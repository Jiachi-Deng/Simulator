import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import type { ModuleId, ModuleVersion } from '@simulator/module-contract'
import type {
  ModuleCoordinator,
  ModuleCoordinatorOperationResult,
  ModuleCoordinatorReleaseRequest,
  ModuleViewPort,
  ModuleViewSnapshot,
  ResolvedModuleCoordinatorInstallRequest,
} from '@simulator/module-coordinator'
import type { ModuleDaemonSnapshot } from '@simulator/module-daemon'
import type { ModuleRegistry } from '@simulator/module-registry'
import {
  OPEN_DESIGN_ACCEPTANCE_CHANNELS,
  type OpenDesignAcceptanceAction,
  type OpenDesignAcceptanceState,
} from '../shared/open-design-acceptance-ipc'
import { OPEN_DESIGN_MODULE_ID } from '../shared/open-design-module-ipc'
import type { OpenDesignDevelopmentBootstrap } from './open-design-development-bootstrap'
import type { OpenDesignOfficialChannelBootstrap } from './open-design-official-channel'
import type { OpenDesignMutationGate } from './open-design-mutation-gate'

export const OPEN_DESIGN_ACCEPTANCE_ENV = 'SIMULATOR_HOST_MODULE_ACCEPTANCE' as const
export const OPEN_DESIGN_ACCEPTANCE_DESCRIPTOR_RELATIVE_PATH = join(
  'open-design-acceptance',
  'rc-control-v1.json',
)

export const OPEN_DESIGN_ACCEPTANCE_IDENTITY = Object.freeze({
  schemaVersion: 1,
  hostVersion: '0.12.0',
  moduleId: OPEN_DESIGN_MODULE_ID,
  platform: 'darwin-arm64',
  stableVersion: '0.14.5',
  stableCatalogUrl: 'https://github.com/Jiachi-Deng/Simulator/releases/download/open-design-v0.14.5/org.simulator.open-design-0.14.5-catalog-v2-envelope.json',
  rcVersion: '0.14.6-rc.1',
  releaseTag: 'open-design-v0.14.6-rc.1',
  catalogUrl: 'https://github.com/Jiachi-Deng/Simulator/releases/download/open-design-v0.14.6-rc.1/org.simulator.open-design-0.14.6-rc.1-catalog-v2-envelope.json',
  minimumCatalogSequence: 2,
  initialCatalogIssuedAt: '2026-07-16T21:35:33.862Z',
  archiveUrl: 'https://github.com/Jiachi-Deng/Simulator/releases/download/open-design-v0.14.6-rc.1/org.simulator.open-design-0.14.6-rc.1-darwin-arm64.tar.gz',
  archiveSha256: '1dd67f6ac536b61009410014ceab562bcba24e0d2694e353914915338d0ef0a3',
  artifactSize: 61_478_074,
  extractedManifestSha256: 'f24ad9a7035731f4f3b3e23b8f3b6c6c9654d4502dda43d9cb70d8d2159c7bbe',
  entrypoint: 'runtime/open-design-launcher',
  auxiliaryExecutables: Object.freeze([
    'runtime/node/bin/node',
    'runtime/daemon/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper',
  ]),
  capabilities: Object.freeze(['host-agent.use', 'workspace.read', 'workspace.write']),
  hostVersionRange: '>=0.12.0',
  githubOwner: 'Jiachi-Deng',
  githubRepository: 'Simulator',
  trustedKeyId: 'open-design-release-2026-01',
  trustedPublicKeySha256: 'f4e7b85cfa73e1f48caceed15aa5d4d0136a63ac73dcdc495ddee1229f5d0d6d',
  trustedKeyActiveFrom: '2026-07-15T00:00:00.000Z',
  trustedKeyActiveUntil: '2027-07-15T00:00:00.000Z',
} as const)

