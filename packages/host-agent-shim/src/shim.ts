import { randomBytes, timingSafeEqual } from 'node:crypto'
import { once } from 'node:events'
import { lstat, readFile, realpath } from 'node:fs/promises'
import type { Readable, Writable } from 'node:stream'
import {
  HOST_AGENT_CONTRACT_VERSION,
  HOST_AGENT_ENV_CONTRACT_VERSION,
  HOST_AGENT_LIMITS,
  HOST_AGENT_SSE_EVENT,
  parseHostAgentCapabilitiesResponse,
  parseHostAgentErrorResponse,
  parseHostAgentEvent,
  parseHostAgentRunSnapshot,
  type HostAgentEvent,
  type HostAgentRunSnapshot,
} from '@simulator/host-agent-contract'
import { parseHostAgentJsonBytes } from '@simulator/host-agent-contract/node'

const REQUEST_TIMEOUT_MS = 10_000
const CLEANUP_TIMEOUT_MS = 5_000
const MAX_CREATE_ATTEMPTS = 3
const MAX_SSE_RECONNECTS = 3
const MAX_HTTP_RESPONSE_BYTES = 512 * 1024
const MAX_SSE_FRAME_BYTES = HOST_AGENT_LIMITS.maxEventBytes + 1024

type Fetch = typeof globalThis.fetch

export interface HostAgentShimOptions {
  argv: string[]
  entryPath: string
  cwd: string
  env: NodeJS.ProcessEnv
  stdin: Readable
  stdout: Writable
  stderr: Writable
  signal: AbortSignal
  fetch?: Fetch
}

interface ValidatedEnvironment {
  baseUrl: string
  token: string
}

class ShimError extends Error {
  constructor(readonly publicCode: string) {
    super(publicCode)
    this.name = 'ShimError'
  }
}

class HttpShimError extends ShimError {
  constructor(publicCode: string, readonly retryable: boolean) {
    super(publicCode)
    this.name = 'HttpShimError'
  }
}

interface EventState {
  runHandle: string
  nextSequence: number
  phase: 'awaiting-accepted' | 'awaiting-started' | 'streaming' | 'terminal' | 'closed'
  terminalType?: 'turn.completed' | 'turn.failed' | 'turn.interrupted'
  lastEventId?: string
}

export async function runHostAgentShim(options: HostAgentShimOptions): Promise<number> {
  if (options.argv.length === 1 && options.argv[0] === '--version') {
    await write(options.stdout, `simulator-host-agent ${HOST_AGENT_CONTRACT_VERSION}\n`)
    return 0
  }
  if (options.argv.length !== 0) {
    diagnostic(options.stderr, 'INVALID_ARGUMENTS')
    return 2
  }

  let runHandle: string | undefined
  let terminal = false
  let closed = false
  let terminalType: EventState['terminalType']
  let environment: ValidatedEnvironment | undefined
  const fetchImpl = options.fetch ?? globalThis.fetch

  try {
    environment = await validateEnvironment(options)
    const prompt = await readPrompt(options.stdin, options.signal)
    const body = JSON.stringify({
      contractVersion: HOST_AGENT_CONTRACT_VERSION,
      prompt,
      workingDirectory: options.cwd,
    })
    if (Buffer.byteLength(body, 'utf8') > HOST_AGENT_LIMITS.maxRequestBodyBytes) {
      throw new ShimError('PAYLOAD_TOO_LARGE')
    }
    const idempotencyKey = `shim-${randomBytes(24).toString('hex')}`
    const created = await createRunWithRecovery(fetchImpl, environment, body, idempotencyKey, options.signal)
    runHandle = created.runHandle
    const state: EventState = {
      runHandle,
      nextSequence: 1,
      phase: 'awaiting-accepted',
    }
    let closePromise: Promise<HostAgentRunSnapshot> | undefined
    let reconnects = 0

    while (!closed) {
      try {
        await consumeEventStream({
          fetchImpl,
          environment,
          state,
          signal: options.signal,
          onEvent: async (event) => {
            validateEventTransition(state, event)
            await write(options.stdout, `${JSON.stringify(event)}\n`)
            if (isTerminal(event)) {
              terminal = true
              terminalType = event.type
              closePromise ??= closeRun(fetchImpl, environment!, runHandle!, options.signal)
              // Mark the original promise handled while SSE continues. Its
              // authoritative result is still awaited after run.closed.
              void closePromise.catch(() => undefined)
            } else if (event.type === 'run.closed') {
              closed = true
            }
          },
        })
        if (!closed) throw new ShimError('BROKER_DISCONNECTED')
      } catch (error) {
        if (options.signal.aborted) throw error
        if (error instanceof HttpShimError && error.publicCode === 'REPLAY_UNAVAILABLE') throw error
        if (closed || reconnects >= MAX_SSE_RECONNECTS) throw error
        reconnects += 1
        await delay(50 * reconnects, options.signal)
      }
    }
    if (!terminal || !terminalType || !closePromise) throw new ShimError('INVALID_EVENT_ORDER')
    const closeSnapshot = await closePromise
    if (closeSnapshot.runHandle !== runHandle || closeSnapshot.state !== 'closed') {
      throw new ShimError('INVALID_CLOSE_RESPONSE')
    }
    return terminalType === 'turn.completed' ? 0 : terminalType === 'turn.interrupted' ? 2 : 1
  } catch (error) {
    if (environment && runHandle && !closed) {
      await bestEffortCancelAndClose(fetchImpl, environment, runHandle)
    }
    diagnostic(options.stderr, options.signal.aborted ? 'CANCELLED' : publicDiagnostic(error))
    return options.signal.aborted ? 143 : 1
  }
}

