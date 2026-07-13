import {
  assertExactKeys,
  assertNoDuplicateJsonKeys,
  assertPlainJson,
  ContractValidationError,
  requireNumber,
  requireString,
  requireStringArray,
} from './json.ts'
import {
  CAPABILITY_KINDS,
  AUDIT_EVENT_KINDS,
  BRIDGE_ERROR_CODES,
  PATH_OPERATIONS,
  SCHEMA_VERSION,
  type AuditEventKind,
  type BridgeErrorCode,
  type CapabilityKind,
  type ContractLimits,
  type EventEnvelope,
  type JsonObject,
  type RequestEnvelope,
  type ResponseEnvelope,
} from './types.ts'

const methods = new Set<string>(CAPABILITY_KINDS)
const errorCodes = new Set<string>(BRIDGE_ERROR_CODES)
const auditEvents = new Set<string>(AUDIT_EVENT_KINDS)
const pathOperations = new Set<string>(PATH_OPERATIONS)

export function parseRawRequest(input: string | Uint8Array, limits: ContractLimits): RequestEnvelope {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input
  if (bytes.byteLength > limits.maxBytes) throw new ContractValidationError('Raw request byte limit exceeded')

  let source: string
  try {
    source = typeof input === 'string' ? input : new TextDecoder('utf-8', { fatal: true }).decode(input)
  } catch {
    throw new ContractValidationError('Raw request must be valid UTF-8')
  }

  let value: unknown
  try {
    assertNoDuplicateJsonKeys(source, limits)
    value = JSON.parse(source)
  } catch (error) {
    if (error instanceof ContractValidationError) throw error
    throw new ContractValidationError('Raw request must be valid JSON')
  }
  return parseRequestEnvelope(value, limits)
}

export function parseRequestEnvelope(input: unknown, limits: ContractLimits): RequestEnvelope {
  assertPlainJson(input, limits)
  if (input === null || Array.isArray(input) || typeof input !== 'object') throw new ContractValidationError('Request must be an object')
  const value = input as JsonObject
  assertExactKeys(value, [
    'schemaVersion', 'type', 'requestId', 'moduleId', 'processId', 'sessionId', 'turnId', 'method', 'capabilityToken', 'nonce', 'payload',
  ])
  const version = requireNumber(value, 'schemaVersion')
  if (version !== SCHEMA_VERSION) throw new ContractValidationError(`Unsupported schema version: ${version}`)
  if (value.type !== 'request') throw new ContractValidationError('Envelope type must be request')
  const method = requireString(value, 'method')
  if (!methods.has(method)) throw new ContractValidationError(`Unsupported method: ${method}`)
  if (value.payload === null || Array.isArray(value.payload) || typeof value.payload !== 'object') {
    throw new ContractValidationError('Payload must be an object')
  }
  validateMethodPayload(method as CapabilityKind, value.payload as JsonObject)
  return {
    schemaVersion: SCHEMA_VERSION,
    type: 'request',
    requestId: requireString(value, 'requestId'),
    moduleId: requireString(value, 'moduleId'),
    processId: requireString(value, 'processId'),
    sessionId: requireString(value, 'sessionId'),
    turnId: requireString(value, 'turnId'),
    method: method as CapabilityKind,
    capabilityToken: requireString(value, 'capabilityToken', 128),
    nonce: requireString(value, 'nonce', 512),
    payload: value.payload as JsonObject,
  }
}

export function parseResponseEnvelope(input: unknown, limits: ContractLimits): ResponseEnvelope {
  const value = requireObject(input, limits, 'Response')
  assertExactKeys(value, ['schemaVersion', 'type', 'requestId', 'replayed', 'ok'], ['result', 'error'])
  assertVersionAndType(value, 'response')
  const requestId = requireString(value, 'requestId')
  if (typeof value.replayed !== 'boolean') throw new ContractValidationError('Response replayed must be a boolean')
  const replayed = value.replayed
  if (typeof value.ok !== 'boolean') throw new ContractValidationError('Response ok must be a boolean')
  if (value.ok) {
    if (value.error !== undefined) throw new ContractValidationError('Successful response cannot contain error')
    const result = requireNestedObject(value, 'result')
    return { schemaVersion: SCHEMA_VERSION, type: 'response', requestId, replayed, ok: true, result }
  }
  if (value.result !== undefined) throw new ContractValidationError('Failed response cannot contain result')
  const error = requireNestedObject(value, 'error')
  assertExactKeys(error, ['code', 'message'])
  const code = requireString(error, 'code')
  if (!errorCodes.has(code)) throw new ContractValidationError(`Unknown error code: ${code}`)
  return {
    schemaVersion: SCHEMA_VERSION,
    type: 'response',
    requestId,
    replayed,
    ok: false,
    error: { code: code as BridgeErrorCode, message: requireString(error, 'message', 1_024) },
  }
}

