import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import {
  HOST_AGENT_HEADERS,
  HOST_AGENT_LIMITS,
  parseHostAgentEvent,
  parseHostAgentRoute,
  type HostAgentEvent,
} from '@simulator/host-agent-contract'

const LOOPBACK_HOST = '127.0.0.1' as const
const MAX_RESPONSE_BYTES = HOST_AGENT_LIMITS.maxReplayBytes + HOST_AGENT_LIMITS.maxEventBytes
const MAX_EVIDENCE_FRAMES = HOST_AGENT_LIMITS.maxReplayEvents + 16
const CASE_IDS = new Set([
  'D01', 'D02', 'D03', 'D04',
  'L01', 'L02', 'L03', 'L04',
  'E01', 'E02', 'E03', 'E04',
  'S01', 'S02', 'S03', 'S04',
  'F01', 'F02', 'F03', 'F04',
])
const TERMINAL_TYPES = new Set<HostAgentEvent['type']>([
  'turn.completed', 'turn.failed', 'turn.interrupted',
])
const PRODUCER = 'external-host-agent-sse-proxy' as const
const HEARTBEAT_FRAME = Buffer.from(': blackout-heartbeat\n\n', 'utf8')
const BLACKOUT_STARTED_FRAME = Buffer.from(': blackout-started\n\n', 'utf8')
const BLACKOUT_ENDED_FRAME = Buffer.from(': blackout-ended\n\n', 'utf8')

export const HOST_AGENT_BLACKOUT_MS = 65_000 as const
export const HOST_AGENT_BLACKOUT_HEARTBEAT_MS = 10_000 as const
export const HOST_AGENT_BLACKOUT_ARM_TIMEOUT_MS = 30_000 as const

export interface HostAgentBlackoutClock {
  now(): number
  wait(delayMs: number, signal: AbortSignal): Promise<void>
  setInterval(callback: () => void, delayMs: number): unknown
  clearInterval(handle: unknown): void
  setTimeout(callback: () => void, delayMs: number): unknown
  clearTimeout(handle: unknown): void
}

export interface HostAgentBlackoutProxyOptions {
  readonly upstreamBaseUrl: string
  readonly bearerToken: string
  readonly blackoutMs?: number
  readonly heartbeatMs?: number
  readonly armTimeoutMs?: number
  readonly fetch?: typeof globalThis.fetch
  /** Deterministic short-duration test seam; production uses the constants above. */
  readonly clock?: HostAgentBlackoutClock
  readonly evidenceId?: () => string
}

export interface HostAgentBlackoutProxyAddress {
  readonly host: typeof LOOPBACK_HOST
  readonly port: number
  readonly url: string
}

export interface HostAgentBlackoutCapability {
  readonly schemaVersion: 1
  readonly available: true
  readonly producer: typeof PRODUCER
  readonly blackoutMs: number
  readonly heartbeatMs: number
}

export interface HostAgentBlackoutArmRequest {
  readonly caseId: string
  readonly stack: 'new'
  readonly turnOrdinal: number
}

export interface HostAgentBlackoutArmResult {
  readonly schemaVersion: 1
  readonly armed: true
  readonly producer: typeof PRODUCER
  readonly evidenceId: string
  readonly caseId: string
  readonly turnOrdinal: number
  readonly blackoutMs: number
  readonly heartbeatMs: number
}

export interface HostAgentBlackoutEvidenceRequest {
  readonly evidenceId: string
  readonly caseId: string
  readonly turnOrdinal: number
}

export interface HostAgentBlackoutDeliveredFrame {
  readonly sequence: number
  readonly at: string
  readonly type: string
  readonly source: 'daemon' | 'host-health' | 'harness'
  readonly business: boolean
  readonly payloadSha256: string
}

export interface HostAgentBlackoutEvidence {
  readonly schemaVersion: 1
  readonly producer: typeof PRODUCER
  readonly evidenceId: string
  readonly caseId: string
  readonly turnOrdinal: number
  readonly startedAt: string
  readonly endedAt: string
  readonly eventSequenceBefore: number
  readonly eventSequenceAfter: number
  readonly bufferedEventCount: number
  readonly replayedEventCount: number
  readonly replaySequenceStart: number
  readonly eventsLost: 0
  readonly heartbeatCount: number
  readonly heartbeatMaxGapMs: number
  readonly replayComplete: true
  readonly terminalEventCount: 1
  readonly deliveredFrames: readonly HostAgentBlackoutDeliveredFrame[]
}

