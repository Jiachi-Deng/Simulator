import { describe, expect, it } from 'bun:test'
import { generateKeyPairSync, sign } from 'node:crypto'
import { encodeCanonicalCatalog } from './canonical.ts'
import { EXTERNAL_ED25519_VECTOR } from './test-vectors/external-ed25519.ts'
import { verifyModuleReleaseCatalog } from './verify.ts'
import {
  MAX_TRUSTED_RELEASE_KEYS,
  type ModuleReleaseEnvelopeV1,
  type TrustedReleaseKey,
  type VerifyModuleReleaseCatalogOptions,
} from './types.ts'

const ISSUED_AT = '2026-07-12T12:00:00.000Z'
const EXPIRES_AT = '2026-07-13T12:00:00.000Z'
const NOW = Date.parse('2026-07-12T18:00:00.000Z')

// Test-only keys are generated in memory. No private key or seed is shipped by the package.
function testKey(keyId: string, overrides: Partial<TrustedReleaseKey> = {}) {
  const pair = generateKeyPairSync('ed25519')
  const spki = pair.publicKey.export({ format: 'der', type: 'spki' })
  const trustedKey: TrustedReleaseKey = {
    keyId,
    publicKey: Uint8Array.from(spki.subarray(spki.byteLength - 32)),
    activeFrom: '2026-07-01T00:00:00.000Z',
    ...overrides,
  }
  return { pair, trustedKey }
}

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    id: 'org.simulator.example',
    version: '1.2.3',
    artifacts: [
      {
        platform: 'darwin-arm64',
        entrypoint: 'bin/example',
        url: 'https://modules.example.test/example-1.2.3-darwin-arm64.tar.gz',
        sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      },
    ],
    capabilities: ['artifact.read'],
    ...overrides,
  }
}

function catalog(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    sequence: 7,
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
    releases: [
      {
        manifest: manifest(),
        artifactSizes: [{ platform: 'darwin-arm64', size: 4096 }],
      },
    ],
    ...overrides,
  }
}

function catalogV2(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 2,
    sequence: 8,
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
    releases: [
      {
        manifest: manifest(),
        artifactSizes: [{ platform: 'darwin-arm64', size: 4096 }],
        hostVersionRange: '>=0.11.0 <0.12.0-0',
        artifactInstallMetadata: [{
          platform: 'darwin-arm64',
          extractedManifestSha256: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
        }],
      },
    ],
    ...overrides,
  }
}

function envelopeFor(value: unknown, privateKey: ReturnType<typeof testKey>['pair']['privateKey'], keyId = 'release-2026') {
  const catalogBytes = encodeCanonicalCatalog(value)
  return {
    schemaVersion: 1,
    keyId,
    catalogBytes,
    signature: Uint8Array.from(sign(null, catalogBytes, privateKey)),
  } satisfies ModuleReleaseEnvelopeV1
}

function verify(
  envelope: unknown,
  trustedKeys: readonly TrustedReleaseKey[],
  overrides: Record<string, unknown> = {},
) {
  return verifyModuleReleaseCatalog(envelope, {
    trustedKeys,
    state: { highestSequence: 0 },
    now: NOW,
    ...overrides,
  })
}

function diagnosticCodes(result: ReturnType<typeof verifyModuleReleaseCatalog>) {
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('Expected verification to fail')
  return result.diagnostics.map((item) => item.code)
}

function unsafeOptions(value: unknown): VerifyModuleReleaseCatalogOptions {
  return value as VerifyModuleReleaseCatalogOptions
}

