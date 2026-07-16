import { describe, expect, it, mock } from 'bun:test'
import type { OpenDesignModuleState } from '../../../shared/open-design-module-ipc'
import type { OpenDesignMenuCommand } from './DesktopAppMenu'
import type { OpenDesignAcceptanceState } from '../../../shared/open-design-acceptance-ipc'

mock.module('@/actions', () => ({
  useActionLabel: () => ({ hotkey: undefined }),
}))
mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }))
mock.module('pdfjs-dist', () => ({ GlobalWorkerOptions: { workerSrc: '' }, getDocument: () => ({}) }))

const {
  getOpenDesignAcceptanceMenuAvailability,
  getOpenDesignMenuPresentation,
  loadOpenDesignAcceptanceStateWithRetry,
  loadOpenDesignStateWithRetry,
} = await import('./DesktopAppMenu')

describe('OpenDesign Debug menu presentation', () => {
  it('keeps retrying beyond the former startup window and returns the first real state', async () => {
    let attempts = 0
    const waits: number[] = []
    const state = await loadOpenDesignStateWithRetry({
      async getState() {
        attempts += 1
        if (attempts < 75) throw new Error('IPC handler is not registered yet')
        return { status: 'not-installed' }
      },
    }, async (milliseconds) => { waits.push(milliseconds) })

    expect(state).toEqual({ status: 'not-installed' })
    expect(attempts).toBe(75)
    expect(waits).toHaveLength(74)
    expect(waits.every((milliseconds) => milliseconds === 250)).toBe(true)
  })

  it('stops retrying when the menu is unmounted', async () => {
    let active = true
    let attempts = 0
    const state = await loadOpenDesignStateWithRetry({
      async getState() {
        attempts += 1
        throw new Error('IPC handler is not registered yet')
      },
    }, async () => { active = false }, () => active)

    expect(state).toMatchObject({ status: 'error', errorCode: 'CONTROLLER_UNAVAILABLE' })
    expect(attempts).toBe(1)
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

describe('OpenDesign acceptance Debug menu', () => {
  const state = (
    activeVersion: string | null,
    lastKnownGoodVersion: string | null,
    status: OpenDesignAcceptanceState['status'] = 'ready',
    installedVersions: readonly string[] = activeVersion === '0.14.6-rc.1' || lastKnownGoodVersion === '0.14.6-rc.1'
      ? ['0.14.5', '0.14.6-rc.1']
      : ['0.14.5'],
    running = true,
    viewAttached = true,
  ): OpenDesignAcceptanceState => ({
    status,
    hostVersion: '0.12.0',
    activeVersion,
    lastKnownGoodVersion,
    installedVersions,
    running,
    viewAttached,
  })

  it('offers only the fixed baseline update and exact active/LKG swap', () => {
    expect(getOpenDesignAcceptanceMenuAvailability(state('0.14.5', null))).toEqual({
      updateEnabled: true,
      rollbackEnabled: false,
    })
    for (const pair of [
      state('0.14.6-rc.1', '0.14.5'),
      state('0.14.5', '0.14.6-rc.1'),
    ]) {
      expect(getOpenDesignAcceptanceMenuAvailability(pair)).toEqual({
        updateEnabled: false,
        rollbackEnabled: true,
      })
    }
    expect(getOpenDesignAcceptanceMenuAvailability(state('0.14.6-rc.1', null))).toEqual({
      updateEnabled: false,
      rollbackEnabled: false,
    })
    expect(getOpenDesignAcceptanceMenuAvailability(state('0.14.5', null, 'ready', [
      '0.14.5', '0.14.4',
    ]))).toEqual({
      updateEnabled: false,
      rollbackEnabled: false,
    })
    expect(getOpenDesignAcceptanceMenuAvailability({
      ...state('0.14.6-rc.1', '0.14.5'),
      running: false,
    })).toEqual({ updateEnabled: false, rollbackEnabled: false })
    expect(getOpenDesignAcceptanceMenuAvailability({
      ...state('0.14.6-rc.1', '0.14.5'),
      viewAttached: false,
    })).toEqual({ updateEnabled: false, rollbackEnabled: false })
  })

  it('waits for the lazily-created Host runtime without accepting other errors as startup lag', async () => {
    let attempts = 0
    const waits: number[] = []
    const available = await loadOpenDesignAcceptanceStateWithRetry({
      async getState() {
        attempts += 1
        if (attempts < 3) {
          return {
            ...state(null, null, 'error', []),
            errorCode: 'ACCEPTANCE_RUNTIME_UNAVAILABLE',
          }
        }
        return state('0.14.5', null)
      },
    }, async (milliseconds) => { waits.push(milliseconds) })
    expect(available).toMatchObject({ activeVersion: '0.14.5', lastKnownGoodVersion: null })
    expect(waits).toEqual([250, 250])

    const hardFailure = { ...state(null, null, 'error', []), errorCode: 'ACCEPTANCE_STATE_UNAVAILABLE' }
    expect(await loadOpenDesignAcceptanceStateWithRetry({ getState: async () => hardFailure })).toEqual(hardFailure)

    let busyAttempts = 0
    const busyWaits: number[] = []
    const afterBusy = await loadOpenDesignAcceptanceStateWithRetry({
      async getState() {
        busyAttempts += 1
        return busyAttempts === 1
          ? { ...state('0.14.6-rc.1', '0.14.5', 'busy'), action: 'rollback' }
          : state('0.14.5', '0.14.6-rc.1')
      },
    }, async (milliseconds) => { busyWaits.push(milliseconds) })
    expect(afterBusy).toMatchObject({ status: 'ready', activeVersion: '0.14.5' })
    expect(busyWaits).toEqual([250])

    let busyThenErrorAttempts = 0
    const terminalError = { ...state(null, null, 'error', []), errorCode: 'ACCEPTANCE_ROLLBACK_FAILED' }
    expect(await loadOpenDesignAcceptanceStateWithRetry({
      async getState() {
        busyThenErrorAttempts += 1
        return busyThenErrorAttempts === 1
          ? { ...state('0.14.6-rc.1', '0.14.5', 'busy'), action: 'rollback' }
          : terminalError
      },
    }, async () => undefined)).toEqual(terminalError)

    let hardFailureWaits = 0
    expect(await loadOpenDesignAcceptanceStateWithRetry({
      getState: async () => { throw new Error('sender rejected') },
    }, async () => { hardFailureWaits += 1 })).toBeUndefined()
    expect(hardFailureWaits).toBe(0)

    let mounted = true
    let unmountAttempts = 0
    expect(await loadOpenDesignAcceptanceStateWithRetry({
      async getState() {
        unmountAttempts += 1
        return { ...state('0.14.6-rc.1', '0.14.5', 'busy'), action: 'rollback' }
      },
    }, async () => { mounted = false }, () => mounted)).toBeUndefined()
    expect(unmountAttempts).toBe(1)
  })

  it('disables both commands while loading, busy, or a renderer command is in flight', () => {
    expect(getOpenDesignAcceptanceMenuAvailability(undefined)).toEqual({
      updateEnabled: false,
      rollbackEnabled: false,
    })
    expect(getOpenDesignAcceptanceMenuAvailability(state('0.14.5', null, 'busy'))).toEqual({
      updateEnabled: false,
      rollbackEnabled: false,
    })
    expect(getOpenDesignAcceptanceMenuAvailability({
      ...state('0.14.5', null, 'error'),
      errorCode: 'ACCEPTANCE_UPDATE_FAILED',
    })).toEqual({
      updateEnabled: false,
      rollbackEnabled: false,
    })
    expect(getOpenDesignAcceptanceMenuAvailability(state('0.14.5', null), true)).toEqual({
      updateEnabled: false,
      rollbackEnabled: false,
    })
  })
})
