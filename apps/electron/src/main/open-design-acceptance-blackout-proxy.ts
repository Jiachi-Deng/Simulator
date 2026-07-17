import { randomUUID } from 'node:crypto'
import { accessSync, constants as fsConstants, lstatSync, realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import {
  parseOpenDesignBlackoutArmResult,
  parseOpenDesignBlackoutEvidence,
  type OpenDesignBlackoutArmRequest,
  type OpenDesignBlackoutArmResult,
  type OpenDesignBlackoutCapability,
  type OpenDesignBlackoutEvidence,
  type OpenDesignBlackoutEvidenceRequest,
} from '../shared/open-design-acceptance-ipc'
export const OPEN_DESIGN_BLACKOUT_PROXY_BUN_ENV = 'SIMULATOR_HOST_AGENT_BLACKOUT_PROXY_BUN_PATH' as const
export const OPEN_DESIGN_BLACKOUT_PROXY_SCRIPT_ENV = 'SIMULATOR_HOST_AGENT_BLACKOUT_PROXY_SCRIPT_PATH' as const
export const OPEN_DESIGN_BLACKOUT_PROXY_PRODUCER = 'external-host-agent-sse-proxy' as const
export const OPEN_DESIGN_BLACKOUT_PROXY_MS = 65_000 as const
export const OPEN_DESIGN_BLACKOUT_PROXY_HEARTBEAT_MS = 10_000 as const

const LOOPBACK_HOST = '127.0.0.1'
const CONTROL_TIMEOUT_MS = 10_000
const STOP_TIMEOUT_MS = 5_000
const MAX_STDOUT_LINE_BYTES = 2 * 1024 * 1024
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

type JsonRecord = Record<string, unknown>

export interface OpenDesignAcceptanceBlackoutProxyLaunchLease {
  readonly url: string
  cleanup(): Promise<void>
}

export interface OpenDesignAcceptanceBlackoutProxyPort {
  getCapability(): OpenDesignBlackoutCapability
  armNextBlackout(request: OpenDesignBlackoutArmRequest): Promise<OpenDesignBlackoutArmResult>
  takeBlackoutEvidence(request: OpenDesignBlackoutEvidenceRequest): Promise<OpenDesignBlackoutEvidence>
  prepareLaunch(input: Readonly<{ upstreamBaseUrl: string; tokenFile: string }>): Promise<OpenDesignAcceptanceBlackoutProxyLaunchLease>
  dispose(): Promise<void>
}

export interface OpenDesignAcceptanceBlackoutProxyOptions {
  readonly bunPath: string
  readonly scriptPath: string
  /** Deterministic process seam. Production always uses node:child_process. */
  readonly spawnChild?: typeof spawn
  readonly controlTimeoutMs?: number
  readonly stopTimeoutMs?: number
}

function exactRecord(value: unknown, fields: readonly string[]): JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError('Blackout proxy response is invalid')
  const actual = Object.keys(value as JsonRecord).sort()
  const expected = [...fields].sort()
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    throw new TypeError('Blackout proxy response is invalid')
  }
  return value as JsonRecord
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function requireExternalFile(path: string, executable: boolean): string {
  const normalized = resolve(path)
  if (normalized !== path) throw new TypeError('Acceptance proxy path must be normalized and absolute')
  const metadata = lstatSync(normalized)
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
    || realpathSync(normalized) !== normalized) {
    throw new TypeError('Acceptance proxy resource must be a canonical unique regular file')
  }
  const trustedOwner = typeof process.getuid !== 'function' || metadata.uid === process.getuid() || metadata.uid === 0
  if (!trustedOwner || (process.platform !== 'win32' && (metadata.mode & 0o022) !== 0)) {
    throw new TypeError('Acceptance proxy resource ownership is invalid')
  }
  if (executable && process.platform !== 'win32') {
    try { accessSync(normalized, fsConstants.X_OK) } catch {
      throw new TypeError('Acceptance proxy runtime is not executable')
    }
  }
  return normalized
}

