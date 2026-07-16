import type {
  HOST_AGENT_ACTIVITY_KINDS,
  HOST_AGENT_ACTIVITY_PHASES,
  HOST_AGENT_CONTRACT_VERSION,
  HOST_AGENT_ERROR_CODES,
  HOST_AGENT_EVENT_TYPES,
  HOST_AGENT_INTERRUPTION_REASONS,
  HOST_AGENT_PRESENTATION_KINDS,
  HOST_AGENT_RUN_STATES,
  HOST_AGENT_TERMINAL_RUN_STATES,
  HOST_AGENT_TURN_FAILURE_CODES,
} from './constants.ts'

export type HostAgentRunState = (typeof HOST_AGENT_RUN_STATES)[number]
export type HostAgentTerminalRunState = (typeof HOST_AGENT_TERMINAL_RUN_STATES)[number]
export type HostAgentEventType = (typeof HOST_AGENT_EVENT_TYPES)[number]
export type HostAgentActivityPhase = (typeof HOST_AGENT_ACTIVITY_PHASES)[number]
export type HostAgentActivityKind = (typeof HOST_AGENT_ACTIVITY_KINDS)[number]
export type HostAgentPresentationKind = (typeof HOST_AGENT_PRESENTATION_KINDS)[number]
export type HostAgentTurnFailureCode = (typeof HOST_AGENT_TURN_FAILURE_CODES)[number]
export type HostAgentInterruptionReason = (typeof HOST_AGENT_INTERRUPTION_REASONS)[number]
export type HostAgentErrorCode = (typeof HOST_AGENT_ERROR_CODES)[number]

export interface HostAgentPublicLimits {
  maxPromptBytes: number
  maxEventBytes: number
  maxDeltaBytes: number
  maxReplayEvents: number
  maxReplayBytes: number
  maxSseSubscribers: number
  maxConcurrentRuns: number
  maxRunDurationMs: number
}

export interface HostAgentCapabilitiesResponse {
  contractVersion: typeof HOST_AGENT_CONTRACT_VERSION
  capability: 'host-agent.run'
  features: {
    streaming: true
    cancellation: true
    reconnect: true
    idempotency: true
  }
  limits: HostAgentPublicLimits
}

/** The sole v2 POST /runs body. Identity, provider, model, and session data are Host-owned. */
export interface CreateHostAgentRunRequest {
  contractVersion: typeof HOST_AGENT_CONTRACT_VERSION
  prompt: string
  workingDirectory?: string
}

export interface HostAgentRunSnapshot {
  contractVersion: typeof HOST_AGENT_CONTRACT_VERSION
  runHandle: string
  state: HostAgentRunState
  createdAt: number
  updatedAt: number
  terminalAt?: number
  closedAt?: number
}

export type CreateHostAgentRunResponse = HostAgentRunSnapshot
export type GetHostAgentRunResponse = HostAgentRunSnapshot
export type CancelHostAgentRunResponse = HostAgentRunSnapshot

export interface HostAgentEventBase<TType extends HostAgentEventType, TData> {
  contractVersion: typeof HOST_AGENT_CONTRACT_VERSION
  eventId: string
  sequence: number
  runHandle: string
  occurredAt: number
  type: TType
  data: TData
}

export type HostAgentRunAcceptedEvent = HostAgentEventBase<'run.accepted', Record<string, never>>
export type HostAgentTurnStartedEvent = HostAgentEventBase<'turn.started', Record<string, never>>
export type HostAgentMessageDeltaEvent = HostAgentEventBase<'message.delta', { delta: string }>
export type HostAgentReasoningDeltaEvent = HostAgentEventBase<'reasoning.delta', { delta: string }>
export type HostAgentActivityEvent = HostAgentEventBase<'activity', {
  phase: HostAgentActivityPhase
  kind: HostAgentActivityKind
  label?: string
}>

export interface HostAgentPresentationItem {
  itemId: string
  kind: HostAgentPresentationKind
  title?: string
  text?: string
  uri?: string
  mediaType?: string
}

export type HostAgentPresentationItemEvent = HostAgentEventBase<'presentation.item', HostAgentPresentationItem>
export type HostAgentTurnCompletedEvent = HostAgentEventBase<'turn.completed', { finalText?: string }>
export type HostAgentTurnFailedEvent = HostAgentEventBase<'turn.failed', {
  code: HostAgentTurnFailureCode
  retryable: boolean
}>
export type HostAgentTurnInterruptedEvent = HostAgentEventBase<'turn.interrupted', {
  reason: HostAgentInterruptionReason
  retryable: boolean
}>
export type HostAgentRunClosedEvent = HostAgentEventBase<'run.closed', Record<string, never>>

export type HostAgentEvent =
  | HostAgentRunAcceptedEvent
  | HostAgentTurnStartedEvent
  | HostAgentMessageDeltaEvent
  | HostAgentReasoningDeltaEvent
  | HostAgentActivityEvent
  | HostAgentPresentationItemEvent
  | HostAgentTurnCompletedEvent
  | HostAgentTurnFailedEvent
  | HostAgentTurnInterruptedEvent
  | HostAgentRunClosedEvent

export interface HostAgentPublicError {
  code: HostAgentErrorCode
  message: string
  retryable: boolean
}

export interface HostAgentErrorResponse {
  contractVersion: typeof HOST_AGENT_CONTRACT_VERSION
  error: HostAgentPublicError
}

export type HostAgentHttpMethod = 'GET' | 'POST' | 'DELETE'
export type HostAgentRouteName = 'capabilities' | 'runs.create' | 'runs.get' | 'runs.events' | 'runs.cancel' | 'runs.delete'

export type HostAgentRouteMatch =
  | { route: 'capabilities' | 'runs.create' }
  | { route: 'runs.get' | 'runs.events' | 'runs.cancel' | 'runs.delete'; runHandle: string }

export interface HostAgentIdempotencyDigests {
  /** Digest of the validated key, safe to use as a map key without retaining the caller's raw header. */
  keyDigest: string
  /** Digest of the closed canonical POST /runs request. */
  requestDigest: string
}
