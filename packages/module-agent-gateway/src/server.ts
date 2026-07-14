import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdir, chmod, lstat, open, unlink } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import {
  MODULE_AGENT_CONTRACT_VERSION,
  MODULE_AGENT_ENV,
  MODULE_AGENT_SSE_EVENT,
  ModuleAgentGatewayError,
  type CancelModuleAgentTurnRequest,
  type CreateModuleAgentSessionRequest,
  type ModuleAgentAuthorization,
  type ModuleAgentEvent,
  type ModuleAgentGrantSpec,
  type StartModuleAgentTurnRequest,
} from './types.ts'
import { ModuleAgentGateway } from './gateway.ts'

async function unlinkTokenFile(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

export interface ModuleAgentGatewayServerOptions {
  host?: '127.0.0.1'
  port?: number
  keepAliveMs?: number
  maxJsonOverheadBytes?: number
}

export interface ModuleAgentLaunchLease {
  grantToken: string
  tokenFile: string
  environment: Readonly<Record<(typeof MODULE_AGENT_ENV)[keyof typeof MODULE_AGENT_ENV], string>>
  authorization: ModuleAgentAuthorization
  dispose(): Promise<void>
}

export class ModuleAgentGatewayServer {
  readonly #gateway: ModuleAgentGateway
  readonly #options: Required<ModuleAgentGatewayServerOptions>
  readonly #leases = new Map<string, ModuleAgentLaunchLease>()
  #server?: Server
  #url?: string

  constructor(gateway: ModuleAgentGateway, options: ModuleAgentGatewayServerOptions = {}) {
    this.#gateway = gateway
    this.#options = {
      host: options.host ?? '127.0.0.1',
      port: options.port ?? 0,
      keepAliveMs: options.keepAliveMs ?? 15_000,
      maxJsonOverheadBytes: options.maxJsonOverheadBytes ?? 8 * 1024,
    }
  }

  get url(): string {
    if (!this.#url) throw new Error('Module Agent Gateway server is not listening')
    return this.#url
  }

  async start(): Promise<string> {
    if (this.#server) return this.url
    const server = createServer((request, response) => {
      void this.#handle(request, response)
    })
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error)
      server.once('error', onError)
      server.listen(this.#options.port, this.#options.host, () => {
        server.off('error', onError)
        resolve()
      })
    })
    const address = server.address()
    if (!address || typeof address === 'string') {
      server.close()
      throw new Error('Module Agent Gateway failed to bind a TCP port')
    }
    this.#server = server
    this.#url = `http://${this.#options.host}:${address.port}`
    return this.#url
  }

  async prepareLaunch(spec: ModuleAgentGrantSpec, tokenDirectory: string): Promise<ModuleAgentLaunchLease> {
    if (!this.#server || !this.#url) throw new Error('Start the Module Agent Gateway server before preparing a launch')
    if (!isAbsolute(tokenDirectory)) throw new Error('Module Agent token directory must be absolute')
    const grant = await this.#gateway.issueGrant(spec)
    const tokenFile = join(tokenDirectory, `.module-agent-${grant.grantToken.slice(0, 16)}.token`)
    let fileCreated = false
    try {
      await mkdir(tokenDirectory, { recursive: true, mode: 0o700 })
      await chmod(tokenDirectory, 0o700)
      const directoryStat = await lstat(tokenDirectory)
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || (directoryStat.mode & 0o077) !== 0
        || (typeof process.getuid === 'function' && directoryStat.uid !== process.getuid())) {
        throw new Error('Module Agent token directory did not satisfy owner-only directory policy')
      }
      const file = await open(tokenFile, 'wx', 0o600)
      fileCreated = true
      try {
        await file.writeFile(`${grant.grantToken}\n`, { encoding: 'utf8' })
        await file.sync()
      } finally {
        await file.close()
      }
      await chmod(tokenFile, 0o600)
      const stat = await lstat(tokenFile)
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0
        || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
        throw new Error('Module Agent token file did not satisfy owner-only regular-file policy')
      }
    } catch (error) {
      if (fileCreated) await unlinkTokenFile(tokenFile).catch(() => undefined)
      await this.#gateway.revokeGrant(grant.grantToken)
      throw error
    }

    let disposed = false
    let disposal: Promise<void> | undefined
    let expiryTimer: ReturnType<typeof setTimeout> | undefined
    const authorization = this.#gateway.authorizationForGrant(grant.grantToken)
    const lease: ModuleAgentLaunchLease = {
      grantToken: grant.grantToken,
      tokenFile,
      environment: Object.freeze({
        [MODULE_AGENT_ENV.url]: this.#url,
        [MODULE_AGENT_ENV.tokenFile]: tokenFile,
      }) as ModuleAgentLaunchLease['environment'],
      authorization,
      dispose: async () => {
        if (disposed) return
        if (disposal) return disposal
        disposal = (async () => {
          if (expiryTimer) clearTimeout(expiryTimer)
          await this.#gateway.revokeGrant(grant.grantToken)
          await unlinkTokenFile(tokenFile)
          disposed = true
          this.#leases.delete(grant.grantToken)
        })()
        try {
          await disposal
        } finally {
          if (!disposed) disposal = undefined
        }
      },
    }
    this.#leases.set(grant.grantToken, lease)
    expiryTimer = setTimeout(() => {
      void lease.dispose().catch(() => undefined)
    }, Math.max(1, Math.min(2_147_483_647, spec.expiresAt - Date.now())))
    expiryTimer.unref()
    return lease
  }

  async stop(): Promise<void> {
    let firstError: unknown
    for (const lease of [...this.#leases.values()]) {
      try {
        await lease.dispose()
      } catch (error) {
        firstError ??= error
      }
    }
    const server = this.#server
    this.#server = undefined
    this.#url = undefined
    if (server) {
      server.closeAllConnections?.()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    if (firstError) throw firstError
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    try {
      const authorization = this.#authorization(request)
      const url = new URL(request.url ?? '/', this.#url)
      const pathname = url.pathname

      if (request.method === 'GET' && pathname === '/v1/capabilities') {
        this.#json(response, 200, this.#gateway.getCapabilities(authorization))
        return
      }
      if (request.method === 'POST' && pathname === '/v1/module-sessions') {
        const body = await this.#jsonBody<CreateModuleAgentSessionRequest>(request)
        this.#exactKeys(body, ['contractVersion', 'workingDirectory'])
        this.#json(response, 201, await this.#gateway.createSession(authorization, body))
        return
      }

      const match = /^\/v1\/module-sessions\/(session_[0-9a-f]{32})(?:\/(turns|events|cancel))?$/.exec(pathname)
      if (!match) {
        this.#jsonError(response, 404, 'INVALID_REQUEST')
        return
      }
      const sessionHandle = match[1]!
      const action = match[2]
      if (request.method === 'POST' && action === 'turns') {
        const body = await this.#jsonBody<StartModuleAgentTurnRequest>(request)
        this.#exactKeys(body, ['contractVersion', 'prompt'])
        this.#json(response, 202, await this.#gateway.startTurn(authorization, sessionHandle, body))
        return
      }
      if (request.method === 'POST' && action === 'cancel') {
        const body = await this.#jsonBody<CancelModuleAgentTurnRequest>(request)
        this.#exactKeys(body, ['contractVersion'])
        if (body.contractVersion !== MODULE_AGENT_CONTRACT_VERSION) {
          throw new ModuleAgentGatewayError('INVALID_CONTRACT_VERSION', 'Unsupported contract version')
        }
        this.#json(response, 202, await this.#gateway.cancelTurn(authorization, sessionHandle))
        return
      }
      if (request.method === 'GET' && action === 'events') {
        const queryKeys = [...url.searchParams.keys()]
        if (queryKeys.some((key) => key !== 'afterSequence') || url.searchParams.getAll('afterSequence').length > 1) {
          throw new ModuleAgentGatewayError('INVALID_REQUEST', 'Unknown or repeated events query parameter')
        }
        const rawAfter = url.searchParams.get('afterSequence') ?? '0'
        if (!/^(0|[1-9][0-9]*)$/.test(rawAfter)) {
          throw new ModuleAgentGatewayError('INVALID_REQUEST', 'Invalid afterSequence')
        }
        this.#stream(response, authorization, sessionHandle, Number(rawAfter))
        return
      }
      if (request.method === 'DELETE' && action === undefined) {
        await this.#gateway.closeSession(authorization, sessionHandle)
        response.statusCode = 204
        response.end()
        return
      }
      this.#jsonError(response, 405, 'INVALID_REQUEST')
    } catch (error) {
      if (response.headersSent) {
        response.end()
        return
      }
      if (error instanceof ModuleAgentGatewayError) {
        const status = error.code === 'UNAUTHORIZED' || error.code === 'GRANT_EXPIRED' || error.code === 'GRANT_REVOKED'
          ? 401
          : error.code === 'SESSION_NOT_FOUND'
            ? 404
            : error.code === 'TURN_ACTIVE' || error.code === 'SESSION_LIMIT' || error.code === 'SUBSCRIBER_LIMIT'
              || error.code === 'REPLAY_TRUNCATED'
              ? 409
              : error.code === 'HOST_RUNTIME_ERROR'
                ? 502
                : 400
        this.#jsonError(response, status, error.code)
        return
      }
      this.#jsonError(response, 500, 'HOST_RUNTIME_ERROR')
    }
  }

  #authorization(request: IncomingMessage): ModuleAgentAuthorization {
    const header = request.headers.authorization
    const match = typeof header === 'string' ? /^Bearer ([0-9a-f]{64})$/.exec(header) : null
    if (!match) throw new ModuleAgentGatewayError('UNAUTHORIZED', 'Missing launch bearer')
    return this.#gateway.authorizationForGrant(match[1]!)
  }

  async #jsonBody<T extends object>(request: IncomingMessage): Promise<T> {
    const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
    if (contentType !== 'application/json') {
      throw new ModuleAgentGatewayError('INVALID_REQUEST', 'application/json is required')
    }
    const chunks: Buffer[] = []
    let bytes = 0
    const max = this.#gateway.limits.maxPromptBytes + this.#options.maxJsonOverheadBytes
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytes += buffer.byteLength
      if (bytes > max) throw new ModuleAgentGatewayError('PROMPT_TOO_LARGE', 'Request body is too large')
      chunks.push(buffer)
    }
    try {
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
      return parsed as T
    } catch {
      throw new ModuleAgentGatewayError('INVALID_REQUEST', 'Malformed JSON request')
    }
  }

  #exactKeys(value: object, allowed: readonly string[]): void {
    const allowedSet = new Set(allowed)
    if (Object.keys(value).some((key) => !allowedSet.has(key))) {
      throw new ModuleAgentGatewayError('INVALID_REQUEST', 'Unknown request field')
    }
  }

  #stream(
    response: ServerResponse,
    authorization: ModuleAgentAuthorization,
    sessionHandle: string,
    afterSequence: number,
  ): void {
    let ended = false
    let live = false
    const replay: ModuleAgentEvent[] = []
    let subscription: ReturnType<ModuleAgentGateway['subscribe']> | undefined
    const listener = (event: ModuleAgentEvent) => {
      if (ended) return
      if (!live) {
        replay.push(event)
        return
      }
      this.#writeEvent(response, event)
      if (event.type === 'session.closed') finish()
    }
    // Authorize handle and establish replay before committing HTTP 200. This
    // preserves structured 401/404 errors for invalid subscriptions.
    subscription = this.#gateway.subscribe(authorization, sessionHandle, afterSequence, listener)
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      Connection: 'keep-alive',
      'Cache-Control': 'no-store, no-transform',
    })
    const finish = () => {
      if (ended) return
      ended = true
      clearInterval(keepAlive)
      subscription?.unsubscribe()
      response.end()
    }
    const keepAlive = setInterval(() => {
      if (!ended) response.write(': keepalive\n\n')
    }, this.#options.keepAliveMs)
    keepAlive.unref()
    response.on('close', finish)
    live = true
    for (const event of replay) this.#writeEvent(response, event)
  }

  #writeEvent(response: ServerResponse, event: ModuleAgentEvent): void {
    response.write(`event: ${MODULE_AGENT_SSE_EVENT}\nid: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`)
  }

  #json(response: ServerResponse, status: number, body: unknown): void {
    response.statusCode = status
    response.setHeader('Content-Type', 'application/json; charset=utf-8')
    response.end(JSON.stringify(body))
  }

  #jsonError(response: ServerResponse, status: number, code: string): void {
    this.#json(response, status, {
      contractVersion: MODULE_AGENT_CONTRACT_VERSION,
      error: { code },
    })
  }
}
