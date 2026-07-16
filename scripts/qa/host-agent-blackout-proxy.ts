import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import {
  HOST_AGENT_HEADERS,
  HOST_AGENT_LIMITS,
  parseHostAgentRoute,
} from '@simulator/host-agent-contract'

const LOOPBACK_HOST = '127.0.0.1' as const
const MAX_RESPONSE_BYTES = HOST_AGENT_LIMITS.maxReplayBytes + HOST_AGENT_LIMITS.maxEventBytes

export interface HostAgentBlackoutProxyOptions {
  readonly upstreamBaseUrl: string
  readonly bearerToken: string
  readonly blackoutMs?: number
  readonly heartbeatMs?: number
  readonly fetch?: typeof globalThis.fetch
}

export interface HostAgentBlackoutProxyAddress {
  readonly host: typeof LOOPBACK_HOST
  readonly port: number
  readonly url: string
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

function singleRawHeader(request: IncomingMessage, name: string): string | undefined {
  const values: string[] = []
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === name.toLowerCase()) {
      values.push(request.rawHeaders[index + 1] ?? '')
    }
  }
  if (values.length > 1) throw new TypeError('Repeated header')
  return values[0]
}

async function readBoundedBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const raw of request) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
    bytes += chunk.byteLength
    if (bytes > HOST_AGENT_LIMITS.maxRequestBodyBytes) throw new TypeError('Request body is too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, bytes)
}

async function readBoundedResponse(response: Response): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0)
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const raw of response.body) {
    const chunk = Buffer.from(raw)
    bytes += chunk.byteLength
    if (bytes > MAX_RESPONSE_BYTES) throw new TypeError('Upstream response is too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, bytes)
}

function copyResponseHeaders(upstream: Response, response: ServerResponse): void {
  for (const name of ['content-type', 'cache-control', 'x-content-type-options']) {
    const value = upstream.headers.get(name)
    if (value) response.setHeader(name, value)
  }
}

function wait(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    const timer = setTimeout(done, delayMs)
    const aborted = (): void => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    function done(): void {
      signal.removeEventListener('abort', aborted)
      resolve()
    }
    signal.addEventListener('abort', aborted, { once: true })
  })
}

/**
 * Acceptance-only loopback proxy. It is deliberately kept under scripts/qa and
 * is never referenced by the Electron build or OpenDesign package closure.
 */
export class HostAgentBlackoutProxy {
  readonly #options: Required<Pick<HostAgentBlackoutProxyOptions, 'blackoutMs' | 'heartbeatMs'>>
    & Omit<HostAgentBlackoutProxyOptions, 'blackoutMs' | 'heartbeatMs'>
  readonly #tokenDigest: Buffer
  readonly #upstream: URL
  readonly #sockets = new Set<Socket>()
  #server?: Server
  #address?: HostAgentBlackoutProxyAddress

  constructor(options: HostAgentBlackoutProxyOptions) {
    const upstream = new URL(options.upstreamBaseUrl)
    if (upstream.protocol !== 'http:' || upstream.hostname !== LOOPBACK_HOST || !upstream.port
      || upstream.pathname !== '/' || upstream.search || upstream.hash || upstream.username || upstream.password) {
      throw new TypeError('Blackout proxy upstream must be an exact loopback HTTP origin')
    }
    if (Buffer.byteLength(options.bearerToken, 'utf8') < 16
      || Buffer.byteLength(options.bearerToken, 'utf8') > 512
      || /[\u0000-\u0020\u007f]/u.test(options.bearerToken)) {
      throw new TypeError('Blackout proxy bearer token is invalid')
    }
    const blackoutMs = options.blackoutMs ?? 65_000
    const heartbeatMs = options.heartbeatMs ?? 10_000
    if (!Number.isSafeInteger(blackoutMs) || blackoutMs < 1
      || !Number.isSafeInteger(heartbeatMs) || heartbeatMs < 1 || heartbeatMs >= blackoutMs) {
      throw new TypeError('Blackout proxy timing is invalid')
    }
    this.#options = { ...options, blackoutMs, heartbeatMs }
    this.#tokenDigest = digest(options.bearerToken)
    this.#upstream = upstream
  }

