import { randomUUID } from 'node:crypto'
import type {
  ArtifactPartialRecord,
  CachedArtifactRecord,
  CachedCatalogRecord,
  DownloaderClock,
  DownloaderFetchAdapter,
  DownloaderFetchRequest,
  DownloaderHeaders,
  DownloaderResponse,
  ModuleDownloaderCacheAdapter,
} from '../types.ts'

export class MemoryHeaders implements DownloaderHeaders {
  readonly #values = new Map<string, string>()

  constructor(values: Readonly<Record<string, string>> = {}) {
    for (const [key, value] of Object.entries(values)) this.#values.set(key.toLowerCase(), value)
  }

  get(name: string): string | null {
    return this.#values.get(name.toLowerCase()) ?? null
  }
}

export function memoryResponse(options: {
  status?: number
  url: string
  headers?: Readonly<Record<string, string>>
  chunks?: readonly Uint8Array[]
}): DownloaderResponse {
  const chunks = options.chunks ?? []
  return {
    status: options.status ?? 200,
    url: options.url,
    headers: new MemoryHeaders(options.headers),
    body: (async function* () {
      for (const chunk of chunks) yield Uint8Array.from(chunk)
    })(),
  }
}

export class QueueFetchAdapter implements DownloaderFetchAdapter {
  readonly requests: DownloaderFetchRequest[] = []
  readonly #responses: Array<DownloaderResponse | Error | ((request: DownloaderFetchRequest) => Promise<DownloaderResponse>)>

  constructor(responses: Array<DownloaderResponse | Error | ((request: DownloaderFetchRequest) => Promise<DownloaderResponse>)>) {
    this.#responses = [...responses]
  }

  async fetch(request: DownloaderFetchRequest): Promise<DownloaderResponse> {
    this.requests.push({ ...request, headers: { ...request.headers } })
    const next = this.#responses.shift()
    if (!next) throw new Error('No queued response')
    if (next instanceof Error) throw next
    return typeof next === 'function' ? next(request) : next
  }
}

export class ManualClock implements DownloaderClock {
  value: number
  readonly sleeps: number[] = []
  readonly timeouts: Array<{ callback: () => void; due: number; active: boolean }> = []

  constructor(now: number) {
    this.value = now
  }

  now(): number {
    return this.value
  }

  async sleep(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw signal.reason
    this.sleeps.push(ms)
    this.value += ms
  }

  setTimeout(callback: () => void, ms: number): () => void {
    const timer = { callback, due: this.value + ms, active: true }
    this.timeouts.push(timer)
    return () => { timer.active = false }
  }

  advance(ms: number): void {
    this.value += ms
    for (const timer of this.timeouts) {
      if (timer.active && timer.due <= this.value) {
        timer.active = false
        timer.callback()
      }
    }
  }
}

interface PartialData {
  record: ArtifactPartialRecord
  chunks: Uint8Array[]
}

export type MemoryCacheFault =
  | 'readCatalog'
  | 'stageCatalog'
  | 'publishCatalog'
  | 'appendPartial'
  | 'publishPartial'

export class MemoryModuleDownloaderCache implements ModuleDownloaderCacheAdapter {
  catalog?: CachedCatalogRecord
  stagedCatalog?: CachedCatalogRecord
  readonly artifacts = new Map<string, CachedArtifactRecord>()
  readonly partials = new Map<string, PartialData>()
  readonly faults = new Map<MemoryCacheFault, number>()

  failNext(point: MemoryCacheFault, count = 1): void {
    this.faults.set(point, count)
  }

  async readCatalog(): Promise<CachedCatalogRecord | undefined> {
    this.#fault('readCatalog')
    return cloneCatalog(this.catalog)
  }

  async readStagedCatalog(): Promise<CachedCatalogRecord | undefined> {
    return cloneCatalog(this.stagedCatalog)
  }

  async stageCatalog(record: CachedCatalogRecord): Promise<void> {
    this.#fault('stageCatalog')
    this.stagedCatalog = cloneCatalog(record)
  }

  async publishCatalog(): Promise<void> {
    this.#fault('publishCatalog')
    if (!this.stagedCatalog) throw new Error('No staged catalog')
    this.catalog = cloneCatalog(this.stagedCatalog)
    this.stagedCatalog = undefined
  }

  async discardStagedCatalog(): Promise<void> {
    this.stagedCatalog = undefined
  }

  async readArtifact(sha256: string): Promise<CachedArtifactRecord | undefined> {
    const value = this.artifacts.get(sha256)
    return value ? { ...value } : undefined
  }

  async listPartials(sha256?: string): Promise<readonly ArtifactPartialRecord[]> {
    return [...this.partials.values()]
      .map(({ record }) => ({ ...record }))
      .filter((record) => sha256 === undefined || record.sha256 === sha256)
  }

  async createPartial(record: Omit<ArtifactPartialRecord, 'id' | 'bytesWritten'>): Promise<ArtifactPartialRecord> {
    const value = { ...record, id: randomUUID(), bytesWritten: 0 }
    this.partials.set(value.id, { record: value, chunks: [] })
    return { ...value }
  }

  async readPartial(id: string): Promise<AsyncIterable<Uint8Array>> {
    const value = this.#partial(id)
    const chunks = value.chunks.map((chunk) => Uint8Array.from(chunk))
    return (async function* () {
      for (const chunk of chunks) yield chunk
    })()
  }

  async appendPartial(id: string, bytes: Uint8Array, updatedAt: number, validator?: string): Promise<ArtifactPartialRecord> {
    this.#fault('appendPartial')
    const value = this.#partial(id)
    if (bytes.byteLength > 0) value.chunks.push(Uint8Array.from(bytes))
    value.record = {
      ...value.record,
      bytesWritten: value.record.bytesWritten + bytes.byteLength,
      updatedAt,
      ...(validator ? { validator } : {}),
    }
    return { ...value.record }
  }

  async removePartial(id: string): Promise<void> {
    this.partials.delete(id)
  }

  async publishPartial(id: string, artifact: CachedArtifactRecord): Promise<void> {
    this.#fault('publishPartial')
    const partial = this.#partial(id)
    if (partial.record.bytesWritten !== artifact.size) throw new Error('Partial size mismatch')
    this.artifacts.set(artifact.sha256, { ...artifact })
    this.partials.delete(id)
  }

  #partial(id: string): PartialData {
    const value = this.partials.get(id)
    if (!value) throw new Error(`Unknown partial: ${id}`)
    return value
  }

  #fault(point: MemoryCacheFault): void {
    const remaining = this.faults.get(point) ?? 0
    if (remaining <= 0) return
    if (remaining === 1) this.faults.delete(point)
    else this.faults.set(point, remaining - 1)
    throw new Error(`Injected cache fault: ${point}`)
  }
}

function cloneCatalog(value: CachedCatalogRecord | undefined): CachedCatalogRecord | undefined {
  return value ? { ...value, responseBytes: Uint8Array.from(value.responseBytes), trustState: { ...value.trustState } } : undefined
}
