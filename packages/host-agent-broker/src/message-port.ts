import {
  HOST_AGENT_LIMITS,
  assertClosedJsonValue,
  parseCreateHostAgentRunRequest,
  parseHostAgentErrorResponse,
  parseHostAgentEvent,
  parseHostAgentRunSnapshot,
  parseIdempotencyKey,
  parseRunHandle,
  type CreateHostAgentRunRequest,
  type HostAgentErrorResponse,
  type HostAgentEvent,
  type HostAgentRunSnapshot,
} from '@simulator/host-agent-contract'
import {
  HostAgentBrokerCoreClientError,
  HostAgentBrokerDisconnectedError,
} from './errors.ts'
import type {
  HostAgentBrokerCoreClient,
  HostAgentBrokerCoreSubscription,
} from './types.ts'

export type MessagePortCreditLane = 'business' | 'terminal'

export interface HostAgentMessagePortLike {
  postMessage(message: unknown): void
  on(event: 'message' | 'close' | 'messageerror', listener: (message?: unknown) => void): unknown
  off?(event: 'message' | 'close' | 'messageerror', listener: (message?: unknown) => void): unknown
  removeListener?(event: 'message' | 'close' | 'messageerror', listener: (message?: unknown) => void): unknown
  start?(): void
}

export interface MessagePortByteCreditLimits {
  businessCreditBytes: number
  terminalCreditBytes: number
  maxQueuedBusinessBytes: number
  maxQueuedTerminalBytes: number
}

interface CreditFrame {
  kind: 'host-agent.credit.frame'
  messageId: string
  lane: MessagePortCreditLane
  creditBytes: number
  payload: unknown
}

interface CreditAck {
  kind: 'host-agent.credit.ack'
  messageId: string
}

interface PendingFrame extends CreditFrame {
  resolve: () => void
  reject: (error: Error) => void
}

const DEFAULT_CREDIT_LIMITS: Readonly<MessagePortByteCreditLimits> = Object.freeze({
  businessCreditBytes: HOST_AGENT_LIMITS.messagePortCreditBytes,
  terminalCreditBytes: HOST_AGENT_LIMITS.terminalControlReserveBytes,
  maxQueuedBusinessBytes: HOST_AGENT_LIMITS.messagePortCreditBytes * 2,
  maxQueuedTerminalBytes: HOST_AGENT_LIMITS.terminalControlReserveBytes,
})

const encoder = new TextEncoder()

function encodedJsonBytes(value: unknown): number {
  assertClosedJsonValue(value)
  let json: string | undefined
  try { json = JSON.stringify(value) } catch { throw new TypeError('MessagePort payload must be JSON data') }
  if (json === undefined) throw new TypeError('MessagePort payload must be JSON data')
  return encoder.encode(json).byteLength
}

/**
 * Credit counts the application payload. The fixed RPC envelope is bounded
 * separately; this keeps a legal 2 MiB POST body representable inside the
 * 2 MiB business lane instead of rejecting it because of a few control bytes.
 */
function creditedBytes(value: unknown): number {
  const fullBytes = encodedJsonBytes(value)
  if (!value || typeof value !== 'object'
    || ownValue(value, 'kind') !== 'host-agent.rpc.request'
    || ownValue(value, 'method') !== 'createRun') return fullBytes
  const params = ownValue(value, 'params')
  if (!params || typeof params !== 'object') return fullBytes
  const request = ownValue(params, 'request')
  const requestBytes = encodedJsonBytes(request)
  // Idempotency key + fixed field names are strictly bounded by the RPC client.
  if (fullBytes - requestBytes > 4 * 1024) throw new TypeError('MessagePort RPC envelope is too large')
  return requestBytes
}

function eventData(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value
  if (Object.getOwnPropertyDescriptor(value, 'kind')) return value
  const descriptor = Object.getOwnPropertyDescriptor(value, 'data')
  return descriptor && 'value' in descriptor ? descriptor.value : value
}

function ownValue(object: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, key)
  return descriptor && 'value' in descriptor ? descriptor.value : undefined
}

function exactOwnKeys(object: object, keys: readonly string[]): boolean {
  const own = Reflect.ownKeys(object)
  return own.every((key) => typeof key === 'string' && keys.includes(key)) && own.length === keys.length
}

export class HostAgentMessagePortCapacityError extends Error {
  constructor() {
    super('Host Agent MessagePort capacity is exhausted')
    this.name = 'HostAgentMessagePortCapacityError'
  }
}

