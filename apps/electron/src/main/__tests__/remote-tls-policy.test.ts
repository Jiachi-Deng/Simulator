import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const electronSrc = resolve(import.meta.dir, '../..')
const repositoryRoot = resolve(electronSrc, '../../..')

function read(relativePath: string): string {
  return readFileSync(resolve(repositoryRoot, relativePath), 'utf8')
}

// Exhaustive production outbound WebSocket surface: shared policy/client, CLI,
// Electron client construction/routing, and the browser WebUI adapter.
// apps/webui/vite.config.ts is intentionally excluded: its secure:false setting belongs
// to a development-only proxy whose target is hard-coded to loopback, not a production
// remote connection or a certificate-verification bypass shipped in the client.
const PRODUCTION_OUTBOUND_PATHS = [
  'packages/server-core/src/transport/websocket-url-policy.ts',
  'packages/server-core/src/transport/client.ts',
  'apps/cli/src/client.ts',
  'apps/cli/src/index.ts',
  'apps/electron/src/main/handlers/workspace.ts',
  'apps/electron/src/preload/bootstrap.ts',
  'apps/electron/src/transport/routed-client.ts',
  'apps/webui/src/adapter/web-api.ts',
] as const

describe('remote TLS security invariants', () => {
  it('does not expose certificate verification bypasses', () => {
    const sources = PRODUCTION_OUTBOUND_PATHS.map(read).join('\n')
    const mainSource = read('apps/electron/src/main/index.ts')

    expect(sources).not.toContain('tlsRejectUnauthorized')
    expect(sources).not.toMatch(/rejectUnauthorized\s*:\s*false/)
    expect(sources).not.toContain('NODE_TLS_REJECT_UNAUTHORIZED')
    expect(sources).not.toContain('lastClose.reason')
    expect(sources).not.toMatch(/\.data\s*=\s*envelope\.error\.data/)
    expect(mainSource).not.toContain("app.on('certificate-error'")
  })

  it('allows insecure transport only as an explicit standalone inbound opt-in, never as an outbound bypass', () => {
    const outboundSources = PRODUCTION_OUTBOUND_PATHS.map(read).join('\n')
    const inboundServerSource = read('packages/server/src/index.ts')

    expect(inboundServerSource).toContain("process.argv.includes('--allow-insecure-bind')")
    expect(outboundSources).not.toContain('--allow-insecure-bind')
  })

  it('does not log sensitive remote URLs', () => {
    const mainSource = read('apps/electron/src/main/index.ts')

    expect(mainSource).not.toContain('CRAFT_SERVER_URL=${process.env.CRAFT_SERVER_URL}')
    expect(mainSource).not.toContain('remote server: ${url}')
  })
})
