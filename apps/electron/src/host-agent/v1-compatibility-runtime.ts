import { randomUUID } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { lstat, readdir, realpath, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
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
const DEFAULT_V1_EXIT_CONFIRMATION_TIMEOUT_MS = 1_000

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
  const environmentRecord = environment as Record<string, unknown>
  const environmentKeys = Reflect.ownKeys(environmentRecord)
  if (environmentKeys.length !== 2
    || environmentKeys.some((key) => typeof key !== 'string'
      || !['SIMULATOR_HOST_AGENT_URL', 'SIMULATOR_HOST_AGENT_TOKEN_FILE'].includes(key))
    || typeof environmentRecord.SIMULATOR_HOST_AGENT_URL !== 'string'
    || typeof environmentRecord.SIMULATOR_HOST_AGENT_TOKEN_FILE !== 'string') {
    throw new TypeError('v1 worker returned an invalid launch environment')
  }
  let endpoint: URL
  try { endpoint = new URL(environmentRecord.SIMULATOR_HOST_AGENT_URL) } catch {
    throw new TypeError('v1 worker returned an invalid launch environment')
  }
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1'
    || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) {
    throw new TypeError('v1 worker returned an invalid launch environment')
  }
  const result = parseDebugSnapshot(snapshot)
  return { leaseId, environment: environmentRecord as Record<string, string>, snapshot: result }
}

function parseDebugSnapshot(value: unknown): ModuleAgentGatewaySnapshot {
  if (!value || typeof value !== 'object') throw new TypeError('v1 worker returned an invalid snapshot')
  const keys = Reflect.ownKeys(value)
  const expected = ['activeGrants', 'activeSessions', 'activeTurns', 'activeSubscribers'] as const
  if (keys.length !== expected.length
    || keys.some((key) => typeof key !== 'string' || !expected.includes(key as typeof expected[number]))) {
    throw new TypeError('v1 worker returned an invalid snapshot')
  }
  const result = value as ModuleAgentGatewaySnapshot
  for (const key of ['activeGrants', 'activeSessions', 'activeTurns', 'activeSubscribers'] as const) {
    if (!Number.isSafeInteger(result[key]) || result[key] < 0) throw new TypeError('v1 worker returned an invalid snapshot')
  }
  return { ...result }
}

function isMissingFile(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

async function removeExitedWorkerToken(tokenFile: string, tokenDirectory: string): Promise<void> {
  if (resolve(tokenFile) !== tokenFile || dirname(tokenFile) !== tokenDirectory
    || !/^\.module-agent-[0-9a-f]{16}\.token$/.test(tokenFile.slice(tokenDirectory.length + 1))) {
    throw new TypeError('v1 Compatibility token path is outside its owner-only directory')
  }
  let metadata
  try { metadata = await lstat(tokenFile) } catch (error) {
    if (isMissingFile(error)) return
    throw error
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
    || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())
    || (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0)) {
    throw new TypeError('v1 Compatibility token file is not an owner-only regular file')
  }
  if (await realpath(tokenFile) !== tokenFile) {
    throw new TypeError('v1 Compatibility token path must not traverse symbolic links')
  }
  await unlink(tokenFile)
}

