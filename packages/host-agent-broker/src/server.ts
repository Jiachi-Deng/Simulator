import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import {
  HOST_AGENT_CAPABILITY,
  HOST_AGENT_CONTRACT_VERSION,
  HOST_AGENT_ERROR_DEFINITIONS,
  HOST_AGENT_HEADERS,
  HOST_AGENT_LIMITS,
  HOST_AGENT_SSE_EVENT,
  createHostAgentErrorResponse,
  parseCreateHostAgentRunRequest,
  parseHostAgentRoute,
  parseHostAgentEvent,
  parseHostAgentRunSnapshot,
  parseIdempotencyKey,
  parseLastEventId,
  type HostAgentCapabilitiesResponse,
  type HostAgentErrorCode,
  type HostAgentEvent,
} from '@simulator/host-agent-contract'
import { parseHostAgentJsonBytes } from '@simulator/host-agent-contract/node'
import { HostAgentBrokerCoreClientError, toPublicErrorCode } from './errors.ts'
import type {
  HostAgentBrokerCoreClient,
  HostAgentBrokerCoreSubscription,
  HostAgentBrokerServerAddress,
  HostAgentBrokerServerLimits,
} from './types.ts'

const LOOPBACK_HOST = '127.0.0.1' as const
const JSON_CONTENT_TYPES = new Set(['application/json', 'application/json; charset=utf-8'])
const SECURITY_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
})

const DEFAULT_SERVER_LIMITS: Readonly<HostAgentBrokerServerLimits> = Object.freeze({
  maxSockets: HOST_AGENT_LIMITS.maxSocketsPerGrant,
  maxConcurrentRequests: HOST_AGENT_LIMITS.maxConcurrentHttpRequestsPerGrant,
  maxSseSubscribers: HOST_AGENT_LIMITS.maxSseSubscribersPerGrant,
  maxRequestBodyBytes: HOST_AGENT_LIMITS.maxRequestBodyBytes,
  heartbeatIntervalMs: HOST_AGENT_LIMITS.heartbeatIntervalMs,
  headerTimeoutMs: 5_000,
  bodyTimeoutMs: 10_000,
  idleTimeoutMs: 30_000,
  maxSseBufferedBytes: HOST_AGENT_LIMITS.maxReplayBytes,
})

class PayloadTooLargeError extends Error {}
class RequestAbortedError extends Error {}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

function rawHeaderValues(request: IncomingMessage, name: string): string[] {
  const values: string[] = []
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === name.toLowerCase()) values.push(request.rawHeaders[index + 1] ?? '')
  }
  return values
}

function singleHeader(request: IncomingMessage, name: string, required: boolean): string | undefined {
  const values = rawHeaderValues(request, name)
  if (values.length === 0 && !required) return undefined
  if (values.length !== 1) throw new TypeError('Invalid HTTP header')
  return values[0]
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), 'utf8')
}

function writeSecurityHeaders(response: ServerResponse): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.setHeader(name, value)
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent || response.destroyed) return
  const body = jsonBytes(value)
  writeSecurityHeaders(response)
  response.statusCode = status
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.setHeader('Content-Length', String(body.byteLength))
  response.end(body)
}

function writeError(response: ServerResponse, code: HostAgentErrorCode): void {
  writeJson(response, HOST_AGENT_ERROR_DEFINITIONS[code].httpStatus, createHostAgentErrorResponse(code))
}

function validateCoreSnapshot(input: unknown) {
  try { return parseHostAgentRunSnapshot(input) } catch { throw new HostAgentBrokerCoreClientError('INTERNAL_ERROR') }
}

function parseContentLength(request: IncomingMessage): number | undefined {
  const value = singleHeader(request, 'content-length', false)
  if (value === undefined) return undefined
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new TypeError('Invalid Content-Length')
  const length = Number(value)
  if (!Number.isSafeInteger(length)) throw new PayloadTooLargeError()
  return length
}

