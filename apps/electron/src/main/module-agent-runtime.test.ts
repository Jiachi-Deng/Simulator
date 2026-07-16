import { afterEach, describe, expect, it } from 'bun:test'
import { chmod, link, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ISessionManager } from '@craft-agent/server-core/handlers'
import type { HostAgentMessagePortLike } from '@simulator/host-agent-broker/message-port'
import {
  MessagePortByteCreditChannel,
  MessagePortHostAgentBrokerCoreClient,
} from '@simulator/host-agent-broker/message-port'
import type { ModuleAgentPortEvent } from '@simulator/module-agent-gateway'
import type { ModuleDaemonLaunchContext } from '@simulator/module-daemon'
import {
  createHostModuleAgentRuntime,
  createIsolatedHostModuleAgentRuntime,
  selectHostAgentProtocolForModule,
} from './module-agent-runtime'
import { OPEN_DESIGN_MODULE_ID } from '../shared/open-design-module-ipc'
import {
  HostAgentWorkerCircuitOpenError,
  HostAgentWorkerSupervisor,
  type HostAgentSupervisorIds,
  type HostAgentUnexpectedExitEvent,
  type HostAgentWorkerHandle,
  type HostAgentWorkerLaunchInput,
  type HostAgentWorkerLauncher,
} from '../host-agent/supervisor'
import type { HostAgentHostToWorkerMessage, HostAgentProtocolPath } from '../host-agent/protocol'
import type { HostAgentTokenStore } from '../host-agent/token-store'
import type { V1UtilityCompatibilityRuntime } from '../host-agent/v1-compatibility-runtime'

const temporaryRoots: string[] = []
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function fakeSessions(workspaceRoot: string, options: {
  autoComplete?: boolean
  disposeSessionAndReap?: (sessionId: string) => Promise<void>
} = {}) {
  const moduleListeners = new Set<(event: ModuleAgentPortEvent) => void>()
  const completionListeners = new Set<(event: {
    sessionId: string
    reason: 'complete'
    finalText: string
  }) => void>()
  const created: Array<Record<string, unknown>> = []
  const deleted: string[] = []
  const prompts: string[] = []
  const visibleListeners = new Set<(change: { active: boolean }) => void | Promise<void>>()
  const sendFixtureMessage = async (sessionId: string, prompt: string): Promise<void> => {
    prompts.push(prompt)
    if (options.autoComplete === false) return
    for (const listener of moduleListeners) {
      listener({ type: 'message.delta', sessionId, delta: 'host runtime ' })
      listener({ type: 'message.completed', sessionId, text: 'host runtime reply' })
    }
    for (const listener of completionListeners) {
      listener({ sessionId, reason: 'complete', finalText: 'host runtime reply' })
    }
  }
  const sessions = {
    getWorkspaces: () => [{
      id: 'workspace-1',
      name: 'Workspace',
      slug: 'workspace',
      rootPath: workspaceRoot,
      createdAt: 1,
    }],
    async createSession(workspaceId: string, options: Record<string, unknown>) {
      created.push({ workspaceId, ...options })
      return {
        id: 'raw-craft-session',
        workspaceId,
        workingDirectory: options.workingDirectory,
        hidden: options.hidden,
      }
    },
    onModuleAgentRuntimeEvent(listener: (event: ModuleAgentPortEvent) => void) {
      moduleListeners.add(listener)
      return () => moduleListeners.delete(listener)
    },
    onSessionComplete(listener: (event: { sessionId: string; reason: 'complete'; finalText: string }) => void) {
      completionListeners.add(listener)
      return () => completionListeners.delete(listener)
    },
    async sendMessage(sessionId: string, prompt: string) {
      await sendFixtureMessage(sessionId, prompt)
    },
    async sendModuleAgentMessage(sessionId: string, prompt: string) {
      await sendFixtureMessage(sessionId, prompt)
    },
    async cancelProcessing() {},
    async awaitSessionStopped() {},
    async updateModuleAgentRunState() {},
    async disposeSessionAndReap(sessionId: string) {
      if (options.disposeSessionAndReap) return await options.disposeSessionAndReap(sessionId)
      deleted.push(sessionId)
    },
    async deleteSession(sessionId: string) { deleted.push(sessionId) },
    onVisibleCraftTurnStateChange(listener: (change: { active: boolean }) => void | Promise<void>) {
      visibleListeners.add(listener)
      return () => visibleListeners.delete(listener)
    },
  } as unknown as ISessionManager
  return {
    sessions,
    created,
    deleted,
    prompts,
    async setVisibleCraftTurnActive(active: boolean) {
      await Promise.all([...visibleListeners].map(async (listener) => listener({ active })))
    },
    completeSession(sessionId = 'raw-craft-session', finalText = 'fixture complete') {
      for (const listener of completionListeners) listener({ sessionId, reason: 'complete', finalText })
    },
  }
}

type PortEvent = 'message' | 'close' | 'messageerror'

class RecoveryPort implements HostAgentMessagePortLike {
  peer?: RecoveryPort
  readonly #listeners = new Map<PortEvent, Set<(message?: unknown) => void>>()
  #closed = false

