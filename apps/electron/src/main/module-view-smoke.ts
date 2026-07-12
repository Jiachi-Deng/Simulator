import { writeFileSync } from 'node:fs'
import { BrowserWindow, app, webContents } from 'electron'
import { ModuleViewManager, type ModuleViewFailure } from './module-view-manager'

const SMOKE_URL_PREFIX = '--module-view-smoke-url='
const SMOKE_RESULT_PREFIX = '--module-view-smoke-result='
const SMOKE_TIMEOUT_MS = 25_000
const MODULE_ID = 'org.simulator.fixture'

interface FixtureSmokeResult {
  readonly cookieWasEmpty: boolean
  readonly cookieBoundToView: boolean
  readonly cacheWasEmpty: boolean
  readonly cacheToken: string
  readonly allowedWebSocket: boolean
  readonly blockedWebSocket: boolean
}

function readArgument(prefix: string): string | undefined {
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length)
}

function writeResult(resultPath: string, result: Record<string, unknown>): void {
  writeFileSync(resultPath, `${JSON.stringify(result)}\n`, { encoding: 'utf8', mode: 0o600 })
}

export function isModuleViewSmokeRequested(): boolean {
  return process.argv.some((argument) => argument.startsWith(SMOKE_URL_PREFIX))
}

export async function runModuleViewSmokeIfRequested(): Promise<boolean> {
  const frontendUrl = readArgument(SMOKE_URL_PREFIX)
  if (!frontendUrl) return false

  const resultPath = readArgument(SMOKE_RESULT_PREFIX)
  if (!resultPath) throw new Error('Module view smoke requires --module-view-smoke-result')

  const origin = new URL(frontendUrl).origin
  const hostWindow = new BrowserWindow({
    width: 800,
    height: 600,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
      devTools: false,
    },
  })
  await hostWindow.loadURL(`data:text/html,${encodeURIComponent(`<!doctype html>
    <html><body style="margin:0"><button id="host-target" style="position:fixed;inset:0;width:100%;height:100%">host</button>
    <script>window.hostClicks=0;document.getElementById('host-target').addEventListener('click',()=>window.hostClicks++)</script>
    </body></html>`)}`)

  let settled = false
  let manager: ModuleViewManager | undefined
  let expectedCrashInstanceId: string | null = null
  let resolveExpectedCrash: (() => void) | null = null
  const responseResolvers = new Map<string, (result: FixtureSmokeResult) => void>()
  const recreateReadyResolvers = new Map<string, () => void>()
  const finish = (result: Record<string, unknown>, exitCode: number) => {
    if (settled) return
    settled = true
    writeResult(resultPath, result)
    manager?.dispose()
    if (!hostWindow.isDestroyed()) hostWindow.destroy()
    app.exit(exitCode)
  }
  const fail = (failure: ModuleViewFailure) => {
    if (failure.code === 'RENDERER_GONE' && failure.viewInstanceId === expectedCrashInstanceId) {
      expectedCrashInstanceId = null
      resolveExpectedCrash?.()
      resolveExpectedCrash = null
      return
    }
    finish({ ok: false, failure, packaged: app.isPackaged }, 1)
  }

  manager = new ModuleViewManager({
    isPackaged: app.isPackaged,
    onFailure: fail,
    onReady: (identity) => {
      const recreateReady = recreateReadyResolvers.get(identity.viewInstanceId)
      if (recreateReady) {
        recreateReadyResolvers.delete(identity.viewInstanceId)
        recreateReady()
        return
      }
      manager?.send(identity, { type: 'smoke-ping', nonce: 'module-view-smoke-v1' })
    },
    onMessage: (payload, identity) => {
      const message = payload as Readonly<Record<string, unknown>> | null
      if (
        message
        && typeof payload === 'object'
        && !Array.isArray(payload)
        && message.type === 'smoke-pong'
        && message.nonce === 'module-view-smoke-v1'
      ) {
        responseResolvers.get(identity.viewInstanceId)?.({
          cookieWasEmpty: message.cookieWasEmpty === true,
          cookieBoundToView: message.cookieBoundToView === true,
          cacheWasEmpty: message.cacheWasEmpty === true,
          cacheToken: typeof message.cacheToken === 'string' ? message.cacheToken : '',
          allowedWebSocket: message.allowedWebSocket === true,
          blockedWebSocket: message.blockedWebSocket === true,
        })
        responseResolvers.delete(identity.viewInstanceId)
      }
    },
  })

  setTimeout(() => {
    finish({ ok: false, error: 'Module view smoke timed out', packaged: app.isPackaged }, 1)
  }, SMOKE_TIMEOUT_MS).unref()

  try {
    const attachAndWait = async (viewInstanceId: string) => {
      const response = new Promise<FixtureSmokeResult>((resolve) => responseResolvers.set(viewInstanceId, resolve))
      const snapshot = await manager!.attach({
        moduleId: MODULE_ID,
        viewInstanceId,
        hostWindow,
        frontendUrl,
        allowedFrontendOrigins: [origin],
        rect: 'full-content',
        visible: true,
      })
      return { snapshot, result: await response }
    }

    const first = await attachAndWait('packaged-smoke-1')
    const second = await attachAndWait('packaged-smoke-2')
    const fixtureResults = [first.result, second.result]
    if (fixtureResults.some((result) => (
      !result.cookieWasEmpty
      || !result.cookieBoundToView
      || !result.cacheWasEmpty
      || !result.allowedWebSocket
      || !result.blockedWebSocket
    ))) {
      throw new Error(`Module view fixture isolation failed: ${JSON.stringify(fixtureResults)}`)
    }
    if (!first.result.cacheToken || !second.result.cacheToken || first.result.cacheToken === second.result.cacheToken) {
      throw new Error(`Module view cache partitions crossed: ${JSON.stringify(fixtureResults)}`)
    }

    manager.detach({ moduleId: MODULE_ID, viewInstanceId: 'packaged-smoke-1' })
    const clickHost = async () => {
      hostWindow.webContents.sendInputEvent({ type: 'mouseDown', x: 100, y: 100, button: 'left', clickCount: 1 })
      hostWindow.webContents.sendInputEvent({ type: 'mouseUp', x: 100, y: 100, button: 'left', clickCount: 1 })
      await new Promise((resolve) => setTimeout(resolve, 100))
      return hostWindow.webContents.executeJavaScript('window.hostClicks') as Promise<number>
    }
    const crashObserved = new Promise<void>((resolve) => { resolveExpectedCrash = resolve })
    expectedCrashInstanceId = 'packaged-smoke-2'
    const crashedWebContents = webContents.fromId(second.snapshot.webContentsId)
    if (!crashedWebContents) throw new Error('Module view WebContents disappeared before crash smoke')
    crashedWebContents.forcefullyCrashRenderer()
    await crashObserved
    if (await clickHost() !== 1) throw new Error('Quarantined module view still intercepted host pointer input')

    const recreatedReady = new Promise<void>((resolve) => recreateReadyResolvers.set('packaged-smoke-2', resolve))
    await manager.recreate({ moduleId: MODULE_ID, viewInstanceId: 'packaged-smoke-2' })
    await recreatedReady

    finish({
      ok: true,
      moduleId: MODULE_ID,
      viewInstances: ['packaged-smoke-1', 'packaged-smoke-2'],
      cookieIsolation: true,
      cacheIsolation: true,
      localWebSocket: true,
      deniedWebSocket: true,
      crashHitTesting: true,
      explicitRecreate: true,
      packaged: app.isPackaged,
    }, 0)
  } catch (error) {
    finish({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      packaged: app.isPackaged,
    }, 1)
  }

  return true
}
