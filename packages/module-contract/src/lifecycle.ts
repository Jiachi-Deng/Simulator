import type { ModuleManifest } from './manifest-types.ts'

export type ModuleLifecycleState = 'uninstalled' | 'installed' | 'running' | 'stopped'
export type ModuleLifecycleOperation = 'install' | 'start' | 'health' | 'stop'
export type ModuleHealthStatus = 'healthy' | 'not-running'

export interface ModuleHealth {
  readonly status: ModuleHealthStatus
  readonly state: ModuleLifecycleState
}

export interface ModuleLifecycleError {
  readonly code: 'INVALID_STATE'
  readonly operation: ModuleLifecycleOperation
  readonly state: ModuleLifecycleState
  readonly message: string
}

export type ModuleLifecycleResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ModuleLifecycleError }

export interface ModuleRuntime {
  readonly manifest: ModuleManifest
  readonly state: ModuleLifecycleState
  install(): Promise<ModuleLifecycleResult<ModuleLifecycleState>>
  start(): Promise<ModuleLifecycleResult<ModuleLifecycleState>>
  health(): Promise<ModuleLifecycleResult<ModuleHealth>>
  stop(): Promise<ModuleLifecycleResult<ModuleLifecycleState>>
}
