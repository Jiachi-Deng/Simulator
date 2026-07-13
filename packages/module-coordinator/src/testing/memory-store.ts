import {
  MODULE_COORDINATOR_STATE_SCHEMA_VERSION,
  type ModuleCoordinatorState,
  type ModuleCoordinatorStore,
} from '../types.ts'

export class InMemoryModuleCoordinatorStore implements ModuleCoordinatorStore {
  state: ModuleCoordinatorState | undefined
  saves = 0

  constructor(initial?: ModuleCoordinatorState) {
    this.state = initial ? structuredClone(initial) : undefined
  }

  async load(): Promise<ModuleCoordinatorState | undefined> {
    return this.state ? structuredClone(this.state) : undefined
  }

  async save(state: ModuleCoordinatorState): Promise<void> {
    if (state.schemaVersion !== MODULE_COORDINATOR_STATE_SCHEMA_VERSION) throw new Error('Unexpected schema version')
    this.saves += 1
    this.state = structuredClone(state)
  }
}
