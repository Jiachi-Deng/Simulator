import {
  HOST_AGENT_CONTRACT_VERSION,
  HOST_AGENT_LIMITS,
  isHostAgentRunTransition,
  isHostAgentTerminalRunState,
  parseCreateHostAgentRunRequest,
  parseHostAgentEvent,
  parseHostAgentRunSnapshot,
  type CreateHostAgentRunRequest,
  type HostAgentEvent,
  type HostAgentInterruptionReason,
  type HostAgentRunSnapshot,
  type HostAgentRunState,
  type HostAgentTurnFailureCode,
} from '@simulator/host-agent-contract'
import { createHostAgentIdempotencyDigests } from '@simulator/host-agent-contract/node'
import { HostAgentReplayBuffer } from './replay-buffer.ts'
import {
  HostAgentRunCoreError,
  type CreateHostAgentRunInput,
  type HostAgentRunClock,
  type HostAgentRunCoreDependencies,
  type HostAgentRunCoreLimits,
  type HostAgentRunCoreSnapshot,
  type HostAgentRunEventListener,
  type HostAgentRunGrantSpec,
  type HostAgentRunOwnership,
  type HostAgentRunSubscription,
  type HostAgentRunTerminalCommit,
  type HostAgentSessionEvent,
} from './types.ts'

interface StoredGrant extends HostAgentRunGrantSpec {
  workspaceRoot: string
  authorizedWorkingRoot: string
  defaultWorkingDirectory: string
  active: boolean
  runs: Set<string>
  idempotency: Map<string, string>
  subscribers: number
}

interface StoredRun {
  handle: string
  grantId: string
  request: CreateHostAgentRunRequest
  keyDigest: string
  requestDigest: string
  state: HostAgentRunState
  createdAt: number
  updatedAt: number
  terminalAt?: number
  closedAt?: number
  sessionId?: string
  workingDirectory: string
  replay: HostAgentReplayBuffer
  nextSequence: number
  listeners: Set<HostAgentRunEventListener>
  unsubscribeSession: () => void
  operationTail: Promise<void>
  initialization?: Promise<void>
  initializationFailure?: HostAgentRunCoreError
  initializationDisposition: 'unknown' | 'not-created' | 'session-owned'
  timeoutHandle?: unknown
  closing?: Promise<HostAgentRunSnapshot>
}

const defaultClock: HostAgentRunClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

const DEFAULT_LIMITS: Readonly<HostAgentRunCoreLimits> = Object.freeze({
  maxReplayEvents: HOST_AGENT_LIMITS.maxReplayEvents,
  maxReplayBytes: HOST_AGENT_LIMITS.maxReplayBytes,
  maxSubscribersPerGrant: HOST_AGENT_LIMITS.maxSseSubscribersPerGrant,
  maxConcurrentRuns: HOST_AGENT_LIMITS.maxConcurrentModuleRuns,
  maxRunDurationMs: HOST_AGENT_LIMITS.maxRunDurationMs,
  maxCraftPreemptionMs: 5_000,
  tombstoneMinRetentionMs: HOST_AGENT_LIMITS.tombstoneMinRetentionMs,
})

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const HEX_32 = /^[0-9a-f]{32}$/

function assertOpaqueId(value: string, label: string): void {
  if (!OPAQUE_ID.test(value)) throw new TypeError(`${label} must be a canonical opaque ID`)
}

function terminalRetryability(commit: HostAgentRunTerminalCommit): boolean {
  if (commit.state === 'completed') return false
  if (commit.state === 'failed') {
    return commit.code === 'RUNTIME_UNAVAILABLE'
      || commit.code === 'RUN_TIMEOUT'
      || commit.code === 'BROKER_DISCONNECTED'
  }
  return commit.reason !== 'CLIENT_CANCELLED'
}

/**
 * Main-process source of truth for v2 runs. HTTP workers only marshal commands;
 * they cannot own Craft sessions, terminal arbitration, or cleanup.
 */
export class ModuleAgentRunCore {
  readonly #deps: HostAgentRunCoreDependencies
  readonly #clock: HostAgentRunClock
  readonly #limits: Readonly<HostAgentRunCoreLimits>
  readonly #grants = new Map<string, StoredGrant>()
  readonly #runs = new Map<string, StoredRun>()
  #creationTail: Promise<void> = Promise.resolve()
  #craftTurnActive = false

