import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  WebContentsView,
  app,
  ipcMain,
  session,
  type BrowserWindow,
  type IpcMainEvent,
  type Rectangle,
  type RenderProcessGoneDetails,
  type Session,
} from 'electron'
import { mainLog } from './logger'
import {
  MODULE_VIEW_CHANNELS,
  MODULE_VIEW_TRANSPORT_VERSION,
  createModuleViewMessageEnvelope,
  isValidModuleId,
  isValidViewInstanceId,
  parseModuleViewEnvelope,
  type ModuleViewFailureEnvelope,
  type ModuleViewJsonValue,
} from '../shared/module-view-transport'

const MAX_VIEW_EDGE = 32_768
const MAX_ALLOWED_ORIGINS = 8
const QUARANTINED_VIEW_BOUNDS = Object.freeze({ x: 0, y: 0, width: 0, height: 0 })

export type ModuleViewFailureCode =
  | 'CROSS_TALK_BLOCKED'
  | 'DESTROYED'
  | 'INVALID_ENVELOPE'
  | 'LOAD_FAILED'
  | 'NAVIGATION_BLOCKED'
  | 'PAYLOAD_LIMIT_EXCEEDED'
  | 'PRELOAD_FAILED'
  | 'RENDERER_GONE'
  | 'RENDERER_REPORTED_FAILURE'

export interface ModuleViewIdentity {
  readonly moduleId: string
  readonly viewInstanceId: string
}

export interface ModuleViewFailure extends ModuleViewIdentity {
  readonly code: ModuleViewFailureCode
  readonly message: string
  readonly detail?: Readonly<Record<string, string | number | boolean | null>>
}

export interface ModuleViewAttachOptions extends ModuleViewIdentity {
  readonly hostWindow: BrowserWindow
  readonly frontendUrl: string
  readonly allowedFrontendOrigins: readonly string[]
  readonly rect?: Rectangle | 'full-content'
  readonly visible?: boolean
  readonly onMessage?: (payload: ModuleViewJsonValue, identity: ModuleViewIdentity) => void
  readonly onFailure?: (failure: ModuleViewFailure) => void
  readonly onReady?: (identity: ModuleViewIdentity) => void
}

export interface ModuleViewSnapshot extends ModuleViewIdentity {
  readonly frontendUrl: string
  readonly allowedFrontendOrigins: readonly string[]
  readonly partition: string
  readonly webContentsId: number
  readonly rect: Rectangle
  readonly attached: boolean
  readonly visible: boolean
  readonly state: 'loading' | 'ready' | 'crashed' | 'failed'
}

interface ModuleViewRecord extends ModuleViewIdentity {
  hostWindow: BrowserWindow
  frontendUrl: string
  allowedFrontendOrigins: readonly string[]
  partition: string
  view: WebContentsView
  rect: Rectangle
  attached: boolean
  reattachAfterRecreate: boolean
  visible: boolean
  restoreVisibleAfterRecreate: boolean
  state: ModuleViewSnapshot['state']
  onMessage?: ModuleViewAttachOptions['onMessage']
  onFailure?: ModuleViewAttachOptions['onFailure']
  onReady?: ModuleViewAttachOptions['onReady']
  hostClosedHandler: () => void
}

export interface ModuleViewManagerOptions {
  readonly preloadPath?: string
  readonly isPackaged?: boolean
  readonly onMessage?: (payload: ModuleViewJsonValue, identity: ModuleViewIdentity) => void
  readonly onFailure?: (failure: ModuleViewFailure) => void
  readonly onReady?: (identity: ModuleViewIdentity) => void
}

export class ModuleViewManagerError extends Error {
  constructor(
    readonly code: 'DUPLICATE_VIEW' | 'INVALID_ARGUMENT' | 'UNKNOWN_VIEW' | 'VIEW_NOT_CRASHED',
    message: string,
  ) {
    super(message)
    this.name = 'ModuleViewManagerError'
  }
}

function keyOf(identity: ModuleViewIdentity): string {
  return `${identity.moduleId}\u0000${identity.viewInstanceId}`
}

