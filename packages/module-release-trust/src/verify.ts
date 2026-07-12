import { createPublicKey, verify as verifySignature } from 'node:crypto'
import {
  MODULE_PLATFORMS,
  parseModuleManifest,
  type ModuleArtifact,
  type ModuleManifest,
  type ModulePlatform,
} from '@simulator/module-contract'
import { encodeCanonicalCatalog, equalBytes } from './canonical.ts'
import {
  MODULE_RELEASE_CATALOG_SCHEMA_VERSION,
  MODULE_RELEASE_ENVELOPE_SCHEMA_VERSION,
  type ModuleArtifactSize,
  type ModuleRelease,
  type ModuleReleaseCatalog,
  type ModuleReleaseTrustDiagnostic,
  type ModuleReleaseTrustDiagnosticCode,
  type ModuleReleaseTrustStage,
  type TrustedReleaseKey,
  type VerifyModuleReleaseCatalogOptions,
  type VerifyModuleReleaseCatalogResult,
} from './types.ts'

type DataRecord = Record<string, unknown>

const ENVELOPE_FIELDS = ['schemaVersion', 'keyId', 'catalogBytes', 'signature'] as const
const CATALOG_FIELDS = ['schemaVersion', 'sequence', 'issuedAt', 'expiresAt', 'releases'] as const
const RELEASE_FIELDS = ['manifest', 'artifactSizes'] as const
const SIZE_FIELDS = ['platform', 'size'] as const
const KEY_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/
const PLATFORM_SET = new Set<string>(MODULE_PLATFORMS)
const MAX_CATALOG_BYTES = 4 * 1024 * 1024
const MAX_RELEASES = 10_000
const ED25519_PUBLIC_KEY_BYTES = 32
const ED25519_SIGNATURE_BYTES = 64
const ED25519_SPKI_PREFIX = Uint8Array.from([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00])

function freeze<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object' && !ArrayBuffer.isView(value) && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const nested of Object.values(value as Record<string, unknown>)) freeze(nested)
  }
  return value
}

function diagnostic(
  code: ModuleReleaseTrustDiagnosticCode,
  stage: ModuleReleaseTrustStage,
  path: string,
  message: string,
  keyId?: string,
): ModuleReleaseTrustDiagnostic {
  return keyId === undefined ? { code, stage, path, message } : { code, stage, path, message, keyId }
}

function fail(...diagnostics: ModuleReleaseTrustDiagnostic[]): VerifyModuleReleaseCatalogResult {
  return freeze({ ok: false as const, diagnostics: diagnostics.map((item) => freeze({ ...item })) })
}

function asRecord(value: unknown): DataRecord | undefined {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return undefined
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string' || descriptors[key]?.get || descriptors[key]?.set)) {
      return undefined
    }
    const record: DataRecord = Object.create(null) as DataRecord
    for (const key of Object.keys(descriptors)) record[key] = descriptors[key]?.value
    return record
  } catch {
    return undefined
  }
}

function hasExactFields(record: DataRecord, fields: readonly string[]): boolean {
  const actual = Object.keys(record).sort()
  const expected = [...fields].sort()
  return actual.length === expected.length && actual.every((field, index) => field === expected[index])
}

function copyBytes(value: unknown, maximum: number): Uint8Array | undefined {
  try {
    if (!(value instanceof Uint8Array) || value.byteLength > maximum) return undefined
    return Uint8Array.from(value)
  } catch {
    return undefined
  }
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) return undefined
  return milliseconds
}

