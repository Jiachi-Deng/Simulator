#!/usr/bin/env bun

import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { createInterface } from 'node:readline'
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as tar from 'tar'
import {
  OPEN_DESIGN_M1_CASES,
  type OpenDesignM1Case,
} from './open-design-m1-cases'
import {
  OPEN_DESIGN_HOST_ARTIFACT_NAME,
  OPEN_DESIGN_HOST_VERSION,
  OPEN_DESIGN_LKG_ARCHIVE_ASSET,
  OPEN_DESIGN_LKG_TAG,
  OPEN_DESIGN_LKG_VERSION,
  OPEN_DESIGN_M1_CASE_HASHES,
  OPEN_DESIGN_M1_CASE_MANIFEST_SHA256,
  OPEN_DESIGN_M1_CASE_SEED_CHECKSUMS_SHA256,
  OPEN_DESIGN_RC_ARCHIVE_ASSET,
  OPEN_DESIGN_RC_SOURCE_SHA,
  OPEN_DESIGN_RC_TAG,
  OPEN_DESIGN_RC_VERSION,
  OPEN_DESIGN_REQUIRED_CI_WORKFLOW_PATHS,
} from './open-design-rc-acceptance-evidence'
import {
  OPEN_DESIGN_M1_MACHINE_ARTIFACT_NAME,
  OPEN_DESIGN_M1_MACHINE_WORKFLOW_PATH,
  expectedMachineEvidencePaths,
  type MachineEvidenceAuthority,
  type OpenDesignM1Stack,
  validateOpenDesignM1MachineEvidence,
} from './open-design-m1-machine-evidence'
import {
  createOpenDesignM1BatchProgress,
  preserveOpenDesignM1FirstFailure,
  runTrackedOpenDesignM1Case,
  type OpenDesignM1CaseFailurePhase,
  type OpenDesignM1FailureCleanupEvidence,
  type OpenDesignM1FirstFailureAuthority,
  type OpenDesignM1LifecycleFailurePhase,
} from './open-design-m1-machine-first-failure'

const REAL_OPT_IN = 'packaged-open-design-direct-observation'
const CONFIRMATION = 'RUN_OPEN_DESIGN_M1_40_PAID_TURNS_STOP_ON_FIRST_FAILURE'
const REPOSITORY = 'Jiachi-Deng/Simulator'
const CDP_PORT = 9347
const WAIT_TIMEOUT_MS = 10 * 60_000
const BLACKOUT_MS = 65_000
const HEARTBEAT_MS = 10_000
const SHA256 = /^[0-9a-f]{64}$/
const COMMIT = /^[0-9a-f]{40}$/
const RELEASE_KEY_ID = 'open-design-release-2026-01'
const RELEASE_PUBLIC_KEY = 'KvpR89GuQd670SZMZuuR+aK4FUIprxRlqE58K3twQZk='
const OPEN_DESIGN_RELEASE_WORKFLOW_PATH = '.github/workflows/open-design-release.yml'
const OPEN_DESIGN_RELEASE_TRANSACTION_STATUSES = Object.freeze([
  'waiting', 'queued', 'in_progress', 'pending', 'requested',
] as const)
export const OPEN_DESIGN_M1_MACHINE_ACCEPTANCE_DESCRIPTOR_CANONICAL_JSON = `${JSON.stringify({
  schemaVersion: 1,
  hostVersion: '0.12.0',
  moduleId: 'org.simulator.open-design',
  platform: 'darwin-arm64',
  stableVersion: '0.14.5',
  stableCatalogUrl: 'https://github.com/Jiachi-Deng/Simulator/releases/download/open-design-v0.14.5/org.simulator.open-design-0.14.5-catalog-v2-envelope.json',
  rcVersion: '0.14.6-rc.1',
  releaseTag: 'open-design-v0.14.6-rc.1',
  catalogUrl: 'https://github.com/Jiachi-Deng/Simulator/releases/download/open-design-v0.14.6-rc.1/org.simulator.open-design-0.14.6-rc.1-catalog-v2-envelope.json',
  minimumCatalogSequence: 2,
  initialCatalogIssuedAt: '2026-07-16T21:35:33.862Z',
  archiveUrl: 'https://github.com/Jiachi-Deng/Simulator/releases/download/open-design-v0.14.6-rc.1/org.simulator.open-design-0.14.6-rc.1-darwin-arm64.tar.gz',
  archiveSha256: '1dd67f6ac536b61009410014ceab562bcba24e0d2694e353914915338d0ef0a3',
  artifactSize: 61_478_074,
  extractedManifestSha256: 'f24ad9a7035731f4f3b3e23b8f3b6c6c9654d4502dda43d9cb70d8d2159c7bbe',
  entrypoint: 'runtime/open-design-launcher',
  auxiliaryExecutables: [
    'runtime/node/bin/node',
    'runtime/daemon/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper',
  ],
  capabilities: ['host-agent.use', 'workspace.read', 'workspace.write'],
  hostVersionRange: '>=0.12.0',
  githubOwner: 'Jiachi-Deng',
  githubRepository: 'Simulator',
  trustedKeyId: 'open-design-release-2026-01',
  trustedPublicKeySha256: 'f4e7b85cfa73e1f48caceed15aa5d4d0136a63ac73dcdc495ddee1229f5d0d6d',
  trustedKeyActiveFrom: '2026-07-15T00:00:00.000Z',
  trustedKeyActiveUntil: '2027-07-15T00:00:00.000Z',
})}\n`

type JsonObject = Record<string, unknown>
type CdpTarget = { id: string; title: string; type: string; url: string; webSocketDebuggerUrl: string }
type FileRef = { path: string; sha256: string }
type BlackoutProxyChild = { bunPath: string; scriptPath: string }
type RuntimeCleanupSnapshot = {
  schemaVersion: 1
  v1: { activeRuns: number; moduleSessions: number }
  v2: { activeRuns: number; moduleSessions: number }
  sessions: { hiddenSessions: number; transientSessions: number; quarantinedSessions: number }
}
type RendererEvaluator = { evaluate(expression: string): Promise<unknown> }
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>
type PreviewPageClient = RendererEvaluator & {
  connect(): Promise<void>
  screenshot(): Promise<Buffer>
  close(): void
}
type ProcessIdentity = { pid: number; commandSha256: string }
type ProcessRow = ProcessIdentity & { ppid: number; command: string }

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex')
}

function canonical(value: unknown): string { return `${JSON.stringify(value)}\n` }
function sleep(ms: number): Promise<void> { return new Promise((resolvePromise) => setTimeout(resolvePromise, ms)) }

async function withDeadline<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs)
  })
  try {
    return await Promise.race([operation, deadline])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function requiredEnv(name: string, pattern?: RegExp): string {
  const value = process.env[name]
  if (!value || (pattern && !pattern.test(value))) throw new TypeError(`${name} is invalid`)
  return value
}

function positiveInteger(name: string): number {
  const value = requiredEnv(name, /^[1-9][0-9]*$/)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw new TypeError(`${name} is invalid`)
  return parsed
}

function pathContains(parent: string, candidate: string): boolean {
  const relation = relative(parent, candidate)
  return relation === '' || (relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation))
}

async function isolatedPath(name: string, runnerTemp: string): Promise<string> {
  const value = resolve(requiredEnv(name))
  const canonicalParent = await realpath(dirname(value))
  const candidate = resolve(canonicalParent, basename(value))
  if (!pathContains(runnerTemp, candidate) || candidate === runnerTemp) throw new TypeError(`${name} leaves RUNNER_TEMP`)
  return candidate
}

async function trustedOwnerExecutablePath(name: string, executable: boolean): Promise<string> {
  const value = requiredEnv(name)
  if (!isAbsolute(value)) throw new TypeError(`${name} must be absolute`)
  const canonicalPath = await realpath(value)
  if (canonicalPath !== value) throw new TypeError(`${name} must be canonical`)
  const metadata = await lstat(canonicalPath)
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : undefined
  if (!metadata.isFile() || metadata.isSymbolicLink()
    || (currentUid !== undefined && metadata.uid !== currentUid && metadata.uid !== 0)
    || (metadata.mode & 0o022) !== 0
    || (executable && (metadata.mode & 0o111) === 0)) {
    throw new TypeError(`${name} is not a trusted owner executable path`)
  }
  return canonicalPath
}

export async function preflightExternalBlackoutProxyChild(
  childAuthority: BlackoutProxyChild,
  stagingRoot: string,
): Promise<void> {
  const tokenFile = join(stagingRoot, 'blackout-proxy-preflight.token')
  await writeFile(tokenFile, `${randomUUID()}${randomUUID()}`, { mode: 0o600, flag: 'wx' })
  const child = spawn(childAuthority.bunPath, [childAuthority.scriptPath], {
    cwd: dirname(childAuthority.scriptPath),
    env: {},
    stdio: ['pipe', 'pipe', 'ignore'],
  })
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity, terminal: false })
  const iterator = lines[Symbol.asyncIterator]()
  const request = async (value: JsonObject): Promise<JsonObject> => {
    const requestId = value.requestId
    if (typeof requestId !== 'string') throw new Error('Blackout proxy preflight request is invalid')
    child.stdin.write(`${JSON.stringify(value)}\n`)
    const result = await Promise.race([
      iterator.next(),
      sleep(10_000).then(() => ({ done: true as const, value: undefined })),
    ])
    if (result.done || typeof result.value !== 'string' || Buffer.byteLength(result.value, 'utf8') > 32 * 1024) {
      throw new Error('Blackout proxy preflight response is unavailable')
    }
    const response = exactObject(JSON.parse(result.value),
      value.command === 'initialize'
        ? ['blackoutMs', 'heartbeatMs', 'port', 'producer', 'requestId', 'schemaVersion', 'type']
        : ['requestId', 'schemaVersion', 'type'],
      'Blackout proxy preflight response')
    if (response.schemaVersion !== 1 || response.requestId !== requestId) {
      throw new Error('Blackout proxy preflight response identity is invalid')
    }
    return response
  }
  try {
    const ready = await request({
      schemaVersion: 1,
      command: 'initialize',
      requestId: `preflight-${randomUUID()}`,
      upstreamBaseUrl: 'http://127.0.0.1:1',
      tokenFile,
      blackoutMs: BLACKOUT_MS,
      heartbeatMs: HEARTBEAT_MS,
    })
    if (ready.type !== 'ready' || ready.producer !== 'external-host-agent-sse-proxy'
      || ready.blackoutMs !== BLACKOUT_MS || ready.heartbeatMs !== HEARTBEAT_MS
      || !Number.isSafeInteger(ready.port) || (ready.port as number) < 1 || (ready.port as number) > 65_535) {
      throw new Error('Blackout proxy preflight did not become ready')
    }
    const stopped = await request({ schemaVersion: 1, command: 'shutdown', requestId: `stop-${randomUUID()}` })
    if (stopped.type !== 'stopped') throw new Error('Blackout proxy preflight did not stop')
    child.stdin.end()
    const exitCode = child.exitCode ?? await Promise.race([
      new Promise<number | null>((resolveExit) => child.once('exit', (code) => resolveExit(code))),
      sleep(10_000).then(() => null),
    ])
    if (exitCode !== 0) throw new Error('Blackout proxy preflight child did not exit cleanly')
  } finally {
    lines.close()
    if (child.exitCode === null) {
      child.kill('SIGKILL')
      await Promise.race([
        new Promise<void>((resolveExit) => child.once('exit', () => resolveExit())),
        sleep(5_000),
      ])
    }
    await rm(tokenFile, { force: true })
  }
}

