import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { parseModuleManifest, type ModuleId, type ModuleSha256, type ModuleVersion } from '@simulator/module-contract'
import { assertGzipFile, extractArchive, inspectArchive, validateEntrypointPlan } from './archive.ts'
import {
  atomicWriteJson,
  copyAndHashArchive,
  createJsonExclusive,
  fsyncDirectory,
  fsyncTree,
  hashExtractedTree,
  normalizeAndVerifyModes,
  pathExists,
} from './filesystem.ts'
import {
  DEFAULT_INSTALL_LIMITS,
  DEFAULT_STALE_STAGING_AGE_MS,
  ModuleInstallerError,
  SimulatedInstallerCrash,
  type InstalledModuleState,
  type InstallLimits,
  type InstallProgress,
  type InstallRequest,
  type InstallResult,
  type ModuleInstallerOptions,
  type ResolvedDescriptor,
  type RestoreModuleStateRequest,
  type RestoreModuleStateResult,
  type RollbackResult,
  type UninstallRequest,
  type VerifiedArtifactDescriptor,
} from './types.ts'

const STATE_SCHEMA_VERSION = 1
const JOURNAL_SCHEMA_VERSION = 1
const MODULE_ID_PATTERN = /^(?=.{3,128}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const TRANSACTION_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const STAGING_OWNERSHIP_SCHEMA_VERSION = 1
const STAGING_OWNERSHIP_FILE = 'ownership.json'

interface StateFile {
  readonly schemaVersion: 1
  readonly activeVersion: string | null
  readonly lastKnownGoodVersion: string | null
}

type JournalOperation = 'install' | 'restore' | 'rollback' | 'uninstall'
type JournalCheckpoint = 'prepared' | 'version-published' | 'state-activated'

interface JournalFile {
  readonly schemaVersion: 1
  readonly operation: JournalOperation
  readonly checkpoint: JournalCheckpoint
  readonly transactionId: string
  readonly moduleId: string
  readonly version: string
  readonly previousState: StateFile
  readonly nextState: StateFile
}

interface ModulePaths {
  readonly moduleDirectory: string
  readonly versionsDirectory: string
  readonly state: string
  readonly journal: string
  readonly journalClaim: string
  readonly recoveringJournal: string
}

interface StagingOwnershipFile {
  readonly schemaVersion: 1
  readonly transactionId: string
  readonly moduleId: string
  readonly createdAtMs: number
}

function emptyState(): StateFile {
  return { schemaVersion: STATE_SCHEMA_VERSION, activeVersion: null, lastKnownGoodVersion: null }
}

function publicState(moduleId: ModuleId, state: StateFile): InstalledModuleState {
  return {
    moduleId,
    activeVersion: state.activeVersion as ModuleVersion | null,
    lastKnownGoodVersion: state.lastKnownGoodVersion as ModuleVersion | null,
  }
}

function statesEqual(left: StateFile, right: StateFile): boolean {
  return left.activeVersion === right.activeVersion && left.lastKnownGoodVersion === right.lastKnownGoodVersion
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
}

function validVersion(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 256 && VERSION_PATTERN.test(value)
}

function parseStagingOwnership(value: unknown, expectedTransactionId: string): StagingOwnershipFile | undefined {
  if (!isPlainObject(value)
    || value.schemaVersion !== STAGING_OWNERSHIP_SCHEMA_VERSION
    || value.transactionId !== expectedTransactionId
    || typeof value.moduleId !== 'string'
    || !MODULE_ID_PATTERN.test(value.moduleId)
    || typeof value.createdAtMs !== 'number'
    || !Number.isSafeInteger(value.createdAtMs)
    || value.createdAtMs < 0
    || Object.keys(value).sort().join(',') !== 'createdAtMs,moduleId,schemaVersion,transactionId') {
    return undefined
  }
  return {
    schemaVersion: STAGING_OWNERSHIP_SCHEMA_VERSION,
    transactionId: value.transactionId,
    moduleId: value.moduleId,
    createdAtMs: value.createdAtMs,
  }
}

function parseState(value: unknown): StateFile {
  if (!isPlainObject(value)
    || value.schemaVersion !== STATE_SCHEMA_VERSION
    || (value.activeVersion !== null && !validVersion(value.activeVersion))
    || (value.lastKnownGoodVersion !== null && !validVersion(value.lastKnownGoodVersion))
    || Object.keys(value).sort().join(',') !== 'activeVersion,lastKnownGoodVersion,schemaVersion') {
    throw new ModuleInstallerError('JOURNAL_INVALID', 'Module activation state is malformed')
  }
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    activeVersion: value.activeVersion,
    lastKnownGoodVersion: value.lastKnownGoodVersion,
  }
}

