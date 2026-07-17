import { afterEach, describe, expect, test } from 'bun:test'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { request as httpRequest } from 'node:http'
import { connect, createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net'
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
const ISOLATED_SSE_READY_TIMEOUT_MS = 4_000
const ISOLATED_SSE_CLAIM_TIMEOUT_MS = 8_000

function snapshot(
  state: HostAgentRunSnapshot['state'] = 'running',
  runHandle = RUN,
): HostAgentRunSnapshot {
  const terminal = ['completed', 'failed', 'interrupted', 'closing', 'closed'].includes(state)
  return parseHostAgentRunSnapshot({
    contractVersion: HOST_AGENT_CONTRACT_VERSION,
    runHandle,
    state,
    createdAt: 1,
    updatedAt: state === 'closed' ? 3 : terminal ? 2 : 1,
    ...(terminal ? { terminalAt: 2 } : {}),
    ...(state === 'closed' ? { closedAt: 3 } : {}),
  })
}

function event(
  sequence: number,
  type: HostAgentEvent['type'] = 'message.delta',
  runHandle = RUN,
): HostAgentEvent {
  return parseHostAgentEvent({
    contractVersion: HOST_AGENT_CONTRACT_VERSION,
    eventId: String(sequence),
    sequence,
    runHandle,
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
  getState: HostAgentRunSnapshot['state'] = 'running'
  getRunHandle = RUN
  getGate?: Promise<void>
  subscribeGate?: Promise<void>
  subscribeStarted?: () => void
  subscribeFailuresRemaining = 0
  unsubscribeCalls = 0
  unsubscribeFailuresRemaining = 0
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
    return snapshot(this.getState, this.getRunHandle)
  }

  async subscribeRun(
    _runHandle: string,
    afterSequence: number | undefined,
    listener: (event: HostAgentEvent) => void,
  ): Promise<HostAgentBrokerCoreSubscription> {
    this.subscribeStarted?.()
    await this.subscribeGate
    if (this.subscribeFailuresRemaining > 0) {
      this.subscribeFailuresRemaining -= 1
      throw new HostAgentBrokerCoreClientError('BROKER_DISCONNECTED')
    }
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
      unsubscribe: async () => {
        this.unsubscribeCalls += 1
        this.listeners.delete(listener)
        if (this.unsubscribeFailuresRemaining > 0) {
          this.unsubscribeFailuresRemaining -= 1
          throw new HostAgentBrokerCoreClientError('BROKER_DISCONNECTED')
        }
      },
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
  cancelGate?: Promise<void>
  cancelStarted?: () => void
  closeEntered?: () => void
  closeFailuresRemaining = 0

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
    this.cancelStarted?.()
    await this.cancelGate
    if (this.activeRuns > 0 && this.terminals.length === 0) this.terminals.push('interrupted')
    return snapshot('interrupted')
  }

  override async closeRun(): Promise<HostAgentRunSnapshot> {
    this.closeCalls += 1
    this.closeStarted = true
    this.closeEntered?.()
    await this.closeGate
    if (this.closeFailuresRemaining > 0) {
      this.closeFailuresRemaining -= 1
      throw new HostAgentBrokerCoreClientError('CLEANUP_FAILED')
    }
    this.activeRuns = 0
    this.moduleSessions = 0
    return snapshot('closed')
  }
}

const servers: HostAgentBrokerServer[] = []
const sockets: Socket[] = []
const childClients = new Set<ChildProcessWithoutNullStreams>()
const fixtureServers = new Set<NetServer>()

function childHasExited(child: ChildProcessWithoutNullStreams): boolean {
  return typeof child.exitCode === 'number' || typeof child.signalCode === 'string'
}

function sigkillChild(child: ChildProcessWithoutNullStreams): void {
  if (child.pid === undefined) throw new Error('SSE fixture child has no process id')
  try {
    process.kill(child.pid, 'SIGKILL')
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error
  }
}

async function ensureChildExited(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (childHasExited(child)) return
  let resolveExit!: () => void
  const exited = new Promise<void>((resolve) => { resolveExit = resolve })
  child.once('exit', resolveExit)
  if (childHasExited(child)) {
    child.off('exit', resolveExit)
    return
  }
  sigkillChild(child)
  if (childHasExited(child)) {
    child.off('exit', resolveExit)
    return
  }
  await exited
}

afterEach(async () => {
  const children = [...childClients]
  childClients.clear()
  await Promise.all(children.map(ensureChildExited))
  for (const socket of sockets.splice(0)) socket.destroy()
  await Promise.all([...fixtureServers].map(async (server) => {
    fixtureServers.delete(server)
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }))
  for (const server of servers.splice(0)) await server.stop().catch(() => undefined)
})

async function start(core = new FakeCore(), limits: ConstructorParameters<typeof HostAgentBrokerServer>[0]['limits'] = {}) {
  const server = new HostAgentBrokerServer({ coreClient: core, bearerToken: TOKEN, limits })
  servers.push(server)
  const address = await server.start()
  return { server, core, address }
}

async function waitForCondition(label: string, condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`)
    await Bun.sleep(5)
  }
}

async function waitForPromise<T>(label: string, promise: Promise<T>, timeoutMs = 2_000): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs)
  })
  try {
    return await Promise.race([promise, deadline])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${TOKEN}`, ...extra }
}

async function transitionClaimedOwnerToDisconnectGrace(
  core: OwnershipCore,
  server: HostAgentBrokerServer,
  url: string,
): Promise<void> {
  const unsubscribeTarget = core.unsubscribeCalls + 1
  core.subscribeFailuresRemaining = 1
  const failedReconnect = await fetch(`${url}/v2/runs/${RUN}/events`, {
    headers: headers({ 'Last-Event-ID': '1' }),
  })
  if (failedReconnect.status !== 503) throw new Error('Failed reconnect did not report Broker disconnection')
  const failure = parseHostAgentErrorResponse(await failedReconnect.json())
  if (failure.error.code !== 'BROKER_DISCONNECTED') throw new Error('Failed reconnect returned the wrong error')
  await waitForCondition(
    'disconnected owner grace',
    () => server.debugSnapshot().reconnectGraceRuns === 1,
  )
  await waitForCondition(
    'failed reconnect subscription cleanup',
    () => core.unsubscribeCalls >= unsubscribeTarget,
  )
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

async function startRawSseSocket(url: string): Promise<Socket> {
  const endpoint = new URL(url)
  const socket = connect(Number(endpoint.port), endpoint.hostname)
  sockets.push(socket)
  socket.on('error', () => undefined)
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  socket.write([
    `GET ${endpoint.pathname} HTTP/1.1`,
    `Host: ${endpoint.hostname}:${endpoint.port}`,
    `Authorization: Bearer ${TOKEN}`,
    '',
    '',
  ].join('\r\n'))
  await new Promise<void>((resolve, reject) => {
    let response = ''
    const timeout = setTimeout(() => reject(new Error('Raw SSE fixture timed out')), 2_000)
    const onData = (chunk: Buffer): void => {
      response += chunk.toString('utf8')
      if (!response.includes('HTTP/1.1 200 OK')) return
      clearTimeout(timeout)
      socket.off('data', onData)
      resolve()
    }
    socket.on('data', onData)
    socket.once('close', () => {
      clearTimeout(timeout)
      if (!response.includes('HTTP/1.1 200 OK')) reject(new Error('Raw SSE fixture closed before ready'))
    })
  })
  return socket
}

interface IsolatedSseClient {
  child: ChildProcessWithoutNullStreams
  output(): { stdout: string; stderr: string }
}

const ISOLATED_SSE_CLIENT_SOURCE = String.raw`
import { connect } from 'node:net'
let input = ''
for await (const chunk of process.stdin) input += chunk.toString('utf8')
try {
  const config = JSON.parse(input)
  const url = new URL(config.url)
  const socket = connect(Number(url.port), url.hostname)
  let response = ''
  let ready = false
  const markReady = () => {
    if (ready) return
    ready = true
    process.stdout.write('ready\n')
  }
  const fail = () => {
    if (ready) return
    process.stderr.write('CLIENT_FAILED\n')
    process.exit(1)
  }
  socket.once('error', fail)
  socket.once('close', fail)
  socket.on('data', (chunk) => {
    response += chunk.toString('utf8')
    const markerSeen = !config.marker || response.includes(config.marker)
    if (ready || !response.includes('HTTP/1.1 200 OK') || !markerSeen) return
    markReady()
  })
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  socket.write([
    'GET ' + url.pathname + ' HTTP/1.1',
    'Host: ' + url.hostname + ':' + url.port,
    'Authorization: Bearer ' + config.token,
    '',
    '',
  ].join('\r\n'))
  if (config.readyOnRequest) markReady()
  setInterval(() => {}, 60_000)
} catch {
  process.stderr.write('CLIENT_FAILED\n')
  process.exit(1)
}
`

async function startIsolatedSseClient(
  url: string,
  marker?: string,
  readyOnRequest = false,
  readyTimeoutMs = ISOLATED_SSE_READY_TIMEOUT_MS,
): Promise<IsolatedSseClient> {
  const child = spawn('node', ['--input-type=module', '-e', ISOLATED_SSE_CLIENT_SOURCE], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  childClients.add(child)
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8') })
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
  const ready = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('SSE fixture timed out')),
      readyTimeoutMs,
    )
    const inspect = (): void => {
      if (!stdout.includes('ready\n')) return
      clearTimeout(timeout)
      resolve()
    }
    child.stdout.on('data', inspect)
    child.once('exit', () => {
      clearTimeout(timeout)
      if (!stdout.includes('ready\n')) reject(new Error('SSE fixture exited before ready'))
    })
    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
  })
  child.stdin.end(JSON.stringify({
    url,
    token: TOKEN,
    ...(marker === undefined ? {} : { marker }),
    ...(readyOnRequest ? { readyOnRequest: true } : {}),
  }))
  try {
    await ready
  } catch (error) {
    await ensureChildExited(child)
    childClients.delete(child)
    const detail = `stdout=${JSON.stringify(stdout.slice(0, 256))} stderr=${JSON.stringify(stderr.slice(0, 256))}`
    throw new Error(`SSE fixture failed before ready: ${detail}`, { cause: error })
  }
  return { child, output: () => ({ stdout, stderr }) }
}

