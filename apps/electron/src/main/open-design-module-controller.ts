import { randomUUID } from 'node:crypto'
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'
import type { ModuleId } from '@simulator/module-contract'
import type {
  ModuleCoordinator,
  ModuleCoordinatorInstallRequest,
  ModuleCoordinatorOperation,
  ModuleCoordinatorOperationResult,
  ModuleCoordinatorSnapshot,
  ModuleViewPort,
  ModuleViewSnapshot,
} from '@simulator/module-coordinator'
import type { ModuleDaemonManager, ModuleDaemonSnapshot } from '@simulator/module-daemon'
import type { ModuleRegistry, ModuleRegistrySnapshot } from '@simulator/module-registry'
import {
  OPEN_DESIGN_MODULE_CHANNELS,
  OPEN_DESIGN_MODULE_ID,
  type OpenDesignModuleAction,
  type OpenDesignModuleProgress,
  type OpenDesignModuleState,
} from '../shared/open-design-module-ipc'

const POLL_INTERVAL_MS = 150
const OPEN_DESIGN_COORDINATOR_MODULE_ID = OPEN_DESIGN_MODULE_ID as ModuleId

type Awaitable<T> = T | Promise<T>

export interface OpenDesignModuleRuntime {
  readonly coordinator: Pick<ModuleCoordinator, 'install' | 'start' | 'stop' | 'snapshot'>
  readonly registry: Pick<ModuleRegistry, 'snapshot'>
  readonly daemon: Pick<ModuleDaemonManager, 'get' | 'subscribe'>
  readonly view: Pick<ModuleViewPort, 'query'>
}

export type OpenDesignModuleRuntimeLookup =
  | { readonly status: 'disabled' }
  | { readonly status: 'not-ready'; readonly errorCode?: string; readonly errorMessage?: string }
  | { readonly status: 'ready'; readonly runtime: OpenDesignModuleRuntime }

export interface OpenDesignModuleHostAdapter {
  isAllowedSender(sender: unknown): boolean
  emitState(state: OpenDesignModuleState): void
}

export interface OpenDesignModuleClock {
  now(): number
  setTimeout(callback: () => void, milliseconds: number): () => void
}

export interface OpenDesignModuleControllerOptions {
  readonly getRuntime: () => OpenDesignModuleRuntimeLookup
  readonly getInstallRequest: () => Awaitable<ModuleCoordinatorInstallRequest | undefined>
  readonly host: OpenDesignModuleHostAdapter
  readonly clock?: OpenDesignModuleClock
}

export interface OpenDesignModuleSafeError {
  readonly code: string
  readonly message: string
}

interface ActiveOperation {
  readonly action: OpenDesignModuleAction
  readonly operationId: string
  version?: string
  progress?: OpenDesignModuleProgress
}

export interface OpenDesignModuleReducerInput {
  readonly availability: OpenDesignModuleRuntimeLookup['status']
  readonly availabilityError?: OpenDesignModuleSafeError
  readonly coordinator?: ModuleCoordinatorSnapshot
  readonly registry?: ModuleRegistrySnapshot
  readonly daemon?: ModuleDaemonSnapshot
  readonly view?: ModuleViewSnapshot
  readonly activeOperation?: Readonly<ActiveOperation>
  readonly error?: OpenDesignModuleSafeError
}

class OpenDesignModuleControllerError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'OpenDesignModuleControllerError'
  }
}

const defaultClock: OpenDesignModuleClock = Object.freeze({
  now: () => Date.now(),
  setTimeout(callback: () => void, milliseconds: number) {
    const timer = setTimeout(callback, milliseconds)
    return () => clearTimeout(timer)
  },
})

function latestOperation(snapshot: ModuleCoordinatorSnapshot | undefined): ModuleCoordinatorOperation | undefined {
  let latest: ModuleCoordinatorOperation | undefined
  for (const operation of snapshot?.operations ?? []) {
    if (operation.moduleId !== OPEN_DESIGN_MODULE_ID) continue
    if (!latest
      || operation.updatedAt > latest.updatedAt
      || (operation.updatedAt === latest.updatedAt && operation.createdAt > latest.createdAt)
      || (operation.updatedAt === latest.updatedAt && operation.createdAt === latest.createdAt
        && operation.id.localeCompare(latest.id) > 0)) {
      latest = operation
    }
  }
  return latest
}

