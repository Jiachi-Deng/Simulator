import {
  HOST_AGENT_CAPABILITY,
  HOST_AGENT_CONTRACT_VERSION,
  HOST_AGENT_ERROR_CODES,
  HOST_AGENT_ERROR_DEFINITIONS,
  HOST_AGENT_EVENT_TYPES,
  HOST_AGENT_INTERRUPTION_REASONS,
  HOST_AGENT_LIMITS,
  HOST_AGENT_PRESENTATION_KINDS,
  HOST_AGENT_RUN_STATES,
  HOST_AGENT_TURN_FAILURE_CODES,
} from './constants.ts'

type JsonSchema = Record<string, unknown>

const runHandleSchema = Object.freeze({
  type: 'string',
  pattern: '^run_[0-9a-f]{32}$',
})

const safeTimestampSchema = Object.freeze({
  type: 'integer',
  minimum: 0,
  maximum: Number.MAX_SAFE_INTEGER,
})

const emptyDataSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  maxProperties: 0,
})

function eventSchema(type: string, data: JsonSchema): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['contractVersion', 'eventId', 'sequence', 'runHandle', 'occurredAt', 'type', 'data'],
    properties: {
      contractVersion: { const: HOST_AGENT_CONTRACT_VERSION },
      eventId: { type: 'string', pattern: '^[1-9][0-9]*$' },
      sequence: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
      runHandle: runHandleSchema,
      occurredAt: safeTimestampSchema,
      type: { const: type },
      data,
    },
    'x-simulator-invariant': 'eventId is the canonical decimal representation of sequence',
    'x-simulator-maxUtf8Bytes': HOST_AGENT_LIMITS.maxEventBytes,
  }
}

const fixedErrorSchemas = HOST_AGENT_ERROR_CODES.map((code) => ({
  type: 'object',
  additionalProperties: false,
  required: ['code', 'message', 'retryable'],
  properties: {
    code: { const: code },
    message: { const: HOST_AGENT_ERROR_DEFINITIONS[code].message },
    retryable: { const: HOST_AGENT_ERROR_DEFINITIONS[code].retryable },
  },
}))

const failureRetryability = {
  RUNTIME_UNAVAILABLE: true,
  TOOL_BOUNDARY_UNAVAILABLE: false,
  RUN_TIMEOUT: true,
  BROKER_DISCONNECTED: true,
  INTERNAL_ERROR: false,
} as const

const interruptionRetryability = {
  CLIENT_CANCELLED: false,
  CRAFT_TURN_PREEMPTED: true,
  BROKER_DISCONNECTED: true,
  RUN_TIMEOUT: true,
  HOST_SHUTDOWN: true,
} as const