function parseJournal(value: unknown, expectedModuleId: string): JournalFile {
  if (!isPlainObject(value)
    || value.schemaVersion !== JOURNAL_SCHEMA_VERSION
    || (value.operation !== 'install' && value.operation !== 'restore' && value.operation !== 'rollback' && value.operation !== 'uninstall')
    || (value.checkpoint !== 'prepared' && value.checkpoint !== 'version-published' && value.checkpoint !== 'state-activated')
    || typeof value.transactionId !== 'string'
    || !TRANSACTION_ID_PATTERN.test(value.transactionId)
    || value.moduleId !== expectedModuleId
    || !validVersion(value.version)) {
    throw new ModuleInstallerError('JOURNAL_INVALID', 'Module transaction journal is malformed')
  }
  const allowed = ['checkpoint', 'moduleId', 'nextState', 'operation', 'previousState', 'schemaVersion', 'transactionId', 'version']
  if (Object.keys(value).sort().join(',') !== allowed.join(',')) {
    throw new ModuleInstallerError('JOURNAL_INVALID', 'Module transaction journal contains unknown fields')
  }
  return {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    operation: value.operation,
    checkpoint: value.checkpoint,
    transactionId: value.transactionId,
    moduleId: value.moduleId,
    version: value.version,
    previousState: parseState(value.previousState),
    nextState: parseState(value.nextState),
  }
}

function validateLimits(overrides?: Partial<InstallLimits>): InstallLimits {
  const limits = { ...DEFAULT_INSTALL_LIMITS, ...overrides }
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new ModuleInstallerError('DESCRIPTOR_INVALID', `Install limit ${name} must be a positive safe integer`)
    }
  }
  return Object.freeze(limits)
}

function resolveDescriptor(descriptor: VerifiedArtifactDescriptor): ResolvedDescriptor {
  if (!isPlainObject(descriptor) || descriptor.verified !== true || descriptor.format !== 'tar.gz') {
    throw new ModuleInstallerError('DESCRIPTOR_INVALID', 'Installer requires a verified tar.gz artifact descriptor')
  }
  const parsed = parseModuleManifest(descriptor.manifest)
  if (!parsed.ok) throw new ModuleInstallerError('DESCRIPTOR_INVALID', 'Descriptor contains an invalid module manifest')
  if (!SHA256_PATTERN.test(descriptor.extractedManifestSha256)) {
    throw new ModuleInstallerError('DESCRIPTOR_INVALID', 'Descriptor extracted manifest SHA-256 is invalid')
  }

  const artifact = parsed.value.artifacts.find((candidate) => candidate.platform === descriptor.artifact?.platform)
  if (!artifact
    || artifact.entrypoint !== descriptor.artifact.entrypoint
    || artifact.url !== descriptor.artifact.url
    || artifact.sha256 !== descriptor.artifact.sha256) {
    throw new ModuleInstallerError('DESCRIPTOR_INVALID', 'Descriptor artifact does not exactly match its verified manifest')
  }
  const url = new URL(artifact.url)
  if (!url.pathname.endsWith('.tar.gz')) {
    throw new ModuleInstallerError('FORMAT_UNSUPPORTED', 'Verified artifact URL must identify the production .tar.gz format')
  }
  return {
    moduleId: parsed.value.id,
    version: parsed.value.version,
    platform: artifact.platform,
    artifact,
    archiveSha256: artifact.sha256,
    extractedManifestSha256: descriptor.extractedManifestSha256,
  }
}

export class ModuleInstaller {
  readonly #root: string
  readonly #limits: InstallLimits
  readonly #faultInjector: ModuleInstallerOptions['faultInjector']
  readonly #usageGuard: ModuleInstallerOptions['usageGuard']
  readonly #busy = new Set<string>()
  #rootReady = false
  #maintenanceActive = false

  constructor(moduleRoot: string, options: ModuleInstallerOptions = {}) {
    if (typeof moduleRoot !== 'string' || moduleRoot.length === 0 || moduleRoot.includes('\0')) {
      throw new ModuleInstallerError('DESCRIPTOR_INVALID', 'Module root must be a non-empty filesystem path')
    }
    this.#root = resolve(moduleRoot)
    this.#limits = validateLimits(options.limits)
    this.#faultInjector = options.faultInjector
    this.#usageGuard = options.usageGuard
  }

  get root(): string {
    return this.#root
  }