function validateTrustedKeys(keys: readonly TrustedReleaseKey[]): ModuleReleaseTrustDiagnostic[] {
  const diagnostics: ModuleReleaseTrustDiagnostic[] = []
  const seen = new Set<string>()
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]!
    const path = `/trustedKeys/${index}`
    if (!KEY_ID_PATTERN.test(key.keyId) || key.publicKey.byteLength !== ED25519_PUBLIC_KEY_BYTES) {
      diagnostics.push(diagnostic('INVALID_TRUSTED_KEY', 'trust', path, 'Trusted key has an invalid key ID or Ed25519 public key'))
      continue
    }
    if (seen.has(key.keyId)) {
      diagnostics.push(diagnostic('DUPLICATE_TRUSTED_KEY', 'trust', `${path}/keyId`, 'Trusted key ID is declared more than once', key.keyId))
      continue
    }
    seen.add(key.keyId)
    const activeFrom = parseTimestamp(key.activeFrom)
    const activeUntil = key.activeUntil === undefined ? undefined : parseTimestamp(key.activeUntil)
    const revokedAt = key.revokedAt === undefined ? undefined : parseTimestamp(key.revokedAt)
    if (activeFrom === undefined || (key.activeUntil !== undefined && activeUntil === undefined)
      || (key.revokedAt !== undefined && revokedAt === undefined)
      || (activeUntil !== undefined && activeFrom >= activeUntil)
      || (revokedAt !== undefined && revokedAt <= activeFrom)) {
      diagnostics.push(diagnostic('INVALID_TRUSTED_KEY', 'trust', path, 'Trusted key has an invalid activation, expiry, or revocation window', key.keyId))
    }
  }
  return diagnostics
}

function verifyEd25519(publicKey: Uint8Array, bytes: Uint8Array, signature: Uint8Array): boolean {
  try {
    const spki = new Uint8Array(ED25519_SPKI_PREFIX.byteLength + publicKey.byteLength)
    spki.set(ED25519_SPKI_PREFIX)
    spki.set(publicKey, ED25519_SPKI_PREFIX.byteLength)
    const key = createPublicKey({ key: Buffer.from(spki), format: 'der', type: 'spki' })
    return verifySignature(null, bytes, key, signature)
  } catch {
    return false
  }
}

function parseArtifactSizes(
  value: unknown,
  manifest: ModuleManifest,
  releaseIndex: number,
  diagnostics: ModuleReleaseTrustDiagnostic[],
): readonly ModuleArtifactSize[] | undefined {
  const path = `/releases/${releaseIndex}/artifactSizes`
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > MODULE_PLATFORMS.length) {
    diagnostics.push(diagnostic('INVALID_RELEASE', 'catalog', path, 'Artifact sizes must be a bounded plain array'))
    return undefined
  }
  const byPlatform = new Map<ModulePlatform, ModuleArtifactSize>()
  for (let index = 0; index < value.length; index += 1) {
    const itemPath = `${path}/${index}`
    if (!Object.hasOwn(value, index)) {
      diagnostics.push(diagnostic('INVALID_RELEASE', 'catalog', itemPath, 'Sparse artifact size arrays are not accepted'))
      continue
    }
    const record = asRecord(value[index])
    if (!record || !hasExactFields(record, SIZE_FIELDS)) {
      diagnostics.push(diagnostic('INVALID_RELEASE', 'catalog', itemPath, 'Artifact size must contain only platform and size'))
      continue
    }
    const platform = record.platform
    const size = record.size
    if (typeof platform !== 'string' || !PLATFORM_SET.has(platform)) {
      diagnostics.push(diagnostic('UNKNOWN_PLATFORM_SIZE', 'catalog', `${itemPath}/platform`, 'Artifact size references an unsupported platform'))
      continue
    }
    if (!Number.isSafeInteger(size) || (size as number) <= 0) {
      diagnostics.push(diagnostic('INVALID_ARTIFACT_SIZE', 'catalog', `${itemPath}/size`, 'Artifact size must be a positive safe integer'))
      continue
    }
    const typedPlatform = platform as ModulePlatform
    if (byPlatform.has(typedPlatform)) {
      diagnostics.push(diagnostic('DUPLICATE_PLATFORM', 'catalog', `${itemPath}/platform`, 'Artifact size platform is declared more than once'))
      continue
    }
    byPlatform.set(typedPlatform, freeze({ platform: typedPlatform, size: size as number }))
  }

  const manifestPlatforms = new Set(manifest.artifacts.map((artifact: ModuleArtifact) => artifact.platform))
  for (const platform of manifestPlatforms) {
    if (!byPlatform.has(platform)) {
      diagnostics.push(diagnostic('MISSING_PLATFORM_SIZE', 'catalog', path, `Missing artifact size for platform ${platform}`))
    }
  }
  for (const platform of byPlatform.keys()) {
    if (!manifestPlatforms.has(platform)) {
      diagnostics.push(diagnostic('UNKNOWN_PLATFORM_SIZE', 'catalog', path, `Artifact size has no manifest artifact for platform ${platform}`))
    }
  }
  return [...byPlatform.values()]
}