const DESCRIPTOR_FIELDS = [
  'schemaVersion',
  'hostVersion',
  'moduleId',
  'platform',
  'stableVersion',
  'stableCatalogUrl',
  'rcVersion',
  'releaseTag',
  'catalogUrl',
  'minimumCatalogSequence',
  'initialCatalogIssuedAt',
  'archiveUrl',
  'archiveSha256',
  'artifactSize',
  'extractedManifestSha256',
  'entrypoint',
  'auxiliaryExecutables',
  'capabilities',
  'hostVersionRange',
  'githubOwner',
  'githubRepository',
  'trustedKeyId',
  'trustedPublicKeySha256',
  'trustedKeyActiveFrom',
  'trustedKeyActiveUntil',
] as const
const CANONICAL_DESCRIPTOR = Object.freeze({
  schemaVersion: OPEN_DESIGN_ACCEPTANCE_IDENTITY.schemaVersion,
  hostVersion: OPEN_DESIGN_ACCEPTANCE_IDENTITY.hostVersion,
  moduleId: OPEN_DESIGN_ACCEPTANCE_IDENTITY.moduleId,
  platform: OPEN_DESIGN_ACCEPTANCE_IDENTITY.platform,
  stableVersion: OPEN_DESIGN_ACCEPTANCE_IDENTITY.stableVersion,
  stableCatalogUrl: OPEN_DESIGN_ACCEPTANCE_IDENTITY.stableCatalogUrl,
  rcVersion: OPEN_DESIGN_ACCEPTANCE_IDENTITY.rcVersion,
  releaseTag: OPEN_DESIGN_ACCEPTANCE_IDENTITY.releaseTag,
  catalogUrl: OPEN_DESIGN_ACCEPTANCE_IDENTITY.catalogUrl,
  minimumCatalogSequence: OPEN_DESIGN_ACCEPTANCE_IDENTITY.minimumCatalogSequence,
  initialCatalogIssuedAt: OPEN_DESIGN_ACCEPTANCE_IDENTITY.initialCatalogIssuedAt,
  archiveUrl: OPEN_DESIGN_ACCEPTANCE_IDENTITY.archiveUrl,
  archiveSha256: OPEN_DESIGN_ACCEPTANCE_IDENTITY.archiveSha256,
  artifactSize: OPEN_DESIGN_ACCEPTANCE_IDENTITY.artifactSize,
  extractedManifestSha256: OPEN_DESIGN_ACCEPTANCE_IDENTITY.extractedManifestSha256,
  entrypoint: OPEN_DESIGN_ACCEPTANCE_IDENTITY.entrypoint,
  auxiliaryExecutables: OPEN_DESIGN_ACCEPTANCE_IDENTITY.auxiliaryExecutables,
  capabilities: OPEN_DESIGN_ACCEPTANCE_IDENTITY.capabilities,
  hostVersionRange: OPEN_DESIGN_ACCEPTANCE_IDENTITY.hostVersionRange,
  githubOwner: OPEN_DESIGN_ACCEPTANCE_IDENTITY.githubOwner,
  githubRepository: OPEN_DESIGN_ACCEPTANCE_IDENTITY.githubRepository,
  trustedKeyId: OPEN_DESIGN_ACCEPTANCE_IDENTITY.trustedKeyId,
  trustedPublicKeySha256: OPEN_DESIGN_ACCEPTANCE_IDENTITY.trustedPublicKeySha256,
  trustedKeyActiveFrom: OPEN_DESIGN_ACCEPTANCE_IDENTITY.trustedKeyActiveFrom,
  trustedKeyActiveUntil: OPEN_DESIGN_ACCEPTANCE_IDENTITY.trustedKeyActiveUntil,
})

/** The owner-only enable descriptor has exactly one accepted byte representation. */
export const OPEN_DESIGN_ACCEPTANCE_DESCRIPTOR_CANONICAL_JSON = `${JSON.stringify(CANONICAL_DESCRIPTOR)}\n`
const MAX_DESCRIPTOR_BYTES = 16 * 1024
const MODULE_ID = OPEN_DESIGN_MODULE_ID as ModuleId
const RC_VERSION = OPEN_DESIGN_ACCEPTANCE_IDENTITY.rcVersion as ModuleVersion

export type OpenDesignAcceptanceBootstrap =
  | { readonly status: 'not-ready'; readonly errorCode: string }
  | {
      readonly status: 'ready'
      readonly releaseRequest: ModuleCoordinatorReleaseRequest
      readonly descriptorPath: string
    }

export interface LoadOpenDesignAcceptanceOptions {
  readonly isPackaged: boolean
  readonly hostVersion: string
  readonly platform: string
  readonly argv: readonly string[]
  readonly env: Readonly<Record<string, string | undefined>>
  readonly userDataRoot: string
  readonly development: OpenDesignDevelopmentBootstrap
  readonly official: OpenDesignOfficialChannelBootstrap
}

function notReady(errorCode: string): OpenDesignAcceptanceBootstrap {
  return Object.freeze({ status: 'not-ready' as const, errorCode })
}

function exactPlainRecord(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return false
  const actual = Object.keys(value).sort()
  const expected = [...fields].sort()
  return actual.length === expected.length && actual.every((field, index) => field === expected[index])
}

function descriptorMatches(value: unknown): boolean {
  if (!exactPlainRecord(value, DESCRIPTOR_FIELDS)) return false
  return DESCRIPTOR_FIELDS.every((field) => {
    const expected = OPEN_DESIGN_ACCEPTANCE_IDENTITY[field]
    const actual = value[field]
    if (Array.isArray(expected)) {
      return Array.isArray(actual)
        && Object.getPrototypeOf(actual) === Array.prototype
        && actual.length === expected.length
        && actual.every((item, index) => item === expected[index])
    }
    return actual === expected
  })
}

