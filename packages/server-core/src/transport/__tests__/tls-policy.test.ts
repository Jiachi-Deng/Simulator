import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { WsRpcClient } from '../client'
import { WsRpcServer } from '../server'
import type { MessageEnvelope } from '@craft-agent/shared/protocol'

const OriginalWebSocket = globalThis.WebSocket

afterEach(() => {
  globalThis.WebSocket = OriginalWebSocket
})

describe('WsRpcClient connection policy', () => {
  it.each([
    'wss://user@example.com:3000/socket',
    'wss://user:password@example.com:3000/socket',
    'ws://user@localhost:3000/socket',
  ])('rejects WebSocket URLs containing userinfo: %s', (url) => {
    let socketCreated = false
    globalThis.WebSocket = class {
      constructor() {
        socketCreated = true
      }
    } as unknown as typeof WebSocket

    const client = new WsRpcClient(url, { autoReconnect: false })
    client.connect()

    expect(socketCreated).toBe(false)
    expect(client.getConnectionState()).toMatchObject({
      status: 'failed',
      url: new URL(url).origin.replace(/\/\/.*@/, '//') + '/socket',
      lastError: {
        kind: 'protocol',
        code: 'WEBSOCKET_URL_USERINFO_NOT_ALLOWED',
      },
    })
  })

  it.each([
    'ws://example.com:3000',
    'ws://localhost.example.com:3000',
    'ws://127.0.0.2:3000',
    'http://localhost:3000',
    'not a URL',
  ])('rejects disallowed URL before creating a socket: %s', (url) => {
    let socketCreated = false
    globalThis.WebSocket = class {
      constructor() {
        socketCreated = true
      }
    } as unknown as typeof WebSocket

    const token = 'super-secret-remote-token'
    const client = new WsRpcClient(url, { token, autoReconnect: false })
    client.connect()

    const state = client.getConnectionState()
    expect(socketCreated).toBe(false)
    expect(state.status).toBe('failed')
    expect(state.lastError?.kind).toBe('protocol')
    expect(state.lastError?.code).toMatch(/^(INSECURE|INVALID)_WEBSOCKET_URL$/)
    expect(JSON.stringify(state.lastError)).not.toContain(token)
  })

  it.each([
    'ws://localhost:3000',
    'ws://127.0.0.1:3000',
    'ws://[::1]:3000',
    'wss://localhost:3000',
    'wss://remote.example.com:3000',
  ])('allows loopback ws:// and all wss:// URLs: %s', (url) => {
    const constructorArgs: unknown[][] = []
    globalThis.WebSocket = class {
      static readonly CLOSED = 3
      readonly CLOSED = 3
      readyState = 0
      onopen = null
      onmessage = null
      onclose = null
      onerror = null

      constructor(...args: unknown[]) {
        constructorArgs.push(args)
      }

      close() {
        this.readyState = this.CLOSED
      }
    } as unknown as typeof WebSocket

    const client = new WsRpcClient(url, { autoReconnect: false })
    client.connect()

    expect(constructorArgs).toEqual([[url]])
    expect(client.getConnectionState().status).toBe('connecting')
    client.destroy()
  })

  it('exposes only scheme, host, and path in connection state', () => {
    const token = 'token with / and ? characters'
    const encodedToken = encodeURIComponent(token)
    const url = `wss://ignored:${encodedToken}@remote.example.com:9443/rpc?token=${encodedToken}#${token}`
    const client = new WsRpcClient(url, { token, autoReconnect: false })

    const state = client.getConnectionState()
    expect(state.url).toBe('wss://remote.example.com:9443/rpc')
    expect(JSON.stringify(state)).not.toContain(token)
    expect(JSON.stringify(state)).not.toContain(encodedToken)
  })

  it('redacts literal, encoded, and double-encoded tokens without retaining close reasons', () => {
    const token = 'secret token/with?reserved=characters'
    const encodedToken = encodeURIComponent(token)
    const doubleEncodedToken = encodeURIComponent(encodedToken)
    let socket: {
      onopen: (() => void) | null
      onmessage: ((event: { data: string }) => void) | null
      onclose: ((event: { code: number; reason: string; wasClean: boolean }) => void) | null
    } | null = null

    globalThis.WebSocket = class {
      static readonly CLOSED = 3
      readonly CLOSED = 3
      readyState = 0
      onopen = null
      onmessage = null
      onclose = null
      onerror = null

      constructor() {
        socket = this
      }

      close() {
        this.readyState = this.CLOSED
      }
    } as unknown as typeof WebSocket

    const client = new WsRpcClient('wss://remote.example.com/rpc', { token, autoReconnect: false })
    client.connect()
    socket!.onmessage?.({
      data: JSON.stringify({
        id: 'error',
        type: 'error',
        error: { code: 'AUTH_FAILED', message: `Rejected ${token} / ${encodedToken} / ${doubleEncodedToken}` },
      }),
    })
    socket!.onclose?.({
      code: 4005,
      reason: `Closed ${token} / ${encodedToken} / ${doubleEncodedToken}`,
      wasClean: true,
    })

    const serializedState = JSON.stringify(client.getConnectionState())
    expect(serializedState).not.toContain(token)
    expect(serializedState).not.toContain(encodedToken)
    expect(serializedState).not.toContain(doubleEncodedToken)
    expect(client.getConnectionState().lastError?.message).toContain('[REDACTED]')
    expect(client.getConnectionState().lastClose).toEqual({ code: 4005, wasClean: true })
  })

  it('does not retain mutable RPC error data on rejected errors', async () => {
    const sent: string[] = []
    let socket: {
      onopen: (() => void) | null
      onmessage: ((event: { data: string }) => void) | null
      send: (data: string) => void
    } | null = null

    globalThis.WebSocket = class {
      static readonly OPEN = 1
      readonly OPEN = 1
      readyState = 1
      onopen = null
      onmessage = null
      onclose = null
      onerror = null

      constructor() {
        socket = this
      }

      send(data: string) {
        sent.push(data)
      }

      close() {}
    } as unknown as typeof WebSocket

    const client = new WsRpcClient('wss://remote.example.com/rpc', { autoReconnect: false })
    client.connect()
    socket!.onopen?.()
    socket!.onmessage?.({
      data: JSON.stringify({
        id: 'ack',
        type: 'handshake_ack',
        clientId: 'rpc-data-client',
        protocolVersion: '1.0',
      }),
    })

    const pending = client.invoke('test:error-data')
    await Promise.resolve()
    const request = JSON.parse(sent.at(-1)!) as MessageEnvelope
    const mutableData = { secret: 'rpc-data-secret', nested: { state: 'original' } }
    socket!.onmessage?.({
      data: JSON.stringify({
        id: request.id,
        type: 'response',
        error: { code: 'HANDLER_ERROR', message: 'Request failed', data: mutableData },
      }),
    })

    let error: (Error & { code?: string; data?: unknown }) | undefined
    try {
      await pending
    } catch (cause) {
      error = cause as Error & { code?: string; data?: unknown }
    }
    mutableData.nested.state = 'mutated'

    expect(error).toMatchObject({ message: 'Request failed', code: 'HANDLER_ERROR' })
    expect(error).not.toHaveProperty('data')
    expect(JSON.stringify(error)).not.toContain('rpc-data-secret')
    expect(JSON.stringify(error)).not.toContain('mutated')
    client.destroy()
  })

  const tlsIt = hasTlsTooling() ? it : it.skip
  tlsIt('rejects an untrusted WSS certificate and accepts the same certificate as an explicit CA (requires sh + openssl)', async () => {
    const tls = generateSelfSignedCert()
    const server = new WsRpcServer({ host: '127.0.0.1', port: 0, tls })
    await server.listen()

    const token = 'real tls token/with?reserved=characters'
    const encodedToken = encodeURIComponent(token)
    const client = new WsRpcClient(
      `wss://127.0.0.1:${server.port}/rpc?token=${encodedToken}`,
      { token, autoReconnect: false, connectTimeout: 2_000 },
    )

    try {
      let error: Error | undefined
      try {
        await client.invoke('test:self-signed-tls')
      } catch (cause) {
        error = cause instanceof Error ? cause : new Error(String(cause))
      }

      const state = client.getConnectionState()
      expect(error).toBeDefined()
      expect(state.status).toBe('failed')
      expect(state.url).toBe(`wss://127.0.0.1:${server.port}/rpc`)
      expect(`${error?.message}\n${JSON.stringify(state)}`).not.toContain(token)
      expect(`${error?.message}\n${JSON.stringify(state)}`).not.toContain(encodedToken)

      // Let the failed socket deliver its close event before starting the
      // trusted connection, so no TLS error can escape after test teardown.
      await new Promise((resolveClose) => setTimeout(resolveClose, 50))

      const trustedHandshake = await new Promise<MessageEnvelope>((resolveHandshake, rejectHandshake) => {
        const TrustedWebSocket = WebSocket as unknown as new (
          url: string,
          options: { tls: { ca: string } },
        ) => WebSocket
        const ws = new TrustedWebSocket(
          `wss://127.0.0.1:${server.port}/rpc`,
          { tls: { ca: tls.cert } },
        )
        ws.onerror = (event) => {
          const message = 'message' in event && typeof event.message === 'string'
            ? event.message
            : 'Trusted WSS connection failed'
          rejectHandshake(new Error(message))
        }
        ws.onopen = () => {
          ws.send(JSON.stringify({
            id: 'trusted-handshake',
            type: 'handshake',
            protocolVersion: '1.0',
          }))
        }
        ws.onmessage = (event) => {
          const envelope = JSON.parse(String(event.data)) as MessageEnvelope
          ws.close()
          resolveHandshake(envelope)
        }
      })
      expect(trustedHandshake).toMatchObject({ type: 'handshake_ack' })
    } finally {
      client.destroy()
      server.close()
    }
  })
})

function generateSelfSignedCert(): { cert: string; key: string } {
  const outputDir = mkdtempSync(resolve(tmpdir(), 'craft-tls-'))
  try {
    const result = Bun.spawnSync({
      cmd: ['sh', resolve(import.meta.dir, '../../../../../scripts/generate-dev-cert.sh'), outputDir],
      stderr: 'pipe',
    })
    expect(result.exitCode, result.stderr.toString()).toBe(0)
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
