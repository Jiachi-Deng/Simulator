// Runs separately because Bun's Electron module mocks are process-global.
import { beforeEach, describe, expect, it, mock } from 'bun:test'

type Listener = (...args: any[]) => any

const ipcListeners = new Map<string, Listener>()
const sessions = new Map<string, ReturnType<typeof createMockSession>>()
const createdViews: any[] = []
let nextWebContentsId = 100
let loadURLImplementation: ((webContents: any, url: string) => Promise<void>) | undefined

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
      Object.assign(wrapped, { listener })
      this.on(event, wrapped)
    },
    removeListener(event: string, listener: Listener) {
      listeners.set(event, (listeners.get(event) ?? []).filter((candidate) => (
        candidate !== listener && (candidate as Listener & { listener?: Listener }).listener !== listener
      )))
    },
    emit(event: string, ...args: any[]) {
      for (const listener of [...(listeners.get(event) ?? [])]) listener(...args)
    },
    listenerCount(event: string) {
      return listeners.get(event)?.length ?? 0
    },
  }
}

function createMockWebContents() {
  const emitter = createEmitter()
  const mainFrame = {}
  let destroyed = false
  const webContents = {
    ...emitter,
    id: nextWebContentsId++,
    mainFrame,
    isDestroyed: mock(() => destroyed),
    close: mock((_options?: unknown) => { destroyed = true }),
    loadURL: mock(async (url: string) => loadURLImplementation?.(webContents, url)),
    send: mock((_channel: string, _envelope: unknown) => {}),
    setWindowOpenHandler: mock((_handler: Listener) => {}),
    closeDevTools: mock(() => {}),
  }
  return webContents
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
  let contentSizeError: Error | undefined
  return {
    ...emitter,
    contentView: {
      addChildView: mock((_view: unknown) => {}),
      removeChildView: mock((_view: unknown) => {}),
    },
    getContentSize: mock(() => {
      if (contentSizeError) throw contentSizeError
      return [width, height]
    }),
    isDestroyed: mock(() => destroyed),
    _emit: (event: string) => emitter.emit(event),
    _listenerCount: (event: string) => emitter.listenerCount(event),
    _setContentSize: (nextWidth: number, nextHeight: number, event = 'resize') => {
      width = nextWidth
      height = nextHeight
      emitter.emit(event)
    },
    _setContentSizeError: (error: Error | undefined) => {
      contentSizeError = error
    },
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
    loadURLImplementation = undefined
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
    expect(dedicatedSession.webRequest.onBeforeRequest.mock.calls[0][0]).toEqual({ urls: ['<all_urls>'] })

    manager.dispose()
  })

  it('keeps full-content bounds synchronized across resize, maximize, and restore size changes', async () => {
    const hostWindow = createHostWindow(1000, 700)
    const manager = new ModuleViewManager()
    await manager.attach({ ...attachOptions(hostWindow), rect: 'full-content' })
    const view = createdViews[0]

    expect(hostWindow._listenerCount('resize')).toBe(1)
    expect(hostWindow._listenerCount('maximize')).toBe(1)
    expect(hostWindow._listenerCount('restore')).toBe(1)

    hostWindow._setContentSize(1280, 800)
    expect(view.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 1280, height: 800 })
    expect(manager.get(identity)?.rect).toEqual({ x: 0, y: 0, width: 1280, height: 800 })

    hostWindow._setContentSize(1728, 1080, 'maximize')
    expect(view.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 1728, height: 1080 })

    hostWindow._setContentSize(1100, 720, 'restore')
    expect(view.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 1100, height: 720 })
    expect(manager.get(identity)?.rect).toEqual({ x: 0, y: 0, width: 1100, height: 720 })
    manager.dispose()
  })

  it('keeps fixed bounds stable and only subscribes while full-content is attached', async () => {
    const hostWindow = createHostWindow()
    const replacementHost = createHostWindow(1400, 900)
    const manager = new ModuleViewManager()
    const fixedRect = { x: 8, y: 12, width: 640, height: 480 }
    await manager.attach({ ...attachOptions(hostWindow), rect: fixedRect })
    const view = createdViews[0]

    expect(hostWindow._listenerCount('resize')).toBe(0)
    hostWindow._setContentSize(1800, 1000)
    expect(view.setBounds).toHaveBeenCalledTimes(1)
    expect(manager.get(identity)?.rect).toEqual(fixedRect)

    manager.resize(identity, 'full-content')
    expect(hostWindow._listenerCount('resize')).toBe(1)
    expect(view.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 1800, height: 1000 })

    manager.resize(identity, fixedRect)
    expect(hostWindow._listenerCount('resize')).toBe(0)
    hostWindow._setContentSize(1920, 1080)
    expect(view.setBounds).toHaveBeenLastCalledWith(fixedRect)

    manager.detach(identity)
    expect(manager.reattach(identity, replacementHost as any).rect).toEqual(fixedRect)
    expect(replacementHost._listenerCount('resize')).toBe(0)
    replacementHost._setContentSize(1600, 1000)
    expect(view.setBounds).toHaveBeenLastCalledWith(fixedRect)
    manager.dispose()
  })

  it('cleans up full-content listeners across detach, replacement, host close, destroy, and dispose', async () => {
    const firstHost = createHostWindow(1000, 700)
    const replacementHost = createHostWindow(1400, 900)
    const manager = new ModuleViewManager()
    await manager.attach({ ...attachOptions(firstHost), rect: 'full-content' })
    const view = createdViews[0]

    manager.detach(identity)
    expect(firstHost._listenerCount('resize')).toBe(0)
    firstHost._setContentSize(1100, 750)
    expect(view.setBounds).toHaveBeenCalledTimes(1)

    expect(manager.reattach(identity, replacementHost as any).rect)
      .toEqual({ x: 0, y: 0, width: 1400, height: 900 })
    expect(firstHost._listenerCount('closed')).toBe(0)
    expect(replacementHost._listenerCount('resize')).toBe(1)
    firstHost._destroy()
    expect(manager.get(identity)).toBeDefined()

    replacementHost._destroy()
    expect(manager.get(identity)).toBeUndefined()
    expect(replacementHost._listenerCount('resize')).toBe(0)
    expect(view.webContents.close).toHaveBeenCalledTimes(1)

    const destroyHost = createHostWindow()
    await manager.attach({ ...attachOptions(destroyHost), viewInstanceId: 'view-destroy', rect: 'full-content' })
    manager.destroy({ moduleId: identity.moduleId, viewInstanceId: 'view-destroy' })
    expect(destroyHost._listenerCount('resize')).toBe(0)
    expect(destroyHost._listenerCount('closed')).toBe(0)

    const disposeHost = createHostWindow()
    await manager.attach({ ...attachOptions(disposeHost), viewInstanceId: 'view-dispose', rect: 'full-content' })
    manager.dispose()
    expect(disposeHost._listenerCount('resize')).toBe(0)
    expect(disposeHost._listenerCount('closed')).toBe(0)
  })

  it('rebinds full-content resize to a recreated live view without touching the destroyed view', async () => {
    const hostWindow = createHostWindow(1200, 800)
    const manager = new ModuleViewManager()
    await manager.attach({ ...attachOptions(hostWindow), rect: 'full-content' })
    const crashedView = createdViews[0]

    crashedView.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 139 })
    expect(hostWindow._listenerCount('resize')).toBe(0)
    hostWindow._setContentSize(1600, 1000)
    expect(crashedView.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 0, height: 0 })

    await manager.recreate(identity)
    const replacement = createdViews[1]
    expect(replacement.setBounds).toHaveBeenCalledWith({ x: 0, y: 0, width: 1600, height: 1000 })
    expect(hostWindow._listenerCount('resize')).toBe(1)

    crashedView.webContents.isDestroyed.mockImplementation(() => true)
    hostWindow._setContentSize(1700, 1050)
    expect(replacement.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 1700, height: 1050 })
    expect(crashedView.setBounds).toHaveBeenCalledTimes(2)
    manager.dispose()
  })

  it('contains host resize errors and preserves the last successfully applied bounds', async () => {
    const hostWindow = createHostWindow(1200, 800)
    const manager = new ModuleViewManager()
    await manager.attach({ ...attachOptions(hostWindow), rect: 'full-content' })
    const view = createdViews[0]

    hostWindow._setContentSizeError(new Error('window is transitioning'))
    expect(() => hostWindow._emit('resize')).not.toThrow()
    expect(manager.get(identity)?.rect).toEqual({ x: 0, y: 0, width: 1200, height: 800 })
    expect(view.setBounds).toHaveBeenCalledTimes(1)

    hostWindow._setContentSizeError(undefined)
    view.setBounds.mockImplementationOnce(() => { throw new Error('view was destroyed during resize') })
    expect(() => hostWindow._setContentSize(1400, 900)).not.toThrow()
    expect(manager.get(identity)?.rect).toEqual({ x: 0, y: 0, width: 1200, height: 800 })

    hostWindow._setContentSize(1500, 950)
    expect(view.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 1500, height: 950 })
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

  it('quarantines an initial did-fail-load once before destroying the failed attachment', async () => {
    const hostWindow = createHostWindow()
    const failures: any[] = []
    let manager: InstanceType<typeof ModuleViewManager>
    manager = new ModuleViewManager({
      onFailure: (failure) => {
        const view = createdViews[0]
        expect(view.setVisible).toHaveBeenLastCalledWith(false)
        expect(view.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 0, height: 0 })
        expect(hostWindow.contentView.removeChildView).toHaveBeenCalledWith(view)
        expect(manager.get(identity)).toMatchObject({ state: 'failed', attached: false, visible: false })
        failures.push(failure)
      },
    })
    loadURLImplementation = async (webContents, url) => {
      webContents.emit('did-fail-load', {}, -105, 'NAME_NOT_RESOLVED', url, true)
      throw new Error('loadURL rejected after did-fail-load')
    }

    await expect(manager.attach(attachOptions(hostWindow))).rejects.toThrow('loadURL rejected after did-fail-load')
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({ code: 'LOAD_FAILED', ...identity })
    expect(manager.get(identity)).toBeUndefined()
    expect(manager.destroy(identity)).toBe(false)
    expect(manager.destroy(identity)).toBe(false)
    expect(createdViews[0].webContents.close).toHaveBeenCalledTimes(1)
    manager.dispose()
  })

  it('quarantines a post-attach main-frame reload failure before callback and disables its sender', async () => {
    const hostWindow = createHostWindow()
    const failures: any[] = []
    const messages: any[] = []
    let manager: InstanceType<typeof ModuleViewManager>
    manager = new ModuleViewManager({
      onMessage: (payload) => messages.push(payload),
      onFailure: (failure) => {
        const view = createdViews[0]
        expect(view.setVisible).toHaveBeenLastCalledWith(false)
        expect(view.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 0, height: 0 })
        expect(hostWindow.contentView.removeChildView).toHaveBeenCalledWith(view)
        expect(manager.get(identity)).toMatchObject({ state: 'failed', attached: false, visible: false })
        failures.push(failure)
      },
    })
    await manager.attach(attachOptions(hostWindow))
    const view = createdViews[0]

    view.webContents.emit('did-fail-load', {}, -2, 'FAILED', `${origin}/index.html`, true)
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({
      code: 'LOAD_FAILED',
      detail: { errorCode: -2, errorDescription: 'FAILED', url: `${origin}/index.html` },
      ...identity,
    })
    expect(hostWindow.contentView.removeChildView).toHaveBeenCalledTimes(1)

    emitIpc(view, {
      version: 1,
      direction: 'module-to-host',
      ...identity,
      type: 'message',
      payload: { shouldNotArrive: true },
    })
    view.webContents.emit('did-fail-load', {}, -2, 'FAILED_AGAIN', `${origin}/index.html`, true)
    expect(messages).toHaveLength(0)
    expect(failures).toHaveLength(1)
    expect(() => manager.reattach(identity)).toThrow(ModuleViewManagerError)
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
    const localWebSocketCallback = mock((_result: unknown) => {})
    requestHandler({ url: 'ws://127.0.0.1:43117/socket' }, localWebSocketCallback)
    expect(localWebSocketCallback).toHaveBeenCalledWith({ cancel: false })
    for (const deniedUrl of [
      'ws://127.0.0.1:43118/socket',
      'ws://localhost:43117/socket',
      'wss://127.0.0.1:43117/socket',
      'file:///tmp/module.html',
      'data:text/plain,blocked',
    ]) {
      const callback = mock((_result: unknown) => {})
      requestHandler({ url: deniedUrl }, callback)
      expect(callback).toHaveBeenCalledWith({ cancel: true })
    }
    expect(failures.some((failure) => failure.code === 'NAVIGATION_BLOCKED')).toBe(true)
    manager.dispose()
  })

  it('routes valid messages by sender and blocks forged identities, null/subframes, destroyed senders, and oversized payloads', async () => {
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
    emitIpc(view, envelope, null)
    view.webContents.isDestroyed.mockImplementationOnce(() => true)
    emitIpc(view, envelope)
    emitIpc(view, { ...envelope, payload: 'x'.repeat(17 * 1024) })
    expect(failures.map((failure) => failure.code)).toEqual([
      'CROSS_TALK_BLOCKED',
      'CROSS_TALK_BLOCKED',
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

  it('quarantines renderer crashes before callback and recreates only the unavailable view', async () => {
    const failures: any[] = []
    const hostWindow = createHostWindow()
    let manager: InstanceType<typeof ModuleViewManager>
    manager = new ModuleViewManager({
      onFailure: (failure) => {
        const view = createdViews[0]
        expect(view.setVisible).toHaveBeenLastCalledWith(false)
        expect(view.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 0, height: 0 })
        expect(hostWindow.contentView.removeChildView).toHaveBeenCalledWith(view)
        expect(manager.get(identity)).toMatchObject({ attached: false, visible: false })
        failures.push(failure)
      },
    })
    await manager.attach(attachOptions(hostWindow))
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
    expect(hostWindow.contentView.addChildView).toHaveBeenLastCalledWith(replacement)
    expect(recreated.attached).toBe(true)
    await expect(manager.recreate(identity)).rejects.toMatchObject({ code: 'VIEW_NOT_CRASHED' })
    manager.dispose()
  })

  it('quarantines preload failure before callback and requires explicit recreate', async () => {
    const hostWindow = createHostWindow()
    const failures: any[] = []
    let manager: InstanceType<typeof ModuleViewManager>
    manager = new ModuleViewManager({
      onFailure: (failure) => {
        const view = createdViews[0]
        expect(view.setVisible).toHaveBeenLastCalledWith(false)
        expect(view.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 0, height: 0 })
        expect(hostWindow.contentView.removeChildView).toHaveBeenCalledWith(view)
        expect(manager.get(identity)).toMatchObject({ state: 'failed', attached: false, visible: false })
        failures.push(failure)
      },
    })
    await manager.attach(attachOptions(hostWindow))
    const failedView = createdViews[0]

    failedView.webContents.emit('preload-error', {}, '/tmp/module-view-preload.cjs', new Error('broken preload'))
    expect(failures.at(-1)).toMatchObject({ code: 'PRELOAD_FAILED', ...identity })
    const envelope = {
      version: 1,
      direction: 'module-to-host',
      ...identity,
      type: 'message',
      payload: { shouldNotArrive: true },
    }
    emitIpc(failedView, envelope)
    expect(failures).toHaveLength(1)
    expect(() => manager.show(identity)).not.toThrow()
    expect(() => manager.resize(identity, { x: 4, y: 4, width: 320, height: 240 })).not.toThrow()
    expect(failedView.setVisible).toHaveBeenLastCalledWith(false)
    expect(failedView.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 0, height: 0 })
    expect(() => manager.reattach(identity)).toThrow(ModuleViewManagerError)

    const recreated = await manager.recreate(identity)
    expect(recreated).toMatchObject({ state: 'loading', attached: true, visible: true })
    expect(createdViews[1].setBounds).toHaveBeenCalledWith({ x: 4, y: 4, width: 320, height: 240 })
    manager.dispose()
  })
})
