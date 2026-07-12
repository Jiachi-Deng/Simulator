import {
  MODULE_CAPABILITIES,
  MODULE_MANIFEST_SCHEMA_VERSION,
  MODULE_PLATFORMS,
  MAX_MODULE_ARTIFACTS,
  MAX_MODULE_CAPABILITIES,
  type ManifestValidationError,
  type ManifestValidationErrorCode,
  type ModuleArtifact,
  type ModuleArtifactUrl,
  type ModuleCapability,
  type ModuleEntrypoint,
  type ModuleId,
  type ModuleManifestParseResult,
  type ModulePlatform,
  type ModuleSha256,
  type ModuleVersion,
} from './manifest-types.ts'

type DataRecord = Record<string, unknown>

const ROOT_FIELDS = ['schemaVersion', 'id', 'version', 'artifacts', 'capabilities'] as const
const ARTIFACT_FIELDS = ['platform', 'entrypoint', 'url', 'sha256'] as const
const ID_PATTERN = /^(?=.{3,128}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/
const ENTRYPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const PLATFORM_SET = new Set<string>(MODULE_PLATFORMS)
const CAPABILITY_SET = new Set<string>(MODULE_CAPABILITIES)

function freeze<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const nested of Object.values(value as Record<string, unknown>)) freeze(nested)
  }
  return value
}

function error(code: ManifestValidationErrorCode, path: string, message: string): ManifestValidationError {
  return { code, path, message }
}

function pointerPath(path: string, segment: string): string {
  return `${path}/${segment.replace(/~/g, '~0').replace(/\//g, '~1')}`
}

function asDataRecord(
  value: unknown,
  path: string,
  errors: ManifestValidationError[],
): DataRecord | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(error('INVALID_TYPE', path, 'Expected an object'))
    return undefined
  }

  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    errors.push(error('INVALID_TYPE', path, 'Expected a plain data object'))
    return undefined
  }

  const descriptors = Object.getOwnPropertyDescriptors(value)
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || descriptors[key]?.get || descriptors[key]?.set) {
      errors.push(error('UNREADABLE_INPUT', path, 'Input must contain only plain data properties'))
      return undefined
    }
  }

  const record: DataRecord = Object.create(null) as DataRecord
  for (const key of Object.keys(descriptors)) record[key] = descriptors[key]?.value
  return record
}

function asDataArray(
  value: unknown,
  path: string,
  maxLength: number,
  errors: ManifestValidationError[],
): readonly unknown[] | undefined {
  if (!Array.isArray(value)) {
    errors.push(error('INVALID_TYPE', path, 'Expected an array'))
    return undefined
  }
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    errors.push(error('INVALID_TYPE', path, 'Expected a plain data array'))
    return undefined
  }

  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
  const length = lengthDescriptor?.value
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) {
    errors.push(error('UNREADABLE_INPUT', path, 'Array length is not readable plain data'))
    return undefined
  }
  if (length > maxLength) {
    errors.push(error('LIMIT_EXCEEDED', path, `Array exceeds maximum item count of ${maxLength}`))
    return undefined
  }

  const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<PropertyKey, PropertyDescriptor>

  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key]
    if (typeof key !== 'string' || descriptor?.get || descriptor?.set) {
      errors.push(error('UNREADABLE_INPUT', path, 'Input must contain only plain data properties'))
      return undefined
    }
    if (key !== 'length' && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= length)) {
      errors.push(error('INVALID_TYPE', path, 'Expected a plain data array'))
      return undefined
    }
  }

  const output: unknown[] = []
  output.length = length
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[index]
    if (descriptor) output[index] = descriptor.value
  }
  return output
}

function rejectUnknownFields(
  record: DataRecord,
  allowed: readonly string[],
  path: string,
  errors: ManifestValidationError[],
): void {
  const allowedSet = new Set(allowed)
  for (const key of Object.keys(record).filter((candidate) => !allowedSet.has(candidate)).sort()) {
    errors.push(error('UNKNOWN_FIELD', pointerPath(path, key), `Unknown field: ${key}`))
  }
}

