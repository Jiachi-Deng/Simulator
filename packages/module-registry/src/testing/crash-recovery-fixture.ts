import type { ModuleRegistryHost } from '../types.ts'
import { InMemoryModuleRegistryPersistence } from '../persistence.ts'
import { ModuleRegistry } from '../registry.ts'

export class RegistryCrashRecoveryFixture {
  readonly builtInAgent = Object.freeze({ available: true as const })
  readonly persistence: InMemoryModuleRegistryPersistence
  readonly host: ModuleRegistryHost

  constructor(host: ModuleRegistryHost, initialCommitted: unknown | null = null) {
    this.host = Object.freeze({ ...host })
    this.persistence = new InMemoryModuleRegistryPersistence(initialCommitted)
  }

  start(host: ModuleRegistryHost = this.host): ModuleRegistry {
    return new ModuleRegistry(host, this.persistence)
  }

  interruptNextCommit(): void {
    this.persistence.interruptNextCommit()
  }
}
