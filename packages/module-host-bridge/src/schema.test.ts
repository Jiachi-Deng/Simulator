import { describe, expect, test } from 'bun:test'
import { assertPlainJson, ContractValidationError } from './json.ts'
import { parseRequestEnvelope } from './schema.ts'
import { DEFAULT_LIMITS } from './types.ts'

const request = {
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
})
