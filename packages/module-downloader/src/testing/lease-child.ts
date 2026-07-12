import { NodeFilesystemModuleDownloaderCache } from '../node-cache.ts'

const [root, key, hold] = process.argv.slice(2)
if (!root || !key || !hold) throw new Error('Expected root, key and hold milliseconds')
const cache = new NodeFilesystemModuleDownloaderCache(root, { leasePollMs: 5 })
const lease = await cache.acquireLease(key, new AbortController().signal)
process.stdout.write(`acquired:${process.pid}\n`)
await new Promise((resolve) => setTimeout(resolve, Number(hold)))
await lease.release()
process.stdout.write(`released:${process.pid}\n`)
