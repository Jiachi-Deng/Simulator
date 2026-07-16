import { afterEach, describe, expect, it } from 'bun:test'
import { createServer, type Server } from 'node:http'
import { HostAgentBlackoutProxy } from './host-agent-blackout-proxy'

const TOKEN = 'blackout-test-token-0123456789abcdef'
const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.allSettled(cleanup.splice(0).map((operation) => operation()))
})

async function upstreamServer(): Promise<{ server: Server; url: string }> {
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
    if (request.url === '/v2/runs/run_0123456789abcdef0123456789abcdef/events') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
      response.write(': upstream-heartbeat\n\n')
      response.write('id: 1\nevent: host-agent.event\ndata: {"sequence":1}\n\n')
      response.end('id: 2\nevent: host-agent.event\ndata: {"sequence":2}\n\n')
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

async function proxyFor(upstream: string, blackoutMs = 80): Promise<HostAgentBlackoutProxy> {
  const proxy = new HostAgentBlackoutProxy({
    upstreamBaseUrl: upstream,
    bearerToken: TOKEN,
    blackoutMs,
    heartbeatMs: 10,
  })
  await proxy.start()
  cleanup.push(() => proxy.stop())
  return proxy
}

describe('Host Agent acceptance blackout proxy', () => {
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

  it('keeps heartbeats flowing while business frames remain silent, then replays in order', async () => {
    const upstream = await upstreamServer()
    const proxy = await proxyFor(upstream.url, 80)
    const startedAt = performance.now()
    const response = await fetch(`${proxy.address!.url}/v2/runs/run_0123456789abcdef0123456789abcdef/events`, {
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
    expect(heartbeatAt).toBeLessThan(40)
    expect(firstBusinessAt).toBeGreaterThanOrEqual(70)
    expect(text.indexOf('{"sequence":1}')).toBeLessThan(text.indexOf('{"sequence":2}'))
    expect(text).not.toContain('upstream-heartbeat')
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
