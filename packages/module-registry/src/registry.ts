import {
  isValidatedModuleManifest,
  MODULE_MANIFEST_SCHEMA_VERSION,
  MODULE_PLATFORMS,
  parseModuleManifest,
  type ModuleManifest,
  type ModulePlatform,
} from '@simulator/module-contract'
import { compareBuild, satisfies, valid, validRange } from 'semver'
import { InMemoryModuleRegistryPersistence } from './persistence.ts'
import {
  MODULE_REGISTRY_STATE_SCHEMA_VERSION,
  type InstalledModuleSnapshot,
  type InstalledModuleVersionSnapshot,
  type ModuleInstallCompatibility,
  type ModuleRegistryHost,
  type ModuleRegistryPersistence,
  type ModuleRegistrySnapshot,
  type PersistedModuleRegistryStateV1,
  type RegistryDiagnostic,
  type RegistryDiagnosticCode,
  type RegistryMutationResult,
  type SafeRemovalTransition,
} from './types.ts'

interface InstalledVersionRecord {
  readonly manifest: ModuleManifest
  readonly hostVersionRange: string
}

interface InstalledModuleRecord {
  readonly id: string
  disabled: boolean
  activeVersion: string | null
  lastKnownGoodVersion: string | null
  readonly versions: Map<string, InstalledVersionRecord>
}

interface RecoveredState {
  readonly modules: Map<string, InstalledModuleRecord>
  readonly diagnostics: RegistryDiagnostic[]
}

const PLATFORM_SET = new Set<string>(MODULE_PLATFORMS)

class CorruptStateError extends Error {}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function compareVersions(left: string, right: string): number {
  return compareBuild(left, right) || compareText(left, right)
}

function freeze<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const nested of Object.values(value as Record<string, unknown>)) freeze(nested)
  }
  return value
}

function diagnostic(
  code: RegistryDiagnosticCode,
  message: string,
  moduleId?: string,
  version?: string,
): RegistryDiagnostic {
  return moduleId === undefined
    ? { code, message }
    : version === undefined
      ? { code, message, moduleId }
      : { code, message, moduleId, version }
}

function sortedDiagnostics(values: readonly RegistryDiagnostic[]): RegistryDiagnostic[] {
  return [...values].sort((left, right) =>
    compareText(left.code, right.code)
    || compareText(left.moduleId ?? '', right.moduleId ?? '')
    || compareVersionsIfValid(left.version, right.version)
    || compareText(left.message, right.message))
}

function compareVersionsIfValid(left: string | undefined, right: string | undefined): number {
  if (left === undefined || right === undefined) return compareText(left ?? '', right ?? '')
  return valid(left) && valid(right) ? compareVersions(left, right) : compareText(left, right)
}

function canonicalManifest(manifest: ModuleManifest): ModuleManifest {
  return freeze({
    schemaVersion: manifest.schemaVersion,
    id: manifest.id,
    version: manifest.version,
    artifacts: [...manifest.artifacts]
      .sort((left, right) => compareText(left.platform, right.platform))
      .map((artifact) => ({ ...artifact })),
    capabilities: [...manifest.capabilities].sort(compareText),
  }) as ModuleManifest
}

function manifestFingerprint(manifest: ModuleManifest, hostVersionRange: string): string {
  return JSON.stringify({ manifest: canonicalManifest(manifest), hostVersionRange })
}

function ownDataRecord(input: unknown, label: string): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new CorruptStateError(`${label} must be an object`)
  }
  const prototype = Object.getPrototypeOf(input)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new CorruptStateError(`${label} must be a plain object`)
  }
  const descriptors = Object.getOwnPropertyDescriptors(input)
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || descriptors[key]?.get || descriptors[key]?.set) {
      throw new CorruptStateError(`${label} must contain only data properties`)
    }
    output[key] = descriptors[key]?.value
  }
  return output
}

function exactFields(record: Record<string, unknown>, fields: readonly string[], label: string): void {
  const expected = new Set(fields)
  if (Object.keys(record).some((key) => !expected.has(key)) || fields.some((key) => !Object.hasOwn(record, key))) {
    throw new CorruptStateError(`${label} fields are invalid`)
  }
}

