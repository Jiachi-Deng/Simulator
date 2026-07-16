import {
  DEFAULT_MODULE_AGENT_LIMITS,
  MODULE_AGENT_CAPABILITY,
  MODULE_AGENT_CONTRACT_VERSION,
  ModuleAgentGatewayError,
  type CancelModuleAgentTurnResponse,
  type CreateModuleAgentSessionRequest,
  type CreateModuleAgentSessionResponse,
  type ModuleAgentAuthorization,
  type ModuleAgentCapabilitiesResponse,
  type ModuleAgentEvent,
  type ModuleAgentEventData,
  type ModuleAgentGatewayDependencies,
  type ModuleAgentGatewaySnapshot,
  type ModuleAgentGrant,
  type ModuleAgentGrantSpec,
  type ModuleAgentLimits,
  type ModuleAgentPortEvent,
  type ModuleAgentSubscription,
  type StartModuleAgentTurnRequest,
  type StartModuleAgentTurnResponse,
  type TrustedModuleAgentIdentity,
} from './types.ts'

interface StoredGrant extends ModuleAgentGrantSpec {
  grantToken: string
  workspaceRoot: string
  authorizedWorkingRoot: string
  defaultWorkingDirectory: string
  revoked: boolean
  sessions: Set<string>
  operationTail: Promise<void>
}

interface ActiveTurn {
  turnId: string
}

interface StoredSession {
  handle: string
  grantToken: string
  rawSessionId: string
  workingDirectory: string
  activeTurn?: ActiveTurn
  events: ModuleAgentEvent[]
  nextSequence: number
  listeners: Set<(event: ModuleAgentEvent) => void>
  unsubscribePort: () => void
  closing?: Promise<void>
}

const EMPTY_DATA: Record<string, never> = Object.freeze({})

export class ModuleAgentGateway {
  readonly #deps: ModuleAgentGatewayDependencies
  readonly #limits: ModuleAgentLimits
  readonly #grants = new Map<string, StoredGrant>()
  readonly #sessions = new Map<string, StoredSession>()

  constructor(dependencies: ModuleAgentGatewayDependencies) {
    this.#deps = dependencies
    this.#limits = Object.freeze({ ...DEFAULT_MODULE_AGENT_LIMITS, ...dependencies.limits })
  }

  get limits(): Readonly<ModuleAgentLimits> {
    return this.#limits
  }

  /** Process-local diagnostics for lifecycle leak tests. Never exposed on HTTP. */
  debugSnapshot(): ModuleAgentGatewaySnapshot {
    let activeTurns = 0
    let activeSubscribers = 0
    for (const session of this.#sessions.values()) {
      if (session.activeTurn) activeTurns += 1
      activeSubscribers += session.listeners.size
    }
    return {
      activeGrants: this.#grants.size,
      activeSessions: this.#sessions.size,
      activeTurns,
      activeSubscribers,
    }
  }

  /** Trusted transport helper: resolves a bearer to its Host-owned principal. */
  authorizationForGrant(grantToken: string): ModuleAgentAuthorization {
    const grant = this.#grants.get(grantToken)
    if (!grant) throw new ModuleAgentGatewayError('UNAUTHORIZED', 'Unknown launch grant')
    const authorization: ModuleAgentAuthorization = {
      grantToken,
      ownerId: grant.ownerId,
      moduleId: grant.moduleId,
      launchId: grant.launchId,
      lifecycleId: grant.lifecycleId,
    }
    this.#authorize(authorization)
    return authorization
  }

