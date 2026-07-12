import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const electronSrc = resolve(import.meta.dir, '../..')
const repositoryRoot = resolve(electronSrc, '../../..')

function read(relativePath: string): string {
  return readFileSync(resolve(repositoryRoot, relativePath), 'utf8')
}

// Keep this list scoped to production paths that create or configure remote clients.
// apps/webui/vite.config.ts is intentionally excluded: its secure:false setting belongs
// to a development-only proxy whose target is hard-coded to loopback, not a production
// remote connection or a certificate-verification bypass shipped in the client.
const PRODUCTION_REMOTE_PATHS = [
  'packages/server-core/src/transport/client.ts',
  'apps/electron/src/main/handlers/workspace.ts',
  'apps/electron/src/main/index.ts',
  'apps/electron/src/preload/bootstrap.ts',
] as const

describe('remote TLS security invariants', () => {
  it('does not expose certificate verification bypasses', () => {
    const sources = PRODUCTION_REMOTE_PATHS.map(read).join('\n')
    const mainSource = read('apps/electron/src/main/index.ts')

    expect(sources).not.toContain('tlsRejectUnauthorized')
    expect(sources).not.toMatch(/rejectUnauthorized\s*:\s*false/)
    expect(mainSource).not.toContain("app.on('certificate-error'")
  })

  it('does not log sensitive remote URLs', () => {
    const mainSource = read('apps/electron/src/main/index.ts')

    expect(mainSource).not.toContain('CRAFT_SERVER_URL=${process.env.CRAFT_SERVER_URL}')
    expect(mainSource).not.toContain('remote server: ${url}')
  })
})
