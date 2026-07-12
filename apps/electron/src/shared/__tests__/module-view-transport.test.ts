import { describe, expect, it } from 'bun:test'
import {
  MODULE_VIEW_LIMITS,
  createModuleViewMessageEnvelope,
  parseModuleViewEnvelope,
} from '../module-view-transport'

const identity = {
  moduleId: 'org.simulator.fake',
  viewInstanceId: 'view-1',
}

describe('module view transport contract', () => {
  it('rebuilds a valid versioned message envelope', () => {
    const parsed = createModuleViewMessageEnvelope(
      'module-to-host',
      identity.moduleId,
      identity.viewInstanceId,
      { action: 'ping', values: [1, true, null] },
    )

    expect(parsed).toEqual({
      ok: true,
      value: {
        version: 1,
        direction: 'module-to-host',
        ...identity,
        type: 'message',
        payload: { action: 'ping', values: [1, true, null] },
      },
    })
  })

  it('rejects unknown fields, directions, identities, and versions', () => {
    const valid = {
      version: 1,
      direction: 'module-to-host',
      ...identity,
      type: 'ready',
    }

    expect(parseModuleViewEnvelope({ ...valid, extra: true }).ok).toBe(false)
    expect(parseModuleViewEnvelope({ ...valid, version: 2 }).ok).toBe(false)
    expect(parseModuleViewEnvelope({ ...valid, direction: 'host-to-module' }, 'module-to-host').ok).toBe(false)
    expect(parseModuleViewEnvelope({ ...valid, moduleId: 'Fake' }).ok).toBe(false)
    expect(parseModuleViewEnvelope({ ...valid, viewInstanceId: '../other' }).ok).toBe(false)
  })

  it('rejects non-JSON values, accessors, cycles, and non-finite numbers', () => {
    const accessor = Object.defineProperty({}, 'secret', { enumerable: true, get: () => 'read' })
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle

    expect(createModuleViewMessageEnvelope('module-to-host', identity.moduleId, identity.viewInstanceId, undefined).ok).toBe(false)
    expect(createModuleViewMessageEnvelope('module-to-host', identity.moduleId, identity.viewInstanceId, accessor).ok).toBe(false)
    expect(createModuleViewMessageEnvelope('module-to-host', identity.moduleId, identity.viewInstanceId, cycle).ok).toBe(false)
    expect(createModuleViewMessageEnvelope('module-to-host', identity.moduleId, identity.viewInstanceId, Number.NaN).ok).toBe(false)
  })

  it('enforces string, array, object, depth, node, and aggregate limits', () => {
    const tooLongString = 'x'.repeat(MODULE_VIEW_LIMITS.maxStringBytes + 1)
    const tooLongArray = Array.from({ length: MODULE_VIEW_LIMITS.maxArrayLength + 1 }, () => null)
    const tooWideObject = Object.fromEntries(
      Array.from({ length: MODULE_VIEW_LIMITS.maxObjectKeys + 1 }, (_, index) => [`key${index}`, null]),
    )
    let tooDeep: unknown = null
    for (let index = 0; index <= MODULE_VIEW_LIMITS.maxDepth; index++) tooDeep = [tooDeep]
    const tooManyNodes = Array.from(
      { length: MODULE_VIEW_LIMITS.maxArrayLength },
      () => Array.from({ length: 5 }, () => null),
    )
    const tooManyBytes = Array.from(
      { length: 5 },
      () => 'x'.repeat(MODULE_VIEW_LIMITS.maxStringBytes),
    )

    for (const payload of [tooLongString, tooLongArray, tooWideObject, tooDeep, tooManyNodes, tooManyBytes]) {
      const result = createModuleViewMessageEnvelope(
        'module-to-host',
        identity.moduleId,
        identity.viewInstanceId,
        payload,
      )
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.code).toBe('PAYLOAD_LIMIT_EXCEEDED')
    }
  })
})
