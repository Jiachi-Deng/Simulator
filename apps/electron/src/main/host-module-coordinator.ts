import { chmodSync, lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import type { ModuleId, ModulePlatform } from '@simulator/module-contract'
import {
  ModuleCoordinator,
  ModuleRuntimeUseGate,
  type ModuleCoordinatorSnapshot,
} from '@simulator/module-coordinator'
import { NodeFilesystemModuleCoordinatorStore } from '@simulator/module-coordinator/node'
import {
  ModuleDownloader,
  NodeFetchAdapter,
  NodeFilesystemModuleDownloaderCache,
  type ModuleDownloaderOptions,
} from '@simulator/module-downloader'
import { ModuleInstaller } from '@simulator/module-installer'
import { ModuleRegistry, type ModuleRegistryOptions } from '@simulator/module-registry'
import { FilesystemModuleRegistryPersistence } from '@simulator/module-registry/filesystem'
import {
  LoopbackHttpHealthAdapter,
  ModuleDaemonManager,
  RealClock,
  RealProcessAdapter,
  type PrepareModuleDaemonLaunch,
} from '@simulator/module-daemon'
import { ElectronModuleViewPort } from './electron-module-view-port'
import type { ModuleViewFailure, ModuleViewManager } from './module-view-manager'

export interface HostModuleCoordinatorOptions {
  readonly root: string
  readonly hostVersion: string
  readonly platform: ModulePlatform
  readonly trustedKeys: ModuleDownloaderOptions['trustedKeys']
  readonly githubReleaseRedirectPolicy?: ModuleDownloaderOptions['githubReleaseRedirectPolicy']
  readonly moduleViewManager: ModuleViewManager
  readonly hostWindow: () => BrowserWindow | undefined
  readonly onHostClose?: (moduleId: ModuleId) => void | Promise<void>
  readonly onHostCloseError?: (error: unknown, moduleId: ModuleId) => void | Promise<void>
  readonly onViewFailure?: (failure: ModuleViewFailure, moduleId: ModuleId) => void | Promise<void>
  readonly onViewFailureError?: (error: unknown, moduleId: ModuleId) => void | Promise<void>
  readonly fetch?: ModuleDownloaderOptions['fetch']
  readonly clock?: HostModuleClock
  readonly daemonEnvironment?: Readonly<Record<string, string>>
  readonly prepareModuleAgentLaunch?: PrepareModuleDaemonLaunch
  readonly registryCompatibilityExceptions?: ModuleRegistryOptions['compatibilityExceptions']
}

export class HostModuleClock extends RealClock {
  setTimeout(callback: () => void, milliseconds: number): () => void {
    const timer = setTimeout(callback, milliseconds)
    return () => clearTimeout(timer)
  }
}

export interface HostModuleCoordinatorRuntime {
  readonly coordinator: ModuleCoordinator
  readonly daemon: ModuleDaemonManager
  readonly registry: ModuleRegistry
  readonly usage: ModuleRuntimeUseGate
  readonly view: ElectronModuleViewPort
  snapshot(): Promise<ModuleCoordinatorSnapshot>
  dispose(): Promise<void>
}

export function currentModulePlatform(): ModulePlatform {
  return `${process.platform}-${process.arch}` as ModulePlatform
}

export function createHostModuleCoordinator(options: HostModuleCoordinatorOptions): HostModuleCoordinatorRuntime {
  mkdirSync(options.root, { recursive: true, mode: 0o700 })
  let trustBoundary = lstatSync(options.root)
  if (!trustBoundary.isDirectory() || trustBoundary.isSymbolicLink()
    || (typeof process.getuid === 'function' && trustBoundary.uid !== process.getuid())) {
    throw new TypeError('Host module root must be a host-owned real directory')
  }
  if (process.platform !== 'win32') {
    chmodSync(options.root, 0o700)
    trustBoundary = lstatSync(options.root)
  }
  realpathSync(options.root)
  if (process.platform !== 'win32' && (trustBoundary.mode & 0o077) !== 0) {
    throw new TypeError('Host module root must be an owner-only canonical trust boundary')
  }
  const cacheRoot = join(options.root, 'download-cache')
  const installedRoot = join(options.root, 'installed')
  const moduleDataRoot = join(options.root, 'module-data')
  const clock = options.clock ?? new HostModuleClock()
  const usage = new ModuleRuntimeUseGate()
  const downloader = new ModuleDownloader({
    fetch: options.fetch ?? new NodeFetchAdapter(),
    cache: new NodeFilesystemModuleDownloaderCache(cacheRoot),
    clock,
    trustedKeys: options.trustedKeys,
    githubReleaseRedirectPolicy: options.githubReleaseRedirectPolicy,
  })
  const installer = new ModuleInstaller(installedRoot, { usageGuard: usage })
  const registry = new ModuleRegistry(
    { version: options.hostVersion, platform: options.platform },
    new FilesystemModuleRegistryPersistence(join(options.root, 'registry')),
    { compatibilityExceptions: options.registryCompatibilityExceptions },
  )
  const daemon = new ModuleDaemonManager({
    process: new RealProcessAdapter(),
    clock,
    health: new LoopbackHttpHealthAdapter(),
    baseEnvironment: options.daemonEnvironment,
    moduleDataRoot,
    prepareLaunch: async (context) => {
      const installed = registry.snapshot().modules
        .find((module) => module.id === context.id)
        ?.versions.find((version) => version.version === context.version)
      if (!installed?.manifest.capabilities.includes('host-agent.use')) {
        return { cleanup: async () => undefined }
      }
      if (!options.prepareModuleAgentLaunch) {
        throw new Error('Module declares host-agent.use but the Host Agent runtime is unavailable')
      }
      return options.prepareModuleAgentLaunch(context)
    },
  })
  const view = new ElectronModuleViewPort({
    manager: options.moduleViewManager,
    hostWindow: options.hostWindow,
    onHostClose: options.onHostClose,
    onHostCloseError: options.onHostCloseError,
    onViewFailure: options.onViewFailure,
    onViewFailureError: options.onViewFailureError,
  })
  const coordinator = new ModuleCoordinator({
    downloader,
    installer,
    registry,
    daemon,
    platform: options.platform,
    archiveLocator: {
      locate: async (sha256) => join(cacheRoot, 'artifacts', sha256, 'artifact.bin'),
    },
    activationLocator: {
      locate: async (moduleId, version) => join(installedRoot, 'modules', moduleId, 'versions', version),
      isInstalled: async (moduleId, version) => {
        try {
          return (await lstat(join(installedRoot, 'modules', moduleId, 'versions', version))).isDirectory()
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
          throw error
        }
      },
    },
    store: new NodeFilesystemModuleCoordinatorStore(join(options.root, 'coordinator'), {
      trustedBoundary: options.root,
    }),
    view,
    usage,
  })

  return {
    coordinator,
    daemon,
    registry,
    usage,
    view,
    snapshot: () => coordinator.snapshot(),
    async dispose() {
      await coordinator.dispose()
      await daemon.drain()
      view.dispose()
    },
  }
}
