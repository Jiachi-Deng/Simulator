import { describe, expect, it } from 'bun:test'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { parseModuleManifest, type ModuleArtifact } from '@simulator/module-contract'
import {
  encodeCanonicalCatalog,
  type ModuleReleaseEnvelopeV1,
  type TrustedReleaseKey,
} from '@simulator/module-release-trust'
import { ModuleDownloader } from './downloader.ts'
import { ModuleDownloaderError } from './types.ts'
import {
  ManualClock,
  MemoryHeaders,
  MemoryModuleDownloaderCache,
  QueueFetchAdapter,
  memoryResponse,
} from './testing/index.ts'

const NOW = Date.parse('2026-07-12T18:00:00.000Z')
const CATALOG_URL = 'https://modules.example.test/catalog.json'
const ARTIFACT_URL = 'https://modules.example.test/example.tar.gz'

function fixture() {
  const pair = generateKeyPairSync('ed25519')
  const publicDer = pair.publicKey.export({ format: 'der', type: 'spki' })
  const trustedKey: TrustedReleaseKey = {
    keyId: 'release-test',
    publicKey: Uint8Array.from(publicDer.subarray(publicDer.byteLength - 32)),
    activeFrom: '2026-07-12T00:00:00.000Z',
  }
  const artifactBytes = new TextEncoder().encode('abcdef')
  const sha256 = createHash('sha256').update(artifactBytes).digest('hex')
  const catalog = {
    schemaVersion: 1,
    sequence: 1,
    issuedAt: '2026-07-12T17:00:00.000Z',
    expiresAt: '2026-07-13T17:00:00.000Z',
    releases: [{
      manifest: {
        schemaVersion: 1,
        id: 'org.simulator.example',
        version: '1.0.0',
        artifacts: [{ platform: 'darwin-arm64', entrypoint: 'bin/example', url: ARTIFACT_URL, sha256 }],
        capabilities: ['artifact.read'],
      },
      artifactSizes: [{ platform: 'darwin-arm64', size: artifactBytes.byteLength }],
    }],
  }
  const catalogBytes = encodeCanonicalCatalog(catalog)
  const envelope: ModuleReleaseEnvelopeV1 = {
    schemaVersion: 1,
    keyId: trustedKey.keyId,
    catalogBytes,
    signature: Uint8Array.from(sign(null, catalogBytes, pair.privateKey)),
  }
  const wireBytes = new TextEncoder().encode(JSON.stringify({
    schemaVersion: 1,
    keyId: envelope.keyId,
    catalogBytes: Buffer.from(envelope.catalogBytes).toString('base64'),
    signature: Buffer.from(envelope.signature).toString('base64'),
  }))
  const parsed = parseModuleManifest(catalog.releases[0]!.manifest)
  if (!parsed.ok) throw new Error('Fixture manifest failed validation')
  return { trustedKey, artifactBytes, artifact: parsed.value.artifacts[0]!, wireBytes }
}

function downloader(
  fetch: QueueFetchAdapter,
  cache: MemoryModuleDownloaderCache,
  trustedKey: TrustedReleaseKey,
  clock = new ManualClock(NOW),
) {
  return new ModuleDownloader({
    fetch,
    cache,
    clock,
    trustedKeys: [trustedKey],
    retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 4 },
  })
}