function validateIdentity(identity: ModuleViewIdentity): void {
  if (!isValidModuleId(identity.moduleId)) {
    throw new ModuleViewManagerError('INVALID_ARGUMENT', 'Invalid moduleId')
  }
  if (!isValidViewInstanceId(identity.viewInstanceId)) {
    throw new ModuleViewManagerError('INVALID_ARGUMENT', 'Invalid viewInstanceId')
  }
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1' || hostname === 'localhost'
}

function parseAllowedOrigin(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new ModuleViewManagerError('INVALID_ARGUMENT', `Invalid frontend origin: ${value}`)
  }
  if (url.protocol !== 'http:' || !isLoopbackHostname(url.hostname) || !url.port) {
    throw new ModuleViewManagerError('INVALID_ARGUMENT', 'Module frontend origins must use HTTP on an explicit loopback port')
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.origin !== value) {
    throw new ModuleViewManagerError('INVALID_ARGUMENT', `Frontend origin must be canonical: ${url.origin}`)
  }
  return url.origin
}

function validateFrontend(frontendUrl: string, allowedOrigins: readonly string[]): readonly string[] {
  if (allowedOrigins.length === 0 || allowedOrigins.length > MAX_ALLOWED_ORIGINS) {
    throw new ModuleViewManagerError('INVALID_ARGUMENT', `allowedFrontendOrigins must contain 1-${MAX_ALLOWED_ORIGINS} origins`)
  }

  const canonicalOrigins = [...new Set(allowedOrigins.map(parseAllowedOrigin))]
  let url: URL
  try {
    url = new URL(frontendUrl)
  } catch {
    throw new ModuleViewManagerError('INVALID_ARGUMENT', 'Invalid module frontend URL')
  }
  if (url.username || url.password || !canonicalOrigins.includes(url.origin)) {
    throw new ModuleViewManagerError('INVALID_ARGUMENT', 'Module frontend URL is not in its local origin allowlist')
  }
  return Object.freeze(canonicalOrigins)
}

function validateRect(rect: Rectangle): Rectangle {
  for (const [name, value] of Object.entries(rect)) {
    if (!Number.isSafeInteger(value) || value < 0 || value > MAX_VIEW_EDGE) {
      throw new ModuleViewManagerError('INVALID_ARGUMENT', `Invalid module view rect ${name}`)
    }
  }
  if (rect.width === 0 || rect.height === 0) {
    throw new ModuleViewManagerError('INVALID_ARGUMENT', 'Module view rect must have a positive width and height')
  }
  return Object.freeze({ x: rect.x, y: rect.y, width: rect.width, height: rect.height })
}

export function getModuleViewFullContentRect(hostWindow: BrowserWindow): Rectangle {
  const [width, height] = hostWindow.getContentSize()
  return validateRect({ x: 0, y: 0, width, height })
}

function resolveRect(hostWindow: BrowserWindow, rect: Rectangle | 'full-content' | undefined): Rectangle {
  return rect === undefined || rect === 'full-content'
    ? getModuleViewFullContentRect(hostWindow)
    : validateRect(rect)
}

function isAllowedRequest(urlString: string, allowedOrigins: readonly string[]): boolean {
  try {
    const requestUrl = new URL(urlString)
    if (requestUrl.protocol === 'http:') return allowedOrigins.includes(requestUrl.origin)
    if (requestUrl.protocol !== 'ws:') return false

    return allowedOrigins.some((origin) => {
      const allowedUrl = new URL(origin)
      return requestUrl.hostname === allowedUrl.hostname && requestUrl.port === allowedUrl.port
    })
  } catch {
    return false
  }
}

function createPartition(identity: ModuleViewIdentity): string {
  const digest = createHash('sha256')
    .update(identity.moduleId)
    .update('\u0000')
    .update(identity.viewInstanceId)
    .update('\u0000')
    .update(randomUUID())
    .digest('hex')
    .slice(0, 24)
  return `module-view-${digest}`
}

export class ModuleViewManager {
  private readonly records = new Map<string, ModuleViewRecord>()
  private readonly keyByWebContentsId = new Map<number, string>()
  private readonly configuredPartitions = new Set<string>()
  private readonly preloadPath: string
  private readonly isPackaged: boolean
  private readonly ipcListener: (event: IpcMainEvent, envelope: unknown) => void
  private disposed = false

