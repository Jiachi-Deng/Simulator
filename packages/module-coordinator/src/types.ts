import type { ModuleDaemonSnapshot, StartModuleDaemonRequest } from '@simulator/module-daemon'
import type { ModuleId, ModuleManifest, ModulePlatform, ModuleSha256, ModuleVersion } from '@simulator/module-contract'
import type { ModuleInstaller, VerifiedArtifactDescriptor } from '@simulator/module-installer'
import type { ModuleDownloader } from '@simulator/module-downloader'
import type { ModuleRegistry } from '@simulator/module-registry'

export const MODULE_COORDINATOR_STATE_SCHEMA_VERSION = 2 as const

export type ModuleCoordinatorOperationKind = 'install' | 'update' | 'rollback' | 'start' | 'restart' | 'stop' | 'uninstall'
export type ModuleCoordinatorOperationPhase = 'forward' | 'compensating'

export type ModuleCoordinatorCheckpoint =
  | 'intent-recorded'
  | 'runtime-detached'
  | 'daemon-stopped'
  | 'catalog-verified'
  | 'artifact-downloaded'
  | 'installed'
  | 'registered'
  | 'activation-restored'
  | 'registry-restored'
  | 'daemon-started'
  | 'view-attached'
  | 'version-uninstalled'
  | 'registry-removed'
  | 'compensation-started'
  | 'compensation-runtime-detached'
  | 'compensation-daemon-stopped'
  | 'compensation-activation-restored'
  | 'compensation-registry-restored'
  | 'compensation-daemon-started'
  | 'compensation-view-attached'
  | 'completed'
  | 'compensated'

export interface ModuleOperationIdentity {
  readonly operationId?: string
}

/** Signed Catalog facts bound to an install request by resolveInstallRequest. */
export interface ModuleCoordinatorCatalogEvidence {
  readonly schemaVersion: 1
  readonly sequence: number
  readonly issuedAt: string
  readonly expiresAt: string
  readonly artifactSize: number
}

export interface ModuleCoordinatorInstallRequest extends ModuleOperationIdentity {
  readonly catalogUrl: string
  readonly descriptor: VerifiedArtifactDescriptor
  readonly hostVersionRange: string
  /** Optional only for compatibility with durable operations created before Catalog evidence existed. */
  readonly catalogEvidence?: ModuleCoordinatorCatalogEvidence
}

/** A new install request resolved from the coordinator's own verified v2 Catalog. */
export interface ResolvedModuleCoordinatorInstallRequest extends ModuleCoordinatorInstallRequest {
  readonly catalogEvidence: ModuleCoordinatorCatalogEvidence
}

/** Exact release selection resolved from the coordinator's own verified downloader. */
export interface ModuleCoordinatorReleaseRequest {
  readonly catalogUrl: string
  readonly moduleId: ModuleId
  readonly version: ModuleVersion
}

export interface ModuleCoordinatorModuleRequest extends ModuleOperationIdentity {
  readonly moduleId: ModuleId
}

export interface ModuleCoordinatorRollbackRequest extends ModuleCoordinatorModuleRequest {
  readonly restartAfterRollback?: boolean
}

export interface ModuleCoordinatorUninstallRequest extends ModuleCoordinatorModuleRequest {
  readonly version: ModuleVersion
}

export type ModuleCoordinatorRequest =
  | ModuleCoordinatorInstallRequest
  | ModuleCoordinatorModuleRequest
  | ModuleCoordinatorRollbackRequest
  | ModuleCoordinatorUninstallRequest

export interface ModuleCoordinatorTargetState {
  readonly activeVersion: ModuleVersion | null
  readonly lastKnownGoodVersion: ModuleVersion | null
  readonly running: boolean
  readonly viewAttached: boolean
  readonly registryPresent: boolean
}

export interface ModuleCoordinatorOperationResult {
  readonly operationId: string
  readonly moduleId: ModuleId
  readonly kind: ModuleCoordinatorOperationKind
  readonly ok: boolean
  readonly source: ModuleCoordinatorTargetState
  readonly target: ModuleCoordinatorTargetState
  readonly completedAt: number
  readonly error?: string
}

