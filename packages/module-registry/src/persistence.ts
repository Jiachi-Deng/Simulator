import type {
  ModuleRegistryPersistence,
  PersistedModuleRegistryStateV1,
  RegistryPersistenceCommit,
  RegistryPersistenceRead,
} from './types.ts'

function cloneData<T>(value: T): T {
  return structuredClone(value)
}

export class InMemoryModuleRegistryPersistence implements ModuleRegistryPersistence {
  private committed: unknown | null
  private staged: PersistedModuleRegistryStateV1 | null = null
  private interruptNext = false
  private revision = 0

  constructor(initialCommitted: unknown | null = null) {
    this.committed = initialCommitted === null ? null : cloneData(initialCommitted)
  }

  read(): RegistryPersistenceRead {
    return {
      committed: this.committed === null ? null : cloneData(this.committed),
      interruptedCommit: this.staged !== null,
      revision: String(this.revision),
    }
  }

  commit(state: PersistedModuleRegistryStateV1, expectedRevision: string): RegistryPersistenceCommit {
    if (expectedRevision !== String(this.revision)) {
      return { ok: false, revision: String(this.revision) }
    }
    this.staged = cloneData(state)
    if (this.interruptNext) {
      this.interruptNext = false
      throw new Error('Simulated registry persistence interruption')
    }
    this.committed = this.staged
    this.staged = null
    this.revision += 1
    return { ok: true, revision: String(this.revision) }
  }

  interruptNextCommit(): void {
    this.interruptNext = true
  }

  clearInterruptedCommit(): void {
    this.staged = null
  }
}
