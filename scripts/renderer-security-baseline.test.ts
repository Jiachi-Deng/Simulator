import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'node-html-parser'

const rendererRoot = resolve(import.meta.dir, '../apps/electron/src/renderer')
const allowedScriptSources = new Set([
  "'self'",
  "'unsafe-inline'",
  "'unsafe-eval'",
  "'wasm-unsafe-eval'",
])
const rendererHtmlFiles = readdirSync(rendererRoot).filter((file) => file.endsWith('.html'))

describe('renderer HTML security baseline', () => {
  for (const file of rendererHtmlFiles) {
    test(`${file} only loads scripts allowed by the packaged renderer policy`, () => {
      const html = readFileSync(resolve(rendererRoot, file), 'utf8')
      const document = parse(html)
      const csp = document
        .querySelector('meta[http-equiv="Content-Security-Policy"]')
        ?.getAttribute('content')
      const scriptDirective = csp
        ?.split(';')
        .map((directive) => directive.trim().split(/\s+/))
        .find(([name]) => name === 'script-src')
      const scriptSources = scriptDirective?.slice(1) ?? []

      expect(csp).toBeDefined()
      expect(scriptSources.length).toBeGreaterThan(0)
      expect(scriptSources.every((source) => allowedScriptSources.has(source))).toBe(true)
      for (const script of document.querySelectorAll('script:not([src])')) {
        expect(script.text).not.toMatch(/createElement\s*\(\s*['"]script['"]\s*\)/)
        expect(script.text).not.toMatch(/document\.write\s*\(/)
        expect(script.text).not.toMatch(/https?:\/\//)
      }

      for (const script of document.querySelectorAll('script[src]')) {
        const src = script.getAttribute('src') ?? ''
        expect(src.startsWith('./') || src.startsWith('/')).toBe(true)
      }

      expect(html).not.toMatch(/(?:localhost|127\.0\.0\.1|\[::1\]):8097\b/i)
    })
  }
})
