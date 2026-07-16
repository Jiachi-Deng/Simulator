import {
  HOST_AGENT_ERROR_CODES,
  HOST_AGENT_LIMITS,
  createHostAgentErrorResponse,
  parseCreateHostAgentRunRequest,
  parseIdempotencyKey,
  parseLastEventId,
  parseRunHandle,
  type HostAgentErrorCode,
  type HostAgentEvent,
} from '@simulator/host-agent-contract'
import {
  MessagePortByteCreditChannel,
  type HostAgentBrokerRpcEvent,
  type HostAgentBrokerRpcMethod,
  type HostAgentBrokerRpcRequest,
  type HostAgentBrokerRpcResponse,
  type HostAgentMessagePortLike,
  type MessagePortCreditLane,
} from '@simulator/host-agent-broker/message-port'
import {
  HostAgentRunCoreError,
  type HostAgentRunSubscription,
  type ModuleAgentRunCore,
} from '@simulator/host-agent-run-core'

const publicErrorCodes = new Set<string>(HOST_AGENT_ERROR_CODES)
const terminalEventTypes = new Set<HostAgentEvent['type']>([
  'turn.completed',
  'turn.failed',
  'turn.interrupted',
  'run.closed',
])
const eventEncoder = new TextEncoder()

function subscriptionEventLane(event: HostAgentEvent): MessagePortCreditLane {
  // finalText may legally make turn.completed much larger than the 64 KiB
  // terminal control reserve. Carry that payload on the 2 MiB business lane;
  // the reserve remains available for cancel/close responses and the small
  // terminal/closed control events that finish strict cleanup.
  if (event.type === 'turn.completed' && event.data.finalText !== undefined) return 'business'
  return terminalEventTypes.has(event.type) ? 'terminal' : 'business'
}

interface QueuedSubscriptionEvent {
  event: HostAgentEvent
  bytes: number
}

interface SubscriptionDelivery {
  queue: QueuedSubscriptionEvent[]
  queuedBytes: number
  ready: boolean
  overflowed: boolean
  pumping?: Promise<void>
}

function ownValue(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor && 'value' in descriptor ? descriptor.value : undefined
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value)
  return keys.length === expected.length
    && keys.every((key) => typeof key === 'string' && expected.includes(key))
}

function parseRequest(value: unknown): HostAgentBrokerRpcRequest {
  if (!value || typeof value !== 'object' || !hasExactKeys(value, ['kind', 'requestId', 'method', 'params'])) {
    throw new TypeError('Invalid Host Agent RPC request')
  }
  const kind = ownValue(value, 'kind')
  const requestId = ownValue(value, 'requestId')
  const method = ownValue(value, 'method')
  if (kind !== 'host-agent.rpc.request'
    || typeof requestId !== 'string'
    || !/^rpc_[1-9][0-9]*$/.test(requestId)
    || !['createRun', 'getRun', 'subscribeRun', 'unsubscribeRun', 'cancelRun', 'closeRun'].includes(String(method))) {
    throw new TypeError('Invalid Host Agent RPC request')
  }
  return { kind, requestId, method: method as HostAgentBrokerRpcMethod, params: ownValue(value, 'params') }
}

function exactParams(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object') throw new TypeError('Invalid Host Agent RPC parameters')
  const keys = Reflect.ownKeys(value)
  if (keys.some((key) => typeof key !== 'string' || (!required.includes(key) && !optional.includes(key)))) {
    throw new TypeError('Invalid Host Agent RPC parameters')
  }
  if (required.some((key) => !keys.includes(key))) throw new TypeError('Invalid Host Agent RPC parameters')
  return value as Record<string, unknown>
}

function parseSubscriptionId(value: unknown): string {
  if (typeof value !== 'string' || !/^sub_[1-9][0-9]*$/.test(value)) {
    throw new TypeError('Invalid Host Agent subscription id')
  }
  return value
}

function publicErrorCode(error: unknown): HostAgentErrorCode {
  if (error instanceof HostAgentRunCoreError && publicErrorCodes.has(error.code)) return error.code as HostAgentErrorCode
  if (error instanceof TypeError) return 'INVALID_REQUEST'
  return 'INTERNAL_ERROR'
}

function parseAfterSequence(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError('Invalid replay sequence')
  return parseLastEventId(String(value))
}

function requestLane(method: HostAgentBrokerRpcMethod): MessagePortCreditLane {
  return method === 'cancelRun' || method === 'closeRun' || method === 'unsubscribeRun' ? 'terminal' : 'business'
}

