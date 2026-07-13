import { existsSync } from 'node:fs'
import { NodeFilesystemModuleDownloaderCache } from '../node-cache.ts'

const [root, gate] = process.argv.slice(2)
if (!root || !gate) throw new Error('Expected root and release gate')
const cache = new NodeFilesystemModuleDownloaderCache(root, { leasePollMs: 5 })
const lease = await cache.acquireLease('catalog', new AbortController().signal)
process.stdout.write(`acquired:${process.pid}\n`)
while (!existsSync(gate)) await new Promise((resolve) => setTimeout(resolve, 5))
await lease.release()
process.stdout.write(`released:${process.pid}\n`)