function parseCatalog(value: unknown): { catalog?: ModuleReleaseCatalog; diagnostics: ModuleReleaseTrustDiagnostic[] } {
  const diagnostics: ModuleReleaseTrustDiagnostic[] = []
  const record = asRecord(value)
  if (!record || !hasExactFields(record, CATALOG_FIELDS)) {
    return { diagnostics: [diagnostic('INVALID_CATALOG', 'catalog', '', 'Catalog must contain exactly the v1 catalog fields')] }
  }
  if (record.schemaVersion !== MODULE_RELEASE_CATALOG_SCHEMA_VERSION) {
    return { diagnostics: [diagnostic('UNSUPPORTED_CATALOG_SCHEMA', 'catalog', '/schemaVersion', 'Unsupported module release catalog schema version')] }
  }
  if (!Number.isSafeInteger(record.sequence) || (record.sequence as number) < 1) {
    diagnostics.push(diagnostic('INVALID_SEQUENCE', 'catalog', '/sequence', 'Catalog sequence must be a positive safe integer'))
  }
  const issuedAt = parseTimestamp(record.issuedAt)
  const expiresAt = parseTimestamp(record.expiresAt)
  if (issuedAt === undefined) diagnostics.push(diagnostic('INVALID_TIMESTAMP', 'catalog', '/issuedAt', 'issuedAt must be a canonical ISO-8601 timestamp'))
  if (expiresAt === undefined) diagnostics.push(diagnostic('INVALID_TIMESTAMP', 'catalog', '/expiresAt', 'expiresAt must be a canonical ISO-8601 timestamp'))
  if (issuedAt !== undefined && expiresAt !== undefined && issuedAt >= expiresAt) {
    diagnostics.push(diagnostic('INVALID_TIME_WINDOW', 'catalog', '/expiresAt', 'Catalog expiry must be after issuance'))
  }
  if (!Array.isArray(record.releases) || Object.getPrototypeOf(record.releases) !== Array.prototype) {
    diagnostics.push(diagnostic('INVALID_CATALOG', 'catalog', '/releases', 'Catalog releases must be a plain array'))
    return { diagnostics }
  }
  if (record.releases.length > MAX_RELEASES) {
    diagnostics.push(diagnostic('LIMIT_EXCEEDED', 'catalog', '/releases', `Catalog exceeds maximum release count of ${MAX_RELEASES}`))
    return { diagnostics }
  }

  const releases: ModuleRelease[] = []
  const seenReleases = new Set<string>()
  for (let index = 0; index < record.releases.length; index += 1) {
    const path = `/releases/${index}`
    if (!Object.hasOwn(record.releases, index)) {
      diagnostics.push(diagnostic('INVALID_RELEASE', 'catalog', path, 'Sparse release arrays are not accepted'))
      continue
    }
    const releaseRecord = asRecord(record.releases[index])
    if (!releaseRecord || !hasExactFields(releaseRecord, RELEASE_FIELDS)) {
      diagnostics.push(diagnostic('INVALID_RELEASE', 'catalog', path, 'Release must contain exactly manifest and artifactSizes'))
      continue
    }
    const manifestResult = parseModuleManifest(releaseRecord.manifest)
    if (!manifestResult.ok) {
      for (const manifestError of manifestResult.errors) {
        diagnostics.push(diagnostic('INVALID_MANIFEST', 'catalog', `${path}/manifest${manifestError.path}`, `${manifestError.code}: ${manifestError.message}`))
      }
      continue
    }
    const identity = `${manifestResult.value.id}\u0000${manifestResult.value.version}`
    if (seenReleases.has(identity)) {
      diagnostics.push(diagnostic('DUPLICATE_MODULE_VERSION', 'catalog', `${path}/manifest/version`, 'Module ID and version are declared more than once'))
    } else {
      seenReleases.add(identity)
    }
    const artifactSizes = parseArtifactSizes(releaseRecord.artifactSizes, manifestResult.value, index, diagnostics)
    if (artifactSizes) releases.push(freeze({ manifest: manifestResult.value, artifactSizes: freeze([...artifactSizes]) }))
  }

  if (diagnostics.length > 0 || issuedAt === undefined || expiresAt === undefined || !Number.isSafeInteger(record.sequence)) {
    return { diagnostics }
  }
  return {
    diagnostics,
    catalog: freeze({
      schemaVersion: MODULE_RELEASE_CATALOG_SCHEMA_VERSION,
      sequence: record.sequence as number,
      issuedAt: record.issuedAt as string,
      expiresAt: record.expiresAt as string,
      releases: freeze(releases),
    }),
  }
}

