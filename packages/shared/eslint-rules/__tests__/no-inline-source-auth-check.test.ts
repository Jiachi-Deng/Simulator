import { describe, expect, it } from 'bun:test'
import { Linter } from 'eslint'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const rule = require('../no-inline-source-auth-check.cjs')

function runRule(code: string) {
  const linter = new Linter({ configType: 'eslintrc' })
  linter.defineRule('craft-shared/no-inline-source-auth-check', rule)

  return linter.verify(
    code,
    {
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
      rules: {
        'craft-shared/no-inline-source-auth-check': 'error',
      },
    },
    '/repo/packages/shared/src/sources/source-state.ts',
  )
}

describe('no-inline-source-auth-check', () => {
  it('allows direct assignment when updating auth state', () => {
    expect(runRule('source.config.isAuthenticated = true')).toHaveLength(0)
  })

  it('flags compound assignment to auth state', () => {
    expect(runRule('source.config.isAuthenticated += 1')).toHaveLength(1)
    expect(runRule('source.config.isAuthenticated ||= fallback')).toHaveLength(1)
  })

  it('continues to flag direct auth-state reads', () => {
    const messages = runRule('const usable = source.config.isAuthenticated')
    expect(messages).toHaveLength(1)
    expect(messages[0]?.message).toContain('Use isSourceUsable()')
  })
})
