import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
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
  type RealProcessAdapterOptions,
  type WindowsJobProcessFactory,
} from './types.ts'

function abortError(): DOMException {
  return new DOMException('Operation aborted', 'AbortError')
}

export class RealClock implements ClockAdapter {
  now(): number {
    return Date.now()
  }

  sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortError())
    return new Promise((resolve, reject) => {
      const timer = setTimeout(finish, milliseconds)
      const onAbort = (): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        reject(abortError())
      }
      function finish(): void {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }
}

class RealModuleProcess implements ModuleProcess {
  readonly pid: number
  readonly exited: Promise<ProcessExit>
  private stopPromise?: Promise<void>

  constructor(private readonly child: ChildProcess) {
    if (child.pid === undefined) throw new Error('Spawned module process has no pid')
    this.pid = child.pid
    this.exited = new Promise((resolve) => {
      child.once('exit', (exitCode, signal) => resolve({ exitCode, signal }))
    })
  }

  stopTree(graceMs: number): Promise<void> {
    this.stopPromise ??= this.stopTreeOnce(graceMs)
    return this.stopPromise
  }

  private async stopTreeOnce(graceMs: number): Promise<void> {
    this.signalGroup('SIGTERM')
    const groupExited = await this.waitForGroupExit(graceMs)
    if (!groupExited) {
      this.signalGroup('SIGKILL')
      if (!await this.waitForGroupExit(graceMs)) {
        throw new Error('Module process group did not exit after SIGKILL')
      }
    }
    if (!await this.waitForLeaderExit(graceMs)) {
      throw new Error('Module process leader exit event timed out')
    }
  }

  private signalGroup(signal: NodeJS.Signals): void {
    try {
      process.kill(-this.pid, signal)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ESRCH') throw error
    }
  }

  private async waitForGroupExit(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (this.groupExists() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(10, Math.max(1, deadline - Date.now()))))
    }
    return !this.groupExists()
  }

  private groupExists(): boolean {
    try {
      process.kill(-this.pid, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ESRCH'
    }
  }

  private async waitForLeaderExit(timeoutMs: number): Promise<boolean> {
    return await Promise.race([
      this.exited.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
    ])
  }
}

export class RealProcessAdapter implements ProcessAdapter {
  private readonly platform: NodeJS.Platform
  private windowsJobFactory?: WindowsJobProcessFactory

  constructor(options: RealProcessAdapterOptions = {}) {
    this.platform = options.platform ?? process.platform
    this.windowsJobFactory = options.windowsJobFactory
  }

  async spawn(request: ModuleSpawnRequest): Promise<ModuleProcess> {
    if (request.shell !== false || request.args.length !== 0) {
      throw new ModuleDaemonError('SPAWN_FAILED', 'Module processes must use shell:false with no host-supplied arguments')
    }

    if (this.platform === 'win32') {
      this.windowsJobFactory ??= new (await import('./windows-job.ts')).KoffiWindowsJobProcessFactory()
      return this.windowsJobFactory.spawn(request)
    }

    return await new Promise((resolve, reject) => {
      const child = spawn(request.executable, [], {
        cwd: request.cwd,
        env: { ...request.env },
        shell: false,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
      child.once('error', (error) => reject(new ModuleDaemonError('SPAWN_FAILED', 'Unable to spawn module daemon', { cause: error })))
      child.once('spawn', () => resolve(new RealModuleProcess(child)))
    })
  }
}

export class LoopbackHttpHealthAdapter implements HealthAdapter {
  async allocateEndpoint(signal?: AbortSignal): Promise<LoopbackEndpoint> {
    if (signal?.aborted) throw abortError()
    return await new Promise((resolve, reject) => {
      const server = createServer()
      const onAbort = (): void => {
        server.close(() => reject(abortError()))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      server.once('error', (error) => {
        signal?.removeEventListener('abort', onAbort)
        reject(new ModuleDaemonError('ENDPOINT_ALLOCATION_FAILED', 'Unable to allocate loopback health endpoint', { cause: error }))
      })
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (!address || typeof address === 'string') {
          server.close(() => reject(new ModuleDaemonError('ENDPOINT_ALLOCATION_FAILED', 'Loopback allocator returned no TCP endpoint')))
          return
        }
        server.close((error) => {
          signal?.removeEventListener('abort', onAbort)
          if (error) reject(new ModuleDaemonError('ENDPOINT_ALLOCATION_FAILED', 'Unable to release loopback endpoint reservation', { cause: error }))
          else resolve({ host: '127.0.0.1', port: address.port })
        })
      })
    })
  }

  async check(
    endpoint: LoopbackEndpoint,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<HealthProbeResult> {
    const timeout = AbortSignal.timeout(timeoutMs)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    try {
      const response = await fetch(`http://${endpoint.host}:${endpoint.port}/health`, {
        method: 'GET',
        headers: { accept: 'application/json' },
        redirect: 'error',
        signal: combined,
      })
      if (!response.ok) return { status: 'unhealthy', detail: `HTTP ${response.status}` }
      const contentType = response.headers.get('content-type') ?? ''
      if (!contentType.toLowerCase().startsWith('application/json')) {
        return { status: 'malformed', detail: 'Health response must use application/json' }
      }
      let body: unknown
      try {
        body = await response.json()
      } catch {
        return { status: 'malformed', detail: 'Health response is not valid JSON' }
      }
      if (body === null || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).length !== 1 || (body as { status?: unknown }).status !== 'healthy') {
        return { status: 'malformed', detail: 'Health response must equal {"status":"healthy"}' }
      }
      return { status: 'healthy' }
    } catch (error) {
      if (signal?.aborted) throw abortError()
      return {
        status: 'unhealthy',
        detail: error instanceof Error && error.name === 'TimeoutError' ? 'Health probe timed out' : 'Health endpoint unavailable',
      }
    }
  }
}
