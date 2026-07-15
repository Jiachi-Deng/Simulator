import { createServer, type Server } from 'node:http'
import { createConnection } from 'node:net'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { BrowserWindow, app, webContents } from 'electron'
import { parseModuleManifest } from '@simulator/module-contract'
import type { SessionManager } from '@craft-agent/server-core/sessions'
import { addLlmConnection, getWorkspaces, setDefaultLlmConnection } from '@craft-agent/shared/config'
import type { HostModuleCoordinatorRuntime } from './host-module-coordinator'
import type { ModuleViewManager } from './module-view-manager'
import type { HostModuleAgentRuntime } from './module-agent-runtime'
import {
  HOST_MODULE_SMOKE_ROOT_PREFIX,
  isHostModuleSmokeAcceptanceRequested,
  resolveHostModuleSmokeNodeRuntime,
} from './host-module-smoke-gate'

const MANIFEST_PREFIX = '--host-module-smoke-manifest='
const RESULT_PREFIX = '--host-module-smoke-result='
const TIMEOUT_MS = 40_000
const AGENT_REPLY = 'deterministic built-in Agent response'

interface SmokeRuntime {
  readonly runtime: HostModuleCoordinatorRuntime
  readonly manager: ModuleViewManager
  readonly sessionManager: SessionManager
  readonly hostWindow: BrowserWindow
  readonly serverHost: string
  readonly serverPort: number
  readonly moduleAgentRuntime: HostModuleAgentRuntime
}

interface CleanupEvidence {
  readonly coordinatorDrained: boolean
  readonly sessionFlushed: boolean
  readonly serverStopped: boolean
  readonly viewsDisposed: boolean
  readonly moduleAgentStopped: boolean
}

let pendingResult: Record<string, unknown> | undefined
let pendingResultPath: string | undefined
let beforeQuitEventCount = 0

function argument(prefix: string): string | undefined {
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length)
}

function writeResult(path: string, result: Record<string, unknown>): void {
  writeFileSync(path, `${JSON.stringify(result)}\n`, { encoding: 'utf8', mode: 0o600 })
}

function waitFor(predicate: () => boolean, description: string, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    const poll = () => {
      if (predicate()) return resolve()
      if (Date.now() >= deadline) return reject(new Error(`Timed out waiting for ${description}`))
      setTimeout(poll, 25)
    }
    poll()
  })
}

async function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port })
    const done = (result: boolean) => {
      socket.destroy()
      resolve(result)
    }
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
    socket.setTimeout(2_000, () => done(false))
  })
}

async function listen(server: Server): Promise<{ host: string; port: number }> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fake provider did not bind TCP')
  return { host: address.address, port: address.port }
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

