import { describe, expect, it } from 'bun:test'
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
})
