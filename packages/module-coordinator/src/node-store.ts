import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  chmod,
  lstat,
  link,
  mkdir,
  open,
  realpath,
  rename,
  rm,
  unlink,
} from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { parseModuleCoordinatorState } from './state-schema.ts'
import {
  ModuleCoordinatorError,
  type ModuleCoordinatorState,
  type ModuleCoordinatorStore,
} from './types.ts'

const STATE_FILE = 'module-coordinator.json'
const LOCK_FILE = 'module-coordinator.lock'
const MAX_STATE_BYTES = 16 * 1024 * 1024
const NO_FOLLOW = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW

// Windows file identifiers can exceed Number.MAX_SAFE_INTEGER. Keeping the
// identity as bigint prevents distinct trusted paths from comparing equal.
interface FilesystemIdentity {
  readonly dev: bigint
  readonly ino: bigint
}

interface RootIdentity extends FilesystemIdentity {
  readonly path: string
  readonly canonical: string
}

function sameIdentity(left: FilesystemIdentity, right: FilesystemIdentity): boolean {
  // An unavailable zero inode cannot prove identity, so reject it instead of
  // silently weakening the trusted-root and lstat/open substitution checks.
  return left.ino !== 0n && left.dev === right.dev && left.ino === right.ino
}

export type NodeCoordinatorStoreFaultPoint =
  | 'after-state-lstat'
  | 'after-temp-open'
  | 'before-state-rename'

export interface NodeFilesystemModuleCoordinatorStoreOptions {
  readonly faultInjector?: (point: NodeCoordinatorStoreFaultPoint) => void | Promise<void>
  /** Host-owned, non-group/world-writable ancestor that defines the mutable trust boundary. */
  readonly trustedBoundary?: string
}

/** Durable single-writer state store rooted in a host-selected trusted directory. */
export class NodeFilesystemModuleCoordinatorStore implements ModuleCoordinatorStore {
  readonly root: string
  readonly path: string
  readonly #trustedBoundary: string
  #ready?: Promise<readonly RootIdentity[]>
  readonly #fault?: NodeFilesystemModuleCoordinatorStoreOptions['faultInjector']

