import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { HOST_AGENT_EVENT_TYPES } from './constants.ts'
import { HOST_AGENT_V2_FIXTURES, renderHostAgentV2Fixtures } from './fixtures.ts'
import { decodeHostAgentUtf8Strict } from './node.ts'
import { HOST_AGENT_V2_JSON_SCHEMA, renderHostAgentV2JsonSchema } from './schema.ts'
import {
  HostAgentContractValidationError,
  parseCreateHostAgentRunRequest,
  parseHostAgentErrorResponse,
  parseHostAgentEvent,
  parseHostAgentRunSnapshot,
  parseIdempotencyKey,
  parseLastEventId,
} from './validators.ts'

const schemaPath = fileURLToPath(new URL('../schema/host-agent-v2.schema.json', import.meta.url))
const fixturesPath = fileURLToPath(new URL('../fixtures/host-agent-v2-fixtures.json', import.meta.url))

describe('static JSON Schema and canonical fixtures', () => {
  it('keeps generated artifacts byte-for-byte current with browser-safe sources', async () => {
    expect(await readFile(schemaPath, 'utf8')).toBe(renderHostAgentV2JsonSchema())
    expect(await readFile(fixturesPath, 'utf8')).toBe(renderHostAgentV2Fixtures())
    expect(JSON.parse(await readFile(schemaPath, 'utf8'))).toEqual(HOST_AGENT_V2_JSON_SCHEMA)
    expect(JSON.parse(await readFile(fixturesPath, 'utf8'))).toEqual(HOST_AGENT_V2_FIXTURES)
  })

  it('publishes all ten events and closed schemas for every wire DTO', () => {
    const schemaText = JSON.stringify(HOST_AGENT_V2_JSON_SCHEMA)
    for (const eventType of HOST_AGENT_EVENT_TYPES) expect(schemaText).toContain(`\"${eventType}\"`)
    expect(schemaText).toContain('REPLAY_UNAVAILABLE')
    expect(schemaText).toContain('additionalProperties')
    expect(schemaText).not.toContain('providerSessionId')
    expect(schemaText).not.toContain('profileId')
  })

  it('proves every valid fixture is accepted by the matching runtime parser', () => {
    for (const request of HOST_AGENT_V2_FIXTURES.valid.createRunRequests) {
      expect(parseCreateHostAgentRunRequest(request)).toEqual(request)
    }
    for (const snapshot of HOST_AGENT_V2_FIXTURES.valid.runSnapshots) {
      expect(parseHostAgentRunSnapshot(snapshot)).toEqual(snapshot)
    }
    for (const event of HOST_AGENT_V2_FIXTURES.valid.events) {
      expect(parseHostAgentEvent(event)).toEqual(event)
    }
    expect(parseHostAgentErrorResponse(HOST_AGENT_V2_FIXTURES.valid.errorResponse)).toEqual(
      HOST_AGENT_V2_FIXTURES.valid.errorResponse,
    )
    expect(parseIdempotencyKey(HOST_AGENT_V2_FIXTURES.valid.headers.idempotencyKey)).toBe(
      HOST_AGENT_V2_FIXTURES.valid.headers.idempotencyKey,
    )
    expect(parseLastEventId(HOST_AGENT_V2_FIXTURES.valid.headers.lastEventId)).toBe(7)
  })

  it('proves every named invalid fixture fails the matching runtime parser', () => {
    const parsers: Record<string, (value: unknown) => unknown> = {
      createRunRequest: parseCreateHostAgentRunRequest,
      runSnapshot: parseHostAgentRunSnapshot,
      event: parseHostAgentEvent,
      errorResponse: parseHostAgentErrorResponse,
      idempotencyKey: parseIdempotencyKey,
      lastEventId: parseLastEventId,
    }
    for (const fixture of HOST_AGENT_V2_FIXTURES.invalid) {
      const parser = parsers[fixture.parser]
      expect(parser, fixture.name).toBeDefined()
      expect(() => parser!(fixture.value), fixture.name).toThrow(HostAgentContractValidationError)
    }
    for (const fixture of HOST_AGENT_V2_FIXTURES.rawInvalidUtf8) {
      const bytes = Uint8Array.from(Buffer.from(fixture.hex, 'hex'))
      expect(() => decodeHostAgentUtf8Strict(bytes, 100), fixture.name).toThrow(HostAgentContractValidationError)
    }
  })
})
