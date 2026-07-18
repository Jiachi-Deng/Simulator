import type {
  CreateHostModuleSessionInput,
  CreatedHostModuleSession,
  ModuleAgentPathAuthority,
  ModuleAgentPortEvent,
  ModuleAgentSessionPort,
} from '@simulator/module-agent-gateway'
import type { ISessionManager } from '../handlers/session-manager-interface'
import type {
  BackendCredentialAuthoritySnapshot,
  BackendRuntimeAuthoritySnapshot,
} from '@craft-agent/shared/agent/backend'
import type { ModuleAgentRunMetadata } from '@craft-agent/shared/sessions'
import type {
  CreateHostAgentSessionInput,
  CreatedHostAgentSession,
  HostAgentRunSessionPort,
  HostAgentSessionEvent,
} from '@simulator/host-agent-run-core'
import {
  markModuleAgentSession,
  registerModuleAgentToolBoundary,
  unregisterModuleAgentToolBoundary,
} from '@craft-agent/shared/agent'
import { createHash, randomBytes } from 'node:crypto'

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/**
 * Acceptance-only provider authority owned by the Electron Host. The normal
 * production path omits this dependency entirely. When present, every Module
 * Session must be admitted against the exact in-memory Connection pinned by H1.
 */
export interface ModuleAgentConnectionAdmission {
  admit(workspaceId: string): Promise<Readonly<{
    llmConnection: string
    provider: BackendRuntimeAuthoritySnapshot['provider']
    authType: BackendRuntimeAuthoritySnapshot['authType']
    resolvedModel: string
  }>>
  assertConnection(input: Readonly<{
    workspaceId: string
  } & BackendRuntimeAuthoritySnapshot>): Promise<void>
  assertCredential(input: Readonly<{
    workspaceId: string
    llmConnection: string
    credential: BackendCredentialAuthoritySnapshot
  }>): Promise<void>
}

interface AdmittedSessionConnection {
  readonly workspaceId: string
  readonly llmConnection: string
  readonly provider: BackendRuntimeAuthoritySnapshot['provider']
  readonly authType: BackendRuntimeAuthoritySnapshot['authType']
  readonly resolvedModel: string
}

function runtimeSnapshot(admitted: AdmittedSessionConnection): BackendRuntimeAuthoritySnapshot {
  return Object.freeze({
    connectionSlug: admitted.llmConnection,
    provider: admitted.provider,
    authType: admitted.authType,
    resolvedModel: admitted.resolvedModel,
  })
}

/**
 * Compatibility-only ownership for the v1 Gateway, which creates its public
 * session handle after the Host session port returns. v2 ModuleAgentRunCore
 * must supply its final idempotency/request digests and worker epoch directly.
 */
export function createLegacyV1ModuleAgentRunMetadata(
  input: CreateHostModuleSessionInput,
): ModuleAgentRunMetadata {
  const nonce = randomBytes(32).toString('hex')
  const ownershipSeed = sha256(JSON.stringify({
    contractVersion: 1,
    moduleId: 'open-design',
    workspaceId: input.workspaceId,
    workspaceRoot: input.workspaceRoot,
    authorizedWorkingRoot: input.authorizedWorkingRoot,
    workingDirectory: input.workingDirectory,
    nonce,
  }))

  return {
    transient: true,
    contractVersion: 1,
    moduleId: 'open-design',
    runHandle: `run_${sha256(`run:${ownershipSeed}`).slice(0, 32)}`,
    idempotencyKeyDigest: sha256(`idempotency:${ownershipSeed}`),
    requestDigest: sha256(`request:${ownershipSeed}`),
    workerEpoch: `epoch_${sha256(`epoch:${ownershipSeed}`).slice(0, 32)}`,
    state: 'accepted',
  }
}

/**
 * The only trusted adapter between Module Agent Gateway and Craft's full
 * SessionManager. It deliberately does not expose ISessionManager to modules.
 */
export class CraftModuleAgentSessionPort implements ModuleAgentSessionPort {
  private readonly localListeners = new Map<string, Set<(event: ModuleAgentPortEvent) => void>>()
  private readonly admittedConnections = new Map<string, AdmittedSessionConnection>()

  constructor(
    private readonly sessions: ISessionManager,
    private readonly paths: ModuleAgentPathAuthority,
    private readonly connectionAdmission?: ModuleAgentConnectionAdmission,
  ) {}

