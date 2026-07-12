import type { DownloaderFetchAdapter, DownloaderFetchRequest, DownloaderResponse } from './types.ts'

export class NodeFetchAdapter implements DownloaderFetchAdapter {
  readonly #fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>

  constructor(fetchImplementation: (input: string | URL | Request, init?: RequestInit) => Promise<Response> = globalThis.fetch) {
    if (typeof fetchImplementation !== 'function') throw new TypeError('A native fetch implementation is required')
    this.#fetch = fetchImplementation
  }

  async fetch(request: DownloaderFetchRequest): Promise<DownloaderResponse> {
    const response = await this.#fetch(request.url, {
      method: 'GET', headers: request.headers, signal: request.signal, redirect: request.redirect,
    })
    const body = response.body ? new ResponseBodyOwner(response.body) : null
    let disposal: Promise<void> | undefined
    return {
      status: response.status, url: response.url, headers: response.headers, body,
      dispose() { return (disposal ??= body?.dispose() ?? Promise.resolve()) },
    }
  }
}

class ResponseBodyOwner implements AsyncIterable<Uint8Array> {
  readonly #reader: { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void>; releaseLock(): void }
  #iteratorCreated = false
  #disposed = false

  constructor(stream: ReadableStream<Uint8Array>) { this.#reader = stream.getReader() }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    if (this.#iteratorCreated) throw new Error('Response body can only be consumed once')
    this.#iteratorCreated = true
    const reader = this.#reader
    return {
      next: async () => { const result = await reader.read(); return result.done ? { done: true, value: undefined } : { done: false, value: result.value! } },
      return: async () => { await this.dispose(); return { done: true, value: undefined } },
    }
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    try { await this.#reader.cancel() } finally { this.#reader.releaseLock() }
  }
}
