import { describe, it, expect, afterEach } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { CliRpcClient } from './client.ts'
import {
  serializeEnvelope,
  deserializeEnvelope,
} from '@craft-agent/server-core/transport'
import type { MessageEnvelope } from '@craft-agent/shared/protocol'

// ---------------------------------------------------------------------------
// Mock WS server helpers
// ---------------------------------------------------------------------------

interface MockServer {
  url: string
  port: number
  close: () => void
  lastMessage: () => MessageEnvelope | null
  sendToAll: (envelope: MessageEnvelope) => void
}

function createMockServer(opts?: {
  rejectAuth?: boolean
  noAck?: boolean
  tls?: { cert: string; key: string }
}): MockServer {
  let lastMsg: MessageEnvelope | null = null
  const clients = new Set<any>()

  const server = Bun.serve({
    port: 0,
    tls: opts?.tls,
    fetch(req, server) {
      if (server.upgrade(req)) return undefined
      return new Response('Not found', { status: 404 })
    },
    websocket: {
      message(ws, message) {
        const raw = typeof message === 'string' ? message : new TextDecoder().decode(message)
        const envelope = deserializeEnvelope(raw)
        lastMsg = envelope

        if (envelope.type === 'handshake') {
          if (opts?.rejectAuth) {
            const error: MessageEnvelope = {
              id: envelope.id,
              type: 'error',
              error: { code: 'AUTH_FAILED', message: 'Invalid token' },
            }
            ws.send(serializeEnvelope(error))
            ws.close()
            return
          }

          if (opts?.noAck) return // Simulate timeout

          const ack: MessageEnvelope = {
            id: crypto.randomUUID(),
            type: 'handshake_ack',
            clientId: 'test-client-001',
            protocolVersion: '1.0',
          }
          ws.send(serializeEnvelope(ack))
          return
        }

        if (envelope.type === 'request') {
          // Default: echo args back as result
          const response: MessageEnvelope = {
            id: envelope.id,
            type: 'response',
            channel: envelope.channel,
            result: envelope.args,
          }
          ws.send(serializeEnvelope(response))
        }
      },
      open(ws) {
        clients.add(ws)
      },
      close(ws) {
        clients.delete(ws)
      },
    },
  })

  const protocol = opts?.tls ? 'wss' : 'ws'
  const port = server.port!
  return {
    url: `${protocol}://127.0.0.1:${port}`,
    port,
    close: () => server.stop(true),
    lastMessage: () => lastMsg,
    sendToAll: (envelope: MessageEnvelope) => {
      const data = serializeEnvelope(envelope)
      for (const ws of clients) ws.send(data)
    },
  }
}

