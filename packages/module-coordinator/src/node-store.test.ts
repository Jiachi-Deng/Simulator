import { afterEach, describe, expect, it } from 'bun:test'
import { execFile } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { NodeFilesystemModuleCoordinatorStore } from './node-store.ts'
import { MODULE_COORDINATOR_STATE_SCHEMA_VERSION, ModuleCoordinatorError, type ModuleCoordinatorState } from './types.ts'

const roots: string[] = []
const execFileAsync = promisify(execFile)
const EMPTY_STATE: ModuleCoordinatorState = Object.freeze({
  schemaVersion: MODULE_COORDINATOR_STATE_SCHEMA_VERSION,
  operations: [],
  events: [],
})

async function root(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'simulator-module-coordinator-store-'))
  const value = join(parent, 'state')
  await mkdir(value, { mode: 0o700 })
  roots.push(parent)
  return value
}

async function shortPath(path: string): Promise<string | undefined> {
  if (process.platform !== 'win32') return undefined
  const { stdout } = await execFileAsync('cmd.exe', ['/d', '/c', `for %I in ("${path}") do @echo %~sI`])
  const value = stdout.trim()
  if (value.length === 0 || value === path) return undefined
  if (!isAbsolute(value)) throw new Error(`cmd.exe returned an invalid short path: ${JSON.stringify(value)}`)
  return value
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })))
})

describe('NodeFilesystemModuleCoordinatorStore', () => {
  it('defers root creation until an operation awaits initialization', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'simulator-module-coordinator-store-lazy-'))
    roots.push(parent)
    const directory = join(parent, 'state')
    const store = new NodeFilesystemModuleCoordinatorStore(directory)
    await expect(lstat(directory)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await store.load()).toBeUndefined()
    await store.save(EMPTY_STATE)
    expect(await store.load()).toEqual(EMPTY_STATE)
  })

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

  it('rejects a cross-platform regular-file substitution between lstat and open', async () => {
    const directory = await root()
    const statePath = join(directory, 'module-coordinator.json')
    const displaced = join(directory, 'displaced.json')
    await writeFile(statePath, JSON.stringify(EMPTY_STATE))
    let replaced = false
    const store = new NodeFilesystemModuleCoordinatorStore(directory, {
      async faultInjector(point) {
        if (point !== 'after-state-lstat' || replaced) return
        replaced = true
        await rename(statePath, displaced)
        await writeFile(statePath, JSON.stringify(EMPTY_STATE))
      },
    })
    await expect(store.load()).rejects.toMatchObject({ code: 'STORE_CORRUPT' })
  })

  it('pins the trusted root device and inode across operations', async () => {
    const directory = await root()
    const displaced = `${directory}-displaced`
    roots.push(displaced)
    const store = new NodeFilesystemModuleCoordinatorStore(directory)
    await store.save(EMPTY_STATE)
    await rename(directory, displaced)
    await mkdir(directory, { mode: 0o700 })
    await expect(store.load()).rejects.toMatchObject({ code: 'STORE_CORRUPT' })
  })

  it('pins every ancestor below an explicit host-owned trust boundary', async () => {
    const boundary = await mkdtemp(join(tmpdir(), 'simulator-module-coordinator-boundary-'))
    roots.push(boundary)
    const ancestor = join(boundary, 'owned-parent')
    const directory = join(ancestor, 'state')
    const displaced = join(boundary, 'owned-parent-displaced')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const store = new NodeFilesystemModuleCoordinatorStore(directory, { trustedBoundary: boundary })
    await store.save(EMPTY_STATE)

    await rename(ancestor, displaced)
    await mkdir(directory, { recursive: true, mode: 0o700 })

    await expect(store.load()).rejects.toMatchObject({ code: 'STORE_CORRUPT' })
  })

  it('keeps pinned identities stable across equivalent Windows short and long paths', async () => {
    const directory = await root()
    const longPath = await realpath(directory)
    const alias = await shortPath(longPath)
    if (!alias) return

    const shortStore = new NodeFilesystemModuleCoordinatorStore(alias)
    const longStore = new NodeFilesystemModuleCoordinatorStore(longPath)
    await shortStore.save(EMPTY_STATE)
    expect(await longStore.load()).toEqual(EMPTY_STATE)
    await Promise.all([shortStore.save(EMPTY_STATE), longStore.load()])
    expect(await new NodeFilesystemModuleCoordinatorStore(longPath).load()).toEqual(EMPTY_STATE)
  })

  it('rejects a writable trust boundary instead of silently trusting it', async () => {
    if (process.platform === 'win32') return
    const boundary = await mkdtemp(join(tmpdir(), 'simulator-module-coordinator-boundary-'))
    roots.push(boundary)
    const directory = join(boundary, 'state')
    await chmod(boundary, 0o777)
    const store = new NodeFilesystemModuleCoordinatorStore(directory, { trustedBoundary: boundary })
    await expect(store.load()).rejects.toThrow('owner-only')
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

  it('fails closed on a destination symlink introduced before atomic rename', async () => {
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
    await expect(store.save(EMPTY_STATE)).rejects.toMatchObject({ code: 'STORE_CORRUPT' })
    expect(await readFile(external, 'utf8')).toBe('untouched')
  })
})
