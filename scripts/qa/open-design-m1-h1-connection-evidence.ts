#!/usr/bin/env bun

import { createReadStream } from 'node:fs'
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { execFile as execFileCallback } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { basename, dirname, join, resolve } from 'node:path'
import { verifyEngineeringRcBundle } from '../release/verify-engineering-rc-bundle'
import {
  COMMIT_SHA_PATTERN,
  SHA256_PATTERN,
  canonicalJson,
  canonicalTimestamp,
  evidenceFailure,
  exactKeys,
  inventoryOwnerOnlyFiles,
  objectAt,
  publishOwnerOnlyDirectory,
  readOwnerOnlyBoundedFile,
  readOwnerOnlyCanonicalJson,
  requireCanonicalDirectory,
  requireCanonicalRegularFile,
  requireOwnerOnlyDirectory,
  sha256,
  stringAt,
  writeOwnerOnlyNewFile,
  type JsonObject,
} from './open-design-m1-local-evidence'

const KIND = 'OpenDesign M1 H1 connection evidence'
const PREFLIGHT_KIND = 'open-design-m1-h1-preflight-evidence'
const CONNECTION_KIND = 'open-design-m1-h1-connection-evidence'
const LAUNCH_KIND = 'open-design-m1-h1-launch-evidence'
const PREFLIGHT_PATH = 'h1-preflight.json' as const
const CONNECTION_PATH = 'h1-connection.json' as const
const CHECKSUMS_PATH = 'SHA256SUMS' as const
const MAX_PROOF_BYTES = 32 * 1024
const MAX_LAUNCH_BYTES = 8 * 1024
const MAX_LOCK_BYTES = 512
const MAX_CDP_RESPONSE_BYTES = 256 * 1024
const MAX_GITHUB_RESPONSE_BYTES = 1024 * 1024
const MAX_ATTESTATION_RESPONSE_BYTES = 8 * 1024 * 1024
const MAX_ARTIFACT_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024
const SAFE_TARGET_ID = /^[A-Za-z0-9._-]{1,128}$/
const SAFE_WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const RC_LABEL_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-rc\.([1-9]\d*)$/
const SERVICE_DIGEST_PATTERN = /^sha256:([0-9a-f]{64})$/
const PROCESS_START_PATTERN = /^[A-Z][a-z]{2} [A-Z][a-z]{2}\s+[0-9]{1,2} [0-9]{2}:[0-9]{2}:[0-9]{2} [0-9]{4}$/
const REPOSITORY = 'Jiachi-Deng/Simulator'
const REPOSITORY_ID = 1_298_254_148
const WORKFLOW_PATH = '.github/workflows/engineering-rc.yml'
const FINAL_BUNDLE_FILES = Object.freeze([
  'RELEASE_NOTES.md',
  'SHA256SUMS',
  'Simulator-arm64.dmg',
  'Simulator-arm64.zip',
  'app-inventory.jsonl',
  'attestations/provenance.sigstore.json',
  'attestations/sbom.sigstore.json',
  'bundle-metadata.json',
  'dmg-app-inventory.raw.jsonl',
  'dmg-signatures.json',
  'package-verification-code.txt',
  'packaged-files.sha256',
  'rc-validation.json',
  'sbom.spdx.json',
  'transport-normalization-policy.json',
  'verification-input.json',
  'zip-app-inventory.raw.jsonl',
  'zip-signatures.json',
] as const)
const execFile = promisify(execFileCallback)
const SCRIPT_ROOT = dirname(fileURLToPath(import.meta.url))
const REPOSITORY_ROOT = resolve(SCRIPT_ROOT, '..', '..')

export type H1CommandRunner = (
  file: string,
  args: readonly string[],
  maximumBytes: number,
  label: string,
) => Promise<string>

export interface H1ConnectionAuthority {
  readonly sourceSha: string
  readonly hostBuildRunId: number
  readonly hostArtifactId: number
  readonly hostArtifactDigest: string
  readonly rcLabel: string
  readonly productVersion: string
  readonly artifactArchiveRealpath: string
  readonly bundleRootRealpath: string
}

export interface H1ConnectionInstance {
  readonly appBundleRealpath: string
  readonly executableRealpath: string
  readonly mainPid: number
  readonly profileRealpath: string
  readonly configRealpath: string
  readonly cdpPort: number
  readonly launchEvidenceRealpath: string
}

export interface ProcessObservation {
  readonly pid: number
  readonly uid: number
  readonly parentPid: number
  readonly executableRealpath: string
  readonly commandLine: string
  readonly startIdentity: string
  readonly startedAtMs: number
  readonly loopbackListeningPorts: readonly number[]
}

interface CdpTarget {
  readonly id: string
  readonly type: string
  readonly url: string
  readonly webSocketDebuggerUrl: string
}

export interface ReleaseAuthoritySnapshot {
  readonly authority: JsonObject
  readonly bundleFiles: Readonly<Record<string, { readonly bytes: number; readonly sha256: string }>>
}

interface StagingSnapshot {
  readonly appInventorySha256: string
  readonly rawAppInventorySha256: string
  readonly macOSLaunchServicesProvenanceSha256: string | null
  readonly packagedFilesSha256: string
  readonly packageVerificationCodeSha256: string
  readonly packagedFileCount: number
  readonly codesignStrictVerified: true
}

interface ValidatedTarget {
  readonly target: CdpTarget
  readonly workspaceId: string
}

interface H1RuntimeBindingRequest {
  readonly profileRealpath: string
  readonly configRealpath: string
  readonly mainPid: number
  readonly serverPid: number
  readonly serverLockStartedAt: number
}

interface H1RuntimeBinding {
  readonly schemaVersion: 1
  readonly configRootMatches: true
  readonly userDataRootMatches: true
  readonly mainPidMatches: true
  readonly serverIdentityMatches: true
  readonly runtimeInstanceDigest: string
}

export interface H1ConnectionProbeDependencies {
  readonly inspectProcess: (pid: number) => Promise<ProcessObservation>
  readonly listProcesses: () => Promise<readonly ProcessObservation[]>
  readonly discoverTargets: (port: number) => Promise<readonly CdpTarget[]>
  readonly readAuthenticatedConnectionsPresent: (target: CdpTarget) => Promise<boolean>
  readonly readRuntimeBinding: (
    target: CdpTarget,
    request: H1RuntimeBindingRequest,
  ) => Promise<H1RuntimeBinding>
  readonly inspectReleaseAuthority: (authority: H1ConnectionAuthority) => Promise<ReleaseAuthoritySnapshot>
  readonly inspectStagedApp: (
    instance: H1ConnectionInstance,
    release: ReleaseAuthoritySnapshot,
  ) => Promise<StagingSnapshot>
  readonly now: () => number
}

export interface H1PreflightEvidenceResult {
  readonly objectPath: typeof PREFLIGHT_PATH
  readonly sha256: string
  readonly observedAt: string
  readonly verifierDidNotSendTurn: true
}

export interface H1ConnectionEvidenceResult {
  readonly objectPath: typeof CONNECTION_PATH
  readonly sha256: string
  readonly observedAt: string
  readonly authenticatedConnectionsPresent: true
  readonly verifierDidNotSendTurn: true
}

interface CanonicalInstance extends H1ConnectionInstance {}

function serviceDigest(value: string, path: string): string {
  const match = SERVICE_DIGEST_PATTERN.exec(value)
  if (!match) evidenceFailure(KIND, path)
  return match[1]!
}

function validateAuthority(authority: H1ConnectionAuthority): void {
  if (!COMMIT_SHA_PATTERN.test(authority.sourceSha)
    || !Number.isSafeInteger(authority.hostBuildRunId) || authority.hostBuildRunId < 1
    || !Number.isSafeInteger(authority.hostArtifactId) || authority.hostArtifactId < 1
    || !SERVICE_DIGEST_PATTERN.test(authority.hostArtifactDigest)
    || !RC_LABEL_PATTERN.test(authority.rcLabel)
    || authority.rcLabel.slice(0, authority.rcLabel.indexOf('-rc.')) !== authority.productVersion
    || !/^\d+\.\d+\.\d+$/.test(authority.productVersion)) {
    evidenceFailure(KIND, 'authority')
  }
}

function validatePort(port: number): void {
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
    evidenceFailure(KIND, 'instance.cdpPort')
  }
}

async function canonicalInstance(instance: H1ConnectionInstance): Promise<CanonicalInstance> {
  validatePort(instance.cdpPort)
  if (!Number.isSafeInteger(instance.mainPid) || instance.mainPid < 2) {
    evidenceFailure(KIND, 'instance.mainPid')
  }
  const appBundleRealpath = await requireCanonicalDirectory(instance.appBundleRealpath, KIND, 'instance.appBundleRealpath')
  if (!appBundleRealpath.endsWith('.app')) evidenceFailure(KIND, 'instance.appBundleRealpath')
  const executableRealpath = await requireCanonicalRegularFile(
    instance.executableRealpath,
    KIND,
    'instance.executableRealpath',
    { executable: true },
  )
  if (dirname(executableRealpath) !== join(appBundleRealpath, 'Contents', 'MacOS')
    || basename(executableRealpath).length < 1) {
    evidenceFailure(KIND, 'instance.executableRealpath', 'is not the app main executable')
  }
  const profileRealpath = await requireOwnerOnlyDirectory(instance.profileRealpath, KIND, 'instance.profileRealpath')
  const configRealpath = await requireOwnerOnlyDirectory(instance.configRealpath, KIND, 'instance.configRealpath')
  if (profileRealpath === configRealpath) evidenceFailure(KIND, 'instance', 'must use distinct profile and config roots')
  const launchEvidenceRealpath = await requireCanonicalRegularFile(
    instance.launchEvidenceRealpath,
    KIND,
    'instance.launchEvidenceRealpath',
    { ownerOnly: true },
  )
  await requireOwnerOnlyDirectory(dirname(launchEvidenceRealpath), KIND, 'instance.launchEvidenceParent')
  return Object.freeze({
    appBundleRealpath,
    executableRealpath,
    mainPid: instance.mainPid,
    profileRealpath,
    configRealpath,
    cdpPort: instance.cdpPort,
    launchEvidenceRealpath,
  })
}

async function commandText(
  file: string,
  args: readonly string[],
  maximumBytes: number,
  label: string,
): Promise<string> {
  try {
    const result = await execFile(file, [...args], {
      encoding: 'utf8',
      maxBuffer: maximumBytes,
      timeout: 60_000,
    })
    if (Buffer.byteLength(result.stdout, 'utf8') > maximumBytes || result.stderr.trim()) {
      evidenceFailure(KIND, label, 'failed')
    }
    return result.stdout.trim()
  } catch {
    return evidenceFailure(KIND, label, 'failed')
  }
}

function parseProcessStart(value: string, label: string): number {
  const canonical = value.replace(/\s+/g, ' ').trim()
  if (!PROCESS_START_PATTERN.test(canonical)) evidenceFailure(KIND, label)
  const milliseconds = Date.parse(canonical)
  if (!Number.isFinite(milliseconds)) evidenceFailure(KIND, label)
  return milliseconds
}

