import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import {
  chmod, link, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, rmdir,
} from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { ModuleReleaseTrustState } from '@simulator/module-release-trust'
import type {
  ArtifactPartialRecord, ArtifactPublishResult, CachedArtifactRecord, CachedCatalogRecord,
  ModuleDownloaderCacheAdapter, ModuleDownloaderCacheLease,
} from './types.ts'
import { writeAll } from './node-file-io.ts'

const OWNER_MODE = 0o700
const FILE_MODE = 0o600
const HASH = /^[a-f0-9]{64}$/
const UUID = /^[a-f0-9-]{36}$/
const TOP_LEVEL = ['catalog', 'artifacts', 'partials', 'leases'] as const
const PROCESS_INSTANCE_ID = randomUUID()

export type NodeCacheFaultPoint = 'temp-write' | 'file-sync' | 'rename' | 'directory-sync' | 'cleanup'
export type NodeCacheCheckpoint =
  | 'lease-owner-published' | 'lease-candidate-created' | 'lease-claim-published' | 'lease-stale-observed' | 'lease-quarantined'
  | 'artifact-owner-published' | 'artifact-claim-published' | 'artifact-destination-created'
  | 'partial-data-created' | 'catalog-generation-mid-write' | 'catalog-generation-written' | 'catalog-pointer-renamed'

export interface NodeFilesystemCacheOptions {
  readonly staleLeaseMs?: number
  readonly leasePollMs?: number
  readonly maxStaleRecoveries?: number
  readonly maxStartupPrunes?: number
  readonly now?: () => number
  readonly faultInjector?: (point: NodeCacheFaultPoint, path: string) => void | Promise<void>
  readonly checkpoint?: (point: NodeCacheCheckpoint, path: string) => void | Promise<void>
  readonly processIdentity?: (pid: number) => Promise<string | undefined>
}

interface OwnerRecord { readonly token: string; readonly pid: number; readonly processInstanceId: string; readonly processStartIdentity?: string; readonly acquiredAt: number }
interface CatalogWire extends Omit<CachedCatalogRecord, 'responseBytes'> { readonly responseBytesBase64: string }
interface CatalogTransaction { readonly id: string; readonly digest: string; readonly path: string }

export class NodeFilesystemModuleDownloaderCache implements ModuleDownloaderCacheAdapter {
  readonly root: string
  readonly durability = 'immutable-generation-scan' as const
  readonly #instance = randomUUID()
  readonly #staleMs: number
  readonly #pollMs: number
  readonly #maxRecoveries: number
  readonly #now: () => number
  readonly #fault?: NodeFilesystemCacheOptions['faultInjector']
  readonly #checkpointHook?: NodeFilesystemCacheOptions['checkpoint']
  readonly #processIdentity: (pid: number) => Promise<string | undefined>
  readonly #ready: Promise<void>
  #stage?: CatalogTransaction
  #ownProcessIdentity?: Promise<string | undefined>

  constructor(root: string, options: NodeFilesystemCacheOptions = {}) {
    if (!root || !isAbsolute(root)) throw new TypeError('Cache root must be an absolute path')
    this.root = resolve(root)
    this.#staleMs = positive(options.staleLeaseMs, 120_000, 'staleLeaseMs')
    this.#pollMs = positive(options.leasePollMs, 25, 'leasePollMs')
    this.#maxRecoveries = positive(options.maxStaleRecoveries, 3, 'maxStaleRecoveries')
    this.#now = options.now ?? Date.now
    this.#fault = options.faultInjector
    this.#checkpointHook = options.checkpoint
    this.#processIdentity = options.processIdentity ?? processStartIdentity
    this.#ready = this.#initialize(positive(options.maxStartupPrunes, 64, 'maxStartupPrunes'))
  }

