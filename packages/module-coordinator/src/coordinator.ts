import { randomUUID } from 'node:crypto'
import type { ModuleDaemonManager, ModuleDaemonSnapshot } from '@simulator/module-daemon'
import type { ModuleDownloader } from '@simulator/module-downloader'
import { ModuleInstaller, ModuleInstallerError } from '@simulator/module-installer'
import { ModuleRegistry } from '@simulator/module-registry'
import { parseModuleManifest, type ModuleId, type ModuleManifest, type ModulePlatform, type ModuleVersion } from '@simulator/module-contract'
import {
  MODULE_COORDINATOR_STATE_SCHEMA_VERSION,
  ModuleCoordinatorError,
  SimulatedCoordinatorCrash,
  type ModuleActivationLocator,
  type ModuleArchiveLocator,
  type ModuleCoordinatorCheckpoint,
  type ModuleCoordinatorEvent,
  type ModuleCoordinatorInstallRequest,
  type ModuleCoordinatorOperation,
  type ModuleCoordinatorOperationKind,
  type ModuleCoordinatorRollbackRequest,
  type ModuleCoordinatorSnapshot,
  type ModuleCoordinatorStore,
  type ModuleCoordinatorUninstallRequest,
  type ModuleViewPort,
} from './types.ts'

const MAX_EVENTS = 256

interface Dependencies {
  readonly downloader: Pick<ModuleDownloader, 'fetchCatalog' | 'downloadArtifact'>
  readonly installer: Pick<ModuleInstaller, 'install' | 'getState' | 'rollback' | 'uninstall' | 'recoverAll'>
  readonly registry: ModuleRegistry
  readonly daemon: Pick<ModuleDaemonManager, 'start' | 'stop' | 'get' | 'subscribe'>
  readonly platform: ModulePlatform
  readonly archiveLocator: ModuleArchiveLocator
  readonly activationLocator: ModuleActivationLocator
  readonly store: ModuleCoordinatorStore
  readonly view?: ModuleViewPort
  readonly now?: () => number
}

type OperationRequest = ModuleCoordinatorInstallRequest | ModuleCoordinatorRollbackRequest | ModuleCoordinatorUninstallRequest | undefined

function clone<T>(value: T): T {
  return structuredClone(value)
}

function isRunning(snapshot: ModuleDaemonSnapshot | undefined): boolean {
  return snapshot?.state === 'starting' || snapshot?.state === 'healthy' || snapshot?.state === 'degraded' || snapshot?.state === 'crashed'
}

