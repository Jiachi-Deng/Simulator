import { writeFileSync } from 'node:fs'
import { BrowserWindow, app } from 'electron'
import { ModuleViewManager, type ModuleViewFailure } from './module-view-manager'

const SMOKE_URL_PREFIX = '--module-view-smoke-url='
const SMOKE_RESULT_PREFIX = '--module-view-smoke-result='
const SMOKE_TIMEOUT_MS = 15_000

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

  let settled = false
  let manager: ModuleViewManager | undefined
  const finish = (result: Record<string, unknown>, exitCode: number) => {
    if (settled) return
    settled = true
    writeResult(resultPath, result)
    manager?.dispose()
    if (!hostWindow.isDestroyed()) hostWindow.destroy()
    app.exit(exitCode)
  }
  const fail = (failure: ModuleViewFailure) => {
    finish({ ok: false, failure, packaged: app.isPackaged }, 1)
  }

  manager = new ModuleViewManager({
    isPackaged: app.isPackaged,
    onFailure: fail,
    onReady: (identity) => {
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
        finish({
          ok: true,
          moduleId: identity.moduleId,
          viewInstanceId: identity.viewInstanceId,
          packaged: app.isPackaged,
        }, 0)
      }
    },
  })

  setTimeout(() => {
    finish({ ok: false, error: 'Module view smoke timed out', packaged: app.isPackaged }, 1)
  }, SMOKE_TIMEOUT_MS).unref()

  try {
    await manager.attach({
      moduleId: 'org.simulator.fixture',
      viewInstanceId: 'packaged-smoke-1',
      hostWindow,
      frontendUrl,
      allowedFrontendOrigins: [origin],
      rect: 'full-content',
      visible: false,
    })
  } catch (error) {
    finish({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      packaged: app.isPackaged,
    }, 1)
  }

  return true
}