  async install(request: InstallRequest): Promise<InstallResult> {
    const descriptor = resolveDescriptor(request.descriptor)
    return this.#exclusive(descriptor.moduleId, async () => {
      await this.#ensureRoot()
      const paths = await this.#ensureModuleLayout(descriptor.moduleId)
      await this.#assertIdle(paths)
      const target = join(paths.versionsDirectory, descriptor.version)
      if (await pathExists(target)) {
        throw new ModuleInstallerError('INSTALL_CONFLICT', `Module version ${descriptor.version} is already installed`)
      }

      const transactionId = randomUUID()
      const staging = this.#stagingPath(transactionId)
      const archive = join(staging, 'artifact.tar.gz')
      const payload = join(staging, 'payload')
      let journalWritten = false
      let intendedState: StateFile | undefined
      let committedResult: InstallResult | undefined
      const report = this.#progressReporter(request.onProgress)
      report({ phase: 'preparing', completed: 0, total: 100 })

      try {
        this.#abortIfRequested(request.signal)
        await mkdir(staging, { mode: 0o700 })
        const ownership: StagingOwnershipFile = {
          schemaVersion: STAGING_OWNERSHIP_SCHEMA_VERSION,
          transactionId,
          moduleId: descriptor.moduleId,
          createdAtMs: Date.now(),
        }
        await atomicWriteJson(join(staging, STAGING_OWNERSHIP_FILE), ownership)
        await fsyncDirectory(join(this.#root, '.module-installer', 'staging'))
        await mkdir(payload, { mode: 0o700 })
        const archiveSha256 = await copyAndHashArchive(request.archivePath, archive, this.#limits, request.signal, report)
        if (archiveSha256 !== descriptor.archiveSha256) {
          throw new ModuleInstallerError('ARCHIVE_HASH_MISMATCH', 'Compressed archive SHA-256 does not match verified descriptor')
        }
        await this.#fault('after-archive-copy')
        await assertGzipFile(archive)

        const plan = await inspectArchive(archive, this.#limits, request.signal, report)
        validateEntrypointPlan(plan, descriptor.artifact.entrypoint)
        await this.#fault('after-archive-inspection')
        await extractArchive(archive, payload, plan, this.#limits, request.signal, report)
        await this.#fault('after-extraction')
        await normalizeAndVerifyModes(payload, descriptor.artifact.entrypoint)

        const tree = await hashExtractedTree(payload, this.#limits, request.signal, report)
        if (tree.sha256 !== descriptor.extractedManifestSha256) {
          throw new ModuleInstallerError('TREE_HASH_MISMATCH', 'Extracted file manifest SHA-256 does not match verified descriptor')
        }
        const entrypoint = tree.files.get(descriptor.artifact.entrypoint)
        if (!entrypoint?.executable) {
          throw new ModuleInstallerError('ENTRYPOINT_INVALID', 'Extracted entrypoint is missing or not executable')
        }
        for (const [path, file] of tree.files) {
          if (file.executable && path !== descriptor.artifact.entrypoint) {
            throw new ModuleInstallerError('ENTRYPOINT_INVALID', `Extracted executable is not the declared entrypoint: ${JSON.stringify(path)}`)
          }
        }

        await this.#fault('before-content-fsync')
        await fsyncTree(payload)
        this.#abortIfRequested(request.signal)

        const previousState = await this.#readState(paths.state)
        const nextState: StateFile = {
          schemaVersion: STATE_SCHEMA_VERSION,
          activeVersion: descriptor.version,
          lastKnownGoodVersion: previousState.activeVersion,
        }
        intendedState = nextState
        committedResult = {
          ...publicState(descriptor.moduleId, nextState),
          installedPath: target,
          archiveSha256: archiveSha256 as ModuleSha256,
          extractedManifestSha256: tree.sha256,
        }
        let journal: JournalFile = {
          schemaVersion: JOURNAL_SCHEMA_VERSION,
          operation: 'install',
          checkpoint: 'prepared',
          transactionId,
          moduleId: descriptor.moduleId,
          version: descriptor.version,
          previousState,
          nextState,
        }
        await this.#claimJournal(paths, journal)
        journalWritten = true
        await this.#fault('after-journal-prepared')
        this.#abortIfRequested(request.signal)

        report({ phase: 'activating', completed: 90, total: 100 })
        await this.#fault('before-publish-rename')
        await rename(payload, target)
        await this.#fault('after-publish-rename')
        await fsyncDirectory(staging)
        await this.#fault('after-publish-source-fsync')
        await fsyncDirectory(paths.versionsDirectory)
        await this.#fault('after-publish-destination-fsync')
        journal = { ...journal, checkpoint: 'version-published' }
        await atomicWriteJson(paths.journal, journal)
        await this.#fault('after-version-published')
        this.#abortIfRequested(request.signal)

        await this.#fault('before-state-rename')
        await atomicWriteJson(paths.state, nextState)
        await this.#fault('after-state-rename')
        journal = { ...journal, checkpoint: 'state-activated' }
        await atomicWriteJson(paths.journal, journal)
        await this.#fault('after-state-activated')
        await this.#fault('before-cleanup')
        await this.#cleanupTransaction(paths, transactionId)
        report({ phase: 'complete', completed: 100, total: 100, entries: tree.fileCount, bytes: tree.totalBytes })
        return committedResult
      } catch (error) {
        if (error instanceof SimulatedInstallerCrash) throw error
        if (journalWritten) {
          const committed = intendedState !== undefined && statesEqual(await this.#readState(paths.state), intendedState)
          await this.#recoverModule(descriptor.moduleId)
          if (committed && committedResult) {
            report({ phase: 'complete', completed: 100, total: 100 })
            return committedResult
          }
        } else {
          await rm(staging, { recursive: true, force: true }).catch(() => undefined)
          await fsyncDirectory(join(this.#root, '.module-installer', 'staging')).catch(() => undefined)
        }
        if (error instanceof ModuleInstallerError) throw error
        throw new ModuleInstallerError('FILESYSTEM_ERROR', error instanceof Error ? error.message : String(error), error)
      }
    })
  }

  async getState(moduleId: ModuleId): Promise<InstalledModuleState> {
    this.#validateModuleId(moduleId)
    await this.#ensureRoot()
    const paths = this.#modulePaths(moduleId)
    return publicState(moduleId, await this.#readState(paths.state))
  }

  async rollback(moduleId: ModuleId): Promise<RollbackResult> {
    this.#validateModuleId(moduleId)
    return this.#exclusive(moduleId, async () => {
      await this.#ensureRoot()
      const paths = await this.#ensureModuleLayout(moduleId)
      await this.#assertIdle(paths)
      const previousState = await this.#readState(paths.state)
      if (previousState.lastKnownGoodVersion === null) {
        throw new ModuleInstallerError('NO_LAST_KNOWN_GOOD', 'Module has no last-known-good version')
      }
      const lkgPath = join(paths.versionsDirectory, previousState.lastKnownGoodVersion)
      if (!(await pathExists(lkgPath))) throw new ModuleInstallerError('NOT_INSTALLED', 'Last-known-good version is missing')
      const nextState: StateFile = {
        schemaVersion: STATE_SCHEMA_VERSION,
        activeVersion: previousState.lastKnownGoodVersion,
        lastKnownGoodVersion: previousState.activeVersion,
      }
      const transactionId = randomUUID()
      let journal: JournalFile = {
        schemaVersion: JOURNAL_SCHEMA_VERSION,
        operation: 'rollback',
        checkpoint: 'prepared',
        transactionId,
        moduleId,
        version: previousState.lastKnownGoodVersion,
        previousState,
        nextState,
      }
      await this.#claimJournal(paths, journal)
      try {
        await this.#fault('after-journal-prepared')
        await this.#fault('before-state-rename')
        await atomicWriteJson(paths.state, nextState)
        await this.#fault('after-state-rename')
        journal = { ...journal, checkpoint: 'state-activated' }
        await atomicWriteJson(paths.journal, journal)
        await this.#fault('after-state-activated')
        await this.#fault('before-cleanup')
        await this.#cleanupTransaction(paths, transactionId)
      } catch (error) {
        if (error instanceof SimulatedInstallerCrash) throw error
        const committed = statesEqual(await this.#readState(paths.state), nextState)
        await this.#recoverModule(moduleId)
        if (committed) return { ...publicState(moduleId, nextState), activePath: lkgPath }
        if (error instanceof ModuleInstallerError) throw error
        throw new ModuleInstallerError('FILESYSTEM_ERROR', error instanceof Error ? error.message : String(error), error)
      }
      return { ...publicState(moduleId, nextState), activePath: lkgPath }
    })
  }

  async restoreState(request: RestoreModuleStateRequest): Promise<RestoreModuleStateResult> {
    this.#validateModuleId(request.moduleId)
    for (const [name, version] of [
      ['activeVersion', request.activeVersion],
      ['lastKnownGoodVersion', request.lastKnownGoodVersion],
    ] as const) {
      if (version !== null && !validVersion(version)) {
        throw new ModuleInstallerError('DESCRIPTOR_INVALID', `${name} is invalid`)
      }
    }
    if (!this.#usageGuard) {
      throw new ModuleInstallerError('USAGE_GUARD_REQUIRED', 'State restoration requires an authoritative host usage guard')
    }
    return this.#usageGuard.runExclusive(request.moduleId, async (lease) => this.#exclusive(request.moduleId, async () => {
      await this.#ensureRoot()
      const paths = await this.#ensureModuleLayout(request.moduleId)
      await this.#assertIdle(paths)
      const previousState = await this.#readState(paths.state)
      const nextState: StateFile = {
        schemaVersion: STATE_SCHEMA_VERSION,
        activeVersion: request.activeVersion,
        lastKnownGoodVersion: request.lastKnownGoodVersion,
      }
      if (statesEqual(previousState, nextState)) {
        return {
          ...publicState(request.moduleId, nextState),
          activePath: nextState.activeVersion === null ? null : join(paths.versionsDirectory, nextState.activeVersion),
        }
      }
      const referencedVersions = [...new Set([
        previousState.activeVersion,
        previousState.lastKnownGoodVersion,
        nextState.activeVersion,
        nextState.lastKnownGoodVersion,
      ].filter((version): version is ModuleVersion => version !== null))]
      for (const version of referencedVersions) {
        if (await lease.isVersionInUse(version)) {
          throw new ModuleInstallerError('PROTECTED_VERSION', `Cannot restore state while version ${version} is in use`)
        }
        if ((version === nextState.activeVersion || version === nextState.lastKnownGoodVersion)
          && !(await pathExists(join(paths.versionsDirectory, version)))) {
          throw new ModuleInstallerError('NOT_INSTALLED', `Cannot restore missing module version ${version}`)
        }
      }
      const journalVersion = nextState.activeVersion
        ?? nextState.lastKnownGoodVersion
        ?? previousState.activeVersion
        ?? previousState.lastKnownGoodVersion
      if (journalVersion === null) {
        throw new ModuleInstallerError('JOURNAL_INVALID', 'State restoration has no journal version')
      }
      const transactionId = randomUUID()
      let journal: JournalFile = {
        schemaVersion: JOURNAL_SCHEMA_VERSION,
        operation: 'restore',
        checkpoint: 'prepared',
        transactionId,
        moduleId: request.moduleId,
        version: journalVersion,
        previousState,
        nextState,
      }
      await this.#claimJournal(paths, journal)
      try {
        await this.#fault('after-journal-prepared')
        await this.#fault('before-state-rename')
        await atomicWriteJson(paths.state, nextState)
        await this.#fault('after-state-rename')
        journal = { ...journal, checkpoint: 'state-activated' }
        await atomicWriteJson(paths.journal, journal)
        await this.#fault('after-state-activated')
        await this.#fault('before-cleanup')
        await this.#cleanupTransaction(paths, transactionId)
      } catch (error) {
        if (error instanceof SimulatedInstallerCrash) throw error
        const committed = statesEqual(await this.#readState(paths.state), nextState)
        await this.#recoverModule(request.moduleId)
        if (!committed) {
          if (error instanceof ModuleInstallerError) throw error
          throw new ModuleInstallerError('FILESYSTEM_ERROR', error instanceof Error ? error.message : String(error), error)
        }
      }
      return {
        ...publicState(request.moduleId, nextState),
        activePath: nextState.activeVersion === null ? null : join(paths.versionsDirectory, nextState.activeVersion),
      }
    }))
  }

  async uninstall(request: UninstallRequest): Promise<void> {
    this.#validateModuleId(request.moduleId)
    if (!validVersion(request.version)) throw new ModuleInstallerError('DESCRIPTOR_INVALID', 'Uninstall version is invalid')
    if (!this.#usageGuard) {
      throw new ModuleInstallerError('USAGE_GUARD_REQUIRED', 'Uninstall requires an authoritative host usage guard')
    }
    await this.#usageGuard.runExclusive(request.moduleId, async (lease) => this.#exclusive(request.moduleId, async () => {
      await this.#ensureRoot()
      const paths = await this.#ensureModuleLayout(request.moduleId)
      await this.#assertIdle(paths)
      const state = await this.#readState(paths.state)
      if (state.activeVersion === request.version || state.lastKnownGoodVersion === request.version || await lease.isVersionInUse(request.version)) {
        throw new ModuleInstallerError('PROTECTED_VERSION', 'Cannot uninstall an active, last-known-good, or in-use version')
      }
      const target = join(paths.versionsDirectory, request.version)
      if (!(await pathExists(target))) throw new ModuleInstallerError('NOT_INSTALLED', 'Module version is not installed')
      const transactionId = randomUUID()
      const trash = this.#trashPath(transactionId)
      const journal: JournalFile = {
        schemaVersion: JOURNAL_SCHEMA_VERSION,
        operation: 'uninstall',
        checkpoint: 'prepared',
        transactionId,
        moduleId: request.moduleId,
        version: request.version,
        previousState: state,
        nextState: state,
      }
      await this.#claimJournal(paths, journal)
      try {
        await mkdir(resolve(trash, '..'), { recursive: true, mode: 0o700 })
        await this.#fault('after-journal-prepared')
        await this.#fault('before-trash-rename')
        await rename(target, trash)
        await this.#fault('after-trash-rename')
        await fsyncDirectory(paths.versionsDirectory)
        await this.#fault('after-trash-source-fsync')
        await fsyncDirectory(resolve(trash, '..'))
        await this.#fault('after-trash-destination-fsync')
        await atomicWriteJson(paths.journal, { ...journal, checkpoint: 'version-published' })
        await this.#fault('after-trash-published')
        await this.#fault('before-trash-delete')
        await rm(trash, { recursive: true, force: true })
        await fsyncDirectory(resolve(trash, '..'))
        await this.#fault('after-trash-delete')
        await this.#fault('before-cleanup')
        await this.#cleanupTransaction(paths, transactionId)
      } catch (error) {
        if (error instanceof SimulatedInstallerCrash) throw error
        await this.#recoverModule(request.moduleId)
        if (!(await pathExists(target))) return
        if (error instanceof ModuleInstallerError) throw error
        throw new ModuleInstallerError('FILESYSTEM_ERROR', error instanceof Error ? error.message : String(error), error)
      }
    }))
  }

  async recover(moduleId: ModuleId): Promise<void> {
    this.#validateModuleId(moduleId)
    await this.#exclusive(moduleId, async () => {
      await this.#ensureRoot()
      await this.#recoverModule(moduleId)
    })
  }

