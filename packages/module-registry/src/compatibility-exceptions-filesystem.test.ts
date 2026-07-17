import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseModuleManifest,
  type ModuleManifest,
} from '@simulator/module-contract'
import { FilesystemModuleRegistryPersistence } from './filesystem-persistence.ts'
import { ModuleRegistry } from './registry.ts'
import type { ModuleRegistryCompatibilityException, ModuleRegistryHost } from './types.ts'

const OLD_HOST = Object.freeze({ version: '0.11.1', platform: 'darwin-arm64' as const })
const NEW_HOST = Object.freeze({ version: '0.12.0', platform: 'darwin-arm64' as const })
const ORIGINAL_RANGE = '>=0.11.1 <0.12.0'
const HASH_A = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
const HASH_B = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789'
const roots: string[] = []

interface ManifestOverrides {
  readonly id?: string
  readonly version?: string
  readonly sha256?: string
  readonly urlSuffix?: string
  readonly auxiliaryExecutables?: readonly string[]
  readonly capabilities?: readonly string[]
}

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'simulator-registry-compatibility-exception-'))
  roots.push(value)
  return value
}

function manifest(overrides: ManifestOverrides = {}): ModuleManifest {
  const id = overrides.id ?? 'org.simulator.persisted-compatibility-exception'
  const version = overrides.version ?? '0.14.5'
  const parsed = parseModuleManifest({
    schemaVersion: 1,
    id,
    version,
    artifacts: (['darwin-arm64', 'linux-x64'] as const).map((platform) => ({
      platform,
      entrypoint: 'bin/module',
      auxiliaryExecutables: overrides.auxiliaryExecutables ?? ['runtime/node', 'bin/spawn-helper'],
      url: `https://modules.example.test/${id}/${version}/${platform}${overrides.urlSuffix ?? ''}.tar.gz`,
      sha256: overrides.sha256 ?? HASH_A,
    })),
    capabilities: overrides.capabilities ?? ['host-agent.use', 'workspace.write'],
  })
  if (!parsed.ok) throw new Error(`Test manifest did not validate: ${JSON.stringify(parsed.errors)}`)
  return parsed.value
}

function exactException(
  exactManifest: ModuleManifest,
  host: ModuleRegistryHost = NEW_HOST,
  hostVersionRange = ORIGINAL_RANGE,
): ModuleRegistryCompatibilityException {
  return { host, hostVersionRange, manifest: exactManifest }
}

