import { afterEach, describe, expect, it } from 'bun:test'
import type { Workspace } from '@craft-agent/core/types'
import type { AgentBackend } from '@craft-agent/shared/agent/backend'
import type { ModuleAgentRunMetadata } from '@craft-agent/shared/sessions'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager, createManagedSession } from './SessionManager'

type PriorityTestSeam = {
  beginVisibleCraftTurn(managed: ReturnType<typeof createManagedSession>): Promise<void>
  setProcessing(managed: ReturnType<typeof createManagedSession>, processing: boolean): void
  visibleCraftTurnGate: { end(sessionId: string): Promise<void> }
}

const workspace = {
  id: 'workspace-1',
  name: 'Workspace',
  rootPath: '/tmp/visible-craft-turn-priority',
  createdAt: 1,
} as Workspace

const moduleOwnership: ModuleAgentRunMetadata = {
  transient: true,
  contractVersion: 2,
  moduleId: 'open-design',
  runHandle: 'a'.repeat(32),
  idempotencyKeyDigest: 'b'.repeat(64),
  requestDigest: 'c'.repeat(64),
  workerEpoch: 'd'.repeat(32),
  state: 'running',
}

const temporaryRoots: string[] = []
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('SessionManager visible Craft priority seam', () => {
  it('awaits visible Craft activation but excludes hidden and transient Module sessions', async () => {
    const manager = new SessionManager()
    const seam = manager as unknown as PriorityTestSeam
    const visible = createManagedSession({ id: 'visible' }, workspace, { messagesLoaded: true })
    const hidden = createManagedSession({ id: 'hidden', hidden: true }, workspace, { messagesLoaded: true })
    const module = createManagedSession({
      id: 'module',
      hidden: true,
      moduleAgentRun: moduleOwnership,
    }, workspace, { messagesLoaded: true })

    let release!: () => void
    const barrier = new Promise<void>((resolve) => { release = resolve })
    const events: boolean[] = []
    manager.onVisibleCraftTurnStateChange(async (change) => {
      events.push(change.active)
      if (change.active) await barrier
    })

    await seam.beginVisibleCraftTurn(hidden)
    await seam.beginVisibleCraftTurn(module)
    expect(events).toEqual([])

    let admitted = false
    const admission = seam.beginVisibleCraftTurn(visible).then(() => { admitted = true })
    await Promise.resolve()
    expect(events).toEqual([true])
    expect(admitted).toBe(false)

    release()
    await admission
    seam.setProcessing(visible, true)
    seam.setProcessing(visible, false)
    await seam.visibleCraftTurnGate.end('visible')
    expect(events).toEqual([true, false])
  })

  it('does not start first-message title provider work before Module preemption finishes', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'visible-craft-title-priority-'))
    temporaryRoots.push(rootPath)
    const manager = new SessionManager()
    const visible = createManagedSession({ id: 'visible-send' }, {
      ...workspace,
      id: 'workspace-title-priority',
      rootPath,
    }, { messagesLoaded: true })
    let titleProviderCalls = 0
    visible.agent = {
      generateTitle: async () => {
        titleProviderCalls++
        return null
      },
      setAllSources: () => {},
      getModel: () => 'fixture-model',
      getSessionId: () => null,
      chat: async function* () {
        yield { type: 'complete' }
      },
      isProcessing: () => false,
      forceAbort: () => {},
      dispose: () => {},
      disposeForRestart: async () => {},
    } as unknown as AgentBackend
    ;(manager as unknown as { sessions: Map<string, typeof visible> }).sessions.set(visible.id, visible)

    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    let entered!: () => void
    const gateEntered = new Promise<void>((resolve) => { entered = resolve })
    manager.onVisibleCraftTurnStateChange(async (change) => {
      if (!change.active) return
      entered()
      await blocked
    })

    try {
      const sending = manager.sendMessage(visible.id, 'first visible message')
      await gateEntered
      // generateTitle used to wait only one second before creating provider
      // work, so keep the real gate closed beyond that former deadline.
      await new Promise((resolve) => setTimeout(resolve, 1_100))
      expect(titleProviderCalls).toBe(0)

      release()
      await sending
      expect(titleProviderCalls).toBe(1)
    } finally {
      release()
      manager.cleanup()
    }
  })
})
