import { readFileSync, writeFileSync } from 'node:fs'
import { BrowserWindow, app, webContents } from 'electron'
import { parseModuleManifest } from '@simulator/module-contract'
import { createHostModuleCoordinator, currentModulePlatform, type HostModuleCoordinatorRuntime } from './host-module-coordinator'
import { ModuleViewManager } from './module-view-manager'

const ROOT_PREFIX = '--host-module-smoke-root='
const MANIFEST_PREFIX = '--host-module-smoke-manifest='
const RESULT_PREFIX = '--host-module-smoke-result='
const TIMEOUT_MS = 30_000

function argument(prefix: string): string | undefined {
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length)
}

function writeResult(path: string, result: Record<string, unknown>): void {
  writeFileSync(path, `${JSON.stringify(result)}\n`, { encoding: 'utf8', mode: 0o600 })
}

export function isHostModuleCoordinatorSmokeRequested(): boolean {
  return process.argv.some((value) => value.startsWith(ROOT_PREFIX))
}

export function writeHostModuleCoordinatorSmokeBootMarker(): void {
  if (!isHostModuleCoordinatorSmokeRequested()) return
  const resultPath = argument(RESULT_PREFIX)
  if (resultPath) writeResult(resultPath, { ok: false, phase: 'main-loaded', packaged: app.isPackaged })
}

export async function runHostModuleCoordinatorSmokeIfRequested(): Promise<boolean> {
  const root = argument(ROOT_PREFIX)
  if (!root) return false
  const manifestPath = argument(MANIFEST_PREFIX)
  const resultPath = argument(RESULT_PREFIX)
  if (!manifestPath || !resultPath) throw new Error('Host module smoke requires manifest and result paths')

  const parsed = parseModuleManifest(JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown)
  if (!parsed.ok) throw new Error(`Host module smoke manifest is invalid: ${JSON.stringify(parsed.errors)}`)
  const manifest = parsed.value
  const builtInAgent = Object.freeze({ id: 'builtin-agent', revision: 1, available: true })
  const hostWindow = new BrowserWindow({
    width: 900,
    height: 700,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
      devTools: false,
    },
  })
  await hostWindow.loadURL(`data:text/html,${encodeURIComponent('<!doctype html><html><body>host</body></html>')}`)
  const manager = new ModuleViewManager({ isPackaged: app.isPackaged })
  let runtime: HostModuleCoordinatorRuntime | undefined
  let settled = false
  const finish = async (result: Record<string, unknown>, exitCode: number) => {
    if (settled) return
    settled = true
    await runtime?.dispose().catch(() => undefined)
    manager.dispose()
    if (!hostWindow.isDestroyed()) hostWindow.destroy()
    writeResult(resultPath, result)
    app.exit(exitCode)
  }
  setTimeout(() => void finish({ ok: false, error: 'Host module coordinator smoke timed out' }, 1), TIMEOUT_MS).unref()

  try {
    runtime = createHostModuleCoordinator({
      root,
      hostVersion: app.getVersion(),
      platform: currentModulePlatform(),
      trustedKeys: [],
      moduleViewManager: manager,
      hostWindow: () => hostWindow,
    })
    if (!runtime.registry.install(manifest, { hostVersionRange: '*' }).ok) throw new Error('Could not register smoke module')
    if (!runtime.registry.activate(manifest.id, manifest.version).ok) throw new Error('Could not activate smoke module')
    if (!runtime.registry.markLastKnownGood(manifest.id, manifest.version).ok) throw new Error('Could not mark smoke module last-known-good')

    const started = await runtime.coordinator.start({
      operationId: 'electron-product-smoke-start',
      moduleId: manifest.id,
    })
    if (!started.ok) throw new Error(started.error ?? 'Coordinator start failed')
    const view = manager.list()[0]
    if (!view || manager.list().length !== 1 || view.state !== 'ready' || !view.attached) {
      throw new Error(`Expected one ready attached WebContentsView: ${JSON.stringify(manager.list())}`)
    }
    const moduleWebContents = webContents.fromId(view.webContentsId)
    if (!moduleWebContents) throw new Error('Attached module WebContents was not found')
    const renderer = await moduleWebContents.executeJavaScript(`({
      text: document.querySelector('main')?.textContent,
      moduleId: window.simulatorModuleView?.moduleId,
      viewInstanceId: window.simulatorModuleView?.viewInstanceId,
      requireType: typeof require,
      processType: typeof process
    })`) as Record<string, unknown>
    const daemon = runtime.daemon.get(manifest.id)
    if (!daemon?.endpoint) throw new Error('Healthy daemon endpoint disappeared')
    const resource = await fetch(`http://${daemon.endpoint.host}:${daemon.endpoint.port}/resource/data.txt`)
    const resourceText = await resource.text()
    const webContentsId = view.webContentsId

    const stopped = await runtime.coordinator.stop({
      operationId: 'electron-product-smoke-stop',
      moduleId: manifest.id,
    })
    if (!stopped.ok) throw new Error(stopped.error ?? 'Coordinator stop failed')
    const orphan = manager.list().length !== 0 || webContents.fromId(webContentsId) !== undefined
    if (orphan) throw new Error('Coordinator stop left an orphan module WebContentsView')

    await finish({
      ok: true,
      packaged: app.isPackaged,
      coordinatorLifecycle: true,
      moduleId: manifest.id,
      renderer,
      resourceText,
      preloadIsolated: renderer.requireType === 'undefined' && renderer.processType === 'undefined',
      noOrphanWebContents: true,
      builtInAgentIndependent: builtInAgent.available === true && builtInAgent.revision === 1,
    }, 0)
  } catch (error) {
    await finish({
      ok: false,
      packaged: app.isPackaged,
      error: error instanceof Error ? error.message : String(error),
    }, 1)
  }
  return true
}
