import type { ModuleCoordinatorCheckpoint, ModuleViewSnapshot } from '@simulator/module-coordinator'
import type { ModuleDaemonState } from '@simulator/module-daemon'

export const OPEN_DESIGN_MODULE_ID = 'org.simulator.open-design' as const

export const OPEN_DESIGN_MODULE_CHANNELS = Object.freeze({
  GET_STATE: 'open-design-module:get-state',
  INSTALL: 'open-design-module:install',
  START: 'open-design-module:start',
  STOP: 'open-design-module:stop',
  STATE_CHANGED: 'open-design-module:state-changed',
})

export type OpenDesignModuleStatus =
  | 'disabled'
  | 'not-ready'
  | 'not-installed'
  | 'installing'
  | 'available'
  | 'running'
  | 'error'

export type OpenDesignModuleAction = 'install' | 'start' | 'stop'
export type OpenDesignModuleCheckpoint = ModuleCoordinatorCheckpoint
export type OpenDesignModuleDaemonState = ModuleDaemonState
export type OpenDesignModuleViewState = ModuleViewSnapshot['state']

export interface OpenDesignModuleProgress {
  readonly received: number
  readonly total: number
}

export interface OpenDesignModuleState {
  readonly status: OpenDesignModuleStatus
  readonly operationId?: string
  readonly checkpoint?: OpenDesignModuleCheckpoint
  readonly daemonState?: OpenDesignModuleDaemonState
  readonly viewState?: OpenDesignModuleViewState
  readonly version?: string
  readonly errorCode?: string
  readonly errorMessage?: string
  readonly progress?: OpenDesignModuleProgress
}

/** Renderer-facing facade. Every command has a fixed target and accepts no caller-controlled input. */
export interface OpenDesignModuleFacade {
  getState(): Promise<OpenDesignModuleState>
  install(): Promise<OpenDesignModuleState>
  start(): Promise<OpenDesignModuleState>
  stop(): Promise<OpenDesignModuleState>
  onStateChanged(listener: (state: OpenDesignModuleState) => void): () => void
}