function trustedOfficialChannelMatches(official: OpenDesignOfficialChannelBootstrap): boolean {
  if (official.status !== 'ready') return false
  const channel = official.channel
  if (channel.githubReleaseRedirectPolicy.owner !== OPEN_DESIGN_ACCEPTANCE_IDENTITY.githubOwner
    || channel.githubReleaseRedirectPolicy.repository !== OPEN_DESIGN_ACCEPTANCE_IDENTITY.githubRepository
    || channel.trustedKeys.length !== 1) return false
  const key = channel.trustedKeys[0]
  if (!key
    || key.keyId !== OPEN_DESIGN_ACCEPTANCE_IDENTITY.trustedKeyId
    || key.activeFrom !== OPEN_DESIGN_ACCEPTANCE_IDENTITY.trustedKeyActiveFrom
    || key.activeUntil !== OPEN_DESIGN_ACCEPTANCE_IDENTITY.trustedKeyActiveUntil
    || key.revokedAt !== undefined
    || createHash('sha256').update(key.publicKey).digest('hex') !== OPEN_DESIGN_ACCEPTANCE_IDENTITY.trustedPublicKeySha256) {
    return false
  }
  return channel.releaseRequest.moduleId === MODULE_ID
    && channel.releaseRequest.version === OPEN_DESIGN_ACCEPTANCE_IDENTITY.stableVersion
    && channel.releaseRequest.catalogUrl === OPEN_DESIGN_ACCEPTANCE_IDENTITY.stableCatalogUrl
}

async function readOwnerOnlyCanonicalDescriptor(userDataRoot: string): Promise<string> {
  const descriptorPath = resolve(userDataRoot, OPEN_DESIGN_ACCEPTANCE_DESCRIPTOR_RELATIVE_PATH)
  const expectedPath = join(resolve(userDataRoot), OPEN_DESIGN_ACCEPTANCE_DESCRIPTOR_RELATIVE_PATH)
  if (descriptorPath !== expectedPath) throw new Error('ACCEPTANCE_DESCRIPTOR_PATH_INVALID')

  const directoryPath = resolve(descriptorPath, '..')
  const directory = await lstat(directoryPath)
  if (!directory.isDirectory() || directory.isSymbolicLink()
    || (typeof process.getuid === 'function' && directory.uid !== process.getuid())
    || (directory.mode & 0o777) !== 0o700
    || await realpath(directoryPath) !== directoryPath) {
    throw new Error('ACCEPTANCE_DESCRIPTOR_DIRECTORY_INVALID')
  }

  const before = await lstat(descriptorPath)
  if (!before.isFile() || before.isSymbolicLink()
    || before.nlink !== 1
    || (typeof process.getuid === 'function' && before.uid !== process.getuid())
    || (before.mode & 0o777) !== 0o600
    || before.size <= 0 || before.size > MAX_DESCRIPTOR_BYTES
    || await realpath(descriptorPath) !== descriptorPath) {
    throw new Error('ACCEPTANCE_DESCRIPTOR_FILE_INVALID')
  }

  const handle = await open(descriptorPath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = await handle.stat()
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      throw new Error('ACCEPTANCE_DESCRIPTOR_CHANGED')
    }
    const bytes = await handle.readFile()
    const after = await handle.stat()
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs || bytes.byteLength !== opened.size) {
      throw new Error('ACCEPTANCE_DESCRIPTOR_CHANGED')
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } finally {
    await handle.close()
  }
}