export interface ModuleCoordinatorOperation {
  readonly id: string
  readonly moduleId: ModuleId
  readonly kind: ModuleCoordinatorOperationKind
  readonly fingerprint: string
  readonly phase: ModuleCoordinatorOperationPhase
  readonly checkpoint: ModuleCoordinatorCheckpoint
  readonly status: 'pending' | 'completed' | 'failed'
  readonly createdAt: number
  readonly updatedAt: number
  readonly request: ModuleCoordinatorRequest
  readonly source: ModuleCoordinatorTargetState
  readonly target: ModuleCoordinatorTargetState
  readonly result?: ModuleCoordinatorOperationResult
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

/** Resolves and queries immutable installed versions without exposing installer layout assumptions. */
export interface ModuleActivationLocator {
  locate(moduleId: ModuleId, version: ModuleVersion): Promise<string>
  isInstalled(moduleId: ModuleId, version: ModuleVersion): Promise<boolean>
}

export interface ModuleViewSnapshot {
  readonly moduleId: ModuleId
  readonly version: ModuleVersion
  readonly state: 'attaching' | 'attached' | 'detached' | 'crashed'
}

export interface ModuleViewAttachRequest {
  readonly moduleId: ModuleId
  readonly version: ModuleVersion
  readonly daemon: ModuleDaemonSnapshot
}

/** Runtime-neutral shape implemented by Electron ModuleViewManager adapters and production test hosts. */
export interface ModuleViewPort {
  attach(request: ModuleViewAttachRequest): Promise<ModuleViewSnapshot>
  detach(moduleId: ModuleId): Promise<void>
  query(moduleId: ModuleId): Promise<ModuleViewSnapshot | undefined>
}

export interface ModuleRuntimeLeaseManager {
  acquireReference(moduleId: ModuleId, version: ModuleVersion): Promise<() => void>
}

export type ModuleCoordinatorFaultPoint = `before-checkpoint:${ModuleCoordinatorCheckpoint}`

export interface ModuleCoordinatorDependencies {
  readonly downloader: Pick<ModuleDownloader, 'fetchCatalog' | 'downloadArtifact'>
  readonly installer: Pick<ModuleInstaller, 'install' | 'getState' | 'restoreState' | 'uninstall' | 'recoverAll'>
  readonly registry: ModuleRegistry
  readonly daemon: {
    start(request: StartModuleDaemonRequest): Promise<ModuleDaemonSnapshot>
    stop(moduleId: ModuleId): Promise<ModuleDaemonSnapshot | undefined>
    get(moduleId: ModuleId): ModuleDaemonSnapshot | undefined
    subscribe(listener: (snapshot: ModuleDaemonSnapshot) => void): () => void
  }
  readonly platform: ModulePlatform
  readonly archiveLocator: ModuleArchiveLocator
  readonly activationLocator: ModuleActivationLocator
  readonly store: ModuleCoordinatorStore
  readonly view: ModuleViewPort
  readonly usage: ModuleRuntimeLeaseManager
  readonly now?: () => number
  readonly faultInjector?: (point: ModuleCoordinatorFaultPoint) => void | Promise<void>
}

export type ModuleCoordinatorErrorCode =
  | 'ACTIVE_VERSION_MISSING'
  | 'ARTIFACT_MISSING'
  | 'CATALOG_INSTALL_METADATA_MISSING'
  | 'CATALOG_RELEASE_MISSING'
  | 'CATALOG_RELEASE_MISMATCH'
  | 'INVALID_OPERATION'
  | 'OPERATION_ID_CONFLICT'
  | 'REGISTRY_MUTATION_FAILED'
  | 'STATE_DIVERGED'
  | 'STORE_CORRUPT'
  | 'VIEW_STATE_INVALID'

export class ModuleCoordinatorError extends Error {
  readonly code: ModuleCoordinatorErrorCode

  constructor(code: ModuleCoordinatorErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ModuleCoordinatorError'
    this.code = code
  }
}

/** Test-only sentinel for simulating a process death after a side effect or durable checkpoint. */
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
