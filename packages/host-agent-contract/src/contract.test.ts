import { describe, expect, it } from 'bun:test'
import {
  HOST_AGENT_CONTRACT_VERSION,
  HOST_AGENT_ENV,
  HOST_AGENT_ENV_CONTRACT_VERSION,
  HOST_AGENT_ERROR_CODES,
  HOST_AGENT_ERROR_DEFINITIONS,
  HOST_AGENT_EVENT_TYPES,
  HOST_AGENT_LIMITS,
  HOST_AGENT_ROUTES,
  HOST_AGENT_RUN_STATES,
  HOST_AGENT_TERMINAL_RUN_STATES,
} from './constants.ts'
import { HOST_AGENT_FIXTURE_RUN_HANDLE, HOST_AGENT_V2_FIXTURES } from './fixtures.ts'
import {
  HostAgentContractValidationError,
  assertClosedJsonValue,
  createHostAgentErrorResponse,
  isHostAgentRunTransition,
  parseCreateHostAgentRunRequest,
  parseHostAgentCapabilitiesResponse,
  parseHostAgentErrorResponse,
  parseHostAgentEvent,
  parseHostAgentRoute,
  parseHostAgentRunSnapshot,
  parseIdempotencyKey,
  parseLastEventId,
  parseRunHandle,
  parseWorkingDirectory,
} from './validators.ts'

function expectContractError(callback: () => unknown, code?: HostAgentContractValidationError['code']): void {
  try {
    callback()
    throw new Error('Expected a HostAgentContractValidationError')
  } catch (error) {
    expect(error).toBeInstanceOf(HostAgentContractValidationError)
    if (code) expect((error as HostAgentContractValidationError).code).toBe(code)
  }
}

describe('Host Agent v2 constants', () => {
  it('locks the user-approved version, env, routes, states, and event vocabulary', () => {
    expect(HOST_AGENT_CONTRACT_VERSION).toBe(2)
    expect(HOST_AGENT_ENV_CONTRACT_VERSION).toBe('2')
    expect(HOST_AGENT_ENV).toEqual({
      url: 'SIMULATOR_HOST_AGENT_URL',
      tokenFile: 'SIMULATOR_HOST_AGENT_TOKEN_FILE',
      shimPath: 'SIMULATOR_HOST_AGENT_SHIM_PATH',
      contractVersion: 'SIMULATOR_HOST_AGENT_CONTRACT_VERSION',
    })
    expect(HOST_AGENT_ROUTES.capabilities).toBe('/v2/capabilities')
    expect(HOST_AGENT_ROUTES.runs).toBe('/v2/runs')
    expect(HOST_AGENT_ROUTES.run(HOST_AGENT_FIXTURE_RUN_HANDLE)).toBe(`/v2/runs/${HOST_AGENT_FIXTURE_RUN_HANDLE}`)
    expect(HOST_AGENT_ROUTES.events(HOST_AGENT_FIXTURE_RUN_HANDLE)).toBe(`/v2/runs/${HOST_AGENT_FIXTURE_RUN_HANDLE}/events`)
    expect(HOST_AGENT_ROUTES.cancel(HOST_AGENT_FIXTURE_RUN_HANDLE)).toBe(`/v2/runs/${HOST_AGENT_FIXTURE_RUN_HANDLE}/cancel`)
    expect(HOST_AGENT_RUN_STATES).toEqual([
      'accepted', 'starting', 'running', 'completed', 'failed', 'interrupted', 'closing', 'closed',
    ])
    expect(HOST_AGENT_TERMINAL_RUN_STATES).toEqual(['completed', 'failed', 'interrupted'])
    expect(HOST_AGENT_EVENT_TYPES).toEqual([
      'run.accepted', 'turn.started', 'message.delta', 'reasoning.delta', 'activity',
      'presentation.item', 'turn.completed', 'turn.failed', 'turn.interrupted', 'run.closed',
    ])
    expect(HOST_AGENT_ERROR_CODES).toContain('REPLAY_UNAVAILABLE')
  })

  it('locks every M1 resource ceiling', () => {
    expect(HOST_AGENT_LIMITS).toMatchObject({
      maxRequestBodyBytes: 2 * 1024 * 1024,
      maxPromptBytes: 2 * 1024 * 1024,
      maxEventBytes: 256 * 1024,
      maxDeltaBytes: 64 * 1024,
      maxReplayEvents: 1024,
      maxReplayBytes: 8 * 1024 * 1024,
      messagePortCreditBytes: 2 * 1024 * 1024,
      terminalControlReserveBytes: 64 * 1024,
      maxSseSubscribersPerGrant: 2,
      maxSocketsPerGrant: 8,
      maxConcurrentHttpRequestsPerGrant: 4,
      maxConcurrentModuleRuns: 1,
      heartbeatIntervalMs: 10_000,
      maxRunDurationMs: 30 * 60_000,
      workerHeapBytes: 64 * 1024 * 1024,
      workerRssGateBytes: 128 * 1024 * 1024,
      workerCrashWindowMs: 5 * 60_000,
      maxWorkerCrashesPerWindow: 3,
      maxStartupP95Ms: 250,
      tombstoneMinRetentionMs: 24 * 60 * 60_000,
    })
    expect(Object.isFrozen(HOST_AGENT_LIMITS)).toBe(true)
  })

  it('exposes the sole legal state transitions and keeps closed final', () => {
    expect(isHostAgentRunTransition('accepted', 'starting')).toBe(true)
    expect(isHostAgentRunTransition('accepted', 'failed')).toBe(true)
    expect(isHostAgentRunTransition('accepted', 'interrupted')).toBe(true)
    expect(isHostAgentRunTransition('running', 'completed')).toBe(true)
    expect(isHostAgentRunTransition('failed', 'closing')).toBe(true)
    expect(isHostAgentRunTransition('closing', 'closed')).toBe(true)
    expect(isHostAgentRunTransition('completed', 'running')).toBe(false)
    expect(isHostAgentRunTransition('closed', 'accepted')).toBe(false)
  })
})

