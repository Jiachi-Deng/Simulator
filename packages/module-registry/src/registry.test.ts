import { describe, expect, it } from 'bun:test'
import {
  parseModuleManifest,
  type ModuleManifest,
  type ModulePlatform,
} from '@simulator/module-contract'
import { InMemoryModuleRegistryPersistence } from './persistence.ts'
import { ModuleRegistry } from './registry.ts'
import { RegistryCrashRecoveryFixture } from './testing/crash-recovery-fixture.ts'

const HOST = Object.freeze({ version: '0.11.1', platform: 'darwin-arm64' as const })
const HASH = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

function validatedManifest(
  id: string,
  version: string,
  platforms: readonly ModulePlatform[] = ['darwin-arm64'],
  overrides: Record<string, unknown> = {},
): ModuleManifest {
  const result = parseModuleManifest({
    schemaVersion: 1,
    id,
    version,
    artifacts: platforms.map((platform) => ({
      platform,
      entrypoint: `bin/${id}`,
      url: `https://modules.example.test/${id}/${version}/${platform}.tar.gz`,
      sha256: HASH,
    })),
    capabilities: ['workspace.read', 'artifact.read'],
    ...overrides,
  })
  if (!result.ok) throw new Error(`Test manifest did not validate: ${JSON.stringify(result.errors)}`)
  return result.value
}

function firstCode(result: ReturnType<ModuleRegistry['install']>): string | undefined {
  return result.diagnostics[0]?.code
}

describe('ModuleRegistry installation and deterministic snapshots', () => {
  it('registers multiple versions with canonical module, version, artifact, and capability ordering', () => {
    const registry = new ModuleRegistry(HOST)
    const inputs = [
      validatedManifest('org.simulator.zeta', '2.0.0'),
      validatedManifest('org.simulator.alpha', '1.10.0', ['linux-x64', 'darwin-arm64']),
      validatedManifest('org.simulator.alpha', '1.2.0'),
      validatedManifest('org.simulator.alpha', '1.2.0+build.2'),
    ]
    for (const manifest of inputs) {
      expect(registry.install(manifest, { hostVersionRange: '>=0.11.0 <1.0.0' }).ok).toBe(true)
    }

    const snapshot = registry.snapshot()
    expect(snapshot.modules.map((module) => module.id)).toEqual([
      'org.simulator.alpha',
      'org.simulator.zeta',
    ])
    expect(snapshot.modules[0]?.versions.map((item) => item.version)).toEqual([
      '1.2.0',
      '1.2.0+build.2',
      '1.10.0',
    ])
    expect(snapshot.modules[0]?.versions[2]?.manifest.artifacts.map((item) => item.platform)).toEqual([
      'darwin-arm64',
      'linux-x64',
    ])
    expect(snapshot.modules[0]?.versions[0]?.manifest.capabilities).toEqual([
      'artifact.read',
      'workspace.read',
    ])

    const reverseRegistry = new ModuleRegistry(HOST)
    for (const manifest of [...inputs].reverse()) {
      reverseRegistry.install(manifest, { hostVersionRange: '>=0.11.0 <1.0.0' })
    }
    expect(reverseRegistry.snapshot()).toEqual(snapshot)
  })

  it.each([
    {
      name: 'unvalidated structural manifest',
      manifest: Object.freeze({ schemaVersion: 1 }),
      range: '*',
      code: 'UNVALIDATED_MANIFEST',
    },
    {
      name: 'unsupported schema',
      manifest: Object.freeze({ schemaVersion: 2 }),
      range: '*',
      code: 'UNSUPPORTED_MANIFEST_SCHEMA',
    },
    {
      name: 'invalid host range',
      manifest: validatedManifest('org.simulator.invalid-range', '1.0.0'),
      range: 'not a range',
      code: 'INVALID_HOST_VERSION_RANGE',
    },
    {
      name: 'missing host platform artifact',
      manifest: validatedManifest('org.simulator.linux-only', '1.0.0', ['linux-x64']),
      range: '*',
      code: 'INCOMPATIBLE_PLATFORM',
    },
    {
      name: 'incompatible host version',
      manifest: validatedManifest('org.simulator.future', '1.0.0'),
      range: '>=1.0.0',
      code: 'INCOMPATIBLE_HOST_VERSION',
    },
  ])('rejects $name without changing state', ({ manifest, range, code }) => {
    const registry = new ModuleRegistry(HOST)
    const before = registry.snapshot()
    const result = registry.install(manifest as ModuleManifest, { hostVersionRange: range })
    expect(result.ok).toBe(false)
    expect(firstCode(result)).toBe(code)
    expect(registry.snapshot()).toEqual(before)
  })

  it('distinguishes exact duplicates from conflicting manifests and ranges', () => {
    const registry = new ModuleRegistry(HOST)
    const original = validatedManifest('org.simulator.conflict', '1.0.0')
    expect(registry.install(original, { hostVersionRange: '^0.11.0' }).ok).toBe(true)
    const installed = registry.snapshot()

    expect(firstCode(registry.install(original, { hostVersionRange: '^0.11.0' }))).toBe('DUPLICATE_VERSION')
    expect(firstCode(registry.install(original, { hostVersionRange: '*' }))).toBe('MANIFEST_CONFLICT')

    const changed = validatedManifest('org.simulator.conflict', '1.0.0', ['darwin-arm64'], {
      capabilities: ['workspace.write'],
    })
    expect(firstCode(registry.install(changed, { hostVersionRange: '^0.11.0' }))).toBe('MANIFEST_CONFLICT')
    expect(registry.snapshot()).toEqual(installed)
  })

  it('sorts two safe-integer boundary versions and rejects the first unsafe version at the contract', () => {
    const registry = new ModuleRegistry(HOST)
    const lower = validatedManifest('org.simulator.large-version', '9007199254740990.0.0')
    const upper = validatedManifest('org.simulator.large-version', '9007199254740991.0.0')

    expect(registry.install(upper, { hostVersionRange: '*' }).ok).toBe(true)
    expect(registry.install(lower, { hostVersionRange: '*' }).ok).toBe(true)
    expect(registry.snapshot().modules[0]?.versions.map((item) => item.version)).toEqual([
      '9007199254740990.0.0',
      '9007199254740991.0.0',
    ])

    const unsafe = parseModuleManifest({
      ...lower,
      version: '9007199254740992.0.0',
    })
    expect(unsafe).toEqual({
      ok: false,
      errors: [
        { code: 'INVALID_VERSION', path: '/version', message: 'Module version must be valid Semantic Versioning' },
      ],
    })
  })

  it('returns deep immutable snapshots and does not expose accepted manifest references', () => {
    const registry = new ModuleRegistry(HOST)
    const manifest = validatedManifest('org.simulator.immutable', '1.0.0')
    registry.install(manifest, { hostVersionRange: '*' })
    const snapshot = registry.snapshot()
    const version = snapshot.modules[0]!.versions[0]!

    expect(version.manifest).not.toBe(manifest)
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.host)).toBe(true)
    expect(Object.isFrozen(snapshot.modules)).toBe(true)
    expect(Object.isFrozen(snapshot.modules[0])).toBe(true)
    expect(Object.isFrozen(version)).toBe(true)
    expect(Object.isFrozen(version.manifest.artifacts[0])).toBe(true)
    expect(() => (snapshot.modules as unknown as unknown[]).push('mutation')).toThrow()
  })
})