  async acquireLease(key: string, signal: AbortSignal): Promise<ModuleDownloaderCacheLease> {
    await this.#ready
    if (!key || key.length > 1024 || /[\0\r\n]/.test(key)) throw new TypeError('Invalid cache lease key')
    const base = join(this.root, 'leases', 'claims', createHash('sha256').update(key).digest('hex'))
    let recoveries = 0
    while (true) {
      if (signal.aborted) throw signal.reason
      const state = await this.#reconcileLease(base)
      if (state === 'blocked') { await sleep(this.#pollMs, signal); continue }
      const owner = await this.#newOwner()
      const ownerPath = this.#leaseOwner(owner.token)
      await this.#immutableJson(ownerPath, owner)
      await this.#checkpoint('lease-owner-published', ownerPath)
      if (process.platform === 'win32') {
        const lock = `${base}.lock`
        try { await mkdir(lock, { mode: OWNER_MODE }) }
        catch (cause) {
          await safeRemoveFile(ownerPath, this.root).catch(() => undefined)
          if (!hasCode(cause, 'EEXIST') && !hasCode(cause, 'ENOTEMPTY')) throw cause
          if (recoveries++ < this.#maxRecoveries) await this.#reconcileLease(base)
          await sleep(this.#pollMs, signal)
          continue
        }
        await this.#checkpoint('lease-candidate-created', lock)
        try {
          await this.#immutableJson(join(lock, 'claim.json'), { token: owner.token })
          await this.#syncDirectory(lock)
          await this.#checkpoint('lease-claim-published', lock)
          if (await this.#hasRecovery(base)) { await this.#releaseOwner(base, owner.token); continue }
          await this.#syncDirectory(dirname(base))
          return { release: once(() => this.#releaseOwner(base, owner.token)) }
        } catch (cause) {
          const token = await claimToken(lock, this.root)
          if (token === undefined || token === owner.token) await rm(lock, { recursive: true, force: true }).catch(() => undefined)
          await safeRemoveFile(ownerPath, this.root).catch(() => undefined)
          throw cause
        }
      }
      const candidate = `${base}.candidate-${owner.token}`
      await mkdir(candidate, { mode: OWNER_MODE })
      await this.#checkpoint('lease-candidate-created', candidate)
      try {
        await this.#immutableJson(join(candidate, 'claim.json'), { token: owner.token })
        await this.#syncDirectory(candidate)
        try { await this.#rename(candidate, `${base}.lock`) }
        catch (cause) {
          if (!hasCode(cause, 'EEXIST') && !hasCode(cause, 'ENOTEMPTY')) throw cause
          await rm(candidate, { recursive: true, force: true })
          if (recoveries++ < this.#maxRecoveries) await this.#reconcileLease(base)
          await sleep(this.#pollMs, signal); continue
        }
        await this.#checkpoint('lease-claim-published', `${base}.lock`)
        if (await this.#hasRecovery(base)) { await this.#releaseOwner(base, owner.token); continue }
        await this.#syncDirectory(dirname(base))
        return { release: once(() => this.#releaseOwner(base, owner.token)) }
      } finally { await rm(candidate, { recursive: true, force: true }).catch(() => undefined) }
    }
  }

  async readCatalog(): Promise<CachedCatalogRecord | undefined> {
    await this.#ready; await this.#assertSafeTree('catalog')
    return (await this.#scanCatalogGenerations())?.record
  }

  async readStagedCatalog(): Promise<CachedCatalogRecord | undefined> {
    await this.#ready; await this.#assertSafeTree('catalog')
    if (this.#stage) return (await this.#readTransaction(this.#stage))?.record
    const directory = join(this.root, 'catalog', 'staged')
    for (const name of (await directoryNames(directory)).sort()) {
      const match = name.match(/^([a-f0-9-]{36})\.([a-f0-9]{64})\.json$/)
      if (!match) continue
      const tx = { id: match[1]!, digest: match[2]!, path: join(directory, name) }
      const valid = await this.#readTransaction(tx)
      if (valid) { this.#stage = tx; return valid.record }
    }
    return undefined
  }

  async stageCatalog(record: CachedCatalogRecord): Promise<void> {
    await this.#ready; await this.#assertSafeTree('catalog')
    const bytes = Buffer.from(JSON.stringify(toCatalogWire(record)))
    const id = randomUUID(); const digest = sha256(bytes)
    const tx: CatalogTransaction = { id, digest, path: join(this.root, 'catalog', 'staged', `${id}.${digest}.json`) }
    await this.#immutableBytes(tx.path, bytes)
    this.#stage = tx
  }

  async publishCatalog(expectedState: ModuleReleaseTrustState | undefined): Promise<boolean> {
    await this.#ready
    if (!this.#stage) throw new Error('No staged catalog transaction for this adapter')
    const exact = this.#stage
    const lease = await this.acquireLease('__catalog-cas__', new AbortController().signal)
    try {
      const staged = await this.#readTransaction(exact)
      if (!staged) throw new Error('Staged catalog transaction identity or digest changed')
      const current = await this.#scanCatalogGenerations()
      if (!sameTrustState(current?.record.trustState, expectedState)) return false
      const generation = join(this.root, 'catalog', 'generations', `${String(staged.record.trustState.highestSequence).padStart(16, '0')}.${exact.digest}.json`)
      await this.#publishGeneration(generation, staged.bytes, exact.digest)
      await this.#checkpoint('catalog-generation-written', generation)
      const pointer = join(this.root, 'catalog', 'current.json')
      await this.#atomicJson(pointer, { generation: generation.slice(dirname(generation).length + 1), digest: exact.digest }, 'catalog')
      await this.#checkpoint('catalog-pointer-renamed', pointer)
      await this.discardStagedCatalog()
      return true
    } finally { await lease.release() }
  }

  async discardStagedCatalog(): Promise<void> {
    await this.#ready
    if (!this.#stage) return
    await safeRemoveFile(this.#stage.path, this.root)
    this.#stage = undefined
  }

  async readArtifact(hash: string): Promise<CachedArtifactRecord | undefined> {
    await this.#ready; validateHash(hash); await this.#assertSafeTree('artifacts')
    const directory = join(this.root, 'artifacts', hash)
    const info = await lstat(directory).catch(() => undefined)
    if (!info) return undefined
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe artifact destination')
    if (!await exists(join(directory, 'committed'))) return undefined
    const record = await safeReadJson<CachedArtifactRecord>(join(directory, 'record.json'), this.root)
    if (!record || record.sha256 !== hash || !Number.isSafeInteger(record.size) || record.size < 0) throw new Error('Invalid artifact record')
    const data = join(directory, 'artifact.bin')
    if ((await safeStatFile(data, this.root)).size !== record.size || await hashFile(data, this.root) !== hash) throw new Error('Artifact CAS verification failed')
    return record
  }

  async listPartials(hash?: string): Promise<readonly ArtifactPartialRecord[]> {
    await this.#ready; if (hash) validateHash(hash); await this.#assertSafeTree('partials')
    const records = await Promise.all((await directoryNames(join(this.root, 'partials'))).filter((id) => UUID.test(id)).map(async (id) => {
      try { return await safeReadJson<ArtifactPartialRecord>(this.#partialRecord(id), this.root) } catch { return undefined }
    }))
    return records.filter((value): value is ArtifactPartialRecord => Boolean(value && validPartial(value) && (!hash || value.sha256 === hash)))
  }

  async createPartial(record: Omit<ArtifactPartialRecord, 'id' | 'bytesWritten'>): Promise<ArtifactPartialRecord> {
    await this.#ready; validateHash(record.sha256); await this.#assertSafeTree('partials')
    const id = randomUUID(); const directory = this.#partialDirectory(id); const value = { ...record, id, bytesWritten: 0 }
    await mkdir(directory, { mode: OWNER_MODE }); await this.#immutableJson(join(directory, 'owner.json'), await this.#newOwner())
    await this.#immutableBytes(this.#partialData(id), new Uint8Array())
    await this.#checkpoint('partial-data-created', directory)
    await this.#atomicJson(this.#partialRecord(id), value, 'partials')
    return value
  }

  async readPartial(id: string): Promise<AsyncIterable<Uint8Array>> {
    await this.#requiredPartial(id)
    const handle = await safeOpen(this.#partialData(id), constants.O_RDONLY, this.root)
    return readChunks(handle)
  }

  async appendPartial(id: string, bytes: Uint8Array, updatedAt: number, validator?: string): Promise<ArtifactPartialRecord> {
    const record = await this.#requiredPartial(id)
    if (bytes.byteLength) {
      const handle = await safeOpen(this.#partialData(id), constants.O_WRONLY, this.root)
      try { await writeAll(handle, bytes, record.bytesWritten); await handle.sync() } finally { await handle.close() }
    }
    const next = { ...record, bytesWritten: record.bytesWritten + bytes.byteLength, updatedAt, ...(validator ? { validator } : {}) }
    await this.#atomicJson(this.#partialRecord(id), next, 'partials')
    return next
  }

  async removePartial(id: string): Promise<void> {
    await this.#ready; validateId(id); await this.#assertSafeTree('partials')
    const directory = this.#partialDirectory(id); const info = await lstat(directory).catch(() => undefined)
    if (!info) return
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe partial directory')
    const quarantine = `${directory}.remove-${randomUUID()}`
    await this.#rename(directory, quarantine)
    await rm(quarantine, { recursive: true, force: true })
    await this.#syncDirectory(dirname(directory))
  }

  async publishPartial(id: string, artifact: CachedArtifactRecord): Promise<ArtifactPublishResult> {
    await this.#ready; validateHash(artifact.sha256); await this.#assertSafeTree('artifacts')
    const partial = await this.#requiredPartial(id)
    if (partial.sha256 !== artifact.sha256 || partial.bytesWritten !== artifact.size || await hashFile(this.#partialData(id), this.root) !== artifact.sha256) throw new Error('Partial verification failed')
    const existing = await this.readArtifact(artifact.sha256)
    if (existing) { if (existing.size !== artifact.size) throw new Error('Artifact CAS winner differs'); await this.removePartial(id); return 'already-present' }
    const destination = join(this.root, 'artifacts', artifact.sha256); const owner = await this.#newOwner()
    const ownerPath = join(this.root, 'artifacts', 'owners', `${owner.token}.json`)
    const claim = join(this.root, 'artifacts', 'claims', `${artifact.sha256}.claim`)
    let ownsClaim = false
    await this.#immutableJson(ownerPath, owner)
    try {
      await this.#checkpoint('artifact-owner-published', ownerPath)
      let waits = 0
      while (true) {
        try { await link(ownerPath, claim); ownsClaim = true; await this.#syncDirectory(dirname(claim)); break }
        catch (cause) {
          if (!hasCode(cause, 'EEXIST')) throw cause
          const winner = await this.readArtifact(artifact.sha256)
          if (winner) { if (winner.size !== artifact.size) throw new Error('Artifact CAS winner differs'); await this.removePartial(id); return 'already-present' }
          if (await this.#recoverArtifactClaim(claim, destination)) continue
          if (waits++ >= this.#maxRecoveries) throw new Error('Artifact CAS claim belongs to a live or unverifiable owner')
          await sleep(this.#pollMs, new AbortController().signal)
        }
      }
      await this.#checkpoint('artifact-claim-published', claim)
      let destinationCreated = false
      try {
        try { await mkdir(destination, { mode: OWNER_MODE }); destinationCreated = true }
        catch (cause) { if (hasCode(cause, 'EEXIST')) throw new Error('Artifact CAS destination exists after claim publication', { cause }); throw cause }
        await this.#checkpoint('artifact-destination-created', destination)
        await this.#immutableJson(join(destination, 'owner.json'), owner)
        await copyVerified(this.#partialData(id), join(destination, 'artifact.bin'), this.root)
        await this.#immutableJson(join(destination, 'record.json'), artifact)
        await this.#immutableBytes(join(destination, 'committed'), Buffer.from(artifact.sha256))
        const published = await this.readArtifact(artifact.sha256)
        if (!published || published.size !== artifact.size) throw new Error('Artifact read-back verification failed')
        await this.removePartial(id)
        return 'published'
      } catch (cause) {
        if (destinationCreated && !await exists(join(destination, 'committed'))) await rm(destination, { recursive: true, force: true }).catch(() => undefined)
        throw cause
      }
    } finally {
      if (ownsClaim) await this.#releaseArtifactClaim(claim, owner.token)
      await safeRemoveFile(ownerPath, this.root)
    }
  }

  async #initialize(limit: number): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: OWNER_MODE }); await assertDirectory(this.root); await chmod(this.root, OWNER_MODE)
    for (const name of TOP_LEVEL) await this.#ensureDirectory(join(this.root, name))
    for (const path of [
      join(this.root, 'catalog', 'staged'), join(this.root, 'catalog', 'generations'),
      join(this.root, 'leases', 'owners'), join(this.root, 'leases', 'claims'),
      join(this.root, 'artifacts', 'owners'), join(this.root, 'artifacts', 'claims'),
    ]) await this.#ensureDirectory(path)
    await this.#recoverStartup(limit)
  }

  async #ensureDirectory(path: string): Promise<void> {
    await mkdir(path, { mode: OWNER_MODE }).catch((cause) => { if (!hasCode(cause, 'EEXIST')) throw cause })
    await assertDirectory(path); await assertContained(this.root, path); await chmod(path, OWNER_MODE)
  }

  async #assertSafeTree(name: typeof TOP_LEVEL[number]): Promise<void> {
    const path = join(this.root, name); await assertDirectory(path); await assertContained(this.root, path)
  }

  async #reconcileLease(base: string): Promise<'clear' | 'blocked'> {
    const parent = dirname(base); const prefix = `${baseName(base)}.recover-`
    for (const name of (await directoryNames(parent)).filter((value) => value.startsWith(prefix))) {
      const quarantine = join(parent, name); const token = await claimToken(quarantine, this.root)
      if (!token || await exists(this.#leaseReleased(token)) || await this.#ownerDeadOrStale(token, quarantine)) {
        await rm(quarantine, { recursive: true, force: true }); continue
      }
      if (!await exists(`${base}.lock`)) { await this.#rename(quarantine, `${base}.lock`); continue }
      return 'blocked'
    }
    const lock = `${base}.lock`; const info = await lstat(lock).catch(() => undefined)
    if (!info) {
      if (process.platform === 'win32' && !await this.#clearReleasedLeaseMarkers(base)) return 'blocked'
      return 'clear'
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe lease claim')
    const token = await claimToken(lock, this.root)
    if (token && await exists(this.#leaseReleased(token))) {
      await this.#removeClaim(base, token)
      return await this.#releasedLeaseCleared(base, lock)
    }
    if (process.platform === 'win32') {
      const released = await this.#releasedLeaseTokens(base)
      if (!token && released.length === 1) {
        await this.#removeClaim(base, released[0]!)
        return await this.#releasedLeaseCleared(base, lock)
      }
      if (!token && released.length > 1) throw new Error('Ambiguous released lease markers')
    }
    const stale = token ? await this.#ownerDeadOrStale(token, lock) : this.#now() - info.mtimeMs > this.#staleMs
    if (!stale) return 'blocked'
    await this.#checkpoint('lease-stale-observed', lock)
    const quarantine = `${base}.recover-${randomUUID()}`
    try { await this.#rename(lock, quarantine) }
    catch (cause) { if (hasCode(cause, 'ENOENT')) return 'blocked'; throw cause }
    await this.#checkpoint('lease-quarantined', quarantine)
    const movedToken = await claimToken(quarantine, this.root)
    if (!movedToken || await exists(this.#leaseReleased(movedToken)) || await this.#ownerDeadOrStale(movedToken, quarantine)) await rm(quarantine, { recursive: true, force: true })
    else if (!await exists(lock)) await this.#rename(quarantine, lock)
    return await exists(lock) ? 'blocked' : 'clear'
  }

  async #hasRecovery(base: string): Promise<boolean> { return (await directoryNames(dirname(base))).some((name) => name.startsWith(`${baseName(base)}.recover-`)) }
  async #ownerDeadOrStale(token: string, fallback: string): Promise<boolean> {
    const owner = await safeReadJson<OwnerRecord>(this.#leaseOwner(token), this.root).catch(() => undefined)
    if (!owner) return this.#now() - (await lstat(fallback)).mtimeMs > this.#staleMs
    return this.#ownerRecordRecoverable(owner)
  }
  async #releaseOwner(base: string, token: string): Promise<void> {
    try { await this.#immutableBytes(this.#leaseReleased(token), Buffer.from(token)) } catch (cause) { if (!hasCode(cause, 'EEXIST')) throw cause }
    await this.#removeClaim(base, token)
    await this.#reconcileLease(base)
  }
  async #removeClaim(base: string, token: string): Promise<void> {
    const lock = `${base}.lock`; const claimedToken = await claimToken(lock, this.root)
    if (process.platform === 'win32') {
      if (claimedToken !== undefined && claimedToken !== token) return
      const marker = this.#leaseReleaseMarker(base, token)
      try { await this.#immutableBytes(marker, Buffer.from(token)) }
      catch (cause) {
        if (!hasCode(cause, 'EEXIST') || (await safeReadFile(marker, this.root)).toString() !== token) throw cause
      }
      try { await safeRemoveFile(join(lock, 'claim.json'), this.root) }
      catch (cause) {
        if (hasCode(cause, 'ENOENT') || hasCode(cause, 'EPERM')) return
        throw cause
      }
      try { await rmdir(lock) }
      catch (cause) {
        if (hasCode(cause, 'ENOENT') || hasCode(cause, 'ENOTEMPTY') || hasCode(cause, 'EPERM')) return
        throw cause
      }
      await this.#syncDirectory(dirname(base))
      await safeRemoveFile(marker, this.root).catch((cause) => {
        if (!hasCode(cause, 'ENOENT') && !hasCode(cause, 'EPERM')) throw cause
      })
      return
    }
    if (claimedToken !== token) return
    const released = `${base}.released-${token}`
    try { await this.#rename(lock, released) } catch (cause) { if (hasCode(cause, 'ENOENT')) return; throw cause }
    await rm(released, { recursive: true, force: true }); await this.#syncDirectory(dirname(base))
  }
  #leaseOwner(token: string): string { validateId(token); return join(this.root, 'leases', 'owners', `${token}.json`) }
  #leaseReleased(token: string): string { validateId(token); return join(this.root, 'leases', 'owners', `${token}.released`) }
  #leaseReleaseMarker(base: string, token: string): string { validateId(token); return `${base}.released-${token}` }
  async #releasedLeaseTokens(base: string): Promise<string[]> {
    const prefix = `${baseName(base)}.released-`
    const tokens: string[] = []
    for (const name of (await directoryNames(dirname(base))).filter((value) => value.startsWith(prefix))) {
      const token = name.slice(prefix.length)
      if (!UUID.test(token)) continue
      let bytes: Buffer
      try { bytes = await safeReadFile(join(dirname(base), name), this.root) }
      catch (cause) {
        if (hasCode(cause, 'ENOENT')) continue
        throw cause
      }
      if (bytes.toString() !== token) throw new Error('Invalid released lease marker')
      tokens.push(token)
    }
    return tokens
  }
  async #clearReleasedLeaseMarkers(base: string): Promise<boolean> {
    for (const token of await this.#releasedLeaseTokens(base)) {
      try { await safeRemoveFile(this.#leaseReleaseMarker(base, token), this.root) }
      catch (cause) {
        if (hasCode(cause, 'ENOENT')) continue
        if (hasCode(cause, 'EPERM')) return false
        throw cause
      }
    }
    return true
  }
  async #releasedLeaseCleared(base: string, lock: string): Promise<'clear' | 'blocked'> {
    if (await exists(lock)) return 'blocked'
    if (process.platform === 'win32' && !await this.#clearReleasedLeaseMarkers(base)) return 'blocked'
    return 'clear'
  }

  async #recoverArtifactClaim(claim: string, destination: string): Promise<boolean> {
    const owner = await safeReadJson<OwnerRecord>(claim, this.root).catch(() => undefined)
    if (!owner || !await this.#ownerRecordRecoverable(owner)) return false
    const quarantine = `${claim}.recover-${randomUUID()}`
    try { await this.#rename(claim, quarantine) } catch (cause) { if (hasCode(cause, 'ENOENT')) return true; throw cause }
    const moved = await safeReadJson<OwnerRecord>(quarantine, this.root).catch(() => undefined)
    if (!moved || !await this.#ownerRecordRecoverable(moved)) { if (!await exists(claim)) await this.#rename(quarantine, claim); return false }
    await safeRemoveFile(quarantine, this.root)
    const info = await lstat(destination).catch(() => undefined)
    if (info) {
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe artifact destination')
      if (await exists(join(destination, 'committed'))) return false
      await rm(destination, { recursive: true, force: true })
    }
    return true
  }
  async #releaseArtifactClaim(claim: string, token: string): Promise<void> {
    const owner = await safeReadJson<OwnerRecord>(claim, this.root).catch(() => undefined)
    if (owner?.token !== token) return
    const quarantine = `${claim}.released-${token}`
    try { await this.#rename(claim, quarantine) } catch (cause) { if (hasCode(cause, 'ENOENT')) return; throw cause }
    await safeRemoveFile(quarantine, this.root)
  }

  async #recoverStartup(limit: number): Promise<void> {
    let remaining = limit
    for (const name of await directoryNames(join(this.root, 'catalog', 'generations'))) {
      if (!remaining) return
      if (!name.endsWith('.generation.tmp')) continue
      const path = join(this.root, 'catalog', 'generations', name); const info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Unsafe catalog generation temp')
      if (this.#now() - info.mtimeMs > this.#staleMs) { await safeRemoveFile(path, this.root); remaining -= 1 }
    }
    const claims = join(this.root, 'leases', 'claims')
    const bases = new Set((await directoryNames(claims)).map((name) => name.match(/^([a-f0-9]{64})\.(?:lock|recover-)/)?.[1]).filter((v): v is string => Boolean(v)))
    for (const name of bases) { if (!remaining--) return; await this.#reconcileLease(join(claims, name)) }
    const artifactClaims = join(this.root, 'artifacts', 'claims')
    for (const name of await directoryNames(artifactClaims)) {
      if (!remaining) return
      const match = name.match(/^([a-f0-9]{64})\.claim$/)
      if (!match) continue
      const claim = join(artifactClaims, name); const info = await lstat(claim)
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Unsafe artifact claim')
      const recovered = await this.#recoverArtifactClaim(claim, join(this.root, 'artifacts', match[1]!))
      if (recovered || !await exists(claim)) remaining -= 1
    }
    for (const name of await directoryNames(join(this.root, 'artifacts'))) {
      if (!remaining) return
      const path = join(this.root, 'artifacts', name)
      if (name.includes('.recover-')) {
        if (await exists(join(path, 'committed'))) { const target = path.slice(0, path.indexOf('.recover-')); if (!await exists(target)) await this.#rename(path, target) }
        else await rm(path, { recursive: true, force: true })
        remaining -= 1; continue
      }
      if (HASH.test(name) && !await exists(join(path, 'committed'))) {
        const owner = await safeReadJson<OwnerRecord>(join(path, 'owner.json'), this.root).catch(() => undefined)
        if (owner && await this.#ownerRecordRecoverable(owner)) { await rm(path, { recursive: true, force: true }); remaining -= 1 }
      }
    }
    const artifactOwners = join(this.root, 'artifacts', 'owners')
    for (const name of await directoryNames(artifactOwners)) {
      if (!remaining) return
      if (!/^([a-f0-9-]{36})\.json$/.test(name)) continue
      const path = join(artifactOwners, name); const info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Unsafe artifact owner')
      if (info.nlink > 1) continue
      const owner = await safeReadJson<OwnerRecord>(path, this.root).catch(() => undefined)
      const recoverable = owner ? await this.#ownerRecordRecoverable(owner) : this.#now() - info.mtimeMs > this.#staleMs
      if (recoverable) { await safeRemoveFile(path, this.root); remaining -= 1 }
    }
    for (const id of (await directoryNames(join(this.root, 'partials'))).filter((name) => UUID.test(name))) {
      if (!remaining) return
      const directory = join(this.root, 'partials', id); const info = await lstat(directory)
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe partial directory')
      if (await exists(join(directory, 'record.json'))) continue
      const owner = await safeReadJson<OwnerRecord>(join(directory, 'owner.json'), this.root).catch(() => undefined)
      const recoverable = owner ? await this.#ownerRecordRecoverable(owner) : this.#now() - info.mtimeMs > this.#staleMs
      if (recoverable) { const quarantine = `${directory}.recover-${randomUUID()}`; await this.#rename(directory, quarantine); await rm(quarantine, { recursive: true, force: true }); remaining -= 1 }
    }
  }

  async #scanCatalogGenerations(): Promise<{ record: CachedCatalogRecord; digest: string } | undefined> {
    const directory = join(this.root, 'catalog', 'generations'); const valid: Array<{ record: CachedCatalogRecord; digest: string; name: string }> = []
    for (const name of await directoryNames(directory)) {
      const match = name.match(/^[0-9]{16}\.([a-f0-9]{64})\.json$/); if (!match) continue
      try {
        const bytes = await safeReadFile(join(directory, name), this.root); if (sha256(bytes) !== match[1]) continue
        const record = fromCatalogWire(JSON.parse(bytes.toString('utf8')) as CatalogWire); if (!record || record.trustState.highestSequence !== Number(name.slice(0, 16))) continue
        valid.push({ record, digest: match[1]!, name })
      } catch { /* invalid generations are ignored */ }
    }
    valid.sort((a, b) => b.record.trustState.highestSequence - a.record.trustState.highestSequence || b.record.committedAt - a.record.committedAt || b.name.localeCompare(a.name))
    return valid[0]
  }
  async #readTransaction(tx: CatalogTransaction): Promise<{ record: CachedCatalogRecord; bytes: Buffer } | undefined> {
    try { const bytes = await safeReadFile(tx.path, this.root); if (sha256(bytes) !== tx.digest) return undefined; const record = fromCatalogWire(JSON.parse(bytes.toString('utf8')) as CatalogWire); return record ? { record, bytes } : undefined } catch { return undefined }
  }

  async #publishGeneration(path: string, bytes: Buffer, digest: string): Promise<void> {
    const temp = join(dirname(path), `.${randomUUID()}.generation.tmp`)
    await this.#faultAt('temp-write', temp)
    const handle = await open(temp, exclusiveWriteFlags(), FILE_MODE)
    try {
      const midpoint = Math.max(1, Math.floor(bytes.byteLength / 2)); await writeAll(handle, bytes.subarray(0, midpoint), 0)
      await this.#checkpoint('catalog-generation-mid-write', temp)
      await writeAll(handle, bytes.subarray(midpoint), midpoint); await this.#faultAt('file-sync', temp); await handle.sync()
    } finally { await handle.close() }
    try {
      if (sha256(await safeReadFile(temp, this.root)) !== digest) throw new Error('Catalog generation temp verification failed')
      try { await this.#faultAt('rename', path); await link(temp, path); await this.#syncDirectory(dirname(path)) }
      catch (cause) { if (!hasCode(cause, 'EEXIST') || sha256(await safeReadFile(path, this.root)) !== digest) throw cause }
    } finally { await safeRemoveFile(temp, this.root).catch(() => undefined); await this.#faultAt('cleanup', path) }
  }

  async #newOwner(): Promise<OwnerRecord> {
    const processStartIdentity = await (this.#ownProcessIdentity ??= this.#processIdentity(process.pid))
    return { token: randomUUID(), pid: process.pid, processInstanceId: PROCESS_INSTANCE_ID, ...(processStartIdentity ? { processStartIdentity } : {}), acquiredAt: this.#now() }
  }
  async #ownerRecordRecoverable(owner: OwnerRecord): Promise<boolean> {
    if (this.#now() - owner.acquiredAt <= this.#staleMs) return false
    if (!isLivePid(owner.pid)) return true
    if (!owner.processStartIdentity) return false
    const current = await this.#processIdentity(owner.pid)
    return current !== undefined && current !== owner.processStartIdentity
  }

  #partialDirectory(id: string): string { validateId(id); return join(this.root, 'partials', id) }
  #partialRecord(id: string): string { return join(this.#partialDirectory(id), 'record.json') }
  #partialData(id: string): string { return join(this.#partialDirectory(id), 'data.bin') }
  async #requiredPartial(id: string): Promise<ArtifactPartialRecord> {
    await this.#ready; validateId(id); await this.#assertSafeTree('partials'); await assertDirectory(this.#partialDirectory(id)); await assertContained(this.root, this.#partialDirectory(id))
    const value = await safeReadJson<ArtifactPartialRecord>(this.#partialRecord(id), this.root)
    if (!value || !validPartial(value)) throw new Error(`Unknown partial: ${id}`)
    await safeStatFile(this.#partialData(id), this.root)
    return value
  }

  async #immutableJson(path: string, value: unknown): Promise<void> { await this.#immutableBytes(path, Buffer.from(JSON.stringify(value))) }
  async #immutableBytes(path: string, bytes: Uint8Array): Promise<void> {
    await this.#faultAt('temp-write', path); const handle = await open(path, exclusiveWriteFlags(), FILE_MODE)
    try { await handle.writeFile(bytes); await this.#faultAt('file-sync', path); await handle.sync() } finally { await handle.close() }
    await chmod(path, FILE_MODE); await this.#syncDirectory(dirname(path))
  }
  async #atomicJson(path: string, value: unknown, topLevel: typeof TOP_LEVEL[number]): Promise<void> {
    await this.#assertSafeTree(topLevel); const temp = `${path}.${randomUUID()}.tmp`
    try { await this.#immutableJson(temp, value); await this.#rename(temp, path); await this.#syncDirectory(dirname(path)) }
    finally { await safeRemoveFile(temp, this.root).catch(() => undefined); await this.#faultAt('cleanup', path) }
  }
  async #faultAt(point: NodeCacheFaultPoint, path: string): Promise<void> { await this.#fault?.(point, path) }
  async #checkpoint(point: NodeCacheCheckpoint, path: string): Promise<void> { await this.#checkpointHook?.(point, path) }
  async #rename(from: string, to: string): Promise<void> { await this.#faultAt('rename', to); await rename(from, to) }
  async #syncDirectory(path: string): Promise<void> { await this.#faultAt('directory-sync', path); if (process.platform === 'win32') return; const handle = await open(path, 'r'); try { await handle.sync() } finally { await handle.close() } }
}

function toCatalogWire(record: CachedCatalogRecord): CatalogWire { const { responseBytes, ...rest } = record; return { ...rest, responseBytesBase64: Buffer.from(responseBytes).toString('base64') } }
function fromCatalogWire(value: CatalogWire | undefined): CachedCatalogRecord | undefined { if (!value) return undefined; const { responseBytesBase64, ...rest } = value; return { ...rest, responseBytes: Uint8Array.from(Buffer.from(responseBytesBase64, 'base64')) } }
function sameTrustState(a: ModuleReleaseTrustState | undefined, b: ModuleReleaseTrustState | undefined): boolean { return a?.highestSequence === b?.highestSequence && a?.latestIssuedAt === b?.latestIssuedAt }
function validateHash(value: string): void { if (!HASH.test(value)) throw new TypeError('Invalid SHA-256') }
function validateId(value: string): void { if (!UUID.test(value)) throw new TypeError('Invalid id') }
function validPartial(value: ArtifactPartialRecord): boolean { return UUID.test(value.id) && HASH.test(value.sha256) && Number.isSafeInteger(value.bytesWritten) && value.bytesWritten >= 0 }
function positive(value: number | undefined, fallback: number, name: string): number { const result = value ?? fallback; if (!Number.isSafeInteger(result) || result <= 0) throw new TypeError(`${name} must be positive`); return result }
function hasCode(cause: unknown, code: string): boolean { return cause instanceof Error && 'code' in cause && cause.code === code }
function isLivePid(pid: number): boolean { if (!Number.isSafeInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true } catch (cause) { return hasCode(cause, 'EPERM') } }
function sha256(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }
function baseName(path: string): string { return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1) }
function once(operation: () => Promise<void>): () => Promise<void> { let promise: Promise<void> | undefined; return () => (promise ??= operation()) }
async function directoryNames(path: string): Promise<string[]> { try { return await readdir(path) } catch (cause) { if (hasCode(cause, 'ENOENT')) return []; throw cause } }
async function exists(path: string): Promise<boolean> { try { await lstat(path); return true } catch (cause) { if (hasCode(cause, 'ENOENT')) return false; throw cause } }
async function assertDirectory(path: string): Promise<void> { const info = await lstat(path); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Unsafe cache directory: ${path}`) }
async function assertContained(root: string, path: string): Promise<void> { const [a, b] = await Promise.all([realpath(root), realpath(path)]); const rel = relative(a, b); if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Cache path escapes root') }
async function safeOpen(path: string, flags: number, root: string) {
  const before = await lstat(path); if (!before.isFile() || before.isSymbolicLink()) throw new Error('Unsafe cache leaf')
  await assertContained(root, path)
  const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW
  const handle = await open(path, flags | noFollow)
  const after = await handle.stat(); if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino) { await handle.close(); throw new Error('Cache leaf identity changed') }
  return handle
}
async function safeReadFile(path: string, root: string): Promise<Buffer> { const handle = await safeOpen(path, constants.O_RDONLY, root); try { return await handle.readFile() } finally { await handle.close() } }
async function safeReadJson<T>(path: string, root: string): Promise<T | undefined> { try { return JSON.parse((await safeReadFile(path, root)).toString('utf8')) as T } catch (cause) { if (hasCode(cause, 'ENOENT')) return undefined; throw cause } }
async function safeStatFile(path: string, root: string) { const handle = await safeOpen(path, constants.O_RDONLY, root); try { return await handle.stat() } finally { await handle.close() } }
async function safeRemoveFile(path: string, root: string): Promise<void> { const info = await lstat(path).catch(() => undefined); if (!info) return; if (!info.isFile() || info.isSymbolicLink()) throw new Error('Refusing to remove unsafe cache leaf'); await assertContained(root, path); await rm(path) }
async function hashFile(path: string, root: string): Promise<string> { const handle = await safeOpen(path, constants.O_RDONLY, root); const hash = createHash('sha256'); try { for await (const chunk of readChunks(handle, false)) hash.update(chunk); return hash.digest('hex') } finally { await handle.close() } }
async function claimToken(path: string, root: string): Promise<string | undefined> { const value = await safeReadJson<{ token?: string }>(join(path, 'claim.json'), root).catch(() => undefined); return value?.token && UUID.test(value.token) ? value.token : undefined }
async function copyVerified(source: string, destination: string, root: string): Promise<void> { const input = await safeOpen(source, constants.O_RDONLY, root); const output = await open(destination, exclusiveWriteFlags(), FILE_MODE); try { let position = 0; for await (const chunk of readChunks(input, false)) { await writeAll(output, chunk, position); position += chunk.byteLength } await output.sync() } finally { await Promise.all([input.close(), output.close()]) } }
function exclusiveWriteFlags(): 'wx' | number { return process.platform === 'win32' ? 'wx' : constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY }
async function* readChunks(handle: Awaited<ReturnType<typeof open>>, close = true): AsyncGenerator<Uint8Array> { const buffer = Buffer.allocUnsafe(64 * 1024); let position = 0; try { while (true) { const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position); if (bytesRead === 0) return; position += bytesRead; yield Uint8Array.from(buffer.subarray(0, bytesRead)) } } finally { if (close) await handle.close() } }
function sleep(ms: number, signal: AbortSignal): Promise<void> { return new Promise((resolveSleep, reject) => { const timer = setTimeout(done, ms); const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason) }; function done() { signal.removeEventListener('abort', abort); resolveSleep() } signal.addEventListener('abort', abort, { once: true }) }) }

async function processStartIdentity(pid: number): Promise<string | undefined> {
  try {
    if (process.platform === 'linux') {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8'); const end = stat.lastIndexOf(')'); const fields = stat.slice(end + 2).split(' ')
      return fields[19] ? `linux:${fields[19]}` : undefined
    }
    if (process.platform === 'win32') {
      const output = await execFileOutput('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().Ticks`])
      return output ? `windows:${output}` : undefined
    }
    const output = await execFileOutput('ps', ['-o', 'lstart=', '-p', String(pid)])
    return output ? `${process.platform}:${output}` : undefined
  } catch { return undefined }
}

function execFileOutput(file: string, args: string[]): Promise<string> {
  return new Promise((resolveOutput, reject) => execFile(file, args, { encoding: 'utf8' }, (error, stdout) => error ? reject(error) : resolveOutput(stdout.trim())))
}
