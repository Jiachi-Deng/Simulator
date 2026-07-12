import type { ModuleId, ModuleVersion } from '@simulator/module-contract'
import { assertLoopbackEndpoint, createMinimalEnvironment, resolveActivatedEntrypoint, selectArtifact } from './safety.ts'
import {
  ModuleDaemonError,
  type HealthProbeResult,
  type LoopbackEndpoint,
  type ModuleDaemonDiagnostic,
  type ModuleDaemonDiagnosticCode,
  type ModuleDaemonManagerOptions,
  type ModuleDaemonSnapshot,
  type ModuleDaemonState,
  type ModuleProcess,
  type ProcessExit,
  type StartModuleDaemonRequest,
} from './types.ts'

const DEFAULT_STARTUP_TIMEOUT_MS = 10_000
const DEFAULT_HEALTH_TIMEOUT_MS = 1_000
const DEFAULT_HEALTH_INTERVAL_MS = 500
const DEFAULT_UNHEALTHY_THRESHOLD = 3
const DEFAULT_RESTART_LIMIT = 3
const DEFAULT_RESTART_BACKOFF_MS = [100, 500, 2_000] as const
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000
const DEFAULT_STOP_GRACE_MS = 2_000

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

interface DaemonRecord {
  readonly id: ModuleId
  readonly version: ModuleVersion
  readonly request: StartModuleDaemonRequest
  readonly executable: string
  readonly activatedRoot: string
  readonly controller: AbortController
  readonly ready: Deferred<ModuleDaemonSnapshot>
  state: ModuleDaemonState
  endpoint?: LoopbackEndpoint
  process?: ModuleProcess
  restartCount: number
  lastActiveAt: number
  diagnostic?: ModuleDaemonDiagnostic
  readySettled: boolean
  supervising: boolean
  stopRequested: boolean
  readonly healthyWaiters: Set<Deferred<ModuleDaemonSnapshot>>
  lifecycle?: Promise<void>
  stopPromise?: Promise<ModuleDaemonSnapshot>
}

type MonitorOutcome =
  | { readonly kind: 'crashed'; readonly code: ModuleDaemonDiagnosticCode; readonly message: string }
  | { readonly kind: 'idle' }

type ProbeRace =
  | { readonly kind: 'probe'; readonly result: HealthProbeResult }
  | { readonly kind: 'exit'; readonly exit: ProcessExit }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'error'; readonly error: unknown }

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

function positiveInteger(value: number, name: string, allowZero = false): number {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new TypeError(`${name} must be ${allowZero ? 'a non-negative' : 'a positive'} integer`)
  }
  return value
}

export class ModuleDaemonManager {
  private readonly records = new Map<ModuleId, DaemonRecord>()
  private readonly pendingStarts = new Map<ModuleId, Promise<ModuleDaemonSnapshot>>()
  private readonly pendingStartRequests = new Map<ModuleId, StartModuleDaemonRequest>()
  private readonly listeners = new Set<(snapshot: ModuleDaemonSnapshot) => void>()
  private readonly startupTimeoutMs: number
  private readonly healthTimeoutMs: number
  private readonly healthIntervalMs: number
  private readonly unhealthyThreshold: number
  private readonly restartLimit: number
  private readonly restartBackoffMs: readonly number[]
  private readonly idleTimeoutMs: number
  private readonly stopGraceMs: number
  private readonly baseEnvironment: Readonly<Record<string, string>>
  private draining = false
  private drainPromise?: Promise<void>

  constructor(private readonly options: ModuleDaemonManagerOptions) {
    this.startupTimeoutMs = positiveInteger(options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS, 'startupTimeoutMs')
    this.healthTimeoutMs = positiveInteger(options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS, 'healthTimeoutMs')
    this.healthIntervalMs = positiveInteger(options.healthIntervalMs ?? DEFAULT_HEALTH_INTERVAL_MS, 'healthIntervalMs')
    this.unhealthyThreshold = positiveInteger(options.unhealthyThreshold ?? DEFAULT_UNHEALTHY_THRESHOLD, 'unhealthyThreshold')
    this.restartLimit = positiveInteger(options.restartLimit ?? DEFAULT_RESTART_LIMIT, 'restartLimit', true)
    this.idleTimeoutMs = positiveInteger(options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS, 'idleTimeoutMs')
    this.stopGraceMs = positiveInteger(options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS, 'stopGraceMs')
    const backoff = options.restartBackoffMs ?? DEFAULT_RESTART_BACKOFF_MS
    if (backoff.length === 0 || backoff.some((value) => !Number.isSafeInteger(value) || value < 0)) {
      throw new TypeError('restartBackoffMs must contain non-negative integers')
    }
    this.restartBackoffMs = Object.freeze([...backoff])
    this.baseEnvironment = Object.freeze({ ...(options.baseEnvironment ?? {}) })
  }

