import { createHash } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises'
import { dirname, isAbsolute, normalize, relative, resolve } from 'node:path'
import type { ModuleSha256 } from '@simulator/module-contract'
import type { ModuleCoordinatorInstallRequest } from '@simulator/module-coordinator'
import {
  decodeCatalogEnvelope,
  type DownloaderFetchAdapter,
  type DownloaderFetchRequest,
  type DownloaderHeaders,
  type DownloaderResponse,
} from '@simulator/module-downloader'
import { verifyModuleReleaseCatalog, type TrustedReleaseKey } from '@simulator/module-release-trust'
import { validRange } from 'semver'

export const DEVELOPMENT_MODULE_BUNDLE_SCHEMA_VERSION = 2 as const
const MAX_DESCRIPTOR_BYTES = 64 * 1024
const MAX_CATALOG_BYTES = 4 * 1024 * 1024
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024
const MAX_RELATIVE_PATH_BYTES = 512
const MAX_URL_BYTES = 2 * 1024
const MAX_ETAG_BYTES = 130
const MAX_DEVELOPMENT_KEY_WINDOW_MS = 31 * 24 * 60 * 60 * 1_000
const READ_CHUNK_BYTES = 64 * 1024
const INSECURE_MODE_BITS = 0o7077n

const MODULE_ID_PATTERN = /^(?=.{3,128}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/
const KEY_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const RELATIVE_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/
const STRONG_ETAG_PATTERN = /^"[A-Za-z0-9._:-]{1,128}"$/
const SYNTHETIC_URL_PATH_PATTERN = /^\/[A-Za-z0-9._~/-]+$/

type ResourceRole = 'catalog' | 'archive'

export type DevelopmentModuleBundleErrorCode =
  | 'INVALID_DESCRIPTOR_PATH'
  | 'INSECURE_BUNDLE_ROOT'
  | 'INSECURE_DESCRIPTOR'
  | 'INVALID_DESCRIPTOR'
  | 'INVALID_RESOURCE'
  | 'RESOURCE_CHANGED'
  | 'REQUEST_REFUSED'
  | 'ABORTED'
  | 'BODY_ALREADY_CONSUMED'
  | 'BODY_DISPOSED'
  | 'CATALOG_TRUST_FAILED'
  | 'RELEASE_MISSING'
  | 'RELEASE_DUPLICATE'
  | 'RELEASE_MISMATCH'

export class DevelopmentModuleBundleError extends Error {
  readonly code: DevelopmentModuleBundleErrorCode

  constructor(code: DevelopmentModuleBundleErrorCode, message: string) {
    super(message)
    this.name = 'DevelopmentModuleBundleError'
    this.code = code
  }
}

export interface DevelopmentModuleBundleReleaseMetadata {
  readonly developmentOnly: true
  readonly nonPromotable: true
  readonly moduleId: string
  readonly version: string
  readonly platform: 'darwin-arm64'
  readonly archiveUrl: string
  readonly archiveSha256: string
  readonly archiveSize: number
}

export interface LoadedDevelopmentModuleBundle {
  readonly catalogUrl: string
  readonly trustedKeys: readonly TrustedReleaseKey[]
  readonly fetchAdapter: DownloaderFetchAdapter
  /** Informational only. The signed catalog remains authoritative for release selection. */
  readonly release: DevelopmentModuleBundleReleaseMetadata
  readonly installRequest: Readonly<ModuleCoordinatorInstallRequest>
}

export interface LoadDevelopmentModuleBundleOptions {
  readonly descriptorPath: string
  readonly expectedModuleId: string
}

interface ParsedResource {
  readonly role: ResourceRole
  readonly url: string
  readonly relativePath: string
  readonly size: number
  readonly sha256: string
  readonly etag: string
}

interface PinnedResource extends ParsedResource {
  readonly absolutePath: string
  readonly identity: FileIdentity
}

interface ParsedDescriptor {
  readonly moduleId: string
  readonly version: string
  readonly platform: 'darwin-arm64'
  readonly trustedKey: TrustedReleaseKey
  readonly extractedManifestSha256: ModuleSha256
  readonly hostVersionRange: string
  readonly catalog: ParsedResource
  readonly archive: ParsedResource
}

interface PinnedResourceResult {
  readonly resource: PinnedResource
  readonly verifiedBytes?: Uint8Array
}

interface FileIdentity {
  readonly dev: bigint
  readonly ino: bigint
  readonly mode: bigint
  readonly uid: bigint
  readonly nlink: bigint
  readonly size: bigint
  readonly mtimeNs: bigint
  readonly ctimeNs: bigint
}

interface OpenResponseBody {
  readonly body: AsyncIterable<Uint8Array>
  dispose(): Promise<void>
}

class FixedHeaders implements DownloaderHeaders {
  readonly #values: ReadonlyMap<string, string>

  constructor(values: Readonly<Record<string, string>>) {
    this.#values = new Map(Object.entries(values).map(([name, value]) => [name.toLowerCase(), value]))
  }

  get(name: string): string | null {
    return this.#values.get(name.toLowerCase()) ?? null
  }
}

export async function loadDevelopmentModuleBundle(
  options: LoadDevelopmentModuleBundleOptions,
): Promise<LoadedDevelopmentModuleBundle> {
  const expectedModuleId = parseExpectedModuleId(options.expectedModuleId)
  const descriptorPath = validateAbsoluteCanonicalPath(options.descriptorPath)
  const root = dirname(descriptorPath)
  const ownerUid = currentOwnerUid()

  await validateDirectory(root, ownerUid, 'INSECURE_BUNDLE_ROOT')
  const descriptorBytes = await readDescriptor(descriptorPath, root, ownerUid)
  const descriptor = parseDescriptor(descriptorBytes, expectedModuleId)
  if (descriptor.catalog.url === descriptor.archive.url || descriptor.catalog.relativePath === descriptor.archive.relativePath) {
    invalidDescriptor('Catalog and archive resources must be distinct')
  }
  if (new URL(descriptor.catalog.url).origin !== new URL(descriptor.archive.url).origin) {
    invalidDescriptor('Catalog and archive URLs must share one synthetic origin')
  }

  const catalogResult = await pinResource(root, descriptor.catalog, ownerUid, true)
  const archiveResult = await pinResource(root, descriptor.archive, ownerUid)
  const catalog = catalogResult.resource
  const archive = archiveResult.resource
  if (!catalogResult.verifiedBytes) catalogTrustFailed()
  const trustedKey = Object.freeze({ ...descriptor.trustedKey, publicKey: Uint8Array.from(descriptor.trustedKey.publicKey) })
  const installRequest = createInstallRequest(catalogResult.verifiedBytes, catalog, archive, descriptor, trustedKey)

  return Object.freeze({
    catalogUrl: catalog.url,
    trustedKeys: Object.freeze([trustedKey]),
    fetchAdapter: new DevelopmentModuleBundleFetchAdapter(root, ownerUid, catalog, archive),
    release: Object.freeze({
      developmentOnly: true,
      nonPromotable: true,
      moduleId: descriptor.moduleId,
      version: descriptor.version,
      platform: descriptor.platform,
      archiveUrl: archive.url,
      archiveSha256: archive.sha256,
      archiveSize: archive.size,
    }),
    installRequest,
  })
}

class DevelopmentModuleBundleFetchAdapter implements DownloaderFetchAdapter {
  readonly #root: string
  readonly #ownerUid: bigint
  readonly #resources: ReadonlyMap<string, PinnedResource>

  constructor(root: string, ownerUid: bigint, catalog: PinnedResource, archive: PinnedResource) {
    this.#root = root
    this.#ownerUid = ownerUid
    this.#resources = new Map([[catalog.url, catalog], [archive.url, archive]])
  }

  async fetch(request: DownloaderFetchRequest): Promise<DownloaderResponse> {
    assertNotAborted(request.signal)
    if (request.redirect !== 'manual') requestRefused()
    const resource = this.#resources.get(request.url)
    if (!resource) requestRefused()

    const opened = await openVerifiedResource(this.#root, resource, this.#ownerUid, request.signal)
    if (resource.role === 'catalog') {
      if (requestHeader(request.headers, 'range') !== undefined) {
        await opened.dispose()
        requestRefused()
      }
      if (requestHeader(request.headers, 'if-none-match') === resource.etag) {
        await opened.dispose()
        return response(resource.url, 304, { etag: resource.etag }, null)
      }
      return response(resource.url, 200, {
        'content-type': 'application/vnd.simulator.module-catalog+json',
        'content-length': String(resource.size),
        etag: resource.etag,
      }, opened)
    }

    const rangeValue = requestHeader(request.headers, 'range')
    if (rangeValue === undefined) {
      return response(resource.url, 200, archiveHeaders(resource, resource.size), opened)
    }

    const rangeStart = parseOpenEndedRange(rangeValue, resource.size)
    if (rangeStart === undefined) {
      await opened.dispose()
      return response(resource.url, 416, {
        'content-range': `bytes */${resource.size}`,
        'content-length': '0',
        etag: resource.etag,
      }, null)
    }
    if (requestHeader(request.headers, 'if-range') !== resource.etag) {
      return response(resource.url, 200, archiveHeaders(resource, resource.size), opened)
    }

    const length = resource.size - rangeStart
    return response(resource.url, 206, {
      ...archiveHeaders(resource, length),
      'content-range': `bytes ${rangeStart}-${resource.size - 1}/${resource.size}`,
    }, sliceBody(opened, rangeStart, resource.size))
  }
}

function response(
  url: string,
  status: number,
  headers: Readonly<Record<string, string>>,
  opened: OpenResponseBody | null,
): DownloaderResponse {
  let disposed = false
  return {
    status,
    url,
    headers: new FixedHeaders(headers),
    body: opened?.body ?? null,
    async dispose() {
      if (disposed) return
      disposed = true
      await opened?.dispose()
    },
  }
}

function archiveHeaders(resource: PinnedResource, contentLength: number): Readonly<Record<string, string>> {
  return {
    'content-type': 'application/octet-stream',
    'content-length': String(contentLength),
    'accept-ranges': 'bytes',
    etag: resource.etag,
  }
}

function sliceBody(opened: OpenResponseBody, start: number, end: number): OpenResponseBody {
  let claimed = false
  return {
    body: {
      [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
        if (claimed) throw new DevelopmentModuleBundleError('BODY_ALREADY_CONSUMED', 'Development bundle body was already consumed')
        claimed = true
        const source = opened.body[Symbol.asyncIterator]()
        let offset = 0
        return (async function* () {
          try {
            while (true) {
              const next = await source.next()
              if (next.done) return
              const chunkEnd = offset + next.value.byteLength
              if (chunkEnd > start && offset < end) {
                yield next.value.subarray(Math.max(0, start - offset), Math.min(next.value.byteLength, end - offset))
              }
              offset = chunkEnd
            }
          } finally {
            await source.return?.()
          }
        })()
      },
    },
    dispose: () => opened.dispose(),
  }
}

async function readDescriptor(descriptorPath: string, root: string, ownerUid: bigint): Promise<Uint8Array> {
  let handle: FileHandle | undefined
  try {
    const pathInfo = await lstat(descriptorPath, { bigint: true })
    assertSecureFile(pathInfo, ownerUid, 'INSECURE_DESCRIPTOR', 'Descriptor file is not private and owner-controlled')
    if (await realpath(descriptorPath) !== descriptorPath || !isContained(root, descriptorPath)) {
      throw new DevelopmentModuleBundleError('INSECURE_DESCRIPTOR', 'Descriptor file is not canonical and contained')
    }
    handle = await open(descriptorPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    const before = await handle.stat({ bigint: true })
    assertSecureFile(before, ownerUid, 'INSECURE_DESCRIPTOR', 'Descriptor file is not private and owner-controlled')
    if (!sameIdentity(identity(pathInfo), identity(before)) || before.size <= 0n || before.size > BigInt(MAX_DESCRIPTOR_BYTES)) {
      throw new DevelopmentModuleBundleError('INSECURE_DESCRIPTOR', 'Descriptor file identity or size is invalid')
    }
    const bytes = await readExact(handle, Number(before.size), () => {
      throw new DevelopmentModuleBundleError('INSECURE_DESCRIPTOR', 'Descriptor file ended while being read')
    })
    const after = await handle.stat({ bigint: true })
    if (!sameIdentity(identity(before), identity(after))) {
      throw new DevelopmentModuleBundleError('INSECURE_DESCRIPTOR', 'Descriptor file changed while being read')
    }
    return bytes
  } catch (cause) {
    if (cause instanceof DevelopmentModuleBundleError) throw cause
    throw new DevelopmentModuleBundleError('INSECURE_DESCRIPTOR', 'Descriptor file could not be read safely')
  } finally {
    await closeQuietly(handle)
  }
}

function parseDescriptor(bytes: Uint8Array, expectedModuleId: string): ParsedDescriptor {
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    invalidDescriptor('Descriptor must be valid UTF-8 JSON')
  }
  const root = exactRecord(value, [
    'schemaVersion', 'developmentOnly', 'nonPromotable', 'moduleId', 'release', 'install', 'trustedKey', 'resources',
  ], 'Descriptor')
  if (root.schemaVersion !== DEVELOPMENT_MODULE_BUNDLE_SCHEMA_VERSION) invalidDescriptor('Descriptor schemaVersion is unsupported')
  if (root.developmentOnly !== true || root.nonPromotable !== true) {
    invalidDescriptor('Descriptor must be development-only and non-promotable')
  }
  if (root.moduleId !== expectedModuleId) invalidDescriptor('Descriptor module ID does not match the expected module')

  const release = exactRecord(root.release, ['version', 'platform'], 'Release metadata')
  if (typeof release.version !== 'string' || release.version.length > 256 || !VERSION_PATTERN.test(release.version)) {
    invalidDescriptor('Release version is invalid')
  }
  if (release.platform !== 'darwin-arm64') invalidDescriptor('Development bundle platform must be darwin-arm64')

  const install = parseInstallMetadata(root.install)
  const trustedKey = parseTrustedKey(root.trustedKey)
  const resources = exactRecord(root.resources, ['catalog', 'archive'], 'Resources')
  const catalog = parseResource('catalog', resources.catalog)
  const archive = parseResource('archive', resources.archive)
  return {
    moduleId: expectedModuleId,
    version: release.version,
    platform: 'darwin-arm64',
    trustedKey,
    extractedManifestSha256: install.extractedManifestSha256,
    hostVersionRange: install.hostVersionRange,
    catalog,
    archive,
  }
}

function parseInstallMetadata(value: unknown): Pick<ParsedDescriptor, 'extractedManifestSha256' | 'hostVersionRange'> {
  const record = exactRecord(value, ['extractedManifestSha256', 'hostVersionRange'], 'Install metadata')
  if (typeof record.extractedManifestSha256 !== 'string' || !SHA256_PATTERN.test(record.extractedManifestSha256)) {
    invalidDescriptor('Extracted manifest SHA-256 is invalid')
  }
  if (typeof record.hostVersionRange !== 'string' || record.hostVersionRange.length === 0
    || record.hostVersionRange.length > 256 || record.hostVersionRange.trim() !== record.hostVersionRange) {
    invalidDescriptor('Host version range is invalid')
  }
  let hostVersionRange: string | null
  try {
    hostVersionRange = validRange(record.hostVersionRange)
  } catch {
    invalidDescriptor('Host version range is invalid')
  }
  if (!hostVersionRange || hostVersionRange.length > 256) invalidDescriptor('Host version range is invalid')
  return Object.freeze({
    extractedManifestSha256: record.extractedManifestSha256 as ModuleSha256,
    hostVersionRange,
  })
}

function parseTrustedKey(value: unknown): TrustedReleaseKey {
  const record = exactRecord(value, ['developmentOnly', 'keyId', 'publicKey', 'activeFrom', 'activeUntil'], 'Trusted key')
  if (record.developmentOnly !== true) invalidDescriptor('Trusted key must be marked development-only')
  if (typeof record.keyId !== 'string' || !KEY_ID_PATTERN.test(record.keyId)) invalidDescriptor('Trusted key ID is invalid')
  if (typeof record.publicKey !== 'string' || record.publicKey.length !== 44) invalidDescriptor('Trusted public key is invalid')
  const publicKey = Buffer.from(record.publicKey, 'base64')
  if (publicKey.byteLength !== 32 || publicKey.toString('base64') !== record.publicKey) {
    invalidDescriptor('Trusted public key is invalid')
  }
  const activeFrom = canonicalTimestamp(record.activeFrom, 'Trusted key activeFrom is invalid')
  const activeUntil = canonicalTimestamp(record.activeUntil, 'Trusted key activeUntil is invalid')
  const window = Date.parse(activeUntil) - Date.parse(activeFrom)
  if (window <= 0 || window > MAX_DEVELOPMENT_KEY_WINDOW_MS) invalidDescriptor('Trusted key active window is invalid')
  return Object.freeze({
    keyId: record.keyId,
    publicKey: Uint8Array.from(publicKey),
    activeFrom,
    activeUntil,
  })
}

function parseResource(role: ResourceRole, value: unknown): ParsedResource {
  const record = exactRecord(value, ['url', 'path', 'size', 'sha256', 'etag'], `${role} resource`)
  const maximumSize = role === 'catalog' ? MAX_CATALOG_BYTES : MAX_ARCHIVE_BYTES
  if (typeof record.url !== 'string') invalidDescriptor(`${role} URL is invalid`)
  const url = canonicalSyntheticHttpsUrl(record.url, role)
  if (typeof record.path !== 'string' || !safeRelativePath(record.path)) invalidDescriptor(`${role} path is invalid`)
  if (!Number.isSafeInteger(record.size) || (record.size as number) <= 0 || (record.size as number) > maximumSize) {
    invalidDescriptor(`${role} size is invalid`)
  }
  if (typeof record.sha256 !== 'string' || !SHA256_PATTERN.test(record.sha256)) invalidDescriptor(`${role} SHA-256 is invalid`)
  if (typeof record.etag !== 'string'
    || Buffer.byteLength(record.etag, 'utf8') > MAX_ETAG_BYTES
    || !STRONG_ETAG_PATTERN.test(record.etag)) {
    invalidDescriptor(`${role} ETag is invalid`)
  }
  return Object.freeze({
    role,
    url,
    relativePath: record.path,
    size: record.size as number,
    sha256: record.sha256,
    etag: record.etag,
  })
}

function createInstallRequest(
  catalogBytes: Uint8Array,
  catalog: PinnedResource,
  archive: PinnedResource,
  descriptor: ParsedDescriptor,
  trustedKey: TrustedReleaseKey,
): Readonly<ModuleCoordinatorInstallRequest> {
  let envelope: ReturnType<typeof decodeCatalogEnvelope>
  try {
    envelope = decodeCatalogEnvelope(catalogBytes)
  } catch {
    catalogTrustFailed()
  }
  const verified = verifyModuleReleaseCatalog(envelope, {
    trustedKeys: [trustedKey],
    state: { highestSequence: 0 },
    now: Date.now(),
  })
  if (!verified.ok) {
    if (verified.diagnostics.some((diagnostic) => diagnostic.code === 'DUPLICATE_MODULE_VERSION')) releaseDuplicate()
    catalogTrustFailed()
  }

  const releases = verified.catalog.releases.filter((release) => (
    release.manifest.id === descriptor.moduleId && release.manifest.version === descriptor.version
  ))
  if (releases.length === 0) {
    throw new DevelopmentModuleBundleError('RELEASE_MISSING', 'Verified catalog does not contain the requested development release')
  }
  if (releases.length !== 1) releaseDuplicate()
  const release = releases[0]!
  const artifacts = release.manifest.artifacts.filter((artifact) => artifact.platform === descriptor.platform)
  const artifactSizes = release.artifactSizes.filter((item) => item.platform === descriptor.platform)
  if (artifacts.length !== 1 || artifactSizes.length !== 1) releaseMismatch()
  const artifact = artifacts[0]!
  const artifactSize = artifactSizes[0]!.size
  if (artifact.url !== archive.url || artifact.sha256 !== archive.sha256 || artifactSize !== archive.size
    || !new URL(artifact.url).pathname.endsWith('.tar.gz')) {
    releaseMismatch()
  }

  const installRequest: ModuleCoordinatorInstallRequest = Object.freeze({
    catalogUrl: catalog.url,
    descriptor: Object.freeze({
      verified: true,
      manifest: release.manifest,
      artifact,
      extractedManifestSha256: descriptor.extractedManifestSha256,
      format: 'tar.gz',
    }),
    hostVersionRange: descriptor.hostVersionRange,
  })
  return installRequest
}

async function pinResource(
  root: string,
  resource: ParsedResource,
  ownerUid: bigint,
  captureVerifiedBytes = false,
): Promise<PinnedResourceResult> {
  if (captureVerifiedBytes && resource.role !== 'catalog') invalidResource(resource.role, 'cannot be captured as catalog bytes')
  const absolutePath = resolve(root, ...resource.relativePath.split('/'))
  if (!isContained(root, absolutePath)) invalidResource(resource.role, 'path containment failed')
  await validateDirectoryChain(root, resource.relativePath, ownerUid)

  let handle: FileHandle | undefined
  try {
    const pathInfo = await lstat(absolutePath, { bigint: true })
    assertSecureFile(pathInfo, ownerUid, 'INVALID_RESOURCE', `${resource.role} resource is not private and owner-controlled`)
    if (await realpath(absolutePath) !== absolutePath) invalidResource(resource.role, 'path is not canonical')
    handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW)
    const before = await handle.stat({ bigint: true })
    assertSecureFile(before, ownerUid, 'INVALID_RESOURCE', `${resource.role} resource is not private and owner-controlled`)
    const pinned = identity(before)
    if (!sameIdentity(identity(pathInfo), pinned) || before.size !== BigInt(resource.size)) {
      invalidResource(resource.role, 'identity or size does not match the descriptor')
    }
    const verifiedBytes = captureVerifiedBytes
      ? await readExact(handle, resource.size, () => invalidResource(resource.role, 'ended while being verified'))
      : undefined
    const digest = verifiedBytes ? createHash('sha256').update(verifiedBytes).digest('hex') : await hashFile(handle, resource.size)
    const after = await handle.stat({ bigint: true })
    if (!sameIdentity(pinned, identity(after)) || digest !== resource.sha256) {
      invalidResource(resource.role, 'bytes do not match the descriptor')
    }
    return Object.freeze({
      resource: Object.freeze({ ...resource, absolutePath, identity: pinned }),
      ...(verifiedBytes ? { verifiedBytes } : {}),
    })
  } catch (cause) {
    if (cause instanceof DevelopmentModuleBundleError) throw cause
    invalidResource(resource.role, 'could not be opened safely')
  } finally {
    await closeQuietly(handle)
  }
}

async function openVerifiedResource(
  root: string,
  resource: PinnedResource,
  ownerUid: bigint,
  signal: AbortSignal,
): Promise<OpenResponseBody> {
  let handle: FileHandle | undefined
  try {
    assertNotAborted(signal)
    await validateDirectory(root, ownerUid, 'RESOURCE_CHANGED')
    await validateDirectoryChain(root, resource.relativePath, ownerUid, 'RESOURCE_CHANGED')
    const pathInfo = await lstat(resource.absolutePath, { bigint: true })
    assertSecureFile(pathInfo, ownerUid, 'RESOURCE_CHANGED', `${resource.role} resource security changed`)
    if (await realpath(resource.absolutePath) !== resource.absolutePath) resourceChanged(resource.role)
    handle = await open(resource.absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW)
    const before = await handle.stat({ bigint: true })
    assertSecureFile(before, ownerUid, 'RESOURCE_CHANGED', `${resource.role} resource security changed`)
    if (!sameIdentity(resource.identity, identity(pathInfo)) || !sameIdentity(resource.identity, identity(before))) {
      resourceChanged(resource.role)
    }
    const digest = await hashFile(handle, resource.size, signal)
    const after = await handle.stat({ bigint: true })
    if (!sameIdentity(resource.identity, identity(after)) || digest !== resource.sha256) resourceChanged(resource.role)
    assertNotAborted(signal)
    const responseBody = streamOpenFile(handle, resource, signal)
    handle = undefined
    return responseBody
  } catch (cause) {
    await closeQuietly(handle)
    if (cause instanceof DevelopmentModuleBundleError) throw cause
    if (signal.aborted) throw aborted()
    resourceChanged(resource.role)
  }
}

function streamOpenFile(handle: FileHandle, resource: PinnedResource, signal: AbortSignal): OpenResponseBody {
  let claimed = false
  let disposed = false
  let closePromise: Promise<void> | undefined
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      signal.removeEventListener('abort', onAbort)
      try {
        await handle.close()
      } catch {
        throw new DevelopmentModuleBundleError('RESOURCE_CHANGED', `${resource.role} resource could not be closed safely`)
      }
    })()
    return closePromise
  }
  const onAbort = () => { void close().catch(() => undefined) }
  signal.addEventListener('abort', onAbort, { once: true })

  return {
    body: {
      [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
        if (claimed) throw new DevelopmentModuleBundleError('BODY_ALREADY_CONSUMED', 'Development bundle body was already consumed')
        claimed = true
        return (async function* () {
          const digest = createHash('sha256')
          let position = 0
          try {
            while (position < resource.size) {
              if (disposed) throw new DevelopmentModuleBundleError('BODY_DISPOSED', 'Development bundle body was disposed')
              assertNotAborted(signal)
              const length = Math.min(READ_CHUNK_BYTES, resource.size - position)
              const buffer = Buffer.allocUnsafe(length)
              const result = await handle.read(buffer, 0, length, position)
              assertNotAborted(signal)
              if (disposed) throw new DevelopmentModuleBundleError('BODY_DISPOSED', 'Development bundle body was disposed')
              if (result.bytesRead !== length) resourceChanged(resource.role)
              const chunk = Uint8Array.from(buffer.subarray(0, result.bytesRead))
              digest.update(chunk)
              position += result.bytesRead
              yield chunk
            }
            const after = await handle.stat({ bigint: true })
            if (!sameIdentity(resource.identity, identity(after)) || digest.digest('hex') !== resource.sha256) {
              resourceChanged(resource.role)
            }
          } catch (cause) {
            if (cause instanceof DevelopmentModuleBundleError) throw cause
            if (signal.aborted) throw aborted()
            if (disposed) throw new DevelopmentModuleBundleError('BODY_DISPOSED', 'Development bundle body was disposed')
            resourceChanged(resource.role)
          } finally {
            await close()
          }
        })()
      },
    },
    async dispose() {
      if (disposed) return closePromise
      disposed = true
      await close()
    },
  }
}