export function verifyModuleReleaseCatalog(
  envelopeInput: unknown,
  options: VerifyModuleReleaseCatalogOptions,
): VerifyModuleReleaseCatalogResult {
  const envelope = asRecord(envelopeInput)
  if (!envelope || !hasExactFields(envelope, ENVELOPE_FIELDS)) {
    return fail(diagnostic('INVALID_ENVELOPE', 'envelope', '', 'Envelope must contain exactly the v1 envelope fields'))
  }
  if (envelope.schemaVersion !== MODULE_RELEASE_ENVELOPE_SCHEMA_VERSION) {
    return fail(diagnostic('UNSUPPORTED_ENVELOPE_SCHEMA', 'envelope', '/schemaVersion', 'Unsupported module release envelope schema version'))
  }
  if (typeof envelope.keyId !== 'string' || !KEY_ID_PATTERN.test(envelope.keyId)) {
    return fail(diagnostic('INVALID_KEY_ID', 'envelope', '/keyId', 'Envelope key ID is invalid'))
  }
  const catalogBytes = copyBytes(envelope.catalogBytes, MAX_CATALOG_BYTES)
  if (!catalogBytes || catalogBytes.byteLength === 0) {
    return fail(diagnostic('INVALID_BYTE_FIELD', 'envelope', '/catalogBytes', `Catalog bytes must be a non-empty Uint8Array up to ${MAX_CATALOG_BYTES} bytes`, envelope.keyId))
  }
  const signature = copyBytes(envelope.signature, ED25519_SIGNATURE_BYTES)
  if (!signature || signature.byteLength !== ED25519_SIGNATURE_BYTES) {
    return fail(diagnostic('INVALID_SIGNATURE_LENGTH', 'envelope', '/signature', `Ed25519 signature must be ${ED25519_SIGNATURE_BYTES} bytes`, envelope.keyId))
  }

  const keyDiagnostics = validateTrustedKeys(options.trustedKeys)
  if (keyDiagnostics.length > 0) return fail(...keyDiagnostics)
  const trustedKey = options.trustedKeys.find((candidate) => candidate.keyId === envelope.keyId)
  if (!trustedKey) return fail(diagnostic('UNTRUSTED_KEY', 'trust', '/keyId', 'Envelope key is not in the trusted key set', envelope.keyId))
  if (!verifyEd25519(Uint8Array.from(trustedKey.publicKey), catalogBytes, signature)) {
    return fail(diagnostic('SIGNATURE_INVALID', 'signature', '/signature', 'Ed25519 signature does not authenticate the exact catalog bytes', envelope.keyId))
  }

  let decoded: string
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(catalogBytes)
  } catch {
    return fail(diagnostic('INVALID_UTF8', 'bytes', '/catalogBytes', 'Signed catalog bytes are not valid UTF-8', envelope.keyId))
  }
  let json: unknown
  try {
    json = JSON.parse(decoded)
  } catch {
    return fail(diagnostic('INVALID_JSON', 'bytes', '/catalogBytes', 'Signed catalog bytes are not valid JSON', envelope.keyId))
  }
  let canonical: Uint8Array
  try {
    canonical = encodeCanonicalCatalog(json)
  } catch {
    return fail(diagnostic('NON_CANONICAL_BYTES', 'bytes', '/catalogBytes', 'Signed catalog contains values outside canonical JSON', envelope.keyId))
  }
  if (!equalBytes(catalogBytes, canonical)) {
    return fail(diagnostic('NON_CANONICAL_BYTES', 'bytes', '/catalogBytes', 'Signed catalog bytes are not the canonical representation', envelope.keyId))
  }

  const parsed = parseCatalog(json)
  if (!parsed.catalog) return fail(...parsed.diagnostics)
  const catalog = parsed.catalog
  const issuedAt = Date.parse(catalog.issuedAt)
  const expiresAt = Date.parse(catalog.expiresAt)
  const activeFrom = Date.parse(trustedKey.activeFrom)
  const activeUntil = trustedKey.activeUntil === undefined ? undefined : Date.parse(trustedKey.activeUntil)
  const revokedAt = trustedKey.revokedAt === undefined ? undefined : Date.parse(trustedKey.revokedAt)
  if (issuedAt < activeFrom) return fail(diagnostic('KEY_NOT_ACTIVE', 'trust', '/issuedAt', 'Catalog was issued before the signing key activation window', envelope.keyId))
  if (activeUntil !== undefined && issuedAt >= activeUntil) return fail(diagnostic('KEY_EXPIRED', 'trust', '/issuedAt', 'Catalog was issued after the signing key activation window', envelope.keyId))
  if (revokedAt !== undefined && issuedAt >= revokedAt) return fail(diagnostic('KEY_REVOKED', 'trust', '/issuedAt', 'Catalog was issued at or after key revocation', envelope.keyId))

  const now = options.now ?? Date.now()
  const clockSkewMs = options.clockSkewMs ?? 0
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(clockSkewMs) || clockSkewMs < 0) {
    return fail(diagnostic('INVALID_TIME_WINDOW', 'catalog', '', 'now and clockSkewMs must be non-negative safe integer milliseconds'))
  }
  if (issuedAt > now + clockSkewMs) return fail(diagnostic('CATALOG_NOT_YET_VALID', 'catalog', '/issuedAt', 'Catalog issuance is beyond the allowed clock skew', envelope.keyId))
  if (expiresAt <= now - clockSkewMs) return fail(diagnostic('CATALOG_EXPIRED', 'catalog', '/expiresAt', 'Catalog has expired beyond the allowed clock skew', envelope.keyId))

  if (!Number.isSafeInteger(options.state.highestSequence) || options.state.highestSequence < 0) {
    return fail(diagnostic('INVALID_SEQUENCE', 'rollback', '/state/highestSequence', 'Trust state sequence must be a non-negative safe integer'))
  }
  if (catalog.sequence <= options.state.highestSequence) {
    return fail(diagnostic('ROLLBACK_DETECTED', 'rollback', '/sequence', 'Catalog sequence does not advance the trusted high-water mark', envelope.keyId))
  }
  return freeze({
    ok: true as const,
    catalog,
    state: freeze({ highestSequence: catalog.sequence }),
    keyId: envelope.keyId,
  })
}
