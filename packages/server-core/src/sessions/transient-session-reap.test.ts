import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Workspace } from '@craft-agent/core/types'
import type { AgentBackend } from '@craft-agent/shared/agent/backend'
import { SessionManager, createManagedSession } from './SessionManager'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('transient Module Session strict reap', () => {
  it('forces awaited provider disposal after cooperative stop times out', async () => {
    const root = await mkdtemp(join(tmpdir(), 'transient-session-reap-'))
    roots.push(root)
    const workspace = {
      id: 'workspace-1',
      name: 'Workspace',
      rootPath: root,
      createdAt: 1,
    } as Workspace
    const manager = new SessionManager()
    const managed = createManagedSession({ id: 'module-session', hidden: true }, workspace, {
      messagesLoaded: true,
    })
    const lifecycle: string[] = []
    managed.isProcessing = true
    managed.agent = {
      isProcessing: () => true,
      forceAbort: () => { lifecycle.push('forceAbort') },
      dispose: () => { lifecycle.push('dispose') },
      disposeForRestart: async () => { lifecycle.push('disposeForRestart') },
    } as unknown as AgentBackend
    ;(manager as unknown as { sessions: Map<string, typeof managed> }).sessions.set(managed.id, managed)

    await manager.disposeSessionAndReap(managed.id, 25)

    expect(lifecycle).toEqual(['forceAbort', 'disposeForRestart'])
    expect(managed.isProcessing).toBe(false)
    expect(managed.agent).toBeNull()
    await expect(manager.getSession(managed.id)).resolves.toBeNull()
  })

  it('does not report success or delete ownership when awaited strict disposal fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'transient-session-reap-'))
    roots.push(root)
    const workspace = {
      id: 'workspace-1',
      name: 'Workspace',
      rootPath: root,
      createdAt: 1,
    } as Workspace
    const manager = new SessionManager()
    const managed = createManagedSession({ id: 'module-session', hidden: true }, workspace, {
      messagesLoaded: true,
    })
    const lifecycle: string[] = []
    managed.agent = {
      isProcessing: () => false,
      forceAbort: () => { lifecycle.push('forceAbort') },
      disposeForRestart: async () => {
        lifecycle.push('disposeForRestart')
        throw new Error('graceful shutdown failed')
      },
      dispose: () => { lifecycle.push('dispose') },
    } as unknown as AgentBackend
    ;(manager as unknown as { sessions: Map<string, typeof managed> }).sessions.set(managed.id, managed)

    await expect(manager.disposeSessionAndReap(managed.id, 25)).rejects.toThrow('graceful shutdown failed')

    expect(lifecycle).toEqual(['disposeForRestart', 'dispose'])
    expect(managed.agent).not.toBeNull()
    await expect(manager.getSession(managed.id)).resolves.not.toBeNull()
  })
})
