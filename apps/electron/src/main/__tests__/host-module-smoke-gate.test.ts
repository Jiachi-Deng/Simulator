import { describe, expect, it } from 'bun:test'
import {
  HOST_MODULE_SMOKE_ACCEPTANCE_ENV,
  isHostModuleSmokeAcceptanceRequested,
  resolveHostModuleSmokeNodeRuntime,
} from '../host-module-smoke-gate'

const ROOT_ARGUMENT = '--host-module-smoke-root=/private/tmp/simulator-module-acceptance'
const NODE_ARGUMENT = '--host-module-smoke-node-runtime=/private/tmp/acceptance-node'

describe('host Module smoke acceptance gate', () => {
  it('requires an independent environment opt-in and debug argument', () => {
    expect(isHostModuleSmokeAcceptanceRequested({
      argv: ['Simulator', '--debug', ROOT_ARGUMENT],
      env: { [HOST_MODULE_SMOKE_ACCEPTANCE_ENV]: '1' },
    })).toBe(true)

    expect(isHostModuleSmokeAcceptanceRequested({
      argv: ['Simulator', ROOT_ARGUMENT],
      env: { [HOST_MODULE_SMOKE_ACCEPTANCE_ENV]: '1' },
    })).toBe(false)
    expect(isHostModuleSmokeAcceptanceRequested({
      argv: ['Simulator', '--debug', ROOT_ARGUMENT],
      env: {},
    })).toBe(false)
    expect(isHostModuleSmokeAcceptanceRequested({
      argv: ['Simulator', '--debug', '--host-module-smoke-root='],
      env: { [HOST_MODULE_SMOKE_ACCEPTANCE_ENV]: '1' },
    })).toBe(false)
  })

  it('does not expose a runtime override unless the full gate is enabled', () => {
    expect(resolveHostModuleSmokeNodeRuntime({
      argv: ['Simulator', '--debug', ROOT_ARGUMENT, NODE_ARGUMENT],
      env: { [HOST_MODULE_SMOKE_ACCEPTANCE_ENV]: '1' },
    })).toBe('/private/tmp/acceptance-node')

    expect(resolveHostModuleSmokeNodeRuntime({
      argv: ['Simulator', '--debug', ROOT_ARGUMENT, NODE_ARGUMENT],
      env: {},
    })).toBeUndefined()
    expect(resolveHostModuleSmokeNodeRuntime({
      argv: ['Simulator', ROOT_ARGUMENT, NODE_ARGUMENT],
      env: { [HOST_MODULE_SMOKE_ACCEPTANCE_ENV]: '1' },
    })).toBeUndefined()
    expect(resolveHostModuleSmokeNodeRuntime({
      argv: ['Simulator', '--debug', NODE_ARGUMENT],
      env: { [HOST_MODULE_SMOKE_ACCEPTANCE_ENV]: '1' },
    })).toBeUndefined()
  })
})
