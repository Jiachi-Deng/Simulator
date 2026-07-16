import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { createConnection } from 'node:net'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { BrowserWindow, app, webContents } from 'electron'
import { parseModuleManifest } from '@simulator/module-contract'
import type { SessionManager } from '@craft-agent/server-core/sessions'
import { addLlmConnection, getWorkspaces, setDefaultLlmConnection } from '@craft-agent/shared/config'
import type { HostModuleCoordinatorRuntime } from './host-module-coordinator'
import type { ModuleViewManager } from './module-view-manager'
import type {
  IsolatedHostModuleAgentRuntime,
  IsolatedHostModuleAgentRuntimeSnapshot,
} from './module-agent-runtime'
import {
  HOST_MODULE_SMOKE_ROOT_PREFIX,
  isHostModuleSmokeAcceptanceRequested,
  resolveHostModuleSmokeNodeRuntime,
} from './host-module-smoke-gate'
import { AuthoritativeSmokeWatchdogState, waitForAcceptedValue } from './host-module-smoke-deadline'

const MANIFEST_PREFIX = '--host-module-smoke-manifest='
const RESULT_PREFIX = '--host-module-smoke-result='
const INNER_WATCHDOG_TIMEOUT_MS = 40_000
const AGENT_REPLY = 'deterministic built-in Agent response'
const PROVIDER_RESPONSE_DELAY_MS = 100
const PROCESS_TREE_SAMPLE_MS = 15
const PROTOCOL_FIXTURE_SCOPE = 'deterministic-packaged-protocol-fixture-not-real-rc-or-paid-preview-acceptance'

interface SmokeRuntime {
  readonly runtime: HostModuleCoordinatorRuntime
  readonly manager: ModuleViewManager
  readonly sessionManager: SessionManager
  readonly hostWindow: BrowserWindow
  readonly serverHost: string
  readonly serverPort: number
  readonly moduleAgentRuntime: IsolatedHostModuleAgentRuntime
}

interface CleanupEvidence {
  readonly coordinatorDrained: boolean
  readonly sessionFlushed: boolean
  readonly serverStopped: boolean
  readonly viewsDisposed: boolean
  readonly moduleAgentStopped: boolean
}

interface HostAgentSmokeBase {
  readonly ok: boolean
  readonly capability?: string
  readonly contractVersion?: number
  readonly replies?: string[]
  readonly tokenFile?: string
  readonly failure?: {
    readonly code?: string
    readonly bytes?: number
    readonly status?: number
  }
}

interface HostAgentV2Invocation {
  readonly pid?: number
  readonly argv?: unknown[]
  readonly stdinOnly?: boolean
  readonly eofClosed?: boolean
  readonly runHandle?: string
  readonly eventTypes?: string[]
  readonly terminalType?: string
  readonly finalText?: string
  readonly exitCode?: number
  readonly stderrBytes?: number
  readonly processReaped?: boolean
}

interface HostAgentV2Smoke extends HostAgentSmokeBase {
  readonly protocolFixture?: boolean
  readonly acceptanceScope?: string
  readonly transport?: string
  readonly oneTurnPerProcess?: boolean
  readonly invocationCount?: number
  readonly invocations?: HostAgentV2Invocation[]
  readonly shim?: {
    readonly path?: string
    readonly sha256?: string
    readonly size?: number
    readonly nlink?: number
  }
}

interface HostAgentJourneyEvidence {
  readonly tokenFile: string
  readonly processIds: number[]
  readonly ordinaryJsonEventStreamCli: boolean
  readonly oneTurnPerSession: boolean
  readonly shimResourceHashVerified: boolean
}