  start(request: StartModuleDaemonRequest): Promise<ModuleDaemonSnapshot> {
    if (this.draining) {
      return Promise.reject(new ModuleDaemonError('MANAGER_DRAINING', 'Module daemon manager is draining'))
    }

    const current = this.records.get(request.manifest.id)
    if (current
      && current.version === request.manifest.version
      && current.request.activatedRoot === request.activatedRoot
      && (current.state === 'starting'
        || current.state === 'healthy'
        || current.state === 'degraded'
        || (current.state === 'crashed' && current.supervising))) {
      if (current.state === 'healthy' || current.state === 'degraded') return Promise.resolve(this.snapshot(current))
      if (!current.readySettled) return current.ready.promise
      return this.waitForHealthy(current)
    }

    const pending = this.pendingStarts.get(request.manifest.id)
    if (pending) {
      const pendingRequest = this.pendingStartRequests.get(request.manifest.id)!
      if (pendingRequest.manifest.version !== request.manifest.version
        || pendingRequest.activatedRoot !== request.activatedRoot) {
        return pending.then(() => this.start(request), () => this.start(request))
      }
      return pending
    }

    const operation = this.startNew(request)
    this.pendingStarts.set(request.manifest.id, operation)
    this.pendingStartRequests.set(request.manifest.id, request)
    const clear = (): void => {
      if (this.pendingStarts.get(request.manifest.id) === operation) {
        this.pendingStarts.delete(request.manifest.id)
        this.pendingStartRequests.delete(request.manifest.id)
      }
    }
    void operation.then(clear, clear)
    return operation
  }

  private async startNew(request: StartModuleDaemonRequest): Promise<ModuleDaemonSnapshot> {
    const artifact = selectArtifact(request.manifest.artifacts, request.platform)
    const resolved = await resolveActivatedEntrypoint(request.activatedRoot, artifact)
    if (this.draining) {
      throw new ModuleDaemonError('MANAGER_DRAINING', 'Module daemon manager is draining')
    }

    const existing = this.records.get(request.manifest.id)
    if (existing?.state === 'stopping') {
      throw new ModuleDaemonError('STOP_REQUESTED', 'Module daemon is stopping')
    }
    if (existing && (existing.state === 'starting'
      || existing.state === 'healthy'
      || existing.state === 'degraded'
      || (existing.state === 'crashed' && existing.supervising))) {
      if (existing.version !== request.manifest.version || existing.activatedRoot !== resolved.activatedRoot) {
        throw new ModuleDaemonError('SPAWN_FAILED', 'A different activated version of this module is already active')
      }
      if (existing.state === 'healthy' || existing.state === 'degraded') return this.snapshot(existing)
      if (!existing.readySettled) return existing.ready.promise
      return this.waitForHealthy(existing)
    }

    const ready = deferred<ModuleDaemonSnapshot>()
    const record: DaemonRecord = {
      id: request.manifest.id,
      version: request.manifest.version,
      request,
      executable: resolved.executable,
      activatedRoot: resolved.activatedRoot,
      controller: new AbortController(),
      ready,
      state: 'starting',
      restartCount: 0,
      lastActiveAt: this.options.clock.now(),
      readySettled: false,
      supervising: true,
      stopRequested: false,
      healthyWaiters: new Set(),
    }
    this.records.set(record.id, record)
    this.emit(record)
    record.lifecycle = this.supervise(record)
    return ready.promise
  }

