// Runs separately because Bun's Electron module mocks are process-global.
import { beforeEach, describe, expect, it, mock } from 'bun:test'

type Listener = (...args: any[]) => any

const ipcListeners = new Map<string, Listener>()
const sessions = new Map<string, ReturnType<typeof createMockSession>>()
const createdViews: any[] = []
let nextWebContentsId = 100

function createEmitter() {
  const listeners = new Map<string, Listener[]>()
  return {
    on(event: string, listener: Listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
    },
    once(event: string, listener: Listener) {
      const wrapped = (...args: any[]) => {
        this.removeListener(event, wrapped)
        listener(...args)
      }
      this.on(event, wrapped)
    },
    removeListener(event: string, listener: Listener) {
      listeners.set(event, (listeners.get(event) ?? []).filter((candidate) => candidate !== listener))
    },
    emit(event: string, ...args: any[]) {
      for (const listener of [...(listeners.get(event) ?? [])]) listener(...args)
    },
  }
}

function createMockWebContents() {
  const emitter = createEmitter()
  const mainFrame = {}
  let destroyed = false
  return {
    ...emitter,
    id: nextWebContentsId++,
    mainFrame,
    isDestroyed: mock(() => destroyed),
    close: mock((_options?: unknown) => { destroyed = true }),
    loadURL: mock(async (_url: string) => {}),
    send: mock((_channel: string, _envelope: unknown) => {}),
    setWindowOpenHandler: mock((_handler: Listener) => {}),
    closeDevTools: mock(() => {}),
  }
}

function createMockSession() {
  return {
    setPermissionCheckHandler: mock((_handler: Listener) => {}),
    setPermissionRequestHandler: mock((_handler: Listener) => {}),
    setDevicePermissionHandler: mock((_handler: Listener) => {}),
    setDisplayMediaRequestHandler: mock((_handler: Listener) => {}),
    on: mock((_event: string, _handler: Listener) => {}),
    webRequest: {
      onBeforeRequest: mock((_filter: unknown, _handler: Listener) => {}),
    },
  }
}

function createHostWindow(width = 1200, height = 800) {
  const emitter = createEmitter()
  let destroyed = false
  return {
    ...emitter,
    contentView: {
      addChildView: mock((_view: unknown) => {}),
      removeChildView: mock((_view: unknown) => {}),
    },
    getContentSize: mock(() => [width, height]),
    isDestroyed: mock(() => destroyed),
    _destroy: () => {
      destroyed = true
      emitter.emit('closed')
    },
  }
}

mock.module('electron', () => ({
  app: { isPackaged: true },
  ipcMain: {
    on: mock((channel: string, listener: Listener) => ipcListeners.set(channel, listener)),
    removeListener: mock((channel: string, listener: Listener) => {
      if (ipcListeners.get(channel) === listener) ipcListeners.delete(channel)
    }),
  },
  session: {
    fromPartition: mock((partition: string) => {
      const existing = sessions.get(partition)
      if (existing) return existing
      const created = createMockSession()
      sessions.set(partition, created)
      return created
    }),
  },
  WebContentsView: class MockWebContentsView {
    webContents = createMockWebContents()
    setBounds = mock((_rect: unknown) => {})
    setVisible = mock((_visible: boolean) => {})
    constructor(readonly options: unknown) {
      createdViews.push(this)
    }
  },
}))

mock.module('../logger', () => ({
  mainLog: { warn: mock(() => {}), info: mock(() => {}), error: mock(() => {}), debug: mock(() => {}) },
}))

const {
  ModuleViewManager,
  ModuleViewManagerError,
  getModuleViewFullContentRect,
} = await import('../module-view-manager')

const identity = { moduleId: 'org.simulator.fake', viewInstanceId: 'view-1' }
const origin = 'http://127.0.0.1:43117'

function attachOptions(hostWindow = createHostWindow()) {
  return {
    ...identity,
    hostWindow: hostWindow as any,
    frontendUrl: `${origin}/index.html`,
    allowedFrontendOrigins: [origin],
  }
}

function emitIpc(view: any, envelope: unknown, senderFrame = view.webContents.mainFrame) {
  const listener = ipcListeners.get('module-view:to-host')
  if (!listener) throw new Error('Expected module view IPC listener')
  listener({ sender: view.webContents, senderFrame }, envelope)
}

