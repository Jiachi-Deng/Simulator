import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'node-html-parser'

const rendererRoot = resolve(import.meta.dir, '../apps/electron/src/renderer')
const rendererOrigin = 'https://renderer.invalid'
const expectedScriptSources: Record<string, string[]> = {
  'browser-empty-state.html': ["'self'", "'unsafe-inline'", "'wasm-unsafe-eval'"],
  'browser-toolbar.html': ["'self'", "'unsafe-inline'", "'wasm-unsafe-eval'"],
  'index.html': ["'self'", "'unsafe-eval'", "'wasm-unsafe-eval'"],
  'playground.html': ["'self'", "'wasm-unsafe-eval'"],
}
const rendererHtmlFiles = readdirSync(rendererRoot)
  .filter((file) => file.endsWith('.html'))
  .sort()

function rendererScriptPolicyViolations(file: string, html: string): string[] {
  const violations: string[] = []
  const document = parse(html)
  const csp = document
    .querySelector('meta[http-equiv="Content-Security-Policy"]')
    ?.getAttribute('content')
  const scriptDirective = csp
    ?.split(';')
    .map((directive) => directive.trim().split(/\s+/))
    .find(([name]) => name === 'script-src')
  const actualSources = scriptDirective?.slice(1).sort() ?? []
  const expectedSources = expectedScriptSources[file]?.toSorted()

  if (!expectedSources) violations.push(`missing explicit script policy for ${file}`)
  if (!csp) violations.push('missing Content-Security-Policy')
  if (expectedSources && JSON.stringify(actualSources) !== JSON.stringify(expectedSources)) {
    violations.push(`unexpected script-src: ${actualSources.join(' ')}`)
  }

  for (const script of document.querySelectorAll('script:not([src])')) {
    if (/createElement\s*\(\s*['"]script['"]\s*\)/.test(script.text)) {
      violations.push('inline script creates a script element')
    }
    if (/document\.write\s*\(/.test(script.text)) {
      violations.push('inline script writes HTML')
    }
    if (/https?:\/\//.test(script.text)) violations.push('inline script contains a remote URL')
  }

  for (const script of document.querySelectorAll('script[src]')) {
    const src = script.getAttribute('src') ?? ''
    try {
      const url = new URL(src, `${rendererOrigin}/`)
      if (url.origin !== rendererOrigin) violations.push(`external script source: ${src}`)
    } catch {
      violations.push(`invalid script source: ${src}`)
    }
  }

  if (/(?:localhost|127\.0\.0\.1|\[::1\]):8097\b/i.test(html)) {
    violations.push('development script port is present')
  }

  return violations
}

describe('renderer HTML security baseline', () => {
  test('every renderer HTML entry has an explicit script policy', () => {
    expect(rendererHtmlFiles).toEqual(Object.keys(expectedScriptSources).sort())
  })

  for (const file of rendererHtmlFiles) {
    test(`${file} only loads scripts allowed by its packaged policy`, () => {
      const html = readFileSync(resolve(rendererRoot, file), 'utf8')
      expect(rendererScriptPolicyViolations(file, html)).toEqual([])
    })
  }

  test('rejects unsafe-eval when added to a Browser View', () => {
    const html = readFileSync(resolve(rendererRoot, 'browser-toolbar.html'), 'utf8')
      .replace("script-src 'self'", "script-src 'self' 'unsafe-eval'")
    expect(rendererScriptPolicyViolations('browser-toolbar.html', html)).toContain(
      "unexpected script-src: 'self' 'unsafe-eval' 'unsafe-inline' 'wasm-unsafe-eval'",
    )
  })

  test('rejects a protocol-relative external script source', () => {
    const html = readFileSync(resolve(rendererRoot, 'playground.html'), 'utf8')
      .replace('./playground.tsx', '//localhost:8098/devtools.js')
    expect(rendererScriptPolicyViolations('playground.html', html)).toContain(
      'external script source: //localhost:8098/devtools.js',
    )
  })
})