async function readBody(request: IncomingMessage, maxBytes: number, timeoutMs: number): Promise<Buffer> {
  const declared = parseContentLength(request)
  if (declared !== undefined && declared > maxBytes) {
    request.resume()
    throw new PayloadTooLargeError()
  }
  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    let bytes = 0
    let settled = false
    const timeout = setTimeout(() => finish(new RequestAbortedError()), timeoutMs)
    timeout.unref?.()
    const cleanup = (): void => {
      clearTimeout(timeout)
      request.off('data', onData)
      request.off('end', onEnd)
      request.off('aborted', onAborted)
      request.off('error', onError)
    }
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      if (error) reject(error)
      else resolve(Buffer.concat(chunks, bytes))
    }
    const onData = (chunk: Buffer | string): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytes += buffer.byteLength
      if (bytes > maxBytes) {
        request.resume()
        finish(new PayloadTooLargeError())
        return
      }
      chunks.push(buffer)
    }
    const onEnd = (): void => {
      if (declared !== undefined && declared !== bytes) finish(new RequestAbortedError())
      else finish()
    }
    const onAborted = (): void => finish(new RequestAbortedError())
    const onError = (): void => finish(new RequestAbortedError())
    request.on('data', onData)
    request.once('end', onEnd)
    request.once('aborted', onAborted)
    request.once('error', onError)
    if (request.readableEnded) onEnd()
  })
}

class SseWriter {
  readonly #response: ServerResponse
  readonly #maxBufferedBytes: number
  readonly #queue: Buffer[] = []
  #queuedBytes = 0
  #blocked = false
  #endWhenDrained = false
  #closed = false

