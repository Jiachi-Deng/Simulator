import type {
  ModuleHealth,
  ModuleLifecycleOperation,
  ModuleLifecycleResult,
  ModuleLifecycleState,
  ModuleRuntime,
} from '../lifecycle.ts'
import type { ModuleManifest } from '../manifest-types.ts'

export interface FakeModuleTransition {
  readonly sequence: number
  readonly operation: Exclude<ModuleLifecycleOperation, 'health'>
  readonly from: ModuleLifecycleState
  readonly to: ModuleLifecycleState
}

function immutable<T>(value: T): Readonly<T> {
  return Object.freeze(value)
}

export class FakeModule implements ModuleRuntime {
  readonly manifest: ModuleManifest
  #state: ModuleLifecycleState = 'uninstalled'
  #transitions: FakeModuleTransition[] = []

  constructor(manifest: ModuleManifest) {
    this.manifest = manifest
  }

  get state(): ModuleLifecycleState {
    return this.#state
  }

  get transitions(): readonly FakeModuleTransition[] {
    return immutable(this.#transitions.map((transition) => immutable({ ...transition })))
  }

  async install(): Promise<ModuleLifecycleResult<ModuleLifecycleState>> {
    if (this.#state !== 'uninstalled') return this.#invalidState('install')
    return this.#transition('install', 'installed')
  }

  async start(): Promise<ModuleLifecycleResult<ModuleLifecycleState>> {
    if (this.#state !== 'installed' && this.#state !== 'stopped') return this.#invalidState('start')
    return this.#transition('start', 'running')
  }

  async health(): Promise<ModuleLifecycleResult<ModuleHealth>> {
    const value: ModuleHealth = {
      status: this.#state === 'running' ? 'healthy' : 'not-running',
      state: this.#state,
    }
    return immutable({
      ok: true,
      value: immutable(value),
    })
  }

  async stop(): Promise<ModuleLifecycleResult<ModuleLifecycleState>> {
    if (this.#state !== 'running') return this.#invalidState('stop')
    return this.#transition('stop', 'stopped')
  }

  #transition(
    operation: FakeModuleTransition['operation'],
    to: ModuleLifecycleState,
  ): ModuleLifecycleResult<ModuleLifecycleState> {
    const from = this.#state
    this.#state = to
    this.#transitions.push(immutable({ sequence: this.#transitions.length + 1, operation, from, to }))
    return immutable({ ok: true, value: to })
  }

  #invalidState(operation: ModuleLifecycleOperation): ModuleLifecycleResult<never> {
    return immutable({
      ok: false,
      error: immutable({
        code: 'INVALID_STATE',
        operation,
        state: this.#state,
        message: `Cannot ${operation} module while state is ${this.#state}`,
      }),
    })
  }
}