function required(record: DataRecord, key: string, path: string, errors: ManifestValidationError[]): unknown {
  if (!Object.hasOwn(record, key)) {
    errors.push(error('MISSING_FIELD', pointerPath(path, key), `Missing required field: ${key}`))
    return undefined
  }
  return record[key]
}

function stringField(
  record: DataRecord,
  key: string,
  path: string,
  errors: ManifestValidationError[],
): string | undefined {
  const value = required(record, key, path, errors)
  if (value === undefined && !Object.hasOwn(record, key)) return undefined
  if (typeof value !== 'string') {
    errors.push(error('INVALID_TYPE', pointerPath(path, key), 'Expected a string'))
    return undefined
  }
  return value
}

function parseArtifact(
  input: unknown,
  index: number,
  errors: ManifestValidationError[],
): ModuleArtifact | undefined {
  const path = `/artifacts/${index}`
  const record = asDataRecord(input, path, errors)
  if (!record) return undefined
  rejectUnknownFields(record, ARTIFACT_FIELDS, path, errors)

  const platform = stringField(record, 'platform', path, errors)
  const entrypoint = stringField(record, 'entrypoint', path, errors)
  const url = stringField(record, 'url', path, errors)
  const sha256 = stringField(record, 'sha256', path, errors)
  let valid = true

  if (platform !== undefined && !PLATFORM_SET.has(platform)) {
    errors.push(error('INVALID_PLATFORM', `${path}/platform`, 'Unsupported module platform'))
    valid = false
  }
  if (entrypoint !== undefined && !isValidEntrypoint(entrypoint)) {
    errors.push(error('INVALID_ENTRYPOINT', `${path}/entrypoint`, 'Entrypoint must be a safe relative POSIX path'))
    valid = false
  }
  if (url !== undefined && !isValidArtifactUrl(url)) {
    errors.push(error('INVALID_URL', `${path}/url`, 'Artifact URL must be a canonical absolute HTTPS URL without credentials or fragments'))
    valid = false
  }
  if (sha256 !== undefined && !SHA256_PATTERN.test(sha256)) {
    errors.push(error('INVALID_HASH', `${path}/sha256`, 'SHA-256 must be 64 lowercase hexadecimal characters'))
    valid = false
  }

  if (!platform || !entrypoint || !url || !sha256 || !valid) return undefined
  return {
    platform: platform as ModulePlatform,
    entrypoint: entrypoint as ModuleEntrypoint,
    url: url as ModuleArtifactUrl,
    sha256: sha256 as ModuleSha256,
  }
}

function isValidEntrypoint(value: string): boolean {
  if (value.length === 0 || value.length > 256 || value.startsWith('/') || value.includes('\\')) return false
  const segments = value.split('/')
  return segments.every((segment) => segment !== '.' && segment !== '..' && ENTRYPOINT_SEGMENT_PATTERN.test(segment))
}

function isValidArtifactUrl(value: string): boolean {
  if (/[\u0000-\u001F\u007F]/.test(value) || value.includes('\\')) return false
  try {
    const url = new URL(value)
    return url.href === value
      && url.protocol === 'https:'
      && url.username === ''
      && url.password === ''
      && url.hash === ''
      && url.hostname !== ''
  } catch {
    return false
  }
}

function invalidResult(errors: ManifestValidationError[]): ModuleManifestParseResult {
  return freeze({ ok: false as const, errors: errors.map((item) => freeze({ ...item })) })
}

