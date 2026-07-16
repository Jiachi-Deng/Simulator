import type { ModuleAgentPortEvent } from '@simulator/module-agent-gateway'

export type V1HostRpcMethod =
  | 'path.canonicalize'
  | 'path.isEqualOrWithin'
  | 'session.create'
  | 'session.sendTurn'
  | 'session.cancelTurn'
  | 'session.awaitStopped'
  | 'session.disposeAndReap'
  | 'session.subscribe'
  | 'session.unsubscribe'

export type V1WorkerRpcMethod = 'prepareLaunch' | 'disposeLease' | 'debugSnapshot'

export interface V1HostRpcRequest {
  kind: 'module-agent.host.request'
  requestId: string
  method: V1HostRpcMethod
  params: unknown
}

export interface V1HostRpcResponse {
  kind: 'module-agent.host.response'
  requestId: string
  ok: boolean
  result?: unknown
  error?: { code: 'REQUEST_FAILED' }
}

export interface V1HostRpcEvent {
  kind: 'module-agent.host.event'
  subscriptionId: string
  event: ModuleAgentPortEvent
}

export interface V1WorkerRpcRequest {
  kind: 'module-agent.worker.request'
  requestId: string
  method: V1WorkerRpcMethod
  params: unknown
}

export interface V1WorkerRpcResponse {
  kind: 'module-agent.worker.response'
  requestId: string
  ok: boolean
  result?: unknown
  error?: { code: 'REQUEST_FAILED' }
}

export type V1RpcWireMessage =
  | V1HostRpcRequest
  | V1HostRpcResponse
  | V1HostRpcEvent
  | V1WorkerRpcRequest
  | V1WorkerRpcResponse

const hostMethods = new Set<V1HostRpcMethod>([
  'path.canonicalize',
  'path.isEqualOrWithin',
  'session.create',
  'session.sendTurn',
  'session.cancelTurn',
  'session.awaitStopped',
  'session.disposeAndReap',
  'session.subscribe',
  'session.unsubscribe',
])
const workerMethods = new Set<V1WorkerRpcMethod>(['prepareLaunch', 'disposeLease', 'debugSnapshot'])

function ownValue(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor && 'value' in descriptor ? descriptor.value : undefined
}

function exactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value)
  return actual.length === keys.length
    && actual.every((key) => typeof key === 'string' && keys.includes(key))
}

function validRequestId(value: unknown, prefix: 'host' | 'worker'): value is string {
  return typeof value === 'string' && new RegExp(`^${prefix}_[1-9][0-9]*$`).test(value)
}

export function parseV1RpcWireMessage(value: unknown): V1RpcWireMessage | undefined {
  if (!value || typeof value !== 'object') return undefined
  const kind = ownValue(value, 'kind')
  if (kind === 'module-agent.host.request' || kind === 'module-agent.worker.request') {
    if (!exactKeys(value, ['kind', 'requestId', 'method', 'params'])) return undefined
    const requestId = ownValue(value, 'requestId')
    const method = ownValue(value, 'method')
    const host = kind === 'module-agent.host.request'
    if (!validRequestId(requestId, host ? 'worker' : 'host')) return undefined
    if (typeof method !== 'string' || !(host ? hostMethods.has(method as V1HostRpcMethod) : workerMethods.has(method as V1WorkerRpcMethod))) {
      return undefined
    }
    return { kind, requestId, method, params: ownValue(value, 'params') } as V1HostRpcRequest | V1WorkerRpcRequest
  }
  if (kind === 'module-agent.host.response' || kind === 'module-agent.worker.response') {
    const ok = ownValue(value, 'ok')
    const host = kind === 'module-agent.host.response'
    const requestId = ownValue(value, 'requestId')
    if (typeof ok !== 'boolean' || !validRequestId(requestId, host ? 'worker' : 'host')) return undefined
    if (ok) {
      if (!exactKeys(value, ['kind', 'requestId', 'ok', 'result'])) return undefined
      return { kind, requestId, ok, result: ownValue(value, 'result') }
    }
    if (!exactKeys(value, ['kind', 'requestId', 'ok', 'error'])) return undefined
    const error = ownValue(value, 'error')
    if (!error || typeof error !== 'object' || !exactKeys(error, ['code']) || ownValue(error, 'code') !== 'REQUEST_FAILED') return undefined
    return { kind, requestId, ok, error: { code: 'REQUEST_FAILED' } }
  }
  if (kind === 'module-agent.host.event') {
    if (!exactKeys(value, ['kind', 'subscriptionId', 'event'])) return undefined
    const subscriptionId = ownValue(value, 'subscriptionId')
    if (typeof subscriptionId !== 'string' || !/^sub_[1-9][0-9]*$/.test(subscriptionId)) return undefined
    return { kind, subscriptionId, event: ownValue(value, 'event') as ModuleAgentPortEvent }
  }
  return undefined
}

export function v1RpcLane(method: V1HostRpcMethod | V1WorkerRpcMethod): 'business' | 'terminal' {
  return method === 'session.cancelTurn'
    || method === 'session.awaitStopped'
    || method === 'session.disposeAndReap'
    || method === 'session.unsubscribe'
    || method === 'disposeLease'
    ? 'terminal'
    : 'business'
}