export function parseEventEnvelope(input: unknown, limits: ContractLimits): EventEnvelope {
  const value = requireObject(input, limits, 'Event')
  assertExactKeys(value, ['schemaVersion', 'type', 'eventId', 'event', 'occurredAt', 'payload'])
  assertVersionAndType(value, 'event')
  const event = requireString(value, 'event')
  if (!auditEvents.has(event)) throw new ContractValidationError(`Unknown event kind: ${event}`)
  return {
    schemaVersion: SCHEMA_VERSION,
    type: 'event',
    eventId: requireString(value, 'eventId'),
    event: event as AuditEventKind,
    occurredAt: requireNumber(value, 'occurredAt'),
    payload: requireNestedObject(value, 'payload'),
  }
}

function requireObject(input: unknown, limits: ContractLimits, label: string): JsonObject {
  assertPlainJson(input, limits)
  if (input === null || Array.isArray(input) || typeof input !== 'object') throw new ContractValidationError(`${label} must be an object`)
  return input as JsonObject
}

function requireNestedObject(value: JsonObject, key: string): JsonObject {
  const nested = value[key]
  if (nested === null || Array.isArray(nested) || typeof nested !== 'object') {
    throw new ContractValidationError(`Field ${key} must be an object`)
  }
  return nested as JsonObject
}

function assertVersionAndType(value: JsonObject, type: 'response' | 'event'): void {
  const version = requireNumber(value, 'schemaVersion')
  if (version !== SCHEMA_VERSION) throw new ContractValidationError(`Unsupported schema version: ${version}`)
  if (value.type !== type) throw new ContractValidationError(`Envelope type must be ${type}`)
}

export function validateMethodPayload(method: CapabilityKind, payload: JsonObject): void {
  switch (method) {
    case 'folder.pick':
      assertExactKeys(payload, [], ['suggestedRoot'])
      if (payload.suggestedRoot !== undefined) requireString(payload, 'suggestedRoot', 4_096)
      return
    case 'path.authorize':
      assertExactKeys(payload, ['path', 'operations'])
      requireString(payload, 'path', 4_096)
      validatePathOperations(requireStringArray(payload, 'operations'))
      return
    case 'file.export':
      assertExactKeys(payload, ['sourcePath', 'suggestedName'])
      requireString(payload, 'sourcePath', 4_096)
      requireString(payload, 'suggestedName', 512)
      return
    case 'external.open':
      assertExactKeys(payload, ['url'])
      requireString(payload, 'url', 8_192)
      return
    case 'oauth.launch':
      assertExactKeys(payload, ['provider', 'authorizationUrl', 'callbackNonce'])
      requireString(payload, 'provider')
      requireString(payload, 'authorizationUrl', 8_192)
      requireString(payload, 'callbackNonce')
      return
    case 'credential.use':
      assertExactKeys(payload, ['credentialHandle', 'operation'], ['arguments'])
      requireString(payload, 'credentialHandle', 512)
      requireString(payload, 'operation', 256)
      if (payload.arguments !== undefined && (payload.arguments === null || Array.isArray(payload.arguments) || typeof payload.arguments !== 'object')) {
        throw new ContractValidationError('Credential arguments must be an object')
      }
      return
    case 'approval.request':
      assertExactKeys(payload, ['prompt', 'expiresAt'])
      requireString(payload, 'prompt', 4_096)
      requireNumber(payload, 'expiresAt')
      return
    case 'notification.send':
      assertExactKeys(payload, ['title', 'body'])
      requireString(payload, 'title', 256)
      requireString(payload, 'body', 2_048)
      return
    case 'artifact.publish':
      assertExactKeys(payload, ['artifactPath', 'mediaType', 'displayName'])
      requireString(payload, 'artifactPath', 4_096)
      requireString(payload, 'mediaType', 256)
      requireString(payload, 'displayName', 512)
      return
  }
}

function validatePathOperations(operations: string[]): void {
  if (operations.length === 0) throw new ContractValidationError('Path operations must be non-empty')
  if (new Set(operations).size !== operations.length) throw new ContractValidationError('Path operations must be unique')
  if (operations.some(operation => !pathOperations.has(operation))) {
    throw new ContractValidationError('Path operations contain an unsupported operation')
  }
}
