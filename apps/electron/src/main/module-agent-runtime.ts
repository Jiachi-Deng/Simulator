import { accessSync, chmodSync, constants as fsConstants, lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import {
  ModuleAgentGateway,
  type ModuleAgentGatewaySnapshot,
} from '@simulator/module-agent-gateway'
import {
  ModuleAgentGatewayServer,
  NodeModuleAgentPathAuthority,
  NodeModuleAgentTokenSource,
  type ModuleAgentLaunchLease,
} from '@simulator/module-agent-gateway/node'
import type { ModuleDaemonLaunchContext, ModuleDaemonLaunchLease } from '@simulator/module-daemon'
import {
  CraftModuleAgentSessionPort,
  CraftHostAgentRunSessionPort,
} from '@craft-agent/server-core/sessions'
import type { ISessionManager } from '@craft-agent/server-core/handlers'
import { ModuleAgentRunCore } from '@simulator/host-agent-run-core'
import {
  HostAgentWorkerSupervisor,
  type HostAgentUnexpectedExitEvent,
  type HostAgentWorkerFailure,
  type HostAgentWorkerSupervisorOptions,
} from '../host-agent/supervisor'
import { MainProcessModuleTurnLease } from '../host-agent/module-turn-lease'
import { OwnerOnlyHostAgentTokenStore } from '../host-agent/token-store'
import { V2CorePortAdapter } from '../host-agent/v2-core-port-adapter'
import {
  createV1UtilityCompatibilityRuntime,
  type V1UtilityCompatibilityRuntime,
} from '../host-agent/v1-compatibility-runtime'
import type { HostAgentProtocolPath } from '../host-agent/protocol'
import { OPEN_DESIGN_MODULE_ID } from '../shared/open-design-module-ipc'

const LAUNCH_GRANT_TTL_MS = 24 * 60 * 60 * 1_000

export interface HostModuleAgentRuntimeOptions {
  readonly storageRoot: string
  readonly sessions: ISessionManager
  readonly resolveWorkspaceId: () => string | undefined
  readonly now?: () => number
  /** Internal deterministic test seam; production always uses the loopback HTTP server. */
  readonly createServer?: (gateway: ModuleAgentGateway) => {
    start(): Promise<string>
    prepareLaunch(
      spec: Parameters<ModuleAgentGateway['issueGrant']>[0],
      tokenDirectory: string,
    ): Promise<ModuleAgentLaunchLease>
    stop(): Promise<void>
  }
}

export type LegacyHostModuleAgentRuntimeSnapshot = Readonly<
  ModuleAgentGatewaySnapshot & Record<string, unknown>
>

export type IsolatedHostModuleAgentRuntimeSnapshot = Readonly<{
  kind: 'isolated'
  v1: ModuleAgentGatewaySnapshot
  v2: ReturnType<ModuleAgentRunCore['debugSnapshot']>
  workers: ReturnType<HostAgentWorkerSupervisor['snapshots']>
  turnLease: ReturnType<MainProcessModuleTurnLease['snapshot']>
}> & Readonly<Record<string, unknown>>

export type HostModuleAgentRuntimeSnapshot =
  | LegacyHostModuleAgentRuntimeSnapshot
  | IsolatedHostModuleAgentRuntimeSnapshot

/** Lifecycle base used by app composition; factories return precise snapshot subtypes. */
export interface HostModuleAgentRuntime<
  Snapshot extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>,
> {
  prepareLaunch(context: ModuleDaemonLaunchContext): Promise<ModuleDaemonLaunchLease>
  debugSnapshot(): Snapshot
  dispose(): Promise<void>
}

export interface LegacyHostModuleAgentRuntime
  extends HostModuleAgentRuntime<LegacyHostModuleAgentRuntimeSnapshot> {}

export interface IsolatedHostModuleAgentRuntime
  extends HostModuleAgentRuntime<IsolatedHostModuleAgentRuntimeSnapshot> {
  /** Exact v1 worker state plus synchronous main-process v2/Supervisor state. */
  refreshDebugSnapshot(): Promise<IsolatedHostModuleAgentRuntimeSnapshot>
}

function ensureOwnerOnlyDirectory(path: string): string {
  const normalized = resolve(path)
  if (normalized !== path) throw new TypeError('Module Agent directory must be a normalized absolute path')
  mkdirSync(normalized, { recursive: true, mode: 0o700 })
  const canonical = realpathSync(normalized)
  let stat = lstatSync(canonical)
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
    throw new TypeError('Module Agent directory must be a host-owned real directory')
  }
  if (process.platform !== 'win32') {
    chmodSync(canonical, 0o700)
    stat = lstatSync(canonical)
    if ((stat.mode & 0o077) !== 0) {
      throw new TypeError('Module Agent directory must be owner-only')
    }
  }
  return canonical
}