async function validateEnvironment(options: HostAgentShimOptions): Promise<ValidatedEnvironment> {
  if (options.env.SIMULATOR_HOST_AGENT_CONTRACT_VERSION !== HOST_AGENT_ENV_CONTRACT_VERSION) {
    throw new ShimError('INVALID_CONTRACT_VERSION')
  }
  const rawUrl = requiredEnvironment(options.env, 'SIMULATOR_HOST_AGENT_URL')
  const tokenPath = requiredEnvironment(options.env, 'SIMULATOR_HOST_AGENT_TOKEN_FILE')
  const shimPath = requiredEnvironment(options.env, 'SIMULATOR_HOST_AGENT_SHIM_PATH')

  const url = new URL(rawUrl)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash || !url.port) {
    throw new ShimError('INVALID_HOST_URL')
  }

  const [actualEntry, expectedEntry] = await Promise.all([
    realpath(options.entryPath),
    realpath(shimPath),
  ])
  const left = Buffer.from(actualEntry)
  const right = Buffer.from(expectedEntry)
  if (left.byteLength !== right.byteLength || !timingSafeEqual(left, right)) {
    throw new ShimError('INVALID_SHIM_PATH')
  }
  const shimStat = await lstat(expectedEntry)
  if (!shimStat.isFile() || shimStat.isSymbolicLink()) throw new ShimError('INVALID_SHIM_PATH')

  if (!tokenPath.startsWith('/')) throw new ShimError('INVALID_TOKEN_FILE')
  const tokenStat = await lstat(tokenPath)
  if (!tokenStat.isFile() || tokenStat.isSymbolicLink()) throw new ShimError('INVALID_TOKEN_FILE')
  if (typeof process.getuid === 'function' && tokenStat.uid !== process.getuid()) {
    throw new ShimError('INVALID_TOKEN_FILE')
  }
  if (process.platform !== 'win32' && (tokenStat.mode & 0o077) !== 0) {
    throw new ShimError('INVALID_TOKEN_FILE')
  }
  const tokenBytes = await readFile(tokenPath)
  if (tokenBytes.byteLength < 16 || tokenBytes.byteLength > 513) throw new ShimError('INVALID_TOKEN_FILE')
  const token = new TextDecoder('utf-8', { fatal: true }).decode(tokenBytes).replace(/\n$/u, '')
  if (Buffer.byteLength(token, 'utf8') < 16 || Buffer.byteLength(token, 'utf8') > 512
    || /[\u0000-\u0020\u007f]/u.test(token)) {
    throw new ShimError('INVALID_TOKEN_FILE')
  }
  return { baseUrl: url.origin, token }
}

function requiredEnvironment(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > 4096) {
    throw new ShimError('INVALID_ENVIRONMENT')
  }
  return value
}

async function readPrompt(stream: Readable, signal: AbortSignal): Promise<string> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const raw of stream) {
    if (signal.aborted) throw new ShimError('CANCELLED')
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
    bytes += chunk.byteLength
    if (bytes > HOST_AGENT_LIMITS.maxPromptBytes) throw new ShimError('PAYLOAD_TOO_LARGE')
    chunks.push(chunk)
  }
  if (signal.aborted) throw new ShimError('CANCELLED')
  const input = Buffer.concat(chunks, bytes)
  if (input.byteLength === 0) throw new ShimError('INVALID_PROMPT')
  if (input[0] === 0xef && input[1] === 0xbb && input[2] === 0xbf) throw new ShimError('INVALID_PROMPT')
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(input)
  } catch {
    throw new ShimError('INVALID_PROMPT')
  }
}

