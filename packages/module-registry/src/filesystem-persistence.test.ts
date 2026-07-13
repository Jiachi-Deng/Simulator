import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseModuleManifest } from '@simulator/module-contract'
import { FilesystemModuleRegistryPersistence } from './filesystem-persistence.ts'
import { ModuleRegistry } from './registry.ts'

const roots: string[] = []
const HOST = Object.freeze({ version: '0.11.1', platform: 'darwin-arm64' as const })

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'simulator-module-registry-'))
  roots.push(value)
  return value
}

function manifest(version = '1.0.0') {
  const parsed = parseModuleManifest({
    schemaVersion: 1,
    id: 'org.simulator.filesystem-registry',
    version,
    artifacts: [{
      platform: 'darwin-arm64',
      entrypoint: 'bin/module',
      url: `https://modules.example.test/${version}.tar.gz`,
      sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    }],
    capabilities: [],
  })
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors))
  return parsed.value
}

function install(registry: ModuleRegistry, version = '1.0.0'): void {
  expect(registry.install(manifest(version), { hostVersionRange: '*' }).ok).toBe(true)
  expect(registry.activate('org.simulator.filesystem-registry', version).ok).toBe(true)
  expect(registry.markLastKnownGood('org.simulator.filesystem-registry', version).ok).toBe(true)
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { force: true, recursive: true })
})