function operationForState(input: OpenDesignModuleReducerInput): ModuleCoordinatorOperation | undefined {
  if (!input.activeOperation) return latestOperation(input.coordinator)
  return input.coordinator?.operations.find((operation) => operation.id === input.activeOperation?.operationId)
}

function operationVersion(operation: ModuleCoordinatorOperation | undefined): string | undefined {
  if (!operation || (operation.kind !== 'install' && operation.kind !== 'update')) return undefined
  return (operation.request as ModuleCoordinatorInstallRequest).descriptor.manifest.version
}

function safeOperationFailure(operation: ModuleCoordinatorOperation): OpenDesignModuleSafeError {
  return {
    code: `COORDINATOR_${operation.kind.toUpperCase()}_FAILED`,
    message: 'OpenDesign could not complete the requested operation.',
  }
}

function stateError(
  error: OpenDesignModuleSafeError,
  common: Omit<OpenDesignModuleState, 'status' | 'errorCode' | 'errorMessage'>,
): OpenDesignModuleState {
  return Object.freeze({
    status: 'error',
    ...common,
    errorCode: error.code,
    errorMessage: error.message,
  })
}

/** Pure projection of current coordinator, registry, daemon, and view observations. */
export function reduceOpenDesignModuleState(input: OpenDesignModuleReducerInput): OpenDesignModuleState {
  if (input.availability === 'disabled') return Object.freeze({ status: 'disabled' })
  if (input.availability === 'not-ready') {
    return Object.freeze({
      status: 'not-ready',
      ...(input.availabilityError ? {
        errorCode: input.availabilityError.code,
        errorMessage: input.availabilityError.message,
      } : {}),
    })
  }

  const installed = input.registry?.modules.find((module) => module.id === OPEN_DESIGN_MODULE_ID)
  const operation = operationForState(input)
  const operationId = input.activeOperation?.operationId ?? operation?.id
  const version = installed?.activeVersion
    ?? input.daemon?.version
    ?? input.view?.version
    ?? input.activeOperation?.version
    ?? operationVersion(operation)
  const common = {
    ...(operationId ? { operationId } : {}),
    ...(operation?.checkpoint ? { checkpoint: operation.checkpoint } : {}),
    ...(input.daemon?.state ? { daemonState: input.daemon.state } : {}),
    ...(input.view?.state ? { viewState: input.view.state } : {}),
    ...(version ? { version } : {}),
    ...(input.activeOperation?.progress ? { progress: input.activeOperation.progress } : {}),
  } satisfies Omit<OpenDesignModuleState, 'status' | 'errorCode' | 'errorMessage'>

  if (input.error) return stateError(input.error, common)
  if (input.daemon?.state === 'crashed') {
    return stateError({
      code: input.daemon.diagnostic?.code ? `DAEMON_${input.daemon.diagnostic.code}` : 'DAEMON_CRASHED',
      message: 'OpenDesign stopped unexpectedly.',
    }, common)
  }
  if (input.view?.state === 'crashed') {
    return stateError({
      code: 'VIEW_CRASHED',
      message: 'The OpenDesign view is unavailable.',
    }, common)
  }
  if (operation?.status === 'failed' || operation?.result?.ok === false) {
    return stateError(safeOperationFailure(operation), common)
  }
  if (installed?.disabled) return Object.freeze({ status: 'disabled', ...common })

  const installing = input.activeOperation?.action === 'install'
    || ((operation?.kind === 'install' || operation?.kind === 'update') && operation.status === 'pending')
  if (installing) return Object.freeze({ status: 'installing', ...common })

  const daemonRunning = input.daemon !== undefined
    && input.daemon.state !== 'stopped'
  const viewRunning = input.view?.state === 'attaching' || input.view?.state === 'attached'
  if (daemonRunning || viewRunning) return Object.freeze({ status: 'running', ...common })

  if (installed?.activeVersion) return Object.freeze({ status: 'available', ...common })
  if (installed && installed.versions.length > 0) {
    return stateError({
      code: 'ACTIVE_VERSION_MISSING',
      message: 'The OpenDesign installation is not ready to start.',
    }, common)
  }
  return Object.freeze({ status: 'not-installed', ...common })
}