function delay(delayMs: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs))
}

interface PendingResponse {
  readonly requestId: string
  readonly resolve: (value: JsonRecord) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

class BlackoutProxyChildSession {
  readonly #child: ChildProcessWithoutNullStreams
  readonly #controlTimeoutMs: number
  readonly #stopTimeoutMs: number
  readonly #onExit: () => void
  #stdout = Buffer.alloc(0)
  #pending?: PendingResponse
  #exited = false
  #closed = false

  constructor(
    child: ChildProcessWithoutNullStreams,
    controlTimeoutMs: number,
    stopTimeoutMs: number,
    onExit: () => void,
  ) {
    this.#child = child
    this.#controlTimeoutMs = controlTimeoutMs
    this.#stopTimeoutMs = stopTimeoutMs
    this.#onExit = onExit
    child.stdout.on('data', (raw: Buffer | string) => this.#receive(Buffer.from(raw)))
    child.stdout.once('error', () => this.#fail(new Error('Blackout proxy stdout failed')))
    child.stdin.once('error', () => this.#fail(new Error('Blackout proxy stdin failed')))
    child.once('error', () => this.#fail(new Error('Blackout proxy process failed')))
    child.once('exit', () => {
      this.#exited = true
      this.#fail(new Error('Blackout proxy process exited'))
      this.#onExit()
    })
  }

  async request(command: JsonRecord, allowClosing = false): Promise<JsonRecord> {
    if ((this.#closed && !allowClosing) || this.#exited || this.#pending) {
      throw new TypeError('Blackout proxy control is unavailable')
    }
    const requestId = command.requestId
    if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) throw new TypeError('Blackout proxy request ID is invalid')
    const line = `${JSON.stringify(command)}\n`
    if (Buffer.byteLength(line, 'utf8') > 32 * 1024) throw new TypeError('Blackout proxy control request is too large')
    const response = new Promise<JsonRecord>((resolveResponse, rejectResponse) => {
      const timer = setTimeout(() => {
        if (this.#pending?.requestId !== requestId) return
        this.#pending = undefined
        rejectResponse(new Error('Blackout proxy control timed out'))
        void this.close()
      }, this.#controlTimeoutMs)
      timer.unref?.()
      this.#pending = { requestId, resolve: resolveResponse, reject: rejectResponse, timer }
    })
    this.#child.stdin.write(line)
    return await response
  }

  async close(): Promise<void> {
    if (this.#exited) return
    const firstClose = !this.#closed
    this.#closed = true
    if (firstClose && !this.#exited) {
      try {
        // close() owns the lane, so no renderer action can race shutdown.
        if (!this.#pending) {
          await this.request(
            { schemaVersion: 1, command: 'shutdown', requestId: `shutdown-${randomUUID()}` },
            true,
          )
        }
      } catch {
        this.#closed = true
      }
    }
    this.#child.stdin.end()
    if (!this.#exited) this.#child.kill('SIGTERM')
    await Promise.race([new Promise<void>((resolveExit) => this.#child.once('exit', () => resolveExit())), delay(this.#stopTimeoutMs)])
    if (!this.#exited) {
      this.#child.kill('SIGKILL')
      await Promise.race([new Promise<void>((resolveExit) => this.#child.once('exit', () => resolveExit())), delay(this.#stopTimeoutMs)])
    }
    if (!this.#exited) throw new Error('Blackout proxy process did not exit')
    this.#fail(new Error('Blackout proxy control closed'))
  }

  #receive(chunk: Buffer): void {
    if (this.#exited) return
    this.#stdout = Buffer.concat([this.#stdout, chunk])
    if (this.#stdout.byteLength > MAX_STDOUT_LINE_BYTES) {
      this.#fail(new Error('Blackout proxy response is too large'))
      void this.close()
      return
    }
    while (true) {
      const boundary = this.#stdout.indexOf(0x0a)
      if (boundary < 0) break
      const line = this.#stdout.subarray(0, boundary)
      this.#stdout = this.#stdout.subarray(boundary + 1)
      if (line.byteLength === 0) {
        this.#fail(new Error('Blackout proxy emitted an empty response'))
        void this.close()
        return
      }
      let value: unknown
      try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)) } catch {
        this.#fail(new Error('Blackout proxy emitted invalid JSON'))
        void this.close()
        return
      }
      const pending = this.#pending
      if (!pending) {
        void this.close()
        return
      }
      let envelope: JsonRecord
      try {
        const record = value as JsonRecord
        envelope = exactRecord(value, record?.type === 'error'
          ? ['code', 'requestId', 'schemaVersion', 'type']
          : record?.type === 'ready'
            ? ['blackoutMs', 'heartbeatMs', 'port', 'producer', 'requestId', 'schemaVersion', 'type']
            : record?.type === 'stopped'
              ? ['requestId', 'schemaVersion', 'type']
              : ['requestId', 'result', 'schemaVersion', 'type'])
        if (envelope.schemaVersion !== 1 || envelope.requestId !== pending.requestId) {
          throw new TypeError('Blackout proxy response identity is invalid')
        }
      } catch {
        this.#fail(new Error('Blackout proxy emitted an invalid response'))
        void this.close()
        return
      }
      this.#pending = undefined
      clearTimeout(pending.timer)
      if (envelope.type === 'error') pending.reject(new Error(
        typeof envelope.code === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(envelope.code)
          ? envelope.code
          : 'BLACKOUT_PROXY_FAILED',
      ))
      else pending.resolve(envelope)
    }
  }

  #fail(error: Error): void {
    const pending = this.#pending
    this.#pending = undefined
    if (pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
  }
}

export class OpenDesignAcceptanceBlackoutProxy implements OpenDesignAcceptanceBlackoutProxyPort {
  readonly #bunPath: string
  readonly #scriptPath: string
  readonly #spawnChild: typeof spawn
  readonly #controlTimeoutMs: number
  readonly #stopTimeoutMs: number
  #session?: BlackoutProxyChildSession
  #disposed = false

  constructor(options: OpenDesignAcceptanceBlackoutProxyOptions) {
    this.#bunPath = requireExternalFile(options.bunPath, true)
    this.#scriptPath = requireExternalFile(options.scriptPath, false)
    this.#spawnChild = options.spawnChild ?? spawn
    this.#controlTimeoutMs = options.controlTimeoutMs ?? CONTROL_TIMEOUT_MS
    this.#stopTimeoutMs = options.stopTimeoutMs ?? STOP_TIMEOUT_MS
    if (!positiveInteger(this.#controlTimeoutMs) || !positiveInteger(this.#stopTimeoutMs)) {
      throw new TypeError('Blackout proxy control timing is invalid')
    }
  }

  getCapability(): OpenDesignBlackoutCapability {
    if (this.#disposed) throw new TypeError('Blackout proxy is disposed')
    return Object.freeze({
      schemaVersion: 1,
      available: true,
      producer: OPEN_DESIGN_BLACKOUT_PROXY_PRODUCER,
      blackoutMs: OPEN_DESIGN_BLACKOUT_PROXY_MS,
      heartbeatMs: OPEN_DESIGN_BLACKOUT_PROXY_HEARTBEAT_MS,
    })
  }

  async armNextBlackout(request: OpenDesignBlackoutArmRequest): Promise<OpenDesignBlackoutArmResult> {
    const response = await this.#requireSession().request({
      schemaVersion: 1,
      command: 'arm',
      requestId: `arm-${randomUUID()}`,
      ...request,
    })
    if (response.type !== 'armed') throw new TypeError('Blackout proxy arm response is invalid')
    return parseOpenDesignBlackoutArmResult(response.result)
  }

  async takeBlackoutEvidence(request: OpenDesignBlackoutEvidenceRequest): Promise<OpenDesignBlackoutEvidence> {
    const response = await this.#requireSession().request({
      schemaVersion: 1,
      command: 'take',
      requestId: `take-${randomUUID()}`,
      ...request,
    })
    if (response.type !== 'evidence') throw new TypeError('Blackout proxy evidence response is invalid')
    return parseOpenDesignBlackoutEvidence(response.result)
  }

  async prepareLaunch(
    input: Readonly<{ upstreamBaseUrl: string; tokenFile: string }>,
  ): Promise<OpenDesignAcceptanceBlackoutProxyLaunchLease> {
    if (this.#disposed || this.#session) throw new TypeError('Blackout proxy launch is unavailable')
    const child = this.#spawnChild(this.#bunPath, [this.#scriptPath], {
      cwd: dirname(this.#scriptPath),
      env: {},
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams
    // The external script emits only a fixed generic failure marker; discard it
    // so no child-controlled value can enter Host logs.
    child.stderr.resume()
    let session: BlackoutProxyChildSession
    session = new BlackoutProxyChildSession(
      child,
      this.#controlTimeoutMs,
      this.#stopTimeoutMs,
      () => { if (this.#session === session) this.#session = undefined },
    )
    this.#session = session
    try {
      const response = await session.request({
        schemaVersion: 1,
        command: 'initialize',
        requestId: `initialize-${randomUUID()}`,
        upstreamBaseUrl: input.upstreamBaseUrl,
        tokenFile: input.tokenFile,
        blackoutMs: OPEN_DESIGN_BLACKOUT_PROXY_MS,
        heartbeatMs: OPEN_DESIGN_BLACKOUT_PROXY_HEARTBEAT_MS,
      })
      if (response.type !== 'ready' || response.producer !== OPEN_DESIGN_BLACKOUT_PROXY_PRODUCER
        || response.blackoutMs !== OPEN_DESIGN_BLACKOUT_PROXY_MS
        || response.heartbeatMs !== OPEN_DESIGN_BLACKOUT_PROXY_HEARTBEAT_MS
        || !positiveInteger(response.port) || response.port > 65_535) {
        throw new TypeError('Blackout proxy ready response is invalid')
      }
      const url = `http://${LOOPBACK_HOST}:${response.port}`
      let cleaned = false
      let cleanupPromise: Promise<void> | undefined
      return Object.freeze({
        url,
        cleanup: async () => {
          if (cleaned) return
          if (cleanupPromise) return await cleanupPromise
          const operation = session.close().then(() => {
            cleaned = true
            if (this.#session === session) this.#session = undefined
          })
          cleanupPromise = operation
          try { await operation } finally {
            if (cleanupPromise === operation) cleanupPromise = undefined
          }
        },
      })
    } catch (error) {
      if (this.#session === session) this.#session = undefined
      await session.close()
      throw error
    }
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    const session = this.#session
    this.#session = undefined
    await session?.close()
  }

  #requireSession(): BlackoutProxyChildSession {
    if (this.#disposed || !this.#session) throw new TypeError('Blackout proxy is not attached to an active v2 grant')
    return this.#session
  }
}

/** Called only after the packaged debug descriptor gate succeeds. */
export function loadOpenDesignAcceptanceBlackoutProxy(
  env: Readonly<Record<string, string | undefined>>,
): OpenDesignAcceptanceBlackoutProxy | undefined {
  const bunPath = env[OPEN_DESIGN_BLACKOUT_PROXY_BUN_ENV]
  const scriptPath = env[OPEN_DESIGN_BLACKOUT_PROXY_SCRIPT_ENV]
  if (bunPath === undefined && scriptPath === undefined) return undefined
  if (!bunPath || !scriptPath) throw new TypeError('Acceptance proxy configuration is incomplete')
  return new OpenDesignAcceptanceBlackoutProxy({ bunPath, scriptPath })
}