describe('verifyModuleReleaseCatalog', () => {
  it('verifies exact Ed25519-signed canonical bytes and returns deeply immutable release metadata', () => {
    const { pair, trustedKey } = testKey('release-2026')
    const result = verify(envelopeFor(catalog(), pair.privateKey), [trustedKey])
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('Expected catalog verification to succeed')

    const release = result.catalog.releases[0]!
    expect(result.state).toEqual({ highestSequence: 7, latestIssuedAt: ISSUED_AT })
    expect(release.manifest.artifacts[0]).toMatchObject({
      url: 'https://modules.example.test/example-1.2.3-darwin-arm64.tar.gz',
      sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    })
    expect(release.artifactSizes[0]?.size).toBe(4096)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.catalog)).toBe(true)
    expect(Object.isFrozen(release.manifest.artifacts[0]!)).toBe(true)
    expect(Object.isFrozen(release.artifactSizes[0]!)).toBe(true)
  })

  it('keeps v1 catalogs compatible while authenticating production install metadata in v2', () => {
    const { pair, trustedKey } = testKey('release-2026')
    const legacy = verify(envelopeFor(catalog(), pair.privateKey), [trustedKey])
    const production = verify(envelopeFor(catalogV2(), pair.privateKey), [trustedKey])

    expect(legacy.ok).toBe(true)
    expect(production.ok).toBe(true)
    if (!production.ok) throw new Error('Expected v2 catalog verification to succeed')
    expect(production.catalog.schemaVersion).toBe(2)
    const release = production.catalog.releases[0]!
    expect(release).toMatchObject({
      hostVersionRange: '>=0.11.0 <0.12.0-0',
      artifactInstallMetadata: [{
        platform: 'darwin-arm64',
        extractedManifestSha256: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
      }],
    })
    expect(Object.isFrozen(release)).toBe(true)
    expect(Object.isFrozen((release as { artifactInstallMetadata: readonly unknown[] }).artifactInstallMetadata)).toBe(true)
  })

  it('rejects incomplete or malformed v2 install metadata before returning a catalog', () => {
    const { pair, trustedKey } = testKey('release-2026')
    const base = catalogV2().releases[0]!
    const invalidReleases = [
      { ...base, hostVersionRange: '' },
      { ...base, hostVersionRange: ' >=0.11.0' },
      { ...base, artifactInstallMetadata: [] },
      { ...base, artifactInstallMetadata: [{ platform: 'linux-x64', extractedManifestSha256: 'a'.repeat(64) }] },
      { ...base, artifactInstallMetadata: [{ platform: 'darwin-arm64', extractedManifestSha256: 'not-a-sha256' }] },
      { ...base, artifactInstallMetadata: [
        { platform: 'darwin-arm64', extractedManifestSha256: 'a'.repeat(64) },
        { platform: 'darwin-arm64', extractedManifestSha256: 'b'.repeat(64) },
      ] },
    ]

    for (const release of invalidReleases) {
      expect(verify(envelopeFor(catalogV2({ releases: [release] }), pair.privateKey), [trustedKey]).ok).toBe(false)
    }
  })

  it('rejects v1 release shape under schema v2 and v2-only fields under schema v1', () => {
    const { pair, trustedKey } = testKey('release-2026')
    expect(diagnosticCodes(verify(envelopeFor(catalogV2({ releases: catalog().releases }), pair.privateKey), [trustedKey])))
      .toContain('INVALID_RELEASE')
    expect(diagnosticCodes(verify(envelopeFor(catalog({ releases: catalogV2().releases }), pair.privateKey), [trustedKey])))
      .toContain('INVALID_RELEASE')
  })

  it('rejects mutation of any authenticated catalog byte', () => {
    const { pair, trustedKey } = testKey('release-2026')
    const envelope = envelopeFor(catalog(), pair.privateKey)
    envelope.catalogBytes[10] = envelope.catalogBytes[10]! ^ 1
    expect(diagnosticCodes(verify(envelope, [trustedKey]))).toEqual(['SIGNATURE_INVALID'])
  })

  it('rejects valid signatures from keys outside the trusted set', () => {
    const signer = testKey('untrusted')
    const trusted = testKey('trusted')
    const envelope = envelopeFor(catalog(), signer.pair.privateKey, signer.trustedKey.keyId)
    expect(diagnosticCodes(verify(envelope, [trusted.trustedKey]))).toEqual(['UNTRUSTED_KEY'])
  })

  it('supports key rotation with explicit non-overlapping activation windows', () => {
    const oldKey = testKey('release-old', { activeUntil: '2026-07-10T00:00:00.000Z' })
    const newKey = testKey('release-new', { activeFrom: '2026-07-10T00:00:00.000Z' })
    const accepted = verify(envelopeFor(catalog(), newKey.pair.privateKey, 'release-new'), [oldKey.trustedKey, newKey.trustedKey])
    expect(accepted.ok).toBe(true)

    const oldEnvelope = envelopeFor(catalog(), oldKey.pair.privateKey, 'release-old')
    expect(diagnosticCodes(verify(oldEnvelope, [oldKey.trustedKey, newKey.trustedKey]))).toEqual(['KEY_EXPIRED'])
  })

  it('enforces key activation and revocation against catalog issuance', () => {
    const future = testKey('release-future', { activeFrom: '2026-07-13T00:00:00.000Z' })
    expect(diagnosticCodes(verify(envelopeFor(catalog(), future.pair.privateKey, 'release-future'), [future.trustedKey]))).toEqual(['KEY_NOT_ACTIVE'])

    const revoked = testKey('release-revoked', { revokedAt: '2026-07-12T00:00:00.000Z' })
    expect(diagnosticCodes(verify(envelopeFor(catalog(), revoked.pair.privateKey, 'release-revoked'), [revoked.trustedKey]))).toEqual(['KEY_REVOKED'])
  })

  it('rejects a catalog issued before revocation once trusted now reaches revokedAt', () => {
    const revoked = testKey('release-revoked-now', { revokedAt: '2026-07-12T18:00:00.000Z' })
    const issuedBeforeRevocation = catalog({
      issuedAt: '2026-07-12T12:00:00.000Z',
      expiresAt: '2026-07-13T12:00:00.000Z',
      sequence: 8,
    })
    const result = verify(envelopeFor(issuedBeforeRevocation, revoked.pair.privateKey, revoked.trustedKey.keyId), [revoked.trustedKey])
    expect(diagnosticCodes(result)).toEqual(['KEY_REVOKED'])
    if (!result.ok) expect(result.diagnostics[0]?.message).toContain('trusted current time')
  })

  it('bounds acceptance and catalog expiry by activeUntil and revocation', () => {
    const expiredNow = testKey('release-expired-now', { activeUntil: '2026-07-12T18:00:00.000Z' })
    expect(diagnosticCodes(verify(envelopeFor(catalog(), expiredNow.pair.privateKey, expiredNow.trustedKey.keyId), [expiredNow.trustedKey]))).toEqual(['KEY_EXPIRED'])

    const expiresSoon = testKey('release-expires-soon', { activeUntil: '2026-07-13T00:00:00.000Z' })
    expect(diagnosticCodes(verify(envelopeFor(catalog(), expiresSoon.pair.privateKey, expiresSoon.trustedKey.keyId), [expiresSoon.trustedKey]))).toEqual(['KEY_EXPIRED'])

    const revokedSoon = testKey('release-revoked-soon', { revokedAt: '2026-07-13T00:00:00.000Z' })
    expect(diagnosticCodes(verify(envelopeFor(catalog(), revokedSoon.pair.privateKey, revokedSoon.trustedKey.keyId), [revokedSoon.trustedKey]))).toEqual(['KEY_REVOKED'])
  })

  it('rejects catalogs beyond the strict maximum TTL', () => {
    const { pair, trustedKey } = testKey('release-2026')
    const tooLong = catalog({ expiresAt: '2026-07-13T12:00:00.001Z' })
    expect(diagnosticCodes(verify(envelopeFor(tooLong, pair.privateKey), [trustedKey]))).toEqual(['CATALOG_TTL_EXCEEDED'])
  })

  it('enforces issuance, expiry, and bounded clock skew', () => {
    const { pair, trustedKey } = testKey('release-2026')
    const futureCatalog = catalog({ issuedAt: '2026-07-12T18:00:01.000Z', expiresAt: '2026-07-13T18:00:01.000Z' })
    const futureEnvelope = envelopeFor(futureCatalog, pair.privateKey)
    expect(diagnosticCodes(verify(futureEnvelope, [trustedKey]))).toEqual(['CATALOG_NOT_YET_VALID'])
    expect(verify(futureEnvelope, [trustedKey], { clockSkewMs: 1_000 }).ok).toBe(true)

    const expiredCatalog = catalog({ expiresAt: '2026-07-12T17:59:59.000Z' })
    const expiredEnvelope = envelopeFor(expiredCatalog, pair.privateKey)
    expect(diagnosticCodes(verify(expiredEnvelope, [trustedKey]))).toEqual(['CATALOG_EXPIRED'])
    expect(verify(expiredEnvelope, [trustedKey], { clockSkewMs: 1_001 }).ok).toBe(true)
  })

  it('rejects rollback and replay at or below the monotonic high-water mark', () => {
    const { pair, trustedKey } = testKey('release-2026')
    const envelope = envelopeFor(catalog({ sequence: 7 }), pair.privateKey)
    const latestIssuedAt = '2026-07-12T11:00:00.000Z'
    expect(diagnosticCodes(verify(envelope, [trustedKey], { state: { highestSequence: 7, latestIssuedAt } }))).toEqual(['ROLLBACK_DETECTED'])
    expect(diagnosticCodes(verify(envelope, [trustedKey], { state: { highestSequence: 8, latestIssuedAt } }))).toEqual(['ROLLBACK_DETECTED'])
  })

  it('rejects a backdated catalog with a poisoning high sequence', () => {
    const { pair, trustedKey } = testKey('release-2026')
    const backdated = catalog({
      sequence: Number.MAX_SAFE_INTEGER,
      issuedAt: '2026-07-12T11:00:00.000Z',
      expiresAt: '2026-07-13T11:00:00.000Z',
    })
    const result = verify(envelopeFor(backdated, pair.privateKey), [trustedKey], {
      state: { highestSequence: 7, latestIssuedAt: ISSUED_AT },
    })
    expect(diagnosticCodes(result)).toEqual(['BACKDATED_CATALOG'])
  })

  it('rejects signed but non-canonical JSON bytes without normalizing the signature input', () => {
    const { pair, trustedKey } = testKey('release-2026')
    const nonCanonicalBytes = new TextEncoder().encode(JSON.stringify(catalog(), null, 2))
    const envelope = {
      schemaVersion: 1,
      keyId: 'release-2026',
      catalogBytes: nonCanonicalBytes,
      signature: Uint8Array.from(sign(null, nonCanonicalBytes, pair.privateKey)),
    }
    expect(diagnosticCodes(verify(envelope, [trustedKey]))).toEqual(['NON_CANONICAL_BYTES'])
  })

  it('rejects duplicate module/version release identities', () => {
    const { pair, trustedKey } = testKey('release-2026')
    const release = { manifest: manifest(), artifactSizes: [{ platform: 'darwin-arm64', size: 4096 }] }
    const envelope = envelopeFor(catalog({ releases: [release, release] }), pair.privateKey)
    expect(diagnosticCodes(verify(envelope, [trustedKey]))).toContain('DUPLICATE_MODULE_VERSION')
  })

  it('rejects duplicate artifact-size platforms', () => {
    const { pair, trustedKey } = testKey('release-2026')
    const releases = [{
      manifest: manifest(),
      artifactSizes: [
        { platform: 'darwin-arm64', size: 4096 },
        { platform: 'darwin-arm64', size: 8192 },
      ],
    }]
    const envelope = envelopeFor(catalog({ releases }), pair.privateKey)
    expect(diagnosticCodes(verify(envelope, [trustedKey]))).toContain('DUPLICATE_PLATFORM')
  })

  it('delegates manifest validation for duplicate platforms, hashes, and canonical HTTPS URLs', () => {
    const { pair, trustedKey } = testKey('release-2026')
    const badArtifact = {
      platform: 'darwin-arm64',
      entrypoint: 'bin/example',
      url: 'https://MODULES.example.test/example.tar.gz',
      sha256: 'not-a-sha256',
    }
    const releases = [{
      manifest: manifest({ artifacts: [badArtifact, { ...badArtifact }] }),
      artifactSizes: [{ platform: 'darwin-arm64', size: 4096 }],
    }]
    const result = verify(envelopeFor(catalog({ releases }), pair.privateKey), [trustedKey])
    expect(diagnosticCodes(result)).toEqual(expect.arrayContaining(['INVALID_MANIFEST']))
    if (!result.ok) {
      expect(result.diagnostics.some((item) => item.message.startsWith('INVALID_URL:'))).toBe(true)
      expect(result.diagnostics.some((item) => item.message.startsWith('INVALID_HASH:'))).toBe(true)
    }
  })

  it('rejects missing, unknown, zero, and negative artifact sizes', () => {
    const { pair, trustedKey } = testKey('release-2026')
    for (const artifactSizes of [
      [],
      [{ platform: 'darwin-arm64', size: 0 }],
      [{ platform: 'darwin-arm64', size: -1 }],
      [{ platform: 'linux-x64', size: 4096 }],
    ]) {
      const releases = [{ manifest: manifest(), artifactSizes }]
      expect(verify(envelopeFor(catalog({ releases }), pair.privateKey), [trustedKey]).ok).toBe(false)
    }
  })

  it('refuses to encode unsafe numeric values into canonical signed bytes', () => {
    const releases = [{
      manifest: manifest(),
      artifactSizes: [{ platform: 'darwin-arm64', size: Number.MAX_SAFE_INTEGER + 1 }],
    }]
    expect(() => encodeCanonicalCatalog(catalog({ releases }))).toThrow('Canonical catalog numbers must be safe integers')
  })

  it('copies envelope bytes before asynchronous caller mutation can affect verification', () => {
    const { pair, trustedKey } = testKey('release-2026')
    const envelope = envelopeFor(catalog(), pair.privateKey)
    const result = verify(envelope, [trustedKey])
    envelope.catalogBytes.fill(0)
    envelope.signature.fill(0)
    expect(result.ok).toBe(true)
  })

  it('returns structured diagnostics with stage, JSON pointer path, and key ID', () => {
    const { pair, trustedKey } = testKey('release-2026')
    const envelope = envelopeFor(catalog({ sequence: 1 }), pair.privateKey)
    const result = verify(envelope, [trustedKey], { state: { highestSequence: 1, latestIssuedAt: '2026-07-12T11:00:00.000Z' } })
    expect(result).toEqual({
      ok: false,
      diagnostics: [{
        code: 'ROLLBACK_DETECTED',
        stage: 'rollback',
        path: '/sequence',
        message: 'Catalog sequence does not advance the trusted high-water mark',
        keyId: 'release-2026',
      }],
    })
  })

  it('rejects unreadable envelopes without executing accessors or throwing on proxies', () => {
    let getterCalls = 0
    const accessorEnvelope = Object.defineProperty({}, 'catalogBytes', {
      enumerable: true,
      get() {
        getterCalls += 1
        return new Uint8Array()
      },
    })
    expect(diagnosticCodes(verify(accessorEnvelope, []))).toEqual(['INVALID_ENVELOPE'])
    expect(getterCalls).toBe(0)

    const unreadableEnvelope = new Proxy({}, {
      ownKeys() {
        throw new Error('unreadable')
      },
    })
    expect(diagnosticCodes(verify(unreadableEnvelope, []))).toEqual(['INVALID_ENVELOPE'])
  })

  it('validates null and unreadable options, trusted key entries, and state without getters or throws', () => {
    expect(diagnosticCodes(verifyModuleReleaseCatalog({}, unsafeOptions(null)))).toEqual(['INVALID_OPTIONS'])
    expect(diagnosticCodes(verifyModuleReleaseCatalog({}, unsafeOptions({ trustedKeys: null, state: { highestSequence: 0 } })))).toEqual(['INVALID_OPTIONS'])
    expect(diagnosticCodes(verifyModuleReleaseCatalog({}, unsafeOptions({ trustedKeys: [], state: null })))).toEqual(['INVALID_OPTIONS'])
    expect(diagnosticCodes(verifyModuleReleaseCatalog({}, unsafeOptions({
      trustedKeys: [],
      state: { highestSequence: 1 },
    })))).toEqual(['INVALID_OPTIONS'])

    let getterCalls = 0
    const accessorOptions = Object.defineProperty({}, 'trustedKeys', {
      enumerable: true,
      get() {
        getterCalls += 1
        return []
      },
    })
    expect(diagnosticCodes(verifyModuleReleaseCatalog({}, unsafeOptions(accessorOptions)))).toEqual(['INVALID_OPTIONS'])

    const accessorKey = Object.defineProperty({}, 'keyId', {
      enumerable: true,
      get() {
        getterCalls += 1
        return 'key'
      },
    })
    expect(diagnosticCodes(verifyModuleReleaseCatalog({}, unsafeOptions({
      trustedKeys: [accessorKey],
      state: { highestSequence: 0 },
    })))).toEqual(['INVALID_TRUSTED_KEY'])

    const accessorState = Object.defineProperty({}, 'highestSequence', {
      enumerable: true,
      get() {
        getterCalls += 1
        return 0
      },
    })
    expect(diagnosticCodes(verifyModuleReleaseCatalog({}, unsafeOptions({
      trustedKeys: [],
      state: accessorState,
    })))).toEqual(['INVALID_OPTIONS'])

    const unreadableKey = new Proxy({}, {
      ownKeys() {
        throw new Error('unreadable')
      },
    })
    expect(diagnosticCodes(verifyModuleReleaseCatalog({}, unsafeOptions({
      trustedKeys: [unreadableKey],
      state: { highestSequence: 0 },
    })))).toEqual(['INVALID_TRUSTED_KEY'])
    expect(getterCalls).toBe(0)
  })

  it('enforces the trusted key count resource bound before traversing entries', () => {
    const trustedKeys = new Array(MAX_TRUSTED_RELEASE_KEYS + 1).fill(null)
    expect(diagnosticCodes(verifyModuleReleaseCatalog({}, unsafeOptions({
      trustedKeys,
      state: { highestSequence: 0 },
    })))).toEqual(['INVALID_OPTIONS'])
  })

  it('verifies a fixed external public vector and rejects catalog or signature bit flips', () => {
    const catalogBytes = Uint8Array.from(Buffer.from(EXTERNAL_ED25519_VECTOR.catalogBytesBase64, 'base64'))
    const signature = Uint8Array.from(Buffer.from(EXTERNAL_ED25519_VECTOR.signatureBase64, 'base64'))
    const publicKey = Uint8Array.from(Buffer.from(EXTERNAL_ED25519_VECTOR.publicKeyBase64, 'base64'))
    const envelope = {
      schemaVersion: 1,
      keyId: EXTERNAL_ED25519_VECTOR.keyId,
      catalogBytes,
      signature,
    }
    const trustedKey = {
      keyId: EXTERNAL_ED25519_VECTOR.keyId,
      publicKey,
      activeFrom: '2026-07-01T00:00:00.000Z',
    }
    expect(verify(envelope, [trustedKey]).ok).toBe(true)

    const changedCatalog = { ...envelope, catalogBytes: Uint8Array.from(catalogBytes) }
    changedCatalog.catalogBytes[0] = changedCatalog.catalogBytes[0]! ^ 1
    expect(diagnosticCodes(verify(changedCatalog, [trustedKey]))).toEqual(['SIGNATURE_INVALID'])

    const changedSignature = { ...envelope, signature: Uint8Array.from(signature) }
    changedSignature.signature[0] = changedSignature.signature[0]! ^ 1
    expect(diagnosticCodes(verify(changedSignature, [trustedKey]))).toEqual(['SIGNATURE_INVALID'])
  })
})