function safeActionError(action: OpenDesignModuleAction, error: unknown): OpenDesignModuleSafeError {
  if (error instanceof OpenDesignModuleControllerError) {
    return { code: error.code, message: error.message }
  }
  return {
    code: `OPEN_DESIGN_${action.toUpperCase()}_FAILED`,
    message: `OpenDesign could not be ${action === 'install' ? 'installed' : action === 'start' ? 'started' : 'stopped'}.`,
  }
}

function failedResultError(action: OpenDesignModuleAction): OpenDesignModuleSafeError {
  return {
    code: `OPEN_DESIGN_${action.toUpperCase()}_FAILED`,
    message: `OpenDesign could not be ${action === 'install' ? 'installed' : action === 'start' ? 'started' : 'stopped'}.`,
  }
}

export function createOpenDesignModuleBrowserWindowAdapter(
  getHostWindow: () => BrowserWindow | undefined,
): OpenDesignModuleHostAdapter {
  const liveWebContents = () => {
    const window = getHostWindow()
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return undefined
    return window.webContents
  }
  return {
    isAllowedSender: (sender) => liveWebContents() === sender,
    emitState(state) {
      liveWebContents()?.send(OPEN_DESIGN_MODULE_CHANNELS.STATE_CHANGED, state)
    },
  }
}

export class OpenDesignModuleController {
  readonly #options: OpenDesignModuleControllerOptions
  readonly #clock: OpenDesignModuleClock
  readonly #flights = new Map<OpenDesignModuleAction, Promise<OpenDesignModuleState>>()
  #tail: Promise<unknown> = Promise.resolve()
  #activeOperation?: ActiveOperation
  #lastError?: OpenDesignModuleSafeError
  #subscriptionRuntime?: OpenDesignModuleRuntime
  #unsubscribeDaemon?: () => void
  #cancelPoll?: () => void
  #publishFlight?: Promise<void>
  #pollGeneration = 0
  #disposed = false

  constructor(options: OpenDesignModuleControllerOptions) {
    this.#options = options
    this.#clock = options.clock ?? defaultClock
    this.#refreshSubscription()
  }

  isAllowedSender(sender: unknown): boolean {
    try {
      return this.#options.host.isAllowedSender(sender)
    } catch {
      return false
    }
  }