describe('verified catalog download', () => {
  it('caches exact response bytes and accepts 304 only through reverified unexpired cache', async () => {
    const data = fixture()
    const cache = new MemoryModuleDownloaderCache()
    const fetch = new QueueFetchAdapter([
      memoryResponse({
        url: CATALOG_URL,
        headers: { etag: '"catalog-v1"', 'content-length': String(data.wireBytes.byteLength) },
        chunks: [data.wireBytes.subarray(0, 17), data.wireBytes.subarray(17)],
      }),
      memoryResponse({ status: 304, url: CATALOG_URL }),
    ])
    const client = downloader(fetch, cache, data.trustedKey)

    const first = await client.fetchCatalog(CATALOG_URL)
    const second = await client.fetchCatalog(CATALOG_URL)

    expect(first.source).toBe('network')
    expect(second.source).toBe('revalidated-cache')
    expect(cache.catalog?.responseBytes).toEqual(data.wireBytes)
    expect(fetch.requests[1]?.headers['if-none-match']).toBe('"catalog-v1"')
  })

  it('serializes concurrent catalog refreshes so trust state cannot publish out of order', async () => {
    const data = fixture()
    const cache = new MemoryModuleDownloaderCache()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const fetch = new QueueFetchAdapter([
      async () => { await gate; return memoryResponse({ url: CATALOG_URL, headers: { etag: '"catalog-v1"' }, chunks: [data.wireBytes] }) },
      memoryResponse({ status: 304, url: CATALOG_URL }),
    ])
    const client = downloader(fetch, cache, data.trustedKey)
    const first = client.fetchCatalog(CATALOG_URL)
    const second = client.fetchCatalog(CATALOG_URL)
    while (fetch.requests.length === 0) await Promise.resolve()
    expect(fetch.requests).toHaveLength(1)
    release()
    expect((await first).source).toBe('network')
    expect((await second).source).toBe('revalidated-cache')
    expect(fetch.requests).toHaveLength(2)
  })

  it('rejects 304 after cached catalog expiry', async () => {
    const data = fixture()
    const cache = new MemoryModuleDownloaderCache()
    const clock = new ManualClock(NOW)
    const first = downloader(new QueueFetchAdapter([
      memoryResponse({ url: CATALOG_URL, chunks: [data.wireBytes] }),
    ]), cache, data.trustedKey, clock)
    await first.fetchCatalog(CATALOG_URL)
    clock.value = Date.parse('2026-07-13T17:00:00.000Z')
    const second = downloader(new QueueFetchAdapter([
      memoryResponse({ status: 304, url: CATALOG_URL }),
    ]), cache, data.trustedKey, clock)
    await expect(second.fetchCatalog(CATALOG_URL)).rejects.toMatchObject({ code: 'CACHE_MISS' })
  })

  it('recovers a fully staged catalog after publish crashes without splitting trust state', async () => {
    const data = fixture()
    const cache = new MemoryModuleDownloaderCache()
    cache.failNext('publishCatalog')
    const first = downloader(new QueueFetchAdapter([
      memoryResponse({ url: CATALOG_URL, chunks: [data.wireBytes] }),
    ]), cache, data.trustedKey)
    await expect(first.fetchCatalog(CATALOG_URL)).rejects.toMatchObject({ code: 'CACHE_ERROR' })
    expect(cache.catalog).toBeUndefined()
    expect(cache.stagedCatalog?.trustState.highestSequence).toBe(1)

    const restarted = downloader(new QueueFetchAdapter([]), cache, data.trustedKey)
    const recovered = await restarted.initialize()
    expect(recovered?.source).toBe('recovered-stage')
    expect(cache.catalog?.trustState).toEqual({ highestSequence: 1, latestIssuedAt: '2026-07-12T17:00:00.000Z' })
    expect(cache.stagedCatalog).toBeUndefined()
  })

  it('discards a corrupt staged catalog during crash recovery', async () => {
    const data = fixture()
    const cache = new MemoryModuleDownloaderCache()
    cache.stagedCatalog = {
      sourceUrl: CATALOG_URL,
      responseBytes: new TextEncoder().encode('{corrupt'),
      expiresAt: '2026-07-13T17:00:00.000Z',
      trustState: { highestSequence: 1, latestIssuedAt: '2026-07-12T17:00:00.000Z' },
      committedAt: NOW,
    }
    expect(await downloader(new QueueFetchAdapter([]), cache, data.trustedKey).initialize()).toBeUndefined()
    expect(cache.stagedCatalog).toBeUndefined()
  })

  it('rejects cross-origin redirects before sending a second request', async () => {
    const data = fixture()
    const fetch = new QueueFetchAdapter([
      memoryResponse({ status: 302, url: CATALOG_URL, headers: { location: 'https://evil.example/catalog' } }),
    ])
    await expect(downloader(fetch, new MemoryModuleDownloaderCache(), data.trustedKey).fetchCatalog(CATALOG_URL))
      .rejects.toMatchObject({ code: 'INVALID_REDIRECT' })
    expect(fetch.requests).toHaveLength(1)
  })

  it('enforces catalog timeout through the injected clock', async () => {
    const data = fixture()
    const clock = new ManualClock(NOW)
    const fetch = new QueueFetchAdapter([async (request) => new Promise((_, reject) => {
      request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })
    })])
    const client = new ModuleDownloader({
      fetch,
      cache: new MemoryModuleDownloaderCache(),
      clock,
      trustedKeys: [data.trustedKey],
      retry: { maxAttempts: 1 },
    })
    const pending = client.fetchCatalog(CATALOG_URL)
    while (fetch.requests.length === 0) await Promise.resolve()
    clock.advance(30_000)
    await expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' })
  })
})

