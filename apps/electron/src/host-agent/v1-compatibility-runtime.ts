import { randomUUID } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { ModuleAgentGatewaySnapshot, ModuleAgentGrantSpec, ModuleAgentSessionPort } from '@simulator/module-agent-gateway'
import { NodeModuleAgentPathAuthority } from '@simulator/module-agent-gateway/node'
import type { ModuleDaemonLaunchContext, ModuleDaemonLaunchLease } from '@simulator/module-daemon'
import { CraftModuleAgentSessionPort } from '@craft-agent/server-core/sessions'
import type { ISessionManager } from '@craft-agent/server-core/handlers'
import type { HostAgentWorkerSupervisor } from './supervisor'
import { V1CorePortAdapter } from './v1-core-port-adapter'

const V1_GRANT_TTL_MS = 24 * 60 * 60 * 1_000
const DEFAULT_V1_REQUEST_TIMEOUT_MS = 5_000
const DEFAULT_V1_CLEANUP_TIMEOUT_MS = 6_000

async function settleV1Cleanup(
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
    timer.unref?.()
  })
  try { return await Promise.race([guarded, timeout]) } finally { if (timer) clearTimeout(timer) }
}

function ensureOwnerOnlyDirectory(path: string): string {
  const normalized = resolve(path)
  if (normalized !== path) throw new TypeError('v1 Compatibility directory must be a normalized absolute path')
  mkdirSync(normalized, { recursive: true, mode: 0o700 })
  const canonical = realpathSync(normalized)
  let metadata = lstatSync(canonical)
  if (!metadata.isDirectory() || metadata.isSymbolicLink()
    || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())) {
    throw new TypeError('v1 Compatibility directory must be host-owned')
  }
  if (process.platform !== 'win32') {
    chmodSync(canonical, 0o700)
    metadata = lstatSync(canonical)
    if ((metadata.mode & 0o077) !== 0) throw new TypeError('v1 Compatibility directory must be owner-only')
  }
  return canonical
}

function parsePrepareResult(value: unknown): {
  leaseId: string
  environment: Readonly<Record<string, string>>
  snapshot: ModuleAgentGatewaySnapshot
} {
  if (!value || typeof value !== 'object') throw new TypeError('v1 worker returned an invalid launch lease')
  const input = value as Record<string, unknown>
  const leaseId = input.leaseId
  const environment = input.environment
  const snapshot = input.snapshot
  if (typeof leaseId !== 'string' || !/^lease_[1-9][0-9]*$/.test(leaseId)
    || !environment || typeof environment !== 'object'
    || !snapshot || typeof snapshot !== 'object') {
    throw new TypeError('v1 worker returned an invalid launch lease')
  }
  const entries = Object.entries(environment as Record<string, unknown>)
  if (entries.length !== 2 || entries.some(([, item]) => typeof item !== 'string')) {
    throw new TypeError('v1 worker returned an invalid launch environment')
  }
  const result = snapshot as ModuleAgentGatewaySnapshot
  for (const key of ['activeGrants', 'activeSessions', 'activeTurns', 'activeSubscribers'] as const) {
    if (!Number.isSafeInteger(result[key]) || result[key] < 0) throw new TypeError('v1 worker returned an invalid snapshot')
  }
  return { leaseId, environment: environment as Record<string, string>, snapshot: result }
}

export interface V1UtilityCompatibilityRuntimeOptions {
  storageRoot: string
  sessions: ISessionManager
  supervisor: HostAgentWorkerSupervisor
  sessionPort?: ModuleAgentSessionPort
  resolveWorkspaceId(): string | undefined
  now?: () => number
  /** Internal deterministic test seams; production uses the bounded defaults. */
  requestTimeoutMs?: number
  cleanupTimeoutMs?: number
}

export interface V1UtilityCompatibilityRuntime {
  prepareLaunch(context: ModuleDaemonLaunchContext): Promise<ModuleDaemonLaunchLease>
  debugSnapshot(): ModuleAgentGatewaySnapshot
  dispose(): Promise<void>
}

