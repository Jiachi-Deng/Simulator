import type { ModuleManifest, ModulePlatform } from '@simulator/module-contract'

export const MODULE_REGISTRY_STATE_SCHEMA_VERSION = 1 as const

export interface ModuleRegistryHost {
  readonly version: string
  readonly platform: ModulePlatform
}

export interface ModuleInstallCompatibility {
  readonly hostVersionRange: string
}

export type ModuleCompatibility = 'compatible' | 'incompatible'

export type RegistryDiagnosticCode =
  | 'ACTIVE_CLEARED_INCOMPATIBLE'
  | 'ACTIVE_REMOVAL_GUARD'
  | 'CORRUPT_PERSISTED_STATE'
  | 'DUPLICATE_VERSION'
  | 'INCOMPATIBLE_HOST_VERSION'
  | 'INCOMPATIBLE_PLATFORM'
  | 'INVALID_HOST_VERSION_RANGE'
  | 'LAST_KNOWN_GOOD_CLEARED_INCOMPATIBLE'
  | 'LAST_KNOWN_GOOD_REMOVAL_GUARD'
  | 'MANIFEST_CONFLICT'
  | 'MODULE_DISABLED'
  | 'MODULE_NOT_FOUND'
  | 'PERSISTENCE_WRITE_FAILED'
  | 'RECOVERY_INTERRUPTED_COMMIT'
  | 'UNSUPPORTED_MANIFEST_SCHEMA'
  | 'UNVALIDATED_MANIFEST'
  | 'VERSION_INCOMPATIBLE'
  | 'VERSION_NOT_FOUND'

export interface RegistryDiagnostic {
  readonly code: RegistryDiagnosticCode
  readonly message: string
  readonly moduleId?: string
  readonly version?: string
}

export interface InstalledModuleVersionSnapshot {
  readonly version: string
  readonly manifest: ModuleManifest
  readonly hostVersionRange: string
  readonly compatibility: ModuleCompatibility
  readonly incompatibilityReasons: readonly RegistryDiagnostic[]
}

export interface InstalledModuleSnapshot {
  readonly id: string
  readonly disabled: boolean
  readonly activeVersion: string | null
  readonly lastKnownGoodVersion: string | null
  readonly versions: readonly InstalledModuleVersionSnapshot[]
}

export interface ModuleRegistrySnapshot {
  readonly host: ModuleRegistryHost
  readonly modules: readonly InstalledModuleSnapshot[]
  readonly diagnostics: readonly RegistryDiagnostic[]
}

export type RegistryMutationResult =
  | { readonly ok: true; readonly snapshot: ModuleRegistrySnapshot; readonly diagnostics: readonly [] }
  | { readonly ok: false; readonly snapshot: ModuleRegistrySnapshot; readonly diagnostics: readonly RegistryDiagnostic[] }

export interface SafeRemovalTransition {
  readonly activeVersion?: string | null
  readonly lastKnownGoodVersion?: string | null
}

export interface PersistedModuleVersionV1 {
  readonly manifest: unknown
  readonly hostVersionRange: string
}

export interface PersistedModuleV1 {
  readonly id: string
  readonly disabled: boolean
  readonly activeVersion: string | null
  readonly lastKnownGoodVersion: string | null
  readonly versions: readonly PersistedModuleVersionV1[]
}

export interface PersistedModuleRegistryStateV1 {
  readonly schemaVersion: typeof MODULE_REGISTRY_STATE_SCHEMA_VERSION
  readonly host: ModuleRegistryHost
  readonly modules: readonly PersistedModuleV1[]
}

export interface RegistryPersistenceRead {
  readonly committed: unknown | null
  readonly interruptedCommit: boolean
}

export interface ModuleRegistryPersistence {
  read(): RegistryPersistenceRead
  commit(state: PersistedModuleRegistryStateV1): void
}
