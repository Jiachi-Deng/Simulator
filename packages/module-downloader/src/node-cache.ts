import { createHash, randomUUID } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import {
  appendFile, chmod, copyFile, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile,
} from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { ModuleReleaseTrustState } from '@simulator/module-release-trust'
import type {
  ArtifactPartialRecord, ArtifactPublishResult, CachedArtifactRecord, CachedCatalogRecord,
  ModuleDownloaderCacheAdapter, ModuleDownloaderCacheLease,
} from './types.ts'

const OWNER_MODE = 0o700
const FILE_MODE = 0o600
const HASH = /^[a-f0-9]{64}$/
const PARTIAL_ID = /^[a-f0-9-]{36}$/
const TOP_LEVEL = ['catalog', 'artifacts', 'partials', 'leases'] as const

export type NodeCacheFaultPoint = 'temp-write' | 'file-sync' | 'rename' | 'directory-sync' | 'cleanup'
export interface NodeFilesystemCacheOptions {
  readonly staleLeaseMs?: number
  readonly leasePollMs?: number
  readonly maxStaleRecoveries?: number
  readonly maxStartupPrunes?: number
  readonly now?: () => number
  readonly faultInjector?: (point: NodeCacheFaultPoint, path: string) => void | Promise<void>
}

interface LeaseOwner { readonly token: string; readonly pid: number; readonly acquiredAt: number }
interface CatalogWire extends Omit<CachedCatalogRecord, 'responseBytes'> { readonly responseBytesBase64: string }

export class NodeFilesystemModuleDownloaderCache implements ModuleDownloaderCacheAdapter {
  readonly root: string
  readonly durability: 'file-and-directory-fsync' | 'file-fsync-and-recovery-marker'
  readonly #instance = randomUUID()
  readonly #ownStagePath: string
  #activeStagePath: string
  readonly #staleLeaseMs: number
  readonly #leasePollMs: number
  readonly #maxStaleRecoveries: number
  readonly #now: () => number
  readonly #fault?: NodeFilesystemCacheOptions['faultInjector']
  readonly #ready: Promise<void>

  constructor(root: string, options: NodeFilesystemCacheOptions = {}) {
    if (!root || !isAbsolute(root)) throw new TypeError('Cache root must be an absolute path')
    this.root = resolve(root)
    this.#ownStagePath = join(this.root, 'catalog', `staged.${this.#instance}.json`)
    this.#activeStagePath = this.#ownStagePath
    this.durability = process.platform === 'win32' ? 'file-fsync-and-recovery-marker' : 'file-and-directory-fsync'
    this.#staleLeaseMs = positive(options.staleLeaseMs, 120_000, 'staleLeaseMs')
    this.#leasePollMs = positive(options.leasePollMs, 25, 'leasePollMs')
    this.#maxStaleRecoveries = positive(options.maxStaleRecoveries, 3, 'maxStaleRecoveries')
    this.#now = options.now ?? Date.now
    this.#fault = options.faultInjector
    this.#ready = this.#initialize(positive(options.maxStartupPrunes, 64, 'maxStartupPrunes'))
  }

