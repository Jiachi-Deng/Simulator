export type HostAgentProtocolPath = 'v1' | 'v2'

export const HOST_AGENT_PROTOCOL_PATHS: readonly HostAgentProtocolPath[] = ['v1', 'v2']

export const HOST_AGENT_WORKER_LIMITS = Object.freeze({
  maxHeapMiB: 64,
  maxRssBytes: 128 * 1024 * 1024,
  healthIntervalMs: 10_000,
  crashThreshold: 3,
  crashWindowMs: 5 * 60_000,
  gracefulStopTimeoutMs: 5_000,
  startupTimeoutMs: 10_000,
})

export interface HostAgentWorkerAttachMessage {
  kind: 'simulator.host-agent.attach'
  protocol: HostAgentProtocolPath
  epoch: string
}

export interface HostAgentWorkerReadyMessage {
  kind: 'simulator.host-agent.worker.ready'
  protocol: HostAgentProtocolPath
  epoch: string
  pid: number
  address?: {
    host: '127.0.0.1'
    port: number
    url: string
  }
}

export interface HostAgentWorkerHealthMessage {
  kind: 'simulator.host-agent.worker.health'
  protocol: HostAgentProtocolPath
  epoch: string
  rssBytes: number
}

export interface HostAgentWorkerShutdownMessage {
  kind: 'simulator.host-agent.worker.shutdown'
  protocol: HostAgentProtocolPath
  epoch: string
}

export interface HostAgentWorkerShutdownAckMessage {
  kind: 'simulator.host-agent.worker.shutdown-ack'
  protocol: HostAgentProtocolPath
  epoch: string
}

export interface HostAgentWorkerBootstrapFailedMessage {
  kind: 'simulator.host-agent.worker.bootstrap-failed'
  protocol: HostAgentProtocolPath
  epoch: string
  stage: 'attach' | 'token' | 'configuration' | 'runtime'
}

export interface HostAgentWorkerRpcRequest {
  kind: 'simulator.host-agent.rpc.request'
  protocol: HostAgentProtocolPath
  epoch: string
  requestId: string
  method: string
  payload: unknown
}

export interface HostAgentWorkerRpcSuccess {
  kind: 'simulator.host-agent.rpc.response'
  protocol: HostAgentProtocolPath
  epoch: string
  requestId: string
  ok: true
  value: unknown
}

export interface HostAgentWorkerRpcFailure {
  kind: 'simulator.host-agent.rpc.response'
  protocol: HostAgentProtocolPath
  epoch: string
  requestId: string
  ok: false
  error: {
    code: 'METHOD_UNAVAILABLE' | 'REQUEST_FAILED'
  }
}

export type HostAgentWorkerRpcResponse = HostAgentWorkerRpcSuccess | HostAgentWorkerRpcFailure

export type HostAgentWorkerToHostMessage =
  | HostAgentWorkerReadyMessage
  | HostAgentWorkerHealthMessage
  | HostAgentWorkerShutdownAckMessage
  | HostAgentWorkerBootstrapFailedMessage
  | HostAgentWorkerRpcRequest

export type HostAgentHostToWorkerMessage = HostAgentWorkerShutdownMessage | HostAgentWorkerRpcResponse

function ownValue(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor && 'value' in descriptor ? descriptor.value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function isHostAgentProtocolPath(value: unknown): value is HostAgentProtocolPath {
  return value === 'v1' || value === 'v2'
}

export function parseHostAgentWorkerMessage(value: unknown): HostAgentWorkerToHostMessage | undefined {
  if (!isRecord(value)) return undefined
  const kind = ownValue(value, 'kind')
  const protocol = ownValue(value, 'protocol')
  const epoch = ownValue(value, 'epoch')
  if (!isHostAgentProtocolPath(protocol) || typeof epoch !== 'string' || epoch.length === 0) return undefined

  if (kind === 'simulator.host-agent.worker.ready') {
    const pid = ownValue(value, 'pid')
    if (!Number.isSafeInteger(pid) || (pid as number) < 1) return undefined
    const address = ownValue(value, 'address')
    if (address === undefined) return { kind, protocol, epoch, pid: pid as number }
    if (!isRecord(address)
      || ownValue(address, 'host') !== '127.0.0.1'
      || typeof ownValue(address, 'port') !== 'number'
      || !Number.isSafeInteger(ownValue(address, 'port'))
      || (ownValue(address, 'port') as number) < 1
      || typeof ownValue(address, 'url') !== 'string') return undefined
    const port = ownValue(address, 'port') as number
    const url = ownValue(address, 'url') as string
    if (url !== `http://127.0.0.1:${port}`) return undefined
    return { kind, protocol, epoch, pid: pid as number, address: { host: '127.0.0.1', port, url } }
  }
  if (kind === 'simulator.host-agent.worker.health') {
    const rssBytes = ownValue(value, 'rssBytes')
    if (!Number.isSafeInteger(rssBytes) || (rssBytes as number) < 0) return undefined
    return { kind, protocol, epoch, rssBytes: rssBytes as number }
  }
  if (kind === 'simulator.host-agent.worker.shutdown-ack') {
    return { kind, protocol, epoch }
  }
  if (kind === 'simulator.host-agent.worker.bootstrap-failed') {
    const stage = ownValue(value, 'stage')
    if (stage !== 'attach' && stage !== 'token' && stage !== 'configuration' && stage !== 'runtime') return undefined
    return { kind, protocol, epoch, stage }
  }
  if (kind === 'simulator.host-agent.rpc.request') {
    const requestId = ownValue(value, 'requestId')
    const method = ownValue(value, 'method')
    if (typeof requestId !== 'string' || requestId.length === 0 || requestId.length > 128) return undefined
    if (typeof method !== 'string' || method.length === 0 || method.length > 128) return undefined
    return { kind, protocol, epoch, requestId, method, payload: ownValue(value, 'payload') }
  }
  return undefined
}

export function isHostAgentWorkerAttachMessage(value: unknown): value is HostAgentWorkerAttachMessage {
  if (!isRecord(value)) return false
  return ownValue(value, 'kind') === 'simulator.host-agent.attach'
    && isHostAgentProtocolPath(ownValue(value, 'protocol'))
    && typeof ownValue(value, 'epoch') === 'string'
    && (ownValue(value, 'epoch') as string).length > 0
}

export function isHostAgentHostMessage(value: unknown): value is HostAgentHostToWorkerMessage {
  if (!isRecord(value)) return false
  const kind = ownValue(value, 'kind')
  const protocol = ownValue(value, 'protocol')
  const epoch = ownValue(value, 'epoch')
  if (!isHostAgentProtocolPath(protocol) || typeof epoch !== 'string' || epoch.length === 0) return false
  if (kind === 'simulator.host-agent.worker.shutdown') return true
  if (kind !== 'simulator.host-agent.rpc.response') return false
  const requestId = ownValue(value, 'requestId')
  const ok = ownValue(value, 'ok')
  return typeof requestId === 'string' && requestId.length > 0 && typeof ok === 'boolean'
}
