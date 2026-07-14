import { randomUUID } from 'node:crypto'
import type { BrowserWindow } from 'electron'
import type { ModuleId } from '@simulator/module-contract'
import type {
  ModuleViewAttachRequest,
  ModuleViewPort,
  ModuleViewSnapshot as CoordinatorViewSnapshot,
} from '@simulator/module-coordinator'
import type {
  ModuleViewAttachOptions,
  ModuleViewIdentity,
  ModuleViewManager,
  ModuleViewSnapshot,
} from './module-view-manager'

interface ElectronViewManagerPort {
  attach(options: ModuleViewAttachOptions): Promise<ModuleViewSnapshot>
  get(identity: ModuleViewIdentity): ModuleViewSnapshot | undefined
  destroy(identity: ModuleViewIdentity): boolean
}

export interface ElectronModuleViewPortOptions {
  readonly manager: ElectronViewManagerPort
  readonly hostWindow: () => BrowserWindow | undefined
  readonly readyTimeoutMs?: number
  readonly onHostClose?: (moduleId: ModuleId) => void | Promise<void>
  readonly onHostCloseError?: (error: unknown, moduleId: ModuleId) => void | Promise<void>
}

interface AttachedView {
  readonly identity: ModuleViewIdentity
  readonly version: CoordinatorViewSnapshot['version']
}

function isHostClosePayload(payload: unknown): payload is { readonly type: 'host.close' } {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return false
  try {
    const prototype = Object.getPrototypeOf(payload)
    if (prototype !== Object.prototype && prototype !== null) return false
    const keys = Reflect.ownKeys(payload)
    if (keys.length !== 1 || keys[0] !== 'type') return false
    const descriptor = Object.getOwnPropertyDescriptor(payload, 'type')
    return !!descriptor && 'value' in descriptor && descriptor.value === 'host.close'
  } catch {
    return false
  }
}

export class ElectronModuleViewPort implements ModuleViewPort {
  readonly #manager: ElectronViewManagerPort
  readonly #hostWindow: ElectronModuleViewPortOptions['hostWindow']
  readonly #readyTimeoutMs: number
  readonly #onHostClose: ElectronModuleViewPortOptions['onHostClose']
  readonly #onHostCloseError: ElectronModuleViewPortOptions['onHostCloseError']
  readonly #views = new Map<ModuleId, AttachedView>()

  constructor(options: ElectronModuleViewPortOptions) {
    this.#manager = options.manager
    this.#hostWindow = options.hostWindow
    this.#readyTimeoutMs = options.readyTimeoutMs ?? 10_000
    this.#onHostClose = options.onHostClose
    this.#onHostCloseError = options.onHostCloseError
    if (!Number.isSafeInteger(this.#readyTimeoutMs) || this.#readyTimeoutMs <= 0) {
      throw new TypeError('Electron module view ready timeout must be a positive integer')
    }
  }

  async attach(request: ModuleViewAttachRequest): Promise<CoordinatorViewSnapshot> {
    const endpoint = request.daemon.endpoint
    if (request.daemon.state !== 'healthy' || !endpoint) {
      throw new Error('Electron module view requires a healthy daemon endpoint')
    }
    const hostWindow = this.#hostWindow()
    if (!hostWindow || hostWindow.isDestroyed()) throw new Error('Electron module view requires a live host window')

    await this.detach(request.moduleId)
    const identity = { moduleId: request.moduleId, viewInstanceId: `host-${randomUUID()}` }
    const origin = `http://${endpoint.host}:${endpoint.port}`
    let timeout: ReturnType<typeof setTimeout> | undefined
    let readyResolve!: () => void
    let readyReject!: (error: Error) => void
    const ready = new Promise<void>((resolve, reject) => {
      readyResolve = resolve
      readyReject = reject
    })
    timeout = setTimeout(() => readyReject(new Error('Electron module view preload did not become ready')), this.#readyTimeoutMs)

    this.#views.set(request.moduleId, { identity, version: request.version })
    try {
      await this.#manager.attach({
        ...identity,
        hostWindow,
        frontendUrl: `${origin}/`,
        allowedFrontendOrigins: [origin],
        rect: 'full-content',
        visible: true,
        onReady: readyResolve,
        onFailure: (failure) => readyReject(new Error(`${failure.code}: ${failure.message}`)),
        onMessage: (payload, boundIdentity) => {
          const current = this.#views.get(request.moduleId)
          if (
            !current
            || current.identity.moduleId !== identity.moduleId
            || current.identity.viewInstanceId !== identity.viewInstanceId
            || boundIdentity.moduleId !== identity.moduleId
            || boundIdentity.viewInstanceId !== identity.viewInstanceId
            || !isHostClosePayload(payload)
            || !this.#onHostClose
          ) {
            return
          }
          void this.#notifyHostClose(request.moduleId)
        },
      })
      await ready
      const snapshot = await this.query(request.moduleId)
      if (snapshot?.state !== 'attached') throw new Error('Electron module view did not attach after preload readiness')
      return snapshot
    } catch (error) {
      this.#manager.destroy(identity)
      this.#views.delete(request.moduleId)
      throw error
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }

  async detach(moduleId: ModuleId): Promise<void> {
    const record = this.#views.get(moduleId)
    if (!record) return
    this.#views.delete(moduleId)
    this.#manager.destroy(record.identity)
  }

  async query(moduleId: ModuleId): Promise<CoordinatorViewSnapshot | undefined> {
    const record = this.#views.get(moduleId)
    if (!record) return undefined
    const snapshot = this.#manager.get(record.identity)
    if (!snapshot) {
      this.#views.delete(moduleId)
      return undefined
    }
    return {
      moduleId,
      version: record.version,
      state: snapshot.state === 'loading'
        ? 'attaching'
        : snapshot.state === 'ready'
          ? snapshot.attached ? 'attached' : 'detached'
          : 'crashed',
    }
  }

  dispose(): void {
    for (const moduleId of [...this.#views.keys()]) void this.detach(moduleId)
  }

  async #notifyHostClose(moduleId: ModuleId): Promise<void> {
    try {
      await this.#onHostClose?.(moduleId)
    } catch (error) {
      try {
        await this.#onHostCloseError?.(error, moduleId)
      } catch {
        // Host callback failures must not escape into the module transport.
      }
    }
  }
}

export type { ElectronViewManagerPort }
