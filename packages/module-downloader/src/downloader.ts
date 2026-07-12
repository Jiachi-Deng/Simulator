import { createHash } from 'node:crypto'
import { verifyModuleReleaseCatalog, type ModuleReleaseTrustState } from '@simulator/module-release-trust'
import { decodeCatalogEnvelope } from './wire.ts'
import {
  abortError,
  canonicalHttpsUrl,
  contentLength,
  fetchWithRedirects,
  strongEtag,
  timeoutSignal,
} from './network.ts'
import {
  ModuleDownloaderError,
  type ArtifactDownloadRequest,
  type ArtifactDownloadResult,
  type ArtifactPartialRecord,
  type ArtifactProgress,
  type CachedCatalogRecord,
  type CatalogResult,
  type ModuleDownloaderOptions,
  type RetryPolicy,
} from './types.ts'

const DEFAULT_CATALOG_MAX_BYTES = 4 * 1024 * 1024
const DEFAULT_CATALOG_TIMEOUT_MS = 30_000
const DEFAULT_ARTIFACT_TIMEOUT_MS = 10 * 60_000
const DEFAULT_MAX_REDIRECTS = 3
const DEFAULT_PARTIAL_MAX_AGE_MS = 24 * 60 * 60_000
const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 3, baseDelayMs: 250, maxDelayMs: 5_000 }

interface Subscriber {
  readonly signal?: AbortSignal
  readonly onProgress?: (progress: ArtifactProgress) => void
}

interface ArtifactFlight {
  readonly promise: Promise<ArtifactDownloadResult>
  readonly controller: AbortController
  readonly subscribers: Set<Subscriber>
  readonly sourceUrl: string
  readonly expectedSize: number
}

