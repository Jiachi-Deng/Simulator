import { afterEach, describe, expect, it } from 'bun:test'
import { SessionManager, createManagedSession } from './SessionManager.ts'
import { createSession as createStoredSession, getSessionFilePath, readSessionHeader } from '@craft-agent/shared/sessions'
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
})