  /** Resume only after the host has established that the prior recovery owner is gone. */
  async recoverInterrupted(moduleId: ModuleId): Promise<void> {
    this.#validateModuleId(moduleId)
    await this.#exclusive(moduleId, async () => {
      await this.#ensureRoot()
      await this.#recoverModule(moduleId, true)
    })
  }

  async recoverAll(): Promise<void> {
    if (this.#maintenanceActive || this.#busy.size > 0) {
      throw new ModuleInstallerError('BUSY', 'Cannot run global recovery while module mutations are active')
    }
    this.#maintenanceActive = true
    try {
      await this.#ensureRoot()
      const modulesDirectory = join(this.#root, 'modules')
      const entries = await readdir(modulesDirectory, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory() || !MODULE_ID_PATTERN.test(entry.name)) {
          throw new ModuleInstallerError('JOURNAL_INVALID', `Unexpected entry in module root: ${JSON.stringify(entry.name)}`)
        }
        await this.#recoverModule(entry.name as ModuleId)
      }
      await this.#cleanupStaleStaging()
    } finally {
      this.#maintenanceActive = false
    }
  }

  async #cleanupStaleStaging(): Promise<void> {
    const stagingRoot = join(this.#root, '.module-installer', 'staging')
    const now = Date.now()
    let removed = false
    for (const entry of await readdir(stagingRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !TRANSACTION_ID_PATTERN.test(entry.name)) continue
      const staging = this.#stagingPath(entry.name)
      let ownership: StagingOwnershipFile | undefined
      try {
        ownership = parseStagingOwnership(
          await this.#readSmallJson(join(staging, STAGING_OWNERSHIP_FILE)),
          entry.name,
        )
      } catch {
        continue
      }
      if (!ownership || ownership.createdAtMs > now || now - ownership.createdAtMs < DEFAULT_STALE_STAGING_AGE_MS) continue
      const paths = this.#modulePaths(ownership.moduleId as ModuleId)
      if (await pathExists(paths.journal) || await pathExists(paths.recoveringJournal) || await pathExists(paths.journalClaim)) continue
      await rm(staging, { recursive: true, force: true })
      removed = true
    }
    if (removed) await fsyncDirectory(stagingRoot)
  }

  async #recoverModule(moduleId: ModuleId, resumeInterrupted = false): Promise<void> {
    const paths = this.#modulePaths(moduleId)
    const hasJournal = await pathExists(paths.journal)
    const hasRecoveringJournal = await pathExists(paths.recoveringJournal)
    const hasJournalClaim = await pathExists(paths.journalClaim)
    if (hasJournal && hasRecoveringJournal) {
      throw new ModuleInstallerError('JOURNAL_INVALID', 'Module has conflicting transaction journals')
    }
    if (hasJournalClaim && !resumeInterrupted) {
      throw new ModuleInstallerError('BUSY', 'A journal publisher may still be active; resume only after confirming it stopped')
    }
    if (hasJournalClaim) {
      await rm(paths.journalClaim, { recursive: true, force: true })
      await fsyncDirectory(paths.moduleDirectory)
    }
    if (!hasJournal && !hasRecoveringJournal) return
    if (hasRecoveringJournal && !resumeInterrupted) {
      throw new ModuleInstallerError('BUSY', 'Another installer owns recovery; use recoverInterrupted only after confirming it stopped')
    }
    if (hasJournal) {
      try {
        await rename(paths.journal, paths.recoveringJournal)
        await fsyncDirectory(paths.moduleDirectory)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' && await pathExists(paths.recoveringJournal)) {
          throw new ModuleInstallerError('BUSY', 'Another installer is recovering this module')
        }
        throw error
      }
    }
    await this.#fault('after-recovery-claimed')
    const journal = parseJournal(await this.#readSmallJson(paths.recoveringJournal), moduleId)
    const currentState = await this.#readState(paths.state)
    const staging = this.#stagingPath(journal.transactionId)
    const trash = this.#trashPath(journal.transactionId)
    const target = join(paths.versionsDirectory, journal.version)

    if (journal.operation === 'uninstall') {
      if (await pathExists(trash)) await rm(trash, { recursive: true, force: true })
      await this.#cleanupTransaction(paths, journal.transactionId, paths.recoveringJournal)
      return
    }

    if (statesEqual(currentState, journal.nextState)) {
      await this.#cleanupTransaction(paths, journal.transactionId, paths.recoveringJournal)
      return
    }

    if (!statesEqual(currentState, journal.previousState)) {
      throw new ModuleInstallerError('JOURNAL_INVALID', 'Activation state does not match either side of pending transaction')
    }
    if (journal.operation === 'install' && await pathExists(target)) {
      await rm(target, { recursive: true, force: true })
      await fsyncDirectory(paths.versionsDirectory)
    }
    if (await pathExists(staging)) await rm(staging, { recursive: true, force: true })
    await rm(paths.recoveringJournal, { force: true })
    await fsyncDirectory(paths.moduleDirectory)
  }

  async #ensureRoot(): Promise<void> {
    if (this.#rootReady) return
    await mkdir(this.#root, { recursive: true, mode: 0o700 })
    const info = await lstat(this.#root)
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new ModuleInstallerError('FILESYSTEM_ERROR', 'Module root must be a real directory, not a link')
    }
    await this.#ensureDirectory(join(this.#root, '.module-installer'))
    await this.#ensureDirectory(join(this.#root, '.module-installer', 'staging'))
    await this.#ensureDirectory(join(this.#root, '.module-installer', 'trash'))
    await this.#ensureDirectory(join(this.#root, 'modules'))
    const rootDevice = (await stat(this.#root)).dev
    for (const child of [join(this.#root, '.module-installer'), join(this.#root, 'modules')]) {
      if ((await stat(child)).dev !== rootDevice) {
        throw new ModuleInstallerError('FILESYSTEM_ERROR', 'Installer control and module directories must share one filesystem')
      }
    }
    this.#rootReady = true
  }

  async #ensureModuleLayout(moduleId: ModuleId): Promise<ModulePaths> {
    const paths = this.#modulePaths(moduleId)
    await this.#ensureDirectory(paths.moduleDirectory)
    await this.#ensureDirectory(paths.versionsDirectory)
    return paths
  }

  async #ensureDirectory(path: string): Promise<void> {
    await mkdir(path, { recursive: true, mode: 0o700 })
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new ModuleInstallerError('FILESYSTEM_ERROR', `Installer path must be a real directory: ${path}`)
    }
  }

  #modulePaths(moduleId: ModuleId): ModulePaths {
    this.#validateModuleId(moduleId)
    const moduleDirectory = join(this.#root, 'modules', moduleId)
    return {
      moduleDirectory,
      versionsDirectory: join(moduleDirectory, 'versions'),
      state: join(moduleDirectory, 'state.json'),
      journal: join(moduleDirectory, 'transaction.json'),
      journalClaim: join(moduleDirectory, 'transaction.claim'),
      recoveringJournal: join(moduleDirectory, 'transaction.recovering.json'),
    }
  }

  #stagingPath(transactionId: string): string {
    if (!TRANSACTION_ID_PATTERN.test(transactionId)) throw new ModuleInstallerError('JOURNAL_INVALID', 'Invalid transaction identifier')
    return join(this.#root, '.module-installer', 'staging', transactionId)
  }

  #trashPath(transactionId: string): string {
    if (!TRANSACTION_ID_PATTERN.test(transactionId)) throw new ModuleInstallerError('JOURNAL_INVALID', 'Invalid transaction identifier')
    return join(this.#root, '.module-installer', 'trash', transactionId)
  }

  async #readState(path: string): Promise<StateFile> {
    if (!(await pathExists(path))) return emptyState()
    return parseState(await this.#readSmallJson(path))
  }

  async #readSmallJson(path: string): Promise<unknown> {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) throw new ModuleInstallerError('JOURNAL_INVALID', 'Installer metadata file is invalid')
    try {
      return JSON.parse(await readFile(path, 'utf8')) as unknown
    } catch (error) {
      throw new ModuleInstallerError('JOURNAL_INVALID', 'Installer metadata is not valid JSON', error)
    }
  }

  async #cleanupTransaction(paths: ModulePaths, transactionId: string, metadataPath = paths.journal): Promise<void> {
    await rm(this.#stagingPath(transactionId), { recursive: true, force: true })
    await rm(this.#trashPath(transactionId), { recursive: true, force: true })
    await fsyncDirectory(join(this.#root, '.module-installer', 'staging'))
    await fsyncDirectory(join(this.#root, '.module-installer', 'trash'))
    await rm(metadataPath, { force: true })
    await fsyncDirectory(paths.moduleDirectory)
  }

  #progressReporter(callback?: (progress: InstallProgress) => void): (progress: InstallProgress) => void {
    let completed = -1
    return (progress) => {
      if (progress.completed < completed) return
      completed = progress.completed
      callback?.(Object.freeze({ ...progress }))
    }
  }

  #abortIfRequested(signal?: AbortSignal): void {
    if (signal?.aborted) throw new ModuleInstallerError('ABORTED', 'Module installation was cancelled')
  }

  async #fault(point: Parameters<NonNullable<ModuleInstallerOptions['faultInjector']>>[0]): Promise<void> {
    await this.#faultInjector?.(point)
  }

  async #assertIdle(paths: ModulePaths): Promise<void> {
    if (await pathExists(paths.journal) || await pathExists(paths.recoveringJournal) || await pathExists(paths.journalClaim)) {
      throw new ModuleInstallerError('BUSY', 'Module has a pending transaction; recover it before starting another operation')
    }
  }

  async #claimJournal(paths: ModulePaths, journal: JournalFile): Promise<void> {
    try {
      await createJsonExclusive(paths.journal, paths.journalClaim, journal, (point) => this.#fault(point))
    } catch (error) {
      if (error instanceof SimulatedInstallerCrash || error instanceof ModuleInstallerError) throw error
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new ModuleInstallerError('BUSY', 'Another installer owns the module transaction')
      }
      throw new ModuleInstallerError('FILESYSTEM_ERROR', `Could not publish module transaction journal: ${error instanceof Error ? error.message : String(error)}`, error)
    }
    try {
      const currentState = await this.#readState(paths.state)
      if (statesEqual(currentState, journal.previousState)) return
    } catch (error) {
      await rm(paths.journal, { force: true })
      await fsyncDirectory(paths.moduleDirectory)
      throw error
    }
    await rm(paths.journal, { force: true })
    await fsyncDirectory(paths.moduleDirectory)
    throw new ModuleInstallerError('BUSY', 'Module state changed while acquiring transaction ownership')
  }

  #validateModuleId(moduleId: string): asserts moduleId is ModuleId {
    if (!MODULE_ID_PATTERN.test(moduleId) || isAbsolute(moduleId)) {
      throw new ModuleInstallerError('DESCRIPTOR_INVALID', 'Module id is not a safe path component')
    }
  }

  async #exclusive<T>(moduleId: ModuleId, operation: () => Promise<T>): Promise<T> {
    if (this.#maintenanceActive || this.#busy.has(moduleId)) throw new ModuleInstallerError('BUSY', `Another operation is active for ${moduleId}`)
    this.#busy.add(moduleId)
    try {
      return await operation()
    } finally {
      this.#busy.delete(moduleId)
    }
  }
}
