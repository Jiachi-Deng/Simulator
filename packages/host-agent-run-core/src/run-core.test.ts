import { describe, expect, it } from 'bun:test'
import { HOST_AGENT_CONTRACT_VERSION, type HostAgentEvent } from '@simulator/host-agent-contract'
import { ModuleAgentRunCore } from './run-core.ts'
import { HostAgentRunCoreError, type HostAgentRunClock } from './types.ts'
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
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

class TestClock implements HostAgentRunClock {
  #now: number
  #nextTimer = 1
  readonly #timers = new Map<number, { at: number; callback: () => void }>()

  constructor(now = 1_000) { this.#now = now }

  now(): number { return this.#now }

  get pendingTimers(): number { return this.#timers.size }

  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.#nextTimer++
    this.#timers.set(id, { at: this.#now + delayMs, callback })
    return id
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === 'number') this.#timers.delete(handle)
  }

  setNow(now: number): void { this.#now = now }

  advance(ms: number): void {
    this.#now += ms
    while (true) {
      const due = [...this.#timers.entries()]
        .filter(([, timer]) => timer.at <= this.#now)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0]
      if (!due) return
      this.#timers.delete(due[0])
      due[1].callback()
    }
  }
}

interface SetupOverrides {
  maxReplayEvents?: number
  maxReplayBytes?: number
  maxRetainedTerminalReplayBytes?: number
  maxRunDurationMs?: number
  maxCraftPreemptionMs?: number
  tombstoneMinRetentionMs?: number
  grantTtlMs?: number
  clock?: HostAgentRunClock
}

async function setup(overrides?: SetupOverrides) {
  const sessions = new InMemoryHostAgentRunSessionPort()
  let canonicalizeBarrier: Promise<void> | undefined
  const maxReplayBytes = overrides?.maxReplayBytes ?? 1024 * 1024
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
    ...(overrides?.clock ? { clock: overrides.clock } : {}),
    limits: {
      maxReplayEvents: overrides?.maxReplayEvents ?? 32,
      maxReplayBytes,
      maxRetainedTerminalReplayBytes: overrides?.maxRetainedTerminalReplayBytes ?? maxReplayBytes,
      maxRunDurationMs: overrides?.maxRunDurationMs ?? 60_000,
      maxCraftPreemptionMs: overrides?.maxCraftPreemptionMs ?? 5_000,
      tombstoneMinRetentionMs: overrides?.tombstoneMinRetentionMs ?? 60_000,
    },
  })
  const now = overrides?.clock?.now() ?? Date.now()
  await core.issueGrant({
    grantId: 'grant-1',
    moduleId: 'org.simulator.open-design',
    workerEpoch: 'epoch-1',
    workspaceId: 'workspace-1',
    workspaceRoot: '/workspace',
    authorizedWorkingRoot: '/projects',
    defaultWorkingDirectory: '/projects/default',
    expiresAt: now + (overrides?.grantTtlMs ?? 60_000),
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

  it('recovers the committed Session when the create response is lost', async () => {
    const { core, sessions } = await setup()
    const createSession = sessions.createSession.bind(sessions)
    sessions.createSession = async (input) => {
      await createSession(input)
      throw new Error('response lost after ownership header commit')
    }

    const first = await core.createRun({
      grantId: 'grant-1', idempotencyKey: 'lost-create-response', request: request(),
    })
    const duplicate = await core.createRun({
      grantId: 'grant-1', idempotencyKey: 'lost-create-response', request: request(),
    })
    expect(duplicate.runHandle).toBe(first.runHandle)
    expect(sessions.created).toHaveLength(1)
    expect(sessions.recovered).toHaveLength(1)
    expect(core.debugSnapshot()).toMatchObject({ retainedRuns: 1, moduleSessions: 1 })
  })

  it('retains idempotency ownership when Session recovery is uncertain', async () => {
    const { core, sessions } = await setup()
    let createAttempts = 0
    sessions.createSession = async () => {
      createAttempts += 1
      throw new Error('response lost after possible commit')
    }
    sessions.recoverError = new Error('ownership lookup unavailable')

    await expect(core.createRun({
      grantId: 'grant-1', idempotencyKey: 'unknown-create-ownership', request: request(),
    })).rejects.toMatchObject({ code: 'CLEANUP_FAILED' })
    expect(core.debugSnapshot()).toMatchObject({ activeRuns: 1, retainedRuns: 1 })
    await expect(core.createRun({
      grantId: 'grant-1', idempotencyKey: 'unknown-create-ownership', request: request(),
    })).rejects.toMatchObject({ code: 'CLEANUP_FAILED' })
    await expect(core.createRun({
      grantId: 'grant-1', idempotencyKey: 'another-key', request: request('another'),
    })).rejects.toMatchObject({ code: 'CLEANUP_FAILED' })
    expect(createAttempts).toBe(1)
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

  it('bounds Craft admission when Module Session initialization never settles', async () => {
    const { core, sessions } = await setup({ maxCraftPreemptionMs: 20 })
    sessions.createSession = async () => await new Promise<never>(() => undefined)
    const creating = core.createRun({
      grantId: 'grant-1', idempotencyKey: 'never-settled-init', request: request(),
    })
    void creating.catch(() => undefined)
    await flush()
    const startedAt = Date.now()
    await expect(core.beginCraftTurn()).rejects.toMatchObject({ code: 'CLEANUP_FAILED' })
    expect(Date.now() - startedAt).toBeLessThan(500)
    expect(core.debugSnapshot()).toMatchObject({ activeRuns: 1, moduleSessions: 0 })
  })

  it('reaps a Session that arrives after the Craft initialization deadline without starting its provider', async () => {
    const { core, sessions } = await setup({ maxCraftPreemptionMs: 20 })
    const enteredCreate = deferred()
    const releaseCreate = deferred()
    const createSession = sessions.createSession.bind(sessions)
    sessions.createSession = async (input) => {
      enteredCreate.resolve()
      await releaseCreate.promise
      return await createSession(input)
    }

    const creating = core.createRun({
      grantId: 'grant-1', idempotencyKey: 'late-init-craft-race', request: request(),
    })
    await enteredCreate.promise
    await expect(core.beginCraftTurn()).rejects.toMatchObject({ code: 'CLEANUP_FAILED' })
    releaseCreate.resolve()
    const run = await creating
    await flush()

    expect(sessions.prompts).toHaveLength(0)
    expect(sessions.reaped).toEqual(['session-1'])
    expect(core.getRun('grant-1', run.runHandle).state).toBe('closed')
    expect(core.debugSnapshot()).toMatchObject({ activeRuns: 0, moduleSessions: 0 })
  })

  it('starts the absolute Run deadline before Session initialization completes', async () => {
    const clock = new TestClock()
    const { core, sessions } = await setup({ clock, maxRunDurationMs: 100 })
    const enteredCreate = deferred()
    const releaseCreate = deferred()
    const createSession = sessions.createSession.bind(sessions)
    sessions.createSession = async (input) => {
      enteredCreate.resolve()
      await releaseCreate.promise
      return await createSession(input)
    }

    const creating = core.createRun({
      grantId: 'grant-1', idempotencyKey: 'accepted-deadline', request: request(),
    })
    await enteredCreate.promise
    clock.advance(100)
    releaseCreate.resolve()
    const run = await creating
    await flush()

    expect(core.getRun('grant-1', run.runHandle).state).toBe('closed')
    expect(sessions.prompts).toHaveLength(0)
    const events: HostAgentEvent[] = []
    core.subscribe('grant-1', run.runHandle, undefined, (event) => events.push(event))
    expect(events.filter((event) => event.type === 'turn.failed')).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ code: 'RUN_TIMEOUT' }) }),
    ])
    await core.closeRun('grant-1', run.runHandle)
    expect(sessions.reaped).toEqual(['session-1'])
  })

  it('bounds createRun when Session creation never settles and retains unknown ownership', async () => {
    const clock = new TestClock()
    const { core, sessions } = await setup({ clock, maxRunDurationMs: 100 })
    sessions.createSession = async () => await new Promise<never>(() => undefined)

    const creating = core.createRun({
      grantId: 'grant-1', idempotencyKey: 'permanent-create-hang', request: request(),
    })
    await flush()
    clock.advance(100)
    const run = await creating

    expect(run.state).toBe('failed')
    expect(sessions.prompts).toHaveLength(0)
    const transcript: HostAgentEvent[] = []
    core.subscribe('grant-1', run.runHandle, undefined, (event) => transcript.push(event))
    expect(transcript.map((event) => event.type)).toEqual(['run.accepted', 'turn.failed'])
    expect(transcript[1]).toMatchObject({ data: { code: 'RUN_TIMEOUT' } })
    expect(core.debugSnapshot()).toMatchObject({
      activeRuns: 0,
      retainedRuns: 1,
      moduleSessions: 0,
      cleanupDebtRuns: 1,
    })
    await expect(core.createRun({
      grantId: 'grant-1', idempotencyKey: 'permanent-create-hang', request: request(),
    })).resolves.toMatchObject({ runHandle: run.runHandle, state: 'failed' })
    await expect(core.closeRun('grant-1', run.runHandle)).rejects.toMatchObject({ code: 'CLEANUP_FAILED' })
    expect(core.getRun('grant-1', run.runHandle).state).toBe('closing')
    expect(clock.pendingTimers).toBe(0)
    clock.advance(10 * 60_000)
    await flush()
    expect(clock.pendingTimers).toBe(0)
  })

