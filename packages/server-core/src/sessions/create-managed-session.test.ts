import { describe, expect, it } from 'bun:test'
import { SessionManager, createManagedSession } from './SessionManager.ts'

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
})
