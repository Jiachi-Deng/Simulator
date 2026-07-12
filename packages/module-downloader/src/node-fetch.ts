import type { DownloaderFetchAdapter, DownloaderFetchRequest, DownloaderResponse } from './types.ts'

export class NodeFetchAdapter implements DownloaderFetchAdapter {
  readonly #fetch: typeof globalThis.fetch

  constructor(fetchImplementation: typeof globalThis.fetch = globalThis.fetch) {
    if (typeof fetchImplementation !== 'function') throw new TypeError('A native fetch implementation is required')
    this.#fetch = fetchImplementation
  }

  async fetch(request: DownloaderFetchRequest): Promise<DownloaderResponse> {
    const response = await this.#fetch(request.url, {
      method: 'GET',
      headers: request.headers,
      signal: request.signal,
      redirect: request.redirect,
    })
    let disposed = false
    return {
      status: response.status,
      url: response.url,
      headers: response.headers,
      body: response.body ? readableStreamBytes(response.body) : null,
      async dispose() {
        if (disposed) return
        disposed = true
        if (response.body && !response.body.locked) await response.body.cancel()
      },
    }
  }
}

async function* readableStreamBytes(stream: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  const reader = stream.getReader()
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) return
      yield next.value
    }
  } finally {
    reader.releaseLock()
  }
}
