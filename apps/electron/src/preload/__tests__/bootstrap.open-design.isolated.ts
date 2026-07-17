// Runs separately because Bun's Electron module mocks are process-global.
import { describe, expect, it, mock } from 'bun:test'
import { OPEN_DESIGN_MODULE_CHANNELS } from '../../shared/open-design-module-ipc'
import { OPEN_DESIGN_ACCEPTANCE_CHANNELS } from '../../shared/open-design-acceptance-ipc'

type Listener = (...args: any[]) => void

const ipcListeners = new Map<string, Listener>()
const invoke = mock(async (channel: string, ..._args: unknown[]) => ({ status: channel.endsWith('get-state') ? 'available' : 'running' }))
const removeListener = mock((channel: string, listener: Listener) => {
  if (ipcListeners.get(channel) === listener) ipcListeners.delete(channel)
})
const exposeInMainWorld = mock((_name: string, _api: unknown) => {})
const sendSync = mock(() => undefined)

mock.module('electron', () => ({
  contextBridge: { exposeInMainWorld },
  ipcRenderer: {
    invoke,
    on: mock((channel: string, listener: Listener) => ipcListeners.set(channel, listener)),
    removeListener,
    send: mock(() => {}),
    sendSync,
  },
  shell: {
    openExternal: mock(async () => {}),
    openPath: mock(async () => ''),
    showItemInFolder: mock(() => {}),
  },
  webUtils: { getPathForFile: mock(() => '') },
}))

mock.module('@sentry/electron/preload', () => ({}))
mock.module('../../transport/client', () => ({
  WsRpcClient: class {
    connect() {}
    handleCapability() {}
    isChannelAvailable() { return true }
    getConnectionState() { return { mode: 'local', status: 'connected' } }
    onConnectionStateChanged() { return () => {} }
    reconnectNow() {}
    invoke() { return Promise.resolve({}) }
  },
}))
mock.module('../../transport/routed-client', () => ({ RoutedClient: class {} }))
mock.module('../../transport/build-api', () => ({ buildClientApi: () => ({}) }))
mock.module('../../transport/channel-map', () => ({ CHANNEL_MAP: {} }))
mock.module('@craft-agent/shared/auth/callback-server', () => ({ createCallbackServer: mock(() => {}) }))
mock.module('@craft-agent/shared/auth/chatgpt-oauth-config', () => ({
  CHATGPT_OAUTH_CONFIG: { CALLBACK_PORT: 1455 },
}))
mock.module('@craft-agent/server-core/transport', () => ({
  CLIENT_OPEN_EXTERNAL: 'open-external',
  CLIENT_OPEN_PATH: 'open-path',
  CLIENT_SHOW_IN_FOLDER: 'show-in-folder',
  CLIENT_CONFIRM_DIALOG: 'confirm-dialog',
  CLIENT_OPEN_FILE_DIALOG: 'open-file-dialog',
  CLIENT_BROWSER_INVOKE: 'browser-invoke',
  LOCAL_CLIENT_CAPABILITIES: [],
}))

process.env.CRAFT_SERVER_URL = 'ws://127.0.0.1:43117'
const {
  createOpenDesignAcceptanceFacade,
  createOpenDesignModuleFacade,
  discoverOpenDesignAcceptanceFacade,
} = await import('../bootstrap')

