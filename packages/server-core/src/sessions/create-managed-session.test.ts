import { afterEach, describe, expect, it } from 'bun:test'
import { SessionManager, createManagedSession } from './SessionManager.ts'
import {
  createSession as createStoredSession,
  getSessionFilePath,
  readSessionHeader,
  sessionPersistenceQueue,
} from '@craft-agent/shared/sessions'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const temporaryRoots: string[] = []
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('createManagedSession', () => {
  const workspace = {
    id: 'ws_test',
    name: 'Test Workspace',
    rootPath: '/tmp/test-workspace',
    createdAt: Date.now(),
  }

  it('normalizes legacy thinkingLevel=think on restore', () => {
    const managed = createManagedSession({
      id: 'session_legacy',
      thinkingLevel: 'think' as any,
    }, workspace as any)

    expect(managed.thinkingLevel).toBe('medium')
  })

  it('drops invalid thinking levels instead of leaking them into runtime state', () => {
    const managed = createManagedSession({
      id: 'session_invalid',
      thinkingLevel: 'ultra' as any,
    }, workspace as any)

    expect(managed.thinkingLevel).toBeUndefined()
  })

  it('never exposes transient Module ownership through renderer Session DTOs', () => {
    const manager = new SessionManager()
    const managed = createManagedSession({
      id: 'session_module',
      hidden: true,
      moduleAgentRun: {
        transient: true,
        contractVersion: 2,
        moduleId: 'open-design',
        runHandle: `run_${'1'.repeat(32)}`,
        idempotencyKeyDigest: '2'.repeat(64),
        requestDigest: '3'.repeat(64),
        workerEpoch: 'epoch_1234',
        state: 'running',
      },
    }, workspace as any)
    ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(managed.id, managed)

    const [rendererSession] = manager.getSessions(workspace.id)
    expect(rendererSession).toBeDefined()
    expect(rendererSession).not.toHaveProperty('moduleAgentRun')
    expect(JSON.stringify(rendererSession)).not.toContain('idempotencyKeyDigest')
  })

  it('atomically persists valid transient Run state transitions', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'module-run-state-'))
    temporaryRoots.push(rootPath)
    const ownership = {
      transient: true as const,
      contractVersion: 2 as const,
      moduleId: 'org.simulator.open-design',
      runHandle: `run_${'1'.repeat(32)}`,
      idempotencyKeyDigest: '2'.repeat(64),
      requestDigest: '3'.repeat(64),
      workerEpoch: 'epoch_1234',
      state: 'accepted' as const,
    }
    const stored = await createStoredSession(rootPath, {
      hidden: true,
      workingDirectory: rootPath,
      moduleAgentRun: ownership,
    })
    const currentWorkspace = { ...workspace, id: 'ws_module_state', rootPath }
    const managed = createManagedSession(stored, currentWorkspace as any, { messagesLoaded: true })
    const manager = new SessionManager()
    ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(managed.id, managed)

    await manager.updateModuleAgentRunState(managed.id, 'starting')
    await manager.updateModuleAgentRunState(managed.id, 'running')
    const header = readSessionHeader(getSessionFilePath(rootPath, managed.id))
    expect(header?.moduleAgentRun).toEqual({ ...ownership, state: 'running' })
    await expect(manager.updateModuleAgentRunState(managed.id, 'accepted')).rejects.toThrow(
      'Invalid transient Module run transition running -> accepted',
    )
    expect(readSessionHeader(getSessionFilePath(rootPath, managed.id))?.moduleAgentRun).toEqual({
      ...ownership,
      state: 'running',
    })
    manager.cleanup()
  })

  it('does not publish a Run state in memory before its durable header is acknowledged', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'module-run-publish-order-'))
    temporaryRoots.push(rootPath)
    const ownership = {
      transient: true as const,
      contractVersion: 2 as const,
      moduleId: 'org.simulator.open-design',
      runHandle: `run_${'4'.repeat(32)}`,
      idempotencyKeyDigest: '5'.repeat(64),
      requestDigest: '6'.repeat(64),
      workerEpoch: 'epoch_publish_order',
      state: 'accepted' as const,
    }
    const stored = await createStoredSession(rootPath, {
      hidden: true,
      workingDirectory: rootPath,
      moduleAgentRun: ownership,
    })
    const managed = createManagedSession(stored, { ...workspace, id: 'ws_publish_order', rootPath } as any, {
      messagesLoaded: true,
    })
    const manager = new SessionManager()
    ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(managed.id, managed)

    const originalFlush = sessionPersistenceQueue.flush.bind(sessionPersistenceQueue)
    let flushCalls = 0
    let releaseDurableWrite!: () => void
    const durableWriteGate = new Promise<void>((resolve) => { releaseDurableWrite = resolve })
    sessionPersistenceQueue.flush = async (sessionId: string) => {
      flushCalls++
      if (flushCalls === 2) await durableWriteGate
      await originalFlush(sessionId)
    }

    try {
      const transition = manager.updateModuleAgentRunState(managed.id, 'starting')
      while (flushCalls < 2) await new Promise((resolve) => setTimeout(resolve, 0))
      expect((managed.moduleAgentRun as typeof ownership).state).toBe('accepted')
      expect(readSessionHeader(getSessionFilePath(rootPath, managed.id))?.moduleAgentRun).toEqual(ownership)
      releaseDurableWrite()
      await transition
      expect((managed.moduleAgentRun as { state: string }).state).toBe('starting')
    } finally {
      sessionPersistenceQueue.flush = originalFlush
      releaseDurableWrite()
      manager.cleanup()
    }
  })

  it('verifies same-state requests against disk and rolls split memory back', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'module-run-same-state-'))
    temporaryRoots.push(rootPath)
    const ownership = {
      transient: true as const,
      contractVersion: 2 as const,
      moduleId: 'org.simulator.open-design',
      runHandle: `run_${'7'.repeat(32)}`,
      idempotencyKeyDigest: '8'.repeat(64),
      requestDigest: '9'.repeat(64),
      workerEpoch: 'epoch_same_state',
      state: 'accepted' as const,
    }
    const stored = await createStoredSession(rootPath, {
      hidden: true,
      workingDirectory: rootPath,
      moduleAgentRun: ownership,
    })
    const managed = createManagedSession(stored, { ...workspace, id: 'ws_same_state', rootPath } as any, {
      messagesLoaded: true,
      moduleAgentRun: { ...ownership, state: 'starting' },
    })
    const manager = new SessionManager()
    ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(managed.id, managed)

    await expect(manager.updateModuleAgentRunState(managed.id, 'starting')).rejects.toThrow(
      'split ownership state',
    )
    expect((managed.moduleAgentRun as { state: string }).state).toBe('accepted')
    expect(readSessionHeader(getSessionFilePath(rootPath, managed.id))?.moduleAgentRun).toEqual(ownership)
    manager.cleanup()
  })

  it('recovers exactly one matching durable transient Session and rejects ambiguity', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'module-run-recovery-'))
    temporaryRoots.push(rootPath)
    const ownership = {
      transient: true as const,
      contractVersion: 2 as const,
      moduleId: 'org.simulator.open-design',
      runHandle: `run_${'a'.repeat(32)}`,
      idempotencyKeyDigest: 'b'.repeat(64),
      requestDigest: 'c'.repeat(64),
      workerEpoch: 'epoch_recovery',
      state: 'accepted' as const,
    }
    const currentWorkspace = { ...workspace, id: 'ws_recovery', rootPath }
    const firstStored = await createStoredSession(rootPath, {
      hidden: true,
      workingDirectory: rootPath,
      moduleAgentRun: ownership,
    })
    const first = createManagedSession(firstStored, currentWorkspace as any, { messagesLoaded: true })
    const manager = new SessionManager()
    const sessions = (manager as unknown as { sessions: Map<string, unknown> }).sessions
    sessions.set(first.id, first)

    const recovered = await manager.recoverModuleAgentSession({
      workspaceId: currentWorkspace.id,
      workingDirectory: rootPath,
      ownership,
    })
    expect(recovered?.id).toBe(first.id)

    const secondStored = await createStoredSession(rootPath, {
      hidden: true,
      workingDirectory: rootPath,
      moduleAgentRun: ownership,
    })
    const second = createManagedSession(secondStored, currentWorkspace as any, { messagesLoaded: true })
    sessions.set(second.id, second)
    await expect(manager.recoverModuleAgentSession({
      workspaceId: currentWorkspace.id,
      workingDirectory: rootPath,
      ownership,
    })).rejects.toThrow('ambiguous')
    manager.cleanup()
  })
})
