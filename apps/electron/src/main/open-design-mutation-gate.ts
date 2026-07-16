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
}

/**
 * Prevents the ordinary Module controller and the gated acceptance controller
 * from entering their independent Coordinator paths at the same time.
 */
export function createOpenDesignMutationGate(): OpenDesignMutationGate {
  let owner: OpenDesignMutationSurface | undefined
  let leaseCount = 0

  return Object.freeze({
    tryAcquire(surface: OpenDesignMutationSurface): OpenDesignMutationLease | undefined {
      if (owner !== undefined && owner !== surface) return undefined
      owner = surface
      leaseCount += 1
      let released = false
      return Object.freeze({
        release() {
          if (released) return
          released = true
          leaseCount -= 1
          if (leaseCount === 0) owner = undefined
        },
      })
    },
  })
}