export interface V2CorePortAdapterOptions {
  core: ModuleAgentRunCore
  grantId: string
  port: HostAgentMessagePortLike
}

/**
 * Main-process half of the v2 Broker RPC seam. The Utility Process receives only
 * grant-bound run operations; SessionManager and provider objects never cross
 * this MessagePort.
 */
export class V2CorePortAdapter {
  readonly #core: ModuleAgentRunCore
  readonly #grantId: string
  readonly #channel: MessagePortByteCreditChannel
  readonly #subscriptions = new Map<string, HostAgentRunSubscription>()
  readonly #subscriptionDelivery = new Map<string, SubscriptionDelivery>()
  readonly #requests = new Set<string>()
  #disconnected = false
  #grantDisconnected = false
  #disconnectAttempt?: Promise<void>

  constructor(options: V2CorePortAdapterOptions) {
    this.#core = options.core
    this.#grantId = options.grantId
    this.#channel = new MessagePortByteCreditChannel(options.port)
    this.#channel.onMessage((payload) => this.#receive(payload))
    this.#channel.onDisconnect(() => this.#disconnectInBackground())
  }

  async disconnect(): Promise<void> {
    if (!this.#disconnected) {
      this.#disconnected = true
      for (const subscription of this.#subscriptions.values()) subscription.unsubscribe()
      this.#subscriptions.clear()
      this.#subscriptionDelivery.clear()
      this.#requests.clear()
      this.#channel.disconnect()
    }
    if (this.#grantDisconnected) return
    if (this.#disconnectAttempt) return await this.#disconnectAttempt

    const attempt = this.#core.disconnectGrant(this.#grantId).then(() => {
      this.#grantDisconnected = true
    })
    this.#disconnectAttempt = attempt
    try {
      await attempt
    } finally {
      if (this.#disconnectAttempt === attempt) this.#disconnectAttempt = undefined
    }
  }

  #disconnectInBackground(): void {
    void this.disconnect().catch(() => {
      // The explicit launch cleanup path will retry and surface strict-reap
      // failure to the Supervisor. Passive MessagePort teardown cannot throw.
    })
  }

  #receive(payload: unknown): void {
    let request: HostAgentBrokerRpcRequest
    try { request = parseRequest(payload) } catch {
      this.#disconnectInBackground()
      return
    }
    if (this.#requests.has(request.requestId)) {
      this.#disconnectInBackground()
      return
    }
    this.#requests.add(request.requestId)
    void this.#dispatch(request).finally(() => this.#requests.delete(request.requestId))
  }

