import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HostAgentMessagePortLike } from '@simulator/host-agent-broker/message-port'
import {
  HostAgentWorkerExitUnconfirmedError,
  HostAgentWorkerCircuitOpenError,
  HostAgentWorkerSupervisor,
  HostAgentWorkerStartCancelledError,
  type HostAgentSupervisorClock,
  type HostAgentSupervisorIds,
  type HostAgentWorkerHandle,
  type HostAgentWorkerLaunchInput,
  type HostAgentWorkerLauncher,
} from '../supervisor'
import { OwnerOnlyHostAgentTokenStore, type HostAgentTokenStore } from '../token-store'
import type { HostAgentHostToWorkerMessage, HostAgentProtocolPath } from '../protocol'

class NullPort implements HostAgentMessagePortLike {
  postMessage(): void {}
  on(): this { return this }
  start(): void {}
}

class FakeHandle implements HostAgentWorkerHandle {
  readonly rpcPort = new NullPort()
  readonly sent: HostAgentHostToWorkerMessage[] = []
  readonly #messageListeners = new Set<(message: unknown) => void>()
  readonly #exitListeners = new Set<(code: number) => void>()
  closed = false
  terminated = false
  exitOnShutdown = true
  exitOnTerminate = true
  throwOnSend = false
  throwOnTerminate = false
  emitReady = true
  readyGate?: Promise<void>
  bufferedExitCode: number | undefined

  constructor(
    readonly input: HostAgentWorkerLaunchInput,
    readonly pid: number,
    private readonly readyWithAddress = true,
  ) {}

  send(message: HostAgentHostToWorkerMessage): void {
    if (this.throwOnSend) throw new Error('fake send failure')
    this.sent.push(message)
    if (message.kind === 'simulator.host-agent.worker.shutdown' && this.exitOnShutdown) {
      queueMicrotask(() => this.emitExit(0))
    }
  }

  terminate(): boolean {
    if (this.throwOnTerminate) throw new Error('fake terminate failure')
    this.terminated = true
    if (this.exitOnTerminate) queueMicrotask(() => this.emitExit(70))
    return true
  }

  closeChannel(): void { this.closed = true }

  onMessage(listener: (message: unknown) => void): () => void {
    this.#messageListeners.add(listener)
    if (this.emitReady) {
      queueMicrotask(() => {
        void (async () => {
          if (this.readyGate) await this.readyGate
          this.emit({
            kind: 'simulator.host-agent.worker.ready',
            protocol: this.input.protocol,
            epoch: this.input.epoch,
            pid: this.pid,
            ...(this.readyWithAddress
              ? { address: { host: '127.0.0.1', port: 43123, url: 'http://127.0.0.1:43123' } }
              : {}),
          })
        })()
      })
    }
    return () => this.#messageListeners.delete(listener)
  }

  onExit(listener: (code: number) => void): () => void {
    this.#exitListeners.add(listener)
    if (this.bufferedExitCode !== undefined) {
      const code = this.bufferedExitCode
      queueMicrotask(() => listener(code))
    }
    return () => this.#exitListeners.delete(listener)
  }

