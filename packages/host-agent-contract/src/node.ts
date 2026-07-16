import { createHash } from 'node:crypto'
import {
  HOST_AGENT_LIMITS,
} from './constants.ts'
import { encodeCanonicalCreateHostAgentRunRequest } from './canonical.ts'
import type {
  CreateHostAgentRunRequest,
  HostAgentCapabilitiesResponse,
  HostAgentErrorResponse,
  HostAgentEvent,
  HostAgentIdempotencyDigests,
  HostAgentRunSnapshot,
} from './types.ts'
import {
  HostAgentContractValidationError,
  assertClosedJsonValue,
  parseCreateHostAgentRunRequest,
  parseHostAgentCapabilitiesResponse,
  parseHostAgentErrorResponse,
  parseHostAgentEvent,
  parseHostAgentRunSnapshot,
  parseIdempotencyKey,
} from './validators.ts'

const decoder = new TextDecoder('utf-8', { fatal: true })
const encoder = new TextEncoder()

function bytesView(input: unknown, path = '$'): Uint8Array {
  if (!(input instanceof Uint8Array)) {
    throw new HostAgentContractValidationError('INVALID_TYPE', path, 'value must be a Uint8Array')
  }
  return input
}

/** Strict UTF-8 decoding for Node HTTP/stdin boundaries; malformed bytes and a leading BOM fail closed. */
export function decodeHostAgentUtf8Strict(input: unknown, maxBytes: number): string {
  const bytes = bytesView(input)
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new TypeError('maxBytes must be a non-negative safe integer')
  }
  if (bytes.byteLength > maxBytes) {
    throw new HostAgentContractValidationError('LIMIT_EXCEEDED', '$', `input exceeds ${maxBytes} bytes`)
  }
  if (bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new HostAgentContractValidationError('INVALID_VALUE', '$', 'a UTF-8 BOM is not allowed')
  }
  try {
    return decoder.decode(bytes)
  } catch {
    throw new HostAgentContractValidationError('INVALID_VALUE', '$', 'input is not valid UTF-8')
  }
}

export function parseHostAgentJsonBytes(input: unknown, maxBytes: number): unknown {
  const text = decodeHostAgentUtf8Strict(input, maxBytes)
  if (text.length === 0) {
    throw new HostAgentContractValidationError('INVALID_VALUE', '$', 'JSON input must not be empty')
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new HostAgentContractValidationError('INVALID_VALUE', '$', 'input is not valid JSON')
  }
  assertClosedJsonValue(value)
  return value
}

function parseBytesWith<T>(
  input: unknown,
  maxBytes: number,
  parser: (value: unknown) => T,
): T {
  return parser(parseHostAgentJsonBytes(input, maxBytes))
}

export function parseCreateHostAgentRunRequestBytes(input: unknown): CreateHostAgentRunRequest {
  return parseBytesWith(input, HOST_AGENT_LIMITS.maxRequestBodyBytes, parseCreateHostAgentRunRequest)
}

export function parseHostAgentCapabilitiesResponseBytes(input: unknown): HostAgentCapabilitiesResponse {
  return parseBytesWith(input, HOST_AGENT_LIMITS.maxEventBytes, parseHostAgentCapabilitiesResponse)
}

export function parseHostAgentRunSnapshotBytes(input: unknown): HostAgentRunSnapshot {
  return parseBytesWith(input, HOST_AGENT_LIMITS.maxEventBytes, parseHostAgentRunSnapshot)
}

export function parseHostAgentEventBytes(input: unknown): HostAgentEvent {
  return parseBytesWith(input, HOST_AGENT_LIMITS.maxEventBytes, parseHostAgentEvent)
}

export function parseHostAgentErrorResponseBytes(input: unknown): HostAgentErrorResponse {
  return parseBytesWith(input, HOST_AGENT_LIMITS.maxEventBytes, parseHostAgentErrorResponse)
}

export function sha256Hex(input: Uint8Array): string {
  return createHash('sha256').update(input).digest('hex')
}

export function digestCreateHostAgentRunRequest(input: unknown): string {
  return sha256Hex(encodeCanonicalCreateHostAgentRunRequest(input))
}

/** Domain-separated digest used as the retained idempotency lookup key. */
export function digestHostAgentIdempotencyKey(input: unknown): string {
  const key = parseIdempotencyKey(input)
  return sha256Hex(encoder.encode(`simulator-host-agent-v2:idempotency-key\0${key}`))
}

export function createHostAgentIdempotencyDigests(
  idempotencyKey: unknown,
  request: unknown,
): HostAgentIdempotencyDigests {
  return {
    keyDigest: digestHostAgentIdempotencyKey(idempotencyKey),
    requestDigest: digestCreateHostAgentRunRequest(request),
  }
}

export * from './index.ts'
