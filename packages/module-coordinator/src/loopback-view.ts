import type { ModuleId } from '@simulator/module-contract'
import type { ModuleViewAttachRequest, ModuleViewPort, ModuleViewSnapshot } from './types.ts'

const DEFAULT_MAX_DOCUMENT_BYTES = 2 * 1024 * 1024

export interface LoopbackFrontendDocument {
  readonly moduleId: ModuleId
  readonly version: ModuleViewSnapshot['version']
  readonly url: string
  readonly contentType: string
  readonly html: string
}

export interface LoopbackFrontendModuleViewPortOptions {
  readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>
  readonly path?: string
  readonly maxDocumentBytes?: number
  readonly timeoutMs?: number
}

interface ViewSession {
  snapshot: ModuleViewSnapshot
  document?: LoopbackFrontendDocument
}

/** Fetch-backed frontend lifecycle adapter for non-Electron hosts and packaged module smoke tests. */
export class LoopbackFrontendModuleViewPort implements ModuleViewPort {
  readonly #fetch: (input: string, init?: RequestInit) => Promise<Response>
  readonly #path: string
  readonly #maxDocumentBytes: number
  readonly #timeoutMs: number
  readonly #sessions = new Map<ModuleId, ViewSession>()

  constructor(options: LoopbackFrontendModuleViewPortOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch
    this.#path = options.path ?? '/'
    this.#maxDocumentBytes = options.maxDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES
    this.#timeoutMs = options.timeoutMs ?? 2_000
    if (!this.#path.startsWith('/') || this.#path.startsWith('//') || this.#path.includes('\\')) throw new TypeError('Frontend path must be an absolute URL path')
    if (!Number.isSafeInteger(this.#maxDocumentBytes) || this.#maxDocumentBytes < 1) throw new TypeError('maxDocumentBytes must be a positive safe integer')
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1) throw new TypeError('timeoutMs must be a positive safe integer')
  }

  async attach(request: ModuleViewAttachRequest): Promise<ModuleViewSnapshot> {
    const endpoint = request.daemon.endpoint
    if (!endpoint || request.daemon.id !== request.moduleId || request.daemon.version !== request.version
      || (request.daemon.state !== 'healthy' && request.daemon.state !== 'degraded')) {
      throw new Error('Frontend attachment requires a ready matching daemon endpoint')
    }
    const attaching = this.#snapshot(request, 'attaching')
    this.#sessions.set(request.moduleId, { snapshot: attaching })
    const host = endpoint.host === '::1' ? '[::1]' : endpoint.host
    const url = `http://${host}:${endpoint.port}${this.#path}`
    try {
      const response = await this.#fetch(url, {
        method: 'GET',
        headers: { accept: 'text/html' },
        redirect: 'error',
        signal: AbortSignal.timeout(this.#timeoutMs),
      })
      if (!response.ok) throw new Error(`Frontend returned HTTP ${response.status}`)
      const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
      if (!contentType.startsWith('text/html')) throw new Error('Frontend must use text/html')
      const declaredLength = Number(response.headers.get('content-length'))
      if (Number.isFinite(declaredLength) && declaredLength > this.#maxDocumentBytes) throw new Error('Frontend exceeds document size limit')
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (bytes.byteLength === 0 || bytes.byteLength > this.#maxDocumentBytes) throw new Error('Frontend document size is invalid')
      const html = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      if (html.includes('\0')) throw new Error('Frontend document contains NUL')
      const attached = this.#snapshot(request, 'attached')
      this.#sessions.set(request.moduleId, {
        snapshot: attached,
        document: Object.freeze({ moduleId: request.moduleId, version: request.version, url, contentType, html }),
      })
      return attached
    } catch (error) {
      this.#sessions.set(request.moduleId, { snapshot: this.#snapshot(request, 'crashed') })
      throw error
    }
  }

  async detach(moduleId: ModuleId): Promise<void> {
    const session = this.#sessions.get(moduleId)
    if (!session) return
    session.snapshot = Object.freeze({ ...session.snapshot, state: 'detached' })
    session.document = undefined
  }

  async query(moduleId: ModuleId): Promise<ModuleViewSnapshot | undefined> {
    const snapshot = this.#sessions.get(moduleId)?.snapshot
    return snapshot ? structuredClone(snapshot) : undefined
  }

  document(moduleId: ModuleId): LoopbackFrontendDocument | undefined {
    const document = this.#sessions.get(moduleId)?.document
    return document ? structuredClone(document) : undefined
  }

  markCrashed(moduleId: ModuleId): ModuleViewSnapshot | undefined {
    const session = this.#sessions.get(moduleId)
    if (!session || session.snapshot.state === 'detached') return undefined
    session.snapshot = Object.freeze({ ...session.snapshot, state: 'crashed' })
    session.document = undefined
    return structuredClone(session.snapshot)
  }

  #snapshot(request: ModuleViewAttachRequest, state: ModuleViewSnapshot['state']): ModuleViewSnapshot {
    return Object.freeze({ moduleId: request.moduleId, version: request.version, state })
  }
}