  constructor(private readonly options: ModuleViewManagerOptions = {}) {
    this.preloadPath = options.preloadPath ?? join(__dirname, 'module-view-preload.cjs')
    this.isPackaged = options.isPackaged ?? app.isPackaged
    this.ipcListener = (event, envelope) => this.handleModuleMessage(event, envelope)
    ipcMain.on(MODULE_VIEW_CHANNELS.TO_HOST, this.ipcListener)
  }

  async attach(options: ModuleViewAttachOptions): Promise<ModuleViewSnapshot> {
    this.assertActive()
    validateIdentity(options)
    const key = keyOf(options)
    if (this.records.has(key)) {
      throw new ModuleViewManagerError('DUPLICATE_VIEW', 'Module view identity is already in use')
    }
    if (options.hostWindow.isDestroyed()) {
      throw new ModuleViewManagerError('INVALID_ARGUMENT', 'Cannot attach a module view to a destroyed window')
    }

    const allowedFrontendOrigins = validateFrontend(options.frontendUrl, options.allowedFrontendOrigins)
    const partition = createPartition(options)
    const rect = resolveRect(options.hostWindow, options.rect)
    const visible = options.visible ?? true
    this.configureSession(partition, allowedFrontendOrigins)

    const view = this.createView(options, partition)
    const hostClosedHandler = () => this.destroy(options)
    const record: ModuleViewRecord = {
      moduleId: options.moduleId,
      viewInstanceId: options.viewInstanceId,
      hostWindow: options.hostWindow,
      frontendUrl: options.frontendUrl,
      allowedFrontendOrigins,
      partition,
      view,
      rect,
      attached: true,
      reattachAfterRecreate: false,
      visible,
      restoreVisibleAfterRecreate: false,
      state: 'loading',
      onMessage: options.onMessage,
      onFailure: options.onFailure,
      onReady: options.onReady,
      hostClosedHandler,
    }

    this.records.set(key, record)
    this.keyByWebContentsId.set(view.webContents.id, key)
    options.hostWindow.once('closed', hostClosedHandler)
    options.hostWindow.contentView.addChildView(view)
    view.setBounds(rect)
    view.setVisible(visible)
    this.bindViewEvents(record)

    try {
      await view.webContents.loadURL(options.frontendUrl)
    } catch (error) {
      this.handleLoadFailure(record, view.webContents, {
        error: error instanceof Error ? error.message : String(error),
      })
      this.destroy(options)
      throw error
    }
    return this.snapshot(record)
  }

  detach(identity: ModuleViewIdentity): ModuleViewSnapshot {
    const record = this.requireRecord(identity)
    if (record.attached && !record.hostWindow.isDestroyed()) {
      record.hostWindow.contentView.removeChildView(record.view)
    }
    record.attached = false
    return this.snapshot(record)
  }

  reattach(identity: ModuleViewIdentity, hostWindow?: BrowserWindow): ModuleViewSnapshot {
    const record = this.requireRecord(identity)
    if (record.state === 'crashed' || record.state === 'failed') {
      throw new ModuleViewManagerError('INVALID_ARGUMENT', 'Unavailable module views require explicit recreation')
    }
    if (record.attached) return this.snapshot(record)
    if (hostWindow) {
      if (hostWindow.isDestroyed()) {
        throw new ModuleViewManagerError('INVALID_ARGUMENT', 'Cannot attach a module view to a destroyed window')
      }
      record.hostWindow.removeListener('closed', record.hostClosedHandler)
      record.hostWindow = hostWindow
      record.hostWindow.once('closed', record.hostClosedHandler)
      record.rect = getModuleViewFullContentRect(hostWindow)
    }
    record.hostWindow.contentView.addChildView(record.view)
    record.view.setBounds(record.rect)
    record.view.setVisible(record.visible)
    record.attached = true
    return this.snapshot(record)
  }

  resize(identity: ModuleViewIdentity, rect: Rectangle | 'full-content'): ModuleViewSnapshot {
    const record = this.requireRecord(identity)
    record.rect = resolveRect(record.hostWindow, rect)
    if (record.state !== 'crashed' && record.state !== 'failed') record.view.setBounds(record.rect)
    return this.snapshot(record)
  }