  async getState(): Promise<OpenDesignModuleState> {
    if (this.#disposed) {
      return reduceOpenDesignModuleState({
        availability: 'ready',
        error: { code: 'CONTROLLER_DISPOSED', message: 'OpenDesign is no longer available.' },
      })
    }

    const lookup = this.#runtimeLookup()
    if (lookup.status !== 'ready') {
      this.#clearSubscription()
      return reduceOpenDesignModuleState({
        availability: lookup.status,
        ...(lookup.status === 'not-ready' && lookup.errorCode ? {
          availabilityError: {
            code: lookup.errorCode,
            message: lookup.errorMessage ?? 'OpenDesign is not ready.',
          },
        } : {}),
      })
    }
    this.#ensureSubscription(lookup.runtime)

    try {
      const coordinator = await lookup.runtime.coordinator.snapshot()
      const registry = lookup.runtime.registry.snapshot()
      const daemon = lookup.runtime.daemon.get(OPEN_DESIGN_COORDINATOR_MODULE_ID)
      const view = await lookup.runtime.view.query(OPEN_DESIGN_COORDINATOR_MODULE_ID)
      return reduceOpenDesignModuleState({
        availability: 'ready',
        coordinator,
        registry,
        daemon,
        view,
        activeOperation: this.#activeOperation,
        error: this.#lastError,
      })
    } catch {
      return reduceOpenDesignModuleState({
        availability: 'ready',
        activeOperation: this.#activeOperation,
        error: this.#lastError ?? {
          code: 'STATE_UNAVAILABLE',
          message: 'OpenDesign state is temporarily unavailable.',
        },
      })
    }
  }

  install(): Promise<OpenDesignModuleState> {
    return this.#run('install', async (runtime, operationId) => {
      const request = await this.#options.getInstallRequest()
      if (!request) {
        throw new OpenDesignModuleControllerError(
          'DEVELOPMENT_BUNDLE_NOT_READY',
          'The verified OpenDesign development bundle is not ready.',
        )
      }
      if (request.descriptor.manifest.id !== OPEN_DESIGN_MODULE_ID) {
        throw new OpenDesignModuleControllerError(
          'INSTALL_REQUEST_MODULE_MISMATCH',
          'The verified development bundle does not target OpenDesign.',
        )
      }
      if (this.#activeOperation) this.#activeOperation.version = request.descriptor.manifest.version
      return runtime.coordinator.install({ ...request, operationId })
    })
  }

  start(): Promise<OpenDesignModuleState> {
    return this.#run('start', (runtime, operationId) => runtime.coordinator.start({
      moduleId: OPEN_DESIGN_COORDINATOR_MODULE_ID,
      operationId,
    }))
  }

  stop(): Promise<OpenDesignModuleState> {
    return this.#run('stop', (runtime, operationId) => runtime.coordinator.stop({
      moduleId: OPEN_DESIGN_COORDINATOR_MODULE_ID,
      operationId,
    }))
  }

  /** Single host-view escape hatch; integration should route host.close here instead of destroying the view. */
  stopForHostView(): Promise<OpenDesignModuleState> {
    return this.stop()
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#stopPolling()
    this.#clearSubscription()
  }

  #run(
    action: OpenDesignModuleAction,
    operation: (runtime: OpenDesignModuleRuntime, operationId: string) => Promise<ModuleCoordinatorOperationResult>,
  ): Promise<OpenDesignModuleState> {
    const existing = this.#flights.get(action)
    if (existing) return existing

    const operationId = `open-design-${action}-${this.#clock.now().toString(36)}-${randomUUID()}`
    const flight = this.#tail
      .catch(() => undefined)
      .then(() => this.#execute(action, operationId, operation))
    this.#tail = flight.catch(() => undefined)
    this.#flights.set(action, flight)
    void flight.finally(() => {
      if (this.#flights.get(action) === flight) this.#flights.delete(action)
    }).catch(() => undefined)
    return flight
  }

  async #execute(
    action: OpenDesignModuleAction,
    operationId: string,
    operation: (runtime: OpenDesignModuleRuntime, operationId: string) => Promise<ModuleCoordinatorOperationResult>,
  ): Promise<OpenDesignModuleState> {
    if (this.#disposed) return this.getState()
    const lookup = this.#runtimeLookup()
    if (lookup.status !== 'ready') {
      return reduceOpenDesignModuleState({
        availability: lookup.status,
        ...(lookup.status === 'not-ready' && lookup.errorCode ? {
          availabilityError: {
            code: lookup.errorCode,
            message: lookup.errorMessage ?? 'OpenDesign is not ready.',
          },
        } : {}),
      })
    }
    this.#ensureSubscription(lookup.runtime)

    this.#lastError = undefined
    this.#activeOperation = { action, operationId }
    this.#startPolling()
    await this.#publishCurrentState()
    try {
      const result = await operation(lookup.runtime, operationId)
      if (!result.ok) this.#lastError = failedResultError(action)
    } catch (error) {
      this.#lastError = safeActionError(action, error)
    } finally {
      this.#stopPolling()
      this.#activeOperation = undefined
    }

    const state = await this.getState()
    this.#emit(state)
    return state
  }

  #runtimeLookup(): OpenDesignModuleRuntimeLookup {
    try {
      return this.#options.getRuntime()
    } catch {
      return {
        status: 'not-ready',
        errorCode: 'RUNTIME_LOOKUP_FAILED',
        errorMessage: 'OpenDesign runtime discovery failed.',
      }
    }
  }

  #refreshSubscription(): void {
    const lookup = this.#runtimeLookup()
    if (lookup.status === 'ready') this.#ensureSubscription(lookup.runtime)
  }

  #ensureSubscription(runtime: OpenDesignModuleRuntime): void {
    if (this.#disposed || this.#subscriptionRuntime === runtime) return
    this.#clearSubscription()
    this.#subscriptionRuntime = runtime
    try {
      const unsubscribe = runtime.daemon.subscribe((snapshot) => {
        if (snapshot.id !== OPEN_DESIGN_MODULE_ID || this.#disposed) return
        void this.#publishCurrentState()
      })
      if (this.#lastError?.code === 'DAEMON_SUBSCRIPTION_FAILED') this.#lastError = undefined
      this.#unsubscribeDaemon = () => {
        try {
          unsubscribe()
        } catch {
          // Teardown is best-effort and must not destabilize the host.
        }
      }
    } catch {
      this.#subscriptionRuntime = undefined
      this.#lastError ??= {
        code: 'DAEMON_SUBSCRIPTION_FAILED',
        message: 'OpenDesign state updates are temporarily unavailable.',
      }
    }
  }

  #clearSubscription(): void {
    this.#unsubscribeDaemon?.()
    this.#unsubscribeDaemon = undefined
    this.#subscriptionRuntime = undefined
  }

  #startPolling(): void {
    this.#stopPolling()
    const generation = this.#pollGeneration
    const schedule = () => {
      if (this.#disposed || !this.#activeOperation || generation !== this.#pollGeneration) return
      try {
        this.#cancelPoll = this.#clock.setTimeout(() => {
          this.#cancelPoll = undefined
          if (this.#disposed || !this.#activeOperation || generation !== this.#pollGeneration) return
          void this.#publishCurrentState().finally(schedule)
        }, POLL_INTERVAL_MS)
      } catch {
        this.#lastError ??= {
          code: 'POLLING_UNAVAILABLE',
          message: 'OpenDesign operation progress is temporarily unavailable.',
        }
      }
    }
    schedule()
  }

  #stopPolling(): void {
    this.#pollGeneration += 1
    this.#cancelPoll?.()
    this.#cancelPoll = undefined
  }

  async #publishCurrentState(): Promise<void> {
    if (this.#publishFlight) return this.#publishFlight
    const flight = (async () => {
      try {
        const state = await this.getState()
        this.#emit(state)
      } catch {
        // Publication is observational and must not reject controller operations.
      }
    })()
    this.#publishFlight = flight
    void flight.finally(() => {
      if (this.#publishFlight === flight) this.#publishFlight = undefined
    }).catch(() => undefined)
    return flight
  }

  #emit(state: OpenDesignModuleState): void {
    if (this.#disposed) return
    try {
      this.#options.host.emitState(state)
    } catch {
      // A destroyed renderer or throwing subscriber cannot break controller work.
    }
  }
}

