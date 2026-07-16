import {
  HOST_AGENT_ACTIVITY_KINDS,
  HOST_AGENT_ACTIVITY_PHASES,
  HOST_AGENT_CANONICAL_CURSOR_PATTERN,
  HOST_AGENT_CAPABILITY,
  HOST_AGENT_CONTRACT_VERSION,
  HOST_AGENT_ERROR_CODES,
  HOST_AGENT_ERROR_DEFINITIONS,
  HOST_AGENT_EVENT_TYPES,
  HOST_AGENT_IDEMPOTENCY_KEY_PATTERN,
  HOST_AGENT_INTERRUPTION_REASONS,
  HOST_AGENT_LIMITS,
  HOST_AGENT_PRESENTATION_KINDS,
  HOST_AGENT_ROUTES,
  HOST_AGENT_RUN_HANDLE_PATTERN,
  HOST_AGENT_RUN_STATES,
  HOST_AGENT_RUN_TRANSITIONS,
  HOST_AGENT_TERMINAL_RUN_STATES,
  HOST_AGENT_TURN_FAILURE_CODES,
} from './constants.ts'
import type {
  CreateHostAgentRunRequest,
  HostAgentCapabilitiesResponse,
  HostAgentErrorCode,
  HostAgentErrorResponse,
  HostAgentEvent,
  HostAgentHttpMethod,
  HostAgentInterruptionReason,
  HostAgentPublicLimits,
  HostAgentRouteMatch,
  HostAgentRunSnapshot,
  HostAgentRunState,
  HostAgentTerminalRunState,
  HostAgentTurnFailureCode,
} from './types.ts'

export type HostAgentValidationCode =
  | 'INVALID_TYPE'
  | 'UNKNOWN_FIELD'
  | 'MISSING_FIELD'
  | 'INVALID_VALUE'
  | 'LIMIT_EXCEEDED'
  | 'NON_JSON_VALUE'