  async #dispatch(request: HostAgentBrokerRpcRequest): Promise<void> {
    let result: unknown
    try {
      result = await this.#invoke(request.method, request.params)
    } catch (error) {
      const response: HostAgentBrokerRpcResponse = {
        kind: 'host-agent.rpc.response',
        requestId: request.requestId,
        ok: false,
        error: createHostAgentErrorResponse(publicErrorCode(error)),
      }
      try { await this.#channel.send(response, requestLane(request.method)) } catch { await this.disconnect() }
      return
    }

    const response: HostAgentBrokerRpcResponse = {
      kind: 'host-agent.rpc.response',
      requestId: request.requestId,
      ok: true,
      result: result ?? null,
    }
    try {
      await this.#channel.send(response, requestLane(request.method))
    } catch {
      await this.disconnect()
      return
    }
    if (request.method === 'subscribeRun') {
      try { await this.#startSubscriptionDelivery(request.params) } catch { await this.disconnect() }
    }
  }

  async #invoke(method: HostAgentBrokerRpcMethod, paramsValue: unknown): Promise<unknown> {
    if (method === 'createRun') {
      const params = exactParams(paramsValue, ['idempotencyKey', 'request'])
      return await this.#core.createRun({
        grantId: this.#grantId,
        idempotencyKey: parseIdempotencyKey(params.idempotencyKey),
        request: parseCreateHostAgentRunRequest(params.request),
      })
    }
    if (method === 'getRun') {
      const params = exactParams(paramsValue, ['runHandle'])
      return this.#core.getRun(this.#grantId, parseRunHandle(params.runHandle))
    }
    if (method === 'cancelRun') {
      const params = exactParams(paramsValue, ['runHandle'])
      return await this.#core.cancelRun(this.#grantId, parseRunHandle(params.runHandle))
    }
    if (method === 'closeRun') {
      const params = exactParams(paramsValue, ['runHandle'])
      return await this.#core.closeRun(this.#grantId, parseRunHandle(params.runHandle))
    }
    if (method === 'unsubscribeRun') {
      const params = exactParams(paramsValue, ['subscriptionId'])
      const subscriptionId = parseSubscriptionId(params.subscriptionId)
      this.#subscriptions.get(subscriptionId)?.unsubscribe()
      this.#subscriptions.delete(subscriptionId)
      this.#subscriptionDelivery.delete(subscriptionId)
      return null
    }

    const params = exactParams(paramsValue, ['runHandle', 'subscriptionId'], ['afterSequence'])
    const runHandle = parseRunHandle(params.runHandle)
    const subscriptionId = parseSubscriptionId(params.subscriptionId)
    if (this.#subscriptions.has(subscriptionId)) throw new TypeError('Duplicate Host Agent subscription id')
    const delivery: SubscriptionDelivery = {
      queue: [],
      queuedBytes: 0,
      ready: false,
      overflowed: false,
    }
    this.#subscriptionDelivery.set(subscriptionId, delivery)
    let subscription: HostAgentRunSubscription
    try {
      subscription = this.#core.subscribe(
        this.#grantId,
        runHandle,
        parseAfterSequence(params.afterSequence),
        (event) => this.#enqueueSubscriptionEvent(subscriptionId, delivery, event),
      )
    } catch (error) {
      this.#subscriptionDelivery.delete(subscriptionId)
      throw error
    }
    if (delivery.overflowed || this.#disconnected) {
      subscription.unsubscribe()
      this.#subscriptionDelivery.delete(subscriptionId)
      throw new HostAgentRunCoreError('REPLAY_UNAVAILABLE', 'Subscription replay exceeded the bounded delivery queue')
    }
    this.#subscriptions.set(subscriptionId, subscription)
    return {
      replayed: subscription.replayed,
      ...(subscription.earliestEventId === undefined ? {} : { earliestEventId: subscription.earliestEventId }),
      ...(subscription.latestEventId === undefined ? {} : { latestEventId: subscription.latestEventId }),
    }
  }

  async #startSubscriptionDelivery(paramsValue: unknown): Promise<void> {
    const params = paramsValue as Record<string, unknown>
    const subscriptionId = parseSubscriptionId(params.subscriptionId)
    const delivery = this.#subscriptionDelivery.get(subscriptionId)
    if (!delivery) return
    delivery.ready = true
    await this.#pumpSubscription(subscriptionId, delivery)
  }

  #enqueueSubscriptionEvent(
    subscriptionId: string,
    delivery: SubscriptionDelivery,
    event: HostAgentEvent,
  ): void {
    if (delivery.overflowed || this.#disconnected
      || this.#subscriptionDelivery.get(subscriptionId) !== delivery) return
    const bytes = eventEncoder.encode(JSON.stringify(event)).byteLength
    if (delivery.queue.length >= HOST_AGENT_LIMITS.maxReplayEvents
      || delivery.queuedBytes + bytes > HOST_AGENT_LIMITS.maxReplayBytes) {
      delivery.overflowed = true
      this.#disconnectInBackground()
      return
    }
    delivery.queue.push({ event, bytes })
    delivery.queuedBytes += bytes
    if (delivery.ready) void this.#pumpSubscription(subscriptionId, delivery)
  }

  #pumpSubscription(subscriptionId: string, delivery: SubscriptionDelivery): Promise<void> {
    if (delivery.pumping) return delivery.pumping
    const operation = (async () => {
      while (!this.#disconnected
        && !delivery.overflowed
        && delivery.ready
        && this.#subscriptionDelivery.get(subscriptionId) === delivery
        && delivery.queue.length > 0) {
        const next = delivery.queue.shift()!
        delivery.queuedBytes -= next.bytes
        const message: HostAgentBrokerRpcEvent = {
          kind: 'host-agent.rpc.event',
          subscriptionId,
          event: next.event,
        }
        // One ordered pump per subscription is the sequencing authority. The
        // terminal lane supplies reserved capacity but never overtakes an
        // earlier business event from the same stream.
        await this.#channel.send(message, subscriptionEventLane(next.event))
      }
    })()
    delivery.pumping = operation
    void operation.finally(() => {
      if (delivery.pumping === operation) delivery.pumping = undefined
      if (!this.#disconnected && !delivery.overflowed && delivery.ready
        && this.#subscriptionDelivery.get(subscriptionId) === delivery
        && delivery.queue.length > 0) {
        void this.#pumpSubscription(subscriptionId, delivery)
      }
    }).catch(() => this.#disconnectInBackground())
    return operation
  }
}
