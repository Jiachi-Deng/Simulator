import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import type {
  ModuleRegistryPersistence,
  PersistedModuleRegistryStateV1,
  RegistryPersistenceRead,
} from './types.ts'

const STATE_FILE = 'module-registry.json'
const PENDING_FILE = 'module-registry.pending.json'
const LOCK_FILE = 'module-registry.lock'
const MAX_STATE_BYTES = 4 * 1024 * 1024

export type FilesystemRegistryFaultPoint =
  | 'after-pending-sync'
  | 'after-state-lstat'
  | 'before-state-rename'
  | 'after-state-rename'

export interface FilesystemModuleRegistryPersistenceOptions {
  readonly faultInjector?: (point: FilesystemRegistryFaultPoint) => void
}

export class FilesystemModuleRegistryPersistence implements ModuleRegistryPersistence {
  readonly root: string
  readonly #canonicalRoot: string
  readonly #fault?: FilesystemModuleRegistryPersistenceOptions['faultInjector']

  constructor(trustedRoot: string, options: FilesystemModuleRegistryPersistenceOptions = {}) {
    if (!isAbsolute(trustedRoot)) throw new TypeError('Registry trusted root must be absolute')
    this.root = resolve(trustedRoot)
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    this.#canonicalRoot = realpathSync(this.root)
    this.#assertRoot()
    this.#fault = options.faultInjector
  }

  read(): RegistryPersistenceRead {
    this.#assertRoot()
    const pending = this.#safeExists(PENDING_FILE)
    const committed = this.#readJson(STATE_FILE)
    if (pending) {
      unlinkSync(this.#path(PENDING_FILE))
      this.#syncRoot()
    }
    return { committed, interruptedCommit: pending }
  }

  commit(state: PersistedModuleRegistryStateV1): void {
    this.#assertRoot()
    const lockToken = this.#acquireLock()
    let temporary: string | undefined
    try {
      this.#assertRoot()
      this.#writeExclusive(PENDING_FILE, state)
      this.#syncRoot()
      this.#fault?.('after-pending-sync')
      const serialized = this.#serialize(state)
      temporary = this.#path(`.${STATE_FILE}.${randomUUID()}.tmp`)
      const descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
      try {
        writeFileSync(descriptor, serialized)
        fsyncSync(descriptor)
      } finally {
        closeSync(descriptor)
      }
      this.#assertRoot()
      this.#assertSafeDestination(STATE_FILE)
      this.#fault?.('before-state-rename')
      renameSync(temporary, this.#path(STATE_FILE))
      temporary = undefined
      this.#syncRoot()
      this.#fault?.('after-state-rename')
      unlinkSync(this.#path(PENDING_FILE))
      this.#syncRoot()
    } finally {
      if (temporary) rmSync(temporary, { force: true })
      this.#releaseLock(lockToken)
      this.#syncRoot()
    }
  }

  #readJson(name: string): unknown | null {
    if (!this.#safeExists(name)) return null
    const path = this.#path(name)
    const info = lstatSync(path)
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_STATE_BYTES) {
      throw new Error(`Unsafe registry persistence file: ${name}`)
    }
    if (name === STATE_FILE) this.#fault?.('after-state-lstat')
    const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const opened = fstatSync(descriptor)
      if (!opened.isFile() || opened.size > MAX_STATE_BYTES) {
        throw new Error(`Unsafe registry persistence file: ${name}`)
      }
      const bytes = readFileSync(descriptor)
      if (bytes.byteLength > MAX_STATE_BYTES) throw new Error('Registry state exceeds size limit')
      return JSON.parse(bytes.toString('utf8')) as unknown
    } finally {
      closeSync(descriptor)
    }
  }

  #writeExclusive(name: string, state: PersistedModuleRegistryStateV1): void {
    const descriptor = openSync(this.#path(name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
    try {
      writeFileSync(descriptor, this.#serialize(state))
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
  }

  #acquireLock(): string {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = randomUUID()
      const candidate = this.#path(`.${LOCK_FILE}.${token}.tmp`)
      const descriptor = openSync(candidate, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
      try {
        writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, token })}\n`, 'utf8')
        fsyncSync(descriptor)
      } finally {
        closeSync(descriptor)
      }
      try {
        linkSync(candidate, this.#path(LOCK_FILE))
        unlinkSync(candidate)
        this.#syncRoot()
        return token
      } catch (error) {
        rmSync(candidate, { force: true })
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        if (attempt === 1 || !this.#reclaimStaleLock()) throw new Error('Another registry persistence writer is active')
      }
    }
    throw new Error('Could not acquire registry persistence writer lock')
  }

  #reclaimStaleLock(): boolean {
    const owner = this.#readLockOwner()
    if (!owner) return true
    try {
      process.kill(owner.pid, 0)
      return false
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EPERM') return false
      if (code !== 'ESRCH') throw error
    }
    const stale = this.#path(`.${LOCK_FILE}.${owner.token}.stale`)
    try {
      renameSync(this.#path(LOCK_FILE), stale)
      unlinkSync(stale)
      this.#syncRoot()
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
      throw error
    }
  }

  #readLockOwner(): { pid: number; token: string } | undefined {
    if (!this.#safeExists(LOCK_FILE)) return undefined
    const path = this.#path(LOCK_FILE)
    const info = lstatSync(path)
    if (!info.isFile() || info.size > 1_024) throw new Error('Registry writer lock is invalid')
    const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const opened = fstatSync(descriptor)
      if (!opened.isFile() || opened.size > 1_024) throw new Error('Registry writer lock is invalid')
      const parsed = JSON.parse(readFileSync(descriptor, 'utf8')) as unknown
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Registry writer lock is invalid')
      const value = parsed as Record<string, unknown>
      if (Object.keys(value).length !== 2 || !Number.isSafeInteger(value.pid) || (value.pid as number) <= 0
        || typeof value.token !== 'string' || !/^[a-f0-9-]{36}$/.test(value.token)) throw new Error('Registry writer lock is invalid')
      return { pid: value.pid as number, token: value.token }
    } finally {
      closeSync(descriptor)
    }
  }

  #releaseLock(token: string): void {
    const owner = this.#readLockOwner()
    if (!owner) return
    if (owner.token !== token) throw new Error('Registry writer lock ownership changed')
    unlinkSync(this.#path(LOCK_FILE))
  }

  #serialize(state: PersistedModuleRegistryStateV1): Buffer {
    const bytes = Buffer.from(`${JSON.stringify(state)}\n`, 'utf8')
    if (bytes.byteLength > MAX_STATE_BYTES) throw new Error('Registry state exceeds size limit')
    return bytes
  }

  #assertRoot(): void {
    const info = lstatSync(this.root)
    if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(this.root) !== this.#canonicalRoot) {
      throw new Error('Registry trusted root changed or is not a real directory')
    }
  }

  #assertSafeDestination(name: string): void {
    if (!existsSync(this.#path(name))) return
    const info = lstatSync(this.#path(name))
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Unsafe registry persistence destination: ${name}`)
  }

  #safeExists(name: string): boolean {
    const path = this.#path(name)
    try {
      const info = lstatSync(path)
      if (info.isSymbolicLink()) throw new Error(`Registry persistence path is a symlink: ${name}`)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }

  #syncRoot(): void {
    const descriptor = openSync(this.root, constants.O_RDONLY)
    try {
      fsyncSync(descriptor)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EISDIR' && code !== 'EPERM') throw error
    } finally {
      closeSync(descriptor)
    }
  }

  #path(name: string): string {
    return join(this.root, name)
  }
}