export async function createHostModuleAgentRuntime(
  options: HostModuleAgentRuntimeOptions,
): Promise<LegacyHostModuleAgentRuntime> {
  const storageRoot = ensureOwnerOnlyDirectory(options.storageRoot)
  const moduleDataRoot = ensureOwnerOnlyDirectory(join(storageRoot, 'module-data'))
  const tokenRoot = ensureOwnerOnlyDirectory(join(storageRoot, 'agent-grants'))
  const paths = new NodeModuleAgentPathAuthority()
  const port = new CraftModuleAgentSessionPort(options.sessions, paths)
  const gateway = new ModuleAgentGateway({
    port,
    pathAuthority: paths,
    tokenSource: new NodeModuleAgentTokenSource(),
    ...(options.now ? { clock: { now: options.now } } : {}),
  })
  const server = options.createServer?.(gateway) ?? new ModuleAgentGatewayServer(gateway)
  await server.start()

  let disposed = false
  return {
    async prepareLaunch(context) {
      if (disposed) throw new Error('Module Agent runtime is disposed')
      if (context.signal.aborted) throw new Error('Module launch was cancelled')
      const workspaceId = options.resolveWorkspaceId()
      const workspace = options.sessions.getWorkspaces().find((candidate) => candidate.id === workspaceId)
      if (!workspace) throw new Error('No active local Craft workspace is available for the Module runtime')

      const authorizedWorkingRoot = ensureOwnerOnlyDirectory(join(moduleDataRoot, context.id))
      const tokenDirectory = ensureOwnerOnlyDirectory(join(tokenRoot, context.id))
      const now = options.now?.() ?? Date.now()
      const lease = await server.prepareLaunch({
        ownerId: `workspace:${workspace.id}`,
        moduleId: context.id,
        launchId: randomUUID(),
        lifecycleId: randomUUID(),
        workspaceId: workspace.id,
        workspaceRoot: workspace.rootPath,
        authorizedWorkingRoot,
        defaultWorkingDirectory: authorizedWorkingRoot,
        expiresAt: now + LAUNCH_GRANT_TTL_MS,
      }, tokenDirectory)
      if (context.signal.aborted) {
        await lease.dispose()
        throw new Error('Module launch was cancelled')
      }
      return {
        environment: lease.environment,
        cleanup: async () => lease.dispose(),
      }
    },
    debugSnapshot: () => ({ ...gateway.debugSnapshot() }),
    async dispose() {
      if (disposed) return
      await server.stop()
      disposed = true
    },
  }
}

const OPEN_DESIGN_V1_VERSION = '0.14.5'
const OPEN_DESIGN_V2_VERSIONS = new Set(['0.14.6-rc.1', '0.14.6'])
const V2_GRANT_TTL_MS = 24 * 60 * 60 * 1_000
// Run timeout is 30 minutes. Start rotation five minutes earlier than that so
// an already-running Turn can finish without extending the 24-hour authority.
const V2_GRANT_ROTATION_LEAD_MS = 35 * 60 * 1_000
const V2_GRANT_ROTATION_RETRY_MS = 1_000
const DEFAULT_CRAFT_PREEMPT_TIMEOUT_MS = 10_000

export type ModuleAgentWorkerRecoveryFailure = HostAgentWorkerFailure | 'grant-expiring'

export function selectHostAgentProtocolForModule(
  context: Readonly<{ id: string; version: string }>,
): HostAgentProtocolPath {
  // The deterministic packaged smoke is deliberately a generic v1 consumer.
  // OpenDesign production versions are exact so an unknown release cannot
  // accidentally receive a wire contract it did not declare.
  if (context.id !== OPEN_DESIGN_MODULE_ID) return 'v1'
  if (context.version === OPEN_DESIGN_V1_VERSION) return 'v1'
  if (OPEN_DESIGN_V2_VERSIONS.has(context.version)) return 'v2'
  throw new Error(`OpenDesign ${context.version} does not declare a supported Host Agent contract`)
}

