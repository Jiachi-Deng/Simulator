import { afterEach, describe, expect, it } from 'bun:test'
import { execFile } from 'node:child_process'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import {
  chmod,
  link,
  mkdtemp,
  open as openFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { ModuleDownloader, type DownloaderResponse } from '@simulator/module-downloader'
import { ManualClock, MemoryModuleDownloaderCache } from '@simulator/module-downloader/testing'
import { encodeCanonicalCatalog } from '@simulator/module-release-trust'
import {
  DEVELOPMENT_MODULE_BUNDLE_SCHEMA_VERSION,
  DevelopmentModuleBundleError,
  loadDevelopmentModuleBundle,
  type LoadedDevelopmentModuleBundle,
} from '../development-module-bundle.ts'

const NOW = Date.now()
const HOUR_MS = 60 * 60 * 1_000
const ISSUED_AT = new Date(NOW - HOUR_MS).toISOString()
const EXPIRES_AT = new Date(NOW + 20 * HOUR_MS).toISOString()
const KEY_ACTIVE_FROM = new Date(NOW - 24 * HOUR_MS).toISOString()
const KEY_ACTIVE_UNTIL = new Date(NOW + 7 * 24 * HOUR_MS).toISOString()
const MODULE_ID = 'org.simulator.open-design'
const CATALOG_URL = 'https://open-design.development.invalid/catalog/catalog-v1.json'
const ARCHIVE_URL = 'https://open-design.development.invalid/releases/open-design-1.0.0-darwin-arm64.tar.gz'
const CATALOG_ETAG = '"catalog-v1"'
const ARCHIVE_ETAG = '"archive-v1"'
const EXTRACTED_MANIFEST_SHA256 = 'e'.repeat(64)
const HOST_VERSION_RANGE = '>=0.11.0 <1.0.0'
const execFileAsync = promisify(execFile)

interface ResourceDescriptorFixture {
  url: string
  path: string
  size: number
  sha256: string
  etag: string
}

interface BundleDescriptorFixture {
  schemaVersion: number
  developmentOnly: boolean
  nonPromotable: boolean
  moduleId: string
  release: { version: string; platform: string }
  install: { extractedManifestSha256: string; hostVersionRange: string }
  trustedKey: {
    developmentOnly: boolean
    keyId: string
    publicKey: string
    activeFrom: string
    activeUntil: string
  }
  resources: {
    catalog: ResourceDescriptorFixture
    archive: ResourceDescriptorFixture
  }
}

interface CatalogFixture {
  schemaVersion: number
  sequence: number
  issuedAt: string
  expiresAt: string
  releases: Array<{
    manifest: {
      schemaVersion: number
      id: string
      version: string
      artifacts: Array<{
        platform: string
        entrypoint: string
        url: string
        sha256: string
      }>
      capabilities: string[]
    }
    artifactSizes: Array<{ platform: string; size: number }>
  }>
}

interface BundleFixture {
  root: string
  descriptorPath: string
  catalogPath: string
  archivePath: string
  catalogBytes: Uint8Array
  archiveBytes: Uint8Array
  descriptor: BundleDescriptorFixture
}

const cleanupRoots: string[] = []

afterEach(async () => {
  await Promise.all(cleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(
  mutate?: (descriptor: BundleDescriptorFixture) => void,
  mutateCatalog?: (catalog: CatalogFixture) => void,
): Promise<BundleFixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'simulator-development-module-bundle-')))
  cleanupRoots.push(root)
  await chmod(root, 0o700)

  const pair = generateKeyPairSync('ed25519')
  const publicDer = pair.publicKey.export({ format: 'der', type: 'spki' })
  const publicKey = Buffer.from(publicDer.subarray(publicDer.byteLength - 32))
  const archiveBytes = Uint8Array.from({ length: 160_000 }, (_, index) => (index * 31) % 251)
  const archiveSha256 = sha256(archiveBytes)
  const catalog: CatalogFixture = {
    schemaVersion: 1,
    sequence: 1,
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
    releases: [{
      manifest: {
        schemaVersion: 1,
        id: MODULE_ID,
        version: '1.0.0',
        artifacts: [{
          platform: 'darwin-arm64',
          entrypoint: 'bin/open-design',
          url: ARCHIVE_URL,
          sha256: archiveSha256,
        }],
        capabilities: ['artifact.read'],
      },
      artifactSizes: [{ platform: 'darwin-arm64', size: archiveBytes.byteLength }],
    }],
  }
  mutateCatalog?.(catalog)
  const canonicalCatalog = encodeCanonicalCatalog(catalog)
  const catalogBytes = new TextEncoder().encode(JSON.stringify({
    schemaVersion: 1,
    keyId: 'development-open-design-v1',
    catalogBytes: Buffer.from(canonicalCatalog).toString('base64'),
    signature: Buffer.from(sign(null, canonicalCatalog, pair.privateKey)).toString('base64'),
  }))
  const descriptor: BundleDescriptorFixture = {
    schemaVersion: 2,
    developmentOnly: true,
    nonPromotable: true,
    moduleId: MODULE_ID,
    release: { version: '1.0.0', platform: 'darwin-arm64' },
    install: {
      extractedManifestSha256: EXTRACTED_MANIFEST_SHA256,
      hostVersionRange: HOST_VERSION_RANGE,
    },
    trustedKey: {
      developmentOnly: true,
      keyId: 'development-open-design-v1',
      publicKey: publicKey.toString('base64'),
      activeFrom: KEY_ACTIVE_FROM,
      activeUntil: KEY_ACTIVE_UNTIL,
    },
    resources: {
      catalog: {
        url: CATALOG_URL,
        path: 'catalog-v1.json',
        size: catalogBytes.byteLength,
        sha256: sha256(catalogBytes),
        etag: CATALOG_ETAG,
      },
      archive: {
        url: ARCHIVE_URL,
        path: 'open-design-1.0.0.tar.gz',
        size: archiveBytes.byteLength,
        sha256: archiveSha256,
        etag: ARCHIVE_ETAG,
      },
    },
  }
  mutate?.(descriptor)

  const descriptorPath = join(root, 'development-module-bundle.json')
  const catalogPath = join(root, 'catalog-v1.json')
  const archivePath = join(root, 'open-design-1.0.0.tar.gz')
  await secureWrite(catalogPath, catalogBytes)
  await secureWrite(archivePath, archiveBytes)
  await secureWrite(descriptorPath, JSON.stringify(descriptor))
  return { root, descriptorPath, catalogPath, archivePath, catalogBytes, archiveBytes, descriptor }
}

