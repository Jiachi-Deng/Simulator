import { describe, expect, it } from 'bun:test'
import {
  parseModuleManifest,
  type ModuleManifest,
  type ModulePlatform,
} from '@simulator/module-contract'
import { InMemoryModuleRegistryPersistence } from './persistence.ts'
import { ModuleRegistry } from './registry.ts'
import type {
  ModuleRegistryCompatibilityException,
  ModuleRegistryHost,
  ModuleRegistryOptions,
} from './types.ts'

const OLD_HOST = Object.freeze({ version: '0.11.1', platform: 'darwin-arm64' as const })
const NEW_HOST = Object.freeze({ version: '0.12.0', platform: 'darwin-arm64' as const })
const ORIGINAL_RANGE = '>=0.11.1 <0.12.0'
const HASH_A = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
const HASH_B = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789'

interface ManifestOverrides {
  readonly id?: string
  readonly version?: string
  readonly platforms?: readonly ModulePlatform[]
  readonly entrypointSuffix?: string
  readonly auxiliaryExecutables?: readonly string[]
  readonly urlSuffix?: string
  readonly sha256?: string
  readonly capabilities?: readonly string[]
}

function manifest(overrides: ManifestOverrides = {}): ModuleManifest {
  const id = overrides.id ?? 'org.simulator.compatibility-exception'
  const version = overrides.version ?? '0.14.5'
  const parsed = parseModuleManifest({
    schemaVersion: 1,
    id,
    version,
    artifacts: (overrides.platforms ?? ['linux-x64', 'darwin-arm64']).map((platform) => ({
      platform,
      entrypoint: `bin/module${overrides.entrypointSuffix ?? ''}`,
      auxiliaryExecutables: overrides.auxiliaryExecutables ?? ['runtime/node', 'bin/spawn-helper'],
      url: `https://modules.example.test/${id}/${version}/${platform}${overrides.urlSuffix ?? ''}.tar.gz`,
      sha256: overrides.sha256 ?? HASH_A,
    })),
    capabilities: overrides.capabilities ?? ['workspace.write', 'host-agent.use'],
  })
  if (!parsed.ok) throw new Error(`Test manifest did not validate: ${JSON.stringify(parsed.errors)}`)
  return parsed.value
}

function exception(
  exactManifest: ModuleManifest = manifest(),
  host: ModuleRegistryHost = NEW_HOST,
  hostVersionRange = ORIGINAL_RANGE,
): ModuleRegistryCompatibilityException {
  return { host, hostVersionRange, manifest: exactManifest }
}

function registryWith(
  exactException: ModuleRegistryCompatibilityException,
  host: ModuleRegistryHost = NEW_HOST,
): ModuleRegistry {
  return new ModuleRegistry(host, undefined, { compatibilityExceptions: [exactException] })
}

const INVALID_OPTION_CASES: ReadonlyArray<readonly [string, () => unknown]> = [
  ['null options', () => null],
  ['unknown options field', () => ({ unknown: true })],
  ['non-array exception list', () => ({ compatibilityExceptions: {} })],
  ['sparse exception list', () => ({ compatibilityExceptions: new Array(1) })],
  ['unknown exception field', () => ({ compatibilityExceptions: [{ ...exception(), unknown: true }] })],
  ['missing exception field', () => ({ compatibilityExceptions: [{ host: NEW_HOST, manifest: manifest() }] })],
  ['noncanonical host version', () => ({ compatibilityExceptions: [exception(manifest(), { ...NEW_HOST, version: 'v0.12.0' })] })],
  ['unsupported host platform', () => ({ compatibilityExceptions: [exception(manifest(), { version: '0.12.0', platform: 'other' as ModulePlatform })] })],
  ['invalid host range', () => ({ compatibilityExceptions: [exception(manifest(), NEW_HOST, 'not-a-range')] })],
  ['nonnormalized host range', () => ({ compatibilityExceptions: [exception(manifest(), NEW_HOST, '^0.11.1')] })],
  ['unvalidated manifest', () => ({ compatibilityExceptions: [{ ...exception(), manifest: structuredClone(manifest()) }] })],
  ['already-compatible host range', () => ({ compatibilityExceptions: [exception(manifest(), NEW_HOST, '*')] })],
  ['missing target platform', () => ({ compatibilityExceptions: [exception(manifest({ platforms: ['linux-x64'] }))] })],
  ['exact duplicate', () => {
    const exact = exception()
    return { compatibilityExceptions: [exact, exact] }
  }],
  ['conflicting authority for one exact slot', () => ({
    compatibilityExceptions: [exception(manifest()), exception(manifest({ sha256: HASH_B }))],
  })],
  ['accessor-backed exception', () => ({
    compatibilityExceptions: [Object.defineProperty({}, 'host', { enumerable: true, get: () => NEW_HOST })],
  })],
]

