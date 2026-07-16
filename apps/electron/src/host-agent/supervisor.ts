import { randomBytes, randomUUID } from 'node:crypto'
import {
  HOST_AGENT_PROTOCOL_PATHS,
  HOST_AGENT_WORKER_LIMITS,
  parseHostAgentWorkerMessage,
  type HostAgentHostToWorkerMessage,
  type HostAgentProtocolPath,
} from './protocol'
import { HostAgentRpcMethodUnavailableError, type HostAgentWorkerRpcHandler } from './rpc-seams'
import type { HostAgentTokenStore } from './token-store'
import type { HostAgentMessagePortLike } from '@simulator/host-agent-broker/message-port'

export type HostAgentWorkerStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'circuit-open'
export type HostAgentWorkerFailure = 'launch-failed' | 'unexpected-exit' | 'rss-limit' | 'cleanup-timeout'

export interface HostAgentWorkerLaunchInput {
  protocol: HostAgentProtocolPath
  epoch: string
  tokenFile: string
  maxHeapMiB: number
  maxRssBytes: number
  healthIntervalMs: number
}

export interface HostAgentWorkerHandle {
  readonly pid?: number
  readonly rpcPort: HostAgentMessagePortLike
  send(message: HostAgentHostToWorkerMessage): void
  terminate(): boolean
  closeChannel(): void
  onMessage(listener: (message: unknown) => void): () => void
  onExit(listener: (code: number) => void): () => void
}

export interface HostAgentWorkerLauncher {
  launch(input: HostAgentWorkerLaunchInput): Promise<HostAgentWorkerHandle>
}

export interface HostAgentSupervisorClock {
  now(): number
  setTimeout(callback: () => void, delayMs: number): unknown
  clearTimeout(handle: unknown): void
}

export interface HostAgentSupervisorIds {
  epoch(): string
  token(): string
}

type HostAgentWorkerLimits = {
  [Key in keyof typeof HOST_AGENT_WORKER_LIMITS]: number
}

export interface HostAgentWorkerSnapshot {
  protocol: HostAgentProtocolPath
  status: HostAgentWorkerStatus
  epoch?: string
  pid?: number
  rssBytes?: number
  address?: {
    host: '127.0.0.1'
    port: number
    url: string
  }
  crashCountInWindow: number
  lastFailure?: HostAgentWorkerFailure
}

/** Host-internal launch material. Never log or serialize this object. */
export interface HostAgentWorkerConnection {
  readonly protocol: HostAgentProtocolPath
  readonly epoch: string
  readonly tokenFile: string
  readonly address: NonNullable<HostAgentWorkerSnapshot['address']>
}

export interface HostAgentWorkerSupervisorOptions {
  launcher: HostAgentWorkerLauncher
  tokenStore: HostAgentTokenStore
  rpcHandlers?: Partial<Record<HostAgentProtocolPath, HostAgentWorkerRpcHandler>>
  onUnexpectedExit?(event: HostAgentUnexpectedExitEvent): void | Promise<void>
  clock?: HostAgentSupervisorClock
  ids?: HostAgentSupervisorIds
  limits?: Partial<HostAgentWorkerLimits>
}

export interface HostAgentUnexpectedExitEvent {
  protocol: HostAgentProtocolPath
  epoch: string
  failure: Exclude<HostAgentWorkerFailure, 'cleanup-timeout'>
}

interface LaneRuntime {
  epoch: string
  tokenFile: string
  handle: HostAgentWorkerHandle
  expectedStop: boolean
  rssBytes?: number
  address?: HostAgentWorkerSnapshot['address']
  failureOverride?: HostAgentWorkerFailure
  bootstrapFailureStage?: 'attach' | 'token' | 'configuration' | 'runtime'
  exitCode?: number
  exitPromise: Promise<number>
  resolveExit(code: number): void
  finalizedPromise: Promise<void>
  resolveFinalized(): void
  finalizationStarted: boolean
  circuitFenced: boolean
  readyPromise: Promise<boolean>
  resolveReady(ready: boolean): void
  removeMessageListener(): void
  removeExitListener(): void
}