async function inspectDarwinProcess(pid: number): Promise<ProcessObservation> {
  if (process.platform !== 'darwin') evidenceFailure(KIND, 'process inspection', 'requires macOS')
  const [identity, executableSource, commandLine, textMappings, listeners] = await Promise.all([
    commandText('/bin/ps', ['-p', String(pid), '-o', 'pid=,ppid=,uid=,lstart='], 64 * 1024, 'process inspection'),
    commandText('/bin/ps', ['-ww', '-p', String(pid), '-o', 'comm='], 64 * 1024, 'process inspection'),
    commandText('/bin/ps', ['-ww', '-p', String(pid), '-o', 'command='], 128 * 1024, 'process inspection'),
    commandText('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'txt', '-Fn'], 128 * 1024, 'process inspection'),
    commandText('/usr/sbin/lsof', ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-Fn'], 128 * 1024, 'process inspection'),
  ])
  const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(identity)
  if (!match) evidenceFailure(KIND, 'process inspection', 'returned an invalid identity')
  const observedPid = Number(match[1])
  const parentPid = Number(match[2])
  const uid = Number(match[3])
  const startIdentity = match[4]!.replace(/\s+/g, ' ').trim()
  if (!Number.isSafeInteger(observedPid) || !Number.isSafeInteger(parentPid)
    || !Number.isSafeInteger(uid) || observedPid !== pid || uid < 0 || parentPid < 0) {
    evidenceFailure(KIND, 'process inspection', 'returned an invalid identity')
  }
  const executableRealpath = resolve(executableSource)
  if (!textMappings.split('\n').some((line) => line === `n${executableRealpath}`)) {
    evidenceFailure(KIND, 'process inspection', 'does not identify the executable mapping')
  }
  const ports = listeners.split('\n').flatMap((line) => {
    const portMatch = /^n127\.0\.0\.1:([0-9]+)(?: \(LISTEN\))?$/.exec(line)
    return portMatch ? [Number(portMatch[1])] : []
  })
  return Object.freeze({
    pid,
    uid,
    parentPid,
    executableRealpath,
    commandLine,
    startIdentity,
    startedAtMs: parseProcessStart(startIdentity, 'process start identity'),
    loopbackListeningPorts: Object.freeze(ports),
  })
}

async function listDarwinProcesses(): Promise<readonly ProcessObservation[]> {
  if (process.platform !== 'darwin') evidenceFailure(KIND, 'process list', 'requires macOS')
  const source = await commandText(
    '/bin/ps',
    ['-axo', 'pid=,ppid=,uid=,lstart=,comm='],
    8 * 1024 * 1024,
    'process list',
  )
  return Object.freeze(source.split('\n').map((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([A-Z][a-z]{2} [A-Z][a-z]{2}\s+[0-9]{1,2} [0-9]{2}:[0-9]{2}:[0-9]{2} [0-9]{4})\s+(.+)$/.exec(line)
    if (!match) evidenceFailure(KIND, 'process list')
    const startIdentity = match[4]!.replace(/\s+/g, ' ').trim()
    return Object.freeze({
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      uid: Number(match[3]),
      executableRealpath: resolve(match[5]!.trim()),
      commandLine: '',
      startIdentity,
      startedAtMs: parseProcessStart(startIdentity, 'process list start identity'),
      loopbackListeningPorts: Object.freeze([]),
    })
  }))
}

async function boundedJsonFetch(url: string): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(5_000) })
  } catch {
    return evidenceFailure(KIND, 'CDP discovery', 'failed')
  }
  const contentLength = response.headers.get('content-length')
  if (!response.ok || (contentLength !== null && Number(contentLength) > MAX_CDP_RESPONSE_BYTES)) {
    try { await response.body?.cancel() } catch { /* fail below */ }
    return evidenceFailure(KIND, 'CDP discovery', 'failed')
  }
  const source = await response.text()
  if (Buffer.byteLength(source, 'utf8') > MAX_CDP_RESPONSE_BYTES) {
    evidenceFailure(KIND, 'CDP discovery', 'exceeded its size limit')
  }
  try {
    return JSON.parse(source)
  } catch {
    return evidenceFailure(KIND, 'CDP discovery', 'returned invalid JSON')
  }
}

async function discoverCdpTargets(port: number): Promise<readonly CdpTarget[]> {
  const value = await boundedJsonFetch(`http://127.0.0.1:${port}/json/list`)
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) evidenceFailure(KIND, 'CDP targets')
  return Object.freeze(value.map((candidate, index) => {
    const object = objectAt(candidate, `$targets[${index}]`, KIND)
    const id = object.id
    const type = object.type
    const url = object.url
    const webSocketDebuggerUrl = object.webSocketDebuggerUrl
    if (typeof id !== 'string' || !SAFE_TARGET_ID.test(id) || typeof type !== 'string'
      || typeof url !== 'string' || typeof webSocketDebuggerUrl !== 'string') {
      evidenceFailure(KIND, `$targets[${index}]`)
    }
    return Object.freeze({ id, type, url, webSocketDebuggerUrl })
  }))
}

class CdpConnection {
  readonly #socket: WebSocket
  readonly #pending = new Map<number, {
    resolve(value: unknown): void
    reject(error: Error): void
    timeout: ReturnType<typeof setTimeout>
  }>()
  #nextId = 1

  constructor(url: string) {
    this.#socket = new WebSocket(url)
  }

  async connect(): Promise<void> {
    await new Promise<void>((resolvePromise, reject) => {
      const timeout = setTimeout(() => reject(new Error('CDP connect timeout')), 5_000)
      this.#socket.addEventListener('open', () => {
        clearTimeout(timeout)
        resolvePromise()
      }, { once: true })
      this.#socket.addEventListener('error', () => {
        clearTimeout(timeout)
        reject(new Error('CDP connect failed'))
      }, { once: true })
    })
    this.#socket.addEventListener('message', (event) => {
      let message: { id?: number; result?: unknown; error?: unknown }
      try { message = JSON.parse(String(event.data)) } catch { return }
      if (!Number.isSafeInteger(message.id)) return
      const pending = this.#pending.get(message.id!)
      if (!pending) return
      clearTimeout(pending.timeout)
      this.#pending.delete(message.id!)
      if (message.error) pending.reject(new Error('CDP request failed'))
      else pending.resolve(message.result)
    })
    this.#socket.addEventListener('close', () => {
      for (const pending of this.#pending.values()) {
        clearTimeout(pending.timeout)
        pending.reject(new Error('CDP closed'))
      }
      this.#pending.clear()
    })
  }

  request(method: string, params: JsonObject): Promise<unknown> {
    const id = this.#nextId++
    return new Promise((resolvePromise, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error('CDP request timeout'))
      }, 5_000)
      this.#pending.set(id, { resolve: resolvePromise, reject, timeout })
      try {
        this.#socket.send(JSON.stringify({ id, method, params }))
      } catch {
        clearTimeout(timeout)
        this.#pending.delete(id)
        reject(new Error('CDP request failed'))
      }
    })
  }

  close(): void {
    this.#socket.close()
  }
}

async function readAuthenticatedConnectionsPresent(target: CdpTarget): Promise<boolean> {
  const client = new CdpConnection(target.webSocketDebuggerUrl)
  try {
    await client.connect()
    const result = objectAt(await client.request('Runtime.evaluate', {
      expression: `(async()=>{const list=window.electronAPI?.listLlmConnectionsWithStatus;if(typeof list!=='function')return false;const connections=await list();return Array.isArray(connections)&&connections.some((connection)=>connection?.isAuthenticated===true);})()`,
      awaitPromise: true,
      returnByValue: true,
      userGesture: false,
    }), '$cdp.result', KIND)
    if (result.exceptionDetails !== undefined) evidenceFailure(KIND, 'CDP evaluation', 'failed')
    const remote = objectAt(result.result, '$cdp.result.result', KIND)
    if (typeof remote.value !== 'boolean') evidenceFailure(KIND, 'CDP evaluation', 'did not return a boolean')
    return remote.value
  } finally {
    client.close()
  }
}

async function readRuntimeBinding(
  target: CdpTarget,
  request: H1RuntimeBindingRequest,
): Promise<H1RuntimeBinding> {
  const client = new CdpConnection(target.webSocketDebuggerUrl)
  try {
    await client.connect()
    const requestSource = JSON.stringify(request)
    const result = objectAt(await client.request('Runtime.evaluate', {
      expression: `(async()=>{const read=window.electronAPI?.openDesignAcceptance?.getRuntimeBinding;if(typeof read!=='function')return null;return await read(JSON.parse(${JSON.stringify(requestSource)}));})()`,
      awaitPromise: true,
      returnByValue: true,
      userGesture: false,
    }), '$cdp.runtimeBinding', KIND)
    if (result.exceptionDetails !== undefined) evidenceFailure(KIND, 'runtime-binding RPC', 'failed')
    const remote = objectAt(result.result, '$cdp.runtimeBinding.result', KIND)
    const binding = objectAt(remote.value, '$cdp.runtimeBinding.result.value', KIND)
    exactKeys(binding, [
      'configRootMatches', 'mainPidMatches', 'runtimeInstanceDigest', 'schemaVersion',
      'serverIdentityMatches', 'userDataRootMatches',
    ], '$cdp.runtimeBinding.result.value', KIND)
    if (binding.schemaVersion !== 1 || binding.configRootMatches !== true
      || binding.userDataRootMatches !== true || binding.mainPidMatches !== true
      || binding.serverIdentityMatches !== true
      || typeof binding.runtimeInstanceDigest !== 'string'
      || !SHA256_PATTERN.test(binding.runtimeInstanceDigest)) {
      evidenceFailure(KIND, 'runtime-binding RPC', 'did not bind the live App process')
    }
    return Object.freeze({
      schemaVersion: 1,
      configRootMatches: true,
      userDataRootMatches: true,
      mainPidMatches: true,
      serverIdentityMatches: true,
      runtimeInstanceDigest: binding.runtimeInstanceDigest,
    })
  } finally {
    client.close()
  }
}

