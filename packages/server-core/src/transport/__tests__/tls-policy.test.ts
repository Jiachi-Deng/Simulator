import { afterEach, describe, expect, it } from 'bun:test'
import { WsRpcClient } from '../client'
import { WsRpcServer } from '../server'

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

  it('redacts literal and encoded tokens from errors and close reasons', () => {
    const token = 'secret token/with?reserved=characters'
    const encodedToken = encodeURIComponent(token)
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
        error: { code: 'AUTH_FAILED', message: `Rejected ${token} / ${encodedToken}` },
      }),
    })
    socket!.onclose?.({
      code: 4005,
      reason: `Closed ${token} / ${encodedToken}`,
      wasClean: true,
    })

    const serializedState = JSON.stringify(client.getConnectionState())
    expect(serializedState).not.toContain(token)
    expect(serializedState).not.toContain(encodedToken)
    expect(client.getConnectionState().lastError?.message).toContain('[REDACTED]')
    expect(client.getConnectionState().lastClose?.reason).toContain('[REDACTED]')
  })

  it('rejects a real self-signed WSS handshake without exposing the token', async () => {
    const tls = generateSelfSignedCert()
    const server = new WsRpcServer({ host: '127.0.0.1', port: 0, tls })
    await server.listen()

    const token = 'real tls token/with?reserved=characters'
    const encodedToken = encodeURIComponent(token)
    const client = new WsRpcClient(
      `wss://127.0.0.1:${server.port}/rpc?token=${encodedToken}#${token}`,
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
    } finally {
      client.destroy()
      server.close()
    }
  })
})

function generateSelfSignedCert(): { cert: string; key: string } {
  const result = Bun.spawnSync({
    cmd: [
      'openssl', 'req', '-x509', '-newkey', 'rsa:2048',
      '-keyout', '/dev/stdout', '-out', '/dev/stdout',
      '-days', '1', '-nodes', '-subj', '/CN=localhost', '-batch',
    ],
    stderr: 'pipe',
  })
  expect(result.exitCode, result.stderr.toString()).toBe(0)

  const pem = result.stdout.toString()
  const cert = pem.match(/(-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----)/)?.[1]
  const key = pem.match(/(-----BEGIN (?:EC )?PRIVATE KEY-----[\s\S]+?-----END (?:EC )?PRIVATE KEY-----)/)?.[1]
  expect(cert).toBeDefined()
  expect(key).toBeDefined()
  return { cert: `${cert!}\n`, key: `${key!}\n` }
}