async function createRunWithRecovery(
  fetchImpl: Fetch,
  environment: ValidatedEnvironment,
  body: string,
  idempotencyKey: string,
  signal: AbortSignal,
): Promise<HostAgentRunSnapshot> {
  let lastError: unknown
  for (let attempt = 1; attempt <= MAX_CREATE_ATTEMPTS; attempt += 1) {
    try {
      return await requestSnapshot(fetchImpl, environment, '/v2/runs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Idempotency-Key': idempotencyKey,
        },
        body,
        signal,
      })
    } catch (error) {
      lastError = error
      if (signal.aborted || (error instanceof HttpShimError && !error.retryable)) throw error
      if (attempt < MAX_CREATE_ATTEMPTS) await delay(50 * attempt, signal)
    }
  }
  throw lastError ?? new ShimError('RUNTIME_UNAVAILABLE')
}

async function consumeEventStream(input: {
  fetchImpl: Fetch
  environment: ValidatedEnvironment
  state: EventState
  signal: AbortSignal
  onEvent(event: HostAgentEvent): Promise<void>
}): Promise<void> {
  const headers: Record<string, string> = authorizationHeaders(input.environment)
  if (input.state.lastEventId !== undefined) headers['last-event-id'] = input.state.lastEventId
  const response = await fetchWithTimeout(input.fetchImpl, `${input.environment.baseUrl}/v2/runs/${input.state.runHandle}/events`, {
    method: 'GET',
    headers,
    signal: input.signal,
  }, REQUEST_TIMEOUT_MS, false)
  if (!response.ok) throw await responseError(response)
  if (!response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream')) {
    throw new ShimError('INVALID_EVENT_STREAM')
  }
  if (!response.body) throw new ShimError('BROKER_DISCONNECTED')

  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let buffered = ''
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      try {
        buffered += decoder.decode(value, { stream: true })
      } catch {
        throw new ShimError('INVALID_EVENT_STREAM')
      }
      if (Buffer.byteLength(buffered, 'utf8') > MAX_SSE_FRAME_BYTES) throw new ShimError('INVALID_EVENT_STREAM')
      let boundary: number
      while ((boundary = buffered.indexOf('\n\n')) >= 0) {
        const frame = buffered.slice(0, boundary)
        buffered = buffered.slice(boundary + 2)
        if (frame.startsWith(':')) continue
        const event = parseSseFrame(frame)
        await input.onEvent(event)
      }
    }
    try {
      buffered += decoder.decode()
    } catch {
      throw new ShimError('INVALID_EVENT_STREAM')
    }
    if (buffered.length !== 0) throw new ShimError('BROKER_DISCONNECTED')
  } finally {
    reader.releaseLock()
  }
}

function parseSseFrame(frame: string): HostAgentEvent {
  if (Buffer.byteLength(frame, 'utf8') > MAX_SSE_FRAME_BYTES || frame.includes('\r')) {
    throw new ShimError('INVALID_EVENT_STREAM')
  }
  const fields = new Map<string, string>()
  for (const line of frame.split('\n')) {
    const separator = line.indexOf(':')
    if (separator < 1) throw new ShimError('INVALID_EVENT_STREAM')
    const key = line.slice(0, separator)
    const value = line.slice(separator + 1).replace(/^ /u, '')
    if (!['id', 'event', 'data'].includes(key) || fields.has(key)) throw new ShimError('INVALID_EVENT_STREAM')
    fields.set(key, value)
  }
  if (fields.get('event') !== HOST_AGENT_SSE_EVENT || !fields.has('id') || !fields.has('data')) {
    throw new ShimError('INVALID_EVENT_STREAM')
  }
  const raw = Buffer.from(fields.get('data')!, 'utf8')
  const event = parseHostAgentEvent(parseHostAgentJsonBytes(raw, HOST_AGENT_LIMITS.maxEventBytes))
  if (event.eventId !== fields.get('id')) throw new ShimError('INVALID_EVENT_STREAM')
  return event
}

function validateEventTransition(state: EventState, event: HostAgentEvent): void {
  if (event.runHandle !== state.runHandle || event.sequence !== state.nextSequence
    || event.eventId !== String(event.sequence)) {
    throw new ShimError('INVALID_EVENT_ORDER')
  }
  switch (state.phase) {
    case 'awaiting-accepted':
      if (event.type !== 'run.accepted') throw new ShimError('INVALID_EVENT_ORDER')
      state.phase = 'awaiting-started'
      break
    case 'awaiting-started':
      if (event.type !== 'turn.started') throw new ShimError('INVALID_EVENT_ORDER')
      state.phase = 'streaming'
      break
    case 'streaming':
      if (event.type === 'run.accepted' || event.type === 'turn.started' || event.type === 'run.closed') {
        throw new ShimError('INVALID_EVENT_ORDER')
      }
      if (isTerminal(event)) {
        state.terminalType = event.type
        state.phase = 'terminal'
      }
      break
    case 'terminal':
      if (event.type !== 'run.closed') throw new ShimError('INVALID_EVENT_ORDER')
      state.phase = 'closed'
      break
    case 'closed':
      throw new ShimError('INVALID_EVENT_ORDER')
  }
  state.lastEventId = event.eventId
  state.nextSequence += 1
}

