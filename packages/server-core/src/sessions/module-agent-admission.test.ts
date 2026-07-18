import { afterEach, describe, expect, it } from 'bun:test'
import {
  createSession as createStoredSession,
  loadSession as loadStoredSession,
  type ModuleAgentRunMetadata,
} from '@craft-agent/shared/sessions'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager, createManagedSession } from './SessionManager.ts'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function createTransientManager(contractVersion: 1 | 2 = 2): Promise<{
  manager: SessionManager
  managed: ReturnType<typeof createManagedSession>
  ownership: ModuleAgentRunMetadata
  rootPath: string
}> {
  const rootPath = await mkdtemp(join(tmpdir(), 'module-agent-admission-'))
  temporaryRoots.push(rootPath)
  const ownership: ModuleAgentRunMetadata = {
    transient: true,
    contractVersion,
    moduleId: 'org.simulator.open-design',
    runHandle: `run_${'1'.repeat(32)}`,
    idempotencyKeyDigest: '2'.repeat(64),
    requestDigest: '3'.repeat(64),
    workerEpoch: 'epoch_admission_fence',
    state: 'accepted',
  }
  const stored = await createStoredSession(rootPath, {
    name: 'OpenDesign',
    hidden: true,
    workingDirectory: rootPath,
    enabledSourceSlugs: [],
    model: 'pinned-model',
    llmConnection: 'pinned-connection',
    moduleAgentRun: ownership,
  })
  const managed = createManagedSession(stored, {
    id: 'workspace-admission',
    name: 'Admission Workspace',
    rootPath,
    createdAt: Date.now(),
  } as never, { messagesLoaded: true })
  const manager = new SessionManager()
  ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(managed.id, managed)
  return { manager, managed, ownership, rootPath }
}