/** Fail-closed startup gate. No descriptor field can redirect release or trust selection. */
export async function loadOpenDesignAcceptance(
  options: LoadOpenDesignAcceptanceOptions,
): Promise<OpenDesignAcceptanceBootstrap> {
  if (!options.isPackaged) return notReady('ACCEPTANCE_REQUIRES_PACKAGED_HOST')
  if (options.hostVersion !== OPEN_DESIGN_ACCEPTANCE_IDENTITY.hostVersion) return notReady('ACCEPTANCE_HOST_VERSION_MISMATCH')
  if (options.platform !== OPEN_DESIGN_ACCEPTANCE_IDENTITY.platform) return notReady('ACCEPTANCE_PLATFORM_MISMATCH')
  if (!options.argv.includes('--debug')) return notReady('ACCEPTANCE_REQUIRES_EXPLICIT_DEBUG')
  if (options.env[OPEN_DESIGN_ACCEPTANCE_ENV] !== '1') return notReady('ACCEPTANCE_ENV_DISABLED')
  if (options.development.status !== 'disabled') return notReady('ACCEPTANCE_DEVELOPMENT_CHANNEL_ACTIVE')
  if (!trustedOfficialChannelMatches(options.official)) return notReady('ACCEPTANCE_OFFICIAL_TRUST_MISMATCH')

  let descriptorBytes: string
  try {
    descriptorBytes = await readOwnerOnlyCanonicalDescriptor(options.userDataRoot)
  } catch {
    return notReady('ACCEPTANCE_DESCRIPTOR_INVALID')
  }
  if (descriptorBytes !== OPEN_DESIGN_ACCEPTANCE_DESCRIPTOR_CANONICAL_JSON) {
    return notReady('ACCEPTANCE_DESCRIPTOR_IDENTITY_MISMATCH')
  }
  let descriptor: unknown
  try {
    descriptor = JSON.parse(descriptorBytes)
  } catch {
    return notReady('ACCEPTANCE_DESCRIPTOR_INVALID')
  }
  if (!descriptorMatches(descriptor)) return notReady('ACCEPTANCE_DESCRIPTOR_IDENTITY_MISMATCH')

  return Object.freeze({
    status: 'ready' as const,
    descriptorPath: join(resolve(options.userDataRoot), OPEN_DESIGN_ACCEPTANCE_DESCRIPTOR_RELATIVE_PATH),
    releaseRequest: Object.freeze({
      catalogUrl: OPEN_DESIGN_ACCEPTANCE_IDENTITY.catalogUrl,
      moduleId: MODULE_ID,
      version: RC_VERSION,
    }),
  })
}

export interface OpenDesignAcceptanceRuntime {
  readonly coordinator: Pick<ModuleCoordinator, 'resolveInstallRequest' | 'update' | 'rollback'>
  readonly registry: Pick<ModuleRegistry, 'snapshot'>
  readonly daemon: { get(moduleId: ModuleId): ModuleDaemonSnapshot | undefined }
  readonly view: Pick<ModuleViewPort, 'query'>
}

export interface OpenDesignAcceptanceRuntimeGate {
  getRuntime(): OpenDesignAcceptanceRuntime | undefined
  /** Starts a new recovery epoch and returns its one-shot completion marker. */
  beginRecovery(): () => void
  reset(): void
  close(): void
}

/** Prevents acceptance commands from observing a Coordinator before recovery commits. */
export function createOpenDesignAcceptanceRuntimeGate(
  lookup: () => OpenDesignAcceptanceRuntime | undefined,
): OpenDesignAcceptanceRuntimeGate {
  let recovered = false
  let epoch = 0
  let closed = false
  return Object.freeze({
    getRuntime: () => recovered ? lookup() : undefined,
    beginRecovery: () => {
      const recoveryEpoch = ++epoch
      recovered = false
      return () => {
        if (!closed && epoch === recoveryEpoch) recovered = true
      }
    },
    reset: () => {
      epoch += 1
      recovered = false
    },
    close: () => {
      closed = true
      epoch += 1
      recovered = false
    },
  })
}

/** Product smoke owns its isolated Module lifecycle and must never open acceptance IPC runtime access. */
export function completeOpenDesignAcceptanceRecovery(
  runtimeGate: Pick<OpenDesignAcceptanceRuntimeGate, 'reset'>,
  markRecovered: () => void,
  hostModuleSmokeRequested: boolean,
): boolean {
  if (hostModuleSmokeRequested) {
    runtimeGate.reset()
    return false
  }
  markRecovered()
  return true
}

export interface OpenDesignAcceptanceHostAdapter {
  isAllowedSender(sender: unknown): boolean
}

export interface OpenDesignAcceptanceControllerOptions {
  readonly bootstrap: Extract<OpenDesignAcceptanceBootstrap, { status: 'ready' }>
  readonly getRuntime: () => OpenDesignAcceptanceRuntime | undefined
  readonly host: OpenDesignAcceptanceHostAdapter
  readonly mutationGate: OpenDesignMutationGate
  readonly operationId?: (action: OpenDesignAcceptanceAction) => string
  readonly now?: () => number
}

class AcceptanceControlError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'AcceptanceControlError'
  }
}