async function validateDirectoryChain(
  root: string,
  relativePath: string,
  ownerUid: bigint,
  code: 'INVALID_RESOURCE' | 'RESOURCE_CHANGED' = 'INVALID_RESOURCE',
): Promise<void> {
  const segments = relativePath.split('/').slice(0, -1)
  let current = root
  for (const segment of segments) {
    current = resolve(current, segment)
    await validateDirectory(current, ownerUid, code)
  }
}

async function validateDirectory(
  path: string,
  ownerUid: bigint,
  code: 'INSECURE_BUNDLE_ROOT' | 'INVALID_RESOURCE' | 'RESOURCE_CHANGED',
): Promise<void> {
  try {
    const info = await lstat(path, { bigint: true })
    if (!info.isDirectory() || info.uid !== ownerUid || (info.mode & INSECURE_MODE_BITS) !== 0n || await realpath(path) !== path) {
      throw new DevelopmentModuleBundleError(code, 'Development bundle directory is not private and canonical')
    }
  } catch (cause) {
    if (cause instanceof DevelopmentModuleBundleError) throw cause
    throw new DevelopmentModuleBundleError(code, 'Development bundle directory could not be validated safely')
  }
}

function assertSecureFile(
  info: BigIntStats,
  ownerUid: bigint,
  code: 'INSECURE_DESCRIPTOR' | 'INVALID_RESOURCE' | 'RESOURCE_CHANGED',
  message: string,
): void {
  if (!info.isFile() || info.uid !== ownerUid || info.nlink !== 1n || (info.mode & INSECURE_MODE_BITS) !== 0n) {
    throw new DevelopmentModuleBundleError(code, message)
  }
}