function requireRuntimeBinding(value: unknown): H1RuntimeBinding {
  const binding = objectAt(value, '$runtimeBinding', KIND)
  exactKeys(binding, [
    'configRootMatches', 'mainPidMatches', 'runtimeInstanceDigest', 'schemaVersion',
    'serverIdentityMatches', 'userDataRootMatches',
  ], '$runtimeBinding', KIND)
  if (binding.schemaVersion !== 1 || binding.configRootMatches !== true
    || binding.userDataRootMatches !== true || binding.mainPidMatches !== true
    || binding.serverIdentityMatches !== true
    || typeof binding.runtimeInstanceDigest !== 'string'
    || !SHA256_PATTERN.test(binding.runtimeInstanceDigest)) {
    evidenceFailure(KIND, 'runtime-binding RPC', 'did not bind the live App process')
  }
  return Object.freeze({
    schemaVersion: 1,
    configRootMatches: true,
    userDataRootMatches: true,
    mainPidMatches: true,
    serverIdentityMatches: true,
    runtimeInstanceDigest: binding.runtimeInstanceDigest,
  })
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function hasOneExactProcessArgument(commandLine: string, argument: string): boolean {
  const matches = commandLine.match(new RegExp(`(?:^|\\s)${escapeRegExp(argument)}(?=\\s|$)`, 'g'))
  return matches?.length === 1
}

function validatedCraftTarget(candidates: readonly CdpTarget[], instance: CanonicalInstance): ValidatedTarget {
  const expectedRendererPath = join(
    instance.appBundleRealpath, 'Contents', 'Resources', 'app.asar', 'dist', 'renderer', 'index.html',
  )
  const matches = candidates.flatMap((target): ValidatedTarget[] => {
    if (target.type !== 'page' || !SAFE_TARGET_ID.test(target.id)) return []
    let rendererUrl: URL
    let socketUrl: URL
    try {
      rendererUrl = new URL(target.url)
      socketUrl = new URL(target.webSocketDebuggerUrl)
    } catch {
      return []
    }
    if (rendererUrl.protocol !== 'file:' || rendererUrl.username || rendererUrl.password || rendererUrl.hash) return []
    const workspaceIds = rendererUrl.searchParams.getAll('workspaceId')
    const workspaceId = workspaceIds[0]
    if (rendererUrl.searchParams.size !== 1 || workspaceIds.length !== 1 || !workspaceId
      || !SAFE_WORKSPACE_ID.test(workspaceId) || rendererUrl.search !== `?workspaceId=${workspaceId}`) return []
    let rendererPath: string
    try { rendererPath = fileURLToPath(rendererUrl) } catch { return [] }
    if (rendererPath !== expectedRendererPath) return []
    if (socketUrl.protocol !== 'ws:' || socketUrl.hostname !== '127.0.0.1'
      || socketUrl.port !== String(instance.cdpPort) || socketUrl.username || socketUrl.password
      || socketUrl.pathname !== `/devtools/page/${target.id}` || socketUrl.search || socketUrl.hash) return []
    return [{ target, workspaceId }]
  })
  if (matches.length !== 1) evidenceFailure(KIND, 'dedicated Craft CDP target', 'was not uniquely identified')
  return matches[0]!
}

async function streamFileSnapshot(pathInput: string, maximumBytes: number, label: string): Promise<{ bytes: number; sha256: string }> {
  const path = await requireCanonicalRegularFile(pathInput, KIND, label, { ownerOnly: true })
  const before = await lstat(path)
  if (before.size < 1 || before.size > maximumBytes) evidenceFailure(KIND, label, 'violates file size constraints')
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of createReadStream(path)) {
    bytes += chunk.length
    if (bytes > before.size || bytes > maximumBytes) evidenceFailure(KIND, label, 'changed while being read')
    hash.update(chunk)
  }
  const after = await lstat(path)
  if (bytes !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino) {
    evidenceFailure(KIND, label, 'changed while being read')
  }
  return Object.freeze({ bytes, sha256: hash.digest('hex') })
}

async function regularFileSnapshot(pathInput: string, maximumBytes: number, label: string): Promise<{ bytes: number; sha256: string }> {
  const path = await requireCanonicalRegularFile(pathInput, KIND, label)
  const before = await lstat(path)
  if (before.size < 1 || before.size > maximumBytes) evidenceFailure(KIND, label, 'violates file size constraints')
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of createReadStream(path)) {
    bytes += chunk.length
    if (bytes > before.size || bytes > maximumBytes) evidenceFailure(KIND, label, 'changed while being read')
    hash.update(chunk)
  }
  const after = await lstat(path)
  if (bytes !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino) {
    evidenceFailure(KIND, label, 'changed while being read')
  }
  return Object.freeze({ bytes, sha256: hash.digest('hex') })
}

export interface GithubCliAuthority {
  readonly invocationPath: '/opt/homebrew/bin/gh'
  readonly executableRealpath: string
  readonly version: string
  readonly bytes: number
  readonly sha256: string
}

interface GithubCliFileSnapshot {
  readonly bytes: number
  readonly sha256: string
}

export interface H1ReleaseGithubCliFixtureIo {
  readonly resolveRealpath: (path: string) => Promise<string>
  readonly snapshotRegularFile: (
    path: string,
    maximumBytes: number,
    label: string,
  ) => Promise<GithubCliFileSnapshot>
}

const DEFAULT_GITHUB_CLI_IO: H1ReleaseGithubCliFixtureIo = Object.freeze({
  resolveRealpath: realpath,
  snapshotRegularFile: regularFileSnapshot,
})

async function inspectGithubCliAuthority(
  runCommand: H1CommandRunner = commandText,
  fixtureIo: H1ReleaseGithubCliFixtureIo = DEFAULT_GITHUB_CLI_IO,
): Promise<GithubCliAuthority> {
  const invocationPath = '/opt/homebrew/bin/gh' as const
  let executableRealpath: string
  try { executableRealpath = await fixtureIo.resolveRealpath(invocationPath) } catch {
    return evidenceFailure(KIND, 'GitHub CLI authority', 'is unavailable')
  }
  if (!executableRealpath.startsWith('/')) evidenceFailure(KIND, 'GitHub CLI authority', 'has an invalid realpath')
  const snapshot = await fixtureIo.snapshotRegularFile(
    executableRealpath,
    128 * 1024 * 1024,
    'GitHub CLI authority',
  )
  if (!Number.isSafeInteger(snapshot.bytes) || snapshot.bytes < 1 || !SHA256_PATTERN.test(snapshot.sha256)) {
    evidenceFailure(KIND, 'GitHub CLI authority', 'has an invalid snapshot')
  }
  const versionSource = await runCommand(invocationPath, ['--version'], 64 * 1024, 'GitHub CLI authority')
  const firstLine = versionSource.split('\n')[0] ?? ''
  const match = /^gh version ([0-9]+\.[0-9]+\.[0-9]+)(?:[-+][A-Za-z0-9.-]+)? \(.+\)$/.exec(firstLine)
  if (!match) evidenceFailure(KIND, 'GitHub CLI authority', 'returned an invalid version')
  return Object.freeze({
    invocationPath,
    executableRealpath,
    version: match[1]!,
    bytes: snapshot.bytes,
    sha256: snapshot.sha256,
  })
}

async function readBoundedJsonFile(path: string, maximumBytes: number, label: string): Promise<unknown> {
  const snapshot = await regularFileSnapshot(path, maximumBytes, label)
  const source = await readFile(path, 'utf8')
  if (Buffer.byteLength(source, 'utf8') !== snapshot.bytes) evidenceFailure(KIND, label, 'changed while being read')
  try { return JSON.parse(source) } catch { return evidenceFailure(KIND, label, 'is not JSON') }
}

interface GithubArtifactExpected {
  readonly name: string
  readonly digest: string
  readonly runId: number
  readonly sourceSha: string
  readonly archiveBytes?: number
}

async function githubArtifact(
  artifactId: number,
  expected: GithubArtifactExpected,
  runCommand: H1CommandRunner = commandText,
): Promise<void> {
  const source = await runCommand(
    '/opt/homebrew/bin/gh',
    ['api', '--hostname', 'github.com', `repos/${REPOSITORY}/actions/artifacts/${artifactId}`],
    MAX_GITHUB_RESPONSE_BYTES,
    'GitHub Artifact authority',
  )
  let parsed: unknown
  try { parsed = JSON.parse(source) } catch { return evidenceFailure(KIND, 'GitHub Artifact authority', 'returned invalid JSON') }
  const artifact = objectAt(parsed, '$artifact', KIND)
  const workflowRun = objectAt(artifact.workflow_run, '$artifact.workflow_run', KIND)
  if (artifact.id !== artifactId || artifact.name !== expected.name || artifact.digest !== expected.digest
    || artifact.expired !== false || typeof artifact.size_in_bytes !== 'number'
    || !Number.isSafeInteger(artifact.size_in_bytes) || artifact.size_in_bytes < 1
    || (expected.archiveBytes !== undefined && artifact.size_in_bytes !== expected.archiveBytes)
    || workflowRun.id !== expected.runId
    || workflowRun.repository_id !== REPOSITORY_ID || workflowRun.head_repository_id !== REPOSITORY_ID
    || workflowRun.head_branch !== 'main' || workflowRun.head_sha !== expected.sourceSha) {
    evidenceFailure(KIND, 'GitHub Artifact authority', 'does not match the requested run and source')
  }
}

export interface H1GitHubRunAttemptAuthority {
  readonly runId: number
  readonly runAttempt: number
  readonly event: 'workflow_dispatch'
  readonly status: 'completed'
  readonly conclusion: 'success'
  readonly headBranch: 'main'
  readonly headSha: string
  readonly workflowPath: typeof WORKFLOW_PATH
  readonly repositoryId: typeof REPOSITORY_ID
  readonly headRepositoryId: typeof REPOSITORY_ID
}

/** Verifies the exact run-attempt REST authority disclosed by provenance. */
export async function inspectOpenDesignM1H1GitHubRunAttempt(
  runId: number,
  runAttempt: number,
  sourceSha: string,
  runCommand: H1CommandRunner = commandText,
): Promise<H1GitHubRunAttemptAuthority> {
  if (!Number.isSafeInteger(runId) || runId < 1
    || !Number.isSafeInteger(runAttempt) || runAttempt < 1
    || !COMMIT_SHA_PATTERN.test(sourceSha)) evidenceFailure(KIND, 'GitHub run-attempt authority')
  const source = await runCommand(
    '/opt/homebrew/bin/gh',
    ['api', '--hostname', 'github.com', `repos/${REPOSITORY}/actions/runs/${runId}/attempts/${runAttempt}`],
    MAX_GITHUB_RESPONSE_BYTES,
    'GitHub run-attempt authority',
  )
  let parsed: unknown
  try { parsed = JSON.parse(source) } catch {
    return evidenceFailure(KIND, 'GitHub run-attempt authority', 'returned invalid JSON')
  }
  const run = objectAt(parsed, '$runAttempt', KIND)
  const repository = objectAt(run.repository, '$runAttempt.repository', KIND)
  const headRepository = objectAt(run.head_repository, '$runAttempt.head_repository', KIND)
  if (run.id !== runId || run.run_attempt !== runAttempt
    || run.event !== 'workflow_dispatch' || run.status !== 'completed' || run.conclusion !== 'success'
    || run.head_branch !== 'main' || run.head_sha !== sourceSha || run.path !== WORKFLOW_PATH
    || repository.id !== REPOSITORY_ID || repository.full_name !== REPOSITORY
    || headRepository.id !== REPOSITORY_ID || headRepository.full_name !== REPOSITORY) {
    evidenceFailure(KIND, 'GitHub run-attempt authority', 'does not match the completed main workflow attempt')
  }
  return Object.freeze({
    runId,
    runAttempt,
    event: 'workflow_dispatch',
    status: 'completed',
    conclusion: 'success',
    headBranch: 'main',
    headSha: sourceSha,
    workflowPath: WORKFLOW_PATH,
    repositoryId: REPOSITORY_ID,
    headRepositoryId: REPOSITORY_ID,
  })
}