export interface IsolatedHostModuleAgentRuntimeOptions {
  readonly storageRoot: string
  readonly sessions: ISessionManager
  readonly resolveWorkspaceId: () => string | undefined
  readonly workerEntryPath: string
  readonly shimPath: string
  readonly now?: () => number
  readonly craftPreemptTimeoutMs?: number
  /** Internal deterministic timer seam; production begins safe rotation 35 minutes before fixed 24h expiry. */
  readonly scheduleGrantRotation?: (callback: () => void, delayMs: number) => () => void
  /**
   * Called only for an epoch owned by an active launch, after its local cleanup
   * either strictly reaped or fenced that protocol. `circuitOpen` distinguishes
   * restart from stop. The callback is deliberately not awaited so a
   * Coordinator operation can call prepareLaunch without deadlocking recovery.
   */
  readonly onWorkerRecoveryNeeded?: (input: {
    protocol: HostAgentProtocolPath
    epoch: string
    failure: ModuleAgentWorkerRecoveryFailure
    circuitOpen: boolean
  }) => void | Promise<void>
  readonly onIsolationFailure?: (input: {
    protocol: HostAgentProtocolPath
    phase: 'craft-preempt' | 'launch-cleanup' | 'worker-recovery' | 'shutdown'
    error?: unknown
  }) => void
  /** Internal deterministic test seam; production always uses Electron Utility Process. */
  readonly createSupervisor?: (
    onUnexpectedExit: NonNullable<HostAgentWorkerSupervisorOptions['onUnexpectedExit']>,
  ) => HostAgentWorkerSupervisor
  /** Internal deterministic test seam; production uses the real v1 runtime. */
  readonly createV1Runtime?: typeof createV1UtilityCompatibilityRuntime
}

function requireHostOwnedFile(path: string, executable: boolean): string {
  const normalized = resolve(path)
  if (normalized !== path) throw new TypeError('Host Agent resource path must be normalized and absolute')
  const metadata = lstatSync(normalized)
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new TypeError('Host Agent resource must be a unique Host-owned regular file')
  }
  const canonical = realpathSync(normalized)
  if (canonical !== normalized) {
    throw new TypeError('Host Agent resource path must not traverse symbolic links')
  }
  const trustedOwner = typeof process.getuid !== 'function'
    || metadata.uid === process.getuid()
    // A drag-installed or administrator-installed signed .app commonly has
    // root-owned immutable resources. That is a stronger trust owner than the
    // current desktop user and must remain launchable.
    || metadata.uid === 0
  if (!trustedOwner) {
    throw new TypeError('Host Agent resource must be a Host-owned regular file')
  }
  if (process.platform !== 'win32' && (metadata.mode & 0o022) !== 0) {
    throw new TypeError('Host Agent resource must not be group/world writable')
  }
  if (executable && process.platform !== 'win32') {
    try { accessSync(normalized, fsConstants.X_OK) } catch {
      throw new TypeError('Host Agent shim is not executable by the current user')
    }
  }
  return canonical
}

async function settleBounded(
  operation: Promise<void>,
  timeoutMs: number,
): Promise<{ status: 'fulfilled' } | { status: 'rejected'; error: unknown } | { status: 'timed-out' }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const guarded = operation.then(
    () => ({ status: 'fulfilled' as const }),
    (error) => ({ status: 'rejected' as const, error }),
  )
  const timeout = new Promise<{ status: 'timed-out' }>((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout({ status: 'timed-out' }), timeoutMs)
  })
  try { return await Promise.race([guarded, timeout]) } finally { if (timer) clearTimeout(timer) }
}

/**
 * Production composition: v1/v2 HTTP state lives in independent Utility
 * Processes while SessionManager/provider ownership remains in the main Host.
 */