export class ModuleDownloader {
  readonly #options: ModuleDownloaderOptions & {
    catalogMaxBytes: number
    catalogTimeoutMs: number
    artifactTimeoutMs: number
    maxRedirects: number
    partialMaxAgeMs: number
    retry: RetryPolicy
  }
  readonly #flights = new Map<string, ArtifactFlight>()
  #initialized?: Promise<CatalogResult | undefined>
  #catalogTail = Promise.resolve()

  constructor(options: ModuleDownloaderOptions) {
    this.#options = {
      ...options,
      catalogMaxBytes: positiveInteger(options.catalogMaxBytes, DEFAULT_CATALOG_MAX_BYTES, 'catalogMaxBytes'),
      catalogTimeoutMs: positiveInteger(options.catalogTimeoutMs, DEFAULT_CATALOG_TIMEOUT_MS, 'catalogTimeoutMs'),
      artifactTimeoutMs: positiveInteger(options.artifactTimeoutMs, DEFAULT_ARTIFACT_TIMEOUT_MS, 'artifactTimeoutMs'),
      maxRedirects: nonNegativeInteger(options.maxRedirects, DEFAULT_MAX_REDIRECTS, 'maxRedirects'),
      partialMaxAgeMs: nonNegativeInteger(options.partialMaxAgeMs, DEFAULT_PARTIAL_MAX_AGE_MS, 'partialMaxAgeMs'),
      retry: normalizeRetry(options.retry),
    }
  }

  initialize(): Promise<CatalogResult | undefined> {
    this.#initialized ??= this.#recover()
    return this.#initialized
  }

  async fetchCatalog(url: string, signal?: AbortSignal): Promise<CatalogResult> {
    await this.initialize()
    const previous = this.#catalogTail
    let release!: () => void
    this.#catalogTail = new Promise<void>((resolve) => { release = resolve })
    await previous
    try {
      return await this.#fetchCatalogLocked(url, signal)
    } finally {
      release()
    }
  }

  async #fetchCatalogLocked(url: string, signal?: AbortSignal): Promise<CatalogResult> {
    canonicalHttpsUrl(url)
    const cached = await this.#options.cache.readCatalog()
    const usableCache = cached?.sourceUrl === url ? this.#verifyCached(cached) : undefined
    const headers: Record<string, string> = { accept: 'application/vnd.simulator.module-catalog+json' }
    if (usableCache && cached?.etag) headers['if-none-match'] = cached.etag

    return this.#retry(async () => {
      const timeout = timeoutSignal(signal, this.#options.catalogTimeoutMs, this.#options.clock)
      try {
        const response = await fetchWithRedirects({ options: this.#options }, url, headers, timeout.signal)
        if (response.status === 304) {
          if (!usableCache || !cached || Date.parse(cached.expiresAt) <= this.#options.clock.now()) {
            throw new ModuleDownloaderError('CACHE_MISS', '304 requires a verified, unexpired cached catalog')
          }
          return { ...usableCache, source: 'revalidated-cache' as const }
        }
        if (response.status !== 200) throw httpError(response.status, 'Catalog request')
        const declared = contentLength(response)
        if (declared !== undefined && declared > this.#options.catalogMaxBytes) {
          throw new ModuleDownloaderError('CATALOG_TOO_LARGE', 'Catalog exceeds the byte limit')
        }
        const bytes = await readBounded(response.body, this.#options.catalogMaxBytes, timeout.signal)
        if (declared !== undefined && declared !== bytes.byteLength) {
          throw new ModuleDownloaderError('SIZE_MISMATCH', 'Catalog Content-Length does not match received bytes', { retryable: true })
        }
        const state = cached?.trustState ?? { highestSequence: 0 }
        const verified = this.#verifyNetwork(bytes, state)
        const etag = validEtag(response.headers.get('etag'))
        const record: CachedCatalogRecord = {
          sourceUrl: url,
          responseBytes: bytes,
          ...(etag ? { etag } : {}),
          expiresAt: verified.catalog.expiresAt,
          trustState: verified.state,
          committedAt: this.#options.clock.now(),
        }
        try {
          await this.#options.cache.stageCatalog(record)
          await this.#options.cache.publishCatalog()
        } catch (cause) {
          throw new ModuleDownloaderError('CACHE_ERROR', 'Could not atomically publish verified catalog and trust state', { cause })
        }
        return { catalog: verified.catalog, source: 'network' as const, ...(etag ? { etag } : {}) }
      } finally {
        timeout.dispose()
      }
    }, signal)
  }

  async downloadArtifact(request: ArtifactDownloadRequest): Promise<ArtifactDownloadResult> {
    await this.initialize()
    canonicalHttpsUrl(request.artifact.url)
    if (!Number.isSafeInteger(request.expectedSize) || request.expectedSize <= 0) {
      throw new TypeError('expectedSize must be a positive safe integer')
    }
    const existing = await this.#options.cache.readArtifact(request.artifact.sha256)
    if (existing) {
      if (existing.size !== request.expectedSize) {
        throw new ModuleDownloaderError('SIZE_MISMATCH', 'Cached artifact size conflicts with verified catalog')
      }
      return { artifact: existing, source: 'cache' }
    }

    let flight = this.#flights.get(request.artifact.sha256)
    if (flight && (flight.sourceUrl !== request.artifact.url || flight.expectedSize !== request.expectedSize)) {
      throw new ModuleDownloaderError('SIZE_MISMATCH', 'Concurrent same-hash request has conflicting verified metadata')
    }
    if (!flight) {
      const controller = new AbortController()
      const subscribers = new Set<Subscriber>()
      const promise = this.#downloadArtifactOwner(request, controller.signal, subscribers)
        .finally(() => this.#flights.delete(request.artifact.sha256))
      flight = {
        promise,
        controller,
        subscribers,
        sourceUrl: request.artifact.url,
        expectedSize: request.expectedSize,
      }
      this.#flights.set(request.artifact.sha256, flight)
    }
    return this.#subscribe(flight, request)
  }

  async cleanupStalePartials(): Promise<number> {
    const cutoff = this.#options.clock.now() - this.#options.partialMaxAgeMs
    const partials = await this.#options.cache.listPartials()
    const stale = partials.filter((partial) => partial.updatedAt <= cutoff)
    await Promise.all(stale.map((partial) => this.#options.cache.removePartial(partial.id)))
    return stale.length
  }

  async #recover(): Promise<CatalogResult | undefined> {
    await this.cleanupStalePartials()
    const staged = await this.#options.cache.readStagedCatalog()
    if (!staged) return undefined
    const committed = await this.#options.cache.readCatalog()
    if (committed && sameCatalogRecord(committed, staged)) {
      await this.#options.cache.discardStagedCatalog()
      return this.#verifyCached(committed)
    }
    try {
      const verified = this.#verifyNetwork(staged.responseBytes, committed?.trustState ?? { highestSequence: 0 })
      if (!sameTrustState(verified.state, staged.trustState) || verified.catalog.expiresAt !== staged.expiresAt) {
        throw new ModuleDownloaderError('CATALOG_NOT_VERIFIED', 'Staged catalog metadata does not match verified bytes')
      }
      await this.#options.cache.publishCatalog()
      return { catalog: verified.catalog, source: 'recovered-stage', ...(staged.etag ? { etag: staged.etag } : {}) }
    } catch (cause) {
      await this.#options.cache.discardStagedCatalog()
      if (
        cause instanceof ModuleDownloaderError
        && (cause.code === 'CATALOG_NOT_VERIFIED' || cause.code === 'INVALID_CATALOG_WIRE')
      ) return undefined
      throw cause
    }
  }

  #verifyNetwork(bytes: Uint8Array, state: ModuleReleaseTrustState) {
    const result = verifyModuleReleaseCatalog(decodeCatalogEnvelope(bytes), {
      trustedKeys: this.#options.trustedKeys,
      state,
      now: this.#options.clock.now(),
    })
    if (!result.ok) {
      throw new ModuleDownloaderError('CATALOG_NOT_VERIFIED', 'Catalog trust verification failed', {
        diagnostics: result.diagnostics,
      })
    }
    return result
  }

  #verifyCached(record: CachedCatalogRecord): CatalogResult | undefined {
    try {
      const envelope = decodeCatalogEnvelope(record.responseBytes)
      const raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(envelope.catalogBytes)) as Record<string, unknown>
      const sequence = raw.sequence
      const issuedAt = raw.issuedAt
      if (!Number.isSafeInteger(sequence) || typeof issuedAt !== 'string') return undefined
      const previous: ModuleReleaseTrustState = sequence === 1
        ? { highestSequence: 0 }
        : { highestSequence: (sequence as number) - 1, latestIssuedAt: new Date(Date.parse(issuedAt) - 1).toISOString() }
      const result = verifyModuleReleaseCatalog(envelope, {
        trustedKeys: this.#options.trustedKeys,
        state: previous,
        now: this.#options.clock.now(),
      })
      if (!result.ok || !sameTrustState(result.state, record.trustState) || result.catalog.expiresAt !== record.expiresAt) return undefined
      if (Date.parse(result.catalog.expiresAt) <= this.#options.clock.now()) return undefined
      return { catalog: result.catalog, source: 'cache', ...(record.etag ? { etag: record.etag } : {}) }
    } catch {
      return undefined
    }
  }

  async #downloadArtifactOwner(
    request: ArtifactDownloadRequest,
    signal: AbortSignal,
    subscribers: Set<Subscriber>,
  ): Promise<ArtifactDownloadResult> {
    let attempt = 0
    return this.#retry(async () => {
      attempt += 1
      return this.#artifactAttempt(request, signal, subscribers, attempt)
    }, signal)
  }

  async #artifactAttempt(
    request: ArtifactDownloadRequest,
    parentSignal: AbortSignal,
    subscribers: Set<Subscriber>,
    attempt: number,
  ): Promise<ArtifactDownloadResult> {
    const timeout = timeoutSignal(parentSignal, this.#options.artifactTimeoutMs, this.#options.clock)
    let partial = await this.#selectPartial(request)
    const resumed = partial !== undefined
    if (!partial) {
      partial = await this.#options.cache.createPartial({
        sha256: request.artifact.sha256,
        sourceUrl: request.artifact.url,
        expectedSize: request.expectedSize,
        updatedAt: this.#options.clock.now(),
      })
    }
    const headers: Record<string, string> = { accept: 'application/octet-stream' }
    if (resumed && partial.validator) {
      headers.range = `bytes=${partial.bytesWritten}-`
      headers['if-range'] = partial.validator
    }
    try {
      const response = await fetchWithRedirects({ options: this.#options }, request.artifact.url, headers, timeout.signal)
      if (resumed) {
        try {
          this.#validateRangeResponse(response.status, response.headers.get('content-range'), response.headers.get('etag'), partial)
        } catch (cause) {
          await this.#options.cache.removePartial(partial.id)
          throw cause
        }
      }
      else if (response.status !== 200) throw httpError(response.status, 'Artifact request')

      const declared = contentLength(response)
      const expectedResponseBytes = request.expectedSize - partial.bytesWritten
      if (declared !== undefined && declared !== expectedResponseBytes) {
        throw new ModuleDownloaderError('SIZE_MISMATCH', 'Artifact Content-Length does not match verified size', { retryable: true })
      }
      const responseValidator = strongEtag(response.headers.get('etag'))
      if (!resumed && responseValidator) {
        partial = await this.#options.cache.appendPartial(partial.id, new Uint8Array(), this.#options.clock.now(), responseValidator)
      }
      let received = partial.bytesWritten
      if (!response.body) throw new ModuleDownloaderError('NETWORK_ERROR', 'Artifact response has no body', { retryable: true })
      for await (const chunk of response.body) {
        if (timeout.signal.aborted) throw abortError(timeout.signal)
        if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0) continue
        received += chunk.byteLength
        if (received > request.expectedSize) throw new ModuleDownloaderError('SIZE_MISMATCH', 'Artifact exceeds verified size')
        try {
          partial = await this.#options.cache.appendPartial(partial.id, chunk, this.#options.clock.now(), responseValidator)
        } catch (cause) {
          throw new ModuleDownloaderError('CACHE_ERROR', 'Could not persist artifact bytes', { cause })
        }
        notify(subscribers, {
          sha256: request.artifact.sha256,
          receivedBytes: received,
          totalBytes: request.expectedSize,
          attempt,
          resumed,
        })
      }
      if (received !== request.expectedSize) {
        throw new ModuleDownloaderError('SIZE_MISMATCH', 'Artifact ended before verified size', { retryable: true })
      }
      let digest: string
      try {
        digest = await hashPartial(this.#options.cache.readPartial(partial.id), timeout.signal)
      } catch (cause) {
        if (cause instanceof ModuleDownloaderError) throw cause
        throw new ModuleDownloaderError('CACHE_ERROR', 'Could not reread artifact partial for verification', { cause })
      }
      if (digest !== request.artifact.sha256) {
        await this.#options.cache.removePartial(partial.id)
        throw new ModuleDownloaderError('HASH_MISMATCH', 'Artifact SHA-256 does not match verified catalog')
      }
      const artifact = { sha256: digest, size: received, committedAt: this.#options.clock.now() }
      try {
        await this.#options.cache.publishPartial(partial.id, artifact)
      } catch (cause) {
        throw new ModuleDownloaderError('CACHE_ERROR', 'Could not atomically publish verified artifact', { cause })
      }
      return { artifact, source: 'network' }
    } catch (cause) {
      if (cause instanceof ModuleDownloaderError) throw cause
      if (timeout.signal.aborted) throw abortError(timeout.signal)
      throw new ModuleDownloaderError('NETWORK_ERROR', 'Artifact response stream failed', { retryable: true, cause })
    } finally {
      timeout.dispose()
    }
  }

  async #selectPartial(request: ArtifactDownloadRequest): Promise<ArtifactPartialRecord | undefined> {
    const partials = await this.#options.cache.listPartials(request.artifact.sha256)
    let selected: ArtifactPartialRecord | undefined
    for (const partial of partials) {
      const valid = partial.sourceUrl === request.artifact.url
        && partial.expectedSize === request.expectedSize
        && partial.bytesWritten > 0
        && partial.bytesWritten < request.expectedSize
        && strongEtag(partial.validator ?? null) !== undefined
      if (valid && (!selected || partial.updatedAt > selected.updatedAt)) selected = partial
      else await this.#options.cache.removePartial(partial.id)
    }
    return selected
  }

  #validateRangeResponse(status: number, range: string | null, etag: string | null, partial: ArtifactPartialRecord): void {
    const expected = `bytes ${partial.bytesWritten}-${partial.expectedSize - 1}/${partial.expectedSize}`
    if (status !== 206 || range !== expected || strongEtag(etag) !== partial.validator) {
      throw new ModuleDownloaderError('INVALID_RANGE_RESPONSE', 'Range response does not match the safe resume validator', { retryable: true })
    }
  }

  #subscribe(flight: ArtifactFlight, request: ArtifactDownloadRequest): Promise<ArtifactDownloadResult> {
    if (request.signal?.aborted) return Promise.reject(abortError(request.signal))
    const subscriber: Subscriber = { signal: request.signal, onProgress: request.onProgress }
    flight.subscribers.add(subscriber)
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        flight.subscribers.delete(subscriber)
        if (flight.subscribers.size === 0) flight.controller.abort(request.signal?.reason)
        reject(abortError(request.signal!))
      }
      request.signal?.addEventListener('abort', onAbort, { once: true })
      flight.promise.then(resolve, reject).finally(() => {
        request.signal?.removeEventListener('abort', onAbort)
        flight.subscribers.delete(subscriber)
      })
    })
  }

  async #retry<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    let last: unknown
    for (let attempt = 1; attempt <= this.#options.retry.maxAttempts; attempt += 1) {
      if (signal?.aborted) throw abortError(signal)
      try {
        return await operation()
      } catch (cause) {
        last = cause
        if (!(cause instanceof ModuleDownloaderError) || !cause.retryable || attempt === this.#options.retry.maxAttempts) throw cause
        const exponential = Math.min(this.#options.retry.maxDelayMs, this.#options.retry.baseDelayMs * 2 ** (attempt - 1))
        const jitter = deterministicJitter(exponential, attempt)
        try {
          await this.#options.clock.sleep(jitter, signal ?? new AbortController().signal)
        } catch (cause) {
          if (signal?.aborted) throw abortError(signal)
          throw new ModuleDownloaderError('NETWORK_ERROR', 'Retry backoff failed', { cause })
        }
      }
    }
    throw last
  }
}