function exactSubject(
  value: unknown,
  expected: readonly { readonly name: string; readonly sha256: string }[],
  label: string,
): void {
  if (!Array.isArray(value) || value.length !== expected.length) evidenceFailure(KIND, label)
  for (let index = 0; index < expected.length; index += 1) {
    const subject = objectAt(value[index], `${label}[${index}]`, KIND)
    const digest = objectAt(subject.digest, `${label}[${index}].digest`, KIND)
    exactKeys(subject, ['digest', 'name'], `${label}[${index}]`, KIND)
    exactKeys(digest, ['sha256'], `${label}[${index}].digest`, KIND)
    if (subject.name !== expected[index]!.name || digest.sha256 !== expected[index]!.sha256) {
      evidenceFailure(KIND, label)
    }
  }
}

function canonicalSemanticJson(value: unknown): string {
  const normalize = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(normalize)
    if (candidate !== null && typeof candidate === 'object') {
      const object = candidate as Record<string, unknown>
      return Object.fromEntries(Object.keys(object).sort().map((key) => [key, normalize(object[key])]))
    }
    return candidate
  }
  return JSON.stringify(normalize(value))
}

function validateProvenanceStatement(
  statementInput: unknown,
  authority: H1ConnectionAuthority,
  artifacts: readonly { readonly name: string; readonly sha256: string }[],
): number {
  const statement = objectAt(statementInput, '$provenance', KIND)
  if (statement._type !== 'https://in-toto.io/Statement/v1'
    || statement.predicateType !== 'https://slsa.dev/provenance/v1') {
    evidenceFailure(KIND, 'provenance statement')
  }
  exactSubject(statement.subject, artifacts, '$provenance.subject')
  const predicate = objectAt(statement.predicate, '$provenance.predicate', KIND)
  const buildDefinition = objectAt(predicate.buildDefinition, '$provenance.predicate.buildDefinition', KIND)
  const external = objectAt(buildDefinition.externalParameters, '$provenance.predicate.buildDefinition.externalParameters', KIND)
  const workflow = objectAt(external.workflow, '$provenance.predicate.buildDefinition.externalParameters.workflow', KIND)
  const internal = objectAt(buildDefinition.internalParameters, '$provenance.predicate.buildDefinition.internalParameters', KIND)
  const github = objectAt(internal.github, '$provenance.predicate.buildDefinition.internalParameters.github', KIND)
  const runDetails = objectAt(predicate.runDetails, '$provenance.predicate.runDetails', KIND)
  const builder = objectAt(runDetails.builder, '$provenance.predicate.runDetails.builder', KIND)
  const metadata = objectAt(runDetails.metadata, '$provenance.predicate.runDetails.metadata', KIND)
  const invocationMatch = typeof metadata.invocationId === 'string'
    ? new RegExp(`^https://github\\.com/${REPOSITORY}/actions/runs/${authority.hostBuildRunId}/attempts/([1-9][0-9]*)$`)
      .exec(metadata.invocationId)
    : null
  if (buildDefinition.buildType !== 'https://actions.github.io/buildtypes/workflow/v1'
    || workflow.ref !== 'refs/heads/main' || workflow.repository !== `https://github.com/${REPOSITORY}`
    || workflow.path !== WORKFLOW_PATH || github.event_name !== 'workflow_dispatch'
    || github.repository_id !== String(REPOSITORY_ID) || github.runner_environment !== 'github-hosted'
    || builder.id !== `https://github.com/${REPOSITORY}/${WORKFLOW_PATH}@refs/heads/main`
    || !invocationMatch
    || !Array.isArray(buildDefinition.resolvedDependencies)
    || buildDefinition.resolvedDependencies.length !== 1) {
    evidenceFailure(KIND, 'provenance statement', 'does not bind the expected GitHub-hosted workflow')
  }
  const dependency = objectAt(buildDefinition.resolvedDependencies[0], '$provenance.resolvedDependencies[0]', KIND)
  const dependencyDigest = objectAt(dependency.digest, '$provenance.resolvedDependencies[0].digest', KIND)
  if (dependency.uri !== `git+https://github.com/${REPOSITORY}@refs/heads/main`
    || dependencyDigest.gitCommit !== authority.sourceSha) {
    evidenceFailure(KIND, 'provenance statement', 'does not bind the expected source')
  }
  return positiveIntegerValue(Number(invocationMatch[1]), 'provenance run attempt')
}

function decodeDssePayload(pathValue: string, value: unknown): unknown {
  const bundle = objectAt(value, pathValue, KIND)
  const envelope = objectAt(bundle.dsseEnvelope, `${pathValue}.dsseEnvelope`, KIND)
  if (envelope.payloadType !== 'application/vnd.in-toto+json'
    || typeof envelope.payload !== 'string' || envelope.payload.length > MAX_ATTESTATION_RESPONSE_BYTES) {
    evidenceFailure(KIND, `${pathValue}.dsseEnvelope`)
  }
  try {
    const bytes = Buffer.from(envelope.payload, 'base64')
    if (bytes.length < 1 || bytes.length > MAX_ATTESTATION_RESPONSE_BYTES
      || bytes.toString('base64').replace(/=+$/, '') !== envelope.payload.replace(/=+$/, '')) {
      evidenceFailure(KIND, `${pathValue}.dsseEnvelope.payload`)
    }
    return JSON.parse(bytes.toString('utf8'))
  } catch {
    return evidenceFailure(KIND, `${pathValue}.dsseEnvelope.payload`, 'is not valid DSSE JSON')
  }
}

async function cryptographicallyVerifyAttestation(
  subject: string,
  bundle: string,
  predicateType: string,
  sourceSha: string,
  runCommand: H1CommandRunner = commandText,
): Promise<readonly JsonObject[]> {
  const source = await runCommand('/opt/homebrew/bin/gh', [
    'attestation', 'verify', subject,
    '--hostname', 'github.com',
    '--bundle', bundle,
    '--repo', REPOSITORY,
    '--signer-workflow', `${REPOSITORY}/${WORKFLOW_PATH}`,
    '--source-ref', 'refs/heads/main',
    '--source-digest', sourceSha,
    '--signer-digest', sourceSha,
    '--deny-self-hosted-runners',
    '--cert-oidc-issuer', 'https://token.actions.githubusercontent.com',
    '--digest-alg', 'sha256',
    '--predicate-type', predicateType,
    '--format', 'json',
  ], MAX_ATTESTATION_RESPONSE_BYTES, 'GitHub attestation verification')
  let parsed: unknown
  try { parsed = JSON.parse(source) } catch { return evidenceFailure(KIND, 'GitHub attestation verification', 'returned invalid JSON') }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 8) {
    evidenceFailure(KIND, 'GitHub attestation verification')
  }
  return Object.freeze(parsed.map((entry, index) => objectAt(entry, `$attestations[${index}]`, KIND)))
}

async function verifyAttestations(
  bundleRoot: string,
  authority: H1ConnectionAuthority,
  dmgSha256: string,
  zipSha256: string,
  runCommand: H1CommandRunner = commandText,
): Promise<number> {
  const provenancePath = join(bundleRoot, 'attestations', 'provenance.sigstore.json')
  const sbomBundlePath = join(bundleRoot, 'attestations', 'sbom.sigstore.json')
  const provenanceBundle = await readBoundedJsonFile(provenancePath, 32 * 1024 * 1024, 'provenance attestation bundle')
  const hostBuildRunAttempt = validateProvenanceStatement(decodeDssePayload('$provenanceBundle', provenanceBundle), authority, [
    { name: 'Simulator-arm64.dmg', sha256: dmgSha256 },
    { name: 'Simulator-arm64.zip', sha256: zipSha256 },
  ])
  const provenanceExpected = [
    { name: 'Simulator-arm64.dmg', sha256: dmgSha256 },
    { name: 'Simulator-arm64.zip', sha256: zipSha256 },
  ] as const
  for (const subjectName of ['Simulator-arm64.dmg', 'Simulator-arm64.zip'] as const) {
    const verified = await cryptographicallyVerifyAttestation(
      join(bundleRoot, subjectName),
      provenancePath,
      'https://slsa.dev/provenance/v1',
      authority.sourceSha,
      runCommand,
    )
    for (const [index, result] of verified.entries()) {
      const verification = objectAt(result.verificationResult, `$verified[${index}].verificationResult`, KIND)
      if (validateProvenanceStatement(verification.statement, authority, provenanceExpected) !== hostBuildRunAttempt) {
        evidenceFailure(KIND, 'provenance statement', 'contains inconsistent workflow attempts')
      }
    }
  }
  const verifiedSbom = await cryptographicallyVerifyAttestation(
    join(bundleRoot, 'Simulator-arm64.zip'),
    sbomBundlePath,
    'https://spdx.dev/Document/v2.3',
    authority.sourceSha,
    runCommand,
  )
  const expectedSbom = await readBoundedJsonFile(join(bundleRoot, 'sbom.spdx.json'), 128 * 1024 * 1024, 'SPDX SBOM')
  for (const [index, result] of verifiedSbom.entries()) {
    const verification = objectAt(result.verificationResult, `$verifiedSbom[${index}].verificationResult`, KIND)
    const statement = objectAt(verification.statement, `$verifiedSbom[${index}].statement`, KIND)
    if (statement.predicateType !== 'https://spdx.dev/Document/v2.3'
      || canonicalSemanticJson(statement.predicate) !== canonicalSemanticJson(expectedSbom)) {
      evidenceFailure(KIND, 'SBOM attestation', 'does not match the bundled SPDX document')
    }
    exactSubject(statement.subject, [{ name: 'Simulator-arm64.zip', sha256: zipSha256 }], '$sbom.subject')
  }
  return hostBuildRunAttempt
}

function positiveIntegerValue(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) evidenceFailure(KIND, label)
  return value as number
}

function hashValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) evidenceFailure(KIND, label)
  return value
}

async function compareFinalBundleTrees(leftRoot: string, rightRoot: string): Promise<Readonly<Record<string, { bytes: number; sha256: string }>>> {
  const result: Record<string, { bytes: number; sha256: string }> = {}
  for (const path of FINAL_BUNDLE_FILES) {
    const [left, right] = await Promise.all([
      regularFileSnapshot(join(leftRoot, path), path.endsWith('.dmg') || path.endsWith('.zip')
        ? 1280 * 1024 * 1024 : 256 * 1024 * 1024, `bundle.${path}`),
      regularFileSnapshot(join(rightRoot, path), path.endsWith('.dmg') || path.endsWith('.zip')
        ? 1280 * 1024 * 1024 : 256 * 1024 * 1024, `archive.${path}`),
    ])
    if (left.bytes !== right.bytes || left.sha256 !== right.sha256) {
      evidenceFailure(KIND, `bundle.${path}`, 'does not match the authenticated Artifact archive')
    }
    result[path] = left
  }
  return Object.freeze(result)
}