interface ArmRecord {
  readonly evidenceId: string
  readonly caseId: string
  readonly turnOrdinal: number
  timeout?: unknown
  state: 'pending' | 'streaming' | 'complete' | 'failed' | 'taken'
  failureCode?: string
  evidence?: HostAgentBlackoutEvidence
  abort?: () => void
}

function digestBytes(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex')
}

function tokenDigest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

function defaultWait(delayMs: number, signal: AbortSignal): Promise<void> {
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

const DEFAULT_CLOCK: HostAgentBlackoutClock = {
  now: Date.now,
  wait: defaultWait,
  setInterval: (callback, delayMs) => setInterval(callback, delayMs),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
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

function assertEvidenceId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new TypeError('Evidence ID is invalid')
}

function parseSseEventFrame(frame: Buffer, expectedRunHandle: string): HostAgentEvent {
  if (frame.byteLength > HOST_AGENT_LIMITS.maxEventBytes) throw new TypeError('Host Agent SSE frame is too large')
  const text = new TextDecoder('utf-8', { fatal: true }).decode(frame)
  const match = /^id: ([1-9][0-9]*)\nevent: host-agent\.event\ndata: ([^\n]+)\n\n$/u.exec(text)
  if (!match) throw new TypeError('Host Agent SSE frame is invalid')
  const event = parseHostAgentEvent(JSON.parse(match[2]!))
  if (event.eventId !== match[1] || event.runHandle !== expectedRunHandle) {
    throw new TypeError('Host Agent SSE event identity is invalid')
  }
  return event
}

function writeFrame(response: ServerResponse, frame: Buffer): void {
  if (response.destroyed || response.writableEnded) throw new Error('Blackout proxy downstream is unavailable')
  // A false return is normal bounded socket backpressure, not delivery
  // failure. Armed replay is already capped by the Host contract.
  response.write(frame)
}

/**
 * Acceptance-only loopback proxy. It is deliberately kept under scripts/qa and
 * is never referenced by the Electron build or OpenDesign package closure.
 */
export class HostAgentBlackoutProxy {
  readonly #options: Required<Pick<HostAgentBlackoutProxyOptions, 'blackoutMs' | 'heartbeatMs' | 'armTimeoutMs'>>
    & Omit<HostAgentBlackoutProxyOptions, 'blackoutMs' | 'heartbeatMs' | 'armTimeoutMs'>
  readonly #tokenDigest: Buffer
  readonly #upstream: URL
  readonly #clock: HostAgentBlackoutClock
  readonly #sockets = new Set<Socket>()
  readonly #records = new Map<string, ArmRecord>()
  #server?: Server
  #address?: HostAgentBlackoutProxyAddress
  #pending?: ArmRecord
  #active?: ArmRecord
  #nextOrdinal = 1

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
    const blackoutMs = options.blackoutMs ?? HOST_AGENT_BLACKOUT_MS
    const heartbeatMs = options.heartbeatMs ?? HOST_AGENT_BLACKOUT_HEARTBEAT_MS
    const armTimeoutMs = options.armTimeoutMs ?? HOST_AGENT_BLACKOUT_ARM_TIMEOUT_MS
    if (!Number.isSafeInteger(blackoutMs) || blackoutMs < 1
      || !Number.isSafeInteger(heartbeatMs) || heartbeatMs < 1 || heartbeatMs >= blackoutMs
      || !Number.isSafeInteger(armTimeoutMs) || armTimeoutMs < 1) {
      throw new TypeError('Blackout proxy timing is invalid')
    }
    this.#options = { ...options, blackoutMs, heartbeatMs, armTimeoutMs }
    this.#tokenDigest = tokenDigest(options.bearerToken)
    this.#upstream = upstream
    this.#clock = options.clock ?? DEFAULT_CLOCK
  }

  get address(): HostAgentBlackoutProxyAddress | undefined { return this.#address }

  getCapability(): HostAgentBlackoutCapability {
    return Object.freeze({
      schemaVersion: 1,
      available: true,
      producer: PRODUCER,
      blackoutMs: this.#options.blackoutMs,
      heartbeatMs: this.#options.heartbeatMs,
    })
  }

  armNextBlackout(request: HostAgentBlackoutArmRequest): HostAgentBlackoutArmResult {
    if (!this.#server || !this.#address) throw new TypeError('Blackout proxy is not running')
    if (Object.getPrototypeOf(request) !== Object.prototype
      || Object.keys(request).sort().join(',') !== 'caseId,stack,turnOrdinal'
      || !CASE_IDS.has(request.caseId) || request.stack !== 'new'
      || !Number.isSafeInteger(request.turnOrdinal) || request.turnOrdinal !== this.#nextOrdinal
      || request.turnOrdinal < 1 || request.turnOrdinal > 20) {
      this.#failPending('BLACKOUT_ARM_SEQUENCE_INVALID')
      throw new TypeError('Blackout arm request is invalid')
    }
    if (this.#pending || this.#active) {
      this.#failPending('BLACKOUT_ARM_DUPLICATE')
      if (this.#active) this.#failRecord(this.#active, 'BLACKOUT_STREAM_DUPLICATE')
      throw new TypeError('Blackout proxy already has an owned arm')
    }
    const evidenceId = this.#options.evidenceId?.() ?? `blackout-${request.turnOrdinal}-${randomUUID()}`
    assertEvidenceId(evidenceId)
    if (this.#records.has(evidenceId)) throw new TypeError('Blackout evidence ID is not unique')
    const record: ArmRecord = {
      evidenceId,
      caseId: request.caseId,
      turnOrdinal: request.turnOrdinal,
      state: 'pending',
    }
    record.timeout = this.#clock.setTimeout(() => {
      if (this.#pending !== record || record.state !== 'pending') return
      this.#pending = undefined
      this.#failRecord(record, 'BLACKOUT_ARM_TIMEOUT')
    }, this.#options.armTimeoutMs)
    this.#records.set(evidenceId, record)
    this.#pending = record
    this.#nextOrdinal += 1
    return Object.freeze({
      schemaVersion: 1,
      armed: true,
      producer: PRODUCER,
      evidenceId,
      caseId: request.caseId,
      turnOrdinal: request.turnOrdinal,
      blackoutMs: this.#options.blackoutMs,
      heartbeatMs: this.#options.heartbeatMs,
    })
  }

  takeBlackoutEvidence(request: HostAgentBlackoutEvidenceRequest): HostAgentBlackoutEvidence {
    if (Object.getPrototypeOf(request) !== Object.prototype
      || Object.keys(request).sort().join(',') !== 'caseId,evidenceId,turnOrdinal'
      || !CASE_IDS.has(request.caseId) || !Number.isSafeInteger(request.turnOrdinal)) {
      throw new TypeError('Blackout evidence request is invalid')
    }
    assertEvidenceId(request.evidenceId)
    const record = this.#records.get(request.evidenceId)
    if (!record || record.caseId !== request.caseId || record.turnOrdinal !== request.turnOrdinal) {
      throw new TypeError('Blackout evidence identity is invalid')
    }
    if (record.state === 'pending' || record.state === 'streaming') {
      throw new TypeError('Blackout evidence is not terminal')
    }
    if (record.state === 'taken') throw new TypeError('Blackout evidence was already taken')
    record.state = 'taken'
    this.#records.delete(record.evidenceId)
    if (!record.evidence) throw new TypeError(record.failureCode ?? 'Blackout evidence failed')
    return record.evidence
  }

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
    this.#failPending('BLACKOUT_PROXY_STOPPED')
    if (this.#active) this.#failRecord(this.#active, 'BLACKOUT_PROXY_STOPPED')
    for (const record of this.#records.values()) {
      if (record.timeout !== undefined) this.#clock.clearTimeout(record.timeout)
    }
    for (const socket of this.#sockets) socket.destroy()
    this.#sockets.clear()
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  #failPending(code: string): void {
    const pending = this.#pending
    if (!pending) return
    this.#pending = undefined
    this.#failRecord(pending, code)
  }

  #failRecord(record: ArmRecord, code: string): void {
    if (record.timeout !== undefined) {
      this.#clock.clearTimeout(record.timeout)
      record.timeout = undefined
    }
    if (record.state === 'complete' || record.state === 'taken') return
    const abort = record.abort
    record.abort = undefined
    record.state = 'failed'
    record.failureCode = code
    record.evidence = undefined
    if (this.#pending === record) this.#pending = undefined
    if (this.#active === record) this.#active = undefined
    abort?.()
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
        await this.#stream(request, response, route.runHandle, abort.signal)
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
    const candidate = tokenDigest(match?.[1] ?? 'invalid')
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

  #consumeArm(): ArmRecord | undefined {
    if (this.#active) {
      this.#failRecord(this.#active, 'BLACKOUT_STREAM_DUPLICATE')
      throw new TypeError('A blackout stream is already active')
    }
    const record = this.#pending
    if (!record) return undefined
    this.#pending = undefined
    if (record.timeout !== undefined) {
      this.#clock.clearTimeout(record.timeout)
      record.timeout = undefined
    }
    record.state = 'streaming'
    this.#active = record
    return record
  }

  async #stream(
    request: IncomingMessage,
    response: ServerResponse,
    runHandle: string,
    signal: AbortSignal,
  ): Promise<void> {
    const record = this.#consumeArm()
    try {
      if (record && singleRawHeader(request, HOST_AGENT_HEADERS.lastEventId) !== undefined) {
        this.#failRecord(record, 'BLACKOUT_WRONG_CONNECTION')
        throw new TypeError('An armed blackout requires the initial SSE connection')
      }
      const upstream = await (this.#options.fetch ?? globalThis.fetch)(new URL(request.url ?? '/', this.#upstream), {
        method: 'GET',
        headers: this.#upstreamHeaders(request),
        signal,
      })
      if (!upstream.ok || !upstream.body) {
        if (record) this.#failRecord(record, 'BLACKOUT_UPSTREAM_REJECTED')
        const bytes = await readBoundedResponse(upstream)
        copyResponseHeaders(upstream, response)
        response.statusCode = upstream.status
        response.end(bytes)
        return
      }
      if (!record) {
        await this.#passthrough(upstream, response)
        return
      }
      await this.#blackout(upstream, response, runHandle, record, signal)
    } catch (error) {
      if (record) this.#failRecord(record, 'BLACKOUT_STREAM_FAILED')
      throw error
    } finally {
      if (this.#active === record) this.#active = undefined
    }
  }

  async #passthrough(upstream: Response, response: ServerResponse): Promise<void> {
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream; charset=utf-8',
      'X-Accel-Buffering': 'no',
    })
    for await (const raw of upstream.body!) writeFrame(response, Buffer.from(raw))
    response.end()
  }

  async #blackout(
    upstream: Response,
    response: ServerResponse,
    runHandle: string,
    record: ArmRecord,
    signal: AbortSignal,
  ): Promise<void> {
    record.abort = () => response.destroy()
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream; charset=utf-8',
      'X-Accel-Buffering': 'no',
    })

    const deliveredFrames: HostAgentBlackoutDeliveredFrame[] = []
    let lastEvidenceAtMs = -1
    const append = (
      frame: Buffer,
      type: string,
      source: HostAgentBlackoutDeliveredFrame['source'],
      business: boolean,
    ): HostAgentBlackoutDeliveredFrame => {
      if (deliveredFrames.length >= MAX_EVIDENCE_FRAMES) throw new TypeError('Blackout evidence exceeded')
      // Date timestamps have millisecond resolution. Preserve actual delivery
      // order with a monotonic logical millisecond when multiple frames are
      // written in the same clock tick (notably the end marker and first replay).
      const atMs = Math.max(this.#clock.now(), lastEvidenceAtMs + 1)
      lastEvidenceAtMs = atMs
      const item = Object.freeze({
        sequence: deliveredFrames.length + 1,
        at: new Date(atMs).toISOString(),
        type,
        source,
        business,
        payloadSha256: digestBytes(frame),
      })
      deliveredFrames.push(item)
      return item
    }

    writeFrame(response, BLACKOUT_STARTED_FRAME)
    const startedFrame = append(BLACKOUT_STARTED_FRAME, 'blackout.started', 'harness', false)
    const startedAtMs = Date.parse(startedFrame.at)
    const eventSequenceBefore = startedFrame.sequence
    const heartbeatTimes: number[] = []
    const emitHeartbeat = (): void => {
      writeFrame(response, HEARTBEAT_FRAME)
      const frame = append(HEARTBEAT_FRAME, 'heartbeat', 'host-health', false)
      heartbeatTimes.push(Date.parse(frame.at))
    }
    emitHeartbeat()
    let heartbeatFailure: unknown
    const heartbeat = this.#clock.setInterval(() => {
      if (heartbeatFailure !== undefined) return
      try {
        emitHeartbeat()
      } catch (error) {
        // Timer callbacks must never become process-level uncaught exceptions.
        // Failing the owned record destroys this response, which aborts the
        // upstream fetch and settles the already-handled blackout promise.
        heartbeatFailure = error
        this.#failRecord(record, 'BLACKOUT_HEARTBEAT_FAILED')
      }
    }, this.#options.heartbeatMs)
    let blackoutComplete = false
    let bufferedBytes = 0
    const bufferedFrames: Array<{ frame: Buffer; event: HostAgentEvent }> = []
    const blackout = this.#clock.wait(this.#options.blackoutMs, signal).then(() => {
      blackoutComplete = true
      writeFrame(response, BLACKOUT_ENDED_FRAME)
      const endedFrame = append(BLACKOUT_ENDED_FRAME, 'blackout.ended', 'harness', false)
      const endedAtMs = Date.parse(endedFrame.at)
      const eventSequenceAfter = endedFrame.sequence
      const bufferedEventCount = bufferedFrames.length
      if (bufferedEventCount < 1) {
        throw new TypeError('Blackout did not buffer an upstream event for replay')
      }
      const replaySequenceStart = eventSequenceAfter + 1
      let replayedEventCount = 0
      for (const buffered of bufferedFrames.splice(0)) {
        writeFrame(response, buffered.frame)
        append(buffered.frame, buffered.event.type, 'daemon', true)
        replayedEventCount += 1
      }
      if (replayedEventCount !== bufferedEventCount) {
        throw new TypeError('Blackout replay count is inconsistent')
      }
      bufferedBytes = 0
      return {
        endedAtMs,
        eventSequenceAfter,
        bufferedEventCount,
        replayedEventCount,
        replaySequenceStart,
      }
    }).then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (error: unknown) => ({ status: 'rejected' as const, error }),
    )
    let pending = Buffer.alloc(0)
    let lastUpstreamSequence: number | undefined
    let terminalEventCount = 0
    let completedCount = 0
    let closedCount = 0
    try {
      for await (const raw of upstream.body!) {
        pending = Buffer.concat([pending, Buffer.from(raw)])
        if (pending.byteLength > HOST_AGENT_LIMITS.maxReplayBytes + HOST_AGENT_LIMITS.maxEventBytes) {
          throw new TypeError('Blackout replay buffer exceeded')
        }
        while (true) {
          const boundary = pending.indexOf('\n\n')
          if (boundary < 0) break
          const frame = Buffer.from(pending.subarray(0, boundary + 2))
          pending = pending.subarray(boundary + 2)
          if (frame.subarray(0, 1).equals(Buffer.from(':'))) continue
          const event = parseSseEventFrame(frame, runHandle)
          if ((lastUpstreamSequence === undefined && event.sequence !== 1)
            || (lastUpstreamSequence !== undefined && event.sequence !== lastUpstreamSequence + 1)
            || closedCount > 0) {
            throw new TypeError('Blackout replay sequence is discontinuous')
          }
          lastUpstreamSequence = event.sequence
          if (TERMINAL_TYPES.has(event.type)) {
            terminalEventCount += 1
            if (event.type === 'turn.completed') completedCount += 1
          }
          if (event.type === 'run.closed') closedCount += 1
          if (blackoutComplete) {
            writeFrame(response, frame)
            append(frame, event.type, 'daemon', true)
          } else {
            bufferedBytes += frame.byteLength
            if (bufferedBytes > HOST_AGENT_LIMITS.maxReplayBytes
              || bufferedFrames.length >= HOST_AGENT_LIMITS.maxReplayEvents) {
              throw new TypeError('Blackout replay buffer exceeded')
            }
            bufferedFrames.push({ frame, event })
          }
        }
      }
      if (pending.byteLength !== 0) throw new TypeError('Truncated upstream SSE frame')
      const blackoutSettlement = await blackout
      if (blackoutSettlement.status === 'rejected') throw blackoutSettlement.error
      if (heartbeatFailure !== undefined) throw heartbeatFailure
      const blackoutResult = blackoutSettlement.value
      response.end()

      if (record.state !== 'streaming'
        || terminalEventCount !== 1 || completedCount !== 1 || closedCount !== 1) {
        throw new TypeError('Blackout stream did not complete exactly once')
      }
      const gaps: number[] = []
      for (let index = 1; index < heartbeatTimes.length; index += 1) {
        gaps.push(heartbeatTimes[index]! - heartbeatTimes[index - 1]!)
      }
      record.evidence = Object.freeze({
        schemaVersion: 1,
        producer: PRODUCER,
        evidenceId: record.evidenceId,
        caseId: record.caseId,
        turnOrdinal: record.turnOrdinal,
        startedAt: new Date(startedAtMs).toISOString(),
        endedAt: new Date(Math.max(blackoutResult.endedAtMs, startedAtMs + this.#options.blackoutMs)).toISOString(),
        eventSequenceBefore,
        eventSequenceAfter: blackoutResult.eventSequenceAfter,
        bufferedEventCount: blackoutResult.bufferedEventCount,
        replayedEventCount: blackoutResult.replayedEventCount,
        replaySequenceStart: blackoutResult.replaySequenceStart,
        eventsLost: 0,
        heartbeatCount: heartbeatTimes.length,
        heartbeatMaxGapMs: gaps.length > 0 ? Math.max(...gaps) : 0,
        replayComplete: true,
        terminalEventCount: 1,
        deliveredFrames: Object.freeze(deliveredFrames),
      })
      record.abort = undefined
      record.state = 'complete'
    } finally {
      this.#clock.clearInterval(heartbeat)
    }
  }
}
