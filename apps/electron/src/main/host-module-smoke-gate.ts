export const HOST_MODULE_SMOKE_ACCEPTANCE_ENV = 'SIMULATOR_HOST_MODULE_ACCEPTANCE'
export const HOST_MODULE_SMOKE_ROOT_PREFIX = '--host-module-smoke-root='
export const HOST_MODULE_SMOKE_NODE_RUNTIME_PREFIX = '--host-module-smoke-node-runtime='

export interface HostModuleSmokeGateOptions {
  readonly argv: readonly string[]
  readonly env: Readonly<Record<string, string | undefined>>
}

/**
 * The coordinator smoke bypasses the downloader/installer trust path on purpose,
 * so it must never be selected by a command-line flag alone. Acceptance callers
 * must opt in independently through both the environment and debug argv.
 */
export function isHostModuleSmokeAcceptanceRequested(options: HostModuleSmokeGateOptions): boolean {
  if (options.env[HOST_MODULE_SMOKE_ACCEPTANCE_ENV] !== '1') return false
  if (!options.argv.includes('--debug')) return false
  return options.argv.some((value) => (
    value.startsWith(HOST_MODULE_SMOKE_ROOT_PREFIX)
    && value.length > HOST_MODULE_SMOKE_ROOT_PREFIX.length
  ))
}

export function resolveHostModuleSmokeNodeRuntime(options: HostModuleSmokeGateOptions): string | undefined {
  if (!isHostModuleSmokeAcceptanceRequested(options)) return undefined
  return options.argv
    .find((value) => value.startsWith(HOST_MODULE_SMOKE_NODE_RUNTIME_PREFIX))
    ?.slice(HOST_MODULE_SMOKE_NODE_RUNTIME_PREFIX.length)
}