async function hashFile(handle: FileHandle, size: number, signal?: AbortSignal): Promise<string> {
  const digest = createHash('sha256')
  let position = 0
  while (position < size) {
    if (signal) assertNotAborted(signal)
    const length = Math.min(READ_CHUNK_BYTES, size - position)
    const buffer = Buffer.allocUnsafe(length)
    const result = await handle.read(buffer, 0, length, position)
    if (signal) assertNotAborted(signal)
    if (result.bytesRead !== length) throw new DevelopmentModuleBundleError('RESOURCE_CHANGED', 'Development bundle resource changed while being verified')
    digest.update(buffer.subarray(0, result.bytesRead))
    position += result.bytesRead
  }
  return digest.digest('hex')
}

async function readExact(handle: FileHandle, size: number, onShortRead: () => never): Promise<Uint8Array> {
  const bytes = Buffer.allocUnsafe(size)
  let position = 0
  while (position < size) {
    const result = await handle.read(bytes, position, size - position, position)
    if (result.bytesRead === 0) onShortRead()
    position += result.bytesRead
  }
  return Uint8Array.from(bytes)
}

function identity(info: BigIntStats): FileIdentity {
  return {
    dev: info.dev,
    ino: info.ino,
    mode: info.mode,
    uid: info.uid,
    nlink: info.nlink,
    size: info.size,
    mtimeNs: info.mtimeNs,
    ctimeNs: info.ctimeNs,
  }
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.uid === right.uid
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
}