/**
 * Symmetric MessagePort channel with two independent byte-credit lanes.
 * Business saturation can never consume the terminal control reserve.
 */
export class MessagePortByteCreditChannel {
  readonly #port: HostAgentMessagePortLike
  readonly #limits: Readonly<MessagePortByteCreditLimits>
  readonly #businessQueue: PendingFrame[] = []
  readonly #terminalQueue: PendingFrame[] = []
  readonly #inFlight = new Map<string, { lane: MessagePortCreditLane; bytes: number }>()
  readonly #messageListeners = new Set<(payload: unknown) => void>()
  readonly #disconnectListeners = new Set<(error: HostAgentBrokerDisconnectedError) => void>()
  #businessInFlight = 0
  #terminalInFlight = 0
  #businessQueued = 0
  #terminalQueued = 0
  #nextMessageId = 1
  #disconnected = false

  readonly #handleMessage = (message?: unknown): void => {
    try { this.#receive(eventData(message)) } catch { this.disconnect() }
  }
  readonly #handleDisconnect = (): void => this.disconnect()

  constructor(port: HostAgentMessagePortLike, limits: Partial<MessagePortByteCreditLimits> = {}) {
    this.#port = port
    this.#limits = Object.freeze({ ...DEFAULT_CREDIT_LIMITS, ...limits })
    this.#validateLimits()
    port.on('message', this.#handleMessage)
    port.on('close', this.#handleDisconnect)
    port.on('messageerror', this.#handleDisconnect)
    port.start?.()
  }

  get disconnected(): boolean { return this.#disconnected }

  debugSnapshot(): Readonly<{
    businessInFlight: number
    terminalInFlight: number
    businessQueued: number
    terminalQueued: number
    pendingFrames: number
  }> {
    return {
      businessInFlight: this.#businessInFlight,
      terminalInFlight: this.#terminalInFlight,
      businessQueued: this.#businessQueued,
      terminalQueued: this.#terminalQueued,
      pendingFrames: this.#businessQueue.length + this.#terminalQueue.length,
    }
  }

  send(payload: unknown, lane: MessagePortCreditLane = 'business'): Promise<void> {
    if (this.#disconnected) return Promise.reject(new HostAgentBrokerDisconnectedError())
    let creditBytes: number
    try { creditBytes = creditedBytes(payload) } catch (error) {
      return Promise.reject(error instanceof Error ? error : new TypeError('MessagePort payload is invalid'))
    }
    const laneLimit = lane === 'business' ? this.#limits.businessCreditBytes : this.#limits.terminalCreditBytes
    if (creditBytes > laneLimit) return Promise.reject(new HostAgentMessagePortCapacityError())
    return new Promise<void>((resolve, reject) => {
      const frame: PendingFrame = {
        kind: 'host-agent.credit.frame',
        messageId: `mp_${this.#nextMessageId++}`,
        lane,
        creditBytes,
        payload,
        resolve,
        reject,
      }
      if (this.#canSend(frame)) {
        this.#post(frame)
        return
      }
      const queued = lane === 'business' ? this.#businessQueued : this.#terminalQueued
      const maxQueued = lane === 'business' ? this.#limits.maxQueuedBusinessBytes : this.#limits.maxQueuedTerminalBytes
      if (queued + creditBytes > maxQueued) {
        reject(new HostAgentMessagePortCapacityError())
        return
      }
      if (lane === 'business') {
        this.#businessQueue.push(frame)
        this.#businessQueued += creditBytes
      } else {
        this.#terminalQueue.push(frame)
        this.#terminalQueued += creditBytes
      }
    })
  }

  onMessage(listener: (payload: unknown) => void): () => void {
    this.#messageListeners.add(listener)
    return () => { this.#messageListeners.delete(listener) }
  }

  onDisconnect(listener: (error: HostAgentBrokerDisconnectedError) => void): () => void {
    if (this.#disconnected) {
      listener(new HostAgentBrokerDisconnectedError())
      return () => undefined
    }
    this.#disconnectListeners.add(listener)
    return () => { this.#disconnectListeners.delete(listener) }
  }

  disconnect(): void {
    if (this.#disconnected) return
    this.#disconnected = true
    const error = new HostAgentBrokerDisconnectedError()
    for (const frame of [...this.#terminalQueue, ...this.#businessQueue]) frame.reject(error)
    this.#terminalQueue.length = 0
    this.#businessQueue.length = 0
    this.#terminalQueued = 0
    this.#businessQueued = 0
    this.#inFlight.clear()
    this.#terminalInFlight = 0
    this.#businessInFlight = 0
    for (const listener of this.#disconnectListeners) {
      try { listener(error) } catch { /* Isolation boundary: observers cannot prevent disconnect. */ }
    }
    this.#disconnectListeners.clear()
    this.#messageListeners.clear()
    this.#removePortListener('message', this.#handleMessage)
    this.#removePortListener('close', this.#handleDisconnect)
    this.#removePortListener('messageerror', this.#handleDisconnect)
  }

  #validateLimits(): void {
    const values = Object.values(this.#limits)
    if (values.some((value) => !Number.isSafeInteger(value) || value < 1)) {
      throw new TypeError('MessagePort credit limits must be positive safe integers')
    }
    if (this.#limits.businessCreditBytes > HOST_AGENT_LIMITS.messagePortCreditBytes
      || this.#limits.terminalCreditBytes > HOST_AGENT_LIMITS.terminalControlReserveBytes
      || this.#limits.maxQueuedBusinessBytes > HOST_AGENT_LIMITS.messagePortCreditBytes * 2
      || this.#limits.maxQueuedTerminalBytes > HOST_AGENT_LIMITS.terminalControlReserveBytes) {
      throw new TypeError('MessagePort credit exceeds the Host Agent contract ceiling')
    }
  }

  #canSend(frame: CreditFrame): boolean {
    return frame.lane === 'business'
      ? this.#businessInFlight + frame.creditBytes <= this.#limits.businessCreditBytes
      : this.#terminalInFlight + frame.creditBytes <= this.#limits.terminalCreditBytes
  }

  #post(frame: PendingFrame): void {
    if (this.#disconnected) {
      frame.reject(new HostAgentBrokerDisconnectedError())
      return
    }
    const wire: CreditFrame = {
      kind: frame.kind,
      messageId: frame.messageId,
      lane: frame.lane,
      creditBytes: frame.creditBytes,
      payload: frame.payload,
    }
    this.#inFlight.set(frame.messageId, { lane: frame.lane, bytes: frame.creditBytes })
    if (frame.lane === 'business') this.#businessInFlight += frame.creditBytes
    else this.#terminalInFlight += frame.creditBytes
    try {
      this.#port.postMessage(wire)
      frame.resolve()
    } catch {
      this.#inFlight.delete(frame.messageId)
      if (frame.lane === 'business') this.#businessInFlight -= frame.creditBytes
      else this.#terminalInFlight -= frame.creditBytes
      frame.reject(new HostAgentBrokerDisconnectedError())
      this.disconnect()
    }
  }

  #receive(message: unknown): void {
    if (this.#disconnected || !message || typeof message !== 'object') return this.disconnect()
    const kind = ownValue(message, 'kind')
    if (kind === 'host-agent.credit.ack') {
      if (!exactOwnKeys(message, ['kind', 'messageId'])) return this.disconnect()
      const messageId = ownValue(message, 'messageId')
      if (typeof messageId !== 'string') return this.disconnect()
      const credit = this.#inFlight.get(messageId)
      if (!credit) return this.disconnect()
      this.#inFlight.delete(messageId)
      if (credit.lane === 'business') this.#businessInFlight -= credit.bytes
      else this.#terminalInFlight -= credit.bytes
      this.#drain()
      return
    }
    if (kind !== 'host-agent.credit.frame'
      || !exactOwnKeys(message, ['kind', 'messageId', 'lane', 'creditBytes', 'payload'])) {
      return this.disconnect()
    }
    const messageId = ownValue(message, 'messageId')
    const lane = ownValue(message, 'lane')
    const creditBytes = ownValue(message, 'creditBytes')
    const payload = ownValue(message, 'payload')
    if (typeof messageId !== 'string' || !/^mp_[1-9][0-9]*$/.test(messageId)
      || (lane !== 'business' && lane !== 'terminal')
      || !Number.isSafeInteger(creditBytes) || (creditBytes as number) < 1
      || creditBytes !== creditedBytes(payload)) {
      return this.disconnect()
    }
    const limit = lane === 'business' ? this.#limits.businessCreditBytes : this.#limits.terminalCreditBytes
    if ((creditBytes as number) > limit) return this.disconnect()
    const ack: CreditAck = { kind: 'host-agent.credit.ack', messageId }
    try { this.#port.postMessage(ack) } catch { return this.disconnect() }
    for (const listener of this.#messageListeners) {
      try { listener(payload) } catch { /* RPC layer owns payload validation failure. */ }
    }
  }

  #drain(): void {
    if (this.#disconnected) return
    // Terminal control always drains before business traffic.
    for (const [queue, lane] of [[this.#terminalQueue, 'terminal'], [this.#businessQueue, 'business']] as const) {
      while (queue.length > 0) {
        const next = queue[0]
        if (!next || !this.#canSend(next)) break
        const frame = queue.shift()!
        if (lane === 'terminal') this.#terminalQueued -= frame.creditBytes
        else this.#businessQueued -= frame.creditBytes
        this.#post(frame)
      }
    }
  }

  #removePortListener(event: 'message' | 'close' | 'messageerror', listener: (message?: unknown) => void): void {
    if (this.#port.off) this.#port.off(event, listener)
    else this.#port.removeListener?.(event, listener)
  }
}

export type HostAgentBrokerRpcMethod =
  | 'createRun'
  | 'getRun'
  | 'subscribeRun'
  | 'unsubscribeRun'
  | 'cancelRun'
  | 'closeRun'

export interface HostAgentBrokerRpcRequest {
  kind: 'host-agent.rpc.request'
  requestId: string
  method: HostAgentBrokerRpcMethod
  params: unknown
}

export interface HostAgentBrokerRpcResponse {
  kind: 'host-agent.rpc.response'
  requestId: string
  ok: boolean
  result?: unknown
  error?: HostAgentErrorResponse
}

export interface HostAgentBrokerRpcEvent {
  kind: 'host-agent.rpc.event'
  subscriptionId: string
  event: HostAgentEvent
}

interface PendingRpc {
  parse: (value: unknown) => unknown
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

function parseSubscription(value: unknown): Omit<HostAgentBrokerCoreSubscription, 'unsubscribe'> {
  if (!value || typeof value !== 'object') throw new TypeError('Invalid subscription response')
  const allowed = ['replayed', 'earliestEventId', 'latestEventId']
  const keys = Reflect.ownKeys(value)
  if (keys.some((key) => typeof key !== 'string' || !allowed.includes(key)) || !keys.includes('replayed')) {
    throw new TypeError('Invalid subscription response')
  }
  const replayed = ownValue(value, 'replayed')
  const earliestEventId = ownValue(value, 'earliestEventId')
  const latestEventId = ownValue(value, 'latestEventId')
  if (!Number.isSafeInteger(replayed) || (replayed as number) < 0
    || (earliestEventId !== undefined && (typeof earliestEventId !== 'string' || !/^(0|[1-9][0-9]*)$/.test(earliestEventId)))
    || (latestEventId !== undefined && (typeof latestEventId !== 'string' || !/^(0|[1-9][0-9]*)$/.test(latestEventId)))) {
    throw new TypeError('Invalid subscription response')
  }
  return {
    replayed: replayed as number,
    ...(earliestEventId === undefined ? {} : { earliestEventId }),
    ...(latestEventId === undefined ? {} : { latestEventId }),
  }
}

/** RPC implementation of the narrow core seam. Pending calls fail on disconnect. */
export class MessagePortHostAgentBrokerCoreClient implements HostAgentBrokerCoreClient {
  readonly #channel: MessagePortByteCreditChannel
  readonly #pending = new Map<string, PendingRpc>()
  readonly #subscriptions = new Map<string, { runHandle: string; listener: (event: HostAgentEvent) => void }>()
  #nextRequestId = 1
  #nextSubscriptionId = 1
  #disconnected = false

  constructor(channel: MessagePortByteCreditChannel) {
    this.#channel = channel
    channel.onMessage((payload) => this.#receive(payload))
    channel.onDisconnect((error) => {
      this.#disconnected = true
      for (const pending of this.#pending.values()) pending.reject(error)
      this.#pending.clear()
      this.#subscriptions.clear()
    })
  }

  async createRun(idempotencyKey: string, request: CreateHostAgentRunRequest): Promise<HostAgentRunSnapshot> {
    const key = parseIdempotencyKey(idempotencyKey)
    const parsedRequest = parseCreateHostAgentRunRequest(request)
    return await this.#call('createRun', { idempotencyKey: key, request: parsedRequest }, parseHostAgentRunSnapshot, 'business')
  }

  async getRun(runHandle: string): Promise<HostAgentRunSnapshot> {
    return await this.#call('getRun', { runHandle: parseRunHandle(runHandle) }, parseHostAgentRunSnapshot, 'business')
  }

  async subscribeRun(
    runHandle: string,
    afterSequence: number | undefined,
    listener: (event: HostAgentEvent) => void,
  ): Promise<HostAgentBrokerCoreSubscription> {
    runHandle = parseRunHandle(runHandle)
    const subscriptionId = `sub_${this.#nextSubscriptionId++}`
    this.#subscriptions.set(subscriptionId, { runHandle, listener })
    let metadata: Omit<HostAgentBrokerCoreSubscription, 'unsubscribe'>
    try {
      metadata = await this.#call(
        'subscribeRun',
        { runHandle, subscriptionId, ...(afterSequence === undefined ? {} : { afterSequence }) },
        parseSubscription,
        'business',
      )
    } catch (error) {
      this.#subscriptions.delete(subscriptionId)
      throw error
    }
    let active = true
    return {
      ...metadata,
      unsubscribe: async () => {
        if (!active) return
        active = false
        this.#subscriptions.delete(subscriptionId)
        await this.#call('unsubscribeRun', { subscriptionId }, () => undefined, 'terminal')
      },
    }
  }

  async cancelRun(runHandle: string): Promise<HostAgentRunSnapshot> {
    return await this.#call('cancelRun', { runHandle: parseRunHandle(runHandle) }, parseHostAgentRunSnapshot, 'terminal')
  }

  async closeRun(runHandle: string): Promise<HostAgentRunSnapshot> {
    return await this.#call('closeRun', { runHandle: parseRunHandle(runHandle) }, parseHostAgentRunSnapshot, 'terminal')
  }

  #call<T>(
    method: HostAgentBrokerRpcMethod,
    params: unknown,
    parse: (value: unknown) => T,
    lane: MessagePortCreditLane,
  ): Promise<T> {
    if (this.#disconnected || this.#channel.disconnected) return Promise.reject(new HostAgentBrokerDisconnectedError())
    const requestId = `rpc_${this.#nextRequestId++}`
    const request: HostAgentBrokerRpcRequest = { kind: 'host-agent.rpc.request', requestId, method, params }
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(requestId, {
        parse,
        resolve: (value) => resolve(value as T),
        reject,
      })
      void this.#channel.send(request, lane).catch((error) => {
        if (this.#pending.delete(requestId)) reject(error instanceof Error ? error : new HostAgentBrokerDisconnectedError())
      })
    })
  }

  #receive(payload: unknown): void {
    try {
      if (!payload || typeof payload !== 'object') throw new TypeError('Invalid RPC message')
      const kind = ownValue(payload, 'kind')
      if (kind === 'host-agent.rpc.event') {
        if (!exactOwnKeys(payload, ['kind', 'subscriptionId', 'event'])) throw new TypeError('Invalid RPC event')
        const subscriptionId = ownValue(payload, 'subscriptionId')
        if (typeof subscriptionId !== 'string') throw new TypeError('Invalid RPC event')
        const event = parseHostAgentEvent(ownValue(payload, 'event'))
        const subscription = this.#subscriptions.get(subscriptionId)
        if (subscription && subscription.runHandle !== event.runHandle) throw new TypeError('RPC event has the wrong run owner')
        try { subscription?.listener(event) } catch { /* Subscriber failure is isolated. */ }
        return
      }
      if (kind !== 'host-agent.rpc.response') throw new TypeError('Invalid RPC response')
      const keys = Reflect.ownKeys(payload)
      const requestId = ownValue(payload, 'requestId')
      const ok = ownValue(payload, 'ok')
      if (typeof requestId !== 'string' || typeof ok !== 'boolean') throw new TypeError('Invalid RPC response')
      const pending = this.#pending.get(requestId)
      if (!pending) throw new TypeError('Unknown RPC response')
      if (ok) {
        if (keys.length !== 4 || !exactOwnKeys(payload, ['kind', 'requestId', 'ok', 'result'])) throw new TypeError('Invalid RPC response')
        const parsed = pending.parse(ownValue(payload, 'result'))
        this.#pending.delete(requestId)
        pending.resolve(parsed)
      } else {
        if (keys.length !== 4 || !exactOwnKeys(payload, ['kind', 'requestId', 'ok', 'error'])) throw new TypeError('Invalid RPC response')
        const response = parseHostAgentErrorResponse(ownValue(payload, 'error'))
        this.#pending.delete(requestId)
        pending.reject(new HostAgentBrokerCoreClientError(response.error.code))
      }
    } catch {
      this.#channel.disconnect()
    }
  }
}