async function killIsolatedSseClient(client: IsolatedSseClient): Promise<void> {
  if (childHasExited(client.child)) {
    childClients.delete(client.child)
    return
  }
  await ensureChildExited(client.child)
  childClients.delete(client.child)
}

describe('HostAgentBrokerServer protocol and security boundary', () => {
  test('isolated SSE fixture timeout reaps its child without stalling teardown', async () => {
    const fixtureServer = createNetServer((socket) => sockets.push(socket))
    fixtureServers.add(fixtureServer)
    await new Promise<void>((resolve, reject) => {
      fixtureServer.once('error', reject)
      fixtureServer.listen(0, '127.0.0.1', () => resolve())
    })
    const address = fixtureServer.address()
    if (!address || typeof address === 'string') throw new Error('Fixture server did not bind TCP')
    const initialChildren = childClients.size

    await expect(startIsolatedSseClient(
      `http://127.0.0.1:${address.port}/v2/runs/${RUN}/events`,
      undefined,
      false,
      50,
    )).rejects.toThrow('SSE fixture failed before ready')
    expect(childClients.size).toBe(initialChildren)
  })

  test('starts with the default lease limits, binds only IPv4 loopback, and returns secured capabilities', async () => {
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

  test('rejects a valid event belonging to a different Run before opening SSE', async () => {
    const core = new FakeCore()
    core.events.push(event(1, 'message.delta', 'run_ffffffffffffffffffffffffffffffff'))
    const { address } = await start(core)
    expect((await postRun(address.url, {
      contractVersion: 2,
      prompt: 'cross-run event must fail closed',
    }, 'wrong-run-event')).status).toBe(200)

    const response = await fetch(`${address.url}/v2/runs/${RUN}/events`, { headers: headers() })
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

  test('reconnects a disconnected owner with Last-Event-ID before its grace expires', async () => {
    const core = new OwnershipCore()
    core.events.push(event(1))
    const { address, server } = await start(core, {
      ownershipClaimTimeoutMs: ISOLATED_SSE_CLAIM_TIMEOUT_MS,
      claimedClientDisconnectGraceMs: 1_000,
      claimedClientLeaseTimeoutMs: 5_000,
      heartbeatIntervalMs: 50,
      idleTimeoutMs: 1_000,
    })
    expect((await postRun(address.url, {
      contractVersion: 2,
      prompt: 'reconnect without replaying provider work',
    }, 'claimed-reconnect')).status).toBe(200)

    const first = await startIsolatedSseClient(`${address.url}/v2/runs/${RUN}/events`, 'id: 1\n')
    expect(core.cancelCalls).toBe(0)
    expect(core.activeRuns).toBe(1)
    expect(core.moduleSessions).toBe(1)
    await transitionClaimedOwnerToDisconnectGrace(core, server, address.url)

    core.emit(event(2))
    const secondController = new AbortController()
    const second = await fetch(`${address.url}/v2/runs/${RUN}/events`, {
      headers: headers({ 'Last-Event-ID': '1' }),
      signal: secondController.signal,
    })
    expect(second.status).toBe(200)
    const replay = new TextDecoder().decode((await second.body!.getReader().read()).value)
    expect(replay).toContain('id: 2\n')
    expect(replay).not.toContain('id: 1\n')
    expect(server.debugSnapshot().reconnectGraceRuns).toBe(0)
    await killIsolatedSseClient(first)

    // Cross the old disconnect grace while remaining within the replacement
    // lease. A stale disconnect timer would cancel here.
    await Bun.sleep(1_250)
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
    secondController.abort()
    expect(core.cancelCalls).toBe(1)
    expect(core.closeCalls).toBe(1)
    expect(core.terminals).toEqual(['interrupted'])
    expect(core.activeRuns).toBe(0)
    expect(core.moduleSessions).toBe(0)
  })

  test('SIGKILL-equivalent socket loss expires the owner and reaps its hidden Session', async () => {
    const core = new OwnershipCore()
    const { address, server } = await start(core, {
      ownershipClaimTimeoutMs: ISOLATED_SSE_CLAIM_TIMEOUT_MS,
      claimedClientDisconnectGraceMs: 200,
      claimedClientLeaseTimeoutMs: 500,
      heartbeatIntervalMs: 25,
      idleTimeoutMs: 1_000,
    })
    expect((await postRun(address.url, {
      contractVersion: 2,
      prompt: 'raw process death has no finally cleanup',
    }, 'sigkill-no-finally')).status).toBe(200)

    const rawStream = await startIsolatedSseClient(`${address.url}/v2/runs/${RUN}/events`)
    // Destroying the only transport models SIGKILL/OOM: no cancel or DELETE
    // request and no Shim catch/finally code can run.
    await killIsolatedSseClient(rawStream)
    // Some kernels surface process death as a half-open stream. The missing
    // authenticated status heartbeat must still expire the claimed lease.
    await waitForCondition('SIGKILL Session reap', () => core.moduleSessions === 0)
    expect(core.cancelCalls).toBe(1)
    expect(core.closeCalls).toBe(1)
    expect(core.terminals).toEqual(['interrupted'])
    expect(core.activeRuns).toBe(0)
    expect(core.moduleSessions).toBe(0)
    expect(server.debugSnapshot().unclaimedRuns).toBe(0)
    expect(server.debugSnapshot().reconnectGraceRuns).toBe(0)
    expect(rawStream.output()).toEqual({ stdout: 'ready\n', stderr: '' })
  })

  test('authenticated status heartbeats renew the claimed-client lease without replay', async () => {
    const core = new OwnershipCore()
    const { address } = await start(core, {
      ownershipClaimTimeoutMs: ISOLATED_SSE_CLAIM_TIMEOUT_MS,
      claimedClientDisconnectGraceMs: 200,
      claimedClientLeaseTimeoutMs: 1_000,
      heartbeatIntervalMs: 50,
      idleTimeoutMs: 1_000,
    })
    expect((await postRun(address.url, {
      contractVersion: 2,
      prompt: 'quiet provider turn remains owned',
    }, 'claimed-heartbeat')).status).toBe(200)
    const client = await startIsolatedSseClient(`${address.url}/v2/runs/${RUN}/events`)
    expect(core.cancelCalls).toBe(0)
    expect(core.activeRuns).toBe(1)
    expect(core.moduleSessions).toBe(1)

    // Cross an entire original lease with 10x scheduling margin per renewal.
    for (let heartbeat = 0; heartbeat < 12; heartbeat += 1) {
      await Bun.sleep(100)
      const response = await fetch(`${address.url}/v2/runs/${RUN}`, { headers: headers() })
      expect(response.status).toBe(200)
      expect(parseHostAgentRunSnapshot(await response.json()).runHandle).toBe(RUN)
    }
    expect(core.createCalls).toBe(1)
    expect(core.fileWrites).toBe(1)
    expect(core.cancelCalls).toBe(0)
    expect(core.closeCalls).toBe(0)
    expect(core.activeRuns).toBe(1)
    expect(core.moduleSessions).toBe(1)

    await killIsolatedSseClient(client)
    await waitForCondition('heartbeat owner Session reap', () => core.moduleSessions === 0)
    expect(core.cancelCalls).toBe(1)
    expect(core.closeCalls).toBe(1)
    expect(core.terminals).toEqual(['interrupted'])
    expect(core.activeRuns).toBe(0)
    expect(core.moduleSessions).toBe(0)
    expect(client.output()).toEqual({ stdout: 'ready\n', stderr: '' })
  })

  test('terminal status polling cannot renew a stdout-backpressured Shim lease and the Session is reaped', async () => {
    const core = new OwnershipCore()
    const { address, server } = await start(core, {
      ownershipClaimTimeoutMs: ISOLATED_SSE_CLAIM_TIMEOUT_MS,
      claimedClientDisconnectGraceMs: 200,
      claimedClientLeaseTimeoutMs: 400,
      heartbeatIntervalMs: 50,
      idleTimeoutMs: 1_000,
    })
    expect((await postRun(address.url, {
      contractVersion: 2,
      prompt: 'terminal work must not be retained by blocked stdout',
    }, 'terminal-heartbeat')).status).toBe(200)
    const client = await startIsolatedSseClient(`${address.url}/v2/runs/${RUN}/events`)

    // Model a provider that committed its terminal while the Shim is blocked
    // writing an earlier delta to an unread stdout. Its independent status
    // heartbeat may continue, but terminal GETs cannot extend ownership.
    core.getState = 'completed'
    core.terminals.push('completed')
    for (let heartbeat = 0; heartbeat < 6; heartbeat += 1) {
      await Bun.sleep(100)
      const response = await fetch(`${address.url}/v2/runs/${RUN}`, { headers: headers() })
      expect(response.status).toBe(200)
      expect(parseHostAgentRunSnapshot(await response.json()).state).toBe('completed')
    }
    await waitForCondition('terminal Session reap', () => core.moduleSessions === 0)

    expect(core.cancelCalls).toBe(1)
    expect(core.closeCalls).toBe(1)
    expect(core.terminals).toEqual(['completed'])
    expect(core.activeRuns).toBe(0)
    expect(core.moduleSessions).toBe(0)
    expect(server.debugSnapshot().unclaimedRuns).toBe(0)
    await killIsolatedSseClient(client)
  })

  test('a valid snapshot for the wrong Run cannot renew ownership and is rejected at the core boundary', async () => {
    const core = new OwnershipCore()
    const { address, server } = await start(core, {
      ownershipClaimTimeoutMs: ISOLATED_SSE_CLAIM_TIMEOUT_MS,
      claimedClientDisconnectGraceMs: 200,
      claimedClientLeaseTimeoutMs: 400,
      heartbeatIntervalMs: 50,
      idleTimeoutMs: 1_000,
    })
    expect((await postRun(address.url, {
      contractVersion: 2,
      prompt: 'cross-run status must fail closed',
    }, 'wrong-run-status')).status).toBe(200)
    const client = await startIsolatedSseClient(`${address.url}/v2/runs/${RUN}/events`)
    core.getRunHandle = 'run_ffffffffffffffffffffffffffffffff'

    for (let heartbeat = 0; heartbeat < 6; heartbeat += 1) {
      await Bun.sleep(100)
      const response = await fetch(`${address.url}/v2/runs/${RUN}`, { headers: headers() })
      expect(response.status).toBe(500)
      expect(parseHostAgentErrorResponse(await response.json()).error.code).toBe('INTERNAL_ERROR')
    }
    await waitForCondition('wrong-Run Session reap', () => core.moduleSessions === 0)

    expect(core.cancelCalls).toBe(1)
    expect(core.closeCalls).toBe(1)
    expect(core.activeRuns).toBe(0)
    expect(core.moduleSessions).toBe(0)
    expect(server.debugSnapshot().unclaimedRuns).toBe(0)
    await killIsolatedSseClient(client)
  })

  test('rejects a stale concurrent SSE owner without reflecting grant material', async () => {
    const core = new OwnershipCore()
    const { address, server } = await start(core, { claimedClientDisconnectGraceMs: 50 })
    const key = 'private-idempotency-material'
    expect((await postRun(address.url, {
      contractVersion: 2,
      prompt: 'one active stream owner',
    }, key)).status).toBe(200)
    const controller = new AbortController()
    expect((await fetch(`${address.url}/v2/runs/${RUN}/events`, {
      headers: headers(), signal: controller.signal,
    })).status).toBe(200)

    const stale = await fetch(`${address.url}/v2/runs/${RUN}/events`, { headers: headers() })
    expect(stale.status).toBe(503)
    const body = await stale.text()
    expect(parseHostAgentErrorResponse(JSON.parse(body)).error.code).toBe('RUNTIME_UNAVAILABLE')
    expect(body).not.toContain(TOKEN)
    expect(body).not.toContain(key)
    expect(JSON.stringify(server.debugSnapshot())).not.toContain(TOKEN)
    expect(JSON.stringify(server.debugSnapshot())).not.toContain(key)
    expect(core.cancelCalls).toBe(0)
    expect(core.closeCalls).toBe(0)

    controller.abort()
    expect((await fetch(`${address.url}/v2/runs/${RUN}/cancel`, {
      method: 'POST', headers: headers(),
    })).status).toBe(200)
    expect((await fetch(`${address.url}/v2/runs/${RUN}`, {
      method: 'DELETE', headers: headers(),
    })).status).toBe(200)
  })

  test('explicit DELETE wins a disconnect timer race without duplicate cleanup', async () => {
    let releaseClose!: () => void
    let signalCloseEntered!: () => void
    let closeReleased = false
    const core = new OwnershipCore()
    core.closeGate = new Promise<void>((resolve) => { releaseClose = resolve })
    const closeEntered = new Promise<void>((resolve) => { signalCloseEntered = resolve })
    core.closeEntered = signalCloseEntered
    const releaseCloseOnce = (): void => {
      if (closeReleased) return
      closeReleased = true
      releaseClose()
    }
    const { address, server } = await start(core, {
      ownershipClaimTimeoutMs: ISOLATED_SSE_CLAIM_TIMEOUT_MS,
      claimedClientDisconnectGraceMs: 1_000,
      claimedClientLeaseTimeoutMs: 5_000,
      heartbeatIntervalMs: 50,
      idleTimeoutMs: 1_000,
    })
    let dispose: Promise<Response> | undefined
    let stream: Socket | undefined
    try {
      expect((await postRun(address.url, {
        contractVersion: 2,
        prompt: 'timer versus explicit dispose',
      }, 'delete-timer-race')).status).toBe(200)
      stream = await startRawSseSocket(`${address.url}/v2/runs/${RUN}/events`)
      await transitionClaimedOwnerToDisconnectGrace(core, server, address.url)

      dispose = fetch(`${address.url}/v2/runs/${RUN}`, { method: 'DELETE', headers: headers() })
      await waitForPromise('explicit close entry', closeEntered)
      // Cross the old disconnect deadline while the explicit close owns
      // cleanup. The stale timer must not start a second cancel/close path.
      await Bun.sleep(1_250)
      expect(core.cancelCalls).toBe(0)
      expect(core.closeCalls).toBe(1)
      releaseCloseOnce()
      expect((await dispose).status).toBe(200)
      expect(core.closeCalls).toBe(1)
      expect(core.activeRuns).toBe(0)
      expect(core.moduleSessions).toBe(0)
      expect(server.debugSnapshot().unclaimedRuns).toBe(0)
    } finally {
      releaseCloseOnce()
      await dispose?.catch(() => undefined)
      stream?.destroy()
    }
  })

  test('server stop joins an in-flight explicit DELETE and cannot acknowledge cleanup early', async () => {
    let releaseClose!: () => void
    const core = new OwnershipCore()
    core.closeGate = new Promise<void>((resolve) => { releaseClose = resolve })
    const { address, server } = await start(core, {
      ownershipClaimTimeoutMs: 100,
      claimedClientDisconnectGraceMs: 20,
      claimedClientLeaseTimeoutMs: 45,
      heartbeatIntervalMs: 10,
      idleTimeoutMs: 100,
    })
    expect((await postRun(address.url, {
      contractVersion: 2,
      prompt: 'shutdown must join explicit strict reap',
    }, 'stop-explicit-delete')).status).toBe(200)

    const dispose = fetch(`${address.url}/v2/runs/${RUN}`, {
      method: 'DELETE', headers: headers(),
    }).catch((error: unknown) => error)
    for (let attempt = 0; attempt < 100 && !core.closeStarted; attempt += 1) await Bun.sleep(1)
    expect(core.closeStarted).toBe(true)

    let stopSettled = false
    const stopping = server.stop().finally(() => { stopSettled = true })
    await Bun.sleep(20)
    expect(stopSettled).toBe(false)
    expect(core.cancelCalls).toBe(0)
    expect(core.closeCalls).toBe(1)
    expect(core.moduleSessions).toBe(1)

    releaseClose()
    await stopping
    await dispose
    expect(core.cancelCalls).toBe(0)
    expect(core.closeCalls).toBe(1)
    expect(core.activeRuns).toBe(0)
    expect(core.moduleSessions).toBe(0)
    expect(server.debugSnapshot().unclaimedRuns).toBe(0)
  })

  test('server stop fails closed when its joined explicit DELETE cannot reap', async () => {
    let releaseClose!: () => void
    const core = new OwnershipCore()
    core.closeFailuresRemaining = 1
    core.closeGate = new Promise<void>((resolve) => { releaseClose = resolve })
    const { address, server } = await start(core, {
      ownershipClaimTimeoutMs: 100,
      claimedClientDisconnectGraceMs: 20,
      claimedClientLeaseTimeoutMs: 45,
      heartbeatIntervalMs: 10,
      idleTimeoutMs: 100,
    })
    expect((await postRun(address.url, {
      contractVersion: 2,
      prompt: 'failed shutdown reap remains a blocker',
    }, 'stop-explicit-delete-failure')).status).toBe(200)

    const dispose = fetch(`${address.url}/v2/runs/${RUN}`, {
      method: 'DELETE', headers: headers(),
    }).catch((error: unknown) => error)
    for (let attempt = 0; attempt < 100 && !core.closeStarted; attempt += 1) await Bun.sleep(1)
    expect(core.closeStarted).toBe(true)

    let stopSettled = false
    const stopping = server.stop().then(
      () => ({ error: undefined as unknown }),
      (error: unknown) => ({ error }),
    ).finally(() => { stopSettled = true })
    await Bun.sleep(20)
    expect(stopSettled).toBe(false)
    releaseClose()
    const { error } = await stopping
    await dispose

    expect(error).toBeInstanceOf(HostAgentBrokerCoreClientError)
    expect((error as HostAgentBrokerCoreClientError).code).toBe('CLEANUP_FAILED')
    expect(core.cancelCalls).toBe(0)
    expect(core.closeCalls).toBe(1)
    expect(core.activeRuns).toBe(1)
    expect(core.moduleSessions).toBe(1)
    expect(server.debugSnapshot().unclaimedRuns).toBe(1)
    await expect(server.stop()).rejects.toMatchObject({ code: 'CLEANUP_FAILED' })
    expect(core.closeCalls).toBe(1)
  })

  test('a failed explicit DELETE restores the claimed lease and is later reaped once', async () => {
    const core = new OwnershipCore()
    core.closeFailuresRemaining = 1
    const { address, server } = await start(core, {
      ownershipClaimTimeoutMs: ISOLATED_SSE_CLAIM_TIMEOUT_MS,
      claimedClientDisconnectGraceMs: 200,
      claimedClientLeaseTimeoutMs: 400,
      heartbeatIntervalMs: 50,
      idleTimeoutMs: 1_000,
    })
    expect((await postRun(address.url, {
      contractVersion: 2,
      prompt: 'failed dispose must not clear the owner timer',
    }, 'failed-delete-lease')).status).toBe(200)
    const client = await startIsolatedSseClient(`${address.url}/v2/runs/${RUN}/events`)

    const failedDelete = await fetch(`${address.url}/v2/runs/${RUN}`, {
      method: 'DELETE', headers: headers(),
    })
    expect(failedDelete.status).toBe(500)
    expect(parseHostAgentErrorResponse(await failedDelete.json()).error.code).toBe('CLEANUP_FAILED')
    await waitForCondition('failed DELETE lease reap', () => core.moduleSessions === 0)

    expect(core.cancelCalls).toBe(1)
    expect(core.closeCalls).toBe(2)
    expect(core.terminals).toEqual(['interrupted'])
    expect(core.activeRuns).toBe(0)
    expect(core.moduleSessions).toBe(0)
    expect(server.debugSnapshot().unclaimedRuns).toBe(0)
    await killIsolatedSseClient(client)
  })

  test('server stop joins an in-flight orphan cleanup instead of disposing twice', async () => {
    let cancelStarted!: () => void
    let releaseCancel!: () => void
    const core = new OwnershipCore()
    const started = new Promise<void>((resolve) => { cancelStarted = resolve })
    core.cancelStarted = cancelStarted
    core.cancelGate = new Promise<void>((resolve) => { releaseCancel = resolve })
    const { address, server } = await start(core, {
      ownershipClaimTimeoutMs: ISOLATED_SSE_CLAIM_TIMEOUT_MS,
      claimedClientDisconnectGraceMs: 100,
      claimedClientLeaseTimeoutMs: 1_000,
      heartbeatIntervalMs: 25,
      idleTimeoutMs: 1_000,
    })
    expect((await postRun(address.url, {
      contractVersion: 2,
      prompt: 'stop during orphan cleanup',
    }, 'stop-cleanup-race')).status).toBe(200)
    const stream = await startIsolatedSseClient(`${address.url}/v2/runs/${RUN}/events`)
    await killIsolatedSseClient(stream)
    await started

    const stopping = server.stop()
    await Bun.sleep(10)
    expect(core.cancelCalls).toBe(1)
    expect(core.closeCalls).toBe(0)
    releaseCancel()
    await stopping
    expect(core.cancelCalls).toBe(1)
    expect(core.closeCalls).toBe(1)
    expect(core.terminals).toEqual(['interrupted'])
    expect(core.activeRuns).toBe(0)
    expect(core.moduleSessions).toBe(0)
    expect(server.debugSnapshot().unclaimedRuns).toBe(0)
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

  test('a late subscription with rejected unsubscribe cannot become a Worker unhandled rejection', async () => {
    let releaseSubscribe!: () => void
    let subscribeStarted!: () => void
    const core = new OwnershipCore()
    core.subscribeGate = new Promise<void>((resolve) => { releaseSubscribe = resolve })
    const started = new Promise<void>((resolve) => { subscribeStarted = resolve })
    core.subscribeStarted = subscribeStarted
    core.unsubscribeFailuresRemaining = 1
    const { address, server } = await start(core, {
      ownershipClaimTimeoutMs: ISOLATED_SSE_CLAIM_TIMEOUT_MS,
    })
    expect((await postRun(address.url, {
      contractVersion: 2,
      prompt: 'late MessagePort unsubscribe rejects',
    }, 'late-rejected-unsubscribe')).status).toBe(200)

    const unhandled: unknown[] = []
    const onUnhandled = (error: unknown): void => { unhandled.push(error) }
    process.on('unhandledRejection', onUnhandled)
    try {
      const client = await startIsolatedSseClient(
        `${address.url}/v2/runs/${RUN}/events`,
        undefined,
        true,
      )
      await started
      await killIsolatedSseClient(client)
      await server.stop()

      releaseSubscribe()
      for (let attempt = 0; attempt < 100 && core.unsubscribeCalls === 0; attempt += 1) await Bun.sleep(2)
      await Bun.sleep(20)
      expect(core.unsubscribeCalls).toBe(1)
      expect(unhandled).toEqual([])
      expect(core.cancelCalls).toBe(1)
      expect(core.closeCalls).toBe(1)
      expect(core.activeRuns).toBe(0)
      expect(core.moduleSessions).toBe(0)
      expect(server.debugSnapshot().unclaimedRuns).toBe(0)
    } finally {
      process.off('unhandledRejection', onUnhandled)
      releaseSubscribe()
    }
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
