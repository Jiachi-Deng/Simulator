import type { ModuleArtifact } from '@simulator/module-contract'
import type {
  ModuleReleaseCatalog,
  ModuleReleaseTrustDiagnostic,
  ModuleReleaseTrustState,
  TrustedReleaseKey,
} from '@simulator/module-release-trust'

export interface DownloaderHeaders {
  get(name: string): string | null
}

export interface DownloaderResponse {
  readonly status: number
  readonly url: string
  readonly headers: DownloaderHeaders
  readonly body: AsyncIterable<Uint8Array> | null
  /** Cancels or releases the body and transport. The downloader calls this exactly once. */
  dispose(): void | Promise<void>
}

export interface DownloaderFetchRequest {
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly signal: AbortSignal
  readonly redirect: 'manual'
}

export interface DownloaderFetchAdapter {
  fetch(request: DownloaderFetchRequest): Promise<DownloaderResponse>
}

export interface DownloaderClock {
  now(): number
  sleep(ms: number, signal: AbortSignal): Promise<void>
  setTimeout(callback: () => void, ms: number): () => void
}

export interface CachedCatalogRecord {
  readonly sourceUrl: string
  readonly responseBytes: Uint8Array
  readonly etag?: string
  readonly expiresAt: string
  readonly trustState: ModuleReleaseTrustState
  readonly committedAt: number
}

export interface ArtifactPartialRecord {
  readonly id: string
  readonly sha256: string
  readonly sourceUrl: string
  readonly expectedSize: number
  readonly bytesWritten: number
  readonly validator?: string
  readonly updatedAt: number
}

export interface CachedArtifactRecord {
  readonly sha256: string
  readonly size: number
  readonly committedAt: number
}

export interface ModuleDownloaderCacheLease {
  release(): void | Promise<void>
}

export type ArtifactPublishResult = 'published' | 'already-present'

export interface ModuleDownloaderCacheAdapter {
  /** Must exclude the same key across every adapter instance sharing the backing store. */
  acquireLease(key: string, signal: AbortSignal): Promise<ModuleDownloaderCacheLease>

  readCatalog(): Promise<CachedCatalogRecord | undefined>
  readStagedCatalog(): Promise<CachedCatalogRecord | undefined>
  stageCatalog(record: CachedCatalogRecord): Promise<void>
  /** Atomically publishes staged bytes plus trust state only when committed state equals expectedState. */
  publishCatalog(expectedState: ModuleReleaseTrustState | undefined): Promise<boolean>
  discardStagedCatalog(): Promise<void>

  readArtifact(sha256: string): Promise<CachedArtifactRecord | undefined>
  listPartials(sha256?: string): Promise<readonly ArtifactPartialRecord[]>
  createPartial(record: Omit<ArtifactPartialRecord, 'id' | 'bytesWritten'>): Promise<ArtifactPartialRecord>
  readPartial(id: string): Promise<AsyncIterable<Uint8Array>>
  appendPartial(id: string, bytes: Uint8Array, updatedAt: number, validator?: string): Promise<ArtifactPartialRecord>
  removePartial(id: string): Promise<void>
  /** Atomically publishes the verified partial only when the hash has no committed artifact. */
  publishPartial(id: string, artifact: CachedArtifactRecord): Promise<ArtifactPublishResult>
}

export interface RetryPolicy {
  readonly maxAttempts: number
  readonly baseDelayMs: number
  readonly maxDelayMs: number
}

/**
 * Explicit opt-in for GitHub's exact-tag release asset redirect. The initial
 * URL remains catalog-authenticated; this policy only narrows the transport hop.
 */
export interface GitHubReleaseRedirectPolicy {
  readonly owner: string
  readonly repository: string
}

export interface ModuleDownloaderOptions {
  readonly fetch: DownloaderFetchAdapter
  readonly clock: DownloaderClock
  readonly cache: ModuleDownloaderCacheAdapter
  readonly trustedKeys: readonly TrustedReleaseKey[]
  readonly catalogMaxBytes?: number
  readonly catalogTimeoutMs?: number
  readonly artifactTimeoutMs?: number
  readonly retry?: Partial<RetryPolicy>
  readonly maxRedirects?: number
  readonly githubReleaseRedirectPolicy?: GitHubReleaseRedirectPolicy
  readonly partialMaxAgeMs?: number
  readonly maxPartialsPerArtifact?: number
}

export type DownloaderErrorCode =
  | 'ABORTED'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'HTTP_STATUS'
  | 'INVALID_REDIRECT'
  | 'REDIRECT_LIMIT'
  | 'INVALID_CONTENT_LENGTH'
  | 'SIZE_MISMATCH'
  | 'HASH_MISMATCH'
  | 'CATALOG_TOO_LARGE'
  | 'INVALID_CATALOG_WIRE'
  | 'CATALOG_NOT_VERIFIED'
  | 'CACHE_MISS'
  | 'INVALID_RANGE_RESPONSE'
  | 'CACHE_ERROR'

export class ModuleDownloaderError extends Error {
  readonly code: DownloaderErrorCode
  readonly retryable: boolean
  readonly status?: number
  readonly diagnostics?: readonly ModuleReleaseTrustDiagnostic[]

  constructor(
    code: DownloaderErrorCode,
    message: string,
    options: {
      retryable?: boolean
      status?: number
      diagnostics?: readonly ModuleReleaseTrustDiagnostic[]
      cause?: unknown
    } = {},
  ) {
    super(message, { cause: options.cause })
    this.name = 'ModuleDownloaderError'
    this.code = code
    this.retryable = options.retryable ?? false
    this.status = options.status
    this.diagnostics = options.diagnostics
  }
}

export interface CatalogResult {
  readonly catalog: ModuleReleaseCatalog
  readonly source: 'network' | 'cache' | 'revalidated-cache' | 'recovered-stage'
  readonly etag?: string
}

export interface ArtifactDownloadRequest {
  readonly artifact: ModuleArtifact
  readonly expectedSize: number
  readonly signal?: AbortSignal
  readonly onProgress?: (progress: ArtifactProgress) => void
}

export interface ArtifactProgress {
  readonly sha256: string
  readonly receivedBytes: number
  readonly totalBytes: number
  readonly attempt: number
  readonly resumed: boolean
}

export interface ArtifactDownloadResult {
  readonly artifact: CachedArtifactRecord
  readonly source: 'network' | 'cache'
}
