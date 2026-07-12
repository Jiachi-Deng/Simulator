import {
  ModuleDaemonError,
  type ClockAdapter,
  type HealthAdapter,
  type HealthProbeResult,
  type LoopbackEndpoint,
  type ModuleProcess,
  type ModuleSpawnRequest,
  type ProcessAdapter,
  type ProcessExit,
} from '../types.ts'

interface ScheduledSleep {
  readonly deadline: number
  readonly resolve: () => void
  readonly reject: (error: unknown) => void
  readonly signal?: AbortSignal
  readonly onAbort?: () => void
}

function abortError(): DOMException {
  return new DOMException('Operation aborted', 'AbortError')
}

export class FakeClock implements ClockAdapter {
  private time: number
  private readonly sleeps: ScheduledSleep[] = []

  constructor(startAt = 0) {
    this.time = startAt
  }

  now(): number {
    return this.time
  }

  sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortError())
    if (milliseconds <= 0) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const scheduled: ScheduledSleep = {
        deadline: this.time + milliseconds,
        resolve,
        reject,
        signal,
      }
      const onAbort = (): void => {
        const index = this.sleeps.indexOf(scheduled)
        if (index >= 0) this.sleeps.splice(index, 1)
        reject(abortError())
      }
      Object.assign(scheduled, { onAbort })
      signal?.addEventListener('abort', onAbort, { once: true })
      this.sleeps.push(scheduled)
      this.sleeps.sort((left, right) => left.deadline - right.deadline)
    })
  }

  async advance(milliseconds: number): Promise<void> {
    if (milliseconds < 0) throw new TypeError('Cannot move fake clock backwards')
    this.time += milliseconds
    const due = this.sleeps.filter((sleep) => sleep.deadline <= this.time)
    for (const sleep of due) {
      const index = this.sleeps.indexOf(sleep)
      if (index >= 0) this.sleeps.splice(index, 1)
      sleep.signal?.removeEventListener('abort', sleep.onAbort!)
      sleep.resolve()
    }
    await Promise.resolve()
  }

  get pendingSleeps(): number {
    return this.sleeps.length
  }
}

export class FakeModuleProcess implements ModuleProcess {
  readonly exited: Promise<ProcessExit>
  stopCalls = 0
  private settled = false
  private resolveExit!: (exit: ProcessExit) => void

  constructor(readonly pid: number) {
    this.exited = new Promise((resolve) => {
      this.resolveExit = resolve
    })
  }

  crash(exitCode: number | null = 1, signal: NodeJS.Signals | null = null): void {
    if (this.settled) return
    this.settled = true
    this.resolveExit({ exitCode, signal })
  }

  async stopTree(): Promise<void> {
    this.stopCalls += 1
    this.crash(null, 'SIGTERM')
  }
}

export class FakeProcessAdapter implements ProcessAdapter {
  readonly requests: ModuleSpawnRequest[] = []
  readonly processes: FakeModuleProcess[] = []
  private readonly failures: unknown[] = []
  private nextPid = 10_000

  failNext(error: unknown = new ModuleDaemonError('SPAWN_FAILED', 'Injected spawn failure')): void {
    this.failures.push(error)
  }

  async spawn(request: ModuleSpawnRequest): Promise<ModuleProcess> {
    this.requests.push(request)
    const failure = this.failures.shift()
    if (failure) throw failure
    const process = new FakeModuleProcess(this.nextPid++)
    this.processes.push(process)
    return process
  }
}

interface PendingProbe {
  readonly promise: Promise<HealthProbeResult>
  resolve(result: HealthProbeResult): void
  reject(error: unknown): void
}

export class FakeHealthAdapter implements HealthAdapter {
  readonly allocated: LoopbackEndpoint[] = []
  readonly released: LoopbackEndpoint[] = []
  readonly checks: Array<{ endpoint: LoopbackEndpoint; timeoutMs: number }> = []
  defaultResult: HealthProbeResult = { status: 'healthy' }
  nextHost: LoopbackEndpoint['host'] | string = '127.0.0.1'
  private nextPort = 41_000
  private readonly allocationFailures: unknown[] = []
  private readonly probes: Array<HealthProbeResult | PendingProbe> = []

  failAllocationNext(error: unknown = new Error('Injected allocation failure')): void {
    this.allocationFailures.push(error)
  }

  queueProbe(...results: HealthProbeResult[]): void {
    this.probes.push(...results)
  }

  queuePendingProbe(): PendingProbe {
    let resolve!: (result: HealthProbeResult) => void
    let reject!: (error: unknown) => void
    const pending = {
      promise: new Promise<HealthProbeResult>((onResolve, onReject) => {
        resolve = onResolve
        reject = onReject
      }),
      resolve: (result: HealthProbeResult) => resolve(result),
      reject: (error: unknown) => reject(error),
    }
    this.probes.push(pending)
    return pending
  }

  async allocateEndpoint(): Promise<LoopbackEndpoint> {
    const failure = this.allocationFailures.shift()
    if (failure) throw failure
    const endpoint = { host: this.nextHost, port: this.nextPort++ } as LoopbackEndpoint
    this.allocated.push(endpoint)
    return endpoint
  }

  async check(endpoint: LoopbackEndpoint, timeoutMs: number, signal?: AbortSignal): Promise<HealthProbeResult> {
    this.checks.push({ endpoint, timeoutMs })
    const next = this.probes.shift()
    if (!next) return this.defaultResult
    if (!('promise' in next)) return next
    if (signal?.aborted) throw abortError()
    return await Promise.race([
      next.promise,
      new Promise<HealthProbeResult>((_, reject) => {
        signal?.addEventListener('abort', () => reject(abortError()), { once: true })
      }),
    ])
  }

  async releaseEndpoint(endpoint: LoopbackEndpoint): Promise<void> {
    this.released.push(endpoint)
  }
}
