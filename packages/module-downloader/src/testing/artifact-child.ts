import { createHash } from 'node:crypto'
import { NodeFilesystemModuleDownloaderCache } from '../node-cache.ts'

const [root, contents, hold] = process.argv.slice(2)
if (!root || contents === undefined || hold === undefined) throw new Error('Expected root, contents and hold milliseconds')
const bytes = Buffer.from(contents)
const sha256 = createHash('sha256').update(bytes).digest('hex')
const cache = new NodeFilesystemModuleDownloaderCache(root, { leasePollMs: 5 })
const lease = await cache.acquireLease(`artifact:${sha256}`, new AbortController().signal)
try {
  const existing = await cache.readArtifact(sha256)
  if (existing) {
    process.stdout.write(`verified-reader:${existing.sha256}\n`)
  } else {
    const partial = await cache.createPartial({ sha256, sourceUrl: 'https://example.test/artifact', expectedSize: bytes.length, updatedAt: Date.now() })
    await cache.appendPartial(partial.id, bytes, Date.now())
    await new Promise((resolve) => setTimeout(resolve, Number(hold)))
    await cache.publishPartial(partial.id, { sha256, size: bytes.length, committedAt: Date.now() })
    process.stdout.write(`publisher:${sha256}\n`)
  }
} finally {
  await lease.release()
}