function persistOldActiveState(directory: string, exactManifest: ModuleManifest): void {
  const registry = new ModuleRegistry(OLD_HOST, new FilesystemModuleRegistryPersistence(directory))
  expect(registry.install(exactManifest, { hostVersionRange: ORIGINAL_RANGE }).ok).toBe(true)
  expect(registry.activate(exactManifest.id, exactManifest.version).ok).toBe(true)
  expect(registry.markLastKnownGood(exactManifest.id, exactManifest.version).ok).toBe(true)
  expect(JSON.parse(readFileSync(join(directory, 'module-registry.json'), 'utf8')).host).toEqual(OLD_HOST)
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

describe('ModuleRegistry compatibility exception filesystem recovery', () => {
  it('preserves the exact 0.11.1 active/LKG tuple when restarting on 0.12.0', () => {
    const directory = root()
    const exactManifest = manifest()
    persistOldActiveState(directory, exactManifest)

    const recoveredRegistry = new ModuleRegistry(
      NEW_HOST,
      new FilesystemModuleRegistryPersistence(directory),
      { compatibilityExceptions: [exactException(exactManifest)] },
    )
    const recovered = recoveredRegistry.snapshot()
    expect(recovered.modules[0]).toMatchObject({
      activeVersion: exactManifest.version,
      lastKnownGoodVersion: exactManifest.version,
    })
    expect(recovered.modules[0]?.versions[0]).toMatchObject({
      hostVersionRange: ORIGINAL_RANGE,
      compatibility: 'compatible',
      incompatibilityReasons: [],
    })
    expect(recovered.diagnostics).toEqual([])

    // Recovery itself is read-only and therefore proves the old persisted host
    // was evaluated with the exception before active/LKG clearing.
    expect(JSON.parse(readFileSync(join(directory, 'module-registry.json'), 'utf8')).host).toEqual(OLD_HOST)

    expect(recoveredRegistry.restoreActivation(exactManifest.id, {
      activeVersion: null,
      lastKnownGoodVersion: null,
    }).ok).toBe(true)
    expect(recoveredRegistry.restoreActivation(exactManifest.id, {
      activeVersion: exactManifest.version,
      lastKnownGoodVersion: exactManifest.version,
    }).ok).toBe(true)

    const restartedAgain = new ModuleRegistry(
      NEW_HOST,
      new FilesystemModuleRegistryPersistence(directory),
      { compatibilityExceptions: [exactException(exactManifest)] },
    ).snapshot()
    expect(restartedAgain.modules[0]).toMatchObject({
      activeVersion: exactManifest.version,
      lastKnownGoodVersion: exactManifest.version,
    })
    expect(JSON.parse(readFileSync(join(directory, 'module-registry.json'), 'utf8')).host).toEqual(NEW_HOST)
  })

  it.each([
    ['artifact SHA', () => ({ configuredManifest: manifest({ sha256: HASH_B }) })],
    ['artifact URL', () => ({ configuredManifest: manifest({ urlSuffix: '-different' }) })],
    ['auxiliary executables', () => ({ configuredManifest: manifest({ auxiliaryExecutables: ['runtime/other'] }) })],
    ['capabilities', () => ({ configuredManifest: manifest({ capabilities: ['workspace.read'] }) })],
    ['module ID', () => ({ configuredManifest: manifest({ id: 'org.simulator.other-persisted-module' }) })],
    ['module version', () => ({ configuredManifest: manifest({ version: '0.14.5+different' }) })],
    ['exception host version', () => ({ exceptionHost: { ...NEW_HOST, version: '0.12.1' } })],
    ['exception host platform', () => ({ exceptionHost: { version: '0.12.0', platform: 'linux-x64' as const } })],
    ['current host version', () => ({ registryHost: { ...NEW_HOST, version: '0.12.1' } })],
    ['current host platform', () => ({ registryHost: { version: '0.12.0', platform: 'linux-x64' as const } })],
    ['normalized original range', () => ({ exceptionRange: '>=0.11.0 <0.12.0' })],
  ] as const)('clears persisted active/LKG for a different %s', (_name, createVariant) => {
    const directory = root()
    const persistedManifest = manifest()
    persistOldActiveState(directory, persistedManifest)
    const variant = createVariant() as {
      readonly configuredManifest?: ModuleManifest
      readonly exceptionHost?: ModuleRegistryHost
      readonly registryHost?: ModuleRegistryHost
      readonly exceptionRange?: string
    }

    const recovered = new ModuleRegistry(
      variant.registryHost ?? NEW_HOST,
      new FilesystemModuleRegistryPersistence(directory),
      {
        compatibilityExceptions: [exactException(
          variant.configuredManifest ?? persistedManifest,
          variant.exceptionHost ?? NEW_HOST,
          variant.exceptionRange ?? ORIGINAL_RANGE,
        )],
      },
    ).snapshot()

    expect(recovered.modules[0]).toMatchObject({ activeVersion: null, lastKnownGoodVersion: null })
    expect(recovered.modules[0]?.versions[0]).toMatchObject({ compatibility: 'incompatible' })
    expect(recovered.modules[0]?.versions[0]?.incompatibilityReasons.map((item) => item.code))
      .toContain('INCOMPATIBLE_HOST_VERSION')
    expect(recovered.diagnostics.map((item) => item.code)).toEqual([
      'ACTIVE_CLEARED_INCOMPATIBLE',
      'LAST_KNOWN_GOOD_CLEARED_INCOMPATIBLE',
    ])
  })

  it('cannot use an exact exception to recover a corrupt persisted manifest schema', () => {
    const directory = root()
    const exactManifest = manifest()
    persistOldActiveState(directory, exactManifest)
    const statePath = join(directory, 'module-registry.json')
    const persisted = JSON.parse(readFileSync(statePath, 'utf8')) as {
      modules: Array<{ versions: Array<{ manifest: { schemaVersion: number } }> }>
    }
    persisted.modules[0]!.versions[0]!.manifest.schemaVersion = 2
    writeFileSync(statePath, `${JSON.stringify(persisted)}\n`, { mode: 0o600 })

    const recovered = new ModuleRegistry(
      NEW_HOST,
      new FilesystemModuleRegistryPersistence(directory),
      { compatibilityExceptions: [exactException(exactManifest)] },
    ).snapshot()
    expect(recovered.modules).toEqual([])
    expect(recovered.diagnostics.map((item) => item.code)).toEqual(['CORRUPT_PERSISTED_STATE'])
  })
})