async function readBounded(body: AsyncIterable<Uint8Array> | null, limit: number, signal: AbortSignal): Promise<Uint8Array> {
  if (!body) throw new ModuleDownloaderError('NETWORK_ERROR', 'Response has no body', { retryable: true })
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of body) {
    if (signal.aborted) throw abortError(signal)
    if (!(chunk instanceof Uint8Array)) throw new ModuleDownloaderError('NETWORK_ERROR', 'Response body yielded invalid bytes')
    size += chunk.byteLength
    if (size > limit) throw new ModuleDownloaderError('CATALOG_TOO_LARGE', 'Catalog exceeds the byte limit')
    chunks.push(chunk)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

async function hashPartial(body: Promise<AsyncIterable<Uint8Array>>, signal: AbortSignal): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of await body) {
    if (signal.aborted) throw abortError(signal)
    hash.update(chunk)
  }
  return hash.digest('hex')
}

function notify(subscribers: Set<Subscriber>, progress: ArtifactProgress): void {
  for (const subscriber of subscribers) {
    if (!subscriber.signal?.aborted) {
      try {
        subscriber.onProgress?.(progress)
      } catch {
        // Progress observers are not part of the download transaction.
      }
    }
  }
}

function httpError(status: number, label: string): ModuleDownloaderError {
  return new ModuleDownloaderError('HTTP_STATUS', `${label} returned HTTP ${status}`, {
    status,
    retryable: status === 408 || status === 425 || status === 429 || status >= 500,
  })
}