async function extractAuthenticatedFinalArchive(
  archive: string,
  runCommand: H1CommandRunner = commandText,
): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'simulator-m1-h1-artifact-')))
  await chmod(root, 0o700)
  try {
    await runCommand('/usr/bin/python3', [
      join(REPOSITORY_ROOT, 'scripts', 'release', 'extract-engineering-rc-artifact.py'),
      'final', archive, root,
    ], 1024 * 1024, 'Engineering RC Artifact extraction')
    return root
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

/** Narrow deterministic seam: production helpers remain wired and exercised. */
export interface H1ReleaseAuthorityTestSeam {
  readonly runCommand: H1CommandRunner
  readonly githubCliFixtureIo: H1ReleaseGithubCliFixtureIo
}

export async function inspectOpenDesignM1H1ReleaseAuthority(
  authority: H1ConnectionAuthority,
  testSeam?: H1ReleaseAuthorityTestSeam,
): Promise<ReleaseAuthoritySnapshot> {
  const runCommand = testSeam?.runCommand ?? commandText
  const githubCliFixtureIo = testSeam?.githubCliFixtureIo ?? DEFAULT_GITHUB_CLI_IO
  validateAuthority(authority)
  const bundleRoot = await requireOwnerOnlyDirectory(authority.bundleRootRealpath, KIND, 'authority.bundleRootRealpath')
  const archive = await requireCanonicalRegularFile(
    authority.artifactArchiveRealpath,
    KIND,
    'authority.artifactArchiveRealpath',
    { ownerOnly: true },
  )
  const archiveSnapshot = await streamFileSnapshot(archive, MAX_ARTIFACT_ARCHIVE_BYTES, 'authority.artifactArchiveRealpath')
  if (archiveSnapshot.sha256 !== serviceDigest(authority.hostArtifactDigest, 'authority.hostArtifactDigest')) {
    evidenceFailure(KIND, 'authority.artifactArchiveRealpath', 'does not match the GitHub service digest')
  }

  const [repositoryHead, repositoryStatus] = await Promise.all([
    runCommand('/usr/bin/git', ['-C', REPOSITORY_ROOT, 'rev-parse', 'HEAD'], 1024, 'verifier source authority'),
    runCommand(
      '/usr/bin/git', ['-C', REPOSITORY_ROOT, 'status', '--porcelain=v1', '--untracked-files=all'],
      1024 * 1024, 'verifier source authority',
    ),
  ])
  if (repositoryHead !== authority.sourceSha || repositoryStatus !== '') {
    evidenceFailure(KIND, 'verifier source authority', 'must be the clean exact source commit')
  }
  const githubCliBefore = await inspectGithubCliAuthority(runCommand, githubCliFixtureIo)

  const metadata = objectAt(
    await readBoundedJsonFile(join(bundleRoot, 'bundle-metadata.json'), 32 * 1024 * 1024, 'bundle metadata'),
    '$bundleMetadata',
    KIND,
  )
  exactKeys(metadata, [
    'channel', 'inputArtifactDigest', 'inputArtifactId', 'productVersion', 'rcLabel',
    'schemaVersion', 'signed', 'sourceSha',
  ], '$bundleMetadata', KIND)
  const inputArtifactId = positiveIntegerValue(
    typeof metadata.inputArtifactId === 'string' && /^[1-9][0-9]*$/.test(metadata.inputArtifactId)
      ? Number(metadata.inputArtifactId)
      : metadata.inputArtifactId,
    '$bundleMetadata.inputArtifactId',
  )
  const inputArtifactDigest = hashValue(metadata.inputArtifactDigest, '$bundleMetadata.inputArtifactDigest')
  if (metadata.schemaVersion !== 1 || metadata.channel !== 'engineering-rc' || metadata.signed !== false
    || metadata.rcLabel !== authority.rcLabel || metadata.productVersion !== authority.productVersion
    || metadata.sourceSha !== authority.sourceSha) {
    evidenceFailure(KIND, 'bundle metadata', 'does not match the requested authority')
  }

  await Promise.all([
    githubArtifact(authority.hostArtifactId, {
      name: `simulator-${authority.rcLabel}-macos-arm64-unsigned`,
      digest: authority.hostArtifactDigest,
      runId: authority.hostBuildRunId,
      sourceSha: authority.sourceSha,
      archiveBytes: archiveSnapshot.bytes,
    }, runCommand),
    githubArtifact(inputArtifactId, {
      name: `engineering-rc-input-${authority.rcLabel}-${authority.sourceSha}`,
      digest: `sha256:${inputArtifactDigest}`,
      runId: authority.hostBuildRunId,
      sourceSha: authority.sourceSha,
    }, runCommand),
  ])

  try {
    await verifyEngineeringRcBundle({
      phase: 'final',
      bundleDirectory: bundleRoot,
      rcLabel: authority.rcLabel,
      productVersion: authority.productVersion,
      sourceSha: authority.sourceSha,
      inputArtifactId: String(inputArtifactId),
      inputArtifactDigest,
    })
  } catch {
    evidenceFailure(KIND, 'Engineering RC bundle verification', 'failed')
  }

  const extractedRoot = await extractAuthenticatedFinalArchive(archive, runCommand)
  let bundleFiles: Readonly<Record<string, { bytes: number; sha256: string }>>
  try {
    await verifyEngineeringRcBundle({
      phase: 'final',
      bundleDirectory: extractedRoot,
      rcLabel: authority.rcLabel,
      productVersion: authority.productVersion,
      sourceSha: authority.sourceSha,
      inputArtifactId: String(inputArtifactId),
      inputArtifactDigest,
    })
    bundleFiles = await compareFinalBundleTrees(bundleRoot, extractedRoot)
  } catch {
    return evidenceFailure(KIND, 'authenticated Artifact bundle', 'failed exact extraction or comparison')
  } finally {
    await rm(extractedRoot, { recursive: true, force: true })
  }

  const dmg = bundleFiles['Simulator-arm64.dmg']!
  const zip = bundleFiles['Simulator-arm64.zip']!
  const hostBuildRunAttempt = await verifyAttestations(
    bundleRoot, authority, dmg.sha256, zip.sha256, runCommand,
  )
  await inspectOpenDesignM1H1GitHubRunAttempt(
    authority.hostBuildRunId,
    hostBuildRunAttempt,
    authority.sourceSha,
    runCommand,
  )
  const githubCliAfter = await inspectGithubCliAuthority(runCommand, githubCliFixtureIo)
  if (canonicalJson(githubCliAfter) !== canonicalJson(githubCliBefore)) {
    evidenceFailure(KIND, 'GitHub CLI authority', 'changed across verification')
  }

  return Object.freeze({
    authority: Object.freeze({
      sourceSha: authority.sourceSha,
      verifierRepositoryHeadSha: repositoryHead,
      hostBuildRunId: authority.hostBuildRunId,
      hostBuildRunAttempt,
      hostArtifactId: authority.hostArtifactId,
      hostArtifactName: `simulator-${authority.rcLabel}-macos-arm64-unsigned`,
      hostArtifactDigest: authority.hostArtifactDigest,
      hostArtifactArchive: {
        realpath: archive,
        bytes: archiveSnapshot.bytes,
        sha256: archiveSnapshot.sha256,
      },
      rcLabel: authority.rcLabel,
      productVersion: authority.productVersion,
      inputArtifactId,
      inputArtifactDigest: `sha256:${inputArtifactDigest}`,
      bundleRootRealpath: bundleRoot,
      dmg,
      zip,
      bundleMetadataSha256: bundleFiles['bundle-metadata.json']!.sha256,
      appInventorySha256: bundleFiles['app-inventory.jsonl']!.sha256,
      packagedFilesSha256: bundleFiles['packaged-files.sha256']!.sha256,
      packageVerificationCodeSha256: bundleFiles['package-verification-code.txt']!.sha256,
      provenanceAttestationSha256: bundleFiles['attestations/provenance.sigstore.json']!.sha256,
      sbomAttestationSha256: bundleFiles['attestations/sbom.sigstore.json']!.sha256,
      githubCli: githubCliBefore,
    }),
    bundleFiles,
  })
}

async function assertNoUnexpectedHardLinks(root: string): Promise<void> {
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      const metadata = await lstat(path)
      if (metadata.isSymbolicLink()) continue
      if (metadata.isDirectory()) await visit(path)
      else if (metadata.isFile()) {
        if (metadata.nlink !== 1) evidenceFailure(KIND, 'staged App', 'contains a hard-linked regular file')
      } else {
        evidenceFailure(KIND, 'staged App', 'contains an unsupported filesystem entry')
      }
    }
  }
  await visit(root)
}

export function normalizeOpenDesignM1H1StagedInventory(
  stagedSource: string,
  expectedSource: string,
): { normalizedSha256: string; provenanceSha256: string | null } {
  if (!stagedSource.endsWith('\n') || stagedSource.includes('\r')
    || !expectedSource.endsWith('\n') || expectedSource.includes('\r')) {
    evidenceFailure(KIND, 'staged App inventory', 'is not canonical JSONL')
  }
  const stagedLines = stagedSource.slice(0, -1).split('\n')
  const expectedLines = expectedSource.slice(0, -1).split('\n')
  if (stagedLines.length !== expectedLines.length || stagedLines.length < 1) {
    evidenceFailure(KIND, 'staged App inventory', 'does not match the packaged path closure')
  }
  const provenanceDigests = new Set<string>()
  let provenanceEntries = 0
  const normalizedLines = stagedLines.map((line, index) => {
    let stagedValue: unknown
    let expectedValue: unknown
    try {
      stagedValue = JSON.parse(line)
      expectedValue = JSON.parse(expectedLines[index]!)
    } catch {
      return evidenceFailure(KIND, 'staged App inventory', 'contains invalid JSONL')
    }
    if (line !== JSON.stringify(stagedValue) || expectedLines[index] !== JSON.stringify(expectedValue)) {
      evidenceFailure(KIND, 'staged App inventory', 'is not canonical compact JSONL')
    }
    const stagedEntry = objectAt(stagedValue, `$stagedInventory[${index}]`, KIND)
    const expectedEntry = objectAt(expectedValue, `$expectedInventory[${index}]`, KIND)
    if (!Array.isArray(stagedEntry.xattrs) || !Array.isArray(expectedEntry.xattrs)) {
      evidenceFailure(KIND, 'staged App inventory xattrs')
    }
    const expectedHasProvenance = expectedEntry.xattrs.some((candidate) => {
      const attribute = objectAt(candidate, `$expectedInventory[${index}].xattrs`, KIND)
      return attribute.name === 'com.apple.provenance'
    })
    const normalizedAttributes: unknown[] = []
    let entryProvenanceCount = 0
    for (const candidate of stagedEntry.xattrs) {
      const attribute = objectAt(candidate, `$stagedInventory[${index}].xattrs`, KIND)
      if (!expectedHasProvenance && attribute.name === 'com.apple.provenance') {
        exactKeys(attribute, ['name', 'sha256'], `$stagedInventory[${index}].xattrs`, KIND)
        if (typeof attribute.sha256 !== 'string' || !SHA256_PATTERN.test(attribute.sha256)) {
          evidenceFailure(KIND, 'staged App provenance xattr')
        }
        provenanceDigests.add(attribute.sha256)
        entryProvenanceCount += 1
      } else {
        normalizedAttributes.push(candidate)
      }
    }
    if (entryProvenanceCount > 1) evidenceFailure(KIND, 'staged App provenance xattr', 'is duplicated')
    if (entryProvenanceCount === 1) provenanceEntries += 1
    const normalizedEntry = { ...stagedEntry, xattrs: normalizedAttributes }
    const normalizedLine = JSON.stringify(normalizedEntry)
    if (normalizedLine !== expectedLines[index]) {
      evidenceFailure(KIND, 'staged App inventory', 'differs outside the explicit LaunchServices provenance normalization')
    }
    return normalizedLine
  })
  if (provenanceDigests.size > 1
    || (provenanceEntries !== 0 && provenanceEntries !== stagedLines.length)) {
    evidenceFailure(KIND, 'staged App provenance xattr', 'is not uniform across the exact App tree')
  }
  const normalizedSource = `${normalizedLines.join('\n')}\n`
  if (normalizedSource !== expectedSource) evidenceFailure(KIND, 'staged App inventory')
  return Object.freeze({
    normalizedSha256: sha256(normalizedSource),
    provenanceSha256: provenanceEntries === 0 ? null : [...provenanceDigests][0]!,
  })
}