function assertResolvedRcIdentity(request: ResolvedModuleCoordinatorInstallRequest, now: number): void {
  const evidence = request.catalogEvidence
  if (!evidence) throw new AcceptanceControlError('ACCEPTANCE_RESOLVED_RELEASE_IDENTITY_MISMATCH')
  const artifact = request.descriptor.artifact
  const manifestArtifact = request.descriptor.manifest.artifacts[0]
  const auxiliaryExecutables = artifact.auxiliaryExecutables ?? []
  const manifestAuxiliaryExecutables = manifestArtifact?.auxiliaryExecutables ?? []
  const issuedAt = canonicalTimestamp(evidence.issuedAt)
  const expiresAt = canonicalTimestamp(evidence.expiresAt)
  if (request.catalogUrl !== OPEN_DESIGN_ACCEPTANCE_IDENTITY.catalogUrl
    || request.hostVersionRange !== OPEN_DESIGN_ACCEPTANCE_IDENTITY.hostVersionRange
    || request.descriptor.verified !== true
    || request.descriptor.format !== 'tar.gz'
    || request.descriptor.extractedManifestSha256 !== OPEN_DESIGN_ACCEPTANCE_IDENTITY.extractedManifestSha256
    || request.descriptor.manifest.schemaVersion !== 1
    || request.descriptor.manifest.id !== OPEN_DESIGN_MODULE_ID
    || request.descriptor.manifest.version !== OPEN_DESIGN_ACCEPTANCE_IDENTITY.rcVersion
    || request.descriptor.manifest.artifacts.length !== 1
    || !manifestArtifact
    || request.descriptor.manifest.capabilities.length !== OPEN_DESIGN_ACCEPTANCE_IDENTITY.capabilities.length
    || request.descriptor.manifest.capabilities.some((capability, index) => (
      capability !== OPEN_DESIGN_ACCEPTANCE_IDENTITY.capabilities[index]
    ))
    || artifact.platform !== OPEN_DESIGN_ACCEPTANCE_IDENTITY.platform
    || artifact.url !== OPEN_DESIGN_ACCEPTANCE_IDENTITY.archiveUrl
    || artifact.sha256 !== OPEN_DESIGN_ACCEPTANCE_IDENTITY.archiveSha256
    || artifact.entrypoint !== OPEN_DESIGN_ACCEPTANCE_IDENTITY.entrypoint
    || auxiliaryExecutables.length !== OPEN_DESIGN_ACCEPTANCE_IDENTITY.auxiliaryExecutables.length
    || auxiliaryExecutables.some((entry, index) => (
      entry !== OPEN_DESIGN_ACCEPTANCE_IDENTITY.auxiliaryExecutables[index]
    ))
    || manifestArtifact.platform !== OPEN_DESIGN_ACCEPTANCE_IDENTITY.platform
    || manifestArtifact.url !== OPEN_DESIGN_ACCEPTANCE_IDENTITY.archiveUrl
    || manifestArtifact.sha256 !== OPEN_DESIGN_ACCEPTANCE_IDENTITY.archiveSha256
    || manifestArtifact.entrypoint !== OPEN_DESIGN_ACCEPTANCE_IDENTITY.entrypoint
    || manifestAuxiliaryExecutables.length !== OPEN_DESIGN_ACCEPTANCE_IDENTITY.auxiliaryExecutables.length
    || manifestAuxiliaryExecutables.some((entry, index) => (
      entry !== OPEN_DESIGN_ACCEPTANCE_IDENTITY.auxiliaryExecutables[index]
    ))
    || evidence.schemaVersion !== 1
    || !Number.isSafeInteger(evidence.sequence)
    || evidence.sequence < OPEN_DESIGN_ACCEPTANCE_IDENTITY.minimumCatalogSequence
    || issuedAt === undefined
    || issuedAt < Date.parse(OPEN_DESIGN_ACCEPTANCE_IDENTITY.initialCatalogIssuedAt)
    || expiresAt === undefined
    || expiresAt <= issuedAt
    || expiresAt <= now
    || evidence.artifactSize !== OPEN_DESIGN_ACCEPTANCE_IDENTITY.artifactSize) {
    throw new AcceptanceControlError('ACCEPTANCE_RESOLVED_RELEASE_IDENTITY_MISMATCH')
  }
}

function operationEvidence(result: ModuleCoordinatorOperationResult) {
  return Object.freeze({ operationId: result.operationId, kind: result.kind as 'update' | 'rollback', ok: result.ok })
}

function canonicalTimestamp(value: string): number | undefined {
  const milliseconds = Date.parse(value)
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value
    ? milliseconds
    : undefined
}

interface AcceptanceExecution {
  readonly result: ModuleCoordinatorOperationResult
  readonly expectedActiveVersion: string
  readonly expectedLastKnownGoodVersion: string
}

interface AcceptanceRegistryState {
  readonly activeVersion: string | null
  readonly lastKnownGoodVersion: string | null
  readonly installedVersions: readonly string[]
}

interface AcceptanceObservedState extends AcceptanceRegistryState {
  readonly daemon: ModuleDaemonSnapshot | undefined
  readonly view: ModuleViewSnapshot | undefined
  readonly running: boolean
  readonly viewAttached: boolean
}