async function waitFor<T>(description: string, probe: () => T | undefined | false | Promise<T | undefined | false>, timeoutMs = WAIT_TIMEOUT_MS): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const result = await probe()
      if (result) return result
    } catch (error) { lastError = error }
    await sleep(250)
  }
  throw new Error(`${description} was not observed${lastError instanceof Error ? ` (${lastError.name})` : ''}`)
}

export async function runFixedFailStopBatch<T>(
  tasks: readonly T[],
  execute: (task: T, index: number) => Promise<void>,
): Promise<number> {
  let completed = 0
  for (let index = 0; index < tasks.length; index += 1) {
    await execute(tasks[index]!, index)
    completed += 1
  }
  return completed
}

class CdpClient {
  readonly #socket: WebSocket
  readonly #pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>()
  #nextId = 1

  constructor(url: string) { this.#socket = new WebSocket(url) }

  async connect(): Promise<void> {
    await new Promise<void>((resolvePromise, reject) => {
      this.#socket.addEventListener('open', () => resolvePromise(), { once: true })
      this.#socket.addEventListener('error', () => reject(new Error('CDP connection failed')), { once: true })
    })
    this.#socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message?: string } }
      if (!message.id) return
      const pending = this.#pending.get(message.id)
      if (!pending) return
      this.#pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error.message ?? 'CDP request failed'))
      else pending.resolve(message.result)
    })
    this.#socket.addEventListener('close', () => {
      for (const pending of this.#pending.values()) pending.reject(new Error('CDP closed'))
      this.#pending.clear()
    })
    await this.send('Runtime.enable')
    await this.send('Page.enable')
  }

  send(method: string, params: JsonObject = {}): Promise<any> {
    const id = this.#nextId++
    return new Promise((resolvePromise, reject) => {
      this.#pending.set(id, { resolve: resolvePromise, reject })
      this.#socket.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate(expression: string): Promise<any> {
    const response = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true, userGesture: true,
    })
    if (response.exceptionDetails) throw new Error('Renderer evaluation failed')
    return response.result?.value
  }

  async screenshot(): Promise<Buffer> {
    const result = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
    if (typeof result?.data !== 'string') throw new Error('CDP screenshot is unavailable')
    const bytes = Buffer.from(result.data, 'base64')
    if (bytes.byteLength < 8 || bytes.byteLength > 4 * 1024 * 1024) throw new Error('CDP screenshot size is invalid')
    return bytes
  }

  close(): void { this.#socket.close() }
}

export async function requirePaidTurnRuntimeBaseline(cdp: RendererEvaluator): Promise<void> {
  const snapshot = await queryRuntimeCleanup(cdp)
  if (!runtimeIsClean(snapshot)) {
    throw new Error('Module Runtime or global Session residue exists before paid Turn batch')
  }
}

export async function runFixedPaidTurnBatch<T>(
  tasks: readonly T[],
  cdp: RendererEvaluator,
  execute: (task: T, index: number) => Promise<void>,
): Promise<number> {
  await requirePaidTurnRuntimeBaseline(cdp)
  return runFixedFailStopBatch(tasks, execute)
}

function exactLoopbackPreviewUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port
    || url.username || url.password || url.search || url.hash) {
    throw new Error('Preview screenshot URL is invalid')
  }
  return url.href
}

export async function requirePreviewHttp200(
  previewUrl: string,
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  const canonicalUrl = exactLoopbackPreviewUrl(previewUrl)
  const response = await fetchImpl(canonicalUrl, { redirect: 'error' })
  const status = response.status
  try {
    await response.body?.cancel()
  } catch {
    throw new Error('Preview HTTP response body did not close')
  }
  if (status !== 200) throw new Error('Preview did not return HTTP 200')
}

export async function capturePreviewUrlScreenshot(
  previewUrl: string,
  dependencies: {
    cdpOrigin?: string
    fetchImpl?: FetchLike
    createClient?: (webSocketDebuggerUrl: string) => PreviewPageClient
  } = {},
): Promise<Buffer> {
  const canonicalUrl = exactLoopbackPreviewUrl(previewUrl)
  const cdpOrigin = dependencies.cdpOrigin ?? `http://127.0.0.1:${CDP_PORT}`
  const fetchImpl = dependencies.fetchImpl ?? fetch
  const createClient = dependencies.createClient ?? ((url: string) => new CdpClient(url))
  const createResponse = await fetchImpl(
    `${cdpOrigin}/json/new?${encodeURIComponent(canonicalUrl)}`,
    { method: 'PUT', redirect: 'error' },
  )
  const createBody = await createResponse.text()
  if (!createResponse.ok || Buffer.byteLength(createBody, 'utf8') > 32 * 1024) {
    throw new Error('Preview CDP target creation failed')
  }
  let target: unknown
  try { target = JSON.parse(createBody) } catch { throw new Error('Preview CDP target response is invalid') }
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    throw new Error('Preview CDP target response is invalid')
  }
  const id = (target as JsonObject).id
  const webSocketDebuggerUrl = (target as JsonObject).webSocketDebuggerUrl
  if (typeof id !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(id)) {
    throw new Error('Preview CDP target identity is invalid')
  }

  let client: PreviewPageClient | undefined
  let screenshot: Buffer | undefined
  let failure: unknown
  try {
    if ((target as JsonObject).type !== 'page' || typeof webSocketDebuggerUrl !== 'string') {
      throw new Error('Preview CDP target socket is invalid')
    }
    let socketUrl: URL
    try { socketUrl = new URL(webSocketDebuggerUrl) } catch { throw new Error('Preview CDP target socket is invalid') }
    const cdpUrl = new URL(cdpOrigin)
    if (socketUrl.protocol !== 'ws:' || socketUrl.hostname !== cdpUrl.hostname || socketUrl.port !== cdpUrl.port
      || socketUrl.username || socketUrl.password || socketUrl.pathname !== `/devtools/page/${id}`) {
      throw new Error('Preview CDP target socket is invalid')
    }
    client = createClient(webSocketDebuggerUrl)
    await client.connect()
    await waitFor('Preview page load', async () => {
      const state = await client!.evaluate(`({href:window.location.href,readyState:document.readyState})`)
      if (!state || typeof state !== 'object' || Array.isArray(state)) return false
      return (state as JsonObject).href === canonicalUrl && (state as JsonObject).readyState === 'complete'
    }, 30_000)
    const captured = await client.screenshot()
    if (!Buffer.isBuffer(captured) || captured.byteLength < 8 || captured.byteLength > 4 * 1024 * 1024
      || !captured.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      throw new Error('Preview screenshot is invalid')
    }
    screenshot = captured
  } catch (error) {
    failure = error
  }
  let clientCloseError: unknown
  try { client?.close() } catch (error) { clientCloseError = error }
  try {
    const closeResponse = await fetchImpl(`${cdpOrigin}/json/close/${encodeURIComponent(id)}`, { redirect: 'error' })
    const closeBody = await closeResponse.text()
    if (!closeResponse.ok || Buffer.byteLength(closeBody, 'utf8') > 4 * 1024) {
      throw new Error('Preview CDP target cleanup failed')
    }
  } catch (cleanupError) {
    failure = failure
      ? new AggregateError([failure, cleanupError], 'Preview capture and cleanup failed')
      : cleanupError
  }
  if (clientCloseError) {
    failure = failure
      ? new AggregateError([failure, clientCloseError], 'Preview capture and cleanup failed')
      : clientCloseError
  }
  if (failure) throw failure
  if (!screenshot) throw new Error('Preview screenshot is unavailable')
  return screenshot
}

function rendererCall(facade: string, method: string, ...args: unknown[]): string {
  return `(async()=>{const f=window.electronAPI?.[${JSON.stringify(facade)}];if(!f||typeof f[${JSON.stringify(method)}]!=='function')throw new Error('facade unavailable');return await f[${JSON.stringify(method)}](...${JSON.stringify(args)});})()`
}

function exactObject(value: unknown, keys: readonly string[], name: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} is invalid`)
  const object = value as JsonObject
  const actual = Object.keys(object).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${name} is invalid`)
  }
  return object
}

async function requireExternalBlackoutProxy(cdp: CdpClient): Promise<void> {
  const capability = exactObject(
    await cdp.evaluate(rendererCall('openDesignAcceptance', 'getBlackoutProxyCapability')),
    ['available', 'blackoutMs', 'heartbeatMs', 'producer', 'schemaVersion'],
    'Host blackout proxy capability',
  )
  if (capability.available !== true || capability.schemaVersion !== 1
    || capability.producer !== 'external-host-agent-sse-proxy'
    || capability.blackoutMs !== BLACKOUT_MS || capability.heartbeatMs !== HEARTBEAT_MS) {
    throw new Error('External Host Agent SSE blackout proxy is unavailable')
  }
}

async function requireAuthenticatedCraftRuntime(cdp: CdpClient): Promise<void> {
  const ready = await cdp.evaluate(`(async()=>{
    const list=window.electronAPI?.listLlmConnectionsWithStatus;
    if(typeof list!=='function')return false;
    const connections=await list();
    return Array.isArray(connections)&&connections.some((connection)=>connection?.isAuthenticated===true);
  })()`)
  if (ready !== true) throw new Error('Protected runner has no authenticated Craft Runtime connection')
}

async function requireOpenDesignHostRuntime(origin: string): Promise<void> {
  const response = await fetchJson(`${origin}/api/agents`)
  if (!Array.isArray(response.agents) || response.agents.length !== 1) {
    throw new Error('OpenDesign Host Runtime inventory is invalid')
  }
  const agent = response.agents[0]
  if (!agent || typeof agent !== 'object' || Array.isArray(agent)
    || (agent as JsonObject).id !== 'simulator-host-runtime'
    || (agent as JsonObject).available !== true
    || (agent as JsonObject).streamFormat !== 'json-event-stream') {
    throw new Error('OpenDesign Host Runtime is not ready')
  }
}

function runtimeCleanupSnapshot(value: unknown): RuntimeCleanupSnapshot {
  const snapshot = exactObject(value, ['schemaVersion', 'sessions', 'v1', 'v2'], 'Module Agent Runtime snapshot')
  const v1 = exactObject(snapshot.v1, ['activeRuns', 'moduleSessions'], 'v1 Module Agent Runtime snapshot')
  const v2 = exactObject(snapshot.v2, ['activeRuns', 'moduleSessions'], 'v2 Module Agent Runtime snapshot')
  const sessions = exactObject(snapshot.sessions,
    ['hiddenSessions', 'quarantinedSessions', 'transientSessions'], 'global Module Session snapshot')
  for (const count of [
    v1.activeRuns, v1.moduleSessions, v2.activeRuns, v2.moduleSessions,
    sessions.hiddenSessions, sessions.transientSessions, sessions.quarantinedSessions,
  ]) {
    if (!Number.isSafeInteger(count) || (count as number) < 0) {
      throw new Error('Module Agent Runtime cleanup count is invalid')
    }
  }
  if (snapshot.schemaVersion !== 1) throw new Error('Module Agent Runtime snapshot version is invalid')
  return snapshot as unknown as RuntimeCleanupSnapshot
}

async function queryRuntimeCleanup(cdp: RendererEvaluator): Promise<RuntimeCleanupSnapshot> {
  return runtimeCleanupSnapshot(await cdp.evaluate(
    rendererCall('openDesignAcceptance', 'getModuleAgentRuntimeSnapshot'),
  ))
}

