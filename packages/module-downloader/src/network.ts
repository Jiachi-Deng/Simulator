import { ModuleDownloaderError, type DownloaderClock, type DownloaderResponse, type ModuleDownloaderOptions } from './types.ts'

export interface NetworkContext {
  readonly options: Required<Pick<ModuleDownloaderOptions, 'maxRedirects'>> & ModuleDownloaderOptions
}

export function canonicalHttpsUrl(input: string): URL {
  let url: URL
  try {
    url = new URL(input)
  } catch (cause) {
    throw new ModuleDownloaderError('INVALID_REDIRECT', 'URL is invalid', { cause })
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.href !== input) {
    throw new ModuleDownloaderError('INVALID_REDIRECT', 'URL must be canonical HTTPS without credentials or fragment')
  }
  return url
}

export async function fetchWithRedirects(
  context: NetworkContext,
  input: string,
  headers: Readonly<Record<string, string>>,
  signal: AbortSignal,
): Promise<DownloaderResponse> {
  const initial = canonicalHttpsUrl(input)
  let current = initial
  for (let redirects = 0; ; redirects += 1) {
    let response: DownloaderResponse
    try {
      response = await context.options.fetch.fetch({ url: current.href, headers, signal, redirect: 'manual' })
    } catch (cause) {
      if (signal.aborted) throw abortError(signal)
      throw new ModuleDownloaderError('NETWORK_ERROR', 'Network request failed', { retryable: true, cause })
    }
    let transferred = false
    try {
      const reported = canonicalHttpsUrl(response.url)
      if (reported.href !== current.href) {
        throw new ModuleDownloaderError('INVALID_REDIRECT', 'Fetch adapter followed a redirect implicitly')
      }
      if (![301, 302, 303, 307, 308].includes(response.status)) {
        transferred = true
        return response
      }
      if (redirects >= context.options.maxRedirects) {
        throw new ModuleDownloaderError('REDIRECT_LIMIT', 'Redirect limit exceeded')
      }
      const location = response.headers.get('location')
      if (!location) throw new ModuleDownloaderError('INVALID_REDIRECT', 'Redirect response is missing Location')
      let next: URL
      try {
        next = new URL(location, current)
      } catch (cause) {
        throw new ModuleDownloaderError('INVALID_REDIRECT', 'Redirect Location is invalid', { cause })
      }
      canonicalHttpsUrl(next.href)
      if (next.origin !== initial.origin) {
        throw new ModuleDownloaderError('INVALID_REDIRECT', 'Cross-origin redirects are not allowed')
      }
      current = next
    } finally {
      if (!transferred) await disposeResponse(response)
    }
  }
}

export async function disposeResponse(response: DownloaderResponse): Promise<void> {
  try {
    await response.dispose()
  } catch (cause) {
    throw new ModuleDownloaderError('NETWORK_ERROR', 'Could not dispose network response', { retryable: true, cause })
  }
}

export async function nextBodyChunk(
  iterator: AsyncIterator<Uint8Array>,
  signal: AbortSignal,
): Promise<IteratorResult<Uint8Array>> {
  if (signal.aborted) throw abortError(signal)
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError(signal))
    signal.addEventListener('abort', onAbort, { once: true })
    void iterator.next().then(resolve, (cause) => {
      if (signal.aborted) reject(abortError(signal))
      else reject(new ModuleDownloaderError('NETWORK_ERROR', 'Response body iterator failed', { retryable: true, cause }))
    }).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

export function strongEtag(value: string | null): string | undefined {
  if (!value || value.startsWith('W/') || !/^"[\x21\x23-\x7e\x80-\xff]*"$/.test(value)) return undefined
  return value
}

export function contentLength(response: DownloaderResponse): number | undefined {
  const raw = response.headers.get('content-length')
  if (raw === null) return undefined
  if (!/^(?:0|[1-9][0-9]*)$/.test(raw)) {
    throw new ModuleDownloaderError('INVALID_CONTENT_LENGTH', 'Content-Length is invalid')
  }
  const value = Number(raw)
  if (!Number.isSafeInteger(value)) throw new ModuleDownloaderError('INVALID_CONTENT_LENGTH', 'Content-Length is unsafe')
  return value
}

export function abortError(signal: AbortSignal): ModuleDownloaderError {
  const timeout = signal.reason === 'module-downloader-timeout'
  return new ModuleDownloaderError(timeout ? 'TIMEOUT' : 'ABORTED', timeout ? 'Download timed out' : 'Download was aborted', {
    retryable: timeout,
    cause: signal.reason,
  })
}

export function timeoutSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number,
  clock: DownloaderClock,
): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController()
  const onAbort = () => controller.abort(parent?.reason)
  parent?.addEventListener('abort', onAbort, { once: true })
  if (parent?.aborted) controller.abort(parent.reason)
  const cancelTimer = clock.setTimeout(() => controller.abort('module-downloader-timeout'), timeoutMs)
  return {
    signal: controller.signal,
    dispose() {
      cancelTimer()
      parent?.removeEventListener('abort', onAbort)
    },
  }
}
