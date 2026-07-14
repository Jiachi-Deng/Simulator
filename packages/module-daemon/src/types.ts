import type {
  ModuleArtifact,
  ModuleId,
  ModuleManifest,
  ModulePlatform,
  ModuleVersion,
} from '@simulator/module-contract'

export type ModuleDaemonState =
  | 'starting'
  | 'healthy'
  | 'degraded'
  | 'stopping'
  | 'stopped'
  | 'crashed'

export interface LoopbackEndpoint {
  readonly host: '127.0.0.1' | '::1'
  readonly port: number
}

export interface ProcessExit {
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
}

export interface ModuleProcess {
  readonly pid: number
  readonly exited: Promise<ProcessExit>
  stopTree(graceMs: number): Promise<void>
}

export interface ModuleSpawnRequest {
  readonly executable: string
  readonly args: readonly []
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly shell: false
}

export interface ProcessAdapter {
  spawn(request: ModuleSpawnRequest): Promise<ModuleProcess>
}

export interface WindowsJobProcessFactory {
  spawn(request: ModuleSpawnRequest): Promise<ModuleProcess>
}

export interface RealProcessAdapterOptions {
  readonly platform?: NodeJS.Platform
  readonly windowsJobFactory?: WindowsJobProcessFactory
}

export interface ClockAdapter {
  now(): number
  sleep(milliseconds: number, signal?: AbortSignal): Promise<void>
}

export type HealthProbeResult =
  | { readonly status: 'healthy' }
  | { readonly status: 'unhealthy'; readonly detail: string }
  | { readonly status: 'malformed'; readonly detail: string }

export interface HealthAdapter {
  allocateEndpoint(signal?: AbortSignal): Promise<LoopbackEndpoint>
  check(
    endpoint: LoopbackEndpoint,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<HealthProbeResult>
  releaseEndpoint?(endpoint: LoopbackEndpoint): Promise<void>
}

export interface ActivationAdapter {
  resolveEntrypoint(
    activatedRoot: string,
    artifact: ModuleArtifact,
  ): Promise<{ readonly activatedRoot: string; readonly executable: string }>
}

export interface StartModuleDaemonRequest {
  readonly manifest: ModuleManifest
  readonly activatedRoot: string
  readonly platform: ModulePlatform
}

/** Immutable host-owned context for one daemon launch attempt. */
export interface ModuleDaemonLaunchContext {
  readonly id: ModuleId
  readonly version: ModuleVersion
  readonly activatedRoot: string
  readonly executable: string
  readonly endpoint: LoopbackEndpoint
  readonly restartCount: number
  readonly signal: AbortSignal
}

export type ModuleDaemonLaunchCleanupReason =
  | 'spawn-failed'
  | 'process-exit'
  | 'stop'
  | 'restart'
  | 'drain'

/**
 * Per-launch resources prepared by the host before spawning a module daemon.
 *
 * `environment` is merged only into this spawn request; it is never retained
 * in the manager's shared base environment. `cleanup` must revoke every
 * resource represented by the environment (for example, an opaque grant).
 */
export interface ModuleDaemonLaunchLease {
  readonly environment?: Readonly<Record<string, string>>
  cleanup(reason: ModuleDaemonLaunchCleanupReason): Promise<void>
}

export type PrepareModuleDaemonLaunch = (
  context: ModuleDaemonLaunchContext,
) => Promise<ModuleDaemonLaunchLease>

export type ModuleDaemonDiagnosticCode =
  | 'ENTRYPOINT_INVALID'
  | 'ENTRYPOINT_OUTSIDE_ACTIVATED_ROOT'
  | 'ENTRYPOINT_NOT_EXECUTABLE'
  | 'ARTIFACT_NOT_FOUND'
  | 'ENDPOINT_ALLOCATION_FAILED'
  | 'ENDPOINT_NOT_LOOPBACK'
  | 'LAUNCH_PREPARATION_FAILED'
  | 'LAUNCH_ENVIRONMENT_INVALID'
  | 'LAUNCH_CLEANUP_FAILED'
  | 'SPAWN_FAILED'
  | 'STARTUP_TIMEOUT'
  | 'READINESS_MALFORMED'
  | 'PROCESS_EXITED'
  | 'PROCESS_CLEANUP_FAILED'
  | 'HEALTH_DEGRADED'
  | 'HEALTH_TIMEOUT'
  | 'RESTART_BUDGET_EXHAUSTED'
  | 'IDLE_TIMEOUT'
  | 'STOP_REQUESTED'
  | 'MANAGER_DRAINING'

export interface ModuleDaemonDiagnostic {
  readonly code: ModuleDaemonDiagnosticCode
  readonly message: string
  readonly at: number
  readonly restartCount: number
}

export interface ModuleDaemonSnapshot {
  readonly id: ModuleId
  readonly version: ModuleVersion
  readonly state: ModuleDaemonState
  readonly endpoint?: LoopbackEndpoint
  readonly pid?: number
  readonly restartCount: number
  readonly diagnostic?: ModuleDaemonDiagnostic
}

export interface ModuleDaemonManagerOptions {
  readonly process: ProcessAdapter
  readonly clock: ClockAdapter
  readonly health: HealthAdapter
  readonly activation?: ActivationAdapter
  readonly startupTimeoutMs?: number
  readonly healthTimeoutMs?: number
  readonly healthIntervalMs?: number
  readonly unhealthyThreshold?: number
  readonly restartLimit?: number
  readonly restartBackoffMs?: readonly number[]
  readonly idleTimeoutMs?: number
  readonly stopGraceMs?: number
  readonly baseEnvironment?: Readonly<Record<string, string>>
  /**
   * Atomically prepares environment and revocable resources for each spawn.
   * A restart invokes this hook again. The manager owns and cleans a returned
   * lease once after success and retries cleanup only when it rejects.
   */
  readonly prepareLaunch?: PrepareModuleDaemonLaunch
  /** Host-owned parent used to derive one persistent data root per module ID. */
  readonly moduleDataRoot?: string
  readonly onListenerError?: (error: unknown, snapshot: ModuleDaemonSnapshot) => void
}

export class ModuleDaemonError extends Error {
  readonly code: ModuleDaemonDiagnosticCode

  constructor(code: ModuleDaemonDiagnosticCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ModuleDaemonError'
    this.code = code
  }
}
