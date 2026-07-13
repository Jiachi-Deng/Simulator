import { describe, expect, it } from 'bun:test'
import type { ModuleId, ModuleVersion } from '@simulator/module-contract'
import { ElectronModuleViewPort, type ElectronViewManagerPort } from '../electron-module-view-port'

function daemon() {
  return {
    id: 'org.simulator.electron-port' as ModuleId,
    version: '1.0.0' as ModuleVersion,
    state: 'healthy' as const,
    restartCount: 0,
    endpoint: { host: '127.0.0.1' as const, port: 43117 },
  }
}

describe('ElectronModuleViewPort', () => {
  it('waits for preload readiness and destroys the WebContentsView on detach', async () => {
    const records = new Map<string, any>()
    const manager: ElectronViewManagerPort = {
      async attach(options) {
        const snapshot = {
          moduleId: options.moduleId,
          viewInstanceId: options.viewInstanceId,
          frontendUrl: options.frontendUrl,
          allowedFrontendOrigins: options.allowedFrontendOrigins,
          partition: 'module-test',
          webContentsId: 7,
          rect: { x: 0, y: 0, width: 800, height: 600 },
          attached: true,
          visible: true,
          state: 'ready' as const,
        }
        records.set(options.viewInstanceId, snapshot)
        options.onReady?.(options)
        return snapshot
      },
      get(identity) {
        return records.get(identity.viewInstanceId)
      },
      destroy(identity) {
        return records.delete(identity.viewInstanceId)
      },
    }
    const hostWindow = { isDestroyed: () => false }
    const port = new ElectronModuleViewPort({ manager, hostWindow: () => hostWindow as any })
    const request = {
      moduleId: daemon().id,
      version: daemon().version,
      daemon: daemon(),
    }

    expect(await port.attach(request)).toMatchObject({ state: 'attached', version: '1.0.0' })
    expect([...records.values()][0]).toMatchObject({
      frontendUrl: 'http://127.0.0.1:43117/',
      allowedFrontendOrigins: ['http://127.0.0.1:43117'],
    })
    await port.detach(request.moduleId)
    expect(await port.query(request.moduleId)).toBeUndefined()
    expect(records.size).toBe(0)
  })

  it('reports quarantined renderer state as crashed', async () => {
    let snapshot: any
    const manager: ElectronViewManagerPort = {
      async attach(options) {
        snapshot = {
          ...options,
          partition: 'module-test',
          webContentsId: 8,
          rect: { x: 0, y: 0, width: 800, height: 600 },
          attached: true,
          visible: true,
          state: 'ready',
        }
        options.onReady?.(options)
        return snapshot
      },
      get: () => snapshot,
      destroy: () => { snapshot = undefined; return true },
    }
    const port = new ElectronModuleViewPort({
      manager,
      hostWindow: () => ({ isDestroyed: () => false }) as any,
    })
    const healthy = daemon()
    await port.attach({ moduleId: healthy.id, version: healthy.version, daemon: healthy })
    snapshot = { ...snapshot, state: 'crashed', attached: false, visible: false }
    expect(await port.query(healthy.id)).toMatchObject({ state: 'crashed' })
  })
})