  async stop(id: ModuleId): Promise<ModuleDaemonSnapshot | undefined> {
    let record = this.records.get(id)
    if (!record) {
      const pending = this.pendingStarts.get(id)
      if (!pending) return undefined
      try {
        await pending
      } catch {
        return this.records.get(id) ? this.stop(id) : undefined
      }
      record = this.records.get(id)
      if (!record) return undefined
    }
    if (record.state === 'stopped') return this.snapshot(record)
    if (record.stopPromise) return record.stopPromise

    record.stopRequested = true
    record.state = 'stopping'
    this.setDiagnostic(record, 'STOP_REQUESTED', 'Module daemon stop requested')
    record.controller.abort()
    this.emit(record)
    record.stopPromise = (async () => {
      await record.process?.stopTree(this.stopGraceMs)
      await record.lifecycle
      if (record.state !== 'crashed') record.state = 'stopped'
      this.emit(record)
      return this.snapshot(record)
    })()
    return record.stopPromise
  }

  async drain(): Promise<void> {
    this.draining = true
    this.drainPromise ??= Promise.all([...this.records.keys()].map((id) => this.stop(id))).then(() => undefined)
    return this.drainPromise
  }

  touch(id: ModuleId): boolean {
    const record = this.records.get(id)
    if (!record || (record.state !== 'healthy' && record.state !== 'degraded')) return false
    record.lastActiveAt = this.options.clock.now()
    return true
  }

  get(id: ModuleId): ModuleDaemonSnapshot | undefined {
    const record = this.records.get(id)
    return record ? this.snapshot(record) : undefined
  }

