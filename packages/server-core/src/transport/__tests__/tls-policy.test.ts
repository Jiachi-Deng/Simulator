import { afterEach, describe, expect, it } from 'bun:test'
import { WsRpcClient } from '../client'

const OriginalWebSocket = globalThis.WebSocket

afterEach(() => {
  globalThis.WebSocket = OriginalWebSocket
})

describe('WsRpcClient connection policy', () => {
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
})