function validateAbsoluteCanonicalPath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4_096
    || value.includes('\0') || !isAbsolute(value) || normalize(value) !== value) {
    throw new DevelopmentModuleBundleError('INVALID_DESCRIPTOR_PATH', 'Descriptor path must be absolute and canonical')
  }
  return value
}

function parseExpectedModuleId(value: unknown): string {
  if (typeof value !== 'string' || !MODULE_ID_PATTERN.test(value)) {
    throw new DevelopmentModuleBundleError('INVALID_DESCRIPTOR', 'Expected module ID is invalid')
  }
  return value
}

function canonicalSyntheticHttpsUrl(value: string, role: ResourceRole): string {
  if (Buffer.byteLength(value, 'utf8') > MAX_URL_BYTES) invalidDescriptor(`${role} URL is too long`)
  let url: URL
  try {
    url = new URL(value)
  } catch {
    invalidDescriptor(`${role} URL is invalid`)
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search || url.port
    || url.href !== value || !url.hostname.endsWith('.invalid')
    || !SYNTHETIC_URL_PATH_PATTERN.test(url.pathname) || url.pathname.includes('//')) {
    invalidDescriptor(`${role} URL must be canonical synthetic HTTPS on a .invalid host`)
  }
  return url.href
}

function safeRelativePath(value: string): boolean {
  if (value.length === 0 || value.startsWith('/') || value.includes('\\')
    || Buffer.byteLength(value, 'utf8') > MAX_RELATIVE_PATH_BYTES) return false
  const segments = value.split('/')
  return segments.length <= 32 && segments.every((segment) => RELATIVE_PATH_SEGMENT_PATTERN.test(segment))
}