async function secureWrite(path: string, bytes: string | Uint8Array): Promise<void> {
  await writeFile(path, bytes, { mode: 0o600 })
  await chmod(path, 0o600)
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function request(
  loaded: LoadedDevelopmentModuleBundle,
  url: string,
  headers: Readonly<Record<string, string>> = {},
  signal = new AbortController().signal,
) {
  return loaded.fetchAdapter.fetch({ url, headers, signal, redirect: 'manual' })
}

async function readBody(response: DownloaderResponse): Promise<Uint8Array> {
  if (!response.body) throw new Error('Expected response body')
  const chunks: Uint8Array[] = []
  for await (const chunk of response.body) chunks.push(chunk)
  return Uint8Array.from(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))))
}

async function load(input: BundleFixture): Promise<LoadedDevelopmentModuleBundle> {
  return loadDevelopmentModuleBundle({ descriptorPath: input.descriptorPath, expectedModuleId: MODULE_ID })
}

describe('development module bundle fetch adapter', () => {
  it('loads a private bundle and serves exact catalog responses with one-shot bodies and idempotent disposal', async () => {
    const input = await fixture()
    const loaded = await load(input)

    expect(DEVELOPMENT_MODULE_BUNDLE_SCHEMA_VERSION).toBe(2)
    expect(loaded.catalogUrl).toBe(CATALOG_URL)
    expect(loaded.release).toEqual({
      developmentOnly: true,
      nonPromotable: true,
      moduleId: MODULE_ID,
      version: '1.0.0',
      platform: 'darwin-arm64',
      archiveUrl: ARCHIVE_URL,
      archiveSha256: sha256(input.archiveBytes),
      archiveSize: input.archiveBytes.byteLength,
    })
    expect(loaded.trustedKeys).toHaveLength(1)
    expect(loaded.trustedKeys[0]).toMatchObject({
      keyId: 'development-open-design-v1',
      activeFrom: KEY_ACTIVE_FROM,
      activeUntil: KEY_ACTIVE_UNTIL,
    })
    expect(loaded.installRequest as unknown).toEqual({
      catalogUrl: CATALOG_URL,
      descriptor: {
        verified: true,
        manifest: {
          schemaVersion: 1,
          id: MODULE_ID,
          version: '1.0.0',
          artifacts: [{
            platform: 'darwin-arm64',
            entrypoint: 'bin/open-design',
            url: ARCHIVE_URL,
            sha256: sha256(input.archiveBytes),
          }],
          capabilities: ['artifact.read'],
        },
        artifact: {
          platform: 'darwin-arm64',
          entrypoint: 'bin/open-design',
          url: ARCHIVE_URL,
          sha256: sha256(input.archiveBytes),
        },
        extractedManifestSha256: EXTRACTED_MANIFEST_SHA256,
        format: 'tar.gz',
      },
      hostVersionRange: HOST_VERSION_RANGE,
    })
    expect(Object.isFrozen(loaded.installRequest)).toBe(true)
    expect(Object.isFrozen(loaded.installRequest.descriptor)).toBe(true)
    expect(Object.isFrozen(loaded.installRequest.descriptor.manifest)).toBe(true)

    const response = await request(loaded, CATALOG_URL)
    expect(response.status).toBe(200)
    expect(response.url).toBe(CATALOG_URL)
    expect(response.headers.get('content-length')).toBe(String(input.catalogBytes.byteLength))
    expect(response.headers.get('content-type')).toBe('application/vnd.simulator.module-catalog+json')
    expect(response.headers.get('etag')).toBe(CATALOG_ETAG)
    expect(await readBody(response)).toEqual(input.catalogBytes)
    expect(() => response.body?.[Symbol.asyncIterator]()).toThrow(DevelopmentModuleBundleError)
    await response.dispose()
    await response.dispose()

    const notModified = await request(loaded, CATALOG_URL, { 'If-None-Match': CATALOG_ETAG })
    expect(notModified.status).toBe(304)
    expect(notModified.url).toBe(CATALOG_URL)
    expect(notModified.headers.get('etag')).toBe(CATALOG_ETAG)
    expect(notModified.headers.get('content-length')).toBeNull()
    expect(notModified.body).toBeNull()
    await notModified.dispose()
    await notModified.dispose()
  })

  it('serves full archives, safe open-ended ranges, mismatch fallback, and explicit malformed-range failure', async () => {
    const input = await fixture()
    const loaded = await load(input)

    const full = await request(loaded, ARCHIVE_URL)
    expect(full.status).toBe(200)
    expect(full.headers.get('accept-ranges')).toBe('bytes')
    expect(full.headers.get('content-length')).toBe(String(input.archiveBytes.byteLength))
    expect(full.headers.get('etag')).toBe(ARCHIVE_ETAG)
    expect(await readBody(full)).toEqual(input.archiveBytes)
    await full.dispose()

    const start = 70_000
    const partial = await request(loaded, ARCHIVE_URL, { range: `bytes=${start}-`, 'if-range': ARCHIVE_ETAG })
    expect(partial.status).toBe(206)
    expect(partial.url).toBe(ARCHIVE_URL)
    expect(partial.headers.get('content-range')).toBe(`bytes ${start}-${input.archiveBytes.byteLength - 1}/${input.archiveBytes.byteLength}`)
    expect(partial.headers.get('content-length')).toBe(String(input.archiveBytes.byteLength - start))
    expect(await readBody(partial)).toEqual(input.archiveBytes.subarray(start))
    await partial.dispose()

    const validatorMismatch = await request(loaded, ARCHIVE_URL, { range: 'bytes=70000-', 'if-range': '"stale"' })
    expect(validatorMismatch.status).toBe(200)
    expect(validatorMismatch.headers.get('content-range')).toBeNull()
    expect(await readBody(validatorMismatch)).toEqual(input.archiveBytes)
    await validatorMismatch.dispose()

    for (const range of ['bytes=1-2', 'bytes=-5', 'bytes=999999-', 'bytes=01-']) {
      const invalid = await request(loaded, ARCHIVE_URL, { range, 'if-range': ARCHIVE_ETAG })
      expect(invalid.status).toBe(416)
      expect(invalid.headers.get('content-range')).toBe(`bytes */${input.archiveBytes.byteLength}`)
      expect(invalid.headers.get('content-length')).toBe('0')
      expect(invalid.body).toBeNull()
      await invalid.dispose()
    }
  })

  it('refuses unknown URLs, catalog ranges, and non-manual redirect requests', async () => {
    const input = await fixture()
    const loaded = await load(input)

    await expect(request(loaded, 'https://open-design.development.invalid/unknown'))
      .rejects.toMatchObject({ code: 'REQUEST_REFUSED' })
    await expect(request(loaded, CATALOG_URL, { range: 'bytes=0-' }))
      .rejects.toMatchObject({ code: 'REQUEST_REFUSED' })
    await expect(loaded.fetchAdapter.fetch({
      url: CATALOG_URL,
      headers: {},
      signal: new AbortController().signal,
      redirect: 'follow' as 'manual',
    })).rejects.toMatchObject({ code: 'REQUEST_REFUSED' })
  })
})

