import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveBuildPolicy, writeBuildPolicy } from './build-policy'

describe('packaged build policy', () => {
  test('resolves a strict boolean from the build environment', () => {
    expect(resolveBuildPolicy({ SIMULATOR_DISABLE_UPDATES: '1' }).updatesDisabled).toBe(true)
    expect(resolveBuildPolicy({ SIMULATOR_DISABLE_UPDATES: 'true' }).updatesDisabled).toBe(false)
    expect(resolveBuildPolicy({}).updatesDisabled).toBe(false)
  })

  test('writes the exact policy consumed by the main build', () => {
    const root = mkdtempSync(join(tmpdir(), 'simulator-build-policy-'))
    try {
      const policy = resolveBuildPolicy({ SIMULATOR_DISABLE_UPDATES: '1' })
      const target = writeBuildPolicy(root, policy)
      expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual(policy)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('keeps every Windows build path on the same policy and marker protocol', () => {
    const windowsBuild = readFileSync(join(import.meta.dir, 'build', 'win32.ts'), 'utf8')
    const powershellBuild = readFileSync(
      join(import.meta.dir, '..', 'apps', 'electron', 'scripts', 'build-win.ps1'),
      'utf8',
    )
    for (const source of [windowsBuild, powershellBuild]) {
      expect(source).toContain('SIMULATOR_DISABLE_UPDATES')
      expect(source).toContain('build-policy')
    }
  })
})
