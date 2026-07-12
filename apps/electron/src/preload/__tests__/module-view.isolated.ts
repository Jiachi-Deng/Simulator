// Runs separately because Bun's Electron module mocks are process-global.
import { describe, expect, it, mock } from 'bun:test'

const exposed: Record<string, any> = {}
const sent: Array<[string, unknown]> = []
const listeners = new Map<string, (event: unknown, envelope: unknown) => void>()

mock.module('electron', () => ({
  contextBridge: {
    exposeInMainWorld: mock((name: string, api: unknown) => { exposed[name] = api }),
  },
  ipcRenderer: {
    send: mock((channel: string, envelope: unknown) => sent.push([channel, envelope])),
    on: mock((channel: string, listener: (event: unknown, envelope: unknown) => void) => listeners.set(channel, listener)),
  },
}))

process.argv.push(
  '--simulator-module-id=org.simulator.fake',
  '--simulator-view-instance-id=fixture-1',
)

await import('../module-view')

describe('module view preload', () => {
  it('exposes only the bound narrow API and announces readiness', () => {
    const api = exposed.simulatorModuleView
    expect(Object.keys(api).sort()).toEqual(['moduleId', 'onMessage', 'send', 'version', 'viewInstanceId'])
    expect(api).toMatchObject({
      version: 1,
      moduleId: 'org.simulator.fake',
      viewInstanceId: 'fixture-1',
    })
    expect(sent[0]).toEqual(['module-view:to-host', {
      version: 1,
      direction: 'module-to-host',
      moduleId: 'org.simulator.fake',
      viewInstanceId: 'fixture-1',
      type: 'ready',
    }])
  })

  it('validates outbound payloads and sends a bound envelope', () => {
    const api = exposed.simulatorModuleView
    api.send({ action: 'ping' })
    expect(sent.at(-1)).toEqual(['module-view:to-host', {
      version: 1,
      direction: 'module-to-host',
      moduleId: 'org.simulator.fake',
      viewInstanceId: 'fixture-1',
      type: 'message',
      payload: { action: 'ping' },
    }])
    expect(() => api.send(undefined)).toThrow(TypeError)
    expect(() => api.send('x'.repeat(17 * 1024))).toThrow(TypeError)
  })

  it('delivers only matching host messages and reports cross-talk', () => {
    const received: unknown[] = []
    const unsubscribe = exposed.simulatorModuleView.onMessage((payload: unknown) => received.push(payload))
    const listener = listeners.get('module-view:to-module')!
    const envelope = {
      version: 1,
      direction: 'host-to-module',
      moduleId: 'org.simulator.fake',
      viewInstanceId: 'fixture-1',
      type: 'message',
      payload: { command: 'refresh' },
    }

    listener({}, envelope)
    expect(received).toEqual([{ command: 'refresh' }])
    listener({}, { ...envelope, viewInstanceId: 'fixture-2' })
    expect(received).toHaveLength(1)
    expect(sent.at(-1)).toEqual(['module-view:to-host', expect.objectContaining({
      type: 'failure',
      error: expect.objectContaining({ code: 'CROSS_TALK_BLOCKED' }),
    })])

    unsubscribe()
    listener({}, envelope)
    expect(received).toHaveLength(1)
  })
})
