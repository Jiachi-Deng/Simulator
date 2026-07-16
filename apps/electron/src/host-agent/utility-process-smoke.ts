import { app } from 'electron'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ElectronHostAgentWorkerLauncher } from './electron-launcher'
import { HostAgentWorkerSupervisor } from './supervisor'
import { OwnerOnlyHostAgentTokenStore } from './token-store'
import { V1CorePortAdapter } from './v1-core-port-adapter'
import { FakeModuleAgentSessionPort } from '@simulator/module-agent-gateway/testing'
import { NodeModuleAgentPathAuthority } from '@simulator/module-agent-gateway/node'
import type { ModuleAgentGrantSpec } from '@simulator/module-agent-gateway'

async function main(): Promise<void> {
  await app.whenReady()
  app.dock?.hide()
  const root = await mkdtemp(join(tmpdir(), 'simulator-host-agent-smoke-'))
  try {
    const supervisor = new HostAgentWorkerSupervisor({
      launcher: new ElectronHostAgentWorkerLauncher({
        workerEntryPath: join(__dirname, 'resources/host-agent/worker.cjs'),
      }),
      tokenStore: new OwnerOnlyHostAgentTokenStore(join(root, 'tokens')),
    })
    const startupBeganAt = performance.now()
    const started = await supervisor.startAll()
    const startupMs = performance.now() - startupBeganAt
    if (started.v1.status !== 'fulfilled' || started.v2.status !== 'fulfilled') {
      const failures = [started.v1, started.v2]
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason instanceof Error ? result.reason.message : 'unknown')
      throw new Error(`Host Agent Utility Process failed readiness (${failures.join(', ')})`)
    }
    const snapshots = supervisor.snapshots()
    if (!snapshots.v1.address || !snapshots.v2.address) throw new Error('Host Agent worker address is missing')
    const v1RpcPort = supervisor.rpcPort('v1')
    if (!v1RpcPort) throw new Error('v1 Compatibility RPC port is missing')
    const v1Adapter = new V1CorePortAdapter({
      sessions: new FakeModuleAgentSessionPort(),
      paths: new NodeModuleAgentPathAuthority(),
      port: v1RpcPort,
    })
    const workspaceRoot = join(root, 'workspace')
    const authorizedWorkingRoot = join(root, 'module-data')
    const grantTokens = join(root, 'grant-tokens')
    await Promise.all([workspaceRoot, authorizedWorkingRoot, grantTokens].map((path) => mkdir(path, { recursive: true })))
    const spec: ModuleAgentGrantSpec = {
      ownerId: 'workspace:smoke', moduleId: 'open-design', launchId: 'launch-smoke', lifecycleId: 'lifecycle-smoke',
      workspaceId: 'workspace-smoke', workspaceRoot, authorizedWorkingRoot,
      defaultWorkingDirectory: authorizedWorkingRoot, expiresAt: Date.now() + 60_000,
    }
    await v1Adapter.registerGrantScope('scope:smoke', spec)
    const prepared = await v1Adapter.invokeWorker('prepareLaunch', { spec, tokenDirectory: grantTokens }) as {
      leaseId: string
      environment: Record<string, string>
    }
    const bearer = (await readFile(prepared.environment.SIMULATOR_HOST_AGENT_TOKEN_FILE!, 'utf8')).trim()
    const authorizedV1 = await fetch(`${prepared.environment.SIMULATOR_HOST_AGENT_URL}/v1/capabilities`, {
      headers: { Authorization: `Bearer ${bearer}` },
    })
    if (authorizedV1.status !== 200) throw new Error(`v1 Compatibility wire failed (${authorizedV1.status})`)

    const [v1, v2] = await Promise.all([
      fetch(`${snapshots.v1.address.url}/v1/capabilities`),
      fetch(`${snapshots.v2.address.url}/v2/capabilities`),
    ])
    if (v1.status < 400 || v1.status >= 500 || v2.status < 400 || v2.status >= 500) {
      throw new Error(`Host Agent loopback authentication is not fail-closed (v1=${v1.status}, v2=${v2.status})`)
    }
    await v1Adapter.invokeWorker('disposeLease', { leaseId: prepared.leaseId })
    v1Adapter.unregisterGrantScope('scope:smoke')
    const stopped = await supervisor.stopAll()
    if (stopped.v1.status !== 'fulfilled' || stopped.v2.status !== 'fulfilled') {
      throw new Error('Host Agent Utility Process failed graceful reap')
    }
    process.stdout.write(`${JSON.stringify({
      startupMs: Number(startupMs.toFixed(2)),
      v1: {
        ready: true,
        rssBytes: snapshots.v1.rssBytes,
        wireStatus: authorizedV1.status,
        unauthorizedStatus: v1.status,
      },
      v2: { ready: true, rssBytes: snapshots.v2.rssBytes, unauthorizedStatus: v2.status },
      reaped: supervisor.snapshots().v1.status === 'stopped' && supervisor.snapshots().v2.status === 'stopped',
    })}\n`)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

void main().then(() => app.exit(0)).catch((error) => {
  process.stderr.write(`Host Agent Utility Process smoke failed: ${error instanceof Error ? error.message : 'unknown error'}\n`)
  app.exit(1)
})
