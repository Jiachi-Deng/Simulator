import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ModuleAgentGateway } from './gateway.ts'
import { ModuleAgentGatewayServer } from './server.ts'
import { NodeModuleAgentTokenSource } from './node.ts'
import { FakeModuleAgentSessionPort, MemoryModuleAgentPathAuthority } from './testing.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

describe('ModuleAgentGatewayServer', () => {
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
})