function runtimeIsClean(snapshot: RuntimeCleanupSnapshot): boolean {
  return snapshot.v1.activeRuns === 0 && snapshot.v1.moduleSessions === 0
    && snapshot.v2.activeRuns === 0 && snapshot.v2.moduleSessions === 0
    && snapshot.sessions.hiddenSessions === 0 && snapshot.sessions.transientSessions === 0
    && snapshot.sessions.quarantinedSessions === 0
}

async function requireRuntimeCleanup(cdp: RendererEvaluator, timeoutMs: number): Promise<{
  activeRuns: number
  hiddenSessions: number
  moduleSessions: number
  quarantinedSessions: number
  settledSeconds: number
  transientSessions: number
}> {
  const startedAt = Date.now()
  const snapshot = await waitFor('Module Agent Runtime cleanup', async () => {
    const observed = await queryRuntimeCleanup(cdp)
    return runtimeIsClean(observed) ? observed : false
  }, timeoutMs)
  if (!runtimeIsClean(snapshot)) throw new Error('Module Agent Runtime cleanup did not settle')
  return {
    activeRuns: snapshot.v1.activeRuns + snapshot.v2.activeRuns,
    hiddenSessions: snapshot.sessions.hiddenSessions,
    moduleSessions: snapshot.v1.moduleSessions + snapshot.v2.moduleSessions,
    quarantinedSessions: snapshot.sessions.quarantinedSessions,
    settledSeconds: Math.ceil((Date.now() - startedAt) / 1000),
    transientSessions: snapshot.sessions.transientSessions,
  }
}

async function armExternalBlackoutProxy(cdp: CdpClient, caseId: string, turnOrdinal: number): Promise<string> {
  const arm = exactObject(
    await cdp.evaluate(rendererCall('openDesignAcceptance', 'armNextBlackout', { caseId, stack: 'new', turnOrdinal })),
    ['armed', 'blackoutMs', 'caseId', 'evidenceId', 'heartbeatMs', 'producer', 'schemaVersion', 'turnOrdinal'],
    'Host blackout proxy arm result',
  )
  if (arm.schemaVersion !== 1 || arm.armed !== true || arm.producer !== 'external-host-agent-sse-proxy'
    || arm.blackoutMs !== BLACKOUT_MS || arm.heartbeatMs !== HEARTBEAT_MS
    || arm.caseId !== caseId || arm.turnOrdinal !== turnOrdinal
    || typeof arm.evidenceId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(arm.evidenceId)) {
    throw new Error('External Host Agent SSE blackout proxy did not arm')
  }
  return arm.evidenceId
}

function externalBlackoutLedger(value: unknown, evidenceId: string, caseId: string, turnOrdinal: number): {
  readonly ledger: Array<JsonObject & { sequence: number }>
  readonly blackout: JsonObject
} {
  const evidence = exactObject(value, [
    'bufferedEventCount', 'caseId', 'deliveredFrames', 'endedAt', 'eventSequenceAfter', 'eventSequenceBefore',
    'eventsLost', 'evidenceId', 'heartbeatCount', 'heartbeatMaxGapMs', 'producer', 'replayedEventCount',
    'replayComplete', 'replaySequenceStart', 'schemaVersion', 'startedAt', 'terminalEventCount', 'turnOrdinal',
  ], 'Host blackout proxy evidence')
  if (evidence.schemaVersion !== 1 || evidence.evidenceId !== evidenceId
    || evidence.caseId !== caseId || evidence.turnOrdinal !== turnOrdinal
    || evidence.producer !== 'external-host-agent-sse-proxy'
    || typeof evidence.startedAt !== 'string' || typeof evidence.endedAt !== 'string'
    || Date.parse(evidence.endedAt) - Date.parse(evidence.startedAt) < BLACKOUT_MS
    || evidence.eventsLost !== 0 || evidence.replayComplete !== true || evidence.terminalEventCount !== 1
    || !Number.isSafeInteger(evidence.eventSequenceBefore) || !Number.isSafeInteger(evidence.eventSequenceAfter)
    || !Number.isSafeInteger(evidence.bufferedEventCount) || (evidence.bufferedEventCount as number) < 1
    || !Number.isSafeInteger(evidence.replayedEventCount) || evidence.replayedEventCount !== evidence.bufferedEventCount
    || !Number.isSafeInteger(evidence.replaySequenceStart)
    || !Number.isSafeInteger(evidence.heartbeatCount) || !Number.isSafeInteger(evidence.heartbeatMaxGapMs)
    || !Array.isArray(evidence.deliveredFrames)) throw new Error('Host blackout proxy evidence is invalid')
  const ledger = evidence.deliveredFrames.map((entry, index) => {
    const event = exactObject(entry, ['at', 'business', 'payloadSha256', 'sequence', 'source', 'type'], `blackout event ${index}`)
    if (event.sequence !== index + 1 || typeof event.at !== 'string' || !Number.isFinite(Date.parse(event.at))
      || typeof event.business !== 'boolean' || typeof event.payloadSha256 !== 'string' || !SHA256.test(event.payloadSha256)
      || !['daemon', 'host-health', 'harness'].includes(String(event.source))
      || typeof event.type !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(event.type)) {
      throw new Error('Host blackout proxy event ledger is invalid')
    }
    return event as JsonObject & { sequence: number }
  })
  const start = Date.parse(evidence.startedAt)
  const end = Date.parse(evidence.endedAt)
  const before = evidence.eventSequenceBefore as number
  const after = evidence.eventSequenceAfter as number
  const replayedEventCount = evidence.replayedEventCount as number
  const replaySequenceStart = evidence.replaySequenceStart as number
  const startBoundary = ledger[before - 1]
  const endBoundary = ledger[after - 1]
  if (before < 1 || after <= before || after > ledger.length
    || replaySequenceStart !== after + 1 || replaySequenceStart + replayedEventCount - 1 > ledger.length
    || startBoundary?.type !== 'blackout.started' || startBoundary.source !== 'harness'
    || startBoundary.business !== false || Date.parse(startBoundary.at as string) !== start
    || endBoundary?.type !== 'blackout.ended' || endBoundary.source !== 'harness'
    || endBoundary.business !== false || Date.parse(endBoundary.at as string) !== end) {
    throw new Error('Host blackout proxy boundaries are invalid')
  }
  const interval = ledger.filter((event) => Date.parse(event.at as string) >= start && Date.parse(event.at as string) <= end)
  if (interval.some((event) => event.business === true)) throw new Error('Host blackout proxy delivered a business event during blackout')
  const heartbeats = interval.filter((event) => event.source === 'host-health' && event.type === 'heartbeat')
  const replayedEvents = ledger.slice(replaySequenceStart - 1, replaySequenceStart - 1 + replayedEventCount)
  if (heartbeats.length !== evidence.heartbeatCount || heartbeats.length < 6
    || replayedEvents.length !== replayedEventCount
    || replayedEvents.some((event) => event.source !== 'daemon' || event.business !== true
      || Date.parse(event.at as string) <= end)
    || ledger.filter((event) => event.type === 'turn.completed').length !== 1) {
    throw new Error('Host blackout proxy heartbeat or terminal evidence is invalid')
  }
  return {
    ledger,
    blackout: {
      bufferedEventCount: evidence.bufferedEventCount,
      endedAt: evidence.endedAt,
      eventSequenceAfter: evidence.eventSequenceAfter,
      eventSequenceBefore: evidence.eventSequenceBefore,
      eventsLost: evidence.eventsLost,
      heartbeatCount: evidence.heartbeatCount,
      heartbeatMaxGapMs: evidence.heartbeatMaxGapMs,
      replayedEventCount: evidence.replayedEventCount,
      replayComplete: evidence.replayComplete,
      replaySequenceStart: evidence.replaySequenceStart,
      required: true,
      startedAt: evidence.startedAt,
    },
  }
}

async function discoverTargets(): Promise<CdpTarget[]> {
  const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)
  if (!response.ok) throw new Error('CDP discovery failed')
  const value = await response.json()
  if (!Array.isArray(value)) throw new Error('CDP target inventory is invalid')
  return value as CdpTarget[]
}

async function craftTarget(): Promise<CdpTarget> {
  return waitFor('Craft renderer CDP target', async () => {
    const targets = await discoverTargets()
    const matches = targets.filter((target) => target.type === 'page'
      && target.url.includes('/dist/renderer/index.html') && target.webSocketDebuggerUrl)
    return matches.length === 1 ? matches[0] : false
  })
}

async function openDesignTarget(): Promise<CdpTarget> {
  return waitFor('OpenDesign CDP target', async () => {
    const targets = await discoverTargets()
    const matches = targets.filter((target) => {
      if (target.type !== 'page' || !target.webSocketDebuggerUrl) return false
      let url: URL
      try { url = new URL(target.url) } catch { return false }
      return url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port !== String(CDP_PORT)
    })
    return matches.length === 1 ? matches[0] : false
  })
}

async function githubJson(path: string, token: string): Promise<any> {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' },
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`GitHub authority request failed: ${response.status}`)
  return response.json()
}

type GitHubJsonRequest = (path: string, token: string) => Promise<any>

/**
 * Catalog freeze is meaningful only when the single Release transaction lane is
 * idle. Query every non-terminal GitHub Actions status independently so a large
 * completed-run history cannot push an active transaction off a bounded page.
 */
export async function requireNoOpenDesignReleaseTransaction(
  token: string,
  request: GitHubJsonRequest = githubJson,
): Promise<void> {
  const workflow = encodeURIComponent(OPEN_DESIGN_RELEASE_WORKFLOW_PATH)
  for (const status of OPEN_DESIGN_RELEASE_TRANSACTION_STATUSES) {
    const result = await request(
      `/repos/${REPOSITORY}/actions/workflows/${workflow}/runs?status=${status}&per_page=100`,
      token,
    )
    if (!result || !Number.isSafeInteger(result.total_count) || result.total_count !== 0
      || !Array.isArray(result.workflow_runs) || result.workflow_runs.length !== 0) {
      throw new Error('OpenDesign Release transaction is not idle')
    }
  }
}

async function downloadCanonicalJson(url: string): Promise<{ bytes: Buffer; value: JsonObject }> {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error('Release authority download failed')
  const finalUrl = new URL(response.url)
  if (!['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'].includes(finalUrl.hostname)) {
    throw new Error('Release authority redirect left the GitHub allowlist')
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.byteLength < 3 || bytes.byteLength > 256 * 1024) throw new Error('Release authority JSON size is invalid')
  const source = bytes.toString('utf8')
  const value = JSON.parse(source) as JsonObject
  if (source !== JSON.stringify(value)) throw new Error('Release authority JSON is not exact canonical release bytes')
  return { bytes, value }
}

function authenticateCatalogEnvelope(
  catalog: { bytes: Buffer; value: JsonObject },
  envelope: { bytes: Buffer; value: JsonObject },
): void {
  const fields = Object.keys(envelope.value).sort()
  if (fields.join(',') !== ['catalogBytes', 'keyId', 'schemaVersion', 'signature'].sort().join(',')
    || envelope.value.schemaVersion !== 1 || envelope.value.keyId !== RELEASE_KEY_ID
    || typeof envelope.value.catalogBytes !== 'string' || typeof envelope.value.signature !== 'string') {
    throw new Error('Release Catalog envelope schema is invalid')
  }
  const catalogBytes = Buffer.from(envelope.value.catalogBytes, 'base64')
  const signature = Buffer.from(envelope.value.signature, 'base64')
  if (catalogBytes.toString('base64') !== envelope.value.catalogBytes
    || signature.toString('base64') !== envelope.value.signature || signature.byteLength !== 64
    || !catalogBytes.equals(catalog.bytes)) throw new Error('Release Catalog envelope bytes are invalid')
  const rawPublicKey = Buffer.from(RELEASE_PUBLIC_KEY, 'base64')
  if (rawPublicKey.byteLength !== 32) throw new Error('Release public key is invalid')
  const publicKey = createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), rawPublicKey]),
    format: 'der',
    type: 'spki',
  })
  if (!verify(null, catalogBytes, publicKey, signature)) throw new Error('Release Catalog signature is invalid')
}

