import type {
  CreateHostAgentRunRequest,
  HostAgentEvent,
  HostAgentRunSnapshot,
} from '@simulator/host-agent-contract'

/**
 * Grant-bound narrow seam presented to the loopback HTTP worker. Implementations
 * may marshal these calls over a MessagePort, but may never expose SessionManager.
 */
export interface HostAgentBrokerCoreClient {
  createRun(idempotencyKey: string, request: CreateHostAgentRunRequest): Promise<HostAgentRunSnapshot>
  getRun(runHandle: string): Promise<HostAgentRunSnapshot>
  subscribeRun(
    runHandle: string,
    afterSequence: number | undefined,
    listener: (event: HostAgentEvent) => void,
  ): Promise<HostAgentBrokerCoreSubscription>
  cancelRun(runHandle: string): Promise<HostAgentRunSnapshot>
  closeRun(runHandle: string): Promise<HostAgentRunSnapshot>
}

export interface HostAgentBrokerCoreSubscription {
  replayed: number
  earliestEventId?: string
  latestEventId?: string
  unsubscribe(): void | Promise<void>
}

export interface HostAgentBrokerServerAddress {
  host: '127.0.0.1'
  port: number
  url: string
}

export interface HostAgentBrokerServerLimits {
  maxSockets: number
  maxConcurrentRequests: number
  maxSseSubscribers: number
  maxRequestBodyBytes: number
  heartbeatIntervalMs: number
  headerTimeoutMs: number
  bodyTimeoutMs: number
  idleTimeoutMs: number
  maxSseBufferedBytes: number
}