async function removeExitedWorkerTokensInDirectory(tokenDirectory: string): Promise<void> {
  let metadata
  try { metadata = await lstat(tokenDirectory) } catch (error) {
    if (isMissingFile(error)) return
    throw error
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()
    || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())
    || (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0)
    || await realpath(tokenDirectory) !== tokenDirectory) {
    throw new TypeError('v1 Compatibility token directory is not owner-only')
  }
  const entries = await readdir(tokenDirectory, { withFileTypes: true })
  for (const entry of entries) {
    if (!/^\.module-agent-[0-9a-f]{16}\.token$/.test(entry.name)) continue
    await removeExitedWorkerToken(join(tokenDirectory, entry.name), tokenDirectory)
  }
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
  readonly workerEpoch: string
  hasActiveLaunch(): boolean
  prepareLaunch(context: ModuleDaemonLaunchContext): Promise<ModuleDaemonLaunchLease>
  /** Strict local cleanup for a worker whose process exit was positively observed. */
  invalidateAfterWorkerExit(epoch: string): Promise<boolean>
  /** Exact worker-local Gateway state for acceptance and leak checks. */
  refreshDebugSnapshot(): Promise<ModuleAgentGatewaySnapshot>
  /** Synchronous main-process ownership view; use refreshDebugSnapshot for exact HTTP subscriber state. */
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
  const connection = options.supervisor.connection('v1')
  const rpcPort = options.supervisor.rpcPort('v1')
  if (!connection || !rpcPort) throw new Error('v1 Compatibility worker RPC port is unavailable')
  const workerEpoch = connection.epoch
  const paths = new NodeModuleAgentPathAuthority()
  const adapter = new V1CorePortAdapter({
    sessions: options.sessionPort ?? new CraftModuleAgentSessionPort(options.sessions, paths),
    paths,
    port: rpcPort,
    requestTimeoutMs,
  })
  interface ActiveLease {
    readonly scopeId: string
    readonly tokenFile: string
    readonly tokenDirectory: string
    cleaned: boolean
    remoteCleanup?: Promise<void>
    localCleanup?: Promise<void>
    dispose(): Promise<void>
  }
  const activeLeases = new Map<string, ActiveLease>()
  const tokenDirectories = new Set<string>()
  let disposed = false
  let workerExited = false
  let disposePromise: Promise<void> | undefined
  let invalidationPromise: Promise<boolean> | undefined

  const currentWorkerMatches = (): boolean => options.supervisor.connection('v1')?.epoch === workerEpoch

  const waitForWorkerExitConfirmation = async (): Promise<boolean> => {
    const timeoutMs = Math.min(cleanupTimeoutMs, DEFAULT_V1_EXIT_CONFIRMATION_TIMEOUT_MS)
    const deadline = Date.now() + timeoutMs
    while (currentWorkerMatches()) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) return false
      await new Promise<void>((resolveDelay) => {
        const timer = setTimeout(resolveDelay, Math.min(10, remaining))
        timer.unref?.()
      })
    }
    return true
  }

  const cleanLeaseLocally = (leaseId: string, lease: ActiveLease): Promise<void> => {
    if (lease.cleaned) return Promise.resolve()
    if (lease.localCleanup) return lease.localCleanup
    const operation = (async () => {
      adapter.unregisterGrantScope(lease.scopeId)
      await removeExitedWorkerToken(lease.tokenFile, lease.tokenDirectory)
      lease.cleaned = true
      if (activeLeases.get(leaseId) === lease) activeLeases.delete(leaseId)
    })()
    lease.localCleanup = operation
    void operation.then(
      () => undefined,
      () => { if (lease.localCleanup === operation) lease.localCleanup = undefined },
    )
    return operation
  }

  const invalidateExitedWorker = (epoch: string): Promise<boolean> => {
    if (epoch !== workerEpoch) return Promise.resolve(false)
    workerExited = true
    disposed = true
    if (invalidationPromise) return invalidationPromise
    const operation = (async (): Promise<boolean> => {
      const errors: unknown[] = []
      const deadline = Date.now() + cleanupTimeoutMs
      const remaining = (): number => Math.max(0, deadline - Date.now())
      const settleWithinBudget = async (task: Promise<void>, description: string) => {
        const budget = remaining()
        if (budget === 0) {
          void task.catch(() => undefined)
          errors.push(new Error(`${description} timed out after ${cleanupTimeoutMs}ms`))
          return
        }
        const result = await settleV1Cleanup(task, budget)
        if (result.status === 'timed-out') errors.push(new Error(`${description} timed out after ${cleanupTimeoutMs}ms`))
        else if (result.status === 'rejected') errors.push(result.error)
      }

      // The exited Utility Process cannot own a live HTTP grant any longer.
      // Strict safety is therefore local: reap every Craft Session first, then
      // remove only the exact bearer files returned by that worker. Never send
      // disposeLease to a port whose process is known to be gone.
      await settleWithinBudget(adapter.disconnect(), 'v1 Compatibility Session cleanup')
      await settleWithinBudget(Promise.allSettled(
        [...activeLeases.entries()].map(async ([leaseId, lease]) => {
          await cleanLeaseLocally(leaseId, lease)
        }),
      ).then((results) => {
        for (const result of results) if (result.status === 'rejected') throw result.reason
      }), 'v1 Compatibility token cleanup')
      await settleWithinBudget(Promise.allSettled(
        [...tokenDirectories].map(async (tokenDirectory) => {
          await removeExitedWorkerTokensInDirectory(tokenDirectory)
        }),
      ).then((results) => {
        for (const result of results) if (result.status === 'rejected') throw result.reason
      }), 'v1 Compatibility orphan token cleanup')

      if (errors.length > 0) {
        options.supervisor.tripCircuit('v1', 'cleanup-timeout')
        throw new AggregateError(errors, 'v1 Compatibility worker-exit cleanup did not fully reap')
      }
      tokenDirectories.clear()
      return true
    })()
    invalidationPromise = operation
    void operation.catch(() => {
      if (invalidationPromise === operation) invalidationPromise = undefined
    })
    return operation
  }

  const failClosedPrepare = async (cause: unknown): Promise<never> => {
    disposed = true
    const cleanupErrors: unknown[] = []
    let exitConfirmed = !currentWorkerMatches()
    if (!exitConfirmed) {
      const stopped = await settleV1Cleanup(options.supervisor.stop('v1'), cleanupTimeoutMs)
      if (stopped.status === 'fulfilled') exitConfirmed = true
      else if (stopped.status === 'timed-out') {
        cleanupErrors.push(new Error(`v1 Compatibility worker stop timed out after ${cleanupTimeoutMs}ms`))
      } else {
        cleanupErrors.push(stopped.error)
      }
      // The Supervisor revokes connection authority synchronously when it
      // positively observes exit, even if final token cleanup later rejects.
      exitConfirmed ||= !currentWorkerMatches()
    }
    if (exitConfirmed) {
      try {
        await invalidateExitedWorker(workerEpoch)
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    if (cleanupErrors.length > 0) {
      options.supervisor.tripCircuit('v1', 'cleanup-timeout')
      throw new AggregateError(
        [cause, ...cleanupErrors],
        'v1 Compatibility invalid prepare response did not fully reap',
      )
    }
    throw cause
  }

  return {
    workerEpoch,
    hasActiveLaunch: () => activeLeases.size > 0,
    async prepareLaunch(context) {
      if (disposed) throw new Error('v1 Compatibility runtime is disposed')
      if (context.signal.aborted) throw new Error('Module launch was cancelled')
      const workspaceId = options.resolveWorkspaceId()
      const workspace = options.sessions.getWorkspaces().find((candidate) => candidate.id === workspaceId)
      if (!workspace) throw new Error('No active local Craft workspace is available for the Module runtime')

      const authorizedWorkingRoot = ensureOwnerOnlyDirectory(join(moduleDataRoot, context.id))
      const tokenDirectory = ensureOwnerOnlyDirectory(join(tokenRoot, context.id))
      tokenDirectories.add(tokenDirectory)
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
        const tokenFile = prepared.environment.SIMULATOR_HOST_AGENT_TOKEN_FILE
        if (resolve(tokenFile) !== tokenFile || dirname(tokenFile) !== tokenDirectory) {
          throw new TypeError('v1 worker returned a token outside its owner-only directory')
        }
      } catch (error) {
        adapter.unregisterGrantScope(scopeId)
        return await failClosedPrepare(error)
      }
      const tokenFile = prepared.environment.SIMULATOR_HOST_AGENT_TOKEN_FILE
      const lease: ActiveLease = {
        scopeId,
        tokenFile,
        tokenDirectory,
        cleaned: false,
        dispose: async () => undefined,
      }
      const cleanup = async (): Promise<void> => {
        if (lease.cleaned) return
        if (workerExited || !currentWorkerMatches()) {
          await invalidateExitedWorker(workerEpoch)
          return
        }
        if (lease.remoteCleanup) return await lease.remoteCleanup
        const operation = (async () => {
          try {
            await adapter.invokeWorker('disposeLease', { leaseId: prepared.leaseId })
          } catch (error) {
            if (currentWorkerMatches()) await waitForWorkerExitConfirmation()
            if (!currentWorkerMatches()) {
              lease.remoteCleanup = undefined
              await invalidateExitedWorker(workerEpoch)
              return
            }
            throw error
          }
          adapter.unregisterGrantScope(scopeId)
          activeLeases.delete(prepared.leaseId)
          lease.cleaned = true
        })()
        lease.remoteCleanup = operation
        void operation.then(
          () => undefined,
          () => { if (lease.remoteCleanup === operation) lease.remoteCleanup = undefined },
        )
        return await operation
      }
      lease.dispose = cleanup
      activeLeases.set(prepared.leaseId, lease)
      if (!currentWorkerMatches()) {
        await invalidateExitedWorker(workerEpoch)
        throw new Error('v1 Compatibility worker exited during launch')
      }
      if (context.signal.aborted) {
        await cleanup()
        throw new Error('Module launch was cancelled')
      }
      return { environment: prepared.environment, cleanup }
    },
    invalidateAfterWorkerExit: invalidateExitedWorker,
    async refreshDebugSnapshot() {
      if (disposed || workerExited || !currentWorkerMatches()) {
        throw new Error('v1 Compatibility worker snapshot is unavailable')
      }
      return parseDebugSnapshot(await adapter.invokeWorker('debugSnapshot', {}))
    },
    debugSnapshot: () => adapter.debugSnapshot(),
    dispose() {
      if (disposePromise) return disposePromise
      if (workerExited || !currentWorkerMatches()) {
        const operation = invalidateExitedWorker(workerEpoch).then(() => undefined)
        disposePromise = operation
        void operation.catch(() => {
          if (disposePromise === operation) disposePromise = undefined
        })
        return operation
      }
      disposed = true
      const operation = (async () => {
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

        const disconnect = await settleWithinBudget(adapter.disconnect())
        if (disconnect.status === 'timed-out') {
          errors.push(new Error(`v1 Compatibility Session cleanup timed out after ${cleanupTimeoutMs}ms`))
        } else if (disconnect.status === 'rejected') {
          errors.push(disconnect.error)
        }

        // A late cleanup from an older lease must never stop a replacement
        // worker. Only the exact epoch captured by this runtime may be stopped.
        let exitConfirmed = !currentWorkerMatches()
        if (currentWorkerMatches()) {
          const stopped = await settleWithinBudget(options.supervisor.stop('v1'))
          if (stopped.status === 'fulfilled') {
            exitConfirmed = true
          } else if (stopped.status === 'timed-out') {
            errors.push(new Error(`v1 Compatibility worker stop timed out after ${cleanupTimeoutMs}ms`))
          } else {
            errors.push(stopped.error)
          }
          exitConfirmed ||= !currentWorkerMatches()
        }
        if (exitConfirmed) {
          try {
            // A confirmed process exit converts all remote cleanup uncertainty
            // into exact local ownership. Retry Session reap and sweep only the
            // token directory captured by this worker epoch.
            await invalidateExitedWorker(workerEpoch)
            return
          } catch (error) {
            errors.push(error)
          }
        }
        if (errors.length > 0) {
          // Retain activeLeases and adapter ownership so a later dispose can
          // retry after the Supervisor finally observes this exact exit.
          options.supervisor.tripCircuit('v1', 'cleanup-timeout')
          throw new AggregateError(errors, 'v1 Compatibility runtime did not fully reap')
        }
      })()
      disposePromise = operation
      void operation.catch(() => {
        if (disposePromise === operation) disposePromise = undefined
      })
      return operation
    },
  }
}