  async acquireLease(key: string, signal: AbortSignal): Promise<ModuleDownloaderCacheLease> {
    await this.#ready
    if (!key || key.length > 1024 || /[\0\r\n]/.test(key)) throw new TypeError('Invalid cache lease key')
    const base = join(this.root, 'leases', createHash('sha256').update(key).digest('hex'))
    let recoveries = 0
    while (true) {
      if (signal.aborted) throw signal.reason
      if ((await directoryNames(dirname(base))).some((name) => name.startsWith(`${basename(base)}.recover-`))) {
        await sleep(this.#leasePollMs, signal); continue
      }
      const owner: LeaseOwner = { token: randomUUID(), pid: process.pid, acquiredAt: this.#now() }
      const staging = `${base}.candidate-${owner.token}`
      await mkdir(staging, { mode: OWNER_MODE })
      try {
        await this.#durableWrite(join(staging, 'owner.json'), JSON.stringify(owner))
        await this.#syncDirectory(staging)
        try { await this.#rename(staging, `${base}.lock`) }
        catch (cause) {
          if (!hasCode(cause, 'EEXIST') && !hasCode(cause, 'ENOTEMPTY')) throw cause
          await rm(staging, { recursive: true, force: true })
          if (recoveries < this.#maxStaleRecoveries && await this.#recoverStale(base)) { recoveries += 1; continue }
          await sleep(this.#leasePollMs, signal); continue
        }
        if ((await directoryNames(dirname(base))).some((name) => name.startsWith(`${basename(base)}.recover-`))) {
          await releaseLease(base, owner.token, this.#syncDirectory.bind(this)); continue
        }
        await this.#syncDirectory(dirname(base))
        return { release: once(() => releaseLease(base, owner.token, this.#syncDirectory.bind(this))) }
      } finally {
        await rm(staging, { recursive: true, force: true }).catch(() => undefined)
      }
    }
  }

  async readCatalog(): Promise<CachedCatalogRecord | undefined> {
    await this.#ready; await this.#assertSafeTopLevel('catalog')
    return fromCatalogWire(await readJson<CatalogWire>(join(this.root, 'catalog', 'committed.json')))
  }
  async readStagedCatalog(): Promise<CachedCatalogRecord | undefined> {
    await this.#ready; await this.#assertSafeTopLevel('catalog')
    const own = await readJson<CatalogWire>(this.#ownStagePath)
    if (own) { this.#activeStagePath = this.#ownStagePath; return fromCatalogWire(own) }
    const names = (await directoryNames(join(this.root, 'catalog'))).filter((name) => /^staged\.[a-f0-9-]{36}\.json$/.test(name)).sort()
    if (!names.length) return undefined
    this.#activeStagePath = join(this.root, 'catalog', names[0]!)
    return fromCatalogWire(await readJson<CatalogWire>(this.#activeStagePath))
  }
  async stageCatalog(record: CachedCatalogRecord): Promise<void> {
    await this.#ready; this.#activeStagePath = this.#ownStagePath; await this.#atomicJson(this.#activeStagePath, toCatalogWire(record))
  }
  async publishCatalog(expectedState: ModuleReleaseTrustState | undefined): Promise<boolean> {
    await this.#ready
    const lease = await this.acquireLease('__catalog-cas__', new AbortController().signal)
    try {
      const staged = fromCatalogWire(await readJson<CatalogWire>(this.#activeStagePath))
      if (!staged) throw new Error('No staged catalog transaction for this adapter')
      const committed = fromCatalogWire(await readJson<CatalogWire>(join(this.root, 'catalog', 'committed.json')))
      if (!sameTrustState(committed?.trustState, expectedState)) return false
      await this.#atomicJson(join(this.root, 'catalog', 'committed.json'), toCatalogWire(staged))
      await this.discardStagedCatalog()
      return true
    } finally { await lease.release() }
  }
  async discardStagedCatalog(): Promise<void> { await this.#ready; await this.#durableRemove(this.#activeStagePath); this.#activeStagePath = this.#ownStagePath }

  async readArtifact(sha256: string): Promise<CachedArtifactRecord | undefined> {
    await this.#ready; validateHash(sha256); await this.#assertSafeTopLevel('artifacts')
    const directory = join(this.root, 'artifacts', sha256)
    if (!await exists(join(directory, 'committed'))) return undefined
    const record = await readJson<CachedArtifactRecord>(join(directory, 'record.json'))
    if (!record || record.sha256 !== sha256 || !Number.isSafeInteger(record.size) || record.size < 0) throw new Error('Invalid artifact record')
    const data = join(directory, 'artifact.bin'); const info = await lstat(data)
    if (!info.isFile() || info.isSymbolicLink() || info.size !== record.size || await hashFile(data) !== sha256) throw new Error('Artifact CAS verification failed')
    return record
  }
  async listPartials(sha256?: string): Promise<readonly ArtifactPartialRecord[]> {
    await this.#ready; if (sha256) validateHash(sha256); await this.#assertSafeTopLevel('partials')
    const directory = join(this.root, 'partials')
    const records = await Promise.all((await directoryNames(directory)).filter((name) => name.endsWith('.json') && PARTIAL_ID.test(name.slice(0, -5)))
      .map((name) => readJson<ArtifactPartialRecord>(join(directory, name)).catch(() => undefined)))
    return records.filter((value): value is ArtifactPartialRecord => Boolean(value && validPartial(value) && (!sha256 || value.sha256 === sha256)))
  }
  async createPartial(record: Omit<ArtifactPartialRecord, 'id' | 'bytesWritten'>): Promise<ArtifactPartialRecord> {
    await this.#ready; validateHash(record.sha256); await this.#assertSafeTopLevel('partials')
    const id = randomUUID(); const value = { ...record, id, bytesWritten: 0 }
    await writeFile(this.#partialData(id), new Uint8Array(), { flag: 'wx', mode: FILE_MODE }); await this.#syncFile(this.#partialData(id))
    await this.#atomicJson(this.#partialMetadata(id), value); return value
  }
  async readPartial(id: string): Promise<AsyncIterable<Uint8Array>> {
    await this.#ready; validatePartialId(id); await this.#assertSafeTopLevel('partials')
    const stream = createReadStream(this.#partialData(id)); return (async function* () { for await (const chunk of stream) yield Uint8Array.from(chunk as Buffer) })()
  }
  async appendPartial(id: string, bytes: Uint8Array, updatedAt: number, validator?: string): Promise<ArtifactPartialRecord> {
    const record = await this.#requiredPartial(id)
    if (bytes.byteLength) { await appendFile(this.#partialData(id), bytes, { mode: FILE_MODE }); await this.#syncFile(this.#partialData(id)) }
    const next = { ...record, bytesWritten: record.bytesWritten + bytes.byteLength, updatedAt, ...(validator ? { validator } : {}) }
    await this.#atomicJson(this.#partialMetadata(id), next); return next
  }
  async removePartial(id: string): Promise<void> { await this.#ready; validatePartialId(id); await this.#assertSafeTopLevel('partials'); await Promise.all([this.#durableRemove(this.#partialMetadata(id)), this.#durableRemove(this.#partialData(id))]) }

  async publishPartial(id: string, artifact: CachedArtifactRecord): Promise<ArtifactPublishResult> {
    await this.#ready; validateHash(artifact.sha256); await this.#assertSafeTopLevel('artifacts')
    const partial = await this.#requiredPartial(id)
    if (partial.sha256 !== artifact.sha256 || partial.bytesWritten !== artifact.size || await hashFile(this.#partialData(id)) !== artifact.sha256) throw new Error('Partial verification failed')
    const destination = join(this.root, 'artifacts', artifact.sha256)
    try { await mkdir(destination, { mode: OWNER_MODE }) }
    catch (cause) {
      if (!hasCode(cause, 'EEXIST')) throw cause
      const winner = await this.readArtifact(artifact.sha256)
      if (!winner || winner.size !== artifact.size) throw new Error('Artifact CAS destination exists without an equivalent committed winner')
      await this.removePartial(id); return 'already-present'
    }
    try {
      await copyFile(this.#partialData(id), join(destination, 'artifact.bin'), constants.COPYFILE_EXCL)
      await chmod(join(destination, 'artifact.bin'), FILE_MODE); await this.#syncFile(join(destination, 'artifact.bin'))
      await this.#durableWrite(join(destination, 'record.json'), JSON.stringify(artifact)); await this.#syncDirectory(destination)
      await this.#durableWrite(join(destination, 'committed'), artifact.sha256); await this.#syncDirectory(destination); await this.#syncDirectory(dirname(destination))
      const published = await this.readArtifact(artifact.sha256)
      if (!published || published.size !== artifact.size) throw new Error('Artifact read-back verification failed')
      await this.removePartial(id); return 'published'
    } catch (cause) {
      if (!await exists(join(destination, 'committed'))) await rm(destination, { recursive: true, force: true }).catch(() => undefined)
      throw cause
    }
  }

  async #initialize(limit: number): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: OWNER_MODE }); await assertDirectoryNotSymlink(this.root); await chmod(this.root, OWNER_MODE)
    for (const name of TOP_LEVEL) { const path = join(this.root, name); await mkdir(path, { mode: OWNER_MODE }).catch((cause) => { if (!hasCode(cause, 'EEXIST')) throw cause }); await assertDirectoryNotSymlink(path); await chmod(path, OWNER_MODE) }
    await this.#recoverStartup(limit)
  }
  async #assertSafeTopLevel(name: typeof TOP_LEVEL[number]): Promise<void> { await assertDirectoryNotSymlink(join(this.root, name)); await assertContained(this.root, join(this.root, name)) }
  async #recoverStale(base: string): Promise<boolean> {
    const lock = `${base}.lock`; let hint: LeaseOwner | undefined
    try { hint = await readJson<LeaseOwner>(join(lock, 'owner.json')) } catch { /* ownerless lock uses directory age */ }
    const lockStat = await lstat(lock).catch(() => undefined)
    if (!lockStat || (hint && (this.#now() - hint.acquiredAt <= this.#staleLeaseMs || isLivePid(hint.pid))) || (!hint && this.#now() - lockStat.mtimeMs <= this.#staleLeaseMs)) return false
    const quarantine = `${base}.recover-${randomUUID()}`
    try { await this.#rename(lock, quarantine) } catch (cause) { if (hasCode(cause, 'ENOENT')) return false; throw cause }
    const moved = await readJson<LeaseOwner>(join(quarantine, 'owner.json')).catch(() => undefined)
    if (moved && (this.#now() - moved.acquiredAt <= this.#staleLeaseMs || isLivePid(moved.pid))) {
      while (await exists(lock)) await sleep(this.#leasePollMs, new AbortController().signal)
      await this.#rename(quarantine, lock); await this.#syncDirectory(dirname(lock)); return false
    }
    await rm(quarantine, { recursive: true, force: true }); await this.#syncDirectory(dirname(lock)); return true
  }
  async #recoverStartup(limit: number): Promise<void> {
    let remaining = limit; const cutoff = this.#now() - this.#staleLeaseMs
    for (const name of await directoryNames(join(this.root, 'artifacts'))) {
      if (!remaining) return; const path = join(this.root, 'artifacts', name); const info = await lstat(path)
      if (info.isSymbolicLink()) throw new Error('Symlink inside artifact cache is not allowed')
      if (info.isDirectory() && !await exists(join(path, 'committed')) && info.mtimeMs <= cutoff) { await rm(path, { recursive: true }); remaining -= 1 }
    }
    for (const name of await directoryNames(join(this.root, 'partials'))) {
      if (!remaining) return; const match = name.match(/^([a-f0-9-]{36})\.(json|bin)$/); if (!match) continue
      const other = join(this.root, 'partials', `${match[1]}.${match[2] === 'json' ? 'bin' : 'json'}`); const path = join(this.root, 'partials', name)
      if (!await exists(other) && (await lstat(path)).mtimeMs <= cutoff) { await this.#durableRemove(path); remaining -= 1 }
    }
  }
  async #requiredPartial(id: string): Promise<ArtifactPartialRecord> { await this.#ready; validatePartialId(id); await this.#assertSafeTopLevel('partials'); const value = await readJson<ArtifactPartialRecord>(this.#partialMetadata(id)); if (!value || !validPartial(value)) throw new Error(`Unknown partial: ${id}`); return value }
  #partialMetadata(id: string): string { validatePartialId(id); return join(this.root, 'partials', `${id}.json`) }
  #partialData(id: string): string { validatePartialId(id); return join(this.root, 'partials', `${id}.bin`) }
  async #faultAt(point: NodeCacheFaultPoint, path: string): Promise<void> { await this.#fault?.(point, path) }
  async #durableWrite(path: string, contents: string): Promise<void> { await this.#faultAt('temp-write', path); await writeFile(path, contents, { flag: 'wx', mode: FILE_MODE }); await chmod(path, FILE_MODE); await this.#syncFile(path) }
  async #atomicJson(path: string, value: unknown): Promise<void> { await this.#assertSafeTopLevel('catalog'); const temp = `${path}.${randomUUID()}.tmp`; try { await this.#durableWrite(temp, JSON.stringify(value)); await this.#rename(temp, path); await this.#syncDirectory(dirname(path)) } finally { await rm(temp, { force: true }).catch(() => undefined); await this.#faultAt('cleanup', path) } }
  async #durableRemove(path: string): Promise<void> { try { await rm(path); await this.#syncDirectory(dirname(path)) } catch (cause) { if (!hasCode(cause, 'ENOENT')) throw cause } }
  async #rename(from: string, to: string): Promise<void> { await this.#faultAt('rename', to); await rename(from, to) }
  async #syncFile(path: string): Promise<void> { await this.#faultAt('file-sync', path); const handle = await open(path, 'r'); try { await handle.sync() } finally { await handle.close() } }
  async #syncDirectory(path: string): Promise<void> { await this.#faultAt('directory-sync', path); if (process.platform === 'win32') return; const handle = await open(path, 'r'); try { await handle.sync() } finally { await handle.close() } }
}

async function releaseLease(base: string, token: string, syncDirectory: (path: string) => Promise<void>): Promise<void> {
  const lock = `${base}.lock`; const owner = await readJson<LeaseOwner>(join(lock, 'owner.json')).catch(() => undefined); if (owner?.token !== token) return
  const released = `${base}.released-${token}`
  try { await rename(lock, released) } catch (cause) { if (hasCode(cause, 'ENOENT')) return; throw cause }
  await rm(released, { recursive: true, force: true }); await syncDirectory(dirname(lock))
}
function once(operation: () => Promise<void>): () => Promise<void> { let promise: Promise<void> | undefined; return () => (promise ??= operation()) }
function toCatalogWire(record: CachedCatalogRecord): CatalogWire { const { responseBytes, ...rest } = record; return { ...rest, responseBytesBase64: Buffer.from(responseBytes).toString('base64') } }
function fromCatalogWire(value: CatalogWire | undefined): CachedCatalogRecord | undefined { if (!value) return undefined; const { responseBytesBase64, ...rest } = value; return { ...rest, responseBytes: Uint8Array.from(Buffer.from(responseBytesBase64, 'base64')) } }
function sameTrustState(a: ModuleReleaseTrustState | undefined, b: ModuleReleaseTrustState | undefined): boolean { return a?.highestSequence === b?.highestSequence && a?.latestIssuedAt === b?.latestIssuedAt }
function validateHash(value: string): void { if (!HASH.test(value)) throw new TypeError('Invalid SHA-256') }
function validatePartialId(value: string): void { if (!PARTIAL_ID.test(value)) throw new TypeError('Invalid partial id') }
function validPartial(value: ArtifactPartialRecord): boolean { return PARTIAL_ID.test(value.id) && HASH.test(value.sha256) && Number.isSafeInteger(value.bytesWritten) && value.bytesWritten >= 0 }
function positive(value: number | undefined, fallback: number, name: string): number { const result = value ?? fallback; if (!Number.isSafeInteger(result) || result <= 0) throw new TypeError(`${name} must be positive`); return result }
function hasCode(cause: unknown, code: string): boolean { return cause instanceof Error && 'code' in cause && cause.code === code }
function isLivePid(pid: number | undefined): boolean { if (!Number.isSafeInteger(pid) || pid! <= 0) return false; try { process.kill(pid!, 0); return true } catch (cause) { return hasCode(cause, 'EPERM') } }
function basename(path: string): string { return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1) }
async function assertDirectoryNotSymlink(path: string): Promise<void> { const info = await lstat(path); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Unsafe cache directory: ${path}`) }
async function assertContained(root: string, path: string): Promise<void> { const [realRoot, realPath] = await Promise.all([realpath(root), realpath(path)]); const rel = relative(realRoot, realPath); if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Cache path escapes root') }
async function readJson<T>(path: string): Promise<T | undefined> { try { return JSON.parse(await readFile(path, 'utf8')) as T } catch (cause) { if (hasCode(cause, 'ENOENT')) return undefined; throw cause } }
async function hashFile(path: string): Promise<string> { const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer); return hash.digest('hex') }
async function directoryNames(path: string): Promise<string[]> { try { return await readdir(path) } catch (cause) { if (hasCode(cause, 'ENOENT')) return []; throw cause } }
async function exists(path: string): Promise<boolean> { try { await lstat(path); return true } catch (cause) { if (hasCode(cause, 'ENOENT')) return false; throw cause } }
function sleep(ms: number, signal: AbortSignal): Promise<void> { return new Promise((resolveSleep, reject) => { const timer = setTimeout(done, ms); const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason) }; function done() { signal.removeEventListener('abort', abort); resolveSleep() } signal.addEventListener('abort', abort, { once: true }) }) }
