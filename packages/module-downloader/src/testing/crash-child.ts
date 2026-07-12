import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { NodeFilesystemModuleDownloaderCache, type NodeCacheCheckpoint } from '../node-cache.ts'

const [root, mode] = process.argv.slice(2)
if (!root || !mode) throw new Error('Expected root and crash mode')
let armed = false
const target = new Map<string, NodeCacheCheckpoint>([
  ['lease-owner', 'lease-owner-published'], ['lease-mkdir', 'lease-candidate-created'], ['lease-claim', 'lease-claim-published'],
  ['lease-quarantine', 'lease-quarantined'], ['artifact', 'artifact-destination-created'],
  ['catalog-generation', 'catalog-generation-written'], ['catalog-rename', 'catalog-pointer-renamed'],
]).get(mode)
if (!target) throw new Error(`Unknown crash mode: ${mode}`)
const cache = new NodeFilesystemModuleDownloaderCache(root, {
  staleLeaseMs: 1, leasePollMs: 5,
  checkpoint: async (point) => {
    if (!armed || point !== target) return
    process.stdout.write(`checkpoint:${point}\n`)
    await new Promise(() => undefined)
  },
})
await cache.readCatalog()

if (mode === 'lease-quarantine') {
  const hash = createHash('sha256').update('catalog').digest('hex'); const token = '00000000-0000-4000-8000-000000000000'
  const lock = join(root, 'leases', 'claims', `${hash}.lock`); await mkdir(lock)
  await writeFile(join(lock, 'claim.json'), JSON.stringify({ token }))
  await writeFile(join(root, 'leases', 'owners', `${token}.json`), JSON.stringify({ token, pid: 999_999_999, acquiredAt: 0 }))
}

if (mode.startsWith('lease-')) {
  armed = true; await cache.acquireLease('catalog', new AbortController().signal
  )
} else if (mode === 'artifact') {
  const bytes = Buffer.from('crash artifact'); const sha256 = createHash('sha256').update(bytes).digest('hex')
  const partial = await cache.createPartial({ sha256, sourceUrl: 'https://example.test/a', expectedSize: bytes.length, updatedAt: 1 })
  await cache.appendPartial(partial.id, bytes, 2); armed = true
  await cache.publishPartial(partial.id, { sha256, size: bytes.length, committedAt: 3 })
} else {
  await cache.stageCatalog(catalog(1)); await cache.publishCatalog(undefined)
  await cache.stageCatalog(catalog(2)); armed = true; await cache.publishCatalog({ highestSequence: 1, latestIssuedAt: '2029-01-01T00:00:00.000Z' })
}

function catalog(sequence: number) {
  return { sourceUrl: `https://example.test/${sequence}`, responseBytes: new Uint8Array([sequence]), expiresAt: '2030-01-01T00:00:00.000Z', trustState: { highestSequence: sequence, latestIssuedAt: '2029-01-01T00:00:00.000Z' }, committedAt: sequence }
}