function createDeterministicProvider(): Server {
  return createServer((request, response) => {
    if (request.method === 'GET' && request.url?.endsWith('/models')) {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ object: 'list', data: [{ id: 'simulator-smoke-model', object: 'model' }] }))
      return
    }
    if (request.method !== 'POST' || !request.url?.endsWith('/chat/completions')) {
      response.statusCode = 404
      response.end()
      return
    }
    request.resume()
    request.once('end', () => {
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'close',
      })
      const base = {
        id: 'chatcmpl-simulator-smoke',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'simulator-smoke-model',
      }
      response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: AGENT_REPLY }, finish_reason: null }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 5, total_tokens: 13 } })}\n\n`)
      response.end('data: [DONE]\n\n')
    })
  })
}

export function isHostModuleCoordinatorSmokeRequested(): boolean {
  return isHostModuleSmokeAcceptanceRequested({ argv: process.argv, env: process.env })
}

export function getHostModuleCoordinatorSmokeRoot(): string | undefined {
  if (!isHostModuleCoordinatorSmokeRequested()) return undefined
  return argument(HOST_MODULE_SMOKE_ROOT_PREFIX)
}

export function getHostModuleCoordinatorSmokeNodeRuntime(): string | undefined {
  return resolveHostModuleSmokeNodeRuntime({ argv: process.argv, env: process.env })
}

export function writeHostModuleCoordinatorSmokeBootMarker(): void {
  if (!isHostModuleCoordinatorSmokeRequested()) return
  const resultPath = argument(RESULT_PREFIX)
  if (resultPath) writeResult(resultPath, { ok: false, phase: 'main-loaded', packaged: app.isPackaged })
}

export function recordHostModuleCoordinatorBeforeQuitEvent(): void {
  if (pendingResult) beforeQuitEventCount += 1
}

export function completeHostModuleCoordinatorSmokeCleanup(evidence: CleanupEvidence): void {
  if (!pendingResult || !pendingResultPath) return
  writeResult(pendingResultPath, {
    ...pendingResult,
    beforeQuitObserved: beforeQuitEventCount > 0,
    repeatedBeforeQuitIdempotent: beforeQuitEventCount >= 2,
    cleanup: evidence,
  })
}

export async function runHostModuleCoordinatorSmokeIfRequested(smoke: SmokeRuntime): Promise<boolean> {
  const root = getHostModuleCoordinatorSmokeRoot()
  if (!root) return false
  const manifestPath = argument(MANIFEST_PREFIX)
  const resultPath = argument(RESULT_PREFIX)
  if (!manifestPath || !resultPath) throw new Error('Host module smoke requires manifest and result paths')

  pendingResultPath = resultPath
  const timeout = setTimeout(() => {
    pendingResult = { ok: false, packaged: app.isPackaged, error: 'Host module coordinator smoke timed out' }
    app.quit()
  }, TIMEOUT_MS)
  timeout.unref()
  const provider = createDeterministicProvider()

  try {
    const providerAddress = await listen(provider)
    const connectionSlug = 'simulator-smoke-provider'
    if (!addLlmConnection({
      slug: connectionSlug,
      name: 'Simulator Smoke Provider',
      providerType: 'pi_compat',
      authType: 'none',
      baseUrl: `http://${providerAddress.host}:${providerAddress.port}/v1`,
      defaultModel: 'simulator-smoke-model',
      piAuthProvider: 'openai',
      customEndpoint: { api: 'openai-completions', supportsImages: false },
      models: ['simulator-smoke-model'],
      createdAt: Date.now(),
    })) throw new Error('Could not register deterministic built-in Agent provider')
    if (!setDefaultLlmConnection(connectionSlug)) throw new Error('Could not select deterministic built-in Agent provider')

    await smoke.sessionManager.waitForInit()
    const workspace = getWorkspaces()[0]
    if (!workspace) throw new Error('Built-in runtime did not initialize a workspace')
    const session = await smoke.sessionManager.createSession(workspace.id, {
      name: 'Module independence smoke',
      llmConnection: connectionSlug,
      model: 'simulator-smoke-model',
      workingDirectory: 'none',
    }, { emitCreatedEvent: false })
    await smoke.sessionManager.sendMessage(session.id, 'Reply deterministically for module independence smoke')
    await smoke.sessionManager.renameSession(session.id, 'Built-in Agent remains healthy')
    await smoke.sessionManager.setSessionStatus(session.id, 'in-progress')
    await smoke.sessionManager.flushSession(session.id)
    const sessionPath = smoke.sessionManager.getSessionPath(session.id)
    const sessionBeforeModule = await smoke.sessionManager.getSession(session.id)
    const hostWebContentsId = smoke.hostWindow.webContents.id
    const serverHealthyBeforeModule = await canConnect(smoke.serverHost, smoke.serverPort)
    if (!sessionBeforeModule?.messages.some((message) => message.role === 'assistant' && message.content.includes(AGENT_REPLY))) {
      throw new Error(`Deterministic built-in Agent turn did not complete: ${JSON.stringify(
        sessionBeforeModule?.messages.map((message) => ({ role: message.role, content: message.content.slice(0, 240) })),
      )}`)
    }

    const parsed = parseModuleManifest(JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown)
    if (!parsed.ok) throw new Error(`Host module smoke manifest is invalid: ${JSON.stringify(parsed.errors)}`)
    const manifest = parsed.value
    if (!smoke.runtime.registry.install(manifest, { hostVersionRange: '*' }).ok) throw new Error('Could not register smoke module')
    if (!smoke.runtime.registry.activate(manifest.id, manifest.version).ok) throw new Error('Could not activate smoke module')
    if (!smoke.runtime.registry.markLastKnownGood(manifest.id, manifest.version).ok) throw new Error('Could not mark smoke module last-known-good')

    const started = await smoke.runtime.coordinator.start({ operationId: 'electron-product-smoke-start', moduleId: manifest.id })
    if (!started.ok) throw new Error(started.error ?? 'Coordinator start failed')
    const firstView = smoke.manager.list()[0]
    if (!firstView || smoke.manager.list().length !== 1 || firstView.state !== 'ready' || !firstView.attached) {
      throw new Error(`Expected one ready attached WebContentsView: ${JSON.stringify(smoke.manager.list())}`)
    }
    const moduleWebContents = webContents.fromId(firstView.webContentsId)
    if (!moduleWebContents) throw new Error('Attached module WebContents was not found')
    const renderer = await moduleWebContents.executeJavaScript(`({
      text: document.querySelector('main')?.textContent,
      moduleId: window.simulatorModuleView?.moduleId,
      viewInstanceId: window.simulatorModuleView?.viewInstanceId,
      requireType: typeof require,
      processType: typeof process
    })`) as Record<string, unknown>
    const daemon = smoke.runtime.daemon.get(manifest.id)
    if (!daemon?.endpoint || !daemon.pid) throw new Error('Healthy daemon endpoint disappeared')
    const resource = await fetch(`http://${daemon.endpoint.host}:${daemon.endpoint.port}/resource/data.txt`)
    const resourceText = await resource.text()
    const firstHostAgentResponse = await fetch(`http://${daemon.endpoint.host}:${daemon.endpoint.port}/host-agent-smoke`)
    const firstHostAgent = await firstHostAgentResponse.json() as {
      ok: boolean
      capability?: string
      contractVersion?: number
      replies?: string[]
      tokenFile?: string
      error?: string
    }
    if (!firstHostAgent.ok || firstHostAgent.capability !== 'host-agent.use'
      || firstHostAgent.contractVersion !== 1
      || firstHostAgent.replies?.length !== 2
      || firstHostAgent.replies.some((reply) => !reply.includes(AGENT_REPLY))
      || !firstHostAgent.tokenFile || !existsSync(firstHostAgent.tokenFile)) {
      throw new Error(`First Module Host Agent journey failed: ${JSON.stringify(firstHostAgent)}`)
    }
    const firstTokenFile = firstHostAgent.tokenFile
    const firstGatewaySnapshot = smoke.moduleAgentRuntime.debugSnapshot()
    if (firstGatewaySnapshot.activeGrants !== 1 || firstGatewaySnapshot.activeSessions !== 0
      || firstGatewaySnapshot.activeTurns !== 0 || firstGatewaySnapshot.activeSubscribers !== 0) {
      throw new Error(`First Host Agent journey leaked session state: ${JSON.stringify(firstGatewaySnapshot)}`)
    }

    process.kill(daemon.pid, 'SIGKILL')
    await waitFor(() => !existsSync(firstTokenFile), 'old launch token revocation')
    await waitFor(() => {
      const current = smoke.runtime.daemon.get(manifest.id)
      return current?.state === 'healthy' && current.restartCount >= 1
    }, 'module daemon restart')
    await waitFor(() => smoke.manager.list()[0]?.state === 'ready' && smoke.manager.list()[0]?.attached === true, 'module view reattach')
    const restartedDaemon = smoke.runtime.daemon.get(manifest.id)
    if (!restartedDaemon?.endpoint) throw new Error('Restarted daemon endpoint disappeared')
    const secondHostAgentResponse = await fetch(`http://${restartedDaemon.endpoint.host}:${restartedDaemon.endpoint.port}/host-agent-smoke`)
    const secondHostAgent = await secondHostAgentResponse.json() as typeof firstHostAgent
    if (!secondHostAgent.ok || secondHostAgent.capability !== 'host-agent.use'
      || secondHostAgent.replies?.length !== 2
      || secondHostAgent.replies.some((reply) => !reply.includes(AGENT_REPLY))
      || !secondHostAgent.tokenFile || secondHostAgent.tokenFile === firstTokenFile
      || !existsSync(secondHostAgent.tokenFile)) {
      throw new Error(`Restarted Module Host Agent journey failed: ${JSON.stringify(secondHostAgent)}`)
    }
    const secondTokenFile = secondHostAgent.tokenFile

    const sessionDuringModule = await smoke.sessionManager.getSession(session.id)
    const builtInRuntimeUnaffected = Boolean(
      sessionDuringModule
      && sessionDuringModule.name === 'Built-in Agent remains healthy'
      && sessionDuringModule.sessionStatus === 'in-progress'
      && sessionDuringModule.messages.some((message) => message.role === 'assistant' && message.content.includes(AGENT_REPLY))
      && !smoke.hostWindow.isDestroyed()
      && smoke.hostWindow.webContents.id === hostWebContentsId
      && await canConnect(smoke.serverHost, smoke.serverPort),
    )

    const stopped = await smoke.runtime.coordinator.stop({ operationId: 'electron-product-smoke-stop', moduleId: manifest.id })
    if (!stopped.ok) throw new Error(stopped.error ?? 'Coordinator stop failed')
    await waitFor(() => !existsSync(secondTokenFile), 'restarted launch token revocation')
    const stoppedGatewaySnapshot = smoke.moduleAgentRuntime.debugSnapshot()
    if (JSON.stringify(stoppedGatewaySnapshot) !== JSON.stringify({
      activeGrants: 0,
      activeSessions: 0,
      activeTurns: 0,
      activeSubscribers: 0,
    })) throw new Error(`Coordinator stop leaked Host Agent state: ${JSON.stringify(stoppedGatewaySnapshot)}`)
    const orphan = smoke.manager.list().length !== 0 || webContents.fromId(firstView.webContentsId) !== undefined
    if (orphan) throw new Error('Coordinator stop left an orphan module WebContentsView')

    const sessionAfterModule = await smoke.sessionManager.getSession(session.id)
    pendingResult = {
      ok: true,
      packaged: app.isPackaged,
      coordinatorLifecycle: true,
      moduleCrashRestarted: true,
      hostAgentRuntime: {
        deterministicMultiTurn: true,
        crashGrantRotated: true,
        oldGrantRevoked: true,
        stopGrantRevoked: true,
        firstGatewaySnapshot,
        stoppedGatewaySnapshot,
      },
      moduleId: manifest.id,
      renderer,
      resourceText,
      preloadIsolated: renderer.requireType === 'undefined' && renderer.processType === 'undefined',
      noOrphanWebContents: true,
      builtInAgentIndependent: builtInRuntimeUnaffected && sessionAfterModule?.id === session.id,
      builtInAgent: {
        deterministicTurn: true,
        sessionId: session.id,
        sessionPath,
        serverHealthyBeforeModule,
        serverHealthyAfterModule: await canConnect(smoke.serverHost, smoke.serverPort),
        hostWebContentsId,
      },
    }
  } catch (error) {
    pendingResult = {
      ok: false,
      packaged: app.isPackaged,
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    clearTimeout(timeout)
    await close(provider).catch(() => undefined)
  }

  writeResult(resultPath, { ...pendingResult, phase: 'awaiting-before-quit-cleanup' })
  app.quit()
  app.quit()
  return true
}
