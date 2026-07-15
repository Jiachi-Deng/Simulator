import { createPublicKey, verify as verifySignature } from 'node:crypto'
import {
  MODULE_PLATFORMS,
  parseModuleManifest,
  type ModuleArtifact,
  type ModuleManifest,
  type ModulePlatform,
} from '@simulator/module-contract'
import { encodeCanonicalCatalog, equalBytes, MAX_CANONICAL_CATALOG_BYTES } from './canonical.ts'
import {
  MAX_MODULE_RELEASE_CATALOG_TTL_MS,
  MAX_MODULE_RELEASE_CLOCK_SKEW_MS,
  MAX_TRUSTED_RELEASE_KEYS,
  MODULE_RELEASE_CATALOG_SCHEMA_VERSION_V1,
  MODULE_RELEASE_CATALOG_SCHEMA_VERSION_V2,
  MODULE_RELEASE_ENVELOPE_SCHEMA_VERSION,
  type ModuleArtifactInstallMetadataV2,
  type ModuleArtifactSize,
  type ModuleReleaseCatalog,
  type ModuleReleaseV1,
  type ModuleReleaseV2,
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
const RELEASE_V1_FIELDS = ['manifest', 'artifactSizes'] as const
const RELEASE_V2_FIELDS = ['manifest', 'artifactSizes', 'hostVersionRange', 'artifactInstallMetadata'] as const
const SIZE_FIELDS = ['platform', 'size'] as const
const INSTALL_METADATA_FIELDS = ['platform', 'extractedManifestSha256'] as const
const OPTIONS_FIELDS = ['trustedKeys', 'state', 'now', 'clockSkewMs'] as const
const TRUSTED_KEY_FIELDS = ['keyId', 'publicKey', 'activeFrom', 'activeUntil', 'revokedAt'] as const
const TRUST_STATE_FIELDS = ['highestSequence', 'latestIssuedAt'] as const
const KEY_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/
const PLATFORM_SET = new Set<string>(MODULE_PLATFORMS)
const MAX_RELEASES = 10_000
const ED25519_PUBLIC_KEY_BYTES = 32
const ED25519_SIGNATURE_BYTES = 64
const ED25519_SPKI_PREFIX = Uint8Array.from([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00])
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const MAX_HOST_VERSION_RANGE_BYTES = 256

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

function hasOnlyFields(record: DataRecord, allowed: readonly string[], required: readonly string[]): boolean {
  const keys = Object.keys(record)
  return required.every((field) => Object.hasOwn(record, field)) && keys.every((field) => allowed.includes(field))
}

function asPlainArray(value: unknown, maximum: number): readonly unknown[] | undefined {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) return undefined
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const keys = Reflect.ownKeys(descriptors)
    if (keys.some((key) => typeof key !== 'string') || keys.length !== value.length + 1) return undefined
    const result: unknown[] = []
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[index]
      if (!descriptor || descriptor.get || descriptor.set || !Object.hasOwn(descriptor, 'value')) return undefined
      result.push(descriptor.value)
    }
    return result
  } catch {
    return undefined
  }
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

interface ParsedOptions {
  readonly trustedKeys: readonly TrustedReleaseKey[]
  readonly state: {
    readonly highestSequence: number
    readonly latestIssuedAt?: string
  }
  readonly now: number
  readonly clockSkewMs: number
}