const eventSchemas = [
  eventSchema('run.accepted', emptyDataSchema),
  eventSchema('turn.started', emptyDataSchema),
  eventSchema('message.delta', {
    type: 'object',
    additionalProperties: false,
    required: ['delta'],
    properties: {
      delta: { type: 'string', minLength: 1, 'x-simulator-maxUtf8Bytes': HOST_AGENT_LIMITS.maxDeltaBytes },
    },
  }),
  eventSchema('reasoning.delta', {
    type: 'object',
    additionalProperties: false,
    required: ['delta'],
    properties: {
      delta: { type: 'string', minLength: 1, 'x-simulator-maxUtf8Bytes': HOST_AGENT_LIMITS.maxDeltaBytes },
    },
  }),
  eventSchema('activity', {
    type: 'object',
    additionalProperties: false,
    required: ['phase', 'kind'],
    properties: {
      phase: { enum: ['started', 'finished'] },
      kind: { enum: ['runtime', 'tool'] },
      label: { type: 'string', minLength: 1, 'x-simulator-maxUtf8Bytes': HOST_AGENT_LIMITS.maxActivityLabelBytes },
    },
  }),
  eventSchema('presentation.item', {
    type: 'object',
    additionalProperties: false,
    required: ['itemId', 'kind'],
    properties: {
      itemId: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' },
      kind: { enum: HOST_AGENT_PRESENTATION_KINDS },
      title: { type: 'string', minLength: 1, 'x-simulator-maxUtf8Bytes': 4096 },
      text: { type: 'string', minLength: 1, 'x-simulator-maxUtf8Bytes': HOST_AGENT_LIMITS.maxEventBytes },
      uri: { type: 'string', minLength: 1, 'x-simulator-maxUtf8Bytes': 8192 },
      mediaType: { type: 'string', pattern: '^[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+$' },
    },
  }),
  eventSchema('turn.completed', {
    type: 'object',
    additionalProperties: false,
    properties: {
      finalText: { type: 'string', 'x-simulator-maxUtf8Bytes': HOST_AGENT_LIMITS.maxEventBytes },
    },
  }),
  eventSchema('turn.failed', {
    oneOf: HOST_AGENT_TURN_FAILURE_CODES.map((code) => ({
      type: 'object',
      additionalProperties: false,
      required: ['code', 'retryable'],
      properties: { code: { const: code }, retryable: { const: failureRetryability[code] } },
    })),
  }),
  eventSchema('turn.interrupted', {
    oneOf: HOST_AGENT_INTERRUPTION_REASONS.map((reason) => ({
      type: 'object',
      additionalProperties: false,
      required: ['reason', 'retryable'],
      properties: { reason: { const: reason }, retryable: { const: interruptionRetryability[reason] } },
    })),
  }),
  eventSchema('run.closed', emptyDataSchema),
] as const

export const HOST_AGENT_CREATE_RUN_REQUEST_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['contractVersion', 'prompt'],
  properties: {
    contractVersion: { const: HOST_AGENT_CONTRACT_VERSION },
    prompt: {
      type: 'string',
      minLength: 1,
      pattern: '^(?=[\\s\\S]*\\S)[^\\u0000]*$',
      'x-simulator-maxUtf8Bytes': HOST_AGENT_LIMITS.maxPromptBytes,
    },
    workingDirectory: {
      type: 'string',
      minLength: 1,
      format: 'simulator-canonical-absolute-posix-path',
      'x-simulator-maxUtf8Bytes': HOST_AGENT_LIMITS.maxWorkingDirectoryBytes,
    },
  },
})

export const HOST_AGENT_CAPABILITIES_RESPONSE_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['contractVersion', 'capability', 'features', 'limits'],
  properties: {
    contractVersion: { const: HOST_AGENT_CONTRACT_VERSION },
    capability: { const: HOST_AGENT_CAPABILITY },
    features: {
      type: 'object',
      additionalProperties: false,
      required: ['streaming', 'cancellation', 'reconnect', 'idempotency'],
      properties: {
        streaming: { const: true },
        cancellation: { const: true },
        reconnect: { const: true },
        idempotency: { const: true },
      },
    },
    limits: {
      type: 'object',
      additionalProperties: false,
      required: [
        'maxPromptBytes', 'maxEventBytes', 'maxDeltaBytes', 'maxReplayEvents',
        'maxReplayBytes', 'maxSseSubscribers', 'maxConcurrentRuns', 'maxRunDurationMs',
      ],
      properties: {
        maxPromptBytes: { type: 'integer', minimum: 1, maximum: HOST_AGENT_LIMITS.maxPromptBytes },
        maxEventBytes: { type: 'integer', minimum: 1, maximum: HOST_AGENT_LIMITS.maxEventBytes },
        maxDeltaBytes: { type: 'integer', minimum: 1, maximum: HOST_AGENT_LIMITS.maxDeltaBytes },
        maxReplayEvents: { type: 'integer', minimum: 1, maximum: HOST_AGENT_LIMITS.maxReplayEvents },
        maxReplayBytes: { type: 'integer', minimum: 1, maximum: HOST_AGENT_LIMITS.maxReplayBytes },
        maxSseSubscribers: { type: 'integer', minimum: 1, maximum: HOST_AGENT_LIMITS.maxSseSubscribersPerGrant },
        maxConcurrentRuns: { const: HOST_AGENT_LIMITS.maxConcurrentModuleRuns },
        maxRunDurationMs: { type: 'integer', minimum: 1, maximum: HOST_AGENT_LIMITS.maxRunDurationMs },
      },
    },
  },
})