describe('ModuleDownloader integration', () => {
  it('keeps Ed25519 verification, 304 cache revalidation, hash/size checks, and Range resume in the real downloader path', async () => {
    const input = await fixture()
    const loaded = await load(input)
    const clock = new ManualClock(NOW)
    const cache = new MemoryModuleDownloaderCache()
    const downloader = new ModuleDownloader({
      fetch: loaded.fetchAdapter,
      cache,
      clock,
      trustedKeys: loaded.trustedKeys,
      retry: { maxAttempts: 1 },
    })

    const firstCatalog = await downloader.fetchCatalog(loaded.catalogUrl)
    const secondCatalog = await downloader.fetchCatalog(loaded.catalogUrl)
    expect(firstCatalog.source).toBe('network')
    expect(secondCatalog.source).toBe('revalidated-cache')
    expect(String(firstCatalog.catalog.releases[0]?.manifest.id)).toBe(MODULE_ID)
    const artifact = firstCatalog.catalog.releases[0]?.manifest.artifacts[0]
    const expectedSize = firstCatalog.catalog.releases[0]?.artifactSizes[0]?.size
    if (!artifact || !expectedSize) throw new Error('Signed fixture release is incomplete')

    const downloaded = await downloader.downloadArtifact({ artifact, expectedSize })
    expect(downloaded.source).toBe('network')
    expect(downloaded.artifact).toMatchObject({ sha256: sha256(input.archiveBytes), size: input.archiveBytes.byteLength })
    expect(cache.artifacts.get(artifact.sha256)?.size).toBe(input.archiveBytes.byteLength)

    const resumeCache = new MemoryModuleDownloaderCache()
    const resumeDownloader = new ModuleDownloader({
      fetch: loaded.fetchAdapter,
      cache: resumeCache,
      clock: new ManualClock(NOW),
      trustedKeys: loaded.trustedKeys,
      retry: { maxAttempts: 1 },
    })
    await resumeDownloader.fetchCatalog(loaded.catalogUrl)
    const prefixSize = 70_000
    const partial = await resumeCache.createPartial({
      sha256: artifact.sha256,
      sourceUrl: artifact.url,
      expectedSize,
      updatedAt: NOW,
    })
    await resumeCache.appendPartial(partial.id, input.archiveBytes.subarray(0, prefixSize), NOW, ARCHIVE_ETAG)
    const resumed = await resumeDownloader.downloadArtifact({ artifact, expectedSize })
    expect(resumed.source).toBe('network')
    expect(resumed.artifact).toMatchObject({ sha256: artifact.sha256, size: expectedSize })
    expect(resumeCache.partials).toHaveLength(0)

    const staleCache = new MemoryModuleDownloaderCache()
    const staleDownloader = new ModuleDownloader({
      fetch: loaded.fetchAdapter,
      cache: staleCache,
      clock: new ManualClock(NOW),
      trustedKeys: loaded.trustedKeys,
      retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
    })
    await staleDownloader.fetchCatalog(loaded.catalogUrl)
    const stalePartial = await staleCache.createPartial({
      sha256: artifact.sha256,
      sourceUrl: artifact.url,
      expectedSize,
      updatedAt: NOW,
    })
    await staleCache.appendPartial(stalePartial.id, input.archiveBytes.subarray(0, prefixSize), NOW, '"stale"')
    const restarted = await staleDownloader.downloadArtifact({ artifact, expectedSize })
    expect(restarted.source).toBe('network')
    expect(restarted.artifact).toMatchObject({ sha256: artifact.sha256, size: expectedSize })
    expect(staleCache.partials).toHaveLength(0)
  })

  it('rejects a different valid Ed25519 key before exposing downloader inputs', async () => {
    const otherPair = generateKeyPairSync('ed25519')
    const otherDer = otherPair.publicKey.export({ format: 'der', type: 'spki' })
    const input = await fixture((descriptor) => {
      descriptor.trustedKey.publicKey = Buffer.from(otherDer.subarray(otherDer.byteLength - 32)).toString('base64')
    })
    await expect(load(input)).rejects.toMatchObject({ code: 'CATALOG_TRUST_FAILED' })
  })
})

