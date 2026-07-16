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
  type CreateHostAgentSessionInput,
  type CreatedHostAgentSession,
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
  request?: CreateHostAgentRunRequest
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
  cleanupDebt?: HostAgentRunCoreError
  automaticRetentionBlocked?: boolean
  terminalWinner?: HostAgentRunTerminalCommit
  terminalPublished?: boolean
  strictCleanupAttempt?: { sessionId: string; raw: Promise<void> }
  strictCleanupRetryBlocked?: boolean
  lateObserverGate?: Promise<void>
  releaseLateObserver?: () => void
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
  // Terminal Runs retain idempotency/tombstone metadata for the full contract
  // window even if a client never sends DELETE, but their aggregate replay
  // payload may consume at most one per-Run replay budget in the main Host.
  maxRetainedTerminalReplayBytes: HOST_AGENT_LIMITS.maxReplayBytes,
  maxSubscribersPerGrant: HOST_AGENT_LIMITS.maxSseSubscribersPerGrant,
  maxConcurrentRuns: HOST_AGENT_LIMITS.maxConcurrentModuleRuns,
  maxRunDurationMs: HOST_AGENT_LIMITS.maxRunDurationMs,
  maxCraftPreemptionMs: 5_000,
  tombstoneMinRetentionMs: HOST_AGENT_LIMITS.tombstoneMinRetentionMs,
})

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const HEX_32 = /^[0-9a-f]{32}$/
const MAX_TIMER_DELAY_MS = 2_147_000_000

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
  #retentionTimer?: unknown
  #retentionTimerDeadline?: number
  #retentionSchedulingEnabled = true
  #retentionMaintenance?: Promise<void>

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
    this.#maintainRetainedRuns()
    let activeRuns = 0
    let moduleSessions = 0
    let subscribers = 0
    let retainedReplayBytes = 0
    let retainedTerminalReplayBytes = 0
    let replayUnavailableRuns = 0
    let retainedRequestPayloads = 0
    let cleanupDebtRuns = 0
    for (const run of this.#runs.values()) {
      if (run.state === 'accepted' || run.state === 'starting' || run.state === 'running') activeRuns += 1
      if (run.sessionId) moduleSessions += 1
      subscribers += run.listeners.size
      retainedReplayBytes += run.replay.byteLength
      if (isHostAgentTerminalRunState(run.state) || run.state === 'closing' || run.state === 'closed') {
        retainedTerminalReplayBytes += run.replay.byteLength
      }
      if (!run.replay.available) replayUnavailableRuns += 1
      if (run.request) retainedRequestPayloads += 1
      if (run.cleanupDebt || run.initializationFailure
        || (run.state === 'closing' && (run.sessionId !== undefined || run.initializationDisposition === 'unknown'))) {
        cleanupDebtRuns += 1
      }
    }
    return {
      activeGrants: [...this.#grants.values()].filter((grant) => grant.active).length,
      activeRuns,
      retainedRuns: this.#runs.size,
      retainedReplayBytes,
      retainedTerminalReplayBytes,
      replayUnavailableRuns,
      retainedRequestPayloads,
      cleanupDebtRuns,
      moduleSessions,
      subscribers,
    }
  }

  async issueGrant(spec: HostAgentRunGrantSpec): Promise<void> {
    this.#maintainRetainedRuns()
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
    this.#scheduleRetentionMaintenance()
  }

  async createRun(input: CreateHostAgentRunInput): Promise<HostAgentRunSnapshot> {
    return await this.#serializeCreation(() => this.#createRunNow(input))
  }

  async #createRunNow(input: CreateHostAgentRunInput): Promise<HostAgentRunSnapshot> {
    this.#maintainRetainedRuns()
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
      if (existing.initializationFailure && existing.state === 'accepted') {
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
    // The 30-minute ceiling starts when the Run becomes visible, not after
    // Session creation. A delayed Session response may postpone cleanup, but
    // it can never receive a provider Turn after this absolute deadline.
    this.#armRunTimeout(run)

    // Initialization participates in the same per-run serial queue as Broker
    // disconnect, Craft preemption and shutdown. A disconnect can therefore
    // never close an accepted shell and then lose a Session created afterward.
    const initialization = this.#serialize(run, () => this.#initializeRun(grant, run))
    run.initialization = initialization
    let initializationTimedOut = false
    try {
      await initialization
    } catch (error) {
      const failure = error instanceof HostAgentRunCoreError
        ? error
        : new HostAgentRunCoreError('RUNTIME_UNAVAILABLE', 'Host could not initialize a transient Module session')
      if (failure.code === 'RUN_TIMEOUT') {
        // Session ownership is deliberately retained until the late operation
        // proves "not created" or its observer strictly reaps the result. The
        // POST itself still finishes at the absolute Run deadline.
        initializationTimedOut = true
        run.cleanupDebt ??= new HostAgentRunCoreError(
          'CLEANUP_FAILED',
          'Transient Module session creation is still awaiting an authoritative late result',
        )
        try {
          await this.#serialize(run, () => this.#timeoutRunNow(run))
        } finally {
          this.#releaseLateSessionObserver(run)
        }
      } else {
      // If strict cleanup could not prove the Session gone, keep the Run and
      // idempotency ownership for retryable shutdown cleanup. Never turn an
      // uncertain Session into an untracked orphan or a fresh duplicate Run.
        const safeToDiscard = run.initializationDisposition === 'not-created'
          && !run.sessionId
          && grant.active
          && !this.#craftTurnActive
          && run.state === 'accepted'
        if (safeToDiscard) {
          this.#clearRunTimeout(run)
          this.#runs.delete(handle)
          grant.runs.delete(handle)
          if (grant.idempotency.get(digests.keyDigest) === handle) grant.idempotency.delete(digests.keyDigest)
        } else {
          run.initializationFailure = failure
        }
        throw failure
      }
    } finally {
      if (run.initialization === initialization) run.initialization = undefined
    }

    if (initializationTimedOut) return this.#snapshot(run)
    if (this.#runDeadlineExpired(run)) {
      await this.#serialize(run, () => this.#timeoutRunNow(run))
    } else {
      void this.#serialize(run, () => this.#startRunNow(run)).catch(() => undefined)
    }
    return this.#snapshot(run)
  }

  getRun(grantId: string, runHandle: string): HostAgentRunSnapshot {
    this.#maintainRetainedRuns()
    const grant = this.#activeOrRetainedGrant(grantId)
    return this.#snapshot(this.#ownedRun(grant, runHandle))
  }

  subscribe(
    grantId: string,
    runHandle: string,
    afterSequence: number | undefined,
    listener: HostAgentRunEventListener,
  ): HostAgentRunSubscription {
    this.#maintainRetainedRuns()
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
    this.#maintainRetainedRuns()
    const grant = this.#activeGrant(grantId)
    const run = this.#ownedRun(grant, runHandle)
    return this.#serialize(run, async () => {
      await this.#interruptNow(run, 'CLIENT_CANCELLED')
      return this.#snapshot(run)
    })
  }

  async closeRun(grantId: string, runHandle: string): Promise<HostAgentRunSnapshot> {
    this.#maintainRetainedRuns()
    const grant = this.#activeOrRetainedGrant(grantId)
    const run = this.#ownedRun(grant, runHandle)
    if (run.state === 'closed') return this.#snapshot(run)
    return await this.#startOrJoinClose(run, 'CLIENT_CANCELLED', true)
  }

  #startOrJoinClose(
    run: StoredRun,
    reason: HostAgentInterruptionReason,
    allowStrictCleanupRetry: boolean,
  ): Promise<HostAgentRunSnapshot> {
    if (run.closing) return run.closing
    const closing = this.#serialize(run, () => this.#closeRunNow(run, reason, allowStrictCleanupRetry))
    run.closing = closing
    // Keep the shared marker until the underlying serialized close settles,
    // even when a bounded Craft waiter has already timed out. This prevents a
    // second DELETE/preemption from creating another cleanup operation.
    void closing.finally(() => {
      // A failed strict reap leaves the run in `closing` so a later DELETE or
      // startup cleanup can retry. Never cache a rejected cleanup promise.
      if (run.closing === closing) run.closing = undefined
    }).catch(() => undefined)
    return closing
  }

  /** Visible Craft work has priority and waits until the Module provider is stopped. */
  async beginCraftTurn(): Promise<void> {
    this.#craftTurnActive = true
    // DELETE owns the whole terminal-close transaction. Join it directly in
    // every local state instead of appending a second preemption behind its
    // operationTail; the Session remains an admission fence until that one
    // transaction proves strict reap.
    const sessionOwnedClose = [...this.#runs.values()].find((run) =>
      run.sessionId !== undefined && run.closing !== undefined)
    if (sessionOwnedClose) {
      await this.#awaitClosingCleanupForCraft(sessionOwnedClose)
      return
    }
    const active = [...this.#runs.values()].find((run) =>
      run.state === 'accepted' || run.state === 'starting' || run.state === 'running')
    if (!active) {
      const sessionOwner = [...this.#runs.values()].find((run) => run.sessionId !== undefined)
      if (sessionOwner) {
        if (isHostAgentTerminalRunState(sessionOwner.state)) {
          this.#startOrJoinClose(sessionOwner, 'CRAFT_TURN_PREEMPTED', false)
        }
        await this.#awaitClosingCleanupForCraft(sessionOwner)
      }
      return
    }
    if (active.initialization) {
      await this.#awaitCraftPreemptionDeadline(active, active.initialization)
    }
    const preemption = this.#serialize(active, async () => {
      if (isHostAgentTerminalRunState(active.state) || active.state === 'closing' || active.state === 'closed') {
        // Classification happened before this operation acquired the Run tail.
        // A concurrent cancel/timeout may have committed a terminal while its
        // Session is still live. Close it inside this serialization slot: a
        // shared close queued behind us cannot be awaited here without a tail
        // cycle, while strict cleanup itself remains single-flight.
        if (active.sessionId) await this.#closeRunNow(active, 'CRAFT_TURN_PREEMPTED')
        return
      }

      // Craft cannot share its provider with an unconfirmed Module turn. The
      // cooperative path is attempted first; strict disposal is the fallback
      // if the provider never acknowledges the stop. Either way, no provider
      // work remains before this method resolves.
      try {
        await this.#awaitWithinDuration((async () => {
          await this.#deps.sessions.cancelTurn(active.sessionId!)
          await this.#deps.sessions.awaitStopped(active.sessionId!)
        })(), this.#limits.maxCraftPreemptionMs, 'Module cooperative stop exceeded the Craft admission deadline')
      } catch (stopError) {
        try {
          await this.#awaitStrictCleanupNow(active, active.sessionId!, false)
        } catch {
          this.#commitLocalCleanupFailureNow(active, 'INTERNAL_ERROR')
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

  #commitLocalCleanupFailureNow(run: StoredRun, code: HostAgentTurnFailureCode): void {
    if (isHostAgentTerminalRunState(run.state) || run.state === 'closing' || run.state === 'closed') return
    if (run.nextSequence === 1) this.#emit(run, { type: 'run.accepted', data: {} })
    const commit: HostAgentRunTerminalCommit = { state: 'failed', code }
    run.terminalWinner ??= commit
    const event = this.#prepareTerminalEvent(run, commit)
    this.#setLocalStateNow(run, 'failed')
    this.#clearRunTimeout(run)
    this.#publishPreparedEvent(run, event)
    run.terminalPublished = true
    this.#setLocalStateNow(run, 'closing')
    run.cleanupDebt ??= new HostAgentRunCoreError(
      'CLEANUP_FAILED',
      'Transient Module cleanup is still pending',
    )
    run.automaticRetentionBlocked = true
    this.#scheduleRetentionMaintenance()
  }

  async #awaitClosingCleanupForCraft(run: StoredRun): Promise<void> {
    const closing = run.closing
    if (closing) {
      try {
        // Join the already serialized DELETE instead of queuing another close
        // behind it. Craft has its own deadline, while the original operation
        // remains responsible for bounded header persistence and one strict
        // reap attempt.
        await this.#awaitWithinDuration(
          closing,
          this.#limits.maxCraftPreemptionMs,
          'In-flight Module close exceeded the Craft admission deadline',
        )
      } catch {
        throw new HostAgentRunCoreError(
          'CLEANUP_FAILED',
          'Module close is still pending; Craft admission remains fenced',
        )
      }
      if (run.sessionId || run.state !== 'closed') {
        throw new HostAgentRunCoreError('CLEANUP_FAILED', 'Module close did not finish before Craft admission')
      }
      return
    }

    const attempt = run.strictCleanupAttempt
    if (!attempt || attempt.sessionId !== run.sessionId) {
      throw new HostAgentRunCoreError(
        'CLEANUP_FAILED',
        'Module cleanup debt has no pending strict-reap attempt; explicit DELETE is required',
      )
    }
    try {
      await this.#awaitWithinDuration(
        attempt.raw,
        this.#limits.maxCraftPreemptionMs,
        'Pending Module strict reap exceeded the Craft admission deadline',
      )
    } catch {
      throw new HostAgentRunCoreError(
        'CLEANUP_FAILED',
        'Module strict reap is still pending; Craft admission remains fenced',
      )
    }
    await this.#serialize(run, async () => {
      this.#completeStrictCleanupNow(run, attempt)
      if (run.state === 'closing') await this.#closeRunNow(run, 'CRAFT_TURN_PREEMPTED')
    })
    if (run.sessionId || run.state !== 'closed') {
      throw new HostAgentRunCoreError('CLEANUP_FAILED', 'Module cleanup did not close before Craft admission')
    }
  }

  endCraftTurn(): void { this.#craftTurnActive = false }

  /** A dead Broker invalidates only its grant. Current work fails once and is never replayed. */
  async disconnectGrant(grantId: string): Promise<void> {
    this.#maintainRetainedRuns()
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
    this.#maintainRetainedRuns()
    if (firstError) throw firstError
  }

  async shutdown(): Promise<void> {
    // Runtime shutdown is terminal for this in-memory authority. Keep records
    // available to the current caller for strict cleanup retries, but never let
    // a 24-hour tombstone timer retain an otherwise disposed RunCore instance.
    this.#retentionSchedulingEnabled = false
    this.#clearRetentionTimer()
    this.#maintainRetainedRuns()
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
    this.#maintainRetainedRuns()
    if (firstError) throw firstError
  }

  purgeExpiredTombstones(): number {
    const purged = this.#purgeExpiredTombstonesNow()
    this.#enforceTerminalReplayBudget()
    this.#scheduleRetentionMaintenance()
    return purged
  }

  #purgeExpiredTombstonesNow(): number {
    const now = this.#clock.now()
    let purged = 0
    for (const [handle, run] of this.#runs) {
      if (run.state !== 'closed' || run.terminalAt === undefined) continue
      const grant = this.#grants.get(run.grantId)
      const retainUntil = Math.max(run.terminalAt + this.#limits.tombstoneMinRetentionMs, grant?.expiresAt ?? 0)
      if (now < retainUntil) continue
      if (run.cleanupDebt || run.initializationDisposition === 'unknown' || run.sessionId) continue
      this.#runs.delete(handle)
      grant?.runs.delete(handle)
      if (grant?.idempotency.get(run.keyDigest) === handle) grant.idempotency.delete(run.keyDigest)
      if (grant) grant.subscribers = Math.max(0, grant.subscribers - run.listeners.size)
      run.listeners.clear()
      purged += 1
    }
    for (const [grantId, grant] of this.#grants) {
      if (!grant.active && grant.runs.size === 0) this.#grants.delete(grantId)
    }
    return purged
  }

  #maintainRetainedRuns(): void {
    this.#purgeExpiredTombstonesNow()
    this.#enforceTerminalReplayBudget()
    this.#scheduleRetentionMaintenance()
  }

  #enforceTerminalReplayBudget(): void {
    let retainedBytes = 0
    const candidates: StoredRun[] = []
    for (const run of this.#runs.values()) {
      if ((!isHostAgentTerminalRunState(run.state) && run.state !== 'closing' && run.state !== 'closed')
        || !run.replay.available || run.replay.byteLength === 0) continue
      retainedBytes += run.replay.byteLength
      candidates.push(run)
    }
    if (retainedBytes <= this.#limits.maxRetainedTerminalReplayBytes) return

    candidates.sort((left, right) => (
      (left.closedAt ?? left.updatedAt) - (right.closedAt ?? right.updatedAt)
      || left.createdAt - right.createdAt
      || left.handle.localeCompare(right.handle)
    ))
    for (const run of candidates) {
      if (retainedBytes <= this.#limits.maxRetainedTerminalReplayBytes) break
      retainedBytes -= run.replay.discard()
    }
  }

  #scheduleRetentionMaintenance(): void {
    if (!this.#retentionSchedulingEnabled) {
      this.#clearRetentionTimer()
      return
    }
    let deadline: number | undefined
    for (const run of this.#runs.values()) {
      if ((!isHostAgentTerminalRunState(run.state) && run.state !== 'closing' && run.state !== 'closed')
        || run.terminalAt === undefined) continue
      const grant = this.#grants.get(run.grantId)
      const retainUntil = Math.max(
        run.terminalAt + this.#limits.tombstoneMinRetentionMs,
        grant?.expiresAt ?? 0,
      )
      if (run.state !== 'closed' && run.automaticRetentionBlocked) continue
      if (deadline === undefined || retainUntil < deadline) deadline = retainUntil
    }

    if (deadline === undefined) {
      if (this.#retentionTimer !== undefined) this.#clock.clearTimeout(this.#retentionTimer)
      this.#retentionTimer = undefined
      this.#retentionTimerDeadline = undefined
      return
    }
    if (this.#retentionTimer !== undefined && this.#retentionTimerDeadline === deadline) return
    if (this.#retentionTimer !== undefined) this.#clock.clearTimeout(this.#retentionTimer)
    this.#retentionTimerDeadline = deadline
    this.#retentionTimer = this.#clock.setTimeout(() => {
      this.#retentionTimer = undefined
      this.#retentionTimerDeadline = undefined
      this.#startRetentionMaintenance()
    }, Math.min(MAX_TIMER_DELAY_MS, Math.max(1, deadline - this.#clock.now())))
  }

  #startRetentionMaintenance(): void {
    if (!this.#retentionSchedulingEnabled || this.#retentionMaintenance) return
    const maintenance = this.#expireDueRetainedRuns()
    this.#retentionMaintenance = maintenance
    void maintenance.finally(() => {
      if (this.#retentionMaintenance === maintenance) this.#retentionMaintenance = undefined
      this.#purgeExpiredTombstonesNow()
      this.#enforceTerminalReplayBudget()
      this.#scheduleRetentionMaintenance()
    }).catch(() => undefined)
  }

  async #expireDueRetainedRuns(): Promise<void> {
    const candidates = [...this.#runs.values()].filter((run) => {
      if ((!isHostAgentTerminalRunState(run.state) && run.state !== 'closing') || run.terminalAt === undefined) {
        return false
      }
      const grant = this.#grants.get(run.grantId)
      const retainUntil = Math.max(
        run.terminalAt + this.#limits.tombstoneMinRetentionMs,
        grant?.expiresAt ?? 0,
      )
      return !run.automaticRetentionBlocked && this.#clock.now() >= retainUntil
    })
    for (const run of candidates) {
      try {
        await this.#serialize(run, async () => {
          if (!isHostAgentTerminalRunState(run.state) && run.state !== 'closing') return
          await this.#closeRunNow(run, 'HOST_SHUTDOWN')
          run.cleanupDebt = undefined
          run.automaticRetentionBlocked = undefined
        })
      } catch {
        // Cleanup failure is durable state, not a timer-only error. Keep the
        // Run/idempotency/session ownership so startup/shutdown/debugSnapshot
        // can still discover the debt.
        run.cleanupDebt = new HostAgentRunCoreError(
          'CLEANUP_FAILED',
          'Expired transient Module session could not be strictly reaped',
        )
        // A timer has no new ownership information and must not wake the Host
        // forever. Late observers and explicit DELETE/shutdown may retry.
        run.automaticRetentionBlocked = true
      }
    }
  }

  #clearRetentionTimer(): void {
    if (this.#retentionTimer !== undefined) this.#clock.clearTimeout(this.#retentionTimer)
    this.#retentionTimer = undefined
    this.#retentionTimerDeadline = undefined
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
    const input: CreateHostAgentSessionInput = {
      workspaceId: grant.workspaceId,
      workspaceRoot: grant.workspaceRoot,
      authorizedWorkingRoot: grant.authorizedWorkingRoot,
      workingDirectory: run.workingDirectory,
      ownership,
    }
    let created: CreatedHostAgentSession | undefined
    let createOperation: Promise<CreatedHostAgentSession>
    try {
      createOperation = this.#deps.sessions.createSession(input)
      try {
        created = await this.#awaitWithinRunDeadline(run, createOperation)
      } catch (error) {
        if (error instanceof HostAgentRunCoreError && error.code === 'RUN_TIMEOUT') {
          this.#markUnknownSessionOwnership(run)
          this.#observeLateCreateOutcome(run, input, createOperation)
        }
        throw error
      }
    } catch (createError) {
      if (createError instanceof HostAgentRunCoreError && createError.code === 'RUN_TIMEOUT') throw createError
      // A rejected Promise does not prove that the ownership header was never
      // committed. Recover by the same Run ownership before deciding whether
      // the idempotency reservation may be released.
      let recoveryOperation: Promise<CreatedHostAgentSession | undefined>
      try {
        recoveryOperation = this.#deps.sessions.recoverSession(input)
        try {
          created = await this.#awaitWithinRunDeadline(run, recoveryOperation)
        } catch (error) {
          if (error instanceof HostAgentRunCoreError && error.code === 'RUN_TIMEOUT') {
            this.#markUnknownSessionOwnership(run)
            this.#observeLateRecoveryOutcome(run, recoveryOperation)
          }
          throw error
        }
      } catch (recoveryError) {
        if (recoveryError instanceof HostAgentRunCoreError && recoveryError.code === 'RUN_TIMEOUT') {
          throw recoveryError
        }
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
    if (!created) {
      run.initializationDisposition = 'not-created'
      throw new HostAgentRunCoreError('RUNTIME_UNAVAILABLE', 'Host did not create a transient Module session')
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
          await this.#awaitStrictCleanupNow(run, run.sessionId, false)
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
        await this.#awaitStrictCleanupNow(run, created.sessionId, false)
      } catch {
        throw new HostAgentRunCoreError('CLEANUP_FAILED', 'Unsubscribed transient Module session could not be reaped')
      }
      throw new HostAgentRunCoreError('RUNTIME_UNAVAILABLE', 'Host could not subscribe to the transient Module session')
    }
    this.#emit(run, { type: 'run.accepted', data: {} })
  }

  #markUnknownSessionOwnership(run: StoredRun): void {
    run.initializationDisposition = 'unknown'
    run.cleanupDebt = new HostAgentRunCoreError(
      'CLEANUP_FAILED',
      'Transient Module session creation has not returned an authoritative ownership result',
    )
    if (!run.lateObserverGate) {
      run.lateObserverGate = new Promise<void>((resolve) => { run.releaseLateObserver = resolve })
    }
  }

  #releaseLateSessionObserver(run: StoredRun): void {
    const release = run.releaseLateObserver
    run.releaseLateObserver = undefined
    release?.()
  }

  #observeLateCreateOutcome(
    run: StoredRun,
    input: CreateHostAgentSessionInput,
    operation: Promise<CreatedHostAgentSession>,
  ): void {
    void operation.then(
      async (created) => {
        await run.lateObserverGate
        return await this.#serialize(run, () => this.#settleLateSessionOwnershipNow(run, created))
      },
      async () => {
        let recovery: Promise<CreatedHostAgentSession | undefined>
        try {
          recovery = this.#deps.sessions.recoverSession(input)
        } catch {
          return
        }
        this.#observeLateRecoveryOutcome(run, recovery)
      },
    ).catch(() => undefined)
  }

  #observeLateRecoveryOutcome(
    run: StoredRun,
    operation: Promise<CreatedHostAgentSession | undefined>,
  ): void {
    void operation.then(
      async (created) => {
        await run.lateObserverGate
        return await this.#serialize(run, () => this.#settleLateSessionOwnershipNow(run, created))
      },
      () => undefined,
    ).catch(() => undefined)
  }

  async #settleLateSessionOwnershipNow(
    run: StoredRun,
    created: CreatedHostAgentSession | undefined,
  ): Promise<void> {
    const sessionId = created && typeof created.sessionId === 'string' && created.sessionId.length > 0
      ? created.sessionId
      : undefined
    if (sessionId) {
      // A late create/recovery result is an ownership observer only. It never
      // subscribes or invokes the provider and must prove strict reap before
      // releasing idempotency ownership.
      run.sessionId = sessionId
      run.initializationDisposition = 'session-owned'
      try {
        await this.#awaitStrictCleanupNow(run, sessionId, false)
      } catch {
        run.cleanupDebt = new HostAgentRunCoreError(
          'CLEANUP_FAILED',
          'Late transient Module session could not be strictly reaped',
        )
        run.automaticRetentionBlocked = true
        this.#scheduleRetentionMaintenance()
        return
      }
    }
    run.initializationDisposition = 'not-created'
    run.initializationFailure = undefined
    run.cleanupDebt = undefined
    run.automaticRetentionBlocked = undefined
    run.lateObserverGate = undefined
    if (run.state === 'closing') await this.#closeRunNow(run, 'HOST_SHUTDOWN')
    this.#scheduleRetentionMaintenance()
  }

  async #startRunNow(run: StoredRun): Promise<void> {
    if (run.state !== 'accepted' || !run.sessionId) return
    if (this.#runDeadlineExpired(run)) {
      await this.#timeoutRunNow(run)
      return
    }
    try {
      if (await this.#closeBeforeProviderStartIfFenced(run)) return
      await this.#setActiveStateWithinRunDeadlineNow(run, 'starting')
      // Persisting the starting state is an await boundary. Craft priority or
      // Broker ownership may change while that write is in flight; recheck at
      // the last synchronous point before the provider can be invoked.
      if (await this.#closeBeforeProviderStartIfFenced(run)) return
      if (this.#runDeadlineExpired(run)) {
        await this.#timeoutRunNow(run)
        return
      }
      const request = run.request
      if (!request) throw new HostAgentRunCoreError('INTERNAL_ERROR', 'Run request payload is unavailable')
      await this.#awaitWithinRunDeadline(run, this.#deps.sessions.sendTurn(run.sessionId, request.prompt))
      if (!this.#runIsInState(run, 'starting')) return
      if (this.#runDeadlineExpired(run)) {
        await this.#timeoutRunNow(run)
        return
      }
      await this.#setActiveStateWithinRunDeadlineNow(run, 'running')
      this.#emit(run, { type: 'turn.started', data: {} })
    } catch (error) {
      if (error instanceof HostAgentRunCoreError && error.code === 'RUN_TIMEOUT') {
        await this.#timeoutRunNow(run)
      } else {
        await this.#failAfterSessionOperationNow(run, error, 'RUNTIME_UNAVAILABLE')
      }
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
    // A pre-Session initialization failure may discard its reservation while
    // the absolute-deadline callback is already queued behind that failure.
    // Detached Runs must never publish a terminal event or retain prompt data.
    if (this.#runs.get(run.handle) !== run) return
    if (run.state !== 'accepted' && run.state !== 'starting' && run.state !== 'running') return
    if (run.state === 'starting' || run.state === 'running') await this.#stopProviderNow(run)
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
      await this.#awaitWithinDuration((async () => {
        await this.#deps.sessions.cancelTurn(run.sessionId!)
        await this.#deps.sessions.awaitStopped(run.sessionId!)
      })(), this.#limits.maxCraftPreemptionMs, 'Module provider stop exceeded its cleanup deadline')
    } catch {
      // Terminal arbitration still happens in the main process. Strict reap on
      // DELETE remains the final safety boundary when provider cancellation fails.
    }
  }

  async #commitTerminalNow(run: StoredRun, commit: HostAgentRunTerminalCommit): Promise<boolean> {
    if (run.terminalWinner || isHostAgentTerminalRunState(run.state)
      || run.state === 'closing' || run.state === 'closed') return false
    const winner: HostAgentRunTerminalCommit = this.#runDeadlineExpired(run)
      && !(commit.state === 'failed' && commit.code === 'RUN_TIMEOUT')
      ? { state: 'failed', code: 'RUN_TIMEOUT' }
      : commit
    if (!isHostAgentRunTransition(run.state, winner.state)) return false
    // Shim/json-event-stream consumers require every transcript, including a
    // pre-Session timeout/cancel/disconnect, to start with run.accepted.
    if (run.nextSequence === 1) this.#emit(run, { type: 'run.accepted', data: {} })
    const terminalEvent = this.#prepareTerminalEvent(run, winner)
    // Main-process arbitration happens before any persistence await. The claim
    // is immutable: cancel, timeout and late provider callbacks cannot publish
    // a second terminal while Session persistence is slow or abandoned.
    run.terminalWinner = winner.state === 'completed' ? { state: 'completed' } : winner

    const sessionId = run.sessionId
    if (sessionId) {
      let persistence: Promise<void> | undefined
      try {
        persistence = this.#deps.sessions.updateRunState(sessionId, winner.state)
        await this.#awaitWithinDuration(
          persistence,
          this.#terminalPersistenceBudgetMs(run),
          'Terminal Session state persistence exceeded its deadline',
        )
      } catch {
        if (persistence) this.#observeLateTerminalPersistence(run, sessionId, persistence)
        await this.#recoverTerminalPersistenceFailureNow(run, winner)
        return true
      }
    }

    this.#setLocalStateNow(run, winner.state)
    this.#clearRunTimeout(run)
    this.#publishPreparedEvent(run, terminalEvent)
    run.terminalPublished = true
    return true
  }

  #prepareTerminalEvent(run: StoredRun, commit: HostAgentRunTerminalCommit): HostAgentEvent {
    let terminalEvent: HostAgentEvent
    if (commit.state === 'completed') {
      try {
        terminalEvent = this.#prepareEvent(run, {
          type: 'turn.completed',
          data: commit.finalText === undefined ? {} : { finalText: commit.finalText },
        })
        if (!run.replay.canAppend(terminalEvent)) {
          throw new TypeError('Completion exceeds the active replay capacity')
        }
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
    if (!run.replay.canAppend(terminalEvent)) {
      throw new HostAgentRunCoreError('INTERNAL_ERROR', 'Terminal event exceeds the active replay capacity')
    }
    return terminalEvent
  }

  #terminalPersistenceBudgetMs(run: StoredRun): number {
    const remaining = run.createdAt + this.#limits.maxRunDurationMs - this.#clock.now()
    return Math.max(1, Math.min(this.#limits.maxCraftPreemptionMs, Math.max(1, remaining)))
  }

  async #recoverTerminalPersistenceFailureNow(
    run: StoredRun,
    winner: HostAgentRunTerminalCommit,
  ): Promise<void> {
    this.#clearRunTimeout(run)
    await this.#stopProviderNow(run)
    run.unsubscribeSession()
    run.unsubscribeSession = () => undefined

    const sessionId = run.sessionId
    let reaped = sessionId === undefined
    if (sessionId) {
      try {
        await this.#awaitStrictCleanupNow(run, sessionId, false)
        reaped = true
      } catch {
        reaped = false
      }
    }

    const fallbackCode: HostAgentTurnFailureCode = winner.state === 'failed'
      ? winner.code
      : 'INTERNAL_ERROR'
    const failedEvent = this.#prepareTerminalEvent(run, { state: 'failed', code: fallbackCode })
    if (isHostAgentRunTransition(run.state, 'failed')) {
      this.#setLocalStateNow(run, 'failed')
      this.#publishPreparedEvent(run, failedEvent)
      run.terminalPublished = true
    }

    if (reaped) {
      await this.#closeRunNow(run, 'HOST_SHUTDOWN')
      return
    }

    if (run.state === 'failed' && isHostAgentRunTransition(run.state, 'closing')) {
      this.#setLocalStateNow(run, 'closing')
    }
    run.cleanupDebt = new HostAgentRunCoreError(
      'CLEANUP_FAILED',
      'Terminal Session persistence failed and strict reap did not finish',
    )
    run.automaticRetentionBlocked = true
    this.#scheduleRetentionMaintenance()
  }

  #observeLateTerminalPersistence(
    run: StoredRun,
    sessionId: string,
    persistence: Promise<void>,
  ): void {
    void persistence.then(
      () => this.#serialize(run, () => this.#reconcileLateTerminalPersistenceNow(run, sessionId)),
      () => undefined,
    ).catch(() => undefined)
  }

  async #reconcileLateTerminalPersistenceNow(run: StoredRun, sessionId: string): Promise<void> {
    if (this.#runs.get(run.handle) !== run || run.sessionId !== sessionId || run.state !== 'closing') return
    try {
      await this.#awaitWithinDuration(
        this.#deps.sessions.updateRunState(sessionId, 'closing'),
        this.#limits.maxCraftPreemptionMs,
        'Late terminal persistence reconciliation exceeded its deadline',
      )
    } catch {
      // The Run remains fenced as cleanup debt. Reconciliation never changes
      // the local winner or emits another terminal.
    }
  }

  #strictCleanupAttemptNow(
    run: StoredRun,
    sessionId: string,
    allowRejectedRetry: boolean,
  ): { sessionId: string; raw: Promise<void> } {
    const existing = run.strictCleanupAttempt
    if (existing) {
      if (existing.sessionId !== sessionId) {
        throw new HostAgentRunCoreError('CLEANUP_FAILED', 'Strict cleanup ownership changed unexpectedly')
      }
      return existing
    }
    if (run.strictCleanupRetryBlocked && !allowRejectedRetry) {
      throw new HostAgentRunCoreError(
        'CLEANUP_FAILED',
        'The prior strict cleanup attempt rejected; explicit DELETE is required to retry',
      )
    }

    // Store the raw promise itself. Every bounded waiter races this same
    // attempt; abandoning a wait never creates a second provider-tree reap.
    const raw = Promise.resolve().then(() => this.#deps.sessions.disposeAndReap(sessionId))
    const attempt = { sessionId, raw }
    run.strictCleanupAttempt = attempt
    void raw.then(
      () => {
        void this.#serialize(run, async () => {
          this.#completeStrictCleanupNow(run, attempt)
          // A late strict-reap result is an ownership fact, not merely a
          // waiter notification. Initialization may already have returned a
          // cleanup failure while this raw attempt was pending; preserve that
          // failure until it is converted into a durable failed tombstone.
          if (this.#runs.get(run.handle) !== run) return
          if (run.initializationFailure
            && (run.state === 'accepted' || run.state === 'starting' || run.state === 'running')) {
            this.#commitLocalCleanupFailureNow(run, 'RUNTIME_UNAVAILABLE')
          }
          if (isHostAgentTerminalRunState(run.state) || run.state === 'closing') {
            await this.#closeRunNow(run, 'HOST_SHUTDOWN')
          }
        }).catch(() => undefined)
      },
      () => {
        if (run.strictCleanupAttempt === attempt) run.strictCleanupAttempt = undefined
        run.strictCleanupRetryBlocked = true
        run.cleanupDebt = new HostAgentRunCoreError(
          'CLEANUP_FAILED',
          'Transient Module session strict cleanup attempt rejected',
        )
        run.automaticRetentionBlocked = true
        this.#scheduleRetentionMaintenance()
      },
    )
    return attempt
  }

  async #awaitStrictCleanupNow(
    run: StoredRun,
    sessionId: string,
    allowRejectedRetry: boolean,
  ): Promise<void> {
    const attempt = this.#strictCleanupAttemptNow(run, sessionId, allowRejectedRetry)
    try {
      await this.#awaitWithinDuration(
        attempt.raw,
        this.#limits.maxCraftPreemptionMs,
        'Transient Module strict cleanup exceeded its deadline',
      )
    } catch {
      run.cleanupDebt = new HostAgentRunCoreError(
        'CLEANUP_FAILED',
        'Transient Module session strict cleanup did not finish',
      )
      run.automaticRetentionBlocked = true
      this.#scheduleRetentionMaintenance()
      throw run.cleanupDebt
    }
    this.#completeStrictCleanupNow(run, attempt)
  }

  #completeStrictCleanupNow(
    run: StoredRun,
    attempt: { sessionId: string; raw: Promise<void> },
  ): void {
    if (run.strictCleanupAttempt === attempt) run.strictCleanupAttempt = undefined
    if (run.sessionId !== attempt.sessionId) return
    run.sessionId = undefined
    run.initializationDisposition = 'not-created'
    run.cleanupDebt = undefined
    run.automaticRetentionBlocked = undefined
    run.strictCleanupRetryBlocked = undefined
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
        await this.#awaitStrictCleanupNow(run, sessionId, false)
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

  async #closeRunNow(
    run: StoredRun,
    reason: HostAgentInterruptionReason,
    allowStrictCleanupRetry = false,
  ): Promise<HostAgentRunSnapshot> {
    if (run.state === 'closed') return this.#snapshot(run)
    if (!isHostAgentTerminalRunState(run.state) && run.state !== 'closing') {
      await this.#interruptNow(run, reason)
    }
    if (isHostAgentTerminalRunState(run.state)) {
      try {
        if (run.sessionId) {
          await this.#awaitWithinDuration(
            this.#deps.sessions.updateRunState(run.sessionId, 'closing'),
            this.#limits.maxCraftPreemptionMs,
            'Transient Module closing state persistence exceeded its cleanup deadline',
          )
        }
        this.#setLocalStateNow(run, 'closing')
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
        await this.#awaitStrictCleanupNow(run, sessionId, allowStrictCleanupRetry)
      } catch {
        throw new HostAgentRunCoreError('CLEANUP_FAILED', 'Transient Module session cleanup did not finish')
      }
    }
    if (run.initializationDisposition === 'unknown') {
      run.cleanupDebt = new HostAgentRunCoreError(
        'CLEANUP_FAILED',
        'Transient Module session ownership is still awaiting an authoritative result',
      )
      run.automaticRetentionBlocked = true
      this.#scheduleRetentionMaintenance()
      throw run.cleanupDebt
    }
    const now = this.#clock.now()
    run.state = 'closed'
    run.updatedAt = now
    run.closedAt = now
    run.initializationDisposition = 'not-created'
    run.initializationFailure = undefined
    run.cleanupDebt = undefined
    run.automaticRetentionBlocked = undefined
    this.#emit(run, { type: 'run.closed', data: {} })
    this.#maintainRetainedRuns()
    return this.#snapshot(run)
  }

  async #setStateNow(run: StoredRun, next: HostAgentRunState): Promise<void> {
    if (!isHostAgentRunTransition(run.state, next)) {
      throw new HostAgentRunCoreError('INTERNAL_ERROR', `Invalid run transition ${run.state} -> ${next}`)
    }
    if (run.sessionId) await this.#deps.sessions.updateRunState(run.sessionId, next)
    this.#setLocalStateNow(run, next)
  }

  async #setActiveStateWithinRunDeadlineNow(
    run: StoredRun,
    next: 'starting' | 'running',
  ): Promise<void> {
    if (!isHostAgentRunTransition(run.state, next)) {
      throw new HostAgentRunCoreError('INTERNAL_ERROR', `Invalid run transition ${run.state} -> ${next}`)
    }
    if (run.sessionId) {
      await this.#awaitWithinRunDeadline(run, this.#deps.sessions.updateRunState(run.sessionId, next))
    }
    if (this.#runDeadlineExpired(run)) {
      throw new HostAgentRunCoreError('RUN_TIMEOUT', 'The Run exceeded its absolute deadline')
    }
    this.#setLocalStateNow(run, next)
  }

  #setLocalStateNow(run: StoredRun, next: HostAgentRunState): void {
    if (!isHostAgentRunTransition(run.state, next)) {
      throw new HostAgentRunCoreError('INTERNAL_ERROR', `Invalid run transition ${run.state} -> ${next}`)
    }
    const now = this.#clock.now()
    run.state = next
    run.updatedAt = Math.max(now, run.updatedAt)
    if (isHostAgentTerminalRunState(next)) {
      if (run.terminalAt === undefined) run.terminalAt = run.updatedAt
      // Idempotency uses the canonical request digest. Once a terminal is
      // committed, even a client that never sends DELETE cannot retain the
      // potentially 2 MiB prompt in the main Host.
      delete run.request
      this.#enforceTerminalReplayBudget()
      this.#scheduleRetentionMaintenance()
    }
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
    // Sequence ownership is committed only after replay accepts the event.
    // A contract-valid event may still exceed a deliberately smaller replay
    // budget; consuming its slot first would make the recovery terminal and
    // run.closed fail with a permanent sequence gap.
    run.replay.append(event)
    run.nextSequence += 1
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
      if (run.initializationFailure || run.cleanupDebt || (run.state === 'closing' && run.sessionId)) {
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
    const delayMs = Math.max(1, run.createdAt + this.#limits.maxRunDurationMs - this.#clock.now())
    run.timeoutHandle = this.#clock.setTimeout(() => {
      if (this.#runs.get(run.handle) !== run) return
      void this.#serialize(run, () => this.#timeoutRunNow(run)).catch(() => undefined)
    }, delayMs)
  }

  #runDeadlineExpired(run: StoredRun): boolean {
    return this.#clock.now() >= run.createdAt + this.#limits.maxRunDurationMs
  }

  async #awaitWithinRunDeadline<T>(run: StoredRun, operation: Promise<T>): Promise<T> {
    const remainingMs = run.createdAt + this.#limits.maxRunDurationMs - this.#clock.now()
    if (remainingMs <= 0) throw new HostAgentRunCoreError('RUN_TIMEOUT', 'The Run exceeded its absolute deadline')
    return await this.#awaitWithinDuration(operation, remainingMs, 'The Run exceeded its absolute deadline', 'RUN_TIMEOUT')
  }

  async #awaitWithinDuration<T>(
    operation: Promise<T>,
    timeoutMs: number,
    message: string,
    code: 'RUN_TIMEOUT' | 'CLEANUP_FAILED' = 'CLEANUP_FAILED',
  ): Promise<T> {
    let timeoutHandle: unknown
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutHandle = this.#clock.setTimeout(() => reject(new HostAgentRunCoreError(code, message)), timeoutMs)
    })
    try {
      return await Promise.race([operation, timeout])
    } finally {
      if (timeoutHandle !== undefined) this.#clock.clearTimeout(timeoutHandle)
    }
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
