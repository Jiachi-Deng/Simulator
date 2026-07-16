import { afterEach, describe, expect, test } from 'bun:test'
import { request as httpRequest } from 'node:http'
import { connect, type Socket } from 'node:net'
import {
  HOST_AGENT_CONTRACT_VERSION,
  parseHostAgentErrorResponse,
  parseHostAgentEvent,
  parseHostAgentRunSnapshot,
  type CreateHostAgentRunRequest,
  type HostAgentEvent,
  type HostAgentRunSnapshot,
} from '@simulator/host-agent-contract'
import { HostAgentBrokerCoreClientError } from './errors.ts'
import { HostAgentBrokerServer } from './server.ts'
import type { HostAgentBrokerCoreClient, HostAgentBrokerCoreSubscription } from './types.ts'

const TOKEN = 'test-token-0123456789-abcdefghijkl'
const RUN = 'run_00000000000000000000000000000001'

function snapshot(state: HostAgentRunSnapshot['state'] = 'running'): HostAgentRunSnapshot {
  const terminal = ['completed', 'failed', 'interrupted', 'closing', 'closed'].includes(state)
  return parseHostAgentRunSnapshot({
    contractVersion: HOST_AGENT_CONTRACT_VERSION,
    runHandle: RUN,
    state,
    createdAt: 1,
    updatedAt: state === 'closed' ? 3 : terminal ? 2 : 1,
    ...(terminal ? { terminalAt: 2 } : {}),
    ...(state === 'closed' ? { closedAt: 3 } : {}),
  })
}

function event(sequence: number, type: HostAgentEvent['type'] = 'message.delta'): HostAgentEvent {
  return parseHostAgentEvent({
    contractVersion: HOST_AGENT_CONTRACT_VERSION,
    eventId: String(sequence),
    sequence,
    runHandle: RUN,
    occurredAt: sequence,
    type,
    data: type === 'message.delta' ? { delta: `d${sequence}` } : {},
  })
}

class FakeCore implements HostAgentBrokerCoreClient {
  readonly keyRequests = new Map<string, string>()
  readonly events: HostAgentEvent[] = []
  readonly listeners = new Set<(event: HostAgentEvent) => void>()
  replayFloor = 0
  getGate?: Promise<void>
  subscribeGate?: Promise<void>
  subscribeStarted?: () => void
  closeGate?: Promise<void>
  closeStarted = false

  async createRun(key: string, request: CreateHostAgentRunRequest): Promise<HostAgentRunSnapshot> {
    const digest = JSON.stringify(request)
    const existing = this.keyRequests.get(key)
    if (existing !== undefined && existing !== digest) throw new HostAgentBrokerCoreClientError('IDEMPOTENCY_CONFLICT')
    this.keyRequests.set(key, digest)
    return snapshot('accepted')
  }

  async getRun(): Promise<HostAgentRunSnapshot> {
    await this.getGate
    return snapshot()
  }

  async subscribeRun(
    _runHandle: string,
    afterSequence: number | undefined,
    listener: (event: HostAgentEvent) => void,
  ): Promise<HostAgentBrokerCoreSubscription> {
    this.subscribeStarted?.()
    await this.subscribeGate
    if (afterSequence !== undefined && afterSequence < this.replayFloor) {
      throw new HostAgentBrokerCoreClientError('REPLAY_UNAVAILABLE')
    }
    const replay = this.events.filter((item) => afterSequence === undefined || item.sequence > afterSequence)
    for (const item of replay) listener(item)
    this.listeners.add(listener)
    return {
      replayed: replay.length,
      earliestEventId: this.events[0]?.eventId,
      latestEventId: this.events.at(-1)?.eventId,
      unsubscribe: () => { this.listeners.delete(listener) },
    }
  }

  async cancelRun(): Promise<HostAgentRunSnapshot> { return snapshot('interrupted') }

  async closeRun(): Promise<HostAgentRunSnapshot> {
    this.closeStarted = true
    await this.closeGate
    return snapshot('closed')
  }

  emit(item: HostAgentEvent): void {
    this.events.push(item)
    for (const listener of this.listeners) listener(item)
  }
}

class OwnershipCore extends FakeCore {
  createCalls = 0
  fileWrites = 0
  activeRuns = 0
  moduleSessions = 0
  cancelCalls = 0
  closeCalls = 0
  readonly terminals: string[] = []
  createGate?: Promise<void>
  createStarted?: () => void