function plainArray(input: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) {
    throw new CorruptStateError(`${label} must be a plain array`)
  }
  const descriptors = Object.getOwnPropertyDescriptors(input)
  for (let index = 0; index < input.length; index += 1) {
    const descriptor = descriptors[index]
    if (!descriptor || descriptor.get || descriptor.set) {
      throw new CorruptStateError(`${label} must be a dense data array`)
    }
  }
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string' || (key !== 'length' && !/^(0|[1-9]\d*)$/.test(key)))) {
    throw new CorruptStateError(`${label} contains invalid properties`)
  }
  return input
}

function nullableString(input: unknown, label: string): string | null {
  if (input !== null && typeof input !== 'string') throw new CorruptStateError(`${label} must be a string or null`)
  return input
}

function compatibilityReasons(
  manifest: ModuleManifest,
  hostVersionRange: string,
  host: ModuleRegistryHost,
): RegistryDiagnostic[] {
  const reasons: RegistryDiagnostic[] = []
  if (!manifest.artifacts.some((artifact) => artifact.platform === host.platform)) {
    reasons.push(diagnostic(
      'INCOMPATIBLE_PLATFORM',
      `Module has no artifact for host platform ${host.platform}`,
      manifest.id,
      manifest.version,
    ))
  }
  if (!satisfies(host.version, hostVersionRange)) {
    reasons.push(diagnostic(
      'INCOMPATIBLE_HOST_VERSION',
      `Host version ${host.version} does not satisfy ${hostVersionRange}`,
      manifest.id,
      manifest.version,
    ))
  }
  return sortedDiagnostics(reasons)
}

function cloneState(source: Map<string, InstalledModuleRecord>): Map<string, InstalledModuleRecord> {
  const output = new Map<string, InstalledModuleRecord>()
  for (const [id, module] of source) {
    output.set(id, {
      id,
      disabled: module.disabled,
      activeVersion: module.activeVersion,
      lastKnownGoodVersion: module.lastKnownGoodVersion,
      versions: new Map(module.versions),
    })
  }
  return output
}

export class ModuleRegistry {
  readonly host: ModuleRegistryHost
  private readonly persistence: ModuleRegistryPersistence
  private modules = new Map<string, InstalledModuleRecord>()
  private recoveryDiagnostics: readonly RegistryDiagnostic[] = freeze([])

  constructor(host: ModuleRegistryHost, persistence: ModuleRegistryPersistence = new InMemoryModuleRegistryPersistence()) {
    if (valid(host.version) !== host.version) throw new TypeError('Registry host version must be canonical Semantic Versioning')
    if (!PLATFORM_SET.has(host.platform)) throw new TypeError('Registry host platform is unsupported')
    this.host = freeze({ version: host.version, platform: host.platform }) as ModuleRegistryHost
    this.persistence = persistence
    this.recover()
  }

  snapshot(): ModuleRegistrySnapshot {
    const modules = [...this.modules.values()]
      .sort((left, right) => compareText(left.id, right.id))
      .map((module): InstalledModuleSnapshot => ({
        id: module.id,
        disabled: module.disabled,
        activeVersion: module.activeVersion,
        lastKnownGoodVersion: module.lastKnownGoodVersion,
        versions: [...module.versions.values()]
          .sort((left, right) => compareVersions(left.manifest.version, right.manifest.version))
          .map((record): InstalledModuleVersionSnapshot => {
            const reasons = compatibilityReasons(record.manifest, record.hostVersionRange, this.host)
            return {
              version: record.manifest.version,
              manifest: canonicalManifest(record.manifest),
              hostVersionRange: record.hostVersionRange,
              compatibility: reasons.length === 0 ? 'compatible' : 'incompatible',
              incompatibilityReasons: reasons,
            }
          }),
      }))

    return freeze({
      host: { ...this.host },
      modules,
      diagnostics: sortedDiagnostics(this.recoveryDiagnostics),
    }) as ModuleRegistrySnapshot
  }

