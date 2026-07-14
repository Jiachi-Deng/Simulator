import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const host = process.env.SIMULATOR_MODULE_HEALTH_HOST
const port = Number(process.env.SIMULATOR_MODULE_HEALTH_PORT)
const mode = process.env.SIMULATOR_PACKAGED_FAKE_MODE ?? 'healthy'
const startupDelayMs = Number(process.env.SIMULATOR_PACKAGED_FAKE_STARTUP_DELAY_MS ?? '0')

if (host !== '127.0.0.1' || !Number.isSafeInteger(port) || port < 1 || port > 65_535
  || !Number.isSafeInteger(startupDelayMs) || startupDelayMs < 0 || startupDelayMs > 10_000) process.exit(64)

if (startupDelayMs > 0) await Bun.sleep(startupDelayMs)

const moduleRoot = join(dirname(process.execPath), '..')
const hostAgentUrl = process.env.SIMULATOR_HOST_AGENT_URL
const hostAgentTokenFile = process.env.SIMULATOR_HOST_AGENT_TOKEN_FILE

interface HostAgentEvent {
  sequence: number
  type: string
  data: { text?: string }
}

async function hostAgentRequest(pathname: string, token: string, init: RequestInit = {}): Promise<Response> {
  if (!hostAgentUrl) throw new Error('SIMULATOR_HOST_AGENT_URL is missing')
  const response = await fetch(new URL(pathname, hostAgentUrl), {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  })
  if (!response.ok) throw new Error(`Host Agent request ${pathname} failed with ${response.status}`)
  return response
}

async function waitForTerminalEvent(
  sessionHandle: string,
  token: string,
  afterSequence: number,
): Promise<{ sequence: number; text: string }> {
  const controller = new AbortController()
  const response = await hostAgentRequest(
    `/v1/module-sessions/${encodeURIComponent(sessionHandle)}/events?afterSequence=${afterSequence}`,
    token,
    { signal: controller.signal },
  )
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Host Agent event stream has no body')
  const decoder = new TextDecoder()
  let buffer = ''
  let latestSequence = afterSequence
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) throw new Error('Host Agent event stream closed before terminal event')
      buffer += decoder.decode(chunk.value, { stream: true })
      let boundary = buffer.indexOf('\n\n')
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        boundary = buffer.indexOf('\n\n')
        if (!frame.startsWith('event: module-agent.event\n')) continue
        const data = frame.split('\n').find((line) => line.startsWith('data: '))?.slice(6)
        if (!data) continue
        const event = JSON.parse(data) as HostAgentEvent
        if (event.sequence !== latestSequence + 1) {
          throw new Error(`Host Agent event sequence gap: expected ${latestSequence + 1}, received ${event.sequence}`)
        }
        latestSequence = event.sequence
        if (event.type === 'turn.failed' || event.type === 'turn.cancelled') {
          throw new Error(`Host Agent turn ended as ${event.type}`)
        }
        if (event.type === 'turn.completed') {
          return { sequence: latestSequence, text: event.data.text ?? '' }
        }
      }
    }
  } finally {
    controller.abort()
    await reader.cancel().catch(() => undefined)
  }
}

async function runHostAgentSmoke(): Promise<Record<string, unknown>> {
  if (!hostAgentTokenFile) throw new Error('SIMULATOR_HOST_AGENT_TOKEN_FILE is missing')
  const token = (await readFile(hostAgentTokenFile, 'utf8')).trim()
  if (!/^[0-9a-f]{64}$/.test(token)) throw new Error('Host Agent launch token is malformed')
  const capabilities = await (await hostAgentRequest('/v1/capabilities', token)).json() as Record<string, unknown>
  const created = await (await hostAgentRequest('/v1/module-sessions', token, {
    method: 'POST',
    body: JSON.stringify({ contractVersion: 1 }),
  })).json() as { sessionHandle: string }
  let sequence = 0
  const replies: string[] = []
  try {
    for (const prompt of ['OpenDesign host runtime turn one', 'OpenDesign host runtime turn two']) {
      await hostAgentRequest(`/v1/module-sessions/${encodeURIComponent(created.sessionHandle)}/turns`, token, {
        method: 'POST',
        body: JSON.stringify({ contractVersion: 1, prompt }),
      })
      const terminal = await waitForTerminalEvent(created.sessionHandle, token, sequence)
      sequence = terminal.sequence
      replies.push(terminal.text)
    }
  } finally {
    await hostAgentRequest(`/v1/module-sessions/${encodeURIComponent(created.sessionHandle)}`, token, {
      method: 'DELETE',
    }).catch(() => undefined)
  }
  return {
    ok: true,
    capability: capabilities.capability,
    contractVersion: capabilities.contractVersion,
    replies,
    tokenFile: hostAgentTokenFile,
  }
}

const hostAgentSmoke = runHostAgentSmoke().catch((error) => ({
  ok: false,
  error: error instanceof Error ? error.message : String(error),
  tokenFile: hostAgentTokenFile,
}))

const server = Bun.serve({
  hostname: host,
  port,
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === '/health') {
      if (mode === 'readiness-failure') return Response.json({ status: 'unhealthy' }, { status: 503 })
      return Response.json({ status: 'healthy' })
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(Bun.file(join(moduleRoot, 'frontend', 'index.html')), {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    }
    if (url.pathname === '/resource/data.txt') return new Response(Bun.file(join(moduleRoot, 'data.txt')))
    if (url.pathname === '/host-agent-smoke') return Response.json(await hostAgentSmoke)
    if (url.pathname === '/crash') {
      setTimeout(() => process.exit(23), 5)
      return new Response('crashing')
    }
    return new Response('not found', { status: 404 })
  },
})

function stop(): void {
  server.stop(true)
  process.exit(0)
}

process.on('SIGTERM', stop)
process.on('SIGINT', stop)
