import { createReadStream } from 'node:fs'
import { appendFile, copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ModuleReleaseTrustState } from '@simulator/module-release-trust'
import type {
  ArtifactPartialRecord,
  ArtifactPublishResult,
  CachedArtifactRecord,
  CachedCatalogRecord,
  ModuleDownloaderCacheAdapter,
  ModuleDownloaderCacheLease,
} from '../types.ts'

interface LeaseWaiter {
  readonly signal: AbortSignal
  readonly resolve: (lease: ModuleDownloaderCacheLease) => void
  readonly reject: (cause: unknown) => void
  onAbort: () => void
}

interface LeaseState {
  held: boolean
  readonly waiters: LeaseWaiter[]
}

const leases = new Map<string, LeaseState>()

export class FilesystemModuleDownloaderCache implements ModuleDownloaderCacheAdapter {
  readonly root: string

  constructor(root: string) {
    this.root = resolve(root)
  }

  async acquireLease(key: string, signal: AbortSignal): Promise<ModuleDownloaderCacheLease> {
    if (signal.aborted) throw signal.reason
    const identity = `${this.root}\0${key}`
    const state = leases.get(identity) ?? { held: false, waiters: [] }
    leases.set(identity, state)
    if (!state.held) {
      state.held = true
      return this.#lease(identity, state)
    }
    return new Promise((resolveLease, reject) => {
      const waiter: LeaseWaiter = { signal, resolve: resolveLease, reject, onAbort: () => undefined }
      waiter.onAbort = () => {
        const index = state.waiters.indexOf(waiter)
        if (index >= 0) state.waiters.splice(index, 1)
        reject(signal.reason)
      }
      state.waiters.push(waiter)
      signal.addEventListener('abort', waiter.onAbort, { once: true })
    })
  }

  async readCatalog(): Promise<CachedCatalogRecord | undefined> {
    return this.#readJson<CachedCatalogRecordWire>(join(this.root, 'catalog', 'committed.json')).then(fromCatalogWire)
  }

  async readStagedCatalog(): Promise<CachedCatalogRecord | undefined> {
    return this.#readJson<CachedCatalogRecordWire>(join(this.root, 'catalog', 'staged.json')).then(fromCatalogWire)
  }

  async stageCatalog(record: CachedCatalogRecord): Promise<void> {
    await this.#atomicJson(join(this.root, 'catalog', 'staged.json'), toCatalogWire(record))
  }

  async publishCatalog(expectedState: ModuleReleaseTrustState | undefined): Promise<boolean> {
    const staged = await this.readStagedCatalog()
    if (!staged) throw new Error('No staged catalog')
    const committed = await this.readCatalog()
    if (!sameTrustState(committed?.trustState, expectedState)) return false
    await this.#atomicJson(join(this.root, 'catalog', 'committed.json'), toCatalogWire(staged))
    await this.discardStagedCatalog()
    return true
  }

  async discardStagedCatalog(): Promise<void> {
    await rm(join(this.root, 'catalog', 'staged.json'), { force: true })
  }

  async readArtifact(sha256: string): Promise<CachedArtifactRecord | undefined> {
    return this.#readJson<CachedArtifactRecord>(join(this.root, 'artifacts', sha256, 'record.json'))
  }

  async listPartials(sha256?: string): Promise<readonly ArtifactPartialRecord[]> {
    const directory = join(this.root, 'partials')
    let entries: string[]
    try {
      entries = await readdir(directory)
    } catch (cause) {
      if (isNotFound(cause)) return []
      throw cause
    }
    const records = await Promise.all(entries.filter((name) => name.endsWith('.json')).map((name) => (
      this.#readJson<ArtifactPartialRecord>(join(directory, name))
    )))
    return records.filter((record): record is ArtifactPartialRecord => Boolean(record && (sha256 === undefined || record.sha256 === sha256)))
  }