interface LaneState {
  protocol: HostAgentProtocolPath
  status: HostAgentWorkerStatus
  crashes: number[]
  lastFailure?: HostAgentWorkerFailure
  runtime?: LaneRuntime
  startPromise?: Promise<HostAgentWorkerSnapshot>
  stopPromise?: Promise<void>
  stopRequested: boolean
  forceStopRequested: boolean
}

const systemClock: HostAgentSupervisorClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

const systemIds: HostAgentSupervisorIds = {
  epoch: () => randomUUID(),
  token: () => randomBytes(32).toString('base64url'),
}

export class HostAgentWorkerCircuitOpenError extends Error {
  constructor(readonly protocol: HostAgentProtocolPath) {
    super(`Host Agent ${protocol} worker circuit is open`)
    this.name = 'HostAgentWorkerCircuitOpenError'
  }
}

export class HostAgentWorkerExitUnconfirmedError extends Error {
  readonly code = 'HOST_AGENT_WORKER_EXIT_UNCONFIRMED'

  constructor(
    readonly protocol: HostAgentProtocolPath,
    readonly epoch: string,
    readonly pid: number | undefined,
    readonly timeoutMs: number,
  ) {
    super(`Host Agent ${protocol} worker exit was not confirmed within ${timeoutMs}ms`)
    this.name = 'HostAgentWorkerExitUnconfirmedError'
  }
}

export class HostAgentWorkerStartCancelledError extends Error {
  constructor(readonly protocol: HostAgentProtocolPath) {
    super(`Host Agent ${protocol} worker start was cancelled by a concurrent stop`)
    this.name = 'HostAgentWorkerStartCancelledError'
  }
}

/**
 * Supervises v1 and v2 as independent failure domains. It deliberately has no
 * reference to Electron app lifecycle APIs, so a worker failure cannot quit or
 * terminate the Craft host.
 */
export class HostAgentWorkerSupervisor {
  readonly #launcher: HostAgentWorkerLauncher
  readonly #tokenStore: HostAgentTokenStore
  readonly #rpcHandlers: Partial<Record<HostAgentProtocolPath, HostAgentWorkerRpcHandler>>
  readonly #onUnexpectedExit?: HostAgentWorkerSupervisorOptions['onUnexpectedExit']
  readonly #clock: HostAgentSupervisorClock
  readonly #ids: HostAgentSupervisorIds
  readonly #limits: HostAgentWorkerLimits
  readonly #lanes = new Map<HostAgentProtocolPath, LaneState>()
  readonly #pendingFinalizers = new Set<Promise<void>>()

