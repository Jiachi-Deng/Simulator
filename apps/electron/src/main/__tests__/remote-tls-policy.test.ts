import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const electronSrc = resolve(import.meta.dir, '../..')
const repositoryRoot = resolve(electronSrc, '../../..')

function read(relativePath: string): string {
  return readFileSync(resolve(repositoryRoot, relativePath), 'utf8')
}

describe('remote TLS security invariants', () => {
  it('does not expose certificate verification bypasses', () => {
    const sources = [
      read('packages/server-core/src/transport/client.ts'),
      read('apps/electron/src/main/handlers/workspace.ts'),
      read('apps/electron/src/preload/bootstrap.ts'),
    ].join('\n')
    const mainSource = read('apps/electron/src/main/index.ts')

    expect(sources).not.toContain('tlsRejectUnauthorized')
    expect(sources).not.toMatch(/rejectUnauthorized\s*:\s*false/)
    expect(mainSource).not.toContain("app.on('certificate-error'")
  })
})
