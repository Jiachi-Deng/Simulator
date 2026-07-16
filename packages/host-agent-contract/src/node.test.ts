import { describe, expect, it } from 'bun:test'
import {
  canonicalizeCreateHostAgentRunRequest,
  encodeCanonicalCreateHostAgentRunRequest,
} from './canonical.ts'
import { HOST_AGENT_LIMITS } from './constants.ts'
import { HOST_AGENT_V2_FIXTURES } from './fixtures.ts'
import {
  createHostAgentIdempotencyDigests,
  decodeHostAgentUtf8Strict,
  digestCreateHostAgentRunRequest,
  digestHostAgentIdempotencyKey,
  parseCreateHostAgentRunRequestBytes,
  parseHostAgentCapabilitiesResponseBytes,
  parseHostAgentErrorResponseBytes,
  parseHostAgentEventBytes,
  parseHostAgentJsonBytes,
  parseHostAgentRunSnapshotBytes,
} from './node.ts'
import { HostAgentContractValidationError } from './validators.ts'

const encoder = new TextEncoder()
const jsonBytes = (value: unknown): Uint8Array => encoder.encode(JSON.stringify(value))

describe('Node-only strict UTF-8 and JSON byte boundary', () => {
  it('decodes valid UTF-8 and rejects malformed input, BOM, wrong types, and byte overflow', () => {
    expect(decodeHostAgentUtf8Strict(encoder.encode('设计'), 6)).toBe('设计')
    expect(() => decodeHostAgentUtf8Strict(encoder.encode('设计'), 5)).toThrow(HostAgentContractValidationError)
    expect(() => decodeHostAgentUtf8Strict('not bytes', 100)).toThrow(HostAgentContractValidationError)
    for (const fixture of HOST_AGENT_V2_FIXTURES.rawInvalidUtf8) {
      const bytes = Uint8Array.from(Buffer.from(fixture.hex, 'hex'))
      expect(() => decodeHostAgentUtf8Strict(bytes, 100), fixture.name).toThrow(HostAgentContractValidationError)
    }
  })

  it('rejects empty/malformed JSON and snapshots only closed JSON values', () => {
    expect(parseHostAgentJsonBytes(encoder.encode('{"ok":true}'), 100)).toEqual({ ok: true })
    for (const bytes of [encoder.encode(''), encoder.encode('{'), encoder.encode('null trailing')]) {
      expect(() => parseHostAgentJsonBytes(bytes, 100)).toThrow(HostAgentContractValidationError)
    }
  })

  it('enforces the raw 2 MiB request body cap before DTO validation', () => {
    const tooLarge = new Uint8Array(HOST_AGENT_LIMITS.maxRequestBodyBytes + 1)
    tooLarge.fill(0x20)
    expect(() => parseCreateHostAgentRunRequestBytes(tooLarge)).toThrow(HostAgentContractValidationError)
    expect(parseCreateHostAgentRunRequestBytes(jsonBytes({ contractVersion: 2, prompt: 'Create' }))).toEqual({
      contractVersion: 2,
      prompt: 'Create',
    })
    expect(() => parseCreateHostAgentRunRequestBytes(jsonBytes({
      contractVersion: 2,
      prompt: 'Create',
      provider: 'claude',
    }))).toThrow(HostAgentContractValidationError)
  })

  it('provides strict byte parsers for every server or client JSON boundary', () => {
    expect(parseHostAgentCapabilitiesResponseBytes(jsonBytes(HOST_AGENT_V2_FIXTURES.valid.capabilitiesResponse))).toEqual(
      HOST_AGENT_V2_FIXTURES.valid.capabilitiesResponse,
    )
    expect(parseHostAgentRunSnapshotBytes(jsonBytes(HOST_AGENT_V2_FIXTURES.valid.runSnapshots[0]))).toEqual(
      HOST_AGENT_V2_FIXTURES.valid.runSnapshots[0],
    )
    expect(parseHostAgentEventBytes(jsonBytes(HOST_AGENT_V2_FIXTURES.valid.events[0]))).toEqual(
      HOST_AGENT_V2_FIXTURES.valid.events[0],
    )
    expect(parseHostAgentErrorResponseBytes(jsonBytes(HOST_AGENT_V2_FIXTURES.valid.errorResponse))).toEqual(
      HOST_AGENT_V2_FIXTURES.valid.errorResponse,
    )
  })
})

describe('canonical request and idempotency digests', () => {
  it('locks the canonical JSON and published SHA-256 fixtures', () => {
    const fixture = HOST_AGENT_V2_FIXTURES.canonicalRequest
    expect(canonicalizeCreateHostAgentRunRequest(fixture.value)).toBe(fixture.canonicalJson)
    expect(new TextDecoder().decode(encodeCanonicalCreateHostAgentRunRequest(fixture.value))).toBe(fixture.canonicalJson)
    expect(digestCreateHostAgentRunRequest(fixture.value)).toBe(fixture.requestSha256)
    expect(digestHostAgentIdempotencyKey(fixture.idempotencyKey)).toBe(fixture.idempotencyKeySha256)
    expect(createHostAgentIdempotencyDigests(fixture.idempotencyKey, fixture.value)).toEqual({
      keyDigest: fixture.idempotencyKeySha256,
      requestDigest: fixture.requestSha256,
    })
  })

  it('is independent of input property insertion order but sensitive to every semantic field', () => {
    const left = { contractVersion: 2, prompt: 'Create', workingDirectory: '/tmp/project' }
    const reordered = { workingDirectory: '/tmp/project', prompt: 'Create', contractVersion: 2 }
    expect(digestCreateHostAgentRunRequest(left)).toBe(digestCreateHostAgentRunRequest(reordered))
    expect(digestCreateHostAgentRunRequest(left)).not.toBe(digestCreateHostAgentRunRequest({
      ...left,
      prompt: 'Create another',
    }))
    expect(digestCreateHostAgentRunRequest(left)).not.toBe(digestCreateHostAgentRunRequest({
      contractVersion: 2,
      prompt: 'Create',
    }))
    expect(digestHostAgentIdempotencyKey('key-one')).not.toBe(digestHostAgentIdempotencyKey('key-two'))
  })
})