  install(manifest: ModuleManifest, compatibility: ModuleInstallCompatibility): RegistryMutationResult {
    if (!isValidatedModuleManifest(manifest)) return this.failure(this.unvalidatedManifestDiagnostic(manifest))

    const normalizedRange = this.normalizeHostRange(compatibility)
    if (typeof normalizedRange !== 'string') return this.failure(normalizedRange)

    const incompatibilities = compatibilityReasons(manifest, normalizedRange, this.host)
    if (incompatibilities.length > 0) return this.failure(...incompatibilities)

    const existing = this.modules.get(manifest.id)?.versions.get(manifest.version)
    if (existing) {
      const duplicate = manifestFingerprint(existing.manifest, existing.hostVersionRange)
        === manifestFingerprint(manifest, normalizedRange)
      return this.failure(diagnostic(
        duplicate ? 'DUPLICATE_VERSION' : 'MANIFEST_CONFLICT',
        duplicate
          ? 'Module version is already installed with the same manifest'
          : 'Module version conflicts with an installed manifest or host range',
        manifest.id,
        manifest.version,
      ))
    }

    return this.mutate((next) => {
      let module = next.get(manifest.id)
      if (!module) {
        module = {
          id: manifest.id,
          disabled: false,
          activeVersion: null,
          lastKnownGoodVersion: null,
          versions: new Map(),
        }
        next.set(manifest.id, module)
      }
      module.versions.set(manifest.version, { manifest, hostVersionRange: normalizedRange })
    })
  }

  activate(moduleId: string, version: string): RegistryMutationResult {
    const lookup = this.compatibleVersion(moduleId, version)
    if ('diagnostic' in lookup) return this.failure(lookup.diagnostic)
    if (lookup.module.disabled) {
      return this.failure(diagnostic('MODULE_DISABLED', 'Disabled module cannot be activated', moduleId, version))
    }
    return this.mutate((next) => {
      next.get(moduleId)!.activeVersion = version
    })
  }

  markLastKnownGood(moduleId: string, version: string): RegistryMutationResult {
    const lookup = this.compatibleVersion(moduleId, version)
    if ('diagnostic' in lookup) return this.failure(lookup.diagnostic)
    return this.mutate((next) => {
      next.get(moduleId)!.lastKnownGoodVersion = version
    })
  }

  disable(moduleId: string): RegistryMutationResult {
    return this.setDisabled(moduleId, true)
  }

  enable(moduleId: string): RegistryMutationResult {
    return this.setDisabled(moduleId, false)
  }

  remove(moduleId: string, version: string, transition: SafeRemovalTransition = {}): RegistryMutationResult {
    const module = this.modules.get(moduleId)
    if (!module) return this.failure(diagnostic('MODULE_NOT_FOUND', 'Module is not installed', moduleId))
    if (!module.versions.has(version)) {
      return this.failure(diagnostic('VERSION_NOT_FOUND', 'Module version is not installed', moduleId, version))
    }

    if (module.activeVersion === version && !Object.hasOwn(transition, 'activeVersion')) {
      return this.failure(diagnostic(
        'ACTIVE_REMOVAL_GUARD',
        'Removing the active version requires an explicit safe transition',
        moduleId,
        version,
      ))
    }
    if (module.lastKnownGoodVersion === version && !Object.hasOwn(transition, 'lastKnownGoodVersion')) {
      return this.failure(diagnostic(
        'LAST_KNOWN_GOOD_REMOVAL_GUARD',
        'Removing the last-known-good version requires an explicit safe transition',
        moduleId,
        version,
      ))
    }

    if (Object.hasOwn(transition, 'activeVersion') && module.activeVersion !== version) {
      return this.failure(diagnostic(
        'ACTIVE_REMOVAL_GUARD',
        'Active transition is only allowed when removing the current active version',
        moduleId,
        version,
      ))
    }

    if (Object.hasOwn(transition, 'activeVersion') && transition.activeVersion === undefined) {
      return this.failure(diagnostic(
        'VERSION_NOT_FOUND',
        'activeVersion transition must name an installed remaining version or explicitly use null',
        moduleId,
        version,
      ))
    }
    if (Object.hasOwn(transition, 'lastKnownGoodVersion') && transition.lastKnownGoodVersion === undefined) {
      return this.failure(diagnostic(
        'VERSION_NOT_FOUND',
        'lastKnownGoodVersion transition must name an installed remaining version or explicitly use null',
        moduleId,
        version,
      ))
    }

    const activeError = this.validateTransitionTarget(module, version, transition.activeVersion, 'activeVersion')
    if (activeError) return this.failure(activeError)
    if (transition.activeVersion !== undefined && transition.activeVersion !== null && module.disabled) {
      return this.failure(diagnostic(
        'MODULE_DISABLED',
        'Disabled module cannot activate a replacement during removal',
        moduleId,
        transition.activeVersion,
      ))
    }
    const lastKnownGoodError = this.validateTransitionTarget(
      module,
      version,
      transition.lastKnownGoodVersion,
      'lastKnownGoodVersion',
    )
    if (lastKnownGoodError) return this.failure(lastKnownGoodError)

    return this.mutate((next) => {
      const nextModule = next.get(moduleId)!
      if (Object.hasOwn(transition, 'activeVersion')) nextModule.activeVersion = transition.activeVersion ?? null
      if (Object.hasOwn(transition, 'lastKnownGoodVersion')) {
        nextModule.lastKnownGoodVersion = transition.lastKnownGoodVersion ?? null
      }
      nextModule.versions.delete(version)
      if (nextModule.versions.size === 0) next.delete(moduleId)
    })
  }

