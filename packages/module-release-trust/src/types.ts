import type { ModuleManifest, ModulePlatform } from '@simulator/module-contract'

export const MODULE_RELEASE_CATALOG_SCHEMA_VERSION = 1 as const
export const MODULE_RELEASE_ENVELOPE_SCHEMA_VERSION = 1 as const

export interface ModuleArtifactSize {
  readonly platform: ModulePlatform
  readonly size: number
}

export interface ModuleRelease {
  readonly manifest: ModuleManifest
  readonly artifactSizes: readonly ModuleArtifactSize[]
}

export interface ModuleReleaseCatalogV1 {
  readonly schemaVersion: typeof MODULE_RELEASE_CATALOG_SCHEMA_VERSION
  readonly sequence: number
  readonly issuedAt: string
  readonly expiresAt: string
  readonly releases: readonly ModuleRelease[]
}

export type ModuleReleaseCatalog = ModuleReleaseCatalogV1

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
}

export type ModuleReleaseTrustDiagnosticCode =
  | 'INVALID_ENVELOPE'
  | 'UNSUPPORTED_ENVELOPE_SCHEMA'
  | 'INVALID_KEY_ID'
  | 'INVALID_BYTE_FIELD'
  | 'INVALID_SIGNATURE_LENGTH'
  | 'INVALID_TRUSTED_KEY'
  | 'DUPLICATE_TRUSTED_KEY'
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
  | 'CATALOG_NOT_YET_VALID'
  | 'CATALOG_EXPIRED'
  | 'LIMIT_EXCEEDED'
  | 'INVALID_RELEASE'
  | 'INVALID_MANIFEST'
  | 'INVALID_ARTIFACT_SIZE'
  | 'DUPLICATE_MODULE_VERSION'
  | 'DUPLICATE_PLATFORM'
  | 'MISSING_PLATFORM_SIZE'
  | 'UNKNOWN_PLATFORM_SIZE'

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
