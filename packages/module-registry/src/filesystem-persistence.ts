import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  chmodSync,
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
  RegistryPersistenceCommit,
  RegistryPersistenceRead,
} from './types.ts'

const STATE_FILE = 'module-registry.json'
const PENDING_FILE = 'module-registry.pending.json'
const LOCK_FILE = 'module-registry.lock'
const MAX_STATE_BYTES = 4 * 1024 * 1024
const NO_FOLLOW = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW

interface FilesystemIdentity {
  readonly dev: number
  readonly ino: number
}

function sameIdentity(left: FilesystemIdentity, right: FilesystemIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

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
  readonly #rootIdentity: FilesystemIdentity
  readonly #fault?: FilesystemModuleRegistryPersistenceOptions['faultInjector']

  constructor(trustedRoot: string, options: FilesystemModuleRegistryPersistenceOptions = {}) {
    if (!isAbsolute(trustedRoot)) throw new TypeError('Registry trusted root must be absolute')
    this.root = resolve(trustedRoot)
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    let rootInfo = lstatSync(this.root)
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()
      || (typeof process.getuid === 'function' && rootInfo.uid !== process.getuid())) {
      throw new TypeError('Registry trusted root must be a host-owned real directory')
    }
    if (process.platform !== 'win32') {
      chmodSync(this.root, 0o700)
      rootInfo = lstatSync(this.root)
    }
    this.#canonicalRoot = realpathSync(this.root)
    this.#rootIdentity = { dev: rootInfo.dev, ino: rootInfo.ino }
    this.#assertRoot()
    this.#fault = options.faultInjector
  }

  read(): RegistryPersistenceRead {
    this.#assertRoot()
    const writerActive = this.#safeExists(LOCK_FILE) && !this.#reclaimStaleLock()
    const pending = this.#safeExists(PENDING_FILE)
    const committed = this.#readCommitted()
    if (pending && !writerActive) {
      unlinkSync(this.#path(PENDING_FILE))
      this.#syncRoot()
    }
    return { ...committed, interruptedCommit: pending && !writerActive }
  }

  commit(state: PersistedModuleRegistryStateV1, expectedRevision: string): RegistryPersistenceCommit {
    this.#assertRoot()
    const lockToken = this.#acquireLock()
    let temporary: string | undefined
    try {
      this.#assertRoot()
      const current = this.#readCommitted()
      if (current.revision !== expectedRevision) return { ok: false, revision: current.revision }
      this.#writeExclusive(PENDING_FILE, state)
      this.#syncRoot()
      this.#fault?.('after-pending-sync')
      const serialized = this.#serialize(state)
      temporary = this.#path(`.${STATE_FILE}.${randomUUID()}.tmp`)
      const descriptor = openSync(temporary, exclusiveWriteFlags(), 0o600)
      let temporaryIdentity: FilesystemIdentity
      try {
        writeFileSync(descriptor, serialized)
        fsyncSync(descriptor)
        const opened = fstatSync(descriptor)
        temporaryIdentity = { dev: opened.dev, ino: opened.ino }
      } finally {
        closeSync(descriptor)
      }
      this.#assertRoot()
      const temporaryBeforeRename = lstatSync(temporary)
      if (!temporaryBeforeRename.isFile() || temporaryBeforeRename.isSymbolicLink()
        || !sameIdentity(temporaryIdentity!, temporaryBeforeRename)) {
        throw new Error('Registry temporary state identity changed before rename')
      }
      this.#assertSafeDestination(STATE_FILE)
      this.#fault?.('before-state-rename')
      this.#assertRoot()
      this.#assertSafeDestination(STATE_FILE)
      renameSync(temporary, this.#path(STATE_FILE))
      temporary = undefined
      this.#assertRoot()
      const committed = lstatSync(this.#path(STATE_FILE))
      if (!committed.isFile() || committed.isSymbolicLink() || !sameIdentity(temporaryIdentity!, committed)) {
        throw new Error('Registry committed state identity changed during rename')
      }
      this.#syncRoot()
      this.#fault?.('after-state-rename')
      unlinkSync(this.#path(PENDING_FILE))
      this.#syncRoot()
      return { ok: true, revision: this.#revision(serialized) }
    } finally {
      if (temporary) rmSync(temporary, { force: true })
      this.#releaseLock(lockToken)
      this.#syncRoot()
    }
  }

  #readCommitted(): { committed: unknown | null; revision: string } {
    const bytes = this.#readBytes(STATE_FILE)
    if (!bytes) return { committed: null, revision: this.#revision(null) }
    return {
      committed: JSON.parse(bytes.toString('utf8')) as unknown,
      revision: this.#revision(bytes),
    }
  }

  #readBytes(name: string): Buffer | null {
    if (!this.#safeExists(name)) return null
    const path = this.#path(name)
    const info = lstatSync(path)
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_STATE_BYTES) {
      throw new Error(`Unsafe registry persistence file: ${name}`)
    }
    if (name === STATE_FILE) this.#fault?.('after-state-lstat')
    const descriptor = openSync(path, constants.O_RDONLY | NO_FOLLOW)
    try {
      const opened = fstatSync(descriptor)
      if (!opened.isFile() || opened.size > MAX_STATE_BYTES || !sameIdentity(info, opened)) {
        throw new Error(`Unsafe registry persistence file: ${name}`)
      }
      const bytes = readFileSync(descriptor)
      if (bytes.byteLength > MAX_STATE_BYTES) throw new Error('Registry state exceeds size limit')
      return bytes
    } finally {
      closeSync(descriptor)
    }
  }

  #revision(bytes: Buffer | null): string {
    return createHash('sha256').update(bytes ?? 'empty-registry-state').digest('hex')
  }

  #writeExclusive(name: string, state: PersistedModuleRegistryStateV1): void {
    const descriptor = openSync(this.#path(name), exclusiveWriteFlags(), 0o600)
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
      const descriptor = openSync(candidate, exclusiveWriteFlags(), 0o600)
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
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1_024) throw new Error('Registry writer lock is invalid')
    const descriptor = openSync(path, constants.O_RDONLY | NO_FOLLOW)
    try {
      const opened = fstatSync(descriptor)
      if (!opened.isFile() || opened.size > 1_024 || !sameIdentity(info, opened)) throw new Error('Registry writer lock is invalid')
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
    if (!info.isDirectory() || info.isSymbolicLink() || !sameIdentity(info, this.#rootIdentity)
      || realpathSync(this.root) !== this.#canonicalRoot
      || (typeof process.getuid === 'function' && info.uid !== process.getuid())
      || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) {
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

function exclusiveWriteFlags(): 'wx' | number {
  return process.platform === 'win32'
    ? 'wx'
    : constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW
}
