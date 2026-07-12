import { existsSync } from 'node:fs'
import { NodeFilesystemModuleDownloaderCache } from '../node-cache.ts'

const [root, staleGate, quarantineGate] = process.argv.slice(2)
if (!root || !staleGate || !quarantineGate) throw new Error('Expected root and two gate paths')
const cache = new NodeFilesystemModuleDownloaderCache(root, {
  staleLeaseMs: 1, leasePollMs: 5, now: () => 10_000,
  checkpoint: async (point) => {
    if (point === 'lease-stale-observed') {
      process.stdout.write('before-stale-rename\n')
      while (!existsSync(staleGate)) await new Promise((resolve) => setTimeout(resolve, 5))
    }
    if (point === 'lease-quarantined') {
      process.stdout.write('replacement-quarantined\n')
      while (!existsSync(quarantineGate)) await new Promise((resolve) => setTimeout(resolve, 5))
    }
  },
})
const lease = await cache.acquireLease('catalog', new AbortController().signal)
process.stdout.write('recoverer-acquired\n')
await lease.release()
