import { describe, expect, it, mock } from 'bun:test'
import type { OpenDesignModuleState } from '../../../shared/open-design-module-ipc'
import type { OpenDesignMenuCommand } from './DesktopAppMenu'

mock.module('@/actions', () => ({
  useActionLabel: () => ({ hotkey: undefined }),
}))
mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }))
mock.module('pdfjs-dist', () => ({ GlobalWorkerOptions: { workerSrc: '' }, getDocument: () => ({}) }))

const { getOpenDesignMenuPresentation } = await import('./DesktopAppMenu')

describe('OpenDesign Debug menu presentation', () => {
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
      {
        state: { status: 'not-ready' },
        statusKey: 'menu.openDesignStatusNotReady',
        action: 'retry',
        actionKey: 'menu.openDesignActionRetry',
      },
      {
        state: { status: 'error', errorCode: 'FAILED' },
        statusKey: 'menu.openDesignStatusError',
        action: 'retry',
        actionKey: 'menu.openDesignActionRetry',
      },
      {
        state: { status: 'error', errorCode: 'CONTROLLER_UNAVAILABLE' },
        statusKey: 'menu.openDesignStatusUnavailable',
        action: 'retry',
        actionKey: 'menu.openDesignActionRetry',
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
    for (const status of ['not-installed', 'available', 'running', 'not-ready', 'error'] as const) {
      expect(getOpenDesignMenuPresentation({ status }, true).actionDisabled).toBe(true)
    }
  })
})