export interface OpenDesignModuleIpcRegistration {
  dispose(): void
}

const ipcRegistrations = new WeakMap<object, OpenDesignModuleIpcRegistration>()

function assertIpcInvocation(
  controller: OpenDesignModuleController,
  event: IpcMainInvokeEvent,
  args: readonly unknown[],
): void {
  if (!controller.isAllowedSender(event.sender)) throw new Error('OpenDesign IPC sender was rejected')
  if (args.length !== 0) throw new Error('OpenDesign IPC commands do not accept input')
}

export function registerOpenDesignModuleIpc(
  ipc: Pick<IpcMain, 'handle' | 'removeHandler'>,
  controller: OpenDesignModuleController,
): OpenDesignModuleIpcRegistration {
  const key = ipc as object
  ipcRegistrations.get(key)?.dispose()
  const installed: string[] = []
  let disposed = false

  const register = (
    channel: string,
    invoke: () => Promise<OpenDesignModuleState>,
  ) => {
    ipc.handle(channel, (event, ...args) => {
      assertIpcInvocation(controller, event, args)
      return invoke()
    })
    installed.push(channel)
  }

  const registration: OpenDesignModuleIpcRegistration = {
    dispose() {
      if (disposed) return
      disposed = true
      if (ipcRegistrations.get(key) === registration) ipcRegistrations.delete(key)
      for (const channel of installed) {
        try {
          ipc.removeHandler(channel)
        } catch {
          // Continue removing the remaining fixed handlers.
        }
      }
    },
  }

  try {
    register(OPEN_DESIGN_MODULE_CHANNELS.GET_STATE, () => controller.getState())
    register(OPEN_DESIGN_MODULE_CHANNELS.INSTALL, () => controller.install())
    register(OPEN_DESIGN_MODULE_CHANNELS.START, () => controller.start())
    register(OPEN_DESIGN_MODULE_CHANNELS.STOP, () => controller.stop())
  } catch (error) {
    registration.dispose()
    throw error
  }

  ipcRegistrations.set(key, registration)
  return registration
}