  override async createRun(key: string, request: CreateHostAgentRunRequest): Promise<HostAgentRunSnapshot> {
    this.createCalls += 1
    this.createStarted?.()
    await this.createGate
    const digest = JSON.stringify(request)
    const existing = this.keyRequests.get(key)
    if (existing !== undefined && existing !== digest) {
      throw new HostAgentBrokerCoreClientError('IDEMPOTENCY_CONFLICT')
    }
    if (existing === undefined) {
      this.keyRequests.set(key, digest)
      this.fileWrites += 1
      this.activeRuns = 1
      this.moduleSessions = 1
    }
    return snapshot('accepted')
  }

  override async cancelRun(): Promise<HostAgentRunSnapshot> {
    this.cancelCalls += 1
    if (this.activeRuns > 0 && this.terminals.length === 0) this.terminals.push('interrupted')
    return snapshot('interrupted')
  }

  override async closeRun(): Promise<HostAgentRunSnapshot> {
    this.closeCalls += 1
    this.activeRuns = 0
    this.moduleSessions = 0
    return snapshot('closed')
  }
}

const servers: HostAgentBrokerServer[] = []
const sockets: Socket[] = []

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy()
  for (const server of servers.splice(0)) await server.stop()
})

async function start(core = new FakeCore(), limits: ConstructorParameters<typeof HostAgentBrokerServer>[0]['limits'] = {}) {
  const server = new HostAgentBrokerServer({ coreClient: core, bearerToken: TOKEN, limits })
  servers.push(server)
  const address = await server.start()
  return { server, core, address }
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${TOKEN}`, ...extra }
}

async function postRun(url: string, body: unknown, key = 'key-1'): Promise<Response> {
  return fetch(`${url}/v2/runs`, {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json', 'Idempotency-Key': key }),
    body: JSON.stringify(body),
  })
}

async function rawHttp(
  port: number,
  path: string,
  body: Buffer,
  extraHeaders: Record<string, string>,
): Promise<{ status: number; body: Buffer }> {
  return await new Promise((resolve, reject) => {
    const request = httpRequest({
      host: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, ...extraHeaders },
    }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks) }))
    })
    request.on('error', reject)
    request.end(body)
  })
}

describe('HostAgentBrokerServer protocol and security boundary', () => {
  test('binds only random IPv4 loopback and returns secured capabilities', async () => {
    const { address } = await start()
    expect(address.host).toBe('127.0.0.1')
    expect(address.port).toBeGreaterThan(0)
    const response = await fetch(`${address.url}/v2/capabilities`, { headers: headers() })
    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect((await response.json() as { contractVersion: number }).contractVersion).toBe(2)
  })

  test('uses fixed auth errors without reflecting the token', async () => {
    const { address } = await start()
    const response = await fetch(`${address.url}/v2/capabilities`, { headers: { Authorization: 'Bearer wrong-token-value' } })
    expect(response.status).toBe(401)
    const text = await response.text()
    expect(text).not.toContain('wrong-token-value')
    expect(parseHostAgentErrorResponse(JSON.parse(text)).error.code).toBe('UNAUTHORIZED')
  })

  test('rejects hostile Host and browser Origin headers', async () => {
    const { address } = await start()
    const hostAttack = await fetch(`${address.url}/v2/capabilities`, { headers: headers({ Host: 'attacker.example' }) })
    expect(hostAttack.status).toBe(403)
    const originAttack = await fetch(`${address.url}/v2/capabilities`, { headers: headers({ Origin: 'https://attacker.example' }) })
    expect(originAttack.status).toBe(403)
  })

  test('rejects unknown fields and unsupported contract versions', async () => {
    const { address } = await start()
    const unknown = await postRun(address.url, { contractVersion: 2, prompt: 'hi', model: 'forbidden' })
    expect(parseHostAgentErrorResponse(await unknown.json()).error.code).toBe('INVALID_REQUEST')
    const version = await postRun(address.url, { contractVersion: 1, prompt: 'hi' })
    expect(parseHostAgentErrorResponse(await version.json()).error.code).toBe('INVALID_CONTRACT_VERSION')
  })

  test('validates core output before exposing it over HTTP', async () => {
    const core = new FakeCore()
    core.createRun = async () => ({ runHandle: 'invalid' }) as HostAgentRunSnapshot
    const { address } = await start(core)
    const response = await postRun(address.url, { contractVersion: 2, prompt: 'hi' })
    expect(response.status).toBe(500)
    expect(parseHostAgentErrorResponse(await response.json()).error.code).toBe('INTERNAL_ERROR')
  })

  test('rejects malformed UTF-8 and UTF-8 BOM', async () => {
    const { address } = await start()
    const common = { 'Content-Type': 'application/json', 'Idempotency-Key': 'utf8-key' }
    const malformed = await rawHttp(address.port, '/v2/runs', Buffer.from([0xc3, 0x28]), common)
    expect(malformed.status).toBe(400)
    const bom = await rawHttp(address.port, '/v2/runs', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"contractVersion":2,"prompt":"hi"}')]), common)
    expect(bom.status).toBe(400)
  })

  test('enforces the exact request-body limit before parsing', async () => {
    const { address } = await start(new FakeCore(), { maxRequestBodyBytes: 64 })
    const response = await postRun(address.url, { contractVersion: 2, prompt: 'x'.repeat(100) })
    expect(response.status).toBe(413)
    expect(parseHostAgentErrorResponse(await response.json()).error.code).toBe('PAYLOAD_TOO_LARGE')
  })

  test('preserves idempotency and returns 409 for a digest conflict', async () => {
    const { address, core } = await start()
    expect((await postRun(address.url, { contractVersion: 2, prompt: 'first' }, 'same-key')).status).toBe(200)
    expect((await postRun(address.url, { contractVersion: 2, prompt: 'first' }, 'same-key')).status).toBe(200)
    expect(core.keyRequests.size).toBe(1)
    const conflict = await postRun(address.url, { contractVersion: 2, prompt: 'different' }, 'same-key')
    expect(conflict.status).toBe(409)
    expect(parseHostAgentErrorResponse(await conflict.json()).error.code).toBe('IDEMPOTENCY_CONFLICT')
  })

  test('requires JSON UTF-8 and exposes cancel as an empty-body POST', async () => {
    const { address } = await start()
    const wrongType = await fetch(`${address.url}/v2/runs`, {
      method: 'POST',
      headers: headers({ 'Content-Type': 'text/plain', 'Idempotency-Key': 'wrong-type' }),
      body: JSON.stringify({ contractVersion: 2, prompt: 'hi' }),
    })
    expect(wrongType.status).toBe(400)
    const cancelled = await fetch(`${address.url}/v2/runs/${RUN}/cancel`, { method: 'POST', headers: headers() })
    expect(cancelled.status).toBe(200)
    expect(parseHostAgentRunSnapshot(await cancelled.json()).state).toBe('interrupted')
    const bodyRejected = await fetch(`${address.url}/v2/runs/${RUN}/cancel`, {
      method: 'POST', headers: headers({ 'Content-Type': 'application/json' }), body: '{}',
    })
    expect(bodyRejected.status).toBe(400)
  })

  test('streams canonical SSE and replays only events after Last-Event-ID', async () => {
    const core = new FakeCore()
    core.events.push(event(1), event(2), event(3))
    const { address } = await start(core)
    const controller = new AbortController()
    const response = await fetch(`${address.url}/v2/runs/${RUN}/events`, {
      headers: headers({ 'Last-Event-ID': '1' }),
      signal: controller.signal,
    })
    expect(response.status).toBe(200)
    const reader = response.body!.getReader()
    let text = ''
    while (!text.includes('id: 2\n')) {
      const { value, done } = await reader.read()
      if (done) break
      text += new TextDecoder().decode(value)
    }
    expect(text).not.toContain('id: 1\n')
    expect(text).toContain('id: 2\n')
    expect(text).toContain(`event: host-agent.event`)
    controller.abort()
  })

  test('returns REPLAY_UNAVAILABLE before opening SSE headers', async () => {
    const core = new FakeCore()
    core.replayFloor = 5
    const { address } = await start(core)
    const response = await fetch(`${address.url}/v2/runs/${RUN}/events`, { headers: headers({ 'Last-Event-ID': '1' }) })
    expect(response.status).toBe(409)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(parseHostAgentErrorResponse(await response.json()).error.code).toBe('REPLAY_UNAVAILABLE')
  })

  test('emits comment-only heartbeat without inventing an event', async () => {
    const { address } = await start(new FakeCore(), { heartbeatIntervalMs: 20, idleTimeoutMs: 100 })
    const controller = new AbortController()
    const response = await fetch(`${address.url}/v2/runs/${RUN}/events`, { headers: headers(), signal: controller.signal })
    const reader = response.body!.getReader()
    let text = ''
    while (!text.includes(': heartbeat\n\n')) {
      const { value } = await reader.read()
      text += new TextDecoder().decode(value)
    }
    expect(text).not.toContain('event:')
    controller.abort()
  })

  test('closes a live SSE response after run.closed is delivered', async () => {
    const core = new FakeCore()
    const { address } = await start(core)
    const response = await fetch(`${address.url}/v2/runs/${RUN}/events`, { headers: headers() })
    core.emit(event(1, 'run.closed'))
    const text = await response.text()
    expect(text).toContain('event: host-agent.event')
    expect(text).toContain('"type":"run.closed"')
    expect(core.listeners.size).toBe(0)
  })

  test('flushes and closes a replay that already contains run.closed', async () => {
    const core = new FakeCore()
    core.events.push(event(1, 'run.closed'))
    const { address } = await start(core)
    const response = await fetch(`${address.url}/v2/runs/${RUN}/events`, { headers: headers() })
    expect(await response.text()).toContain('"type":"run.closed"')
    expect(core.listeners.size).toBe(0)
  })

  test('caps SSE subscribers at two per grant', async () => {
    const { address } = await start()
    const controllers = [new AbortController(), new AbortController()]
    const open = controllers.map((controller) => fetch(`${address.url}/v2/runs/${RUN}/events`, {
      headers: headers(), signal: controller.signal,
    }))
    expect((await open[0]!).status).toBe(200)
    expect((await open[1]!).status).toBe(200)
    const third = await fetch(`${address.url}/v2/runs/${RUN}/events`, { headers: headers() })
    expect(third.status).toBe(429)
    controllers.forEach((controller) => controller.abort())
  })

  test('caps concurrent HTTP requests at four', async () => {
    let release!: () => void
    const core = new FakeCore()
    core.getGate = new Promise<void>((resolve) => { release = resolve })
    const { address, server } = await start(core)
    const requests = Array.from({ length: 4 }, () => fetch(`${address.url}/v2/runs/${RUN}`, { headers: headers() }))
    while (server.debugSnapshot().activeRequests < 4) await Bun.sleep(2)
    const fifth = await fetch(`${address.url}/v2/runs/${RUN}`, { headers: headers() })
    expect(fifth.status).toBe(429)
    release()
    expect((await Promise.all(requests)).every((response) => response.status === 200)).toBe(true)
  })

  test('caps raw sockets at eight', async () => {
    const { address, server } = await start()
    for (let index = 0; index < 9; index += 1) {
      const socket = connect(address.port, address.host)
      sockets.push(socket)
      await new Promise<void>((resolve) => socket.once('connect', resolve))
    }
    await Bun.sleep(20)
    expect(server.debugSnapshot().sockets).toBeLessThanOrEqual(8)
  })

  test('releases request capacity after a partial body disconnect', async () => {
    const { address, server } = await start(new FakeCore(), { bodyTimeoutMs: 40 })
    const socket = connect(address.port, address.host)
    sockets.push(socket)
    await new Promise<void>((resolve) => socket.once('connect', resolve))
    socket.write([
      'POST /v2/runs HTTP/1.1',
      `Host: 127.0.0.1:${address.port}`,
      `Authorization: Bearer ${TOKEN}`,
      'Content-Type: application/json',
      'Idempotency-Key: partial',
      'Content-Length: 100',
      '',
      '{',
    ].join('\r\n'))
    while (server.debugSnapshot().activeRequests === 0) await Bun.sleep(2)
    socket.end()
    for (let count = 0; count < 50 && server.debugSnapshot().activeRequests > 0; count += 1) await Bun.sleep(2)
    expect(server.debugSnapshot().activeRequests).toBe(0)
  })

  test('abort before Host create leaves no Run, Session, write, or terminal', async () => {
    const core = new OwnershipCore()
    const { address, server } = await start(core, {
      bodyTimeoutMs: 30,
      ownershipClaimTimeoutMs: 30,
    })
    const socket = connect(address.port, address.host)
    sockets.push(socket)
    socket.on('error', () => undefined)
    await new Promise<void>((resolve) => socket.once('connect', resolve))
    socket.write([
      'POST /v2/runs HTTP/1.1',
      `Host: 127.0.0.1:${address.port}`,
      `Authorization: Bearer ${TOKEN}`,
      'Content-Type: application/json',
      'Idempotency-Key: abort-before-create',
      'Content-Length: 100',
      '',
      '{',
    ].join('\r\n'))
    socket.destroy()
    await Bun.sleep(60)

    expect(core.createCalls).toBe(0)
    expect(core.fileWrites).toBe(0)
    expect(core.activeRuns).toBe(0)
    expect(core.moduleSessions).toBe(0)
    expect(core.terminals).toEqual([])
    expect(server.debugSnapshot().unclaimedRuns).toBe(0)
  })

  test('abort after Host create but before response delivery eventually cancels and closes ownership', async () => {
    let releaseCreate!: () => void
    let createStarted!: () => void
    const core = new OwnershipCore()
    core.createGate = new Promise<void>((resolve) => { releaseCreate = resolve })
    const started = new Promise<void>((resolve) => { createStarted = resolve })
    core.createStarted = createStarted
    const { address, server } = await start(core, { ownershipClaimTimeoutMs: 30 })
    const socket = connect(address.port, address.host)
    sockets.push(socket)
    socket.on('error', () => undefined)
    await new Promise<void>((resolve) => socket.once('connect', resolve))
    const body = JSON.stringify({ contractVersion: 2, prompt: 'write one fixture' })
    socket.write([
      'POST /v2/runs HTTP/1.1',
      `Host: 127.0.0.1:${address.port}`,
      `Authorization: Bearer ${TOKEN}`,
      'Content-Type: application/json',
      'Idempotency-Key: abort-after-create',
      `Content-Length: ${Buffer.byteLength(body)}`,
      '',
      body,
    ].join('\r\n'))
    await started
    socket.destroy()
    releaseCreate()

    for (let attempt = 0; attempt < 100 && core.fileWrites === 0; attempt += 1) await Bun.sleep(2)
    for (let attempt = 0; attempt < 100 && core.activeRuns > 0; attempt += 1) await Bun.sleep(5)
    expect(core.createCalls).toBe(1)
    expect(core.fileWrites).toBe(1)
    expect(core.cancelCalls).toBe(1)
    expect(core.closeCalls).toBe(1)
    expect(core.terminals).toEqual(['interrupted'])
    expect(core.activeRuns).toBe(0)
    expect(core.moduleSessions).toBe(0)
    expect(server.debugSnapshot().unclaimedRuns).toBe(0)
  })

  test('lost response recovers the same key once and event-stream handoff prevents mistaken cleanup', async () => {
    let releaseCreate!: () => void
    let createStarted!: () => void
    const core = new OwnershipCore()
    core.createGate = new Promise<void>((resolve) => { releaseCreate = resolve })
    const started = new Promise<void>((resolve) => { createStarted = resolve })
    core.createStarted = createStarted
    const { address, server } = await start(core, { ownershipClaimTimeoutMs: 80 })
    const first = connect(address.port, address.host)
    sockets.push(first)
    first.on('error', () => undefined)
    await new Promise<void>((resolve) => first.once('connect', resolve))
    const requestBody = { contractVersion: 2, prompt: 'single durable write' }
    const body = JSON.stringify(requestBody)
    first.write([
      'POST /v2/runs HTTP/1.1',
      `Host: 127.0.0.1:${address.port}`,
      `Authorization: Bearer ${TOKEN}`,
      'Content-Type: application/json',
      'Idempotency-Key: recover-same-key',
      `Content-Length: ${Buffer.byteLength(body)}`,
      '',
      body,
    ].join('\r\n'))
    await started
    first.destroy()
    releaseCreate()
    while (server.debugSnapshot().unclaimedRuns === 0) await Bun.sleep(2)

    const recovered = await postRun(address.url, requestBody, 'recover-same-key')
    expect(recovered.status).toBe(200)
    expect(parseHostAgentRunSnapshot(await recovered.json()).runHandle).toBe(RUN)

    const streamAbort = new AbortController()
    const stream = await fetch(`${address.url}/v2/runs/${RUN}/events`, {
      headers: headers(),
      signal: streamAbort.signal,
    })
    expect(stream.status).toBe(200)
    expect(server.debugSnapshot().unclaimedRuns).toBe(0)
    streamAbort.abort()
    await Bun.sleep(100)
    expect(core.cancelCalls).toBe(0)
    expect(core.closeCalls).toBe(0)
    expect(core.activeRuns).toBe(1)
    expect(core.moduleSessions).toBe(1)

    expect((await fetch(`${address.url}/v2/runs/${RUN}/cancel`, {
      method: 'POST', headers: headers(),
    })).status).toBe(200)
    expect((await fetch(`${address.url}/v2/runs/${RUN}`, {
      method: 'DELETE', headers: headers(),
    })).status).toBe(200)
    expect(core.createCalls).toBe(2)
    expect(core.keyRequests.size).toBe(1)
    expect(core.fileWrites).toBe(1)
    expect(core.terminals).toEqual(['interrupted'])
    expect(core.activeRuns).toBe(0)
    expect(core.moduleSessions).toBe(0)
  })

  test('client abort during a stalled event-stream claim cannot strand ownership', async () => {
    let releaseSubscribe!: () => void
    let subscribeStarted!: () => void
    const core = new OwnershipCore()
    core.subscribeGate = new Promise<void>((resolve) => { releaseSubscribe = resolve })
    const started = new Promise<void>((resolve) => { subscribeStarted = resolve })
    core.subscribeStarted = subscribeStarted
    const { address, server } = await start(core, { ownershipClaimTimeoutMs: 30 })
    expect((await postRun(address.url, {
      contractVersion: 2,
      prompt: 'bounded event-stream claim',
    }, 'stalled-stream-claim')).status).toBe(200)

    const controller = new AbortController()
    const stream = fetch(`${address.url}/v2/runs/${RUN}/events`, {
      headers: headers(),
      signal: controller.signal,
    }).catch((error: unknown) => error)
    await started
    controller.abort()
    for (let attempt = 0; attempt < 100 && core.activeRuns > 0; attempt += 1) await Bun.sleep(5)
    releaseSubscribe()
    await stream

    expect(core.cancelCalls).toBe(1)
    expect(core.closeCalls).toBe(1)
    expect(core.terminals).toEqual(['interrupted'])
    expect(core.activeRuns).toBe(0)
    expect(core.moduleSessions).toBe(0)
    expect(server.debugSnapshot().unclaimedRuns).toBe(0)
  })

  test('fails a stalled partial body at the body timeout', async () => {
    const { address, server } = await start(new FakeCore(), { bodyTimeoutMs: 25 })
    const socket = connect(address.port, address.host)
    sockets.push(socket)
    await new Promise<void>((resolve) => socket.once('connect', resolve))
    const responseText = new Promise<string>((resolve) => {
      let value = ''
      socket.on('data', (chunk) => {
        value += chunk.toString('utf8')
      })
      socket.once('close', () => resolve(value))
    })
    socket.write([
      'POST /v2/runs HTTP/1.1',
      `Host: 127.0.0.1:${address.port}`,
      `Authorization: Bearer ${TOKEN}`,
      'Content-Type: application/json',
      'Idempotency-Key: stalled',
      'Content-Length: 100',
      '',
      '{',
    ].join('\r\n'))
    const timeoutResult = await responseText
    expect(timeoutResult).not.toContain('HTTP/1.1 2')
    for (let count = 0; count < 50 && server.debugSnapshot().activeRequests > 0; count += 1) await Bun.sleep(2)
    expect(server.debugSnapshot().activeRequests).toBe(0)
  })

  test('DELETE waits for strict core cleanup and is idempotent at the HTTP seam', async () => {
    let release!: () => void
    const core = new FakeCore()
    core.closeGate = new Promise<void>((resolve) => { release = resolve })
    const { address } = await start(core)
    let resolved = false
    const pending = fetch(`${address.url}/v2/runs/${RUN}`, { method: 'DELETE', headers: headers() }).then((value) => {
      resolved = true
      return value
    })
    while (!core.closeStarted) await Bun.sleep(2)
    await Bun.sleep(10)
    expect(resolved).toBe(false)
    release()
    const first = await pending
    expect(first.status).toBe(200)
    expect(parseHostAgentRunSnapshot(await first.json()).state).toBe('closed')
    expect((await fetch(`${address.url}/v2/runs/${RUN}`, { method: 'DELETE', headers: headers() })).status).toBe(200)
  })
})