function catalogRelease(catalog: JsonObject, version: string): JsonObject {
  if (!Array.isArray(catalog.releases)) throw new Error('Catalog releases are missing')
  const matches = catalog.releases.filter((item) => (item as JsonObject)?.version === version)
  if (matches.length !== 1) throw new Error('Catalog release selection failed')
  return matches[0] as JsonObject
}

function releaseArtifact(release: JsonObject): JsonObject {
  if (!Array.isArray(release.artifacts) || release.artifacts.length !== 1) throw new Error('Catalog artifact selection failed')
  return release.artifacts[0] as JsonObject
}

function installMetadata(release: JsonObject): JsonObject {
  if (!Array.isArray(release.artifactInstallMetadata) || release.artifactInstallMetadata.length !== 1) {
    throw new Error('Catalog install metadata selection failed')
  }
  return release.artifactInstallMetadata[0] as JsonObject
}

async function fetchReleaseAuthority(version: '0.14.5' | '0.14.6-rc.1'): Promise<{
  release: MachineEvidenceAuthority['lkg']
  catalog: { bytes: Buffer; value: JsonObject }
  envelope: { bytes: Buffer; value: JsonObject }
}> {
  const tag = version === OPEN_DESIGN_LKG_VERSION ? OPEN_DESIGN_LKG_TAG : OPEN_DESIGN_RC_TAG
  const stem = `org.simulator.open-design-${version}`
  const base = `https://github.com/${REPOSITORY}/releases/download/${tag}`
  const catalog = await downloadCanonicalJson(`${base}/${stem}-catalog-v2.json`)
  const envelope = await downloadCanonicalJson(`${base}/${stem}-catalog-v2-envelope.json`)
  authenticateCatalogEnvelope(catalog, envelope)
  const release = catalogRelease(catalog.value, version)
  const artifact = releaseArtifact(release)
  const metadata = installMetadata(release)
  const archiveSha256 = artifact.sha256
  const extractedManifestSha256 = metadata.extractedManifestSha256
  if (typeof archiveSha256 !== 'string' || !SHA256.test(archiveSha256)
    || typeof extractedManifestSha256 !== 'string' || !SHA256.test(extractedManifestSha256)
    || !Number.isSafeInteger(catalog.value.sequence)
    || typeof catalog.value.issuedAt !== 'string' || typeof catalog.value.expiresAt !== 'string') {
    throw new Error('Catalog authority fields are invalid')
  }
  return {
    release: {
      archiveSha256,
      catalogIssuedAt: catalog.value.issuedAt,
      catalogSequence: catalog.value.sequence as number,
      catalogSha256: sha256(catalog.bytes),
      envelopeSha256: sha256(envelope.bytes),
      expiresAt: catalog.value.expiresAt,
      extractedManifestSha256,
    },
    catalog,
    envelope,
  }
}

type ReleaseAuthoritySnapshot = Awaited<ReturnType<typeof fetchReleaseAuthority>>

/** Require exact signed Catalog/envelope bytes and parsed authority to remain frozen. */
export function requireReleaseCatalogUnchanged(
  before: ReleaseAuthoritySnapshot,
  after: ReleaseAuthoritySnapshot,
): void {
  if (!before.catalog.bytes.equals(after.catalog.bytes)
    || !before.envelope.bytes.equals(after.envelope.bytes)
    || canonical(before.release) !== canonical(after.release)) {
    throw new Error('OpenDesign Release Catalog changed during paid acceptance')
  }
}

async function requiredCiEvidence(headSha: string, token: string): Promise<JsonObject> {
  const runs: JsonObject[] = []
  for (const workflowPath of OPEN_DESIGN_REQUIRED_CI_WORKFLOW_PATHS) {
    const encoded = encodeURIComponent(workflowPath)
    const response = await githubJson(`/repos/${REPOSITORY}/actions/workflows/${encoded}/runs?branch=main&status=success&per_page=100`, token)
    if (!Array.isArray(response.workflow_runs)) throw new Error(`Required CI inventory is invalid: ${workflowPath}`)
    const matches = (response.workflow_runs as JsonObject[]).filter((run) => run.head_sha === headSha
      && run.conclusion === 'success' && run.head_branch === 'main' && run.path === workflowPath
      && (run.repository as JsonObject | undefined)?.full_name === REPOSITORY
      && Number.isSafeInteger(run.id) && (run.id as number) > 0
      && Number.isSafeInteger(run.run_attempt) && (run.run_attempt as number) > 0)
      .sort((left, right) => (right.id as number) - (left.id as number))
    if (matches.length < 1) throw new Error(`Required CI is missing: ${workflowPath}`)
    const run = matches[0]!
    runs.push({ workflowPath, runId: run.id, runAttempt: run.run_attempt, headSha, conclusion: 'success' })
  }
  return { schemaVersion: 1, headSha, passed: true, runs }
}

async function writeCanonical(root: string, path: string, value: unknown): Promise<void> {
  const destination = join(root, path)
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  await writeFile(destination, canonical(value), { mode: 0o600, flag: 'wx' })
}

async function findProjectDirectory(moduleDataRoot: string, projectId: string): Promise<string> {
  const matches: string[] = []
  async function visit(directory: string, depth: number): Promise<void> {
    if (depth > 8) return
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      const child = join(directory, entry.name)
      if (entry.name === projectId) matches.push(await realpath(child))
      else await visit(child, depth + 1)
    }
  }
  await waitFor('OpenDesign project directory', async () => {
    matches.length = 0
    await visit(moduleDataRoot, 0)
    return matches.length === 1 ? true : false
  })
  if (!pathContains(await realpath(moduleDataRoot), matches[0]!)) throw new Error('Project directory escaped module data root')
  return matches[0]!
}

async function fetchJson(url: string, init?: RequestInit): Promise<any> {
  const response = await fetch(url, init)
  if (!response.ok) throw new Error(`OpenDesign API failed: ${response.status}`)
  return response.json()
}

