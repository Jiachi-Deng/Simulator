export const MODULE_MANIFEST_SCHEMA_VERSION = 1 as const

export const MODULE_PLATFORMS = [
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'win32-arm64',
  'win32-x64',
] as const

export type ModulePlatform = (typeof MODULE_PLATFORMS)[number]
export const MAX_MODULE_ARTIFACTS = MODULE_PLATFORMS.length
/** Auxiliary executables are intentionally bounded to keep manifest review tractable. */
export const MAX_MODULE_AUXILIARY_EXECUTABLES = 8

export const MODULE_CAPABILITIES = [
  'artifact.read',
  'artifact.write',
  'workspace.read',
  'workspace.write',
] as const

export type ModuleCapability = (typeof MODULE_CAPABILITIES)[number]
export const MAX_MODULE_CAPABILITIES = MODULE_CAPABILITIES.length

declare const moduleIdBrand: unique symbol
declare const moduleVersionBrand: unique symbol
declare const moduleEntrypointBrand: unique symbol
declare const moduleAuxiliaryExecutableBrand: unique symbol
declare const moduleArtifactUrlBrand: unique symbol
declare const moduleSha256Brand: unique symbol

export type ModuleId = string & { readonly [moduleIdBrand]: true }
export type ModuleVersion = string & { readonly [moduleVersionBrand]: true }
export type ModuleEntrypoint = string & { readonly [moduleEntrypointBrand]: true }
export type ModuleAuxiliaryExecutable = string & { readonly [moduleAuxiliaryExecutableBrand]: true }
export type ModuleArtifactUrl = string & { readonly [moduleArtifactUrlBrand]: true }
export type ModuleSha256 = string & { readonly [moduleSha256Brand]: true }

export interface ModuleArtifact {
  readonly platform: ModulePlatform
  readonly entrypoint: ModuleEntrypoint
  /** Optional for v1 manifest compatibility; when present, each path is an owner-executable regular file. */
  readonly auxiliaryExecutables?: readonly ModuleAuxiliaryExecutable[]
  readonly url: ModuleArtifactUrl
  readonly sha256: ModuleSha256
}

export interface ModuleManifestV1 {
  readonly schemaVersion: typeof MODULE_MANIFEST_SCHEMA_VERSION
  readonly id: ModuleId
  readonly version: ModuleVersion
  readonly artifacts: readonly ModuleArtifact[]
  readonly capabilities: readonly ModuleCapability[]
}

export type ModuleManifest = ModuleManifestV1

export type ManifestValidationErrorCode =
  | 'INPUT_NOT_OBJECT'
  | 'UNREADABLE_INPUT'
  | 'MISSING_FIELD'
  | 'UNKNOWN_FIELD'
  | 'INVALID_TYPE'
  | 'LIMIT_EXCEEDED'
  | 'UNSUPPORTED_SCHEMA_VERSION'
  | 'INVALID_ID'
  | 'INVALID_VERSION'
  | 'INVALID_PLATFORM'
  | 'INVALID_ENTRYPOINT'
  | 'INVALID_AUXILIARY_EXECUTABLE'
  | 'INVALID_URL'
  | 'INVALID_HASH'
  | 'INVALID_CAPABILITY'
  | 'DUPLICATE_DECLARATION'

export interface ManifestValidationError {
  readonly code: ManifestValidationErrorCode
  readonly path: string
  readonly message: string
}

export type ModuleManifestParseResult =
  | { readonly ok: true; readonly value: ModuleManifest }
  | { readonly ok: false; readonly errors: readonly ManifestValidationError[] }
