import type { ModuleId, ModuleVersion } from '@simulator/module-contract'
import type { ModuleUsageGuard, ModuleUsageGuardLease } from '@simulator/module-installer'

interface GateWaiter<T> {
  readonly operation: () => Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

/**
 * Serializes reference acquisition and installer mutations for each module. The gate
 * deliberately has no cross-module lock, so unrelated modules remain concurrent.
 */
export class ModuleRuntimeUseGate implements ModuleUsageGuard {
  readonly #queues = new Map<ModuleId, GateWaiter<unknown>[]>()
  readonly #active = new Set<ModuleId>()
  readonly #references = new Map<ModuleId, Map<ModuleVersion, number>>()

  async runExclusive<T>(moduleId: ModuleId, operation: (lease: ModuleUsageGuardLease) => Promise<T>): Promise<T> {
    return this.#enqueue(moduleId, async () => await operation({
      isVersionInUse: (version) => (this.#references.get(moduleId)?.get(version) ?? 0) > 0,
    }))
  }

  async acquireReference(moduleId: ModuleId, version: ModuleVersion): Promise<() => void> {
    return this.#enqueue(moduleId, async () => {
      const versions = this.#references.get(moduleId) ?? new Map<ModuleVersion, number>()
      versions.set(version, (versions.get(version) ?? 0) + 1)
      this.#references.set(moduleId, versions)
      let released = false
      return () => {
        if (released) return
        released = true
        const count = versions.get(version) ?? 0
        if (count <= 1) versions.delete(version)
        else versions.set(version, count - 1)
        if (versions.size === 0) this.#references.delete(moduleId)
      }
    })
  }

  #enqueue<T>(moduleId: ModuleId, operation: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const queue = this.#queues.get(moduleId) ?? []
      queue.push({ operation, resolve, reject } as GateWaiter<unknown>)
      this.#queues.set(moduleId, queue)
      void this.#drain(moduleId)
    })
  }

  async #drain(moduleId: ModuleId): Promise<void> {
    if (this.#active.has(moduleId)) return
    this.#active.add(moduleId)
    try {
      const queue = this.#queues.get(moduleId)
      while (queue && queue.length > 0) {
        const next = queue.shift()!
        try {
          next.resolve(await next.operation())
        } catch (error) {
          next.reject(error)
        }
      }
      if (queue?.length === 0) this.#queues.delete(moduleId)
    } finally {
      this.#active.delete(moduleId)
      if ((this.#queues.get(moduleId)?.length ?? 0) > 0) void this.#drain(moduleId)
    }
  }
}
