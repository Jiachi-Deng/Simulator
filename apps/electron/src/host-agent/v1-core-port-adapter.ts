import { isAbsolute, relative } from 'node:path'
import {
  MessagePortByteCreditChannel,
  type HostAgentMessagePortLike,
} from '@simulator/host-agent-broker/message-port'
import type {
  CreateHostModuleSessionInput,
  ModuleAgentGrantSpec,
  ModuleAgentGatewaySnapshot,
  ModuleAgentPathAuthority,
  ModuleAgentPortEvent,
  ModuleAgentSessionPort,
} from '@simulator/module-agent-gateway'
import {
  parseV1RpcWireMessage,
  v1RpcLane,
  type V1HostRpcMethod,
  type V1HostRpcRequest,
  type V1HostRpcResponse,
  type V1WorkerRpcMethod,
  type V1WorkerRpcRequest,
  type V1WorkerRpcResponse,
} from './v1-wire'

interface GrantScope {
  scopeId: string
  workspaceId: string
  workspaceRoot: string
  authorizedWorkingRoot: string
  defaultWorkingDirectory: string
  rawWorkspaceRoot: string
  rawAuthorizedWorkingRoot: string
}

interface PendingWorkerCall {
  resolve(value: unknown): void
  reject(error: Error): void
}

function params(value: unknown, required: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object') throw new TypeError('Invalid v1 RPC parameters')
  const keys = Reflect.ownKeys(value)
  if (keys.length !== required.length || keys.some((key) => typeof key !== 'string' || !required.includes(key))) {
    throw new TypeError('Invalid v1 RPC parameters')
  }
  return value as Record<string, unknown>
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2 * 1024 * 1024) {
    throw new TypeError(`Invalid ${name}`)
  }
  return value
}

function subscriptionId(value: unknown): string {
  if (typeof value !== 'string' || !/^sub_[1-9][0-9]*$/.test(value)) throw new TypeError('Invalid subscription id')
  return value
}