/** Drop-in v1 Host runtime with Gateway/HTTP state owned by its Utility Process. */
export async function createV1UtilityCompatibilityRuntime(
  options: V1UtilityCompatibilityRuntimeOptions,
): Promise<V1UtilityCompatibilityRuntime> {
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_V1_REQUEST_TIMEOUT_MS
  const cleanupTimeoutMs = options.cleanupTimeoutMs ?? DEFAULT_V1_CLEANUP_TIMEOUT_MS
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1
    || !Number.isSafeInteger(cleanupTimeoutMs) || cleanupTimeoutMs < 1) {
    throw new TypeError('v1 Compatibility cleanup timeouts must be positive')
  }
  const storageRoot = ensureOwnerOnlyDirectory(options.storageRoot)
  const moduleDataRoot = ensureOwnerOnlyDirectory(join(storageRoot, 'module-data'))
  const tokenRoot = ensureOwnerOnlyDirectory(join(storageRoot, 'agent-grants'))
  await options.supervisor.start('v1')
  const rpcPort = options.supervisor.rpcPort('v1')
  if (!rpcPort) throw new Error('v1 Compatibility worker RPC port is unavailable')
  const paths = new NodeModuleAgentPathAuthority()
  const adapter = new V1CorePortAdapter({
    sessions: options.sessionPort ?? new CraftModuleAgentSessionPort(options.sessions, paths),
    paths,
    port: rpcPort,
    requestTimeoutMs,
  })
  const activeLeases = new Map<string, { scopeId: string; dispose(): Promise<void> }>()
  let lastSnapshot: ModuleAgentGatewaySnapshot = {
    activeGrants: 0,
    activeSessions: 0,
    activeTurns: 0,
    activeSubscribers: 0,
  }
  let disposed = false
  let disposePromise: Promise<void> | undefined

  return {
    async prepareLaunch(context) {
      if (disposed) throw new Error('v1 Compatibility runtime is disposed')
      if (context.signal.aborted) throw new Error('Module launch was cancelled')
      const workspaceId = options.resolveWorkspaceId()
      const workspace = options.sessions.getWorkspaces().find((candidate) => candidate.id === workspaceId)
      if (!workspace) throw new Error('No active local Craft workspace is available for the Module runtime')

      const authorizedWorkingRoot = ensureOwnerOnlyDirectory(join(moduleDataRoot, context.id))
      const tokenDirectory = ensureOwnerOnlyDirectory(join(tokenRoot, context.id))
      const scopeId = `scope:${randomUUID()}`
      const now = options.now?.() ?? Date.now()
      const spec: ModuleAgentGrantSpec = {
        ownerId: `workspace:${workspace.id}`,
        moduleId: context.id,
        launchId: randomUUID(),
        lifecycleId: randomUUID(),
        workspaceId: workspace.id,
        workspaceRoot: workspace.rootPath,
        authorizedWorkingRoot,
        defaultWorkingDirectory: authorizedWorkingRoot,
        expiresAt: now + V1_GRANT_TTL_MS,
      }
      await adapter.registerGrantScope(scopeId, spec)
      let prepared: ReturnType<typeof parsePrepareResult>
      try {
        prepared = parsePrepareResult(await adapter.invokeWorker('prepareLaunch', { spec, tokenDirectory }))
      } catch (error) {
        adapter.unregisterGrantScope(scopeId)
        throw error
      }
      lastSnapshot = prepared.snapshot
      let cleaned = false
      let cleanupPromise: Promise<void> | undefined
      const cleanup = (): Promise<void> => {
        if (cleaned) return Promise.resolve()
        if (cleanupPromise) return cleanupPromise
        const operation = (async () => {
          const response = await adapter.invokeWorker('disposeLease', { leaseId: prepared.leaseId })
          const parsed = response && typeof response === 'object'
            ? (response as Record<string, unknown>).snapshot
            : undefined
          if (parsed && typeof parsed === 'object') lastSnapshot = parsed as ModuleAgentGatewaySnapshot
          adapter.unregisterGrantScope(scopeId)
          activeLeases.delete(prepared.leaseId)
          cleaned = true
        })()
        cleanupPromise = operation
        void operation.then(
          () => undefined,
          () => { if (cleanupPromise === operation) cleanupPromise = undefined },
        )
        return operation
      }
      activeLeases.set(prepared.leaseId, { scopeId, dispose: cleanup })
      if (context.signal.aborted) {
        await cleanup()
        throw new Error('Module launch was cancelled')
      }
      return { environment: prepared.environment, cleanup }
    },
    debugSnapshot: () => ({ ...lastSnapshot }),
    dispose() {
      if (disposePromise) return disposePromise
      disposed = true
      disposePromise = (async () => {
        const errors: unknown[] = []
        const deadline = Date.now() + cleanupTimeoutMs
        const remaining = (): number => Math.max(0, deadline - Date.now())
        const settleWithinBudget = async (operation: Promise<void>) => {
          const budget = remaining()
          if (budget === 0) {
            void operation.catch(() => undefined)
            return { status: 'timed-out' as const }
          }
          return await settleV1Cleanup(operation, budget)
        }
        const leaseCleanup = Promise.allSettled(
          [...activeLeases.values()].map((lease) => lease.dispose()),
        ).then((results) => {
          for (const result of results) if (result.status === 'rejected') errors.push(result.reason)
        })
        const leases = await settleWithinBudget(leaseCleanup)
        if (leases.status === 'timed-out') {
          errors.push(new Error(`v1 Compatibility lease cleanup timed out after ${cleanupTimeoutMs}ms`))
        } else if (leases.status === 'rejected') {
          errors.push(leases.error)
        }
        activeLeases.clear()

        const disconnect = await settleWithinBudget(adapter.disconnect())
        if (disconnect.status === 'timed-out') {
          errors.push(new Error(`v1 Compatibility Session cleanup timed out after ${cleanupTimeoutMs}ms`))
        } else if (disconnect.status === 'rejected') {
          errors.push(disconnect.error)
        }

        // Any uncertain strict reap fences only v1. The supervisor owns the
        // bounded process kill; no failure here may request Electron/Craft exit.
        if (errors.length > 0) options.supervisor.tripCircuit('v1', 'cleanup-timeout')
        const stopped = await settleWithinBudget(options.supervisor.stop('v1'))
        if (stopped.status === 'timed-out') {
          options.supervisor.tripCircuit('v1', 'cleanup-timeout')
          errors.push(new Error(`v1 Compatibility worker stop timed out after ${cleanupTimeoutMs}ms`))
        } else if (stopped.status === 'rejected') {
          options.supervisor.tripCircuit('v1', 'cleanup-timeout')
          errors.push(stopped.error)
        }
        if (errors.length > 0) {
          throw new AggregateError(errors, 'v1 Compatibility runtime did not fully reap')
        }
      })()
      return disposePromise
    },
  }
}