  it('strictly reaps a Session that resolves after createRun timed out without starting a provider', async () => {
    const clock = new TestClock()
    const { core, sessions } = await setup({ clock, maxRunDurationMs: 100 })
    const enteredCreate = deferred()
    const releaseCreate = deferred()
    const createSession = sessions.createSession.bind(sessions)
    sessions.createSession = async (input) => {
      enteredCreate.resolve()
      await releaseCreate.promise
      return await createSession(input)
    }

    const creating = core.createRun({
      grantId: 'grant-1', idempotencyKey: 'late-create-observer', request: request(),
    })
    await enteredCreate.promise
    clock.advance(100)
    const run = await creating
    expect(run.state).toBe('failed')
    expect(core.debugSnapshot().cleanupDebtRuns).toBe(1)
    const transcript: HostAgentEvent[] = []
    core.subscribe('grant-1', run.runHandle, undefined, (event) => transcript.push(event))
    expect(transcript.map((event) => event.type)).toEqual(['run.accepted', 'turn.failed'])

    releaseCreate.resolve()
    await flush()

    expect(sessions.prompts).toHaveLength(0)
    expect(sessions.reaped).toEqual(['session-1'])
    expect(transcript.filter((event) => event.type.startsWith('turn.') && event.type !== 'turn.started')).toHaveLength(1)
    expect(core.debugSnapshot()).toMatchObject({ moduleSessions: 0, cleanupDebtRuns: 0 })
    await expect(core.closeRun('grant-1', run.runHandle)).resolves.toMatchObject({ state: 'closed' })
    expect(sessions.reaped).toEqual(['session-1'])
  })

  it('bounds a permanently hung recovery and strictly reaps its late ownership result', async () => {
    const clock = new TestClock()
    const { core, sessions } = await setup({ clock, maxRunDurationMs: 100 })
    const enteredRecovery = deferred()
    const releaseRecovery = deferred<{
      sessionId: string
      workspaceId: string
      workspaceRoot: string
      workingDirectory: string
      hidden: true
    } | undefined>()
    sessions.createSession = async () => { throw new Error('create response lost') }
    sessions.recoverSession = async () => {
      enteredRecovery.resolve()
      return await releaseRecovery.promise
    }

    const creating = core.createRun({
      grantId: 'grant-1', idempotencyKey: 'permanent-recovery-hang', request: request(),
    })
    await enteredRecovery.promise
    clock.advance(100)
    const run = await creating
    expect(run.state).toBe('failed')
    expect(core.debugSnapshot().cleanupDebtRuns).toBe(1)

    releaseRecovery.resolve({
      sessionId: 'recovered-late-session',
      workspaceId: 'workspace-1',
      workspaceRoot: '/workspace',
      workingDirectory: '/projects/default',
      hidden: true,
    })
    await flush()

    expect(sessions.reaped).toEqual(['recovered-late-session'])
    expect(sessions.prompts).toHaveLength(0)
    expect(core.debugSnapshot()).toMatchObject({ moduleSessions: 0, cleanupDebtRuns: 0 })
  })

  it('serializes timeout, cancel, and disconnect into exactly one initialization terminal', async () => {
    const clock = new TestClock()
    const { core, sessions } = await setup({ clock, maxRunDurationMs: 100 })
    sessions.createSession = async () => await new Promise<never>(() => undefined)
    const runHandle = 'run_00000000000000000000000000000001'

    const creating = core.createRun({
      grantId: 'grant-1', idempotencyKey: 'initialization-terminal-race', request: request(),
    })
    await flush()
    const cancelling = core.cancelRun('grant-1', runHandle)
    const disconnecting = core.disconnectGrant('grant-1')
    void disconnecting.catch(() => undefined)
    clock.advance(100)
    await creating
    await cancelling
    await disconnecting.catch(() => undefined)
    await flush()

    const events: HostAgentEvent[] = []
    core.subscribe('grant-1', runHandle, undefined, (event) => events.push(event))
    const terminals = events.filter((event) => event.type === 'turn.completed'
      || event.type === 'turn.failed' || event.type === 'turn.interrupted')
    expect(events[0]?.type).toBe('run.accepted')
    expect(terminals).toHaveLength(1)
    expect(terminals[0]).toMatchObject({ type: 'turn.failed', data: { code: 'RUN_TIMEOUT' } })
    expect(sessions.prompts).toHaveLength(0)
  })

  it('fails at the absolute deadline when starting-state persistence never settles', async () => {
    const clock = new TestClock()
    const { core, sessions } = await setup({ clock, maxRunDurationMs: 100 })
    const enteredStarting = deferred()
    const updateRunState = sessions.updateRunState.bind(sessions)
    sessions.updateRunState = async (sessionId, state) => {
      if (state === 'starting') {
        enteredStarting.resolve()
        await new Promise<never>(() => undefined)
      }
      await updateRunState(sessionId, state)
    }

    const run = await core.createRun({
      grantId: 'grant-1', idempotencyKey: 'hung-starting-persistence', request: request(),
    })
    await enteredStarting.promise
    clock.advance(100)
    await flush()

    expect(core.getRun('grant-1', run.runHandle).state).toBe('failed')
    expect(sessions.prompts).toHaveLength(0)
    // The absolute Run timer is gone; the remaining timer is the required
    // terminal retention/strict-reap deadline for a client that omits DELETE.
    expect(clock.pendingTimers).toBe(1)
    await core.closeRun('grant-1', run.runHandle)
    expect(sessions.reaped).toEqual(['session-1'])
  })

  it('cancels a provider whose sendTurn acknowledgement hangs at the absolute deadline', async () => {
    const clock = new TestClock()
    const { core, sessions } = await setup({ clock, maxRunDurationMs: 100 })
    const enteredSend = deferred()
    sessions.sendTurn = async () => {
      enteredSend.resolve()
      await new Promise<never>(() => undefined)
    }

    const run = await core.createRun({
      grantId: 'grant-1', idempotencyKey: 'hung-send-turn', request: request(),
    })
    await enteredSend.promise
    clock.advance(100)
    await flush()

    expect(core.getRun('grant-1', run.runHandle).state).toBe('failed')
    expect(sessions.cancelled).toEqual(['session-1'])
    expect(clock.pendingTimers).toBe(1)
    await core.closeRun('grant-1', run.runHandle)
    expect(sessions.reaped).toEqual(['session-1'])
  })

