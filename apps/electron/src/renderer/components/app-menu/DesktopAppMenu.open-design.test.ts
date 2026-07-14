import { describe, expect, it, mock } from 'bun:test'
import type { OpenDesignModuleState } from '../../../shared/open-design-module-ipc'
import type { OpenDesignMenuCommand } from './DesktopAppMenu'

mock.module('@/actions', () => ({
  useActionLabel: () => ({ hotkey: undefined }),
}))
mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }))
mock.module('pdfjs-dist', () => ({ GlobalWorkerOptions: { workerSrc: '' }, getDocument: () => ({}) }))

const { getOpenDesignMenuPresentation, loadOpenDesignStateWithRetry } = await import('./DesktopAppMenu')

describe('OpenDesign Debug menu presentation', () => {
  it('retries startup IPC registration races and returns the first real state', async () => {
    let attempts = 0
    const waits: number[] = []
    const state = await loadOpenDesignStateWithRetry({
      async getState() {
        attempts += 1
        if (attempts < 3) throw new Error('IPC handler is not registered yet')
        return { status: 'not-installed' }
      },
    }, async (milliseconds) => { waits.push(milliseconds) })

    expect(state).toEqual({ status: 'not-installed' })
    expect(attempts).toBe(3)
    expect(waits).toEqual([250, 250])
  })

  it('maps stable states to the single appropriate action', () => {
    const cases: Array<{
      state: OpenDesignModuleState
      statusKey: string
      action?: OpenDesignMenuCommand
      actionKey?: string
    }> = [
      {
        state: { status: 'not-installed' },
        statusKey: 'menu.openDesignStatusNotInstalled',
        action: 'install',
        actionKey: 'menu.openDesignActionInstall',
      },
      {
        state: { status: 'available' },
        statusKey: 'menu.openDesignStatusAvailable',
        action: 'start',
        actionKey: 'menu.openDesignActionOpen',
      },
      {
        state: { status: 'running' },
        statusKey: 'menu.openDesignStatusRunning',
        action: 'stop',
        actionKey: 'menu.openDesignActionStop',
      },
      { state: { status: 'disabled' }, statusKey: 'menu.openDesignStatusDisabled' },
      { state: { status: 'not-ready' }, statusKey: 'menu.openDesignStatusNotReady' },
      {
        state: { status: 'error', errorCode: 'FAILED' },
        statusKey: 'menu.openDesignStatusError',
        action: 'install',
        actionKey: 'menu.openDesignActionRetry',
      },
      {
        state: { status: 'error', errorCode: 'FAILED', version: '0.14.1-development.1' },
        statusKey: 'menu.openDesignStatusError',
        action: 'start',
        actionKey: 'menu.openDesignActionRetry',
      },
      {
        state: { status: 'error', errorCode: 'CONTROLLER_UNAVAILABLE' },
        statusKey: 'menu.openDesignStatusUnavailable',
      },
    ]

    for (const testCase of cases) {
      const presentation = getOpenDesignMenuPresentation(testCase.state)
      expect(presentation.statusKey).toBe(testCase.statusKey)
      expect(presentation.action).toBe(testCase.action)
      expect(presentation.actionKey).toBe(testCase.actionKey)
    }
  })

  it('disables installing states and exposes progress or checkpoint text', () => {
    expect(getOpenDesignMenuPresentation({
      status: 'installing',
      progress: { received: 75, total: 100 },
    })).toEqual({
      statusKey: 'menu.openDesignStatusInstallingProgress',
      statusValues: { percent: 75 },
      actionDisabled: true,
    })

    expect(getOpenDesignMenuPresentation({
      status: 'installing',
      checkpoint: 'artifact-downloaded',
    })).toEqual({
      statusKey: 'menu.openDesignStatusInstallingCheckpoint',
      checkpointKey: 'menu.openDesignCheckpointInstalling',
      actionDisabled: true,
    })
  })

  it('disables every action while a command is in flight', () => {
    for (const status of ['not-installed', 'available', 'running', 'error'] as const) {
      expect(getOpenDesignMenuPresentation({ status }, true).actionDisabled).toBe(true)
    }
  })
})