  postMessage(message: unknown): void {
    if (this.#closed || (this.peer && this.peer.#closed)) throw new Error('port closed')
    const peer = this.peer
    if (peer) queueMicrotask(() => peer.#emit('message', { data: message }))
  }

  on(event: PortEvent, listener: (message?: unknown) => void): this {
    let listeners = this.#listeners.get(event)
    if (!listeners) this.#listeners.set(event, listeners = new Set())
    listeners.add(listener)
    return this
  }

  off(event: PortEvent, listener: (message?: unknown) => void): this {
    this.#listeners.get(event)?.delete(listener)
    return this
  }

  start(): void {}

  close(): void {
    if (this.#closed) return
    this.#closed = true
    for (const listener of this.#listeners.get('close') ?? []) listener()
    if (this.peer) for (const listener of this.peer.#listeners.get('close') ?? []) listener()
  }

  #emit(event: PortEvent, message?: unknown): void {
    for (const listener of this.#listeners.get(event) ?? []) listener(message)
  }
}

class RecoveryWorkerHandle implements HostAgentWorkerHandle {
  readonly rpcPort: RecoveryPort
  readonly workerRpcPort: RecoveryPort
  readonly sent: HostAgentHostToWorkerMessage[] = []
  readonly #messageListeners = new Set<(message: unknown) => void>()
  readonly #exitListeners = new Set<(code: number) => void>()
  terminated = false
  exited = false
  exitOnShutdown = true
  exitOnTerminate = true

  constructor(
    readonly input: HostAgentWorkerLaunchInput,
    readonly pid: number,
  ) {
    this.rpcPort = new RecoveryPort()
    this.workerRpcPort = new RecoveryPort()
    this.rpcPort.peer = this.workerRpcPort
    this.workerRpcPort.peer = this.rpcPort
  }

  send(message: HostAgentHostToWorkerMessage): void {
    this.sent.push(message)
    if (message.kind === 'simulator.host-agent.worker.shutdown' && this.exitOnShutdown) {
      queueMicrotask(() => this.emitExit(0))
    }
  }

  terminate(): boolean {
    this.terminated = true
    if (this.exitOnTerminate) queueMicrotask(() => this.emitExit(70))
    return true
  }

  closeChannel(): void { this.rpcPort.close() }

  onMessage(listener: (message: unknown) => void): () => void {
    this.#messageListeners.add(listener)
    queueMicrotask(() => listener({
      kind: 'simulator.host-agent.worker.ready',
      protocol: this.input.protocol,
      epoch: this.input.epoch,
      pid: this.pid,
      address: {
        host: '127.0.0.1',
        port: 43_000 + this.pid,
        url: `http://127.0.0.1:${43_000 + this.pid}`,
      },
    }))
    return () => this.#messageListeners.delete(listener)
  }

  onExit(listener: (code: number) => void): () => void {
    this.#exitListeners.add(listener)
    return () => this.#exitListeners.delete(listener)
  }

  emitExit(code: number): void {
    if (this.exited) return
    this.exited = true
    for (const listener of [...this.#exitListeners]) listener(code)
  }
}

class RecoveryWorkerLauncher implements HostAgentWorkerLauncher {
  readonly handles: RecoveryWorkerHandle[] = []

  async launch(input: HostAgentWorkerLaunchInput): Promise<HostAgentWorkerHandle> {
    const handle = new RecoveryWorkerHandle(input, 1_000 + this.handles.length)
    this.handles.push(handle)
    return handle
  }

  latest(protocol: HostAgentProtocolPath): RecoveryWorkerHandle {
    const handle = this.handles.filter((candidate) => candidate.input.protocol === protocol).at(-1)
    if (!handle) throw new Error(`No ${protocol} recovery worker was launched`)
    return handle
  }
}

class RecoveryTokenStore implements HostAgentTokenStore {
  readonly active = new Set<string>()

  async create(protocol: HostAgentProtocolPath, epoch: string): Promise<string> {
    const path = `/fixture-tokens/${protocol}-${epoch}.token`
    this.active.add(path)
    return path
  }

  async remove(path: string): Promise<void> { this.active.delete(path) }
}

function recoveryIds(): HostAgentSupervisorIds {
  let next = 1
  return {
    epoch: () => `epoch_${String(next++).padStart(8, '0')}`,
    token: () => `token_${String(next++).padStart(40, '0')}`,
  }
}

async function waitForRecovery(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for Host Agent recovery')
    await Bun.sleep(2)
  }
}

function launchContext(signal: AbortSignal): ModuleDaemonLaunchContext {
  return {
    id: 'open-design',
    version: '0.14.1',
    activatedRoot: '/activated/open-design',
    executable: '/activated/open-design/bin/open-design',
    endpoint: { host: '127.0.0.1', port: 31_337 },
    restartCount: 0,
    signal,
  } as ModuleDaemonLaunchContext
}

describe('Host Module Agent runtime', () => {
  it('fails closed on symlinked, hardlinked, or non-executable Host Agent shims', async () => {
    if (process.platform === 'win32') return
    const temporary = await mkdtemp(join(tmpdir(), 'electron-module-agent-resources-'))
    temporaryRoots.push(temporary)
    const root = await realpath(temporary)
    const worker = join(root, 'worker.cjs')
    const target = join(root, 'shim-target.mjs')
    await writeFile(worker, 'module.exports = {}\n', { mode: 0o644 })
    await writeFile(target, '#!/usr/bin/env node\n', { mode: 0o755 })
    await chmod(worker, 0o644)
    await chmod(target, 0o755)
    const fake = fakeSessions(root)
    const options = (shimPath: string) => ({
      storageRoot: join(root, 'storage'),
      sessions: fake.sessions,
      resolveWorkspaceId: () => 'workspace-1',
      workerEntryPath: worker,
      shimPath,
    })

    const symlinkPath = join(root, 'symlink-shim.mjs')
    await symlink(target, symlinkPath)
    await expect(createIsolatedHostModuleAgentRuntime(options(symlinkPath))).rejects.toThrow(
      'unique Host-owned regular file',
    )

    const hardlinkPath = join(root, 'hardlink-shim.mjs')
    await link(target, hardlinkPath)
    await expect(createIsolatedHostModuleAgentRuntime(options(hardlinkPath))).rejects.toThrow(
      'unique Host-owned regular file',
    )

    const nonExecutablePath = join(root, 'non-executable-shim.mjs')
    await writeFile(nonExecutablePath, '#!/usr/bin/env node\n', { mode: 0o644 })
    await chmod(nonExecutablePath, 0o644)
    await expect(createIsolatedHostModuleAgentRuntime(options(nonExecutablePath))).rejects.toThrow(
      'not executable by the current user',
    )
  })

  it('routes only the declared OpenDesign versions to their exact protocol', () => {
    expect(selectHostAgentProtocolForModule({ id: OPEN_DESIGN_MODULE_ID, version: '0.14.5' })).toBe('v1')
    expect(selectHostAgentProtocolForModule({ id: OPEN_DESIGN_MODULE_ID, version: '0.14.6-rc.1' })).toBe('v2')
    expect(selectHostAgentProtocolForModule({ id: OPEN_DESIGN_MODULE_ID, version: '0.14.6' })).toBe('v2')
    expect(() => selectHostAgentProtocolForModule({
      id: OPEN_DESIGN_MODULE_ID,
      version: '0.14.6-rc.2',
    })).toThrow('does not declare a supported Host Agent contract')
    expect(selectHostAgentProtocolForModule({ id: 'packaged-smoke', version: '1.0.0' })).toBe('v1')
  })

  it('serially reaps crashed v2 epochs, permits two fresh launches, and leaves only v2 circuit-open on the third', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'electron-module-agent-recovery-'))
    temporaryRoots.push(temporary)
    const root = await realpath(temporary)
    const workspaceRoot = join(root, 'workspace')
    const workerEntryPath = join(root, 'worker.cjs')
    const shimPath = join(root, 'simulator-host-agent.mjs')
    await mkdir(workspaceRoot)
    await writeFile(workerEntryPath, 'module.exports = {}\n', { mode: 0o644 })
    await writeFile(shimPath, '#!/usr/bin/env node\n', { mode: 0o755 })
    await chmod(workerEntryPath, 0o644)
    await chmod(shimPath, 0o755)

    const fake = fakeSessions(workspaceRoot)
    const launcher = new RecoveryWorkerLauncher()
    const tokenStore = new RecoveryTokenStore()
    let supervisor!: HostAgentWorkerSupervisor
    let dispatchUnexpectedExit!: (event: HostAgentUnexpectedExitEvent) => void | Promise<void>
    const recoveries: Array<{
      protocol: HostAgentProtocolPath
      epoch: string
      failure: string
      circuitOpen: boolean
    }> = []
    const runtime = await createIsolatedHostModuleAgentRuntime({
      storageRoot: join(root, 'storage'),
      sessions: fake.sessions,
      resolveWorkspaceId: () => 'workspace-1',
      workerEntryPath,
      shimPath,
      craftPreemptTimeoutMs: 250,
      createSupervisor: (onUnexpectedExit) => {
        dispatchUnexpectedExit = onUnexpectedExit
        supervisor = new HostAgentWorkerSupervisor({
          launcher,
          tokenStore,
          ids: recoveryIds(),
          onUnexpectedExit,
        })
        return supervisor
      },
      onWorkerRecoveryNeeded: (event) => { recoveries.push(event) },
    })

    await supervisor.start('v1')
    const idleEpoch = supervisor.connection('v1')?.epoch
    if (!idleEpoch) throw new Error('idle v1 worker did not publish an epoch')
    launcher.latest('v1').emitExit(71)
    await supervisor.drain()
    await Bun.sleep(5)
    expect(recoveries).toEqual([])

    await supervisor.start('v1')
    const unaffectedV1 = launcher.latest('v1')
    await dispatchUnexpectedExit({ protocol: 'v1', epoch: idleEpoch, failure: 'unexpected-exit' })
    await Bun.sleep(5)
    expect(recoveries).toEqual([])
    let staleLease: Awaited<ReturnType<typeof runtime.prepareLaunch>> | undefined
    const urls: string[] = []
    const epochs: string[] = []

    for (let crash = 0; crash < 3; crash += 1) {
      const lease = await runtime.prepareLaunch({
        id: OPEN_DESIGN_MODULE_ID,
        version: '0.14.6-rc.1',
        activatedRoot: '/activated/open-design',
        executable: '/activated/open-design/bin/open-design',
        endpoint: { host: '127.0.0.1', port: 31_337 },
        restartCount: crash,
        signal: new AbortController().signal,
      } as ModuleDaemonLaunchContext)
      const connection = supervisor.connection('v2')
      if (!connection) throw new Error('v2 recovery worker did not publish a connection')
      const environment = lease.environment
      if (!environment?.SIMULATOR_HOST_AGENT_URL) throw new Error('v2 recovery lease has no URL')
      urls.push(environment.SIMULATOR_HOST_AGENT_URL)
      epochs.push(connection.epoch)
      if (crash === 0) {
        expect(runtime.debugSnapshot()).toMatchObject({
          kind: 'isolated',
          v1: { activeGrants: 0, activeSessions: 0, activeTurns: 0, activeSubscribers: 0 },
          v2: { activeGrants: 1, activeRuns: 0, moduleSessions: 0 },
          workers: {
            v1: { status: 'running' },
            v2: { status: 'running', epoch: connection.epoch },
          },
          turnLease: { craftActive: false },
        })
      }

      // Cleanup from the preceding daemon is intentionally late. It may reap
      // only its own epoch and must not stop this replacement worker.
      if (staleLease) {
        await staleLease.cleanup('process-exit')
        expect(supervisor.connection('v2')?.epoch).toBe(connection.epoch)
        expect(launcher.latest('v2').terminated).toBe(false)
      }

      staleLease = lease
      launcher.latest('v2').emitExit(71)
      await supervisor.drain()
      await waitForRecovery(() => recoveries.length === crash + 1)
      expect(supervisor.snapshot('v2').crashCountInWindow).toBe(crash + 1)
      expect(supervisor.snapshot('v2').status).toBe(crash === 2 ? 'circuit-open' : 'stopped')
      expect(supervisor.snapshot('v1').status).toBe('running')
      expect(unaffectedV1.terminated).toBe(false)
    }

    expect(new Set(urls).size).toBe(3)
    expect(new Set(epochs).size).toBe(3)
    expect(recoveries.map((event) => event.circuitOpen)).toEqual([false, false, true])
    expect(fake.prompts).toEqual([])
    expect(runtime.debugSnapshot()).toMatchObject({
      kind: 'isolated',
      v1: { activeGrants: 0, activeSessions: 0, activeTurns: 0, activeSubscribers: 0 },
      v2: { activeGrants: 0, activeRuns: 0, moduleSessions: 0 },
      workers: { v1: { status: 'running' }, v2: { status: 'circuit-open' } },
      turnLease: { craftActive: false },
    })
    await staleLease?.cleanup('process-exit')
    await expect(runtime.prepareLaunch({
      id: OPEN_DESIGN_MODULE_ID,
      version: '0.14.6-rc.1',
      activatedRoot: '/activated/open-design',
      executable: '/activated/open-design/bin/open-design',
      endpoint: { host: '127.0.0.1', port: 31_337 },
      restartCount: 3,
      signal: new AbortController().signal,
    } as ModuleDaemonLaunchContext)).rejects.toBeInstanceOf(HostAgentWorkerCircuitOpenError)
    await runtime.dispose()
  })

  it('rotates a v2 daemon lease before its fixed grant expires without renewing stale authority', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'electron-module-agent-grant-rotation-'))
    temporaryRoots.push(temporary)
    const root = await realpath(temporary)
    const workspaceRoot = join(root, 'workspace')
    const workerEntryPath = join(root, 'worker.cjs')
    const shimPath = join(root, 'simulator-host-agent.mjs')
    await mkdir(workspaceRoot)
    await writeFile(workerEntryPath, 'module.exports = {}\n', { mode: 0o644 })
    await writeFile(shimPath, '#!/usr/bin/env node\n', { mode: 0o755 })
    await chmod(workerEntryPath, 0o644)
    await chmod(shimPath, 0o755)

    let now = 10_000
    const scheduled: Array<{ callback: () => void; delayMs: number; cancelled: boolean }> = []
    const recoveries: Array<{
      protocol: HostAgentProtocolPath
      epoch: string
      failure: string
      circuitOpen: boolean
    }> = []
    const launcher = new RecoveryWorkerLauncher()
    let supervisor!: HostAgentWorkerSupervisor
    const fake = fakeSessions(workspaceRoot, { autoComplete: false })
    const runtime = await createIsolatedHostModuleAgentRuntime({
      storageRoot: join(root, 'storage'), sessions: fake.sessions,
      resolveWorkspaceId: () => 'workspace-1', workerEntryPath, shimPath, now: () => now,
      createSupervisor: (onUnexpectedExit) => {
        supervisor = new HostAgentWorkerSupervisor({
          launcher, tokenStore: new RecoveryTokenStore(), ids: recoveryIds(), onUnexpectedExit,
        })
        return supervisor
      },
      scheduleGrantRotation: (callback, delayMs) => {
        const timer = { callback, delayMs, cancelled: false }
        scheduled.push(timer)
        return () => { timer.cancelled = true }
      },
      onWorkerRecoveryNeeded: (event) => { recoveries.push(event) },
    })
    const context = (restartCount: number): ModuleDaemonLaunchContext => ({
      id: OPEN_DESIGN_MODULE_ID, version: '0.14.6-rc.1', activatedRoot: '/activated/open-design',
      executable: '/activated/open-design/bin/open-design', endpoint: { host: '127.0.0.1', port: 31_337 },
      restartCount, signal: new AbortController().signal,
    }) as ModuleDaemonLaunchContext

    const firstLease = await runtime.prepareLaunch(context(0))
    const firstEpoch = supervisor.connection('v2')?.epoch
    if (!firstEpoch) throw new Error('first grant rotation epoch is missing')
    const firstHandle = launcher.latest('v2')
    const firstChannel = new MessagePortByteCreditChannel(firstHandle.workerRpcPort)
    const firstClient = new MessagePortHostAgentBrokerCoreClient(firstChannel)
    await firstClient.createRun('rotation-fixture-key-0000000000000001', {
      contractVersion: 2,
      prompt: 'finish before rotating the grant',
    })
    await waitForRecovery(() => fake.prompts.length === 1)
    const firstTimer = scheduled[0]
    if (!firstTimer) throw new Error('first grant rotation timer was not armed')
    expect(firstTimer.delayMs).toBeGreaterThan(23 * 60 * 60 * 1_000)

    // An early scheduler callback must re-arm for the remaining time and must
    // not rotate authority before the five-minute safety window.
    now += firstTimer.delayMs - 1
    firstTimer.callback()
    await waitForRecovery(() => scheduled.length === 2)
    expect(recoveries).toEqual([])
    expect(firstTimer.cancelled).toBe(true)
    const dueTimer = scheduled[1]!
    expect(dueTimer.delayMs).toBe(1)
    now += 1
    dueTimer.callback()
    await waitForRecovery(() => scheduled.length === 3)
    expect(recoveries).toEqual([])
    expect(supervisor.connection('v2')?.epoch).toBe(firstEpoch)
    const activeRetry = scheduled[2]!
    expect(activeRetry.delayMs).toBe(1_000)

    fake.completeSession()
    await waitForRecovery(() => runtime.debugSnapshot().v2.activeRuns === 0)
    now += activeRetry.delayMs
    activeRetry.callback()
    await waitForRecovery(() => recoveries.length === 1)
    expect(recoveries).toEqual([{
      protocol: 'v2', epoch: firstEpoch, failure: 'grant-expiring', circuitOpen: false,
    }])

    await firstLease.cleanup('restart')
    const secondLease = await runtime.prepareLaunch(context(1))
    const secondEpoch = supervisor.connection('v2')?.epoch
    if (!secondEpoch) throw new Error('second grant rotation epoch is missing')
    expect(secondEpoch).not.toBe(firstEpoch)

    // A late callback from the old record cannot stop or rotate its replacement.
    dueTimer.callback()
    await Bun.sleep(5)
    expect(recoveries).toHaveLength(1)
    expect(supervisor.connection('v2')?.epoch).toBe(secondEpoch)

    const secondTimer = scheduled.at(-1)
    if (!secondTimer) throw new Error('second grant rotation timer was not armed')
    now += secondTimer.delayMs + 1
    secondTimer.callback()
    await waitForRecovery(() => recoveries.length === 2)
    expect(recoveries[1]).toEqual({
      protocol: 'v2', epoch: secondEpoch, failure: 'grant-expiring', circuitOpen: false,
    })
    await secondLease.cleanup('stop')
    await runtime.dispose()
  })

  it('forces v2 revocation at the fixed expiry even when an active Run never settles', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'electron-module-agent-hard-expiry-'))
    temporaryRoots.push(temporary)
    const root = await realpath(temporary)
    const workspaceRoot = join(root, 'workspace')
    const workerEntryPath = join(root, 'worker.cjs')
    const shimPath = join(root, 'simulator-host-agent.mjs')
    await mkdir(workspaceRoot)
    await writeFile(workerEntryPath, 'module.exports = {}\n', { mode: 0o644 })
    await writeFile(shimPath, '#!/usr/bin/env node\n', { mode: 0o755 })
    await chmod(workerEntryPath, 0o644)
    await chmod(shimPath, 0o755)