  async createSession(input: CreateHostModuleSessionInput): Promise<CreatedHostModuleSession> {
    const workspace = this.sessions.getWorkspaces().find((candidate) => candidate.id === input.workspaceId)
    if (!workspace) throw new Error('Authorized Craft workspace no longer exists')

    const actualWorkspaceRoot = await this.paths.canonicalize(workspace.rootPath)
    const expectedWorkspaceRoot = await this.paths.canonicalize(input.workspaceRoot)
    if (actualWorkspaceRoot !== expectedWorkspaceRoot) {
      throw new Error('Craft workspace root does not match the launch grant')
    }
    const authorizedWorkingRoot = await this.paths.canonicalize(input.authorizedWorkingRoot)
    const workingDirectory = await this.paths.canonicalize(input.workingDirectory)
    if (!await this.paths.isEqualOrWithin(workingDirectory, authorizedWorkingRoot)) {
      throw new Error('Module working directory is outside the launch grant')
    }

    const admitted = await this.connectionAdmission?.admit(input.workspaceId)

    const session = await this.sessions.createSession(input.workspaceId, {
      name: 'OpenDesign',
      hidden: true,
      workingDirectory,
      enabledSourceSlugs: [],
      ...(admitted ? {
        llmConnection: admitted.llmConnection,
        model: admitted.resolvedModel,
      } : {}),
      // OpenDesign tasks may create project artifacts. A Host-owned session
      // boundary is registered below before any prompt can reach this session.
      permissionMode: 'allow-all',
    }, {
      emitCreatedEvent: false,
      moduleAgentRun: createLegacyV1ModuleAgentRunMetadata(input),
    })
    const returnedWorkingDirectory = session.workingDirectory
      ? await this.paths.canonicalize(session.workingDirectory)
      : ''
    if (!session.hidden || session.workspaceId !== input.workspaceId || returnedWorkingDirectory !== workingDirectory
      || (admitted && (session.llmConnection !== admitted.llmConnection
        || session.model !== admitted.resolvedModel))) {
      await this.sessions.deleteSession(session.id).catch(() => undefined)
      throw new Error('Craft created an invalid hidden module session')
    }
    if (admitted) {
      try {
        await this.connectionAdmission!.assertConnection({
          workspaceId: input.workspaceId,
          ...runtimeSnapshot({ workspaceId: input.workspaceId, ...admitted }),
        })
      } catch (error) {
        await this.sessions.deleteSession(session.id).catch(() => undefined)
        throw error
      }
      this.admittedConnections.set(session.id, {
        workspaceId: input.workspaceId,
        ...admitted,
      })
    }
    // Mark first so any accidental queued/tool work between session creation
    // and boundary installation fails closed. createSession does not return to
    // the Gateway until the canonical boundary is active.
    markModuleAgentSession(session.id)
    try {
      // The launch grant may cover the Module's whole data area so it can
      // select a project, but an Agent session is confined to the one
      // canonical project directory selected at creation time. This prevents
      // one OpenDesign project from reading sibling projects or daemon data.
      registerModuleAgentToolBoundary(session.id, workingDirectory, workingDirectory)
    } catch (error) {
      this.admittedConnections.delete(session.id)
      unregisterModuleAgentToolBoundary(session.id)
      await this.sessions.deleteSession(session.id).catch(() => undefined)
      throw error
    }
    return {
      sessionId: session.id,
      workspaceId: session.workspaceId,
      workspaceRoot: actualWorkspaceRoot,
      workingDirectory: returnedWorkingDirectory,
      hidden: true,
    }
  }

  async sendTurn(sessionId: string, prompt: string): Promise<void> {
    let assertProviderAuthority: ((snapshot: BackendRuntimeAuthoritySnapshot) => Promise<void>) | undefined
    let assertCredentialAuthority: ((snapshot: BackendCredentialAuthoritySnapshot) => Promise<void>) | undefined
    if (this.connectionAdmission) {
      const admitted = this.admittedConnections.get(sessionId)
      if (!admitted) throw new Error('Host provider admission failed')
      assertProviderAuthority = (snapshot) => this.connectionAdmission!.assertConnection({
        workspaceId: admitted.workspaceId,
        ...snapshot,
      })
      assertCredentialAuthority = (credential) => this.connectionAdmission!.assertCredential({
        workspaceId: admitted.workspaceId,
        llmConnection: admitted.llmConnection,
        credential,
      })
      try {
        await assertProviderAuthority(runtimeSnapshot(admitted))
      } catch {
        this.emitLocal({ type: 'turn.failed', sessionId, code: 'HOST_RUNTIME_ERROR' })
        throw new Error('Host provider admission failed')
      }
    }
    // Outside acceptance, SessionManager resolves the existing
    // workspace/global Host default and locks it when the first backend starts.
    // Start asynchronously: awaiting the whole SessionManager turn here would
    // block the HTTP response and make streaming/cancellation unusable.
    const turn = this.sessions.sendLegacyModuleAgentMessage(
      sessionId,
      prompt,
      assertProviderAuthority,
      assertCredentialAuthority,
    )
    void turn.catch(() => {
      this.emitLocal({ type: 'turn.failed', sessionId, code: 'HOST_RUNTIME_ERROR' })
    })
  }