async function createProject(origin: string, testCase: OpenDesignM1Case): Promise<{ projectId: string; conversationId: string }> {
  const projectId = `m1_${testCase.id.toLowerCase()}_${randomUUID().replaceAll('-', '')}`
  const response = await fetchJson(`${origin}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: projectId, name: `M1 ${testCase.id}`, metadata: { kind: 'prototype' }, skipDiscoveryBrief: true }),
  })
  if (typeof response.conversationId !== 'string' || response.conversationId.length < 1) throw new Error('OpenDesign project has no conversation')
  return { projectId, conversationId: response.conversationId }
}

async function startRun(origin: string, projectId: string, conversationId: string, prompt: string): Promise<string> {
  const response = await fetch(`${origin}/api/runs`, {
    method: 'POST', headers: {
      'content-type': 'application/json', 'x-od-analytics-device-id': 'simulator-m1-machine',
      'x-od-analytics-session-id': 'simulator-m1-machine', 'x-od-analytics-client-type': 'web',
    },
    body: JSON.stringify({
      projectId, conversationId, assistantMessageId: `assistant_${randomUUID()}`,
      clientRequestId: `client_${randomUUID()}`, agentId: 'simulator-host-runtime',
      message: prompt, currentPrompt: prompt,
    }),
  })
  if (response.status !== 202) throw new Error(`OpenDesign run was not accepted: ${response.status}`)
  const body = await response.json()
  if (typeof body.runId !== 'string' || body.runId.length < 1) throw new Error('OpenDesign run has no id')
  return body.runId
}

async function runStatus(origin: string, runId: string): Promise<JsonObject> {
  return fetchJson(`${origin}/api/runs/${encodeURIComponent(runId)}`)
}

async function waitForTerminal(origin: string, runId: string): Promise<{ status: JsonObject; observedAt: number }> {
  const status = await waitFor('OpenDesign terminal run state', async () => {
    const value = await runStatus(origin, runId)
    return ['succeeded', 'failed', 'canceled'].includes(String(value.status)) ? value : false
  })
  if (status.status !== 'succeeded') throw new Error('OpenDesign run did not succeed')
  return { status, observedAt: Date.now() }
}

async function rawRunEvents(status: JsonObject, moduleDataRoot: string): Promise<JsonObject[]> {
  if (typeof status.eventsLogPath !== 'string' || !isAbsolute(status.eventsLogPath)) throw new Error('Run event log path is unavailable')
  const eventPath = await realpath(status.eventsLogPath)
  if (!pathContains(await realpath(moduleDataRoot), eventPath)) throw new Error('Run event log escaped module data root')
  const metadata = await lstat(eventPath)
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > 8 * 1024 * 1024) {
    throw new Error('Run event log is invalid')
  }
  return (await readFile(eventPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as JsonObject)
}

function eventTimestamp(event: JsonObject): number {
  if (!Number.isSafeInteger(event.timestamp)) throw new Error('Run event lacks a trustworthy timestamp')
  return event.timestamp as number
}

function eventType(event: JsonObject): string {
  const data = event.data as JsonObject | undefined
  const candidate = typeof data?.type === 'string' ? data.type : event.event
  if (typeof candidate !== 'string' || candidate.length < 1) throw new Error('Run event type is invalid')
  return candidate.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128)
}

function presentationUrl(events: JsonObject[], expectedRoute: '/'): string {
  for (const event of events) {
    const data = event.data as JsonObject | undefined
    const presentation = data?.presentation as JsonObject | undefined
    if (data?.type !== 'presentation' && data?.type !== 'presentation.item'
      && presentation?.kind !== 'preview') continue
    const candidate = typeof presentation?.uri === 'string'
      ? presentation.uri
      : typeof data?.uri === 'string' ? data.uri : undefined
    if (!candidate) continue
    const url = new URL(candidate)
    if (url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port
      && url.pathname === expectedRoute && !url.search && !url.hash && !url.username && !url.password) return url.href
  }
  throw new Error('Run has no loopback Preview presentation URL')
}

async function workspaceManifest(root: string, stack: OpenDesignM1Stack, testCase: OpenDesignM1Case): Promise<JsonObject> {
  const canonicalRoot = await realpath(root)
  const files: Array<{ path: string; sha256: string; bytes: number }> = []
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name)
      const metadata = await lstat(absolute)
      const path = relative(canonicalRoot, absolute).split(sep).join('/')
      if (metadata.isSymbolicLink()) throw new Error('Workspace contains a symlink')
      if (metadata.isDirectory()) await visit(absolute)
      else if (metadata.isFile() && metadata.nlink === 1 && metadata.size > 0 && metadata.size <= 4 * 1024 * 1024) {
        files.push({ path, sha256: sha256(await readFile(absolute)), bytes: metadata.size })
      } else throw new Error('Workspace contains an invalid file')
    }
  }
  await visit(canonicalRoot)
  files.sort((left, right) => left.path.localeCompare(right.path))
  for (const required of testCase.requiredFiles) {
    const file = files.find((candidate) => candidate.path === required)
    if (!file) throw new Error(`Workspace omits ${required}`)
  }
  for (const expected of testCase.requiredContent) {
    const source = await readFile(join(canonicalRoot, expected.path), 'utf8')
    if (!source.includes(expected.marker)) throw new Error(`Workspace marker is missing: ${expected.path}`)
  }
  return {
    schemaVersion: 1, stack, caseId: testCase.id, files,
    rootDigest: sha256(files.map((file) => `${file.sha256}  ${file.bytes}  ${file.path}\n`).join('')),
  }
}

async function craftSnapshot(cdp: CdpClient, hostPid: number): Promise<{ mainPidSurvived: true; usableAfterTurn: true }> {
  try { process.kill(hostPid, 0) } catch { throw new Error('Craft main PID exited') }
  const workspaces = await cdp.evaluate(`window.electronAPI.getWorkspaces()`)
  if (!Array.isArray(workspaces) || workspaces.length < 1) throw new Error('Craft is not usable after Module Turn')
  return { mainPidSurvived: true, usableAfterTurn: true }
}

async function processInventory(): Promise<ProcessRow[]> {
  const output = await new Promise<string>((resolvePromise, reject) => {
    const child = spawn('/bin/ps', ['-axo', 'pid=,ppid=,command='], { stdio: ['ignore', 'pipe', 'ignore'] })
    const chunks: Buffer[] = []
    child.stdout.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    child.once('error', reject)
    child.once('close', (code) => code === 0 ? resolvePromise(Buffer.concat(chunks).toString('utf8')) : reject(new Error('ps failed')))
  })
  return output.split('\n').flatMap((line): ProcessRow[] => {
    const match = /^\s*([1-9][0-9]*)\s+([0-9]+)\s+(.+)$/u.exec(line)
    if (!match) return []
    const pid = Number(match[1])
    const ppid = Number(match[2])
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid)) return []
    return [{ pid, ppid, command: match[3]!, commandSha256: sha256(match[3]!) }]
  })
}

async function shimProcessCount(): Promise<number> {
  const output = await new Promise<string>((resolvePromise, reject) => {
    const child = spawn('/bin/ps', ['-axo', 'command='], { stdio: ['ignore', 'pipe', 'ignore'] })
    const chunks: Buffer[] = []
    child.stdout.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    child.once('error', reject)
    child.once('close', (code) => code === 0 ? resolvePromise(Buffer.concat(chunks).toString('utf8')) : reject(new Error('ps failed')))
  })
  return output.split('\n').filter((line) => line.includes('simulator-host-agent.mjs')).length
}

async function descendantProcessSnapshot(rootPid: number): Promise<ProcessIdentity[]> {
  const rows = await processInventory()
  const descendants = new Set<number>()
  let changed = true
  while (changed) {
    changed = false
    for (const row of rows) {
      if ((row.ppid === rootPid || descendants.has(row.ppid)) && !descendants.has(row.pid)) {
        descendants.add(row.pid)
        changed = true
      }
    }
  }
  return rows.filter((row) => descendants.has(row.pid))
    .map(({ pid, commandSha256 }) => ({ pid, commandSha256 }))
    .sort((left, right) => left.pid - right.pid)
}

async function remainingProcessTreeCount(snapshot: readonly ProcessIdentity[]): Promise<number> {
  const current = new Map((await processInventory()).map((row) => [row.pid, row.commandSha256]))
  return snapshot.filter((entry) => current.get(entry.pid) === entry.commandSha256).length
}

async function reapExactProcessIdentities(snapshot: readonly ProcessIdentity[]): Promise<number> {
  const signalRemaining = async (signal: NodeJS.Signals): Promise<void> => {
    const current = new Map((await processInventory()).map((row) => [row.pid, row.commandSha256]))
    for (const entry of snapshot) {
      if (current.get(entry.pid) !== entry.commandSha256) continue
      try { process.kill(entry.pid, signal) } catch { /* identity already exited */ }
    }
  }
  if (await remainingProcessTreeCount(snapshot) === 0) return 0
  await signalRemaining('SIGTERM')
  try {
    await waitFor('failed-run descendant process TERM cleanup', async () => (
      await remainingProcessTreeCount(snapshot)
    ) === 0 ? true : false, 5_000)
  } catch { /* escalate only the still-matching identities */ }
  if (await remainingProcessTreeCount(snapshot) !== 0) {
    await signalRemaining('SIGKILL')
    try {
      await waitFor('failed-run descendant process KILL cleanup', async () => (
        await remainingProcessTreeCount(snapshot)
      ) === 0 ? true : false, 5_000)
    } catch { /* return the bounded residual count below */ }
  }
  return remainingProcessTreeCount(snapshot)
}

async function residualOwnedModuleProcessCount(userData: string, proxyScriptPath: string): Promise<number> {
  return (await processInventory()).filter((row) => row.pid !== process.pid && (
    row.command.includes(userData)
    || row.command.includes(proxyScriptPath)
    || row.command.includes('simulator-host-agent.mjs')
  )).length
}

async function ownedModuleProcessSnapshot(userData: string, proxyScriptPath: string): Promise<ProcessIdentity[]> {
  return (await processInventory()).filter((row) => row.pid !== process.pid && (
    row.command.includes(userData) || row.command.includes(proxyScriptPath)
  )).map(({ pid, commandSha256 }) => ({ pid, commandSha256 }))
}

async function ownedBlackoutProxyProcessCount(proxyScriptPath: string): Promise<number> {
  return (await processInventory()).filter((row) => row.pid !== process.pid
    && row.command.includes(proxyScriptPath)).length
}

function readyAcceptanceState(value: unknown, expectedVersion: string, expectedLkg: string | null): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('OpenDesign acceptance state is invalid')
  }
  const state = value as JsonObject
  if (state.status !== 'ready' || state.activeVersion !== expectedVersion
    || state.lastKnownGoodVersion !== expectedLkg || state.running !== true || state.viewAttached !== true) {
    throw new Error('OpenDesign acceptance transition did not reach its exact ready state')
  }
  return state
}

async function preflightRealPackagedV2ProxyAttach(options: {
  craftCdp: CdpClient
  proxyScriptPath: string
}): Promise<JsonObject> {
  let state = await options.craftCdp.evaluate(rendererCall('openDesignAcceptance', 'getState')) as JsonObject
  if (state?.activeVersion === null) {
    const installed = await options.craftCdp.evaluate(rendererCall('openDesignModule', 'install'))
    if (!['available', 'running'].includes(installed?.status)) throw new Error('LKG install failed')
    const started = await options.craftCdp.evaluate(rendererCall('openDesignModule', 'start'))
    if (started?.status !== 'running') throw new Error('LKG start failed')
    state = await options.craftCdp.evaluate(rendererCall('openDesignAcceptance', 'getState')) as JsonObject
  } else if (state?.running !== true) {
    if (![OPEN_DESIGN_LKG_VERSION, OPEN_DESIGN_RC_VERSION].includes(String(state?.activeVersion))) {
      throw new Error('Unexpected Module version before real v2 attach preflight')
    }
    const started = await options.craftCdp.evaluate(rendererCall('openDesignModule', 'start'))
    if (started?.status !== 'running') throw new Error('Module start failed before real v2 attach preflight')
    state = await options.craftCdp.evaluate(rendererCall('openDesignAcceptance', 'getState')) as JsonObject
  }

  if (state?.activeVersion === OPEN_DESIGN_LKG_VERSION) {
    if (state.lastKnownGoodVersion === null) {
      state = await options.craftCdp.evaluate(rendererCall('openDesignAcceptance', 'updateToRc')) as JsonObject
    } else if (state.lastKnownGoodVersion === OPEN_DESIGN_RC_VERSION) {
      state = await options.craftCdp.evaluate(rendererCall('openDesignAcceptance', 'rollback')) as JsonObject
    } else {
      throw new Error('Unexpected LKG pair before real v2 attach preflight')
    }
  } else if (state?.activeVersion !== OPEN_DESIGN_RC_VERSION
    || state.lastKnownGoodVersion !== OPEN_DESIGN_LKG_VERSION) {
    throw new Error('Unexpected RC pair before real v2 attach preflight')
  }
  state = readyAcceptanceState(state, OPEN_DESIGN_RC_VERSION, OPEN_DESIGN_LKG_VERSION)

  const module = await openDesignTarget()
  await requireOpenDesignHostRuntime(new URL(module.url).origin)
  await armExternalBlackoutProxy(options.craftCdp, 'D01', 1)
  await waitFor('real packaged v2 blackout proxy process attach', async () => (
    await ownedBlackoutProxyProcessCount(options.proxyScriptPath)
  ) === 1 ? true : false, 10_000)

  state = await options.craftCdp.evaluate(rendererCall('openDesignAcceptance', 'rollback')) as JsonObject
  state = readyAcceptanceState(state, OPEN_DESIGN_LKG_VERSION, OPEN_DESIGN_RC_VERSION)
  await requireRuntimeCleanup(options.craftCdp, 5_000)
  await requirePaidTurnRuntimeBaseline(options.craftCdp)
  await waitFor('real packaged v2 blackout proxy cleanup', async () => (
    await ownedBlackoutProxyProcessCount(options.proxyScriptPath)
  ) === 0 ? true : false, 10_000)
  return state
}

async function requireProcessTreeReaped(snapshot: readonly ProcessIdentity[]): Promise<number> {
  if (snapshot.length === 0) throw new Error('Packaged App descendant process observation is empty')
  const startedAt = Date.now()
  await waitFor('Packaged App descendant process cleanup', async () => (
    await remainingProcessTreeCount(snapshot)
  ) === 0 ? true : false, 10_000)
  const remaining = await remainingProcessTreeCount(snapshot)
  if (remaining !== 0) throw new Error('Packaged App descendant process tree remains')
  return Math.ceil((Date.now() - startedAt) / 1000)
}

async function executeCase(options: {
  stack: OpenDesignM1Stack
  testCase: OpenDesignM1Case
  origin: string
  moduleDataRoot: string
  seedRoot: string
  outputRoot: string
  craftCdp: CdpClient
  hostPid: number
  moduleArchiveSha256: string
  turnOrdinal: number
  onPhase: (phase: OpenDesignM1CaseFailurePhase) => void
}): Promise<void> {
  const { stack, testCase, origin, moduleDataRoot, seedRoot, outputRoot } = options
  const startedAt = Date.now()
  options.onPhase('project.create')
  const project = await createProject(origin, testCase)
  options.onPhase('project.locate')
  const workspace = await findProjectDirectory(moduleDataRoot, project.projectId)
  options.onPhase('seed.verify')
  const seed = join(seedRoot, `${testCase.id}.tar.gz`)
  if (sha256(await readFile(seed)) !== testCase.seedArchiveSha256) throw new Error('Seed archive authority mismatch')
  options.onPhase('seed.extract')
  await tar.x({ cwd: workspace, file: seed, strip: 1, preserveOwner: false })
  options.onPhase('blackout.arm')
  const blackoutEvidenceId = stack === 'new'
    ? await armExternalBlackoutProxy(options.craftCdp, testCase.id, options.turnOrdinal)
    : undefined
  options.onPhase('run.start')
  const runId = await startRun(origin, project.projectId, project.conversationId, testCase.prompt)
  options.onPhase('run.await-terminal')
  const terminal = await waitForTerminal(origin, runId)
  const terminalObservedAt = terminal.observedAt
  options.onPhase('runtime.cleanup')
  const cleanup = await requireRuntimeCleanup(options.craftCdp, 5_000)
  options.onPhase('events.read')
  const rawEvents = await rawRunEvents(terminal.status, moduleDataRoot)
  let blackout: JsonObject
  let ledger: Array<JsonObject & { sequence: number }>
  if (stack === 'new') {
    options.onPhase('blackout.collect')
    if (!blackoutEvidenceId) throw new Error('External blackout evidence ID is missing')
    const proxyEvidence = await waitFor('terminal Host blackout evidence', async () => {
      try {
        return await options.craftCdp.evaluate(rendererCall('openDesignAcceptance', 'takeBlackoutEvidence', {
          evidenceId: blackoutEvidenceId, caseId: testCase.id, turnOrdinal: options.turnOrdinal,
        }))
      } catch {
        return false
      }
    }, 30_000)
    const observed = externalBlackoutLedger(
      proxyEvidence,
      blackoutEvidenceId,
      testCase.id,
      options.turnOrdinal,
    )
    ledger = observed.ledger
    blackout = observed.blackout
  } else {
    const oldLedger: JsonObject[] = rawEvents.map((event) => ({
      at: new Date(eventTimestamp(event)).toISOString(),
      business: true,
      payloadSha256: sha256(JSON.stringify(event)),
      source: 'daemon',
      type: eventType(event),
    }))
    const terminalEvents = oldLedger.filter((event) => ['turn.completed', 'turn.failed', 'turn.interrupted'].includes(String(event.type)))
    if (terminalEvents.some((event) => event.type !== 'turn.completed') || terminalEvents.length > 1) {
      throw new Error('Old-stack terminal state is split')
    }
    if (terminalEvents.length === 0) {
      oldLedger.push({
        at: new Date(terminalObservedAt).toISOString(), business: true,
        payloadSha256: sha256(`terminal:${runId}:succeeded`), source: 'harness', type: 'turn.completed',
      })
    }
    oldLedger.sort((left, right) => Date.parse(left.at as string) - Date.parse(right.at as string))
    ledger = oldLedger.map((event, index) => ({ ...event, sequence: index + 1 }))
    blackout = {
      bufferedEventCount: null, endedAt: null, eventSequenceAfter: null, eventSequenceBefore: null, eventsLost: 0,
      heartbeatCount: null, heartbeatMaxGapMs: null, replayedEventCount: null, replayComplete: true,
      replaySequenceStart: null, required: false, startedAt: null,
    }
  }
  options.onPhase('events.seal')
  const eventsPath = `events/${stack}/${testCase.id}.jsonl`
  await mkdir(dirname(join(outputRoot, eventsPath)), { recursive: true, mode: 0o700 })
  await writeFile(join(outputRoot, eventsPath), `${ledger.map((event) => JSON.stringify(event)).join('\n')}\n`, { mode: 0o600 })

  options.onPhase('preview.verify')
  const previewUrl = presentationUrl(rawEvents, testCase.previewRoute)
  await requirePreviewHttp200(previewUrl)
  options.onPhase('workspace.verify')
  const workspaceValue = await workspaceManifest(workspace, stack, testCase)
  const workspacePath = `workspace/${stack}/${testCase.id}.json`
  await writeCanonical(outputRoot, workspacePath, workspaceValue)
  const workspaceManifestSha256 = sha256(await readFile(join(outputRoot, workspacePath)))
  if (stack === 'new') {
    options.onPhase('preview.capture')
    const screenshot = await capturePreviewUrlScreenshot(previewUrl)
    const screenshotPath = `previews/new/${testCase.id}.png`
    await mkdir(dirname(join(outputRoot, screenshotPath)), { recursive: true, mode: 0o700 })
    await writeFile(join(outputRoot, screenshotPath), screenshot, { mode: 0o600 })
  }
  options.onPhase('craft.verify')
  const craft = await craftSnapshot(options.craftCdp, options.hostPid)
  options.onPhase('shim.reap')
  const reapStartedAt = Date.now()
  await waitFor('Shim process cleanup', async () => (await shimProcessCount()) === 0 ? true : false, 10_000)
    .catch(() => { throw new Error('Shim process remained after Turn') })
  const shimCount = await shimProcessCount()
  if (shimCount !== 0) throw new Error('Shim process cleanup observation split')
  const processTreeReapedWithinSeconds = Math.ceil((Date.now() - reapStartedAt) / 1000)
  const completedTerminals = ledger.filter((event) => event.type === 'turn.completed').length
  const failedTerminals = ledger.filter((event) => event.type === 'turn.failed' || event.type === 'turn.interrupted').length
  const stateSplitCount = terminal.status.status === 'succeeded'
    && completedTerminals === 1 && failedTerminals === 0
    && cleanup.activeRuns === 0 && cleanup.moduleSessions === 0 && cleanup.hiddenSessions === 0
    && cleanup.transientSessions === 0 && cleanup.quarantinedSessions === 0
    ? 0
    : 1
  if (stateSplitCount !== 0) throw new Error('Module and Craft state observations are split')
  const completedAt = Date.now()
  const caseHash = OPEN_DESIGN_M1_CASE_HASHES.find((item) => item.id === testCase.id)!
  options.onPhase('record.seal')
  await writeCanonical(outputRoot, `records/${stack}/${testCase.id}.json`, {
    attemptOrdinal: 1,
    blackout,
    caseId: testCase.id,
    cleanup: {
      activeRuns: cleanup.activeRuns, hiddenSessions: cleanup.hiddenSessions, moduleSessions: cleanup.moduleSessions,
      processTreeReapedWithinSeconds, quarantinedSessions: cleanup.quarantinedSessions,
      residualProcesses: shimCount, runStateSettledWithinSeconds: cleanup.settledSeconds,
      transientSessions: cleanup.transientSessions,
    },
    completedAt: new Date(completedAt).toISOString(),
    craft: { mainPidSurvived: craft.mainPidSurvived, stateSplitCount, usableAfterTurn: craft.usableAfterTurn },
    moduleArchiveSha256: options.moduleArchiveSha256,
    preview: { httpStatus: 200, requiredContentVerified: true, requiredFilesVerified: true, route: '/' },
    promptSha256: caseHash.promptSha256,
    seedArchiveSha256: caseHash.seedArchiveSha256,
    stack,
    startedAt: new Date(startedAt).toISOString(),
    terminal: { status: 'completed', terminalEventCount: 1 },
    turnCount: 1,
    workspaceManifestPath: workspacePath,
    workspaceManifestSha256,
  })
}

async function appLaunch(
  executable: string,
  userData: string,
  blackoutProxyChild: BlackoutProxyChild,
): Promise<ReturnType<typeof Bun.spawn>> {
  await new Promise<void>((resolvePromise, reject) => {
    const probe = createServer()
    probe.once('error', () => reject(new Error('Dedicated CDP port is already in use')))
    probe.listen(CDP_PORT, '127.0.0.1', () => probe.close((error) => (
      error ? reject(new Error('Dedicated CDP port probe failed')) : resolvePromise()
    )))
  })
  const environment: Record<string, string> = {}
  for (const name of ['HOME', 'PATH', 'TMPDIR', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', '__CF_USER_TEXT_ENCODING']) {
    const value = process.env[name]
    if (value !== undefined) environment[name] = value
  }
  environment.SIMULATOR_HOST_MODULE_ACCEPTANCE = '1'
  environment.SIMULATOR_DISABLE_UPDATES = '1'
  environment.SIMULATOR_HOST_AGENT_BLACKOUT_PROXY_BUN_PATH = blackoutProxyChild.bunPath
  environment.SIMULATOR_HOST_AGENT_BLACKOUT_PROXY_SCRIPT_PATH = blackoutProxyChild.scriptPath
  const child = Bun.spawn([
    executable,
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${userData}`,
    '--', '--debug',
  ], {
    env: environment,
    stdout: 'ignore', stderr: 'ignore',
  })
  try {
    await craftTarget()
    return child
  } catch (error) {
    try { await stopApp(child) } catch { /* preserve the startup failure */ }
    throw error
  }
}