describe('ModuleRegistry state transitions', () => {
  it('activates, marks last-known-good, disables, re-enables, and safely removes versions', () => {
    const registry = new ModuleRegistry(HOST)
    registry.install(validatedManifest('org.simulator.transitions', '1.0.0'), { hostVersionRange: '*' })
    registry.install(validatedManifest('org.simulator.transitions', '2.0.0'), { hostVersionRange: '*' })

    expect(registry.activate('org.simulator.transitions', '1.0.0').ok).toBe(true)
    expect(registry.markLastKnownGood('org.simulator.transitions', '1.0.0').ok).toBe(true)
    expect(registry.disable('org.simulator.transitions').ok).toBe(true)
    expect(firstCode(registry.activate('org.simulator.transitions', '2.0.0'))).toBe('MODULE_DISABLED')
    expect(registry.enable('org.simulator.transitions').ok).toBe(true)

    const guarded = registry.remove('org.simulator.transitions', '1.0.0')
    expect(firstCode(guarded)).toBe('ACTIVE_REMOVAL_GUARD')
    expect(registry.remove('org.simulator.transitions', '1.0.0', {
      activeVersion: '2.0.0',
      lastKnownGoodVersion: '2.0.0',
    }).ok).toBe(true)

    const module = registry.snapshot().modules[0]!
    expect(module.activeVersion).toBe('2.0.0')
    expect(module.lastKnownGoodVersion).toBe('2.0.0')
    expect(module.versions.map((item) => item.version)).toEqual(['2.0.0'])
  })

  it.each([
    ['activate missing module', (registry: ModuleRegistry) => registry.activate('org.simulator.missing', '1.0.0'), 'MODULE_NOT_FOUND'],
    ['activate missing version', (registry: ModuleRegistry) => registry.activate('org.simulator.matrix', '9.0.0'), 'VERSION_NOT_FOUND'],
    ['mark missing version LKG', (registry: ModuleRegistry) => registry.markLastKnownGood('org.simulator.matrix', '9.0.0'), 'VERSION_NOT_FOUND'],
    ['disable missing module', (registry: ModuleRegistry) => registry.disable('org.simulator.missing'), 'MODULE_NOT_FOUND'],
    ['remove missing version', (registry: ModuleRegistry) => registry.remove('org.simulator.matrix', '9.0.0'), 'VERSION_NOT_FOUND'],
  ] as const)('rejects table-driven transition: %s', (_name, operation, code) => {
    const registry = new ModuleRegistry(HOST)
    registry.install(validatedManifest('org.simulator.matrix', '1.0.0'), { hostVersionRange: '*' })
    const before = registry.snapshot()
    const result = operation(registry)
    expect(result.ok).toBe(false)
    expect(firstCode(result)).toBe(code)
    expect(registry.snapshot()).toEqual(before)
  })

  it('rejects an invalid safe-removal transition atomically', () => {
    const registry = new ModuleRegistry(HOST)
    registry.install(validatedManifest('org.simulator.remove', '1.0.0'), { hostVersionRange: '*' })
    registry.activate('org.simulator.remove', '1.0.0')
    const before = registry.snapshot()
    const result = registry.remove('org.simulator.remove', '1.0.0', { activeVersion: '2.0.0' })
    expect(firstCode(result)).toBe('VERSION_NOT_FOUND')
    expect(registry.snapshot()).toEqual(before)

    const undefinedTransition = registry.remove(
      'org.simulator.remove',
      '1.0.0',
      { activeVersion: undefined },
    )
    expect(firstCode(undefinedTransition)).toBe('VERSION_NOT_FOUND')
    expect(registry.snapshot()).toEqual(before)
  })
})