  cancelTurn(sessionId: string): Promise<void> {
    return this.sessions.cancelProcessing(sessionId, true)
  }

  awaitStopped(sessionId: string): Promise<void> {
    return this.sessions.awaitSessionStopped(sessionId)
  }

  async disposeAndReap(sessionId: string): Promise<void> {
    await this.sessions.disposeSessionAndReap(sessionId)
    unregisterModuleAgentToolBoundary(sessionId)
    this.admittedConnections.delete(sessionId)
    this.localListeners.delete(sessionId)
  }

  subscribe(sessionId: string, listener: (event: ModuleAgentPortEvent) => void): () => void {
    const local = this.localListeners.get(sessionId) ?? new Set<(event: ModuleAgentPortEvent) => void>()
    local.add(listener)
    this.localListeners.set(sessionId, local)
    const unsubscribeEvents = this.sessions.onModuleAgentRuntimeEvent((event) => {
      if (event.sessionId === sessionId) listener(event)
    })
    const unsubscribeCompletion = this.sessions.onSessionComplete((event) => {
      if (event.sessionId !== sessionId) return
      switch (event.reason) {
        case 'complete':
          listener({ type: 'turn.completed', sessionId, finalText: event.finalText })
          break
        case 'interrupted':
          listener({ type: 'turn.cancelled', sessionId })
          break
        case 'timeout':
          listener({ type: 'turn.failed', sessionId, code: 'HOST_RUNTIME_TIMEOUT' })
          break
        case 'error':
          listener({ type: 'turn.failed', sessionId, code: 'HOST_RUNTIME_ERROR' })
          break
      }
    })
    return () => {
      local.delete(listener)
      if (local.size === 0) this.localListeners.delete(sessionId)
      unsubscribeEvents()
      unsubscribeCompletion()
    }
  }

  private emitLocal(event: ModuleAgentPortEvent): void {
    for (const listener of this.localListeners.get(event.sessionId) ?? []) listener(event)
  }
}

/**
 * v2 one-Turn Session seam. Unlike the v1 compatibility adapter, ownership is
 * allocated by ModuleAgentRunCore before Session creation and is therefore
 * written in the very first JSONL header transaction.
 */
export class CraftHostAgentRunSessionPort implements HostAgentRunSessionPort {
  private readonly localListeners = new Map<string, Set<(event: HostAgentSessionEvent) => void>>()
  private readonly admittedConnections = new Map<string, AdmittedSessionConnection>()

  constructor(
    private readonly sessions: ISessionManager,
    private readonly paths: ModuleAgentPathAuthority,
    private readonly connectionAdmission?: ModuleAgentConnectionAdmission,
  ) {}