async function stopApp(child: ReturnType<typeof Bun.spawn>): Promise<void> {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  const result = await Promise.race([child.exited.then(() => true), sleep(10_000).then(() => false)])
  if (!result) {
    child.kill('SIGKILL')
    await child.exited
  }
}

async function bestEffortFailureCleanup(options: {
  app: ReturnType<typeof Bun.spawn>
  craftCdp?: CdpClient
  moduleCdp?: CdpClient
  userData: string
  proxyScriptPath: string
  knownProcessTree?: readonly ProcessIdentity[]
}): Promise<OpenDesignM1FailureCleanupEvidence> {
  let moduleStop: OpenDesignM1FailureCleanupEvidence['moduleStop'] = 'not-attempted'
  let runtimeSnapshotObserved = false
  let runtimeClean = false
  let activeRuns: number | null = null
  let moduleSessions: number | null = null
  let hiddenSessions: number | null = null
  let transientSessions: number | null = null
  let quarantinedSessions: number | null = null
  let appExit: OpenDesignM1FailureCleanupEvidence['appExit'] = 'failed'
  let descendantProcessesRemaining: number | null = null
  let ownedModuleProcessesRemaining: number | null = null
  let processTreeObserved = (options.knownProcessTree?.length ?? 0) > 0
  const observedProcessTree = new Map<string, ProcessIdentity>(
    (options.knownProcessTree ?? []).map((entry) => [`${entry.pid}:${entry.commandSha256}`, entry]),
  )
  const rememberDescendants = async (): Promise<void> => {
    try {
      const descendants = await descendantProcessSnapshot(options.app.pid)
      processTreeObserved = true
      for (const entry of descendants) {
        observedProcessTree.set(`${entry.pid}:${entry.commandSha256}`, entry)
      }
    } catch { /* process inventory is recorded as unavailable below */ }
  }

  await rememberDescendants()
  if (options.craftCdp) {
    moduleStop = 'failed'
    try {
      const stopped = await withDeadline(
        options.craftCdp.evaluate(rendererCall('openDesignModule', 'stop')),
        30_000,
        'failed-run Module stop',
      ) as JsonObject | undefined
      if (!stopped || !['available', 'not-installed'].includes(String(stopped.status))) {
        throw new Error('failed-run Module stop did not settle')
      }
      moduleStop = 'completed'
    } catch { /* continue to Host termination */ }

    try {
      await withDeadline(requireRuntimeCleanup(options.craftCdp, 15_000), 20_000, 'failed-run Runtime cleanup')
      const snapshot = await withDeadline(queryRuntimeCleanup(options.craftCdp), 5_000, 'failed-run Runtime snapshot')
      runtimeSnapshotObserved = true
      runtimeClean = runtimeIsClean(snapshot)
      activeRuns = snapshot.v1.activeRuns + snapshot.v2.activeRuns
      moduleSessions = snapshot.v1.moduleSessions + snapshot.v2.moduleSessions
      hiddenSessions = snapshot.sessions.hiddenSessions
      transientSessions = snapshot.sessions.transientSessions
      quarantinedSessions = snapshot.sessions.quarantinedSessions
    } catch {
      try {
        const snapshot = await withDeadline(queryRuntimeCleanup(options.craftCdp), 5_000, 'failed-run Runtime snapshot')
        runtimeSnapshotObserved = true
        runtimeClean = runtimeIsClean(snapshot)
        activeRuns = snapshot.v1.activeRuns + snapshot.v2.activeRuns
        moduleSessions = snapshot.v1.moduleSessions + snapshot.v2.moduleSessions
        hiddenSessions = snapshot.sessions.hiddenSessions
        transientSessions = snapshot.sessions.transientSessions
        quarantinedSessions = snapshot.sessions.quarantinedSessions
      } catch { /* runtime evidence remains explicitly unavailable */ }
    }
  }

  await rememberDescendants()
  try { options.moduleCdp?.close() } catch { /* process cleanup continues */ }
  try { options.craftCdp?.close() } catch { /* process cleanup continues */ }
  try {
    await stopApp(options.app)
    appExit = 'completed'
  } catch { /* exact descendant reaping still runs */ }

  const processTree = [...observedProcessTree.values()]
  if (processTreeObserved) {
    try {
      descendantProcessesRemaining = await reapExactProcessIdentities(processTree)
    } catch {
      try { descendantProcessesRemaining = await remainingProcessTreeCount(processTree) } catch { /* unavailable */ }
    }
  }
  try {
    const owned = await ownedModuleProcessSnapshot(options.userData, options.proxyScriptPath)
    processTreeObserved = true
    for (const entry of owned) observedProcessTree.set(`${entry.pid}:${entry.commandSha256}`, entry)
    descendantProcessesRemaining = await reapExactProcessIdentities([...observedProcessTree.values()])
    ownedModuleProcessesRemaining = await residualOwnedModuleProcessCount(
      options.userData,
      options.proxyScriptPath,
    )
  } catch { /* unavailable */ }

  return {
    moduleStop,
    runtimeSnapshotObserved,
    runtimeClean,
    activeRuns,
    moduleSessions,
    hiddenSessions,
    transientSessions,
    quarantinedSessions,
    appExit,
    descendantProcessesRemaining,
    ownedModuleProcessesRemaining,
  }
}