    const createdAt = 20_000
    let now = createdAt
    const scheduled: Array<{ callback: () => void; delayMs: number; cancelled: boolean }> = []
    const never = new Promise<void>(() => undefined)
    const fake = fakeSessions(workspaceRoot, {
      autoComplete: false,
      disposeSessionAndReap: async () => await never,
    })
    const launcher = new RecoveryWorkerLauncher()
    let supervisor!: HostAgentWorkerSupervisor
    const recoveries: Array<{
      protocol: HostAgentProtocolPath
      epoch: string
      failure: string
      circuitOpen: boolean
    }> = []
    const runtime = await createIsolatedHostModuleAgentRuntime({
      storageRoot: join(root, 'storage'), sessions: fake.sessions, resolveWorkspaceId: () => 'workspace-1',
      workerEntryPath, shimPath, now: () => now, craftPreemptTimeoutMs: 25,
      createSupervisor: (onUnexpectedExit) => {
        supervisor = new HostAgentWorkerSupervisor({
          launcher, tokenStore: new RecoveryTokenStore(), ids: recoveryIds(), onUnexpectedExit,
          limits: { gracefulStopTimeoutMs: 5 },
        })
        return supervisor
      },
      scheduleGrantRotation: (callback, delayMs) => {
        const timer = { callback, delayMs, cancelled: false }
        scheduled.push(timer)
        return () => { timer.cancelled = true }
      },
      onWorkerRecoveryNeeded: (event) => { recoveries.push(event) },
    })
    const lease = await runtime.prepareLaunch({
      id: OPEN_DESIGN_MODULE_ID, version: '0.14.6-rc.1', activatedRoot: '/activated/open-design',
      executable: '/activated/open-design/bin/open-design', endpoint: { host: '127.0.0.1', port: 31_337 },
      restartCount: 0, signal: new AbortController().signal,
    } as ModuleDaemonLaunchContext)
    const epoch = supervisor.connection('v2')?.epoch
    if (!epoch) throw new Error('hard-expiry fixture epoch is missing')
    const handle = launcher.latest('v2')
    const client = new MessagePortHostAgentBrokerCoreClient(new MessagePortByteCreditChannel(handle.workerRpcPort))
    await client.createRun('hard-expiry-fixture-key-000000000001', {
      contractVersion: 2,
      prompt: 'remain active through fixed grant expiry',
    })
    await waitForRecovery(() => fake.prompts.length === 1)
    const leadTimer = scheduled[0]
    if (!leadTimer) throw new Error('hard-expiry timer was not armed')

