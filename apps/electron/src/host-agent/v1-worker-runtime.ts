import {
  ModuleAgentGateway,
  type CreateHostModuleSessionInput,
  type CreatedHostModuleSession,
  type ModuleAgentGatewaySnapshot,
  type ModuleAgentGrantSpec,
  type ModuleAgentPathAuthority,
  type ModuleAgentPortEvent,
  type ModuleAgentSessionPort,
} from '@simulator/module-agent-gateway'
import {
  ModuleAgentGatewayServer,
  NodeModuleAgentTokenSource,
  type ModuleAgentLaunchLease,
} from '@simulator/module-agent-gateway/node'
import {
  MessagePortByteCreditChannel,
  type HostAgentMessagePortLike,
} from '@simulator/host-agent-broker/message-port'
import {
  parseV1RpcWireMessage,
  v1RpcLane,
  type V1HostRpcEvent,
  type V1HostRpcMethod,
  type V1HostRpcRequest,
  type V1HostRpcResponse,
  type V1WorkerRpcRequest,
  type V1WorkerRpcResponse,
} from './v1-wire'

interface PendingHostCall {
  resolve(value: unknown): void
  reject(error: Error): void
}

function exactParams(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object') throw new TypeError('Invalid v1 worker command')
  const actual = Reflect.ownKeys(value)
  if (actual.length !== keys.length || actual.some((key) => typeof key !== 'string' || !keys.includes(key))) {
    throw new TypeError('Invalid v1 worker command')
  }
  return value as Record<string, unknown>
}

class V1WorkerRpcPeer {
  readonly #channel: MessagePortByteCreditChannel
  readonly #pending = new Map<string, PendingHostCall>()
  readonly #eventListeners = new Map<string, (event: ModuleAgentPortEvent) => void>()
  #nextHostRequest = 1
  #workerHandler?: (request: V1WorkerRpcRequest) => Promise<unknown>
  #disconnected = false

  constructor(port: HostAgentMessagePortLike, onDisconnect: () => void) {
    this.#channel = new MessagePortByteCreditChannel(port)
    this.#channel.onMessage((payload) => this.#receive(payload))
    this.#channel.onDisconnect(() => {
      if (this.#disconnected) return
      this.#disconnected = true
      for (const pending of this.#pending.values()) pending.reject(new Error('v1 Host RPC disconnected'))
      this.#pending.clear()
      this.#eventListeners.clear()
      onDisconnect()
    })
  }

  setWorkerHandler(handler: (request: V1WorkerRpcRequest) => Promise<unknown>): void {
    this.#workerHandler = handler
  }