function validEtag(value: string | null): string | undefined {
  if (!value || /[\r\n]/.test(value) || value.length > 1024) return undefined
  return value
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result <= 0) throw new TypeError(`${name} must be a positive safe integer`)
  return result
}

function nonNegativeInteger(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result < 0) throw new TypeError(`${name} must be a non-negative safe integer`)
  return result
}

function normalizeRetry(input: ModuleDownloaderOptions['retry']): RetryPolicy {
  const retry = {
    maxAttempts: positiveInteger(input?.maxAttempts, DEFAULT_RETRY.maxAttempts, 'retry.maxAttempts'),
    baseDelayMs: nonNegativeInteger(input?.baseDelayMs, DEFAULT_RETRY.baseDelayMs, 'retry.baseDelayMs'),
    maxDelayMs: nonNegativeInteger(input?.maxDelayMs, DEFAULT_RETRY.maxDelayMs, 'retry.maxDelayMs'),
  }
  if (retry.maxDelayMs < retry.baseDelayMs) throw new TypeError('retry.maxDelayMs must be >= retry.baseDelayMs')
  return retry
}

function deterministicJitter(delay: number, attempt: number): number {
  if (delay === 0) return 0
  return Math.floor(delay * (0.75 + ((attempt * 1103515245 + 12345) % 1000) / 2000))
}

function sameTrustState(left: ModuleReleaseTrustState, right: ModuleReleaseTrustState): boolean {
  return left.highestSequence === right.highestSequence && left.latestIssuedAt === right.latestIssuedAt
}

function sameCatalogRecord(left: CachedCatalogRecord, right: CachedCatalogRecord): boolean {
  return left.sourceUrl === right.sourceUrl
    && left.expiresAt === right.expiresAt
    && sameTrustState(left.trustState, right.trustState)
    && Buffer.from(left.responseBytes).equals(Buffer.from(right.responseBytes))
}
