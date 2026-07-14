import { existsSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { OpenDesignDevelopmentBootstrap } from './open-design-development-bootstrap'

const PUBLIC_OPTIONAL_MODULES_DIRECTORY = 'optional-modules'
const OPEN_DESIGN_DEVELOPMENT_MODULES_DIRECTORY = 'open-design-development-modules'

export interface ResolveHostModuleStorageRootOptions {
  readonly userDataRoot: string
  readonly smokeRoot?: string
  readonly developmentBootstrapStatus: OpenDesignDevelopmentBootstrap['status']
}

function pathContains(parent: string, candidate: string): boolean {
  const relation = relative(parent, candidate)
  return relation === '' || (relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation))
}

function canonicalPath(path: string): string {
  const unresolved: string[] = []
  let current = resolve(path)
  while (!existsSync(current)) {
    const parent = resolve(current, '..')
    if (parent === current) return current
    unresolved.unshift(current.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)))
    current = parent
  }
  return resolve(realpathSync.native(current), ...unresolved)
}

function assertSmokeRootIsIsolated(smokeRoot: string, userDataRoot: string): void {
  const smoke = canonicalPath(smokeRoot)
  const userData = canonicalPath(userDataRoot)
  if (pathContains(smoke, userData) || pathContains(userData, smoke)) {
    throw new Error('Host Module acceptance root must be disjoint from product Module storage')
  }
}

/**
 * Keeps development-only OpenDesign state out of the public Optional Module
 * registry, cache, installation, coordinator journal, and module-data tree.
 * An explicit product-smoke root remains authoritative so the packaged smoke
 * continues to exercise the exact caller-owned trust boundary.
 */
export function resolveHostModuleStorageRoot(options: ResolveHostModuleStorageRootOptions): string {
  const publicRoot = join(options.userDataRoot, PUBLIC_OPTIONAL_MODULES_DIRECTORY)
  const developmentRoot = join(options.userDataRoot, OPEN_DESIGN_DEVELOPMENT_MODULES_DIRECTORY)
  if (options.smokeRoot !== undefined) {
    assertSmokeRootIsIsolated(options.smokeRoot, options.userDataRoot)
    return options.smokeRoot
  }
  return options.developmentBootstrapStatus === 'ready' ? developmentRoot : publicRoot
}