function sameManifest(left: ModuleManifest, right: ModuleManifest): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export class ModuleCoordinator {
  readonly #dependencies: Dependencies
  readonly #now: () => number
  readonly #moduleTails = new Map<ModuleId, Promise<unknown>>()
  readonly #ready: Promise<void>
  #state: { schemaVersion: typeof MODULE_COORDINATOR_STATE_SCHEMA_VERSION; operations: ModuleCoordinatorOperation[]; events: ModuleCoordinatorEvent[] } = {
    schemaVersion: MODULE_COORDINATOR_STATE_SCHEMA_VERSION,
    operations: [],
    events: [],
  }
  #commitTail: Promise<void> = Promise.resolve()

  constructor(dependencies: Dependencies) {
    this.#dependencies = dependencies
    this.#now = dependencies.now ?? Date.now
    this.#ready = this.#load()
    dependencies.daemon.subscribe((snapshot) => {
      void this.#recordDaemonSnapshot(snapshot)
      void dependencies.view?.onDaemonSnapshot?.(snapshot)
    })
  }

  async install(request: ModuleCoordinatorInstallRequest): Promise<void> {
    await this.#createAndRun(request.descriptor.manifest.id, 'install', request)
  }

  async update(request: ModuleCoordinatorInstallRequest): Promise<void> {
    await this.#createAndRun(request.descriptor.manifest.id, 'update', request)
  }

  async rollback(moduleId: ModuleId, restartAfterRollback = true): Promise<void> {
    await this.#createAndRun(moduleId, 'rollback', { moduleId, restartAfterRollback })
  }

  async start(moduleId: ModuleId): Promise<void> {
    await this.#createAndRun(moduleId, 'start')
  }

  async restart(moduleId: ModuleId): Promise<void> {
    await this.#createAndRun(moduleId, 'restart')
  }

  async stop(moduleId: ModuleId): Promise<void> {
    await this.#createAndRun(moduleId, 'stop')
  }

  async uninstall(request: ModuleCoordinatorUninstallRequest): Promise<void> {
    await this.#createAndRun(request.moduleId, 'uninstall', request)
  }

  /** Recovers installer journals first, then idempotently replays every pending intent. */
  async recover(): Promise<void> {
    await this.#ready
    await this.#dependencies.installer.recoverAll()
    const pending = this.#state.operations.filter((operation) => operation.status === 'pending')
    await Promise.all(pending.map(async (operation) => await this.#enqueue(operation.moduleId, async () => await this.#execute(operation))))
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

  async #load(): Promise<void> {
    const persisted = await this.#dependencies.store.load()
    if (!persisted) return
    this.#state = {
      schemaVersion: MODULE_COORDINATOR_STATE_SCHEMA_VERSION,
      operations: [...clone(persisted.operations)],
      events: [...clone(persisted.events).slice(-MAX_EVENTS)],
    }
  }

  async #createAndRun(moduleId: ModuleId, kind: ModuleCoordinatorOperationKind, request?: OperationRequest): Promise<void> {
    await this.#ready
    await this.#enqueue(moduleId, async () => {
      const now = this.#now()
      const operation: ModuleCoordinatorOperation = {
        id: randomUUID(), moduleId, kind, request: request ? clone(request) : undefined,
        checkpoint: 'intent-recorded', status: 'pending', createdAt: now, updatedAt: now,
      }
      await this.#replaceOperation(operation)
      await this.#execute(operation)
    })
  }

  async #execute(operation: ModuleCoordinatorOperation): Promise<void> {
    try {
      switch (operation.kind) {
        case 'install':
        case 'update':
          await this.#installOrUpdate(operation)
          break
        case 'rollback':
          await this.#rollback(operation)
          break
        case 'start':
          await this.#start(operation)
          break
        case 'restart':
          await this.#restart(operation)
          break
        case 'stop':
          await this.#stop(operation)
          break
        case 'uninstall':
          await this.#uninstall(operation)
          break
      }
      await this.#setOperation(operation.id, { checkpoint: 'completed', status: 'completed' })
    } catch (error) {
      if (error instanceof SimulatedCoordinatorCrash) throw error
      await this.#setOperation(operation.id, {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      }).catch(() => undefined)
      throw error
    }
  }

  async #installOrUpdate(operation: ModuleCoordinatorOperation): Promise<void> {
    const request = operation.request as ModuleCoordinatorInstallRequest | undefined
    if (!request || !('catalogUrl' in request)) throw new ModuleCoordinatorError('INVALID_OPERATION', 'Install operation is missing its durable request')
    const parsedDescriptorManifest = parseModuleManifest(request.descriptor.manifest)
    if (!parsedDescriptorManifest.ok) {
      throw new ModuleCoordinatorError('CATALOG_RELEASE_MISMATCH', 'Durable installer descriptor contains an invalid manifest')
    }
    const descriptor = { ...request.descriptor, manifest: parsedDescriptorManifest.value }
    const catalog = await this.#dependencies.downloader.fetchCatalog(request.catalogUrl)
    const release = catalog.catalog.releases.find((candidate) => candidate.manifest.id === descriptor.manifest.id && candidate.manifest.version === descriptor.manifest.version)
    if (!release) throw new ModuleCoordinatorError('CATALOG_RELEASE_MISSING', 'Verified catalog does not contain the requested module release')
    const artifact = release.manifest.artifacts.find((candidate) => candidate.platform === this.#dependencies.platform)
    const size = release.artifactSizes.find((candidate) => candidate.platform === this.#dependencies.platform)?.size
    if (!artifact || size === undefined) throw new ModuleCoordinatorError('ARTIFACT_MISSING', 'Verified catalog has no artifact for the host platform')
    if (!sameManifest(release.manifest, descriptor.manifest)
      || artifact.platform !== descriptor.artifact.platform
      || artifact.sha256 !== descriptor.artifact.sha256
      || artifact.entrypoint !== descriptor.artifact.entrypoint
      || artifact.url !== descriptor.artifact.url) {
      throw new ModuleCoordinatorError('CATALOG_RELEASE_MISMATCH', 'Installer descriptor does not match the verified catalog release')
    }
    await this.#checkpoint(operation.id, 'catalog-verified')
    await this.#dependencies.downloader.downloadArtifact({ artifact, expectedSize: size })
    await this.#checkpoint(operation.id, 'artifact-downloaded')
    const state = await this.#installIdempotently({ ...request, descriptor })
    await this.#checkpoint(operation.id, 'installed')
    this.#ensureRegistryVersion(descriptor.manifest, request.hostVersionRange)
    await this.#checkpoint(operation.id, 'registered')
    this.#requireRegistrySuccess(this.#dependencies.registry.activate(descriptor.manifest.id, descriptor.manifest.version))
    if (state.lastKnownGoodVersion) this.#requireRegistrySuccess(this.#dependencies.registry.markLastKnownGood(descriptor.manifest.id, state.lastKnownGoodVersion))
    await this.#checkpoint(operation.id, 'activated')
  }

  async #installIdempotently(request: ModuleCoordinatorInstallRequest) {
    const descriptor = request.descriptor
    try {
      return await this.#dependencies.installer.install({
        descriptor,
        archivePath: await this.#dependencies.archiveLocator.locate(descriptor.artifact.sha256),
      })
    } catch (error) {
      if (!(error instanceof ModuleInstallerError) || error.code !== 'INSTALL_CONFLICT') throw error
      const state = await this.#dependencies.installer.getState(descriptor.manifest.id)
      if (state.activeVersion !== descriptor.manifest.version) throw error
      return {
        ...state,
        installedPath: await this.#dependencies.activationLocator.locate(descriptor.manifest.id, descriptor.manifest.version),
        archiveSha256: descriptor.artifact.sha256,
        extractedManifestSha256: descriptor.extractedManifestSha256,
      }
    }
  }

  async #rollback(operation: ModuleCoordinatorOperation): Promise<void> {
    const request = operation.request as ModuleCoordinatorRollbackRequest | undefined
    if (!request || !('restartAfterRollback' in request)) throw new ModuleCoordinatorError('INVALID_OPERATION', 'Rollback operation is missing its durable request')
    await this.#dependencies.daemon.stop(operation.moduleId)
    await this.#checkpoint(operation.id, 'daemon-stopped')
    const rollback = await this.#dependencies.installer.rollback(operation.moduleId)
    this.#requireRegistrySuccess(this.#dependencies.registry.activate(operation.moduleId, rollback.activeVersion!))
    if (rollback.lastKnownGoodVersion) this.#requireRegistrySuccess(this.#dependencies.registry.markLastKnownGood(operation.moduleId, rollback.lastKnownGoodVersion))
    await this.#checkpoint(operation.id, 'rolled-back')
    if (request.restartAfterRollback) {
      await this.#startDaemon(operation.moduleId)
      await this.#checkpoint(operation.id, 'daemon-started')
    }
  }

  async #start(operation: ModuleCoordinatorOperation): Promise<void> {
    await this.#startDaemon(operation.moduleId)
    await this.#checkpoint(operation.id, 'daemon-started')
  }

  async #restart(operation: ModuleCoordinatorOperation): Promise<void> {
    await this.#dependencies.daemon.stop(operation.moduleId)
    await this.#checkpoint(operation.id, 'daemon-stopped')
    await this.#startDaemon(operation.moduleId)
    await this.#checkpoint(operation.id, 'daemon-started')
  }

  async #stop(operation: ModuleCoordinatorOperation): Promise<void> {
    await this.#dependencies.daemon.stop(operation.moduleId)
    await this.#checkpoint(operation.id, 'daemon-stopped')
  }

  async #uninstall(operation: ModuleCoordinatorOperation): Promise<void> {
    const request = operation.request as ModuleCoordinatorUninstallRequest | undefined
    if (!request || !('version' in request)) throw new ModuleCoordinatorError('INVALID_OPERATION', 'Uninstall operation is missing its durable request')
    await this.#dependencies.installer.uninstall(request)
    this.#requireRegistrySuccess(this.#dependencies.registry.remove(request.moduleId, request.version))
    await this.#checkpoint(operation.id, 'uninstalled')
  }

  async #startDaemon(moduleId: ModuleId): Promise<void> {
    const state = await this.#dependencies.installer.getState(moduleId)
    if (!state.activeVersion) throw new ModuleCoordinatorError('ACTIVE_VERSION_MISSING', 'Cannot start a module without an active installed version')
    const registered = this.#dependencies.registry.snapshot().modules.find((module) => module.id === moduleId)
    const version = registered?.versions.find((candidate) => candidate.version === state.activeVersion)
    if (!registered || !version || registered.activeVersion !== state.activeVersion) {
      throw new ModuleCoordinatorError('ACTIVE_VERSION_MISSING', 'Registry does not contain the active installed module version')
    }
    await this.#dependencies.daemon.start({
      manifest: version.manifest,
      activatedRoot: await this.#dependencies.activationLocator.locate(moduleId, state.activeVersion),
      platform: this.#dependencies.platform,
    })
  }

  #ensureRegistryVersion(manifest: ModuleManifest, hostVersionRange: string): void {
    const existing = this.#dependencies.registry.snapshot().modules
      .find((module) => module.id === manifest.id)?.versions
      .find((version) => version.version === manifest.version)
    if (existing) {
      if (!sameManifest(existing.manifest, manifest) || existing.hostVersionRange !== hostVersionRange) {
        throw new ModuleCoordinatorError('CATALOG_RELEASE_MISMATCH', 'Installed registry version conflicts with the verified release')
      }
      return
    }
    this.#requireRegistrySuccess(this.#dependencies.registry.install(manifest, { hostVersionRange }))
  }

  #requireRegistrySuccess(result: { readonly ok: boolean; readonly diagnostics: readonly { readonly message: string }[] }): void {
    if (result.ok) return
    throw new ModuleCoordinatorError('REGISTRY_MUTATION_FAILED', result.diagnostics.map((diagnostic) => diagnostic.message).join('; '))
  }

  async #checkpoint(operationId: string, checkpoint: ModuleCoordinatorCheckpoint): Promise<void> {
    await this.#setOperation(operationId, { checkpoint })
  }

  async #replaceOperation(operation: ModuleCoordinatorOperation): Promise<void> {
    await this.#commit(() => {
      this.#state = { ...this.#state, operations: [...this.#state.operations, clone(operation)] }
    })
  }

  async #setOperation(operationId: string, patch: Partial<ModuleCoordinatorOperation>): Promise<void> {
    await this.#commit(() => {
      const operation = this.#state.operations.find((candidate) => candidate.id === operationId)
      if (!operation) throw new ModuleCoordinatorError('INVALID_OPERATION', `Unknown coordinator operation: ${operationId}`)
      const next = { ...operation, ...patch, updatedAt: this.#now() }
      this.#state = {
        ...this.#state,
        operations: this.#state.operations.map((candidate) => candidate.id === operationId ? next : candidate),
      }
    })
  }

  async #recordDaemonSnapshot(snapshot: ModuleDaemonSnapshot): Promise<void> {
    await this.#ready
    await this.#commit(() => {
      const event: ModuleCoordinatorEvent = { moduleId: snapshot.id, at: this.#now(), snapshot: clone(snapshot) }
      this.#state = { ...this.#state, events: [...this.#state.events, event].slice(-MAX_EVENTS) }
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

  async #enqueue(moduleId: ModuleId, operation: () => Promise<void>): Promise<void> {
    const prior = this.#moduleTails.get(moduleId) ?? Promise.resolve()
    const current = prior.catch(() => undefined).then(operation)
    this.#moduleTails.set(moduleId, current)
    try {
      await current
    } finally {
      if (this.#moduleTails.get(moduleId) === current) this.#moduleTails.delete(moduleId)
    }
  }
}
