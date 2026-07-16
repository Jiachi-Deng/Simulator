import { MessageChannelMain, utilityProcess, type MessagePortMain, type UtilityProcess } from 'electron'
import { join } from 'node:path'
import type { HostAgentMessagePortLike } from '@simulator/host-agent-broker/message-port'
import type {
  HostAgentWorkerHandle,
  HostAgentWorkerLaunchInput,
  HostAgentWorkerLauncher,
} from './supervisor'

export interface ElectronHostAgentWorkerLauncherOptions {
  workerEntryPath: string
  cwd?: string
  baseEnvironment?: NodeJS.ProcessEnv
}

export function resolveHostAgentWorkerEntry(appPath: string): string {
  return join(appPath, 'dist/resources/host-agent/worker.cjs')
}

function safeWorkerEnvironment(base: NodeJS.ProcessEnv, input: HostAgentWorkerLaunchInput): Record<string, string> {
  const environment: Record<string, string> = {}
  for (const key of ['PATH', 'HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL']) {
    const value = base[key]
    if (value) environment[key] = value
  }
  environment.SIMULATOR_HOST_AGENT_PROTOCOL = input.protocol
  environment.SIMULATOR_HOST_AGENT_WORKER_EPOCH = input.epoch
  environment.SIMULATOR_HOST_AGENT_TOKEN_FILE = input.tokenFile
  environment.SIMULATOR_HOST_AGENT_MAX_RSS_BYTES = String(input.maxRssBytes)
  environment.SIMULATOR_HOST_AGENT_HEALTH_INTERVAL_MS = String(input.healthIntervalMs)
  return environment
}

class ElectronHostAgentWorkerHandle implements HostAgentWorkerHandle {
  readonly #child: UtilityProcess
  readonly #controlPort: MessagePortMain
  readonly #rpcPort: MessagePortMain
  readonly #exitListeners = new Set<(code: number) => void>()
  #exitCode: number | undefined

  constructor(child: UtilityProcess, controlPort: MessagePortMain, rpcPort: MessagePortMain) {
    this.#child = child
    this.#controlPort = controlPort
    this.#rpcPort = rpcPort
    // Capture exit immediately when the handle is constructed. The supervisor
    // installs its listener after launch() resolves, so forwarding Electron's
    // event directly would otherwise lose a same-turn early exit ACK.
    child.once('exit', (code) => {
      if (this.#exitCode !== undefined) return
      this.#exitCode = code
      for (const listener of [...this.#exitListeners]) listener(code)
      this.#exitListeners.clear()
    })
    controlPort.start()
  }

  get pid(): number | undefined { return this.#child.pid }
  get rpcPort(): HostAgentMessagePortLike { return this.#rpcPort as unknown as HostAgentMessagePortLike }

  send(message: Parameters<HostAgentWorkerHandle['send']>[0]): void {
    this.#controlPort.postMessage(message)
  }

  terminate(): boolean { return this.#child.kill() }

  closeChannel(): void {
    this.#controlPort.close()
    this.#rpcPort.close()
  }

  onMessage(listener: (message: unknown) => void): () => void {
    const wrapped = (event: Electron.MessageEvent): void => listener(event.data)
    const direct = (message: unknown): void => listener(message)
    this.#controlPort.on('message', wrapped)
    this.#child.on('message', direct)
    return () => {
      this.#controlPort.off('message', wrapped)
      this.#child.off('message', direct)
    }
  }

  onExit(listener: (code: number) => void): () => void {
    let active = true
    if (this.#exitCode !== undefined) {
      const code = this.#exitCode
      queueMicrotask(() => { if (active) listener(code) })
    } else {
      this.#exitListeners.add(listener)
    }
    return () => {
      active = false
      this.#exitListeners.delete(listener)
    }
  }
}

/** Electron-only launcher; call after app.ready. */
export class ElectronHostAgentWorkerLauncher implements HostAgentWorkerLauncher {
  readonly #options: ElectronHostAgentWorkerLauncherOptions

  constructor(options: ElectronHostAgentWorkerLauncherOptions) {
    this.#options = options
  }

  async launch(input: HostAgentWorkerLaunchInput): Promise<HostAgentWorkerHandle> {
    const control = new MessageChannelMain()
    const rpc = new MessageChannelMain()
    const child = utilityProcess.fork(this.#options.workerEntryPath, [], {
      cwd: this.#options.cwd,
      env: safeWorkerEnvironment(this.#options.baseEnvironment ?? process.env, input),
      execArgv: [`--max-old-space-size=${input.maxHeapMiB}`],
      stdio: 'ignore',
      serviceName: `Simulator Host Agent ${input.protocol}`,
      allowLoadingUnsignedLibraries: false,
    })
    const handle = new ElectronHostAgentWorkerHandle(child, control.port1, rpc.port1)
    child.once('spawn', () => {
      child.postMessage({
        kind: 'simulator.host-agent.attach',
        protocol: input.protocol,
        epoch: input.epoch,
      }, [control.port2, rpc.port2])
    })
    // Electron guarantees an exit event after a FatalError. Handling the error
    // itself here would double-count one crash and risk cross-path side effects.
    child.on('error', () => undefined)
    return handle
  }
}
