import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  lstat,
  link,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
} from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { parseModuleCoordinatorState } from './state-schema.ts'
import {
  ModuleCoordinatorError,
  type ModuleCoordinatorState,
  type ModuleCoordinatorStore,
} from './types.ts'

const STATE_FILE = 'module-coordinator.json'
const LOCK_FILE = 'module-coordinator.lock'
const MAX_STATE_BYTES = 16 * 1024 * 1024

export type NodeCoordinatorStoreFaultPoint =
  | 'after-state-lstat'
  | 'after-temp-open'
  | 'before-state-rename'

export interface NodeFilesystemModuleCoordinatorStoreOptions {
  readonly faultInjector?: (point: NodeCoordinatorStoreFaultPoint) => void | Promise<void>
}

/** Durable single-writer state store rooted in a host-selected trusted directory. */
export class NodeFilesystemModuleCoordinatorStore implements ModuleCoordinatorStore {
  readonly root: string
  readonly path: string
  readonly #ready: Promise<string>
  readonly #fault?: NodeFilesystemModuleCoordinatorStoreOptions['faultInjector']

  constructor(trustedRoot: string, options: NodeFilesystemModuleCoordinatorStoreOptions = {}) {
    if (!isAbsolute(trustedRoot)) throw new TypeError('Coordinator trusted root must be absolute')
    this.root = resolve(trustedRoot)
    this.path = join(this.root, STATE_FILE)
    this.#fault = options.faultInjector
    this.#ready = this.#initializeRoot()
  }

  async load(): Promise<ModuleCoordinatorState | undefined> {
    await this.#assertRoot()
    let info
    try {
      info = await lstat(this.path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_STATE_BYTES) this.#corrupt('state path is not a bounded regular file')
    await this.#fault?.('after-state-lstat')
    let handle
    try {
      handle = await open(this.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    } catch (error) {
      this.#corrupt(`state file could not be opened safely: ${this.#message(error)}`)
    }
    try {
      const opened = await handle.stat()
      if (!opened.isFile() || opened.size > MAX_STATE_BYTES) this.#corrupt('opened state is not a bounded regular file')
      const bytes = await handle.readFile()
      if (bytes.byteLength > MAX_STATE_BYTES) this.#corrupt('state exceeds the size limit')
      try {
        return structuredClone(parseModuleCoordinatorState(JSON.parse(bytes.toString('utf8')) as unknown))
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
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
      temporaryExists = true
      try {
        await this.#fault?.('after-temp-open')
        await handle.writeFile(serialized)
        await handle.sync()
      } finally {
        await handle.close()
      }
      await this.#assertRoot()
      await this.#assertSafeDestination()
      await this.#fault?.('before-state-rename')
      await rename(temporary, this.path)
      temporaryExists = false
      await this.#syncRoot()
    } finally {
      if (temporaryExists) await unlink(temporary).catch(() => undefined)
      await this.#releaseLock(lockToken)
      await this.#syncRoot().catch(() => undefined)
    }
  }

  async #initializeRoot(): Promise<string> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const info = await lstat(this.root)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new TypeError('Coordinator trusted root must be a real directory')
    return realpath(this.root)
  }

  async #assertRoot(): Promise<void> {
    const canonical = await this.#ready
    const info = await lstat(this.root)
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(this.root) !== canonical) {
      throw new ModuleCoordinatorError('STORE_CORRUPT', 'Coordinator trusted root changed')
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
      const handle = await open(candidate, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
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
    try {
      handle = await open(lock, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
      this.#corrupt(`writer lock could not be opened safely: ${this.#message(error)}`)
    }
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.size > 1_024) this.#corrupt('writer lock is invalid')
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
    let input: unknown
    try {
      input = JSON.parse(await readFile(lock, 'utf8')) as unknown
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    if (input === null || typeof input !== 'object' || (input as { token?: unknown }).token !== token) {
      throw new ModuleCoordinatorError('STORE_CORRUPT', 'Coordinator writer lock ownership changed')
    }
    await unlink(lock)
  }

  async #syncRoot(): Promise<void> {
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