  async issueGrant(spec: ModuleAgentGrantSpec): Promise<ModuleAgentGrant> {
    this.#assertIdentity(spec)
    if (!spec.workspaceId.trim()) {
      throw new ModuleAgentGatewayError('INVALID_REQUEST', 'workspaceId is required')
    }
    if (!Number.isFinite(spec.expiresAt) || spec.expiresAt <= this.#now()) {
      throw new ModuleAgentGatewayError('INVALID_REQUEST', 'Grant expiry must be in the future')
    }

    const workspaceRoot = await this.#deps.pathAuthority.canonicalize(spec.workspaceRoot)
    const authorizedWorkingRoot = await this.#deps.pathAuthority.canonicalize(spec.authorizedWorkingRoot)
    const defaultWorkingDirectory = await this.#deps.pathAuthority.canonicalize(spec.defaultWorkingDirectory)
    if (!await this.#deps.pathAuthority.isEqualOrWithin(defaultWorkingDirectory, authorizedWorkingRoot)) {
      throw new ModuleAgentGatewayError('WORKSPACE_DENIED', 'Default working directory is outside the authorized project root')
    }

    let grantToken = ''
    for (let attempts = 0; attempts < 4; attempts += 1) {
      grantToken = this.#deps.tokenSource.createHex(32)
      if (/^[0-9a-f]{64}$/.test(grantToken) && !this.#grants.has(grantToken)) break
      grantToken = ''
    }
    if (!grantToken) {
      throw new ModuleAgentGatewayError('HOST_RUNTIME_ERROR', 'Unable to allocate a secure launch grant')
    }

    this.#grants.set(grantToken, {
      ...spec,
      grantToken,
      workspaceRoot,
      authorizedWorkingRoot,
      defaultWorkingDirectory,
      revoked: false,
      sessions: new Set(),
      operationTail: Promise.resolve(),
    })
    return {
      contractVersion: MODULE_AGENT_CONTRACT_VERSION,
      capability: MODULE_AGENT_CAPABILITY,
      grantToken,
      expiresAt: spec.expiresAt,
    }
  }

  /** Trusted launch supervisor renewal. Never exposed through the Module HTTP API. */
  renewGrant(grantToken: string, expiresAt: number): ModuleAgentGrant {
    const grant = this.#grants.get(grantToken)
    if (!grant || grant.revoked) throw new ModuleAgentGatewayError('UNAUTHORIZED', 'Unknown launch grant')
    // Renewal may extend a live lease but must never resurrect an authority
    // whose original expiry elapsed during sleep or event-loop suspension.
    this.#assertGrantActive(grant)
    if (!Number.isFinite(expiresAt) || expiresAt <= this.#now()) {
      throw new ModuleAgentGatewayError('INVALID_REQUEST', 'Grant expiry must be in the future')
    }
    grant.expiresAt = expiresAt
    return {
      contractVersion: MODULE_AGENT_CONTRACT_VERSION,
      capability: MODULE_AGENT_CAPABILITY,
      grantToken,
      expiresAt,
    }
  }

  getCapabilities(authorization: ModuleAgentAuthorization): ModuleAgentCapabilitiesResponse {
    this.#authorize(authorization)
    return {
      contractVersion: MODULE_AGENT_CONTRACT_VERSION,
      capability: MODULE_AGENT_CAPABILITY,
      features: { streaming: true, cancellation: true, multiTurn: true },
      limits: {
        maxPromptBytes: this.#limits.maxPromptBytes,
        maxReplayEvents: this.#limits.maxReplayEvents,
      },
    }
  }

  async createSession(
    authorization: ModuleAgentAuthorization,
    request: CreateModuleAgentSessionRequest,
  ): Promise<CreateModuleAgentSessionResponse> {
    this.#assertVersion(request.contractVersion)
    const grant = this.#authorize(authorization)
    return this.#runGrantExclusive(grant, async () => {
      this.#assertGrantActive(grant)
      if (grant.sessions.size >= this.#limits.maxSessionsPerGrant) {
        throw new ModuleAgentGatewayError('SESSION_LIMIT', 'Launch grant session limit reached')
      }

      const workingDirectory = await this.#deps.pathAuthority.canonicalize(
        request.workingDirectory ?? grant.defaultWorkingDirectory,
      )
      this.#assertGrantActive(grant)
      if (!await this.#deps.pathAuthority.isEqualOrWithin(workingDirectory, grant.authorizedWorkingRoot)) {
        throw new ModuleAgentGatewayError('WORKSPACE_DENIED', 'Working directory is outside the authorized project root')
      }

      const created = await this.#deps.port.createSession({
        workspaceId: grant.workspaceId,
        workspaceRoot: grant.workspaceRoot,
        authorizedWorkingRoot: grant.authorizedWorkingRoot,
        workingDirectory,
      })
      const handle = this.#uniqueOpaqueId('session')
      const record: StoredSession = {
        handle,
        grantToken: grant.grantToken,
        rawSessionId: created.sessionId,
        workingDirectory,
        events: [],
        nextSequence: 1,
        listeners: new Set(),
        unsubscribePort: () => undefined,
      }
      // Register cleanup ownership before any post-create validation. A revoke
      // racing the awaited Host create can therefore never orphan a raw session.
      this.#sessions.set(handle, record)
      grant.sessions.add(handle)

      const validSession = created.hidden
        && created.workspaceId === grant.workspaceId
        && created.workspaceRoot === grant.workspaceRoot
        && created.workingDirectory === workingDirectory
      if (!validSession || !this.#isGrantActive(grant)) {
        try {
          await this.#closeStoredSession(record)
        } catch {
          throw new ModuleAgentGatewayError('HOST_RUNTIME_ERROR', 'Host could not clean up a rejected module session')
        }
        if (!validSession) {
          throw new ModuleAgentGatewayError('HOST_RUNTIME_ERROR', 'Host created a session outside the launch grant')
        }
        this.#assertGrantActive(grant)
      }

      try {
        record.unsubscribePort = await this.#deps.port.subscribe(created.sessionId, (event) => {
          this.#receivePortEvent(record, event)
        })
      } catch {
        try {
          await this.#closeStoredSession(record)
        } catch {
          throw new ModuleAgentGatewayError('HOST_RUNTIME_ERROR', 'Host could not clean up an unsubscribed module session')
        }
        throw new ModuleAgentGatewayError('HOST_RUNTIME_ERROR', 'Host could not subscribe to the module session')
      }
      this.#emit(record, { type: 'session.ready', data: EMPTY_DATA })
      return { contractVersion: MODULE_AGENT_CONTRACT_VERSION, sessionHandle: handle, state: 'idle' }
    })
  }

  async startTurn(
    authorization: ModuleAgentAuthorization,
    sessionHandle: string,
    request: StartModuleAgentTurnRequest,
  ): Promise<StartModuleAgentTurnResponse> {
    this.#assertVersion(request.contractVersion)
    const session = this.#ownedSession(authorization, sessionHandle)
    if (session.activeTurn) {
      throw new ModuleAgentGatewayError('TURN_ACTIVE', 'Only one turn may run in a module session')
    }
    if (typeof request.prompt !== 'string' || request.prompt.trim().length === 0) {
      throw new ModuleAgentGatewayError('INVALID_REQUEST', 'A non-empty prompt is required')
    }
    if (new TextEncoder().encode(request.prompt).byteLength > this.#limits.maxPromptBytes) {
      throw new ModuleAgentGatewayError('PROMPT_TOO_LARGE', 'Prompt exceeds the host limit')
    }

    const turnId = this.#uniqueOpaqueId('turn')
    session.activeTurn = { turnId }
    this.#emit(session, { type: 'turn.started', data: EMPTY_DATA }, turnId)
    try {
      await this.#deps.port.sendTurn(session.rawSessionId, request.prompt)
    } catch {
      if (session.activeTurn?.turnId === turnId) {
        session.activeTurn = undefined
        this.#emit(session, { type: 'turn.failed', data: { code: 'HOST_RUNTIME_ERROR' } }, turnId)
      }
      throw new ModuleAgentGatewayError('HOST_RUNTIME_ERROR', 'Host runtime rejected the turn')
    }
    return { contractVersion: MODULE_AGENT_CONTRACT_VERSION, turnId, state: 'running' }
  }

  subscribe(
    authorization: ModuleAgentAuthorization,
    sessionHandle: string,
    afterSequence: number,
    listener: (event: ModuleAgentEvent) => void,
  ): ModuleAgentSubscription {
    const session = this.#ownedSession(authorization, sessionHandle)
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new ModuleAgentGatewayError('INVALID_REQUEST', 'afterSequence must be a non-negative safe integer')
    }
    if (session.listeners.size >= this.#limits.maxSubscribersPerSession) {
      throw new ModuleAgentGatewayError('SUBSCRIBER_LIMIT', 'Session subscriber limit reached')
    }

    const earliestSequence = session.events[0]?.sequence ?? session.nextSequence
    const latestSequence = session.events.at(-1)?.sequence ?? 0
    const replayTruncated = afterSequence < earliestSequence - 1
    if (replayTruncated) {
      throw new ModuleAgentGatewayError('REPLAY_TRUNCATED', 'Requested Module Agent events are no longer available')
    }
    for (const event of session.events) {
      if (event.sequence > afterSequence) this.#safeNotify(listener, event)
    }
    session.listeners.add(listener)
    let subscribed = true
    return {
      earliestSequence,
      latestSequence,
      replayTruncated,
      unsubscribe: () => {
        if (!subscribed) return
        subscribed = false
        session.listeners.delete(listener)
      },
    }
  }

  async cancelTurn(
    authorization: ModuleAgentAuthorization,
    sessionHandle: string,
  ): Promise<CancelModuleAgentTurnResponse> {
    const session = this.#ownedSession(authorization, sessionHandle)
    const active = session.activeTurn
    if (!active) {
      return { contractVersion: MODULE_AGENT_CONTRACT_VERSION, state: 'idle' }
    }
    await this.#deps.port.cancelTurn(session.rawSessionId)
    if (session.activeTurn?.turnId === active.turnId) {
      session.activeTurn = undefined
      this.#emit(session, { type: 'turn.cancelled', data: EMPTY_DATA }, active.turnId)
    }
    return { contractVersion: MODULE_AGENT_CONTRACT_VERSION, state: 'cancelling' }
  }

  async closeSession(authorization: ModuleAgentAuthorization, sessionHandle: string): Promise<void> {
    const session = this.#ownedSession(authorization, sessionHandle)
    await this.#closeStoredSession(session)
  }

  async revokeGrant(grantToken: string): Promise<void> {
    const grant = this.#grants.get(grantToken)
    if (!grant) return
    grant.revoked = true
    await this.#runGrantExclusive(grant, async () => {
      let firstError: unknown
      for (const handle of [...grant.sessions]) {
        const session = this.#sessions.get(handle)
        if (!session) {
          grant.sessions.delete(handle)
          continue
        }
        try {
          await this.#closeStoredSession(session)
        } catch (error) {
          firstError ??= error
        }
      }
      if (grant.sessions.size === 0) this.#grants.delete(grantToken)
      if (firstError) throw firstError
    })
  }

  #receivePortEvent(session: StoredSession, event: ModuleAgentPortEvent): void {
    if (session.closing || event.sessionId !== session.rawSessionId) return
    const active = session.activeTurn
    switch (event.type) {
      case 'message.delta':
        if (active) this.#emit(session, { type: 'message.delta', data: { delta: event.delta } }, active.turnId)
        return
      case 'message.completed':
        if (active) this.#emit(session, { type: 'message.completed', data: { text: event.text } }, active.turnId)
        return
      case 'activity':
        if (active) {
          this.#emit(session, {
            type: 'activity',
            data: {
              phase: event.phase,
              kind: event.kind,
              ...(event.label ? { label: event.label } : {}),
            },
          }, active.turnId)
        }
        return
      case 'turn.completed':
        if (active) {
          session.activeTurn = undefined
          this.#emit(session, {
            type: 'turn.completed',
            data: event.finalText ? { text: event.finalText } : {},
          }, active.turnId)
        }
        return
      case 'turn.failed':
        if (active) {
          session.activeTurn = undefined
          this.#emit(session, { type: 'turn.failed', data: { code: event.code } }, active.turnId)
        }
        return
      case 'turn.cancelled':
        if (active) {
          session.activeTurn = undefined
          this.#emit(session, { type: 'turn.cancelled', data: EMPTY_DATA }, active.turnId)
        }
    }
  }

  async #closeStoredSession(session: StoredSession): Promise<void> {
    if (session.closing) return session.closing
    const operation = this.#performCloseStoredSession(session)
    session.closing = operation
    try {
      await operation
    } catch (error) {
      if (session.closing === operation) session.closing = undefined
      throw error
    }
  }

  async #performCloseStoredSession(session: StoredSession): Promise<void> {
    const active = session.activeTurn
    if (active) {
      try {
        await this.#deps.port.cancelTurn(session.rawSessionId)
        await this.#deps.port.awaitStopped(session.rawSessionId)
        session.activeTurn = undefined
        this.#emit(session, { type: 'turn.cancelled', data: EMPTY_DATA }, active.turnId)
      } catch {
        // Deletion remains the hard cleanup primitive; try it even when cancel
        // fails. If deletion also fails, ownership is retained for retry.
      }
    }
    try {
      await this.#deps.port.disposeAndReap(session.rawSessionId)
    } catch (error) {
      throw error
    }
    if (session.activeTurn) {
      const stillActive = session.activeTurn
      session.activeTurn = undefined
      this.#emit(session, { type: 'turn.cancelled', data: EMPTY_DATA }, stillActive.turnId)
    }
    this.#emit(session, { type: 'session.closed', data: EMPTY_DATA })
    session.unsubscribePort()
    session.listeners.clear()
    this.#sessions.delete(session.handle)
    const grant = this.#grants.get(session.grantToken)
    grant?.sessions.delete(session.handle)
    if (grant?.revoked && grant.sessions.size === 0) this.#grants.delete(session.grantToken)
  }

  #authorize(authorization: ModuleAgentAuthorization): StoredGrant {
    const grant = this.#grants.get(authorization.grantToken)
    if (!grant) throw new ModuleAgentGatewayError('UNAUTHORIZED', 'Unknown launch grant')
    if (grant.revoked) throw new ModuleAgentGatewayError('GRANT_REVOKED', 'Launch grant was revoked')
    if (grant.expiresAt <= this.#now()) throw new ModuleAgentGatewayError('GRANT_EXPIRED', 'Launch grant expired')
    if (
      grant.ownerId !== authorization.ownerId
      || grant.moduleId !== authorization.moduleId
      || grant.launchId !== authorization.launchId
      || grant.lifecycleId !== authorization.lifecycleId
    ) {
      throw new ModuleAgentGatewayError('UNAUTHORIZED', 'Launch identity does not match grant')
    }
    return grant
  }

  #isGrantActive(grant: StoredGrant): boolean {
    return this.#grants.get(grant.grantToken) === grant
      && !grant.revoked
      && grant.expiresAt > this.#now()
  }

  #assertGrantActive(grant: StoredGrant): void {
    if (this.#grants.get(grant.grantToken) !== grant || grant.revoked) {
      throw new ModuleAgentGatewayError('GRANT_REVOKED', 'Launch grant was revoked')
    }
    if (grant.expiresAt <= this.#now()) {
      throw new ModuleAgentGatewayError('GRANT_EXPIRED', 'Launch grant expired')
    }
  }

  async #runGrantExclusive<T>(grant: StoredGrant, operation: () => Promise<T>): Promise<T> {
    const previous = grant.operationTail
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    grant.operationTail = previous.then(() => gate)
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }

  #ownedSession(authorization: ModuleAgentAuthorization, handle: string): StoredSession {
    const grant = this.#authorize(authorization)
    const session = this.#sessions.get(handle)
    if (!session || session.grantToken !== grant.grantToken || !grant.sessions.has(handle)) {
      throw new ModuleAgentGatewayError('SESSION_NOT_FOUND', 'Module session was not found')
    }
    return session
  }

  #emit(session: StoredSession, event: ModuleAgentEventData, turnId?: string): void {
    const bounded = this.#boundEvent(event)
    const envelope: ModuleAgentEvent = {
      contractVersion: MODULE_AGENT_CONTRACT_VERSION,
      sequence: session.nextSequence++,
      sessionHandle: session.handle,
      ...(turnId ? { turnId } : {}),
      occurredAt: this.#now(),
      ...bounded,
    }
    session.events.push(envelope)
    if (session.events.length > this.#limits.maxReplayEvents) session.events.shift()
    for (const listener of session.listeners) this.#safeNotify(listener, envelope)
  }

  #boundEvent(event: ModuleAgentEventData): ModuleAgentEventData {
    const clip = (value: string) => value.slice(0, this.#limits.maxEventTextLength)
    switch (event.type) {
      case 'message.delta': return { type: event.type, data: { delta: clip(event.data.delta) } }
      case 'message.completed': return { type: event.type, data: { text: clip(event.data.text) } }
      case 'turn.completed': return { type: event.type, data: event.data.text ? { text: clip(event.data.text) } : {} }
      case 'activity': return {
        type: event.type,
        data: {
          phase: event.data.phase,
          kind: event.data.kind,
          ...(event.data.label ? { label: clip(event.data.label) } : {}),
        },
      }
      default: return event
    }
  }

  #safeNotify(listener: (event: ModuleAgentEvent) => void, event: ModuleAgentEvent): void {
    try { listener(event) } catch { /* A Module stream cannot break Host execution. */ }
  }

  #assertIdentity(identity: TrustedModuleAgentIdentity): void {
    for (const value of [identity.ownerId, identity.moduleId, identity.launchId, identity.lifecycleId]) {
      if (typeof value !== 'string' || value.trim().length === 0 || value.length > 256) {
        throw new ModuleAgentGatewayError('INVALID_REQUEST', 'Launch identity fields must be non-empty bounded strings')
      }
    }
  }

  #assertVersion(version: number): void {
    if (version !== MODULE_AGENT_CONTRACT_VERSION) {
      throw new ModuleAgentGatewayError('INVALID_CONTRACT_VERSION', 'Unsupported Module Agent contract version')
    }
  }

  #uniqueOpaqueId(prefix: 'session' | 'turn'): string {
    for (let attempts = 0; attempts < 4; attempts += 1) {
      const candidate = `${prefix}_${this.#deps.tokenSource.createHex(16)}`
      if (/^(session|turn)_[0-9a-f]{32}$/.test(candidate) && !this.#sessions.has(candidate)) return candidate
    }
    throw new ModuleAgentGatewayError('HOST_RUNTIME_ERROR', 'Unable to allocate an opaque identifier')
  }

  #now(): number {
    return this.#deps.clock?.now() ?? Date.now()
  }
}