function parseOptions(input: unknown): { value?: ParsedOptions; diagnostics: ModuleReleaseTrustDiagnostic[] } {
  const diagnostics: ModuleReleaseTrustDiagnostic[] = []
  const record = asRecord(input)
  if (!record || !hasOnlyFields(record, OPTIONS_FIELDS, ['trustedKeys', 'state'])) {
    return { diagnostics: [diagnostic('INVALID_OPTIONS', 'trust', '', 'Options must contain trustedKeys and state with only supported fields')] }
  }

  const keyValues = asPlainArray(record.trustedKeys, MAX_TRUSTED_RELEASE_KEYS)
  if (!keyValues) {
    return { diagnostics: [diagnostic('INVALID_OPTIONS', 'trust', '/trustedKeys', `trustedKeys must be a dense plain array with at most ${MAX_TRUSTED_RELEASE_KEYS} entries`)] }
  }

  const keys: TrustedReleaseKey[] = []
  const seen = new Set<string>()
  for (let index = 0; index < keyValues.length; index += 1) {
    const path = `/trustedKeys/${index}`
    const key = asRecord(keyValues[index])
    if (!key || !hasOnlyFields(key, TRUSTED_KEY_FIELDS, ['keyId', 'publicKey', 'activeFrom'])) {
      diagnostics.push(diagnostic('INVALID_TRUSTED_KEY', 'trust', path, 'Trusted key must be a plain data object with only supported fields'))
      continue
    }
    const keyId = key.keyId
    const publicKey = copyBytes(key.publicKey, ED25519_PUBLIC_KEY_BYTES)
    if (typeof keyId !== 'string' || !KEY_ID_PATTERN.test(keyId) || !publicKey || publicKey.byteLength !== ED25519_PUBLIC_KEY_BYTES) {
      diagnostics.push(diagnostic('INVALID_TRUSTED_KEY', 'trust', path, 'Trusted key has an invalid key ID or Ed25519 public key'))
      continue
    }
    if (seen.has(keyId)) {
      diagnostics.push(diagnostic('DUPLICATE_TRUSTED_KEY', 'trust', `${path}/keyId`, 'Trusted key ID is declared more than once', keyId))
      continue
    }
    seen.add(keyId)
    const activeFrom = parseTimestamp(key.activeFrom)
    const activeUntil = key.activeUntil === undefined ? undefined : parseTimestamp(key.activeUntil)
    const revokedAt = key.revokedAt === undefined ? undefined : parseTimestamp(key.revokedAt)
    if (activeFrom === undefined || (key.activeUntil !== undefined && activeUntil === undefined)
      || (key.revokedAt !== undefined && revokedAt === undefined)
      || (activeUntil !== undefined && activeFrom >= activeUntil)
      || (revokedAt !== undefined && revokedAt <= activeFrom)) {
      diagnostics.push(diagnostic('INVALID_TRUSTED_KEY', 'trust', path, 'Trusted key has an invalid activation, expiry, or revocation window', keyId))
      continue
    }
    keys.push(freeze({
      keyId,
      publicKey,
      activeFrom: key.activeFrom as string,
      ...(key.activeUntil === undefined ? {} : { activeUntil: key.activeUntil as string }),
      ...(key.revokedAt === undefined ? {} : { revokedAt: key.revokedAt as string }),
    }))
  }
  if (diagnostics.length > 0) return { diagnostics }

  const state = asRecord(record.state)
  if (!state || !hasOnlyFields(state, TRUST_STATE_FIELDS, ['highestSequence'])
    || !Number.isSafeInteger(state.highestSequence) || (state.highestSequence as number) < 0) {
    return { diagnostics: [diagnostic('INVALID_OPTIONS', 'rollback', '/state', 'State must contain a non-negative safe integer highestSequence')] }
  }
  const latestIssuedAt = state.latestIssuedAt === undefined ? undefined : parseTimestamp(state.latestIssuedAt)
  if ((state.latestIssuedAt !== undefined && latestIssuedAt === undefined)
    || ((state.highestSequence as number) === 0 && latestIssuedAt !== undefined)
    || ((state.highestSequence as number) > 0 && latestIssuedAt === undefined)) {
    return { diagnostics: [diagnostic('INVALID_OPTIONS', 'rollback', '/state/latestIssuedAt', 'State must pair a positive highestSequence with canonical latestIssuedAt')] }
  }

  const now = record.now === undefined ? Date.now() : record.now
  const clockSkewMs = record.clockSkewMs === undefined ? 0 : record.clockSkewMs
  if (!Number.isSafeInteger(now) || (now as number) < 0
    || !Number.isSafeInteger(clockSkewMs) || (clockSkewMs as number) < 0
    || (clockSkewMs as number) > MAX_MODULE_RELEASE_CLOCK_SKEW_MS
    || !Number.isSafeInteger((now as number) + (clockSkewMs as number))) {
    return { diagnostics: [diagnostic('INVALID_OPTIONS', 'trust', '', `now must be a non-negative safe integer and clockSkewMs must be between 0 and ${MAX_MODULE_RELEASE_CLOCK_SKEW_MS}`)] }
  }

  return {
    diagnostics,
    value: freeze({
      trustedKeys: freeze(keys),
      state: freeze({
        highestSequence: state.highestSequence as number,
        ...(latestIssuedAt === undefined ? {} : { latestIssuedAt: state.latestIssuedAt as string }),
      }),
      now: now as number,
      clockSkewMs: clockSkewMs as number,
    }),
  }
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

function parseHostVersionRange(
  value: unknown,
  releaseIndex: number,
  diagnostics: ModuleReleaseTrustDiagnostic[],
): string | undefined {
  const path = `/releases/${releaseIndex}/hostVersionRange`
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_HOST_VERSION_RANGE_BYTES
    || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) {
    diagnostics.push(diagnostic('INVALID_HOST_VERSION_RANGE', 'catalog', path, 'Host version range must be a bounded non-empty trimmed string'))
    return undefined
  }
  return value
}