describe('verified install request derivation', () => {
  it('normalizes a valid host version range for coordinator and registry persistence', async () => {
    const input = await fixture((descriptor) => { descriptor.install.hostVersionRange = '^0.11.0' })
    expect((await load(input)).installRequest.hostVersionRange).toBe('>=0.11.0 <0.12.0-0')
  })

  it('rejects catalog signature tampering even when the owner descriptor hash matches the tampered envelope', async () => {
    const input = await fixture()
    const wire = JSON.parse(new TextDecoder().decode(input.catalogBytes)) as { signature: string }
    const signature = Buffer.from(wire.signature, 'base64')
    signature[0] = signature[0]! ^ 0xff
    wire.signature = signature.toString('base64')
    const tamperedBytes = new TextEncoder().encode(JSON.stringify(wire))
    input.descriptor.resources.catalog.size = tamperedBytes.byteLength
    input.descriptor.resources.catalog.sha256 = sha256(tamperedBytes)
    await secureWrite(input.catalogPath, tamperedBytes)
    await secureWrite(input.descriptorPath, JSON.stringify(input.descriptor))

    try {
      await load(input)
      throw new Error('Expected catalog trust failure')
    } catch (cause) {
      expect(cause).toMatchObject({ code: 'CATALOG_TRUST_FAILED' })
      expect(String((cause as Error).message)).not.toContain(input.root)
      expect((cause as Error & { cause?: unknown }).cause).toBeUndefined()
    }
  })

  it('rejects missing and duplicate moduleId+version releases', async () => {
    const missing = await fixture(undefined, (catalog) => {
      catalog.releases[0]!.manifest.version = '2.0.0'
    })
    await expect(load(missing)).rejects.toMatchObject({ code: 'RELEASE_MISSING' })

    const duplicate = await fixture(undefined, (catalog) => {
      catalog.releases.push(structuredClone(catalog.releases[0]!))
    })
    await expect(load(duplicate)).rejects.toMatchObject({ code: 'RELEASE_DUPLICATE' })
  })

  it('rejects catalog archive URL, SHA-256, size, and platform metadata mismatches', async () => {
    const mutations: Array<(catalog: CatalogFixture) => void> = [
      (catalog) => { catalog.releases[0]!.manifest.artifacts[0]!.url = 'https://open-design.development.invalid/releases/other.tar.gz' },
      (catalog) => { catalog.releases[0]!.manifest.artifacts[0]!.sha256 = 'f'.repeat(64) },
      (catalog) => { catalog.releases[0]!.artifactSizes[0]!.size -= 1 },
      (catalog) => {
        catalog.releases[0]!.manifest.artifacts[0]!.platform = 'darwin-x64'
        catalog.releases[0]!.artifactSizes[0]!.platform = 'darwin-x64'
      },
    ]
    for (const mutateCatalog of mutations) {
      const input = await fixture(undefined, mutateCatalog)
      await expect(load(input)).rejects.toMatchObject({ code: 'RELEASE_MISMATCH' })
    }
  })
})

