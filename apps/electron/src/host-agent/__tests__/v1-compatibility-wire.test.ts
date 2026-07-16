import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FakeModuleAgentSessionPort,
} from '@simulator/module-agent-gateway/testing'
import { NodeModuleAgentPathAuthority } from '@simulator/module-agent-gateway/node'
import type { ModuleAgentGrantSpec } from '@simulator/module-agent-gateway'
import {
  MessagePortByteCreditChannel,
  type HostAgentMessagePortLike,
} from '@simulator/host-agent-broker/message-port'
import { V1CorePortAdapter } from '../v1-core-port-adapter'
import { startV1CompatibilityWorker } from '../v1-worker-runtime'

type PortEvent = 'message' | 'close' | 'messageerror'
class PairedPort implements HostAgentMessagePortLike {
  peer?: PairedPort
  readonly #listeners = new Map<PortEvent, Set<(message?: unknown) => void>>()
  closed = false
  postMessage(message: unknown): void {
    if (!this.peer || this.closed || this.peer.closed) throw new Error('port closed')
    const peer = this.peer
    queueMicrotask(() => peer.#emit('message', { data: message }))
  }
  on(event: PortEvent, listener: (message?: unknown) => void): this {
    let listeners = this.#listeners.get(event)
    if (!listeners) this.#listeners.set(event, listeners = new Set())
    listeners.add(listener)
    return this
  }
  off(event: PortEvent, listener: (message?: unknown) => void): this {
    this.#listeners.get(event)?.delete(listener)
    return this
  }
  start(): void {}
  close(): void {
    if (this.closed) return
    this.closed = true
    this.#emit('close')
    const peer = this.peer
    if (peer) peer.#emit('close')
  }
  #emit(event: PortEvent, message?: unknown): void {
    for (const listener of this.#listeners.get(event) ?? []) listener(message)
  }
}

function pair(): [PairedPort, PairedPort] {
  const host = new PairedPort()
  const worker = new PairedPort()
  host.peer = worker
  worker.peer = host
  return [host, worker]
}

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('v1 Compatibility Utility wire', () => {
  it('preserves the OpenDesign 0.14.5 HTTP/SSE contract through a remote Host Session port', async () => {
    const root = await mkdtemp(join(tmpdir(), 'simulator-v1-wire-'))
    roots.push(root)
    const workspaceRoot = join(root, 'workspace')
    const authorizedWorkingRoot = join(root, 'module-data', 'open-design')
    const tokenDirectory = join(root, 'tokens')
    await Promise.all([
      mkdir(workspaceRoot, { recursive: true }),
      mkdir(authorizedWorkingRoot, { recursive: true }),
      mkdir(tokenDirectory, { recursive: true }),
    ])

    const spec: ModuleAgentGrantSpec = {
      ownerId: 'workspace:fixture',
      moduleId: 'open-design',
      launchId: 'launch-fixture',
      lifecycleId: 'lifecycle-fixture',
      workspaceId: 'workspace-fixture',
      workspaceRoot,
      authorizedWorkingRoot,
      defaultWorkingDirectory: authorizedWorkingRoot,
      expiresAt: Date.now() + 60_000,
    }
    const [hostPort, workerPort] = pair()
    const sessions = new FakeModuleAgentSessionPort()
    const adapter = new V1CorePortAdapter({
      sessions,
      paths: new NodeModuleAgentPathAuthority(),
      port: hostPort,
    })
    await adapter.registerGrantScope('scope:fixture', spec)
    expect(adapter.debugSnapshot()).toEqual({
      activeGrants: 1,
      activeSessions: 0,
      activeTurns: 0,
      activeSubscribers: 0,
    })
    let workerDisconnected = 0
    const worker = await startV1CompatibilityWorker(workerPort, () => { workerDisconnected += 1 })
    const prepared = await adapter.invokeWorker('prepareLaunch', { spec, tokenDirectory }) as {
      leaseId: string
      environment: Record<string, string>
    }
    expect(worker.address.host).toBe('127.0.0.1')
    expect(prepared.environment.SIMULATOR_HOST_AGENT_URL).toBe(worker.address.url)
    const tokenFile = prepared.environment.SIMULATOR_HOST_AGENT_TOKEN_FILE!
    const token = (await readFile(tokenFile, 'utf8')).trim()
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    const headers = { Authorization: `Bearer ${token}` }

    const capabilities = await fetch(`${worker.address.url}/v1/capabilities`, { headers })
    expect(capabilities.status).toBe(200)
    expect(await capabilities.json()).toMatchObject({ contractVersion: 1, capability: 'host-agent.use' })

    const created = await fetch(`${worker.address.url}/v1/module-sessions`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ contractVersion: 1, workingDirectory: authorizedWorkingRoot }),
    })
    expect(created.status).toBe(201)
    const session = await created.json() as { sessionHandle: string }
    expect(session.sessionHandle).toMatch(/^session_[0-9a-f]{32}$/)
    expect(sessions.created).toHaveLength(1)
    expect(await adapter.invokeWorker('debugSnapshot', {})).toEqual({
      activeGrants: 1,
      activeSessions: 1,
      activeTurns: 0,
      activeSubscribers: 0,
    })
    expect(adapter.debugSnapshot()).toEqual({
      activeGrants: 1,
      activeSessions: 1,
      activeTurns: 0,
      activeSubscribers: 1,
    })

    const turn = await fetch(`${worker.address.url}/v1/module-sessions/${session.sessionHandle}/turns`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ contractVersion: 1, prompt: 'Create the fixture' }),
    })
    expect(turn.status).toBe(202)
    expect(sessions.sent).toEqual([{ sessionId: 'raw-1', prompt: 'Create the fixture' }])
    expect(await adapter.invokeWorker('debugSnapshot', {})).toMatchObject({ activeSessions: 1, activeTurns: 1 })
    expect(adapter.debugSnapshot()).toMatchObject({ activeSessions: 1, activeTurns: 1 })

    const cancelled = await fetch(`${worker.address.url}/v1/module-sessions/${session.sessionHandle}/cancel`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ contractVersion: 1 }),
    })
    expect(cancelled.status).toBe(202)
    expect(sessions.cancelled).toEqual(['raw-1'])
    expect(sessions.awaitedStopped).toEqual([])
    expect(await adapter.invokeWorker('debugSnapshot', {})).toMatchObject({ activeSessions: 1, activeTurns: 0 })

    const events = await fetch(`${worker.address.url}/v1/module-sessions/${session.sessionHandle}/events?afterSequence=0`, { headers })
    expect(events.status).toBe(200)
    const reader = events.body!.getReader()
    const decoder = new TextDecoder()
    let transcript = ''
    for (let read = 0; read < 5 && !transcript.includes('"type":"turn.cancelled"'); read++) {
      const chunk = await reader.read()
      if (chunk.done) break
      transcript += decoder.decode(chunk.value, { stream: true })
    }
    expect(transcript).toContain('event: module-agent.event')
    expect(transcript).toContain('"type":"session.ready"')
    expect(transcript).toContain('"type":"turn.started"')
    expect(transcript).toContain('"type":"turn.cancelled"')
    expect(await adapter.invokeWorker('debugSnapshot', {})).toMatchObject({ activeSubscribers: 1 })
    await reader.cancel()

    const deleted = await fetch(`${worker.address.url}/v1/module-sessions/${session.sessionHandle}`, {
      method: 'DELETE', headers,
    })
    expect(deleted.status).toBe(204)
    expect(sessions.deleted).toEqual(['raw-1'])
    expect(adapter.debugSnapshot()).toMatchObject({ activeSessions: 0, activeTurns: 0, activeSubscribers: 0 })

    await adapter.invokeWorker('disposeLease', { leaseId: prepared.leaseId })
    expect(await adapter.invokeWorker('debugSnapshot', {})).toEqual({
      activeGrants: 0,
      activeSessions: 0,
      activeTurns: 0,
      activeSubscribers: 0,
    })
    adapter.unregisterGrantScope('scope:fixture')
    await worker.stop()
    await adapter.disconnect()
    expect(workerDisconnected).toBe(1)
  })

  it('rejects path and Session operations outside the registered grant', async () => {
    const root = await mkdtemp(join(tmpdir(), 'simulator-v1-deny-'))
    roots.push(root)
    const workspaceRoot = join(root, 'workspace')
    const authorizedWorkingRoot = join(root, 'allowed')
    const outside = join(root, 'outside')
    await Promise.all([workspaceRoot, authorizedWorkingRoot, outside].map((path) => mkdir(path, { recursive: true })))
    const [hostPort, workerPort] = pair()
    const adapter = new V1CorePortAdapter({
      sessions: new FakeModuleAgentSessionPort(),
      paths: new NodeModuleAgentPathAuthority(),
      port: hostPort,
    })
    await adapter.registerGrantScope('scope:fixture', {
      ownerId: 'owner', moduleId: 'open-design', launchId: 'launch', lifecycleId: 'life',
      workspaceId: 'workspace', workspaceRoot, authorizedWorkingRoot,
      defaultWorkingDirectory: authorizedWorkingRoot, expiresAt: Date.now() + 60_000,
    })
    const worker = await startV1CompatibilityWorker(workerPort, () => undefined)
    await expect(adapter.invokeWorker('prepareLaunch', {
      spec: {
        ownerId: 'owner', moduleId: 'open-design', launchId: 'forged', lifecycleId: 'life',
        workspaceId: 'workspace', workspaceRoot, authorizedWorkingRoot: outside,
        defaultWorkingDirectory: outside, expiresAt: Date.now() + 60_000,
      },
      tokenDirectory: join(root, 'tokens'),
    })).rejects.toThrow('request failed')
    await worker.stop()
    await adapter.disconnect()
  })

  it('surfaces strict Session reap failure and retries retained ownership', async () => {
    const root = await mkdtemp(join(tmpdir(), 'simulator-v1-strict-reap-'))
    roots.push(root)
    const workspaceRoot = join(root, 'workspace')
    const authorizedWorkingRoot = join(root, 'allowed')
    await Promise.all([workspaceRoot, authorizedWorkingRoot]
      .map((path) => mkdir(path, { recursive: true })))
    const spec: ModuleAgentGrantSpec = {
      ownerId: 'owner', moduleId: 'open-design', launchId: 'launch', lifecycleId: 'life',
      workspaceId: 'workspace', workspaceRoot, authorizedWorkingRoot,
      defaultWorkingDirectory: authorizedWorkingRoot, expiresAt: Date.now() + 60_000,
    }
    const [hostPort, workerPort] = pair()
    const sessions = new FakeModuleAgentSessionPort()
    const adapter = new V1CorePortAdapter({
      sessions,
      paths: new NodeModuleAgentPathAuthority(),
      port: hostPort,
    })
    await adapter.registerGrantScope('scope:fixture', spec)
    const workerChannel = new MessagePortByteCreditChannel(workerPort)
    const response = new Promise<unknown>((resolve) => workerChannel.onMessage(resolve))
    await workerChannel.send({
      kind: 'module-agent.host.request',
      requestId: 'worker_1',
      method: 'session.create',
      params: {
        input: {
          workspaceId: spec.workspaceId,
          workspaceRoot: await realpath(spec.workspaceRoot),
          authorizedWorkingRoot: await realpath(spec.authorizedWorkingRoot),
          workingDirectory: await realpath(spec.defaultWorkingDirectory),
        },
      },
    }, 'business')
    expect(await response).toMatchObject({
      kind: 'module-agent.host.response',
      requestId: 'worker_1',
      ok: true,
    })
    expect(sessions.created).toHaveLength(1)

    sessions.failDelete = true
    await expect(adapter.disconnect()).rejects.toThrow('delete failed')
    sessions.failDelete = false
    await expect(adapter.disconnect()).resolves.toBeUndefined()
    expect(sessions.deleted).toEqual(['raw-1'])
  })

  it('bounds and coalesces worker stop when strict Session cleanup is wedged', async () => {
    const root = await mkdtemp(join(tmpdir(), 'simulator-v1-bounded-stop-'))
    roots.push(root)
    const workspaceRoot = join(root, 'workspace')
    const authorizedWorkingRoot = join(root, 'allowed')
    const tokenDirectory = join(root, 'tokens')
    await Promise.all([workspaceRoot, authorizedWorkingRoot, tokenDirectory]
      .map((path) => mkdir(path, { recursive: true })))
    const spec: ModuleAgentGrantSpec = {
      ownerId: 'owner', moduleId: 'open-design', launchId: 'launch', lifecycleId: 'life',
      workspaceId: 'workspace', workspaceRoot, authorizedWorkingRoot,
      defaultWorkingDirectory: authorizedWorkingRoot, expiresAt: Date.now() + 60_000,
    }
    const [hostPort, workerPort] = pair()
    const sessions = new FakeModuleAgentSessionPort()
    const originalDisposeAndReap = sessions.disposeAndReap.bind(sessions)
    let releaseReap!: () => void
    const reapBarrier = new Promise<void>((resolve) => { releaseReap = resolve })
    let reapPromise: Promise<void> | undefined
    sessions.disposeAndReap = (sessionId: string) => {
      reapPromise ??= reapBarrier.then(() => originalDisposeAndReap(sessionId))
      return reapPromise
    }
    const adapter = new V1CorePortAdapter({
      sessions,
      paths: new NodeModuleAgentPathAuthority(),
      port: hostPort,
    })
    await adapter.registerGrantScope('scope:fixture', spec)
    const worker = await startV1CompatibilityWorker(workerPort, () => undefined, { stopTimeoutMs: 25 })
    const prepared = await adapter.invokeWorker('prepareLaunch', { spec, tokenDirectory }) as {
      environment: Record<string, string>
    }
    const token = (await readFile(prepared.environment.SIMULATOR_HOST_AGENT_TOKEN_FILE!, 'utf8')).trim()
    const created = await fetch(`${worker.address.url}/v1/module-sessions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ contractVersion: 1, workingDirectory: authorizedWorkingRoot }),
    })
    expect(created.status).toBe(201)

    const startedAt = Date.now()
    const firstStop = worker.stop()
    const coalescedStop = worker.stop()
    expect(coalescedStop).toBe(firstStop)
    await expect(firstStop).rejects.toThrow('cleanup timed out after 25ms')
    expect(Date.now() - startedAt).toBeLessThan(1_000)

    // The worker has handed control back to its process supervisor. Releasing
    // the fake Host reap lets the in-process test fixture finish its abandoned
    // cleanup without creating an unhandled rejection or a second stop loop.
    releaseReap()
    await adapter.disconnect()
    await expect(worker.stop()).rejects.toThrow('cleanup timed out after 25ms')
  })
})
