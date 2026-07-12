import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FilesystemModuleDownloaderCache } from './filesystem-cache.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function pair() {
  const root = await mkdtemp(join(tmpdir(), 'module-downloader-cache-'))
  roots.push(root)
  return [new FilesystemModuleDownloaderCache(root), new FilesystemModuleDownloaderCache(root)] as const
}

describe('filesystem-like cache adapter conformance', () => {
  it('serializes the same lease across adapter instances and supports waiter cancellation', async () => {
    const [left, right] = await pair()
    const owner = await left.acquireLease('artifact:abc', new AbortController().signal)
    let acquired = false
    const waiting = right.acquireLease('artifact:abc', new AbortController().signal).then((lease) => {
      acquired = true
      return lease
    })
    await Promise.resolve()
    expect(acquired).toBe(false)
    await owner.release()
    const follower = await waiting
    expect(acquired).toBe(true)
    await follower.release()

    const blocking = await left.acquireLease('catalog', new AbortController().signal)
    const abort = new AbortController()
    const cancelled = right.acquireLease('catalog', abort.signal)
    abort.abort('cancelled')
    await expect(cancelled).rejects.toBe('cancelled')
    await blocking.release()
  })

  it('publishes catalog bytes and trust state atomically with compare-and-swap', async () => {
    const [left, right] = await pair()
    const first = {
      sourceUrl: 'https://modules.example.test/catalog.json',
      responseBytes: new Uint8Array([1, 2, 3]),
      expiresAt: '2026-07-13T00:00:00.000Z',
      trustState: { highestSequence: 1, latestIssuedAt: '2026-07-12T00:00:00.000Z' },
      committedAt: 1,
    }
    await left.stageCatalog(first)
    expect(await left.publishCatalog(undefined)).toBe(true)
    expect(await right.readCatalog()).toEqual(first)

    await right.stageCatalog({ ...first, responseBytes: new Uint8Array([4]), trustState: { highestSequence: 2, latestIssuedAt: '2026-07-12T01:00:00.000Z' } })
    expect(await right.publishCatalog(undefined)).toBe(false)
    expect((await left.readCatalog())?.trustState.highestSequence).toBe(1)
    await right.discardStagedCatalog()
  })

  it('creates unique partials and compare-absent publishes one artifact winner', async () => {
    const [left, right] = await pair()
    const base = {
      sha256: 'a'.repeat(64),
      sourceUrl: 'https://modules.example.test/a.tar.gz',
      expectedSize: 3,
      updatedAt: 1,
    }
    const first = await left.createPartial(base)
    const second = await right.createPartial(base)
    expect(first.id).not.toBe(second.id)
    await left.appendPartial(first.id, new Uint8Array([1, 2, 3]), 2)
    await right.appendPartial(second.id, new Uint8Array([1, 2, 3]), 2)
    const artifact = { sha256: base.sha256, size: 3, committedAt: 3 }
    expect(await left.publishPartial(first.id, artifact)).toBe('published')
    expect(await right.publishPartial(second.id, artifact)).toBe('already-present')
    expect(await right.readArtifact(base.sha256)).toEqual(artifact)
    expect(await left.listPartials(base.sha256)).toEqual([])
  })
})