describe('descriptor and filesystem policy', () => {
  it('rejects unsupported schema, wrong module, invalid keys, extra resources, and unsafe paths', async () => {
    const cases: Array<(descriptor: BundleDescriptorFixture) => void> = [
      (descriptor) => { descriptor.schemaVersion = 1 },
      (descriptor) => { delete (descriptor as Partial<BundleDescriptorFixture>).install },
      (descriptor) => { descriptor.moduleId = 'org.simulator.wrong-module' },
      (descriptor) => { descriptor.developmentOnly = false },
      (descriptor) => { descriptor.nonPromotable = false },
      (descriptor) => { descriptor.trustedKey.developmentOnly = false },
      (descriptor) => { descriptor.trustedKey.publicKey = 'not-canonical-base64' },
      (descriptor) => { descriptor.trustedKey.activeUntil = descriptor.trustedKey.activeFrom },
      (descriptor) => { descriptor.trustedKey.activeUntil = new Date(NOW + 32 * 24 * HOUR_MS).toISOString() },
      (descriptor) => { descriptor.install.extractedManifestSha256 = 'not-a-sha256' },
      (descriptor) => { descriptor.install.hostVersionRange = 'not a semver range' },
      (descriptor) => { descriptor.install.hostVersionRange = '' },
      (descriptor) => { descriptor.resources.archive.path = '../outside.tar.gz' },
      (descriptor) => { descriptor.resources.archive.path = descriptor.resources.catalog.path },
      (descriptor) => {
        (descriptor.resources as BundleDescriptorFixture['resources'] & Record<string, unknown>).extra = { url: ARCHIVE_URL }
      },
    ]

    for (const mutate of cases) {
      const input = await fixture(mutate)
      await expect(load(input)).rejects.toBeInstanceOf(DevelopmentModuleBundleError)
    }

    const valid = await fixture()
    await expect(loadDevelopmentModuleBundle({ descriptorPath: valid.descriptorPath, expectedModuleId: 'not-a-module-id' }))
      .rejects.toMatchObject({ code: 'INVALID_DESCRIPTOR' })
    await expect(loadDevelopmentModuleBundle({ descriptorPath: 'development-module-bundle.json', expectedModuleId: MODULE_ID }))
      .rejects.toMatchObject({ code: 'INVALID_DESCRIPTOR_PATH' })
  })

  it('rejects file, HTTP, non-.invalid, non-canonical, cross-origin, and duplicate resource URLs', async () => {
    const cases: Array<(descriptor: BundleDescriptorFixture) => void> = [
      (descriptor) => { descriptor.resources.catalog.url = 'file:///catalog-v1.json' },
      (descriptor) => { descriptor.resources.catalog.url = 'http://open-design.development.invalid/catalog-v1.json' },
      (descriptor) => { descriptor.resources.catalog.url = 'https://example.com/catalog-v1.json' },
      (descriptor) => { descriptor.resources.catalog.url = 'https://OPEN-DESIGN.DEVELOPMENT.INVALID/catalog-v1.json' },
      (descriptor) => { descriptor.resources.catalog.url = 'https://catalog.development.invalid/catalog-v1.json' },
      (descriptor) => { descriptor.resources.catalog.url = ARCHIVE_URL },
    ]
    for (const mutate of cases) {
      const input = await fixture(mutate)
      await expect(load(input)).rejects.toMatchObject({ code: 'INVALID_DESCRIPTOR' })
    }
  })

  it('prevalidates exact size and SHA-256 and detects post-load tampering without leaking local paths', async () => {
    const wrongSize = await fixture((descriptor) => { descriptor.resources.archive.size -= 1 })
    await expect(load(wrongSize)).rejects.toMatchObject({ code: 'INVALID_RESOURCE' })

    const wrongHash = await fixture((descriptor) => { descriptor.resources.archive.sha256 = '0'.repeat(64) })
    await expect(load(wrongHash)).rejects.toMatchObject({ code: 'INVALID_RESOURCE' })

    const preTampered = await fixture()
    await secureWrite(preTampered.archivePath, Uint8Array.from(preTampered.archiveBytes, (value, index) => index === 0 ? value ^ 0xff : value))
    await expect(load(preTampered)).rejects.toMatchObject({ code: 'INVALID_RESOURCE' })

    const input = await fixture()
    const loaded = await load(input)
    await secureWrite(input.archivePath, Uint8Array.from(input.archiveBytes, (value, index) => index === 1 ? value ^ 0xff : value))
    try {
      await request(loaded, ARCHIVE_URL)
      throw new Error('Expected tampered resource to fail')
    } catch (cause) {
      expect(cause).toMatchObject({ code: 'RESOURCE_CHANGED' })
      expect(String((cause as Error).message)).not.toContain(input.root)
      expect((cause as Error & { cause?: unknown }).cause).toBeUndefined()
    }
  })

  it('rejects symlinks, hardlinks, and group/other-accessible roots, descriptors, and resources', async () => {
    const descriptorSymlink = await fixture()
    const descriptorTarget = join(descriptorSymlink.root, 'descriptor-target.json')
    await rename(descriptorSymlink.descriptorPath, descriptorTarget)
    await symlink('descriptor-target.json', descriptorSymlink.descriptorPath)
    await expect(load(descriptorSymlink)).rejects.toMatchObject({ code: 'INSECURE_DESCRIPTOR' })

    const symlinked = await fixture()
    const targetPath = join(symlinked.root, 'target.tar.gz')
    await secureWrite(targetPath, symlinked.archiveBytes)
    await rm(symlinked.archivePath)
    await symlink('target.tar.gz', symlinked.archivePath)
    await expect(load(symlinked)).rejects.toMatchObject({ code: 'INVALID_RESOURCE' })

    const hardlinked = await fixture()
    await link(hardlinked.archivePath, join(hardlinked.root, 'archive-alias.tar.gz'))
    await expect(load(hardlinked)).rejects.toMatchObject({ code: 'INVALID_RESOURCE' })

    const openRoot = await fixture()
    await chmod(openRoot.root, 0o755)
    await expect(load(openRoot)).rejects.toMatchObject({ code: 'INSECURE_BUNDLE_ROOT' })

    const openDescriptor = await fixture()
    await chmod(openDescriptor.descriptorPath, 0o644)
    await expect(load(openDescriptor)).rejects.toMatchObject({ code: 'INSECURE_DESCRIPTOR' })

    const openResource = await fixture()
    await chmod(openResource.archivePath, 0o644)
    await expect(load(openResource)).rejects.toMatchObject({ code: 'INVALID_RESOURCE' })

    const specialMode = await fixture()
    await execFileAsync('/bin/chmod', ['4600', specialMode.archivePath])
    await expect(load(specialMode)).rejects.toMatchObject({ code: 'INVALID_RESOURCE' })
  })
})