  private recover(): void {
    try {
      const read = this.persistence.read()
      const recovered = read.committed === null
        ? { modules: new Map<string, InstalledModuleRecord>(), diagnostics: [] }
        : this.parsePersistedState(read.committed)
      if (read.interruptedCommit) {
        recovered.diagnostics.push(diagnostic(
          'RECOVERY_INTERRUPTED_COMMIT',
          'Ignored an incomplete registry commit and recovered the previous snapshot',
        ))
      }
      this.modules = recovered.modules
      this.recoveryDiagnostics = freeze(sortedDiagnostics(recovered.diagnostics))
    } catch {
      this.modules = new Map()
      this.recoveryDiagnostics = freeze([
        diagnostic('CORRUPT_PERSISTED_STATE', 'Persisted optional-module state is corrupt; recovered an empty registry'),
      ])
    }
  }

  private parsePersistedState(input: unknown): RecoveredState {
    const root = ownDataRecord(input, 'registry state')
    exactFields(root, ['schemaVersion', 'host', 'modules'], 'registry state')
    if (root.schemaVersion !== MODULE_REGISTRY_STATE_SCHEMA_VERSION) {
      throw new CorruptStateError('Unsupported registry state schema')
    }

    const persistedHost = ownDataRecord(root.host, 'registry host')
    exactFields(persistedHost, ['version', 'platform'], 'registry host')
    if (typeof persistedHost.version !== 'string' || valid(persistedHost.version) !== persistedHost.version) {
      throw new CorruptStateError('Persisted host version is invalid')
    }
    if (typeof persistedHost.platform !== 'string' || !PLATFORM_SET.has(persistedHost.platform)) {
      throw new CorruptStateError('Persisted host platform is invalid')
    }
    const hostChanged = persistedHost.version !== this.host.version || persistedHost.platform !== this.host.platform

    const modules = new Map<string, InstalledModuleRecord>()
    const diagnostics: RegistryDiagnostic[] = []
    for (const [moduleIndex, moduleInput] of plainArray(root.modules, 'registry modules').entries()) {
      const persistedModule = ownDataRecord(moduleInput, `registry module ${moduleIndex}`)
      exactFields(
        persistedModule,
        ['id', 'disabled', 'activeVersion', 'lastKnownGoodVersion', 'versions'],
        `registry module ${moduleIndex}`,
      )
      if (typeof persistedModule.id !== 'string' || typeof persistedModule.disabled !== 'boolean') {
        throw new CorruptStateError('Persisted module identity or disabled state is invalid')
      }
      if (modules.has(persistedModule.id)) throw new CorruptStateError('Persisted module ID is duplicated')

      const module: InstalledModuleRecord = {
        id: persistedModule.id,
        disabled: persistedModule.disabled,
        activeVersion: nullableString(persistedModule.activeVersion, 'active version'),
        lastKnownGoodVersion: nullableString(persistedModule.lastKnownGoodVersion, 'last-known-good version'),
        versions: new Map(),
      }

      for (const [versionIndex, versionInput] of plainArray(persistedModule.versions, 'module versions').entries()) {
        const persistedVersion = ownDataRecord(versionInput, `module version ${versionIndex}`)
        exactFields(persistedVersion, ['manifest', 'hostVersionRange'], `module version ${versionIndex}`)
        if (typeof persistedVersion.hostVersionRange !== 'string') {
          throw new CorruptStateError('Persisted host version range is invalid')
        }
        const normalizedRange = validRange(persistedVersion.hostVersionRange)
        if (!normalizedRange) throw new CorruptStateError('Persisted host version range is invalid')
        const parsedManifest = parseModuleManifest(persistedVersion.manifest)
        if (!parsedManifest.ok || parsedManifest.value.id !== module.id) {
          throw new CorruptStateError('Persisted manifest is invalid or has conflicting identity')
        }
        if (module.versions.has(parsedManifest.value.version)) {
          throw new CorruptStateError('Persisted module version is duplicated')
        }
        module.versions.set(parsedManifest.value.version, {
          manifest: parsedManifest.value,
          hostVersionRange: normalizedRange,
        })
      }
      if (module.versions.size === 0) throw new CorruptStateError('Persisted module has no versions')

      module.activeVersion = this.recoverReference(
        module,
        module.activeVersion,
        hostChanged,
        diagnostics,
        'ACTIVE_CLEARED_INCOMPATIBLE',
      )
      module.lastKnownGoodVersion = this.recoverReference(
        module,
        module.lastKnownGoodVersion,
        hostChanged,
        diagnostics,
        'LAST_KNOWN_GOOD_CLEARED_INCOMPATIBLE',
      )
      modules.set(module.id, module)
    }
    return { modules, diagnostics }
  }