function isTerminal(event: HostAgentEvent): event is Extract<HostAgentEvent, {
  type: 'turn.completed' | 'turn.failed' | 'turn.interrupted'
}> {
  return event.type === 'turn.completed' || event.type === 'turn.failed' || event.type === 'turn.interrupted'
}

async function closeRun(
  fetchImpl: Fetch,
  environment: ValidatedEnvironment,
  runHandle: string,
  signal: AbortSignal,
): Promise<HostAgentRunSnapshot> {
  return requestSnapshot(fetchImpl, environment, `/v2/runs/${runHandle}`, {
    method: 'DELETE',
    headers: {},
    signal,
  })
}

async function bestEffortCancelAndClose(
  fetchImpl: Fetch,
  environment: ValidatedEnvironment,
  runHandle: string,
): Promise<void> {
  const timeout = AbortSignal.timeout(CLEANUP_TIMEOUT_MS)
  try {
    await requestSnapshot(fetchImpl, environment, `/v2/runs/${runHandle}/cancel`, {
      method: 'POST', headers: {}, signal: timeout,
    })
  } catch {}
  try {
    await requestSnapshot(fetchImpl, environment, `/v2/runs/${runHandle}`, {
      method: 'DELETE', headers: {}, signal: timeout,
    })
  } catch {}
}

async function requestSnapshot(
  fetchImpl: Fetch,
  environment: ValidatedEnvironment,
  path: string,
  init: RequestInit,
): Promise<HostAgentRunSnapshot> {
  const response = await fetchWithTimeout(fetchImpl, `${environment.baseUrl}${path}`, {
    ...init,
    headers: { ...authorizationHeaders(environment), ...(init.headers ?? {}) },
  }, REQUEST_TIMEOUT_MS)
  const bytes = await readResponseBytes(response, MAX_HTTP_RESPONSE_BYTES)
  if (!response.ok) throw parseResponseError(bytes)
  return parseHostAgentRunSnapshot(parseHostAgentJsonBytes(bytes, MAX_HTTP_RESPONSE_BYTES))
}

async function responseError(response: Response): Promise<HttpShimError> {
  return parseResponseError(await readResponseBytes(response, MAX_HTTP_RESPONSE_BYTES))
}

function parseResponseError(bytes: Uint8Array): HttpShimError {
  try {
    const parsed = parseHostAgentErrorResponse(parseHostAgentJsonBytes(bytes, MAX_HTTP_RESPONSE_BYTES))
    return new HttpShimError(parsed.error.code, parsed.error.retryable)
  } catch {
    return new HttpShimError('INVALID_HOST_RESPONSE', false)
  }
}

async function readResponseBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = response.headers.get('content-length')
  if (declared && Number(declared) > maxBytes) throw new ShimError('INVALID_HOST_RESPONSE')
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > maxBytes) throw new ShimError('INVALID_HOST_RESPONSE')
  return bytes
}

function authorizationHeaders(environment: ValidatedEnvironment): Record<string, string> {
  return { Authorization: `Bearer ${environment.token}` }
}

async function fetchWithTimeout(
  fetchImpl: Fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  applyTimeout = true,
): Promise<Response> {
  const signal = applyTimeout
    ? AbortSignal.any([init.signal as AbortSignal, AbortSignal.timeout(timeoutMs)])
    : init.signal
  return fetchImpl(url, { ...init, signal })
}

async function write(stream: Writable, value: string): Promise<void> {
  if (stream.write(value)) return
  await once(stream, 'drain')
}

function diagnostic(stream: Writable, code: string): void {
  const safe = /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'INTERNAL_ERROR'
  stream.write(`[simulator-host-agent] ${safe}\n`)
}

function publicDiagnostic(error: unknown): string {
  return error instanceof ShimError ? error.publicCode : 'RUNTIME_UNAVAILABLE'
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new ShimError('CANCELLED')
  await new Promise<void>((resolve, reject) => {
    const finish = (): void => {
      signal.removeEventListener('abort', abort)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    const abort = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      reject(new ShimError('CANCELLED'))
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}

/** Used by artifact smoke tests without opening a run. */
export async function probeCapabilities(fetchImpl: Fetch, baseUrl: string, token: string): Promise<void> {
  const response = await fetchImpl(`${baseUrl}/v2/capabilities`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const bytes = await readResponseBytes(response, MAX_HTTP_RESPONSE_BYTES)
  if (!response.ok) throw parseResponseError(bytes)
  parseHostAgentCapabilitiesResponse(parseHostAgentJsonBytes(bytes, MAX_HTTP_RESPONSE_BYTES))
}
