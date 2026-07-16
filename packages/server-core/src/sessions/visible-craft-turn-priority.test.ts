import { describe, expect, it } from 'bun:test'
import type { Workspace } from '@craft-agent/core/types'
import type { ModuleAgentRunMetadata } from '@craft-agent/shared/sessions'
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
})
