export const HOST_AGENT_CONTRACT_VERSION = 2 as const
export const HOST_AGENT_CAPABILITY = 'host-agent.run' as const
export const HOST_AGENT_SSE_EVENT = 'host-agent.event' as const

export const HOST_AGENT_HEADERS = Object.freeze({
  idempotencyKey: 'Idempotency-Key',
  lastEventId: 'Last-Event-ID',
})

export const HOST_AGENT_ENV = Object.freeze({
  url: 'SIMULATOR_HOST_AGENT_URL',
  tokenFile: 'SIMULATOR_HOST_AGENT_TOKEN_FILE',
  shimPath: 'SIMULATOR_HOST_AGENT_SHIM_PATH',
  contractVersion: 'SIMULATOR_HOST_AGENT_CONTRACT_VERSION',
})

export const HOST_AGENT_ENV_CONTRACT_VERSION = '2' as const

export const HOST_AGENT_RUN_HANDLE_PATTERN = /^run_[0-9a-f]{32}$/
export const HOST_AGENT_IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/
export const HOST_AGENT_CANONICAL_CURSOR_PATTERN = /^(0|[1-9][0-9]*)$/

function routeRunHandle(runHandle: string): string {
  if (!HOST_AGENT_RUN_HANDLE_PATTERN.test(runHandle)) {
    throw new TypeError('Host Agent run handle must match run_[0-9a-f]{32}')
  }
  return runHandle
}

export const HOST_AGENT_ROUTES = Object.freeze({
  capabilities: '/v2/capabilities',
  runs: '/v2/runs',
  run: (runHandle: string) => `/v2/runs/${routeRunHandle(runHandle)}`,
  events: (runHandle: string) => `/v2/runs/${routeRunHandle(runHandle)}/events`,
  cancel: (runHandle: string) => `/v2/runs/${routeRunHandle(runHandle)}/cancel`,
})

export interface HostAgentLimits {
  maxRequestBodyBytes: number
  maxPromptBytes: number
  maxWorkingDirectoryBytes: number
  maxEventBytes: number
  maxDeltaBytes: number
  maxReplayEvents: number
  maxReplayBytes: number
  messagePortCreditBytes: number
  terminalControlReserveBytes: number
  maxSseSubscribersPerGrant: number
  maxSocketsPerGrant: number
  maxConcurrentHttpRequestsPerGrant: number
  maxConcurrentModuleRuns: number
  heartbeatIntervalMs: number
  maxRunDurationMs: number
  workerHeapBytes: number
  workerRssGateBytes: number
  workerCrashWindowMs: number
  maxWorkerCrashesPerWindow: number
  maxStartupP95Ms: number
  tombstoneMinRetentionMs: number
  maxIdempotencyKeyBytes: number
  maxErrorMessageBytes: number
  maxActivityLabelBytes: number
}

const MiB = 1024 * 1024
const KiB = 1024

/** Hard v2 protocol and process ceilings. Implementations may not raise them. */
export const HOST_AGENT_LIMITS: Readonly<HostAgentLimits> = Object.freeze({
  maxRequestBodyBytes: 2 * MiB,
  maxPromptBytes: 2 * MiB,
  maxWorkingDirectoryBytes: 4 * KiB,
  maxEventBytes: 256 * KiB,
  maxDeltaBytes: 64 * KiB,
  maxReplayEvents: 1024,
  maxReplayBytes: 8 * MiB,
  messagePortCreditBytes: 2 * MiB,
  terminalControlReserveBytes: 64 * KiB,
  maxSseSubscribersPerGrant: 2,
  maxSocketsPerGrant: 8,
  maxConcurrentHttpRequestsPerGrant: 4,
  maxConcurrentModuleRuns: 1,
  heartbeatIntervalMs: 10_000,
  maxRunDurationMs: 30 * 60_000,
  workerHeapBytes: 64 * MiB,
  workerRssGateBytes: 128 * MiB,
  workerCrashWindowMs: 5 * 60_000,
  maxWorkerCrashesPerWindow: 3,
  maxStartupP95Ms: 250,
  tombstoneMinRetentionMs: 24 * 60 * 60_000,
  maxIdempotencyKeyBytes: 128,
  maxErrorMessageBytes: 1024,
  maxActivityLabelBytes: 4096,
})

export const HOST_AGENT_RUN_STATES = [
  'accepted',
  'starting',
  'running',
  'completed',
  'failed',
  'interrupted',
  'closing',
  'closed',
] as const

export const HOST_AGENT_TERMINAL_RUN_STATES = ['completed', 'failed', 'interrupted'] as const

export const HOST_AGENT_EVENT_TYPES = [
  'run.accepted',
  'turn.started',
  'message.delta',
  'reasoning.delta',
  'activity',
  'presentation.item',
  'turn.completed',
  'turn.failed',
  'turn.interrupted',
  'run.closed',
] as const

