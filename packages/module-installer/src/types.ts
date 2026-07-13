import type {
  ModuleArtifact,
  ModuleId,
  ModuleManifest,
  ModulePlatform,
  ModuleSha256,
  ModuleVersion,
} from '@simulator/module-contract'

export const DEFAULT_INSTALL_LIMITS = Object.freeze({
  maxArchiveBytes: 128 * 1024 * 1024,
  maxEntries: 4_096,
  maxFileBytes: 64 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
  maxPathBytes: 512,
  maxDepth: 32,
  maxMetadataBytes: 256 * 1024,
  maxDecompressionRatio: 200,
})

export const DEFAULT_STALE_STAGING_AGE_MS = 24 * 60 * 60 * 1_000

export interface InstallLimits {
  readonly maxArchiveBytes: number
  readonly maxEntries: number
  readonly maxFileBytes: number
  readonly maxTotalBytes: number
  readonly maxPathBytes: number
  readonly maxDepth: number
  readonly maxMetadataBytes: number
  readonly maxDecompressionRatio: number
}

/** The caller establishes descriptor trust; the installer revalidates its shape and both hashes. */
export interface VerifiedArtifactDescriptor {
  readonly verified: true
  readonly manifest: ModuleManifest
  readonly artifact: ModuleArtifact
  readonly extractedManifestSha256: ModuleSha256
  readonly format: 'tar.gz'
}

export type InstallPhase =
  | 'preparing'
  | 'verifying-archive'
  | 'inspecting-archive'
  | 'extracting'
  | 'verifying-files'
  | 'activating'
  | 'complete'

export interface InstallProgress {
  readonly phase: InstallPhase
  readonly completed: number
  readonly total: 100
  readonly entries?: number
  readonly bytes?: number
}

export interface InstalledModuleState {
  readonly moduleId: ModuleId
  readonly activeVersion: ModuleVersion | null
  readonly lastKnownGoodVersion: ModuleVersion | null
}

export interface InstallResult extends InstalledModuleState {
  readonly installedPath: string
  readonly archiveSha256: ModuleSha256
  readonly extractedManifestSha256: ModuleSha256
}

export interface RollbackResult extends InstalledModuleState {
  readonly activePath: string
}

export interface RestoreModuleStateRequest extends InstalledModuleState {}

export interface RestoreModuleStateResult extends InstalledModuleState {
  readonly activePath: string | null
}

export interface InstallRequest {
  readonly descriptor: VerifiedArtifactDescriptor
  readonly archivePath: string
  readonly signal?: AbortSignal
  readonly onProgress?: (progress: InstallProgress) => void
}

export interface UninstallRequest {
  readonly moduleId: ModuleId
  readonly version: ModuleVersion
}

/** Held by the host while reference acquisition is serialized against a module mutation. */
export interface ModuleUsageGuardLease {
  isVersionInUse(version: ModuleVersion): boolean | Promise<boolean>
}

/**
 * The host must prevent new runtime references for the full duration of operation.
 * The installer deliberately has no permissive fallback when this authority is absent.
 */
export interface ModuleUsageGuard {
  runExclusive<T>(
    moduleId: ModuleId,
    operation: (lease: ModuleUsageGuardLease) => Promise<T>,
  ): Promise<T>
}

export type InstallerFaultPoint =
  | 'after-archive-copy'
  | 'after-archive-inspection'
  | 'after-extraction'
  | 'before-content-fsync'
  | 'before-journal-temp-write'
  | 'during-journal-temp-write'
  | 'after-journal-temp-fsync'
  | 'after-journal-claim'
  | 'after-journal-rename'
  | 'after-journal-prepared'
  | 'before-publish-rename'
  | 'after-publish-rename'
  | 'after-publish-source-fsync'
  | 'after-publish-destination-fsync'
  | 'after-version-published'
  | 'before-state-rename'
  | 'after-state-rename'
  | 'after-state-activated'
  | 'before-trash-rename'
  | 'after-trash-rename'
  | 'after-trash-source-fsync'
  | 'after-trash-destination-fsync'
  | 'after-trash-published'
  | 'before-trash-delete'
  | 'after-trash-delete'
  | 'after-recovery-claimed'
  | 'before-cleanup'

export type InstallerFaultInjector = (point: InstallerFaultPoint) => void | Promise<void>

export interface ModuleInstallerOptions {
  readonly limits?: Partial<InstallLimits>
  readonly faultInjector?: InstallerFaultInjector
  readonly usageGuard?: ModuleUsageGuard
}

export type ModuleInstallerErrorCode =
  | 'ABORTED'
  | 'ARCHIVE_HASH_MISMATCH'
  | 'ARCHIVE_INVALID'
  | 'ARCHIVE_LIMIT_EXCEEDED'
  | 'BUSY'
  | 'DESCRIPTOR_INVALID'
  | 'ENTRYPOINT_INVALID'
  | 'FILESYSTEM_ERROR'
  | 'FORMAT_UNSUPPORTED'
  | 'INSTALL_CONFLICT'
  | 'JOURNAL_INVALID'
  | 'NO_LAST_KNOWN_GOOD'
  | 'NOT_INSTALLED'
  | 'PROTECTED_VERSION'
  | 'TREE_HASH_MISMATCH'
  | 'USAGE_GUARD_REQUIRED'

export class ModuleInstallerError extends Error {
  readonly code: ModuleInstallerErrorCode
  readonly cause?: unknown

  constructor(code: ModuleInstallerErrorCode, message: string, cause?: unknown) {
    super(message)
    this.name = 'ModuleInstallerError'
    this.code = code
    this.cause = cause
  }
}

/** Fault-injection sentinel that intentionally leaves journaled state for recovery tests. */
export class SimulatedInstallerCrash extends Error {
  constructor(message = 'Simulated installer crash') {
    super(message)
    this.name = 'SimulatedInstallerCrash'
  }
}

export interface ResolvedDescriptor {
  readonly moduleId: ModuleId
  readonly version: ModuleVersion
  readonly platform: ModulePlatform
  readonly artifact: ModuleArtifact
  readonly archiveSha256: ModuleSha256
  readonly extractedManifestSha256: ModuleSha256
}
