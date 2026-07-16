import { describe, expect, it } from 'bun:test'
import { HOST_AGENT_CONTRACT_VERSION, type HostAgentEvent } from '@simulator/host-agent-contract'
import { ModuleAgentRunCore } from './run-core.ts'
import { HostAgentRunCoreError } from './types.ts'
import {
  DeterministicHostAgentRunIdSource,
  InMemoryHostAgentRunSessionPort,
} from './testing.ts'

const flush = async () => {
  await Promise.resolve()
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

async function setup(overrides?: { maxReplayEvents?: number }) {
  const sessions = new InMemoryHostAgentRunSessionPort()
  let canonicalizeBarrier: Promise<void> | undefined
  const core = new ModuleAgentRunCore({
    sessions,
    ids: new DeterministicHostAgentRunIdSource(),
    paths: {
      async canonicalize(value) {
        await canonicalizeBarrier
        return value
      },
      isEqualOrWithin(candidate, root) { return candidate === root || candidate.startsWith(`${root}/`) },
    },
    limits: {
      maxReplayEvents: overrides?.maxReplayEvents ?? 32,
      maxReplayBytes: 1024 * 1024,
      maxRunDurationMs: 60_000,
      tombstoneMinRetentionMs: 60_000,
    },
  })
  await core.issueGrant({
    grantId: 'grant-1',
    moduleId: 'org.simulator.open-design',
    workerEpoch: 'epoch-1',
    workspaceId: 'workspace-1',
    workspaceRoot: '/workspace',
    authorizedWorkingRoot: '/projects',
    defaultWorkingDirectory: '/projects/default',
    expiresAt: Date.now() + 60_000,
  })
  return {
    core,
    sessions,
    setCanonicalizeBarrier(value: Promise<void> | undefined) { canonicalizeBarrier = value },
  }
}

const request = (prompt = 'Build the dashboard') => ({
  contractVersion: HOST_AGENT_CONTRACT_VERSION,
  prompt,
})

describe('ModuleAgentRunCore', () => {
  it('atomically binds idempotency and transient ownership before provider start', async () => {
    const { core, sessions } = await setup()
    const first = await core.createRun({ grantId: 'grant-1', idempotencyKey: 'turn-1', request: request() })
    const duplicate = await core.createRun({ grantId: 'grant-1', idempotencyKey: 'turn-1', request: request() })
    expect(duplicate.runHandle).toBe(first.runHandle)
    expect(sessions.created).toHaveLength(1)
    expect(sessions.created[0]?.ownership).toEqual({
      transient: true,
      contractVersion: 2,
      moduleId: 'org.simulator.open-design',
      runHandle: first.runHandle,
      idempotencyKeyDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      requestDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      workerEpoch: 'epoch-1',
      state: 'accepted',
    })
    await flush()
    expect(sessions.prompts).toEqual([{ sessionId: 'session-1', prompt: 'Build the dashboard' }])
    expect(core.getRun('grant-1', first.runHandle).state).toBe('running')
  })

  it('serializes concurrent idempotent creates into one Run and one Session', async () => {
    const { core, sessions, setCanonicalizeBarrier } = await setup()
    const gate = deferred()
    setCanonicalizeBarrier(gate.promise)
    const first = core.createRun({ grantId: 'grant-1', idempotencyKey: 'same-key', request: request() })
    const duplicate = core.createRun({ grantId: 'grant-1', idempotencyKey: 'same-key', request: request() })
    await flush()
    gate.resolve()
    const [firstRun, duplicateRun] = await Promise.all([first, duplicate])
    expect(duplicateRun.runHandle).toBe(firstRun.runHandle)
    expect(sessions.created).toHaveLength(1)
  })

  it('enforces one global Module Run across concurrent distinct creates', async () => {
    const { core, sessions, setCanonicalizeBarrier } = await setup()
    const gate = deferred()
    setCanonicalizeBarrier(gate.promise)
    const first = core.createRun({ grantId: 'grant-1', idempotencyKey: 'concurrent-1', request: request('one') })
    const second = core.createRun({ grantId: 'grant-1', idempotencyKey: 'concurrent-2', request: request('two') })
    await flush()
    gate.resolve()
    const results = await Promise.allSettled([first, second])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ code: 'RUN_ACTIVE' }) }),
    ])
    expect(sessions.created).toHaveLength(1)
  })

  it('rechecks Craft priority after asynchronous path canonicalization', async () => {
    const { core, sessions, setCanonicalizeBarrier } = await setup()
    const gate = deferred()
    setCanonicalizeBarrier(gate.promise)
    const creating = core.createRun({
      grantId: 'grant-1', idempotencyKey: 'canonicalize-craft-race', request: request(),
    })
    await flush()
    await core.beginCraftTurn()
    gate.resolve()
    await expect(creating).rejects.toMatchObject({ code: 'CRAFT_TURN_ACTIVE' })
    expect(sessions.created).toHaveLength(0)
    core.endCraftTurn()
  })

  it('rechecks grant revocation after asynchronous path canonicalization', async () => {
    const { core, sessions, setCanonicalizeBarrier } = await setup()
    const gate = deferred()
    setCanonicalizeBarrier(gate.promise)
    const creating = core.createRun({
      grantId: 'grant-1', idempotencyKey: 'canonicalize-disconnect-race', request: request(),
    })
    await flush()
    await core.disconnectGrant('grant-1')
    gate.resolve()
    await expect(creating).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    expect(sessions.created).toHaveLength(0)
  })

  it('rejects a reused idempotency key with a different canonical request', async () => {
    const { core } = await setup()
    await core.createRun({ grantId: 'grant-1', idempotencyKey: 'turn-1', request: request('one') })
    await expect(core.createRun({
      grantId: 'grant-1',
      idempotencyKey: 'turn-1',
      request: request('two'),
    })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
  })

  it('serializes completion and cancellation to exactly one terminal event', async () => {
    const { core, sessions } = await setup()
    const run = await core.createRun({ grantId: 'grant-1', idempotencyKey: 'turn-race', request: request() })
    const events: HostAgentEvent[] = []
    core.subscribe('grant-1', run.runHandle, undefined, (event) => events.push(event))
    await flush()
    sessions.emit('session-1', { type: 'turn.completed', finalText: 'done' })
    const cancelled = core.cancelRun('grant-1', run.runHandle)
    await cancelled
    const terminal = events.filter((event) =>
      event.type === 'turn.completed' || event.type === 'turn.failed' || event.type === 'turn.interrupted')
    expect(terminal).toHaveLength(1)
    const terminalState = terminal[0]?.type === 'turn.completed'
      ? 'completed'
      : terminal[0]?.type === 'turn.failed'
        ? 'failed'
        : 'interrupted'
    expect(core.getRun('grant-1', run.runHandle).state).toBe(terminalState)
  })

  it('fails stale replay explicitly instead of fabricating continuity', async () => {
    const { core, sessions } = await setup({ maxReplayEvents: 2 })
    const run = await core.createRun({ grantId: 'grant-1', idempotencyKey: 'turn-replay', request: request() })
    await flush()
    sessions.emit('session-1', { type: 'message.delta', delta: 'a' })
    sessions.emit('session-1', { type: 'message.delta', delta: 'b' })
    sessions.emit('session-1', { type: 'message.delta', delta: 'c' })
    await flush()
    expect(() => core.subscribe('grant-1', run.runHandle, 0, () => undefined)).toThrow(HostAgentRunCoreError)
    try {
      core.subscribe('grant-1', run.runHandle, 0, () => undefined)
    } catch (error) {
      expect(error).toMatchObject({ code: 'REPLAY_UNAVAILABLE' })
    }
  })

  it('lets a visible Craft turn preempt and await the Module turn', async () => {
    const { core, sessions } = await setup()
    const run = await core.createRun({ grantId: 'grant-1', idempotencyKey: 'turn-preempt', request: request() })
    const events: HostAgentEvent[] = []
    core.subscribe('grant-1', run.runHandle, undefined, (event) => events.push(event))
    await flush()
    await core.beginCraftTurn()
    expect(sessions.cancelled).toEqual(['session-1'])
    expect(sessions.reaped).toEqual(['session-1'])
    expect(core.getRun('grant-1', run.runHandle).state).toBe('closed')
    expect(events.filter((event) => event.type === 'turn.interrupted')).toHaveLength(1)
    expect(events.at(-1)?.type).toBe('run.closed')
    expect(core.debugSnapshot()).toMatchObject({ activeRuns: 0, moduleSessions: 0 })
    await expect(core.createRun({
      grantId: 'grant-1', idempotencyKey: 'turn-blocked', request: request(),
    })).rejects.toMatchObject({ code: 'CRAFT_TURN_ACTIVE' })
    core.endCraftTurn()
  })

  it('strictly reaps when cooperative Craft preemption does not acknowledge stop', async () => {
    const { core, sessions } = await setup()
    const run = await core.createRun({ grantId: 'grant-1', idempotencyKey: 'turn-hard-preempt', request: request() })
    await flush()
    sessions.awaitStoppedError = new Error('provider did not acknowledge stop')

    await expect(core.beginCraftTurn()).resolves.toBeUndefined()
    expect(sessions.cancelled).toEqual(['session-1'])
    expect(sessions.reaped).toEqual(['session-1'])
    expect(core.getRun('grant-1', run.runHandle).state).toBe('closed')
    expect(core.debugSnapshot().moduleSessions).toBe(0)
  })

  it('fails closed when neither cooperative nor strict Craft preemption can reap', async () => {
    const { core, sessions } = await setup()
    const run = await core.createRun({ grantId: 'grant-1', idempotencyKey: 'turn-stuck-preempt', request: request() })
    await flush()
    sessions.awaitStoppedError = new Error('provider did not acknowledge stop')
    sessions.reapError = new Error('provider child still alive')

    await expect(core.beginCraftTurn()).rejects.toMatchObject({ code: 'CLEANUP_FAILED' })
    expect(core.getRun('grant-1', run.runHandle).state).toBe('running')
    expect(core.debugSnapshot().moduleSessions).toBe(1)
    await expect(core.createRun({
      grantId: 'grant-1', idempotencyKey: 'turn-must-stay-blocked', request: request(),
    })).rejects.toMatchObject({ code: 'CRAFT_TURN_ACTIVE' })
  })

  it('makes DELETE idempotent and waits for strict Session reap', async () => {
    const { core, sessions } = await setup()
    const run = await core.createRun({ grantId: 'grant-1', idempotencyKey: 'turn-close', request: request() })
    await flush()
    const closed = await core.closeRun('grant-1', run.runHandle)
    expect(closed.state).toBe('closed')
    expect(sessions.reaped).toEqual(['session-1'])
    expect((await core.closeRun('grant-1', run.runHandle)).state).toBe('closed')
    expect(sessions.reaped).toEqual(['session-1'])
    expect(core.debugSnapshot()).toMatchObject({ activeRuns: 0, moduleSessions: 0 })
  })

  it('keeps cleanup ownership after a failed reap and lets DELETE retry', async () => {
    const { core, sessions } = await setup()
    const run = await core.createRun({ grantId: 'grant-1', idempotencyKey: 'turn-reap-retry', request: request() })
    await flush()
    sessions.reapError = new Error('provider process still alive')
    await expect(core.closeRun('grant-1', run.runHandle)).rejects.toMatchObject({ code: 'CLEANUP_FAILED' })
    expect(core.getRun('grant-1', run.runHandle).state).toBe('closing')
    expect(core.debugSnapshot().moduleSessions).toBe(1)
    sessions.reapError = undefined
    await expect(core.closeRun('grant-1', run.runHandle)).resolves.toMatchObject({ state: 'closed' })
    expect(core.debugSnapshot().moduleSessions).toBe(0)
  })

  it('fails and reaps only the disconnected Broker grant without replay', async () => {
    const { core, sessions } = await setup()
    const run = await core.createRun({ grantId: 'grant-1', idempotencyKey: 'turn-disconnect', request: request() })
    await flush()
    await core.disconnectGrant('grant-1')
    expect(sessions.cancelled).toEqual(['session-1'])
    expect(sessions.reaped).toEqual(['session-1'])
    expect(core.getRun('grant-1', run.runHandle)).toMatchObject({ state: 'closed' })
    expect(sessions.prompts).toHaveLength(1)
  })

  it('serializes Broker disconnect behind Session creation so no late Session escapes', async () => {
    const { core, sessions } = await setup()
    const enteredCreate = deferred()
    const releaseCreate = deferred()
    const createSession = sessions.createSession.bind(sessions)
    sessions.createSession = async (input) => {
      enteredCreate.resolve()
      await releaseCreate.promise
      return await createSession(input)
    }

    const creating = core.createRun({
      grantId: 'grant-1', idempotencyKey: 'turn-disconnect-create-race', request: request(),
    })
    await enteredCreate.promise
    const disconnecting = core.disconnectGrant('grant-1')
    releaseCreate.resolve()
    const run = await creating
    await disconnecting

    expect(core.getRun('grant-1', run.runHandle).state).toBe('closed')
    expect(sessions.reaped).toEqual(['session-1'])
    expect(core.debugSnapshot()).toMatchObject({ activeRuns: 0, moduleSessions: 0 })
  })

  it('retains failed initialization ownership until an uncertain Session is reaped', async () => {
    const { core, sessions } = await setup()
    sessions.subscribe = () => { throw new Error('subscription unavailable') }
    sessions.reapError = new Error('provider process still alive')

    await expect(core.createRun({
      grantId: 'grant-1', idempotencyKey: 'turn-initialization-cleanup', request: request(),
    })).rejects.toMatchObject({ code: 'CLEANUP_FAILED' })
    expect(core.debugSnapshot()).toMatchObject({ activeRuns: 1, retainedRuns: 1, moduleSessions: 1 })
    await expect(core.createRun({
      grantId: 'grant-1', idempotencyKey: 'turn-initialization-cleanup', request: request(),
    })).rejects.toMatchObject({ code: 'CLEANUP_FAILED' })
    expect(sessions.created).toHaveLength(1)

    sessions.reapError = undefined
    await core.disconnectGrant('grant-1')
    expect(sessions.reaped).toEqual(['session-1'])
    expect(core.debugSnapshot()).toMatchObject({ activeRuns: 0, moduleSessions: 0 })
  })

  it('does not retain a failed pre-session reservation as a phantom run', async () => {
    const { core, sessions } = await setup()
    sessions.createError = new Error('disk unavailable')
    await expect(core.createRun({
      grantId: 'grant-1', idempotencyKey: 'turn-retryable-create', request: request(),
    })).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
    expect(core.debugSnapshot()).toMatchObject({ activeRuns: 0, retainedRuns: 0, moduleSessions: 0 })
    sessions.createError = undefined
    await expect(core.createRun({
      grantId: 'grant-1', idempotencyKey: 'turn-retryable-create', request: request(),
    })).resolves.toMatchObject({ state: 'accepted' })
  })
})