describe('FilesystemModuleRegistryPersistence', () => {
  it('restores committed registry state in a new registry instance', () => {
    const directory = root()
    const first = new ModuleRegistry(HOST, new FilesystemModuleRegistryPersistence(directory))
    install(first)

    const restarted = new ModuleRegistry(HOST, new FilesystemModuleRegistryPersistence(directory))
    expect(restarted.snapshot().modules[0]).toMatchObject({
      activeVersion: '1.0.0',
      lastKnownGoodVersion: '1.0.0',
    })
  })

  it.each(['after-pending-sync', 'after-state-rename'] as const)(
    'recovers a commit interrupted at %s without accepting corrupt state',
    (faultPoint) => {
      const directory = root()
      const persistence = new FilesystemModuleRegistryPersistence(directory, {
        faultInjector(point) {
          if (point === faultPoint) throw new Error(`crash:${point}`)
        },
      })
      const registry = new ModuleRegistry(HOST, persistence)
      const result = registry.install(manifest(), { hostVersionRange: '*' })
      expect(result.ok).toBe(false)
      expect(result.diagnostics[0]?.code).toBe('PERSISTENCE_WRITE_FAILED')

      const restarted = new ModuleRegistry(HOST, new FilesystemModuleRegistryPersistence(directory))
      const versions = restarted.snapshot().modules[0]?.versions.map((entry) => entry.version) ?? []
      expect(versions).toEqual(faultPoint === 'after-state-rename' ? ['1.0.0'] : [])
      expect(restarted.snapshot().diagnostics.map((item) => item.code)).toContain('RECOVERY_INTERRUPTED_COMMIT')
    },
  )

  it('advances the committed revision across a crash after rename so a stale writer cannot overwrite it', () => {
    const directory = root()
    const stale = new ModuleRegistry(HOST, new FilesystemModuleRegistryPersistence(directory))
    let crashed = false
    const crashing = new ModuleRegistry(HOST, new FilesystemModuleRegistryPersistence(directory, {
      faultInjector(point) {
        if (point === 'after-state-rename' && !crashed) {
          crashed = true
          throw new Error('simulated process death after durable rename')
        }
      },
    }))

    expect(crashing.install(manifest('1.0.0'), { hostVersionRange: '*' }).diagnostics[0]?.code)
      .toBe('PERSISTENCE_WRITE_FAILED')
    const conflict = stale.install(manifest('2.0.0'), { hostVersionRange: '*' })
    expect(conflict.diagnostics[0]?.code).toBe('PERSISTENCE_CONFLICT')
    expect(conflict.snapshot.modules[0]?.versions.map((entry) => entry.version)).toEqual(['1.0.0'])
  })

  it('rejects a symlinked committed state instead of following it', () => {
    const directory = root()
    const external = join(root(), 'external.json')
    writeFileSync(external, '{}')
    const first = new ModuleRegistry(HOST, new FilesystemModuleRegistryPersistence(directory))
    install(first)
    rmSync(join(directory, 'module-registry.json'))
    symlinkSync(external, join(directory, 'module-registry.json'))

    expect(() => new FilesystemModuleRegistryPersistence(directory).read()).toThrow('symlink')
  })

  it('excludes concurrent writers and reclaims a dead writer lock', () => {
    const directory = root()
    const second = new FilesystemModuleRegistryPersistence(directory)
    const emptyRevision = second.read().revision
    let checked = false
    const first = new FilesystemModuleRegistryPersistence(directory, {
      faultInjector(point) {
        if (point !== 'after-pending-sync' || checked) return
        checked = true
        expect(() => second.commit({ schemaVersion: 1, host: HOST, modules: [] }, emptyRevision)).toThrow('writer is active')
        expect(new ModuleRegistry(HOST, second).snapshot()).toMatchObject({ modules: [], diagnostics: [] })
        expect(readFileSync(join(directory, 'module-registry.pending.json'), 'utf8')).toContain('schemaVersion')
      },
    })
    first.commit({ schemaVersion: 1, host: HOST, modules: [] }, emptyRevision)

    writeFileSync(join(directory, 'module-registry.lock'), `${JSON.stringify({
      pid: 2_147_483_647,
      token: '00000000-0000-4000-8000-000000000000',
    })}\n`)
    second.commit({ schemaVersion: 1, host: HOST, modules: [] }, second.read().revision)
    expect(new ModuleRegistry(HOST, second).snapshot().modules).toHaveLength(0)
  })

  it('rejects a sequential stale writer without losing the first committed version', () => {
    const directory = root()
    const first = new ModuleRegistry(HOST, new FilesystemModuleRegistryPersistence(directory))
    const stale = new ModuleRegistry(HOST, new FilesystemModuleRegistryPersistence(directory))

    expect(first.install(manifest('1.0.0'), { hostVersionRange: '*' }).ok).toBe(true)
    const conflict = stale.install(manifest('2.0.0'), { hostVersionRange: '*' })
    expect(conflict.diagnostics[0]?.code).toBe('PERSISTENCE_CONFLICT')
    expect(conflict.snapshot.modules[0]?.versions.map((entry) => entry.version)).toEqual(['1.0.0'])

    expect(stale.install(manifest('2.0.0'), { hostVersionRange: '*' }).ok).toBe(true)
    expect(new ModuleRegistry(HOST, new FilesystemModuleRegistryPersistence(directory))
      .snapshot().modules[0]?.versions.map((entry) => entry.version)).toEqual(['1.0.0', '2.0.0'])
  })

  it('fails closed when stale activate and remove operations conflict with a newer snapshot', () => {
    const directory = root()
    const setup = new ModuleRegistry(HOST, new FilesystemModuleRegistryPersistence(directory))
    expect(setup.install(manifest('1.0.0'), { hostVersionRange: '*' }).ok).toBe(true)
    expect(setup.install(manifest('2.0.0'), { hostVersionRange: '*' }).ok).toBe(true)

    const activator = new ModuleRegistry(HOST, new FilesystemModuleRegistryPersistence(directory))
    const staleActivator = new ModuleRegistry(HOST, new FilesystemModuleRegistryPersistence(directory))
    const staleRemover = new ModuleRegistry(HOST, new FilesystemModuleRegistryPersistence(directory))
    expect(activator.activate('org.simulator.filesystem-registry', '1.0.0').ok).toBe(true)
    expect(staleActivator.activate('org.simulator.filesystem-registry', '2.0.0').diagnostics[0]?.code)
      .toBe('PERSISTENCE_CONFLICT')
    expect(staleRemover.remove('org.simulator.filesystem-registry', '1.0.0').diagnostics[0]?.code)
      .toBe('PERSISTENCE_CONFLICT')

    const committed = new ModuleRegistry(HOST, new FilesystemModuleRegistryPersistence(directory)).snapshot().modules[0]
    expect(committed?.activeVersion).toBe('1.0.0')
    expect(committed?.versions.map((entry) => entry.version)).toEqual(['1.0.0', '2.0.0'])
  })

  it('serializes concurrent registry instances and permits an explicit retry from the refreshed snapshot', () => {
    const directory = root()
    const second = new ModuleRegistry(HOST, new FilesystemModuleRegistryPersistence(directory))
    let nested: ReturnType<ModuleRegistry['install']> | undefined
    const first = new ModuleRegistry(HOST, new FilesystemModuleRegistryPersistence(directory, {
      faultInjector(point) {
        if (point === 'after-pending-sync' && !nested) {
          nested = second.install(manifest('2.0.0'), { hostVersionRange: '*' })
        }
      },
    }))

    expect(first.install(manifest('1.0.0'), { hostVersionRange: '*' }).ok).toBe(true)
    expect(nested?.diagnostics[0]?.code).toBe('PERSISTENCE_WRITE_FAILED')
    expect(second.install(manifest('2.0.0'), { hostVersionRange: '*' }).diagnostics[0]?.code)
      .toBe('PERSISTENCE_CONFLICT')
    expect(second.install(manifest('2.0.0'), { hostVersionRange: '*' }).ok).toBe(true)
    expect(new ModuleRegistry(HOST, new FilesystemModuleRegistryPersistence(directory))
      .snapshot().modules[0]?.versions.map((entry) => entry.version)).toEqual(['1.0.0', '2.0.0'])
  })

  it('rejects a lstat/open substitution race via O_NOFOLLOW', () => {
    if (process.platform === 'win32') return
    const directory = root()
    const first = new ModuleRegistry(HOST, new FilesystemModuleRegistryPersistence(directory))
    install(first)
    const statePath = join(directory, 'module-registry.json')
    const external = join(root(), 'external.json')
    writeFileSync(external, readFileSync(statePath))

    let replaced = false
    const raced = new FilesystemModuleRegistryPersistence(directory, {
      faultInjector(point) {
        if (point !== 'after-state-lstat' || replaced) return
        replaced = true
        rmSync(statePath)
        symlinkSync(external, statePath)
      },
    })
    expect(() => raced.read()).toThrow()
  })

  it('rejects a cross-platform regular-file substitution between lstat and open', () => {
    const directory = root()
    const first = new ModuleRegistry(HOST, new FilesystemModuleRegistryPersistence(directory))
    install(first)
    const statePath = join(directory, 'module-registry.json')
    const displaced = join(directory, 'displaced.json')
    let replaced = false
    const raced = new FilesystemModuleRegistryPersistence(directory, {
      faultInjector(point) {
        if (point !== 'after-state-lstat' || replaced) return
        replaced = true
        renameSync(statePath, displaced)
        writeFileSync(statePath, readFileSync(displaced))
      },
    })
    expect(() => raced.read()).toThrow('Unsafe registry persistence file')
  })

  it('pins the trusted root device and inode across operations', () => {
    const directory = root()
    const displaced = `${directory}-displaced`
    roots.push(displaced)
    const persistence = new FilesystemModuleRegistryPersistence(directory)
    renameSync(directory, displaced)
    mkdirSync(directory, { mode: 0o700 })
    expect(() => persistence.read()).toThrow('trusted root changed')
  })

  it('fails closed on a destination symlink introduced before atomic rename', () => {
    if (process.platform === 'win32') return
    const directory = root()
    const external = join(root(), 'external.json')
    writeFileSync(external, 'untouched')
    let injected = false
    const persistence = new FilesystemModuleRegistryPersistence(directory, {
      faultInjector(point) {
        if (point !== 'before-state-rename' || injected) return
        injected = true
        symlinkSync(external, join(directory, 'module-registry.json'))
      },
    })
    const registry = new ModuleRegistry(HOST, persistence)
    expect(registry.install(manifest(), { hostVersionRange: '*' }).diagnostics[0]?.code)
      .toBe('PERSISTENCE_WRITE_FAILED')

    expect(readFileSync(external, 'utf8')).toBe('untouched')
    expect(() => new FilesystemModuleRegistryPersistence(directory).read()).toThrow('symlink')
  })
})