function exactVersions(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((version, index) => version === expected[index])
}

export class OpenDesignAcceptanceController {
  readonly #options: OpenDesignAcceptanceControllerOptions
  readonly #now: () => number
  #flight?: Promise<OpenDesignAcceptanceState>
  #action?: OpenDesignAcceptanceAction
  #lastOperation?: ReturnType<typeof operationEvidence>
  #lastError?: string
  #ownerClaimed = false
  #ownerSender?: unknown

  constructor(options: OpenDesignAcceptanceControllerOptions) {
    this.#options = options
    this.#now = options.now ?? Date.now
  }

  claimSender(sender: unknown): boolean {
    if (this.#ownerClaimed) return this.#ownerSender === sender
    try {
      if (!this.#options.host.isAllowedSender(sender)) return false
    } catch {
      return false
    }
    this.#ownerSender = sender
    this.#ownerClaimed = true
    return true
  }

  isClaimedSender(sender: unknown): boolean {
    if (!this.#ownerClaimed || this.#ownerSender !== sender) return false
    try {
      return this.#options.host.isAllowedSender(sender)
    } catch {
      return false
    }
  }

  async getState(): Promise<OpenDesignAcceptanceState> {
    return this.#readState()
  }

  updateToRc(): Promise<OpenDesignAcceptanceState> {
    return this.#run('updateToRc', async (runtime, operationId) => {
      const state = await this.#requireObservedState(runtime)
      if (state.activeVersion !== OPEN_DESIGN_ACCEPTANCE_IDENTITY.stableVersion
        || state.lastKnownGoodVersion !== null
        || !exactVersions(state.installedVersions, [OPEN_DESIGN_ACCEPTANCE_IDENTITY.stableVersion])) {
        throw new AcceptanceControlError('ACCEPTANCE_UPDATE_BASELINE_MISMATCH')
      }
      const request = await runtime.coordinator.resolveInstallRequest(this.#options.bootstrap.releaseRequest)
      assertResolvedRcIdentity(request, this.#now())
      return {
        result: await runtime.coordinator.update({ ...request, operationId }),
        expectedActiveVersion: OPEN_DESIGN_ACCEPTANCE_IDENTITY.rcVersion,
        expectedLastKnownGoodVersion: OPEN_DESIGN_ACCEPTANCE_IDENTITY.stableVersion,
      }
    })
  }

  rollback(): Promise<OpenDesignAcceptanceState> {
    return this.#run('rollback', async (runtime, operationId) => {
      const state = await this.#requireObservedState(runtime)
      const isRcToStable = state.activeVersion === OPEN_DESIGN_ACCEPTANCE_IDENTITY.rcVersion
        && state.lastKnownGoodVersion === OPEN_DESIGN_ACCEPTANCE_IDENTITY.stableVersion
      const isStableToRc = state.activeVersion === OPEN_DESIGN_ACCEPTANCE_IDENTITY.stableVersion
        && state.lastKnownGoodVersion === OPEN_DESIGN_ACCEPTANCE_IDENTITY.rcVersion
      if ((!isRcToStable && !isStableToRc)
        || !exactVersions(state.installedVersions, [
          OPEN_DESIGN_ACCEPTANCE_IDENTITY.stableVersion,
          OPEN_DESIGN_ACCEPTANCE_IDENTITY.rcVersion,
        ])) {
        throw new AcceptanceControlError('ACCEPTANCE_ROLLBACK_PAIR_MISMATCH')
      }
      if (!state.running || !state.viewAttached) {
        throw new AcceptanceControlError('ACCEPTANCE_ROLLBACK_SOURCE_NOT_READY')
      }
      return {
        result: await runtime.coordinator.rollback({
          moduleId: MODULE_ID,
          restartAfterRollback: true,
          operationId,
        }),
        expectedActiveVersion: isRcToStable
          ? OPEN_DESIGN_ACCEPTANCE_IDENTITY.stableVersion
          : OPEN_DESIGN_ACCEPTANCE_IDENTITY.rcVersion,
        expectedLastKnownGoodVersion: isRcToStable
          ? OPEN_DESIGN_ACCEPTANCE_IDENTITY.rcVersion
          : OPEN_DESIGN_ACCEPTANCE_IDENTITY.stableVersion,
      }
    })
  }

  #run(
    action: OpenDesignAcceptanceAction,
    execute: (runtime: OpenDesignAcceptanceRuntime, operationId: string) => Promise<AcceptanceExecution>,
  ): Promise<OpenDesignAcceptanceState> {
    if (this.#flight) return this.#flight
    // Acceptance is an evidence-gathering drill: the first control failure stops
    // all further mutations for this process lifetime. Restart creates a new controller.
    if (this.#lastError) return this.#readState()
    const mutationLease = this.#options.mutationGate.tryAcquire('acceptance')
    if (!mutationLease) {
      this.#lastError = 'ACCEPTANCE_MUTATION_CONFLICT'
      return this.#readState()
    }
    this.#action = action
    this.#lastOperation = undefined
    const flight = (async () => {
      try {
        const operationId = this.#options.operationId?.(action)
          ?? `open-design-acceptance-${action}-${randomUUID()}`
        const runtime = this.#options.getRuntime()
        if (!runtime) throw new AcceptanceControlError('ACCEPTANCE_OPERATION_RUNTIME_UNAVAILABLE')
        const execution = await execute(runtime, operationId)
        const { result } = execution
        const expectedKind = action === 'updateToRc' ? 'update' : 'rollback'
        if (result.moduleId !== MODULE_ID || result.kind !== expectedKind || result.operationId !== operationId) {
          throw new AcceptanceControlError('ACCEPTANCE_COORDINATOR_RESULT_MISMATCH')
        }
        if (!result.ok) {
          this.#lastOperation = operationEvidence(result)
          this.#lastError = `ACCEPTANCE_${expectedKind.toUpperCase()}_FAILED`
        } else {
          let observed: AcceptanceObservedState | undefined
          try {
            observed = await this.#readObservedState(runtime)
          } catch {
            // A claimed success without readable Host state is not acceptance evidence.
          }
          if (!observed
            || observed.activeVersion !== execution.expectedActiveVersion
            || observed.lastKnownGoodVersion !== execution.expectedLastKnownGoodVersion
            || !exactVersions(observed.installedVersions, [
              OPEN_DESIGN_ACCEPTANCE_IDENTITY.stableVersion,
              OPEN_DESIGN_ACCEPTANCE_IDENTITY.rcVersion,
            ])
            || !observed.running || !observed.viewAttached
            || result.target.activeVersion !== execution.expectedActiveVersion
            || result.target.lastKnownGoodVersion !== execution.expectedLastKnownGoodVersion
            || !result.target.running || !result.target.viewAttached || !result.target.registryPresent) {
            throw new AcceptanceControlError('ACCEPTANCE_POSTCONDITION_MISMATCH')
          }
          this.#lastOperation = operationEvidence(result)
        }
      } catch (error) {
        this.#lastError = error instanceof AcceptanceControlError
          ? error.code
          : `ACCEPTANCE_${action === 'updateToRc' ? 'UPDATE' : 'ROLLBACK'}_FAILED`
      } finally {
        this.#action = undefined
      }
      return this.#readState()
    })().finally(() => mutationLease.release())
    this.#flight = flight
    void flight.finally(() => {
      if (this.#flight === flight) this.#flight = undefined
    }).catch(() => undefined)
    return flight
  }

  async #readState(): Promise<OpenDesignAcceptanceState> {
    let runtime: OpenDesignAcceptanceRuntime | undefined
    let runtimeLookupFailed = false
    try {
      runtime = this.#options.getRuntime()
    } catch {
      runtimeLookupFailed = true
    }
    let activeVersion: string | null = null
    let lastKnownGoodVersion: string | null = null
    let installedVersions: readonly string[] = Object.freeze([])
    let running = false
    let viewAttached = false
    let errorCode = this.#lastError
    if (!runtime) {
      errorCode ??= runtimeLookupFailed ? 'ACCEPTANCE_RUNTIME_LOOKUP_FAILED' : 'ACCEPTANCE_RUNTIME_UNAVAILABLE'
    } else {
      try {
        const observed = await this.#readObservedState(runtime)
        activeVersion = observed.activeVersion
        lastKnownGoodVersion = observed.lastKnownGoodVersion
        installedVersions = observed.installedVersions
        running = observed.running
        viewAttached = observed.viewAttached
      } catch {
        errorCode ??= 'ACCEPTANCE_STATE_UNAVAILABLE'
      }
    }
    return Object.freeze({
      status: this.#action ? 'busy' as const : errorCode ? 'error' as const : 'ready' as const,
      hostVersion: OPEN_DESIGN_ACCEPTANCE_IDENTITY.hostVersion,
      activeVersion,
      lastKnownGoodVersion,
      installedVersions,
      running,
      viewAttached,
      ...(this.#action ? { action: this.#action } : {}),
      ...(this.#lastOperation ? { operation: this.#lastOperation } : {}),
      ...(errorCode ? { errorCode } : {}),
    })
  }

  #readRegistryState(runtime: OpenDesignAcceptanceRuntime): AcceptanceRegistryState {
    const module = runtime.registry.snapshot().modules.find((candidate) => candidate.id === OPEN_DESIGN_MODULE_ID)
    return {
      activeVersion: module?.activeVersion ?? null,
      lastKnownGoodVersion: module?.lastKnownGoodVersion ?? null,
      installedVersions: Object.freeze((module?.versions ?? []).map((version) => version.version).sort()),
    }
  }

  async #readObservedState(runtime: OpenDesignAcceptanceRuntime): Promise<AcceptanceObservedState> {
    const registry = this.#readRegistryState(runtime)
    const daemon = runtime.daemon.get(MODULE_ID)
    const view = await runtime.view.query(MODULE_ID)
    const hasActiveVersion = registry.activeVersion !== null
    return {
      ...registry,
      daemon,
      view,
      running: hasActiveVersion
        && daemon?.id === MODULE_ID
        && daemon.version === registry.activeVersion
        && daemon.state === 'healthy',
      viewAttached: hasActiveVersion
        && view?.moduleId === MODULE_ID
        && view.version === registry.activeVersion
        && view.state === 'attached',
    }
  }

  async #requireObservedState(runtime: OpenDesignAcceptanceRuntime): Promise<AcceptanceObservedState> {
    try {
      return await this.#readObservedState(runtime)
    } catch {
      throw new AcceptanceControlError('ACCEPTANCE_STATE_UNAVAILABLE')
    }
  }
}

export interface OpenDesignAcceptanceIpcRegistration {
  dispose(): void
}

type AcceptanceIpc = Pick<IpcMain, 'handle' | 'removeHandler' | 'on' | 'removeListener'>
const ipcRegistrations = new WeakMap<object, OpenDesignAcceptanceIpcRegistration>()

function validMainFrame(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return !!event.senderFrame
    && event.senderFrame === event.sender.mainFrame
}

function claimSender(controller: OpenDesignAcceptanceController, event: IpcMainEvent): boolean {
  return validMainFrame(event) && controller.claimSender(event.sender)
}

function validSender(controller: OpenDesignAcceptanceController, event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return validMainFrame(event) && controller.isClaimedSender(event.sender)
}

function assertInvocation(
  controller: OpenDesignAcceptanceController,
  event: IpcMainInvokeEvent,
  args: readonly unknown[],
): void {
  if (!validSender(controller, event)) throw new Error('OpenDesign acceptance IPC sender was rejected')
  if (args.length !== 0) throw new Error('OpenDesign acceptance IPC commands do not accept input')
}

/**
 * Registers one synchronous availability reply before BrowserWindow preload.
 * Mutation handlers exist only when every acceptance gate produced a controller.
 */
export function registerOpenDesignAcceptanceIpc(
  ipc: AcceptanceIpc,
  controller?: OpenDesignAcceptanceController,
): OpenDesignAcceptanceIpcRegistration {
  const key = ipc as object
  ipcRegistrations.get(key)?.dispose()
  const invokeChannels: string[] = []
  let disposed = false
  const available = (event: IpcMainEvent) => {
    event.returnValue = controller ? claimSender(controller, event) : false
  }
  const register = (
    readyController: OpenDesignAcceptanceController,
    channel: string,
    invoke: () => Promise<OpenDesignAcceptanceState>,
  ) => {
    ipc.handle(channel, (event, ...args) => {
      assertInvocation(readyController, event, args)
      return invoke()
    })
    invokeChannels.push(channel)
  }
  const registration: OpenDesignAcceptanceIpcRegistration = {
    dispose() {
      if (disposed) return
      disposed = true
      if (ipcRegistrations.get(key) === registration) ipcRegistrations.delete(key)
      ipc.removeListener(OPEN_DESIGN_ACCEPTANCE_CHANNELS.IS_AVAILABLE, available)
      for (const channel of invokeChannels) {
        try {
          ipc.removeHandler(channel)
        } catch {
          // Continue removing the remaining fixed handlers.
        }
      }
    },
  }
  try {
    ipc.on(OPEN_DESIGN_ACCEPTANCE_CHANNELS.IS_AVAILABLE, available)
    if (controller) {
      const readyController = controller
      register(readyController, OPEN_DESIGN_ACCEPTANCE_CHANNELS.GET_STATE, () => readyController.getState())
      register(readyController, OPEN_DESIGN_ACCEPTANCE_CHANNELS.UPDATE_TO_RC, () => readyController.updateToRc())
      register(readyController, OPEN_DESIGN_ACCEPTANCE_CHANNELS.ROLLBACK, () => readyController.rollback())
    }
  } catch (error) {
    registration.dispose()
    throw error
  }
  ipcRegistrations.set(key, registration)
  return registration
}
