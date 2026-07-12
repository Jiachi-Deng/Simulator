import type {
  ModuleRegistryPersistence,
  PersistedModuleRegistryStateV1,
  RegistryPersistenceRead,
} from './types.ts'

function cloneData<T>(value: T): T {
  return structuredClone(value)
}

export class InMemoryModuleRegistryPersistence implements ModuleRegistryPersistence {
  private committed: unknown | null
  private staged: PersistedModuleRegistryStateV1 | null = null
  private interruptNext = false

  constructor(initialCommitted: unknown | null = null) {
    this.committed = initialCommitted
  }

  read(): RegistryPersistenceRead {
    return {
      committed: this.committed === null ? null : cloneData(this.committed),
      interruptedCommit: this.staged !== null,
    }
  }

  commit(state: PersistedModuleRegistryStateV1): void {
    this.staged = cloneData(state)
    if (this.interruptNext) {
      this.interruptNext = false
      throw new Error('Simulated registry persistence interruption')
    }
    this.committed = this.staged
    this.staged = null
  }

  interruptNextCommit(): void {
    this.interruptNext = true
  }

  clearInterruptedCommit(): void {
    this.staged = null
  }
}
