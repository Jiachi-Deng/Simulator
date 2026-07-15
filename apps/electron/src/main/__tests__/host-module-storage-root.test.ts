import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { resolveHostModuleStorageRoot } from '../host-module-storage-root'

const USER_DATA_ROOT = '/private/tmp/simulator-user-data'

describe('resolveHostModuleStorageRoot', () => {
  it('uses the public root when development bootstrap is disabled or not ready', () => {
    const publicRoot = join(USER_DATA_ROOT, 'optional-modules')

    expect(resolveHostModuleStorageRoot({
      userDataRoot: USER_DATA_ROOT,
      developmentBootstrapStatus: 'disabled',
    })).toBe(publicRoot)
    expect(resolveHostModuleStorageRoot({
      userDataRoot: USER_DATA_ROOT,
      developmentBootstrapStatus: 'not-ready',
    })).toBe(publicRoot)
  })

  it('uses a disjoint development root only after the bundle is ready', () => {
    const publicRoot = resolveHostModuleStorageRoot({
      userDataRoot: USER_DATA_ROOT,
      developmentBootstrapStatus: 'disabled',
    })
    const developmentRoot = resolveHostModuleStorageRoot({
      userDataRoot: USER_DATA_ROOT,
      developmentBootstrapStatus: 'ready',
    })

    expect(developmentRoot).toBe(join(USER_DATA_ROOT, 'open-design-development-modules'))
    expect(developmentRoot).not.toBe(publicRoot)
    expect(relative(publicRoot, developmentRoot)).toBe(join('..', 'open-design-development-modules'))
    expect(relative(developmentRoot, publicRoot)).toBe(join('..', 'optional-modules'))
  })

  it('preserves the explicit host-module smoke root for every bootstrap status', () => {
    const smokeRoot = '/private/tmp/caller-owned-module-smoke-root'

    for (const developmentBootstrapStatus of ['disabled', 'not-ready', 'ready'] as const) {
      expect(resolveHostModuleStorageRoot({
        userDataRoot: USER_DATA_ROOT,
        smokeRoot,
        developmentBootstrapStatus,
      })).toBe(smokeRoot)
    }
  })

  it('rejects acceptance roots that overlap public or development storage', () => {
    const roots = [
      USER_DATA_ROOT,
      join(USER_DATA_ROOT, 'optional-modules'),
      join(USER_DATA_ROOT, 'optional-modules', 'nested'),
      join(USER_DATA_ROOT, 'open-design-development-modules'),
      join(USER_DATA_ROOT, 'open-design-development-modules', 'nested'),
    ]

    for (const smokeRoot of roots) {
      expect(() => resolveHostModuleStorageRoot({
        userDataRoot: USER_DATA_ROOT,
        smokeRoot,
        developmentBootstrapStatus: 'disabled',
      })).toThrow('acceptance root must be disjoint')
    }
  })

  it('rejects a symlink ancestor that aliases product storage', () => {
    const temporary = mkdtempSync(join(tmpdir(), 'simulator-module-root-test-'))
    try {
      const userDataRoot = join(temporary, 'user-data')
      const publicRoot = join(userDataRoot, 'optional-modules')
      const alias = join(temporary, 'alias')
      mkdirSync(publicRoot, { recursive: true })
      symlinkSync(userDataRoot, alias, 'dir')

      expect(() => resolveHostModuleStorageRoot({
        userDataRoot,
        smokeRoot: join(alias, 'optional-modules'),
        developmentBootstrapStatus: 'disabled',
      })).toThrow('acceptance root must be disjoint')
    } finally {
      rmSync(temporary, { recursive: true, force: true })
    }
  })
})
