import { describe, expect, it } from 'bun:test'
import { isValidatedModuleManifest, parseModuleManifest } from './manifest.ts'
import { MAX_MODULE_ARTIFACTS, MAX_MODULE_CAPABILITIES } from './manifest-types.ts'
import { GOLDEN_MODULE_MANIFEST_INPUT } from './testing/golden-manifest.ts'

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: 'org.simulator.fake',
    version: '1.0.0',
    artifacts: [
      {
        platform: 'darwin-arm64',
        entrypoint: 'bin/fake-module',
        url: 'https://modules.example.test/fake.tar.gz',
        sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      },
    ],
    capabilities: ['artifact.read', 'workspace.read'],
    ...overrides,
  }
}

function errorsFor(input: unknown) {
  const result = parseModuleManifest(input)
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('Expected manifest validation to fail')
  return result.errors
}

describe('parseModuleManifest', () => {
  it('parses the golden manifest into a deeply immutable typed value', () => {
    const result = parseModuleManifest(GOLDEN_MODULE_MANIFEST_INPUT)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('Expected golden manifest to parse')

    expect(result.value as unknown).toEqual(GOLDEN_MODULE_MANIFEST_INPUT)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.value)).toBe(true)
    expect(Object.isFrozen(result.value.artifacts)).toBe(true)
    expect(Object.isFrozen(result.value.artifacts[0])).toBe(true)
    expect(Object.isFrozen(result.value.capabilities)).toBe(true)
    expect(isValidatedModuleManifest(result.value)).toBe(true)
  })

  it('does not trust structurally valid or manually frozen manifest objects', () => {
    expect(isValidatedModuleManifest(GOLDEN_MODULE_MANIFEST_INPUT)).toBe(false)
    expect(isValidatedModuleManifest(Object.freeze({ ...GOLDEN_MODULE_MANIFEST_INPUT }))).toBe(false)
    expect(isValidatedModuleManifest(null)).toBe(false)
  })

  it.each([[null], [[]], ['manifest'], [1]])('rejects non-object input: %p', (input) => {
    expect(errorsFor(input)).toEqual([
      { code: 'INPUT_NOT_OBJECT', path: '', message: 'Module manifest must be an object' },
    ])
  })

  it.each([0, 2, 99])('fails closed for unsupported schema version %p', (schemaVersion) => {
    expect(errorsFor(manifest({ schemaVersion }))).toEqual([
      {
        code: 'UNSUPPORTED_SCHEMA_VERSION',
        path: '/schemaVersion',
        message: 'Unsupported module manifest schema version',
      },
    ])
  })

  it('rejects missing schema version without interpreting the remaining fields', () => {
    const input = manifest()
    delete input.schemaVersion
    expect(errorsFor(input)).toEqual([
      { code: 'MISSING_FIELD', path: '/schemaVersion', message: 'Missing required field: schemaVersion' },
    ])
  })

  it('rejects unknown root and artifact fields in sorted deterministic order', () => {
    const input = manifest({ zebra: true, alpha: true })
    ;(input.artifacts as Array<Record<string, unknown>>)[0] = {
      ...(input.artifacts as Array<Record<string, unknown>>)[0],
      extra: true,
    }
    expect(errorsFor(input).map(({ code, path }) => ({ code, path }))).toEqual([
      { code: 'UNKNOWN_FIELD', path: '/alpha' },
      { code: 'UNKNOWN_FIELD', path: '/zebra' },
      { code: 'UNKNOWN_FIELD', path: '/artifacts/0/extra' },
    ])
  })

  it('escapes dynamic JSON Pointer segments according to RFC 6901', () => {
    const input = manifest({ 'root~/field': true })
    ;(input.artifacts as Array<Record<string, unknown>>)[0] = {
      ...(input.artifacts as Array<Record<string, unknown>>)[0],
      'artifact~/field': true,
    }
    expect(errorsFor(input).map(({ path }) => path)).toEqual([
      '/root~0~1field',
      '/artifacts/0/artifact~0~1field',
    ])
  })

  it.each(['Fake', 'fake', 'org..fake', 'org.simulator_Fake', '-org.fake'])('rejects invalid module ID %p', (id) => {
    expect(errorsFor(manifest({ id }))[0]?.code).toBe('INVALID_ID')
  })

  it.each(['1', 'v1.0.0', '01.0.0', '1.0.0-', '1.0.0+', '9007199254740992.0.0'])('rejects invalid version %p', (version) => {
    expect(errorsFor(manifest({ version }))[0]?.code).toBe('INVALID_VERSION')
  })

  it('matches the semver library safe-integer boundary with a structured contract error', () => {
    expect(parseModuleManifest(manifest({ version: '9007199254740991.0.0' })).ok).toBe(true)
    expect(errorsFor(manifest({ version: '9007199254740992.0.0' }))).toEqual([
      { code: 'INVALID_VERSION', path: '/version', message: 'Module version must be valid Semantic Versioning' },
    ])
  })

  it.each(['macos-arm64', 'linux', 'darwin-universal'])('rejects invalid platform %p', (platform) => {
    const input = manifest()
    ;(input.artifacts as Array<Record<string, unknown>>)[0]!.platform = platform
    expect(errorsFor(input)[0]?.code).toBe('INVALID_PLATFORM')
  })

  it.each(['/bin/module', '../bin/module', 'bin/../module', 'bin\\module', 'bin//module', './module'])('rejects unsafe entrypoint %p', (entrypoint) => {
    const input = manifest()
    ;(input.artifacts as Array<Record<string, unknown>>)[0]!.entrypoint = entrypoint
    expect(errorsFor(input)[0]?.code).toBe('INVALID_ENTRYPOINT')
  })

  it.each([
    'http://modules.example.test/fake.tar.gz',
    'file:///tmp/fake.tar.gz',
    'https://user:secret@modules.example.test/fake.tar.gz',
    'https://modules.example.test/fake.tar.gz#fragment',
    'https://modules.example.test\\fake.tar.gz',
    'https://modules.example.test/\u0000file.tar.gz',
    'https://modules.example.test/\tfile.tar.gz',
    'https://modules.example.test/\nfile.tar.gz',
    'https://modules.example.test/\u007Ffile.tar.gz',
    'https://MODULES.example.test/fake.tar.gz',
    'https://modules.example.test:443/fake.tar.gz',
    'https://modules.example.test/a/../fake.tar.gz',
    'https://modules.example.test',
    'not-a-url',
  ])('rejects unsafe artifact URL %p', (url) => {
    const input = manifest()
    ;(input.artifacts as Array<Record<string, unknown>>)[0]!.url = url
    expect(errorsFor(input)[0]?.code).toBe('INVALID_URL')
  })

  it('accepts canonical HTTPS URLs and requires the canonical slash for an origin-only URL', () => {
    const input = manifest()
    ;(input.artifacts as Array<Record<string, unknown>>)[0]!.url = 'https://modules.example.test/'
    expect(parseModuleManifest(input).ok).toBe(true)
  })

  it.each(['abc', 'G'.repeat(64), 'A'.repeat(64), `${'a'.repeat(63)}z`])('rejects invalid SHA-256 %p', (sha256) => {
    const input = manifest()
    ;(input.artifacts as Array<Record<string, unknown>>)[0]!.sha256 = sha256
    expect(errorsFor(input)[0]?.code).toBe('INVALID_HASH')
  })

  it('rejects duplicate artifact platforms', () => {
    const input = manifest()
    const first = (input.artifacts as Array<Record<string, unknown>>)[0]!
    input.artifacts = [first, { ...first, url: 'https://modules.example.test/duplicate.tar.gz' }]
    expect(errorsFor(input)[0]).toEqual({
      code: 'DUPLICATE_DECLARATION',
      path: '/artifacts/1/platform',
      message: 'Artifact platform is declared more than once',
    })
  })

  it('rejects empty and sparse artifact declarations', () => {
    expect(errorsFor(manifest({ artifacts: [] }))[0]).toEqual({
      code: 'MISSING_FIELD',
      path: '/artifacts',
      message: 'At least one artifact is required',
    })

    const artifacts = new Array(1)
    expect(errorsFor(manifest({ artifacts }))[0]).toEqual({
      code: 'INVALID_TYPE',
      path: '/artifacts/0',
      message: 'Sparse arrays are not accepted',
    })
  })

  it.each([
    ['artifacts', MAX_MODULE_ARTIFACTS, 50_000_000],
    ['capabilities', MAX_MODULE_CAPABILITIES, 50_000_000],
  ] as const)('rejects oversized sparse %s before enumerating or traversing it', (field, maximum, length) => {
    let ownKeyEnumerations = 0
    const oversized = new Proxy(new Array(length), {
      ownKeys(target) {
        ownKeyEnumerations += 1
        return Reflect.ownKeys(target)
      },
    })
    const startedAt = performance.now()
    const errors = errorsFor(manifest({ [field]: oversized }))
    const elapsedMilliseconds = performance.now() - startedAt

    expect(errors[0]).toEqual({
      code: 'LIMIT_EXCEEDED',
      path: `/${field}`,
      message: `Array exceeds maximum item count of ${maximum}`,
    })
    expect(ownKeyEnumerations).toBe(0)
    expect(elapsedMilliseconds).toBeLessThan(100)
  })

  it('rejects wrong collection and collection member types', () => {
    expect(errorsFor(manifest({ artifacts: 'artifact' }))[0]).toEqual({
      code: 'INVALID_TYPE',
      path: '/artifacts',
      message: 'Expected an array',
    })
    expect(errorsFor(manifest({ capabilities: [1] }))[0]).toEqual({
      code: 'INVALID_TYPE',
      path: '/capabilities/0',
      message: 'Capability must be a string',
    })
  })

  it.each(['host.secrets.read', 'process.spawn', 'approval.grant', 'network.fetch'])('rejects unsupported authority capability %p', (capability) => {
    expect(errorsFor(manifest({ capabilities: [capability] }))[0]?.code).toBe('INVALID_CAPABILITY')
  })

  it('rejects duplicate capabilities', () => {
    expect(errorsFor(manifest({ capabilities: ['workspace.read', 'workspace.read'] }))[0]).toEqual({
      code: 'DUPLICATE_DECLARATION',
      path: '/capabilities/1',
      message: 'Capability is declared more than once',
    })
  })

  it('reports malformed fields in stable schema order', () => {
    const input = manifest({
      id: 'BAD',
      version: 'v1',
      artifacts: [{ platform: 'bad', entrypoint: '../bad', url: 'bad', sha256: 'bad' }],
      capabilities: ['bad'],
    })
    const first = errorsFor(input)
    const second = errorsFor(input)
    expect(second).toEqual(first)
    expect(first.map((item) => item.code)).toEqual([
      'INVALID_ID',
      'INVALID_VERSION',
      'INVALID_PLATFORM',
      'INVALID_ENTRYPOINT',
      'INVALID_URL',
      'INVALID_HASH',
      'INVALID_CAPABILITY',
    ])
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first[0])).toBe(true)
  })

  it('rejects accessor properties and unreadable proxies without throwing', () => {
    const accessorInput = manifest()
    Object.defineProperty(accessorInput, 'id', { get: () => 'org.simulator.fake', enumerable: true })
    expect(errorsFor(accessorInput)[0]?.code).toBe('UNREADABLE_INPUT')

    const proxy = new Proxy(manifest(), {
      getPrototypeOf() {
        throw new Error('blocked')
      },
    })
    expect(errorsFor(proxy)).toEqual([
      { code: 'UNREADABLE_INPUT', path: '', message: 'Module manifest could not be read as plain data' },
    ])
  })

  it('rejects indexed array accessors without executing them', () => {
    let executions = 0
    const capabilities: unknown[] = []
    Object.defineProperty(capabilities, 0, {
      enumerable: true,
      get() {
        executions += 1
        return 'workspace.read'
      },
    })
    capabilities.length = 1

    expect(errorsFor(manifest({ capabilities }))[0]).toEqual({
      code: 'UNREADABLE_INPUT',
      path: '/capabilities',
      message: 'Input must contain only plain data properties',
    })
    expect(executions).toBe(0)
  })
})
