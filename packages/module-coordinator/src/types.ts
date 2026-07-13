import type { ModuleDaemonSnapshot } from '@simulator/module-daemon'
import type { ModuleId, ModuleManifest, ModulePlatform, ModuleSha256, ModuleVersion } from '@simulator/module-contract'
import type { VerifiedArtifactDescriptor } from '@simulator/module-installer'

export const MODULE_COORDINATOR_STATE_SCHEMA_VERSION = 1 as const

export type ModuleCoordinatorOperationKind = 'install' | 'update' | 'rollback' | 'start' | 'restart' | 'stop' | 'uninstall'

export type ModuleCoordinatorCheckpoint =
  | 'intent-recorded'
  | 'catalog-verified'
  | 'artifact-downloaded'
  | 'installed'
  | 'registered'
  | 'activated'
  | 'daemon-stopped'
  | 'rolled-back'
  | 'daemon-started'
  | 'uninstalled'
  | 'completed'

export interface ModuleCoordinatorInstallRequest {
  readonly catalogUrl: string
  readonly descriptor: VerifiedArtifactDescriptor
  readonly hostVersionRange: string
}

export interface ModuleCoordinatorRollbackRequest {
  readonly moduleId: ModuleId
  readonly restartAfterRollback: boolean
}

export interface ModuleCoordinatorUninstallRequest {
  readonly moduleId: ModuleId
  readonly version: ModuleVersion
}

export interface ModuleCoordinatorOperation {
  readonly id: string
  readonly moduleId: ModuleId
  readonly kind: ModuleCoordinatorOperationKind
  readonly checkpoint: ModuleCoordinatorCheckpoint
  readonly status: 'pending' | 'completed' | 'failed'
  readonly createdAt: number
  readonly updatedAt: number
  readonly request?: ModuleCoordinatorInstallRequest | ModuleCoordinatorRollbackRequest | ModuleCoordinatorUninstallRequest
  readonly error?: string
}

export interface ModuleCoordinatorEvent {
  readonly moduleId: ModuleId
  readonly at: number
  readonly snapshot: ModuleDaemonSnapshot
}

export interface ModuleCoordinatorState {
  readonly schemaVersion: typeof MODULE_COORDINATOR_STATE_SCHEMA_VERSION
  readonly operations: readonly ModuleCoordinatorOperation[]
  readonly events: readonly ModuleCoordinatorEvent[]
}

export interface ModuleCoordinatorStore {
  load(): Promise<ModuleCoordinatorState | undefined>
  save(state: ModuleCoordinatorState): Promise<void>
}

/** Maps a verified downloader artifact into a host-owned immutable local archive path. */
export interface ModuleArchiveLocator {
  locate(sha256: ModuleSha256): Promise<string>
}

/** Resolves the activated version root without coupling the coordinator to a filesystem layout. */
export interface ModuleActivationLocator {
  locate(moduleId: ModuleId, version: ModuleVersion): Promise<string>
}

/** Electron and other hosts adapt their module-view API through this lifecycle-only port. */
export interface ModuleViewPort {
  onDaemonSnapshot?(snapshot: ModuleDaemonSnapshot): void | Promise<void>
}

export type ModuleCoordinatorErrorCode =
  | 'ACTIVE_VERSION_MISSING'
  | 'ARTIFACT_MISSING'
  | 'CATALOG_RELEASE_MISSING'
  | 'CATALOG_RELEASE_MISMATCH'
  | 'INVALID_OPERATION'
  | 'REGISTRY_MUTATION_FAILED'
  | 'STORE_CORRUPT'

export class ModuleCoordinatorError extends Error {
  readonly code: ModuleCoordinatorErrorCode

  constructor(code: ModuleCoordinatorErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ModuleCoordinatorError'
    this.code = code
  }
}

/** Test-only sentinel for simulating a process death after a durable checkpoint. */
export class SimulatedCoordinatorCrash extends Error {
  constructor(message = 'Simulated coordinator crash') {
    super(message)
    this.name = 'SimulatedCoordinatorCrash'
  }
}

export interface ModuleCoordinatorSnapshot {
  readonly operations: readonly ModuleCoordinatorOperation[]
  readonly events: readonly ModuleCoordinatorEvent[]
  readonly manifests: readonly ModuleManifest[]
  readonly platform: ModulePlatform
}