  hide(identity: ModuleViewIdentity): ModuleViewSnapshot {
    const record = this.requireRecord(identity)
    if (record.state === 'crashed' || record.state === 'failed') {
      record.restoreVisibleAfterRecreate = false
      return this.snapshot(record)
    }
    record.visible = false
    record.view.setVisible(false)
    return this.snapshot(record)
  }

  show(identity: ModuleViewIdentity): ModuleViewSnapshot {
    const record = this.requireRecord(identity)
    if (record.state === 'crashed' || record.state === 'failed') {
      record.restoreVisibleAfterRecreate = true
      return this.snapshot(record)
    }
    record.visible = true
    record.view.setVisible(true)
    return this.snapshot(record)
  }

  send(identity: ModuleViewIdentity, payload: unknown): void {
    const record = this.requireRecord(identity)
    if (record.state === 'crashed' || record.state === 'failed' || record.view.webContents.isDestroyed()) {
      throw new ModuleViewManagerError('INVALID_ARGUMENT', 'Cannot send to an unavailable module view')
    }
    const envelope = createModuleViewMessageEnvelope(
      'host-to-module',
      record.moduleId,
      record.viewInstanceId,
      payload,
    )
    if (!envelope.ok) {
      throw new ModuleViewManagerError('INVALID_ARGUMENT', envelope.message)
    }
    record.view.webContents.send(MODULE_VIEW_CHANNELS.TO_MODULE, envelope.value)
  }