  constructor(response: ServerResponse, maxBufferedBytes: number) {
    this.#response = response
    this.#maxBufferedBytes = maxBufferedBytes
    response.on('drain', () => this.#drain())
    response.on('close', () => { this.#closed = true })
  }

  writeEvent(event: HostAgentEvent): boolean {
    const chunk = Buffer.from(`id: ${event.eventId}\nevent: ${HOST_AGENT_SSE_EVENT}\ndata: ${JSON.stringify(event)}\n\n`, 'utf8')
    return this.#write(chunk, true)
  }

  heartbeat(): void {
    if (!this.#blocked) this.#write(Buffer.from(': heartbeat\n\n', 'utf8'), false)
  }

  finishAfterFlush(): void {
    this.#endWhenDrained = true
    if (!this.#blocked && this.#queue.length === 0 && !this.#closed) this.#response.end()
  }

  #write(chunk: Buffer, countAgainstLimit: boolean): boolean {
    if (this.#closed || this.#response.destroyed || this.#response.writableEnded) return false
    if (this.#blocked) {
      if (!countAgainstLimit) return true
      if (this.#queuedBytes + this.#response.writableLength + chunk.byteLength > this.#maxBufferedBytes) {
        this.#response.destroy()
        this.#closed = true
        return false
      }
      this.#queue.push(chunk)
      this.#queuedBytes += chunk.byteLength
      return true
    }
    if (countAgainstLimit && this.#response.writableLength + chunk.byteLength > this.#maxBufferedBytes) {
      this.#response.destroy()
      this.#closed = true
      return false
    }
    this.#blocked = !this.#response.write(chunk)
    return true
  }

  #drain(): void {
    if (this.#closed) return
    this.#blocked = false
    while (this.#queue.length > 0 && !this.#blocked) {
      const chunk = this.#queue.shift()!
      this.#queuedBytes -= chunk.byteLength
      this.#blocked = !this.#response.write(chunk)
    }
    if (this.#endWhenDrained && !this.#blocked && this.#queue.length === 0) this.#response.end()
  }
}

export interface HostAgentBrokerServerOptions {
  coreClient: HostAgentBrokerCoreClient
  bearerToken: string
  limits?: Partial<HostAgentBrokerServerLimits>
}

/** Loopback-only, grant-bound v2 HTTP/SSE worker. */
export class HostAgentBrokerServer {
  readonly #coreClient: HostAgentBrokerCoreClient
  readonly #tokenDigest: Buffer
  readonly #limits: Readonly<HostAgentBrokerServerLimits>
  readonly #sockets = new Set<Socket>()
  readonly #sseResponses = new Set<ServerResponse>()
  #server?: Server
  #address?: HostAgentBrokerServerAddress
  #activeRequests = 0
  #activeSse = 0

  constructor(options: HostAgentBrokerServerOptions) {
    if (typeof options.bearerToken !== 'string'
      || Buffer.byteLength(options.bearerToken, 'utf8') < 16
      || Buffer.byteLength(options.bearerToken, 'utf8') > 512
      || /[\u0000-\u0020\u007f]/u.test(options.bearerToken)) {
      throw new TypeError('Host Agent bearer token is invalid')
    }
    this.#coreClient = options.coreClient
    this.#tokenDigest = sha256(options.bearerToken)
    this.#limits = Object.freeze({ ...DEFAULT_SERVER_LIMITS, ...options.limits })
    this.#validateLimits()
  }

  get address(): HostAgentBrokerServerAddress | undefined { return this.#address }

  debugSnapshot(): Readonly<{ sockets: number; activeRequests: number; sseSubscribers: number }> {
    return { sockets: this.#sockets.size, activeRequests: this.#activeRequests, sseSubscribers: this.#activeSse }
  }

  async start(): Promise<HostAgentBrokerServerAddress> {
    if (this.#server || this.#address) throw new TypeError('Host Agent broker has already started')
    const server = createServer({
      maxHeaderSize: 16 * 1024,
      headersTimeout: this.#limits.headerTimeoutMs,
      // Node requires requestTimeout >= headersTimeout. The stricter body-only
      // timer remains enforced by readBody after headers are accepted.
      requestTimeout: Math.max(this.#limits.bodyTimeoutMs, this.#limits.headerTimeoutMs),
      keepAliveTimeout: Math.min(5_000, this.#limits.idleTimeoutMs),
    })
    this.#server = server
    server.on('request', (request, response) => void this.#handleRequest(request, response))
    server.on('checkContinue', (request, response) => {
      request.resume()
      writeError(response, 'INVALID_REQUEST')
    })
    server.on('connection', (socket) => {
      if (this.#sockets.size >= this.#limits.maxSockets) {
        socket.destroy()
        return
      }
      this.#sockets.add(socket)
      socket.setTimeout(this.#limits.idleTimeoutMs, () => socket.destroy())
      socket.once('close', () => this.#sockets.delete(socket))
    })
    server.on('clientError', (_error, socket) => {
      if (!socket.writable) return socket.destroy()
      const body = jsonBytes(createHostAgentErrorResponse('INVALID_REQUEST'))
      socket.end([
        'HTTP/1.1 400 Bad Request',
        'Connection: close',
        'Content-Type: application/json; charset=utf-8',
        'Cache-Control: no-store',
        'X-Content-Type-Options: nosniff',
        `Content-Length: ${body.byteLength}`,
        '',
        body.toString('utf8'),
      ].join('\r\n'))
    })
    await new Promise<void>((resolve, reject) => {
      const onError = (): void => reject(new Error('Host Agent broker failed to bind loopback'))
      server.once('error', onError)
      server.listen(0, LOOPBACK_HOST, () => {
        server.off('error', onError)
        resolve()
      })
    })
    const bound = server.address()
    if (!bound || typeof bound === 'string' || bound.address !== LOOPBACK_HOST || bound.port < 1) {
      await this.stop()
      throw new Error('Host Agent broker did not bind the required loopback address')
    }
    this.#address = { host: LOOPBACK_HOST, port: bound.port, url: `http://${LOOPBACK_HOST}:${bound.port}` }
    return this.#address
  }

  async stop(): Promise<void> {
    const server = this.#server
    this.#address = undefined
    this.#server = undefined
    for (const response of this.#sseResponses) response.end()
    this.#sseResponses.clear()
    for (const socket of this.#sockets) socket.destroy()
    this.#sockets.clear()
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  async #handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (this.#activeRequests >= this.#limits.maxConcurrentRequests) {
      request.resume()
      writeError(response, 'RATE_LIMITED')
      return
    }
    this.#activeRequests += 1
    try {
      await this.#routeRequest(request, response)
    } catch (error) {
      if (!request.complete) request.resume()
      if (response.headersSent) {
        if (!response.writableEnded) response.destroy()
      } else {
        if (error instanceof RequestAbortedError) {
          response.setHeader('Connection', 'close')
          const forceClose = setTimeout(() => request.socket.destroy(), 25)
          forceClose.unref?.()
        }
        writeError(response, error instanceof PayloadTooLargeError ? 'PAYLOAD_TOO_LARGE' : toPublicErrorCode(error))
      }
    } finally {
      this.#activeRequests = Math.max(0, this.#activeRequests - 1)
    }
  }

  async #routeRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    this.#authorize(request)
    const route = parseHostAgentRoute(request.method, request.url)
    if (route.route === 'capabilities') {
      await this.#requireEmptyBody(request)
      writeJson(response, 200, this.#capabilities())
      return
    }
    if (route.route === 'runs.create') {
      this.#requireJsonContentType(request)
      const idempotencyKey = parseIdempotencyKey(singleHeader(request, HOST_AGENT_HEADERS.idempotencyKey, true))
      const body = await readBody(request, this.#limits.maxRequestBodyBytes, this.#limits.bodyTimeoutMs)
      const parsed = parseCreateHostAgentRunRequest(parseHostAgentJsonBytes(body, this.#limits.maxRequestBodyBytes))
      writeJson(response, 200, validateCoreSnapshot(await this.#coreClient.createRun(idempotencyKey, parsed)))
      return
    }
    if (route.route === 'runs.get') {
      await this.#requireEmptyBody(request)
      writeJson(response, 200, validateCoreSnapshot(await this.#coreClient.getRun(route.runHandle)))
      return
    }
    if (route.route === 'runs.cancel') {
      await this.#requireEmptyBody(request)
      writeJson(response, 200, validateCoreSnapshot(await this.#coreClient.cancelRun(route.runHandle)))
      return
    }
    if (route.route === 'runs.delete') {
      await this.#requireEmptyBody(request)
      // closeRun resolves only after strict Host cleanup/reap has completed.
      writeJson(response, 200, validateCoreSnapshot(await this.#coreClient.closeRun(route.runHandle)))
      return
    }
    if (route.route === 'runs.events') {
      await this.#serveEvents(request, response, route.runHandle)
      return
    }
    throw new TypeError('Unsupported Host Agent route')
  }

  #authorize(request: IncomingMessage): void {
    const remote = request.socket.remoteAddress
    if (remote !== LOOPBACK_HOST && remote !== `::ffff:${LOOPBACK_HOST}`) throw Object.assign(new Error(), { code: 'FORBIDDEN' })
    if (rawHeaderValues(request, 'origin').length > 0) throw Object.assign(new Error(), { code: 'FORBIDDEN' })
    const address = this.#address
    if (!address) throw new Error('Host Agent broker is not ready')
    const host = singleHeader(request, 'host', true)
    if (host !== `${LOOPBACK_HOST}:${address.port}`) throw Object.assign(new Error(), { code: 'FORBIDDEN' })
    const authorization = singleHeader(request, 'authorization', true)
    const match = /^Bearer ([\x21-\x7e]{1,512})$/i.exec(authorization ?? '')
    const token = match?.[1]
    const candidate = token ? sha256(token) : sha256('invalid')
    if (!token || !timingSafeEqual(candidate, this.#tokenDigest)) {
      throw Object.assign(new Error(), { code: 'UNAUTHORIZED' })
    }
  }

  #requireJsonContentType(request: IncomingMessage): void {
    if (rawHeaderValues(request, 'content-encoding').length > 0) throw new TypeError('Content-Encoding is forbidden')
    const contentType = singleHeader(request, 'content-type', true)?.toLowerCase().replace(/[ \t]+/g, ' ')
    if (!contentType || !JSON_CONTENT_TYPES.has(contentType)) throw new TypeError('Content-Type must be JSON UTF-8')
  }

  async #requireEmptyBody(request: IncomingMessage): Promise<void> {
    if (rawHeaderValues(request, 'content-type').length > 0 || rawHeaderValues(request, 'content-encoding').length > 0) {
      throw new TypeError('This route has no request body')
    }
    const body = await readBody(request, 1, this.#limits.bodyTimeoutMs)
    if (body.byteLength !== 0) throw new TypeError('This route has no request body')
  }

  async #serveEvents(request: IncomingMessage, response: ServerResponse, runHandle: string): Promise<void> {
    await this.#requireEmptyBody(request)
    if (this.#activeSse >= this.#limits.maxSseSubscribers) throw Object.assign(new Error(), { code: 'RATE_LIMITED' })
    const afterSequence = parseLastEventId(singleHeader(request, HOST_AGENT_HEADERS.lastEventId, false))
    this.#activeSse += 1
    const earlyEvents: HostAgentEvent[] = []
    let earlyEventBytes = 0
    let earlyOverflow = false
    let writer: SseWriter | undefined
    let closedEventSeen = false
    let subscription: HostAgentBrokerCoreSubscription | undefined
    let coreBoundaryInvalid = false
    const listener = (rawEvent: HostAgentEvent): void => {
      let event: HostAgentEvent
      try { event = parseHostAgentEvent(rawEvent) } catch {
        coreBoundaryInvalid = true
        if (writer) response.destroy()
        return
      }
      if (event.type === 'run.closed') closedEventSeen = true
      if (writer) {
        writer.writeEvent(event)
        if (event.type === 'run.closed') writer.finishAfterFlush()
      } else {
        earlyEventBytes += Buffer.byteLength(JSON.stringify(event), 'utf8')
        if (earlyEventBytes > this.#limits.maxSseBufferedBytes) earlyOverflow = true
        else earlyEvents.push(event)
      }
    }
    try {
      subscription = await this.#coreClient.subscribeRun(runHandle, afterSequence, listener)
      if (coreBoundaryInvalid) throw new Error('Host Agent core emitted an invalid event')
      if (earlyOverflow) throw Object.assign(new Error(), { code: 'REPLAY_UNAVAILABLE' })
      writeSecurityHeaders(response)
      response.statusCode = 200
      response.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
      response.setHeader('Connection', 'keep-alive')
      response.setHeader('X-Accel-Buffering', 'no')
      response.flushHeaders()
      this.#sseResponses.add(response)
      const finished = new Promise<void>((resolve) => {
        let settled = false
        const done = (): void => {
          if (settled) return
          settled = true
          resolve()
        }
        request.once('aborted', done)
        request.once('close', done)
        response.once('close', done)
        response.once('finish', done)
      })
      writer = new SseWriter(response, this.#limits.maxSseBufferedBytes)
      for (const event of earlyEvents) writer.writeEvent(event)
      const heartbeat = setInterval(() => writer?.heartbeat(), this.#limits.heartbeatIntervalMs)
      heartbeat.unref?.()
      if (closedEventSeen) writer.finishAfterFlush()
      await finished
      clearInterval(heartbeat)
    } finally {
      this.#sseResponses.delete(response)
      this.#activeSse = Math.max(0, this.#activeSse - 1)
      await subscription?.unsubscribe()
    }
  }

  #capabilities(): HostAgentCapabilitiesResponse {
    return {
      contractVersion: HOST_AGENT_CONTRACT_VERSION,
      capability: HOST_AGENT_CAPABILITY,
      features: { streaming: true, cancellation: true, reconnect: true, idempotency: true },
      limits: {
        maxPromptBytes: HOST_AGENT_LIMITS.maxPromptBytes,
        maxEventBytes: HOST_AGENT_LIMITS.maxEventBytes,
        maxDeltaBytes: HOST_AGENT_LIMITS.maxDeltaBytes,
        maxReplayEvents: HOST_AGENT_LIMITS.maxReplayEvents,
        maxReplayBytes: HOST_AGENT_LIMITS.maxReplayBytes,
        maxSseSubscribers: this.#limits.maxSseSubscribers,
        maxConcurrentRuns: HOST_AGENT_LIMITS.maxConcurrentModuleRuns,
        maxRunDurationMs: HOST_AGENT_LIMITS.maxRunDurationMs,
      },
    }
  }

  #validateLimits(): void {
    const ceiling: HostAgentBrokerServerLimits = { ...DEFAULT_SERVER_LIMITS }
    for (const key of Object.keys(this.#limits) as Array<keyof HostAgentBrokerServerLimits>) {
      const value = this.#limits[key]
      if (!Number.isSafeInteger(value) || value < 1 || value > ceiling[key]) {
        throw new TypeError(`${key} exceeds the Host Agent broker ceiling`)
      }
    }
    if (this.#limits.heartbeatIntervalMs >= this.#limits.idleTimeoutMs) {
      throw new TypeError('Heartbeat must be shorter than the idle timeout')
    }
  }
}