describe('OpenDesign preload facade', () => {
  it('invokes only fixed channels without renderer-controlled arguments', async () => {
    const facade = createOpenDesignModuleFacade((await import('electron')).ipcRenderer)

    await facade.getState()
    await facade.install()
    await facade.start()
    await facade.stop()
    await facade.setViewPresentation({
      visible: true,
      bounds: { x: 220, y: 48, width: 980, height: 752 },
    })

    expect(invoke.mock.calls).toEqual([
      [OPEN_DESIGN_MODULE_CHANNELS.GET_STATE],
      [OPEN_DESIGN_MODULE_CHANNELS.INSTALL],
      [OPEN_DESIGN_MODULE_CHANNELS.START],
      [OPEN_DESIGN_MODULE_CHANNELS.STOP],
      [OPEN_DESIGN_MODULE_CHANNELS.SET_VIEW_PRESENTATION, {
        visible: true,
        bounds: { x: 220, y: 48, width: 980, height: 752 },
      }],
    ])
  })

  it('subscribes only to state changes and removes the exact listener once', () => {
    const facade = createOpenDesignModuleFacade((require('electron') as typeof import('electron')).ipcRenderer)
    const states: unknown[] = []
    const unsubscribe = facade.onStateChanged((state) => states.push(state))
    const handler = ipcListeners.get(OPEN_DESIGN_MODULE_CHANNELS.STATE_CHANGED)
    const state = { status: 'running' as const }

    expect([...ipcListeners.keys()]).toEqual([OPEN_DESIGN_MODULE_CHANNELS.STATE_CHANGED])
    handler?.({}, state)
    expect(states).toEqual([state])

    unsubscribe()
    unsubscribe()
    expect(removeListener).toHaveBeenCalledTimes(1)
    expect(removeListener).toHaveBeenCalledWith(OPEN_DESIGN_MODULE_CHANNELS.STATE_CHANGED, handler)
    expect(ipcListeners.size).toBe(0)
  })
})

describe('OpenDesign acceptance preload facade', () => {
  it('invokes only fixed acceptance channels and passes only closed blackout identities', async () => {
    invoke.mockClear()
    const facade = createOpenDesignAcceptanceFacade({ invoke })
    await facade.getState()
    await facade.updateToRc()
    await facade.rollback()
    await facade.getBlackoutProxyCapability()
    await facade.armNextBlackout({ caseId: 'D01', stack: 'new', turnOrdinal: 1 })
    await facade.takeBlackoutEvidence({ evidenceId: 'evidence-D01-1', caseId: 'D01', turnOrdinal: 1 })
    await facade.getModuleAgentRuntimeSnapshot()
    await facade.getRuntimeBinding({
      profileRealpath: '/private/tmp/h1-profile',
      configRealpath: '/private/tmp/h1-config',
      mainPid: 42_001,
      serverPid: 42_001,
      serverLockStartedAt: 1_721_252_815_000,
    })
    expect(invoke.mock.calls).toEqual([
      [OPEN_DESIGN_ACCEPTANCE_CHANNELS.GET_STATE],
      [OPEN_DESIGN_ACCEPTANCE_CHANNELS.UPDATE_TO_RC],
      [OPEN_DESIGN_ACCEPTANCE_CHANNELS.ROLLBACK],
      [OPEN_DESIGN_ACCEPTANCE_CHANNELS.GET_BLACKOUT_PROXY_CAPABILITY],
      [OPEN_DESIGN_ACCEPTANCE_CHANNELS.ARM_NEXT_BLACKOUT, { caseId: 'D01', stack: 'new', turnOrdinal: 1 }],
      [OPEN_DESIGN_ACCEPTANCE_CHANNELS.TAKE_BLACKOUT_EVIDENCE, {
        evidenceId: 'evidence-D01-1', caseId: 'D01', turnOrdinal: 1,
      }],
      [OPEN_DESIGN_ACCEPTANCE_CHANNELS.GET_MODULE_AGENT_RUNTIME_SNAPSHOT],
      [OPEN_DESIGN_ACCEPTANCE_CHANNELS.GET_RUNTIME_BINDING, {
        profileRealpath: '/private/tmp/h1-profile',
        configRealpath: '/private/tmp/h1-config',
        mainPid: 42_001,
        serverPid: 42_001,
        serverLockStartedAt: 1_721_252_815_000,
      }],
    ])
  })

  it('keeps the facade absent unless the gated main process answers exact true', () => {
    const ipc = { invoke, sendSync: mock(() => undefined) }
    expect(discoverOpenDesignAcceptanceFacade(ipc)).toBeUndefined()
    expect(ipc.sendSync).toHaveBeenCalledWith(OPEN_DESIGN_ACCEPTANCE_CHANNELS.IS_AVAILABLE)

    expect(discoverOpenDesignAcceptanceFacade({ invoke, sendSync: () => false })).toBeUndefined()
    expect(discoverOpenDesignAcceptanceFacade({ invoke, sendSync: () => { throw new Error('absent') } })).toBeUndefined()
    expect(discoverOpenDesignAcceptanceFacade({ invoke, sendSync: () => true })).toBeDefined()
  })
})