function createErrorServer(errorData?: unknown): MockServer {
  let lastMsg: MessageEnvelope | null = null
  const clients = new Set<any>()

  const server = Bun.serve({
    port: 0,
    fetch(req, server) {
      if (server.upgrade(req)) return undefined
      return new Response('Not found', { status: 404 })
    },
    websocket: {
      message(ws, message) {
        const raw = typeof message === 'string' ? message : new TextDecoder().decode(message)
        const envelope = deserializeEnvelope(raw)
        lastMsg = envelope

        if (envelope.type === 'handshake') {
          const ack: MessageEnvelope = {
            id: crypto.randomUUID(),
            type: 'handshake_ack',
            clientId: 'test-client-err',
            protocolVersion: '1.0',
          }
          ws.send(serializeEnvelope(ack))
          return
        }

        if (envelope.type === 'request') {
          // Respond with error
          const response: MessageEnvelope = {
            id: envelope.id,
            type: 'response',
            channel: envelope.channel,
            error: { code: 'HANDLER_ERROR', message: 'test error', data: errorData },
          }
          ws.send(serializeEnvelope(response))
        }
      },
      open(ws) {
        clients.add(ws)
      },
      close(ws) {
        clients.delete(ws)
      },
    },
  })

  const port = server.port!
  return {
    url: `ws://127.0.0.1:${port}`,
    port,
    close: () => server.stop(true),
    lastMessage: () => lastMsg,
    sendToAll: (envelope: MessageEnvelope) => {
      const data = serializeEnvelope(envelope)
      for (const ws of clients) ws.send(data)
    },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let server: MockServer | null = null

afterEach(() => {
  server?.close()
  server = null
})

describe('CliRpcClient', () => {
  it.each([
    'wss://user@example.com:3000/socket',
    'ws://user@localhost:3000/socket',
    'ws://example.com:3000',
    'ws://127.0.0.2:3000',
    'http://localhost:3000',
    'not a URL',
  ])('rejects URLs disallowed by the shared WebSocket policy: %s', async (url) => {
    const client = new CliRpcClient(url)
    await expect(client.connect()).rejects.toMatchObject({
      code: expect.stringMatching(/^(INVALID|INSECURE|WEBSOCKET_URL_USERINFO_NOT_ALLOWED)/),
    })
    client.destroy()
  })

  it('connects and completes handshake', async () => {
    server = createMockServer()
    const client = new CliRpcClient(server.url, { token: 'test-token' })
    const clientId = await client.connect()
    expect(clientId).toBe('test-client-001')
    expect(client.isConnected).toBe(true)
    expect(client.clientId).toBe('test-client-001')
    client.destroy()
  })

  it('sends token in handshake', async () => {
    server = createMockServer()
    const client = new CliRpcClient(server.url, { token: 'my-secret' })
    await client.connect()
    const hs = server.lastMessage()
    expect(hs?.type).toBe('handshake')
    expect(hs?.token).toBe('my-secret')
    client.destroy()
  })

  it('rejects on auth failure', async () => {
    server = createMockServer({ rejectAuth: true })
    const client = new CliRpcClient(server.url, { token: 'bad-token' })
    await expect(client.connect()).rejects.toThrow('Invalid token')
    client.destroy()
  })

  it('rejects on connect timeout', async () => {
    server = createMockServer({ noAck: true })
    const client = new CliRpcClient(server.url, { connectTimeout: 200 })
    await expect(client.connect()).rejects.toThrow('Connection timeout')
    client.destroy()
  })

  it('invoke sends request and receives response', async () => {
    server = createMockServer()
    const client = new CliRpcClient(server.url)
    await client.connect()
    const result = await client.invoke('system:homeDir')
    // Mock server echoes args — no args means empty array
    expect(result).toEqual([])
    client.destroy()
  })

  it('invoke passes args correctly', async () => {
    server = createMockServer()
    const client = new CliRpcClient(server.url)
    await client.connect()
    const result = await client.invoke('sessions:get', 'workspace-1')
    expect(result).toEqual(['workspace-1'])
    client.destroy()
  })

  it('invoke rejects on server error', async () => {
    const secret = 'rpc-secret'
    const mutableData = { token: secret, nested: { value: encodeURIComponent(encodeURIComponent(secret)) } }
    server = createErrorServer(mutableData)
    const client = new CliRpcClient(server.url)
    await client.connect()
    let error: (Error & { code?: string; data?: unknown }) | undefined
    try {
      await client.invoke('system:versions')
    } catch (cause) {
      error = cause as Error & { code?: string; data?: unknown }
    }
    mutableData.nested.value = 'mutated-after-response'
    expect(error).toMatchObject({ message: 'test error', code: 'HANDLER_ERROR' })
    expect(error).not.toHaveProperty('data')
    expect(JSON.stringify(error)).not.toContain(secret)
    expect(JSON.stringify(error)).not.toContain('mutated-after-response')
    client.destroy()
  })

  it('invoke rejects on timeout', async () => {
    server = createMockServer({ noAck: false })
    // Create a server that acks handshake but never responds to requests
    server.close()

    const silentServer = Bun.serve({
      port: 0,
      fetch(req, svr) {
        if (svr.upgrade(req)) return undefined
        return new Response('Not found', { status: 404 })
      },
      websocket: {
        message(ws, message) {
          const raw = typeof message === 'string' ? message : new TextDecoder().decode(message)
          const envelope = deserializeEnvelope(raw)
          if (envelope.type === 'handshake') {
            const ack: MessageEnvelope = {
              id: crypto.randomUUID(),
              type: 'handshake_ack',
              clientId: 'silent-client',
              protocolVersion: '1.0',
            }
            ws.send(serializeEnvelope(ack))
          }
          // Never respond to requests
        },
      },
    })

    const client = new CliRpcClient(`ws://127.0.0.1:${silentServer.port}`, { requestTimeout: 200 })
    await client.connect()
    await expect(client.invoke('system:homeDir')).rejects.toThrow('Request timeout')
    client.destroy()
    silentServer.stop(true)
  })

  it('invoke throws when not connected', async () => {
    const client = new CliRpcClient('ws://127.0.0.1:1')
    await expect(client.invoke('system:homeDir')).rejects.toThrow('Not connected')
    client.destroy()
  })

  it('receives push events via on()', async () => {
    server = createMockServer()
    const client = new CliRpcClient(server.url)
    await client.connect()

    const events: unknown[][] = []
    const unsub = client.on('session:event', (...args) => {
      events.push(args)
    })

    // Push an event from server
    server.sendToAll({
      id: crypto.randomUUID(),
      type: 'event',
      channel: 'session:event',
      args: [{ type: 'text_delta', sessionId: 's1', delta: 'hello' }],
    })

    // Give it a tick
    await new Promise((r) => setTimeout(r, 50))

    expect(events.length).toBe(1)
    expect((events[0][0] as any).delta).toBe('hello')

    // Unsubscribe stops delivery
    unsub()
    server.sendToAll({
      id: crypto.randomUUID(),
      type: 'event',
      channel: 'session:event',
      args: [{ type: 'text_delta', sessionId: 's1', delta: 'world' }],
    })

    await new Promise((r) => setTimeout(r, 50))
    expect(events.length).toBe(1) // Still 1
    client.destroy()
  })

  it('destroy closes connection and rejects pending', async () => {
    server = createMockServer({ noAck: false })
    // Use a server that acks but never responds
    server.close()

    const silentServer = Bun.serve({
      port: 0,
      fetch(req, svr) {
        if (svr.upgrade(req)) return undefined
        return new Response('Not found', { status: 404 })
      },
      websocket: {
        message(ws, message) {
          const raw = typeof message === 'string' ? message : new TextDecoder().decode(message)
          const envelope = deserializeEnvelope(raw)
          if (envelope.type === 'handshake') {
            ws.send(serializeEnvelope({
              id: crypto.randomUUID(),
              type: 'handshake_ack',
              clientId: 'destroy-test',
              protocolVersion: '1.0',
            }))
          }
        },
      },
    })

    const client = new CliRpcClient(`ws://127.0.0.1:${silentServer.port}`, { requestTimeout: 5000 })
    await client.connect()

    const pending = client.invoke('system:homeDir')
    client.destroy()

    await expect(pending).rejects.toThrow('Client destroyed')
    expect(client.isConnected).toBe(false)
    silentServer.stop(true)
  })

  it('throws on invoke after destroy', async () => {
    server = createMockServer()
    const client = new CliRpcClient(server.url)
    await client.connect()
    client.destroy()
    await expect(client.invoke('system:homeDir')).rejects.toThrow('Not connected')
  })

  const tlsIt = hasTlsTooling() ? it : it.skip
  tlsIt('generates a Bun-readable RSA development certificate with every loopback SAN (requires sh + openssl)', () => {
    const tls = generateSelfSignedCert()
    const inspection = Bun.spawnSync({
      cmd: ['openssl', 'x509', '-noout', '-text'],
      stdin: Buffer.from(tls.cert),
      stderr: 'pipe',
    })
    expect(inspection.exitCode, inspection.stderr.toString()).toBe(0)

    const text = inspection.stdout.toString()
    expect(text).toContain('Public Key Algorithm: rsaEncryption')
    expect(text).toContain('DNS:localhost')
    expect(text).toContain('IP Address:127.0.0.1')
    expect(text).toMatch(/IP Address:(?:0:){7}1/)

    expect(() => Bun.serve({
      port: 0,
      tls,
      fetch: () => new Response('ok'),
    }).stop(true)).not.toThrow()
  })

  tlsIt('rejects an untrusted WSS certificate, then connects with the same explicit CA (requires sh + openssl)', async () => {
    const tls = generateSelfSignedCert()
    server = createMockServer({ tls })

    const untrustedClient = new CliRpcClient(server.url, { connectTimeout: 2_000 })
    await expect(untrustedClient.connect()).rejects.toThrow('WebSocket connection error')
    expect(server.lastMessage()).toBeNull()
    untrustedClient.destroy()

    const trustedClient = new CliRpcClient(server.url, { tlsCa: tls.cert, connectTimeout: 2_000 })
    const clientId = await trustedClient.connect()
    expect(clientId).toBe('test-client-001')
    expect(server.lastMessage()?.type).toBe('handshake')
    trustedClient.destroy()
  })
})

// ---------------------------------------------------------------------------
// TLS cert helper — generates a real self-signed cert via openssl
// ---------------------------------------------------------------------------

function generateSelfSignedCert(): { cert: string; key: string } {
  const outputDir = mkdtempSync(resolve(tmpdir(), 'craft-cli-tls-'))
  try {
    const keyResult = Bun.spawnSync({
      cmd: ['sh', resolve(import.meta.dir, '../../../scripts/generate-dev-cert.sh'), outputDir],
      stderr: 'pipe',
    })
    expect(keyResult.exitCode, keyResult.stderr.toString()).toBe(0)
    return {
      cert: readFileSync(resolve(outputDir, 'cert.pem'), 'utf8'),
      key: readFileSync(resolve(outputDir, 'key.pem'), 'utf8'),
    }
  } finally {
    rmSync(outputDir, { recursive: true, force: true })
  }
}

function hasTlsTooling(): boolean {
  return Bun.spawnSync({ cmd: ['openssl', 'version'], stdout: 'ignore', stderr: 'ignore' }).exitCode === 0
    && Bun.spawnSync({ cmd: ['sh', '-c', 'exit 0'], stdout: 'ignore', stderr: 'ignore' }).exitCode === 0
}