  emit(message: unknown): void {
    for (const listener of this.#messageListeners) listener(message)
  }

  emitExit(code: number): void {
    for (const listener of [...this.#exitListeners]) listener(code)
  }
}

class FakeLauncher implements HostAgentWorkerLauncher {
  readonly launches: HostAgentWorkerLaunchInput[] = []
  readonly handles: FakeHandle[] = []
  readyWithAddress = true
  launchGate?: Promise<void>
  configureHandle?: (handle: FakeHandle) => void

  async launch(input: HostAgentWorkerLaunchInput): Promise<HostAgentWorkerHandle> {
    this.launches.push(input)
    if (this.launchGate) await this.launchGate
    const handle = new FakeHandle(input, 10_000 + this.handles.length, this.readyWithAddress)
    this.configureHandle?.(handle)
    this.handles.push(handle)
    return handle
  }

  latest(protocol: HostAgentProtocolPath): FakeHandle {
    return this.handles.filter((handle) => handle.input.protocol === protocol).at(-1)!
  }
}

class FakeTokenStore implements HostAgentTokenStore {
  readonly files = new Map<string, { token: string; mode: number }>()
  readonly removed: string[] = []

  async create(protocol: HostAgentProtocolPath, epoch: string, token: string): Promise<string> {
    const path = `/tokens/${protocol}-${epoch}.token`
    this.files.set(path, { token, mode: 0o600 })
    return path
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path)
    this.removed.push(path)
  }
}

class FakeClock implements HostAgentSupervisorClock {
  nowValue = 1_000_000
  now(): number { return this.nowValue }
  setTimeout(callback: () => void, delayMs: number): unknown { return setTimeout(callback, delayMs) }
  clearTimeout(handle: unknown): void { clearTimeout(handle as ReturnType<typeof setTimeout>) }
  advance(ms: number): void { this.nowValue += ms }
}

function createIds(): HostAgentSupervisorIds {
  let next = 1
  return {
    epoch: () => `epoch_${String(next++).padStart(8, '0')}`,
    token: () => `token_${String(next++).padStart(40, '0')}`,
  }
}

function fixture(limits?: Partial<{ gracefulStopTimeoutMs: number; startupTimeoutMs: number }>) {
  const launcher = new FakeLauncher()
  const tokenStore = new FakeTokenStore()
  const clock = new FakeClock()
  const supervisor = new HostAgentWorkerSupervisor({ launcher, tokenStore, clock, ids: createIds(), limits })
  return { launcher, tokenStore, clock, supervisor }
}

async function exitAndDrain(supervisor: HostAgentWorkerSupervisor, handle: FakeHandle): Promise<void> {
  handle.emitExit(1)
  await supervisor.drain()
}

describe('HostAgentWorkerSupervisor', () => {
  it('coalesces concurrent starts into exactly one Utility Process launch', async () => {
    const { launcher, supervisor } = fixture()
    let releaseLaunch!: () => void
    launcher.launchGate = new Promise<void>((resolve) => { releaseLaunch = resolve })

    const first = supervisor.start('v2')
    const second = supervisor.start('v2')
    expect(second).toBe(first)
    await Promise.resolve()
    expect(launcher.launches).toHaveLength(1)

    releaseLaunch()
    const [firstSnapshot, secondSnapshot] = await Promise.all([first, second])
    expect(firstSnapshot).toEqual(secondSnapshot)
    expect(launcher.handles).toHaveLength(1)
    expect(firstSnapshot.status).toBe('running')
  })

  it('cancels a pending start before it can race a concurrent stop', async () => {
    const { launcher, tokenStore, supervisor } = fixture()
    let releaseLaunch!: () => void
    launcher.launchGate = new Promise<void>((resolve) => { releaseLaunch = resolve })

    const starting = supervisor.start('v1')
    await Promise.resolve()
    expect(launcher.launches).toHaveLength(1)
    const stopping = supervisor.stop('v1')
    releaseLaunch()

    await expect(starting).rejects.toBeInstanceOf(HostAgentWorkerStartCancelledError)
    await expect(stopping).resolves.toBeUndefined()
    expect(launcher.launches).toHaveLength(1)
    expect(supervisor.snapshot('v1').status).toBe('stopped')
    expect(tokenStore.files.size).toBe(0)
  })

  it('does not allow a circuit trip during launch to publish a running worker', async () => {
    const { launcher, tokenStore, supervisor } = fixture({ gracefulStopTimeoutMs: 5 })
    let releaseLaunch!: () => void
    launcher.launchGate = new Promise<void>((resolve) => { releaseLaunch = resolve })

    const starting = supervisor.start('v2')
    await Promise.resolve()
    supervisor.tripCircuit('v2')
    const stopping = supervisor.stop('v2')
    releaseLaunch()

    await expect(starting).rejects.toBeInstanceOf(HostAgentWorkerCircuitOpenError)
    await expect(stopping).resolves.toBeUndefined()
    expect(launcher.launches).toHaveLength(1)
    expect(supervisor.snapshot('v2').status).toBe('circuit-open')
    expect(supervisor.snapshot('v2').pid).toBeUndefined()
    expect(tokenStore.files.size).toBe(0)
  })

  it('cancels start when stop arrives while readiness is pending', async () => {
    const { launcher, tokenStore, supervisor } = fixture({ gracefulStopTimeoutMs: 5 })
    let releaseReady!: () => void
    const readyGate = new Promise<void>((resolve) => { releaseReady = resolve })
    launcher.configureHandle = (handle) => { handle.readyGate = readyGate }

    const starting = supervisor.start('v1')
    while (launcher.handles.length === 0) await Promise.resolve()
    const stopping = supervisor.stop('v1')
    releaseReady()

    await expect(starting).rejects.toBeInstanceOf(HostAgentWorkerStartCancelledError)
    await expect(stopping).resolves.toBeUndefined()
    expect(supervisor.snapshot('v1').status).toBe('stopped')
    expect(tokenStore.files.size).toBe(0)
  })

  it('consumes an exit buffered by the launcher before supervisor listener installation', async () => {
    const { launcher, tokenStore, supervisor } = fixture({ startupTimeoutMs: 1_000 })
    launcher.configureHandle = (handle) => {
      handle.emitReady = false
      handle.exitOnTerminate = false
      handle.bufferedExitCode = 72
    }

    await expect(supervisor.start('v2')).rejects.toThrow('failed readiness')
    expect(launcher.handles).toHaveLength(1)
    expect(launcher.latest('v2').closed).toBe(true)
    expect(tokenStore.files.size).toBe(0)
    expect(supervisor.snapshot('v2').pid).toBeUndefined()
  })

  it('starts v1 and v2 as independent ready workers with separate tokens, epochs, and limits', async () => {
    const { launcher, tokenStore, supervisor } = fixture()
    const result = await supervisor.startAll()
    expect(result.v1.status).toBe('fulfilled')
    expect(result.v2.status).toBe('fulfilled')
    const snapshots = supervisor.snapshots()
    expect(snapshots.v1.status).toBe('running')
    expect(snapshots.v2.status).toBe('running')
    expect(snapshots.v1.epoch).not.toBe(snapshots.v2.epoch)
    expect(snapshots.v2.address?.url).toBe('http://127.0.0.1:43123')
    expect(tokenStore.files.size).toBe(2)
    expect(new Set([...tokenStore.files.values()].map((entry) => entry.token)).size).toBe(2)
    expect(launcher.launches.every((launch) => launch.maxHeapMiB === 64)).toBe(true)
    expect(launcher.launches.every((launch) => launch.maxRssBytes === 128 * 1024 * 1024)).toBe(true)
    expect(supervisor.rpcPort('v1')).not.toBe(supervisor.rpcPort('v2'))
  })

  it('opens only the crashing protocol circuit after three crashes in five minutes', async () => {
    const { launcher, supervisor } = fixture()
    await supervisor.start('v2')
    for (let crash = 0; crash < 3; crash++) {
      await supervisor.start('v1')
      await exitAndDrain(supervisor, launcher.latest('v1'))
    }
    expect(supervisor.snapshot('v1').status).toBe('circuit-open')
    expect(supervisor.snapshot('v2').status).toBe('running')
    expect(launcher.latest('v2').terminated).toBe(false)
    await expect(supervisor.start('v1')).rejects.toBeInstanceOf(HostAgentWorkerCircuitOpenError)
  })

  it('rotates token and epoch across a graceful restart and reaps the old channel', async () => {
    const { launcher, tokenStore, supervisor } = fixture()
    const first = await supervisor.start('v1')
    const firstHandle = launcher.latest('v1')
    const firstTokenPath = firstHandle.input.tokenFile
    const second = await supervisor.restart('v1')
    expect(second.epoch).not.toBe(first.epoch)
    expect(firstHandle.closed).toBe(true)
    expect(tokenStore.removed).toContain(firstTokenPath)
    expect(tokenStore.files.has(launcher.latest('v1').input.tokenFile)).toBe(true)
  })

  it('enforces the RSS gate without stopping the other worker', async () => {
    const { launcher, supervisor } = fixture()
    await supervisor.startAll()
    const v2 = launcher.latest('v2')
    v2.emit({
      kind: 'simulator.host-agent.worker.health',
      protocol: 'v2',
      epoch: v2.input.epoch,
      rssBytes: 128 * 1024 * 1024 + 1,
    })
    await supervisor.drain()
    expect(v2.terminated).toBe(true)
    expect(supervisor.snapshot('v2').lastFailure).toBe('rss-limit')
    expect(supervisor.snapshot('v1').status).toBe('running')
    expect(launcher.latest('v1').terminated).toBe(false)
  })

  it('fences only the timed-out Module protocol without waiting or stopping Craft dependencies', async () => {
    const { launcher, supervisor } = fixture()
    await supervisor.startAll()
    supervisor.tripCircuit('v1')
    expect(supervisor.snapshot('v1').status).toBe('circuit-open')
    expect(supervisor.snapshot('v1').lastFailure).toBe('cleanup-timeout')
    expect(launcher.latest('v1').terminated).toBe(true)
    expect(supervisor.snapshot('v2').status).toBe('running')
    expect(launcher.latest('v2').terminated).toBe(false)
    await supervisor.drain()
  })

  it('keeps ownership evidence after a bounded unconfirmed circuit stop, then finalizes on late exit', async () => {
    const { launcher, tokenStore, supervisor } = fixture({ gracefulStopTimeoutMs: 5 })
    launcher.configureHandle = (handle) => {
      handle.exitOnShutdown = false
      handle.exitOnTerminate = false
    }
    const running = await supervisor.start('v1')
    const handle = launcher.latest('v1')
    const tokenPath = handle.input.tokenFile

    supervisor.tripCircuit('v1')
    const firstStop = supervisor.stop('v1')
    const secondStop = supervisor.stop('v1')
    expect(secondStop).toBe(firstStop)
    const [firstResult, secondResult] = await Promise.allSettled([firstStop, secondStop])

    expect(firstResult.status).toBe('rejected')
    expect(secondResult.status).toBe('rejected')
    if (firstResult.status === 'rejected' && secondResult.status === 'rejected') {
      expect(firstResult.reason).toBeInstanceOf(HostAgentWorkerExitUnconfirmedError)
      expect(secondResult.reason).toBe(firstResult.reason)
    }
    expect(supervisor.snapshot('v1')).toMatchObject({
      status: 'circuit-open',
      epoch: running.epoch,
      pid: handle.pid,
      lastFailure: 'cleanup-timeout',
    })
    expect(supervisor.connection('v1')?.tokenFile).toBe(tokenPath)
    expect(tokenStore.files.has(tokenPath)).toBe(true)
    expect(handle.closed).toBe(false)

    supervisor.resetCircuit('v1')
    expect(supervisor.snapshot('v1').status).toBe('circuit-open')
    await expect(supervisor.start('v1')).rejects.toBeInstanceOf(HostAgentWorkerCircuitOpenError)

    handle.emitExit(70)
    await supervisor.drain()
    expect(tokenStore.files.has(tokenPath)).toBe(false)
    expect(tokenStore.removed).toContain(tokenPath)
    expect(handle.closed).toBe(true)
    expect(supervisor.connection('v1')).toBeUndefined()
  })

  it('contains send and terminate exceptions to one protocol lane', async () => {
    const { launcher, tokenStore, supervisor } = fixture({ gracefulStopTimeoutMs: 5 })
    launcher.configureHandle = (handle) => {
      if (handle.input.protocol === 'v1') {
        handle.throwOnSend = true
        handle.throwOnTerminate = true
        handle.exitOnShutdown = false
        handle.exitOnTerminate = false
      }
    }
    await supervisor.startAll()
    const v1Token = launcher.latest('v1').input.tokenFile

    await expect(supervisor.stop('v1')).rejects.toBeInstanceOf(HostAgentWorkerExitUnconfirmedError)
    expect(supervisor.snapshot('v1').status).toBe('circuit-open')
    expect(tokenStore.files.has(v1Token)).toBe(true)
    expect(supervisor.snapshot('v2').status).toBe('running')
    expect(launcher.latest('v2').terminated).toBe(false)
    await expect(supervisor.stop('v2')).resolves.toBeUndefined()
  })

  it('notifies recovery only after a positive unexpected exit and swallows observer failure', async () => {
    const launcher = new FakeLauncher()
    const events: unknown[] = []
    const supervisor = new HostAgentWorkerSupervisor({
      launcher,
      tokenStore: new FakeTokenStore(),
      ids: createIds(),
      onUnexpectedExit: (event) => {
        events.push(event)
        throw new Error('recovery observer failure')
      },
    })
    await supervisor.startAll()
    const v1 = launcher.latest('v1')
    v1.emitExit(71)
    await supervisor.drain()

    expect(events).toEqual([{
      protocol: 'v1',
      epoch: v1.input.epoch,
      failure: 'unexpected-exit',
    }])
    expect(supervisor.snapshot('v2').status).toBe('running')
    expect(launcher.latest('v2').terminated).toBe(false)

    await supervisor.stop('v2')
    expect(events).toHaveLength(1)
  })

  it('keeps v1 and v2 control RPC handlers separate', async () => {
    const launcher = new FakeLauncher()
    const calls: string[] = []
    const supervisor = new HostAgentWorkerSupervisor({
      launcher,
      tokenStore: new FakeTokenStore(),
      ids: createIds(),
      rpcHandlers: {
        v1: { invoke: async (method) => { calls.push(`v1:${method}`); return 'legacy' } },
        v2: { invoke: async (method) => { calls.push(`v2:${method}`); return 'modern' } },
      },
    })
    await supervisor.startAll()
    const v1 = launcher.latest('v1')
    const v2 = launcher.latest('v2')
    v1.emit({ kind: 'simulator.host-agent.rpc.request', protocol: 'v1', epoch: v1.input.epoch, requestId: 'one', method: 'call', payload: null })
    v2.emit({ kind: 'simulator.host-agent.rpc.request', protocol: 'v2', epoch: v2.input.epoch, requestId: 'two', method: 'call', payload: null })
    await Promise.resolve()
    await Promise.resolve()
    expect(calls).toEqual(['v1:call', 'v2:call'])
    expect(v1.sent.at(-1)).toMatchObject({ ok: true, value: 'legacy' })
    expect(v2.sent.at(-1)).toMatchObject({ ok: true, value: 'modern' })
  })

  it('rejects v2 readiness without a loopback address and keeps v1 available', async () => {
    const { launcher, supervisor } = fixture()
    launcher.readyWithAddress = false
    await expect(supervisor.start('v2')).rejects.toThrow('failed readiness')
    launcher.readyWithAddress = true
    expect((await supervisor.start('v1')).status).toBe('running')
  })

  it('gracefully stops and reaps both workers without a cross-path shutdown primitive', async () => {
    const { launcher, tokenStore, supervisor } = fixture()
    await supervisor.startAll()
    const result = await supervisor.stopAll()
    expect(result.v1.status).toBe('fulfilled')
    expect(result.v2.status).toBe('fulfilled')
    expect(launcher.handles.every((handle) => handle.closed)).toBe(true)
    expect(launcher.handles.every((handle) => !handle.terminated)).toBe(true)
    expect(tokenStore.files.size).toBe(0)
  })
})

const temporaryRoots: string[] = []
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('OwnerOnlyHostAgentTokenStore', () => {
  it('creates a 0600 token inside a 0700 directory and removes it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'simulator-host-agent-'))
    temporaryRoots.push(root)
    const directory = join(root, 'tokens')
    const store = new OwnerOnlyHostAgentTokenStore(directory)
    const path = await store.create('v2', 'epoch_12345678', 'a'.repeat(43))
    if (process.platform !== 'win32') {
      expect((await stat(directory)).mode & 0o777).toBe(0o700)
      expect((await stat(path)).mode & 0o777).toBe(0o600)
    }
    await store.remove(path)
    await expect(stat(path)).rejects.toThrow()
  })
})