interface SafeProcessEvidence {
  readonly pid: number
  readonly ppid: number
  readonly pgid: number
  readonly role: 'host-descendant' | 'module-provider-root' | 'module-provider-descendant'
  readonly executable: string
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

function processGroupExists(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

async function waitForProcessGroupsToExit(pgids: readonly number[], timeoutMs: number): Promise<number[]> {
  const deadline = Date.now() + timeoutMs
  let remaining = [...new Set(pgids)].filter(processGroupExists)
  while (remaining.length > 0 && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
    remaining = remaining.filter(processGroupExists)
  }
  return remaining
}

/**
 * Acceptance-only macOS process evidence. `ps` output is reduced immediately
 * to numeric ownership plus basename, so command lines, environment variables,
 * bearer material, and absolute paths can never enter the smoke artifact.
 */
function macosProcessTree(rootPid: number): SafeProcessEvidence[] {
  if (process.platform !== 'darwin') {
    throw new Error('Host Module process-tree acceptance is supported only on macOS')
  }
  let output: string
  try {
    output = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,comm='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    throw new Error('Could not collect sanitized macOS process-tree evidence')
  }
  const rows = output.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line)
    if (!match) return []
    const pid = Number(match[1])
    const ppid = Number(match[2])
    const pgid = Number(match[3])
    if (![pid, ppid, pgid].every((value) => Number.isSafeInteger(value) && value > 0)) return []
    const rawExecutable = match[4]!.split('/').at(-1) ?? 'unknown'
    // macOS wraps a just-exited process name in parentheses while the parent
    // is collecting its status; normalize that harmless lifecycle notation.
    const executable = /^\(([^()]+)\)$/.exec(rawExecutable)?.[1] ?? rawExecutable
    return [{ pid, ppid, pgid, executable }]
  })
  const byParent = new Map<number, typeof rows>()
  for (const row of rows) {
    const children = byParent.get(row.ppid) ?? []
    children.push(row)
    byParent.set(row.ppid, children)
  }
  const descendants = new Map<number, (typeof rows)[number]>()
  const queue = [rootPid]
  while (queue.length > 0) {
    const parent = queue.shift()!
    for (const child of byParent.get(parent) ?? []) {
      if (child.executable === 'ps' || descendants.has(child.pid)) continue
      descendants.set(child.pid, child)
      queue.push(child.pid)
    }
  }
  const providerRuntimeNames = new Set(['bun', 'bun.exe', 'node', 'node.exe'])
  const providerGroups = new Set(
    [...descendants.values()]
      .filter((row) => row.pid === row.pgid && providerRuntimeNames.has(row.executable))
      .map((row) => row.pgid),
  )
  // Include descendants that were re-parented during the snapshot but remain
  // in the dedicated provider process group.
  for (const row of rows) {
    if (providerGroups.has(row.pgid) && row.executable !== 'ps') descendants.set(row.pid, row)
  }
  return [...descendants.values()].map((row) => ({
    ...row,
    role: row.pid === row.pgid && providerGroups.has(row.pgid)
      ? 'module-provider-root'
      : providerGroups.has(row.pgid)
        ? 'module-provider-descendant'
        : 'host-descendant',
  }))
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
      const responseTimer = setTimeout(() => {
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
      }, PROVIDER_RESPONSE_DELAY_MS)
      responseTimer.unref()
    })
  })
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function readBearerTokenInMemory(path: string): string {
  const token = readFileSync(path, 'utf8').trim()
  if (!/^[\x21-\x7e]{32,512}$/.test(token)) throw new Error('Host Agent bearer file was invalid')
  return token
}

async function assertOldBearerRejected(
  snapshot: IsolatedHostModuleAgentRuntimeSnapshot,
  protocol: 'v1' | 'v2',
  bearer: string,
): Promise<void> {
  const address = snapshot.workers[protocol].address
  if (!address) throw new Error(`Recovered ${protocol} Broker address is unavailable`)
  const response = await fetch(`${address.url}/${protocol}/capabilities`, {
    headers: { Authorization: `Bearer ${bearer}` },
  })
  await response.arrayBuffer()
  if (response.status !== 401 && response.status !== 403) {
    throw new Error(`Recovered ${protocol} Broker accepted obsolete authority (${response.status})`)
  }
}

