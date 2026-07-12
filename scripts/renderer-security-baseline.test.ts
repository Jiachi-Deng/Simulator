import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const rendererRoot = resolve(import.meta.dir, '../apps/electron/src/renderer')

describe('renderer HTML security baseline', () => {
  for (const file of ['index.html', 'playground.html']) {
    test(`${file} does not load scripts from a local development port`, () => {
      const html = readFileSync(resolve(rendererRoot, file), 'utf8')

      expect(html).not.toContain('localhost:8097')
      expect(html).not.toMatch(/createElement\(['"]script['"]\)/)
      expect(html).not.toContain("'unsafe-eval'")
      expect(html).not.toContain("script-src 'self' 'unsafe-inline'")
    })
  }
})
