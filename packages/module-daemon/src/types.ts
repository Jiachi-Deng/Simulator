import type {
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

export interface StartModuleDaemonRequest {
  readonly manifest: ModuleManifest
  readonly activatedRoot: string
  readonly platform: ModulePlatform
}

export type ModuleDaemonDiagnosticCode =
  | 'ENTRYPOINT_INVALID'
  | 'ENTRYPOINT_OUTSIDE_ACTIVATED_ROOT'
  | 'ENTRYPOINT_NOT_EXECUTABLE'
  | 'ARTIFACT_NOT_FOUND'
  | 'ENDPOINT_ALLOCATION_FAILED'
  | 'ENDPOINT_NOT_LOOPBACK'
  | 'SPAWN_FAILED'
  | 'STARTUP_TIMEOUT'
  | 'READINESS_MALFORMED'
  | 'PROCESS_EXITED'
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
  readonly startupTimeoutMs?: number
  readonly healthTimeoutMs?: number
  readonly healthIntervalMs?: number
  readonly unhealthyThreshold?: number
  readonly restartLimit?: number
  readonly restartBackoffMs?: readonly number[]
  readonly idleTimeoutMs?: number
  readonly stopGraceMs?: number
  readonly baseEnvironment?: Readonly<Record<string, string>>
}

export class ModuleDaemonError extends Error {
  readonly code: ModuleDaemonDiagnosticCode

  constructor(code: ModuleDaemonDiagnosticCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ModuleDaemonError'
    this.code = code
  }
}
