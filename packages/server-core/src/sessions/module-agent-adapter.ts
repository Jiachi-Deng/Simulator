import type {
  CreateHostModuleSessionInput,
  CreatedHostModuleSession,
  ModuleAgentPathAuthority,
  ModuleAgentPortEvent,
  ModuleAgentSessionPort,
} from '@simulator/module-agent-gateway'
import type { ISessionManager } from '../handlers/session-manager-interface'
import {
  markModuleAgentSession,
  registerModuleAgentToolBoundary,
  unregisterModuleAgentToolBoundary,
} from '@craft-agent/shared/agent'

/**
 * The only trusted adapter between Module Agent Gateway and Craft's full
 * SessionManager. It deliberately does not expose ISessionManager to modules.
 */
export class CraftModuleAgentSessionPort implements ModuleAgentSessionPort {
  private readonly localListeners = new Map<string, Set<(event: ModuleAgentPortEvent) => void>>()

  constructor(
    private readonly sessions: ISessionManager,
    private readonly paths: ModuleAgentPathAuthority,
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
    if (!this.paths.isEqualOrWithin(workingDirectory, authorizedWorkingRoot)) {
      throw new Error('Module working directory is outside the launch grant')
    }

    const session = await this.sessions.createSession(input.workspaceId, {
      name: 'OpenDesign',
      hidden: true,
      workingDirectory,
      enabledSourceSlugs: [],
      // OpenDesign tasks may create project artifacts. A Host-owned session
      // boundary is registered below before any prompt can reach this session.
      permissionMode: 'allow-all',
    }, { emitCreatedEvent: false })
    const returnedWorkingDirectory = session.workingDirectory
      ? await this.paths.canonicalize(session.workingDirectory)
      : ''
    if (!session.hidden || session.workspaceId !== input.workspaceId || returnedWorkingDirectory !== workingDirectory) {
      await this.sessions.deleteSession(session.id).catch(() => undefined)
      throw new Error('Craft created an invalid hidden module session')
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
    // No llmConnection is supplied here. SessionManager resolves the existing
    // workspace/global Host default and locks it when the first backend starts.
    // Start asynchronously: awaiting the whole SessionManager turn here would
    // block the HTTP response and make streaming/cancellation unusable.
    void this.sessions.sendMessage(sessionId, prompt).catch(() => {
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
