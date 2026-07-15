import type { ModuleManifest, ModulePlatform, ModuleSha256 } from '@simulator/module-contract'

export const MODULE_RELEASE_CATALOG_SCHEMA_VERSION_V1 = 1 as const
export const MODULE_RELEASE_CATALOG_SCHEMA_VERSION_V2 = 2 as const
/** Latest schema emitted by production publishers. Verification continues to accept v1. */
export const MODULE_RELEASE_CATALOG_SCHEMA_VERSION = MODULE_RELEASE_CATALOG_SCHEMA_VERSION_V2
export const MODULE_RELEASE_ENVELOPE_SCHEMA_VERSION = 1 as const
export const MAX_TRUSTED_RELEASE_KEYS = 64
export const MAX_MODULE_RELEASE_CATALOG_TTL_MS = 24 * 60 * 60 * 1_000
export const MAX_MODULE_RELEASE_CLOCK_SKEW_MS = 5 * 60 * 1_000

export interface ModuleArtifactSize {
  readonly platform: ModulePlatform
  readonly size: number
}

export interface ModuleArtifactInstallMetadataV2 {
  readonly platform: ModulePlatform
  readonly extractedManifestSha256: ModuleSha256
}

export interface ModuleReleaseV1 {
  readonly manifest: ModuleManifest
  readonly artifactSizes: readonly ModuleArtifactSize[]
}

export interface ModuleReleaseV2 extends ModuleReleaseV1 {
  readonly hostVersionRange: string
  readonly artifactInstallMetadata: readonly ModuleArtifactInstallMetadataV2[]
}

export type ModuleRelease = ModuleReleaseV1 | ModuleReleaseV2

export interface ModuleReleaseCatalogV1 {
  readonly schemaVersion: typeof MODULE_RELEASE_CATALOG_SCHEMA_VERSION_V1
  readonly sequence: number
  readonly issuedAt: string
  readonly expiresAt: string
  readonly releases: readonly ModuleReleaseV1[]
}

export interface ModuleReleaseCatalogV2 {
  readonly schemaVersion: typeof MODULE_RELEASE_CATALOG_SCHEMA_VERSION_V2
  readonly sequence: number
  readonly issuedAt: string
  readonly expiresAt: string
  readonly releases: readonly ModuleReleaseV2[]
}

export type ModuleReleaseCatalog = ModuleReleaseCatalogV1 | ModuleReleaseCatalogV2

export interface ModuleReleaseEnvelopeV1 {
  readonly schemaVersion: typeof MODULE_RELEASE_ENVELOPE_SCHEMA_VERSION
  readonly keyId: string
  readonly catalogBytes: Uint8Array
  readonly signature: Uint8Array
}

export interface TrustedReleaseKey {
  readonly keyId: string
  readonly publicKey: Uint8Array
  readonly activeFrom: string
  readonly activeUntil?: string
  readonly revokedAt?: string
}

export interface ModuleReleaseTrustState {
  readonly highestSequence: number
  readonly latestIssuedAt?: string
}

export type ModuleReleaseTrustDiagnosticCode =
  | 'INVALID_ENVELOPE'
  | 'UNSUPPORTED_ENVELOPE_SCHEMA'
  | 'INVALID_KEY_ID'
  | 'INVALID_BYTE_FIELD'
  | 'INVALID_SIGNATURE_LENGTH'
  | 'INVALID_TRUSTED_KEY'
  | 'DUPLICATE_TRUSTED_KEY'
  | 'INVALID_OPTIONS'
  | 'UNTRUSTED_KEY'
  | 'KEY_NOT_ACTIVE'
  | 'KEY_EXPIRED'
  | 'KEY_REVOKED'
  | 'SIGNATURE_INVALID'
  | 'INVALID_UTF8'
  | 'INVALID_JSON'
  | 'NON_CANONICAL_BYTES'
  | 'INVALID_CATALOG'
  | 'UNSUPPORTED_CATALOG_SCHEMA'
  | 'INVALID_SEQUENCE'
  | 'ROLLBACK_DETECTED'
  | 'INVALID_TIMESTAMP'
  | 'INVALID_TIME_WINDOW'
  | 'CATALOG_TTL_EXCEEDED'
  | 'CATALOG_NOT_YET_VALID'
  | 'CATALOG_EXPIRED'
  | 'BACKDATED_CATALOG'
  | 'LIMIT_EXCEEDED'
  | 'INVALID_RELEASE'
  | 'INVALID_MANIFEST'
  | 'INVALID_ARTIFACT_SIZE'
  | 'INVALID_HOST_VERSION_RANGE'
  | 'INVALID_EXTRACTED_MANIFEST_SHA256'
  | 'DUPLICATE_MODULE_VERSION'
  | 'DUPLICATE_PLATFORM'
  | 'MISSING_PLATFORM_SIZE'
  | 'UNKNOWN_PLATFORM_SIZE'
  | 'MISSING_PLATFORM_INSTALL_METADATA'
  | 'UNKNOWN_PLATFORM_INSTALL_METADATA'

export type ModuleReleaseTrustStage = 'envelope' | 'trust' | 'signature' | 'bytes' | 'catalog' | 'rollback'

export interface ModuleReleaseTrustDiagnostic {
  readonly code: ModuleReleaseTrustDiagnosticCode
  readonly stage: ModuleReleaseTrustStage
  readonly path: string
  readonly message: string
  readonly keyId?: string
}

export interface VerifyModuleReleaseCatalogOptions {
  readonly trustedKeys: readonly TrustedReleaseKey[]
  readonly state: ModuleReleaseTrustState
  readonly now?: number
  readonly clockSkewMs?: number
}

export type VerifyModuleReleaseCatalogResult =
  | {
      readonly ok: true
      readonly catalog: ModuleReleaseCatalog
      readonly state: ModuleReleaseTrustState
      readonly keyId: string
    }
  | {
      readonly ok: false
      readonly diagnostics: readonly ModuleReleaseTrustDiagnostic[]
    }
