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
}

interface AttachedView {
  readonly identity: ModuleViewIdentity
  readonly version: CoordinatorViewSnapshot['version']
}

export class ElectronModuleViewPort implements ModuleViewPort {
  readonly #manager: ElectronViewManagerPort
  readonly #hostWindow: ElectronModuleViewPortOptions['hostWindow']
  readonly #readyTimeoutMs: number
  readonly #views = new Map<ModuleId, AttachedView>()

  constructor(options: ElectronModuleViewPortOptions) {
    this.#manager = options.manager
    this.#hostWindow = options.hostWindow
    this.#readyTimeoutMs = options.readyTimeoutMs ?? 10_000
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
}

export type { ElectronViewManagerPort }