describe('transient Module public seam fences', () => {
  for (const contractVersion of [1, 2] as const) {
    it(`rejects direct generic sendMessage for v${contractVersion}`, async () => {
      const { manager, managed } = await createTransientManager(contractVersion)
      await expect(manager.sendMessage(managed.id, 'bypass')).rejects.toThrow(
        'Transient Module messages require Host provider admission authority',
      )
      manager.cleanup()
    })

    it(`does not expose a v${contractVersion} transient Session through getSessions`, async () => {
      const { manager, managed } = await createTransientManager(contractVersion)
      expect(manager.getSessions().map((session) => session.id)).not.toContain(managed.id)
      expect(manager.getSessions('workspace-admission').map((session) => session.id)).not.toContain(managed.id)
      await expect(manager.getSession(managed.id)).resolves.toBeNull()
      expect(() => manager.assertRendererSessionAccess(managed.id)).toThrow('Session is unavailable')
      expect(() => manager.assertRendererSessionAccess('unknown-session')).toThrow('Session is unavailable')
      managed.isProcessing = true
      expect(manager.getActiveSessionsInfo().map((session) => session.sessionId)).not.toContain(managed.id)
      expect(manager.getActiveSessionCount()).toBe(0)
      expect(manager.getActiveSessionCount('workspace-admission')).toBe(0)
      manager.cleanup()
    })

    it(`hides v${contractVersion} storage and rejects branch/parent references`, async () => {
      const { manager, managed, rootPath } = await createTransientManager(contractVersion)
      const sessionFile = join(rootPath, 'sessions', managed.id, 'session.jsonl')
      const ordinary = await createStoredSession(rootPath, { name: 'Ordinary visible Session' })
      const ordinaryFile = join(rootPath, 'sessions', ordinary.id, 'session.jsonl')
      await expect(manager.assertRendererPathAccess(sessionFile)).rejects.toThrow('Path is unavailable')
      await expect(manager.assertRendererPathAccess(ordinaryFile)).resolves.toBeUndefined()
      await expect(manager.assertRendererPathAccess(rootPath)).resolves.toBeUndefined()

      await expect(manager.createSession('missing-workspace', {
        branchFromSessionId: managed.id,
        branchFromMessageId: 'message-1',
      })).rejects.toThrow('Session is unavailable')
      await expect(manager.createSession('missing-workspace', {
        parentSessionId: managed.id,
      })).rejects.toThrow('Session is unavailable')
      manager.cleanup()
    })

    it(`rejects v${contractVersion} public provider mutations without changing memory or disk`, async () => {
      const { manager, managed, rootPath } = await createTransientManager(contractVersion)
      const before = loadStoredSession(rootPath, managed.id)
      expect(before).toMatchObject({
        model: 'pinned-model',
        llmConnection: 'pinned-connection',
      })

      await expect(manager.setSessionConnection(managed.id, 'attacker-connection')).rejects.toThrow(
        'provider configuration is Host-owned',
      )
      await expect(manager.updateSessionModel(
        managed.id,
        'workspace-admission',
        'attacker-model',
        'attacker-connection',
      )).rejects.toThrow('provider configuration is Host-owned')

      expect(managed.model).toBe('pinned-model')
      expect(managed.llmConnection).toBe('pinned-connection')
      expect(loadStoredSession(rootPath, managed.id)).toMatchObject({
        model: 'pinned-model',
        llmConnection: 'pinned-connection',
      })
      manager.cleanup()
    })

    it(`rejects v${contractVersion} task adoption and binding`, async () => {
      const { manager, managed } = await createTransientManager(contractVersion)
      managed.taskDraft = true
      await expect(manager.adoptGeneratedTaskOrchestrator(managed.id, 'attacker-task')).resolves.toBe(false)
      await expect(manager.bindExistingSessionToTask(managed.id, 'attacker-task')).resolves.toBe(false)
      expect(managed.taskSlug).toBeUndefined()
      manager.cleanup()
    })

    it(`keeps the v${contractVersion} provider reference for strict reap instead of generic auth retry`, async () => {
      const { manager, managed } = await createTransientManager(contractVersion)
      const agent = { forceAbort() {} }
      managed.agent = agent as never
      managed.lastSentMessage = 'do not replay'
      const retry = (manager as unknown as {
        attemptAuthRetry: (sessionId: string, session: typeof managed, workspaceId: string) => boolean
      }).attemptAuthRetry(managed.id, managed, managed.workspace.id)

      expect(retry).toBe(false)
      expect(managed.agent).toBe(agent as never)
      expect(managed.authRetryAttempted).toBeFalsy()
      expect(managed.authRetryInProgress).toBeFalsy()
      manager.cleanup()
    })
  }

  it('projects allow-listed Module events internally without broadcasting raw Session events', async () => {
    const { manager, managed } = await createTransientManager()
    const rendererEvents: unknown[] = []
    const moduleEvents: unknown[] = []
    manager.setEventSink(((...args: unknown[]) => { rendererEvents.push(args) }) as never)
    const unsubscribe = manager.onModuleAgentRuntimeEvent((event) => { moduleEvents.push(event) })
    const sendEvent = (manager as unknown as {
      sendEvent: (event: unknown, workspaceId: string) => void
    }).sendEvent.bind(manager)

    sendEvent({
      type: 'user_message',
      sessionId: managed.id,
      message: { id: 'message-secret', role: 'user', content: 'private Module prompt', timestamp: 1 },
      status: 'accepted',
    }, managed.workspace.id)
    sendEvent({ type: 'text_delta', sessionId: managed.id, delta: 'safe projection' }, managed.workspace.id)

    expect(rendererEvents).toEqual([])
    expect(moduleEvents).toEqual([{
      type: 'message.delta',
      sessionId: managed.id,
      delta: 'safe projection',
    }])
    expect(JSON.stringify(moduleEvents)).not.toContain('private Module prompt')
    unsubscribe()
    manager.cleanup()
  })

  it('does not re-canonicalize every historical protected path on ordinary renderer access', async () => {
    const { manager, rootPath } = await createTransientManager()
    const internals = manager as unknown as {
      moduleAgentProtectedPaths: Set<string>
      canonicalBoundaryPath: (path: string) => Promise<string>
    }
    for (let index = 0; index < 5_000; index++) {
      internals.moduleAgentProtectedPaths.add(join(rootPath, 'sessions', `historical-${index}`))
    }
    const original = internals.canonicalBoundaryPath.bind(manager)
    let canonicalCalls = 0
    internals.canonicalBoundaryPath = async (path: string) => {
      canonicalCalls++
      return original(path)
    }

    await expect(manager.assertRendererPathAccess(join(rootPath, 'projects', 'ordinary')))
      .resolves.toBeUndefined()
    expect(canonicalCalls).toBeLessThan(100)
    manager.cleanup()
  })

  it('excludes a malformed ownership quarantine from every renderer aggregate', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'module-agent-malformed-aggregate-'))
    temporaryRoots.push(rootPath)
    const stored = await createStoredSession(rootPath, { name: 'Malformed', hidden: false })
    const managed = createManagedSession(stored, {
      id: 'workspace-malformed',
      name: 'Malformed Workspace',
      rootPath,
      createdAt: Date.now(),
    } as never, { messagesLoaded: true })
    managed.isProcessing = true
    managed.hasUnread = true
    const manager = new SessionManager()
    ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(managed.id, managed)
    ;(manager as unknown as { malformedModuleAgentSessionIds: Set<string> })
      .malformedModuleAgentSessionIds.add(managed.id)

    expect(manager.getActiveSessionCount()).toBe(0)
    expect(manager.getActiveSessionsInfo()).toEqual([])
    expect(manager.getUnreadSummary().totalUnreadSessions).toBe(0)
    expect(() => manager.assertRendererSessionAccess(managed.id)).toThrow('Session is unavailable')
    manager.cleanup()
  })
})