  private recoverReference(
    module: InstalledModuleRecord,
    version: string | null,
    hostChanged: boolean,
    diagnostics: RegistryDiagnostic[],
    code: 'ACTIVE_CLEARED_INCOMPATIBLE' | 'LAST_KNOWN_GOOD_CLEARED_INCOMPATIBLE',
  ): string | null {
    if (version === null) return null
    const record = module.versions.get(version)
    if (!record) throw new CorruptStateError('Persisted version reference is not installed')
    if (compatibilityReasons(record.manifest, record.hostVersionRange, this.host).length === 0) return version
    if (!hostChanged) throw new CorruptStateError('Persisted version reference is incompatible with its host')
    diagnostics.push(diagnostic(
      code,
      code === 'ACTIVE_CLEARED_INCOMPATIBLE'
        ? 'Cleared active version because the recovered host is incompatible'
        : 'Cleared last-known-good version because the recovered host is incompatible',
      module.id,
      version,
    ))
    return null
  }

  private normalizeHostRange(compatibility: ModuleInstallCompatibility): string | RegistryDiagnostic {
    try {
      const record = ownDataRecord(compatibility, 'module compatibility')
      exactFields(record, ['hostVersionRange'], 'module compatibility')
      if (typeof record.hostVersionRange !== 'string') throw new CorruptStateError('Host version range must be a string')
      const normalized = validRange(record.hostVersionRange)
      if (normalized) return normalized
    } catch {
      // Returned below as a stable public diagnostic.
    }
    return diagnostic('INVALID_HOST_VERSION_RANGE', 'Module host version range is invalid')
  }