describe('abort, disposal, and TOCTOU handling', () => {
  it('honors pre-abort and mid-body abort, supports cancellation, and makes dispose idempotent', async () => {
    const input = await fixture()
    const loaded = await load(input)
    const preAborted = new AbortController()
    preAborted.abort('test-abort')
    await expect(request(loaded, ARCHIVE_URL, {}, preAborted.signal)).rejects.toMatchObject({ code: 'ABORTED' })

    const controller = new AbortController()
    const abortedResponse = await request(loaded, ARCHIVE_URL, {}, controller.signal)
    const abortedIterator = abortedResponse.body?.[Symbol.asyncIterator]()
    if (!abortedIterator) throw new Error('Expected archive body')
    expect((await abortedIterator.next()).done).toBe(false)
    controller.abort('test-abort')
    await expect(abortedIterator.next()).rejects.toMatchObject({ code: 'ABORTED' })
    await abortedResponse.dispose()
    await abortedResponse.dispose()

    const disposedResponse = await request(loaded, ARCHIVE_URL)
    await disposedResponse.dispose()
    await disposedResponse.dispose()
    const disposedIterator = disposedResponse.body?.[Symbol.asyncIterator]()
    if (!disposedIterator) throw new Error('Expected archive body')
    await expect(disposedIterator.next()).rejects.toMatchObject({ code: 'BODY_DISPOSED' })

    const cancelledResponse = await request(loaded, ARCHIVE_URL)
    const cancelledIterator = cancelledResponse.body?.[Symbol.asyncIterator]()
    if (!cancelledIterator) throw new Error('Expected archive body')
    expect((await cancelledIterator.next()).done).toBe(false)
    await cancelledIterator.return?.()
    await cancelledResponse.dispose()
    await cancelledResponse.dispose()
  })

  it('rejects inode replacement, post-load mode changes, and in-place mutation during streaming', async () => {
    const replaced = await fixture()
    const replacedLoaded = await load(replaced)
    const replacementPath = join(replaced.root, 'replacement.tar.gz')
    await secureWrite(replacementPath, replaced.archiveBytes)
    await rename(replacementPath, replaced.archivePath)
    await expect(request(replacedLoaded, ARCHIVE_URL)).rejects.toMatchObject({ code: 'RESOURCE_CHANGED' })

    const modeChanged = await fixture()
    const modeLoaded = await load(modeChanged)
    await chmod(modeChanged.archivePath, 0o644)
    await expect(request(modeLoaded, ARCHIVE_URL)).rejects.toMatchObject({ code: 'RESOURCE_CHANGED' })

    const mutating = await fixture()
    const mutatingLoaded = await load(mutating)
    const response = await request(mutatingLoaded, ARCHIVE_URL)
    const iterator = response.body?.[Symbol.asyncIterator]()
    if (!iterator) throw new Error('Expected archive body')
    expect((await iterator.next()).done).toBe(false)
    const writer = await openFile(mutating.archivePath, 'r+')
    try {
      await writer.write(Uint8Array.of(mutating.archiveBytes[80_000]! ^ 0xff), 0, 1, 80_000)
    } finally {
      await writer.close()
    }
    await expect((async () => {
      while (!(await iterator.next()).done) {
        // Drain until the final identity/hash recheck fails.
      }
    })()).rejects.toMatchObject({ code: 'RESOURCE_CHANGED' })
    await response.dispose()
    await response.dispose()
  })
})
