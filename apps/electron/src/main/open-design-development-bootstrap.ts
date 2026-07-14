import {
  loadDevelopmentModuleBundle,
  type LoadedDevelopmentModuleBundle,
} from './development-module-bundle'
import { OPEN_DESIGN_MODULE_ID } from '../shared/open-design-module-ipc'

export const OPEN_DESIGN_DEVELOPMENT_BUNDLE_ARGUMENT = '--open-design-module-bundle=' as const

export type OpenDesignDevelopmentBootstrap =
  | { readonly status: 'disabled' }
  | { readonly status: 'not-ready'; readonly errorCode: string; readonly errorMessage: string }
  | { readonly status: 'ready'; readonly bundle: LoadedDevelopmentModuleBundle }

export interface LoadOpenDesignDevelopmentBootstrapOptions {
  readonly argv: readonly string[]
  readonly platform: string
  readonly loadBundle?: typeof loadDevelopmentModuleBundle
}

/**
 * Keeps local development trust opt-in and platform-scoped. The descriptor path
 * stays in the main process and is never returned in diagnostics.
 */
export async function loadOpenDesignDevelopmentBootstrap(
  options: LoadOpenDesignDevelopmentBootstrapOptions,
): Promise<OpenDesignDevelopmentBootstrap> {
  const explicitDebug = options.argv.includes('--debug')
  const bundleArguments = options.argv.filter((argument) => argument.startsWith(OPEN_DESIGN_DEVELOPMENT_BUNDLE_ARGUMENT))
  if (!explicitDebug || bundleArguments.length === 0) return Object.freeze({ status: 'disabled' })
  if (bundleArguments.length !== 1) return notReady('DEVELOPMENT_BUNDLE_ARGUMENT_INVALID')
  if (options.platform !== 'darwin-arm64') return notReady('DEVELOPMENT_BUNDLE_PLATFORM_UNSUPPORTED')

  const descriptorPath = bundleArguments[0]!.slice(OPEN_DESIGN_DEVELOPMENT_BUNDLE_ARGUMENT.length)
  if (descriptorPath.length === 0) return notReady('DEVELOPMENT_BUNDLE_ARGUMENT_INVALID')

  try {
    const bundle = await (options.loadBundle ?? loadDevelopmentModuleBundle)({
      descriptorPath,
      expectedModuleId: OPEN_DESIGN_MODULE_ID,
    })
    if (bundle.release.platform !== 'darwin-arm64' || bundle.release.moduleId !== OPEN_DESIGN_MODULE_ID) {
      return notReady('DEVELOPMENT_BUNDLE_TARGET_MISMATCH')
    }
    return Object.freeze({ status: 'ready', bundle })
  } catch {
    return notReady('DEVELOPMENT_BUNDLE_VERIFICATION_FAILED')
  }
}

function notReady(errorCode: string): OpenDesignDevelopmentBootstrap {
  return Object.freeze({
    status: 'not-ready',
    errorCode,
    errorMessage: 'The OpenDesign development bundle is not ready.',
  })
}