  private unvalidatedManifestDiagnostic(manifest: unknown): RegistryDiagnostic {
    try {
      const record = ownDataRecord(manifest, 'module manifest')
      const schemaDescriptor = Object.getOwnPropertyDescriptor(record, 'schemaVersion')
      const schemaVersion = schemaDescriptor?.value
      if (typeof schemaVersion === 'number' && schemaVersion !== MODULE_MANIFEST_SCHEMA_VERSION) {
        return diagnostic('UNSUPPORTED_MANIFEST_SCHEMA', 'Module manifest schema is unsupported')
      }
    } catch {
      // Returned below as a stable public diagnostic.
    }
    return diagnostic('UNVALIDATED_MANIFEST', 'Registry accepts only manifests returned by parseModuleManifest')
  }

  private compatibleVersion(moduleId: string, version: string):
    | { module: InstalledModuleRecord; record: InstalledVersionRecord }
    | { diagnostic: RegistryDiagnostic } {
    const module = this.modules.get(moduleId)
    if (!module) return { diagnostic: diagnostic('MODULE_NOT_FOUND', 'Module is not installed', moduleId) }
    const record = module.versions.get(version)
    if (!record) {
      return { diagnostic: diagnostic('VERSION_NOT_FOUND', 'Module version is not installed', moduleId, version) }
    }
    if (compatibilityReasons(record.manifest, record.hostVersionRange, this.host).length > 0) {
      return { diagnostic: diagnostic('VERSION_INCOMPATIBLE', 'Module version is incompatible with this host', moduleId, version) }
    }
    return { module, record }
  }

  private validateTransitionTarget(
    module: InstalledModuleRecord,
    removedVersion: string,
    target: string | null | undefined,
    field: keyof SafeRemovalTransition,
  ): RegistryDiagnostic | undefined {
    if (target === undefined || target === null) return undefined
    if (target === removedVersion || !module.versions.has(target)) {
      return diagnostic('VERSION_NOT_FOUND', `${field} transition target is not an installed remaining version`, module.id, target)
    }
    const record = module.versions.get(target)!
    if (compatibilityReasons(record.manifest, record.hostVersionRange, this.host).length > 0) {
      return diagnostic('VERSION_INCOMPATIBLE', `${field} transition target is incompatible`, module.id, target)
    }
    return undefined
  }

  private setDisabled(moduleId: string, disabled: boolean): RegistryMutationResult {
    const module = this.modules.get(moduleId)
    if (!module) return this.failure(diagnostic('MODULE_NOT_FOUND', 'Module is not installed', moduleId))
    if (module.disabled === disabled) return this.success()
    return this.mutate((next) => {
      next.get(moduleId)!.disabled = disabled
    })
  }

  private mutate(change: (next: Map<string, InstalledModuleRecord>) => void): RegistryMutationResult {
    const next = cloneState(this.modules)
    change(next)
    try {
      this.persistence.commit(this.serialize(next))
    } catch {
      return this.failure(diagnostic(
        'PERSISTENCE_WRITE_FAILED',
        'Registry mutation was not committed; the previous snapshot is unchanged',
      ))
    }
    this.modules = next
    this.recoveryDiagnostics = freeze([])
    return this.success()
  }

  private serialize(modules: Map<string, InstalledModuleRecord>): PersistedModuleRegistryStateV1 {
    return {
      schemaVersion: MODULE_REGISTRY_STATE_SCHEMA_VERSION,
      host: { ...this.host },
      modules: [...modules.values()]
        .sort((left, right) => compareText(left.id, right.id))
        .map((module) => ({
          id: module.id,
          disabled: module.disabled,
          activeVersion: module.activeVersion,
          lastKnownGoodVersion: module.lastKnownGoodVersion,
          versions: [...module.versions.values()]
            .sort((left, right) => compareVersions(left.manifest.version, right.manifest.version))
            .map((record) => ({
              manifest: canonicalManifest(record.manifest),
              hostVersionRange: record.hostVersionRange,
            })),
        })),
    }
  }

  private success(): RegistryMutationResult {
    return freeze({ ok: true as const, snapshot: this.snapshot(), diagnostics: [] }) as RegistryMutationResult
  }

  private failure(...diagnostics: RegistryDiagnostic[]): RegistryMutationResult {
    return freeze({
      ok: false as const,
      snapshot: this.snapshot(),
      diagnostics: sortedDiagnostics(diagnostics),
    }) as RegistryMutationResult
  }
}