    now += leadTimer.delayMs
    leadTimer.callback()
    await waitForRecovery(() => scheduled.length === 2)
    const activeRetry = scheduled[1]!
    expect(activeRetry.delayMs).toBe(1_000)
    expect(recoveries).toEqual([])

    // The active Run may defer rotation inside the lead window, but the fixed
    // 24-hour authority is a hard boundary. At expiry cleanup is attempted and
    // a wedged provider fences only v2 instead of arming another one-second loop.
    now = createdAt + 24 * 60 * 60 * 1_000
    activeRetry.callback()
    await waitForRecovery(() => recoveries.length === 1)
    expect(recoveries).toEqual([{
      protocol: 'v2', epoch, failure: 'cleanup-timeout', circuitOpen: true,
    }])
    expect(scheduled).toHaveLength(2)
    expect(supervisor.snapshot('v2').status).toBe('circuit-open')
    expect(supervisor.snapshot('v1').status).toBe('stopped')
    await lease.cleanup('stop').catch(() => undefined)
    await runtime.dispose().catch(() => undefined)
  })

  it('retains a v2 launch record after exact worker stop fails and commits cleanup only after retry succeeds', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'electron-module-agent-v2-stop-retry-'))
    temporaryRoots.push(temporary)
    const root = await realpath(temporary)
    const workspaceRoot = join(root, 'workspace')
    const workerEntryPath = join(root, 'worker.cjs')
    const shimPath = join(root, 'simulator-host-agent.mjs')
    await mkdir(workspaceRoot)
    await writeFile(workerEntryPath, 'module.exports = {}\n', { mode: 0o644 })
    await writeFile(shimPath, '#!/usr/bin/env node\n', { mode: 0o755 })
    await chmod(workerEntryPath, 0o644)
    await chmod(shimPath, 0o755)

    const hostPort = new RecoveryPort()
    const workerPort = new RecoveryPort()
    hostPort.peer = workerPort
    workerPort.peer = hostPort
    const epoch = 'epoch_v2_stop_retry'
    let connected = true
    let stopCalls = 0
    let circuitOpen = false
    const circuitTrips: string[] = []
    const snapshot = (protocol: HostAgentProtocolPath) => ({
      protocol,
      status: protocol === 'v2' && circuitOpen ? 'circuit-open' as const : 'stopped' as const,
      ...(protocol === 'v2' && connected ? { epoch } : {}),
      crashCountInWindow: circuitOpen ? 3 : 0,
    })
    const supervisor = {
      async start() {
        connected = true
        return { protocol: 'v2', status: 'running', epoch, crashCountInWindow: 0 }
      },
      connection(protocol: HostAgentProtocolPath) {
        return protocol === 'v2' && connected
          ? {
              protocol: 'v2', epoch, tokenFile: join(root, 'v2-worker.token'),
              address: { host: '127.0.0.1', port: 43_337, url: 'http://127.0.0.1:43337' },
            }
          : undefined
      },
      rpcPort(protocol: HostAgentProtocolPath) { return protocol === 'v2' && connected ? hostPort : undefined },
      async stop(protocol: HostAgentProtocolPath) {
        if (protocol !== 'v2') return
        stopCalls += 1
        if (stopCalls === 1) throw new Error('exact v2 worker exit was not confirmed')
        connected = false
      },
      tripCircuit(protocol: HostAgentProtocolPath) {
        circuitTrips.push(protocol)
        circuitOpen = true
      },
      snapshot,
      snapshots() { return { v1: snapshot('v1'), v2: snapshot('v2') } },
      async stopAll() {
        connected = false
        return { v1: { status: 'fulfilled', value: undefined }, v2: { status: 'fulfilled', value: undefined } }
      },
      async drain() {},
    } as unknown as HostAgentWorkerSupervisor
    const recoveries: Array<{
      protocol: HostAgentProtocolPath
      epoch: string
      failure: string
      circuitOpen: boolean
    }> = []
    const fake = fakeSessions(workspaceRoot)
    const runtime = await createIsolatedHostModuleAgentRuntime({
      storageRoot: join(root, 'storage'), sessions: fake.sessions, resolveWorkspaceId: () => 'workspace-1',
      workerEntryPath, shimPath, craftPreemptTimeoutMs: 25,
      createSupervisor: () => supervisor,
      onWorkerRecoveryNeeded: (event) => { recoveries.push(event) },
    })
    const context = {
      id: OPEN_DESIGN_MODULE_ID, version: '0.14.6-rc.1', activatedRoot: '/activated/open-design',
      executable: '/activated/open-design/bin/open-design', endpoint: { host: '127.0.0.1', port: 31_337 },
      restartCount: 0, signal: new AbortController().signal,
    } as ModuleDaemonLaunchContext
    const lease = await runtime.prepareLaunch(context)

    await expect(lease.cleanup('stop')).rejects.toThrow('exact v2 worker exit was not confirmed')
    expect(stopCalls).toBe(1)
    expect(circuitTrips).toEqual(['v2'])
    expect(recoveries).toEqual([{
      protocol: 'v2', epoch, failure: 'cleanup-timeout', circuitOpen: true,
    }])
    await expect(runtime.prepareLaunch({ ...context, restartCount: 1 })).rejects.toThrow(
      'A v2 Module launch is already active',
    )

    await expect(lease.cleanup('stop')).resolves.toBeUndefined()
    expect(stopCalls).toBe(2)
    await expect(lease.cleanup('stop')).resolves.toBeUndefined()
    expect(stopCalls).toBe(2)
    await runtime.dispose()
  })

  it('stops a normal v1 launch, rotates its epoch on restart, and contains late cleanup to the old runtime', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'electron-module-agent-v1-restart-'))
    temporaryRoots.push(temporary)
    const root = await realpath(temporary)
    const workspaceRoot = join(root, 'workspace')
    const workerEntryPath = join(root, 'worker.cjs')
    const shimPath = join(root, 'simulator-host-agent.mjs')
    await mkdir(workspaceRoot)
    await writeFile(workerEntryPath, 'module.exports = {}\n', { mode: 0o644 })
    await writeFile(shimPath, '#!/usr/bin/env node\n', { mode: 0o755 })
    await chmod(workerEntryPath, 0o644)
    await chmod(shimPath, 0o755)

    const fake = fakeSessions(workspaceRoot)
    const launcher = new RecoveryWorkerLauncher()
    const tokenStore = new RecoveryTokenStore()
    let supervisor!: HostAgentWorkerSupervisor
    const recoveries: Array<{
      protocol: HostAgentProtocolPath
      epoch: string
      failure: string
      circuitOpen: boolean
    }> = []
    const runtime = await createIsolatedHostModuleAgentRuntime({
      storageRoot: join(root, 'storage'),
      sessions: fake.sessions,
      resolveWorkspaceId: () => 'workspace-1',
      workerEntryPath,
      shimPath,
      craftPreemptTimeoutMs: 250,
      createSupervisor: (onUnexpectedExit) => {
        supervisor = new HostAgentWorkerSupervisor({
          launcher, tokenStore, ids: recoveryIds(), onUnexpectedExit,
        })
        return supervisor
      },
      createV1Runtime: async (options): Promise<V1UtilityCompatibilityRuntime> => {
        await options.supervisor.start('v1')
        const connection = options.supervisor.connection('v1')
        if (!connection) throw new Error('v1 fixture worker did not publish a connection')
        let active = false
        let invalidated = false
        let disposal: Promise<void> | undefined
        return {
          workerEpoch: connection.epoch,
          hasActiveLaunch: () => active,
          async prepareLaunch() {
            if (invalidated) throw new Error('v1 fixture runtime is invalidated')
            active = true
            let cleaned = false
            return {
              environment: {
                SIMULATOR_HOST_AGENT_URL: connection.address.url,
                SIMULATOR_HOST_AGENT_TOKEN_FILE: connection.tokenFile,
              },
              async cleanup() {
                if (cleaned) return
                cleaned = true
                active = false
              },
            }
          },
          async invalidateAfterWorkerExit(epoch) {
            if (epoch !== connection.epoch) return false
            invalidated = true
            active = false
            return true
          },
          debugSnapshot: () => ({
            activeGrants: active ? 1 : 0,
            activeSessions: 0,
            activeTurns: 0,
            activeSubscribers: 0,
          }),
          refreshDebugSnapshot: async () => ({
            activeGrants: active ? 1 : 0,
            activeSessions: 0,
            activeTurns: 0,
            activeSubscribers: 0,
          }),
          dispose() {
            if (disposal) return disposal
            invalidated = true
            active = false
            disposal = options.supervisor.connection('v1')?.epoch === connection.epoch
              ? options.supervisor.stop('v1')
              : Promise.resolve()
            return disposal
          },
        }
      },
      onWorkerRecoveryNeeded: (event) => { recoveries.push(event) },
    })
    const context = (restartCount: number): ModuleDaemonLaunchContext => ({
      id: OPEN_DESIGN_MODULE_ID,
      version: '0.14.5',
      activatedRoot: '/activated/open-design',
      executable: '/activated/open-design/bin/open-design',
      endpoint: { host: '127.0.0.1', port: 31_337 },
      restartCount,
      signal: new AbortController().signal,
    }) as ModuleDaemonLaunchContext

    const firstLease = await runtime.prepareLaunch(context(0))
    const firstEpoch = supervisor.connection('v1')?.epoch
    if (!firstEpoch) throw new Error('first v1 fixture epoch is missing')
    expect(await runtime.refreshDebugSnapshot()).toMatchObject({
      kind: 'isolated',
      v1: { activeGrants: 1, activeSessions: 0, activeTurns: 0, activeSubscribers: 0 },
      v2: { activeGrants: 0, activeRuns: 0, moduleSessions: 0 },
      workers: { v1: { status: 'running', epoch: firstEpoch }, v2: { status: 'stopped' } },
    })
    await firstLease.cleanup('restart')
    expect(runtime.debugSnapshot()).toMatchObject({
      kind: 'isolated',
      v1: { activeGrants: 0, activeSessions: 0, activeTurns: 0, activeSubscribers: 0 },
      v2: { activeGrants: 0, activeRuns: 0, moduleSessions: 0 },
      workers: { v1: { status: 'stopped' }, v2: { status: 'stopped' } },
      turnLease: { craftActive: false },
    })

    const secondLease = await runtime.prepareLaunch(context(1))
    const secondEpoch = supervisor.connection('v1')?.epoch
    if (!secondEpoch) throw new Error('second v1 fixture epoch is missing')
    expect(secondEpoch).not.toBe(firstEpoch)
    await firstLease.cleanup('restart')
    expect(supervisor.connection('v1')?.epoch).toBe(secondEpoch)

    launcher.latest('v1').emitExit(71)
    await supervisor.drain()
    await waitForRecovery(() => recoveries.length === 1)
    expect(recoveries).toEqual([{
      protocol: 'v1', epoch: secondEpoch, failure: 'unexpected-exit', circuitOpen: false,
    }])
    const thirdLease = await runtime.prepareLaunch(context(2))
    const thirdEpoch = supervisor.connection('v1')?.epoch
    if (!thirdEpoch) throw new Error('third v1 fixture epoch is missing')
    expect(thirdEpoch).not.toBe(secondEpoch)

    await secondLease.cleanup('process-exit')
    expect(supervisor.connection('v1')?.epoch).toBe(thirdEpoch)
    expect(launcher.latest('v1').terminated).toBe(false)
    await thirdLease.cleanup('stop')
    expect(supervisor.snapshot('v1').status).toBe('stopped')
    expect(supervisor.snapshot('v2').status).toBe('stopped')
    await runtime.dispose()
  })

  it('fences and reports an exact v1 epoch once when Craft preemption cannot reap the provider', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'electron-module-agent-v1-preempt-'))
    temporaryRoots.push(temporary)
    const root = await realpath(temporary)
    const workspaceRoot = join(root, 'workspace')
    const workerEntryPath = join(root, 'worker.cjs')
    const shimPath = join(root, 'simulator-host-agent.mjs')
    await mkdir(workspaceRoot)
    await writeFile(workerEntryPath, 'module.exports = {}\n', { mode: 0o644 })
    await writeFile(shimPath, '#!/usr/bin/env node\n', { mode: 0o755 })
    await chmod(workerEntryPath, 0o644)
    await chmod(shimPath, 0o755)

    const never = new Promise<void>(() => undefined)
    const fake = fakeSessions(workspaceRoot, { disposeSessionAndReap: async () => await never })
    const launcher = new RecoveryWorkerLauncher()
    let supervisor!: HostAgentWorkerSupervisor
    const recoveries: Array<{
      protocol: HostAgentProtocolPath
      epoch: string
      failure: string
      circuitOpen: boolean
    }> = []
    const runtime = await createIsolatedHostModuleAgentRuntime({
      storageRoot: join(root, 'storage'),
      sessions: fake.sessions,
      resolveWorkspaceId: () => 'workspace-1',
      workerEntryPath,
      shimPath,
      craftPreemptTimeoutMs: 25,
      createSupervisor: (onUnexpectedExit) => {
        supervisor = new HostAgentWorkerSupervisor({
          launcher, tokenStore: new RecoveryTokenStore(), ids: recoveryIds(), onUnexpectedExit,
        })
        return supervisor
      },
      createV1Runtime: async (options): Promise<V1UtilityCompatibilityRuntime> => {
        await options.supervisor.start('v1')
        const connection = options.supervisor.connection('v1')
        const port = options.sessionPort
        if (!connection || !port) throw new Error('v1 preemption fixture did not receive its authority')
        let active = false
        return {
          workerEpoch: connection.epoch,
          hasActiveLaunch: () => active,
          async prepareLaunch() {
            const created = await port.createSession({
              workspaceId: 'workspace-1',
              workspaceRoot,
              authorizedWorkingRoot: workspaceRoot,
              workingDirectory: workspaceRoot,
            })
            await port.sendTurn(created.sessionId, 'v1 preemption fixture')
            active = true
            return {
              environment: {
                SIMULATOR_HOST_AGENT_URL: connection.address.url,
                SIMULATOR_HOST_AGENT_TOKEN_FILE: connection.tokenFile,
              },
              async cleanup() { active = false },
            }
          },
          async invalidateAfterWorkerExit(epoch) {
            if (epoch !== connection.epoch) return false
            active = false
            return true
          },
          debugSnapshot: () => ({
            activeGrants: active ? 1 : 0, activeSessions: active ? 1 : 0,
            activeTurns: active ? 1 : 0, activeSubscribers: active ? 1 : 0,
          }),
          refreshDebugSnapshot: async () => ({
            activeGrants: active ? 1 : 0, activeSessions: active ? 1 : 0,
            activeTurns: active ? 1 : 0, activeSubscribers: active ? 1 : 0,
          }),
          async dispose() { active = false; await options.supervisor.stop('v1') },
        }
      },
      onWorkerRecoveryNeeded: (event) => {
        recoveries.push(event)
        return never
      },
    })
    await runtime.prepareLaunch({
      id: OPEN_DESIGN_MODULE_ID, version: '0.14.5', activatedRoot: '/activated/open-design',
      executable: '/activated/open-design/bin/open-design', endpoint: { host: '127.0.0.1', port: 31_337 },
      restartCount: 0, signal: new AbortController().signal,
    } as ModuleDaemonLaunchContext)
    const epoch = supervisor.connection('v1')?.epoch
    if (!epoch) throw new Error('v1 preemption fixture epoch is missing')

    const startedAt = Date.now()
    await fake.setVisibleCraftTurnActive(true)
    expect(Date.now() - startedAt).toBeLessThan(1_000)
    expect(recoveries).toEqual([{
      protocol: 'v1', epoch, failure: 'cleanup-timeout', circuitOpen: true,
    }])
    expect(supervisor.snapshot('v1').status).toBe('circuit-open')
    expect(supervisor.snapshot('v2').status).toBe('stopped')
    await fake.setVisibleCraftTurnActive(true)
    expect(recoveries).toHaveLength(1)
    await runtime.dispose().catch(() => undefined)
  })

  it('fences and reports an exact v2 epoch once when Craft preemption cannot reap the provider', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'electron-module-agent-v2-preempt-'))
    temporaryRoots.push(temporary)
    const root = await realpath(temporary)
    const workspaceRoot = join(root, 'workspace')
    const workerEntryPath = join(root, 'worker.cjs')
    const shimPath = join(root, 'simulator-host-agent.mjs')
    await mkdir(workspaceRoot)
    await writeFile(workerEntryPath, 'module.exports = {}\n', { mode: 0o644 })
    await writeFile(shimPath, '#!/usr/bin/env node\n', { mode: 0o755 })
    await chmod(workerEntryPath, 0o644)
    await chmod(shimPath, 0o755)

    const never = new Promise<void>(() => undefined)
    const fake = fakeSessions(workspaceRoot, {
      autoComplete: false,
      disposeSessionAndReap: async () => await never,
    })
    const launcher = new RecoveryWorkerLauncher()
    let supervisor!: HostAgentWorkerSupervisor
    const recoveries: Array<{
      protocol: HostAgentProtocolPath
      epoch: string
      failure: string
      circuitOpen: boolean
    }> = []
    const runtime = await createIsolatedHostModuleAgentRuntime({
      storageRoot: join(root, 'storage'), sessions: fake.sessions, resolveWorkspaceId: () => 'workspace-1',
      workerEntryPath, shimPath, craftPreemptTimeoutMs: 25,
      createSupervisor: (onUnexpectedExit) => {
        supervisor = new HostAgentWorkerSupervisor({
          launcher, tokenStore: new RecoveryTokenStore(), ids: recoveryIds(), onUnexpectedExit,
        })
        return supervisor
      },
      onWorkerRecoveryNeeded: (event) => {
        recoveries.push(event)
        return never
      },
    })
    await runtime.prepareLaunch({
      id: OPEN_DESIGN_MODULE_ID, version: '0.14.6-rc.1', activatedRoot: '/activated/open-design',
      executable: '/activated/open-design/bin/open-design', endpoint: { host: '127.0.0.1', port: 31_337 },
      restartCount: 0, signal: new AbortController().signal,
    } as ModuleDaemonLaunchContext)
    const handle = launcher.latest('v2')
    const epoch = supervisor.connection('v2')?.epoch
    if (!epoch) throw new Error('v2 preemption fixture epoch is missing')
    const channel = new MessagePortByteCreditChannel(handle.workerRpcPort)
    const client = new MessagePortHostAgentBrokerCoreClient(channel)
    await client.createRun('preempt-fixture-key-0000000000000001', {
      contractVersion: 2,
      prompt: 'v2 preemption fixture',
    })
    await waitForRecovery(() => fake.prompts.length === 1)

    const startedAt = Date.now()
    await fake.setVisibleCraftTurnActive(true)
    expect(Date.now() - startedAt).toBeLessThan(1_000)
    expect(recoveries).toEqual([{
      protocol: 'v2', epoch, failure: 'cleanup-timeout', circuitOpen: true,
    }])
    expect(supervisor.snapshot('v2').status).toBe('circuit-open')
    expect(supervisor.snapshot('v1').status).toBe('stopped')
    await fake.setVisibleCraftTurnActive(true)
    await Bun.sleep(30)
    expect(recoveries).toHaveLength(1)
    expect(fake.prompts).toEqual(['v2 preemption fixture'])
    await runtime.dispose().catch(() => undefined)
  })

  it('binds an active Craft workspace to an owner-only launch grant and revokes it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'electron-module-agent-'))
    temporaryRoots.push(root)
    const workspaceRoot = join(root, 'workspace')
    await mkdir(workspaceRoot)
    const fake = fakeSessions(workspaceRoot)
    let grantedWorkingRoot = ''
    const runtime = await createHostModuleAgentRuntime({
      storageRoot: root,
      sessions: fake.sessions,
      resolveWorkspaceId: () => 'workspace-1',
      createServer: (gateway) => {
        const tokens = new Set<string>()
        return {
          async start() { return 'http://127.0.0.1:31337' },
          async prepareLaunch(spec, tokenDirectory) {
            grantedWorkingRoot = spec.authorizedWorkingRoot
            const grant = await gateway.issueGrant(spec)
            tokens.add(grant.grantToken)
            const tokenFile = join(tokenDirectory, `${grant.grantToken}.token`)
            await writeFile(tokenFile, `${grant.grantToken}\n`, { mode: 0o600 })
            await chmod(tokenFile, 0o600)
            return {
              grantToken: grant.grantToken,
              tokenFile,
              authorization: gateway.authorizationForGrant(grant.grantToken),
              environment: {
                SIMULATOR_HOST_AGENT_URL: 'http://127.0.0.1:31337',
                SIMULATOR_HOST_AGENT_TOKEN_FILE: tokenFile,
              },
              async dispose() {
                await gateway.revokeGrant(grant.grantToken)
                await rm(tokenFile, { force: true })
                tokens.delete(grant.grantToken)
              },
            }
          },
          async stop() {
            for (const token of tokens) await gateway.revokeGrant(token)
            tokens.clear()
          },
        }
      },
    })
    const controller = new AbortController()
    const lease = await runtime.prepareLaunch(launchContext(controller.signal))
    const url = lease.environment?.SIMULATOR_HOST_AGENT_URL
    const tokenFile = lease.environment?.SIMULATOR_HOST_AGENT_TOKEN_FILE
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(tokenFile).toBeString()
    expect((await readFile(tokenFile!, 'utf8')).trim()).toMatch(/^[0-9a-f]{64}$/)
    expect(grantedWorkingRoot).toBe(join(await realpath(root), 'module-data', 'open-design'))
    expect(runtime.debugSnapshot()).toMatchObject({ activeGrants: 1, activeSessions: 0, activeTurns: 0 })

    await lease.cleanup('stop')
    expect(fake.deleted).toEqual([])
    expect(runtime.debugSnapshot()).toEqual({
      activeGrants: 0,
      activeSessions: 0,
      activeTurns: 0,
      activeSubscribers: 0,
    })
    await expect(readFile(tokenFile!, 'utf8')).rejects.toBeTruthy()
    await runtime.dispose()
  })
})