export async function inspectOpenDesignM1H1StagedApp(
  instance: H1ConnectionInstance,
  release: ReleaseAuthoritySnapshot,
  runCommand: H1CommandRunner = commandText,
): Promise<StagingSnapshot> {
  await assertNoUnexpectedHardLinks(instance.appBundleRealpath)
  await runCommand('/usr/bin/codesign', [
    '--verify', '--deep', '--strict', instance.appBundleRealpath,
  ], 128 * 1024, 'staged App strict code-signature verification')
  const temporaryRoot = await realpath(await mkdtemp(join(tmpdir(), 'simulator-m1-h1-inventory-')))
  await chmod(temporaryRoot, 0o700)
  const inventory = join(temporaryRoot, 'app-inventory.jsonl')
  const packagedFiles = join(temporaryRoot, 'packaged-files.sha256')
  const packageVerificationCode = join(temporaryRoot, 'package-verification-code.txt')
  try {
    await runCommand('/usr/bin/python3', [
      join(REPOSITORY_ROOT, 'scripts', 'release', 'write-app-inventory.py'),
      instance.appBundleRealpath,
      inventory,
      '--transport-canonicalization-policy', 'macos-dmg-zip-v1',
      '--spdx-files', packagedFiles,
      '--spdx-package-verification-code', packageVerificationCode,
    ], 1024 * 1024, 'staged App inventory')
    const [inventorySnapshot, packagedFilesSnapshot, verificationCodeSnapshot] = await Promise.all([
      regularFileSnapshot(inventory, 256 * 1024 * 1024, 'staged App inventory'),
      regularFileSnapshot(packagedFiles, 256 * 1024 * 1024, 'staged App packaged files'),
      regularFileSnapshot(packageVerificationCode, 1024, 'staged App package verification code'),
    ])
    const expectedInventoryPath = join(
      stringAt(release.authority, 'bundleRootRealpath', '$release.authority', KIND),
      'app-inventory.jsonl',
    )
    const [stagedInventoryBytes, expectedInventoryBytes] = await Promise.all([
      readFile(inventory),
      readOwnerOnlyBoundedFile(
        expectedInventoryPath, 256 * 1024 * 1024, KIND, 'Engineering RC App inventory',
      ),
    ])
    if (sha256(stagedInventoryBytes) !== inventorySnapshot.sha256
      || sha256(expectedInventoryBytes) !== release.authority.appInventorySha256) {
      evidenceFailure(KIND, 'staged App inventory', 'changed across the comparison boundary')
    }
    const stagedInventorySource = stagedInventoryBytes.toString('utf8')
    const expectedInventorySource = expectedInventoryBytes.toString('utf8')
    const normalizedInventory = normalizeOpenDesignM1H1StagedInventory(stagedInventorySource, expectedInventorySource)
    if (normalizedInventory.normalizedSha256 !== release.authority.appInventorySha256
      || packagedFilesSnapshot.sha256 !== release.authority.packagedFilesSha256
      || verificationCodeSnapshot.sha256 !== release.authority.packageVerificationCodeSha256) {
      evidenceFailure(KIND, 'staged App inventory', 'does not match the authenticated Engineering RC')
    }
    const packagedSource = await readFile(packagedFiles, 'utf8')
    if (!packagedSource.endsWith('\n') || packagedSource.includes('\r')) {
      evidenceFailure(KIND, 'staged App packaged files')
    }
    const packagedFileCount = packagedSource.slice(0, -1).split('\n').length
    if (packagedFileCount < 1) evidenceFailure(KIND, 'staged App packaged files')
    return Object.freeze({
      appInventorySha256: normalizedInventory.normalizedSha256,
      rawAppInventorySha256: inventorySnapshot.sha256,
      macOSLaunchServicesProvenanceSha256: normalizedInventory.provenanceSha256,
      packagedFilesSha256: packagedFilesSnapshot.sha256,
      packageVerificationCodeSha256: verificationCodeSnapshot.sha256,
      packagedFileCount,
      codesignStrictVerified: true,
    })
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

interface LaunchCaptureInput {
  readonly appBundleRealpath: string
  readonly executableRealpath: string
  readonly mainPid: number
  readonly profileRealpath: string
  readonly configRealpath: string
  readonly cdpPort: number
}

async function canonicalLaunchInput(input: LaunchCaptureInput): Promise<LaunchCaptureInput> {
  validatePort(input.cdpPort)
  if (!Number.isSafeInteger(input.mainPid) || input.mainPid < 2) evidenceFailure(KIND, 'launch.mainPid')
  const appBundleRealpath = await requireCanonicalDirectory(input.appBundleRealpath, KIND, 'launch.appBundleRealpath')
  const executableRealpath = await requireCanonicalRegularFile(
    input.executableRealpath, KIND, 'launch.executableRealpath', { executable: true },
  )
  if (!appBundleRealpath.endsWith('.app') || dirname(executableRealpath) !== join(appBundleRealpath, 'Contents', 'MacOS')) {
    evidenceFailure(KIND, 'launch app identity')
  }
  const profileRealpath = await requireOwnerOnlyDirectory(input.profileRealpath, KIND, 'launch.profileRealpath')
  const configRealpath = await requireOwnerOnlyDirectory(input.configRealpath, KIND, 'launch.configRealpath')
  if (profileRealpath === configRealpath) evidenceFailure(KIND, 'launch roots')
  return Object.freeze({
    appBundleRealpath, executableRealpath, mainPid: input.mainPid,
    profileRealpath, configRealpath, cdpPort: input.cdpPort,
  })
}

function mainProcessMatches(instance: LaunchCaptureInput, observation: ProcessObservation): boolean {
  const uid = typeof process.getuid === 'function' ? process.getuid() : observation.uid
  return observation.pid === instance.mainPid && observation.uid === uid && observation.parentPid >= 0
    && observation.executableRealpath === instance.executableRealpath
    && observation.loopbackListeningPorts.includes(instance.cdpPort)
    && hasOneExactProcessArgument(observation.commandLine, `--remote-debugging-port=${instance.cdpPort}`)
    && hasOneExactProcessArgument(observation.commandLine, `--user-data-dir=${instance.profileRealpath}`)
}

export async function captureOpenDesignM1H1LaunchEvidence(
  outputFileInput: string,
  inputValue: LaunchCaptureInput,
  dependencies: Pick<H1ConnectionProbeDependencies, 'inspectProcess' | 'now'>,
): Promise<{ readonly objectPath: string; readonly sha256: string; readonly capturedAt: string }> {
  const input = await canonicalLaunchInput(inputValue)
  const observation = await dependencies.inspectProcess(input.mainPid)
  if (!mainProcessMatches(input, observation)) {
    evidenceFailure(KIND, 'dedicated process identity', 'does not match the expected app, PID, profile, and CDP port')
  }
  const capturedAt = new Date(dependencies.now()).toISOString()
  canonicalTimestamp(capturedAt, '$launch.capturedAt', KIND)
  if (Date.parse(capturedAt) + 1_000 < observation.startedAtMs) evidenceFailure(KIND, '$launch.capturedAt')
  const launch = {
    schemaVersion: 1,
    kind: LAUNCH_KIND,
    capturedAt,
    appBundleRealpath: input.appBundleRealpath,
    executableRealpath: input.executableRealpath,
    mainPid: input.mainPid,
    processStartIdentity: observation.startIdentity,
    profileRealpath: input.profileRealpath,
    configRealpath: input.configRealpath,
    cdpPort: input.cdpPort,
  }
  const outputParent = await requireOwnerOnlyDirectory(dirname(outputFileInput), KIND, 'launch output parent')
  const outputFile = resolve(outputFileInput)
  if (outputFile !== join(outputParent, basename(outputFile)) || outputFile === outputParent) {
    evidenceFailure(KIND, 'launch output file', 'is not canonical')
  }
  const source = canonicalJson(launch)
  await writeOwnerOnlyNewFile(outputFile, source)
  return Object.freeze({ objectPath: outputFile, sha256: sha256(source), capturedAt })
}

async function readServerLock(configRoot: string): Promise<{ pid: number; startedAt: number }> {
  const lockPath = join(configRoot, '.server.lock')
  const canonical = await requireCanonicalRegularFile(lockPath, KIND, 'server lock')
  const before = await lstat(canonical)
  const uid = typeof process.getuid === 'function' ? process.getuid() : before.uid
  if (before.uid !== uid || (before.mode & 0o022) !== 0 || before.size < 1 || before.size > MAX_LOCK_BYTES) {
    evidenceFailure(KIND, 'server lock', 'must be an owner-controlled regular file')
  }
  const source = await readFile(canonical, 'utf8')
  const after = await lstat(canonical)
  if (after.ino !== before.ino || after.mtimeMs !== before.mtimeMs || after.size !== before.size
    || Buffer.byteLength(source, 'utf8') !== before.size) {
    evidenceFailure(KIND, 'server lock', 'changed while being read')
  }
  let parsed: unknown
  try { parsed = JSON.parse(source) } catch { return evidenceFailure(KIND, 'server lock', 'is not JSON') }
  const lock = objectAt(parsed, '$serverLock', KIND)
  exactKeys(lock, ['pid', 'startedAt'], '$serverLock', KIND)
  const pid = positiveIntegerValue(lock.pid, '$serverLock.pid')
  const startedAt = positiveIntegerValue(lock.startedAt, '$serverLock.startedAt')
  if (source !== JSON.stringify({ pid, startedAt })) evidenceFailure(KIND, 'server lock', 'is not canonical compact JSON')
  return Object.freeze({ pid, startedAt })
}

function descendantProcess(
  rootPid: number,
  descendantPid: number,
  processes: readonly ProcessObservation[],
): ProcessObservation | undefined {
  const byPid = new Map<number, ProcessObservation>()
  for (const processValue of processes) {
    if (byPid.has(processValue.pid)) evidenceFailure(KIND, 'process list', 'contains duplicate PIDs')
    byPid.set(processValue.pid, processValue)
  }
  let current = byPid.get(descendantPid)
  const visited = new Set<number>()
  for (let depth = 0; current && depth < 64; depth += 1) {
    if (visited.has(current.pid)) evidenceFailure(KIND, 'process ancestry', 'contains a cycle')
    visited.add(current.pid)
    if (current.pid === rootPid) return byPid.get(descendantPid)
    current = byPid.get(current.parentPid)
  }
  return undefined
}

async function inspectLaunchBinding(
  instance: CanonicalInstance,
  dependencies: H1ConnectionProbeDependencies,
): Promise<{
  readonly launch: JsonObject
  readonly validatedTarget: ValidatedTarget
  readonly observedAt: string
  readonly observedAtMs: number
}> {
  const [launchValue, mainObservation, processList, serverLock, launchSnapshot] = await Promise.all([
    readOwnerOnlyCanonicalJson(instance.launchEvidenceRealpath, MAX_LAUNCH_BYTES, KIND, 'launch evidence'),
    dependencies.inspectProcess(instance.mainPid),
    dependencies.listProcesses(),
    readServerLock(instance.configRealpath),
    streamFileSnapshot(instance.launchEvidenceRealpath, MAX_LAUNCH_BYTES, 'launch evidence'),
  ])
  if (!mainProcessMatches(instance, mainObservation)) {
    evidenceFailure(KIND, 'dedicated process identity', 'does not match the expected app, PID, profile, and CDP port')
  }
  const launch = objectAt(launchValue, '$launch', KIND)
  exactKeys(launch, [
    'appBundleRealpath', 'capturedAt', 'cdpPort', 'configRealpath', 'executableRealpath',
    'kind', 'mainPid', 'processStartIdentity', 'profileRealpath', 'schemaVersion',
  ], '$launch', KIND)
  const capturedAt = stringAt(launch, 'capturedAt', '$launch', KIND)
  const capturedAtMs = canonicalTimestamp(capturedAt, '$launch.capturedAt', KIND)
  const now = dependencies.now()
  if (launch.schemaVersion !== 1 || launch.kind !== LAUNCH_KIND
    || launch.appBundleRealpath !== instance.appBundleRealpath
    || launch.executableRealpath !== instance.executableRealpath || launch.mainPid !== instance.mainPid
    || launch.processStartIdentity !== mainObservation.startIdentity
    || launch.profileRealpath !== instance.profileRealpath || launch.configRealpath !== instance.configRealpath
    || launch.cdpPort !== instance.cdpPort || capturedAtMs + 1_000 < mainObservation.startedAtMs
    || capturedAtMs > now) {
    evidenceFailure(KIND, 'launch evidence', 'does not match the live dedicated instance')
  }

  const uid = typeof process.getuid === 'function' ? process.getuid() : mainObservation.uid
  const serverObservation = serverLock.pid === instance.mainPid
    ? mainObservation
    : descendantProcess(instance.mainPid, serverLock.pid, processList)
  if (!serverObservation || serverObservation.uid !== uid
    || serverObservation.startedAtMs > serverLock.startedAt + 1_000
    || mainObservation.startedAtMs > serverLock.startedAt + 1_000
    || serverLock.startedAt > now + 5_000
    || (serverLock.pid !== instance.mainPid
      && !serverObservation.executableRealpath.startsWith(`${instance.appBundleRealpath}/`))) {
    evidenceFailure(KIND, 'server lock', 'does not belong to the live app process tree')
  }

  const validatedTarget = validatedCraftTarget(await dependencies.discoverTargets(instance.cdpPort), instance)
  const runtimeBinding = requireRuntimeBinding(await dependencies.readRuntimeBinding(validatedTarget.target, {
    profileRealpath: instance.profileRealpath,
    configRealpath: instance.configRealpath,
    mainPid: instance.mainPid,
    serverPid: serverLock.pid,
    serverLockStartedAt: serverLock.startedAt,
  }))
  // This is deliberately the first operation after the final live App RPC.
  const observedAtMs = dependencies.now()
  const observedAt = new Date(observedAtMs).toISOString()
  canonicalTimestamp(observedAt, '$.observation.observedAt', KIND)
  return Object.freeze({
    launch: Object.freeze({
      launchEvidenceRealpath: instance.launchEvidenceRealpath,
      launchEvidenceSha256: launchSnapshot.sha256,
      appBundleRealpath: instance.appBundleRealpath,
      executableRealpath: instance.executableRealpath,
      profileRealpath: instance.profileRealpath,
      configRealpath: instance.configRealpath,
      mainPid: instance.mainPid,
      processStartIdentity: mainObservation.startIdentity,
      cdpPort: instance.cdpPort,
      serverPid: serverLock.pid,
      serverProcessStartIdentity: serverObservation.startIdentity,
      serverLockStartedAt: serverLock.startedAt,
      targetId: validatedTarget.target.id,
      workspaceId: validatedTarget.workspaceId,
      runtimeBinding: Object.freeze({
        schemaVersion: runtimeBinding.schemaVersion,
        configRootMatches: runtimeBinding.configRootMatches,
        userDataRootMatches: runtimeBinding.userDataRootMatches,
        mainPidMatches: runtimeBinding.mainPidMatches,
        serverIdentityMatches: runtimeBinding.serverIdentityMatches,
        runtimeInstanceDigest: runtimeBinding.runtimeInstanceDigest,
      }),
    }),
    validatedTarget,
    observedAt,
    observedAtMs,
  })
}

async function collectPreflightBinding(
  authorityInput: H1ConnectionAuthority,
  instanceInput: H1ConnectionInstance,
  dependencies: H1ConnectionProbeDependencies,
): Promise<{
  readonly binding: JsonObject
  readonly target: CdpTarget
  readonly instance: CanonicalInstance
  readonly observedAt: string
  readonly observedAtMs: number
}> {
  validateAuthority(authorityInput)
  // This sequence is the authority boundary: immutable release first, exact
  // staged App second, and only then the final live process/CDP/RPC check.
  const release = await dependencies.inspectReleaseAuthority(authorityInput)
  const instance = await canonicalInstance(instanceInput)
  const staging = await dependencies.inspectStagedApp(instance, release)
  if (staging.appInventorySha256 !== release.authority.appInventorySha256
    || staging.packagedFilesSha256 !== release.authority.packagedFilesSha256
    || staging.packageVerificationCodeSha256 !== release.authority.packageVerificationCodeSha256
    || !SHA256_PATTERN.test(staging.rawAppInventorySha256)
    || (staging.macOSLaunchServicesProvenanceSha256 !== null
      && !SHA256_PATTERN.test(staging.macOSLaunchServicesProvenanceSha256))
    || staging.codesignStrictVerified !== true || staging.packagedFileCount < 1) {
    evidenceFailure(KIND, 'staging authority', 'does not match the Engineering RC bundle')
  }
  const launch = await inspectLaunchBinding(instance, dependencies)
  return Object.freeze({
    binding: Object.freeze({
      authority: release.authority,
      staging: Object.freeze({
        appBundleRealpath: instance.appBundleRealpath,
        executableRealpath: instance.executableRealpath,
        appInventorySha256: staging.appInventorySha256,
        rawAppInventorySha256: staging.rawAppInventorySha256,
        macOSLaunchServicesProvenanceSha256: staging.macOSLaunchServicesProvenanceSha256,
        packagedFilesSha256: staging.packagedFilesSha256,
        packageVerificationCodeSha256: staging.packageVerificationCodeSha256,
        packagedFileCount: staging.packagedFileCount,
        codesignStrictVerified: true,
      }),
      launch: launch.launch,
    }),
    target: launch.validatedTarget.target,
    instance,
    observedAt: launch.observedAt,
    observedAtMs: launch.observedAtMs,
  })
}

const DEFAULT_DEPENDENCIES: H1ConnectionProbeDependencies = Object.freeze({
  inspectProcess: inspectDarwinProcess,
  listProcesses: listDarwinProcesses,
  discoverTargets: discoverCdpTargets,
  readAuthenticatedConnectionsPresent,
  readRuntimeBinding,
  inspectReleaseAuthority: inspectOpenDesignM1H1ReleaseAuthority,
  inspectStagedApp: inspectOpenDesignM1H1StagedApp,
  now: () => Date.now(),
})

function expectedPreflight(binding: JsonObject, observedAt: string): JsonObject {
  return {
    schemaVersion: 2,
    kind: PREFLIGHT_KIND,
    ...binding,
    observation: {
      observedAt,
      verifierDidNotSendTurn: true,
    },
  }
}

async function validatePreflightDirectory(
  rootInput: string,
  binding: JsonObject,
  now: number,
): Promise<H1PreflightEvidenceResult> {
  const root = await inventoryOwnerOnlyFiles(rootInput, [CHECKSUMS_PATH, PREFLIGHT_PATH], KIND)
  const proofPath = join(root, PREFLIGHT_PATH)
  const proof = objectAt(
    await readOwnerOnlyCanonicalJson(proofPath, MAX_PROOF_BYTES, KIND, PREFLIGHT_PATH),
    '$', KIND,
  )
  exactKeys(proof, ['authority', 'kind', 'launch', 'observation', 'schemaVersion', 'staging'], '$', KIND)
  if (proof.schemaVersion !== 2 || proof.kind !== PREFLIGHT_KIND) evidenceFailure(KIND, '$')
  const observation = objectAt(proof.observation, '$.observation', KIND)
  exactKeys(observation, ['observedAt', 'verifierDidNotSendTurn'], '$.observation', KIND)
  const observedAt = stringAt(observation, 'observedAt', '$.observation', KIND)
  const observedAtMs = canonicalTimestamp(observedAt, '$.observation.observedAt', KIND)
  if (observedAtMs > now || observation.verifierDidNotSendTurn !== true) {
    evidenceFailure(KIND, '$.observation')
  }
  if (canonicalJson(proof) !== canonicalJson(expectedPreflight(binding, observedAt))) {
    evidenceFailure(KIND, '$', 'does not match the live release, staging, and launch authority')
  }
  const proofSource = canonicalJson(proof)
  const proofSha256 = sha256(proofSource)
  const sumsBytes = await readOwnerOnlyBoundedFile(join(root, CHECKSUMS_PATH), 256, KIND, CHECKSUMS_PATH)
  if (sumsBytes.toString('utf8') !== `${proofSha256}  ${PREFLIGHT_PATH}\n`) {
    evidenceFailure(KIND, CHECKSUMS_PATH)
  }
  return Object.freeze({
    objectPath: PREFLIGHT_PATH,
    sha256: proofSha256,
    observedAt,
    verifierDidNotSendTurn: true,
  })
}

async function validatePreflightLive(
  rootInput: string,
  authority: H1ConnectionAuthority,
  instance: H1ConnectionInstance,
  dependencies: H1ConnectionProbeDependencies,
): Promise<{
  readonly result: H1PreflightEvidenceResult
  readonly collected: Awaited<ReturnType<typeof collectPreflightBinding>>
  readonly root: string
}> {
  const collected = await collectPreflightBinding(authority, instance, dependencies)
  const root = await requireOwnerOnlyDirectory(rootInput, KIND, 'preflight root')
  const result = await validatePreflightDirectory(root, collected.binding, collected.observedAtMs)
  return Object.freeze({ result, collected, root })
}

export async function validateOpenDesignM1H1PreflightEvidence(
  rootInput: string,
  authority: H1ConnectionAuthority,
  instance: H1ConnectionInstance,
  dependencies: H1ConnectionProbeDependencies = DEFAULT_DEPENDENCIES,
): Promise<H1PreflightEvidenceResult> {
  return (await validatePreflightLive(rootInput, authority, instance, dependencies)).result
}

export async function createOpenDesignM1H1PreflightEvidence(
  rootInput: string,
  authority: H1ConnectionAuthority,
  instance: H1ConnectionInstance,
  dependencies: H1ConnectionProbeDependencies = DEFAULT_DEPENDENCIES,
): Promise<H1PreflightEvidenceResult> {
  const collected = await collectPreflightBinding(authority, instance, dependencies)
  const observedAt = collected.observedAt
  const proofSource = canonicalJson(expectedPreflight(collected.binding, observedAt))
  const proofSha256 = sha256(proofSource)
  return publishOwnerOnlyDirectory(rootInput, KIND, async (temporaryRoot) => {
    await writeOwnerOnlyNewFile(join(temporaryRoot, PREFLIGHT_PATH), proofSource)
    await writeOwnerOnlyNewFile(join(temporaryRoot, CHECKSUMS_PATH), `${proofSha256}  ${PREFLIGHT_PATH}\n`)
    return validatePreflightDirectory(temporaryRoot, collected.binding, collected.observedAtMs)
  })
}

function expectedConnection(
  preflightRoot: string,
  preflight: H1PreflightEvidenceResult,
  observedAt: string,
): JsonObject {
  return {
    schemaVersion: 2,
    kind: CONNECTION_KIND,
    preflight: {
      rootRealpath: preflightRoot,
      objectPath: preflight.objectPath,
      sha256: preflight.sha256,
    },
    observation: {
      observedAt,
      authenticatedConnectionsPresent: true,
      verifierDidNotSendTurn: true,
    },
  }
}

async function validateConnectionDirectory(
  rootInput: string,
  preflightRoot: string,
  preflight: H1PreflightEvidenceResult,
  now: number,
): Promise<H1ConnectionEvidenceResult> {
  const root = await inventoryOwnerOnlyFiles(rootInput, [CHECKSUMS_PATH, CONNECTION_PATH], KIND)
  const proofPath = join(root, CONNECTION_PATH)
  const proof = objectAt(
    await readOwnerOnlyCanonicalJson(proofPath, MAX_PROOF_BYTES, KIND, CONNECTION_PATH),
    '$', KIND,
  )
  exactKeys(proof, ['kind', 'observation', 'preflight', 'schemaVersion'], '$', KIND)
  if (proof.schemaVersion !== 2 || proof.kind !== CONNECTION_KIND) evidenceFailure(KIND, '$')
  const observation = objectAt(proof.observation, '$.observation', KIND)
  exactKeys(observation, [
    'authenticatedConnectionsPresent', 'observedAt', 'verifierDidNotSendTurn',
  ], '$.observation', KIND)
  const observedAt = stringAt(observation, 'observedAt', '$.observation', KIND)
  const observedAtMs = canonicalTimestamp(observedAt, '$.observation.observedAt', KIND)
  if (observedAtMs < canonicalTimestamp(preflight.observedAt, '$.preflight.observedAt', KIND)
    || observedAtMs > now || observation.authenticatedConnectionsPresent !== true
    || observation.verifierDidNotSendTurn !== true
    || canonicalJson(proof) !== canonicalJson(expectedConnection(preflightRoot, preflight, observedAt))) {
    evidenceFailure(KIND, '$', 'does not match the validated preflight and authenticated observation')
  }
  const proofSource = canonicalJson(proof)
  const proofSha256 = sha256(proofSource)
  const sumsBytes = await readOwnerOnlyBoundedFile(join(root, CHECKSUMS_PATH), 256, KIND, CHECKSUMS_PATH)
  if (sumsBytes.toString('utf8') !== `${proofSha256}  ${CONNECTION_PATH}\n`) {
    evidenceFailure(KIND, CHECKSUMS_PATH)
  }
  return Object.freeze({
    objectPath: CONNECTION_PATH,
    sha256: proofSha256,
    observedAt,
    authenticatedConnectionsPresent: true,
    verifierDidNotSendTurn: true,
  })
}

export async function validateOpenDesignM1H1ConnectionEvidence(
  rootInput: string,
  preflightRootInput: string,
  authority: H1ConnectionAuthority,
  instance: H1ConnectionInstance,
  dependencies: H1ConnectionProbeDependencies = DEFAULT_DEPENDENCIES,
): Promise<H1ConnectionEvidenceResult> {
  const validated = await validatePreflightLive(preflightRootInput, authority, instance, dependencies)
  if (await dependencies.readAuthenticatedConnectionsPresent(validated.collected.target) !== true) {
    evidenceFailure(KIND, 'authenticatedConnectionsPresent', 'was not observed during validation')
  }
  return validateConnectionDirectory(
    rootInput, validated.root, validated.result, dependencies.now(),
  )
}

export async function createOpenDesignM1H1ConnectionEvidence(
  rootInput: string,
  preflightRootInput: string,
  authority: H1ConnectionAuthority,
  instance: H1ConnectionInstance,
  dependencies: H1ConnectionProbeDependencies = DEFAULT_DEPENDENCIES,
): Promise<H1ConnectionEvidenceResult> {
  const validated = await validatePreflightLive(preflightRootInput, authority, instance, dependencies)
  const authenticatedConnectionsPresent = await dependencies.readAuthenticatedConnectionsPresent(validated.collected.target)
  if (authenticatedConnectionsPresent !== true) {
    evidenceFailure(KIND, 'authenticatedConnectionsPresent', 'was not observed')
  }
  const observedAt = new Date(dependencies.now()).toISOString()
  canonicalTimestamp(observedAt, '$.observation.observedAt', KIND)
  const proofSource = canonicalJson(expectedConnection(validated.root, validated.result, observedAt))
  const proofSha256 = sha256(proofSource)
  return publishOwnerOnlyDirectory(rootInput, KIND, async (temporaryRoot) => {
    await writeOwnerOnlyNewFile(join(temporaryRoot, CONNECTION_PATH), proofSource)
    await writeOwnerOnlyNewFile(join(temporaryRoot, CHECKSUMS_PATH), `${proofSha256}  ${CONNECTION_PATH}\n`)
    return validateConnectionDirectory(
      temporaryRoot, validated.root, validated.result, dependencies.now(),
    )
  })
}

function parseArgs(args: readonly string[]): Map<string, string> {
  const result = new Map<string, string>()
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]
    const value = args[index + 1]
    if (!key?.startsWith('--') || value === undefined || value.startsWith('--') || result.has(key)) {
      evidenceFailure(KIND, 'arguments')
    }
    result.set(key, value)
  }
  return result
}

