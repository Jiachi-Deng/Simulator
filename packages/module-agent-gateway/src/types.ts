export const MODULE_AGENT_CONTRACT_VERSION = 1 as const
export const MODULE_AGENT_CAPABILITY = 'host-agent.use' as const
export const MODULE_AGENT_SSE_EVENT = 'module-agent.event' as const

export const MODULE_AGENT_ENV = Object.freeze({
  url: 'SIMULATOR_HOST_AGENT_URL',
  tokenFile: 'SIMULATOR_HOST_AGENT_TOKEN_FILE',
})

export const MODULE_AGENT_ROUTES = Object.freeze({
  capabilities: '/v1/capabilities',
  sessions: '/v1/module-sessions',
  turns: (sessionHandle: string) => `/v1/module-sessions/${encodeURIComponent(sessionHandle)}/turns`,
  events: (sessionHandle: string) => `/v1/module-sessions/${encodeURIComponent(sessionHandle)}/events`,
  cancel: (sessionHandle: string) => `/v1/module-sessions/${encodeURIComponent(sessionHandle)}/cancel`,
  session: (sessionHandle: string) => `/v1/module-sessions/${encodeURIComponent(sessionHandle)}`,
})

export interface ModuleAgentLimits {
  maxPromptBytes: number
  maxReplayEvents: number
  maxEventTextLength: number
  maxSessionsPerGrant: number
  maxSubscribersPerSession: number
}

export const DEFAULT_MODULE_AGENT_LIMITS: Readonly<ModuleAgentLimits> = Object.freeze({
  maxPromptBytes: 2 * 1024 * 1024,
  maxReplayEvents: 256,
  maxEventTextLength: 2 * 1024 * 1024,
  maxSessionsPerGrant: 4,
  maxSubscribersPerSession: 4,
})

export interface ModuleAgentCapabilitiesResponse {
  contractVersion: typeof MODULE_AGENT_CONTRACT_VERSION
  capability: typeof MODULE_AGENT_CAPABILITY
  features: {
    streaming: true
    cancellation: true
    multiTurn: true
  }
  limits: Pick<ModuleAgentLimits, 'maxPromptBytes' | 'maxReplayEvents'>
}

export interface CreateModuleAgentSessionRequest {
  contractVersion: typeof MODULE_AGENT_CONTRACT_VERSION
  workingDirectory?: string
}

export interface CreateModuleAgentSessionResponse {
  contractVersion: typeof MODULE_AGENT_CONTRACT_VERSION
  sessionHandle: string
  state: 'idle'
}

export interface StartModuleAgentTurnRequest {
  contractVersion: typeof MODULE_AGENT_CONTRACT_VERSION
  prompt: string
}

export interface StartModuleAgentTurnResponse {
  contractVersion: typeof MODULE_AGENT_CONTRACT_VERSION
  turnId: string
  state: 'running'
}

export interface CancelModuleAgentTurnRequest {
  contractVersion: typeof MODULE_AGENT_CONTRACT_VERSION
}

export interface CancelModuleAgentTurnResponse {
  contractVersion: typeof MODULE_AGENT_CONTRACT_VERSION
  state: 'cancelling' | 'idle'
}

export const MODULE_AGENT_EVENT_TYPES = [
  'session.ready',
  'turn.started',
  'message.delta',
  'message.completed',
  'activity',
  'turn.completed',
  'turn.failed',
  'turn.cancelled',
  'session.closed',
] as const

export type ModuleAgentEventType = (typeof MODULE_AGENT_EVENT_TYPES)[number]

export type ModuleAgentEventData =
  | { type: 'session.ready'; data: Record<string, never> }
  | { type: 'turn.started'; data: Record<string, never> }
  | { type: 'message.delta'; data: { delta: string } }
  | { type: 'message.completed'; data: { text: string } }
  | { type: 'activity'; data: { phase: 'started' | 'finished'; kind: 'runtime' | 'tool'; label?: string } }
  | { type: 'turn.completed'; data: { text?: string } }
  | { type: 'turn.failed'; data: { code: 'HOST_RUNTIME_ERROR' | 'HOST_RUNTIME_TIMEOUT' } }
  | { type: 'turn.cancelled'; data: Record<string, never> }
  | { type: 'session.closed'; data: Record<string, never> }

export type ModuleAgentEvent = ModuleAgentEventData & {
  contractVersion: typeof MODULE_AGENT_CONTRACT_VERSION
  sequence: number
  sessionHandle: string
  turnId?: string
  occurredAt: number
}