function validateHostAgentJourney(
  input: unknown,
  contractVersion: 1 | 2,
): HostAgentJourneyEvidence {
  const response = input as HostAgentV2Smoke
  if (!response?.ok || response.capability !== 'host-agent.use'
    || response.contractVersion !== contractVersion
    || response.replies?.length !== 2
    || response.replies.some((reply) => !reply.includes(AGENT_REPLY))
    || !response.tokenFile || !existsSync(response.tokenFile)) {
    throw new Error(`Module Host Agent journey failed for contract v${contractVersion}`)
  }
  if (contractVersion === 1) {
    return {
      tokenFile: response.tokenFile,
      processIds: [],
      ordinaryJsonEventStreamCli: false,
      oneTurnPerSession: false,
      shimResourceHashVerified: false,
    }
  }

  const invocations = response.invocations
  if (response.protocolFixture !== true || response.acceptanceScope !== PROTOCOL_FIXTURE_SCOPE
    || response.transport !== 'ordinary-json-event-stream-cli-v2'
    || response.oneTurnPerProcess !== true || response.invocationCount !== 2
    || !Array.isArray(invocations) || invocations.length !== 2) {
    throw new Error('v2 Module response did not prove the ordinary CLI fixture contract')
  }
  const processIds = new Set<number>()
  const runHandles = new Set<string>()
  for (const invocation of invocations) {
    const eventTypes = invocation.eventTypes
    const terminalCount = eventTypes?.filter((event) => (
      event === 'turn.completed' || event === 'turn.failed' || event === 'turn.interrupted'
    )).length
    if (!Number.isSafeInteger(invocation.pid) || (invocation.pid ?? 0) <= 0
      || !Array.isArray(invocation.argv) || invocation.argv.length !== 0
      || invocation.stdinOnly !== true || invocation.eofClosed !== true
      || !invocation.runHandle || !/^run_[a-f0-9]{32}$/.test(invocation.runHandle)
      || !Array.isArray(eventTypes) || eventTypes[0] !== 'run.accepted' || eventTypes[1] !== 'turn.started'
      || eventTypes.at(-2) !== 'turn.completed' || eventTypes.at(-1) !== 'run.closed'
      || terminalCount !== 1 || invocation.terminalType !== 'turn.completed'
      || !invocation.finalText?.includes(AGENT_REPLY)
      || invocation.exitCode !== 0 || invocation.stderrBytes !== 0 || invocation.processReaped !== true) {
      throw new Error('v2 Shim invocation evidence is incomplete')
    }
    processIds.add(invocation.pid!)
    runHandles.add(invocation.runHandle)
  }
  if (processIds.size !== 2 || runHandles.size !== 2) {
    throw new Error('v2 ordinary Runtime reused a Shim process or Run handle')
  }

  const expectedShimPath = join(app.getAppPath(), 'dist', 'resources', 'host-agent', 'simulator-host-agent.mjs')
  const expectedShimHash = sha256File(expectedShimPath)
  if (response.shim?.path !== expectedShimPath || response.shim.sha256 !== expectedShimHash
    || response.shim.size !== readFileSync(expectedShimPath).byteLength || response.shim.nlink !== 1) {
    throw new Error('v2 Module did not execute the exact packaged Host-owned Shim resource')
  }
  return {
    tokenFile: response.tokenFile,
    processIds: [...processIds],
    ordinaryJsonEventStreamCli: true,
    oneTurnPerSession: true,
    shimResourceHashVerified: true,
  }
}

function assertCleanJourneySnapshot(
  snapshot: IsolatedHostModuleAgentRuntimeSnapshot,
  protocol: 'v1' | 'v2',
): { epoch: string; pid: number } {
  const v1Clean = snapshot.v1.activeSessions === 0
    && snapshot.v1.activeTurns === 0
    && snapshot.v1.activeSubscribers === 0
  const v2Clean = snapshot.v2.activeRuns === 0
    && snapshot.v2.moduleSessions === 0
    && snapshot.v2.subscribers === 0
  const worker = snapshot.workers[protocol]
  if (snapshot.kind !== 'isolated' || !v1Clean || !v2Clean
    || snapshot.turnLease.craftActive || snapshot.turnLease.owner
    || snapshot.v1.activeGrants !== (protocol === 'v1' ? 1 : 0)
    || snapshot.v2.activeGrants !== (protocol === 'v2' ? 1 : 0)
    || worker.status !== 'running' || !worker.epoch
    || !Number.isSafeInteger(worker.pid) || (worker.pid ?? 0) <= 0) {
    throw new Error(`Host Agent journey leaked or split state: ${JSON.stringify(snapshot)}`)
  }
  return { epoch: worker.epoch, pid: worker.pid! }
}

async function waitForCleanJourneySnapshot(
  runtime: IsolatedHostModuleAgentRuntime,
  protocol: 'v1' | 'v2',
): Promise<{
  snapshot: IsolatedHostModuleAgentRuntimeSnapshot
  worker: { epoch: string; pid: number }
}> {
  return waitForAcceptedValue({
    timeoutMs: 5_000,
    pollMs: 25,
    refresh: () => runtime.refreshDebugSnapshot(),
    accept: (snapshot) => ({ snapshot, worker: assertCleanJourneySnapshot(snapshot, protocol) }),
  })
}

function assertStoppedSnapshot(snapshot: IsolatedHostModuleAgentRuntimeSnapshot): void {
  if (snapshot.kind !== 'isolated'
    || snapshot.v1.activeGrants !== 0 || snapshot.v1.activeSessions !== 0
    || snapshot.v1.activeTurns !== 0 || snapshot.v1.activeSubscribers !== 0
    || snapshot.v2.activeGrants !== 0 || snapshot.v2.activeRuns !== 0
    || snapshot.v2.moduleSessions !== 0 || snapshot.v2.subscribers !== 0
    || snapshot.workers.v1.status !== 'stopped' || snapshot.workers.v2.status !== 'stopped'
    || snapshot.turnLease.owner) {
    throw new Error(`Coordinator stop leaked Host Agent state: ${JSON.stringify(snapshot)}`)
  }
}

