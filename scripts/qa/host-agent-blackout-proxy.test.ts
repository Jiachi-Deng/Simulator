import { afterEach, describe, expect, it } from 'bun:test'
import { createServer, type Server } from 'node:http'
import {
  HOST_AGENT_BLACKOUT_HEARTBEAT_MS,
  HOST_AGENT_BLACKOUT_MS,
  HostAgentBlackoutProxy,
} from './host-agent-blackout-proxy'

const TOKEN = 'blackout-test-token-0123456789abcdef'
const RUN_HANDLE = 'run_0123456789abcdef0123456789abcdef'
const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.allSettled(cleanup.splice(0).map((operation) => operation()))
})

function event(sequence: number, type: string, data: Record<string, unknown> = {}): string {
  return `id: ${sequence}\nevent: host-agent.event\ndata: ${JSON.stringify({
    contractVersion: 2,
    eventId: String(sequence),
    sequence,
    runHandle: RUN_HANDLE,
    occurredAt: sequence,
    type,
    data,
  })}\n\n`
}

async function upstreamServer(terminal: 'completed' | 'failed' | 'hang' | 'late' = 'completed'): Promise<{ server: Server; url: string }> {
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${TOKEN}`) {
      response.writeHead(401).end()
      return
    }
    if (request.url === '/v2/runs' && request.method === 'POST') {
      const body = await new Response(request as never).text()
      response.setHeader('Content-Type', 'application/json; charset=utf-8')
      response.end(JSON.stringify({ echoed: JSON.parse(body), key: request.headers['idempotency-key'] }))
      return
    }
    if (request.url === `/v2/runs/${RUN_HANDLE}/events`) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
      response.write(': upstream-heartbeat\n\n')
      if (terminal === 'late') await Bun.sleep(40)
      response.write(event(1, 'run.accepted'))
      if (terminal === 'hang') return
      response.write(event(2, 'turn.started'))
      response.write(event(3, 'message.delta', { delta: 'done' }))
      response.write(terminal === 'completed'
        ? event(4, 'turn.completed', { finalText: 'done' })
        : event(4, 'turn.failed', { code: 'INTERNAL_ERROR', retryable: false }))
      response.end(event(5, 'run.closed'))
      return
    }
    response.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('upstream bind failed')
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  return { server, url: `http://127.0.0.1:${address.port}` }
}

async function proxyFor(
  upstream: string,
  options: { blackoutMs?: number; heartbeatMs?: number; armTimeoutMs?: number } = {},
): Promise<HostAgentBlackoutProxy> {
  const proxy = new HostAgentBlackoutProxy({
    upstreamBaseUrl: upstream,
    bearerToken: TOKEN,
    blackoutMs: options.blackoutMs ?? 80,
    heartbeatMs: options.heartbeatMs ?? 10,
    armTimeoutMs: options.armTimeoutMs ?? 100,
    evidenceId: () => 'evidence-D01-1',
  })
  await proxy.start()
  cleanup.push(() => proxy.stop())
  return proxy
}

async function stream(proxy: HostAgentBlackoutProxy): Promise<{ text: string; firstBusinessAt?: number; heartbeatAt?: number }> {
  const startedAt = performance.now()
  const response = await fetch(`${proxy.address!.url}/v2/runs/${RUN_HANDLE}/events`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  })
  expect(response.status).toBe(200)
  const reader = response.body!.getReader()
  let text = ''
  let firstBusinessAt: number | undefined
  let heartbeatAt: number | undefined
  while (true) {
    const result = await reader.read()
    if (result.done) break
    text += new TextDecoder().decode(result.value)
    if (heartbeatAt === undefined && text.includes(': blackout-heartbeat')) heartbeatAt = performance.now() - startedAt
    if (firstBusinessAt === undefined && text.includes('event: host-agent.event')) {
      firstBusinessAt = performance.now() - startedAt
    }
  }
  return { text, firstBusinessAt, heartbeatAt }
}