  list(): readonly ModuleDaemonSnapshot[] {
    return Object.freeze([...this.records.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((record) => this.snapshot(record)))
  }

  subscribe(listener: (snapshot: ModuleDaemonSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private async supervise(record: DaemonRecord): Promise<void> {
    try {
      while (!record.stopRequested) {
        let outcome: MonitorOutcome
        try {
          outcome = await this.launchAndMonitor(record)
        } catch (error) {
          if (record.stopRequested) break
          const daemonError = error instanceof ModuleDaemonError
            ? error
            : new ModuleDaemonError('SPAWN_FAILED', 'Module daemon launch failed', { cause: error })
          outcome = { kind: 'crashed', code: daemonError.code, message: daemonError.message }
        } finally {
          await this.cleanupCurrent(record)
        }

        if (record.stopRequested) break
        if (outcome.kind === 'idle') {
          record.stopRequested = true
          record.state = 'stopping'
          this.setDiagnostic(record, 'IDLE_TIMEOUT', 'Module daemon stopped after its idle timeout')
          this.emit(record)
          break
        }

        record.state = 'crashed'
        this.setDiagnostic(record, outcome.code, outcome.message)
        this.emit(record)
        if (record.restartCount >= this.restartLimit) {
          record.supervising = false
          this.setDiagnostic(record, 'RESTART_BUDGET_EXHAUSTED', `Restart budget exhausted after ${record.restartCount} restart(s)`)
          this.emit(record)
          if (!record.readySettled) {
            record.readySettled = true
            record.ready.reject(new ModuleDaemonError('RESTART_BUDGET_EXHAUSTED', record.diagnostic!.message))
          }
          this.rejectHealthyWaiters(record, new ModuleDaemonError('RESTART_BUDGET_EXHAUSTED', record.diagnostic!.message))
          return
        }

        const backoff = this.restartBackoffMs[Math.min(record.restartCount, this.restartBackoffMs.length - 1)]!
        record.restartCount += 1
        await this.options.clock.sleep(backoff, record.controller.signal)
      }
    } catch (error) {
      if (!record.stopRequested && !record.readySettled) {
        record.readySettled = true
        record.ready.reject(error)
      }
    } finally {
      try {
        await this.cleanupCurrent(record)
        if (record.stopRequested) {
          record.state = 'stopped'
          if (!record.readySettled) {
            record.readySettled = true
            record.ready.reject(new ModuleDaemonError('STOP_REQUESTED', 'Module daemon stopped before becoming healthy'))
          }
          this.rejectHealthyWaiters(record, new ModuleDaemonError('STOP_REQUESTED', 'Module daemon stopped before becoming healthy'))
          this.emit(record)
        }
      } finally {
        record.supervising = false
      }
    }
  }

  private async launchAndMonitor(record: DaemonRecord): Promise<MonitorOutcome> {
    record.state = 'starting'
    record.diagnostic = undefined
    this.emit(record)

    let endpoint: LoopbackEndpoint
    try {
      endpoint = await this.options.health.allocateEndpoint(record.controller.signal)
      assertLoopbackEndpoint(endpoint)
    } catch (error) {
      if (error instanceof ModuleDaemonError) throw error
      throw new ModuleDaemonError('ENDPOINT_ALLOCATION_FAILED', 'Unable to allocate module health endpoint', { cause: error })
    }
    record.endpoint = endpoint

    const environment = createMinimalEnvironment(this.baseEnvironment, {
      id: record.id,
      version: record.version,
      endpoint,
    })
    try {
      record.process = await this.options.process.spawn({
        executable: record.executable,
        args: [],
        cwd: record.activatedRoot,
        env: environment,
        shell: false,
      })
    } catch (error) {
      if (error instanceof ModuleDaemonError) throw error
      throw new ModuleDaemonError('SPAWN_FAILED', 'Unable to spawn module daemon', { cause: error })
    }
    this.emit(record)

    await this.waitUntilReady(record, record.process, endpoint)
    record.state = 'healthy'
    record.lastActiveAt = this.options.clock.now()
    record.diagnostic = undefined
    this.emit(record)
    if (!record.readySettled) {
      record.readySettled = true
      record.ready.resolve(this.snapshot(record))
    }
    this.resolveHealthyWaiters(record)
    return this.monitor(record, record.process, endpoint)
  }

  private async waitUntilReady(
    record: DaemonRecord,
    moduleProcess: ModuleProcess,
    endpoint: LoopbackEndpoint,
  ): Promise<void> {
    const deadline = this.options.clock.now() + this.startupTimeoutMs
    while (true) {
      const remaining = deadline - this.options.clock.now()
      if (remaining <= 0) throw new ModuleDaemonError('STARTUP_TIMEOUT', 'Module daemon readiness timed out')

      const race = await this.probe(
        record,
        moduleProcess,
        endpoint,
        Math.min(this.healthTimeoutMs, remaining),
      )
      if (race.kind === 'exit') {
        throw new ModuleDaemonError('PROCESS_EXITED', this.exitMessage(race.exit, 'before readiness'))
      }
      if (race.kind === 'timeout' && this.options.clock.now() >= deadline) {
        throw new ModuleDaemonError('STARTUP_TIMEOUT', 'Module daemon readiness timed out')
      }
      if (race.kind === 'probe' && race.result.status === 'healthy') return
      if (race.kind === 'probe' && race.result.status === 'malformed') {
        throw new ModuleDaemonError('READINESS_MALFORMED', race.result.detail)
      }
      await this.options.clock.sleep(Math.min(this.healthIntervalMs, Math.max(0, deadline - this.options.clock.now())), record.controller.signal)
    }
  }

  private async monitor(
    record: DaemonRecord,
    moduleProcess: ModuleProcess,
    endpoint: LoopbackEndpoint,
  ): Promise<MonitorOutcome> {
    let unhealthyCount = 0
    while (!record.stopRequested) {
      const idleRemaining = this.idleTimeoutMs - (this.options.clock.now() - record.lastActiveAt)
      if (idleRemaining <= 0) return { kind: 'idle' }

      const wake = await Promise.race([
        moduleProcess.exited.then((exit) => ({ kind: 'exit' as const, exit })),
        this.options.clock.sleep(Math.min(this.healthIntervalMs, idleRemaining), record.controller.signal)
          .then(() => ({ kind: 'tick' as const })),
      ])
      if (wake.kind === 'exit') {
        return { kind: 'crashed', code: 'PROCESS_EXITED', message: this.exitMessage(wake.exit, 'while running') }
      }
      if (this.options.clock.now() - record.lastActiveAt >= this.idleTimeoutMs) return { kind: 'idle' }

      const probeBudget = Math.min(
        this.healthTimeoutMs,
        Math.max(1, this.idleTimeoutMs - (this.options.clock.now() - record.lastActiveAt)),
      )
      const result = await this.probe(record, moduleProcess, endpoint, probeBudget)
      if (result.kind === 'exit') {
        return { kind: 'crashed', code: 'PROCESS_EXITED', message: this.exitMessage(result.exit, 'during health check') }
      }
      if (result.kind === 'timeout' && this.options.clock.now() - record.lastActiveAt >= this.idleTimeoutMs) {
        return { kind: 'idle' }
      }
      const probe = result.kind === 'probe'
        ? result.result
        : {
            status: 'unhealthy' as const,
            detail: result.kind === 'timeout'
              ? 'Health probe timed out'
              : 'Health probe failed',
          }
      if (probe.status === 'healthy') {
        unhealthyCount = 0
        if (record.state !== 'healthy') {
          record.state = 'healthy'
          record.diagnostic = undefined
          this.emit(record)
        }
        continue
      }

      unhealthyCount += 1
      record.state = 'degraded'
      this.setDiagnostic(record, 'HEALTH_DEGRADED', probe.detail)
      this.emit(record)
      if (unhealthyCount >= this.unhealthyThreshold) {
        const timedOut = probe.status === 'unhealthy' && /timed out/i.test(probe.detail)
        return {
          kind: 'crashed',
          code: timedOut ? 'HEALTH_TIMEOUT' : 'HEALTH_DEGRADED',
          message: `Health failed ${unhealthyCount} consecutive time(s): ${probe.detail}`,
        }
      }
    }
    throw new ModuleDaemonError('STOP_REQUESTED', 'Module daemon stop requested')
  }

  private async cleanupCurrent(record: DaemonRecord): Promise<void> {
    const moduleProcess = record.process
    const endpoint = record.endpoint
    record.process = undefined
    record.endpoint = undefined
    if (moduleProcess) await moduleProcess.stopTree(this.stopGraceMs)
    if (endpoint) await this.options.health.releaseEndpoint?.(endpoint)
  }

  private async probe(
    record: DaemonRecord,
    moduleProcess: ModuleProcess,
    endpoint: LoopbackEndpoint,
    timeoutMs: number,
  ): Promise<ProbeRace> {
    const probeController = new AbortController()
    const signal = AbortSignal.any([record.controller.signal, probeController.signal])
    const result = await Promise.race<ProbeRace>([
      this.options.health.check(endpoint, timeoutMs, signal).then(
        (health) => ({ kind: 'probe' as const, result: health }),
        (error) => ({ kind: 'error' as const, error }),
      ),
      moduleProcess.exited.then((exit) => ({ kind: 'exit' as const, exit })),
      this.options.clock.sleep(timeoutMs, signal).then(() => ({ kind: 'timeout' as const })),
    ])
    probeController.abort()
    if (result.kind === 'error' && record.stopRequested) throw result.error
    return result
  }

  private waitForHealthy(record: DaemonRecord): Promise<ModuleDaemonSnapshot> {
    const waiter = deferred<ModuleDaemonSnapshot>()
    record.healthyWaiters.add(waiter)
    return waiter.promise
  }

  private resolveHealthyWaiters(record: DaemonRecord): void {
    const snapshot = this.snapshot(record)
    for (const waiter of record.healthyWaiters) waiter.resolve(snapshot)
    record.healthyWaiters.clear()
  }

  private rejectHealthyWaiters(record: DaemonRecord, error: ModuleDaemonError): void {
    for (const waiter of record.healthyWaiters) waiter.reject(error)
    record.healthyWaiters.clear()
  }

  private setDiagnostic(record: DaemonRecord, code: ModuleDaemonDiagnosticCode, message: string): void {
    record.diagnostic = Object.freeze({
      code,
      message,
      at: this.options.clock.now(),
      restartCount: record.restartCount,
    })
  }

  private snapshot(record: DaemonRecord): ModuleDaemonSnapshot {
    return Object.freeze({
      id: record.id,
      version: record.version,
      state: record.state,
      ...(record.endpoint ? { endpoint: Object.freeze({ ...record.endpoint }) } : {}),
      ...(record.process ? { pid: record.process.pid } : {}),
      restartCount: record.restartCount,
      ...(record.diagnostic ? { diagnostic: Object.freeze({ ...record.diagnostic }) } : {}),
    })
  }

  private emit(record: DaemonRecord): void {
    const snapshot = this.snapshot(record)
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch (error) {
        try {
          this.options.onListenerError?.(error, snapshot)
        } catch {
          // Diagnostics callbacks cannot participate in daemon supervision.
        }
      }
    }
  }

  private exitMessage(exit: ProcessExit, phase: string): string {
    return `Module daemon exited ${phase} (code=${exit.exitCode ?? 'null'}, signal=${exit.signal ?? 'null'})`
  }
}