describe('v2 Module provider admission fence', () => {
  for (const fenceKind of ['cancel', 'deadline'] as const) {
    it(`prevents provider creation when ${fenceKind} wins a delayed preflight`, async () => {
      const { manager, managed } = await createTransientManager()
      await manager.updateModuleAgentRunState(managed.id, 'starting')
      let releasePreflight!: () => void
      const preflightBlocked = new Promise<void>((resolve) => { releasePreflight = resolve })
      let enteredPreflight!: () => void
      const preflightEntered = new Promise<void>((resolve) => { enteredPreflight = resolve })
      let providerStarts = 0

      const internals = manager as unknown as {
        ensureMessagesLoaded: () => Promise<void>
        getOrCreateAgent: () => Promise<never>
      }
      internals.ensureMessagesLoaded = async () => {
        enteredPreflight()
        await preflightBlocked
      }
      internals.getOrCreateAgent = async () => {
        providerStarts++
        throw new Error('provider must not start')
      }

      const admission = manager.sendModuleAgentMessage(managed.id, 'build a dashboard')
      // Install the rejection observer before fencing so the test itself never
      // creates an unhandled-rejection scheduling race.
      const admissionResult = admission.then(
        () => 'resolved' as const,
        (error: unknown) => error,
      )
      await preflightEntered
      if (fenceKind === 'cancel') {
        await manager.cancelProcessing(managed.id, true)
      } else {
        await manager.updateModuleAgentRunState(managed.id, 'failed')
      }
      releasePreflight()

      const result = await admissionResult
      expect(result).toBeInstanceOf(Error)
      expect((result as Error).message).not.toContain('provider must not start')
      expect(providerStarts).toBe(0)
      expect(managed.isProcessing).toBe(false)
      manager.cleanup()
    })
  }

  it('refuses provider admission before the Run owns starting state', async () => {
    const { manager, managed } = await createTransientManager()
    await expect(manager.sendModuleAgentMessage(managed.id, 'too early')).rejects.toThrow(
      'requires starting state',
    )
    manager.cleanup()
  })

  it('rejects authority drift before creating any provider runtime', async () => {
    const { manager, managed } = await createTransientManager()
    await manager.updateModuleAgentRunState(managed.id, 'starting')
    let providerStarts = 0
    ;(manager as unknown as { getOrCreateAgent: () => Promise<never> }).getOrCreateAgent = async () => {
      providerStarts++
      throw new Error('provider must not start')
    }
    const result = await manager.sendModuleAgentMessage(
      managed.id,
      'drifted v2 authority',
      async () => { throw new Error('authority drifted') },
    ).then(() => 'resolved', (error: unknown) => error)
    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).not.toContain('authority drifted')
    expect(providerStarts).toBe(0)
    expect(managed.isProcessing).toBe(false)
    manager.cleanup()
  })

  it('rechecks authority after runtime creation and before agent.chat', async () => {
    const { manager, managed } = await createTransientManager()
    await manager.updateModuleAgentRunState(managed.id, 'starting')
    let authorityChecks = 0
    let chatCalls = 0
    ;(manager as unknown as { getOrCreateAgent: () => Promise<unknown> }).getOrCreateAgent = async () => ({
      chat: () => { chatCalls++; throw new Error('chat must not start') },
    })
    const result = await manager.sendModuleAgentMessage(
      managed.id,
      'drift after runtime creation',
      async () => {
        authorityChecks++
        if (authorityChecks === 2) throw new Error('authority drifted')
      },
    ).then(() => 'resolved', (error: unknown) => error)
    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).not.toContain('authority drifted')
    expect(authorityChecks).toBe(2)
    expect(chatCalls).toBe(0)
    expect(managed.isProcessing).toBe(false)
    manager.cleanup()
  })

  it('performs a final authority assertion immediately before iterator.next', async () => {
    const { manager, managed } = await createTransientManager()
    await manager.updateModuleAgentRunState(managed.id, 'starting')
    let authorityChecks = 0
    let chatCalls = 0
    let nextCalls = 0
    ;(manager as unknown as { getOrCreateAgent: () => Promise<unknown> }).getOrCreateAgent = async () => ({
      setAllSources: () => undefined,
      getModel: () => 'fixture-model',
      chat: () => {
        chatCalls++
        return {
          [Symbol.asyncIterator]() { return this },
          next: async () => { nextCalls++; return { done: true, value: undefined } },
        }
      },
    })
    const result = await manager.sendModuleAgentMessage(
      managed.id,
      'drift before iterator',
      async () => {
        authorityChecks++
        if (authorityChecks === 4) throw new Error('authority drifted')
      },
    ).then(() => 'resolved', (error: unknown) => error)
    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).not.toContain('authority drifted')
    expect(authorityChecks).toBe(4)
    expect(chatCalls).toBe(1)
    expect(nextCalls).toBe(0)
    expect(managed.isProcessing).toBe(false)
    manager.cleanup()
  })
})

describe('v1 Module provider authority fence', () => {
  it('rejects drift before creating the legacy provider runtime', async () => {
    const { manager, managed } = await createTransientManager(1)
    let providerStarts = 0
    ;(manager as unknown as { getOrCreateAgent: () => Promise<never> }).getOrCreateAgent = async () => {
      providerStarts++
      throw new Error('provider must not start')
    }
    await expect(manager.sendLegacyModuleAgentMessage(
      managed.id,
      'drifted v1 authority',
      async () => { throw new Error('authority drifted') },
    )).rejects.toThrow()
    expect(providerStarts).toBe(0)
    expect(managed.isProcessing).toBe(false)
    manager.cleanup()
  })
})
