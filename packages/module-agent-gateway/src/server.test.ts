import { afterEach, describe, expect, it } from 'bun:test'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ModuleAgentGateway } from './gateway.ts'
import { ModuleAgentGatewayServer, writeModuleAgentSseChunk } from './server.ts'
import { NodeModuleAgentTokenSource } from './node.ts'
import { FakeModuleAgentSessionPort, MemoryModuleAgentPathAuthority } from './testing.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

describe('ModuleAgentGatewayServer', () => {
  it('ends a slow SSE subscriber as soon as the socket applies backpressure', () => {
    let ended = 0
    const accepted = writeModuleAgentSseChunk(
      { write: () => false } as never,
      'event: module-agent.event\n\n',
      () => { ended += 1 },
    )
    expect(accepted).toBe(false)
    expect(ended).toBe(1)
  })

  it('creates an owner-only token lease and serves strict loopback v1 routes', async () => {
    const port = new FakeModuleAgentSessionPort()
    const gateway = new ModuleAgentGateway({
      port,
      pathAuthority: new MemoryModuleAgentPathAuthority(),
      tokenSource: new NodeModuleAgentTokenSource(),
    })
    const server = new ModuleAgentGatewayServer(gateway)
    await server.start()
    cleanups.push(() => server.stop())
    const directory = await mkdtemp(join(tmpdir(), 'module-agent-gateway-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    const lease = await server.prepareLaunch({
      ownerId: 'owner',
      moduleId: 'open-design',
      launchId: 'launch',
      lifecycleId: 'life',
      workspaceId: 'workspace',
      workspaceRoot: '/workspace',
      authorizedWorkingRoot: '/projects/one',
      defaultWorkingDirectory: '/projects/one',
      expiresAt: Date.now() + 60_000,
    }, directory)

    expect((await readFile(lease.tokenFile, 'utf8')).trim()).toMatch(/^[0-9a-f]{64}$/)
    expect((await stat(lease.tokenFile)).mode & 0o777).toBe(0o600)
    expect(lease.environment.SIMULATOR_HOST_AGENT_URL).toBe(server.url)
    expect(lease.environment.SIMULATOR_HOST_AGENT_TOKEN_FILE).toBe(lease.tokenFile)
    const headers = { Authorization: `Bearer ${lease.grantToken}`, 'Content-Type': 'application/json' }
    const capabilities = await fetch(`${server.url}/v1/capabilities`, { headers: { Authorization: headers.Authorization } })
    expect(capabilities.status).toBe(200)
    expect(await capabilities.json()).toMatchObject({ contractVersion: 1, capability: 'host-agent.use' })

    const createdResponse = await fetch(`${server.url}/v1/module-sessions`, {
      method: 'POST', headers, body: JSON.stringify({ contractVersion: 1 }),
    })
    expect(createdResponse.status).toBe(201)
    const created = await createdResponse.json() as { sessionHandle: string }
    const streamAbort = new AbortController()
    const stream = await fetch(`${server.url}/v1/module-sessions/${created.sessionHandle}/events?afterSequence=0`, {
      headers: { Authorization: headers.Authorization },
      signal: streamAbort.signal,
    })
    expect(stream.status).toBe(200)
    const firstFrame = new TextDecoder().decode((await stream.body!.getReader().read()).value)
    expect(firstFrame).toContain('event: module-agent.event\n')
    expect(firstFrame).toMatch(/id: [0-9]+\n/)
    expect(firstFrame).toContain('"contractVersion":1')
    expect(firstFrame).toContain('"type":"session.ready"')
    expect(firstFrame).not.toContain('raw-1')
    streamAbort.abort()
    const invalidEvents = await fetch(`${server.url}/v1/module-sessions/session_00000000000000000000000000000000/events?extra=1`, {
      headers: { Authorization: headers.Authorization },
    })
    expect(invalidEvents.status).toBe(400)
    const unknownEvents = await fetch(`${server.url}/v1/module-sessions/session_00000000000000000000000000000000/events`, {
      headers: { Authorization: headers.Authorization },
    })
    expect(unknownEvents.status).toBe(404)

    const turn = await fetch(`${server.url}/v1/module-sessions/${created.sessionHandle}/turns`, {
      method: 'POST', headers, body: JSON.stringify({ contractVersion: 1, prompt: 'Create' }),
    })
    expect(turn.status).toBe(202)
    const cancelled = await fetch(`${server.url}/v1/module-sessions/${created.sessionHandle}/cancel`, {
      method: 'POST', headers, body: JSON.stringify({ contractVersion: 1 }),
    })
    expect(cancelled.status).toBe(202)
    const closed = await fetch(`${server.url}/v1/module-sessions/${created.sessionHandle}`, {
      method: 'DELETE', headers: { Authorization: headers.Authorization },
    })
    expect(closed.status).toBe(204)
    await lease.dispose()
    await expect(readFile(lease.tokenFile)).rejects.toBeTruthy()
    expect(gateway.debugSnapshot()).toEqual({ activeGrants: 0, activeSessions: 0, activeTurns: 0, activeSubscribers: 0 })
  })

  it('closes a session created after its HTTP client disconnects', async () => {
    // Bun fetch abort cancels only the caller promise and can keep its pooled
    // TCP connection alive. Exercise the Electron/Node production transport
    // in a child process that destroys a real node:http socket instead.
    const gatewayUrl = new URL('./gateway.ts', import.meta.url).href
    const serverUrl = new URL('./server.ts', import.meta.url).href
    const nodeUrl = new URL('./node.ts', import.meta.url).href
    const testingUrl = new URL('./testing.ts', import.meta.url).href
    const script = `
      import http from 'node:http';
      import { mkdtemp, rm } from 'node:fs/promises';
      import { tmpdir } from 'node:os';
      import { join } from 'node:path';
      import { ModuleAgentGateway } from ${JSON.stringify(gatewayUrl)};
      import { ModuleAgentGatewayServer } from ${JSON.stringify(serverUrl)};
      import { NodeModuleAgentTokenSource } from ${JSON.stringify(nodeUrl)};
      import { FakeModuleAgentSessionPort, MemoryModuleAgentPathAuthority } from ${JSON.stringify(testingUrl)};
      let releaseCreate; let markCreateStarted;
      const gate = new Promise((resolve) => { releaseCreate = resolve; });
      const started = new Promise((resolve) => { markCreateStarted = resolve; });
      class GatedPort extends FakeModuleAgentSessionPort {
        async createSession(input) { markCreateStarted(); await gate; return super.createSession(input); }
      }
      const port = new GatedPort();
      const gateway = new ModuleAgentGateway({ port, pathAuthority: new MemoryModuleAgentPathAuthority(), tokenSource: new NodeModuleAgentTokenSource() });
      const server = new ModuleAgentGatewayServer(gateway);
      const directory = await mkdtemp(join(tmpdir(), 'module-agent-node-disconnect-'));
      try {
        await server.start();
        const lease = await server.prepareLaunch({ ownerId: 'owner', moduleId: 'open-design', launchId: 'launch', lifecycleId: 'life', workspaceId: 'workspace', workspaceRoot: '/workspace', authorizedWorkingRoot: '/projects', defaultWorkingDirectory: '/projects/one', expiresAt: Date.now() + 60_000 }, directory);
        const body = JSON.stringify({ contractVersion: 1, workingDirectory: '/projects/one' });
        const request = http.request(new URL('/v1/module-sessions', server.url), { method: 'POST', agent: false, headers: { authorization: 'Bearer ' + lease.grantToken, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } });
        request.on('error', () => undefined);
        request.end(body);
        await started;
        if (!request.socket) throw new Error('node:http did not assign a transport socket');
        const closed = new Promise((resolve) => request.socket.once('close', resolve));
        request.socket.destroy();
        await closed;
        // The client-side close is local; allow the peer TCP close to reach
        // the server before releasing the gated Host create operation.
        await new Promise((resolve) => setTimeout(resolve, 20));
        releaseCreate();
        for (let attempt = 0; attempt < 200 && port.deleted.length === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
        const snapshot = gateway.debugSnapshot();
        if (JSON.stringify(port.deleted) !== JSON.stringify(['raw-1']) || snapshot.activeSessions !== 0 || snapshot.activeGrants !== 1) throw new Error(JSON.stringify({ deleted: port.deleted, snapshot }));
        gateway.getCapabilities(lease.authorization);
        await lease.dispose();
        console.log(JSON.stringify({ deleted: port.deleted, snapshot }));
      } finally {
        await server.stop().catch(() => undefined);
        await rm(directory, { recursive: true, force: true });
      }
    `
    const child = spawn('node', ['--no-warnings=ExperimentalWarning', '--experimental-transform-types', '--input-type=module', '--eval', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
    const exitCode = await new Promise<number | null>((resolve) => child.once('close', resolve))
    expect(exitCode, stderr).toBe(0)
    expect(JSON.parse(stdout.trim())).toMatchObject({
      deleted: ['raw-1'],
      snapshot: { activeGrants: 1, activeSessions: 0 },
    })
  })
})
