import { chmodSync, lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
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
} from '@craft-agent/server-core/sessions'
import type { ISessionManager } from '@craft-agent/server-core/handlers'

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