  constructor(trustedRoot: string, options: NodeFilesystemModuleCoordinatorStoreOptions = {}) {
    if (!isAbsolute(trustedRoot)) throw new TypeError('Coordinator trusted root must be absolute')
    this.root = resolve(trustedRoot)
    this.#trustedBoundary = resolve(options.trustedBoundary ?? dirname(this.root))
    const fromBoundary = relative(this.#trustedBoundary, this.root)
    if (!fromBoundary || fromBoundary.startsWith('..') || isAbsolute(fromBoundary)) {
      throw new TypeError('Coordinator trusted boundary must be a strict ancestor of the store root')
    }
    this.path = join(this.root, STATE_FILE)
    this.#fault = options.faultInjector
  }

  async load(): Promise<ModuleCoordinatorState | undefined> {
    await this.#assertRoot()
    let info
    try {
      info = await lstat(this.path, { bigint: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        await this.#assertRoot()
        return undefined
      }
      throw error
    }
    if (!info.isFile() || info.isSymbolicLink() || info.size > BigInt(MAX_STATE_BYTES)) this.#corrupt('state path is not a bounded regular file')
    await this.#fault?.('after-state-lstat')
    let handle
    try {
      handle = await open(this.path, constants.O_RDONLY | NO_FOLLOW)
    } catch (error) {
      this.#corrupt(`state file could not be opened safely: ${this.#message(error)}`)
    }
    try {
      const opened = await handle.stat({ bigint: true })
      if (!opened.isFile() || opened.size > BigInt(MAX_STATE_BYTES) || !sameIdentity(info, opened)) {
        this.#corrupt('opened state identity changed after validation')
      }
      const bytes = await handle.readFile()
      if (bytes.byteLength > MAX_STATE_BYTES) this.#corrupt('state exceeds the size limit')
      try {
        const state = structuredClone(parseModuleCoordinatorState(JSON.parse(bytes.toString('utf8')) as unknown))
        await this.#assertRoot()
        return state
      } catch (error) {
        this.#corrupt(this.#message(error))
      }
    } finally {
      await handle.close()
    }
  }

  async save(state: ModuleCoordinatorState): Promise<void> {
    await this.#assertRoot()
    let validated: ModuleCoordinatorState
    try {
      validated = parseModuleCoordinatorState(structuredClone(state))
    } catch (error) {
      this.#corrupt(`refusing to persist invalid state: ${this.#message(error)}`)
    }
    const serialized = Buffer.from(`${JSON.stringify(validated)}\n`, 'utf8')
    if (serialized.byteLength > MAX_STATE_BYTES) this.#corrupt('state exceeds the size limit')
    const lockToken = await this.#acquireLock()
    const temporary = join(this.root, `.${STATE_FILE}.${randomUUID()}.tmp`)
    let temporaryExists = false
    try {
      await this.#assertRoot()
      const handle = await open(temporary, exclusiveWriteFlags(), 0o600)
      temporaryExists = true
      let temporaryIdentity: FilesystemIdentity
      try {
        await this.#fault?.('after-temp-open')
        await handle.writeFile(serialized)
        await handle.sync()
        temporaryIdentity = await handle.stat({ bigint: true })
      } finally {
        await handle.close()
      }
      await this.#assertRoot()
      const temporaryBeforeRename = await lstat(temporary, { bigint: true })
      if (!temporaryBeforeRename.isFile() || temporaryBeforeRename.isSymbolicLink()
        || !sameIdentity(temporaryIdentity!, temporaryBeforeRename)) {
        this.#corrupt('temporary state identity changed before rename')
      }
      await this.#assertSafeDestination()
      await this.#fault?.('before-state-rename')
      await this.#assertRoot()
      await this.#assertSafeDestination()
      await rename(temporary, this.path)
      temporaryExists = false
      await this.#assertRoot()
      const committed = await lstat(this.path, { bigint: true })
      if (!committed.isFile() || committed.isSymbolicLink() || !sameIdentity(temporaryIdentity!, committed)) {
        this.#corrupt('committed state identity changed during rename')
      }
      await this.#syncRoot()
      await this.#assertRoot()
    } finally {
      if (temporaryExists) await unlink(temporary).catch(() => undefined)
      await this.#releaseLock(lockToken)
      await this.#syncRoot().catch(() => undefined)
    }
  }

  async #initializeRoot(): Promise<readonly RootIdentity[]> {
    const identities: RootIdentity[] = [await this.#directoryIdentity(this.#trustedBoundary, false)]
    let current = this.#trustedBoundary
    for (const part of relative(this.#trustedBoundary, this.root).split(/[\\/]+/)) {
      current = join(current, part)
      try {
        await mkdir(current, { mode: 0o700 })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      identities.push(await this.#directoryIdentity(current, true))
    }
    await this.#assertIdentities(identities)
    return Object.freeze(identities)
  }

  async #assertRoot(): Promise<void> {
    const identities = await (this.#ready ??= this.#initializeRoot())
    await this.#assertIdentities(identities)
  }

  async #directoryIdentity(path: string, enforceOwnerOnly: boolean): Promise<RootIdentity> {
    let info = await lstat(path, { bigint: true })
    if (!info.isDirectory() || info.isSymbolicLink()) throw new TypeError('Coordinator trust path must be a real directory')
    if (typeof process.getuid === 'function' && info.uid !== BigInt(process.getuid())) {
      throw new TypeError('Coordinator trust path must be owned by the host user')
    }
    if (process.platform !== 'win32' && enforceOwnerOnly) {
      await chmod(path, 0o700)
      info = await lstat(path, { bigint: true })
    }
    if (process.platform !== 'win32' && (info.mode & 0o077n) !== 0n) {
      throw new TypeError('Coordinator trusted boundary and descendants must be owner-only')
    }
    const canonical = await realpath(path)
    return { path: canonical, canonical, dev: info.dev, ino: info.ino }
  }

  async #assertIdentities(expected: readonly RootIdentity[]): Promise<void> {
    for (const identity of expected) {
      let info
      try {
        info = await lstat(identity.path, { bigint: true })
      } catch {
        throw new ModuleCoordinatorError('STORE_CORRUPT', 'Coordinator trusted ancestor changed')
      }
      if (!info.isDirectory() || info.isSymbolicLink() || !sameIdentity(info, identity)
        || (process.platform !== 'win32' && await realpath(identity.path) !== identity.canonical)
        || (typeof process.getuid === 'function' && info.uid !== BigInt(process.getuid()))
        || (process.platform !== 'win32' && (info.mode & 0o077n) !== 0n)) {
        throw new ModuleCoordinatorError('STORE_CORRUPT', 'Coordinator trusted ancestor changed')
      }
    }
  }

  async #assertSafeDestination(): Promise<void> {
    try {
      const info = await lstat(this.path)
      if (!info.isFile() || info.isSymbolicLink()) this.#corrupt('state destination is not a regular file')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  async #acquireLock(): Promise<string> {
    const lock = join(this.root, LOCK_FILE)
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = randomUUID()
      const candidate = join(this.root, `.${LOCK_FILE}.${token}.tmp`)
      const handle = await open(candidate, exclusiveWriteFlags(), 0o600)
      try {
        await handle.writeFile(`${JSON.stringify({ pid: process.pid, token })}\n`, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      try {
        await link(candidate, lock)
        await unlink(candidate)
        await this.#syncRoot()
        return token
      } catch (error) {
        await unlink(candidate).catch(() => undefined)
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        if (attempt === 1 || !await this.#reclaimStaleLock()) {
          throw new ModuleCoordinatorError('INVALID_OPERATION', 'Another coordinator store writer is active')
        }
      }
    }
    throw new ModuleCoordinatorError('INVALID_OPERATION', 'Could not acquire coordinator store writer lock')
  }

  async #reclaimStaleLock(): Promise<boolean> {
    const lock = join(this.root, LOCK_FILE)
    let owner: { pid: number; token: string }
    let handle
    let beforeOpen
    try {
      beforeOpen = await lstat(lock, { bigint: true })
      if (!beforeOpen.isFile() || beforeOpen.isSymbolicLink()) this.#corrupt('writer lock is invalid')
      handle = await open(lock, constants.O_RDONLY | NO_FOLLOW)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
      this.#corrupt(`writer lock could not be opened safely: ${this.#message(error)}`)
    }
    try {
      const info = await handle.stat({ bigint: true })
      if (!info.isFile() || info.size > 1_024n || !sameIdentity(beforeOpen, info)) this.#corrupt('writer lock is invalid')
      const parsed = JSON.parse((await handle.readFile()).toString('utf8')) as unknown
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) this.#corrupt('writer lock owner is invalid')
      const value = parsed as Record<string, unknown>
      if (Object.keys(value).length !== 2 || !Number.isSafeInteger(value.pid) || (value.pid as number) <= 0
        || typeof value.token !== 'string' || !/^[a-f0-9-]{36}$/.test(value.token)) this.#corrupt('writer lock owner is invalid')
      owner = { pid: value.pid as number, token: value.token }
    } catch (error) {
      if (error instanceof ModuleCoordinatorError) throw error
      this.#corrupt(`writer lock owner is invalid: ${this.#message(error)}`)
    } finally {
      await handle.close()
    }
    try {
      process.kill(owner.pid, 0)
      return false
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EPERM') return false
      if (code !== 'ESRCH') throw error
    }
    const stale = join(this.root, `.${LOCK_FILE}.${owner.token}.stale`)
    try {
      await rename(lock, stale)
      await unlink(stale)
      await this.#syncRoot()
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
      throw error
    }
  }

  async #releaseLock(token: string): Promise<void> {
    const lock = join(this.root, LOCK_FILE)
    let handle
    try {
      const beforeOpen = await lstat(lock, { bigint: true })
      if (!beforeOpen.isFile() || beforeOpen.isSymbolicLink()) this.#corrupt('writer lock is invalid')
      handle = await open(lock, constants.O_RDONLY | NO_FOLLOW)
      const opened = await handle.stat({ bigint: true })
      if (!sameIdentity(beforeOpen, opened)) this.#corrupt('writer lock identity changed')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    let input: unknown
    try {
      input = JSON.parse((await handle.readFile()).toString('utf8')) as unknown
    } finally {
      await handle.close()
    }
    if (input === null || typeof input !== 'object' || (input as { token?: unknown }).token !== token) {
      throw new ModuleCoordinatorError('STORE_CORRUPT', 'Coordinator writer lock ownership changed')
    }
    await unlink(lock)
  }

  async #syncRoot(): Promise<void> {
    if (process.platform === 'win32') return
    const handle = await open(this.root, constants.O_RDONLY)
    try {
      await handle.sync()
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EISDIR' && code !== 'EPERM') throw error
    } finally {
      await handle.close()
    }
  }

  #corrupt(message: string): never {
    throw new ModuleCoordinatorError('STORE_CORRUPT', `Coordinator state is invalid: ${message}`)
  }

  #message(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }
}

function exclusiveWriteFlags(): 'wx' | number {
  return process.platform === 'win32'
    ? 'wx'
    : constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW
}
