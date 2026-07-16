import {
  HOST_AGENT_CAPABILITY,
  HOST_AGENT_CONTRACT_VERSION,
  HOST_AGENT_ERROR_DEFINITIONS,
  HOST_AGENT_EVENT_TYPES,
  HOST_AGENT_LIMITS,
} from './constants.ts'

export const HOST_AGENT_FIXTURE_RUN_HANDLE = 'run_0123456789abcdef0123456789abcdef' as const
export const HOST_AGENT_FIXTURE_IDEMPOTENCY_KEY = 'fixture-run-0001' as const

const eventBase = <
  const TType extends (typeof HOST_AGENT_EVENT_TYPES)[number],
  const TData extends Record<string, unknown>,
>(
  sequence: number,
  type: TType,
  data: TData,
) => ({
  contractVersion: HOST_AGENT_CONTRACT_VERSION,
  eventId: String(sequence),
  sequence,
  runHandle: HOST_AGENT_FIXTURE_RUN_HANDLE,
  occurredAt: 1_700_000_000_000 + sequence,
  type,
  data,
})

export const HOST_AGENT_V2_FIXTURES = Object.freeze({
  contractVersion: HOST_AGENT_CONTRACT_VERSION,
  canonicalRequest: {
    idempotencyKey: HOST_AGENT_FIXTURE_IDEMPOTENCY_KEY,
    value: {
      workingDirectory: '/tmp/allowed/project',
      prompt: 'Create a calm dashboard.\nUse the existing files.',
      contractVersion: HOST_AGENT_CONTRACT_VERSION,
    },
    canonicalJson: '{"contractVersion":2,"prompt":"Create a calm dashboard.\\nUse the existing files.","workingDirectory":"/tmp/allowed/project"}',
    requestSha256: '134e5f4eadbce998e870393d12f7f8009fb9d2b38f68b81f79490e29ffa339fb',
    idempotencyKeySha256: 'f1eed990c0fc4c044df333986677272d91883736830710bfb665f746bb595e74',
  },
  valid: {
    createRunRequests: [
      { contractVersion: HOST_AGENT_CONTRACT_VERSION, prompt: 'Create a landing page.' },
      {
        contractVersion: HOST_AGENT_CONTRACT_VERSION,
        prompt: '创建一个可访问的设置页面。',
        workingDirectory: '/tmp/allowed/project',
      },
    ],
    capabilitiesResponse: {
      contractVersion: HOST_AGENT_CONTRACT_VERSION,
      capability: HOST_AGENT_CAPABILITY,
      features: { streaming: true, cancellation: true, reconnect: true, idempotency: true },
      limits: {
        maxPromptBytes: HOST_AGENT_LIMITS.maxPromptBytes,
        maxEventBytes: HOST_AGENT_LIMITS.maxEventBytes,
        maxDeltaBytes: HOST_AGENT_LIMITS.maxDeltaBytes,
        maxReplayEvents: HOST_AGENT_LIMITS.maxReplayEvents,
        maxReplayBytes: HOST_AGENT_LIMITS.maxReplayBytes,
        maxSseSubscribers: HOST_AGENT_LIMITS.maxSseSubscribersPerGrant,
        maxConcurrentRuns: HOST_AGENT_LIMITS.maxConcurrentModuleRuns,
        maxRunDurationMs: HOST_AGENT_LIMITS.maxRunDurationMs,
      },
    },
    runSnapshots: [
      {
        contractVersion: HOST_AGENT_CONTRACT_VERSION,
        runHandle: HOST_AGENT_FIXTURE_RUN_HANDLE,
        state: 'accepted',
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
      },
      {
        contractVersion: HOST_AGENT_CONTRACT_VERSION,
        runHandle: HOST_AGENT_FIXTURE_RUN_HANDLE,
        state: 'completed',
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_100,
        terminalAt: 1_700_000_000_100,
      },
      {
        contractVersion: HOST_AGENT_CONTRACT_VERSION,
        runHandle: HOST_AGENT_FIXTURE_RUN_HANDLE,
        state: 'closed',
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_200,
        terminalAt: 1_700_000_000_100,
        closedAt: 1_700_000_000_200,
      },
    ],
    events: [
      eventBase(1, 'run.accepted', {}),
      eventBase(2, 'turn.started', {}),
      eventBase(3, 'message.delta', { delta: 'Hello' }),
      eventBase(4, 'reasoning.delta', { delta: 'Checking layout' }),
      eventBase(5, 'activity', { phase: 'started', kind: 'tool', label: 'Write file' }),
      eventBase(6, 'presentation.item', {
        itemId: 'preview.main',
        kind: 'preview',
        title: 'Main preview',
        uri: 'http://127.0.0.1:4173/',
        mediaType: 'text/html',
      }),
      eventBase(7, 'turn.completed', { finalText: 'Done' }),
      eventBase(8, 'turn.failed', { code: 'RUNTIME_UNAVAILABLE', retryable: true }),
      eventBase(9, 'turn.interrupted', { reason: 'CRAFT_TURN_PREEMPTED', retryable: true }),
      eventBase(10, 'run.closed', {}),
    ],
    errorResponse: {
      contractVersion: HOST_AGENT_CONTRACT_VERSION,
      error: {
        code: 'REPLAY_UNAVAILABLE',
        message: HOST_AGENT_ERROR_DEFINITIONS.REPLAY_UNAVAILABLE.message,
        retryable: HOST_AGENT_ERROR_DEFINITIONS.REPLAY_UNAVAILABLE.retryable,
      },
    },
    headers: {
      idempotencyKey: HOST_AGENT_FIXTURE_IDEMPOTENCY_KEY,
      lastEventId: '7',
    },
  },
  invalid: [
    {
      name: 'create-run-v1',
      parser: 'createRunRequest',
      value: { contractVersion: 1, prompt: 'Create' },
    },
    {
      name: 'create-run-unknown-provider',
      parser: 'createRunRequest',
      value: { contractVersion: HOST_AGENT_CONTRACT_VERSION, prompt: 'Create', provider: 'claude' },
    },
    {
      name: 'create-run-whitespace-prompt',
      parser: 'createRunRequest',
      value: { contractVersion: HOST_AGENT_CONTRACT_VERSION, prompt: ' \n\t ' },
    },
    {
      name: 'create-run-nul-prompt',
      parser: 'createRunRequest',
      value: { contractVersion: HOST_AGENT_CONTRACT_VERSION, prompt: 'Create\0file' },
    },
    {
      name: 'create-run-relative-directory',
      parser: 'createRunRequest',
      value: { contractVersion: HOST_AGENT_CONTRACT_VERSION, prompt: 'Create', workingDirectory: 'project' },
    },
    {
      name: 'create-run-noncanonical-directory',
      parser: 'createRunRequest',
      value: { contractVersion: HOST_AGENT_CONTRACT_VERSION, prompt: 'Create', workingDirectory: '/tmp/../secret' },
    },
    {
      name: 'run-snapshot-invalid-handle',
      parser: 'runSnapshot',
      value: {
        contractVersion: HOST_AGENT_CONTRACT_VERSION,
        runHandle: 'run_NOT_CANONICAL',
        state: 'accepted',
        createdAt: 1,
        updatedAt: 1,
      },
    },
    {
      name: 'run-snapshot-terminal-without-time',
      parser: 'runSnapshot',
      value: {
        contractVersion: HOST_AGENT_CONTRACT_VERSION,
        runHandle: HOST_AGENT_FIXTURE_RUN_HANDLE,
        state: 'failed',
        createdAt: 1,
        updatedAt: 2,
      },
    },
    {
      name: 'event-sequence-id-mismatch',
      parser: 'event',
      value: { ...eventBase(3, 'message.delta', { delta: 'x' }), eventId: '2' },
    },
    {
      name: 'event-unknown-field',
      parser: 'event',
      value: { ...eventBase(3, 'message.delta', { delta: 'x' }), providerSessionId: 'secret' },
    },
    {
      name: 'error-retryability-mismatch',
      parser: 'errorResponse',
      value: {
        contractVersion: HOST_AGENT_CONTRACT_VERSION,
        error: {
          code: 'REPLAY_UNAVAILABLE',
          message: HOST_AGENT_ERROR_DEFINITIONS.REPLAY_UNAVAILABLE.message,
          retryable: true,
        },
      },
    },
    {
      name: 'last-event-id-leading-zero',
      parser: 'lastEventId',
      value: '01',
    },
    {
      name: 'idempotency-key-whitespace',
      parser: 'idempotencyKey',
      value: 'fixture key',
    },
  ],
  rawInvalidUtf8: [
    { name: 'overlong-slash', hex: 'c0af' },
    { name: 'utf8-bom', hex: 'efbbbf7b7d' },
    { name: 'truncated-four-byte-sequence', hex: 'f09f92' },
  ],
} as const)

export function renderHostAgentV2Fixtures(): string {
  return `${JSON.stringify(HOST_AGENT_V2_FIXTURES, null, 2)}\n`
}
