import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  appendFile, chmod, copyFile, mkdir, open, readFile, readdir, rename, rm, stat, writeFile,
} from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { ModuleReleaseTrustState } from '@simulator/module-release-trust'
import type {
  ArtifactPartialRecord, ArtifactPublishResult, CachedArtifactRecord, CachedCatalogRecord,
  ModuleDownloaderCacheAdapter, ModuleDownloaderCacheLease,
} from './types.ts'

const OWNER_MODE = 0o700
const FILE_MODE = 0o600
const HASH = /^[a-f0-9]{64}$/
const PARTIAL_ID = /^[a-f0-9-]{36}$/

export interface NodeFilesystemCacheOptions {
  readonly staleLeaseMs?: number
  readonly leasePollMs?: number
  readonly maxStaleRecoveries?: number
  readonly now?: () => number
  readonly maxStartupPrunes?: number
}

export class NodeFilesystemModuleDownloaderCache implements ModuleDownloaderCacheAdapter {
  readonly root: string
  readonly #staleLeaseMs: number
  readonly #leasePollMs: number
  readonly #maxStaleRecoveries: number
  readonly #now: () => number
  readonly #ready: Promise<void>

  constructor(root: string, options: NodeFilesystemCacheOptions = {}) {
    if (!root || !isAbsolute(root)) throw new TypeError('Cache root must be an absolute path')
    this.root = resolve(root)
    this.#staleLeaseMs = positive(options.staleLeaseMs, 120_000, 'staleLeaseMs')
    this.#leasePollMs = positive(options.leasePollMs, 25, 'leasePollMs')
    this.#maxStaleRecoveries = positive(options.maxStaleRecoveries, 3, 'maxStaleRecoveries')
    this.#now = options.now ?? Date.now
    this.#ready = this.#recoverStartup(positive(options.maxStartupPrunes, 64, 'maxStartupPrunes'))
  }