  async recreate(identity: ModuleViewIdentity): Promise<ModuleViewSnapshot> {
    const record = this.requireRecord(identity)
    if (record.state !== 'crashed' && record.state !== 'failed') {
      throw new ModuleViewManagerError('VIEW_NOT_CRASHED', 'Only unavailable module views can be recreated')
    }

    const oldView = record.view
    const shouldReattach = record.reattachAfterRecreate
    if (record.attached && !record.hostWindow.isDestroyed()) {
      record.hostWindow.contentView.removeChildView(oldView)
    }
    this.keyByWebContentsId.delete(oldView.webContents.id)
    if (!oldView.webContents.isDestroyed()) oldView.webContents.close({ waitForBeforeUnload: false })

    const replacement = this.createView(record, record.partition)
    const replacementVisible = record.restoreVisibleAfterRecreate
    record.view = replacement
    record.state = 'loading'
    record.reattachAfterRecreate = false
    record.visible = replacementVisible
    record.restoreVisibleAfterRecreate = false
    this.keyByWebContentsId.set(replacement.webContents.id, keyOf(record))
    this.bindViewEvents(record)
    replacement.setBounds(record.rect)
    replacement.setVisible(replacementVisible)
    if (shouldReattach && !record.hostWindow.isDestroyed()) {
      record.hostWindow.contentView.addChildView(replacement)
      record.attached = true
    }

    try {
      await replacement.webContents.loadURL(record.frontendUrl)
    } catch (error) {
      this.handleLoadFailure(record, replacement.webContents, {
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
    return this.snapshot(record)
  }

  get(identity: ModuleViewIdentity): ModuleViewSnapshot | undefined {
    const record = this.records.get(keyOf(identity))
    return record ? this.snapshot(record) : undefined
  }

  list(): readonly ModuleViewSnapshot[] {
    return [...this.records.values()]
      .sort((a, b) => keyOf(a).localeCompare(keyOf(b)))
      .map((record) => this.snapshot(record))
  }

  destroy(identity: ModuleViewIdentity): boolean {
    const key = keyOf(identity)
    const record = this.records.get(key)
    if (!record) return false

    this.records.delete(key)
    this.keyByWebContentsId.delete(record.view.webContents.id)
    record.hostWindow.removeListener('closed', record.hostClosedHandler)
    if (record.attached && !record.hostWindow.isDestroyed()) {
      record.hostWindow.contentView.removeChildView(record.view)
    }
    record.attached = false
    if (!record.view.webContents.isDestroyed()) record.view.webContents.close({ waitForBeforeUnload: false })
    return true
  }

  destroyAll(): void {
    for (const record of [...this.records.values()]) this.destroy(record)
  }

  dispose(): void {
    if (this.disposed) return
    this.destroyAll()
    ipcMain.removeListener(MODULE_VIEW_CHANNELS.TO_HOST, this.ipcListener)
    this.disposed = true
  }

  private assertActive(): void {
    if (this.disposed) throw new ModuleViewManagerError('INVALID_ARGUMENT', 'ModuleViewManager has been disposed')
  }

  private createView(identity: ModuleViewIdentity, partition: string): WebContentsView {
    return new WebContentsView({
      webPreferences: {
        preload: this.preloadPath,
        partition,
        additionalArguments: [
          `--simulator-module-id=${identity.moduleId}`,
          `--simulator-view-instance-id=${identity.viewInstanceId}`,
        ],
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
        devTools: !this.isPackaged,
        spellcheck: false,
        autoplayPolicy: 'document-user-activation-required',
      },
    })
  }

  private configureSession(partition: string, allowedOrigins: readonly string[]): void {
    if (this.configuredPartitions.has(partition)) return
    const moduleSession = session.fromPartition(partition, { cache: false })
    this.configuredPartitions.add(partition)
    this.denySessionPrivileges(moduleSession, allowedOrigins)
  }

  private denySessionPrivileges(moduleSession: Session, allowedOrigins: readonly string[]): void {
    moduleSession.setPermissionCheckHandler(() => false)
    moduleSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
    moduleSession.setDevicePermissionHandler(() => false)
    moduleSession.setDisplayMediaRequestHandler((_request, callback) => callback({}))
    moduleSession.on('will-download', (event, item) => {
      event.preventDefault()
      item.cancel()
    })
    moduleSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
      callback({ cancel: !isAllowedRequest(details.url, allowedOrigins) })
    })
  }

  private bindViewEvents(record: ModuleViewRecord): void {
    const { webContents } = record.view

    webContents.setWindowOpenHandler(() => {
      this.reportFailure(record, 'NAVIGATION_BLOCKED', 'Module frontend popup was blocked')
      return { action: 'deny' }
    })

    const blockDisallowedNavigation = (event: Electron.Event, url: string) => {
      if (isAllowedRequest(url, record.allowedFrontendOrigins)) return
      event.preventDefault()
      this.reportFailure(record, 'NAVIGATION_BLOCKED', 'Module frontend navigation left its local allowlist', { url })
    }
    webContents.on('will-navigate', blockDisallowedNavigation)
    webContents.on('will-redirect', blockDisallowedNavigation)
    webContents.on('will-frame-navigate', (details) => {
      if (isAllowedRequest(details.url, record.allowedFrontendOrigins)) return
      details.preventDefault()
      this.reportFailure(record, 'NAVIGATION_BLOCKED', 'Module frontend frame navigation left its local allowlist', {
        url: details.url,
      })
    })
    webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return
      this.handleLoadFailure(record, webContents, {
        errorCode,
        errorDescription,
        url: validatedUrl,
      })
    })
    webContents.on('preload-error', (_event, preloadPath, error) => {
      if (!this.quarantine(record, 'failed', webContents)) return
      this.reportFailure(record, 'PRELOAD_FAILED', 'Module view preload failed', {
        preloadPath,
        error: error.message,
      })
    })
    webContents.on('render-process-gone', (_event, details: RenderProcessGoneDetails) => {
      if (!this.quarantine(record, 'crashed', webContents)) return
      this.reportFailure(record, 'RENDERER_GONE', 'Module frontend renderer exited', {
        reason: details.reason,
        exitCode: details.exitCode,
      })
    })
    if (this.isPackaged) {
      webContents.on('devtools-opened', () => webContents.closeDevTools())
    }
  }

  private handleModuleMessage(event: IpcMainEvent, input: unknown): void {
    const key = this.keyByWebContentsId.get(event.sender.id)
    if (!key) return
    const record = this.records.get(key)
    if (!record || record.view.webContents !== event.sender) return
    if (record.state === 'crashed' || record.state === 'failed') return

    if (event.sender.isDestroyed() || event.senderFrame !== event.sender.mainFrame) {
      this.reportFailure(record, 'CROSS_TALK_BLOCKED', 'Module view IPC without the live bound main frame was blocked')
      return
    }

    const parsed = parseModuleViewEnvelope(input, 'module-to-host')
    if (!parsed.ok) {
      this.reportFailure(record, parsed.code, parsed.message)
      return
    }
    if (parsed.value.moduleId !== record.moduleId || parsed.value.viewInstanceId !== record.viewInstanceId) {
      this.reportFailure(record, 'CROSS_TALK_BLOCKED', 'Module view envelope identity does not match its sender')
      return
    }

    if (parsed.value.type === 'ready') {
      record.state = 'ready'
      const identity = Object.freeze({ moduleId: record.moduleId, viewInstanceId: record.viewInstanceId })
      record.onReady?.(identity)
      this.options.onReady?.(identity)
      return
    }
    if (parsed.value.type === 'failure') {
      this.reportRendererFailure(record, parsed.value)
      return
    }

    const identity = Object.freeze({ moduleId: record.moduleId, viewInstanceId: record.viewInstanceId })
    record.onMessage?.(parsed.value.payload, identity)
    this.options.onMessage?.(parsed.value.payload, identity)
  }

  private reportRendererFailure(record: ModuleViewRecord, envelope: ModuleViewFailureEnvelope): void {
    this.reportFailure(record, 'RENDERER_REPORTED_FAILURE', envelope.error.message, {
      rendererCode: envelope.error.code,
    })
  }

  private handleLoadFailure(
    record: ModuleViewRecord,
    webContents: Electron.WebContents,
    detail: Readonly<Record<string, string | number | boolean | null>>,
  ): void {
    if (!this.quarantine(record, 'failed', webContents)) return
    this.reportFailure(record, 'LOAD_FAILED', 'Module frontend failed to load', detail)
  }

  private quarantine(
    record: ModuleViewRecord,
    state: 'crashed' | 'failed',
    expectedWebContents: Electron.WebContents,
  ): boolean {
    if (
      this.records.get(keyOf(record)) !== record
      || record.view.webContents !== expectedWebContents
      || record.state === 'crashed'
      || record.state === 'failed'
    ) {
      return false
    }

    record.state = state
    this.keyByWebContentsId.delete(expectedWebContents.id)
    record.reattachAfterRecreate = record.attached
    record.restoreVisibleAfterRecreate = record.visible
    record.visible = false
    record.view.setVisible(false)
    record.view.setBounds(QUARANTINED_VIEW_BOUNDS)
    if (record.attached && !record.hostWindow.isDestroyed()) {
      record.hostWindow.contentView.removeChildView(record.view)
    }
    record.attached = false
    return true
  }

  private reportFailure(
    record: ModuleViewRecord,
    code: ModuleViewFailureCode,
    message: string,
    detail?: Readonly<Record<string, string | number | boolean | null>>,
  ): void {
    const failure = Object.freeze({
      moduleId: record.moduleId,
      viewInstanceId: record.viewInstanceId,
      code,
      message,
      ...(detail ? { detail: Object.freeze({ ...detail }) } : {}),
    })
    mainLog.warn('[module-view] failure', failure)
    record.onFailure?.(failure)
    this.options.onFailure?.(failure)
  }

  private requireRecord(identity: ModuleViewIdentity): ModuleViewRecord {
    this.assertActive()
    validateIdentity(identity)
    const record = this.records.get(keyOf(identity))
    if (!record) throw new ModuleViewManagerError('UNKNOWN_VIEW', 'Unknown module view identity')
    return record
  }

  private snapshot(record: ModuleViewRecord): ModuleViewSnapshot {
    return Object.freeze({
      moduleId: record.moduleId,
      viewInstanceId: record.viewInstanceId,
      frontendUrl: record.frontendUrl,
      allowedFrontendOrigins: record.allowedFrontendOrigins,
      partition: record.partition,
      webContentsId: record.view.webContents.id,
      rect: Object.freeze({ ...record.rect }),
      attached: record.attached,
      visible: record.visible,
      state: record.state,
    })
  }
}
