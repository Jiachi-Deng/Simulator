export type OpenDesignMutationSurface = 'ordinary' | 'acceptance'

export interface OpenDesignMutationLease {
  release(): void
}

export interface OpenDesignMutationGate {
  /**
   * Acquires the process-local OpenDesign mutation boundary synchronously.
   * Calls from the active surface may share the boundary so the ordinary
   * controller can preserve its existing same-surface serialization queue.
   */
  tryAcquire(surface: OpenDesignMutationSurface): OpenDesignMutationLease | undefined

  /**
   * Registers a safety-critical lifecycle/recovery mutation immediately, then
   * resolves after the current owner and any earlier safety waiter finish.
   * Once registered, no new UI mutation lease can be acquired ahead of it.
   */
  acquireSafety(): Promise<OpenDesignMutationLease>
}

/**
 * Prevents the ordinary Module controller and the gated acceptance controller
 * from entering their independent Coordinator paths at the same time.
 */
export function createOpenDesignMutationGate(): OpenDesignMutationGate {
  type GateOwner = OpenDesignMutationSurface | 'safety'
  interface SafetyWaiter {
    readonly resolve: (lease: OpenDesignMutationLease) => void
  }

  let owner: GateOwner | undefined
  let leaseCount = 0
  const safetyWaiters: SafetyWaiter[] = []

  const grantNextSafetyWaiter = (): void => {
    if (owner !== undefined) return
    const waiter = safetyWaiters.shift()
    if (!waiter) return
    owner = 'safety'
    leaseCount = 1
    waiter.resolve(createLease('safety'))
  }

  const createLease = (leaseOwner: GateOwner): OpenDesignMutationLease => {
    let released = false
    return Object.freeze({
      release() {
        if (released) return
        released = true
        if (owner !== leaseOwner || leaseCount <= 0) return
        leaseCount -= 1
        if (leaseCount !== 0) return
        owner = undefined
        grantNextSafetyWaiter()
      },
    })
  }

  return Object.freeze({
    tryAcquire(surface: OpenDesignMutationSurface): OpenDesignMutationLease | undefined {
      if (safetyWaiters.length > 0) return undefined
      if (owner !== undefined && owner !== surface) return undefined
      owner = surface
      leaseCount += 1
      return createLease(surface)
    },
    acquireSafety(): Promise<OpenDesignMutationLease> {
      return new Promise((resolve) => {
        safetyWaiters.push({ resolve })
        grantNextSafetyWaiter()
      })
    },
  })
}
