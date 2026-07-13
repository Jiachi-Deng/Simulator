import { parseModuleManifest, type ModuleId, type ModuleManifest, type ModuleVersion } from '@simulator/module-contract'
import {
  MODULE_COORDINATOR_STATE_SCHEMA_VERSION,
  ModuleCoordinatorError,
  SimulatedCoordinatorCrash,
  type ModuleCoordinatorCheckpoint,
  type ModuleCoordinatorDependencies,
  type ModuleCoordinatorEvent,
  type ModuleCoordinatorInstallRequest,
  type ModuleCoordinatorModuleRequest,
  type ModuleCoordinatorOperation,
  type ModuleCoordinatorOperationKind,
  type ModuleCoordinatorOperationResult,
  type ModuleCoordinatorRequest,
  type ModuleCoordinatorRollbackRequest,
  type ModuleCoordinatorSnapshot,
  type ModuleCoordinatorTargetState,
  type ModuleCoordinatorUninstallRequest,
} from './types.ts'

const MAX_EVENTS = 256
const OPERATION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$/

const FORWARD_CHECKPOINTS: Record<ModuleCoordinatorOperationKind, readonly ModuleCoordinatorCheckpoint[]> = {
  install: ['intent-recorded', 'catalog-verified', 'artifact-downloaded', 'installed', 'registered', 'activation-restored', 'registry-restored', 'completed'],
  update: ['intent-recorded', 'runtime-detached', 'daemon-stopped', 'catalog-verified', 'artifact-downloaded', 'installed', 'registered', 'activation-restored', 'registry-restored', 'daemon-started', 'view-attached', 'completed'],
  rollback: ['intent-recorded', 'runtime-detached', 'daemon-stopped', 'activation-restored', 'registry-restored', 'daemon-started', 'view-attached', 'completed'],
  start: ['intent-recorded', 'daemon-started', 'view-attached', 'completed'],
  restart: ['intent-recorded', 'runtime-detached', 'daemon-stopped', 'daemon-started', 'view-attached', 'completed'],
  stop: ['intent-recorded', 'runtime-detached', 'daemon-stopped', 'completed'],
  uninstall: ['intent-recorded', 'version-uninstalled', 'registry-removed', 'completed'],
}

const COMPENSATION_CHECKPOINTS = [
  'compensation-started',
  'compensation-runtime-detached',
  'compensation-daemon-stopped',
  'compensation-activation-restored',
  'compensation-registry-restored',
  'compensation-daemon-started',
  'compensation-view-attached',
  'compensated',
] as const satisfies readonly ModuleCoordinatorCheckpoint[]

interface OperationFlight {
  readonly fingerprint: string
  readonly promise: Promise<ModuleCoordinatorOperationResult>
}

