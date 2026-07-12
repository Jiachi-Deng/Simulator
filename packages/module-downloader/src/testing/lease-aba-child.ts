import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { NodeFilesystemModuleDownloaderCache } from '../node-cache.ts'

const [root, gate] = process.argv.slice(2)
if (!root || !gate) throw new Error('Expected root and gate path')
let renames = 0
const cache = new NodeFilesystemModuleDownloaderCache(root, {
  staleLeaseMs: 1, leasePollMs: 5, now: () => 10_000,
  faultInjector: async (point) => {
    if (point !== 'rename' || ++renames !== 2) return
    process.stdout.write('before-stale-rename\n')
    while (!existsSync(gate)) await new Promise((resolve) => setTimeout(resolve, 5))
  },
})
const lease = await cache.acquireLease('catalog', new AbortController().signal)
process.stdout.write('recoverer-acquired\n')
await lease.release()