export async function createIsolatedHostModuleAgentRuntime(
  options: IsolatedHostModuleAgentRuntimeOptions,
): Promise<IsolatedHostModuleAgentRuntime> {
  const storageRoot = ensureOwnerOnlyDirectory(options.storageRoot)
  const moduleDataRoot = ensureOwnerOnlyDirectory(join(storageRoot, 'module-data'))
  const workerEntryPath = requireHostOwnedFile(options.workerEntryPath, false)
  const shimPath = requireHostOwnedFile(options.shimPath, true)
  const preemptTimeoutMs = options.craftPreemptTimeoutMs ?? DEFAULT_CRAFT_PREEMPT_TIMEOUT_MS
  if (!Number.isSafeInteger(preemptTimeoutMs) || preemptTimeoutMs < 1) {
    throw new TypeError('Craft preemption timeout must be positive')
  }

  let dispatchUnexpectedExit: (event: HostAgentUnexpectedExitEvent) => void = () => undefined
  const onUnexpectedExit = (event: HostAgentUnexpectedExitEvent): void => dispatchUnexpectedExit(event)
  let supervisor: HostAgentWorkerSupervisor
  if (options.createSupervisor) {
    supervisor = options.createSupervisor(onUnexpectedExit)
  } else {
    const { ElectronHostAgentWorkerLauncher } = await import('../host-agent/electron-launcher')
    supervisor = new HostAgentWorkerSupervisor({
      launcher: new ElectronHostAgentWorkerLauncher({ workerEntryPath }),
      tokenStore: new OwnerOnlyHostAgentTokenStore(
        ensureOwnerOnlyDirectory(join(storageRoot, 'host-agent-worker-tokens')),
      ),
      onUnexpectedExit,
    })
  }
  const paths = new NodeModuleAgentPathAuthority()
  const turnLease = new MainProcessModuleTurnLease()
  const v1SessionPort = turnLease.wrapV1(new CraftModuleAgentSessionPort(options.sessions, paths))
  const v2SessionPort = turnLease.wrapV2(new CraftHostAgentRunSessionPort(options.sessions, paths))
  const core = new ModuleAgentRunCore({
    sessions: v2SessionPort,
    paths,
    ids: { createHex: (bytes) => randomBytes(bytes).toString('hex') },
    ...(options.now ? {
      clock: {
        now: options.now,
        setTimeout: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
        clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      },
    } : {}),
  })

  let v1Runtime: V1UtilityCompatibilityRuntime | undefined
  interface ActiveV2Launch {
    readonly grantId: string
    readonly workerEpoch: string
    readonly expiresAt: number
    readonly adapter: V2CorePortAdapter
    cleaned: boolean
    cancelGrantRotation?: () => void
    cleanupPromise?: Promise<void>
  }
  let activeV2: ActiveV2Launch | undefined
  let disposed = false
  const protocolTails: Record<HostAgentProtocolPath, Promise<void>> = {
    v1: Promise.resolve(),
    v2: Promise.resolve(),
  }
  const notifiedRecoveryEpochs = new Set<string>()

  const enqueueProtocolOperation = <Result>(
    protocol: HostAgentProtocolPath,
    operation: () => Promise<Result>,
  ): Promise<Result> => {
    const previous = protocolTails[protocol]
    const result = previous.then(operation, operation)
    protocolTails[protocol] = result.then(() => undefined, () => undefined)
    return result
  }

  const notifyRecovery = (
    event: Readonly<{
      protocol: HostAgentProtocolPath
      epoch: string
      failure: ModuleAgentWorkerRecoveryFailure
    }>,
    circuitOpen = supervisor.snapshot(event.protocol).status === 'circuit-open',
  ): void => {
    if (disposed || !options.onWorkerRecoveryNeeded) return
    const key = `${event.protocol}:${event.epoch}`
    if (notifiedRecoveryEpochs.has(key)) return
    notifiedRecoveryEpochs.add(key)
    const input = Object.freeze({ ...event, circuitOpen })
    try {
      void Promise.resolve(options.onWorkerRecoveryNeeded(input)).catch(() => undefined)
    } catch {
      // Coordinator recovery is outside the isolation boundary. Its failure
      // must never escape into Craft or corrupt the protocol queue.
    }
  }

  const activeEpochForProtocol = (protocol: HostAgentProtocolPath): string | undefined => {
    if (protocol === 'v1') {
      const epoch = v1Runtime?.workerEpoch
      return epoch && supervisor.connection('v1')?.epoch === epoch ? epoch : undefined
    }
    const record = activeV2
    return record && !record.cleaned && supervisor.connection('v2')?.epoch === record.workerEpoch
      ? record.workerEpoch
      : undefined
  }

  const fence = (
    protocol: HostAgentProtocolPath,
    phase: 'craft-preempt' | 'launch-cleanup' | 'worker-recovery' | 'shutdown',
    error?: unknown,
    ownedEpoch?: string,
  ): void => {
    // Capture ownership before tripCircuit turns this into an expected stop;
    // expected stops deliberately do not produce Supervisor exit callbacks.
    const currentEpoch = supervisor.connection(protocol)?.epoch
    const activeEpoch = protocol === 'v1' ? v1Runtime?.workerEpoch : activeV2?.workerEpoch
    const superseded = ownedEpoch !== undefined
      && ((currentEpoch !== undefined && currentEpoch !== ownedEpoch)
        || (activeEpoch !== undefined && activeEpoch !== ownedEpoch))
    const epoch = ownedEpoch ?? activeEpochForProtocol(protocol)
    if (!superseded) supervisor.tripCircuit(protocol)
    try {
      options.onIsolationFailure?.({ protocol, phase, error })
    } catch {
      // Diagnostics are outside the isolation boundary and must never alter
      // Craft admission or Module cleanup control flow.
    }
    if (!superseded && epoch) notifyRecovery({ protocol, epoch, failure: 'cleanup-timeout' }, true)
  }

  const getWorkspace = () => {
    const workspaceId = options.resolveWorkspaceId()
    const workspace = options.sessions.getWorkspaces().find((candidate) => candidate.id === workspaceId)
    if (!workspace) throw new Error('No active local Craft workspace is available for the Module runtime')
    return workspace
  }

  const prepareV1 = async (context: ModuleDaemonLaunchContext): Promise<ModuleDaemonLaunchLease> => {
    if (!v1Runtime) {
      v1Runtime = await (options.createV1Runtime ?? createV1UtilityCompatibilityRuntime)({
        storageRoot,
        sessions: options.sessions,
        supervisor,
        sessionPort: v1SessionPort,
        resolveWorkspaceId: options.resolveWorkspaceId,
        ...(options.now ? { now: options.now } : {}),
      })
    }
    const runtime = v1Runtime
    let lease: ModuleDaemonLaunchLease
    try {
      lease = await runtime.prepareLaunch(context)
    } catch (error) {
      const cleanup = await settleBounded(runtime.dispose(), preemptTimeoutMs)
      if (cleanup.status !== 'fulfilled') {
        const cleanupError = cleanup.status === 'rejected'
          ? cleanup.error
          : new Error('v1 Host Agent failed-launch cleanup timed out')
        fence('v1', 'launch-cleanup', cleanupError, runtime.workerEpoch)
        throw new AggregateError([error, cleanupError], 'v1 Host Agent launch failed and did not fully reap')
      }
      if (v1Runtime === runtime) v1Runtime = undefined
      notifiedRecoveryEpochs.delete(`v1:${runtime.workerEpoch}`)
      throw error
    }
    return {
      environment: Object.freeze({
        ...lease.environment,
        SIMULATOR_HOST_AGENT_SHIM_PATH: shimPath,
        SIMULATOR_HOST_AGENT_CONTRACT_VERSION: '1',
      }),
      cleanup: async (reason) => {
        const cleanup = await settleBounded(lease.cleanup(reason), preemptTimeoutMs)
        if (cleanup.status !== 'fulfilled') {
          const error = cleanup.status === 'rejected'
            ? cleanup.error
            : new Error('v1 Host Agent launch cleanup timed out')
          fence('v1', 'launch-cleanup', error, runtime.workerEpoch)
          throw error
        }
        if (v1Runtime !== runtime) {
          notifiedRecoveryEpochs.delete(`v1:${runtime.workerEpoch}`)
          return
        }
        const runtimeCleanup = await settleBounded(runtime.dispose(), preemptTimeoutMs)
        if (runtimeCleanup.status !== 'fulfilled') {
          const error = runtimeCleanup.status === 'rejected'
            ? runtimeCleanup.error
            : new Error('v1 Host Agent runtime cleanup timed out')
          fence('v1', 'launch-cleanup', error, runtime.workerEpoch)
          throw error
        }
        if (v1Runtime === runtime) v1Runtime = undefined
        notifiedRecoveryEpochs.delete(`v1:${runtime.workerEpoch}`)
      },
    }
  }

  const cleanupV2Record = (
    record: ActiveV2Launch,
    phase: 'launch-cleanup' | 'worker-recovery',
  ): Promise<void> => {
    if (record.cleaned) {
      notifiedRecoveryEpochs.delete(`v2:${record.workerEpoch}`)
      return Promise.resolve()
    }
    if (record.cleanupPromise) return record.cleanupPromise
    const operation = (async () => {
      record.cancelGrantRotation?.()
      record.cancelGrantRotation = undefined
      const cleanup = await settleBounded(record.adapter.disconnect(), preemptTimeoutMs)
      if (cleanup.status !== 'fulfilled') {
        const error = cleanup.status === 'rejected'
          ? cleanup.error
          : new Error('v2 Host Agent launch cleanup timed out')
        fence('v2', phase, error, record.workerEpoch)
        throw error
      }

      // The lease that created this record owns only its exact worker epoch.
      // A late daemon cleanup after recovery must not stop the replacement.
      if (phase === 'launch-cleanup'
        && supervisor.connection('v2')?.epoch === record.workerEpoch) {
        try { await supervisor.stop('v2') } catch (error) {
          fence('v2', phase, error, record.workerEpoch)
          throw error
        }
      }
      // Commit cleanup only after both the grant adapter and exact worker stop
      // are positively settled. A failed stop retains retryable ownership.
      record.cleaned = true
      if (activeV2 === record) activeV2 = undefined
      notifiedRecoveryEpochs.delete(`v2:${record.workerEpoch}`)
    })()
    record.cleanupPromise = operation
    void operation.catch(() => {
      if (record.cleanupPromise === operation) record.cleanupPromise = undefined
    })
    return operation
  }

  const scheduleGrantRotation = options.scheduleGrantRotation ?? ((callback: () => void, delayMs: number) => {
    const timer = setTimeout(callback, delayMs)
    timer.unref?.()
    return () => clearTimeout(timer)
  })

  const armV2GrantRotation = (record: ActiveV2Launch, retryDelayMs?: number): void => {
    record.cancelGrantRotation?.()
    const now = options.now?.() ?? Date.now()
    const untilExpiryMs = Math.max(0, record.expiresAt - now)
    const delayMs = retryDelayMs === undefined
      ? Math.max(0, record.expiresAt - V2_GRANT_ROTATION_LEAD_MS - now)
      : Math.min(retryDelayMs, untilExpiryMs)
    record.cancelGrantRotation = scheduleGrantRotation(() => {
      void enqueueProtocolOperation('v2', async () => {
        if (disposed || activeV2 !== record || record.cleaned
          || supervisor.connection('v2')?.epoch !== record.workerEpoch) return
        const currentNow = options.now?.() ?? Date.now()
        if (currentNow < record.expiresAt - V2_GRANT_ROTATION_LEAD_MS) {
          armV2GrantRotation(record)
          return
        }
        record.cancelGrantRotation = undefined
        if (core.debugSnapshot().activeRuns > 0 && currentNow < record.expiresAt) {
          // Never interrupt a valid Module Turn merely to rotate an idle
          // launch credential. The 35-minute lead exceeds the 30-minute Run
          // ceiling, leaving a five-minute cleanup margin.
          armV2GrantRotation(record, V2_GRANT_ROTATION_RETRY_MS)
          return
        }
        try {
          // Revoke the old grant/Worker/token before asking the Coordinator to
          // relaunch the daemon. No new Run can slip into the rotation window.
          await cleanupV2Record(record, 'launch-cleanup')
        } catch {
          // cleanupV2Record fenced and emitted a circuit-open stop request.
          return
        }
        // Rotate the whole daemon lease/Worker/token instead of extending the
        // old grant. This keeps every bearer authority bounded to 24 hours.
        notifyRecovery({
          protocol: 'v2',
          epoch: record.workerEpoch,
          failure: 'grant-expiring',
        }, false)
        // cleanupV2Record already closed this exact lifecycle. The serialized
        // protocol queue and ownership check suppress any later stale event,
        // so the notification key no longer needs to stay resident.
        notifiedRecoveryEpochs.delete(`v2:${record.workerEpoch}`)
      }).catch(() => undefined)
    }, delayMs)
  }

  const prepareV2 = async (context: ModuleDaemonLaunchContext): Promise<ModuleDaemonLaunchLease> => {
    if (activeV2 && !activeV2.cleaned) throw new Error('A v2 Module launch is already active')
    const workspace = getWorkspace()
    const authorizedWorkingRoot = ensureOwnerOnlyDirectory(join(moduleDataRoot, context.id))
    await supervisor.start('v2')
    const connection = supervisor.connection('v2')
    const rpcPort = supervisor.rpcPort('v2')
    if (!connection || !rpcPort) {
      supervisor.tripCircuit('v2', 'launch-failed')
      throw new Error('v2 Host Agent worker connection is unavailable')
    }
    const grantId = `grant:${randomUUID()}`
    const now = options.now?.() ?? Date.now()
    const expiresAt = now + V2_GRANT_TTL_MS
    try {
      await core.issueGrant({
        grantId,
        moduleId: context.id,
        workerEpoch: connection.epoch,
        workspaceId: workspace.id,
        workspaceRoot: workspace.rootPath,
        authorizedWorkingRoot,
        defaultWorkingDirectory: authorizedWorkingRoot,
        expiresAt,
      })
    } catch (error) {
      supervisor.tripCircuit('v2', 'launch-failed')
      throw error
    }
    const adapter = new V2CorePortAdapter({ core, grantId, port: rpcPort })
    const record: ActiveV2Launch = {
      grantId,
      workerEpoch: connection.epoch,
      expiresAt,
      adapter,
      cleaned: false,
    }
    activeV2 = record
    if (supervisor.connection('v2')?.epoch !== connection.epoch) {
      await cleanupV2Record(record, 'worker-recovery')
      throw new Error('v2 Host Agent worker exited during launch')
    }
    armV2GrantRotation(record)
    return {
      environment: Object.freeze({
        SIMULATOR_HOST_AGENT_URL: connection.address.url,
        SIMULATOR_HOST_AGENT_TOKEN_FILE: connection.tokenFile,
        SIMULATOR_HOST_AGENT_SHIM_PATH: shimPath,
        SIMULATOR_HOST_AGENT_CONTRACT_VERSION: '2',
      }),
      cleanup: async () => cleanupV2Record(record, 'launch-cleanup'),
    }
  }

  const recoverUnexpectedExit = async (event: HostAgentUnexpectedExitEvent): Promise<void> => {
    if (disposed) return
    let ownedEpoch = false
    if (event.protocol === 'v1') {
      const runtime = v1Runtime
      if (runtime?.workerEpoch === event.epoch) {
        ownedEpoch = runtime.hasActiveLaunch()
        const cleanup = await settleBounded(
          runtime.invalidateAfterWorkerExit(event.epoch).then(() => undefined),
          preemptTimeoutMs,
        )
        if (cleanup.status === 'fulfilled') {
          if (v1Runtime === runtime) v1Runtime = undefined
        } else {
          const error = cleanup.status === 'rejected'
            ? cleanup.error
            : new Error('v1 Host Agent worker recovery timed out')
          fence('v1', 'worker-recovery', error, runtime.workerEpoch)
        }
      }
    } else {
      const record = activeV2
      if (record?.workerEpoch === event.epoch) {
        ownedEpoch = true
        try { await cleanupV2Record(record, 'worker-recovery') } catch {
          // cleanupV2Record already fenced only v2 and reported the failure.
        }
      }
    }
    if (ownedEpoch) {
      notifyRecovery(event)
      const stillOwned = event.protocol === 'v1'
        ? v1Runtime?.workerEpoch === event.epoch
        : activeV2?.workerEpoch === event.epoch && !activeV2.cleaned
      if (!stillOwned) notifiedRecoveryEpochs.delete(`${event.protocol}:${event.epoch}`)
    }
  }

  dispatchUnexpectedExit = (event) => {
    void enqueueProtocolOperation(event.protocol, async () => recoverUnexpectedExit(event))
      .catch(() => undefined)
  }

  const unsubscribeCraftPriority = options.sessions.onVisibleCraftTurnStateChange(async (change) => {
    if (!change.active) {
      turnLease.endCraftTurn()
      core.endCraftTurn()
      return
    }

    const owner = turnLease.markCraftActive()
    if (owner?.protocol === 'v1') {
      const result = await turnLease.preemptCurrent(preemptTimeoutMs)
      if (result.status === 'failed' || result.status === 'timed-out') {
        fence('v1', 'craft-preempt', result.error)
      }
    }
    // beginCraftTurn sets the v2 admission flag synchronously before awaiting
    // any provider cleanup. The bounded wrapper contains every failure so the
    // primary Craft send path always proceeds.
    const v2Preemption = await settleBounded(core.beginCraftTurn(), preemptTimeoutMs)
    if (v2Preemption.status !== 'fulfilled') {
      fence('v2', 'craft-preempt', v2Preemption.status === 'rejected' ? v2Preemption.error : undefined)
    }
  })

  const emptyV1Snapshot = (): ModuleAgentGatewaySnapshot => ({
    activeGrants: 0,
    activeSessions: 0,
    activeTurns: 0,
    activeSubscribers: 0,
  })

  const composeSnapshot = (v1: ModuleAgentGatewaySnapshot): IsolatedHostModuleAgentRuntimeSnapshot => Object.freeze({
    kind: 'isolated' as const,
    v1,
    v2: core.debugSnapshot(),
    workers: supervisor.snapshots(),
    turnLease: turnLease.snapshot(),
  })

  return {
    async prepareLaunch(context) {
      if (disposed) throw new Error('Module Agent runtime is disposed')
      if (context.signal.aborted) throw new Error('Module launch was cancelled')
      const protocol = selectHostAgentProtocolForModule(context)
      const lease = await enqueueProtocolOperation(protocol, async () => {
        if (disposed) throw new Error('Module Agent runtime is disposed')
        if (context.signal.aborted) throw new Error('Module launch was cancelled')
        return protocol === 'v1' ? await prepareV1(context) : await prepareV2(context)
      })
      if (context.signal.aborted) {
        await lease.cleanup('stop')
        throw new Error('Module launch was cancelled')
      }
      return lease
    },
    debugSnapshot() {
      return composeSnapshot(v1Runtime?.debugSnapshot() ?? emptyV1Snapshot())
    },
    async refreshDebugSnapshot() {
      const v1 = await enqueueProtocolOperation('v1', async () => {
        const runtime = v1Runtime
        return runtime ? await runtime.refreshDebugSnapshot() : emptyV1Snapshot()
      })
      return composeSnapshot(v1)
    },
    async dispose() {
      if (disposed) return
      disposed = true
      unsubscribeCraftPriority()
      turnLease.markCraftActive()
      const errors: unknown[] = []

      // Finish exact-epoch invalidation before normal shutdown can touch any
      // lane. Recovery observers are never awaited, so this cannot deadlock a
      // Coordinator operation.
      await Promise.all([protocolTails.v1, protocolTails.v2])

      const owner = turnLease.snapshot().owner
      if (owner?.protocol === 'v1') {
        const result = await turnLease.preemptCurrent(preemptTimeoutMs)
        if (result.status === 'failed' || result.status === 'timed-out') {
          fence('v1', 'shutdown', result.error)
          errors.push(result.error ?? new Error('v1 provider reap timed out'))
        }
      }
      const coreShutdown = await settleBounded(core.shutdown(), preemptTimeoutMs)
      if (coreShutdown.status !== 'fulfilled') {
        fence('v2', 'shutdown', coreShutdown.status === 'rejected' ? coreShutdown.error : undefined)
        errors.push(coreShutdown.status === 'rejected' ? coreShutdown.error : new Error('v2 provider reap timed out'))
      }
      if (v1Runtime) {
        const v1Shutdown = await settleBounded(v1Runtime.dispose(), preemptTimeoutMs)
        if (v1Shutdown.status !== 'fulfilled') {
          const error = v1Shutdown.status === 'rejected'
            ? v1Shutdown.error
            : new Error('v1 Host Agent runtime shutdown timed out')
          fence('v1', 'shutdown', error)
          errors.push(error)
        }
      }
      if (activeV2 && !activeV2.cleaned) {
        const v2LaunchCleanup = await settleBounded(
          cleanupV2Record(activeV2, 'launch-cleanup'),
          preemptTimeoutMs,
        )
        if (v2LaunchCleanup.status !== 'fulfilled') {
          errors.push(v2LaunchCleanup.status === 'rejected'
            ? v2LaunchCleanup.error
            : new Error('v2 launch cleanup timed out during shutdown'))
        }
      }
      const stopped = await supervisor.stopAll()
      for (const result of [stopped.v1, stopped.v2]) {
        if (result.status === 'rejected') errors.push(result.reason)
      }
      await supervisor.drain()
      notifiedRecoveryEpochs.clear()
      if (errors.length > 0) throw new AggregateError(errors, 'Module Agent runtime did not fully reap')
    },
  }
}
