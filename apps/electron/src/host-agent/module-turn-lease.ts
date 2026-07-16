import type { ModuleAgentSessionPort } from '@simulator/module-agent-gateway'
import type { HostAgentRunSessionPort } from '@simulator/host-agent-run-core'
import type { HostAgentProtocolPath } from './protocol'

export interface ModuleTurnLeaseOwner {
  readonly protocol: HostAgentProtocolPath
  readonly sessionId: string
}

export interface ModuleTurnPreemptionResult {
  readonly status: 'idle' | 'stopped' | 'failed' | 'timed-out'
  readonly owner?: ModuleTurnLeaseOwner
  readonly error?: unknown
}

export class ModuleTurnLeaseBusyError extends Error {
  constructor(readonly owner: ModuleTurnLeaseOwner | undefined, message: string) {
    super(message)
    this.name = 'ModuleTurnLeaseBusyError'
  }
}

interface StoredOwner extends ModuleTurnLeaseOwner {
  readonly preempt: () => Promise<void>
}

function sameOwner(left: ModuleTurnLeaseOwner, right: ModuleTurnLeaseOwner): boolean {
  return left.protocol === right.protocol && left.sessionId === right.sessionId
}

/**
 * Main-process admission lock shared by the v1 Compatibility path and v2 Run
 * core. Acquisition mutates the owner before returning a Promise, so two
 * MessagePort requests delivered in the same event-loop turn cannot both pass.
 */
export class MainProcessModuleTurnLease {
  #owner?: StoredOwner
  #craftActive = false

  snapshot(): Readonly<{
    craftActive: boolean
    owner?: ModuleTurnLeaseOwner
  }> {
    return Object.freeze({
      craftActive: this.#craftActive,
      ...(this.#owner ? { owner: { protocol: this.#owner.protocol, sessionId: this.#owner.sessionId } } : {}),
    })
  }

  acquire(owner: ModuleTurnLeaseOwner, preempt: () => Promise<void>): void {
    if (this.#craftActive) {
      throw new ModuleTurnLeaseBusyError(this.#owner, 'A visible Craft turn has priority')
    }
    if (this.#owner && !sameOwner(this.#owner, owner)) {
      throw new ModuleTurnLeaseBusyError(this.#owner, 'Another Module provider turn is active')
    }
    if (!this.#owner) this.#owner = { ...owner, preempt }
  }

  release(owner: ModuleTurnLeaseOwner): void {
    if (this.#owner && sameOwner(this.#owner, owner)) this.#owner = undefined
  }

  markCraftActive(): ModuleTurnLeaseOwner | undefined {
    this.#craftActive = true
    return this.#owner
      ? Object.freeze({ protocol: this.#owner.protocol, sessionId: this.#owner.sessionId })
      : undefined
  }

  endCraftTurn(): void { this.#craftActive = false }

  /**
   * Bounded and failure-containing by construction. The caller may circuit
   * only the returned owner's protocol; no rejection escapes into Craft.
   */
  async preemptCurrent(timeoutMs: number): Promise<ModuleTurnPreemptionResult> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('Preemption timeout must be positive')
    const owner = this.#owner
    if (!owner) return { status: 'idle' }
    const publicOwner: ModuleTurnLeaseOwner = Object.freeze({
      protocol: owner.protocol,
      sessionId: owner.sessionId,
    })

    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<'timed-out'>((resolve) => {
      timer = setTimeout(() => resolve('timed-out'), timeoutMs)
    })
    try {
      const result = await Promise.race([
        owner.preempt().then(() => 'stopped' as const, (error) => ({ error } as const)),
        timeout,
      ])
      if (result === 'timed-out') return { status: 'timed-out', owner: publicOwner }
      if (typeof result === 'object') return { status: 'failed', owner: publicOwner, error: result.error }
      this.release(owner)
      return { status: 'stopped', owner: publicOwner }
    } catch (error) {
      return { status: 'failed', owner: publicOwner, error }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  wrapV1(port: ModuleAgentSessionPort): ModuleAgentSessionPort {
    const lease = this
    return {
      createSession: (input) => port.createSession(input),
      async sendTurn(sessionId, prompt) {
        const owner = { protocol: 'v1' as const, sessionId }
        lease.acquire(owner, async () => {
          await port.cancelTurn(sessionId).catch(() => undefined)
          await port.disposeAndReap(sessionId)
        })
        await port.sendTurn(sessionId, prompt)
      },
      cancelTurn: (sessionId) => port.cancelTurn(sessionId),
      awaitStopped: (sessionId) => port.awaitStopped(sessionId),
      async disposeAndReap(sessionId) {
        await port.disposeAndReap(sessionId)
        lease.release({ protocol: 'v1', sessionId })
      },
      subscribe: (sessionId, listener) => port.subscribe(sessionId, listener),
    }
  }

  wrapV2(port: HostAgentRunSessionPort): HostAgentRunSessionPort {
    const lease = this
    return {
      createSession: (input) => port.createSession(input),
      recoverSession: (input) => port.recoverSession(input),
      updateRunState: (sessionId, state) => port.updateRunState(sessionId, state),
      async sendTurn(sessionId, prompt) {
        const owner = { protocol: 'v2' as const, sessionId }
        lease.acquire(owner, async () => {
          await port.cancelTurn(sessionId).catch(() => undefined)
          await port.disposeAndReap(sessionId)
        })
        await port.sendTurn(sessionId, prompt)
      },
      cancelTurn: (sessionId) => port.cancelTurn(sessionId),
      awaitStopped: (sessionId) => port.awaitStopped(sessionId),
      async disposeAndReap(sessionId) {
        await port.disposeAndReap(sessionId)
        lease.release({ protocol: 'v2', sessionId })
      },
      subscribe: (sessionId, listener) => port.subscribe(sessionId, listener),
    }
  }
}