/**
 * Trusted identity supplied by the Host transport. These fields are never read
 * from a Module request body or query string.
 */
export interface TrustedModuleAgentIdentity {
  ownerId: string
  moduleId: string
  /** Host-generated process-instance binding. It is not accepted from Module input. */
  launchId: string
  lifecycleId: string
}

export interface ModuleAgentAuthorization extends TrustedModuleAgentIdentity {
  grantToken: string
}

export interface ModuleAgentGrantSpec extends TrustedModuleAgentIdentity {
  workspaceId: string
  workspaceRoot: string
  authorizedWorkingRoot: string
  defaultWorkingDirectory: string
  expiresAt: number
}

export interface ModuleAgentGrant {
  contractVersion: typeof MODULE_AGENT_CONTRACT_VERSION
  capability: typeof MODULE_AGENT_CAPABILITY
  grantToken: string
  expiresAt: number
}

export interface ModuleAgentPathAuthority {
  canonicalize(path: string): Promise<string>
  isEqualOrWithin(candidate: string, root: string): boolean | Promise<boolean>
}

export interface ModuleAgentTokenSource {
  createHex(bytes: number): string
}

export interface ModuleAgentClock {
  now(): number
}

/** Sanitized, provider-neutral events emitted by the trusted SessionManager seam. */
export type ModuleAgentPortEvent =
  | { type: 'message.delta'; sessionId: string; delta: string }
  | { type: 'message.completed'; sessionId: string; text: string }
  | { type: 'activity'; sessionId: string; phase: 'started' | 'finished'; kind: 'runtime' | 'tool'; label?: string }
  | { type: 'turn.completed'; sessionId: string; finalText?: string }
  | { type: 'turn.failed'; sessionId: string; code: 'HOST_RUNTIME_ERROR' | 'HOST_RUNTIME_TIMEOUT' }
  | { type: 'turn.cancelled'; sessionId: string }

export interface CreateHostModuleSessionInput {
  workspaceId: string
  workspaceRoot: string
  authorizedWorkingRoot: string
  workingDirectory: string
}

export interface CreatedHostModuleSession {
  /** Raw Craft session id. This value remains inside the trusted Host. */
  sessionId: string
  workspaceId: string
  workspaceRoot: string
  workingDirectory: string
  hidden: true
}

/** The only SessionManager surface visible to the Gateway core. */
export interface ModuleAgentSessionPort {
  createSession(input: CreateHostModuleSessionInput): Promise<CreatedHostModuleSession>
  sendTurn(sessionId: string, prompt: string): Promise<void>
  cancelTurn(sessionId: string): Promise<void>
  /** Wait until provider/query turn processing and its persistence tail have stopped. */
  awaitStopped(sessionId: string): Promise<void>
  /** Strict teardown: stop, dispose, reap Host resources, and remove persistence. */
  disposeAndReap(sessionId: string): Promise<void>
  subscribe(
    sessionId: string,
    listener: (event: ModuleAgentPortEvent) => void,
  ): (() => void) | Promise<() => void>
}

export const MODULE_AGENT_ERROR_CODES = [
  'INVALID_CONTRACT_VERSION',
  'INVALID_REQUEST',
  'UNAUTHORIZED',
  'GRANT_EXPIRED',
  'GRANT_REVOKED',
  'WORKSPACE_DENIED',
  'SESSION_NOT_FOUND',
  'SESSION_LIMIT',
  'TURN_ACTIVE',
  'NO_ACTIVE_TURN',
  'PROMPT_TOO_LARGE',
  'SUBSCRIBER_LIMIT',
  'REPLAY_TRUNCATED',
  'HOST_RUNTIME_ERROR',
] as const

export type ModuleAgentErrorCode = (typeof MODULE_AGENT_ERROR_CODES)[number]

export class ModuleAgentGatewayError extends Error {
  constructor(
    readonly code: ModuleAgentErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'ModuleAgentGatewayError'
  }
}

export interface ModuleAgentGatewayDependencies {
  port: ModuleAgentSessionPort
  pathAuthority: ModuleAgentPathAuthority
  tokenSource: ModuleAgentTokenSource
  clock?: ModuleAgentClock
  limits?: Partial<ModuleAgentLimits>
}

export interface ModuleAgentGatewaySnapshot {
  activeGrants: number
  activeSessions: number
  activeTurns: number
  activeSubscribers: number
}

export interface ModuleAgentSubscription {
  earliestSequence: number
  latestSequence: number
  replayTruncated: boolean
  unsubscribe(): void
}