describe('ModuleRegistry exact compatibility exceptions', () => {
  it('is default-off while preserving the one- and two-argument constructors', () => {
    const exactManifest = manifest()
    const oneArgument = new ModuleRegistry(NEW_HOST)
    const twoArguments = new ModuleRegistry(NEW_HOST, undefined)
    const explicitUndefined = new ModuleRegistry(NEW_HOST, undefined, { compatibilityExceptions: undefined })

    for (const registry of [oneArgument, twoArguments, explicitUndefined]) {
      const result = registry.install(exactManifest, { hostVersionRange: ORIGINAL_RANGE })
      expect(result.ok).toBe(false)
      expect(result.diagnostics.map((item) => item.code)).toEqual(['INCOMPATIBLE_HOST_VERSION'])
      expect(result.snapshot.modules).toEqual([])
    }
  })

  it('applies the exact tuple to install, snapshot, activate, LKG, and restore', () => {
    const exactManifest = manifest()
    const registry = registryWith(exception(exactManifest))

    expect(registry.install(exactManifest, { hostVersionRange: ORIGINAL_RANGE }).ok).toBe(true)
    expect(registry.snapshot().modules[0]?.versions[0]).toMatchObject({
      compatibility: 'compatible',
      hostVersionRange: ORIGINAL_RANGE,
      incompatibilityReasons: [],
    })
    expect(registry.activate(exactManifest.id, exactManifest.version).ok).toBe(true)
    expect(registry.markLastKnownGood(exactManifest.id, exactManifest.version).ok).toBe(true)
    expect(registry.restoreActivation(exactManifest.id, {
      activeVersion: null,
      lastKnownGoodVersion: null,
    }).ok).toBe(true)
    expect(registry.restoreActivation(exactManifest.id, {
      activeVersion: exactManifest.version,
      lastKnownGoodVersion: exactManifest.version,
    }).ok).toBe(true)
    expect(registry.snapshot().modules[0]).toMatchObject({
      activeVersion: exactManifest.version,
      lastKnownGoodVersion: exactManifest.version,
    })
  })

  it('matches canonical manifest content independent of declaration ordering', () => {
    const configured = manifest({
      platforms: ['linux-x64', 'darwin-arm64'],
      auxiliaryExecutables: ['runtime/node', 'bin/spawn-helper'],
      capabilities: ['workspace.write', 'host-agent.use'],
    })
    const reordered = manifest({
      platforms: ['darwin-arm64', 'linux-x64'],
      auxiliaryExecutables: ['bin/spawn-helper', 'runtime/node'],
      capabilities: ['host-agent.use', 'workspace.write'],
    })
    const registry = registryWith(exception(configured))

    expect(registry.install(reordered, { hostVersionRange: ORIGINAL_RANGE }).ok).toBe(true)
    expect(registry.snapshot().modules[0]?.versions[0]?.manifest.artifacts.map((artifact) => artifact.platform))
      .toEqual(['darwin-arm64', 'linux-x64'])
    expect(registry.snapshot().modules[0]?.versions[0]?.manifest.artifacts[0]?.auxiliaryExecutables?.map(String))
      .toEqual(['bin/spawn-helper', 'runtime/node'])
  })

  it.each([
    ['artifact SHA', NEW_HOST, manifest({ sha256: HASH_B }), ORIGINAL_RANGE],
    ['artifact URL', NEW_HOST, manifest({ urlSuffix: '-different' }), ORIGINAL_RANGE],
    ['artifact entrypoint', NEW_HOST, manifest({ entrypointSuffix: '-different' }), ORIGINAL_RANGE],
    ['auxiliary executables', NEW_HOST, manifest({ auxiliaryExecutables: ['runtime/other'] }), ORIGINAL_RANGE],
    ['artifact platform set', NEW_HOST, manifest({ platforms: ['darwin-arm64'] }), ORIGINAL_RANGE],
    ['capabilities', NEW_HOST, manifest({ capabilities: ['workspace.read'] }), ORIGINAL_RANGE],
    ['module ID', NEW_HOST, manifest({ id: 'org.simulator.different-module' }), ORIGINAL_RANGE],
    ['module version', NEW_HOST, manifest({ version: '0.14.5+different' }), ORIGINAL_RANGE],
    ['host version', { ...NEW_HOST, version: '0.12.1' }, manifest(), ORIGINAL_RANGE],
    ['host platform', { version: '0.12.0', platform: 'linux-x64' }, manifest(), ORIGINAL_RANGE],
    ['normalized original range', NEW_HOST, manifest(), '>=0.11.0 <0.12.0'],
  ] as const)('fails closed for a different %s', (_name, host, candidate, range) => {
    const registry = registryWith(exception(manifest()), host)
    const result = registry.install(candidate, { hostVersionRange: range })

    expect(result.ok).toBe(false)
    expect(result.diagnostics.map((item) => item.code)).toContain('INCOMPATIBLE_HOST_VERSION')
    expect(result.snapshot.modules).toEqual([])
  })

  it('never suppresses platform or manifest/schema validation failures', () => {
    const registry = registryWith(exception(manifest()))
    const wrongPlatform = registry.install(
      manifest({ platforms: ['linux-x64'] }),
      { hostVersionRange: ORIGINAL_RANGE },
    )
    expect(wrongPlatform.diagnostics.map((item) => item.code)).toEqual([
      'INCOMPATIBLE_HOST_VERSION',
      'INCOMPATIBLE_PLATFORM',
    ])

    const unvalidated = registry.install(structuredClone(manifest()), { hostVersionRange: ORIGINAL_RANGE })
    expect(unvalidated.diagnostics.map((item) => item.code)).toEqual(['UNVALIDATED_MANIFEST'])
    const unsupportedSchema = registry.install(
      { ...structuredClone(manifest()), schemaVersion: 2 } as unknown as ModuleManifest,
      { hostVersionRange: ORIGINAL_RANGE },
    )
    expect(unsupportedSchema.diagnostics.map((item) => item.code)).toEqual(['UNSUPPORTED_MANIFEST_SCHEMA'])
    expect(registry.snapshot().modules).toEqual([])
  })

  it.each(INVALID_OPTION_CASES)('throws at construction for %s', (_name, createOptions) => {
    expect(() => new ModuleRegistry(
      NEW_HOST,
      undefined,
      createOptions() as unknown as ModuleRegistryOptions,
    )).toThrow(TypeError)
  })

  it('rejects canonically duplicated authorities even when input ordering differs', () => {
    const ordered = manifest()
    const reordered = manifest({
      platforms: ['darwin-arm64', 'linux-x64'],
      auxiliaryExecutables: ['bin/spawn-helper', 'runtime/node'],
      capabilities: ['host-agent.use', 'workspace.write'],
    })
    expect(() => new ModuleRegistry(NEW_HOST, undefined, {
      compatibilityExceptions: [exception(ordered), exception(reordered)],
    })).toThrow('duplicated')
  })

  it('preserves recovered 0.11.1 active/LKG only for the exact 0.12.0 tuple', () => {
    const exactManifest = manifest()
    const persistence = new InMemoryModuleRegistryPersistence()
    const original = new ModuleRegistry(OLD_HOST, persistence)
    expect(original.install(exactManifest, { hostVersionRange: ORIGINAL_RANGE }).ok).toBe(true)
    expect(original.activate(exactManifest.id, exactManifest.version).ok).toBe(true)
    expect(original.markLastKnownGood(exactManifest.id, exactManifest.version).ok).toBe(true)

    const recovered = new ModuleRegistry(NEW_HOST, persistence, {
      compatibilityExceptions: [exception(exactManifest)],
    }).snapshot()
    expect(recovered.modules[0]).toMatchObject({
      activeVersion: exactManifest.version,
      lastKnownGoodVersion: exactManifest.version,
    })
    expect(recovered.modules[0]?.versions[0]).toMatchObject({
      compatibility: 'compatible',
      incompatibilityReasons: [],
    })
    expect(recovered.diagnostics).toEqual([])

    const noException = new ModuleRegistry(NEW_HOST, persistence).snapshot()
    expect(noException.modules[0]).toMatchObject({ activeVersion: null, lastKnownGoodVersion: null })
    expect(noException.diagnostics.map((item) => item.code)).toEqual([
      'ACTIVE_CLEARED_INCOMPATIBLE',
      'LAST_KNOWN_GOOD_CLEARED_INCOMPATIBLE',
    ])
  })
})
