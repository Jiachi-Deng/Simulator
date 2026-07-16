import type {
  CreateHostAgentRunRequest,
  HostAgentEvent,
  HostAgentInterruptionReason,
  HostAgentRunSnapshot,
  HostAgentRunState,
  HostAgentTurnFailureCode,
} from '@simulator/host-agent-contract'

export interface HostAgentRunOwnership {
  transient: true
  contractVersion: 2
  moduleId: string
  runHandle: string
  idempotencyKeyDigest: string
  requestDigest: string
  workerEpoch: string
  state: HostAgentRunState
}

export interface CreateHostAgentSessionInput {
  workspaceId: string
  workspaceRoot: string
  authorizedWorkingRoot: string
  workingDirectory: string
  ownership: HostAgentRunOwnership
}

export interface CreatedHostAgentSession {
  sessionId: string
  workspaceId: string
  workspaceRoot: string
  workingDirectory: string
  hidden: true
}

export type HostAgentSessionEvent =
  | { type: 'message.delta'; sessionId: string; delta: string }
  | { type: 'reasoning.delta'; sessionId: string; delta: string }
  | { type: 'activity'; sessionId: string; phase: 'started' | 'finished'; kind: 'runtime' | 'tool'; label?: string }
  | { type: 'presentation.item'; sessionId: string; data: { itemId: string; kind: 'text' | 'image' | 'file' | 'preview'; title?: string; text?: string; uri?: string; mediaType?: string } }
  | { type: 'turn.completed'; sessionId: string; finalText?: string }
  | { type: 'turn.failed'; sessionId: string; code: HostAgentTurnFailureCode }
  | { type: 'turn.interrupted'; sessionId: string; reason: HostAgentInterruptionReason }

/** Narrow Host-owned SessionManager seam. Module workers never receive this object. */
export interface HostAgentRunSessionPort {
  createSession(input: CreateHostAgentSessionInput): Promise<CreatedHostAgentSession>
  /**
   * Authoritatively recover a Session whose ownership header may have been
   * committed before createSession's response was lost. `undefined` means the
   * Host proved that no matching Session exists; rejection means ownership is
   * still uncertain and must remain reserved.
   */
  recoverSession(input: CreateHostAgentSessionInput): Promise<CreatedHostAgentSession | undefined>
  updateRunState(sessionId: string, state: HostAgentRunState): Promise<void>
  sendTurn(sessionId: string, prompt: string): Promise<void>
  cancelTurn(sessionId: string): Promise<void>
  awaitStopped(sessionId: string): Promise<void>
  disposeAndReap(sessionId: string): Promise<void>
  subscribe(sessionId: string, listener: (event: HostAgentSessionEvent) => void): () => void
}

export interface HostAgentRunPathAuthority {
  canonicalize(path: string): Promise<string>
  isEqualOrWithin(candidate: string, root: string): boolean
}

export interface HostAgentRunIdSource {
  createHex(bytes: number): string
}

export interface HostAgentRunClock {
  now(): number
  setTimeout(callback: () => void, delayMs: number): unknown
  clearTimeout(handle: unknown): void
}

export interface HostAgentRunGrantSpec {
  grantId: string
  moduleId: string
  workerEpoch: string
  workspaceId: string
  workspaceRoot: string
  authorizedWorkingRoot: string
  defaultWorkingDirectory: string
  expiresAt: number
}

export interface HostAgentRunCoreLimits {
  maxReplayEvents: number
  maxReplayBytes: number
  maxSubscribersPerGrant: number
  maxConcurrentRuns: number
  maxRunDurationMs: number
  maxCraftPreemptionMs: number
  tombstoneMinRetentionMs: number
}

export interface HostAgentRunCoreDependencies {
  sessions: HostAgentRunSessionPort
  paths: HostAgentRunPathAuthority
  ids: HostAgentRunIdSource
  clock?: HostAgentRunClock
  limits?: Partial<HostAgentRunCoreLimits>
}

export interface HostAgentRunSubscription {
  replayed: number
  earliestEventId?: string
  latestEventId?: string
  unsubscribe(): void
}

export interface HostAgentRunCoreSnapshot {
  activeGrants: number
  activeRuns: number
  retainedRuns: number
  moduleSessions: number
  subscribers: number
}

export interface CreateHostAgentRunInput {
  grantId: string
  idempotencyKey: string
  request: CreateHostAgentRunRequest | unknown
}

export interface HostAgentRunRecordView {
  snapshot: HostAgentRunSnapshot
  request: CreateHostAgentRunRequest
}

export type HostAgentRunCoreErrorCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'RUN_NOT_FOUND'
  | 'RUN_ACTIVE'
  | 'IDEMPOTENCY_CONFLICT'
  | 'REPLAY_UNAVAILABLE'
  | 'INVALID_REQUEST'
  | 'RATE_LIMITED'
  | 'CRAFT_TURN_ACTIVE'
  | 'RUNTIME_UNAVAILABLE'
  | 'TOOL_BOUNDARY_UNAVAILABLE'
  | 'CLEANUP_FAILED'
  | 'INTERNAL_ERROR'

export class HostAgentRunCoreError extends Error {
  constructor(readonly code: HostAgentRunCoreErrorCode, message: string) {
    super(message)
    this.name = 'HostAgentRunCoreError'
  }
}

/** Explicit pre-commit signal; all untyped Session creation errors are uncertain. */
export class HostAgentSessionCreateError extends Error {
  constructor(
    readonly commit: 'not-created' | 'unknown',
    message: string,
  ) {
    super(message)
    this.name = 'HostAgentSessionCreateError'
  }
}

export type HostAgentRunTerminalCommit =
  | { state: 'completed'; finalText?: string }
  | { state: 'failed'; code: HostAgentTurnFailureCode }
  | { state: 'interrupted'; reason: HostAgentInterruptionReason }

export type HostAgentRunEventListener = (event: HostAgentEvent) => void
