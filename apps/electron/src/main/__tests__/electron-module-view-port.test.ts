import { describe, expect, it, mock } from 'bun:test'
import type { ModuleId, ModuleVersion } from '@simulator/module-contract'
import { ElectronModuleViewPort, type ElectronViewManagerPort } from '../electron-module-view-port'

function daemon(id = 'org.simulator.electron-port' as ModuleId) {
  return {
    id,
    version: '1.0.0' as ModuleVersion,
    state: 'healthy' as const,
    restartCount: 0,
    endpoint: { host: '127.0.0.1' as const, port: 43117 },
  }
}

function createManagerHarness() {
  const records = new Map<string, any>()
  const attachedOptions: any[] = []
  const manager: ElectronViewManagerPort = {
    async attach(options) {
      attachedOptions.push(options)
      const snapshot = {
        ...options,
        partition: `module-test-${attachedOptions.length}`,
        webContentsId: attachedOptions.length,
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
  return { attachedOptions, manager, records }
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

  it('routes only an exact host.close payload from the currently bound module identity', async () => {
    const harness = createManagerHarness()
    const onHostClose = mock((_moduleId: ModuleId) => {})
    const port = new ElectronModuleViewPort({
      manager: harness.manager,
      hostWindow: () => ({ isDestroyed: () => false }) as any,
      onHostClose,
    })
    const firstDaemon = daemon('org.simulator.module-one' as ModuleId)
    await port.attach({ moduleId: firstDaemon.id, version: firstDaemon.version, daemon: firstDaemon })
    const firstAttach = harness.attachedOptions.at(-1)
    const firstIdentity = { moduleId: firstAttach.moduleId, viewInstanceId: firstAttach.viewInstanceId }

    firstAttach.onMessage?.({ type: 'host.close' }, firstIdentity)
    expect(onHostClose).toHaveBeenCalledTimes(1)
    expect(onHostClose).toHaveBeenCalledWith(firstDaemon.id)

    for (const payload of [
      null,
      'host.close',
      ['host.close'],
      {},
      { type: 'host.close', operationId: 'module-controlled' },
      { type: 'host.close', moduleId: firstDaemon.id },
      { type: 'host.close', path: '/tmp/module-controlled' },
      { type: 'host.close', extra: null },
      { type: 'HOST.CLOSE' },
    ]) {
      firstAttach.onMessage?.(payload, firstIdentity)
    }

    const secondDaemon = daemon('org.simulator.module-two' as ModuleId)
    await port.attach({ moduleId: secondDaemon.id, version: secondDaemon.version, daemon: secondDaemon })
    const secondAttach = harness.attachedOptions.at(-1)
    firstAttach.onMessage?.({ type: 'host.close' }, {
      moduleId: secondAttach.moduleId,
      viewInstanceId: secondAttach.viewInstanceId,
    })

    await port.attach({ moduleId: firstDaemon.id, version: firstDaemon.version, daemon: firstDaemon })
    firstAttach.onMessage?.({ type: 'host.close' }, firstIdentity)
    expect(onHostClose).toHaveBeenCalledTimes(1)
  })

  it('contains asynchronous host.close callback failures and reports them through the injected handler', async () => {
    const harness = createManagerHarness()
    const callbackError = new Error('coordinator stop failed')
    const onHostCloseError = mock((_error: unknown, _moduleId: ModuleId) => {})
    const port = new ElectronModuleViewPort({
      manager: harness.manager,
      hostWindow: () => ({ isDestroyed: () => false }) as any,
      onHostClose: async () => { throw callbackError },
      onHostCloseError,
    })
    const healthy = daemon()
    await port.attach({ moduleId: healthy.id, version: healthy.version, daemon: healthy })
    const attached = harness.attachedOptions.at(-1)

    attached.onMessage?.({ type: 'host.close' }, {
      moduleId: attached.moduleId,
      viewInstanceId: attached.viewInstanceId,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(onHostCloseError).toHaveBeenCalledTimes(1)
    expect(onHostCloseError).toHaveBeenCalledWith(callbackError, healthy.id)
    expect(await port.query(healthy.id)).toMatchObject({ state: 'attached' })
    expect(harness.records.size).toBe(1)
  })
})