  async createPartial(record: Omit<ArtifactPartialRecord, 'id' | 'bytesWritten'>): Promise<ArtifactPartialRecord> {
    const id = randomUUID()
    const value = { ...record, id, bytesWritten: 0 }
    await mkdir(join(this.root, 'partials'), { recursive: true })
    await writeFile(this.#partialData(id), new Uint8Array(), { flag: 'wx' })
    await this.#atomicJson(this.#partialMetadata(id), value)
    return value
  }

  async readPartial(id: string): Promise<AsyncIterable<Uint8Array>> {
    const stream = createReadStream(this.#partialData(id))
    return (async function* () {
      for await (const chunk of stream) yield Uint8Array.from(chunk as Buffer)
    })()
  }

  async appendPartial(id: string, bytes: Uint8Array, updatedAt: number, validator?: string): Promise<ArtifactPartialRecord> {
    const record = await this.#requiredPartial(id)
    if (bytes.byteLength > 0) await appendFile(this.#partialData(id), bytes)
    const next = {
      ...record,
      bytesWritten: record.bytesWritten + bytes.byteLength,
      updatedAt,
      ...(validator ? { validator } : {}),
    }
    await this.#atomicJson(this.#partialMetadata(id), next)
    return next
  }

  async removePartial(id: string): Promise<void> {
    await Promise.all([
      rm(this.#partialMetadata(id), { force: true }),
      rm(this.#partialData(id), { force: true }),
    ])
  }

  async publishPartial(id: string, artifact: CachedArtifactRecord): Promise<ArtifactPublishResult> {
    const partial = await this.#requiredPartial(id)
    if (partial.bytesWritten !== artifact.size || partial.sha256 !== artifact.sha256) throw new Error('Partial metadata mismatch')
    const existing = await this.readArtifact(artifact.sha256)
    if (existing) {
      await this.removePartial(id)
      return 'already-present'
    }
    const artifacts = join(this.root, 'artifacts')
    const staging = join(artifacts, `.${artifact.sha256}.${randomUUID()}.tmp`)
    const destination = join(artifacts, artifact.sha256)
    await mkdir(staging, { recursive: true })
    await copyFile(this.#partialData(id), join(staging, 'artifact.bin'))
    await writeFile(join(staging, 'record.json'), JSON.stringify(artifact))
    await rename(staging, destination)
    await this.removePartial(id)
    return 'published'
  }

  #lease(identity: string, state: LeaseState): ModuleDownloaderCacheLease {
    let released = false
    return {
      release: () => {
        if (released) throw new Error('Lease released more than once')
        released = true
        while (state.waiters.length > 0) {
          const next = state.waiters.shift()!
          next.signal.removeEventListener('abort', next.onAbort)
          if (next.signal.aborted) continue
          next.resolve(this.#lease(identity, state))
          return
        }
        state.held = false
        leases.delete(identity)
      },
    }
  }

  async #requiredPartial(id: string): Promise<ArtifactPartialRecord> {
    const value = await this.#readJson<ArtifactPartialRecord>(this.#partialMetadata(id))
    if (!value) throw new Error(`Unknown partial: ${id}`)
    return value
  }

  #partialMetadata(id: string): string {
    return join(this.root, 'partials', `${id}.json`)
  }

  #partialData(id: string): string {
    return join(this.root, 'partials', `${id}.bin`)
  }

  async #atomicJson(path: string, value: unknown): Promise<void> {
    await mkdir(join(path, '..'), { recursive: true })
    const temporary = `${path}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify(value))
    await rename(temporary, path)
  }

  async #readJson<T>(path: string): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(path, 'utf8')) as T
    } catch (cause) {
      if (isNotFound(cause)) return undefined
      throw cause
    }
  }
}

interface CachedCatalogRecordWire extends Omit<CachedCatalogRecord, 'responseBytes'> {
  readonly responseBytesBase64: string
}

function toCatalogWire(record: CachedCatalogRecord): CachedCatalogRecordWire {
  const { responseBytes: bytes, ...metadata } = record
  return { ...metadata, responseBytesBase64: Buffer.from(bytes).toString('base64') }
}

function fromCatalogWire(record: CachedCatalogRecordWire | undefined): CachedCatalogRecord | undefined {
  if (!record) return undefined
  const { responseBytesBase64, ...metadata } = record
  return { ...metadata, responseBytes: Uint8Array.from(Buffer.from(responseBytesBase64, 'base64')) }
}

function sameTrustState(left: ModuleReleaseTrustState | undefined, right: ModuleReleaseTrustState | undefined): boolean {
  return left?.highestSequence === right?.highestSequence && left?.latestIssuedAt === right?.latestIssuedAt
}

function isNotFound(cause: unknown): boolean {
  return cause instanceof Error && 'code' in cause && cause.code === 'ENOENT'
}
