import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import {
  MODULE_COORDINATOR_STATE_SCHEMA_VERSION,
  ModuleCoordinatorError,
  type ModuleCoordinatorState,
  type ModuleCoordinatorStore,
} from './types.ts'

/** A small atomic JSON store used by hosts that want durable coordinator recovery. */
export class NodeFilesystemModuleCoordinatorStore implements ModuleCoordinatorStore {
  readonly path: string

  constructor(path: string) {
    if (!isAbsolute(path)) throw new TypeError('Coordinator state path must be absolute')
    this.path = resolve(path)
  }

  async load(): Promise<ModuleCoordinatorState | undefined> {
    let input: string
    try {
      input = await readFile(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    try {
      const state = JSON.parse(input) as ModuleCoordinatorState
      if (state?.schemaVersion !== MODULE_COORDINATOR_STATE_SCHEMA_VERSION
        || !Array.isArray(state.operations) || !Array.isArray(state.events)) {
        throw new Error('schema mismatch')
      }
      return structuredClone(state)
    } catch (error) {
      throw new ModuleCoordinatorError('STORE_CORRUPT', `Coordinator state is invalid: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async save(state: ModuleCoordinatorState): Promise<void> {
    const directory = dirname(this.path)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.${randomUUID()}.tmp`
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(state)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, this.path)
    const directoryHandle = await open(directory, 'r')
    try {
      await directoryHandle.sync()
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EISDIR' && code !== 'EPERM') throw error
    } finally {
      await directoryHandle.close()
    }
  }
}