function parseArtifactInstallMetadata(
  value: unknown,
  manifest: ModuleManifest,
  releaseIndex: number,
  diagnostics: ModuleReleaseTrustDiagnostic[],
): readonly ModuleArtifactInstallMetadataV2[] | undefined {
  const path = `/releases/${releaseIndex}/artifactInstallMetadata`
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > MODULE_PLATFORMS.length) {
    diagnostics.push(diagnostic('INVALID_RELEASE', 'catalog', path, 'Artifact install metadata must be a bounded plain array'))
    return undefined
  }
  const byPlatform = new Map<ModulePlatform, ModuleArtifactInstallMetadataV2>()
  for (let index = 0; index < value.length; index += 1) {
    const itemPath = `${path}/${index}`
    if (!Object.hasOwn(value, index)) {
      diagnostics.push(diagnostic('INVALID_RELEASE', 'catalog', itemPath, 'Sparse artifact install metadata arrays are not accepted'))
      continue
    }
    const record = asRecord(value[index])
    if (!record || !hasExactFields(record, INSTALL_METADATA_FIELDS)) {
      diagnostics.push(diagnostic('INVALID_RELEASE', 'catalog', itemPath, 'Artifact install metadata must contain only platform and extractedManifestSha256'))
      continue
    }
    const platform = record.platform
    if (typeof platform !== 'string' || !PLATFORM_SET.has(platform)) {
      diagnostics.push(diagnostic('UNKNOWN_PLATFORM_INSTALL_METADATA', 'catalog', `${itemPath}/platform`, 'Artifact install metadata references an unsupported platform'))
      continue
    }
    if (typeof record.extractedManifestSha256 !== 'string' || !SHA256_PATTERN.test(record.extractedManifestSha256)) {
      diagnostics.push(diagnostic('INVALID_EXTRACTED_MANIFEST_SHA256', 'catalog', `${itemPath}/extractedManifestSha256`, 'Extracted manifest SHA-256 must be lowercase hexadecimal'))
      continue
    }
    const typedPlatform = platform as ModulePlatform
    if (byPlatform.has(typedPlatform)) {
      diagnostics.push(diagnostic('DUPLICATE_PLATFORM', 'catalog', `${itemPath}/platform`, 'Artifact install metadata platform is declared more than once'))
      continue
    }
    byPlatform.set(typedPlatform, freeze({
      platform: typedPlatform,
      extractedManifestSha256: record.extractedManifestSha256 as ModuleArtifactInstallMetadataV2['extractedManifestSha256'],
    }))
  }

  const manifestPlatforms = new Set(manifest.artifacts.map((artifact: ModuleArtifact) => artifact.platform))
  for (const platform of manifestPlatforms) {
    if (!byPlatform.has(platform)) {
      diagnostics.push(diagnostic('MISSING_PLATFORM_INSTALL_METADATA', 'catalog', path, `Missing artifact install metadata for platform ${platform}`))
    }
  }
  for (const platform of byPlatform.keys()) {
    if (!manifestPlatforms.has(platform)) {
      diagnostics.push(diagnostic('UNKNOWN_PLATFORM_INSTALL_METADATA', 'catalog', path, `Artifact install metadata has no manifest artifact for platform ${platform}`))
    }
  }
  return [...byPlatform.values()]
}