function lexicallyWithin(candidate: string, root: string): boolean {
  if (!isAbsolute(candidate) || !isAbsolute(root)) return false
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function isTerminalTurnEvent(event: ModuleAgentPortEvent): boolean {
  return event.type === 'turn.completed'
    || event.type === 'turn.failed'
    || event.type === 'turn.cancelled'
}

/** Main-process authority boundary used only by the v1 Compatibility worker. */
export class V1CorePortAdapter {
  readonly #sessions: ModuleAgentSessionPort
  readonly #paths: ModuleAgentPathAuthority
  readonly #channel: MessagePortByteCreditChannel
  readonly #scopes = new Map<string, GrantScope>()
  readonly #ownedSessions = new Map<string, string>()
  readonly #activeTurns = new Set<string>()
  readonly #subscriptions = new Map<string, () => void>()
  readonly #pendingWorkerCalls = new Map<string, PendingWorkerCall>()
  readonly #requestTimeoutMs: number
  #nextWorkerRequest = 1
  #nextRemoteSession = 1
  #disconnected = false
  #disconnectAttempt?: Promise<void>

  constructor(options: {
    sessions: ModuleAgentSessionPort
    paths: ModuleAgentPathAuthority
    port: HostAgentMessagePortLike
    requestTimeoutMs?: number
  }) {
    this.#sessions = options.sessions
    this.#paths = options.paths
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 5_000
    if (!Number.isSafeInteger(this.#requestTimeoutMs) || this.#requestTimeoutMs < 1) {
      throw new TypeError('v1 worker request timeout must be positive')
    }
    this.#channel = new MessagePortByteCreditChannel(options.port)
    this.#channel.onMessage((payload) => this.#receive(payload))
    this.#channel.onDisconnect(() => this.#disconnectInBackground())
  }

  async registerGrantScope(scopeId: string, spec: ModuleAgentGrantSpec): Promise<void> {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(scopeId) || this.#scopes.has(scopeId)) throw new TypeError('Invalid v1 grant scope')
    const workspaceRoot = await this.#paths.canonicalize(spec.workspaceRoot)
    const authorizedWorkingRoot = await this.#paths.canonicalize(spec.authorizedWorkingRoot)
    const defaultWorkingDirectory = await this.#paths.canonicalize(spec.defaultWorkingDirectory)
    if (!await this.#paths.isEqualOrWithin(defaultWorkingDirectory, authorizedWorkingRoot)) {
      throw new TypeError('v1 default directory is outside its grant')
    }
    this.#scopes.set(scopeId, {
      scopeId,
      workspaceId: spec.workspaceId,
      workspaceRoot,
      authorizedWorkingRoot,
      defaultWorkingDirectory,
      rawWorkspaceRoot: spec.workspaceRoot,
      rawAuthorizedWorkingRoot: spec.authorizedWorkingRoot,
    })
  }

  unregisterGrantScope(scopeId: string): void { this.#scopes.delete(scopeId) }

  /**
   * Main-process lifecycle evidence. The worker-local HTTP snapshot can be
   * lost with the Utility Process, so closure checks use the authority that
   * actually owns grant scopes and Craft Sessions. A remote subscription is
   * counted conservatively while the worker still holds a Session event seam.
   */
  debugSnapshot(): ModuleAgentGatewaySnapshot {
    return {
      activeGrants: this.#scopes.size,
      activeSessions: this.#ownedSessions.size,
      activeTurns: this.#activeTurns.size,
      activeSubscribers: this.#subscriptions.size,
    }
  }

  async invokeWorker(method: V1WorkerRpcMethod, value: unknown): Promise<unknown> {
    if (this.#disconnected) throw new Error('v1 Compatibility worker disconnected')
    const requestId = `host_${this.#nextWorkerRequest++}`
    const request: V1WorkerRpcRequest = { kind: 'module-agent.worker.request', requestId, method, params: value }
    let timer: ReturnType<typeof setTimeout> | undefined
    const result = new Promise<unknown>((resolve, reject) => {
      timer = setTimeout(() => {
        if (!this.#pendingWorkerCalls.delete(requestId)) return
        reject(new Error('v1 Compatibility worker request timed out'))
        void this.disconnect()
      }, this.#requestTimeoutMs)
      this.#pendingWorkerCalls.set(requestId, {
        resolve: (value) => {
          if (timer) clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          if (timer) clearTimeout(timer)
          reject(error)
        },
      })
    })
    try { await this.#channel.send(request, v1RpcLane(method)) } catch (error) {
      this.#pendingWorkerCalls.delete(requestId)
      if (timer) clearTimeout(timer)
      throw error
    }
    return await result
  }

  async disconnect(): Promise<void> {
    if (!this.#disconnected) {
      this.#disconnected = true
      this.#channel.disconnect()
      for (const pending of this.#pendingWorkerCalls.values()) pending.reject(new Error('v1 Compatibility worker disconnected'))
      this.#pendingWorkerCalls.clear()
      for (const unsubscribe of this.#subscriptions.values()) unsubscribe()
      this.#subscriptions.clear()
    }
    if (this.#ownedSessions.size === 0) {
      this.#activeTurns.clear()
      this.#scopes.clear()
      return
    }
    if (this.#disconnectAttempt) return await this.#disconnectAttempt

    const attempt = Promise.all([...this.#ownedSessions.entries()].map(async ([remoteSessionId, sessionId]) => {
      await this.#sessions.disposeAndReap(sessionId)
      if (this.#ownedSessions.get(remoteSessionId) === sessionId) {
        this.#ownedSessions.delete(remoteSessionId)
        this.#activeTurns.delete(remoteSessionId)
      }
    })).then(() => { this.#scopes.clear() })
    this.#disconnectAttempt = attempt
    try {
      await attempt
    } finally {
      if (this.#disconnectAttempt === attempt) this.#disconnectAttempt = undefined
    }
  }

  #disconnectInBackground(): void {
    void this.disconnect().catch(() => {
      // Explicit runtime cleanup retries and reports a strict-reap failure.
    })
  }

  #receive(payload: unknown): void {
    const message = parseV1RpcWireMessage(payload)
    if (!message) return this.#disconnectInBackground()
    if (message.kind === 'module-agent.host.request') {
      void this.#dispatchHost(message)
      return
    }
    if (message.kind === 'module-agent.worker.response') {
      const pending = this.#pendingWorkerCalls.get(message.requestId)
      if (!pending) return this.#disconnectInBackground()
      this.#pendingWorkerCalls.delete(message.requestId)
      if (message.ok) pending.resolve(message.result)
      else pending.reject(new Error('v1 Compatibility worker request failed'))
      return
    }
    this.#disconnectInBackground()
  }

  async #dispatchHost(request: V1HostRpcRequest): Promise<void> {
    try {
      const result = await this.#invokeHost(request.method, request.params)
      const response: V1HostRpcResponse = {
        kind: 'module-agent.host.response', requestId: request.requestId, ok: true, result: result ?? null,
      }
      await this.#channel.send(response, v1RpcLane(request.method))
    } catch {
      const response: V1HostRpcResponse = {
        kind: 'module-agent.host.response', requestId: request.requestId, ok: false, error: { code: 'REQUEST_FAILED' },
      }
      try { await this.#channel.send(response, v1RpcLane(request.method)) } catch { await this.disconnect() }
    }
  }

  async #invokeHost(method: V1HostRpcMethod, value: unknown): Promise<unknown> {
    if (method === 'path.canonicalize') {
      const input = params(value, ['path'])
      const path = text(input.path, 'path')
      if (!this.#isLexicallyAuthorized(path)) throw new TypeError('Path is outside v1 grants')
      const canonical = await this.#paths.canonicalize(path)
      if (!await this.#isCanonicallyAuthorized(canonical)) throw new TypeError('Canonical path is outside v1 grants')
      return canonical
    }
    if (method === 'path.isEqualOrWithin') {
      const input = params(value, ['candidate', 'root'])
      const candidate = text(input.candidate, 'candidate')
      const root = text(input.root, 'root')
      if (!await this.#isCanonicallyAuthorized(candidate) || !await this.#isCanonicallyAuthorized(root)) {
        throw new TypeError('Path comparison is outside v1 grants')
      }
      return await this.#paths.isEqualOrWithin(candidate, root)
    }
    if (method === 'session.create') {
      const rawInput = params(value, ['input']).input
      if (!rawInput || typeof rawInput !== 'object') throw new TypeError('Invalid Session input')
      const inputKeys = Reflect.ownKeys(rawInput)
      const expectedInputKeys = ['workspaceId', 'workspaceRoot', 'authorizedWorkingRoot', 'workingDirectory']
      if (inputKeys.length !== expectedInputKeys.length
        || inputKeys.some((key) => typeof key !== 'string' || !expectedInputKeys.includes(key))) {
        throw new TypeError('Invalid Session input')
      }
      const raw = rawInput as Record<string, unknown>
      const input: CreateHostModuleSessionInput = {
        workspaceId: text(raw.workspaceId, 'workspace id'),
        workspaceRoot: text(raw.workspaceRoot, 'workspace root'),
        authorizedWorkingRoot: text(raw.authorizedWorkingRoot, 'authorized root'),
        workingDirectory: text(raw.workingDirectory, 'working directory'),
      }
      const scope = [...this.#scopes.values()].find((candidate) =>
        input.workspaceId === candidate.workspaceId
        && input.workspaceRoot === candidate.workspaceRoot
        && input.authorizedWorkingRoot === candidate.authorizedWorkingRoot)
      if (!scope || !await this.#paths.isEqualOrWithin(input.workingDirectory, scope.authorizedWorkingRoot)) {
        throw new TypeError('Session input is outside v1 grant')
      }
      const created = await this.#sessions.createSession(input)
      const remoteSessionId = `remote_${this.#nextRemoteSession++}`
      this.#ownedSessions.set(remoteSessionId, created.sessionId)
      return { ...created, sessionId: remoteSessionId }
    }
    if (method === 'session.subscribe') {
      const input = params(value, ['sessionId', 'subscriptionId'])
      const remoteSessionId = this.#remoteSessionId(input.sessionId)
      const sessionId = this.#ownedSession(remoteSessionId)
      const id = subscriptionId(input.subscriptionId)
      if (this.#subscriptions.has(id)) throw new TypeError('Duplicate subscription')
      const unsubscribe = await this.#sessions.subscribe(sessionId, (event) => {
        if (isTerminalTurnEvent(event)) this.#activeTurns.delete(remoteSessionId)
        void this.#channel.send({
          kind: 'module-agent.host.event',
          subscriptionId: id,
          event: { ...event, sessionId: remoteSessionId },
        }, 'business')
          .catch(() => this.#disconnectInBackground())
      })
      this.#subscriptions.set(id, unsubscribe)
      return null
    }
    if (method === 'session.unsubscribe') {
      const input = params(value, ['subscriptionId'])
      const id = subscriptionId(input.subscriptionId)
      this.#subscriptions.get(id)?.()
      this.#subscriptions.delete(id)
      return null
    }
    const input = params(value, method === 'session.sendTurn' ? ['sessionId', 'prompt'] : ['sessionId'])
    const remoteSessionId = this.#remoteSessionId(input.sessionId)
    const sessionId = this.#ownedSession(remoteSessionId)
    if (method === 'session.sendTurn') {
      this.#activeTurns.add(remoteSessionId)
      try {
        return await this.#sessions.sendTurn(sessionId, text(input.prompt, 'prompt'))
      } catch (error) {
        this.#activeTurns.delete(remoteSessionId)
        throw error
      }
    }
    if (method === 'session.cancelTurn') return await this.#sessions.cancelTurn(sessionId)
    if (method === 'session.awaitStopped') {
      await this.#sessions.awaitStopped(sessionId)
      this.#activeTurns.delete(remoteSessionId)
      return
    }
    await this.#sessions.disposeAndReap(sessionId)
    this.#ownedSessions.delete(remoteSessionId)
    this.#activeTurns.delete(remoteSessionId)
    return null
  }

  #remoteSessionId(value: unknown): string {
    if (typeof value !== 'string' || !/^remote_[1-9][0-9]*$/.test(value)) throw new TypeError('Invalid remote Session id')
    return value
  }

  #ownedSession(remoteSessionId: string): string {
    const sessionId = this.#ownedSessions.get(remoteSessionId)
    if (!sessionId) throw new TypeError('Session is not owned by v1 worker')
    return sessionId
  }

  #isLexicallyAuthorized(path: string): boolean {
    return [...this.#scopes.values()].some((scope) =>
      path === scope.workspaceRoot
      || path === scope.rawWorkspaceRoot
      || lexicallyWithin(path, scope.authorizedWorkingRoot)
      || lexicallyWithin(path, scope.rawAuthorizedWorkingRoot))
  }

  async #isCanonicallyAuthorized(path: string): Promise<boolean> {
    for (const scope of this.#scopes.values()) {
      if (path === scope.workspaceRoot || await this.#paths.isEqualOrWithin(path, scope.authorizedWorkingRoot)) return true
    }
    return false
  }
}
