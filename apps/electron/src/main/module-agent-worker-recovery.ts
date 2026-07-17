import { randomUUID } from 'node:crypto'
import type { ModuleId } from '@simulator/module-contract'
import type { HostAgentProtocolPath } from '../host-agent/protocol'
import type { HostAgentWorkerFailure } from '../host-agent/supervisor'
import type { HostModuleCoordinatorRuntime } from './host-module-coordinator'
import type { OpenDesignMutationGate } from './open-design-mutation-gate'

export interface ModuleAgentWorkerRecoveryRequest {
  readonly protocol: HostAgentProtocolPath
  readonly epoch: string
  readonly failure: HostAgentWorkerFailure | 'grant-expiring'
  readonly circuitOpen: boolean
}

export type ModuleAgentWorkerRecoveryPhase = 'restart' | 'fallback-stop' | 'circuit-stop'

export interface ModuleAgentWorkerRecoveryControllerOptions {
  readonly moduleId: ModuleId
  readonly getRuntime: () => HostModuleCoordinatorRuntime | null
  readonly mutationGate: OpenDesignMutationGate
  readonly isShuttingDown: () => boolean
  readonly protocolForVersion: (version: string) => HostAgentProtocolPath
  readonly createOperationId?: (phase: ModuleAgentWorkerRecoveryPhase) => string
  readonly onFailure?: (
    phase: ModuleAgentWorkerRecoveryPhase,
    request: ModuleAgentWorkerRecoveryRequest,
    error: unknown,
  ) => void
}

const RECOVERABLE_DAEMON_STATES = new Set(['starting', 'healthy', 'degraded'])

/**
 * Serializes optional-Module recovery without ever joining it to Electron's
 * primary Craft lifecycle. A Worker exit fails the in-flight Turn; this class
 * rotates the daemon launch lease after an exit or before grant expiry so a
 * later explicit retry receives a fresh Worker epoch and token.
 */
export class ModuleAgentWorkerRecoveryController {
  readonly #options: ModuleAgentWorkerRecoveryControllerOptions
  #tail: Promise<void> = Promise.resolve()
  #disposed = false

  constructor(options: ModuleAgentWorkerRecoveryControllerOptions) {
    this.#options = options
  }

  request(input: ModuleAgentWorkerRecoveryRequest): void {
    if (this.#disposed) return
    const request = Object.freeze({ ...input })
    const operation = this.#tail.then(async () => this.#recover(request))
    this.#tail = operation.catch(() => undefined)
  }

  async drain(): Promise<void> {
    await this.#tail
  }

  dispose(): void {
    this.#disposed = true
  }

  async #recover(request: ModuleAgentWorkerRecoveryRequest): Promise<void> {
    if (this.#disposed || this.#options.isShuttingDown()) return
    const mutationLease = await this.#options.mutationGate.acquireSafety()
    try {
      // State is intentionally read only after acquiring the safety boundary:
      // an update/rollback may have changed the active daemon while recovery waited.
      if (this.#disposed || this.#options.isShuttingDown()) return
      const runtime = this.#options.getRuntime()
      if (!runtime) return
      const daemon = runtime.daemon.get(this.#options.moduleId)
      if (!daemon || !RECOVERABLE_DAEMON_STATES.has(daemon.state)) return

      let activeProtocol: HostAgentProtocolPath
      try {
        activeProtocol = this.#options.protocolForVersion(daemon.version)
      } catch {
        // An unsupported active version must not be restarted with a guessed
        // contract. Stop the optional path and keep the primary Host alive.
        await this.#stop(runtime, request, 'circuit-stop')
        return
      }
      if (activeProtocol !== request.protocol) return

      if (request.circuitOpen) {
        await this.#stop(runtime, request, 'circuit-stop')
        return
      }

      try {
        const result = await runtime.coordinator.restart({
          moduleId: this.#options.moduleId,
          operationId: this.#operationId('restart'),
        })
        if (result.ok || this.#options.isShuttingDown()) return
        this.#report('restart', request, new Error(result.error ?? 'Module restart failed'))
      } catch (error) {
        this.#report('restart', request, error)
        if (this.#options.isShuttingDown()) return
      }

      // A failed lease rotation leaves the Module unable to prove which token,
      // epoch, or provider state it owns. Fail closed by stopping only that
      // Module; never quit Electron or dispose primary Host dependencies here.
      await this.#stop(runtime, request, 'fallback-stop')
    } finally {
      mutationLease.release()
    }
  }

  async #stop(
    runtime: HostModuleCoordinatorRuntime,
    request: ModuleAgentWorkerRecoveryRequest,
    phase: 'fallback-stop' | 'circuit-stop',
  ): Promise<void> {
    if (this.#options.isShuttingDown()) return
    try {
      const result = await runtime.coordinator.stop({
        moduleId: this.#options.moduleId,
        operationId: this.#operationId(phase),
      })
      if (!result.ok) this.#report(phase, request, new Error(result.error ?? 'Module stop failed'))
    } catch (error) {
      this.#report(phase, request, error)
    }
  }

  #operationId(phase: ModuleAgentWorkerRecoveryPhase): string {
    return this.#options.createOperationId?.(phase)
      ?? `host-agent-${phase}-${Date.now().toString(36)}-${randomUUID()}`
  }

  #report(
    phase: ModuleAgentWorkerRecoveryPhase,
    request: ModuleAgentWorkerRecoveryRequest,
    error: unknown,
  ): void {
    try { this.#options.onFailure?.(phase, request, error) } catch {
      // Diagnostics are outside the optional Module isolation boundary.
    }
  }
}