export function parseModuleManifest(input: unknown): ModuleManifestParseResult {
  try {
    const errors: ManifestValidationError[] = []
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      return invalidResult([error('INPUT_NOT_OBJECT', '', 'Module manifest must be an object')])
    }

    const record = asDataRecord(input, '', errors)
    if (!record) return invalidResult(errors)

    const schemaVersion = required(record, 'schemaVersion', '', errors)
    if (schemaVersion !== MODULE_MANIFEST_SCHEMA_VERSION) {
      if (Object.hasOwn(record, 'schemaVersion')) {
        errors.push(
          typeof schemaVersion === 'number'
            ? error('UNSUPPORTED_SCHEMA_VERSION', '/schemaVersion', 'Unsupported module manifest schema version')
            : error('INVALID_TYPE', '/schemaVersion', 'Schema version must be a number'),
        )
      }
      return invalidResult(errors)
    }

    rejectUnknownFields(record, ROOT_FIELDS, '', errors)
    const id = stringField(record, 'id', '', errors)
    const version = stringField(record, 'version', '', errors)
    const artifactsInput = required(record, 'artifacts', '', errors)
    const capabilitiesInput = required(record, 'capabilities', '', errors)

    if (id !== undefined && !ID_PATTERN.test(id)) {
      errors.push(error('INVALID_ID', '/id', 'Module ID must be a lowercase dotted identifier'))
    }
    if (version !== undefined && !VERSION_PATTERN.test(version)) {
      errors.push(error('INVALID_VERSION', '/version', 'Module version must be valid Semantic Versioning'))
    }

    const artifacts: ModuleArtifact[] = []
    const artifactValues = Object.hasOwn(record, 'artifacts')
      ? asDataArray(artifactsInput, '/artifacts', MAX_MODULE_ARTIFACTS, errors)
      : undefined
    if (artifactValues?.length === 0) {
      errors.push(error('MISSING_FIELD', '/artifacts', 'At least one artifact is required'))
    } else if (artifactValues) {
      const seenPlatforms = new Set<ModulePlatform>()
      for (let index = 0; index < artifactValues.length; index += 1) {
        if (!Object.hasOwn(artifactValues, index)) {
          errors.push(error('INVALID_TYPE', `/artifacts/${index}`, 'Sparse arrays are not accepted'))
          continue
        }
        const artifact = parseArtifact(artifactValues[index], index, errors)
        if (!artifact) continue
        if (seenPlatforms.has(artifact.platform)) {
          errors.push(error('DUPLICATE_DECLARATION', `/artifacts/${index}/platform`, 'Artifact platform is declared more than once'))
          continue
        }
        seenPlatforms.add(artifact.platform)
        artifacts.push(artifact)
      }
    }

    const capabilities: ModuleCapability[] = []
    const capabilityValues = Object.hasOwn(record, 'capabilities')
      ? asDataArray(capabilitiesInput, '/capabilities', MAX_MODULE_CAPABILITIES, errors)
      : undefined
    if (capabilityValues) {
      const seenCapabilities = new Set<ModuleCapability>()
      for (let index = 0; index < capabilityValues.length; index += 1) {
        const capability = capabilityValues[index]
        if (!Object.hasOwn(capabilityValues, index) || typeof capability !== 'string') {
          errors.push(error('INVALID_TYPE', `/capabilities/${index}`, 'Capability must be a string'))
          continue
        }
        if (!CAPABILITY_SET.has(capability)) {
          errors.push(error('INVALID_CAPABILITY', `/capabilities/${index}`, 'Unsupported module capability'))
          continue
        }
        const typedCapability = capability as ModuleCapability
        if (seenCapabilities.has(typedCapability)) {
          errors.push(error('DUPLICATE_DECLARATION', `/capabilities/${index}`, 'Capability is declared more than once'))
          continue
        }
        seenCapabilities.add(typedCapability)
        capabilities.push(typedCapability)
      }
    }

    if (errors.length > 0 || !id || !version) return invalidResult(errors)
    return freeze({
      ok: true as const,
      value: {
        schemaVersion: MODULE_MANIFEST_SCHEMA_VERSION,
        id: id as ModuleId,
        version: version as ModuleVersion,
        artifacts,
        capabilities,
      },
    })
  } catch {
    return invalidResult([error('UNREADABLE_INPUT', '', 'Module manifest could not be read as plain data')])
  }
}