function exactRecord(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    invalidDescriptor(`${label} must be a plain object`)
  }
  const record = value as Record<string, unknown>
  const actual = Object.keys(record).sort()
  const expected = [...fields].sort()
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    invalidDescriptor(`${label} fields are invalid`)
  }
  return record
}

function canonicalTimestamp(value: unknown, message: string): string {
  if (typeof value !== 'string' || value.length !== 24) invalidDescriptor(message)
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) invalidDescriptor(message)
  return value
}

function parseOpenEndedRange(value: string, size: number): number | undefined {
  const match = /^bytes=(0|[1-9][0-9]*)-$/.exec(value)
  if (!match) return undefined
  const start = Number(match[1])
  return Number.isSafeInteger(start) && start < size ? start : undefined
}

function requestHeader(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  let found: string | undefined
  for (const [candidate, value] of Object.entries(headers)) {
    if (candidate.toLowerCase() !== name) continue
    if (found !== undefined) requestRefused()
    found = value
  }
  return found
}

function isContained(root: string, candidate: string): boolean {
  const nested = relative(root, candidate)
  return nested !== '' && !nested.startsWith('..') && !isAbsolute(nested)
}

function currentOwnerUid(): bigint {
  if (typeof process.getuid !== 'function') {
    throw new DevelopmentModuleBundleError('INSECURE_BUNDLE_ROOT', 'Development bundle loading requires owner identity support')
  }
  return BigInt(process.getuid())
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw aborted()
}