  async createSession(input: CreateHostAgentSessionInput): Promise<CreatedHostAgentSession> {
    const workspace = this.sessions.getWorkspaces().find((candidate) => candidate.id === input.workspaceId)
    if (!workspace) throw new Error('Authorized Craft workspace no longer exists')

    const actualWorkspaceRoot = await this.paths.canonicalize(workspace.rootPath)
    const expectedWorkspaceRoot = await this.paths.canonicalize(input.workspaceRoot)
    if (actualWorkspaceRoot !== expectedWorkspaceRoot) {
      throw new Error('Craft workspace root does not match the v2 launch grant')
    }
    const authorizedWorkingRoot = await this.paths.canonicalize(input.authorizedWorkingRoot)
    const workingDirectory = await this.paths.canonicalize(input.workingDirectory)
    if (!await this.paths.isEqualOrWithin(workingDirectory, authorizedWorkingRoot)) {
      throw new Error('Module working directory is outside the v2 launch grant')
    }

    const admitted = await this.connectionAdmission?.admit(input.workspaceId)

    const ownership = parseV2Ownership(input.ownership)
    const session = await this.sessions.createSession(input.workspaceId, {
      name: 'OpenDesign',
      hidden: true,
      workingDirectory,
      enabledSourceSlugs: [],
      permissionMode: 'allow-all',
      ...(admitted ? {
        llmConnection: admitted.llmConnection,
        model: admitted.resolvedModel,
      } : {}),
    }, {
      emitCreatedEvent: false,
      moduleAgentRun: ownership,
    })
    const returnedWorkingDirectory = session.workingDirectory
      ? await this.paths.canonicalize(session.workingDirectory)
      : ''
    if (!session.hidden || session.workspaceId !== input.workspaceId || returnedWorkingDirectory !== workingDirectory
      || (admitted && (session.llmConnection !== admitted.llmConnection
        || session.model !== admitted.resolvedModel))) {
      await this.sessions.deleteSession(session.id).catch(() => undefined)
      throw new Error('Craft created an invalid hidden v2 Module session')
    }

    if (admitted) {
      try {
        await this.connectionAdmission!.assertConnection({
          workspaceId: input.workspaceId,
          ...runtimeSnapshot({ workspaceId: input.workspaceId, ...admitted }),
        })
      } catch (error) {
        await this.sessions.deleteSession(session.id).catch(() => undefined)
        throw error
      }
      this.admittedConnections.set(session.id, {
        workspaceId: input.workspaceId,
        ...admitted,
      })
    }

    // Mark before installing the canonical boundary. Any unexpected work in
    // this narrow window is rejected by the centralized PreToolUse gate.
    markModuleAgentSession(session.id)
    try {
      registerModuleAgentToolBoundary(session.id, workingDirectory, workingDirectory)
    } catch (error) {
      this.admittedConnections.delete(session.id)
      unregisterModuleAgentToolBoundary(session.id)
      await this.sessions.deleteSession(session.id).catch(() => undefined)
      throw error
    }
    return {
      sessionId: session.id,
      workspaceId: session.workspaceId,
      workspaceRoot: actualWorkspaceRoot,
      workingDirectory: returnedWorkingDirectory,
      hidden: true,
    }
  }

  async recoverSession(input: CreateHostAgentSessionInput): Promise<CreatedHostAgentSession | undefined> {
    const workspace = this.sessions.getWorkspaces().find((candidate) => candidate.id === input.workspaceId)
    if (!workspace) throw new Error('Authorized Craft workspace no longer exists')

    const actualWorkspaceRoot = await this.paths.canonicalize(workspace.rootPath)
    const expectedWorkspaceRoot = await this.paths.canonicalize(input.workspaceRoot)
    if (actualWorkspaceRoot !== expectedWorkspaceRoot) {
      throw new Error('Craft workspace root does not match the v2 recovery grant')
    }
    const authorizedWorkingRoot = await this.paths.canonicalize(input.authorizedWorkingRoot)
    const workingDirectory = await this.paths.canonicalize(input.workingDirectory)
    if (!await this.paths.isEqualOrWithin(workingDirectory, authorizedWorkingRoot)) {
      throw new Error('Module working directory is outside the v2 recovery grant')
    }

    const admitted = await this.connectionAdmission?.admit(input.workspaceId)

    const session = await this.sessions.recoverModuleAgentSession({
      workspaceId: input.workspaceId,
      workingDirectory,
      ownership: parseV2Ownership(input.ownership),
    })
    if (!session) return undefined

    const returnedWorkingDirectory = session.workingDirectory
      ? await this.paths.canonicalize(session.workingDirectory)
      : ''
    if (!session.hidden
      || session.workspaceId !== input.workspaceId
      || returnedWorkingDirectory !== workingDirectory
      || (admitted && (session.llmConnection !== admitted.llmConnection
        || session.model !== admitted.resolvedModel))) {
      throw new Error('Craft recovered an invalid hidden v2 Module session')
    }

    if (admitted) {
      await this.connectionAdmission!.assertConnection({
        workspaceId: input.workspaceId,
        ...runtimeSnapshot({ workspaceId: input.workspaceId, ...admitted }),
      })
      this.admittedConnections.set(session.id, {
        workspaceId: input.workspaceId,
        ...admitted,
      })
    }

    // A recovered Session is never usable until its canonical boundary is
    // reinstalled. Keep the mark on registration failure so every tool remains
    // fail-closed; do not delete durable ownership while recovery is uncertain.
    markModuleAgentSession(session.id)
    registerModuleAgentToolBoundary(session.id, workingDirectory, workingDirectory)
    return {
      sessionId: session.id,
      workspaceId: session.workspaceId,
      workspaceRoot: actualWorkspaceRoot,
      workingDirectory: returnedWorkingDirectory,
      hidden: true,
    }
  }

  updateRunState(sessionId: string, state: Parameters<HostAgentRunSessionPort['updateRunState']>[1]): Promise<void> {
    return this.sessions.updateModuleAgentRunState(sessionId, state)
  }