function assertNoHiddenSessionResidue(
  smoke: SmokeRuntime,
  workspaceId: string,
  visibleSessionPath: string,
): void {
  const sessions = smoke.sessionManager.getSessions(workspaceId)
  const hidden = sessions.filter((session) => session.hidden === true)
  const known = new Set(sessions.map((session) => session.id))
  const unknownDirectories = readdirSync(dirname(visibleSessionPath), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !known.has(entry.name))
    .map((entry) => entry.name)
  if (hidden.length > 0 || unknownDirectories.length > 0) {
    throw new Error(`Module journey left hidden Session state: ${JSON.stringify({
      hidden: hidden.map((session) => session.id),
      unknownDirectories,
    })}`)
  }
}

function assertJourneySessionPattern(
  terminalSessionIds: readonly string[],
  fromIndex: number,
  contractVersion: 1 | 2,
): number {
  const journey = terminalSessionIds.slice(fromIndex)
  const unique = new Set(journey)
  const expectedUnique = contractVersion === 2 ? 2 : 1
  if (journey.length !== 2 || unique.size !== expectedUnique) {
    throw new Error(`Contract v${contractVersion} Session-per-Turn evidence is invalid: ${JSON.stringify({
      terminalEvents: journey.length,
      uniqueSessions: unique.size,
    })}`)
  }
  return terminalSessionIds.length
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
  const watchdog = new AuthoritativeSmokeWatchdogState()
  const smokeOwnedProcessGroups = new Set<number>()
  // Stable numeric diagnostics only. The wrapper may disclose this phase
  // without exposing exception text, paths, prompts, credentials, or process
  // command lines from the packaged acceptance child.
  let failurePhase = 10
  const timeout = setTimeout(() => {
    watchdog.markTimedOut()
    pendingResult = {
      ok: false,
      packaged: app.isPackaged,
      errorCode: 'SMOKE_TIMEOUT',
      smokeOwnedProcessGroups: [...smokeOwnedProcessGroups],
    }
    writeResult(resultPath, { ...pendingResult, phase: 'watchdog-timeout' })
    app.quit()
  }, INNER_WATCHDOG_TIMEOUT_MS)
  timeout.unref()
  const provider = createDeterministicProvider()
  let unsubscribeModuleRuntimeEvents: (() => void) | undefined

  try {
    const providerAddress = await listen(provider)
    failurePhase = 20
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
    failurePhase = 30
    const workspace = getWorkspaces()[0]
    if (!workspace) throw new Error('Built-in runtime did not initialize a workspace')
    const session = await smoke.sessionManager.createSession(workspace.id, {
      name: 'Module independence smoke',
      llmConnection: connectionSlug,
      model: 'simulator-smoke-model',
      workingDirectory: 'none',
    }, { emitCreatedEvent: false })
    const sessionPath = smoke.sessionManager.getSessionPath(session.id)
    if (!sessionPath) throw new Error('Built-in Agent session path is unavailable')
    const hostMainProcessId = process.pid
    const hostWebContentsId = smoke.hostWindow.webContents.id
    const hostRendererProcessId = smoke.hostWindow.webContents.getOSProcessId()
    const observedProcessIds = new Set<number>([hostMainProcessId, hostRendererProcessId])
    const safeProcessRecords = new Map<number, SafeProcessEvidence>()
    const moduleProviderGroups = smokeOwnedProcessGroups
    const captureProcessEvidence = (): void => {
      for (const record of macosProcessTree(hostMainProcessId)) {
        const previous = safeProcessRecords.get(record.pid)
        const sameProcessLostItsExecutableName = previous?.pgid === record.pgid
          && previous.role !== 'host-descendant'
          && record.role === 'host-descendant'
        if (!sameProcessLostItsExecutableName) safeProcessRecords.set(record.pid, record)
        observedProcessIds.add(record.pid)
        if (record.role === 'module-provider-root') moduleProviderGroups.add(record.pgid)
      }
    }
    const assertStableHost = async (phase: string): Promise<void> => {
      if (process.pid !== hostMainProcessId || smoke.hostWindow.isDestroyed()
        || smoke.hostWindow.webContents.id !== hostWebContentsId
        || smoke.hostWindow.webContents.getOSProcessId() !== hostRendererProcessId
        || !await canConnect(smoke.serverHost, smoke.serverPort)) {
        throw new Error(`Visible Craft Host identity changed during ${phase}`)
      }
    }
    const runVisibleCraftTurn = async (marker: string) => {
      await assertStableHost(`${marker}:before`)
      const before = await smoke.sessionManager.getSession(session.id)
      const assistantCountBefore = before?.messages.filter((message) => message.role === 'assistant').length ?? 0
      await smoke.sessionManager.sendMessage(session.id, `Visible Craft independence marker: ${marker}`)
      const after = await smoke.sessionManager.getSession(session.id)
      const assistantMessages = after?.messages.filter((message) => message.role === 'assistant') ?? []
      const userMarkerPresent = after?.messages.some((message) => (
        message.role === 'user' && message.content.includes(marker)
      )) === true
      if (!after || !userMarkerPresent || assistantMessages.length !== assistantCountBefore + 1
        || !assistantMessages.at(-1)?.content.includes(AGENT_REPLY)) {
        throw new Error(`Visible Craft Turn did not complete exactly once for ${marker}`)
      }
      captureProcessEvidence()
      await assertStableHost(`${marker}:after`)
      return { marker, assistantCountBefore, assistantCountAfter: assistantMessages.length }
    }

    const initialCraftTurn = await runVisibleCraftTurn('craft-before-module')
    failurePhase = 40
    await smoke.sessionManager.renameSession(session.id, 'Built-in Agent remains healthy')
    await smoke.sessionManager.setSessionStatus(session.id, 'in-progress')
    await smoke.sessionManager.flushSession(session.id)
    const sessionBeforeModule = await smoke.sessionManager.getSession(session.id)
    const serverHealthyBeforeModule = await canConnect(smoke.serverHost, smoke.serverPort)
    if (!sessionBeforeModule?.messages.some((message) => message.role === 'assistant' && message.content.includes(AGENT_REPLY))) {
      throw new Error(`Deterministic built-in Agent turn did not complete: ${JSON.stringify(
        sessionBeforeModule?.messages.map((message) => ({ role: message.role, content: message.content.slice(0, 240) })),
      )}`)
    }

    const parsed = parseModuleManifest(JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown)
    if (!parsed.ok) throw new Error(`Host module smoke manifest is invalid: ${JSON.stringify(parsed.errors)}`)
    const manifest = parsed.value
    if (manifest.id !== 'org.simulator.open-design'
      || (manifest.version !== '0.14.5' && manifest.version !== '0.14.6-rc.1')) {
      throw new Error('Host module smoke accepts only the exact M1 OpenDesign rollback and RC fixtures')
    }
    const contractVersion: 1 | 2 = manifest.version === '0.14.5' ? 1 : 2
    const scenario = contractVersion === 1 ? 'v1-compat' : 'v2-open-design-rc'
    const terminalSessionIds: string[] = []
    unsubscribeModuleRuntimeEvents = smoke.sessionManager.onSessionComplete((event) => {
      const completed = smoke.sessionManager.getSessions(workspace.id)
        .find((candidate) => candidate.id === event.sessionId)
      if (completed?.hidden === true) terminalSessionIds.push(event.sessionId)
    })
    let terminalSessionOffset = 0
    if (!smoke.runtime.registry.install(manifest, { hostVersionRange: '*' }).ok) throw new Error('Could not register smoke module')
    if (!smoke.runtime.registry.activate(manifest.id, manifest.version).ok) throw new Error('Could not activate smoke module')
    if (!smoke.runtime.registry.markLastKnownGood(manifest.id, manifest.version).ok) throw new Error('Could not mark smoke module last-known-good')

    const started = await smoke.runtime.coordinator.start({ operationId: 'electron-product-smoke-start', moduleId: manifest.id })
    failurePhase = 50
    if (!started.ok) throw new Error(started.error ?? 'Coordinator start failed')
    const firstView = smoke.manager.list()[0]
    if (!firstView || smoke.manager.list().length !== 1 || firstView.state !== 'ready' || !firstView.attached) {
      throw new Error(`Expected one ready attached WebContentsView: ${JSON.stringify(smoke.manager.list())}`)
    }
    const moduleWebContents = webContents.fromId(firstView.webContentsId)
    if (!moduleWebContents) throw new Error('Attached module WebContents was not found')
    const observedViewIds = new Set([firstView.webContentsId])
    observedProcessIds.add(moduleWebContents.getOSProcessId())
    const renderer = await moduleWebContents.executeJavaScript(`({
      text: document.querySelector('main')?.textContent,
      moduleId: window.simulatorModuleView?.moduleId,
      viewInstanceId: window.simulatorModuleView?.viewInstanceId,
      requireType: typeof require,
      processType: typeof process
    })`) as Record<string, unknown>
    const daemon = smoke.runtime.daemon.get(manifest.id)
    if (!daemon?.endpoint || !daemon.pid) throw new Error('Healthy daemon endpoint disappeared')
    observedProcessIds.add(daemon.pid)
    const resource = await fetch(`http://${daemon.endpoint.host}:${daemon.endpoint.port}/resource/data.txt`)
    const resourceText = await resource.text()
    const fetchJourney = async (endpoint: { host: string; port: number }, phaseBase: 60 | 90 | 120) => {
      failurePhase = phaseBase
      const previousProviderGroups = new Set(moduleProviderGroups)
      let samplingError: Error | undefined
      const sample = (): void => {
        if (samplingError) return
        try { captureProcessEvidence() } catch (error) {
          samplingError = error instanceof Error ? error : new Error('Process evidence sampling failed')
        }
      }
      sample()
      failurePhase = phaseBase + 1
      const sampler = setInterval(sample, PROCESS_TREE_SAMPLE_MS)
      let response: Response
      try {
        response = await fetch(`http://${endpoint.host}:${endpoint.port}/host-agent-smoke`)
      } finally {
        clearInterval(sampler)
        sample()
      }
      failurePhase = phaseBase + 2
      if (samplingError) throw samplingError
      if (!response.ok) throw new Error(`Module Host Agent smoke endpoint failed with ${response.status}`)
      const journey = validateHostAgentJourney(await response.json(), contractVersion)
      failurePhase = phaseBase + 3
      const journeyProviderGroups = [...moduleProviderGroups]
        .filter((pgid) => !previousProviderGroups.has(pgid))
      if (journeyProviderGroups.length === 0) {
        throw new Error('Module Host Agent journey did not expose a dedicated provider process group')
      }
      failurePhase = phaseBase + 4
      const residualProviderGroups = await waitForProcessGroupsToExit(journeyProviderGroups, 5_000)
      if (residualProviderGroups.length > 0) {
        throw new Error(`Module Host Agent journey left provider process groups: ${residualProviderGroups.join(',')}`)
      }
      failurePhase = phaseBase + 5
      return journey
    }

    const firstJourney = await fetchJourney(daemon.endpoint, 60)
    failurePhase = 66
    terminalSessionOffset = assertJourneySessionPattern(terminalSessionIds, terminalSessionOffset, contractVersion)
    for (const pid of firstJourney.processIds) observedProcessIds.add(pid)
    failurePhase = 67
    assertNoHiddenSessionResidue(smoke, workspace.id, sessionPath)
    failurePhase = 68
    const firstCleanJourney = await waitForCleanJourneySnapshot(
      smoke.moduleAgentRuntime,
      contractVersion === 1 ? 'v1' : 'v2',
    )
    const firstGatewaySnapshot = firstCleanJourney.snapshot
    if (contractVersion === 2 && firstGatewaySnapshot.v2.retainedRuns !== 2) {
      throw new Error(`First v2 journey did not retain exactly two tombstones: ${JSON.stringify(firstGatewaySnapshot)}`)
    }
    const firstWorker = firstCleanJourney.worker
    failurePhase = 70
    observedProcessIds.add(firstWorker.pid)
    const firstObsoleteBearer = readBearerTokenInMemory(firstJourney.tokenFile)

    // Kill only the protocol Worker. The current Turn has already reached a
    // terminal; recovery must rotate the daemon launch lease without touching
    // the primary Host process or automatically replaying any Turn.
    process.kill(firstWorker.pid, 'SIGKILL')
    failurePhase = 80
    await waitFor(() => !existsSync(firstJourney.tokenFile), 'Worker-crash launch token revocation')
    await waitFor(() => {
      const current = smoke.runtime.daemon.get(manifest.id)
      return current?.state === 'healthy' && current.pid !== daemon.pid
    }, 'daemon lease rotation after Worker crash')
    await waitFor(() => {
      const worker = smoke.moduleAgentRuntime.debugSnapshot().workers[contractVersion === 1 ? 'v1' : 'v2']
      return worker.status === 'running' && worker.epoch !== firstWorker.epoch
    }, 'fresh Worker epoch after crash')
    await waitFor(() => smoke.manager.list()[0]?.state === 'ready' && smoke.manager.list()[0]?.attached === true, 'module view reattach after Worker crash')
    const workerRecoveredView = smoke.manager.list()[0]!
    observedViewIds.add(workerRecoveredView.webContentsId)
    const workerRecoveredWebContents = webContents.fromId(workerRecoveredView.webContentsId)
    if (!workerRecoveredWebContents) throw new Error('Worker recovery did not reattach module WebContents')
    observedProcessIds.add(workerRecoveredWebContents.getOSProcessId())
    const workerRecoveredDaemon = smoke.runtime.daemon.get(manifest.id)
    if (!workerRecoveredDaemon?.endpoint || !workerRecoveredDaemon.pid) throw new Error('Worker-recovered daemon endpoint disappeared')
    observedProcessIds.add(workerRecoveredDaemon.pid)
    const secondJourney = await fetchJourney(workerRecoveredDaemon.endpoint, 90)
    failurePhase = 96
    terminalSessionOffset = assertJourneySessionPattern(terminalSessionIds, terminalSessionOffset, contractVersion)
    if (secondJourney.tokenFile === firstJourney.tokenFile) throw new Error('Worker recovery reused a revoked launch token path')
    for (const pid of secondJourney.processIds) observedProcessIds.add(pid)
    failurePhase = 97
    assertNoHiddenSessionResidue(smoke, workspace.id, sessionPath)
    failurePhase = 98
    const secondCleanJourney = await waitForCleanJourneySnapshot(
      smoke.moduleAgentRuntime,
      contractVersion === 1 ? 'v1' : 'v2',
    )
    const secondGatewaySnapshot = secondCleanJourney.snapshot
    if (contractVersion === 2 && secondGatewaySnapshot.v2.retainedRuns !== 4) {
      throw new Error(`Worker recovery did not preserve exactly four v2 tombstones: ${JSON.stringify(secondGatewaySnapshot)}`)
    }
    const secondWorker = secondCleanJourney.worker
    if (secondWorker.epoch === firstWorker.epoch) throw new Error('Worker recovery reused the crashed epoch')
    observedProcessIds.add(secondWorker.pid)
    await assertOldBearerRejected(
      secondGatewaySnapshot,
      contractVersion === 1 ? 'v1' : 'v2',
      firstObsoleteBearer,
    )
    const workerRecoveryCraftTurn = await runVisibleCraftTurn('craft-after-worker-recovery')
    const secondObsoleteBearer = readBearerTokenInMemory(secondJourney.tokenFile)
    failurePhase = 100

    // Separately crash the optional Module daemon. Its manager owns this
    // recovery and must prepare another revocable launch without Host impact.
    process.kill(workerRecoveredDaemon.pid, 'SIGKILL')
    failurePhase = 110
    await waitFor(() => !existsSync(secondJourney.tokenFile), 'daemon-crash launch token revocation')
    await waitFor(() => {
      const current = smoke.runtime.daemon.get(manifest.id)
      return current?.state === 'healthy' && current.pid !== workerRecoveredDaemon.pid && current.restartCount >= 1
    }, 'module daemon restart')
    await waitFor(() => smoke.manager.list()[0]?.state === 'ready' && smoke.manager.list()[0]?.attached === true, 'module view reattach after daemon crash')
    const daemonRecoveredView = smoke.manager.list()[0]!
    observedViewIds.add(daemonRecoveredView.webContentsId)
    const daemonRecoveredWebContents = webContents.fromId(daemonRecoveredView.webContentsId)
    if (!daemonRecoveredWebContents) throw new Error('Daemon recovery did not reattach module WebContents')
    observedProcessIds.add(daemonRecoveredWebContents.getOSProcessId())
    const daemonRecovered = smoke.runtime.daemon.get(manifest.id)
    if (!daemonRecovered?.endpoint || !daemonRecovered.pid) throw new Error('Restarted daemon endpoint disappeared')
    observedProcessIds.add(daemonRecovered.pid)
    const thirdJourney = await fetchJourney(daemonRecovered.endpoint, 120)
    failurePhase = 126
    terminalSessionOffset = assertJourneySessionPattern(terminalSessionIds, terminalSessionOffset, contractVersion)
    if (new Set([firstJourney.tokenFile, secondJourney.tokenFile, thirdJourney.tokenFile]).size !== 3) {
      throw new Error('Module recovery reused a launch token path')
    }
    for (const pid of thirdJourney.processIds) observedProcessIds.add(pid)
    failurePhase = 127
    assertNoHiddenSessionResidue(smoke, workspace.id, sessionPath)
    failurePhase = 128
    const thirdCleanJourney = await waitForCleanJourneySnapshot(
      smoke.moduleAgentRuntime,
      contractVersion === 1 ? 'v1' : 'v2',
    )
    const thirdGatewaySnapshot = thirdCleanJourney.snapshot
    if (contractVersion === 2 && thirdGatewaySnapshot.v2.retainedRuns !== 6) {
      throw new Error(`Daemon recovery did not preserve exactly six v2 tombstones: ${JSON.stringify(thirdGatewaySnapshot)}`)
    }
    const thirdWorker = thirdCleanJourney.worker
    if (contractVersion === 2 && thirdWorker.epoch === secondWorker.epoch) {
      throw new Error('v2 daemon recovery reused a stopped Worker epoch')
    }
    observedProcessIds.add(thirdWorker.pid)
    await assertOldBearerRejected(
      thirdGatewaySnapshot,
      contractVersion === 1 ? 'v1' : 'v2',
      secondObsoleteBearer,
    )
    const daemonRecoveryCraftTurn = await runVisibleCraftTurn('craft-after-daemon-recovery')
    failurePhase = 130
    if (moduleProviderGroups.size < 3) {
      throw new Error(`Module journeys exposed only ${moduleProviderGroups.size} dedicated provider process groups`)
    }

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
    failurePhase = 140
    if (!stopped.ok) throw new Error(stopped.error ?? 'Coordinator stop failed')
    await waitFor(() => !existsSync(thirdJourney.tokenFile), 'final launch token revocation')
    const stoppedGatewaySnapshot = await smoke.moduleAgentRuntime.refreshDebugSnapshot()
    assertStoppedSnapshot(stoppedGatewaySnapshot)
    assertNoHiddenSessionResidue(smoke, workspace.id, sessionPath)
    const orphan = smoke.manager.list().length !== 0
      || [...observedViewIds].some((webContentsId) => webContents.fromId(webContentsId) !== undefined)
    if (orphan) throw new Error('Coordinator stop left an orphan module WebContentsView')

    const sessionAfterModule = await smoke.sessionManager.getSession(session.id)
    const serverHealthyAfterModule = await canConnect(smoke.serverHost, smoke.serverPort)
    const sessionPersistenceVerified = existsSync(join(sessionPath, 'session.jsonl'))
    if (!sessionPersistenceVerified) throw new Error('Built-in Agent Session persistence was not flushed')
    watchdog.assertMayCommitSuccess()
    failurePhase = 150
    pendingResult = {
      ok: true,
      packaged: app.isPackaged,
      protocolFixture: true,
      acceptanceScope: PROTOCOL_FIXTURE_SCOPE,
      scenario,
      coordinatorLifecycle: true,
      workerCrashRecovered: true,
      moduleCrashRestarted: true,
      hostAgentRuntime: {
        contractVersion,
        deterministicTurns: true,
        deterministicMultiTurn: contractVersion === 1,
        ordinaryJsonEventStreamCli: contractVersion === 2
          && [firstJourney, secondJourney, thirdJourney].every((journey) => journey.ordinaryJsonEventStreamCli),
        oneTurnPerSession: contractVersion === 2
          && [firstJourney, secondJourney, thirdJourney].every((journey) => journey.oneTurnPerSession)
          && terminalSessionIds.length === 6 && new Set(terminalSessionIds).size === 6,
        terminalSessionEvents: terminalSessionIds.length,
        uniqueTerminalSessions: new Set(terminalSessionIds).size,
        shimResourceHashVerified: contractVersion === 2
          && [firstJourney, secondJourney, thirdJourney].every((journey) => journey.shimResourceHashVerified),
        crashGrantRotated: true,
        workerEpochRotated: true,
        oldGrantRevoked: true,
        stopGrantRevoked: true,
        zeroHiddenSessions: true,
        firstGatewaySnapshot,
        secondGatewaySnapshot,
        thirdGatewaySnapshot,
        stoppedGatewaySnapshot,
      },
      moduleId: manifest.id,
      moduleVersion: manifest.version,
      renderer,
      resourceText,
      preloadIsolated: renderer.requireType === 'undefined' && renderer.processType === 'undefined',
      noOrphanWebContents: true,
      builtInAgentIndependent: builtInRuntimeUnaffected && sessionAfterModule?.id === session.id,
      builtInAgent: {
        deterministicTurn: true,
        visibleTurnCount: 3,
        visibleTurns: [initialCraftTurn, workerRecoveryCraftTurn, daemonRecoveryCraftTurn],
        sessionPersistenceVerified,
        serverHealthyBeforeModule,
        serverHealthyAfterModule,
        hostMainProcessId,
        hostWebContentsId,
        hostRendererProcessId,
      },
      smokeOwnedProcessGroups: [...smokeOwnedProcessGroups],
      processEvidence: {
        observedPids: [...observedProcessIds].filter((pid) => Number.isSafeInteger(pid) && pid > 0),
        providerProcessGroups: [...moduleProviderGroups],
        records: [...safeProcessRecords.values()],
        sanitizedFields: ['pid', 'ppid', 'pgid', 'role', 'executable-basename'],
        checkWithinMs: 10_000,
      },
    }
  } catch {
    if (!watchdog.timedOut) {
      pendingResult = {
        ok: false,
        packaged: app.isPackaged,
        errorCode: 'SMOKE_FAILED',
        failurePhase,
        smokeOwnedProcessGroups: [...smokeOwnedProcessGroups],
      }
    }
  } finally {
    clearTimeout(timeout)
    unsubscribeModuleRuntimeEvents?.()
    await close(provider).catch(() => undefined)
  }

  writeResult(resultPath, { ...pendingResult, phase: 'awaiting-before-quit-cleanup' })
  app.quit()
  app.quit()
  return true
}
