import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
    let checked = false
    const first = new FilesystemModuleRegistryPersistence(directory, {
      faultInjector(point) {
        if (point !== 'after-pending-sync' || checked) return
        checked = true
        expect(() => second.commit({ schemaVersion: 1, host: HOST, modules: [] })).toThrow('writer is active')
        expect(new ModuleRegistry(HOST, second).snapshot()).toMatchObject({ modules: [], diagnostics: [] })
        expect(readFileSync(join(directory, 'module-registry.pending.json'), 'utf8')).toContain('schemaVersion')
      },
    })
    first.commit({ schemaVersion: 1, host: HOST, modules: [] })

    writeFileSync(join(directory, 'module-registry.lock'), `${JSON.stringify({
      pid: 2_147_483_647,
      token: '00000000-0000-4000-8000-000000000000',
    })}\n`)
    second.commit({ schemaVersion: 1, host: HOST, modules: [] })
    expect(new ModuleRegistry(HOST, second).snapshot().modules).toHaveLength(0)
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

  it('does not follow a destination symlink introduced before atomic rename', () => {
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
    install(registry)

    expect(readFileSync(external, 'utf8')).toBe('untouched')
    expect(new ModuleRegistry(HOST, new FilesystemModuleRegistryPersistence(directory)).snapshot().modules).toHaveLength(1)
  })
})