function aborted(): DevelopmentModuleBundleError {
  return new DevelopmentModuleBundleError('ABORTED', 'Development bundle request was aborted')
}

function invalidDescriptor(message: string): never {
  throw new DevelopmentModuleBundleError('INVALID_DESCRIPTOR', message)
}

function invalidResource(role: ResourceRole, detail: string): never {
  throw new DevelopmentModuleBundleError('INVALID_RESOURCE', `${role} resource ${detail}`)
}

function resourceChanged(role: ResourceRole): never {
  throw new DevelopmentModuleBundleError('RESOURCE_CHANGED', `${role} resource no longer matches the loaded development bundle`)
}

function requestRefused(): never {
  throw new DevelopmentModuleBundleError('REQUEST_REFUSED', 'Development bundle request was refused')
}

function catalogTrustFailed(): never {
  throw new DevelopmentModuleBundleError('CATALOG_TRUST_FAILED', 'Development bundle catalog trust verification failed')
}

function releaseDuplicate(): never {
  throw new DevelopmentModuleBundleError('RELEASE_DUPLICATE', 'Verified catalog contains a duplicate development release')
}

function releaseMismatch(): never {
  throw new DevelopmentModuleBundleError('RELEASE_MISMATCH', 'Verified catalog release metadata does not match the development bundle')
}

async function closeQuietly(handle: FileHandle | undefined): Promise<void> {
  if (!handle) return
  try {
    await handle.close()
  } catch {
    // The caller emits a path-free validation error for the primary operation.
  }
}
