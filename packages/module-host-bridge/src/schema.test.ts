import { describe, expect, test } from 'bun:test'
import { assertPlainJson, ContractValidationError } from './json.ts'
import { parseEventEnvelope, parseRequestEnvelope, parseResponseEnvelope } from './schema.ts'
import { DEFAULT_LIMITS, type EventEnvelope, type RequestEnvelope, type ResponseEnvelope } from './types.ts'

const request: RequestEnvelope = {
  schemaVersion: 1,
  type: 'request',
  requestId: 'req-1',
  moduleId: 'module-a',
  processId: 'process-a',
  sessionId: 'session-a',
  turnId: 'turn-a',
  method: 'notification.send',
  capabilityToken: 'a'.repeat(64),
  payload: { title: 'Ready', body: 'Done' },
}

describe('plain JSON and envelope contracts', () => {
  test('accepts a versioned request with exact fields', () => {
    expect(parseRequestEnvelope(request, DEFAULT_LIMITS)).toEqual(request)
  })

  test.each([
    [{ ...request, schemaVersion: 2 }, 'Unsupported schema version'],
    [{ ...request, unexpected: true }, 'Unknown field'],
    [{ ...request, payload: { ...request.payload, unexpected: true } }, 'Unknown field'],
    [{ ...request, method: 'host-agent.opaque' }, 'Unsupported method'],
  ])('fails closed for invalid envelope %#', (input, message) => {
    expect(() => parseRequestEnvelope(input, DEFAULT_LIMITS)).toThrow(message)
  })

  test('rejects non-plain, cyclic, deep, large-node, long-string, and oversized JSON', () => {
    expect(() => assertPlainJson(new Date(), DEFAULT_LIMITS)).toThrow('plain prototype')
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => assertPlainJson(cyclic, DEFAULT_LIMITS)).toThrow('Cyclic')
    expect(() => assertPlainJson({ a: { b: 1 } }, { ...DEFAULT_LIMITS, maxDepth: 1 })).toThrow('depth')
    expect(() => assertPlainJson([1, 2], { ...DEFAULT_LIMITS, maxNodes: 2 })).toThrow('node')
    expect(() => assertPlainJson('long', { ...DEFAULT_LIMITS, maxStringLength: 3 })).toThrow('string')
    expect(() => assertPlainJson({ value: 'bytes' }, { ...DEFAULT_LIMITS, maxBytes: 4 })).toThrow('byte')
  })

  test('rejects undefined and non-finite values', () => {
    expect(() => assertPlainJson({ value: undefined }, DEFAULT_LIMITS)).toThrow(ContractValidationError)
    expect(() => assertPlainJson({ value: Number.NaN }, DEFAULT_LIMITS)).toThrow('finite')
  })

  test('strictly parses response and event envelopes', () => {
    const response: ResponseEnvelope = { schemaVersion: 1, type: 'response', requestId: 'req-1', ok: true, result: { authorized: true } }
    const event: EventEnvelope = { schemaVersion: 1, type: 'event', eventId: 'event-1', event: 'capability.used', occurredAt: 1, payload: {} }
    expect(parseResponseEnvelope(response, DEFAULT_LIMITS)).toEqual(response)
    expect(parseEventEnvelope(event, DEFAULT_LIMITS)).toEqual(event)
    expect(() => parseResponseEnvelope({ ...response, unknown: true }, DEFAULT_LIMITS)).toThrow('Unknown field')
    expect(() => parseResponseEnvelope({ ...response, error: { code: 'INVALID_REQUEST', message: 'bad' } }, DEFAULT_LIMITS)).toThrow('cannot contain error')
    expect(() => parseEventEnvelope({ ...event, unknown: true }, DEFAULT_LIMITS)).toThrow('Unknown field')
    expect(() => parseResponseEnvelope({ ...response, ok: false, result: undefined, error: { code: 'FUTURE_ERROR', message: 'bad' } }, DEFAULT_LIMITS)).toThrow('plain JSON')
    expect(() => parseResponseEnvelope({ schemaVersion: 1, type: 'response', requestId: 'req-1', ok: false, error: { code: 'FUTURE_ERROR', message: 'bad' } }, DEFAULT_LIMITS)).toThrow('Unknown error code')
    expect(() => parseEventEnvelope({ ...event, event: 'future.event' }, DEFAULT_LIMITS)).toThrow('Unknown event kind')
  })
})
