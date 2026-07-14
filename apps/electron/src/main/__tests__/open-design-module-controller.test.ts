import { describe, expect, it, mock } from 'bun:test'
import type { BrowserWindow, IpcMain } from 'electron'
import type { ModuleId, ModuleVersion } from '@simulator/module-contract'
import type {
  ModuleCoordinatorInstallRequest,
  ModuleCoordinatorOperation,
  ModuleCoordinatorOperationKind,
  ModuleCoordinatorOperationResult,
  ModuleCoordinatorSnapshot,
  ModuleViewSnapshot,
} from '@simulator/module-coordinator'
import type { ModuleDaemonSnapshot } from '@simulator/module-daemon'
import type { ModuleRegistrySnapshot } from '@simulator/module-registry'
import {
  OpenDesignModuleController,
  createOpenDesignModuleBrowserWindowAdapter,
  reduceOpenDesignModuleState,
  registerOpenDesignModuleIpc,
  type OpenDesignModuleClock,
  type OpenDesignModuleHostAdapter,
  type OpenDesignModuleRuntime,
  type OpenDesignModuleRuntimeLookup,
} from '../open-design-module-controller'
import {
  OPEN_DESIGN_MODULE_CHANNELS,
  OPEN_DESIGN_MODULE_ID,
  type OpenDesignModuleState,
} from '../../shared/open-design-module-ipc'

const MODULE_ID = OPEN_DESIGN_MODULE_ID as ModuleId
const VERSION = '1.2.3' as ModuleVersion

function manifest(version: ModuleVersion = VERSION) {
  return { id: MODULE_ID, version }
}

function installRequest(version: ModuleVersion = VERSION): ModuleCoordinatorInstallRequest {
  return {
    catalogUrl: 'https://open-design.invalid/catalog.json',
    descriptor: { manifest: manifest(version) },
    hostVersionRange: '*',
  } as unknown as ModuleCoordinatorInstallRequest
}

function registrySnapshot(activeVersion?: ModuleVersion, disabled = false): ModuleRegistrySnapshot {
  return {
    host: { version: '0.11.1', platform: 'darwin-arm64' },
    modules: activeVersion === undefined && !disabled
      ? []
      : [{
          id: OPEN_DESIGN_MODULE_ID,
          disabled,
          activeVersion: activeVersion ?? null,
          lastKnownGoodVersion: activeVersion ?? null,
          versions: activeVersion
            ? [{
                version: activeVersion,
                manifest: manifest(activeVersion),
                hostVersionRange: '*',
                compatibility: 'compatible',
                incompatibilityReasons: [],
              }]
            : [],
        }],
    diagnostics: [],
  } as unknown as ModuleRegistrySnapshot
}

function daemonSnapshot(
  state: ModuleDaemonSnapshot['state'] = 'healthy',
  version: ModuleVersion = VERSION,
): ModuleDaemonSnapshot {
  return {
    id: MODULE_ID,
    version,
    state,
    restartCount: 0,
    ...(state === 'crashed'
      ? { diagnostic: { code: 'PROCESS_EXITED', message: '/private/secret crashed', at: 1, restartCount: 0 } }
      : {}),
  } as ModuleDaemonSnapshot
}

function viewSnapshot(
  state: ModuleViewSnapshot['state'] = 'attached',
  version: ModuleVersion = VERSION,
): ModuleViewSnapshot {
  return { moduleId: MODULE_ID, version, state }
}

function coordinatorOperation(
  kind: ModuleCoordinatorOperationKind,
  status: ModuleCoordinatorOperation['status'],
  id = `operation-${kind}`,
  checkpoint: ModuleCoordinatorOperation['checkpoint'] = status === 'pending' ? 'intent-recorded' : 'completed',
): ModuleCoordinatorOperation {
  const source = {
    activeVersion: kind === 'install' ? null : VERSION,
    lastKnownGoodVersion: kind === 'install' ? null : VERSION,
    running: false,
    viewAttached: false,
    registryPresent: kind !== 'install',
  }
  const target = {
    activeVersion: kind === 'stop' ? VERSION : VERSION,
    lastKnownGoodVersion: VERSION,
    running: kind === 'start',
    viewAttached: kind === 'start',
    registryPresent: true,
  }
  const request = kind === 'install'
    ? { ...installRequest(), operationId: id }
    : { moduleId: MODULE_ID, operationId: id }
  return {
    id,
    moduleId: MODULE_ID,
    kind,
    fingerprint: `fingerprint-${id}`,
    phase: 'forward',
    checkpoint,
    status,
    createdAt: 1,
    updatedAt: 1,
    request,
    source,
    target,
    ...(status === 'completed'
      ? {
          result: {
            operationId: id,
            moduleId: MODULE_ID,
            kind,
            ok: true,
            source,
            target,
            completedAt: 2,
          },
        }
      : status === 'failed'
        ? { error: '/private/secret/api-key', result: {
            operationId: id,
            moduleId: MODULE_ID,
            kind,
            ok: false,
            source,
            target,
            completedAt: 2,
            error: '/private/secret/api-key',
          } }
        : {}),
  } as ModuleCoordinatorOperation
}