function requiredArg(args: Map<string, string>, key: string): string {
  const value = args.get(key)
  if (!value) evidenceFailure(KIND, `arguments.${key}`)
  return value
}

function positiveIntegerArg(args: Map<string, string>, key: string): number {
  const value = requiredArg(args, key)
  if (!/^[1-9][0-9]*$/.test(value)) evidenceFailure(KIND, `arguments.${key}`)
  const result = Number(value)
  if (!Number.isSafeInteger(result)) evidenceFailure(KIND, `arguments.${key}`)
  return result
}

function exactArgumentKeys(args: Map<string, string>, expected: readonly string[]): void {
  if ([...args.keys()].sort().join('\n') !== [...expected].sort().join('\n')) {
    evidenceFailure(KIND, 'arguments')
  }
}

function instanceFromArgs(args: Map<string, string>): H1ConnectionInstance {
  return {
    appBundleRealpath: requiredArg(args, '--app-bundle'),
    executableRealpath: requiredArg(args, '--executable'),
    mainPid: positiveIntegerArg(args, '--main-pid'),
    profileRealpath: requiredArg(args, '--profile'),
    configRealpath: requiredArg(args, '--config'),
    cdpPort: positiveIntegerArg(args, '--cdp-port'),
    launchEvidenceRealpath: requiredArg(args, '--launch-evidence'),
  }
}