async function sealArtifact(options: {
  root: string
  authority: MachineEvidenceAuthority
  requiredCi: JsonObject
  lkgTrust: Awaited<ReturnType<typeof fetchReleaseAuthority>>
  rcTrust: Awaited<ReturnType<typeof fetchReleaseAuthority>>
  batchStart: number
  batchCompleted: number
}): Promise<void> {
  await writeCanonical(options.root, 'required-ci.json', options.requiredCi)
  for (const [path, bytes] of [
    ['trust/lkg-catalog.json', options.lkgTrust.catalog.bytes],
    ['trust/lkg-envelope.json', options.lkgTrust.envelope.bytes],
    ['trust/rc-catalog.json', options.rcTrust.catalog.bytes],
    ['trust/rc-envelope.json', options.rcTrust.envelope.bytes],
  ] as const) {
    await mkdir(dirname(join(options.root, path)), { recursive: true, mode: 0o700 })
    await writeFile(join(options.root, path), bytes, { mode: 0o600, flag: 'wx' })
  }
  const payloadPaths = expectedMachineEvidencePaths().filter((path) => path !== 'machine-manifest.json' && path !== 'SHA256SUMS')
  const files: Array<{ path: string; sha256: string; bytes: number }> = []
  for (const path of payloadPaths) {
    const bytes = await readFile(join(options.root, path))
    files.push({ path, sha256: sha256(bytes), bytes: bytes.byteLength })
  }
  const ref = (path: string): FileRef => ({ path, sha256: files.find((file) => file.path === path)!.sha256 })
  const records: JsonObject[] = []
  for (const stack of ['old', 'new'] as const) {
    for (const testCase of OPEN_DESIGN_M1_CASES) {
      records.push({
        stack, caseId: testCase.id,
        record: ref(`records/${stack}/${testCase.id}.json`),
        events: ref(`events/${stack}/${testCase.id}.jsonl`),
        workspace: ref(`workspace/${stack}/${testCase.id}.json`),
        ...(stack === 'new' ? { preview: ref(`previews/new/${testCase.id}.png`) } : {}),
      })
    }
  }
  const batchDigest = sha256(records.map((entry) => [
    entry.stack, entry.caseId, (entry.record as FileRef).sha256, (entry.events as FileRef).sha256,
    (entry.workspace as FileRef).sha256, (entry.preview as FileRef | undefined)?.sha256 ?? '-',
  ].join(':')).join('\n') + '\n')
  const release = (stack: OpenDesignM1Stack): JsonObject => {
    const source = stack === 'old' ? options.authority.lkg : options.authority.rc
    return {
      archiveAsset: stack === 'old' ? OPEN_DESIGN_LKG_ARCHIVE_ASSET : OPEN_DESIGN_RC_ARCHIVE_ASSET,
      archiveSha256: source.archiveSha256,
      catalogIssuedAt: source.catalogIssuedAt,
      catalogSequence: source.catalogSequence,
      catalogSha256: source.catalogSha256,
      envelopeSha256: source.envelopeSha256,
      expiresAt: source.expiresAt,
      extractedManifestSha256: source.extractedManifestSha256,
      ...(stack === 'new' ? { sourceSha: OPEN_DESIGN_RC_SOURCE_SHA } : {}),
      tag: stack === 'old' ? OPEN_DESIGN_LKG_TAG : OPEN_DESIGN_RC_TAG,
      version: stack === 'old' ? OPEN_DESIGN_LKG_VERSION : OPEN_DESIGN_RC_VERSION,
    }
  }
  await writeCanonical(options.root, 'machine-manifest.json', {
    schemaVersion: 1,
    kind: 'open-design-m1-machine-evidence',
    repository: REPOSITORY,
    workflowPath: OPEN_DESIGN_M1_MACHINE_WORKFLOW_PATH,
    producer: {
      headSha: options.authority.hostHeadSha,
      runAttempt: options.authority.producerRunAttempt,
      runId: options.authority.producerRunId,
    },
    host: {
      artifactName: OPEN_DESIGN_HOST_ARTIFACT_NAME,
      artifactSha256: options.authority.hostArtifactSha256,
      buildRunId: options.authority.hostBuildRunId,
      version: OPEN_DESIGN_HOST_VERSION,
    },
    lkg: release('old'),
    rc: release('new'),
    caseAuthority: {
      caseManifestSha256: OPEN_DESIGN_M1_CASE_MANIFEST_SHA256,
      caseSeedChecksumsSha256: OPEN_DESIGN_M1_CASE_SEED_CHECKSUMS_SHA256,
      rcSourceSha: OPEN_DESIGN_RC_SOURCE_SHA,
    },
    batch: {
      batchId: `m1-${options.authority.producerRunId}`, startedAt: new Date(options.batchStart).toISOString(),
      completedAt: new Date(options.batchCompleted).toISOString(), paidTurnBudget: 40, paidTurns: 40,
      status: 'passed', stopOnFailure: true,
    },
    requiredCi: ref('required-ci.json'),
    rollback: {
      transitions: ref('rollback/transitions.json'),
      processes: ref('rollback/processes.json'),
      hiddenSessions: ref('rollback/hidden-sessions.json'),
    },
    records,
    files,
    batchDigest,
  })
  const sums = expectedMachineEvidencePaths().filter((path) => path !== 'SHA256SUMS')
  const lines: string[] = []
  for (const path of sums) lines.push(`${sha256(await readFile(join(options.root, path)))}  ${path}`)
  await writeFile(join(options.root, 'SHA256SUMS'), `${lines.join('\n')}\n`, { mode: 0o600 })
}