  async callHost(method: V1HostRpcMethod, params: unknown): Promise<unknown> {
    if (this.#disconnected) throw new Error('v1 Host RPC disconnected')
    const requestId = `worker_${this.#nextHostRequest++}`
    const request: V1HostRpcRequest = { kind: 'module-agent.host.request', requestId, method, params }
    const result = new Promise<unknown>((resolve, reject) => this.#pending.set(requestId, { resolve, reject }))
    try { await this.#channel.send(request, v1RpcLane(method)) } catch (error) {
      this.#pending.delete(requestId)
      throw error
    }
    return await result
  }

  addEventListener(subscriptionId: string, listener: (event: ModuleAgentPortEvent) => void): void {
    if (this.#eventListeners.has(subscriptionId)) throw new TypeError('Duplicate remote subscription')
    this.#eventListeners.set(subscriptionId, listener)
  }

  removeEventListener(subscriptionId: string): void { this.#eventListeners.delete(subscriptionId) }

  disconnect(): void { this.#channel.disconnect() }

  #receive(payload: unknown): void {
    const message = parseV1RpcWireMessage(payload)
    if (!message) return this.disconnect()
    if (message.kind === 'module-agent.host.response') {
      const pending = this.#pending.get(message.requestId)
      if (!pending) return this.disconnect()
      this.#pending.delete(message.requestId)
      if (message.ok) pending.resolve(message.result)
      else pending.reject(new Error('v1 Host RPC request failed'))
      return
    }
    if (message.kind === 'module-agent.host.event') {
      this.#eventListeners.get(message.subscriptionId)?.(message.event)
      return
    }
    if (message.kind === 'module-agent.worker.request') {
      void this.#dispatchWorker(message)
      return
    }
    this.disconnect()
  }

  async #dispatchWorker(request: V1WorkerRpcRequest): Promise<void> {
    try {
      if (!this.#workerHandler) throw new Error('v1 worker is not ready')
      const result = await this.#workerHandler(request)
      const response: V1WorkerRpcResponse = {
        kind: 'module-agent.worker.response', requestId: request.requestId, ok: true, result: result ?? null,
      }
      await this.#channel.send(response, v1RpcLane(request.method))
    } catch {
      const response: V1WorkerRpcResponse = {
        kind: 'module-agent.worker.response', requestId: request.requestId, ok: false, error: { code: 'REQUEST_FAILED' },
      }
      try { await this.#channel.send(response, v1RpcLane(request.method)) } catch { this.disconnect() }
    }
  }
}

class RemoteV1PathAuthority implements ModuleAgentPathAuthority {
  constructor(private readonly rpc: V1WorkerRpcPeer) {}

  async canonicalize(path: string): Promise<string> {
    const result = await this.rpc.callHost('path.canonicalize', { path })
    if (typeof result !== 'string' || !result.startsWith('/')) throw new TypeError('Host returned an invalid canonical path')
    return result
  }

  async isEqualOrWithin(candidate: string, root: string): Promise<boolean> {
    const result = await this.rpc.callHost('path.isEqualOrWithin', { candidate, root })
    if (typeof result !== 'boolean') throw new TypeError('Host returned an invalid path decision')
    return result
  }
}

class RemoteV1SessionPort implements ModuleAgentSessionPort {
  #nextSubscription = 1
  constructor(private readonly rpc: V1WorkerRpcPeer) {}

  async createSession(input: CreateHostModuleSessionInput): Promise<CreatedHostModuleSession> {
    const result = await this.rpc.callHost('session.create', { input })
    if (!result || typeof result !== 'object') throw new TypeError('Host returned an invalid Session')
    return result as CreatedHostModuleSession
  }

  async sendTurn(sessionId: string, prompt: string): Promise<void> {
    await this.rpc.callHost('session.sendTurn', { sessionId, prompt })
  }

  async cancelTurn(sessionId: string): Promise<void> {
    await this.rpc.callHost('session.cancelTurn', { sessionId })
  }

  async awaitStopped(sessionId: string): Promise<void> {
    await this.rpc.callHost('session.awaitStopped', { sessionId })
  }

  async disposeAndReap(sessionId: string): Promise<void> {
    await this.rpc.callHost('session.disposeAndReap', { sessionId })
  }

  async subscribe(sessionId: string, listener: (event: ModuleAgentPortEvent) => void): Promise<() => void> {
    const id = `sub_${this.#nextSubscription++}`
    this.rpc.addEventListener(id, listener)
    try { await this.rpc.callHost('session.subscribe', { sessionId, subscriptionId: id }) } catch (error) {
      this.rpc.removeEventListener(id)
      throw error
    }
    let active = true
    return () => {
      if (!active) return
      active = false
      this.rpc.removeEventListener(id)
      void this.rpc.callHost('session.unsubscribe', { subscriptionId: id }).catch(() => undefined)
    }
  }
}

export interface V1CompatibilityWorkerRuntime {
  address: { host: '127.0.0.1'; port: number; url: string }
  stop(): Promise<void>
}

export interface V1CompatibilityWorkerOptions {
  /**
   * The Utility Process is the final containment boundary. A Host Session
   * cleanup may be wedged in provider code, so shutdown must eventually hand
   * control back to the process supervisor instead of keeping the worker
   * alive forever.
   */
  stopTimeoutMs?: number
}

const DEFAULT_V1_WORKER_STOP_TIMEOUT_MS = 5_000

async function settleWorkerStop(
  operation: Promise<void>,
  timeoutMs: number,
): Promise<{ status: 'fulfilled' } | { status: 'rejected'; error: unknown } | { status: 'timed-out' }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const guarded = operation.then(
    () => ({ status: 'fulfilled' as const }),
    (error) => ({ status: 'rejected' as const, error }),
  )
  const timeout = new Promise<{ status: 'timed-out' }>((resolve) => {
    timer = setTimeout(() => resolve({ status: 'timed-out' }), timeoutMs)
    timer.unref?.()
  })
  try { return await Promise.race([guarded, timeout]) } finally { if (timer) clearTimeout(timer) }
}

export async function startV1CompatibilityWorker(
  port: HostAgentMessagePortLike,
  onDisconnect: () => void,
  options: V1CompatibilityWorkerOptions = {},
): Promise<V1CompatibilityWorkerRuntime> {
  const stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_V1_WORKER_STOP_TIMEOUT_MS
  if (!Number.isSafeInteger(stopTimeoutMs) || stopTimeoutMs < 1) {
    throw new TypeError('v1 Compatibility worker stop timeout must be positive')
  }
  const peer = new V1WorkerRpcPeer(port, onDisconnect)
  const paths = new RemoteV1PathAuthority(peer)
  const sessions = new RemoteV1SessionPort(peer)
  const gateway = new ModuleAgentGateway({
    port: sessions,
    pathAuthority: paths,
    tokenSource: new NodeModuleAgentTokenSource(),
  })
  const server = new ModuleAgentGatewayServer(gateway)
  const url = await server.start()
  const parsed = new URL(url)
  const leases = new Map<string, ModuleAgentLaunchLease>()
  let nextLease = 1
  let stopPromise: Promise<void> | undefined

  peer.setWorkerHandler(async (request) => {
    if (request.method === 'debugSnapshot') {
      exactParams(request.params, [])
      return gateway.debugSnapshot()
    }
    if (request.method === 'prepareLaunch') {
      const input = exactParams(request.params, ['spec', 'tokenDirectory'])
      if (typeof input.tokenDirectory !== 'string') throw new TypeError('Invalid token directory')
      const lease = await server.prepareLaunch(input.spec as ModuleAgentGrantSpec, input.tokenDirectory)
      const leaseId = `lease_${nextLease++}`
      leases.set(leaseId, lease)
      return { leaseId, environment: lease.environment, snapshot: gateway.debugSnapshot() }
    }
    const input = exactParams(request.params, ['leaseId'])
    if (typeof input.leaseId !== 'string') throw new TypeError('Invalid lease id')
    const lease = leases.get(input.leaseId)
    if (lease) {
      await lease.dispose()
      leases.delete(input.leaseId)
    }
    return { snapshot: gateway.debugSnapshot() }
  })

  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise
    stopPromise = (async () => {
      // ModuleAgentGatewayServer owns every lease. Calling lease.dispose here
      // and then server.stop repeated a failed strict reap indefinitely across
      // stop attempts. One bounded server stop is the sole cleanup attempt;
      // the supervisor terminates this isolated worker if it cannot finish.
      const result = await settleWorkerStop(server.stop(), stopTimeoutMs)
      leases.clear()
      peer.disconnect()
      if (result.status === 'timed-out') {
        throw new Error(`v1 Compatibility worker cleanup timed out after ${stopTimeoutMs}ms`)
      }
      if (result.status === 'rejected') {
        throw new AggregateError([result.error], 'v1 Compatibility worker did not fully stop')
      }
    })()
    return stopPromise
  }

  return {
    address: { host: '127.0.0.1', port: Number(parsed.port), url },
    stop,
  }
}
