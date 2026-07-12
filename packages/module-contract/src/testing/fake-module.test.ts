import { describe, expect, it } from 'bun:test'
import { parseModuleManifest } from '../manifest.ts'
import { FakeModule } from './fake-module.ts'
import { GOLDEN_MODULE_MANIFEST_INPUT } from './golden-manifest.ts'

function createFakeModule(): FakeModule {
  const parsed = parseModuleManifest(GOLDEN_MODULE_MANIFEST_INPUT)
  if (!parsed.ok) throw new Error('Golden manifest is invalid')
  return new FakeModule(parsed.value)
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

  it('fails invalid transitions without changing state or history', async () => {
    const module = createFakeModule()
    expect(await module.start()).toEqual({
      ok: false,
      error: {
        code: 'INVALID_STATE',
        operation: 'start',
        state: 'uninstalled',
        message: 'Cannot start module while state is uninstalled',
      },
    })
    expect(await module.stop()).toEqual({
      ok: false,
      error: {
        code: 'INVALID_STATE',
        operation: 'stop',
        state: 'uninstalled',
        message: 'Cannot stop module while state is uninstalled',
      },
    })
    expect(module.state).toBe('uninstalled')
    expect(module.transitions).toEqual([])
  })

  it('returns immutable results and transition snapshots', async () => {
    const module = createFakeModule()
    const result = await module.install()
    const transitions = module.transitions
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(transitions)).toBe(true)
    expect(Object.isFrozen(transitions[0])).toBe(true)
  })
})