describe('strict identifiers, headers, paths, and routes', () => {
  it('accepts only canonical run handles', () => {
    expect(parseRunHandle(HOST_AGENT_FIXTURE_RUN_HANDLE)).toBe(HOST_AGENT_FIXTURE_RUN_HANDLE)
    for (const value of [
      'run_0123456789ABCDEF0123456789ABCDEF',
      'run_0123',
      'session_0123456789abcdef0123456789abcdef',
      `${HOST_AGENT_FIXTURE_RUN_HANDLE}/events`,
      `%72${HOST_AGENT_FIXTURE_RUN_HANDLE.slice(1)}`,
      null,
    ]) expectContractError(() => parseRunHandle(value))
    expect(() => HOST_AGENT_ROUTES.run('run_bad')).toThrow(TypeError)
  })

  it('accepts canonical idempotency keys and rejects whitespace, controls, non-ASCII, and overlong values', () => {
    for (const value of ['fixture', '550e8400-e29b-41d4-a716-446655440000', 'run:one.v2_retry']) {
      expect(parseIdempotencyKey(value)).toBe(value)
    }
    for (const value of ['', ' key', 'two keys', 'key\n', '键', 'a'.repeat(129), ['duplicate']]) {
      expectContractError(() => parseIdempotencyKey(value))
    }
  })

  it('parses only canonical safe Last-Event-ID values', () => {
    expect(parseLastEventId(undefined)).toBeUndefined()
    expect(parseLastEventId('0')).toBe(0)
    expect(parseLastEventId('42')).toBe(42)
    expect(parseLastEventId(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER)
    for (const value of ['', '01', '-1', '1.0', ' 1', '1 ', '+1', String(Number.MAX_SAFE_INTEGER + 1), ['1']]) {
      expectContractError(() => parseLastEventId(value))
    }
  })

  it('accepts canonical absolute POSIX paths and rejects aliases and controls', () => {
    for (const value of ['/', '/tmp/project', '/Users/example/My Project', '/tmp/设计']) {
      expect(parseWorkingDirectory(value)).toBe(value)
    }
    for (const value of [
      '', 'relative', './project', '../project', '/tmp/', '/tmp//project', '/tmp/./project', '/tmp/../secret',
      '/tmp/line\nbreak', `/tmp/${'a'.repeat(HOST_AGENT_LIMITS.maxWorkingDirectoryBytes)}`,
    ]) expectContractError(() => parseWorkingDirectory(value))
  })

  it('matches exactly the six v2 method/path pairs', () => {
    expect(parseHostAgentRoute('GET', '/v2/capabilities')).toEqual({ route: 'capabilities' })
    expect(parseHostAgentRoute('POST', '/v2/runs')).toEqual({ route: 'runs.create' })
    expect(parseHostAgentRoute('GET', HOST_AGENT_ROUTES.run(HOST_AGENT_FIXTURE_RUN_HANDLE))).toEqual({
      route: 'runs.get', runHandle: HOST_AGENT_FIXTURE_RUN_HANDLE,
    })
    expect(parseHostAgentRoute('GET', HOST_AGENT_ROUTES.events(HOST_AGENT_FIXTURE_RUN_HANDLE))).toEqual({
      route: 'runs.events', runHandle: HOST_AGENT_FIXTURE_RUN_HANDLE,
    })
    expect(parseHostAgentRoute('POST', HOST_AGENT_ROUTES.cancel(HOST_AGENT_FIXTURE_RUN_HANDLE))).toEqual({
      route: 'runs.cancel', runHandle: HOST_AGENT_FIXTURE_RUN_HANDLE,
    })
    expect(parseHostAgentRoute('DELETE', HOST_AGENT_ROUTES.run(HOST_AGENT_FIXTURE_RUN_HANDLE))).toEqual({
      route: 'runs.delete', runHandle: HOST_AGENT_FIXTURE_RUN_HANDLE,
    })
  })

  it('rejects query, fragment, percent encoding, doubled slash, trailing slash, v1, and wrong methods', () => {
    for (const [method, target] of [
      ['GET', '/v2/capabilities?x=1'],
      ['GET', '/v2/capabilities#x'],
      ['GET', `/v2/runs/${HOST_AGENT_FIXTURE_RUN_HANDLE}%2Fevents`],
      ['GET', `//v2/runs/${HOST_AGENT_FIXTURE_RUN_HANDLE}`],
      ['GET', `${HOST_AGENT_ROUTES.run(HOST_AGENT_FIXTURE_RUN_HANDLE)}/`],
      ['GET', '/v1/capabilities'],
      ['POST', '/v2/capabilities'],
      ['POST', HOST_AGENT_ROUTES.events(HOST_AGENT_FIXTURE_RUN_HANDLE)],
      ['DELETE', HOST_AGENT_ROUTES.cancel(HOST_AGENT_FIXTURE_RUN_HANDLE)],
      ['PATCH', HOST_AGENT_ROUTES.run(HOST_AGENT_FIXTURE_RUN_HANDLE)],
    ]) expectContractError(() => parseHostAgentRoute(method, target))
  })
})

describe('closed DTO validators', () => {
  it('parses the exact POST /runs body without mutating caller input', () => {
    const input = {
      workingDirectory: '/tmp/allowed/project',
      prompt: 'Create a page',
      contractVersion: 2,
    }
    const before = JSON.stringify(input)
    expect(parseCreateHostAgentRunRequest(input)).toEqual({
      contractVersion: 2,
      prompt: 'Create a page',
      workingDirectory: '/tmp/allowed/project',
    })
    expect(JSON.stringify(input)).toBe(before)
    expect(parseCreateHostAgentRunRequest({ contractVersion: 2, prompt: 'Create' })).toEqual({
      contractVersion: 2,
      prompt: 'Create',
    })
  })

  it('rejects unknown identity/runtime fields, wrong versions, empty prompts, NUL, and byte overflow', () => {
    for (const value of [
      { contractVersion: 1, prompt: 'Create' },
      { contractVersion: 2, prompt: 'Create', provider: 'claude' },
      { contractVersion: 2, prompt: 'Create', model: 'model' },
      { contractVersion: 2, prompt: 'Create', sessionId: 'session' },
      { contractVersion: 2, prompt: 'Create', resume: true },
      { contractVersion: 2, prompt: 'Create', mcp: {} },
      { contractVersion: 2, prompt: '' },
      { contractVersion: 2, prompt: ' \n\t' },
      { contractVersion: 2, prompt: 'a\0b' },
      { contractVersion: 2, prompt: 'a'.repeat(HOST_AGENT_LIMITS.maxPromptBytes + 1) },
      { contractVersion: 2, prompt: 'Create', workingDirectory: undefined },
    ]) expectContractError(() => parseCreateHostAgentRunRequest(value))
  })

  it('rejects non-closed JavaScript data without invoking accessors', () => {
    let getterCalls = 0
    const accessor = { contractVersion: 2, prompt: 'Create' }
    Object.defineProperty(accessor, 'provider', {
      enumerable: true,
      get() {
        getterCalls += 1
        return 'secret'
      },
    })
    expectContractError(() => assertClosedJsonValue(accessor), 'NON_JSON_VALUE')
    expect(getterCalls).toBe(0)

    const symbol = { contractVersion: 2, prompt: 'Create', [Symbol('secret')]: true }
    expectContractError(() => assertClosedJsonValue(symbol), 'NON_JSON_VALUE')
    expectContractError(() => assertClosedJsonValue(new Date()), 'NON_JSON_VALUE')
    expectContractError(() => assertClosedJsonValue([, 'sparse']), 'NON_JSON_VALUE')
    expectContractError(() => assertClosedJsonValue({ value: BigInt(1) }), 'NON_JSON_VALUE')
    expectContractError(() => assertClosedJsonValue({ value: Number.NaN }), 'NON_JSON_VALUE')
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    expectContractError(() => assertClosedJsonValue(cycle), 'NON_JSON_VALUE')
    expectContractError(() => assertClosedJsonValue({ value: '\ud800' }), 'INVALID_VALUE')
    const hostile = new Proxy({}, { ownKeys: () => { throw new Error('trap') } })
    expectContractError(() => assertClosedJsonValue(hostile), 'NON_JSON_VALUE')
  })

  it('validates minimal provider-neutral capabilities and hard ceilings', () => {
    expect(parseHostAgentCapabilitiesResponse(HOST_AGENT_V2_FIXTURES.valid.capabilitiesResponse)).toEqual(
      HOST_AGENT_V2_FIXTURES.valid.capabilitiesResponse,
    )
    const lower = {
      ...HOST_AGENT_V2_FIXTURES.valid.capabilitiesResponse,
      features: { ...HOST_AGENT_V2_FIXTURES.valid.capabilitiesResponse.features },
      limits: { ...HOST_AGENT_V2_FIXTURES.valid.capabilitiesResponse.limits, maxReplayEvents: 128 },
    }
    expect(parseHostAgentCapabilitiesResponse(lower).limits.maxReplayEvents).toBe(128)
    const tooHigh = {
      ...HOST_AGENT_V2_FIXTURES.valid.capabilitiesResponse,
      features: { ...HOST_AGENT_V2_FIXTURES.valid.capabilitiesResponse.features },
      limits: { ...HOST_AGENT_V2_FIXTURES.valid.capabilitiesResponse.limits, maxSseSubscribers: 3 },
    }
    expectContractError(() => parseHostAgentCapabilitiesResponse(tooHigh), 'LIMIT_EXCEEDED')
    const providerLeak = { ...HOST_AGENT_V2_FIXTURES.valid.capabilitiesResponse, provider: 'claude' }
    expectContractError(() => parseHostAgentCapabilitiesResponse(providerLeak), 'UNKNOWN_FIELD')
  })

  it('enforces snapshot state/timestamp shape and keeps terminal distinct from closed', () => {
    for (const snapshot of HOST_AGENT_V2_FIXTURES.valid.runSnapshots) {
      expect(parseHostAgentRunSnapshot(snapshot)).toEqual(snapshot)
    }
    for (const state of ['accepted', 'starting', 'running'] as const) {
      expect(parseHostAgentRunSnapshot({
        contractVersion: 2,
        runHandle: HOST_AGENT_FIXTURE_RUN_HANDLE,
        state,
        createdAt: 1,
        updatedAt: 2,
      }).state).toBe(state)
    }
    for (const state of ['completed', 'failed', 'interrupted', 'closing'] as const) {
      expect(parseHostAgentRunSnapshot({
        contractVersion: 2,
        runHandle: HOST_AGENT_FIXTURE_RUN_HANDLE,
        state,
        createdAt: 1,
        updatedAt: 2,
        terminalAt: 2,
      }).state).toBe(state)
    }
    for (const value of [
      { contractVersion: 2, runHandle: HOST_AGENT_FIXTURE_RUN_HANDLE, state: 'failed', createdAt: 1, updatedAt: 2 },
      { contractVersion: 2, runHandle: HOST_AGENT_FIXTURE_RUN_HANDLE, state: 'running', createdAt: 1, updatedAt: 2, terminalAt: 2 },
      { contractVersion: 2, runHandle: HOST_AGENT_FIXTURE_RUN_HANDLE, state: 'closed', createdAt: 1, updatedAt: 3, terminalAt: 2 },
      { contractVersion: 2, runHandle: HOST_AGENT_FIXTURE_RUN_HANDLE, state: 'closed', createdAt: 3, updatedAt: 2, terminalAt: 2, closedAt: 2 },
      { contractVersion: 2, runHandle: HOST_AGENT_FIXTURE_RUN_HANDLE, state: 'closed', createdAt: 1, updatedAt: 3, terminalAt: 3, closedAt: 2 },
    ]) expectContractError(() => parseHostAgentRunSnapshot(value))
  })

  it('accepts every locked event type and rejects fields outside each closed payload', () => {
    const parsed = HOST_AGENT_V2_FIXTURES.valid.events.map((event) => parseHostAgentEvent(event))
    expect(parsed.map((event) => event.type)).toEqual([...HOST_AGENT_EVENT_TYPES])
    expectContractError(() => parseHostAgentEvent({
      ...HOST_AGENT_V2_FIXTURES.valid.events[2],
      providerSessionId: 'secret',
    }), 'UNKNOWN_FIELD')
    expectContractError(() => parseHostAgentEvent({
      ...HOST_AGENT_V2_FIXTURES.valid.events[2],
      data: { delta: 'x', rawProviderPayload: {} },
    }), 'UNKNOWN_FIELD')
    expectContractError(() => parseHostAgentEvent({
      ...HOST_AGENT_V2_FIXTURES.valid.events[2],
      eventId: '03',
    }))
    expectContractError(() => parseHostAgentEvent({
      ...HOST_AGENT_V2_FIXTURES.valid.events[7],
      data: { code: 'RUNTIME_UNAVAILABLE', retryable: false },
    }))
    expectContractError(() => parseHostAgentEvent({
      ...HOST_AGENT_V2_FIXTURES.valid.events[8],
      data: { reason: 'CLIENT_CANCELLED', retryable: true },
    }))
  })

  it('enforces the 64 KiB delta and 256 KiB encoded event ceilings in UTF-8 bytes', () => {
    const base = HOST_AGENT_V2_FIXTURES.valid.events[2]
    const exactDelta = { ...base, data: { delta: 'a'.repeat(HOST_AGENT_LIMITS.maxDeltaBytes) } }
    expect(parseHostAgentEvent(exactDelta).type).toBe('message.delta')
    expectContractError(() => parseHostAgentEvent({
      ...base,
      data: { delta: 'a'.repeat(HOST_AGENT_LIMITS.maxDeltaBytes + 1) },
    }), 'LIMIT_EXCEEDED')
    expectContractError(() => parseHostAgentEvent({
      ...HOST_AGENT_V2_FIXTURES.valid.events[5],
      data: {
        itemId: 'huge',
        kind: 'text',
        text: 'a'.repeat(HOST_AGENT_LIMITS.maxEventBytes),
      },
    }), 'LIMIT_EXCEEDED')
  })

  it('uses fixed, closed, redacted public errors for every code', () => {
    for (const code of HOST_AGENT_ERROR_CODES) {
      const response = createHostAgentErrorResponse(code)
      expect(parseHostAgentErrorResponse(response)).toEqual(response)
      expect(response.error).toEqual({
        code,
        message: HOST_AGENT_ERROR_DEFINITIONS[code].message,
        retryable: HOST_AGENT_ERROR_DEFINITIONS[code].retryable,
      })
      expect('httpStatus' in response.error).toBe(false)
    }
    const replay = createHostAgentErrorResponse('REPLAY_UNAVAILABLE')
    expect(replay.error.retryable).toBe(false)
    expectContractError(() => parseHostAgentErrorResponse({
      ...replay,
      error: { ...replay.error, message: '/private/path leaked' },
    }))
    expectContractError(() => parseHostAgentErrorResponse({
      ...replay,
      error: { ...replay.error, providerPayload: {} },
    }), 'UNKNOWN_FIELD')
  })
})