export const HOST_AGENT_RUN_SNAPSHOT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['contractVersion', 'runHandle', 'state', 'createdAt', 'updatedAt'],
  properties: {
    contractVersion: { const: HOST_AGENT_CONTRACT_VERSION },
    runHandle: runHandleSchema,
    state: { enum: HOST_AGENT_RUN_STATES },
    createdAt: safeTimestampSchema,
    updatedAt: safeTimestampSchema,
    terminalAt: safeTimestampSchema,
    closedAt: safeTimestampSchema,
  },
  oneOf: [
    { properties: { state: { enum: ['accepted', 'starting', 'running'] } }, not: { anyOf: [{ required: ['terminalAt'] }, { required: ['closedAt'] }] } },
    { properties: { state: { enum: ['completed', 'failed', 'interrupted', 'closing'] } }, required: ['terminalAt'], not: { required: ['closedAt'] } },
    { properties: { state: { const: 'closed' } }, required: ['terminalAt', 'closedAt'] },
  ],
  'x-simulator-invariant': 'createdAt <= terminalAt <= closedAt <= updatedAt for fields that are present',
})

export const HOST_AGENT_EVENT_SCHEMA = Object.freeze({
  oneOf: eventSchemas,
  'x-simulator-eventTypes': HOST_AGENT_EVENT_TYPES,
})

export const HOST_AGENT_ERROR_RESPONSE_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['contractVersion', 'error'],
  properties: {
    contractVersion: { const: HOST_AGENT_CONTRACT_VERSION },
    error: { oneOf: fixedErrorSchemas },
  },
})

export const HOST_AGENT_V2_JSON_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://simulator.local/schemas/host-agent-v2.schema.json',
  title: 'Simulator Host Agent v2 closed wire contract',
  description: 'Provider-neutral closed JSON messages shared by Host, Worker, Shim, and OpenDesign parser.',
  oneOf: [
    { $ref: '#/$defs/createRunRequest' },
    { $ref: '#/$defs/capabilitiesResponse' },
    { $ref: '#/$defs/runSnapshot' },
    { $ref: '#/$defs/event' },
    { $ref: '#/$defs/errorResponse' },
  ],
  $defs: {
    runHandle: runHandleSchema,
    idempotencyKey: {
      type: 'string',
      pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$',
      minLength: 1,
      maxLength: HOST_AGENT_LIMITS.maxIdempotencyKeyBytes,
      'x-simulator-maxUtf8Bytes': HOST_AGENT_LIMITS.maxIdempotencyKeyBytes,
    },
    lastEventId: {
      type: 'string',
      pattern: '^(0|[1-9][0-9]*)$',
      'x-simulator-maxSafeInteger': Number.MAX_SAFE_INTEGER,
    },
    createRunRequest: HOST_AGENT_CREATE_RUN_REQUEST_SCHEMA,
    capabilitiesResponse: HOST_AGENT_CAPABILITIES_RESPONSE_SCHEMA,
    runSnapshot: HOST_AGENT_RUN_SNAPSHOT_SCHEMA,
    event: HOST_AGENT_EVENT_SCHEMA,
    errorResponse: HOST_AGENT_ERROR_RESPONSE_SCHEMA,
  },
})

export function renderHostAgentV2JsonSchema(): string {
  return `${JSON.stringify(HOST_AGENT_V2_JSON_SCHEMA, null, 2)}\n`
}