  async sendTurn(sessionId: string, prompt: string): Promise<void> {
    try {
      let assertProviderAuthority: ((snapshot: BackendRuntimeAuthoritySnapshot) => Promise<void>) | undefined
      let assertCredentialAuthority: ((snapshot: BackendCredentialAuthoritySnapshot) => Promise<void>) | undefined
      if (this.connectionAdmission) {
        const admitted = this.admittedConnections.get(sessionId)
        if (!admitted) throw new Error('Acceptance Connection admission is missing')
        assertProviderAuthority = (snapshot) => this.connectionAdmission!.assertConnection({
          workspaceId: admitted.workspaceId,
          ...snapshot,
        })
        assertCredentialAuthority = (credential) => this.connectionAdmission!.assertCredential({
          workspaceId: admitted.workspaceId,
          llmConnection: admitted.llmConnection,
          credential,
        })
        await assertProviderAuthority(runtimeSnapshot(admitted))
      }
      // This resolves at the provider-admission boundary, not at end-of-turn.
      // RunCore can therefore publish `running` only after every cancellable
      // SessionManager preflight has completed.
      await this.sessions.sendModuleAgentMessage(
        sessionId,
        prompt,
        assertProviderAuthority,
        assertCredentialAuthority,
      )
    } catch {
      this.emitLocal({ type: 'turn.failed', sessionId, code: 'RUNTIME_UNAVAILABLE' })
      throw new Error('Host provider admission failed')
    }
  }

  cancelTurn(sessionId: string): Promise<void> {
    return this.sessions.cancelProcessing(sessionId, true)
  }

  awaitStopped(sessionId: string): Promise<void> {
    return this.sessions.awaitSessionStopped(sessionId)
  }

  async disposeAndReap(sessionId: string): Promise<void> {
    await this.sessions.disposeSessionAndReap(sessionId)
    unregisterModuleAgentToolBoundary(sessionId)
    this.admittedConnections.delete(sessionId)
    this.localListeners.delete(sessionId)
  }

  subscribe(sessionId: string, listener: (event: HostAgentSessionEvent) => void): () => void {
    const local = this.localListeners.get(sessionId) ?? new Set<(event: HostAgentSessionEvent) => void>()
    local.add(listener)
    this.localListeners.set(sessionId, local)
    const unsubscribeEvents = this.sessions.onModuleAgentRuntimeEvent((event) => {
      if (event.sessionId !== sessionId) return
      const projected = projectV1PortEventToV2(event)
      if (projected) listener(projected)
    })
    const unsubscribeCompletion = this.sessions.onSessionComplete((event) => {
      if (event.sessionId !== sessionId) return
      switch (event.reason) {
        case 'complete':
          listener({ type: 'turn.completed', sessionId, finalText: event.finalText })
          break
        case 'interrupted':
          listener({ type: 'turn.interrupted', sessionId, reason: 'CLIENT_CANCELLED' })
          break
        case 'timeout':
          listener({ type: 'turn.failed', sessionId, code: 'RUN_TIMEOUT' })
          break
        case 'error':
          listener({ type: 'turn.failed', sessionId, code: 'INTERNAL_ERROR' })
          break
      }
    })
    return () => {
      local.delete(listener)
      if (local.size === 0) this.localListeners.delete(sessionId)
      unsubscribeEvents()
      unsubscribeCompletion()
    }
  }

  private emitLocal(event: HostAgentSessionEvent): void {
    for (const listener of this.localListeners.get(event.sessionId) ?? []) listener(event)
  }
}

function parseV2Ownership(input: CreateHostAgentSessionInput['ownership']): ModuleAgentRunMetadata {
  const ownership: ModuleAgentRunMetadata = { ...input, contractVersion: 2 }
  // SessionManager performs the authoritative closed validation again before
  // disk I/O. Keeping this projection explicit prevents accidental extra data.
  return ownership
}

function projectV1PortEventToV2(event: ModuleAgentPortEvent): HostAgentSessionEvent | undefined {
  switch (event.type) {
    case 'message.delta':
      return { type: 'message.delta', sessionId: event.sessionId, delta: event.delta }
    case 'activity':
      return {
        type: 'activity',
        sessionId: event.sessionId,
        phase: event.phase,
        kind: event.kind,
        ...(event.label ? { label: event.label } : {}),
      }
    // Completion is emitted from the SessionManager completion seam below so
    // it remains exactly-once and includes the final text.
    case 'message.completed':
    case 'turn.completed':
    case 'turn.failed':
    case 'turn.cancelled':
      return undefined
  }
}