describe('Host Agent acceptance blackout proxy', () => {
  it('keeps the production constants fixed while allowing only a deterministic timer test seam', () => {
    expect(HOST_AGENT_BLACKOUT_MS).toBe(65_000)
    expect(HOST_AGENT_BLACKOUT_HEARTBEAT_MS).toBe(10_000)
  })

  it('forwards bounded non-SSE requests without exposing the bearer', async () => {
    const upstream = await upstreamServer()
    const proxy = await proxyFor(upstream.url)
    const response = await fetch(`${proxy.address!.url}/v2/runs`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json; charset=utf-8',
        'Idempotency-Key': 'acceptance-case-1',
      },
      body: JSON.stringify({ contractVersion: 2, prompt: 'hello' }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      echoed: { contractVersion: 2, prompt: 'hello' },
      key: 'acceptance-case-1',
    })
  })

  it('is transparent with no arm', async () => {
    const upstream = await upstreamServer()
    const proxy = await proxyFor(upstream.url)
    const observed = await stream(proxy)
    expect(observed.firstBusinessAt).toBeLessThan(70)
    expect(observed.text).toContain(': upstream-heartbeat')
    expect(observed.text).not.toContain(': blackout-heartbeat')
  })

  it('atomically blackouts one armed stream, replays in order, and emits hashed one-shot evidence', async () => {
    const upstream = await upstreamServer()
    const proxy = await proxyFor(upstream.url, { blackoutMs: 80, heartbeatMs: 10 })
    const arm = proxy.armNextBlackout({ caseId: 'D01', stack: 'new', turnOrdinal: 1 })
    const observed = await stream(proxy)
    expect(observed.heartbeatAt).toBeLessThan(40)
    expect(observed.firstBusinessAt).toBeGreaterThanOrEqual(70)
    expect(observed.text.indexOf('"sequence":1')).toBeLessThan(observed.text.indexOf('"sequence":5'))
    expect(observed.text).not.toContain('upstream-heartbeat')

    const evidence = proxy.takeBlackoutEvidence({ evidenceId: arm.evidenceId, caseId: 'D01', turnOrdinal: 1 })
    expect(evidence).toMatchObject({
      schemaVersion: 1,
      producer: 'external-host-agent-sse-proxy',
      evidenceId: arm.evidenceId,
      caseId: 'D01',
      turnOrdinal: 1,
      eventsLost: 0,
      bufferedEventCount: 5,
      replayedEventCount: 5,
      replayComplete: true,
      replaySequenceStart: evidence.eventSequenceAfter + 1,
      terminalEventCount: 1,
    })
    expect(Date.parse(evidence.endedAt) - Date.parse(evidence.startedAt)).toBeGreaterThanOrEqual(80)
    expect(evidence.deliveredFrames[evidence.eventSequenceBefore - 1]?.type).toBe('blackout.started')
    expect(evidence.deliveredFrames[evidence.eventSequenceAfter - 1]?.type).toBe('blackout.ended')
    expect(evidence.deliveredFrames[evidence.replaySequenceStart - 1]?.type).toBe('run.accepted')
    expect(evidence.deliveredFrames.filter((frame) => frame.type === 'turn.completed')).toHaveLength(1)
    expect(evidence.deliveredFrames.every((frame) => /^[0-9a-f]{64}$/.test(frame.payloadSha256))).toBe(true)
    expect(evidence.deliveredFrames.some((frame) => JSON.stringify(frame).includes(RUN_HANDLE))).toBe(false)
    const endedAt = Date.parse(evidence.endedAt)
    expect(evidence.deliveredFrames.filter((frame) => frame.business)
      .every((frame) => Date.parse(frame.at) > endedAt)).toBe(true)
    expect(() => proxy.takeBlackoutEvidence({ evidenceId: arm.evidenceId, caseId: 'D01', turnOrdinal: 1 })).toThrow()
  })

  it('consumes timed-out and duplicate arms without reassigning them', async () => {
    const upstream = await upstreamServer()
    const timed = await proxyFor(upstream.url, { armTimeoutMs: 10 })
    const arm = timed.armNextBlackout({ caseId: 'D01', stack: 'new', turnOrdinal: 1 })
    await Bun.sleep(20)
    expect(() => timed.takeBlackoutEvidence({ evidenceId: arm.evidenceId, caseId: 'D01', turnOrdinal: 1 })).toThrow()
    expect(() => timed.armNextBlackout({ caseId: 'D01', stack: 'new', turnOrdinal: 1 })).toThrow()

    const duplicate = await proxyFor(upstream.url)
    const owned = duplicate.armNextBlackout({ caseId: 'D01', stack: 'new', turnOrdinal: 1 })
    expect(() => duplicate.armNextBlackout({ caseId: 'D01', stack: 'new', turnOrdinal: 1 })).toThrow()
    expect(() => duplicate.takeBlackoutEvidence({
      evidenceId: owned.evidenceId, caseId: 'D01', turnOrdinal: 1,
    })).toThrow()
  })

  it('never reports failed/interrupted streams as successful evidence', async () => {
    const upstream = await upstreamServer('failed')
    const proxy = await proxyFor(upstream.url, { blackoutMs: 20, heartbeatMs: 5 })
    const arm = proxy.armNextBlackout({ caseId: 'D01', stack: 'new', turnOrdinal: 1 })
    await stream(proxy)
    expect(() => proxy.takeBlackoutEvidence({ evidenceId: arm.evidenceId, caseId: 'D01', turnOrdinal: 1 })).toThrow()
  })

  it('fails closed when no upstream business frame was buffered and replayed', async () => {
    const upstream = await upstreamServer('late')
    const proxy = await proxyFor(upstream.url, { blackoutMs: 20, heartbeatMs: 5 })
    const arm = proxy.armNextBlackout({ caseId: 'D01', stack: 'new', turnOrdinal: 1 })
    await stream(proxy).catch(() => undefined)
    expect(() => proxy.takeBlackoutEvidence({
      evidenceId: arm.evidenceId, caseId: 'D01', turnOrdinal: 1,
    })).toThrow()
  })

  it('contains downstream disconnects without an uncaught timer or unhandled blackout rejection', async () => {
    const upstream = await upstreamServer('hang')
    const proxy = await proxyFor(upstream.url, { blackoutMs: 80, heartbeatMs: 10 })
    const arm = proxy.armNextBlackout({ caseId: 'D01', stack: 'new', turnOrdinal: 1 })
    const unhandled: unknown[] = []
    const onUnhandled = (error: unknown): void => { unhandled.push(error) }
    process.on('unhandledRejection', onUnhandled)
    try {
      const response = await fetch(`${proxy.address!.url}/v2/runs/${RUN_HANDLE}/events`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      })
      const reader = response.body!.getReader()
      expect((await reader.read()).done).toBe(false)
      await reader.cancel()
      await Bun.sleep(30)
      expect(unhandled).toEqual([])
      expect(() => proxy.takeBlackoutEvidence({
        evidenceId: arm.evidenceId, caseId: 'D01', turnOrdinal: 1,
      })).toThrow()
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('consumes an armed reconnect carrying Last-Event-ID as the wrong connection', async () => {
    const upstream = await upstreamServer()
    const proxy = await proxyFor(upstream.url)
    const arm = proxy.armNextBlackout({ caseId: 'D01', stack: 'new', turnOrdinal: 1 })
    const response = await fetch(`${proxy.address!.url}/v2/runs/${RUN_HANDLE}/events`, {
      headers: { Authorization: `Bearer ${TOKEN}`, 'Last-Event-ID': '1' },
    })
    expect(response.status).toBe(502)
    expect(() => proxy.takeBlackoutEvidence({
      evidenceId: arm.evidenceId, caseId: 'D01', turnOrdinal: 1,
    })).toThrow()
  })

  it('rejects clients that do not possess the grant bearer', async () => {
    const upstream = await upstreamServer()
    const proxy = await proxyFor(upstream.url)
    const response = await fetch(`${proxy.address!.url}/v2/capabilities`, {
      headers: { Authorization: 'Bearer wrong-token-0123456789' },
    })
    expect(response.status).toBe(502)
    expect(await response.text()).toContain('BLACKOUT_PROXY_FAILED')
  })
})
