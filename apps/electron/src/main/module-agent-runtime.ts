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
import { HostAgentWorkerSupervisor } from '../host-agent/supervisor'
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

export interface HostModuleAgentRuntime {
  prepareLaunch(context: ModuleDaemonLaunchContext): Promise<ModuleDaemonLaunchLease>
  debugSnapshot(): ModuleAgentGatewaySnapshot
  dispose(): Promise<void>
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
): Promise<HostModuleAgentRuntime> {
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
    debugSnapshot: () => gateway.debugSnapshot(),
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
const DEFAULT_CRAFT_PREEMPT_TIMEOUT_MS = 10_000

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
  readonly onIsolationFailure?: (input: {
    protocol: HostAgentProtocolPath
    phase: 'craft-preempt' | 'launch-cleanup' | 'shutdown'
    error?: unknown
  }) => void
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
): Promise<HostModuleAgentRuntime> {
  const storageRoot = ensureOwnerOnlyDirectory(options.storageRoot)
  const moduleDataRoot = ensureOwnerOnlyDirectory(join(storageRoot, 'module-data'))
  const workerEntryPath = requireHostOwnedFile(options.workerEntryPath, false)
  const shimPath = requireHostOwnedFile(options.shimPath, true)
  const preemptTimeoutMs = options.craftPreemptTimeoutMs ?? DEFAULT_CRAFT_PREEMPT_TIMEOUT_MS
  if (!Number.isSafeInteger(preemptTimeoutMs) || preemptTimeoutMs < 1) {
    throw new TypeError('Craft preemption timeout must be positive')
  }

  const { ElectronHostAgentWorkerLauncher } = await import('../host-agent/electron-launcher')
  const supervisor = new HostAgentWorkerSupervisor({
    launcher: new ElectronHostAgentWorkerLauncher({ workerEntryPath }),
    tokenStore: new OwnerOnlyHostAgentTokenStore(
      ensureOwnerOnlyDirectory(join(storageRoot, 'host-agent-worker-tokens')),
    ),
  })
  const paths = new NodeModuleAgentPathAuthority()
  const turnLease = new MainProcessModuleTurnLease()
  const v1SessionPort = turnLease.wrapV1(new CraftModuleAgentSessionPort(options.sessions, paths))
  const v2SessionPort = turnLease.wrapV2(new CraftHostAgentRunSessionPort(options.sessions, paths))
  const core = new ModuleAgentRunCore({
    sessions: v2SessionPort,
    paths,
    ids: { createHex: (bytes) => randomBytes(bytes).toString('hex') },
  })

  let v1Runtime: V1UtilityCompatibilityRuntime | undefined
  let activeV2: { grantId: string; adapter: V2CorePortAdapter; cleaned: boolean } | undefined
  let disposed = false

  const fence = (
    protocol: HostAgentProtocolPath,
    phase: 'craft-preempt' | 'launch-cleanup' | 'shutdown',
    error?: unknown,
  ): void => {
    supervisor.tripCircuit(protocol)
    try {
      options.onIsolationFailure?.({ protocol, phase, error })
    } catch {
      // Diagnostics are outside the isolation boundary and must never alter
      // Craft admission or Module cleanup control flow.
    }
  }

  const getWorkspace = () => {
    const workspaceId = options.resolveWorkspaceId()
    const workspace = options.sessions.getWorkspaces().find((candidate) => candidate.id === workspaceId)
    if (!workspace) throw new Error('No active local Craft workspace is available for the Module runtime')
    return workspace
  }

  const prepareV1 = async (context: ModuleDaemonLaunchContext): Promise<ModuleDaemonLaunchLease> => {
    if (!v1Runtime) {
      v1Runtime = await createV1UtilityCompatibilityRuntime({
        storageRoot,
        sessions: options.sessions,
        supervisor,
        sessionPort: v1SessionPort,
        resolveWorkspaceId: options.resolveWorkspaceId,
        ...(options.now ? { now: options.now } : {}),
      })
    }
    const lease = await v1Runtime.prepareLaunch(context)
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
          fence('v1', 'launch-cleanup', error)
          throw error
        }
      },
    }
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
    try {
      await core.issueGrant({
        grantId,
        moduleId: context.id,
        workerEpoch: connection.epoch,
        workspaceId: workspace.id,
        workspaceRoot: workspace.rootPath,
        authorizedWorkingRoot,
        defaultWorkingDirectory: authorizedWorkingRoot,
        expiresAt: now + V2_GRANT_TTL_MS,
      })
    } catch (error) {
      supervisor.tripCircuit('v2', 'launch-failed')
      throw error
    }
    const adapter = new V2CorePortAdapter({ core, grantId, port: rpcPort })
    const record = { grantId, adapter, cleaned: false }
    activeV2 = record
    return {
      environment: Object.freeze({
        SIMULATOR_HOST_AGENT_URL: connection.address.url,
        SIMULATOR_HOST_AGENT_TOKEN_FILE: connection.tokenFile,
        SIMULATOR_HOST_AGENT_SHIM_PATH: shimPath,
        SIMULATOR_HOST_AGENT_CONTRACT_VERSION: '2',
      }),
      cleanup: async () => {
        if (record.cleaned) return
        const cleanup = await settleBounded(adapter.disconnect(), preemptTimeoutMs)
        if (cleanup.status !== 'fulfilled') {
          fence('v2', 'launch-cleanup', cleanup.status === 'rejected' ? cleanup.error : undefined)
          throw new Error('v2 Host Agent launch cleanup did not complete')
        }
        record.cleaned = true
        if (activeV2 === record) activeV2 = undefined
        await supervisor.stop('v2')
      },
    }
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

  return {
    async prepareLaunch(context) {
      if (disposed) throw new Error('Module Agent runtime is disposed')
      if (context.signal.aborted) throw new Error('Module launch was cancelled')
      const protocol = selectHostAgentProtocolForModule(context)
      const lease = protocol === 'v1' ? await prepareV1(context) : await prepareV2(context)
      if (context.signal.aborted) {
        await lease.cleanup('stop')
        throw new Error('Module launch was cancelled')
      }
      return lease
    },
    debugSnapshot() {
      if (v1Runtime) return v1Runtime.debugSnapshot()
      const snapshot = core.debugSnapshot()
      return {
        activeGrants: snapshot.activeGrants,
        activeSessions: snapshot.moduleSessions,
        activeTurns: snapshot.activeRuns,
        activeSubscribers: snapshot.subscribers,
      }
    },
    async dispose() {
      if (disposed) return
      disposed = true
      unsubscribeCraftPriority()
      turnLease.markCraftActive()
      const errors: unknown[] = []

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
      const stopped = await supervisor.stopAll()
      for (const result of [stopped.v1, stopped.v2]) {
        if (result.status === 'rejected') errors.push(result.reason)
      }
      await supervisor.drain()
      if (errors.length > 0) throw new AggregateError(errors, 'Module Agent runtime did not fully reap')
    },
  }
}