function authorityFromArgs(args: Map<string, string>): H1ConnectionAuthority {
  return {
    sourceSha: requiredArg(args, '--source-sha'),
    hostBuildRunId: positiveIntegerArg(args, '--host-build-run-id'),
    hostArtifactId: positiveIntegerArg(args, '--host-artifact-id'),
    hostArtifactDigest: requiredArg(args, '--host-artifact-digest'),
    rcLabel: requiredArg(args, '--rc-label'),
    productVersion: requiredArg(args, '--product-version'),
    artifactArchiveRealpath: requiredArg(args, '--artifact-archive'),
    bundleRootRealpath: requiredArg(args, '--bundle-root'),
  }
}

const INSTANCE_KEYS = Object.freeze([
  '--app-bundle', '--cdp-port', '--config', '--executable', '--launch-evidence', '--main-pid', '--profile',
])
const AUTHORITY_KEYS = Object.freeze([
  '--artifact-archive', '--bundle-root', '--host-artifact-digest', '--host-artifact-id',
  '--host-build-run-id', '--product-version', '--rc-label', '--source-sha',
])

async function main(): Promise<void> {
  const [command, ...rest] = Bun.argv.slice(2)
  const args = parseArgs(rest)
  if (command === 'capture-launch') {
    const expectedKeys = [
      '--app-bundle', '--cdp-port', '--config', '--executable', '--main-pid', '--output-file', '--profile',
    ]
    exactArgumentKeys(args, expectedKeys)
    const result = await captureOpenDesignM1H1LaunchEvidence(requiredArg(args, '--output-file'), {
      appBundleRealpath: requiredArg(args, '--app-bundle'),
      executableRealpath: requiredArg(args, '--executable'),
      mainPid: positiveIntegerArg(args, '--main-pid'),
      profileRealpath: requiredArg(args, '--profile'),
      configRealpath: requiredArg(args, '--config'),
      cdpPort: positiveIntegerArg(args, '--cdp-port'),
    }, DEFAULT_DEPENDENCIES)
    process.stdout.write(canonicalJson(result))
    return
  }
  if (!['preflight', 'validate-preflight', 'produce', 'validate'].includes(command ?? '')) {
    evidenceFailure(KIND, 'arguments.command')
  }
  const needsPreflight = command === 'produce' || command === 'validate'
  exactArgumentKeys(args, [
    ...INSTANCE_KEYS,
    ...AUTHORITY_KEYS,
    '--output-root',
    ...(needsPreflight ? ['--preflight-root'] : []),
  ])
  const authority = authorityFromArgs(args)
  const instance = instanceFromArgs(args)
  let result: H1PreflightEvidenceResult | H1ConnectionEvidenceResult
  if (command === 'preflight') {
    result = await createOpenDesignM1H1PreflightEvidence(
      requiredArg(args, '--output-root'), authority, instance,
    )
  } else if (command === 'validate-preflight') {
    result = await validateOpenDesignM1H1PreflightEvidence(
      requiredArg(args, '--output-root'), authority, instance,
    )
  } else if (command === 'produce') {
    result = await createOpenDesignM1H1ConnectionEvidence(
      requiredArg(args, '--output-root'), requiredArg(args, '--preflight-root'), authority, instance,
    )
  } else {
    result = await validateOpenDesignM1H1ConnectionEvidence(
      requiredArg(args, '--output-root'), requiredArg(args, '--preflight-root'), authority, instance,
    )
  }
  process.stdout.write(canonicalJson(result))
}

if (import.meta.main) await main()
