import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeFilesystemModuleCoordinatorStore } from './node-store.ts'
import { MODULE_COORDINATOR_STATE_SCHEMA_VERSION, ModuleCoordinatorError, type ModuleCoordinatorState } from './types.ts'

const roots: string[] = []
const EMPTY_STATE: ModuleCoordinatorState = Object.freeze({
  schemaVersion: MODULE_COORDINATOR_STATE_SCHEMA_VERSION,
  operations: [],
  events: [],
})

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'simulator-module-coordinator-store-'))
  roots.push(value)
  return value
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })))
})

describe('NodeFilesystemModuleCoordinatorStore', () => {
  it('requires a trusted absolute root and persists a validated state atomically', async () => {
    expect(() => new NodeFilesystemModuleCoordinatorStore('relative')).toThrow(TypeError)
    const directory = await root()
    const store = new NodeFilesystemModuleCoordinatorStore(directory)
    await store.save(EMPTY_STATE)
    expect(await new NodeFilesystemModuleCoordinatorStore(directory).load()).toEqual(EMPTY_STATE)
  })

  it.each([
    ['unknown field', { ...EMPTY_STATE, injected: true }],
    ['wrong schema', { ...EMPTY_STATE, schemaVersion: 1 }],
    ['non-array operations', { ...EMPTY_STATE, operations: {} }],
  ])('fails closed for %s', async (_name, state) => {
    const directory = await root()
    await writeFile(join(directory, 'module-coordinator.json'), JSON.stringify(state))
    await expect(new NodeFilesystemModuleCoordinatorStore(directory).load()).rejects.toMatchObject({
      code: 'STORE_CORRUPT',
    })
  })

  it('rejects a symlinked state file', async () => {
    const directory = await root()
    const external = join(await root(), 'external.json')
    await writeFile(external, JSON.stringify(EMPTY_STATE))
    await symlink(external, join(directory, 'module-coordinator.json'))
    await expect(new NodeFilesystemModuleCoordinatorStore(directory).load()).rejects.toBeInstanceOf(ModuleCoordinatorError)
  })

  it('rejects a lstat/open symlink substitution race', async () => {
    if (process.platform === 'win32') return
    const directory = await root()
    const external = join(await root(), 'external.json')
    const statePath = join(directory, 'module-coordinator.json')
    await writeFile(external, JSON.stringify(EMPTY_STATE))
    await writeFile(statePath, JSON.stringify(EMPTY_STATE))
    let replaced = false
    const store = new NodeFilesystemModuleCoordinatorStore(directory, {
      async faultInjector(point) {
        if (point !== 'after-state-lstat' || replaced) return
        replaced = true
        await rm(statePath)
        await symlink(external, statePath)
      },
    })
    await expect(store.load()).rejects.toMatchObject({ code: 'STORE_CORRUPT' })
  })

  it('serializes writers across store instances', async () => {
    const directory = await root()
    let entered!: () => void
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { entered = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    const first = new NodeFilesystemModuleCoordinatorStore(directory, {
      async faultInjector(point) {
        if (point !== 'after-temp-open') return
        entered()
        await gate
      },
    })
    const saving = first.save(EMPTY_STATE)
    await blocked
    await expect(new NodeFilesystemModuleCoordinatorStore(directory).save(EMPTY_STATE)).rejects.toThrow('writer is active')
    release()
    await saving
    expect(await first.load()).toEqual(EMPTY_STATE)
  })

  it('reclaims a writer lock left by a dead process', async () => {
    const directory = await root()
    await writeFile(join(directory, 'module-coordinator.lock'), `${JSON.stringify({
      pid: 2_147_483_647,
      token: '00000000-0000-4000-8000-000000000000',
    })}\n`)
    const store = new NodeFilesystemModuleCoordinatorStore(directory)
    await store.save(EMPTY_STATE)
    expect(await store.load()).toEqual(EMPTY_STATE)
  })

  it('atomically replaces a destination symlink without touching its target', async () => {
    if (process.platform === 'win32') return
    const directory = await root()
    const external = join(await root(), 'external.json')
    await writeFile(external, 'untouched')
    let injected = false
    const store = new NodeFilesystemModuleCoordinatorStore(directory, {
      async faultInjector(point) {
        if (point !== 'before-state-rename' || injected) return
        injected = true
        await symlink(external, join(directory, 'module-coordinator.json'))
      },
    })
    await store.save(EMPTY_STATE)
    expect(await readFile(external, 'utf8')).toBe('untouched')
    expect(await store.load()).toEqual(EMPTY_STATE)
  })
})