  get address(): HostAgentBlackoutProxyAddress | undefined { return this.#address }

  async start(): Promise<HostAgentBlackoutProxyAddress> {
    if (this.#server) throw new TypeError('Blackout proxy is already running')
    const server = createServer((request, response) => void this.#handle(request, response))
    this.#server = server
    server.on('connection', (socket) => {
      this.#sockets.add(socket)
      socket.once('close', () => this.#sockets.delete(socket))
    })
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error)
      server.once('error', onError)
      server.listen(0, LOOPBACK_HOST, () => {
        server.off('error', onError)
        resolve()
      })
    })
    const bound = server.address()
    if (!bound || typeof bound === 'string' || bound.address !== LOOPBACK_HOST) {
      await this.stop()
      throw new Error('Blackout proxy failed to bind loopback')
    }
    this.#address = { host: LOOPBACK_HOST, port: bound.port, url: `http://${LOOPBACK_HOST}:${bound.port}` }
    return this.#address
  }

  async stop(): Promise<void> {
    const server = this.#server
    this.#server = undefined
    this.#address = undefined
    for (const socket of this.#sockets) socket.destroy()
    this.#sockets.clear()
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const abort = new AbortController()
    const disconnected = (): void => abort.abort(new Error('Blackout proxy client disconnected'))
    request.once('aborted', disconnected)
    response.once('close', disconnected)
    try {
      this.#authorize(request)
      const route = parseHostAgentRoute(request.method, request.url)
      if (route.route === 'runs.events') {
        await this.#stream(request, response, abort.signal)
      } else {
        await this.#forward(request, response, abort.signal)
      }
    } catch {
      if (!response.headersSent && !response.destroyed) {
        response.writeHead(502, {
          'Cache-Control': 'no-store',
          'Content-Type': 'application/json; charset=utf-8',
          'X-Content-Type-Options': 'nosniff',
        })
        response.end('{"error":{"code":"BLACKOUT_PROXY_FAILED"}}')
      } else if (!response.writableEnded) {
        response.destroy()
      }
    } finally {
      request.off('aborted', disconnected)
      response.off('close', disconnected)
    }
  }

  #authorize(request: IncomingMessage): void {
    const remote = request.socket.remoteAddress
    if (remote !== LOOPBACK_HOST && remote !== `::ffff:${LOOPBACK_HOST}`) throw new TypeError('Non-loopback client')
    if (singleRawHeader(request, 'origin') !== undefined) throw new TypeError('Origin is forbidden')
    const address = this.#address
    if (!address || singleRawHeader(request, 'host') !== `${LOOPBACK_HOST}:${address.port}`) {
      throw new TypeError('Invalid Host header')
    }
    const authorization = singleRawHeader(request, 'authorization')
    const match = /^Bearer ([\x21-\x7e]{1,512})$/i.exec(authorization ?? '')
    const candidate = digest(match?.[1] ?? 'invalid')
    if (!match || !timingSafeEqual(candidate, this.#tokenDigest)) throw new TypeError('Unauthorized')
  }

  #upstreamHeaders(request: IncomingMessage): Headers {
    const headers = new Headers({ Authorization: `Bearer ${this.#options.bearerToken}` })
    for (const name of ['content-type', HOST_AGENT_HEADERS.idempotencyKey, HOST_AGENT_HEADERS.lastEventId]) {
      const value = singleRawHeader(request, name)
      if (value !== undefined) headers.set(name, value)
    }
    return headers
  }

  async #forward(request: IncomingMessage, response: ServerResponse, signal: AbortSignal): Promise<void> {
    const body = request.method === 'POST' ? await readBoundedBody(request) : undefined
    const upstream = await (this.#options.fetch ?? globalThis.fetch)(new URL(request.url ?? '/', this.#upstream), {
      method: request.method,
      headers: this.#upstreamHeaders(request),
      ...(body ? { body } : {}),
      signal,
    })
    const bytes = await readBoundedResponse(upstream)
    copyResponseHeaders(upstream, response)
    response.statusCode = upstream.status
    response.setHeader('Content-Length', String(bytes.byteLength))
    response.end(bytes)
  }

  async #stream(request: IncomingMessage, response: ServerResponse, signal: AbortSignal): Promise<void> {
    const upstream = await (this.#options.fetch ?? globalThis.fetch)(new URL(request.url ?? '/', this.#upstream), {
      method: 'GET',
      headers: this.#upstreamHeaders(request),
      signal,
    })
    if (!upstream.ok || !upstream.body) {
      const bytes = await readBoundedResponse(upstream)
      copyResponseHeaders(upstream, response)
      response.statusCode = upstream.status
      response.end(bytes)
      return
    }

    response.writeHead(200, {
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream; charset=utf-8',
      'X-Accel-Buffering': 'no',
    })
    response.write(': blackout-heartbeat\n\n')
    const heartbeat = setInterval(() => {
      if (!response.destroyed && !response.writableEnded) response.write(': blackout-heartbeat\n\n')
    }, this.#options.heartbeatMs)
    heartbeat.unref?.()

    let blackoutComplete = false
    let bufferedBytes = 0
    const bufferedFrames: Buffer[] = []
    const blackout = wait(this.#options.blackoutMs, signal).then(() => {
      blackoutComplete = true
      for (const frame of bufferedFrames.splice(0)) response.write(frame)
      bufferedBytes = 0
    })
    let pending = Buffer.alloc(0)
    try {
      for await (const raw of upstream.body) {
        pending = Buffer.concat([pending, Buffer.from(raw)])
        if (pending.byteLength > HOST_AGENT_LIMITS.maxReplayBytes + HOST_AGENT_LIMITS.maxEventBytes) {
          throw new TypeError('Blackout replay buffer exceeded')
        }
        while (true) {
          const boundary = pending.indexOf('\n\n')
          if (boundary < 0) break
          const frame = pending.subarray(0, boundary + 2)
          pending = pending.subarray(boundary + 2)
          if (frame.subarray(0, 1).equals(Buffer.from(':'))) continue
          if (blackoutComplete) response.write(frame)
          else {
            bufferedBytes += frame.byteLength
            if (bufferedBytes > HOST_AGENT_LIMITS.maxReplayBytes) throw new TypeError('Blackout replay buffer exceeded')
            bufferedFrames.push(Buffer.from(frame))
          }
        }
      }
      if (pending.byteLength !== 0) throw new TypeError('Truncated upstream SSE frame')
      await blackout
      response.end()
    } finally {
      clearInterval(heartbeat)
    }
  }
}