export const HOST_AGENT_PRESENTATION_KINDS = ['text', 'image', 'file', 'preview'] as const
export const HOST_AGENT_ACTIVITY_PHASES = ['started', 'finished'] as const
export const HOST_AGENT_ACTIVITY_KINDS = ['runtime', 'tool'] as const

export const HOST_AGENT_TURN_FAILURE_CODES = [
  'RUNTIME_UNAVAILABLE',
  'TOOL_BOUNDARY_UNAVAILABLE',
  'RUN_TIMEOUT',
  'BROKER_DISCONNECTED',
  'INTERNAL_ERROR',
] as const

export const HOST_AGENT_INTERRUPTION_REASONS = [
  'CLIENT_CANCELLED',
  'CRAFT_TURN_PREEMPTED',
  'BROKER_DISCONNECTED',
  'RUN_TIMEOUT',
  'HOST_SHUTDOWN',
] as const

export const HOST_AGENT_ERROR_CODES = [
  'INVALID_REQUEST',
  'INVALID_CONTRACT_VERSION',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'RUN_NOT_FOUND',
  'RUN_ACTIVE',
  'IDEMPOTENCY_CONFLICT',
  'REPLAY_UNAVAILABLE',
  'PAYLOAD_TOO_LARGE',
  'RATE_LIMITED',
  'CRAFT_TURN_ACTIVE',
  'RUNTIME_UNAVAILABLE',
  'TOOL_BOUNDARY_UNAVAILABLE',
  'BROKER_DISCONNECTED',
  'RUN_TIMEOUT',
  'CLEANUP_FAILED',
  'INTERNAL_ERROR',
] as const

export interface HostAgentPublicErrorDefinition {
  readonly httpStatus: number
  readonly retryable: boolean
  readonly message: string
}

export const HOST_AGENT_ERROR_DEFINITIONS = Object.freeze({
  INVALID_REQUEST: { httpStatus: 400, retryable: false, message: 'The request is invalid.' },
  INVALID_CONTRACT_VERSION: { httpStatus: 400, retryable: false, message: 'The contract version is not supported.' },
  UNAUTHORIZED: { httpStatus: 401, retryable: false, message: 'Authentication failed.' },
  FORBIDDEN: { httpStatus: 403, retryable: false, message: 'The operation is not permitted.' },
  RUN_NOT_FOUND: { httpStatus: 404, retryable: false, message: 'The run was not found.' },
  RUN_ACTIVE: { httpStatus: 409, retryable: true, message: 'A module run is already active.' },
  IDEMPOTENCY_CONFLICT: { httpStatus: 409, retryable: false, message: 'The idempotency key was already used for a different request.' },
  REPLAY_UNAVAILABLE: { httpStatus: 409, retryable: false, message: 'The requested event replay is no longer available.' },
  PAYLOAD_TOO_LARGE: { httpStatus: 413, retryable: false, message: 'The request payload is too large.' },
  RATE_LIMITED: { httpStatus: 429, retryable: true, message: 'The Host Agent capacity limit was reached.' },
  CRAFT_TURN_ACTIVE: { httpStatus: 409, retryable: true, message: 'A visible Craft turn has priority.' },
  RUNTIME_UNAVAILABLE: { httpStatus: 503, retryable: true, message: 'The Host runtime is unavailable.' },
  TOOL_BOUNDARY_UNAVAILABLE: { httpStatus: 503, retryable: false, message: 'The required tool boundary is unavailable.' },
  BROKER_DISCONNECTED: { httpStatus: 503, retryable: true, message: 'The Host Agent broker disconnected.' },
  RUN_TIMEOUT: { httpStatus: 504, retryable: true, message: 'The run exceeded its time limit.' },
  CLEANUP_FAILED: { httpStatus: 500, retryable: false, message: 'The run could not be safely closed.' },
  INTERNAL_ERROR: { httpStatus: 500, retryable: false, message: 'The Host Agent failed.' },
} satisfies Record<(typeof HOST_AGENT_ERROR_CODES)[number], HostAgentPublicErrorDefinition>)

export const HOST_AGENT_RUN_TRANSITIONS = Object.freeze({
  accepted: Object.freeze(['starting', 'interrupted']),
  starting: Object.freeze(['running', 'failed', 'interrupted']),
  running: Object.freeze(['completed', 'failed', 'interrupted']),
  completed: Object.freeze(['closing']),
  failed: Object.freeze(['closing']),
  interrupted: Object.freeze(['closing']),
  closing: Object.freeze(['closed']),
  closed: Object.freeze([]),
} satisfies Record<(typeof HOST_AGENT_RUN_STATES)[number], readonly (typeof HOST_AGENT_RUN_STATES)[number][]>)
