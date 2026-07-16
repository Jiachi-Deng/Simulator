import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseModuleManifest } from '@simulator/module-contract'
import { ModuleRegistry } from '@simulator/module-registry'
import {
  loadOpenDesignCompatibilityAuthority,
  OPEN_DESIGN_0145_COMPATIBILITY_AUTHORITY_RELATIVE_PATH,
  parseOpenDesignCompatibilityAuthority,
} from '../open-design-compatibility-authority'
import {
  OPEN_DESIGN_0145_COMPATIBILITY_AUTHORITY_RESOURCE_NAME,
  OPEN_DESIGN_0145_COMPATIBILITY_AUTHORITY_RESOURCE_SHA256,
  OPEN_DESIGN_0145_ORIGINAL_HOST_VERSION_RANGE,
} from '../../shared/open-design-compatibility-authority-contract'

type MutableRecord = Record<string, unknown>
type Mutation = readonly [string, (input: MutableRecord) => void]

const REPOSITORY_ROOT = resolve(import.meta.dir, '../../../../..')
const SOURCE_AUTHORITY_PATH = join(
  REPOSITORY_ROOT,
  'apps/electron/resources',
  OPEN_DESIGN_0145_COMPATIBILITY_AUTHORITY_RESOURCE_NAME,
)

function nestedRecord(input: MutableRecord, key: string): MutableRecord {
  const value = input[key]
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Missing test record ${key}`)
  return value as MutableRecord
}

function nestedArray(input: MutableRecord, key: string): unknown[] {
  const value = input[key]
  if (!Array.isArray(value)) throw new Error(`Missing test array ${key}`)
  return value
}

async function authorityFixture(): Promise<{ readonly bytes: Uint8Array; readonly input: MutableRecord }> {
  const bytes = await readFile(SOURCE_AUTHORITY_PATH)
  return { bytes, input: JSON.parse(new TextDecoder().decode(bytes)) as MutableRecord }
}

async function loadFromSource(overrides: Partial<Parameters<typeof loadOpenDesignCompatibilityAuthority>[0]> = {}) {
  const { bytes } = await authorityFixture()
  return loadOpenDesignCompatibilityAuthority({
    isPackaged: true,
    resourcesPath: '/Simulator.app/Contents/Resources',
    hostVersion: '0.12.0',
    platform: 'darwin-arm64',
    readAuthority: async (path) => {
      expect(path).toBe(join(
        '/Simulator.app/Contents/Resources',
        OPEN_DESIGN_0145_COMPATIBILITY_AUTHORITY_RELATIVE_PATH,
      ))
      return bytes
    },
    ...overrides,
  })
}

describe('OpenDesign 0.14.5 packaged compatibility authority', () => {
  it('loads the exact reviewed bytes into one deeply frozen registry exception', async () => {
    const result = await loadFromSource()
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') throw new Error(result.errorCode)

    expect(result.compatibilityException).toMatchObject({
      host: { version: '0.12.0', platform: 'darwin-arm64' },
      hostVersionRange: OPEN_DESIGN_0145_ORIGINAL_HOST_VERSION_RANGE,
      manifest: {
        id: 'org.simulator.open-design',
        version: '0.14.5',
        capabilities: ['host-agent.use', 'workspace.read', 'workspace.write'],
        artifacts: [{
          platform: 'darwin-arm64',
          sha256: 'f883aaedd588c62d8a7ba6a4f94b6e2c8e448f9a8816758d6dbeb468a68d3e09',
        }],
      },
    })
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.compatibilityException)).toBe(true)
    expect(Object.isFrozen(result.compatibilityException.manifest)).toBe(true)
    expect(Object.isFrozen(result.compatibilityException.manifest.artifacts)).toBe(true)

    const bytes = await readFile(SOURCE_AUTHORITY_PATH)
    expect(createHash('sha256').update(bytes).digest('hex'))
      .toBe(OPEN_DESIGN_0145_COMPATIBILITY_AUTHORITY_RESOURCE_SHA256)
  })

  it('is unavailable outside the exact packaged Host 0.12.0 darwin-arm64 tuple', async () => {
    expect(await loadFromSource({ isPackaged: false })).toMatchObject({
      status: 'not-ready',
      errorCode: 'COMPATIBILITY_AUTHORITY_PACKAGED_RESOURCE_UNAVAILABLE',
    })
    expect(await loadFromSource({ hostVersion: '0.12.1' })).toMatchObject({
      status: 'not-ready',
      errorCode: 'COMPATIBILITY_AUTHORITY_HOST_MISMATCH',
    })
    expect(await loadFromSource({ platform: 'linux-x64' })).toMatchObject({
      status: 'not-ready',
      errorCode: 'COMPATIBILITY_AUTHORITY_HOST_MISMATCH',
    })
  })

  it('keeps refreshable catalog and envelope digests out of the runtime exception', async () => {
    const result = await loadFromSource()
    if (result.status !== 'ready') throw new Error(result.errorCode)

    expect(Object.keys(result.compatibilityException).sort()).toEqual([
      'host',
      'hostVersionRange',
      'manifest',
    ])
    const runtimeAuthority = JSON.stringify(result.compatibilityException)
    expect(runtimeAuthority).not.toContain('3832da6574c0eb9808e0b001205318b271996748b39fe2edcb330c5d1c3b4848')
    expect(runtimeAuthority).not.toContain('caa18a16f1ded49b47ae54fced2dd0afe139571ba503b4c176929b6bc1e24a7c')
  })

  it('fails closed for missing, unreadable, empty, oversized, invalid UTF-8, or tampered bytes', async () => {
    const missing = Object.assign(new Error('missing'), { code: 'ENOENT' })
    expect(await loadFromSource({ readAuthority: async () => { throw missing } })).toMatchObject({
      status: 'not-ready',
      errorCode: 'COMPATIBILITY_AUTHORITY_RESOURCE_MISSING',
    })
    expect(await loadFromSource({ readAuthority: async () => { throw new Error('denied') } })).toMatchObject({
      status: 'not-ready',
      errorCode: 'COMPATIBILITY_AUTHORITY_RESOURCE_UNREADABLE',
    })
    for (const bytes of [
      new Uint8Array(),
      new Uint8Array(64 * 1024 + 1),
      Uint8Array.from([0xff]),
      Buffer.concat([await readFile(SOURCE_AUTHORITY_PATH), Buffer.from('\n')]),
    ]) {
      expect(await loadFromSource({ readAuthority: async () => bytes })).toMatchObject({
        status: 'not-ready',
        errorCode: 'COMPATIBILITY_AUTHORITY_RESOURCE_INVALID',
      })
    }
  })

  it('strictly binds every host, manifest, release-evidence, key, protocol, and rationale field', async () => {
    const mutations: readonly Mutation[] = [
      ['unknown root field', (input) => { input.unknown = true }],
      ['authority id', (input) => { input.authorityId = 'another-authority' }],
      ['host version', (input) => { nestedRecord(input, 'host').version = '0.12.1' }],
      ['host platform', (input) => { nestedRecord(input, 'host').platform = 'linux-x64' }],
      ['original range', (input) => { input.originalHostVersionRange = '>=0.11.0 <0.12.0' }],
      ['manifest id', (input) => { nestedRecord(input, 'manifest').id = 'org.simulator.other' }],
      ['manifest version', (input) => { nestedRecord(input, 'manifest').version = '0.14.6' }],
      ['artifact URL', (input) => {
        const artifact = nestedArray(nestedRecord(input, 'manifest'), 'artifacts')[0] as MutableRecord
        artifact.url = 'https://example.invalid/module.tar.gz'
      }],
      ['artifact SHA', (input) => {
        const artifact = nestedArray(nestedRecord(input, 'manifest'), 'artifacts')[0] as MutableRecord
        artifact.sha256 = '0'.repeat(64)
      }],
      ['artifact entrypoint', (input) => {
        const artifact = nestedArray(nestedRecord(input, 'manifest'), 'artifacts')[0] as MutableRecord
        artifact.entrypoint = 'runtime/other'
      }],
      ['auxiliary executables', (input) => {
        const artifact = nestedArray(nestedRecord(input, 'manifest'), 'artifacts')[0] as MutableRecord
        artifact.auxiliaryExecutables = ['runtime/node/bin/node']
      }],
      ['capability order', (input) => {
        nestedRecord(input, 'manifest').capabilities = ['workspace.read', 'host-agent.use', 'workspace.write']
      }],
      ['catalog URL', (input) => { nestedRecord(input, 'releaseEvidence').catalogUrl = 'https://example.invalid/catalog.json' }],
      ['initial published catalog SHA', (input) => {
        nestedRecord(input, 'releaseEvidence').initialPublishedCatalogSha256 = '0'.repeat(64)
      }],
      ['initial published envelope SHA', (input) => {
        nestedRecord(input, 'releaseEvidence').initialPublishedEnvelopeSha256 = '0'.repeat(64)
      }],
      ['archive size', (input) => { nestedRecord(input, 'releaseEvidence').archiveSize = 1 }],
      ['extracted manifest SHA', (input) => {
        nestedRecord(input, 'releaseEvidence').extractedManifestSha256 = '0'.repeat(64)
      }],
      ['release tag', (input) => {
        nestedRecord(nestedRecord(input, 'releaseEvidence'), 'githubRelease').tag = 'open-design-v0.14.6'
      }],
      ['key id', (input) => {
        nestedRecord(nestedRecord(input, 'releaseEvidence'), 'trustedKey').keyId = 'another-key'
      }],
      ['public key', (input) => {
        nestedRecord(nestedRecord(input, 'releaseEvidence'), 'trustedKey').publicKey = Buffer.alloc(32).toString('base64')
      }],
      ['public key fingerprint', (input) => {
        nestedRecord(nestedRecord(input, 'releaseEvidence'), 'trustedKey').publicKeyRawSha256 = '0'.repeat(64)
      }],
      ['protocol', (input) => { input.protocol = 'v2' }],
      ['rationale', (input) => { input.rationale = 'broad exception' }],
    ]

    const { input: original } = await authorityFixture()
    expect(parseOpenDesignCompatibilityAuthority(original)).toBeDefined()
    for (const [, mutate] of mutations) {
      const candidate = structuredClone(original)
      expect(() => mutate(candidate)).not.toThrow()
      expect(parseOpenDesignCompatibilityAuthority(candidate)).toBeUndefined()
    }

    const sparse = structuredClone(original)
    delete nestedArray(nestedRecord(sparse, 'manifest'), 'artifacts')[0]
    expect(parseOpenDesignCompatibilityAuthority(sparse)).toBeUndefined()
  })

  it('suppresses only the exact 0.14.5 host-version mismatch in ModuleRegistry', async () => {
    const loaded = await loadFromSource()
    if (loaded.status !== 'ready') throw new Error(loaded.errorCode)
    const exact = loaded.compatibilityException

    const registry = new ModuleRegistry(exact.host, undefined, {
      compatibilityExceptions: [exact],
    })
    expect(registry.install(exact.manifest, {
      hostVersionRange: exact.hostVersionRange,
    }).ok).toBe(true)

    const noAuthority = new ModuleRegistry(exact.host)
    expect(noAuthority.install(exact.manifest, {
      hostVersionRange: exact.hostVersionRange,
    }).diagnostics.map((item) => item.code)).toEqual(['INCOMPATIBLE_HOST_VERSION'])

    const wrongHost = new ModuleRegistry({ version: '0.12.1', platform: 'darwin-arm64' }, undefined, {
      compatibilityExceptions: [exact],
    })
    expect(wrongHost.install(exact.manifest, {
      hostVersionRange: exact.hostVersionRange,
    }).diagnostics.map((item) => item.code)).toEqual(['INCOMPATIBLE_HOST_VERSION'])

    const changedManifestInput = structuredClone(exact.manifest) as unknown as {
      artifacts: Array<{ sha256: string }>
    }
    changedManifestInput.artifacts[0]!.sha256 = '0'.repeat(64)
    const changedManifest = parseModuleManifest(changedManifestInput)
    if (!changedManifest.ok) throw new Error('Changed manifest fixture must remain valid')
    const changedRegistry = new ModuleRegistry(exact.host, undefined, {
      compatibilityExceptions: [exact],
    })
    expect(changedRegistry.install(changedManifest.value, {
      hostVersionRange: exact.hostVersionRange,
    }).diagnostics.map((item) => item.code)).toEqual(['INCOMPATIBLE_HOST_VERSION'])

    const changedRangeRegistry = new ModuleRegistry(exact.host, undefined, {
      compatibilityExceptions: [exact],
    })
    expect(changedRangeRegistry.install(exact.manifest, {
      hostVersionRange: '>=0.11.0 <0.12.0',
    }).diagnostics.map((item) => item.code)).toEqual(['INCOMPATIBLE_HOST_VERSION'])
  })
})
