import { describe, expect, it } from 'bun:test'
import type { ModuleHealthStatus, ModuleLifecycleOperation, ModuleLifecycleState } from '../lifecycle.ts'
import { parseModuleManifest } from '../manifest.ts'
import { FakeModule } from './fake-module.ts'
import { GOLDEN_MODULE_MANIFEST_INPUT } from './golden-manifest.ts'

function createFakeModule(): FakeModule {
  const parsed = parseModuleManifest(GOLDEN_MODULE_MANIFEST_INPUT)
  if (!parsed.ok) throw new Error('Golden manifest is invalid')
  return new FakeModule(parsed.value)
}

const STATES = ['uninstalled', 'installed', 'running', 'stopped'] as const satisfies readonly ModuleLifecycleState[]
const OPERATIONS = ['install', 'start', 'health', 'stop'] as const satisfies readonly ModuleLifecycleOperation[]

type OperationExpectation =
  | { readonly invalid: true }
  | { readonly nextState: ModuleLifecycleState; readonly health?: ModuleHealthStatus }

const OPERATION_EXPECTATIONS = {
  uninstalled: {
    install: { nextState: 'installed' },
    start: { invalid: true },
    health: { nextState: 'uninstalled', health: 'not-running' },
    stop: { invalid: true },
  },
  installed: {
    install: { invalid: true },
    start: { nextState: 'running' },
    health: { nextState: 'installed', health: 'not-running' },
    stop: { invalid: true },
  },
  running: {
    install: { invalid: true },
    start: { invalid: true },
    health: { nextState: 'running', health: 'healthy' },
    stop: { nextState: 'stopped' },
  },
  stopped: {
    install: { invalid: true },
    start: { nextState: 'running' },
    health: { nextState: 'stopped', health: 'not-running' },
    stop: { invalid: true },
  },
} as const satisfies Record<ModuleLifecycleState, Record<ModuleLifecycleOperation, OperationExpectation>>

async function createFakeModuleInState(state: ModuleLifecycleState): Promise<FakeModule> {
  const module = createFakeModule()
  if (state === 'uninstalled') return module
  await module.install()
  if (state === 'installed') return module
  await module.start()
  if (state === 'running') return module
  await module.stop()
  return module
}

describe('FakeModule', () => {
  it('runs the deterministic install/start/health/stop lifecycle in memory', async () => {
    const module = createFakeModule()
    expect(module.state).toBe('uninstalled')
    expect(await module.health()).toEqual({ ok: true, value: { status: 'not-running', state: 'uninstalled' } })
    expect(await module.install()).toEqual({ ok: true, value: 'installed' })
    expect(await module.start()).toEqual({ ok: true, value: 'running' })
    expect(await module.health()).toEqual({ ok: true, value: { status: 'healthy', state: 'running' } })
    expect(await module.stop()).toEqual({ ok: true, value: 'stopped' })
    expect(await module.health()).toEqual({ ok: true, value: { status: 'not-running', state: 'stopped' } })
    expect(module.transitions).toEqual([
      { sequence: 1, operation: 'install', from: 'uninstalled', to: 'installed' },
      { sequence: 2, operation: 'start', from: 'installed', to: 'running' },
      { sequence: 3, operation: 'stop', from: 'running', to: 'stopped' },
    ])
  })

  it('can restart after a stop', async () => {
    const module = createFakeModule()
    await module.install()
    await module.start()
    await module.stop()
    expect(await module.start()).toEqual({ ok: true, value: 'running' })
    expect(module.transitions.at(-1)).toEqual({ sequence: 4, operation: 'start', from: 'stopped', to: 'running' })
  })

  for (const state of STATES) {
    for (const operation of OPERATIONS) {
      it(`${state} x ${operation} follows the complete lifecycle table`, async () => {
        const module = await createFakeModuleInState(state)
        const stateBefore = module.state
        const historyBefore = module.transitions
        expect(stateBefore).toBe(state)
        const expectation: OperationExpectation = OPERATION_EXPECTATIONS[state][operation]
        const result = await module[operation]()

        if ('invalid' in expectation) {
          expect(result).toEqual({
            ok: false,
            error: {
              code: 'INVALID_STATE',
              operation,
              state,
              message: `Cannot ${operation} module while state is ${state}`,
            },
          })
          expect(module.state).toBe(stateBefore)
          expect(module.transitions).toEqual(historyBefore)
          return
        }

        expect(module.state).toBe(expectation.nextState)
        if (operation === 'health') {
          if (!expectation.health) throw new Error(`Missing health expectation for ${state}`)
          expect(result).toEqual({
            ok: true,
            value: { status: expectation.health, state: expectation.nextState },
          })
          expect(module.transitions).toEqual(historyBefore)
        } else {
          expect(result).toEqual({ ok: true, value: expectation.nextState })
          expect(module.transitions).toHaveLength(historyBefore.length + 1)
        }
      })
    }
  }

  it('returns immutable results and transition snapshots', async () => {
    const module = createFakeModule()
    const result = await module.install()
    const transitions = module.transitions
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(transitions)).toBe(true)
    expect(Object.isFrozen(transitions[0])).toBe(true)
  })
})