describe('ModuleViewManager', () => {
  beforeEach(() => {
    ipcListeners.clear()
    sessions.clear()
    createdViews.length = 0
    nextWebContentsId = 100
  })

  it('attaches a WebContentsView with a dedicated hardened session and full-content rect', async () => {
    const hostWindow = createHostWindow(1440, 900)
    const manager = new ModuleViewManager({ preloadPath: '/tmp/module-view-preload.cjs', isPackaged: true })
    const snapshot = await manager.attach(attachOptions(hostWindow))
    const view = createdViews[0]
    const preferences = view.options.webPreferences

    expect(snapshot.rect).toEqual({ x: 0, y: 0, width: 1440, height: 900 })
    expect(getModuleViewFullContentRect(hostWindow as any)).toEqual(snapshot.rect)
    expect(hostWindow.contentView.addChildView).toHaveBeenCalledWith(view)
    expect(view.setBounds).toHaveBeenCalledWith(snapshot.rect)
    expect(preferences).toMatchObject({
      preload: '/tmp/module-view-preload.cjs',
      partition: snapshot.partition,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      devTools: false,
    })
    expect(preferences.partition.startsWith('persist:')).toBe(false)
    expect(preferences.additionalArguments).toEqual([
      '--simulator-module-id=org.simulator.fake',
      '--simulator-view-instance-id=view-1',
    ])

    const dedicatedSession = sessions.get(snapshot.partition)!
    expect(dedicatedSession.setPermissionCheckHandler).toHaveBeenCalledTimes(1)
    expect(dedicatedSession.setPermissionRequestHandler).toHaveBeenCalledTimes(1)
    expect(dedicatedSession.setDevicePermissionHandler).toHaveBeenCalledTimes(1)
    expect(dedicatedSession.setDisplayMediaRequestHandler).toHaveBeenCalledTimes(1)
    expect(dedicatedSession.on).toHaveBeenCalledWith('will-download', expect.any(Function))
    expect(dedicatedSession.webRequest.onBeforeRequest).toHaveBeenCalledTimes(1)

    manager.dispose()
  })

  it('supports resize, hide, show, detach, reattach, and host-close cleanup', async () => {
    const hostWindow = createHostWindow()
    const manager = new ModuleViewManager()
    await manager.attach(attachOptions(hostWindow))
    const view = createdViews[0]

    expect(manager.resize(identity, { x: 8, y: 12, width: 640, height: 480 }).rect)
      .toEqual({ x: 8, y: 12, width: 640, height: 480 })
    expect(manager.hide(identity).visible).toBe(false)
    expect(manager.show(identity).visible).toBe(true)
    expect(manager.detach(identity).attached).toBe(false)
    expect(hostWindow.contentView.removeChildView).toHaveBeenCalledWith(view)
    expect(manager.reattach(identity).attached).toBe(true)

    hostWindow._destroy()
    expect(manager.get(identity)).toBeUndefined()
    expect(view.webContents.close).toHaveBeenCalledWith({ waitForBeforeUnload: false })
    manager.dispose()
  })

  it('rejects non-local or non-allowlisted frontends and duplicate identities', async () => {
    const manager = new ModuleViewManager()
    await expect(manager.attach({
      ...attachOptions(),
      frontendUrl: 'https://example.com/module',
    })).rejects.toBeInstanceOf(ModuleViewManagerError)
    await expect(manager.attach({
      ...attachOptions(),
      allowedFrontendOrigins: ['http://0.0.0.0:43117'],
    })).rejects.toBeInstanceOf(ModuleViewManagerError)

    await manager.attach(attachOptions())
    await expect(manager.attach(attachOptions())).rejects.toMatchObject({ code: 'DUPLICATE_VIEW' })
    manager.dispose()
  })

  it('denies popup, external navigation, downloads, permissions, and external requests', async () => {
    const failures: any[] = []
    const manager = new ModuleViewManager({ onFailure: (failure) => failures.push(failure) })
    const snapshot = await manager.attach(attachOptions())
    const view = createdViews[0]
    const dedicatedSession = sessions.get(snapshot.partition)!

    const openHandler = view.webContents.setWindowOpenHandler.mock.calls[0][0]
    expect(openHandler({ url: 'https://example.com' })).toEqual({ action: 'deny' })

    const navEvent = { preventDefault: mock(() => {}) }
    view.webContents.emit('will-navigate', navEvent, 'https://example.com')
    expect(navEvent.preventDefault).toHaveBeenCalledTimes(1)
    const sameOriginEvent = { preventDefault: mock(() => {}) }
    view.webContents.emit('will-navigate', sameOriginEvent, `${origin}/settings`)
    expect(sameOriginEvent.preventDefault).not.toHaveBeenCalled()
    const frameEvent = { url: 'https://example.com/frame', preventDefault: mock(() => {}) }
    view.webContents.emit('will-frame-navigate', frameEvent)
    expect(frameEvent.preventDefault).toHaveBeenCalledTimes(1)

    const permissionCheck = dedicatedSession.setPermissionCheckHandler.mock.calls[0][0]
    expect(permissionCheck()).toBe(false)
    const permissionRequest = dedicatedSession.setPermissionRequestHandler.mock.calls[0][0]
    const permissionCallback = mock((_allowed: boolean) => {})
    permissionRequest(null, 'notifications', permissionCallback)
    expect(permissionCallback).toHaveBeenCalledWith(false)

    const downloadHandler = dedicatedSession.on.mock.calls.find(([event]) => event === 'will-download')![1]
    const downloadEvent = { preventDefault: mock(() => {}) }
    const downloadItem = { cancel: mock(() => {}) }
    downloadHandler(downloadEvent, downloadItem)
    expect(downloadEvent.preventDefault).toHaveBeenCalledTimes(1)
    expect(downloadItem.cancel).toHaveBeenCalledTimes(1)

    const requestHandler = dedicatedSession.webRequest.onBeforeRequest.mock.calls[0][1]
    const externalCallback = mock((_result: unknown) => {})
    requestHandler({ url: 'https://cdn.example.com/app.js' }, externalCallback)
    expect(externalCallback).toHaveBeenCalledWith({ cancel: true })
    const localCallback = mock((_result: unknown) => {})
    requestHandler({ url: `${origin}/app.js` }, localCallback)
    expect(localCallback).toHaveBeenCalledWith({ cancel: false })
    expect(failures.some((failure) => failure.code === 'NAVIGATION_BLOCKED')).toBe(true)
    manager.dispose()
  })

  it('routes valid messages by sender and blocks forged identities, subframes, and oversized payloads', async () => {
    const messages: any[] = []
    const failures: any[] = []
    const manager = new ModuleViewManager({
      onMessage: (payload, boundIdentity) => messages.push({ payload, boundIdentity }),
      onFailure: (failure) => failures.push(failure),
    })
    await manager.attach(attachOptions())
    const view = createdViews[0]
    const envelope = {
      version: 1,
      direction: 'module-to-host',
      ...identity,
      type: 'message',
      payload: { action: 'ping' },
    }

    emitIpc(view, envelope)
    expect(messages).toEqual([{ payload: { action: 'ping' }, boundIdentity: identity }])

    emitIpc(view, { ...envelope, viewInstanceId: 'view-2' })
    emitIpc(view, envelope, {})
    emitIpc(view, { ...envelope, payload: 'x'.repeat(17 * 1024) })
    expect(failures.map((failure) => failure.code)).toEqual([
      'CROSS_TALK_BLOCKED',
      'CROSS_TALK_BLOCKED',
      'PAYLOAD_LIMIT_EXCEEDED',
    ])
    expect(messages).toHaveLength(1)
    manager.dispose()
  })

  it('validates host payloads before sending them to exactly one view', async () => {
    const manager = new ModuleViewManager()
    await manager.attach(attachOptions())
    const view = createdViews[0]

    manager.send(identity, { command: 'refresh' })
    expect(view.webContents.send).toHaveBeenCalledWith('module-view:to-module', {
      version: 1,
      direction: 'host-to-module',
      ...identity,
      type: 'message',
      payload: { command: 'refresh' },
    })
    expect(() => manager.send(identity, undefined)).toThrow(ModuleViewManagerError)
    manager.dispose()
  })

  it('reports renderer crashes and recreates only the crashed view', async () => {
    const failures: any[] = []
    const manager = new ModuleViewManager({ onFailure: (failure) => failures.push(failure) })
    await manager.attach(attachOptions())
    const crashedView = createdViews[0]

    crashedView.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 139 })
    expect(manager.get(identity)?.state).toBe('crashed')
    expect(failures.at(-1)).toMatchObject({ code: 'RENDERER_GONE', ...identity })

    const recreated = await manager.recreate(identity)
    const replacement = createdViews[1]
    expect(recreated.state).toBe('loading')
    expect(recreated.webContentsId).toBe(replacement.webContents.id)
    expect(crashedView.webContents.close).toHaveBeenCalledWith({ waitForBeforeUnload: false })
    expect(replacement.webContents.loadURL).toHaveBeenCalledWith(`${origin}/index.html`)
    await expect(manager.recreate(identity)).rejects.toMatchObject({ code: 'VIEW_NOT_CRASHED' })
    manager.dispose()
  })
})