describe('ModuleRegistry persistence recovery', () => {
  it('recovers the previous complete snapshot after an interrupted commit', () => {
    const fixture = new RegistryCrashRecoveryFixture(HOST)
    const registry = fixture.start()
    registry.install(validatedManifest('org.simulator.recovery', '1.0.0'), { hostVersionRange: '*' })
    registry.activate('org.simulator.recovery', '1.0.0')
    const committed = registry.snapshot()

    fixture.interruptNextCommit()
    const interrupted = registry.install(
      validatedManifest('org.simulator.recovery', '2.0.0'),
      { hostVersionRange: '*' },
    )
    expect(firstCode(interrupted)).toBe('PERSISTENCE_WRITE_FAILED')
    expect(registry.snapshot()).toEqual(committed)

    const restarted = fixture.start()
    expect(restarted.snapshot().modules[0]?.versions.map((item) => item.version)).toEqual(['1.0.0'])
    expect(restarted.snapshot().modules[0]?.activeVersion).toBe('1.0.0')
    expect(restarted.snapshot().diagnostics.map((item) => item.code)).toEqual(['RECOVERY_INTERRUPTED_COMMIT'])
    expect(fixture.builtInAgent.available).toBe(true)
  })

  it('tracks recovered versions as incompatible and clears active/LKG after host drift', () => {
    const persistence = new InMemoryModuleRegistryPersistence()
    const original = new ModuleRegistry(HOST, persistence)
    const manifest = validatedManifest('org.simulator.host-drift', '1.0.0', ['darwin-arm64', 'linux-x64'])
    original.install(manifest, { hostVersionRange: '^0.11.0' })
    original.activate(manifest.id, manifest.version)
    original.markLastKnownGood(manifest.id, manifest.version)

    const recovered = new ModuleRegistry({ version: '1.0.0', platform: 'linux-x64' }, persistence).snapshot()
    expect(recovered.modules[0]?.versions[0]?.compatibility).toBe('incompatible')
    expect(recovered.modules[0]?.versions[0]?.incompatibilityReasons.map((item) => item.code)).toEqual([
      'INCOMPATIBLE_HOST_VERSION',
    ])
    expect(recovered.modules[0]?.activeVersion).toBeNull()
    expect(recovered.modules[0]?.lastKnownGoodVersion).toBeNull()
    expect(recovered.diagnostics.map((item) => item.code)).toEqual([
      'ACTIVE_CLEARED_INCOMPATIBLE',
      'LAST_KNOWN_GOOD_CLEARED_INCOMPATIBLE',
    ])
  })

  it.each([
    ['wrong schema', { schemaVersion: 99, host: HOST, modules: [] }],
    ['missing active target', {
      schemaVersion: 1,
      host: HOST,
      modules: [{ id: 'org.simulator.corrupt', disabled: false, activeVersion: '1.0.0', lastKnownGoodVersion: null, versions: [] }],
    }],
    ['non-data input', Object.defineProperty({}, 'schemaVersion', { enumerable: true, get: () => 1 })],
  ])('fails safe to an empty optional registry for corrupt state: %s', (_name, state) => {
    const fixture = new RegistryCrashRecoveryFixture(HOST, state)
    const registry = fixture.start()
    expect(registry.snapshot().modules).toEqual([])
    expect(registry.snapshot().diagnostics.map((item) => item.code)).toEqual(['CORRUPT_PERSISTED_STATE'])
    expect(fixture.builtInAgent).toEqual({ available: true })
  })
})