  constructor(dependencies: HostAgentRunCoreDependencies) {
    this.#deps = dependencies
    this.#clock = dependencies.clock ?? defaultClock
    this.#limits = Object.freeze({ ...DEFAULT_LIMITS, ...dependencies.limits })
    const ceilings = DEFAULT_LIMITS
    for (const key of Object.keys(ceilings) as Array<keyof HostAgentRunCoreLimits>) {
      const value = this.#limits[key]
      if (!Number.isSafeInteger(value) || value < 1 || value > ceilings[key]) {
        throw new TypeError(`${key} exceeds the Host Agent contract ceiling`)
      }
    }
  }

  get limits(): Readonly<HostAgentRunCoreLimits> { return this.#limits }

  debugSnapshot(): HostAgentRunCoreSnapshot {
    let activeRuns = 0
    let moduleSessions = 0
    let subscribers = 0
    for (const run of this.#runs.values()) {
      if (run.state === 'accepted' || run.state === 'starting' || run.state === 'running') activeRuns += 1
      if (run.sessionId) moduleSessions += 1
      subscribers += run.listeners.size
    }
    return {
      activeGrants: [...this.#grants.values()].filter((grant) => grant.active).length,
      activeRuns,
      retainedRuns: this.#runs.size,
      moduleSessions,
      subscribers,
    }
  }

  async issueGrant(spec: HostAgentRunGrantSpec): Promise<void> {
    assertOpaqueId(spec.grantId, 'grantId')
    assertOpaqueId(spec.moduleId, 'moduleId')
    assertOpaqueId(spec.workerEpoch, 'workerEpoch')
    assertOpaqueId(spec.workspaceId, 'workspaceId')
    if (!Number.isSafeInteger(spec.expiresAt) || spec.expiresAt <= this.#clock.now()) {
      throw new TypeError('grant expiry must be in the future')
    }
    if (this.#grants.has(spec.grantId)) throw new TypeError('grantId is already registered')
    const workspaceRoot = await this.#deps.paths.canonicalize(spec.workspaceRoot)
    const authorizedWorkingRoot = await this.#deps.paths.canonicalize(spec.authorizedWorkingRoot)
    const defaultWorkingDirectory = await this.#deps.paths.canonicalize(spec.defaultWorkingDirectory)
    if (!this.#deps.paths.isEqualOrWithin(defaultWorkingDirectory, authorizedWorkingRoot)) {
      throw new HostAgentRunCoreError('FORBIDDEN', 'Default working directory is outside the launch grant')
    }
    this.#grants.set(spec.grantId, {
      ...spec,
      workspaceRoot,
      authorizedWorkingRoot,
      defaultWorkingDirectory,
      active: true,
      runs: new Set(),
      idempotency: new Map(),
      subscribers: 0,
    })
  }

  async createRun(input: CreateHostAgentRunInput): Promise<HostAgentRunSnapshot> {
    return await this.#serializeCreation(() => this.#createRunNow(input))
  }

  async #createRunNow(input: CreateHostAgentRunInput): Promise<HostAgentRunSnapshot> {
    const grant = this.#activeGrant(input.grantId)
    const request = parseCreateHostAgentRunRequest(input.request)
    const digests = createHostAgentIdempotencyDigests(input.idempotencyKey, request)
    const existingHandle = grant.idempotency.get(digests.keyDigest)
    if (existingHandle) {
      const existing = this.#ownedRun(grant, existingHandle)
      if (existing.requestDigest !== digests.requestDigest) {
        throw new HostAgentRunCoreError('IDEMPOTENCY_CONFLICT', 'Idempotency key is bound to another request')
      }
      if (existing.initialization) await existing.initialization
      if (existing.initializationFailure) {
        throw new HostAgentRunCoreError(
          existing.initializationFailure.code,
          existing.initializationFailure.message,
        )
      }
      return this.#snapshot(existing)
    }
    if (this.#craftTurnActive) {
      throw new HostAgentRunCoreError('CRAFT_TURN_ACTIVE', 'A visible Craft turn has priority')
    }
    this.#assertRunCapacityAvailable()

    const requestedWorkingDirectory = request.workingDirectory ?? grant.defaultWorkingDirectory
    const workingDirectory = await this.#deps.paths.canonicalize(requestedWorkingDirectory)
    // Craft priority and grant revocation may change while canonicalization is
    // waiting on the filesystem. Revalidate immediately before ownership is
    // made visible so a late result cannot start Module work behind Craft.
    if (this.#craftTurnActive) {
      throw new HostAgentRunCoreError('CRAFT_TURN_ACTIVE', 'A visible Craft turn has priority')
    }
    if (this.#activeGrant(input.grantId) !== grant) {
      throw new HostAgentRunCoreError('UNAUTHORIZED', 'Launch grant changed during run creation')
    }
    this.#assertRunCapacityAvailable()
    if (!this.#deps.paths.isEqualOrWithin(workingDirectory, grant.authorizedWorkingRoot)) {
      throw new HostAgentRunCoreError('FORBIDDEN', 'Working directory is outside the launch grant')
    }

    const handle = this.#createRunHandle()
    const now = this.#clock.now()
    const run: StoredRun = {
      handle,
      grantId: grant.grantId,
      request,
      keyDigest: digests.keyDigest,
      requestDigest: digests.requestDigest,
      state: 'accepted',
      createdAt: now,
      updatedAt: now,
      workingDirectory,
      replay: new HostAgentReplayBuffer(this.#limits.maxReplayEvents, this.#limits.maxReplayBytes),
      nextSequence: 1,
      listeners: new Set(),
      unsubscribeSession: () => undefined,
      operationTail: Promise.resolve(),
      initializationDisposition: 'unknown',
    }
    this.#runs.set(handle, run)
    grant.runs.add(handle)
    grant.idempotency.set(digests.keyDigest, handle)

    // Initialization participates in the same per-run serial queue as Broker
    // disconnect, Craft preemption and shutdown. A disconnect can therefore
    // never close an accepted shell and then lose a Session created afterward.
    const initialization = this.#serialize(run, () => this.#initializeRun(grant, run))
    run.initialization = initialization
    try {
      await initialization
    } catch (error) {
      const failure = error instanceof HostAgentRunCoreError
        ? error
        : new HostAgentRunCoreError('RUNTIME_UNAVAILABLE', 'Host could not initialize a transient Module session')
      // If strict cleanup could not prove the Session gone, keep the Run and
      // idempotency ownership for retryable shutdown cleanup. Never turn an
      // uncertain Session into an untracked orphan or a fresh duplicate Run.
      const safeToDiscard = run.initializationDisposition === 'not-created'
        && !run.sessionId
        && grant.active
        && !this.#craftTurnActive
        && run.state === 'accepted'
      if (safeToDiscard) {
        this.#runs.delete(handle)
        grant.runs.delete(handle)
        if (grant.idempotency.get(digests.keyDigest) === handle) grant.idempotency.delete(digests.keyDigest)
      } else {
        run.initializationFailure = failure
      }
      throw failure
    } finally {
      if (run.initialization === initialization) run.initialization = undefined
    }

    this.#armRunTimeout(run)
    void this.#serialize(run, () => this.#startRunNow(run)).catch(() => undefined)
    return this.#snapshot(run)
  }

  getRun(grantId: string, runHandle: string): HostAgentRunSnapshot {
    const grant = this.#activeOrRetainedGrant(grantId)
    return this.#snapshot(this.#ownedRun(grant, runHandle))
  }

  subscribe(
    grantId: string,
    runHandle: string,
    afterSequence: number | undefined,
    listener: HostAgentRunEventListener,
  ): HostAgentRunSubscription {
    const grant = this.#activeOrRetainedGrant(grantId)
    const run = this.#ownedRun(grant, runHandle)
    if (grant.subscribers >= this.#limits.maxSubscribersPerGrant) {
      throw new HostAgentRunCoreError('RATE_LIMITED', 'SSE subscriber limit reached')
    }
    const replay = run.replay.replay(afterSequence)
    for (const event of replay) this.#safeNotify(listener, event)
    run.listeners.add(listener)
    grant.subscribers += 1
    let active = true
    return {
      replayed: replay.length,
      earliestEventId: run.replay.earliestSequence === undefined ? undefined : String(run.replay.earliestSequence),
      latestEventId: run.replay.latestSequence === undefined ? undefined : String(run.replay.latestSequence),
      unsubscribe: () => {
        if (!active) return
        active = false
        if (run.listeners.delete(listener)) grant.subscribers = Math.max(0, grant.subscribers - 1)
      },
    }
  }

  async cancelRun(grantId: string, runHandle: string): Promise<HostAgentRunSnapshot> {
    const grant = this.#activeGrant(grantId)
    const run = this.#ownedRun(grant, runHandle)
    return this.#serialize(run, async () => {
      await this.#interruptNow(run, 'CLIENT_CANCELLED')
      return this.#snapshot(run)
    })
  }

  async closeRun(grantId: string, runHandle: string): Promise<HostAgentRunSnapshot> {
    const grant = this.#activeOrRetainedGrant(grantId)
    const run = this.#ownedRun(grant, runHandle)
    if (run.state === 'closed') return this.#snapshot(run)
    if (run.closing) return run.closing
    const closing = this.#serialize(run, () => this.#closeRunNow(run, 'CLIENT_CANCELLED'))
    run.closing = closing
    try {
      return await closing
    } finally {
      // A failed strict reap leaves the run in `closing` so a later DELETE or
      // startup cleanup can retry. Never cache a rejected cleanup promise.
      if (run.closing === closing) run.closing = undefined
    }
  }

  /** Visible Craft work has priority and waits until the Module provider is stopped. */
  async beginCraftTurn(): Promise<void> {
    this.#craftTurnActive = true
    const active = [...this.#runs.values()].find((run) =>
      run.state === 'accepted' || run.state === 'starting' || run.state === 'running')
    if (!active) return
    if (active.initialization) {
      await this.#awaitCraftPreemptionDeadline(active, active.initialization)
    }
    const preemption = this.#serialize(active, async () => {
      if (isHostAgentTerminalRunState(active.state) || active.state === 'closing' || active.state === 'closed') return

      // Craft cannot share its provider with an unconfirmed Module turn. The
      // cooperative path is attempted first; strict disposal is the fallback
      // if the provider never acknowledges the stop. Either way, no provider
      // work remains before this method resolves.
      try {
        await this.#deps.sessions.cancelTurn(active.sessionId!)
        await this.#deps.sessions.awaitStopped(active.sessionId!)
      } catch (stopError) {
        try {
          await this.#deps.sessions.disposeAndReap(active.sessionId!)
          active.sessionId = undefined
        } catch {
          throw new HostAgentRunCoreError(
            'CLEANUP_FAILED',
            `Module provider could not be reaped before Craft admission: ${stopError instanceof Error ? stopError.message : 'stop failed'}`,
          )
        }
      }

      await this.#commitTerminalNow(active, {
        state: 'interrupted',
        reason: 'CRAFT_TURN_PREEMPTED',
      })
      await this.#closeRunNow(active, 'CRAFT_TURN_PREEMPTED')
    })
    await this.#awaitCraftPreemptionDeadline(active, preemption)
  }

  endCraftTurn(): void { this.#craftTurnActive = false }

  /** A dead Broker invalidates only its grant. Current work fails once and is never replayed. */
  async disconnectGrant(grantId: string): Promise<void> {
    const grant = this.#grants.get(grantId)
    if (!grant) return
    grant.active = false
    let firstError: unknown
    for (const handle of grant.runs) {
      const run = this.#runs.get(handle)
      if (!run || run.state === 'closed') continue
      try {
        await this.#serialize(run, async () => {
          if (run.state === 'accepted' || run.state === 'starting' || run.state === 'running') {
            await this.#stopProviderNow(run)
            await this.#commitTerminalNow(run, { state: 'failed', code: 'BROKER_DISCONNECTED' })
          }
          await this.#closeRunNow(run, 'BROKER_DISCONNECTED')
        })
      } catch (error) {
        firstError ??= error
      }
    }
    if (firstError) throw firstError
  }

  async shutdown(): Promise<void> {
    let firstError: unknown
    for (const grant of this.#grants.values()) {
      grant.active = false
      for (const handle of grant.runs) {
        const run = this.#runs.get(handle)
        if (!run || run.state === 'closed') continue
        try {
          await this.#serialize(run, () => this.#closeRunNow(run, 'HOST_SHUTDOWN'))
        } catch (error) {
          firstError ??= error
        }
      }
    }
    if (firstError) throw firstError
  }

  purgeExpiredTombstones(): number {
    const now = this.#clock.now()
    let purged = 0
    for (const [handle, run] of this.#runs) {
      if (run.state !== 'closed' || run.terminalAt === undefined) continue
      const grant = this.#grants.get(run.grantId)
      const retainUntil = Math.max(run.terminalAt + this.#limits.tombstoneMinRetentionMs, grant?.expiresAt ?? 0)
      if (now < retainUntil) continue
      this.#runs.delete(handle)
      grant?.runs.delete(handle)
      if (grant?.idempotency.get(run.keyDigest) === handle) grant.idempotency.delete(run.keyDigest)
      purged += 1
    }
    for (const [grantId, grant] of this.#grants) {
      if (!grant.active && grant.runs.size === 0) this.#grants.delete(grantId)
    }
    return purged
  }

  async #initializeRun(grant: StoredGrant, run: StoredRun): Promise<void> {
    const ownership: HostAgentRunOwnership = {
      transient: true,
      contractVersion: HOST_AGENT_CONTRACT_VERSION,
      moduleId: grant.moduleId,
      runHandle: run.handle,
      idempotencyKeyDigest: run.keyDigest,
      requestDigest: run.requestDigest,
      workerEpoch: grant.workerEpoch,
      state: 'accepted',
    }
    const input = {
      workspaceId: grant.workspaceId,
      workspaceRoot: grant.workspaceRoot,
      authorizedWorkingRoot: grant.authorizedWorkingRoot,
      workingDirectory: run.workingDirectory,
      ownership,
    }
    let created
    try {
      created = await this.#deps.sessions.createSession(input)
    } catch (createError) {
      // A rejected Promise does not prove that the ownership header was never
      // committed. Recover by the same Run ownership before deciding whether
      // the idempotency reservation may be released.
      try {
        created = await this.#deps.sessions.recoverSession(input)
      } catch {
        run.initializationDisposition = 'unknown'
        throw new HostAgentRunCoreError(
          'CLEANUP_FAILED',
          'Transient Module session ownership could not be recovered after creation failed',
        )
      }
      if (!created) {
        run.initializationDisposition = 'not-created'
        throw new HostAgentRunCoreError(
          'RUNTIME_UNAVAILABLE',
          createError instanceof Error
            ? 'Host did not create a transient Module session'
            : 'Host could not create a transient Module session',
        )
      }
    }
    const valid = created.hidden
      && created.workspaceId === grant.workspaceId
      && created.workspaceRoot === grant.workspaceRoot
      && created.workingDirectory === run.workingDirectory
      && typeof created.sessionId === 'string'
      && created.sessionId.length > 0
    if (typeof created.sessionId === 'string' && created.sessionId.length > 0) {
      // Take cleanup ownership before validating any post-create field.
      run.sessionId = created.sessionId
      run.initializationDisposition = 'session-owned'
    }
    if (!valid) {
      if (run.sessionId) {
        try {
          await this.#deps.sessions.disposeAndReap(run.sessionId)
          run.sessionId = undefined
          run.initializationDisposition = 'not-created'
        } catch {
          throw new HostAgentRunCoreError('CLEANUP_FAILED', 'Rejected transient Module session could not be reaped')
        }
      }
      throw new HostAgentRunCoreError('TOOL_BOUNDARY_UNAVAILABLE', 'Host created an invalid transient Module session')
    }
    try {
      run.unsubscribeSession = this.#deps.sessions.subscribe(created.sessionId, (event) => {
        const handling = this.#serialize(run, () => this.#handleSessionEventNow(run, event))
        void handling.catch((error) => {
          void this.#serialize(run, () => this.#failAfterSessionOperationNow(run, error, 'INTERNAL_ERROR'))
            .catch(() => undefined)
        })
      })
    } catch {
      try {
        await this.#deps.sessions.disposeAndReap(created.sessionId)
        run.sessionId = undefined
        run.initializationDisposition = 'not-created'
      } catch {
        throw new HostAgentRunCoreError('CLEANUP_FAILED', 'Unsubscribed transient Module session could not be reaped')
      }
      throw new HostAgentRunCoreError('RUNTIME_UNAVAILABLE', 'Host could not subscribe to the transient Module session')
    }
    this.#emit(run, { type: 'run.accepted', data: {} })
  }

  async #startRunNow(run: StoredRun): Promise<void> {
    if (run.state !== 'accepted' || !run.sessionId) return
    try {
      if (await this.#closeBeforeProviderStartIfFenced(run)) return
      await this.#setStateNow(run, 'starting')
      // Persisting the starting state is an await boundary. Craft priority or
      // Broker ownership may change while that write is in flight; recheck at
      // the last synchronous point before the provider can be invoked.
      if (await this.#closeBeforeProviderStartIfFenced(run)) return
      await this.#deps.sessions.sendTurn(run.sessionId, run.request.prompt)
      if (!this.#runIsInState(run, 'starting')) return
      await this.#setStateNow(run, 'running')
      this.#emit(run, { type: 'turn.started', data: {} })
    } catch (error) {
      await this.#failAfterSessionOperationNow(run, error, 'RUNTIME_UNAVAILABLE')
    }
  }

  async #closeBeforeProviderStartIfFenced(run: StoredRun): Promise<boolean> {
    const grant = this.#grants.get(run.grantId)
    let terminal: HostAgentRunTerminalCommit | undefined
    if (this.#craftTurnActive) {
      terminal = { state: 'interrupted', reason: 'CRAFT_TURN_PREEMPTED' }
    } else if (!grant || !grant.active || grant.expiresAt <= this.#clock.now()) {
      terminal = { state: 'failed', code: 'BROKER_DISCONNECTED' }
    }
    if (!terminal) return false

    await this.#commitTerminalWithRecoveryNow(run, terminal)
    if (run.state !== 'closed') await this.#closeRunNow(run, terminal.state === 'interrupted'
      ? terminal.reason
      : 'BROKER_DISCONNECTED')
    return true
  }

  async #handleSessionEventNow(run: StoredRun, event: HostAgentSessionEvent): Promise<void> {
    if (!run.sessionId || event.sessionId !== run.sessionId) return
    if (run.state !== 'running' && !event.type.startsWith('turn.')) return
    switch (event.type) {
      case 'message.delta':
      case 'reasoning.delta':
        if (event.delta.length > 0) this.#emit(run, { type: event.type, data: { delta: event.delta } })
        return
      case 'activity':
        this.#emit(run, {
          type: 'activity',
          data: { phase: event.phase, kind: event.kind, ...(event.label ? { label: event.label } : {}) },
        })
        return
      case 'presentation.item':
        this.#emit(run, { type: 'presentation.item', data: event.data })
        return
      case 'turn.completed':
        await this.#commitTerminalWithRecoveryNow(run, {
          state: 'completed', ...(event.finalText === undefined ? {} : { finalText: event.finalText }),
        })
        return
      case 'turn.failed':
        await this.#commitTerminalWithRecoveryNow(run, { state: 'failed', code: event.code })
        return
      case 'turn.interrupted':
        await this.#commitTerminalWithRecoveryNow(run, { state: 'interrupted', reason: event.reason })
    }
  }

  async #timeoutRunNow(run: StoredRun): Promise<void> {
    if (run.state !== 'starting' && run.state !== 'running') return
    await this.#stopProviderNow(run)
    await this.#commitTerminalWithRecoveryNow(run, { state: 'failed', code: 'RUN_TIMEOUT' })
  }

  async #interruptNow(run: StoredRun, reason: HostAgentInterruptionReason): Promise<void> {
    if (isHostAgentTerminalRunState(run.state) || run.state === 'closing' || run.state === 'closed') return
    await this.#stopProviderNow(run)
    await this.#commitTerminalWithRecoveryNow(run, { state: 'interrupted', reason })
  }

  async #stopProviderNow(run: StoredRun): Promise<void> {
    if (!run.sessionId) return
    try {
      await this.#deps.sessions.cancelTurn(run.sessionId)
      await this.#deps.sessions.awaitStopped(run.sessionId)
    } catch {
      // Terminal arbitration still happens in the main process. Strict reap on
      // DELETE remains the final safety boundary when provider cancellation fails.
    }
  }

  async #commitTerminalNow(run: StoredRun, commit: HostAgentRunTerminalCommit): Promise<boolean> {
    if (isHostAgentTerminalRunState(run.state) || run.state === 'closing' || run.state === 'closed') return false
    if (!isHostAgentRunTransition(run.state, commit.state)) return false
    let terminalEvent: HostAgentEvent
    if (commit.state === 'completed') {
      try {
        terminalEvent = this.#prepareEvent(run, {
          type: 'turn.completed',
          data: commit.finalText === undefined ? {} : { finalText: commit.finalText },
        })
      } catch (error) {
        if (commit.finalText === undefined) throw error
        // Streamed deltas remain authoritative. A provider-supplied aggregate
        // finalText that cannot fit the closed wire contract is omitted rather
        // than persisting completed and then discovering no terminal can emit.
        terminalEvent = this.#prepareEvent(run, { type: 'turn.completed', data: {} })
      }
    } else if (commit.state === 'failed') {
      terminalEvent = this.#prepareEvent(run, {
        type: 'turn.failed',
        data: { code: commit.code, retryable: terminalRetryability(commit) },
      })
    } else {
      terminalEvent = this.#prepareEvent(run, {
        type: 'turn.interrupted',
        data: { reason: commit.reason, retryable: terminalRetryability(commit) },
      })
    }
    await this.#setStateNow(run, commit.state)
    this.#clearRunTimeout(run)
    this.#publishPreparedEvent(run, terminalEvent)
    return true
  }

  async #commitTerminalWithRecoveryNow(
    run: StoredRun,
    commit: HostAgentRunTerminalCommit,
  ): Promise<boolean> {
    try {
      return await this.#commitTerminalNow(run, commit)
    } catch (error) {
      await this.#failAfterSessionOperationNow(run, error, 'INTERNAL_ERROR')
      return false
    }
  }

  async #failAfterSessionOperationNow(
    run: StoredRun,
    _cause: unknown,
    code: HostAgentTurnFailureCode,
  ): Promise<void> {
    if (isHostAgentTerminalRunState(run.state) || run.state === 'closing' || run.state === 'closed') return
    const sessionId = run.sessionId
    if (sessionId) {
      run.unsubscribeSession()
      run.unsubscribeSession = () => undefined
      try {
        await this.#deps.sessions.disposeAndReap(sessionId)
        run.sessionId = undefined
        run.initializationDisposition = 'not-created'
        run.initializationFailure = undefined
      } catch {
        run.initializationFailure = new HostAgentRunCoreError(
          'CLEANUP_FAILED',
          'Transient Module session could not be reaped after a Host state failure',
        )
      }
    }

    // The Session has either been deleted or is fenced as cleanup debt. Commit
    // a local failure so polling/SSE never remain accepted/running forever.
    // A retained stale header is startup-quarantined and blocks new Module work
    // until DELETE or shutdown proves strict reap.
    if (isHostAgentRunTransition(run.state, 'failed')) {
      this.#setLocalStateNow(run, 'failed')
      this.#clearRunTimeout(run)
      this.#emit(run, {
        type: 'turn.failed',
        data: { code, retryable: code === 'RUNTIME_UNAVAILABLE' || code === 'RUN_TIMEOUT' },
      })
    }
    if (!run.sessionId) await this.#closeRunNow(run, 'HOST_SHUTDOWN')
  }

  async #closeRunNow(run: StoredRun, reason: HostAgentInterruptionReason): Promise<HostAgentRunSnapshot> {
    if (run.state === 'closed') return this.#snapshot(run)
    if (!isHostAgentTerminalRunState(run.state) && run.state !== 'closing') {
      await this.#interruptNow(run, reason)
    }
    if (isHostAgentTerminalRunState(run.state)) {
      try {
        await this.#setStateNow(run, 'closing')
      } catch {
        run.initializationFailure = new HostAgentRunCoreError(
          'CLEANUP_FAILED',
          'Transient Module closing state could not be persisted',
        )
        this.#setLocalStateNow(run, 'closing')
      }
    }
    if (run.state !== 'closing') return this.#snapshot(run)
    this.#clearRunTimeout(run)
    run.unsubscribeSession()
    run.unsubscribeSession = () => undefined
    const sessionId = run.sessionId
    if (sessionId) {
      try {
        await this.#deps.sessions.disposeAndReap(sessionId)
        run.sessionId = undefined
        run.initializationDisposition = 'not-created'
        run.initializationFailure = undefined
      } catch {
        throw new HostAgentRunCoreError('CLEANUP_FAILED', 'Transient Module session cleanup did not finish')
      }
    }
    const now = this.#clock.now()
    run.state = 'closed'
    run.updatedAt = now
    run.closedAt = now
    this.#emit(run, { type: 'run.closed', data: {} })
    return this.#snapshot(run)
  }

  async #setStateNow(run: StoredRun, next: HostAgentRunState): Promise<void> {
    if (!isHostAgentRunTransition(run.state, next)) {
      throw new HostAgentRunCoreError('INTERNAL_ERROR', `Invalid run transition ${run.state} -> ${next}`)
    }
    if (run.sessionId) await this.#deps.sessions.updateRunState(run.sessionId, next)
    this.#setLocalStateNow(run, next)
  }

  #setLocalStateNow(run: StoredRun, next: HostAgentRunState): void {
    if (!isHostAgentRunTransition(run.state, next)) {
      throw new HostAgentRunCoreError('INTERNAL_ERROR', `Invalid run transition ${run.state} -> ${next}`)
    }
    const now = this.#clock.now()
    run.state = next
    run.updatedAt = Math.max(now, run.updatedAt)
    if (isHostAgentTerminalRunState(next) && run.terminalAt === undefined) run.terminalAt = run.updatedAt
  }

  #emit(run: StoredRun, body: Pick<HostAgentEvent, 'type' | 'data'>): HostAgentEvent {
    return this.#publishPreparedEvent(run, this.#prepareEvent(run, body))
  }

  #prepareEvent(run: StoredRun, body: Pick<HostAgentEvent, 'type' | 'data'>): HostAgentEvent {
    return parseHostAgentEvent({
      contractVersion: HOST_AGENT_CONTRACT_VERSION,
      eventId: String(run.nextSequence),
      sequence: run.nextSequence,
      runHandle: run.handle,
      occurredAt: this.#clock.now(),
      ...body,
    })
  }

  #publishPreparedEvent(run: StoredRun, event: HostAgentEvent): HostAgentEvent {
    if (event.sequence !== run.nextSequence || event.eventId !== String(run.nextSequence)
      || event.runHandle !== run.handle) {
      throw new HostAgentRunCoreError('INTERNAL_ERROR', 'Prepared Host Agent event lost its serialization slot')
    }
    run.nextSequence += 1
    run.replay.append(event)
    for (const listener of run.listeners) this.#safeNotify(listener, event)
    return event
  }

  #snapshot(run: StoredRun): HostAgentRunSnapshot {
    return parseHostAgentRunSnapshot({
      contractVersion: HOST_AGENT_CONTRACT_VERSION,
      runHandle: run.handle,
      state: run.state,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      ...(run.terminalAt === undefined ? {} : { terminalAt: run.terminalAt }),
      ...(run.closedAt === undefined ? {} : { closedAt: run.closedAt }),
    })
  }

  #serialize<T>(run: StoredRun, operation: () => Promise<T> | T): Promise<T> {
    const result = run.operationTail.then(operation, operation)
    run.operationTail = result.then(() => undefined, () => undefined)
    return result
  }

  #serializeCreation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#creationTail.then(operation, operation)
    this.#creationTail = result.then(() => undefined, () => undefined)
    return result
  }

  #activeGrant(grantId: string): StoredGrant {
    const grant = this.#grants.get(grantId)
    if (!grant || !grant.active || grant.expiresAt <= this.#clock.now()) {
      throw new HostAgentRunCoreError('UNAUTHORIZED', 'Launch grant is unavailable')
    }
    return grant
  }

  #activeOrRetainedGrant(grantId: string): StoredGrant {
    const grant = this.#grants.get(grantId)
    if (!grant) throw new HostAgentRunCoreError('UNAUTHORIZED', 'Launch grant is unavailable')
    return grant
  }

  #ownedRun(grant: StoredGrant, runHandle: string): StoredRun {
    const run = this.#runs.get(runHandle)
    if (!run || run.grantId !== grant.grantId || !grant.runs.has(runHandle)) {
      throw new HostAgentRunCoreError('RUN_NOT_FOUND', 'Run was not found')
    }
    return run
  }

  #activeRunCount(): number {
    let count = 0
    for (const run of this.#runs.values()) {
      if (run.state === 'accepted' || run.state === 'starting' || run.state === 'running') count += 1
    }
    return count
  }

  #assertRunCapacityAvailable(): void {
    for (const run of this.#runs.values()) {
      if (run.initializationFailure || (run.state === 'closing' && run.sessionId)) {
        throw new HostAgentRunCoreError(
          'CLEANUP_FAILED',
          'A previous Module session still has unresolved cleanup ownership',
        )
      }
    }
    if (this.#activeRunCount() >= this.#limits.maxConcurrentRuns) {
      throw new HostAgentRunCoreError('RUN_ACTIVE', 'Only one Module run may be active')
    }
    // A terminal Run retains provider/session capacity until strict DELETE has
    // reaped it. Do not admit a second hidden Session in this narrow window.
    if ([...this.#runs.values()].some((run) => run.sessionId !== undefined)) {
      throw new HostAgentRunCoreError('RUN_ACTIVE', 'A Module session is still awaiting strict cleanup')
    }
  }

  #createRunHandle(): string {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const hex = this.#deps.ids.createHex(16)
      if (!HEX_32.test(hex)) continue
      const handle = `run_${hex}`
      if (!this.#runs.has(handle)) return handle
    }
    throw new HostAgentRunCoreError('INTERNAL_ERROR', 'Could not allocate a unique run handle')
  }

  #clearRunTimeout(run: StoredRun): void {
    if (run.timeoutHandle === undefined) return
    this.#clock.clearTimeout(run.timeoutHandle)
    run.timeoutHandle = undefined
  }

  #armRunTimeout(run: StoredRun): void {
    if (run.timeoutHandle !== undefined || isHostAgentTerminalRunState(run.state)
      || run.state === 'closing' || run.state === 'closed') return
    run.timeoutHandle = this.#clock.setTimeout(() => {
      void this.#serialize(run, () => this.#timeoutRunNow(run)).catch(() => undefined)
    }, this.#limits.maxRunDurationMs)
  }

  #runIsInState(run: StoredRun, state: HostAgentRunState): boolean {
    return run.state === state
  }

  async #awaitCraftPreemptionDeadline(run: StoredRun, operation: Promise<void>): Promise<void> {
    let timeoutHandle: unknown
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutHandle = this.#clock.setTimeout(() => {
        reject(new HostAgentRunCoreError(
          'CLEANUP_FAILED',
          'Module cleanup exceeded the Craft admission deadline',
        ))
      }, this.#limits.maxCraftPreemptionMs)
    })
    try {
      await Promise.race([operation, timeout])
    } catch (error) {
      if (error instanceof HostAgentRunCoreError && error.code === 'CLEANUP_FAILED') {
        run.initializationFailure = error
      }
      throw error
    } finally {
      if (timeoutHandle !== undefined) this.#clock.clearTimeout(timeoutHandle)
    }
  }

  #safeNotify(listener: HostAgentRunEventListener, event: HostAgentEvent): void {
    try { listener(event) } catch { /* Subscriber failure cannot affect the Host core. */ }
  }
}
