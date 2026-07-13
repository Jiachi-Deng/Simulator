import { describe, expect, it } from 'bun:test'
import type { ModuleId, ModuleVersion } from '@simulator/module-contract'
import { LoopbackFrontendModuleViewPort } from './loopback-view.ts'

const id = 'org.simulator.frontend' as ModuleId
const version = '1.0.0' as ModuleVersion
const daemon = Object.freeze({
  id,
  version,
  state: 'healthy' as const,
  endpoint: { host: '127.0.0.1' as const, port: 41_000 },
  restartCount: 0,
})

describe('LoopbackFrontendModuleViewPort', () => {
  it('attaches a real HTML response and supports query, crash, and detach lifecycle', async () => {
    const requests: string[] = []
    const view = new LoopbackFrontendModuleViewPort({
      fetch: async (input) => {
        requests.push(String(input))
        return new Response('<!doctype html><title>Fake Module</title>', {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        })
      },
    })
    expect(await view.attach({ moduleId: id, version, daemon })).toMatchObject({ state: 'attached' })
    expect(requests).toEqual(['http://127.0.0.1:41000/'])
    expect(view.document(id)?.html).toContain('Fake Module')
    expect(view.markCrashed(id)).toMatchObject({ state: 'crashed' })
    expect(await view.query(id)).toMatchObject({ state: 'crashed' })
    await view.detach(id)
    expect(await view.query(id)).toMatchObject({ state: 'detached' })
  })

  it('fails closed and records a crashed view for invalid frontend content', async () => {
    const view = new LoopbackFrontendModuleViewPort({
      fetch: async () => new Response('{}', { headers: { 'content-type': 'application/json' } }),
    })
    await expect(view.attach({ moduleId: id, version, daemon })).rejects.toThrow('text/html')
    expect(await view.query(id)).toMatchObject({ state: 'crashed' })
  })
})
