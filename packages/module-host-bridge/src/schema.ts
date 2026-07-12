import { assertExactKeys, assertPlainJson, ContractValidationError, requireNumber, requireString, requireStringArray } from './json.ts'
import { CAPABILITY_KINDS, SCHEMA_VERSION, type CapabilityKind, type ContractLimits, type JsonObject, type RequestEnvelope } from './types.ts'

const methods = new Set<string>(CAPABILITY_KINDS)

export function parseRequestEnvelope(input: unknown, limits: ContractLimits): RequestEnvelope {
  assertPlainJson(input, limits)
  if (input === null || Array.isArray(input) || typeof input !== 'object') throw new ContractValidationError('Request must be an object')
  const value = input as JsonObject
  assertExactKeys(value, [
    'schemaVersion', 'type', 'requestId', 'moduleId', 'processId', 'sessionId', 'turnId', 'method', 'capabilityToken', 'payload',
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
    payload: value.payload as JsonObject,
  }
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
      requireStringArray(payload, 'operations')
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