  it('rechecks Craft priority after persisting starting and before provider invocation', async () => {
    const { core, sessions } = await setup()
    const enteredStarting = deferred()
    const releaseStarting = deferred()
    const updateRunState = sessions.updateRunState.bind(sessions)
    sessions.updateRunState = async (sessionId, state) => {
      if (state === 'starting') {
        enteredStarting.resolve()
        await releaseStarting.promise
      }
      await updateRunState(sessionId, state)
    }

    const run = await core.createRun({
      grantId: 'grant-1', idempotencyKey: 'starting-craft-race', request: request(),
    })
    await enteredStarting.promise
    const admittingCraft = core.beginCraftTurn()
    releaseStarting.resolve()
    await admittingCraft
    await flush()

    expect(sessions.prompts).toHaveLength(0)
    expect(sessions.reaped).toEqual(['session-1'])
    expect(core.getRun('grant-1', run.runHandle).state).toBe('closed')
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

  it('fails and closes when accepted to starting persistence fails', async () => {
    const { core, sessions } = await setup()
    sessions.updateError = new Error('disk unavailable')
    const run = await core.createRun({
      grantId: 'grant-1', idempotencyKey: 'starting-persist-failure', request: request(),
    })
    const events: HostAgentEvent[] = []
    core.subscribe('grant-1', run.runHandle, undefined, (event) => events.push(event))
    await flush()
    expect(core.getRun('grant-1', run.runHandle).state).toBe('closed')
    expect(events.map((event) => event.type)).toEqual(['run.accepted', 'turn.failed', 'run.closed'])
    expect(sessions.prompts).toHaveLength(0)
    expect(sessions.reaped).toEqual(['session-1'])
    expect(core.debugSnapshot()).toMatchObject({ activeRuns: 0, moduleSessions: 0 })
  })

  it('fails and closes when starting to running persistence fails after provider admission', async () => {
    const { core, sessions } = await setup()
    const updateRunState = sessions.updateRunState.bind(sessions)
    sessions.updateRunState = async (sessionId, state) => {
      if (state === 'running') throw new Error('running header unavailable')
      await updateRunState(sessionId, state)
    }
    const run = await core.createRun({
      grantId: 'grant-1', idempotencyKey: 'running-persist-failure', request: request(),
    })
    const events: HostAgentEvent[] = []
    core.subscribe('grant-1', run.runHandle, undefined, (event) => events.push(event))
    await flush()
    expect(core.getRun('grant-1', run.runHandle).state).toBe('closed')
    expect(events.map((event) => event.type)).toEqual(['run.accepted', 'turn.failed', 'run.closed'])
    expect(sessions.prompts).toHaveLength(1)
    expect(sessions.reaped).toEqual(['session-1'])
  })

  it('does not strand running when terminal persistence fails', async () => {
    const { core, sessions } = await setup()
    const run = await core.createRun({
      grantId: 'grant-1', idempotencyKey: 'terminal-persist-failure', request: request(),
    })
    const events: HostAgentEvent[] = []
    core.subscribe('grant-1', run.runHandle, undefined, (event) => events.push(event))
    await flush()
    sessions.updateError = new Error('terminal header unavailable')
    sessions.emit('session-1', { type: 'turn.completed', finalText: 'must not escape as success' })
    await flush()
    expect(core.getRun('grant-1', run.runHandle).state).toBe('closed')
    expect(events.filter((event) => event.type === 'turn.completed')).toHaveLength(0)
    expect(events.filter((event) => event.type === 'turn.failed')).toHaveLength(1)
    expect(events.at(-1)?.type).toBe('run.closed')
    expect(core.debugSnapshot()).toMatchObject({ activeRuns: 0, moduleSessions: 0 })
  })

  it('bounds a permanently hung terminal write and publishes only one local failure', async () => {
    const clock = new TestClock()
    const { core, sessions } = await setup({
      clock,
      maxRunDurationMs: 1_000,
      maxCraftPreemptionMs: 20,
    })
    const enteredTerminalWrite = deferred()
    const updateRunState = sessions.updateRunState.bind(sessions)
    sessions.updateRunState = async (sessionId, state) => {
      if (state === 'completed') {
        enteredTerminalWrite.resolve()
        await new Promise<never>(() => undefined)
      }
      await updateRunState(sessionId, state)
    }
    const run = await core.createRun({
      grantId: 'grant-1', idempotencyKey: 'hung-terminal-write', request: request(),
    })
    const events: HostAgentEvent[] = []
    core.subscribe('grant-1', run.runHandle, undefined, (event) => events.push(event))
    await flush()

    sessions.emit('session-1', { type: 'turn.completed', finalText: 'must not publish' })
    await enteredTerminalWrite.promise
    clock.advance(20)
    await flush()

    expect(core.getRun('grant-1', run.runHandle).state).toBe('closed')
    expect(sessions.cancelled).toEqual(['session-1'])
    expect(sessions.reaped).toEqual(['session-1'])
    expect(events.filter((event) => event.type === 'turn.completed')).toHaveLength(0)
    expect(events.filter((event) => event.type === 'turn.failed')).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ code: 'INTERNAL_ERROR' }) }),
    ])
    expect(events.at(-1)?.type).toBe('run.closed')
  })

  it('treats late terminal persistence as reconciliation and lets simultaneous cancel observe the winner', async () => {
    const clock = new TestClock()
    const { core, sessions } = await setup({
      clock,
      maxRunDurationMs: 1_000,
      maxCraftPreemptionMs: 20,
    })
    const enteredTerminalWrite = deferred()
    const releaseTerminalWrite = deferred()
    const updateRunState = sessions.updateRunState.bind(sessions)
    sessions.updateRunState = async (sessionId, state) => {
      if (state === 'completed') {
        enteredTerminalWrite.resolve()
        await releaseTerminalWrite.promise
        return
      }
      await updateRunState(sessionId, state)
    }
    const run = await core.createRun({
      grantId: 'grant-1', idempotencyKey: 'late-terminal-write', request: request(),
    })
    const events: HostAgentEvent[] = []
    core.subscribe('grant-1', run.runHandle, undefined, (event) => events.push(event))
    await flush()

    sessions.emit('session-1', { type: 'turn.completed', finalText: 'must not publish late' })
    await enteredTerminalWrite.promise
    const cancelling = core.cancelRun('grant-1', run.runHandle)
    clock.advance(20)
    await cancelling
    await flush()

    expect(core.getRun('grant-1', run.runHandle).state).toBe('closed')
    expect(events.filter((event) => event.type === 'turn.failed')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'turn.completed')).toHaveLength(0)
    expect(events.filter((event) => event.type === 'turn.interrupted')).toHaveLength(0)

    releaseTerminalWrite.resolve()
    await flush()
    expect(core.getRun('grant-1', run.runHandle).state).toBe('closed')
    expect(events.filter((event) => event.type === 'turn.failed')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'turn.completed')).toHaveLength(0)
  })

  it('retains closing cleanup debt when terminal persistence recovery cannot reap', async () => {
    const clock = new TestClock()
    const { core, sessions } = await setup({
      clock,
      maxRunDurationMs: 1_000,
      maxCraftPreemptionMs: 20,
    })
    const enteredTerminalWrite = deferred()
    const releaseTerminalWrite = deferred()
    const updateRunState = sessions.updateRunState.bind(sessions)
    sessions.updateRunState = async (sessionId, state) => {
      if (state === 'completed') {
        enteredTerminalWrite.resolve()
        await releaseTerminalWrite.promise
        return
      }
      await updateRunState(sessionId, state)
    }
    const run = await core.createRun({
      grantId: 'grant-1', idempotencyKey: 'terminal-write-reap-failure', request: request(),
    })
    const events: HostAgentEvent[] = []
    core.subscribe('grant-1', run.runHandle, undefined, (event) => events.push(event))
    await flush()
    sessions.reapError = new Error('provider child still alive')

    sessions.emit('session-1', { type: 'turn.completed', finalText: 'must fail locally' })
    await enteredTerminalWrite.promise
    clock.advance(20)
    await flush()

    expect(core.getRun('grant-1', run.runHandle).state).toBe('closing')
    expect(core.debugSnapshot()).toMatchObject({ moduleSessions: 1, cleanupDebtRuns: 1 })
    expect(events.filter((event) => event.type === 'turn.completed')).toHaveLength(0)
    expect(events.filter((event) => event.type === 'turn.failed')).toHaveLength(1)
    await expect(core.createRun({
      grantId: 'grant-1', idempotencyKey: 'blocked-by-terminal-debt', request: request('next'),
    })).rejects.toMatchObject({ code: 'CLEANUP_FAILED' })

    releaseTerminalWrite.resolve()
    await flush()
    expect(core.getRun('grant-1', run.runHandle).state).toBe('closing')
    expect(events.filter((event) => event.type === 'turn.failed')).toHaveLength(1)

    sessions.reapError = undefined
    await expect(core.closeRun('grant-1', run.runHandle)).resolves.toMatchObject({ state: 'closed' })
    expect(core.debugSnapshot()).toMatchObject({ moduleSessions: 0, cleanupDebtRuns: 0 })
  })

  it('bounds a strict reap that never settles after terminal persistence timeout', async () => {
    const clock = new TestClock()
    const { core, sessions } = await setup({
      clock,
      maxRunDurationMs: 1_000,
      maxCraftPreemptionMs: 20,
    })
    const enteredTerminalWrite = deferred()
    const enteredReap = deferred()
    const updateRunState = sessions.updateRunState.bind(sessions)
    sessions.updateRunState = async (sessionId, state) => {
      if (state === 'completed') {
        enteredTerminalWrite.resolve()
        await new Promise<never>(() => undefined)
      }
      await updateRunState(sessionId, state)
    }
    sessions.disposeAndReap = async () => {
      enteredReap.resolve()
      await new Promise<never>(() => undefined)
    }
    const run = await core.createRun({
      grantId: 'grant-1', idempotencyKey: 'terminal-write-reap-timeout', request: request(),
    })
    const events: HostAgentEvent[] = []
    core.subscribe('grant-1', run.runHandle, undefined, (event) => events.push(event))
    await flush()

    sessions.emit('session-1', { type: 'turn.completed', finalText: 'must fail locally' })
    await enteredTerminalWrite.promise
    clock.advance(20)
    await enteredReap.promise
    clock.advance(20)
    await flush()

    expect(core.getRun('grant-1', run.runHandle).state).toBe('closing')
    expect(core.debugSnapshot()).toMatchObject({ moduleSessions: 1, cleanupDebtRuns: 1 })
    expect(events.filter((event) => event.type === 'turn.failed')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'turn.completed')).toHaveLength(0)
  })

  it('closes and timer-purges a failed Run when its timed-out strict reap later succeeds', async () => {
    const clock = new TestClock()
    const { core, sessions } = await setup({
      clock,
      maxRunDurationMs: 1_000,
      maxCraftPreemptionMs: 20,
      tombstoneMinRetentionMs: 50,
      grantTtlMs: 100,
    })
    const enteredReap = deferred()
    const releaseReap = deferred()
    const updateRunState = sessions.updateRunState.bind(sessions)
    const disposeAndReap = sessions.disposeAndReap.bind(sessions)
    let reapCalls = 0
    sessions.updateRunState = async (sessionId, state) => {
      if (state === 'completed') throw new Error('terminal header unavailable')
      await updateRunState(sessionId, state)
    }
    sessions.disposeAndReap = async (sessionId) => {
      reapCalls += 1
      enteredReap.resolve()
      await releaseReap.promise
      await disposeAndReap(sessionId)
    }
    const run = await core.createRun({
      grantId: 'grant-1', idempotencyKey: 'late-terminal-reap-purge', request: request(),
    })
    const events: HostAgentEvent[] = []
    core.subscribe('grant-1', run.runHandle, undefined, (event) => events.push(event))
    await flush()

    sessions.emit('session-1', { type: 'turn.completed', finalText: 'must fail locally' })
    await enteredReap.promise
    clock.advance(20)
    await flush()
    expect(core.getRun('grant-1', run.runHandle).state).toBe('closing')
    expect(events.filter((event) => event.type === 'turn.failed')).toHaveLength(1)

    releaseReap.resolve()
    await flush()
    expect(events.filter((event) => event.type === 'run.closed')).toHaveLength(1)
    expect(events.filter((event) => event.type.startsWith('turn.') && event.type !== 'turn.started'))
      .toHaveLength(1)
    expect(reapCalls).toBe(1)
    expect(clock.pendingTimers).toBeGreaterThan(0)

    // No polling/DELETE/debug call is required after the late observer closes
    // the Run. Its own retention timer purges replay, listeners and ownership.
    clock.advance(80)
    await flush()
    expect(core.debugSnapshot()).toMatchObject({
      retainedRuns: 0,
      retainedReplayBytes: 0,
      cleanupDebtRuns: 0,
      moduleSessions: 0,
      subscribers: 0,
    })
    expect(() => core.getRun('grant-1', run.runHandle)).toThrow(
      expect.objectContaining({ code: 'RUN_NOT_FOUND' }),
    )
  })

  it('shares one pending strict reap across Craft admission and concurrent DELETE calls', async () => {
    const clock = new TestClock()
    const { core, sessions } = await setup({
      clock,
      maxRunDurationMs: 1_000,
      maxCraftPreemptionMs: 20,
    })
    const rawReap = deferred()
    const enteredReap = deferred()
    let reapCalls = 0
    const updateRunState = sessions.updateRunState.bind(sessions)
    sessions.updateRunState = async (sessionId, state) => {
      if (state === 'completed') throw new Error('terminal header unavailable')
      await updateRunState(sessionId, state)
    }
    sessions.disposeAndReap = async () => {
      reapCalls += 1
      enteredReap.resolve()
      await rawReap.promise
    }
    const run = await core.createRun({
      grantId: 'grant-1', idempotencyKey: 'single-flight-pending-reap', request: request(),
    })
    const events: HostAgentEvent[] = []
    core.subscribe('grant-1', run.runHandle, undefined, (event) => events.push(event))
    await flush()
    sessions.emit('session-1', { type: 'turn.completed', finalText: 'must fail locally' })
    await enteredReap.promise
    clock.advance(20)
    await flush()
    expect(core.getRun('grant-1', run.runHandle).state).toBe('closing')
    expect(reapCalls).toBe(1)

    const admittingCraft = core.beginCraftTurn()
    const firstDelete = core.closeRun('grant-1', run.runHandle)
    const secondDelete = core.closeRun('grant-1', run.runHandle)
    void admittingCraft.catch(() => undefined)
    void firstDelete.catch(() => undefined)
    void secondDelete.catch(() => undefined)
    await flush()
    expect(reapCalls).toBe(1)
    clock.advance(20)
    await expect(admittingCraft).rejects.toMatchObject({ code: 'CLEANUP_FAILED' })
    await expect(firstDelete).rejects.toMatchObject({ code: 'CLEANUP_FAILED' })
    await expect(secondDelete).rejects.toMatchObject({ code: 'CLEANUP_FAILED' })
    expect(reapCalls).toBe(1)
    expect(clock.pendingTimers).toBe(0)
    core.endCraftTurn()

    rawReap.resolve()
    await flush()
    expect(core.getRun('grant-1', run.runHandle).state).toBe('closed')
    expect(events.filter((event) => event.type === 'turn.failed')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'run.closed')).toHaveLength(1)
    expect(reapCalls).toBe(1)
    await expect(core.beginCraftTurn()).resolves.toBeUndefined()
    core.endCraftTurn()
  })

  it('fences Craft on every closing Session even before a cleanup-debt timeout is recorded', async () => {
    const clock = new TestClock()
    const { core, sessions } = await setup({
      clock,
      maxRunDurationMs: 1_000,
      maxCraftPreemptionMs: 20,
    })
    const run = await core.createRun({
      grantId: 'grant-1', idempotencyKey: 'closing-pending-before-debt', request: request(),
    })
    await flush()
    sessions.emit('session-1', { type: 'turn.completed', finalText: 'done' })
    await flush()

    const enteredReap = deferred()
    const releaseReap = deferred()
    const disposeAndReap = sessions.disposeAndReap.bind(sessions)
    let reapCalls = 0
    sessions.disposeAndReap = async (sessionId) => {
      reapCalls += 1
      enteredReap.resolve()
      await releaseReap.promise
      await disposeAndReap(sessionId)
    }

    const closing = core.closeRun('grant-1', run.runHandle)
    void closing.catch(() => undefined)
    await enteredReap.promise
    // The raw reap is pending but its bounded waiter has not timed out yet, so
    // no cleanupDebt field has been needed to make this Session unsafe.
    expect(core.getRun('grant-1', run.runHandle).state).toBe('closing')
    expect(reapCalls).toBe(1)

    const admittingCraft = core.beginCraftTurn()
    void admittingCraft.catch(() => undefined)
    clock.advance(20)
    await expect(admittingCraft).rejects.toMatchObject({ code: 'CLEANUP_FAILED' })
    await expect(closing).rejects.toMatchObject({ code: 'CLEANUP_FAILED' })
    expect(reapCalls).toBe(1)

    releaseReap.resolve()
    await flush()
    expect(core.getRun('grant-1', run.runHandle).state).toBe('closed')
    expect(sessions.reaped).toEqual(['session-1'])
    expect(reapCalls).toBe(1)
    core.endCraftTurn()
  })

  it('allows exactly one explicit DELETE retry after the raw strict reap rejects', async () => {
    const clock = new TestClock()
    const { core, sessions } = await setup({
      clock,
      maxRunDurationMs: 1_000,
      maxCraftPreemptionMs: 20,
    })
    const firstReap = deferred()
    const secondReap = deferred()
    const enteredFirst = deferred()
    const enteredSecond = deferred()
    let reapCalls = 0
    const updateRunState = sessions.updateRunState.bind(sessions)
    sessions.updateRunState = async (sessionId, state) => {
      if (state === 'completed') throw new Error('terminal header unavailable')
      await updateRunState(sessionId, state)
    }
    sessions.disposeAndReap = async () => {
      reapCalls += 1
      if (reapCalls === 1) {
        enteredFirst.resolve()
        await firstReap.promise
        return
      }
      enteredSecond.resolve()
      await secondReap.promise
    }
    const run = await core.createRun({
      grantId: 'grant-1', idempotencyKey: 'single-flight-explicit-retry', request: request(),
    })
    await flush()
    sessions.emit('session-1', { type: 'turn.completed', finalText: 'must fail locally' })
    await enteredFirst.promise
    firstReap.reject(new Error('provider tree still alive'))
    await flush()

    expect(core.getRun('grant-1', run.runHandle).state).toBe('closing')
    expect(core.debugSnapshot()).toMatchObject({ moduleSessions: 1, cleanupDebtRuns: 1 })
    expect(reapCalls).toBe(1)
    await expect(core.shutdown()).rejects.toMatchObject({ code: 'CLEANUP_FAILED' })
    expect(reapCalls).toBe(1)
    expect(clock.pendingTimers).toBe(0)
    clock.advance(10_000)
    await flush()
    expect(reapCalls).toBe(1)
    expect(clock.pendingTimers).toBe(0)

    const firstDelete = core.closeRun('grant-1', run.runHandle)
    const secondDelete = core.closeRun('grant-1', run.runHandle)
    await enteredSecond.promise
    expect(reapCalls).toBe(2)
    secondReap.resolve()
    await expect(firstDelete).resolves.toMatchObject({ state: 'closed' })
    await expect(secondDelete).resolves.toMatchObject({ state: 'closed' })
    expect(reapCalls).toBe(2)
    expect(core.debugSnapshot()).toMatchObject({ moduleSessions: 0, cleanupDebtRuns: 0 })
  })

  it('bounds closing-state persistence before joining the single strict cleanup attempt', async () => {
    const clock = new TestClock()
    const { core, sessions } = await setup({
      clock,
      maxRunDurationMs: 1_000,
      maxCraftPreemptionMs: 20,
    })
    const run = await core.createRun({
      grantId: 'grant-1', idempotencyKey: 'bounded-closing-persistence', request: request(),
    })
    await flush()
    sessions.emit('session-1', { type: 'turn.completed', finalText: 'done' })
    await flush()
    expect(core.getRun('grant-1', run.runHandle).state).toBe('completed')

    const enteredClosingWrite = deferred()
    let reapCalls = 0
    const updateRunState = sessions.updateRunState.bind(sessions)
    const disposeAndReap = sessions.disposeAndReap.bind(sessions)
    sessions.updateRunState = async (sessionId, state) => {
      if (state === 'closing') {
        enteredClosingWrite.resolve()
        await new Promise<never>(() => undefined)
      }
      await updateRunState(sessionId, state)
    }
    sessions.disposeAndReap = async (sessionId) => {
      reapCalls += 1
      await disposeAndReap(sessionId)
    }

    const closing = core.closeRun('grant-1', run.runHandle)
    await enteredClosingWrite.promise
    clock.advance(20)
    await expect(closing).resolves.toMatchObject({ state: 'closed' })
    expect(reapCalls).toBe(1)
    expect(sessions.reaped).toEqual(['session-1'])
  })

  it('fences Craft while an existing close waits on its closing header and joins its single reap', async () => {
    const clock = new TestClock()
    const { core, sessions } = await setup({
      clock,
      maxRunDurationMs: 1_000,
      maxCraftPreemptionMs: 20,
    })
    const run = await core.createRun({
      grantId: 'grant-1', idempotencyKey: 'craft-during-pending-closing-header', request: request(),
    })
    await flush()

    const enteredClosingWrite = deferred()
    const releaseClosingWrite = deferred()
    const updateRunState = sessions.updateRunState.bind(sessions)
    const disposeAndReap = sessions.disposeAndReap.bind(sessions)
    let reapCalls = 0
    sessions.awaitStoppedError = new Error('provider did not acknowledge stop')
    sessions.updateRunState = async (sessionId, state) => {
      if (state === 'closing') {
        enteredClosingWrite.resolve()
        await releaseClosingWrite.promise
      }
      await updateRunState(sessionId, state)
    }
    sessions.disposeAndReap = async (sessionId) => {
      reapCalls += 1
      await disposeAndReap(sessionId)
    }

    const closing = core.closeRun('grant-1', run.runHandle)
    void closing.catch(() => undefined)
    await enteredClosingWrite.promise
    expect(core.getRun('grant-1', run.runHandle).state).toBe('interrupted')
    expect(core.debugSnapshot()).toMatchObject({ moduleSessions: 1 })
    expect(sessions.reaped).toHaveLength(0)

    let craftSettled = false
    const admittingCraft = core.beginCraftTurn().finally(() => { craftSettled = true })
    void admittingCraft.catch(() => undefined)
    await flush()
    expect(craftSettled).toBe(false)
    expect(reapCalls).toBe(0)

    releaseClosingWrite.resolve()
    await expect(closing).resolves.toMatchObject({ state: 'closed' })
    await expect(admittingCraft).resolves.toBeUndefined()
    expect(reapCalls).toBe(1)
    expect(sessions.reaped).toEqual(['session-1'])
    expect(core.debugSnapshot()).toMatchObject({ activeRuns: 0, moduleSessions: 0 })
    core.endCraftTurn()
  })

  it('bounds Craft when an in-flight closing header hangs and leaves the existing close tail reapable', async () => {
    const clock = new TestClock()
    const { core, sessions } = await setup({
      clock,
      maxRunDurationMs: 1_000,
      maxCraftPreemptionMs: 20,
    })
    const run = await core.createRun({
      grantId: 'grant-1', idempotencyKey: 'craft-during-hung-closing-header', request: request(),
    })
    await flush()

    const enteredClosingWrite = deferred()
    const updateRunState = sessions.updateRunState.bind(sessions)
    const disposeAndReap = sessions.disposeAndReap.bind(sessions)
    let reapCalls = 0
    sessions.awaitStoppedError = new Error('provider did not acknowledge stop')
    sessions.updateRunState = async (sessionId, state) => {
      if (state === 'closing') {
        enteredClosingWrite.resolve()
        await new Promise<never>(() => undefined)
      }
      await updateRunState(sessionId, state)
    }
    sessions.disposeAndReap = async (sessionId) => {
      reapCalls += 1
      await disposeAndReap(sessionId)
    }

    const closing = core.closeRun('grant-1', run.runHandle)
    void closing.catch(() => undefined)
    await enteredClosingWrite.promise
    const admittingCraft = core.beginCraftTurn()
    void admittingCraft.catch(() => undefined)

    clock.advance(20)
    await expect(admittingCraft).rejects.toMatchObject({ code: 'CLEANUP_FAILED' })
    await expect(closing).resolves.toMatchObject({ state: 'closed' })
    expect(reapCalls).toBe(1)
    expect(sessions.reaped).toEqual(['session-1'])
    expect(core.debugSnapshot()).toMatchObject({ activeRuns: 0, moduleSessions: 0 })

    core.endCraftTurn()
    await expect(core.beginCraftTurn()).resolves.toBeUndefined()
    core.endCraftTurn()
  })

  it('prevalidates an oversized provider finalText and emits one legal completion terminal', async () => {
    const { core, sessions } = await setup()
    const run = await core.createRun({
      grantId: 'grant-1', idempotencyKey: 'oversized-terminal', request: request(),
    })
    const events: HostAgentEvent[] = []
    core.subscribe('grant-1', run.runHandle, undefined, (event) => events.push(event))
    await flush()

    sessions.emit('session-1', { type: 'turn.completed', finalText: 'x'.repeat(300 * 1024) })
    await flush()

    expect(core.getRun('grant-1', run.runHandle).state).toBe('completed')
    const terminal = events.filter((event) => event.type.startsWith('turn.') && event.type !== 'turn.started')
    expect(terminal).toEqual([expect.objectContaining({ type: 'turn.completed', data: {} })])
    await expect(core.closeRun('grant-1', run.runHandle)).resolves.toMatchObject({ state: 'closed' })
    expect(core.debugSnapshot()).toMatchObject({ activeRuns: 0, moduleSessions: 0 })
  })

  it('drops a legal finalText that exceeds the configured replay capacity before persistence', async () => {
    const { core, sessions } = await setup({ maxReplayBytes: 128 * 1024 })
    const run = await core.createRun({
      grantId: 'grant-1', idempotencyKey: 'replay-capacity-terminal', request: request(),
    })
    const events: HostAgentEvent[] = []
    core.subscribe('grant-1', run.runHandle, undefined, (event) => events.push(event))
    await flush()

    sessions.emit('session-1', { type: 'turn.completed', finalText: 'x'.repeat(200 * 1024) })
    await flush()

    expect(core.getRun('grant-1', run.runHandle).state).toBe('completed')
    expect(events.filter((event) => event.type === 'turn.completed')).toEqual([
      expect.objectContaining({ data: {} }),
    ])
    expect(sessions.states.at(-1)).toEqual({ sessionId: 'session-1', state: 'completed' })
  })

  it('fails and reaps instead of stranding a Run on an oversized nonterminal provider event', async () => {
    const { core, sessions } = await setup()
    const run = await core.createRun({
      grantId: 'grant-1', idempotencyKey: 'oversized-delta', request: request(),
    })
    const events: HostAgentEvent[] = []
    core.subscribe('grant-1', run.runHandle, undefined, (event) => events.push(event))
    await flush()

    sessions.emit('session-1', { type: 'message.delta', delta: 'x'.repeat(65 * 1024) })
    await flush()

    expect(core.getRun('grant-1', run.runHandle).state).toBe('closed')
    expect(events.filter((event) => event.type === 'turn.failed')).toHaveLength(1)
    expect(events.at(-1)?.type).toBe('run.closed')
    expect(sessions.reaped).toEqual(['session-1'])
  })

  it('preserves the sequence slot when a legal delta exceeds the configured replay budget', async () => {
    const { core, sessions } = await setup({ maxReplayBytes: 32 * 1024 })
    const run = await core.createRun({
      grantId: 'grant-1', idempotencyKey: 'legal-delta-over-replay-budget', request: request(),
    })
    const events: HostAgentEvent[] = []
    core.subscribe('grant-1', run.runHandle, undefined, (event) => events.push(event))
    await flush()

    // message.delta permits 64 KiB, while this Run intentionally retains only
    // 32 KiB of replay. Rejection must not consume sequence 3, because the
    // recovery terminal and run.closed still need contiguous event IDs.
    sessions.emit('session-1', { type: 'message.delta', delta: 'x'.repeat(40 * 1024) })
    await flush()

    expect(core.getRun('grant-1', run.runHandle).state).toBe('closed')
    expect(events.map((event) => event.type)).toEqual([
      'run.accepted',
      'turn.started',
      'turn.failed',
      'run.closed',
    ])
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4])
    expect(events.map((event) => event.eventId)).toEqual(['1', '2', '3', '4'])
    expect(events.filter((event) => event.type.startsWith('turn.') && event.type !== 'turn.started'))
      .toHaveLength(1)
    expect(sessions.reaped).toEqual(['session-1'])
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

  it('bounds all closed replay payloads while retaining tombstone idempotency', async () => {
    const retainedBudget = 70 * 1024
    const { core, sessions } = await setup({
      maxReplayBytes: 128 * 1024,
      maxRetainedTerminalReplayBytes: retainedBudget,
    })

    const complete = async (key: string, prompt: string) => {
      const run = await core.createRun({ grantId: 'grant-1', idempotencyKey: key, request: request(prompt) })
      await flush()
      const sessionId = `session-${sessions.created.length}`
      sessions.emit(sessionId, { type: 'message.delta', delta: 'x'.repeat(48 * 1024) })
      sessions.emit(sessionId, { type: 'turn.completed' })
      await flush()
      await core.closeRun('grant-1', run.runHandle)
      return run
    }

    const firstPrompt = 'first '.repeat(32 * 1024)
    const first = await complete('retained-first', firstPrompt)
    const second = await complete('retained-second', 'second')
    const snapshot = core.debugSnapshot()

    expect(snapshot).toMatchObject({
      retainedRuns: 2,
      replayUnavailableRuns: 1,
      retainedRequestPayloads: 0,
    })
    expect(snapshot.retainedTerminalReplayBytes).toBeLessThanOrEqual(retainedBudget)
    expect(snapshot.retainedReplayBytes).toBe(snapshot.retainedTerminalReplayBytes)
    expect(core.getRun('grant-1', first.runHandle).state).toBe('closed')
    expect(core.getRun('grant-1', second.runHandle).state).toBe('closed')
    await expect(core.createRun({
      grantId: 'grant-1', idempotencyKey: 'retained-first', request: request(firstPrompt),
    })).resolves.toMatchObject({ runHandle: first.runHandle, state: 'closed' })
    expect(sessions.created).toHaveLength(2)
    expect(() => core.subscribe('grant-1', first.runHandle, undefined, () => undefined))
      .toThrow(expect.objectContaining({ code: 'REPLAY_UNAVAILABLE' }))
    const secondReplay = core.subscribe('grant-1', second.runHandle, undefined, () => undefined)
    expect(secondReplay.replayed).toBeGreaterThan(0)
    secondReplay.unsubscribe()
  })

  it('bounds terminal replay and prompt payloads even when a client never sends DELETE', async () => {
    const retainedBudget = 16 * 1024
    const { core, sessions } = await setup({
      maxReplayBytes: 128 * 1024,
      maxRetainedTerminalReplayBytes: retainedBudget,
    })

    const firstPrompt = 'retained without delete '.repeat(48 * 1024)
    const first = await core.createRun({
      grantId: 'grant-1', idempotencyKey: 'terminal-first', request: request(firstPrompt),
    })
    await flush()
    sessions.emit('session-1', { type: 'message.delta', delta: 'x'.repeat(48 * 1024) })
    sessions.emit('session-1', { type: 'turn.completed' })
    await flush()
    const snapshot = core.debugSnapshot()

    expect(snapshot).toMatchObject({
      activeRuns: 0,
      retainedRuns: 1,
      retainedRequestPayloads: 0,
      replayUnavailableRuns: 1,
    })
    expect(snapshot.retainedTerminalReplayBytes).toBeLessThanOrEqual(retainedBudget)
    expect(core.getRun('grant-1', first.runHandle).state).toBe('completed')
    await expect(core.createRun({
      grantId: 'grant-1', idempotencyKey: 'terminal-first', request: request(firstPrompt),
    })).resolves.toMatchObject({ runHandle: first.runHandle, state: 'completed' })
    expect(sessions.created).toHaveLength(1)
    expect(() => core.subscribe('grant-1', first.runHandle, undefined, () => undefined))
      .toThrow(expect.objectContaining({ code: 'REPLAY_UNAVAILABLE' }))
  })

  it('keeps terminal and run.closed live delivery after historical replay is discarded', async () => {
    const { core, sessions } = await setup({
      maxReplayBytes: 128 * 1024,
      maxRetainedTerminalReplayBytes: 1,
    })
    const run = await core.createRun({
      grantId: 'grant-1', idempotencyKey: 'discard-live-terminal', request: request(),
    })
    const live: HostAgentEvent[] = []
    core.subscribe('grant-1', run.runHandle, undefined, (event) => live.push(event))
    await flush()

    sessions.emit('session-1', { type: 'message.delta', delta: 'before discard' })
    sessions.emit('session-1', { type: 'turn.completed', finalText: 'done' })
    await flush()

    expect(core.getRun('grant-1', run.runHandle).state).toBe('completed')
    expect(live.filter((event) => event.type === 'turn.completed')).toHaveLength(1)
    expect(core.debugSnapshot()).toMatchObject({ replayUnavailableRuns: 1, retainedReplayBytes: 0 })
    expect(() => core.subscribe('grant-1', run.runHandle, undefined, () => undefined))
      .toThrow(expect.objectContaining({ code: 'REPLAY_UNAVAILABLE' }))

    await expect(core.closeRun('grant-1', run.runHandle)).resolves.toMatchObject({ state: 'closed' })
    expect(live.filter((event) => event.type === 'run.closed')).toHaveLength(1)
    expect(live.map((event) => event.sequence)).toEqual(
      [...live.map((event) => event.sequence)].sort((left, right) => left - right),
    )
  })

  it('purges expired tombstones on the retention timer', async () => {
    const clock = new TestClock()
    const { core } = await setup({
      clock,
      grantTtlMs: 100,
      tombstoneMinRetentionMs: 50,
    })
    const run = await core.createRun({ grantId: 'grant-1', idempotencyKey: 'timer-purge', request: request() })
    await flush()
    await core.closeRun('grant-1', run.runHandle)
    expect(core.debugSnapshot().retainedRuns).toBe(1)

    clock.advance(99)
    expect(core.debugSnapshot().retainedRuns).toBe(1)
    clock.advance(1)
    expect(core.debugSnapshot().retainedRuns).toBe(0)
    expect(() => core.getRun('grant-1', run.runHandle)).toThrow(expect.objectContaining({ code: 'RUN_NOT_FOUND' }))
  })

  it('strictly reaps and purges an expired terminal Run when the client omits DELETE', async () => {
    const clock = new TestClock()
    const { core, sessions } = await setup({
      clock,
      grantTtlMs: 100,
      tombstoneMinRetentionMs: 50,
    })
    const run = await core.createRun({
      grantId: 'grant-1', idempotencyKey: 'terminal-expiry-reap', request: request(),
    })
    const live: HostAgentEvent[] = []
    core.subscribe('grant-1', run.runHandle, undefined, (event) => live.push(event))
    await flush()
    sessions.emit('session-1', { type: 'turn.completed', finalText: 'done' })
    await flush()
    expect(core.getRun('grant-1', run.runHandle).state).toBe('completed')

    clock.advance(100)
    await flush()

    expect(sessions.reaped).toEqual(['session-1'])
    expect(live.filter((event) => event.type === 'run.closed')).toHaveLength(1)
    expect(core.debugSnapshot()).toMatchObject({ retainedRuns: 0, moduleSessions: 0, cleanupDebtRuns: 0 })
    expect(() => core.getRun('grant-1', run.runHandle)).toThrow(expect.objectContaining({ code: 'RUN_NOT_FOUND' }))
  })

  it('retains discoverable cleanup debt when terminal expiry cannot reap the Session', async () => {
    const clock = new TestClock()
    const { core, sessions } = await setup({
      clock,
      grantTtlMs: 100,
      tombstoneMinRetentionMs: 50,
      maxCraftPreemptionMs: 10,
    })
    const run = await core.createRun({
      grantId: 'grant-1', idempotencyKey: 'terminal-expiry-debt', request: request(),
    })
    await flush()
    sessions.emit('session-1', { type: 'turn.completed', finalText: 'done' })
    await flush()
    sessions.reapError = new Error('provider child still alive')

    clock.advance(100)
    await flush()

    expect(core.getRun('grant-1', run.runHandle).state).toBe('closing')
    expect(core.debugSnapshot()).toMatchObject({
      retainedRuns: 1,
      moduleSessions: 1,
      cleanupDebtRuns: 1,
    })
    expect(clock.pendingTimers).toBe(0)
    clock.advance(10_000)
    await flush()
    expect(clock.pendingTimers).toBe(0)

    sessions.reapError = undefined
    await expect(core.closeRun('grant-1', run.runHandle)).resolves.toMatchObject({ state: 'closed' })
    expect(sessions.reaped).toEqual(['session-1'])
    expect(core.debugSnapshot()).toMatchObject({ retainedRuns: 0, moduleSessions: 0, cleanupDebtRuns: 0 })
  })

  it('purges expired tombstones at the next public operation if a timer did not run', async () => {
    const clock = new TestClock()
    const { core } = await setup({
      clock,
      grantTtlMs: 100,
      tombstoneMinRetentionMs: 50,
    })
    const run = await core.createRun({ grantId: 'grant-1', idempotencyKey: 'operation-purge', request: request() })
    await flush()
    await core.closeRun('grant-1', run.runHandle)
    clock.setNow(clock.now() + 100)

    expect(() => core.getRun('grant-1', run.runHandle)).toThrow(expect.objectContaining({ code: 'RUN_NOT_FOUND' }))
    expect(core.debugSnapshot().retainedRuns).toBe(0)
  })

  it('does not let retained tombstones keep a shut down RunCore alive', async () => {
    const clock = new TestClock()
    const { core } = await setup({
      clock,
      grantTtlMs: 24 * 60 * 60 * 1_000,
      tombstoneMinRetentionMs: 24 * 60 * 60 * 1_000,
    })
    const run = await core.createRun({
      grantId: 'grant-1', idempotencyKey: 'shutdown-retention-timer', request: request(),
    })
    await flush()
    await core.closeRun('grant-1', run.runHandle)
    expect(clock.pendingTimers).toBeGreaterThan(0)

    await core.shutdown()

    expect(clock.pendingTimers).toBe(0)
    expect(core.debugSnapshot().retainedRuns).toBe(1)
    expect(clock.pendingTimers).toBe(0)
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

  it('strictly reaps the interrupted Session left by cancel before admitting Craft', async () => {
    const { core, sessions } = await setup()
    const run = await core.createRun({
      grantId: 'grant-1', idempotencyKey: 'cancel-terminal-before-craft', request: request(),
    })
    const events: HostAgentEvent[] = []
    core.subscribe('grant-1', run.runHandle, undefined, (event) => events.push(event))
    await flush()
    sessions.awaitStoppedError = new Error('provider did not acknowledge stop')

    await expect(core.cancelRun('grant-1', run.runHandle)).resolves.toMatchObject({ state: 'interrupted' })
    expect(core.debugSnapshot()).toMatchObject({ activeRuns: 0, moduleSessions: 1 })
    expect(sessions.cancelled).toEqual(['session-1'])
    expect(sessions.reaped).toHaveLength(0)

    await expect(core.beginCraftTurn()).resolves.toBeUndefined()
    expect(core.getRun('grant-1', run.runHandle).state).toBe('closed')
    expect(sessions.cancelled).toEqual(['session-1'])
    expect(sessions.reaped).toEqual(['session-1'])
    expect(events.filter((event) => event.type.startsWith('turn.') && event.type !== 'turn.started'))
      .toEqual([expect.objectContaining({ type: 'turn.interrupted' })])
    expect(events.at(-1)?.type).toBe('run.closed')
    expect(core.debugSnapshot()).toMatchObject({ activeRuns: 0, moduleSessions: 0 })
    core.endCraftTurn()
  })

  it('rechecks Session ownership after an active Run becomes terminal ahead of queued Craft preemption', async () => {
    const { core, sessions } = await setup()
    const run = await core.createRun({
      grantId: 'grant-1', idempotencyKey: 'pending-interrupted-header-before-craft', request: request(),
    })
    const events: HostAgentEvent[] = []
    core.subscribe('grant-1', run.runHandle, undefined, (event) => events.push(event))
    await flush()

    const enteredInterruptedWrite = deferred()
    const releaseInterruptedWrite = deferred()
    const updateRunState = sessions.updateRunState.bind(sessions)
    const disposeAndReap = sessions.disposeAndReap.bind(sessions)
    let reapCalls = 0
    sessions.awaitStoppedError = new Error('provider did not acknowledge stop')
    sessions.updateRunState = async (sessionId, state) => {
      if (state === 'interrupted') {
        enteredInterruptedWrite.resolve()
        await releaseInterruptedWrite.promise
      }
      await updateRunState(sessionId, state)
    }
    sessions.disposeAndReap = async (sessionId) => {
      reapCalls += 1
      await disposeAndReap(sessionId)
    }

    const cancelling = core.cancelRun('grant-1', run.runHandle)
    void cancelling.catch(() => undefined)
    await enteredInterruptedWrite.promise
    expect(core.getRun('grant-1', run.runHandle).state).toBe('running')

    let craftSettled = false
    const admittingCraft = core.beginCraftTurn().finally(() => { craftSettled = true })
    void admittingCraft.catch(() => undefined)
    const deleting = core.closeRun('grant-1', run.runHandle)
    void deleting.catch(() => undefined)
    await flush()
    expect(craftSettled).toBe(false)
    expect(reapCalls).toBe(0)

    releaseInterruptedWrite.resolve()
    await expect(cancelling).resolves.toMatchObject({ state: 'interrupted' })
    await expect(admittingCraft).resolves.toBeUndefined()
    await expect(deleting).resolves.toMatchObject({ state: 'closed' })
    expect(core.getRun('grant-1', run.runHandle).state).toBe('closed')
    expect(reapCalls).toBe(1)
    expect(sessions.reaped).toEqual(['session-1'])
    expect(events.filter((event) => event.type.startsWith('turn.') && event.type !== 'turn.started'))
      .toEqual([expect.objectContaining({ type: 'turn.interrupted' })])
    expect(events.at(-1)?.type).toBe('run.closed')
    core.endCraftTurn()
  })

  it('strictly reaps a timed-out terminal Session before admitting Craft', async () => {
    const clock = new TestClock()
    const { core, sessions } = await setup({
      clock,
      maxRunDurationMs: 100,
      maxCraftPreemptionMs: 20,
    })
    const run = await core.createRun({
      grantId: 'grant-1', idempotencyKey: 'timeout-terminal-before-craft', request: request(),
    })
    const events: HostAgentEvent[] = []
    core.subscribe('grant-1', run.runHandle, undefined, (event) => events.push(event))
    await flush()
    sessions.awaitStoppedError = new Error('provider did not acknowledge stop')

    clock.advance(100)
    await flush()
    expect(core.getRun('grant-1', run.runHandle).state).toBe('failed')
    expect(core.debugSnapshot()).toMatchObject({ activeRuns: 0, moduleSessions: 1 })
    expect(sessions.reaped).toHaveLength(0)
    expect(events.filter((event) => event.type === 'turn.failed')).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ code: 'RUN_TIMEOUT' }) }),
    ])

    await expect(core.beginCraftTurn()).resolves.toBeUndefined()
    expect(core.getRun('grant-1', run.runHandle).state).toBe('closed')
    expect(sessions.reaped).toEqual(['session-1'])
    expect(events.filter((event) => event.type.startsWith('turn.') && event.type !== 'turn.started'))
      .toHaveLength(1)
    expect(events.at(-1)?.type).toBe('run.closed')
    expect(core.debugSnapshot()).toMatchObject({ activeRuns: 0, moduleSessions: 0 })
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

  it('bounds a permanently hung cooperative cancel and falls back to one strict reap', async () => {
    const clock = new TestClock()
    const { core, sessions } = await setup({
      clock,
      maxRunDurationMs: 1_000,
      maxCraftPreemptionMs: 20,
    })
    const run = await core.createRun({
      grantId: 'grant-1', idempotencyKey: 'craft-cancel-hang', request: request(),
    })
    await flush()

    const enteredCancel = deferred()
    const enteredReap = deferred()
    const releaseReap = deferred()
    const cancelTurn = sessions.cancelTurn.bind(sessions)
    const disposeAndReap = sessions.disposeAndReap.bind(sessions)
    let reapCalls = 0
    sessions.cancelTurn = async (sessionId) => {
      await cancelTurn(sessionId)
      enteredCancel.resolve()
      await new Promise<never>(() => undefined)
    }
    sessions.disposeAndReap = async (sessionId) => {
      reapCalls += 1
      enteredReap.resolve()
      await releaseReap.promise
      await disposeAndReap(sessionId)
    }

    const admittingCraft = core.beginCraftTurn()
    void admittingCraft.catch(() => undefined)
    await enteredCancel.promise
    clock.advance(20)
    await enteredReap.promise
    await expect(admittingCraft).rejects.toMatchObject({ code: 'CLEANUP_FAILED' })
    expect(reapCalls).toBe(1)

    const deleting = core.closeRun('grant-1', run.runHandle)
    void deleting.catch(() => undefined)
    releaseReap.resolve()
    await expect(deleting).resolves.toMatchObject({ state: 'closed' })
    expect(sessions.reaped).toEqual(['session-1'])
    expect(reapCalls).toBe(1)
    expect(core.debugSnapshot()).toMatchObject({ activeRuns: 0, moduleSessions: 0 })
    core.endCraftTurn()
  })

  it('bounds a permanently hung awaitStopped and lets DELETE join the strict reap', async () => {
    const clock = new TestClock()
    const { core, sessions } = await setup({
      clock,
      maxRunDurationMs: 1_000,
      maxCraftPreemptionMs: 20,
    })
    const run = await core.createRun({
      grantId: 'grant-1', idempotencyKey: 'craft-await-stopped-hang', request: request(),
    })
    await flush()

    const enteredAwaitStopped = deferred()
    const enteredReap = deferred()
    const releaseReap = deferred()
    const disposeAndReap = sessions.disposeAndReap.bind(sessions)
    let reapCalls = 0
    sessions.awaitStopped = async () => {
      enteredAwaitStopped.resolve()
      await new Promise<never>(() => undefined)
    }
    sessions.disposeAndReap = async (sessionId) => {
      reapCalls += 1
      enteredReap.resolve()
      await releaseReap.promise
      await disposeAndReap(sessionId)
    }

    const admittingCraft = core.beginCraftTurn()
    void admittingCraft.catch(() => undefined)
    await enteredAwaitStopped.promise
    clock.advance(20)
    await enteredReap.promise
    await expect(admittingCraft).rejects.toMatchObject({ code: 'CLEANUP_FAILED' })
    expect(sessions.cancelled).toEqual(['session-1'])
    expect(reapCalls).toBe(1)

    const deleting = core.closeRun('grant-1', run.runHandle)
    void deleting.catch(() => undefined)
    releaseReap.resolve()
    await expect(deleting).resolves.toMatchObject({ state: 'closed' })
    expect(sessions.reaped).toEqual(['session-1'])
    expect(reapCalls).toBe(1)
    core.endCraftTurn()
  })

  it('fails closed when neither cooperative nor strict Craft preemption can reap', async () => {
    const { core, sessions } = await setup()
    const run = await core.createRun({ grantId: 'grant-1', idempotencyKey: 'turn-stuck-preempt', request: request() })
    await flush()
    sessions.awaitStoppedError = new Error('provider did not acknowledge stop')
    sessions.reapError = new Error('provider child still alive')

    await expect(core.beginCraftTurn()).rejects.toMatchObject({ code: 'CLEANUP_FAILED' })
    expect(core.getRun('grant-1', run.runHandle).state).toBe('closing')
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

  it('blocks a second Run while strict cleanup debt retains a Session', async () => {
    const { core, sessions } = await setup()
    const run = await core.createRun({
      grantId: 'grant-1', idempotencyKey: 'cleanup-debt-first', request: request(),
    })
    await flush()
    sessions.emit('session-1', { type: 'turn.completed', finalText: 'done' })
    await flush()
    sessions.reapError = new Error('provider process still alive')
    await expect(core.closeRun('grant-1', run.runHandle)).rejects.toMatchObject({ code: 'CLEANUP_FAILED' })
    await expect(core.createRun({
      grantId: 'grant-1', idempotencyKey: 'cleanup-debt-second', request: request('second'),
    })).rejects.toMatchObject({ code: 'CLEANUP_FAILED' })
    expect(sessions.created).toHaveLength(1)
    expect(core.debugSnapshot()).toMatchObject({ retainedRuns: 1, moduleSessions: 1 })
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
    await expect(core.disconnectGrant('grant-1')).rejects.toMatchObject({ code: 'CLEANUP_FAILED' })
    const runHandle = sessions.created[0]?.ownership.runHandle
    expect(runHandle).toBeDefined()
    await expect(core.closeRun('grant-1', runHandle!)).resolves.toMatchObject({ state: 'closed' })
    expect(sessions.reaped).toEqual(['session-1'])
    expect(core.debugSnapshot()).toMatchObject({ activeRuns: 0, moduleSessions: 0 })
  })

  it('turns a timed-out initialization cleanup into one failed tombstone after late reap success', async () => {
    const clock = new TestClock()
    const { core, sessions } = await setup({
      clock,
      maxRunDurationMs: 1_000,
      maxCraftPreemptionMs: 20,
    })
    const enteredReap = deferred()
    const releaseReap = deferred()
    const disposeAndReap = sessions.disposeAndReap.bind(sessions)
    let reapCalls = 0
    sessions.subscribe = () => { throw new Error('subscription unavailable') }
    sessions.disposeAndReap = async (sessionId) => {
      reapCalls += 1
      enteredReap.resolve()
      await releaseReap.promise
      await disposeAndReap(sessionId)
    }

    const creating = core.createRun({
      grantId: 'grant-1', idempotencyKey: 'late-initialization-reap', request: request(),
    })
    void creating.catch(() => undefined)
    await enteredReap.promise
    clock.advance(20)
    await expect(creating).rejects.toMatchObject({ code: 'CLEANUP_FAILED' })

    const runHandle = sessions.created[0]?.ownership.runHandle
    expect(runHandle).toBeDefined()
    expect(core.getRun('grant-1', runHandle!).state).toBe('accepted')
    const transcript: HostAgentEvent[] = []
    core.subscribe('grant-1', runHandle!, undefined, (event) => transcript.push(event))

    releaseReap.resolve()
    await flush()

    expect(core.getRun('grant-1', runHandle!).state).toBe('closed')
    expect(transcript.map((event) => event.type)).toEqual([
      'run.accepted',
      'turn.failed',
      'run.closed',
    ])
    expect(transcript.filter((event) => event.type.startsWith('turn.') && event.type !== 'turn.started'))
      .toHaveLength(1)
    expect(transcript.find((event) => event.type === 'turn.failed')).toMatchObject({
      data: { code: 'RUNTIME_UNAVAILABLE' },
    })
    await expect(core.createRun({
      grantId: 'grant-1', idempotencyKey: 'late-initialization-reap', request: request(),
    })).resolves.toMatchObject({ runHandle, state: 'closed' })
    expect(sessions.created).toHaveLength(1)
    expect(sessions.prompts).toHaveLength(0)
    expect(sessions.reaped).toEqual(['session-1'])
    expect(reapCalls).toBe(1)
  })

  it('does not retain a failed pre-session reservation as a phantom run', async () => {
    const clock = new TestClock()
    const { core, sessions } = await setup({ clock })
    sessions.createError = new Error('disk unavailable')
    await expect(core.createRun({
      grantId: 'grant-1', idempotencyKey: 'turn-retryable-create', request: request(),
    })).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
    expect(core.debugSnapshot()).toMatchObject({ activeRuns: 0, retainedRuns: 0, moduleSessions: 0 })
    expect(clock.pendingTimers).toBe(0)
    sessions.createError = undefined
    await expect(core.createRun({
      grantId: 'grant-1', idempotencyKey: 'turn-retryable-create', request: request(),
    })).resolves.toMatchObject({ state: 'accepted' })
  })

  it('lets the absolute timeout win a late create rejection without releasing idempotency', async () => {
    const clock = new TestClock()
    const { core, sessions } = await setup({ clock, maxRunDurationMs: 100 })
    const enteredCreate = deferred()
    const releaseCreate = deferred()
    sessions.createSession = async () => {
      enteredCreate.resolve()
      await releaseCreate.promise
      throw new Error('disk unavailable after deadline')
    }

    const creating = core.createRun({
      grantId: 'grant-1', idempotencyKey: 'queued-timeout-discard', request: request(),
    })
    await enteredCreate.promise
    clock.advance(100)
    releaseCreate.resolve()
    const run = await creating
    await flush()

    expect(run.state).toBe('failed')
    expect(core.debugSnapshot()).toMatchObject({
      activeRuns: 0,
      retainedRuns: 1,
      moduleSessions: 0,
      cleanupDebtRuns: 0,
    })
    await expect(core.createRun({
      grantId: 'grant-1', idempotencyKey: 'queued-timeout-discard', request: request(),
    })).resolves.toMatchObject({ runHandle: run.runHandle, state: 'failed' })
  })
})