async function main(): Promise<void> {
  if (process.argv.length !== 2) throw new TypeError('This producer accepts no CLI arguments')
  if (requiredEnv('SIMULATOR_M1_MACHINE_REAL') !== REAL_OPT_IN
    || requiredEnv('PAID_TURNS_APPROVED') !== 'true'
    || requiredEnv('ACCEPTANCE_CONFIRMATION') !== CONFIRMATION
    || requiredEnv('RC_ACCEPTANCE_FREEZE_ENABLED') !== 'true'
    || requiredEnv('GITHUB_RUN_ATTEMPT') !== '1') throw new TypeError('Machine producer authorization is invalid')
  const runnerTemp = await realpath(requiredEnv('RUNNER_TEMP'))
  const outputRoot = await isolatedPath('M1_EVIDENCE_OUTPUT_ROOT', runnerTemp)
  const failureOutputRoot = await isolatedPath('M1_FIRST_FAILURE_OUTPUT_ROOT', runnerTemp)
  const staging = await isolatedPath('M1_MACHINE_WORK_ROOT', runnerTemp)
  const appBundle = await isolatedPath('M1_PACKAGED_APP_PATH', runnerTemp)
  const caseArtifactRoot = await isolatedPath('M1_CASE_ARTIFACT_ROOT', runnerTemp)
  const seedRoot = join(caseArtifactRoot, 'seeds')
  const executable = join(appBundle, 'Contents', 'MacOS', 'Simulator')
  const executableStat = await stat(executable)
  if (!executableStat.isFile() || (executableStat.mode & 0o111) === 0) throw new Error('Packaged Simulator executable is invalid')
  const blackoutProxyChild: BlackoutProxyChild = {
    bunPath: await trustedOwnerExecutablePath('M1_BLACKOUT_PROXY_BUN_PATH', true),
    scriptPath: await trustedOwnerExecutablePath('M1_BLACKOUT_PROXY_SCRIPT_PATH', false),
  }
  const hostHeadSha = requiredEnv('GITHUB_SHA', COMMIT)
  const hostArtifactSha256 = requiredEnv('HOST_ARTIFACT_SHA256', SHA256)
  const token = requiredEnv('GH_TOKEN')
  await requireNoOpenDesignReleaseTransaction(token)
  const lkgTrust = await fetchReleaseAuthority(OPEN_DESIGN_LKG_VERSION)
  const rcTrust = await fetchReleaseAuthority(OPEN_DESIGN_RC_VERSION)
  const authority: MachineEvidenceAuthority = {
    hostHeadSha,
    producerRunId: positiveInteger('GITHUB_RUN_ID'),
    producerRunAttempt: 1,
    hostBuildRunId: positiveInteger('HOST_BUILD_RUN_ID'),
    hostArtifactSha256,
    lkg: lkgTrust.release,
    rc: { ...rcTrust.release, sourceSha: OPEN_DESIGN_RC_SOURCE_SHA },
  }
  if (authority.rc.catalogSequence <= authority.lkg.catalogSequence
    || Date.parse(authority.rc.catalogIssuedAt) <= Date.parse(authority.lkg.catalogIssuedAt)) {
    throw new Error('RC Catalog does not advance LKG authority')
  }
  const requiredCi = await requiredCiEvidence(hostHeadSha, token)
  await mkdir(staging, { mode: 0o700 })
  await chmod(staging, 0o700)
  await preflightExternalBlackoutProxyChild(blackoutProxyChild, staging)
  const userData = resolve(requiredEnv('M1_PACKAGED_PROFILE_ROOT'))
  const profileParent = await realpath(dirname(userData))
  if (resolve(profileParent, basename(userData)) !== userData || userData === profileParent) {
    throw new Error('Packaged acceptance profile path is invalid')
  }
  const userDataStat = await lstat(userData)
  if (!userDataStat.isDirectory() || userDataStat.isSymbolicLink()
    || (typeof process.getuid === 'function' && userDataStat.uid !== process.getuid())
    || (userDataStat.mode & 0o077) !== 0) throw new Error('Packaged acceptance profile is not owner-only')
  const controlDirectory = join(userData, 'open-design-acceptance')
  await mkdir(controlDirectory, { recursive: true, mode: 0o700 })
  const controlDirectoryStat = await lstat(controlDirectory)
  if (!controlDirectoryStat.isDirectory() || controlDirectoryStat.isSymbolicLink()
    || (typeof process.getuid === 'function' && controlDirectoryStat.uid !== process.getuid())
    || (controlDirectoryStat.mode & 0o777) !== 0o700
    || await realpath(controlDirectory) !== controlDirectory) {
    throw new Error('Packaged acceptance control directory is invalid')
  }
  const controlDescriptor = join(controlDirectory, 'rc-control-v1.json')
  try {
    const descriptorStat = await lstat(controlDescriptor)
    if (!descriptorStat.isFile() || descriptorStat.isSymbolicLink() || descriptorStat.nlink !== 1
      || (typeof process.getuid === 'function' && descriptorStat.uid !== process.getuid())
      || (descriptorStat.mode & 0o777) !== 0o600 || await realpath(controlDescriptor) !== controlDescriptor
      || await readFile(controlDescriptor, 'utf8') !== OPEN_DESIGN_M1_MACHINE_ACCEPTANCE_DESCRIPTOR_CANONICAL_JSON) {
      throw new Error('Existing packaged acceptance descriptor is invalid')
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await writeFile(controlDescriptor, OPEN_DESIGN_M1_MACHINE_ACCEPTANCE_DESCRIPTOR_CANONICAL_JSON, {
      mode: 0o600,
      flag: 'wx',
    })
  }
  const artifactRoot = join(staging, 'artifact')
  const failureArtifactRoot = join(staging, 'first-failure')
  await mkdir(artifactRoot, { mode: 0o700 })
  const batchStart = Date.now()
  const batchProgress = createOpenDesignM1BatchProgress()
  const failureAuthority: OpenDesignM1FirstFailureAuthority = {
    hostHeadSha: authority.hostHeadSha,
    producerRunId: authority.producerRunId,
    producerRunAttempt: authority.producerRunAttempt,
    hostBuildRunId: authority.hostBuildRunId,
    hostArtifactSha256: authority.hostArtifactSha256,
  }
  let app = await appLaunch(executable, userData, blackoutProxyChild)
  let craftCdp: CdpClient | undefined
  let moduleCdp: CdpClient | undefined
  let producerFailed = false
  let failedAt: number | undefined
  let lifecyclePhase: OpenDesignM1LifecycleFailurePhase = 'transition.to-rc'
  const knownProcessTree = new Map<string, ProcessIdentity>()
  const rememberProcessTree = (snapshot: readonly ProcessIdentity[]): void => {
    for (const entry of snapshot) knownProcessTree.set(`${entry.pid}:${entry.commandSha256}`, entry)
  }
  try {
    const craft = await craftTarget()
    craftCdp = new CdpClient(craft.webSocketDebuggerUrl)
    await craftCdp.connect()
    const acceptanceAvailable = await craftCdp.evaluate(`Boolean(window.electronAPI?.openDesignAcceptance)`)
    if (acceptanceAvailable !== true) throw new Error('Packaged Host acceptance facade is unavailable')
    // This runs before installing a Module or spending any paid Turn. Current
    // Hosts without the gated external-proxy seam fail here and emit no artifact.
    await requireExternalBlackoutProxy(craftCdp)
    await requireAuthenticatedCraftRuntime(craftCdp)
    await requireRuntimeCleanup(craftCdp, 1_000)
    await requirePaidTurnRuntimeBaseline(craftCdp)
    let state = await preflightRealPackagedV2ProxyAttach({
      craftCdp,
      proxyScriptPath: blackoutProxyChild.scriptPath,
    })
    let module = await openDesignTarget()
    moduleCdp = new CdpClient(module.webSocketDebuggerUrl)
    await moduleCdp.connect()
    let origin = new URL(module.url).origin
    await requireOpenDesignHostRuntime(origin)
    const moduleDataRoot = join(userData, 'optional-modules', 'module-data', 'org.simulator.open-design')
    await realpath(moduleDataRoot)
    // This is the last boundary before the first paid Turn. Re-check the
    // single release lane and exact signed Catalog bytes after all local
    // package/module preflights, not merely when the producer process started.
    await requireNoOpenDesignReleaseTransaction(token)
    requireReleaseCatalogUnchanged(lkgTrust, await fetchReleaseAuthority(OPEN_DESIGN_LKG_VERSION))
    requireReleaseCatalogUnchanged(rcTrust, await fetchReleaseAuthority(OPEN_DESIGN_RC_VERSION))
    await runFixedPaidTurnBatch(OPEN_DESIGN_M1_CASES, craftCdp, async (testCase, index) => {
      await runTrackedOpenDesignM1Case(batchProgress, 'old', testCase, index, async (onPhase) => {
        await executeCase({
          stack: 'old', testCase, origin, moduleDataRoot, seedRoot, outputRoot: artifactRoot,
          craftCdp: craftCdp!, hostPid: app.pid,
          moduleArchiveSha256: authority.lkg.archiveSha256,
          turnOrdinal: index + 1,
          onPhase,
        })
      })
    })
    lifecyclePhase = 'transition.to-rc'
    state = readyAcceptanceState(
      await craftCdp.evaluate(rendererCall('openDesignAcceptance', 'rollback')),
      OPEN_DESIGN_RC_VERSION,
      OPEN_DESIGN_LKG_VERSION,
    )
    moduleCdp.close()
    module = await openDesignTarget()
    moduleCdp = new CdpClient(module.webSocketDebuggerUrl)
    await moduleCdp.connect()
    origin = new URL(module.url).origin
    await requireOpenDesignHostRuntime(origin)
    lifecyclePhase = 'rc-batch.preflight'
    await runFixedPaidTurnBatch(OPEN_DESIGN_M1_CASES, craftCdp, async (testCase, index) => {
      await runTrackedOpenDesignM1Case(batchProgress, 'new', testCase, index, async (onPhase) => {
        await executeCase({
          stack: 'new', testCase, origin, moduleDataRoot, seedRoot, outputRoot: artifactRoot,
          craftCdp: craftCdp!, hostPid: app.pid,
          moduleArchiveSha256: authority.rc.archiveSha256,
          turnOrdinal: index + 1,
          onPhase,
        })
      })
    })
    lifecyclePhase = 'rollback.exercise'
    readyAcceptanceState(
      await craftCdp.evaluate(rendererCall('openDesignAcceptance', 'rollback')),
      OPEN_DESIGN_LKG_VERSION,
      OPEN_DESIGN_RC_VERSION,
    )
    readyAcceptanceState(
      await craftCdp.evaluate(rendererCall('openDesignAcceptance', 'rollback')),
      OPEN_DESIGN_RC_VERSION,
      OPEN_DESIGN_LKG_VERSION,
    )
    lifecyclePhase = 'view.lifecycle'
    await craftCdp.evaluate(rendererCall('openDesignModule', 'setViewPresentation', { visible: false }))
    await craftCdp.evaluate(rendererCall('openDesignModule', 'setViewPresentation', { visible: true, bounds: { x: 320, y: 0, width: 1000, height: 800 } }))
    await writeCanonical(artifactRoot, 'rollback/transitions.json', {
      schemaVersion: 1, passed: true, craftConnectionPreserved: true, craftSurvivedAllTransitions: true,
      restartAndReopenPassed: true,
      transitions: [OPEN_DESIGN_LKG_VERSION, OPEN_DESIGN_RC_VERSION, OPEN_DESIGN_LKG_VERSION, OPEN_DESIGN_RC_VERSION],
    })
    await craftSnapshot(craftCdp, app.pid)
    await requireRuntimeCleanup(craftCdp, 5_000)
    lifecyclePhase = 'restart.prepare'
    moduleCdp.close(); moduleCdp = undefined
    craftCdp.close(); craftCdp = undefined
    const preRestartProcessTree = await descendantProcessSnapshot(app.pid)
    rememberProcessTree(preRestartProcessTree)
    await stopApp(app)
    await requireProcessTreeReaped(preRestartProcessTree)
    app = await appLaunch(executable, userData, blackoutProxyChild)
    lifecyclePhase = 'restart.verify'
    const restartedCraft = await craftTarget()
    craftCdp = new CdpClient(restartedCraft.webSocketDebuggerUrl)
    await craftCdp.connect()
    state = await craftCdp.evaluate(rendererCall('openDesignAcceptance', 'getState'))
    readyAcceptanceState(state, OPEN_DESIGN_RC_VERSION, OPEN_DESIGN_LKG_VERSION)
    await craftSnapshot(craftCdp, app.pid)
    await requireRuntimeCleanup(craftCdp, 5_000)
    await writeCanonical(artifactRoot, 'rollback/hidden-sessions.json', {
      schemaVersion: 1, passed: true, count: 0, observedAt: new Date().toISOString(),
    })
    craftCdp.close(); craftCdp = undefined
    const finalProcessTree = await descendantProcessSnapshot(app.pid)
    rememberProcessTree(finalProcessTree)
    await stopApp(app)
    await requireProcessTreeReaped(finalProcessTree)
    const residual = await remainingProcessTreeCount(finalProcessTree)
      + await residualOwnedModuleProcessCount(userData, blackoutProxyChild.scriptPath)
    if (residual !== 0) throw new Error('Residual App or Module process remains after Craft stop')
    await writeCanonical(artifactRoot, 'rollback/processes.json', {
      schemaVersion: 1, passed: true, count: 0, observedAt: new Date().toISOString(),
    })
    lifecyclePhase = 'catalog.freeze-verify'
    await requireNoOpenDesignReleaseTransaction(token)
    const finalLkgTrust = await fetchReleaseAuthority(OPEN_DESIGN_LKG_VERSION)
    const finalRcTrust = await fetchReleaseAuthority(OPEN_DESIGN_RC_VERSION)
    requireReleaseCatalogUnchanged(lkgTrust, finalLkgTrust)
    requireReleaseCatalogUnchanged(rcTrust, finalRcTrust)
    const batchCompleted = Date.now()
    lifecyclePhase = 'artifact.seal'
    await sealArtifact({ root: artifactRoot, authority, requiredCi, lkgTrust, rcTrust, batchStart, batchCompleted })
    lifecyclePhase = 'artifact.validate'
    const result = await validateOpenDesignM1MachineEvidence(artifactRoot, authority)
    lifecyclePhase = 'artifact.publish'
    await rename(artifactRoot, outputRoot)
    process.stdout.write(`${canonical({
      status: 'passed', artifactName: OPEN_DESIGN_M1_MACHINE_ARTIFACT_NAME,
      objectPath: result.objectPath, sha256: result.sha256, fileCount: result.fileCount,
      totalBytes: result.totalBytes, batchDigest: result.batchDigest,
    })}`)
  } catch (error) {
    producerFailed = true
    failedAt = Date.now()
    throw error
  } finally {
    const cleanup = producerFailed
      ? await bestEffortFailureCleanup({
          app,
          craftCdp,
          moduleCdp,
          userData,
          proxyScriptPath: blackoutProxyChild.scriptPath,
          knownProcessTree: [...knownProcessTree.values()],
        })
      : undefined
    if (!producerFailed) {
      try { moduleCdp?.close() } catch { /* cleanup only */ }
      try { craftCdp?.close() } catch { /* cleanup only */ }
      try { await stopApp(app) } catch { /* cleanup only */ }
    }
    const firstFailure = batchProgress.current
    if (failedAt !== undefined && cleanup && (firstFailure || batchProgress.completedCaseCount > 0)) {
      await preserveOpenDesignM1FirstFailure(staging, failureArtifactRoot, failureOutputRoot, {
        authority: failureAuthority,
        batchStartedAt: batchStart,
        failedAt,
        progress: firstFailure
          ? { completedCaseCount: batchProgress.completedCaseCount, current: firstFailure }
          : { completedCaseCount: batchProgress.completedCaseCount, lifecyclePhase },
        cleanup,
      })
    } else {
      await rm(staging, { recursive: true, force: true })
    }
  }
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  void main().catch(() => {
    process.stderr.write('OpenDesign M1 machine evidence producer failed closed.\n')
    process.exitCode = 1
  })
}
