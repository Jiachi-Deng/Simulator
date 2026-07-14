import { join } from 'node:path'
import type { OpenDesignDevelopmentBootstrap } from './open-design-development-bootstrap'

const PUBLIC_OPTIONAL_MODULES_DIRECTORY = 'optional-modules'
const OPEN_DESIGN_DEVELOPMENT_MODULES_DIRECTORY = 'open-design-development-modules'

export interface ResolveHostModuleStorageRootOptions {
  readonly userDataRoot: string
  readonly smokeRoot?: string
  readonly developmentBootstrapStatus: OpenDesignDevelopmentBootstrap['status']
}

/**
 * Keeps development-only OpenDesign state out of the public Optional Module
 * registry, cache, installation, coordinator journal, and module-data tree.
 * An explicit product-smoke root remains authoritative so the packaged smoke
 * continues to exercise the exact caller-owned trust boundary.
 */
export function resolveHostModuleStorageRoot(options: ResolveHostModuleStorageRootOptions): string {
  if (options.smokeRoot !== undefined) return options.smokeRoot
  return join(
    options.userDataRoot,
    options.developmentBootstrapStatus === 'ready'
      ? OPEN_DESIGN_DEVELOPMENT_MODULES_DIRECTORY
      : PUBLIC_OPTIONAL_MODULES_DIRECTORY,
  )
}