  constructor(options: HostAgentWorkerSupervisorOptions) {
    this.#launcher = options.launcher
    this.#tokenStore = options.tokenStore
    this.#rpcHandlers = { ...options.rpcHandlers }
    this.#onUnexpectedExit = options.onUnexpectedExit
    this.#clock = options.clock ?? systemClock
    this.#ids = options.ids ?? systemIds
    this.#limits = Object.freeze({ ...HOST_AGENT_WORKER_LIMITS, ...options.limits })
    this.#validateLimits()
    for (const protocol of HOST_AGENT_PROTOCOL_PATHS) {
      this.#lanes.set(protocol, {
        protocol,
        status: 'stopped',
        crashes: [],
        stopRequested: false,
        forceStopRequested: false,
      })
    }
  }

  snapshot(protocol: HostAgentProtocolPath): HostAgentWorkerSnapshot {
    const lane = this.#lane(protocol)
    this.#pruneCrashes(lane)
    if (lane.status === 'circuit-open'
      && !lane.runtime
      && !lane.startPromise
      && !lane.stopPromise
      && lane.crashes.length < this.#limits.crashThreshold) {
      lane.status = 'stopped'
    }
    return {
      protocol,
      status: lane.status,
      epoch: lane.runtime?.epoch,
      pid: lane.runtime?.handle.pid,
      rssBytes: lane.runtime?.rssBytes,
      address: lane.runtime?.address,
      crashCountInWindow: lane.crashes.length,
      lastFailure: lane.lastFailure,
    }
  }

  snapshots(): Readonly<Record<HostAgentProtocolPath, HostAgentWorkerSnapshot>> {
    return { v1: this.snapshot('v1'), v2: this.snapshot('v2') }
  }

  /** Dedicated credit-framed RPC port. Control/health messages never share it. */
  rpcPort(protocol: HostAgentProtocolPath): HostAgentMessagePortLike | undefined {
    return this.#lane(protocol).runtime?.handle.rpcPort
  }

  connection(protocol: HostAgentProtocolPath): HostAgentWorkerConnection | undefined {
    const runtime = this.#lane(protocol).runtime
    if (!runtime?.address) return undefined
    return Object.freeze({
      protocol,
      epoch: runtime.epoch,
      tokenFile: runtime.tokenFile,
      address: runtime.address,
    })
  }

  start(protocol: HostAgentProtocolPath): Promise<HostAgentWorkerSnapshot> {
    const lane = this.#lane(protocol)
    if (lane.startPromise) return lane.startPromise
    const pendingStop = lane.stopPromise
    const operation = this.#startLane(lane, pendingStop)
    lane.startPromise = operation
    void operation.then(
      () => { if (lane.startPromise === operation) lane.startPromise = undefined },
      () => { if (lane.startPromise === operation) lane.startPromise = undefined },
    )
    return operation
  }

  async #startLane(lane: LaneState, pendingStop: Promise<void> | undefined): Promise<HostAgentWorkerSnapshot> {
    if (pendingStop) await pendingStop
    const protocol = lane.protocol
    this.#pruneCrashes(lane)
    if (lane.status === 'circuit-open' && !lane.runtime && lane.crashes.length < this.#limits.crashThreshold) {
      lane.status = 'stopped'
    }
    if (lane.status === 'circuit-open' || lane.crashes.length >= this.#limits.crashThreshold) {
      lane.status = 'circuit-open'
      throw new HostAgentWorkerCircuitOpenError(protocol)
    }
    if (lane.runtime) {
      if (lane.runtime.expectedStop || lane.runtime.circuitFenced) {
        throw new HostAgentWorkerCircuitOpenError(protocol)
      }
      return this.snapshot(protocol)
    }

    lane.status = 'starting'
    const epoch = this.#ids.epoch()
    let tokenFile: string | undefined
    let runtimeInstalled = false
    try {
      tokenFile = await this.#tokenStore.create(protocol, epoch, this.#ids.token())
      if (this.#isCircuitOpen(lane) || lane.stopRequested) {
        await this.#removeToken(tokenFile)
        tokenFile = undefined
        if (this.#isCircuitOpen(lane)) throw new HostAgentWorkerCircuitOpenError(protocol)
        throw new HostAgentWorkerStartCancelledError(protocol)
      }
      const handle = await this.#launcher.launch({
        protocol,
        epoch,
        tokenFile,
        maxHeapMiB: this.#limits.maxHeapMiB,
        maxRssBytes: this.#limits.maxRssBytes,
        healthIntervalMs: this.#limits.healthIntervalMs,
      })
      let resolveExit!: (code: number) => void
      const exitPromise = new Promise<number>((resolve) => { resolveExit = resolve })
      let resolveFinalized!: () => void
      const finalizedPromise = new Promise<void>((resolve) => { resolveFinalized = resolve })
      let resolveReady!: (ready: boolean) => void
      const readyPromise = new Promise<boolean>((resolve) => { resolveReady = resolve })
      const runtime: LaneRuntime = {
        epoch,
        tokenFile,
        handle,
        expectedStop: false,
        exitPromise,
        resolveExit,
        finalizedPromise,
        resolveFinalized,
        finalizationStarted: false,
        circuitFenced: this.#isCircuitOpen(lane),
        readyPromise,
        resolveReady,
        removeMessageListener: () => undefined,
        removeExitListener: () => undefined,
      }
      lane.runtime = runtime
      runtimeInstalled = true
      runtime.removeExitListener = handle.onExit((code) => {
        if (runtime.exitCode !== undefined) return
        runtime.exitCode = code
        resolveExit(code)
        resolveReady(false)
        this.#trackFinalizer(this.#finalizeExit(protocol, epoch, code))
      })
      runtime.removeMessageListener = handle.onMessage((message) => this.#handleMessage(protocol, epoch, message))
      if (runtime.circuitFenced || lane.stopRequested) {
        runtime.expectedStop = true
        if (runtime.circuitFenced) runtime.failureOverride = lane.lastFailure ?? 'cleanup-timeout'
        this.#safeTerminate(runtime)
        if (!await this.#waitForExit(runtime.exitPromise, this.#limits.gracefulStopTimeoutMs)) {
          throw this.#markExitUnconfirmed(lane, runtime)
        }
        await runtime.finalizedPromise
        if (runtime.circuitFenced) throw new HostAgentWorkerCircuitOpenError(protocol)
        throw new HostAgentWorkerStartCancelledError(protocol)
      }
      const ready = await this.#waitForReady(runtime.readyPromise, this.#limits.startupTimeoutMs)
      if (lane.stopRequested || runtime.circuitFenced || this.#isCircuitOpen(lane)) {
        const circuitFenced = runtime.circuitFenced || this.#isCircuitOpen(lane)
        runtime.expectedStop = true
        runtime.circuitFenced = circuitFenced
        if (circuitFenced) runtime.failureOverride = lane.lastFailure ?? 'cleanup-timeout'
        this.#safeTerminate(runtime)
        if (!await this.#waitForExit(runtime.exitPromise, this.#limits.gracefulStopTimeoutMs)) {
          throw this.#markExitUnconfirmed(lane, runtime)
        }
        await runtime.finalizedPromise
        if (circuitFenced) throw new HostAgentWorkerCircuitOpenError(protocol)
        throw new HostAgentWorkerStartCancelledError(protocol)
      }
      if (!ready || runtime.exitCode !== undefined || lane.runtime !== runtime || this.snapshot(protocol).status !== 'running') {
        runtime.failureOverride = 'launch-failed'
        this.#safeTerminate(runtime)
        if (!await this.#waitForExit(runtime.exitPromise, this.#limits.gracefulStopTimeoutMs)) {
          throw this.#markExitUnconfirmed(lane, runtime)
        }
        await runtime.finalizedPromise
        throw new Error(`Host Agent ${protocol} worker failed readiness (${runtime.bootstrapFailureStage ?? (runtime.exitCode === undefined ? 'timeout' : `exit-${runtime.exitCode}`)})`)
      }
      return this.snapshot(protocol)
    } catch (error) {
      if (!runtimeInstalled) {
        if (tokenFile) await this.#removeToken(tokenFile)
        if (!(error instanceof HostAgentWorkerCircuitOpenError)
          && !(error instanceof HostAgentWorkerStartCancelledError)) {
          this.#recordCrash(lane, 'launch-failed')
        }
      }
      throw error
    }
  }

  async startAll(): Promise<Readonly<Record<HostAgentProtocolPath, PromiseSettledResult<HostAgentWorkerSnapshot>>>> {
    const [v1, v2] = await Promise.allSettled([this.start('v1'), this.start('v2')])
    return { v1, v2 }
  }

  async restart(protocol: HostAgentProtocolPath): Promise<HostAgentWorkerSnapshot> {
    await this.stop(protocol)
    return await this.start(protocol)
  }

  stop(protocol: HostAgentProtocolPath): Promise<void> {
    const lane = this.#lane(protocol)
    return this.#beginStop(lane)
  }

  #beginStop(lane: LaneState): Promise<void> {
    if (lane.stopPromise) return lane.stopPromise
    lane.stopRequested = true
    const pendingStart = lane.startPromise
    const operation = (async () => {
      if (pendingStart) {
        try { await pendingStart } catch { /* A failed start may still leave an owned runtime to reap. */ }
      }
      await this.#stopLane(lane)
    })()
    lane.stopPromise = operation
    void operation.then(
      () => { if (lane.stopPromise === operation) lane.stopPromise = undefined },
      () => { if (lane.stopPromise === operation) lane.stopPromise = undefined },
    )
    return operation
  }

  async #stopLane(lane: LaneState): Promise<void> {
    const protocol = lane.protocol
    const runtime = lane.runtime
    if (!runtime) {
      if (lane.status !== 'circuit-open') lane.status = 'stopped'
      lane.stopRequested = false
      lane.forceStopRequested = false
      return
    }

    runtime.expectedStop = true
    if (lane.status !== 'circuit-open') lane.status = 'stopping'
    const forced = lane.forceStopRequested
    if (!forced) {
      this.#safeSend(runtime, {
        kind: 'simulator.host-agent.worker.shutdown',
        protocol,
        epoch: runtime.epoch,
      })
    } else {
      runtime.circuitFenced = true
      this.#safeTerminate(runtime)
    }

    let exited = await this.#waitForExit(runtime.exitPromise, this.#limits.gracefulStopTimeoutMs)
    if (!exited && !forced && lane.runtime === runtime) {
      this.#safeTerminate(runtime)
      exited = await this.#waitForExit(runtime.exitPromise, this.#limits.gracefulStopTimeoutMs)
    }
    lane.forceStopRequested = false
    if (!exited && lane.runtime === runtime) throw this.#markExitUnconfirmed(lane, runtime)
    await runtime.finalizedPromise
    lane.stopRequested = false
  }

  async stopAll(): Promise<Readonly<Record<HostAgentProtocolPath, PromiseSettledResult<void>>>> {
    const [v1, v2] = await Promise.allSettled([this.stop('v1'), this.stop('v2')])
    return { v1, v2 }
  }

  resetCircuit(protocol: HostAgentProtocolPath): void {
    const lane = this.#lane(protocol)
    lane.crashes.length = 0
    if (!lane.runtime && !lane.startPromise && !lane.stopPromise) lane.status = 'stopped'
  }

  /**
   * Immediately fences one protocol path. Termination and token cleanup finish
   * asynchronously; callers such as visible Craft admission must never await a
   * wedged Module worker.
   */
  tripCircuit(protocol: HostAgentProtocolPath, failure: HostAgentWorkerFailure = 'cleanup-timeout'): void {
    const lane = this.#lane(protocol)
    lane.lastFailure = failure
    const now = this.#clock.now()
    while (lane.crashes.length < this.#limits.crashThreshold) lane.crashes.push(now)
    lane.status = 'circuit-open'
    lane.forceStopRequested = true
    if (lane.runtime) {
      lane.runtime.expectedStop = true
      lane.runtime.circuitFenced = true
      lane.runtime.failureOverride = failure
    }
    void this.#beginStop(lane).catch(() => undefined)
  }

  /** Waits for asynchronous exit cleanup; useful for deterministic shutdown and tests. */
  async drain(): Promise<void> {
    while (this.#pendingFinalizers.size > 0) {
      await Promise.allSettled([...this.#pendingFinalizers])
    }
  }

  #handleMessage(protocol: HostAgentProtocolPath, epoch: string, value: unknown): void {
    const message = parseHostAgentWorkerMessage(value)
    const lane = this.#lane(protocol)
    const runtime = lane.runtime
    if (!message || !runtime || runtime.epoch !== epoch) return
    if (message.protocol !== protocol || message.epoch !== epoch) return

    switch (message.kind) {
      case 'simulator.host-agent.worker.ready':
        if (!message.address) {
          runtime.failureOverride = 'launch-failed'
          this.#safeTerminate(runtime)
          runtime.resolveReady(false)
          return
        }
        runtime.address = message.address
        if (lane.status === 'starting') lane.status = 'running'
        runtime.resolveReady(true)
        return
      case 'simulator.host-agent.worker.health':
        runtime.rssBytes = message.rssBytes
        if (message.rssBytes > this.#limits.maxRssBytes && !runtime.expectedStop && !runtime.failureOverride) {
          runtime.failureOverride = 'rss-limit'
          this.#trackFinalizer(this.#terminateUnexpected(lane, runtime))
        }
        return
      case 'simulator.host-agent.worker.shutdown-ack':
        return
      case 'simulator.host-agent.worker.bootstrap-failed':
        runtime.failureOverride = 'launch-failed'
        runtime.bootstrapFailureStage = message.stage
        runtime.resolveReady(false)
        return
      case 'simulator.host-agent.rpc.request':
        void this.#handleRpc(runtime, message.requestId, message.method, message.payload)
        return
    }
  }

  async #handleRpc(runtime: LaneRuntime, requestId: string, method: string, payload: unknown): Promise<void> {
    const lane = this.#laneFromRuntime(runtime)
    if (!lane) return
    const handler = this.#rpcHandlers[lane.protocol]
    try {
      if (!handler) throw new HostAgentRpcMethodUnavailableError(lane.protocol, method)
      const value = await handler.invoke(method, payload)
      if (lane.runtime !== runtime) return
      this.#safeSend(runtime, {
        kind: 'simulator.host-agent.rpc.response',
        protocol: lane.protocol,
        epoch: runtime.epoch,
        requestId,
        ok: true,
        value,
      })
    } catch (error) {
      if (lane.runtime !== runtime) return
      this.#safeSend(runtime, {
        kind: 'simulator.host-agent.rpc.response',
        protocol: lane.protocol,
        epoch: runtime.epoch,
        requestId,
        ok: false,
        error: {
          code: error instanceof HostAgentRpcMethodUnavailableError ? 'METHOD_UNAVAILABLE' : 'REQUEST_FAILED',
        },
      })
    }
  }

  async #finalizeExit(protocol: HostAgentProtocolPath, epoch: string, _code: number): Promise<void> {
    const lane = this.#lane(protocol)
    const runtime = lane.runtime
    if (!runtime || runtime.epoch !== epoch) return
    if (runtime.finalizationStarted) return runtime.finalizedPromise
    runtime.finalizationStarted = true
    try {
      try { runtime.removeMessageListener() } catch { /* The process has exited; retain no live callback. */ }
      try { runtime.removeExitListener() } catch { /* The process has exited; retain no live callback. */ }
      try { runtime.handle.closeChannel() } catch { /* Channel teardown cannot revive an exited process. */ }
      await this.#removeToken(runtime.tokenFile)
      if (lane.runtime === runtime) lane.runtime = undefined
      if (runtime.expectedStop) {
        lane.stopRequested = false
        lane.forceStopRequested = false
        if (lane.status !== 'circuit-open') lane.status = 'stopped'
        return
      }
      const failure = runtime.failureOverride && runtime.failureOverride !== 'cleanup-timeout'
        ? runtime.failureOverride
        : 'unexpected-exit'
      if (!runtime.circuitFenced) this.#recordCrash(lane, failure)
      this.#notifyUnexpectedExit({ protocol, epoch, failure })
    } finally {
      runtime.resolveFinalized()
    }
  }

  async #terminateUnexpected(lane: LaneState, runtime: LaneRuntime): Promise<void> {
    this.#safeTerminate(runtime)
    if (!await this.#waitForExit(runtime.exitPromise, this.#limits.gracefulStopTimeoutMs)
      && lane.runtime === runtime) {
      this.#markExitUnconfirmed(lane, runtime)
    }
  }

  #markExitUnconfirmed(lane: LaneState, runtime: LaneRuntime): HostAgentWorkerExitUnconfirmedError {
    runtime.circuitFenced = true
    lane.lastFailure = 'cleanup-timeout'
    const now = this.#clock.now()
    while (lane.crashes.length < this.#limits.crashThreshold) lane.crashes.push(now)
    lane.status = 'circuit-open'
    return new HostAgentWorkerExitUnconfirmedError(
      lane.protocol,
      runtime.epoch,
      runtime.handle.pid,
      this.#limits.gracefulStopTimeoutMs,
    )
  }

  #safeSend(runtime: LaneRuntime, message: HostAgentHostToWorkerMessage): boolean {
    try {
      runtime.handle.send(message)
      return true
    } catch {
      return false
    }
  }

  #safeTerminate(runtime: LaneRuntime): boolean {
    try { return runtime.handle.terminate() } catch { return false }
  }

  #notifyUnexpectedExit(event: HostAgentUnexpectedExitEvent): void {
    if (!this.#onUnexpectedExit) return
    try {
      void Promise.resolve(this.#onUnexpectedExit(event)).catch(() => undefined)
    } catch {
      // Recovery is best-effort and must never escape the failed protocol lane.
    }
  }

  #recordCrash(lane: LaneState, failure: HostAgentWorkerFailure): void {
    lane.lastFailure = failure
    lane.crashes.push(this.#clock.now())
    this.#pruneCrashes(lane)
    lane.status = lane.crashes.length >= this.#limits.crashThreshold ? 'circuit-open' : 'stopped'
  }

  #pruneCrashes(lane: LaneState): void {
    const cutoff = this.#clock.now() - this.#limits.crashWindowMs
    while (lane.crashes.length > 0 && lane.crashes[0]! <= cutoff) lane.crashes.shift()
  }

  #lane(protocol: HostAgentProtocolPath): LaneState {
    return this.#lanes.get(protocol)!
  }

  #isCircuitOpen(lane: LaneState): boolean {
    return lane.status === 'circuit-open'
  }

  #laneFromRuntime(runtime: LaneRuntime): LaneState | undefined {
    return HOST_AGENT_PROTOCOL_PATHS
      .map((protocol) => this.#lane(protocol))
      .find((lane) => lane.runtime === runtime)
  }

  async #removeToken(path: string): Promise<void> {
    try { await this.#tokenStore.remove(path) } catch { /* Token cleanup is retried on startup by the owner. */ }
  }

  async #waitForExit(exit: Promise<number>, timeoutMs: number): Promise<boolean> {
    let timer: unknown
    const timeout = new Promise<false>((resolve) => {
      timer = this.#clock.setTimeout(() => resolve(false), timeoutMs)
    })
    const result = await Promise.race([exit.then(() => true as const), timeout])
    if (timer !== undefined) this.#clock.clearTimeout(timer)
    return result
  }

  async #waitForReady(ready: Promise<boolean>, timeoutMs: number): Promise<boolean> {
    let timer: unknown
    const timeout = new Promise<false>((resolve) => {
      timer = this.#clock.setTimeout(() => resolve(false), timeoutMs)
    })
    const result = await Promise.race([ready, timeout])
    if (timer !== undefined) this.#clock.clearTimeout(timer)
    return result
  }

  #trackFinalizer(promise: Promise<void>): void {
    this.#pendingFinalizers.add(promise)
    void promise
      .finally(() => this.#pendingFinalizers.delete(promise))
      .catch(() => undefined)
  }

  #validateLimits(): void {
    for (const value of Object.values(this.#limits)) {
      if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('Host Agent worker limits must be positive integers')
    }
  }
}