interface RuntimeLease {
  readonly version: ModuleVersion
  readonly release: () => void
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`
}

function sameManifest(left: ModuleManifest, right: ModuleManifest): boolean {
  return stable(left) === stable(right)
}

function sameTarget(left: Pick<ModuleCoordinatorTargetState, 'activeVersion' | 'lastKnownGoodVersion'>, right: Pick<ModuleCoordinatorTargetState, 'activeVersion' | 'lastKnownGoodVersion'>): boolean {
  return left.activeVersion === right.activeVersion && left.lastKnownGoodVersion === right.lastKnownGoodVersion
}

function daemonRunning(state: string | undefined): boolean {
  return state === 'starting' || state === 'healthy' || state === 'degraded' || state === 'crashed'
}

function requestModuleId(kind: ModuleCoordinatorOperationKind, request: ModuleCoordinatorRequest): ModuleId {
  if (kind === 'install' || kind === 'update') return (request as ModuleCoordinatorInstallRequest).descriptor.manifest.id
  return (request as ModuleCoordinatorModuleRequest).moduleId
}

function withoutOperationId(request: ModuleCoordinatorRequest): Record<string, unknown> {
  const copy = clone(request) as unknown as Record<string, unknown>
  delete copy.operationId
  return copy
}

async function requestFingerprint(value: unknown): Promise<string> {
  const bytes = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(stable(value)))
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function installerErrorCode(error: unknown): string | undefined {
  return error !== null && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined
}

export class ModuleCoordinator {
  readonly #dependencies: ModuleCoordinatorDependencies
  readonly #now: () => number
  readonly #moduleTails = new Map<ModuleId, Promise<unknown>>()
  readonly #operationFlights = new Map<string, OperationFlight>()
  readonly #runtimeLeases = new Map<ModuleId, RuntimeLease>()
  readonly #eventTasks = new Set<Promise<void>>()
  readonly #unsubscribeDaemon: () => void
  readonly #ready: Promise<void>
  #acceptEvents = true
  #state: { schemaVersion: typeof MODULE_COORDINATOR_STATE_SCHEMA_VERSION; operations: ModuleCoordinatorOperation[]; events: ModuleCoordinatorEvent[] } = {
    schemaVersion: MODULE_COORDINATOR_STATE_SCHEMA_VERSION,
    operations: [],
    events: [],
  }
  #commitTail: Promise<void> = Promise.resolve()

  constructor(dependencies: ModuleCoordinatorDependencies) {
    this.#dependencies = dependencies
    this.#now = dependencies.now ?? Date.now
    this.#ready = this.#load()
    this.#unsubscribeDaemon = dependencies.daemon.subscribe((snapshot) => {
      if (!this.#acceptEvents) return
      const task = this.#handleDaemonSnapshot(snapshot)
      this.#eventTasks.add(task)
      void task.finally(() => this.#eventTasks.delete(task)).catch(() => undefined)
    })
  }

  install(request: ModuleCoordinatorInstallRequest): Promise<ModuleCoordinatorOperationResult> {
    return this.#submit('install', request)
  }

  update(request: ModuleCoordinatorInstallRequest): Promise<ModuleCoordinatorOperationResult> {
    return this.#submit('update', request)
  }

  rollback(request: ModuleCoordinatorRollbackRequest): Promise<ModuleCoordinatorOperationResult> {
    return this.#submit('rollback', request)
  }

  start(request: ModuleCoordinatorModuleRequest): Promise<ModuleCoordinatorOperationResult> {
    return this.#submit('start', request)
  }

  restart(request: ModuleCoordinatorModuleRequest): Promise<ModuleCoordinatorOperationResult> {
    return this.#submit('restart', request)
  }

  stop(request: ModuleCoordinatorModuleRequest): Promise<ModuleCoordinatorOperationResult> {
    return this.#submit('stop', request)
  }

  uninstall(request: ModuleCoordinatorUninstallRequest): Promise<ModuleCoordinatorOperationResult> {
    return this.#submit('uninstall', request)
  }

  async recover(): Promise<readonly ModuleCoordinatorOperationResult[]> {
    await this.#ready
    await this.#dependencies.installer.recoverAll()
    const pending = this.#state.operations.filter((operation) => operation.status === 'pending')
    const results = await Promise.all(pending.map((operation) => this.#resume(operation)))
    await this.#reconcileDesiredRuntime()
    return results
  }

  async snapshot(): Promise<ModuleCoordinatorSnapshot> {
    await this.#ready
    const registry = this.#dependencies.registry.snapshot()
    return Object.freeze({
      operations: clone(this.#state.operations),
      events: clone(this.#state.events),
      manifests: registry.modules.flatMap((module) => module.versions.map((version) => version.manifest)),
      platform: this.#dependencies.platform,
    })
  }

  /** Stops daemon event ingestion and waits for all coordinator-owned durable writes. */
  async dispose(): Promise<void> {
    this.#acceptEvents = false
    this.#unsubscribeDaemon()
    await Promise.allSettled([...this.#eventTasks])
    await this.#commitTail
  }

  async #load(): Promise<void> {
    const persisted = await this.#dependencies.store.load()
    if (!persisted) return
    this.#state = {
      schemaVersion: MODULE_COORDINATOR_STATE_SCHEMA_VERSION,
      operations: [...clone(persisted.operations)],
      events: [...clone(persisted.events).slice(-MAX_EVENTS)],
    }
  }

  async #submit(kind: ModuleCoordinatorOperationKind, input: ModuleCoordinatorRequest): Promise<ModuleCoordinatorOperationResult> {
    await this.#ready
    const request = clone(input)
    const operationId = this.#operationId(request.operationId)
    const normalized = { ...request, operationId } as ModuleCoordinatorRequest
    const moduleId = requestModuleId(kind, normalized)
    const fingerprint = await requestFingerprint({ kind, moduleId, request: withoutOperationId(normalized) })
    const flight = this.#operationFlights.get(operationId)
    if (flight) {
      if (flight.fingerprint !== fingerprint) this.#operationConflict(operationId)
      return flight.promise
    }
    const existing = this.#state.operations.find((operation) => operation.id === operationId)
    if (existing) {
      this.#assertSameOperation(existing, kind, moduleId, fingerprint)
      if (existing.result) return clone(existing.result)
      return this.#resume(existing)
    }
    const promise = this.#enqueue(moduleId, async () => {
      const raced = this.#state.operations.find((operation) => operation.id === operationId)
      if (raced) {
        this.#assertSameOperation(raced, kind, moduleId, fingerprint)
        return raced.result ? clone(raced.result) : this.#execute(raced.id)
      }
      const source = await this.#observe(moduleId)
      const target = this.#targetFor(kind, normalized, source)
      const now = this.#now()
      const operation: ModuleCoordinatorOperation = {
        id: operationId,
        moduleId,
        kind,
        fingerprint,
        phase: 'forward',
        checkpoint: 'intent-recorded',
        status: 'pending',
        createdAt: now,
        updatedAt: now,
        request: normalized,
        source,
        target,
      }
      await this.#appendOperation(operation)
      return this.#execute(operation.id)
    })
    this.#operationFlights.set(operationId, { fingerprint, promise })
    void promise.finally(() => {
      if (this.#operationFlights.get(operationId)?.promise === promise) this.#operationFlights.delete(operationId)
    }).catch(() => undefined)
    return promise
  }

  #resume(operation: ModuleCoordinatorOperation): Promise<ModuleCoordinatorOperationResult> {
    const flight = this.#operationFlights.get(operation.id)
    if (flight) return flight.promise
    const promise = this.#enqueue(operation.moduleId, async () => this.#execute(operation.id))
    this.#operationFlights.set(operation.id, { fingerprint: operation.fingerprint, promise })
    void promise.finally(() => {
      if (this.#operationFlights.get(operation.id)?.promise === promise) this.#operationFlights.delete(operation.id)
    }).catch(() => undefined)
    return promise
  }

  async #execute(operationId: string): Promise<ModuleCoordinatorOperationResult> {
    const operation = this.#operation(operationId)
    if (operation.result) return clone(operation.result)
    if (operation.phase === 'compensating') {
      await this.#reconcileCheckpoint(operation)
      return this.#compensate(operationId)
    }
    try {
      await this.#reconcileCheckpoint(operation)
      await this.#executeForward(operationId)
      return await this.#finish(operationId, true)
    } catch (error) {
      if (error instanceof SimulatedCoordinatorCrash) throw error
      if (this.#operation(operationId).kind === 'uninstall') {
        await this.#patchOperation(operationId, { error: this.#errorMessage(error) })
        throw error
      }
      await this.#patchOperation(operationId, {
        phase: 'compensating',
        checkpoint: 'compensation-started',
        error: this.#errorMessage(error),
      })
      return this.#compensate(operationId)
    }
  }

  async #executeForward(operationId: string): Promise<void> {
    const kind = this.#operation(operationId).kind
    switch (kind) {
      case 'install':
        await this.#installSteps(operationId, false)
        return
      case 'update':
        await this.#step(operationId, 'runtime-detached', (operation) => this.#detach(operation.moduleId))
        await this.#step(operationId, 'daemon-stopped', (operation) => this.#stopRuntime(operation.moduleId))
        await this.#installSteps(operationId, true)
        await this.#step(operationId, 'daemon-started', (operation) => this.#startRuntime(operation.moduleId, operation.target.activeVersion))
        await this.#step(operationId, 'view-attached', (operation) => this.#attach(operation.moduleId, operation.target.activeVersion))
        return
      case 'rollback':
        await this.#step(operationId, 'runtime-detached', (operation) => this.#detach(operation.moduleId))
        await this.#step(operationId, 'daemon-stopped', (operation) => this.#stopRuntime(operation.moduleId))
        await this.#step(operationId, 'activation-restored', (operation) => this.#restoreInstaller(operation.moduleId, operation.target))
        await this.#step(operationId, 'registry-restored', (operation) => this.#restoreRegistry(operation, operation.target))
        await this.#step(operationId, 'daemon-started', async (operation) => {
          if (operation.target.running) await this.#startRuntime(operation.moduleId, operation.target.activeVersion)
        })
        await this.#step(operationId, 'view-attached', async (operation) => {
          if (operation.target.viewAttached) await this.#attach(operation.moduleId, operation.target.activeVersion)
        })
        return
      case 'start':
        await this.#step(operationId, 'daemon-started', (operation) => this.#startRuntime(operation.moduleId, operation.target.activeVersion))
        await this.#step(operationId, 'view-attached', (operation) => this.#attach(operation.moduleId, operation.target.activeVersion))
        return
      case 'restart':
        await this.#step(operationId, 'runtime-detached', (operation) => this.#detach(operation.moduleId))
        await this.#step(operationId, 'daemon-stopped', (operation) => this.#stopRuntime(operation.moduleId))
        await this.#step(operationId, 'daemon-started', (operation) => this.#startRuntime(operation.moduleId, operation.target.activeVersion))
        await this.#step(operationId, 'view-attached', (operation) => this.#attach(operation.moduleId, operation.target.activeVersion))
        return
      case 'stop':
        await this.#step(operationId, 'runtime-detached', (operation) => this.#detach(operation.moduleId))
        await this.#step(operationId, 'daemon-stopped', (operation) => this.#stopRuntime(operation.moduleId))
        return
      case 'uninstall':
        await this.#step(operationId, 'version-uninstalled', (operation) => this.#uninstallVersion(operation))
        await this.#step(operationId, 'registry-removed', (operation) => this.#removeRegistryVersion(operation))
        return
    }
  }

  async #reconcileCheckpoint(operation: ModuleCoordinatorOperation): Promise<void> {
    const checkpoint = operation.checkpoint
    if (checkpoint === 'intent-recorded' || checkpoint === 'compensation-started') return
    const state = operation.phase === 'forward' ? operation.target : operation.source
    switch (checkpoint) {
      case 'runtime-detached':
      case 'compensation-runtime-detached':
        await this.#detach(operation.moduleId)
        return
      case 'daemon-stopped':
      case 'compensation-daemon-stopped':
        await this.#stopRuntime(operation.moduleId)
        return
      case 'catalog-verified':
        await this.#verifiedRelease(operation)
        return
      case 'artifact-downloaded': {
        const release = await this.#verifiedRelease(operation)
        await this.#dependencies.downloader.downloadArtifact({ artifact: release.artifact, expectedSize: release.size })
        return
      }
      case 'installed':
        await this.#installTarget(operation)
        return
      case 'registered':
        await this.#ensureRegistryVersion(operation)
        return
      case 'activation-restored':
      case 'compensation-activation-restored':
        await this.#restoreInstaller(operation.moduleId, state)
        return
      case 'registry-restored':
      case 'compensation-registry-restored':
        await this.#restoreRegistry(operation, state)
        return
      case 'daemon-started':
      case 'compensation-daemon-started':
        if (state.running) await this.#startRuntime(operation.moduleId, state.activeVersion)
        return
      case 'view-attached':
      case 'compensation-view-attached':
        if (state.running) await this.#startRuntime(operation.moduleId, state.activeVersion)
        if (state.viewAttached) await this.#attach(operation.moduleId, state.activeVersion)
        return
      case 'version-uninstalled':
        await this.#uninstallVersion(operation)
        return
      case 'registry-removed':
        await this.#removeRegistryVersion(operation)
        return
      case 'completed':
      case 'compensated':
        return
    }
  }

  async #reconcileDesiredRuntime(): Promise<void> {
    const latest = new Map<ModuleId, ModuleCoordinatorOperation>()
    for (const operation of this.#state.operations) latest.set(operation.moduleId, operation)
    await Promise.all([...latest.values()].map((operation) => this.#enqueue(operation.moduleId, async () => {
      const desired = operation.status === 'failed' ? operation.source : operation.target
      if (!desired.running) {
        await this.#detach(operation.moduleId)
        await this.#stopRuntime(operation.moduleId)
        return
      }
      await this.#startRuntime(operation.moduleId, desired.activeVersion)
      if (desired.viewAttached) await this.#attach(operation.moduleId, desired.activeVersion)
      else await this.#detach(operation.moduleId)
    })))
  }

  async #installSteps(operationId: string, startAfter: boolean): Promise<void> {
    await this.#step(operationId, 'catalog-verified', async (operation) => { await this.#verifiedRelease(operation) })
    await this.#step(operationId, 'artifact-downloaded', async (operation) => {
      const release = await this.#verifiedRelease(operation)
      await this.#dependencies.downloader.downloadArtifact({ artifact: release.artifact, expectedSize: release.size })
    })
    await this.#step(operationId, 'installed', (operation) => this.#installTarget(operation))
    await this.#step(operationId, 'registered', async (operation) => this.#ensureRegistryVersion(operation))
    await this.#step(operationId, 'activation-restored', (operation) => this.#restoreInstaller(operation.moduleId, operation.target))
    await this.#step(operationId, 'registry-restored', (operation) => this.#restoreRegistry(operation, operation.target))
    if (startAfter) return
  }

  async #compensate(operationId: string): Promise<ModuleCoordinatorOperationResult> {
    try {
      await this.#step(operationId, 'compensation-runtime-detached', (operation) => this.#detach(operation.moduleId))
      await this.#step(operationId, 'compensation-daemon-stopped', (operation) => this.#stopRuntime(operation.moduleId))
      await this.#step(operationId, 'compensation-activation-restored', (operation) => this.#restoreInstaller(operation.moduleId, operation.source))
      await this.#step(operationId, 'compensation-registry-restored', (operation) => this.#restoreRegistry(operation, operation.source))
      await this.#step(operationId, 'compensation-daemon-started', async (operation) => {
        if (operation.source.running) await this.#startRuntime(operation.moduleId, operation.source.activeVersion)
      })
      await this.#step(operationId, 'compensation-view-attached', async (operation) => {
        if (operation.source.viewAttached) await this.#attach(operation.moduleId, operation.source.activeVersion)
      })
      return await this.#finish(operationId, false)
    } catch (error) {
      if (error instanceof SimulatedCoordinatorCrash) throw error
      await this.#patchOperation(operationId, { error: `${this.#operation(operationId).error}; compensation: ${this.#errorMessage(error)}` })
      throw error
    }
  }

  async #step(
    operationId: string,
    nextCheckpoint: ModuleCoordinatorCheckpoint,
    action: (operation: ModuleCoordinatorOperation) => void | Promise<void>,
  ): Promise<void> {
    const operation = this.#operation(operationId)
    const sequence = operation.phase === 'forward' ? FORWARD_CHECKPOINTS[operation.kind] : COMPENSATION_CHECKPOINTS
    const currentIndex = sequence.indexOf(operation.checkpoint as never)
    const nextIndex = sequence.indexOf(nextCheckpoint as never)
    if (currentIndex < 0 || nextIndex < 0) {
      throw new ModuleCoordinatorError('INVALID_OPERATION', `Checkpoint ${operation.checkpoint} is invalid for ${operation.kind}/${operation.phase}`)
    }
    if (currentIndex >= nextIndex) return
    if (currentIndex + 1 !== nextIndex) {
      throw new ModuleCoordinatorError('INVALID_OPERATION', `Cannot advance ${operation.kind} from ${operation.checkpoint} to ${nextCheckpoint}`)
    }
    await action(operation)
    await this.#dependencies.faultInjector?.(`before-checkpoint:${nextCheckpoint}`)
    await this.#patchOperation(operationId, { checkpoint: nextCheckpoint })
  }

  async #finish(operationId: string, ok: boolean): Promise<ModuleCoordinatorOperationResult> {
    const operation = this.#operation(operationId)
    const checkpoint = ok ? 'completed' : 'compensated'
    const result: ModuleCoordinatorOperationResult = Object.freeze({
      operationId,
      moduleId: operation.moduleId,
      kind: operation.kind,
      ok,
      source: clone(operation.source),
      target: clone(operation.target),
      completedAt: this.#now(),
      ...(ok ? {} : { error: operation.error ?? 'Operation failed and was compensated' }),
    })
    await this.#patchOperation(operationId, {
      checkpoint,
      status: ok ? 'completed' : 'failed',
      result,
    })
    return result
  }

  async #observe(moduleId: ModuleId): Promise<ModuleCoordinatorTargetState> {
    const installed = await this.#dependencies.installer.getState(moduleId)
    const registry = this.#dependencies.registry.snapshot().modules.find((module) => module.id === moduleId)
    if ((installed.activeVersion !== null || installed.lastKnownGoodVersion !== null) && !registry) {
      throw new ModuleCoordinatorError('STATE_DIVERGED', 'Installer state exists without a registry module')
    }
    if (registry && (registry.activeVersion !== installed.activeVersion || registry.lastKnownGoodVersion !== installed.lastKnownGoodVersion)) {
      throw new ModuleCoordinatorError('STATE_DIVERGED', 'Installer and registry activation states differ')
    }
    const daemon = this.#dependencies.daemon.get(moduleId)
    if (daemonRunning(daemon?.state) && daemon?.version !== installed.activeVersion) {
      throw new ModuleCoordinatorError('STATE_DIVERGED', 'Running daemon version differs from active installer state')
    }
    const view = await this.#dependencies.view.query(moduleId)
    const viewAttached = view?.state === 'attached'
    if (viewAttached && view.version !== installed.activeVersion) {
      throw new ModuleCoordinatorError('STATE_DIVERGED', 'Attached view version differs from active installer state')
    }
    return Object.freeze({
      activeVersion: installed.activeVersion,
      lastKnownGoodVersion: installed.lastKnownGoodVersion,
      running: daemonRunning(daemon?.state),
      viewAttached,
      registryPresent: registry !== undefined,
    })
  }

  #targetFor(kind: ModuleCoordinatorOperationKind, request: ModuleCoordinatorRequest, source: ModuleCoordinatorTargetState): ModuleCoordinatorTargetState {
    if (kind === 'install' || kind === 'update') {
      const version = (request as ModuleCoordinatorInstallRequest).descriptor.manifest.version
      return Object.freeze({
        activeVersion: version,
        lastKnownGoodVersion: source.activeVersion,
        running: kind === 'update',
        viewAttached: kind === 'update',
        registryPresent: true,
      })
    }
    if (kind === 'rollback') {
      if (!source.lastKnownGoodVersion) {
        throw new ModuleCoordinatorError('ACTIVE_VERSION_MISSING', 'Rollback requires a last-known-good version')
      }
      const restart = (request as ModuleCoordinatorRollbackRequest).restartAfterRollback ?? source.running
      return Object.freeze({
        activeVersion: source.lastKnownGoodVersion,
        lastKnownGoodVersion: source.activeVersion,
        running: restart,
        viewAttached: restart && source.viewAttached,
        registryPresent: source.registryPresent,
      })
    }
    if (kind === 'start' || kind === 'restart') {
      if (!source.activeVersion) throw new ModuleCoordinatorError('ACTIVE_VERSION_MISSING', `Cannot ${kind} without an active version`)
      return Object.freeze({ ...source, running: true, viewAttached: true })
    }
    if (kind === 'stop') return Object.freeze({ ...source, running: false, viewAttached: false })
    return source
  }

  async #verifiedRelease(operation: ModuleCoordinatorOperation): Promise<{ artifact: ModuleManifest['artifacts'][number]; size: number }> {
    const request = operation.request as ModuleCoordinatorInstallRequest
    const parsed = parseModuleManifest(request.descriptor.manifest)
    if (!parsed.ok) throw new ModuleCoordinatorError('CATALOG_RELEASE_MISMATCH', 'Durable descriptor contains an invalid manifest')
    const catalog = await this.#dependencies.downloader.fetchCatalog(request.catalogUrl)
    const release = catalog.catalog.releases.find((candidate) => candidate.manifest.id === parsed.value.id && candidate.manifest.version === parsed.value.version)
    if (!release) throw new ModuleCoordinatorError('CATALOG_RELEASE_MISSING', 'Verified catalog does not contain the requested release')
    const artifact = release.manifest.artifacts.find((candidate) => candidate.platform === this.#dependencies.platform)
    const size = release.artifactSizes.find((candidate) => candidate.platform === this.#dependencies.platform)?.size
    if (!artifact || size === undefined) throw new ModuleCoordinatorError('ARTIFACT_MISSING', 'Verified catalog has no host artifact')
    const descriptorArtifact = request.descriptor.artifact
    if (!sameManifest(release.manifest, parsed.value)
      || artifact.platform !== descriptorArtifact.platform
      || artifact.sha256 !== descriptorArtifact.sha256
      || artifact.entrypoint !== descriptorArtifact.entrypoint
      || artifact.url !== descriptorArtifact.url) {
      throw new ModuleCoordinatorError('CATALOG_RELEASE_MISMATCH', 'Descriptor does not match the verified catalog release')
    }
    return { artifact, size }
  }

  async #installTarget(operation: ModuleCoordinatorOperation): Promise<void> {
    const request = operation.request as ModuleCoordinatorInstallRequest
    const parsed = parseModuleManifest(request.descriptor.manifest)
    if (!parsed.ok) throw new ModuleCoordinatorError('CATALOG_RELEASE_MISMATCH', 'Durable descriptor contains an invalid manifest')
    const descriptor = { ...request.descriptor, manifest: parsed.value }
    const current = await this.#dependencies.installer.getState(operation.moduleId)
    if (current.activeVersion === operation.target.activeVersion) return
    if (!sameTarget(current, operation.source)) {
      throw new ModuleCoordinatorError('STATE_DIVERGED', 'Installer is at neither the operation source nor target state')
    }
    try {
      await this.#dependencies.installer.install({
        descriptor,
        archivePath: await this.#dependencies.archiveLocator.locate(descriptor.artifact.sha256),
      })
    } catch (error) {
      if (installerErrorCode(error) !== 'INSTALL_CONFLICT') throw error
      const observed = await this.#dependencies.installer.getState(operation.moduleId)
      if (observed.activeVersion !== operation.target.activeVersion) throw error
    }
  }

  async #ensureRegistryVersion(operation: ModuleCoordinatorOperation): Promise<void> {
    const request = operation.request as ModuleCoordinatorInstallRequest
    const parsed = parseModuleManifest(request.descriptor.manifest)
    if (!parsed.ok) throw new ModuleCoordinatorError('CATALOG_RELEASE_MISMATCH', 'Durable descriptor contains an invalid manifest')
    const existing = this.#dependencies.registry.snapshot().modules
      .find((module) => module.id === operation.moduleId)?.versions
      .find((version) => version.version === parsed.value.version)
    if (existing) {
      if (!sameManifest(existing.manifest, parsed.value) || existing.hostVersionRange !== request.hostVersionRange) {
        throw new ModuleCoordinatorError('CATALOG_RELEASE_MISMATCH', 'Registry version conflicts with the verified release')
      }
      return
    }
    this.#requireRegistry(this.#dependencies.registry.install(parsed.value, { hostVersionRange: request.hostVersionRange }))
  }

  async #restoreInstaller(moduleId: ModuleId, target: ModuleCoordinatorTargetState): Promise<void> {
    const current = await this.#dependencies.installer.getState(moduleId)
    if (sameTarget(current, target)) return
    await this.#dependencies.installer.restoreState({
      moduleId,
      activeVersion: target.activeVersion,
      lastKnownGoodVersion: target.lastKnownGoodVersion,
    })
  }

  async #restoreRegistry(operation: ModuleCoordinatorOperation, target: ModuleCoordinatorTargetState): Promise<void> {
    const module = this.#dependencies.registry.snapshot().modules.find((candidate) => candidate.id === operation.moduleId)
    if (!target.registryPresent) {
      if (!module) return
      const request = operation.request as Partial<ModuleCoordinatorInstallRequest>
      const version = request.descriptor?.manifest.version
      if (!version || !module.versions.some((candidate) => candidate.version === version)) {
        throw new ModuleCoordinatorError('STATE_DIVERGED', 'Compensation cannot identify the newly registered version')
      }
      const transition = {
        ...(module.activeVersion === version ? { activeVersion: null } : {}),
        ...(module.lastKnownGoodVersion === version ? { lastKnownGoodVersion: null } : {}),
      }
      this.#requireRegistry(this.#dependencies.registry.remove(operation.moduleId, version, transition))
      return
    }
    if (!module) throw new ModuleCoordinatorError('STATE_DIVERGED', 'Registry module is missing during activation restoration')
    if (module.activeVersion === target.activeVersion && module.lastKnownGoodVersion === target.lastKnownGoodVersion) return
    this.#requireRegistry(this.#dependencies.registry.restoreActivation(operation.moduleId, {
      activeVersion: target.activeVersion,
      lastKnownGoodVersion: target.lastKnownGoodVersion,
    }))
  }

  async #startRuntime(moduleId: ModuleId, version: ModuleVersion | null): Promise<void> {
    if (!version) throw new ModuleCoordinatorError('ACTIVE_VERSION_MISSING', 'Runtime target has no active version')
    const current = this.#dependencies.daemon.get(moduleId)
    if (current && daemonRunning(current.state) && current.version !== version) await this.#stopRuntime(moduleId)
    let lease = this.#runtimeLeases.get(moduleId)
    if (lease && lease.version !== version) {
      lease.release()
      this.#runtimeLeases.delete(moduleId)
      lease = undefined
    }
    if (!lease) {
      this.#runtimeLeases.set(moduleId, { version, release: await this.#dependencies.usage.acquireReference(moduleId, version) })
    }
    const afterLease = this.#dependencies.daemon.get(moduleId)
    if (afterLease && (afterLease.state === 'healthy' || afterLease.state === 'degraded') && afterLease.version === version) return
    const registered = this.#dependencies.registry.snapshot().modules.find((module) => module.id === moduleId)
    const installed = registered?.versions.find((candidate) => candidate.version === version)
    if (!registered || !installed || registered.activeVersion !== version) {
      this.#releaseRuntimeLease(moduleId)
      throw new ModuleCoordinatorError('ACTIVE_VERSION_MISSING', 'Registry does not contain the runtime target version')
    }
    try {
      await this.#dependencies.daemon.start({
        manifest: installed.manifest,
        activatedRoot: await this.#dependencies.activationLocator.locate(moduleId, version),
        platform: this.#dependencies.platform,
      })
    } catch (error) {
      await this.#dependencies.daemon.stop(moduleId).catch(() => undefined)
      this.#releaseRuntimeLease(moduleId)
      throw error
    }
  }

  async #attach(moduleId: ModuleId, version: ModuleVersion | null): Promise<void> {
    if (!version) throw new ModuleCoordinatorError('ACTIVE_VERSION_MISSING', 'View target has no active version')
    const current = await this.#dependencies.view.query(moduleId)
    if (current?.state === 'attached' && current.version === version) return
    if (current) await this.#dependencies.view.detach(moduleId)
    const daemon = this.#dependencies.daemon.get(moduleId)
    if (!daemon || (daemon.state !== 'healthy' && daemon.state !== 'degraded') || daemon.version !== version) {
      throw new ModuleCoordinatorError('VIEW_STATE_INVALID', 'View attachment requires a ready daemon for the target version')
    }
    const attached = await this.#dependencies.view.attach({ moduleId, version, daemon })
    if (attached.state !== 'attached' || attached.version !== version) {
      throw new ModuleCoordinatorError('VIEW_STATE_INVALID', 'View port did not attach the target version')
    }
  }

  async #detach(moduleId: ModuleId): Promise<void> {
    const current = await this.#dependencies.view.query(moduleId)
    if (!current || current.state === 'detached') return
    await this.#dependencies.view.detach(moduleId)
    const remaining = await this.#dependencies.view.query(moduleId)
    if (remaining && remaining.state !== 'detached') {
      throw new ModuleCoordinatorError('VIEW_STATE_INVALID', 'View remained attached after detach')
    }
  }

  async #stopRuntime(moduleId: ModuleId): Promise<void> {
    const current = this.#dependencies.daemon.get(moduleId)
    if (current && current.state !== 'stopped') await this.#dependencies.daemon.stop(moduleId)
    this.#releaseRuntimeLease(moduleId)
  }

  #releaseRuntimeLease(moduleId: ModuleId): void {
    const lease = this.#runtimeLeases.get(moduleId)
    if (!lease) return
    this.#runtimeLeases.delete(moduleId)
    lease.release()
  }

  async #uninstallVersion(operation: ModuleCoordinatorOperation): Promise<void> {
    const request = operation.request as ModuleCoordinatorUninstallRequest
    if (!await this.#dependencies.activationLocator.isInstalled(operation.moduleId, request.version)) return
    try {
      await this.#dependencies.installer.uninstall({ moduleId: operation.moduleId, version: request.version })
    } catch (error) {
      if (installerErrorCode(error) === 'NOT_INSTALLED'
        && !await this.#dependencies.activationLocator.isInstalled(operation.moduleId, request.version)) return
      throw error
    }
  }

  async #removeRegistryVersion(operation: ModuleCoordinatorOperation): Promise<void> {
    const request = operation.request as ModuleCoordinatorUninstallRequest
    const module = this.#dependencies.registry.snapshot().modules.find((candidate) => candidate.id === operation.moduleId)
    if (!module || !module.versions.some((candidate) => candidate.version === request.version)) return
    this.#requireRegistry(this.#dependencies.registry.remove(operation.moduleId, request.version))
  }

  #requireRegistry(result: { readonly ok: boolean; readonly diagnostics: readonly { readonly message: string }[] }): void {
    if (!result.ok) throw new ModuleCoordinatorError('REGISTRY_MUTATION_FAILED', result.diagnostics.map((item) => item.message).join('; '))
  }

  #operationId(value: string | undefined): string {
    const operationId = value ?? globalThis.crypto.randomUUID()
    if (!OPERATION_ID.test(operationId)) throw new ModuleCoordinatorError('INVALID_OPERATION', 'operationId is invalid')
    return operationId
  }

  #assertSameOperation(existing: ModuleCoordinatorOperation, kind: ModuleCoordinatorOperationKind, moduleId: ModuleId, fingerprint: string): void {
    if (existing.kind !== kind || existing.moduleId !== moduleId || existing.fingerprint !== fingerprint) this.#operationConflict(existing.id)
  }

  #operationConflict(operationId: string): never {
    throw new ModuleCoordinatorError('OPERATION_ID_CONFLICT', `operationId ${operationId} is already bound to a different request`)
  }

  #operation(operationId: string): ModuleCoordinatorOperation {
    const operation = this.#state.operations.find((candidate) => candidate.id === operationId)
    if (!operation) throw new ModuleCoordinatorError('INVALID_OPERATION', `Unknown operation: ${operationId}`)
    return operation
  }

  async #appendOperation(operation: ModuleCoordinatorOperation): Promise<void> {
    await this.#commit(() => {
      if (this.#state.operations.some((candidate) => candidate.id === operation.id)) this.#operationConflict(operation.id)
      this.#state = { ...this.#state, operations: [...this.#state.operations, clone(operation)] }
    })
  }

  async #patchOperation(operationId: string, patch: Partial<ModuleCoordinatorOperation>): Promise<void> {
    await this.#commit(() => {
      const current = this.#operation(operationId)
      const next = { ...current, ...clone(patch), updatedAt: this.#now() }
      this.#state = {
        ...this.#state,
        operations: this.#state.operations.map((candidate) => candidate.id === operationId ? next : candidate),
      }
    })
  }

  async #recordDaemonSnapshot(snapshot: import('@simulator/module-daemon').ModuleDaemonSnapshot): Promise<void> {
    await this.#ready
    await this.#commit(() => {
      const event: ModuleCoordinatorEvent = { moduleId: snapshot.id, at: this.#now(), snapshot: clone(snapshot) }
      this.#state = { ...this.#state, events: [...this.#state.events, event].slice(-MAX_EVENTS) }
    })
  }

  async #handleDaemonSnapshot(snapshot: import('@simulator/module-daemon').ModuleDaemonSnapshot): Promise<void> {
    await this.#recordDaemonSnapshot(snapshot)
    if (!this.#acceptEvents || (snapshot.state !== 'crashed' && snapshot.state !== 'stopped'
      && snapshot.state !== 'healthy' && snapshot.state !== 'degraded')) return
    await this.#enqueue(snapshot.id, async () => {
      if (!this.#acceptEvents) return
      if (snapshot.state === 'crashed' || snapshot.state === 'stopped') {
        await this.#detach(snapshot.id)
        return
      }
      const operation = [...this.#state.operations].reverse().find((candidate) => candidate.moduleId === snapshot.id)
      if (!operation) return
      const desired = operation.status === 'failed' || operation.phase === 'compensating' ? operation.source : operation.target
      if (desired.running && desired.viewAttached && desired.activeVersion === snapshot.version) {
        await this.#attach(snapshot.id, desired.activeVersion)
      }
    })
  }

  async #commit(mutate: () => void): Promise<void> {
    const next = this.#commitTail.then(async () => {
      mutate()
      await this.#dependencies.store.save(clone(this.#state))
    })
    this.#commitTail = next.catch(() => undefined)
    await next
  }

  async #enqueue<T>(moduleId: ModuleId, operation: () => Promise<T>): Promise<T> {
    const prior = this.#moduleTails.get(moduleId) ?? Promise.resolve()
    const current = prior.catch(() => undefined).then(operation)
    this.#moduleTails.set(moduleId, current)
    try {
      return await current
    } finally {
      if (this.#moduleTails.get(moduleId) === current) this.#moduleTails.delete(moduleId)
    }
  }

  #errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }
}