function coordinatorSnapshot(operations: readonly ModuleCoordinatorOperation[] = []): ModuleCoordinatorSnapshot {
  return {
    operations,
    events: [{ moduleId: MODULE_ID, at: 1, snapshot: daemonSnapshot('crashed') }],
    manifests: [],
    platform: 'darwin-arm64',
  }
}

function operationResult(
  kind: 'install' | 'start' | 'stop',
  operationId: string,
  ok = true,
): ModuleCoordinatorOperationResult {
  return {
    operationId,
    moduleId: MODULE_ID,
    kind,
    ok,
    source: {
      activeVersion: kind === 'install' ? null : VERSION,
      lastKnownGoodVersion: kind === 'install' ? null : VERSION,
      running: false,
      viewAttached: false,
      registryPresent: kind !== 'install',
    },
    target: {
      activeVersion: VERSION,
      lastKnownGoodVersion: VERSION,
      running: kind === 'start',
      viewAttached: kind === 'start',
      registryPresent: true,
    },
    completedAt: 2,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function until(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error('Timed out waiting for test condition')
}

class FakeClock implements OpenDesignModuleClock {
  readonly delays: number[] = []
  readonly tasks = new Map<number, () => void>()
  #nextId = 1

  now(): number {
    return 1_000
  }

  setTimeout(callback: () => void, milliseconds: number): () => void {
    const id = this.#nextId++
    this.delays.push(milliseconds)
    this.tasks.set(id, callback)
    return () => this.tasks.delete(id)
  }

  runNext(): void {
    const entry = this.tasks.entries().next().value as [number, () => void] | undefined
    if (!entry) throw new Error('No fake timer is pending')
    this.tasks.delete(entry[0])
    entry[1]()
  }
}

interface Harness {
  runtime: OpenDesignModuleRuntime
  host: OpenDesignModuleHostAdapter
  readonly sender: object
  readonly emitted: OpenDesignModuleState[]
  readonly calls: {
    install: ModuleCoordinatorInstallRequest[]
    start: Array<{ moduleId: string; operationId?: string }>
    stop: Array<{ moduleId: string; operationId?: string }>
  }
  readonly listeners: Set<(snapshot: ModuleDaemonSnapshot) => void>
  activeVersion?: ModuleVersion
  daemon?: ModuleDaemonSnapshot
  view?: ModuleViewSnapshot
  operations: ModuleCoordinatorOperation[]
  unsubscribes: number
  installImpl?: (request: ModuleCoordinatorInstallRequest) => Promise<ModuleCoordinatorOperationResult>
  startImpl?: (request: { moduleId: string; operationId?: string }) => Promise<ModuleCoordinatorOperationResult>
  stopImpl?: (request: { moduleId: string; operationId?: string }) => Promise<ModuleCoordinatorOperationResult>
}

function createHarness(installed = false): Harness {
  const sender = { mainFrame: {} }
  const emitted: OpenDesignModuleState[] = []
  const listeners = new Set<(snapshot: ModuleDaemonSnapshot) => void>()
  let sequence = 0
  const harness = {
    sender,
    emitted,
    listeners,
    activeVersion: installed ? VERSION : undefined,
    daemon: undefined,
    view: undefined,
    operations: [],
    unsubscribes: 0,
    calls: { install: [], start: [], stop: [] },
  } as unknown as Harness

  const complete = (kind: 'install' | 'start' | 'stop', operationId: string) => {
    sequence += 1
    const operation = coordinatorOperation(kind, 'completed', operationId)
    harness.operations.push({ ...operation, createdAt: sequence, updatedAt: sequence })
    return operationResult(kind, operationId)
  }

  harness.runtime = {
    coordinator: {
      async install(request) {
        harness.calls.install.push(request)
        if (harness.installImpl) return harness.installImpl(request)
        harness.activeVersion = request.descriptor.manifest.version
        return complete('install', request.operationId!)
      },
      async start(request) {
        harness.calls.start.push(request)
        if (harness.startImpl) return harness.startImpl(request)
        harness.daemon = daemonSnapshot('healthy', harness.activeVersion)
        harness.view = viewSnapshot('attached', harness.activeVersion)
        return complete('start', request.operationId!)
      },
      async stop(request) {
        harness.calls.stop.push(request)
        if (harness.stopImpl) return harness.stopImpl(request)
        harness.daemon = daemonSnapshot('stopped', harness.activeVersion)
        harness.view = undefined
        return complete('stop', request.operationId!)
      },
      async snapshot() {
        return coordinatorSnapshot(harness.operations)
      },
    },
    registry: {
      snapshot: () => registrySnapshot(harness.activeVersion),
    },
    daemon: {
      get: () => harness.daemon,
      subscribe(listener) {
        listeners.add(listener)
        return () => {
          harness.unsubscribes += 1
          listeners.delete(listener)
        }
      },
    },
    view: {
      query: async () => harness.view,
      setPresentation: mock(() => {}),
    },
  }
  harness.host = {
    isAllowedSender: (candidate) => candidate === sender,
    emitState: (state) => emitted.push(state),
  }
  return harness
}

function createController(
  harness: Harness,
  options: {
    clock?: OpenDesignModuleClock
    getRuntime?: () => OpenDesignModuleRuntimeLookup
    getInstallRequest?: () => ModuleCoordinatorInstallRequest | undefined
    host?: OpenDesignModuleHostAdapter
  } = {},
) {
  return new OpenDesignModuleController({
    getRuntime: options.getRuntime ?? (() => ({ status: 'ready', runtime: harness.runtime })),
    getInstallRequest: options.getInstallRequest ?? (() => installRequest()),
    host: options.host ?? harness.host,
    clock: options.clock,
  })
}

describe('reduceOpenDesignModuleState', () => {
  it('applies error > installing > running > available > not-installed priority', () => {
    const availableRegistry = registrySnapshot(VERSION)
    const running = daemonSnapshot('healthy')
    const activeInstall = { action: 'install' as const, operationId: 'install-active' }

    expect(reduceOpenDesignModuleState({ availability: 'ready', registry: registrySnapshot() }).status)
      .toBe('not-installed')
    expect(reduceOpenDesignModuleState({ availability: 'ready', registry: availableRegistry }).status)
      .toBe('available')
    expect(reduceOpenDesignModuleState({ availability: 'ready', registry: availableRegistry, daemon: running }).status)
      .toBe('running')
    expect(reduceOpenDesignModuleState({
      availability: 'ready',
      registry: availableRegistry,
      daemon: running,
      activeOperation: activeInstall,
    }).status).toBe('installing')
    expect(reduceOpenDesignModuleState({
      availability: 'ready',
      registry: availableRegistry,
      daemon: running,
      activeOperation: activeInstall,
      error: { code: 'SAFE_ERROR', message: 'Safe message.' },
    })).toMatchObject({ status: 'error', errorCode: 'SAFE_ERROR' })
  })

  it('reports disabled and not-ready prerequisites without reading runtime state', () => {
    expect(reduceOpenDesignModuleState({ availability: 'disabled' })).toEqual({ status: 'disabled' })
    expect(reduceOpenDesignModuleState({ availability: 'not-ready' })).toEqual({ status: 'not-ready' })
    expect(reduceOpenDesignModuleState({
      availability: 'not-ready',
      availabilityError: { code: 'DEVELOPMENT_BUNDLE_INVALID', message: 'Bundle verification failed.' },
    })).toEqual({
      status: 'not-ready',
      errorCode: 'DEVELOPMENT_BUNDLE_INVALID',
      errorMessage: 'Bundle verification failed.',
    })
    expect(reduceOpenDesignModuleState({
      availability: 'ready',
      registry: registrySnapshot(VERSION, true),
    }).status).toBe('disabled')
  })

  it('uses only the current daemon snapshot and redacts durable operation failures', () => {
    const failed = coordinatorOperation('start', 'failed')
    const state = reduceOpenDesignModuleState({
      availability: 'ready',
      coordinator: coordinatorSnapshot([failed]),
      registry: registrySnapshot(VERSION),
      daemon: daemonSnapshot('stopped'),
    })
    expect(state).toMatchObject({ status: 'error', errorCode: 'COORDINATOR_START_FAILED' })
    expect(JSON.stringify(state)).not.toContain('/private/secret')

    const ignoresHistoricalEvent = reduceOpenDesignModuleState({
      availability: 'ready',
      coordinator: coordinatorSnapshot(),
      registry: registrySnapshot(VERSION),
      daemon: daemonSnapshot('healthy'),
    })
    expect(ignoresHistoricalEvent.status).toBe('running')
  })
})

describe('OpenDesignModuleController', () => {
  it('installs, starts, and stops only the fixed OpenDesign module with host operation IDs', async () => {
    const harness = createHarness()
    const controller = createController(harness)

    expect(await controller.install()).toMatchObject({ status: 'available', version: VERSION })
    expect(await controller.start()).toMatchObject({ status: 'running', version: VERSION })
    expect(await controller.stopForHostView()).toMatchObject({ status: 'available', version: VERSION })

    expect(harness.calls.install[0]?.descriptor.manifest.id).toBe(MODULE_ID)
    expect(harness.calls.start[0]?.moduleId).toBe(MODULE_ID)
    expect(harness.calls.stop[0]?.moduleId).toBe(MODULE_ID)
    const operationIds = [
      harness.calls.install[0]?.operationId,
      harness.calls.start[0]?.operationId,
      harness.calls.stop[0]?.operationId,
    ]
    expect(operationIds.every((id) => id?.startsWith('open-design-'))).toBe(true)
    expect(new Set(operationIds).size).toBe(3)
    controller.dispose()
  })

  it('serializes operations and deduplicates concurrent identical actions', async () => {
    const harness = createHarness()
    const installFlight = deferred<ModuleCoordinatorOperationResult>()
    const startFlight = deferred<ModuleCoordinatorOperationResult>()
    harness.installImpl = async (request) => installFlight.promise.then((result) => {
      harness.activeVersion = VERSION
      harness.operations.push(coordinatorOperation('install', 'completed', request.operationId!))
      return result
    })
    harness.startImpl = async (request) => startFlight.promise.then((result) => {
      harness.daemon = daemonSnapshot('healthy')
      harness.view = viewSnapshot('attached')
      harness.operations.push(coordinatorOperation('start', 'completed', request.operationId!))
      return result
    })
    const controller = createController(harness)

    const firstInstall = controller.install()
    const duplicateInstall = controller.install()
    const start = controller.start()
    expect(duplicateInstall).toBe(firstInstall)
    await until(() => harness.calls.install.length === 1)
    expect(harness.calls.start).toHaveLength(0)

    const installOperationId = harness.calls.install[0]!.operationId!
    installFlight.resolve(operationResult('install', installOperationId))
    await firstInstall
    await until(() => harness.calls.start.length === 1)
    const startOperationId = harness.calls.start[0]!.operationId!
    startFlight.resolve(operationResult('start', startOperationId))
    await start

    expect(harness.calls.install).toHaveLength(1)
    expect(harness.calls.start).toHaveLength(1)
    expect(installOperationId).not.toBe(startOperationId)
    controller.dispose()
  })

  it('publishes daemon changes from fresh state and contains subscriber exceptions', async () => {
    const harness = createHarness(true)
    harness.daemon = daemonSnapshot('healthy')
    let throws = true
    const controller = createController(harness, {
      host: {
        isAllowedSender: harness.host.isAllowedSender,
        emitState(state) {
          if (throws) throw new Error('subscriber failed')
          harness.emitted.push(state)
        },
      },
    })

    const listener = [...harness.listeners][0]!
    listener(daemonSnapshot('crashed'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    throws = false
    listener(daemonSnapshot('crashed'))
    await until(() => harness.emitted.length > 0)

    expect(harness.emitted.at(-1)?.status).toBe('running')
    expect(harness.emitted.at(-1)?.daemonState).toBe('healthy')
    controller.dispose()
  })

  it('polls at 150ms, exposes checkpoints, and clears polling after completion', async () => {
    const harness = createHarness()
    const clock = new FakeClock()
    const installFlight = deferred<ModuleCoordinatorOperationResult>()
    harness.installImpl = async (request) => {
      harness.operations.push(coordinatorOperation('install', 'pending', request.operationId!, 'catalog-verified'))
      return installFlight.promise.then((result) => {
        harness.operations = [coordinatorOperation('install', 'completed', request.operationId!)]
        harness.activeVersion = VERSION
        return result
      })
    }
    const controller = createController(harness, { clock })

    const flight = controller.install()
    await until(() => harness.calls.install.length === 1)
    expect(clock.delays).toEqual([150])
    expect(clock.tasks.size).toBe(1)

    clock.runNext()
    await until(() => harness.emitted.some((state) => state.checkpoint === 'catalog-verified'))
    const operationId = harness.calls.install[0]!.operationId!
    installFlight.resolve(operationResult('install', operationId))
    await flight

    expect(clock.tasks.size).toBe(0)
    controller.dispose()
  })

  it('cleans daemon subscription and polling immediately on dispose', async () => {
    const harness = createHarness()
    const clock = new FakeClock()
    const installFlight = deferred<ModuleCoordinatorOperationResult>()
    harness.installImpl = () => installFlight.promise
    const controller = createController(harness, { clock })
    const flight = controller.install()
    await until(() => harness.calls.install.length === 1)

    controller.dispose()
    controller.dispose()
    expect(clock.tasks.size).toBe(0)
    expect(harness.listeners.size).toBe(0)
    expect(harness.unsubscribes).toBe(1)

    const operationId = harness.calls.install[0]!.operationId!
    installFlight.resolve(operationResult('install', operationId))
    expect(await flight).toMatchObject({ status: 'error', errorCode: 'CONTROLLER_DISPOSED' })
  })

  it('returns path-free safe errors for operation failures', async () => {
    const harness = createHarness(true)
    harness.startImpl = async () => {
      const error = Object.assign(new Error('/private/secret api-key=abc123'), { code: 'API_KEY_ABC123' })
      throw error
    }
    const controller = createController(harness)

    const state = await controller.start()
    expect(state).toMatchObject({
      status: 'error',
      errorCode: 'OPEN_DESIGN_START_FAILED',
      errorMessage: 'OpenDesign could not be started.',
    })
    expect(JSON.stringify(state)).not.toContain('/private/secret')
    expect(JSON.stringify(state)).not.toContain('abc123')
    expect(JSON.stringify(state)).not.toContain('API_KEY_ABC123')
    controller.dispose()
  })

  it('stops the daemon and publishes an actionable error after a view crash', async () => {
    const harness = createHarness(true)
    harness.daemon = daemonSnapshot('healthy')
    harness.view = viewSnapshot('crashed')
    const controller = createController(harness)

    const state = await controller.stopForViewFailure()

    expect(harness.calls.stop).toHaveLength(1)
    expect(harness.daemon?.state).toBe('stopped')
    expect(harness.view).toBeUndefined()
    expect(state).toMatchObject({
      status: 'error',
      errorCode: 'VIEW_CRASHED',
      errorMessage: 'The OpenDesign view stopped unexpectedly.',
      version: VERSION,
    })
    expect(harness.emitted.at(-1)).toEqual(state)
    controller.dispose()
  })

  it('rejects host-view cleanup when the coordinator returns a failed stop', async () => {
    const harness = createHarness(true)
    harness.daemon = daemonSnapshot('healthy')
    harness.view = viewSnapshot('attached')
    harness.stopImpl = async (request) => operationResult('stop', request.operationId!, false)
    const controller = createController(harness)

    await expect(controller.stopForHostView()).rejects.toThrow('OpenDesign could not be stopped')
    expect(await controller.getState()).toMatchObject({
      status: 'error',
      errorCode: 'OPEN_DESIGN_STOP_FAILED',
      daemonState: 'healthy',
      viewState: 'attached',
    })
    controller.dispose()
  })

  it('rejects view-failure cleanup without masking a thrown stop failure', async () => {
    const harness = createHarness(true)
    harness.daemon = daemonSnapshot('healthy')
    harness.view = viewSnapshot('crashed')
    harness.stopImpl = async () => { throw new Error('/private/secret stop failure') }
    const controller = createController(harness)

    await expect(controller.stopForViewFailure()).rejects.toThrow('OpenDesign could not be stopped')
    const state = await controller.getState()
    expect(state).toMatchObject({
      status: 'error',
      errorCode: 'OPEN_DESIGN_STOP_FAILED',
      daemonState: 'healthy',
      viewState: 'crashed',
    })
    expect(state.errorCode).not.toBe('VIEW_CRASHED')
    expect(JSON.stringify(state)).not.toContain('/private/secret')
    controller.dispose()
  })

  it('reports disabled and not-ready runtime lookup states', async () => {
    const harness = createHarness()
    let lookup: OpenDesignModuleRuntimeLookup = { status: 'disabled' }
    const controller = createController(harness, { getRuntime: () => lookup })
    expect(await controller.getState()).toEqual({ status: 'disabled' })
    lookup = { status: 'not-ready' }
    expect(await controller.getState()).toEqual({ status: 'not-ready' })
    controller.dispose()
  })
})

describe('OpenDesign module IPC', () => {
  it('binds BrowserWindow identity exactly and stops emitting after destruction', () => {
    const sender = { isDestroyed: () => false, send: () => undefined }
    let destroyed = false
    const sent: unknown[] = []
    sender.send = (...args: unknown[]) => { sent.push(args) }
    const window = {
      isDestroyed: () => destroyed,
      webContents: sender,
    } as unknown as BrowserWindow
    const adapter = createOpenDesignModuleBrowserWindowAdapter(() => window)

    expect(adapter.isAllowedSender(sender)).toBe(true)
    expect(adapter.isAllowedSender({})).toBe(false)
    adapter.emitState({ status: 'available' })
    expect(sent).toEqual([[OPEN_DESIGN_MODULE_CHANNELS.STATE_CHANGED, { status: 'available' }]])
    destroyed = true
    expect(adapter.isAllowedSender(sender)).toBe(false)
    adapter.emitState({ status: 'running' })
    expect(sent).toHaveLength(1)
  })

  it('rejects foreign senders and arguments, and bounds repeated registration cleanup', async () => {
    const harness = createHarness()
    const controller = createController(harness)
    const handlers = new Map<string, (event: any, ...args: unknown[]) => unknown>()
    const ipc = {
      handle(channel: string, listener: (event: any, ...args: unknown[]) => unknown) {
        if (handlers.has(channel)) throw new Error(`duplicate ${channel}`)
        handlers.set(channel, listener)
      },
      removeHandler(channel: string) {
        handlers.delete(channel)
      },
    } as unknown as Pick<IpcMain, 'handle' | 'removeHandler'>

    const first = registerOpenDesignModuleIpc(ipc, controller)
    expect(handlers.size).toBe(5)
    const getState = handlers.get(OPEN_DESIGN_MODULE_CHANNELS.GET_STATE)!
    await expect(Promise.resolve().then(() => getState({ sender: {} }))).rejects.toThrow('sender was rejected')
    const sender = harness.sender as { mainFrame: object }
    const event = { sender, senderFrame: sender.mainFrame }
    await expect(Promise.resolve().then(() => getState(event, {}))).rejects.toThrow('do not accept input')
    await expect(Promise.resolve().then(() => getState({ sender, senderFrame: {} }))).rejects.toThrow('main frame')
    expect(await getState(event)).toEqual({ status: 'not-installed' })

    const setPresentation = handlers.get(OPEN_DESIGN_MODULE_CHANNELS.SET_VIEW_PRESENTATION)!
    expect(await setPresentation(event, {
      visible: true,
      bounds: { x: 220, y: 48, width: 980, height: 752 },
    })).toEqual({ status: 'not-installed' })
    expect(harness.runtime.view.setPresentation).toHaveBeenCalledWith(MODULE_ID, {
      visible: true,
      rect: { x: 220, y: 48, width: 980, height: 752 },
    })
    await expect(Promise.resolve().then(() => setPresentation(event, { visible: true })))
      .rejects.toThrow('requires bounds')

    const second = registerOpenDesignModuleIpc(ipc, controller)
    expect(handlers.size).toBe(5)
    first.dispose()
    expect(handlers.size).toBe(5)
    second.dispose()
    second.dispose()
    expect(handlers.size).toBe(0)
    controller.dispose()
  })
})