describe('verified artifact download', () => {
  it('streams, reports progress, verifies size/hash, and publishes atomically', async () => {
    const data = fixture()
    const cache = new MemoryModuleDownloaderCache()
    const progress: number[] = []
    const fetch = new QueueFetchAdapter([
      memoryResponse({
        url: ARTIFACT_URL,
        headers: { 'content-length': '6', etag: '"artifact-v1"' },
        chunks: [data.artifactBytes.subarray(0, 2), data.artifactBytes.subarray(2)],
      }),
    ])
    const result = await downloader(fetch, cache, data.trustedKey).downloadArtifact({
      artifact: data.artifact,
      expectedSize: 6,
      onProgress: (event) => progress.push(event.receivedBytes),
    })
    expect(result.source).toBe('network')
    expect(progress).toEqual([2, 6])
    expect(cache.artifacts.get(data.artifact.sha256)?.size).toBe(6)
    expect(cache.partials.size).toBe(0)
  })

  it('resumes only with a strong validator and exact range metadata', async () => {
    const data = fixture()
    const cache = new MemoryModuleDownloaderCache()
    const interrupted = {
      status: 200,
      url: ARTIFACT_URL,
      headers: new MemoryHeaders({ 'content-length': '6', etag: '"artifact-v1"' }),
      body: (async function* () {
        yield data.artifactBytes.subarray(0, 3)
        throw new ModuleDownloaderError('NETWORK_ERROR', 'connection reset', { retryable: true })
      })(),
    }
    const fetch = new QueueFetchAdapter([
      interrupted,
      memoryResponse({
        status: 206,
        url: ARTIFACT_URL,
        headers: { 'content-length': '3', 'content-range': 'bytes 3-5/6', etag: '"artifact-v1"' },
        chunks: [data.artifactBytes.subarray(3)],
      }),
    ])
    await downloader(fetch, cache, data.trustedKey).downloadArtifact({ artifact: data.artifact, expectedSize: 6 })
    expect(fetch.requests[1]?.headers).toMatchObject({ range: 'bytes=3-', 'if-range': '"artifact-v1"' })
    expect(cache.artifacts.has(data.artifact.sha256)).toBe(true)
  })

  it('discards an invalid range response and retries from byte zero', async () => {
    const data = fixture()
    const cache = new MemoryModuleDownloaderCache()
    const fetch = new QueueFetchAdapter([
      {
        status: 200,
        url: ARTIFACT_URL,
        headers: new MemoryHeaders({ 'content-length': '6', etag: '"artifact-v1"' }),
        body: (async function* () {
          yield data.artifactBytes.subarray(0, 3)
          throw new Error('connection reset')
        })(),
      },
      memoryResponse({
        status: 206,
        url: ARTIFACT_URL,
        headers: { 'content-length': '3', 'content-range': 'bytes 2-5/6', etag: '"artifact-v1"' },
        chunks: [data.artifactBytes.subarray(3)],
      }),
      memoryResponse({ url: ARTIFACT_URL, headers: { 'content-length': '6' }, chunks: [data.artifactBytes] }),
    ])
    await downloader(fetch, cache, data.trustedKey).downloadArtifact({ artifact: data.artifact, expectedSize: 6 })
    expect(fetch.requests[1]?.headers.range).toBe('bytes=3-')
    expect(fetch.requests[2]?.headers.range).toBeUndefined()
    expect(cache.partials.size).toBe(0)
  })

  it('coalesces concurrent requests for the same hash while notifying both callers', async () => {
    const data = fixture()
    const cache = new MemoryModuleDownloaderCache()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const fetch = new QueueFetchAdapter([async () => ({
      status: 200,
      url: ARTIFACT_URL,
      headers: new MemoryHeaders({ 'content-length': '6' }),
      body: (async function* () { await gate; yield data.artifactBytes })(),
    })])
    const client = downloader(fetch, cache, data.trustedKey)
    const leftProgress: number[] = []
    const rightProgress: number[] = []
    const left = client.downloadArtifact({ artifact: data.artifact, expectedSize: 6, onProgress: (p) => leftProgress.push(p.receivedBytes) })
    const right = client.downloadArtifact({ artifact: data.artifact, expectedSize: 6, onProgress: (p) => rightProgress.push(p.receivedBytes) })
    await Promise.resolve()
    release()
    const [a, b] = await Promise.all([left, right])
    expect(a.artifact).toEqual(b.artifact)
    expect(fetch.requests).toHaveLength(1)
    expect(leftProgress).toEqual([6])
    expect(rightProgress).toEqual([6])
  })

  it('keeps a coalesced transfer alive when only one subscriber cancels', async () => {
    const data = fixture()
    const cache = new MemoryModuleDownloaderCache()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const fetch = new QueueFetchAdapter([async () => ({
      status: 200,
      url: ARTIFACT_URL,
      headers: new MemoryHeaders({ 'content-length': '6' }),
      body: (async function* () { await gate; yield data.artifactBytes })(),
    })])
    const client = downloader(fetch, cache, data.trustedKey)
    const controller = new AbortController()
    const cancelled = client.downloadArtifact({ artifact: data.artifact, expectedSize: 6, signal: controller.signal })
    const survivor = client.downloadArtifact({ artifact: data.artifact, expectedSize: 6 })
    await Promise.resolve()
    controller.abort('caller-cancelled')
    release()
    await expect(cancelled).rejects.toMatchObject({ code: 'ABORTED' })
    expect((await survivor).artifact.size).toBe(6)
    expect(fetch.requests).toHaveLength(1)
  })

  it('retries retryable status with injected exponential backoff', async () => {
    const data = fixture()
    const cache = new MemoryModuleDownloaderCache()
    const clock = new ManualClock(NOW)
    const fetch = new QueueFetchAdapter([
      memoryResponse({ status: 503, url: ARTIFACT_URL }),
      memoryResponse({ url: ARTIFACT_URL, headers: { 'content-length': '6' }, chunks: [data.artifactBytes] }),
    ])
    await downloader(fetch, cache, data.trustedKey, clock).downloadArtifact({ artifact: data.artifact, expectedSize: 6 })
    expect(clock.sleeps).toHaveLength(1)
    expect(clock.sleeps[0]).toBeGreaterThanOrEqual(0)
  })

  it('does not publish on hash mismatch and removes the poisoned partial', async () => {
    const data = fixture()
    const bad = new TextEncoder().encode('abcdeg')
    const cache = new MemoryModuleDownloaderCache()
    const fetch = new QueueFetchAdapter([
      memoryResponse({ url: ARTIFACT_URL, headers: { 'content-length': '6' }, chunks: [bad] }),
    ])
    await expect(downloader(fetch, cache, data.trustedKey).downloadArtifact({ artifact: data.artifact, expectedSize: 6 }))
      .rejects.toMatchObject({ code: 'HASH_MISMATCH' })
    expect(cache.artifacts.size).toBe(0)
    expect(cache.partials.size).toBe(0)
  })

  it('surfaces atomic artifact publish faults without exposing a final record', async () => {
    const data = fixture()
    const cache = new MemoryModuleDownloaderCache()
    cache.failNext('publishPartial')
    const fetch = new QueueFetchAdapter([
      memoryResponse({ url: ARTIFACT_URL, headers: { 'content-length': '6' }, chunks: [data.artifactBytes] }),
    ])
    await expect(downloader(fetch, cache, data.trustedKey).downloadArtifact({ artifact: data.artifact, expectedSize: 6 }))
      .rejects.toMatchObject({ code: 'CACHE_ERROR' })
    expect(cache.artifacts.size).toBe(0)
    expect(cache.partials.size).toBe(1)
  })

  it('cleans stale unique partials', async () => {
    const data = fixture()
    const cache = new MemoryModuleDownloaderCache()
    await cache.createPartial({
      sha256: data.artifact.sha256,
      sourceUrl: ARTIFACT_URL,
      expectedSize: 6,
      updatedAt: NOW - 100,
    })
    const client = new ModuleDownloader({
      fetch: new QueueFetchAdapter([]), cache, clock: new ManualClock(NOW), trustedKeys: [data.trustedKey], partialMaxAgeMs: 50,
    })
    expect(await client.cleanupStalePartials()).toBe(1)
    expect(cache.partials.size).toBe(0)
  })
})