export class HostAgentContractValidationError extends TypeError {
  constructor(
    readonly code: HostAgentValidationCode,
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`)
    this.name = 'HostAgentContractValidationError'
  }
}

type ClosedJson = null | boolean | number | string | ClosedJson[] | { [key: string]: ClosedJson }
type ClosedObject = { [key: string]: ClosedJson }

const encoder = new TextEncoder()
const runStates = new Set<string>(HOST_AGENT_RUN_STATES)
const terminalRunStates = new Set<string>(HOST_AGENT_TERMINAL_RUN_STATES)
const eventTypes = new Set<string>(HOST_AGENT_EVENT_TYPES)
const errorCodes = new Set<string>(HOST_AGENT_ERROR_CODES)
const activityPhases = new Set<string>(HOST_AGENT_ACTIVITY_PHASES)
const activityKinds = new Set<string>(HOST_AGENT_ACTIVITY_KINDS)
const presentationKinds = new Set<string>(HOST_AGENT_PRESENTATION_KINDS)
const turnFailureCodes = new Set<string>(HOST_AGENT_TURN_FAILURE_CODES)
const interruptionReasons = new Set<string>(HOST_AGENT_INTERRUPTION_REASONS)

const MAX_CLOSED_JSON_DEPTH = 64
const MAX_CLOSED_JSON_NODES = 100_000

interface SnapshotContext {
  readonly active: WeakSet<object>
  nodes: number
}

function invalid(code: HostAgentValidationCode, path: string, message: string): never {
  throw new HostAgentContractValidationError(code, path, message)
}

export function assertWellFormedUnicode(value: string, path = '$'): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        invalid('INVALID_VALUE', path, 'string contains an unpaired UTF-16 surrogate')
      }
      index += 1
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      invalid('INVALID_VALUE', path, 'string contains an unpaired UTF-16 surrogate')
    }
  }
}

export function utf8ByteLength(value: string, path = '$'): number {
  assertWellFormedUnicode(value, path)
  return encoder.encode(value).byteLength
}

function snapshotClosedJson(input: unknown, path: string, depth: number, context: SnapshotContext): ClosedJson {
  context.nodes += 1
  if (context.nodes > MAX_CLOSED_JSON_NODES) invalid('LIMIT_EXCEEDED', path, 'JSON value has too many nodes')
  if (depth > MAX_CLOSED_JSON_DEPTH) invalid('LIMIT_EXCEEDED', path, 'JSON value is too deeply nested')

  if (input === null || typeof input === 'boolean') return input
  if (typeof input === 'string') {
    assertWellFormedUnicode(input, path)
    return input
  }
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) invalid('NON_JSON_VALUE', path, 'number must be finite')
    return input
  }
  if (typeof input !== 'object') invalid('NON_JSON_VALUE', path, 'value must be closed JSON data')
  if (context.active.has(input)) invalid('NON_JSON_VALUE', path, 'cyclic JSON data is not allowed')

  let prototype: object | null
  let descriptors: PropertyDescriptorMap
  try {
    prototype = Object.getPrototypeOf(input)
    descriptors = Object.getOwnPropertyDescriptors(input)
  } catch {
    invalid('NON_JSON_VALUE', path, 'object could not be safely inspected')
  }
  const ownKeys = Reflect.ownKeys(descriptors)
  if (ownKeys.some((key) => typeof key !== 'string')) {
    invalid('NON_JSON_VALUE', path, 'symbol properties are not allowed')
  }

  context.active.add(input)
  try {
    if (Array.isArray(input)) {
      if (prototype !== Array.prototype) invalid('NON_JSON_VALUE', path, 'array must use the built-in Array prototype')
      const lengthDescriptor = descriptors.length
      if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, 'value') || lengthDescriptor.value !== input.length) {
        invalid('NON_JSON_VALUE', path, 'array length descriptor is invalid')
      }
      const expectedKeys = new Set(['length', ...Array.from({ length: input.length }, (_, index) => String(index))])
      if (ownKeys.some((key) => typeof key !== 'string' || !expectedKeys.has(key)) || ownKeys.length !== expectedKeys.size) {
        invalid('NON_JSON_VALUE', path, 'array must be dense and contain no extra properties')
      }
      const result: ClosedJson[] = []
      for (let index = 0; index < input.length; index += 1) {
        const descriptor = descriptors[index]
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.get || descriptor.set || !descriptor.enumerable) {
          invalid('NON_JSON_VALUE', `${path}[${index}]`, 'array entries must be enumerable data properties')
        }
        result.push(snapshotClosedJson(descriptor.value, `${path}[${index}]`, depth + 1, context))
      }
      return result
    }

    if (prototype !== Object.prototype && prototype !== null) {
      invalid('NON_JSON_VALUE', path, 'object must use Object.prototype or a null prototype')
    }
    const result: ClosedObject = Object.create(null) as ClosedObject
    for (const key of ownKeys as string[]) {
      const descriptor = descriptors[key]
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.get || descriptor.set || !descriptor.enumerable) {
        invalid('NON_JSON_VALUE', `${path}.${key}`, 'object fields must be enumerable data properties')
      }
      result[key] = snapshotClosedJson(descriptor.value, `${path}.${key}`, depth + 1, context)
    }
    return result
  } finally {
    context.active.delete(input)
  }
}

/**
 * Rejects accessors, symbols, sparse/extended arrays, custom prototypes,
 * cycles, non-finite numbers, and non-JSON primitives without invoking getters.
 */
export function assertClosedJsonValue(input: unknown, path = '$'): void {
  snapshotClosedJson(input, path, 0, { active: new WeakSet(), nodes: 0 })
}

function rootObject(input: unknown): ClosedObject {
  const value = snapshotClosedJson(input, '$', 0, { active: new WeakSet(), nodes: 0 })
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    invalid('INVALID_TYPE', '$', 'value must be an object')
  }
  return value
}

function objectField(object: ClosedObject, key: string, path: string): ClosedObject {
  const value = object[key]
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    invalid('INVALID_TYPE', path, 'value must be an object')
  }
  return value
}

function exactKeys(
  object: ClosedObject,
  required: readonly string[],
  optional: readonly string[] = [],
  path = '$',
): void {
  const keys = Object.keys(object)
  const allowed = new Set([...required, ...optional])
  const unknown = keys.find((key) => !allowed.has(key))
  if (unknown) invalid('UNKNOWN_FIELD', `${path}.${unknown}`, 'unknown field')
  const missing = required.find((key) => !Object.hasOwn(object, key))
  if (missing) invalid('MISSING_FIELD', `${path}.${missing}`, 'required field is missing')
}

function stringField(object: ClosedObject, key: string, path = `$.${key}`): string {
  const value = object[key]
  if (typeof value !== 'string') invalid('INVALID_TYPE', path, 'value must be a string')
  return value
}

function booleanField(object: ClosedObject, key: string, path = `$.${key}`): boolean {
  const value = object[key]
  if (typeof value !== 'boolean') invalid('INVALID_TYPE', path, 'value must be a boolean')
  return value
}

function safeIntegerField(object: ClosedObject, key: string, path = `$.${key}`): number {
  const value = object[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    invalid('INVALID_TYPE', path, 'value must be a non-negative safe integer')
  }
  return value
}

function positiveIntegerField(object: ClosedObject, key: string, path = `$.${key}`): number {
  const value = safeIntegerField(object, key, path)
  if (value === 0) invalid('INVALID_VALUE', path, 'value must be positive')
  return value
}

function parseVersion(object: ClosedObject): void {
  const version = safeIntegerField(object, 'contractVersion')
  if (version !== HOST_AGENT_CONTRACT_VERSION) {
    invalid('INVALID_VALUE', '$.contractVersion', `value must be ${HOST_AGENT_CONTRACT_VERSION}`)
  }
}

function boundedString(
  value: string,
  path: string,
  options: { minBytes?: number; maxBytes: number; rejectControls?: boolean; rejectNul?: boolean },
): string {
  const bytes = utf8ByteLength(value, path)
  if (bytes < (options.minBytes ?? 0)) invalid('INVALID_VALUE', path, 'string is too short')
  if (bytes > options.maxBytes) invalid('LIMIT_EXCEEDED', path, `string exceeds ${options.maxBytes} UTF-8 bytes`)
  if (options.rejectNul && value.includes('\0')) invalid('INVALID_VALUE', path, 'NUL is not allowed')
  if (options.rejectControls && /[\u0000-\u001f\u007f]/u.test(value)) {
    invalid('INVALID_VALUE', path, 'control characters are not allowed')
  }
  return value
}

export function parseRunHandle(input: unknown): string {
  if (typeof input !== 'string' || !HOST_AGENT_RUN_HANDLE_PATTERN.test(input)) {
    invalid('INVALID_VALUE', '$', 'run handle must match run_[0-9a-f]{32}')
  }
  return input
}

function parseOpaqueId(input: ClosedJson | undefined, path: string): string {
  if (typeof input !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input)) {
    invalid('INVALID_VALUE', path, 'identifier must be a canonical route-safe ID')
  }
  return input
}

export function parseIdempotencyKey(input: unknown): string {
  if (typeof input !== 'string') invalid('INVALID_TYPE', '$', 'idempotency key must be a string')
  const bytes = utf8ByteLength(input, '$')
  if (bytes === 0 || bytes > HOST_AGENT_LIMITS.maxIdempotencyKeyBytes || !HOST_AGENT_IDEMPOTENCY_KEY_PATTERN.test(input)) {
    invalid('INVALID_VALUE', '$', 'idempotency key must be 1-128 canonical ASCII characters')
  }
  return input
}

/** Returns undefined for an absent header and a safe integer for a canonical cursor. */
export function parseLastEventId(input: unknown): number | undefined {
  if (input === undefined) return undefined
  if (typeof input !== 'string' || !HOST_AGENT_CANONICAL_CURSOR_PATTERN.test(input)) {
    invalid('INVALID_VALUE', '$', 'Last-Event-ID must be a canonical non-negative integer')
  }
  const value = Number(input)
  if (!Number.isSafeInteger(value)) invalid('INVALID_VALUE', '$', 'Last-Event-ID exceeds the safe integer range')
  return value
}

export function parseWorkingDirectory(input: unknown): string {
  if (typeof input !== 'string') invalid('INVALID_TYPE', '$', 'workingDirectory must be a string')
  boundedString(input, '$', {
    minBytes: 1,
    maxBytes: HOST_AGENT_LIMITS.maxWorkingDirectoryBytes,
    rejectControls: true,
  })
  if (!input.startsWith('/')) invalid('INVALID_VALUE', '$', 'workingDirectory must be an absolute POSIX path')
  if (input === '/') return input
  if (input !== '/' && input.endsWith('/')) invalid('INVALID_VALUE', '$', 'workingDirectory must not have a trailing slash')
  const segments = input.split('/').slice(1)
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    invalid('INVALID_VALUE', '$', 'workingDirectory must be lexically canonical')
  }
  return input
}

export function parseCreateHostAgentRunRequest(input: unknown): CreateHostAgentRunRequest {
  const object = rootObject(input)
  exactKeys(object, ['contractVersion', 'prompt'], ['workingDirectory'])
  parseVersion(object)
  const prompt = boundedString(stringField(object, 'prompt'), '$.prompt', {
    minBytes: 1,
    maxBytes: HOST_AGENT_LIMITS.maxPromptBytes,
    rejectNul: true,
  })
  if (prompt.trim().length === 0) invalid('INVALID_VALUE', '$.prompt', 'prompt must contain non-whitespace text')
  const workingDirectory = Object.hasOwn(object, 'workingDirectory')
    ? parseWorkingDirectory(object.workingDirectory)
    : undefined
  return workingDirectory === undefined
    ? { contractVersion: HOST_AGENT_CONTRACT_VERSION, prompt }
    : { contractVersion: HOST_AGENT_CONTRACT_VERSION, prompt, workingDirectory }
}

function parsePublicLimits(object: ClosedObject): HostAgentPublicLimits {
  exactKeys(object, [
    'maxPromptBytes',
    'maxEventBytes',
    'maxDeltaBytes',
    'maxReplayEvents',
    'maxReplayBytes',
    'maxSseSubscribers',
    'maxConcurrentRuns',
    'maxRunDurationMs',
  ], [], '$.limits')
  const limits: HostAgentPublicLimits = {
    maxPromptBytes: positiveIntegerField(object, 'maxPromptBytes', '$.limits.maxPromptBytes'),
    maxEventBytes: positiveIntegerField(object, 'maxEventBytes', '$.limits.maxEventBytes'),
    maxDeltaBytes: positiveIntegerField(object, 'maxDeltaBytes', '$.limits.maxDeltaBytes'),
    maxReplayEvents: positiveIntegerField(object, 'maxReplayEvents', '$.limits.maxReplayEvents'),
    maxReplayBytes: positiveIntegerField(object, 'maxReplayBytes', '$.limits.maxReplayBytes'),
    maxSseSubscribers: positiveIntegerField(object, 'maxSseSubscribers', '$.limits.maxSseSubscribers'),
    maxConcurrentRuns: positiveIntegerField(object, 'maxConcurrentRuns', '$.limits.maxConcurrentRuns'),
    maxRunDurationMs: positiveIntegerField(object, 'maxRunDurationMs', '$.limits.maxRunDurationMs'),
  }
  const ceilings: HostAgentPublicLimits = {
    maxPromptBytes: HOST_AGENT_LIMITS.maxPromptBytes,
    maxEventBytes: HOST_AGENT_LIMITS.maxEventBytes,
    maxDeltaBytes: HOST_AGENT_LIMITS.maxDeltaBytes,
    maxReplayEvents: HOST_AGENT_LIMITS.maxReplayEvents,
    maxReplayBytes: HOST_AGENT_LIMITS.maxReplayBytes,
    maxSseSubscribers: HOST_AGENT_LIMITS.maxSseSubscribersPerGrant,
    maxConcurrentRuns: HOST_AGENT_LIMITS.maxConcurrentModuleRuns,
    maxRunDurationMs: HOST_AGENT_LIMITS.maxRunDurationMs,
  }
  for (const key of Object.keys(ceilings) as Array<keyof HostAgentPublicLimits>) {
    if (limits[key] > ceilings[key]) invalid('LIMIT_EXCEEDED', `$.limits.${key}`, 'advertised limit exceeds the v2 ceiling')
  }
  return limits
}

export function parseHostAgentCapabilitiesResponse(input: unknown): HostAgentCapabilitiesResponse {
  const object = rootObject(input)
  exactKeys(object, ['contractVersion', 'capability', 'features', 'limits'])
  parseVersion(object)
  if (object.capability !== HOST_AGENT_CAPABILITY) invalid('INVALID_VALUE', '$.capability', `value must be ${HOST_AGENT_CAPABILITY}`)
  const features = objectField(object, 'features', '$.features')
  exactKeys(features, ['streaming', 'cancellation', 'reconnect', 'idempotency'], [], '$.features')
  for (const feature of ['streaming', 'cancellation', 'reconnect', 'idempotency'] as const) {
    if (booleanField(features, feature, `$.features.${feature}`) !== true) {
      invalid('INVALID_VALUE', `$.features.${feature}`, 'v2 capability must be true')
    }
  }
  return {
    contractVersion: HOST_AGENT_CONTRACT_VERSION,
    capability: HOST_AGENT_CAPABILITY,
    features: { streaming: true, cancellation: true, reconnect: true, idempotency: true },
    limits: parsePublicLimits(objectField(object, 'limits', '$.limits')),
  }
}

export function isHostAgentRunState(input: unknown): input is HostAgentRunState {
  return typeof input === 'string' && runStates.has(input)
}

export function isHostAgentTerminalRunState(input: unknown): input is HostAgentTerminalRunState {
  return typeof input === 'string' && terminalRunStates.has(input)
}

export function isHostAgentRunTransition(from: HostAgentRunState, to: HostAgentRunState): boolean {
  return (HOST_AGENT_RUN_TRANSITIONS[from] as readonly HostAgentRunState[]).includes(to)
}

export function parseHostAgentRunSnapshot(input: unknown): HostAgentRunSnapshot {
  const object = rootObject(input)
  exactKeys(object, ['contractVersion', 'runHandle', 'state', 'createdAt', 'updatedAt'], ['terminalAt', 'closedAt'])
  parseVersion(object)
  const runHandle = parseRunHandle(stringField(object, 'runHandle'))
  const stateValue = stringField(object, 'state')
  if (!isHostAgentRunState(stateValue)) invalid('INVALID_VALUE', '$.state', 'unknown run state')
  const state = stateValue
  const createdAt = safeIntegerField(object, 'createdAt')
  const updatedAt = safeIntegerField(object, 'updatedAt')
  if (updatedAt < createdAt) invalid('INVALID_VALUE', '$.updatedAt', 'updatedAt must not precede createdAt')
  const hasTerminalAt = Object.hasOwn(object, 'terminalAt')
  const hasClosedAt = Object.hasOwn(object, 'closedAt')
  const requiresTerminal = isHostAgentTerminalRunState(state) || state === 'closing' || state === 'closed'
  if (requiresTerminal !== hasTerminalAt) {
    invalid('INVALID_VALUE', '$.terminalAt', requiresTerminal ? 'terminalAt is required for this state' : 'terminalAt is forbidden for this state')
  }
  if ((state === 'closed') !== hasClosedAt) {
    invalid('INVALID_VALUE', '$.closedAt', state === 'closed' ? 'closedAt is required for closed state' : 'closedAt is forbidden before closed state')
  }
  const terminalAt = hasTerminalAt ? safeIntegerField(object, 'terminalAt') : undefined
  const closedAt = hasClosedAt ? safeIntegerField(object, 'closedAt') : undefined
  if (terminalAt !== undefined && (terminalAt < createdAt || updatedAt < terminalAt)) {
    invalid('INVALID_VALUE', '$.terminalAt', 'terminalAt must be within the run timestamp range')
  }
  if (closedAt !== undefined && (terminalAt === undefined || closedAt < terminalAt || updatedAt < closedAt)) {
    invalid('INVALID_VALUE', '$.closedAt', 'closedAt must follow terminalAt and not exceed updatedAt')
  }
  return {
    contractVersion: HOST_AGENT_CONTRACT_VERSION,
    runHandle,
    state,
    createdAt,
    updatedAt,
    ...(terminalAt === undefined ? {} : { terminalAt }),
    ...(closedAt === undefined ? {} : { closedAt }),
  }
}

function parseEventBase(object: ClosedObject): {
  eventId: string
  sequence: number
  runHandle: string
  occurredAt: number
  type: string
  data: ClosedObject
} {
  exactKeys(object, ['contractVersion', 'eventId', 'sequence', 'runHandle', 'occurredAt', 'type', 'data'])
  parseVersion(object)
  const eventId = stringField(object, 'eventId')
  const sequence = positiveIntegerField(object, 'sequence')
  if (eventId !== String(sequence)) invalid('INVALID_VALUE', '$.eventId', 'eventId must be the canonical decimal sequence')
  const type = stringField(object, 'type')
  if (!eventTypes.has(type)) invalid('INVALID_VALUE', '$.type', 'unknown event type')
  return {
    eventId,
    sequence,
    runHandle: parseRunHandle(stringField(object, 'runHandle')),
    occurredAt: safeIntegerField(object, 'occurredAt'),
    type,
    data: objectField(object, 'data', '$.data'),
  }
}

function parseDelta(data: ClosedObject): { delta: string } {
  exactKeys(data, ['delta'], [], '$.data')
  const delta = boundedString(stringField(data, 'delta', '$.data.delta'), '$.data.delta', {
    minBytes: 1,
    maxBytes: HOST_AGENT_LIMITS.maxDeltaBytes,
    rejectNul: true,
  })
  return { delta }
}

const failureRetryability: Record<HostAgentTurnFailureCode, boolean> = {
  RUNTIME_UNAVAILABLE: true,
  TOOL_BOUNDARY_UNAVAILABLE: false,
  RUN_TIMEOUT: true,
  BROKER_DISCONNECTED: true,
  INTERNAL_ERROR: false,
}

const interruptionRetryability: Record<HostAgentInterruptionReason, boolean> = {
  CLIENT_CANCELLED: false,
  CRAFT_TURN_PREEMPTED: true,
  BROKER_DISCONNECTED: true,
  RUN_TIMEOUT: true,
  HOST_SHUTDOWN: true,
}

export function parseHostAgentEvent(input: unknown): HostAgentEvent {
  const object = rootObject(input)
  const base = parseEventBase(object)
  const common = {
    contractVersion: HOST_AGENT_CONTRACT_VERSION,
    eventId: base.eventId,
    sequence: base.sequence,
    runHandle: base.runHandle,
    occurredAt: base.occurredAt,
  }
  let event: HostAgentEvent
  switch (base.type) {
    case 'run.accepted':
    case 'turn.started':
    case 'run.closed': {
      exactKeys(base.data, [], [], '$.data')
      event = { ...common, type: base.type, data: {} }
      break
    }
    case 'message.delta':
    case 'reasoning.delta':
      event = { ...common, type: base.type, data: parseDelta(base.data) }
      break
    case 'activity': {
      exactKeys(base.data, ['phase', 'kind'], ['label'], '$.data')
      const phase = stringField(base.data, 'phase', '$.data.phase')
      const kind = stringField(base.data, 'kind', '$.data.kind')
      if (!activityPhases.has(phase)) invalid('INVALID_VALUE', '$.data.phase', 'unknown activity phase')
      if (!activityKinds.has(kind)) invalid('INVALID_VALUE', '$.data.kind', 'unknown activity kind')
      const label = Object.hasOwn(base.data, 'label')
        ? boundedString(stringField(base.data, 'label', '$.data.label'), '$.data.label', {
            minBytes: 1,
            maxBytes: HOST_AGENT_LIMITS.maxActivityLabelBytes,
            rejectNul: true,
          })
        : undefined
      event = {
        ...common,
        type: 'activity',
        data: { phase: phase as 'started' | 'finished', kind: kind as 'runtime' | 'tool', ...(label === undefined ? {} : { label }) },
      }
      break
    }
    case 'presentation.item': {
      exactKeys(base.data, ['itemId', 'kind'], ['title', 'text', 'uri', 'mediaType'], '$.data')
      const itemId = parseOpaqueId(base.data.itemId, '$.data.itemId')
      const kind = stringField(base.data, 'kind', '$.data.kind')
      if (!presentationKinds.has(kind)) invalid('INVALID_VALUE', '$.data.kind', 'unknown presentation kind')
      const optionalText = (key: 'title' | 'text' | 'uri', maxBytes: number): string | undefined => Object.hasOwn(base.data, key)
        ? boundedString(stringField(base.data, key, `$.data.${key}`), `$.data.${key}`, { minBytes: 1, maxBytes, rejectNul: true })
        : undefined
      const title = optionalText('title', 4096)
      const text = optionalText('text', HOST_AGENT_LIMITS.maxEventBytes)
      const uri = optionalText('uri', 8192)
      const mediaType = Object.hasOwn(base.data, 'mediaType')
        ? boundedString(stringField(base.data, 'mediaType', '$.data.mediaType'), '$.data.mediaType', { minBytes: 1, maxBytes: 256, rejectControls: true })
        : undefined
      if (mediaType !== undefined && !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(mediaType)) {
        invalid('INVALID_VALUE', '$.data.mediaType', 'mediaType must be a canonical media type')
      }
      event = {
        ...common,
        type: 'presentation.item',
        data: {
          itemId,
          kind: kind as 'text' | 'image' | 'file' | 'preview',
          ...(title === undefined ? {} : { title }),
          ...(text === undefined ? {} : { text }),
          ...(uri === undefined ? {} : { uri }),
          ...(mediaType === undefined ? {} : { mediaType }),
        },
      }
      break
    }
    case 'turn.completed': {
      exactKeys(base.data, [], ['finalText'], '$.data')
      const finalText = Object.hasOwn(base.data, 'finalText')
        ? boundedString(stringField(base.data, 'finalText', '$.data.finalText'), '$.data.finalText', {
            maxBytes: HOST_AGENT_LIMITS.maxEventBytes,
            rejectNul: true,
          })
        : undefined
      event = { ...common, type: 'turn.completed', data: finalText === undefined ? {} : { finalText } }
      break
    }
    case 'turn.failed': {
      exactKeys(base.data, ['code', 'retryable'], [], '$.data')
      const code = stringField(base.data, 'code', '$.data.code')
      if (!turnFailureCodes.has(code)) invalid('INVALID_VALUE', '$.data.code', 'unknown turn failure code')
      const retryable = booleanField(base.data, 'retryable', '$.data.retryable')
      if (retryable !== failureRetryability[code as HostAgentTurnFailureCode]) {
        invalid('INVALID_VALUE', '$.data.retryable', 'retryable does not match the public failure code')
      }
      event = { ...common, type: 'turn.failed', data: { code: code as HostAgentTurnFailureCode, retryable } }
      break
    }
    case 'turn.interrupted': {
      exactKeys(base.data, ['reason', 'retryable'], [], '$.data')
      const reason = stringField(base.data, 'reason', '$.data.reason')
      if (!interruptionReasons.has(reason)) invalid('INVALID_VALUE', '$.data.reason', 'unknown interruption reason')
      const retryable = booleanField(base.data, 'retryable', '$.data.retryable')
      if (retryable !== interruptionRetryability[reason as HostAgentInterruptionReason]) {
        invalid('INVALID_VALUE', '$.data.retryable', 'retryable does not match the interruption reason')
      }
      event = { ...common, type: 'turn.interrupted', data: { reason: reason as HostAgentInterruptionReason, retryable } }
      break
    }
    default:
      invalid('INVALID_VALUE', '$.type', 'unknown event type')
  }
  if (encoder.encode(JSON.stringify(event)).byteLength > HOST_AGENT_LIMITS.maxEventBytes) {
    invalid('LIMIT_EXCEEDED', '$', `encoded event exceeds ${HOST_AGENT_LIMITS.maxEventBytes} UTF-8 bytes`)
  }
  return event
}

export function parseHostAgentErrorResponse(input: unknown): HostAgentErrorResponse {
  const object = rootObject(input)
  exactKeys(object, ['contractVersion', 'error'])
  parseVersion(object)
  const error = objectField(object, 'error', '$.error')
  exactKeys(error, ['code', 'message', 'retryable'], [], '$.error')
  const code = stringField(error, 'code', '$.error.code')
  if (!errorCodes.has(code)) invalid('INVALID_VALUE', '$.error.code', 'unknown public error code')
  const definition = HOST_AGENT_ERROR_DEFINITIONS[code as HostAgentErrorCode]
  const message = boundedString(stringField(error, 'message', '$.error.message'), '$.error.message', {
    minBytes: 1,
    maxBytes: HOST_AGENT_LIMITS.maxErrorMessageBytes,
    rejectControls: true,
  })
  const retryable = booleanField(error, 'retryable', '$.error.retryable')
  if (message !== definition.message || retryable !== definition.retryable) {
    invalid('INVALID_VALUE', '$.error', 'message and retryable must match the fixed public error definition')
  }
  return {
    contractVersion: HOST_AGENT_CONTRACT_VERSION,
    error: { code: code as HostAgentErrorCode, message, retryable },
  }
}

export function createHostAgentErrorResponse(code: HostAgentErrorCode): HostAgentErrorResponse {
  const definition = HOST_AGENT_ERROR_DEFINITIONS[code]
  return {
    contractVersion: HOST_AGENT_CONTRACT_VERSION,
    error: { code, message: definition.message, retryable: definition.retryable },
  }
}

export function parseHostAgentRoute(method: unknown, requestTarget: unknown): HostAgentRouteMatch {
  if (method !== 'GET' && method !== 'POST' && method !== 'DELETE') {
    invalid('INVALID_VALUE', '$.method', 'unsupported HTTP method')
  }
  if (typeof requestTarget !== 'string') invalid('INVALID_TYPE', '$.requestTarget', 'request target must be a string')
  if (requestTarget.length === 0 || requestTarget.length > 256 || /[?#%]/.test(requestTarget) || requestTarget.includes('//')) {
    invalid('INVALID_VALUE', '$.requestTarget', 'request target must be a canonical unencoded v2 path')
  }
  const httpMethod = method as HostAgentHttpMethod
  if (httpMethod === 'GET' && requestTarget === HOST_AGENT_ROUTES.capabilities) return { route: 'capabilities' }
  if (httpMethod === 'POST' && requestTarget === HOST_AGENT_ROUTES.runs) return { route: 'runs.create' }
  const match = /^\/v2\/runs\/(run_[0-9a-f]{32})(?:\/(events|cancel))?$/.exec(requestTarget)
  if (!match) invalid('INVALID_VALUE', '$.requestTarget', 'request target does not match a v2 route')
  const runHandle = parseRunHandle(match[1])
  const action = match[2]
  if (httpMethod === 'GET' && action === undefined) return { route: 'runs.get', runHandle }
  if (httpMethod === 'GET' && action === 'events') return { route: 'runs.events', runHandle }
  if (httpMethod === 'POST' && action === 'cancel') return { route: 'runs.cancel', runHandle }
  if (httpMethod === 'DELETE' && action === undefined) return { route: 'runs.delete', runHandle }
  invalid('INVALID_VALUE', '$.method', 'HTTP method does not match the v2 route')
}