function parseCatalog(value: unknown): { catalog?: ModuleReleaseCatalog; diagnostics: ModuleReleaseTrustDiagnostic[] } {
  const diagnostics: ModuleReleaseTrustDiagnostic[] = []
  const record = asRecord(value)
  if (!record || !hasExactFields(record, CATALOG_FIELDS)) {
    return { diagnostics: [diagnostic('INVALID_CATALOG', 'catalog', '', 'Catalog must contain exactly the supported catalog fields')] }
  }
  if (record.schemaVersion !== MODULE_RELEASE_CATALOG_SCHEMA_VERSION_V1
    && record.schemaVersion !== MODULE_RELEASE_CATALOG_SCHEMA_VERSION_V2) {
    return { diagnostics: [diagnostic('UNSUPPORTED_CATALOG_SCHEMA', 'catalog', '/schemaVersion', 'Unsupported module release catalog schema version')] }
  }
  const schemaVersion = record.schemaVersion
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

  const releasesV1: ModuleReleaseV1[] = []
  const releasesV2: ModuleReleaseV2[] = []
  const seenReleases = new Set<string>()
  for (let index = 0; index < record.releases.length; index += 1) {
    const path = `/releases/${index}`
    if (!Object.hasOwn(record.releases, index)) {
      diagnostics.push(diagnostic('INVALID_RELEASE', 'catalog', path, 'Sparse release arrays are not accepted'))
      continue
    }
    const releaseRecord = asRecord(record.releases[index])
    const releaseFields = schemaVersion === MODULE_RELEASE_CATALOG_SCHEMA_VERSION_V1 ? RELEASE_V1_FIELDS : RELEASE_V2_FIELDS
    if (!releaseRecord || !hasExactFields(releaseRecord, releaseFields)) {
      diagnostics.push(diagnostic('INVALID_RELEASE', 'catalog', path, `Release must contain exactly the schema v${schemaVersion} release fields`))
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
    if (!artifactSizes) continue
    if (schemaVersion === MODULE_RELEASE_CATALOG_SCHEMA_VERSION_V1) {
      releasesV1.push(freeze({ manifest: manifestResult.value, artifactSizes: freeze([...artifactSizes]) }))
      continue
    }
    const hostVersionRange = parseHostVersionRange(releaseRecord.hostVersionRange, index, diagnostics)
    const artifactInstallMetadata = parseArtifactInstallMetadata(releaseRecord.artifactInstallMetadata, manifestResult.value, index, diagnostics)
    if (hostVersionRange && artifactInstallMetadata) {
      releasesV2.push(freeze({
        manifest: manifestResult.value,
        artifactSizes: freeze([...artifactSizes]),
        hostVersionRange,
        artifactInstallMetadata: freeze([...artifactInstallMetadata]),
      }))
    }
  }

  if (diagnostics.length > 0 || issuedAt === undefined || expiresAt === undefined || !Number.isSafeInteger(record.sequence)) {
    return { diagnostics }
  }
  const common = {
      sequence: record.sequence as number,
      issuedAt: record.issuedAt as string,
      expiresAt: record.expiresAt as string,
  }
  return {
    diagnostics,
    catalog: schemaVersion === MODULE_RELEASE_CATALOG_SCHEMA_VERSION_V1
      ? freeze({ schemaVersion, ...common, releases: freeze(releasesV1) })
      : freeze({ schemaVersion, ...common, releases: freeze(releasesV2) }),
  }
}

export function verifyModuleReleaseCatalog(
  envelopeInput: unknown,
  optionsInput: VerifyModuleReleaseCatalogOptions,
): VerifyModuleReleaseCatalogResult {
  const parsedOptions = parseOptions(optionsInput)
  if (!parsedOptions.value) return fail(...parsedOptions.diagnostics)
  const options = parsedOptions.value

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
  const catalogBytes = copyBytes(envelope.catalogBytes, MAX_CANONICAL_CATALOG_BYTES)
  if (!catalogBytes || catalogBytes.byteLength === 0) {
    return fail(diagnostic('INVALID_BYTE_FIELD', 'envelope', '/catalogBytes', `Catalog bytes must be a non-empty Uint8Array up to ${MAX_CANONICAL_CATALOG_BYTES} bytes`, envelope.keyId))
  }
  const signature = copyBytes(envelope.signature, ED25519_SIGNATURE_BYTES)
  if (!signature || signature.byteLength !== ED25519_SIGNATURE_BYTES) {
    return fail(diagnostic('INVALID_SIGNATURE_LENGTH', 'envelope', '/signature', `Ed25519 signature must be ${ED25519_SIGNATURE_BYTES} bytes`, envelope.keyId))
  }

  const trustedKey = options.trustedKeys.find((candidate) => candidate.keyId === envelope.keyId)
  if (!trustedKey) return fail(diagnostic('UNTRUSTED_KEY', 'trust', '/keyId', 'Envelope key is not in the trusted key set', envelope.keyId))
  const activeFrom = Date.parse(trustedKey.activeFrom)
  const activeUntil = trustedKey.activeUntil === undefined ? undefined : Date.parse(trustedKey.activeUntil)
  const revokedAt = trustedKey.revokedAt === undefined ? undefined : Date.parse(trustedKey.revokedAt)
  if (options.now < activeFrom) {
    return fail(diagnostic('KEY_NOT_ACTIVE', 'trust', '/trustedKeys', 'Signing key is not active at the trusted current time', envelope.keyId))
  }
  if (activeUntil !== undefined && options.now >= activeUntil) {
    return fail(diagnostic('KEY_EXPIRED', 'trust', '/trustedKeys', 'Signing key is outside its acceptance window at the trusted current time', envelope.keyId))
  }
  if (revokedAt !== undefined && options.now >= revokedAt) {
    return fail(diagnostic('KEY_REVOKED', 'trust', '/trustedKeys', 'Signing key is revoked at the trusted current time', envelope.keyId))
  }
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
  if (issuedAt < activeFrom) return fail(diagnostic('KEY_NOT_ACTIVE', 'trust', '/issuedAt', 'Catalog was issued before the signing key activation window', envelope.keyId))
  if (activeUntil !== undefined && issuedAt >= activeUntil) return fail(diagnostic('KEY_EXPIRED', 'trust', '/issuedAt', 'Catalog was issued after the signing key activation window', envelope.keyId))
  if (revokedAt !== undefined && issuedAt >= revokedAt) return fail(diagnostic('KEY_REVOKED', 'trust', '/issuedAt', 'Catalog was issued at or after key revocation', envelope.keyId))
  if (expiresAt - issuedAt > MAX_MODULE_RELEASE_CATALOG_TTL_MS) {
    return fail(diagnostic('CATALOG_TTL_EXCEEDED', 'catalog', '/expiresAt', `Catalog lifetime exceeds ${MAX_MODULE_RELEASE_CATALOG_TTL_MS} milliseconds`, envelope.keyId))
  }
  if (activeUntil !== undefined && expiresAt > activeUntil) {
    return fail(diagnostic('KEY_EXPIRED', 'trust', '/expiresAt', 'Catalog expiry exceeds the signing key validity window', envelope.keyId))
  }
  if (revokedAt !== undefined && expiresAt > revokedAt) {
    return fail(diagnostic('KEY_REVOKED', 'trust', '/expiresAt', 'Catalog expiry exceeds the signing key revocation boundary', envelope.keyId))
  }
  if (issuedAt > options.now + options.clockSkewMs) return fail(diagnostic('CATALOG_NOT_YET_VALID', 'catalog', '/issuedAt', 'Catalog issuance is beyond the allowed clock skew', envelope.keyId))
  if (expiresAt <= options.now - options.clockSkewMs) return fail(diagnostic('CATALOG_EXPIRED', 'catalog', '/expiresAt', 'Catalog has expired beyond the allowed clock skew', envelope.keyId))

  if (catalog.sequence <= options.state.highestSequence) {
    return fail(diagnostic('ROLLBACK_DETECTED', 'rollback', '/sequence', 'Catalog sequence does not advance the trusted high-water mark', envelope.keyId))
  }
  if (options.state.latestIssuedAt !== undefined && issuedAt <= Date.parse(options.state.latestIssuedAt)) {
    return fail(diagnostic('BACKDATED_CATALOG', 'rollback', '/issuedAt', 'Catalog issuance does not advance the trusted issuance high-water mark', envelope.keyId))
  }
  return freeze({
    ok: true as const,
    catalog,
    state: freeze({ highestSequence: catalog.sequence, latestIssuedAt: catalog.issuedAt }),
    keyId: envelope.keyId,
  })
}