  async acquireLease(key: string, signal: AbortSignal): Promise<ModuleDownloaderCacheLease> {
    await this.#ready
    if (!key || key.length > 1024 || /[\0\r\n]/.test(key)) throw new TypeError('Invalid cache lease key')
    const name = createHash('sha256').update(key).digest('hex')
    const lock = join(this.root, 'leases', `${name}.lock`)
    let recoveries = 0
    await secureDirectory(dirname(lock))
    while (true) {
      if (signal.aborted) throw signal.reason
      const token = randomUUID()
      try {
        await mkdir(lock, { mode: OWNER_MODE })
        await durableWrite(join(lock, 'owner.json'), JSON.stringify({ token, pid: process.pid, acquiredAt: this.#now() }))
        return leaseFor(lock, token)
      } catch (cause) {
        if (!hasCode(cause, 'EEXIST')) throw cause
      }
      if (recoveries < this.#maxStaleRecoveries && await this.#recoverStale(lock)) {
        recoveries += 1
        continue
      }
      await sleep(this.#leasePollMs, signal)
    }
  }

  async readCatalog(): Promise<CachedCatalogRecord | undefined> {
    await this.#ready
    return fromCatalogWire(await readJson<CatalogWire>(join(this.root, 'catalog', 'committed.json')))
  }

  async readStagedCatalog(): Promise<CachedCatalogRecord | undefined> {
    await this.#ready
    return fromCatalogWire(await readJson<CatalogWire>(join(this.root, 'catalog', 'staged.json')))
  }

  async stageCatalog(record: CachedCatalogRecord): Promise<void> {
    await this.#ready
    await atomicJson(join(this.root, 'catalog', 'staged.json'), toCatalogWire(record))
  }

  async publishCatalog(expectedState: ModuleReleaseTrustState | undefined): Promise<boolean> {
    const staged = await this.readStagedCatalog()
    if (!staged) throw new Error('No staged catalog transaction')
    if (!sameTrustState((await this.readCatalog())?.trustState, expectedState)) return false
    await atomicJson(join(this.root, 'catalog', 'committed.json'), toCatalogWire(staged))
    await this.discardStagedCatalog()
    return true
  }

  async discardStagedCatalog(): Promise<void> {
    await this.#ready
    await durableRemove(join(this.root, 'catalog', 'staged.json'))
  }

  async readArtifact(sha256: string): Promise<CachedArtifactRecord | undefined> {
    await this.#ready
    validateHash(sha256)
    const directory = join(this.root, 'artifacts', sha256)
    const record = await readJson<CachedArtifactRecord>(join(directory, 'record.json'))
    if (!record) return undefined
    if (record.sha256 !== sha256 || !Number.isSafeInteger(record.size) || record.size < 0) throw new Error('Invalid artifact record')
    const data = join(directory, 'artifact.bin')
    const info = await stat(data)
    if (!info.isFile() || info.size !== record.size || await hashFile(data) !== sha256) throw new Error('Artifact CAS verification failed')
    return record
  }

  async listPartials(sha256?: string): Promise<readonly ArtifactPartialRecord[]> {
    await this.#ready
    if (sha256 !== undefined) validateHash(sha256)
    const directory = join(this.root, 'partials')
    let names: string[]
    try { names = await readdir(directory) } catch (cause) { if (hasCode(cause, 'ENOENT')) return []; throw cause }
    const records = await Promise.all(names.filter((name) => PARTIAL_ID.test(name.slice(0, -5)) && name.endsWith('.json'))
      .map((name) => readJson<ArtifactPartialRecord>(join(directory, name)).catch(() => undefined)))
    return records.filter((value): value is ArtifactPartialRecord => Boolean(value && validPartial(value) && (!sha256 || value.sha256 === sha256)))
  }

  async createPartial(record: Omit<ArtifactPartialRecord, 'id' | 'bytesWritten'>): Promise<ArtifactPartialRecord> {
    await this.#ready
    validateHash(record.sha256)
    const id = randomUUID()
    const value = { ...record, id, bytesWritten: 0 }
    await secureDirectory(join(this.root, 'partials'))
    await writeFile(this.partialData(id), new Uint8Array(), { flag: 'wx', mode: FILE_MODE })
    await fsyncFile(this.partialData(id))
    await atomicJson(this.partialMetadata(id), value)
    return value
  }

  async readPartial(id: string): Promise<AsyncIterable<Uint8Array>> {
    validatePartialId(id)
    const stream = createReadStream(this.partialData(id))
    return (async function* () { for await (const chunk of stream) yield Uint8Array.from(chunk as Buffer) })()
  }

  async appendPartial(id: string, bytes: Uint8Array, updatedAt: number, validator?: string): Promise<ArtifactPartialRecord> {
    const record = await this.requiredPartial(id)
    if (bytes.byteLength) {
      await appendFile(this.partialData(id), bytes, { mode: FILE_MODE })
      await fsyncFile(this.partialData(id))
    }
    const next = { ...record, bytesWritten: record.bytesWritten + bytes.byteLength, updatedAt, ...(validator ? { validator } : {}) }
    await atomicJson(this.partialMetadata(id), next)
    return next
  }

  async removePartial(id: string): Promise<void> {
    validatePartialId(id)
    await Promise.all([durableRemove(this.partialMetadata(id)), durableRemove(this.partialData(id))])
  }

  async publishPartial(id: string, artifact: CachedArtifactRecord): Promise<ArtifactPublishResult> {
    validateHash(artifact.sha256)
    const partial = await this.requiredPartial(id)
    if (partial.sha256 !== artifact.sha256 || partial.bytesWritten !== artifact.size) throw new Error('Partial metadata mismatch')
    if (await hashFile(this.partialData(id)) !== artifact.sha256) throw new Error('Partial hash mismatch')
    const artifacts = join(this.root, 'artifacts')
    await secureDirectory(artifacts)
    const staging = join(artifacts, `.${artifact.sha256}.${randomUUID()}.tmp`)
    await mkdir(staging, { mode: OWNER_MODE })
    try {
      await copyFile(this.partialData(id), join(staging, 'artifact.bin'))
      await chmod(join(staging, 'artifact.bin'), FILE_MODE)
      await fsyncFile(join(staging, 'artifact.bin'))
      await durableWrite(join(staging, 'record.json'), JSON.stringify(artifact))
      await fsyncDirectory(staging)
      try { await rename(staging, join(artifacts, artifact.sha256)) }
      catch (cause) {
        if (!hasCode(cause, 'EEXIST') && !hasCode(cause, 'ENOTEMPTY')) throw cause
        await rm(staging, { recursive: true, force: true })
        const winner = await this.readArtifact(artifact.sha256)
        if (!winner || winner.size !== artifact.size) throw new Error('Artifact CAS winner differs')
        await this.removePartial(id)
        return 'already-present'
      }
      await fsyncDirectory(artifacts)
      await this.removePartial(id)
      return 'published'
    } catch (cause) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined)
      throw cause
    }
  }

  async #recoverStale(lock: string): Promise<boolean> {
    let owner: { token?: string; pid?: number; acquiredAt?: number }
    try { owner = JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8')) as typeof owner }
    catch { return false }
    if (typeof owner.token !== 'string' || typeof owner.acquiredAt !== 'number') return false
    if (this.#now() - owner.acquiredAt <= this.#staleLeaseMs || isLivePid(owner.pid)) return false
    const quarantine = `${lock}.stale.${owner.token}.${randomUUID()}`
    try { await rename(lock, quarantine) } catch (cause) { if (hasCode(cause, 'ENOENT')) return false; throw cause }
    await rm(quarantine, { recursive: true, force: true })
    await fsyncDirectory(dirname(lock))
    return true
  }

  async #recoverStartup(limit: number): Promise<void> {
    let remaining = limit
    const cutoff = this.#now() - this.#staleLeaseMs
    const artifacts = join(this.root, 'artifacts')
    for (const name of await directoryNames(artifacts)) {
      if (remaining === 0) return
      if (!name.startsWith('.') || !name.endsWith('.tmp')) continue
      const path = join(artifacts, name)
      if ((await stat(path)).mtimeMs <= cutoff) { await rm(path, { recursive: true, force: true }); remaining -= 1 }
    }
    const partials = join(this.root, 'partials')
    const names = await directoryNames(partials)
    const ids = new Set(names.map((name) => name.match(/^([a-f0-9-]{36})\.(?:json|bin)$/)?.[1]).filter((id): id is string => Boolean(id)))
    for (const id of ids) {
      if (remaining === 0) return
      const metadata = join(partials, `${id}.json`)
      const data = join(partials, `${id}.bin`)
      const [hasMetadata, hasData] = await Promise.all([exists(metadata), exists(data)])
      if (hasMetadata === hasData) continue
      const survivor = hasMetadata ? metadata : data
      if ((await stat(survivor)).mtimeMs <= cutoff) { await durableRemove(survivor); remaining -= 1 }
    }
  }

  async requiredPartial(id: string): Promise<ArtifactPartialRecord> {
    validatePartialId(id)
    const value = await readJson<ArtifactPartialRecord>(this.partialMetadata(id))
    if (!value || !validPartial(value)) throw new Error(`Unknown partial: ${id}`)
    return value
  }

  partialMetadata(id: string): string { validatePartialId(id); return join(this.root, 'partials', `${id}.json`) }
  partialData(id: string): string { validatePartialId(id); return join(this.root, 'partials', `${id}.bin`) }
}

function leaseFor(lock: string, token: string): ModuleDownloaderCacheLease {
  let released = false
  return { async release() {
    if (released) return
    released = true
    const owner = await readJson<{ token?: string }>(join(lock, 'owner.json'))
    if (owner?.token !== token) return
    const quarantine = `${lock}.released.${token}`
    try { await rename(lock, quarantine) } catch (cause) { if (hasCode(cause, 'ENOENT')) return; throw cause }
    await rm(quarantine, { recursive: true, force: true })
    await fsyncDirectory(dirname(lock))
  } }
}

interface CatalogWire extends Omit<CachedCatalogRecord, 'responseBytes'> { readonly responseBytesBase64: string }
function toCatalogWire(record: CachedCatalogRecord): CatalogWire { const { responseBytes, ...rest } = record; return { ...rest, responseBytesBase64: Buffer.from(responseBytes).toString('base64') } }
function fromCatalogWire(value: CatalogWire | undefined): CachedCatalogRecord | undefined { if (!value) return undefined; const { responseBytesBase64, ...rest } = value; return { ...rest, responseBytes: Uint8Array.from(Buffer.from(responseBytesBase64, 'base64')) } }
function sameTrustState(a: ModuleReleaseTrustState | undefined, b: ModuleReleaseTrustState | undefined): boolean { return a?.highestSequence === b?.highestSequence && a?.latestIssuedAt === b?.latestIssuedAt }
function validateHash(value: string): void { if (!HASH.test(value)) throw new TypeError('Invalid SHA-256') }
function validatePartialId(value: string): void { if (!PARTIAL_ID.test(value)) throw new TypeError('Invalid partial id') }
function validPartial(value: ArtifactPartialRecord): boolean { return PARTIAL_ID.test(value.id) && HASH.test(value.sha256) && Number.isSafeInteger(value.bytesWritten) && value.bytesWritten >= 0 }
function positive(value: number | undefined, fallback: number, name: string): number { const result = value ?? fallback; if (!Number.isSafeInteger(result) || result <= 0) throw new TypeError(`${name} must be positive`); return result }
function hasCode(cause: unknown, code: string): boolean { return cause instanceof Error && 'code' in cause && cause.code === code }
function isLivePid(pid: number | undefined): boolean { if (!Number.isSafeInteger(pid) || pid! <= 0) return false; try { process.kill(pid!, 0); return true } catch (cause) { return hasCode(cause, 'EPERM') } }
async function secureDirectory(path: string): Promise<void> { await mkdir(path, { recursive: true, mode: OWNER_MODE }); await chmod(path, OWNER_MODE) }
async function durableWrite(path: string, contents: string): Promise<void> { await writeFile(path, contents, { mode: FILE_MODE }); await chmod(path, FILE_MODE); await fsyncFile(path) }
async function atomicJson(path: string, value: unknown): Promise<void> { await secureDirectory(dirname(path)); const temp = `${path}.${randomUUID()}.tmp`; try { await durableWrite(temp, JSON.stringify(value)); await rename(temp, path); await fsyncDirectory(dirname(path)) } finally { await rm(temp, { force: true }).catch(() => undefined) } }
async function durableRemove(path: string): Promise<void> { try { await rm(path); await fsyncDirectory(dirname(path)) } catch (cause) { if (!hasCode(cause, 'ENOENT')) throw cause } }
async function readJson<T>(path: string): Promise<T | undefined> { try { return JSON.parse(await readFile(path, 'utf8')) as T } catch (cause) { if (hasCode(cause, 'ENOENT')) return undefined; throw cause } }
async function fsyncFile(path: string): Promise<void> { const handle = await open(path, 'r'); try { await handle.sync() } finally { await handle.close() } }
async function fsyncDirectory(path: string): Promise<void> { if (process.platform === 'win32') return; const handle = await open(path, 'r'); try { await handle.sync() } finally { await handle.close() } }
async function hashFile(path: string): Promise<string> { const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer); return hash.digest('hex') }
async function directoryNames(path: string): Promise<string[]> { try { return await readdir(path) } catch (cause) { if (hasCode(cause, 'ENOENT')) return []; throw cause } }
async function exists(path: string): Promise<boolean> { try { await stat(path); return true } catch (cause) { if (hasCode(cause, 'ENOENT')) return false; throw cause } }
function sleep(ms: number, signal: AbortSignal): Promise<void> { return new Promise((resolveSleep, reject) => { const timer = setTimeout(done, ms); const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason) }; function done() { signal.removeEventListener('abort', abort); resolveSleep() } signal.addEventListener('abort', abort, { once: true }) }) }
