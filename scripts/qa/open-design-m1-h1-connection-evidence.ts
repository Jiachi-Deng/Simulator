#!/usr/bin/env bun

import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { basename, dirname, join, resolve } from 'node:path'
import {
  COMMIT_SHA_PATTERN,
  SHA256_PATTERN,
  canonicalJson,
  canonicalTimestamp,
  commitAt,
  evidenceFailure,
  exactKeys,
  hashAt,
  integerAt,
  inventoryOwnerOnlyFiles,
  objectAt,
  positiveIntegerAt,
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
const PROOF_PATH = 'h1-connection.json' as const
const CHECKSUMS_PATH = 'SHA256SUMS' as const
const MAX_PROOF_BYTES = 16 * 1024
const MAX_CDP_RESPONSE_BYTES = 256 * 1024
const SAFE_TARGET_ID = /^[A-Za-z0-9._-]{1,128}$/
const execFile = promisify(execFileCallback)

export interface H1ConnectionAuthority {
  readonly sourceSha: string
  readonly hostBuildRunId: number
  readonly hostArtifactSha256: string
}

export interface H1ConnectionInstance {
  readonly appBundleRealpath: string
  readonly executableRealpath: string
  readonly mainPid: number
  readonly profileRealpath: string
  readonly cdpPort: number
}

interface ProcessObservation {
  readonly pid: number
  readonly uid: number
  readonly parentPid: number
  readonly executableRealpath: string
  readonly commandLine: string
  readonly loopbackListeningPorts: readonly number[]
}

interface CdpTarget {
  readonly id: string
  readonly type: string
  readonly url: string
  readonly webSocketDebuggerUrl: string
}

export interface H1ConnectionProbeDependencies {
  readonly inspectProcess: (pid: number) => Promise<ProcessObservation>
  readonly discoverTargets: (port: number) => Promise<readonly CdpTarget[]>
  readonly readAuthenticatedConnectionsPresent: (target: CdpTarget) => Promise<boolean>
}

export interface H1ConnectionEvidenceResult {
  readonly objectPath: typeof PROOF_PATH
  readonly sha256: string
  readonly observedAt: string
  readonly authenticatedConnectionsPresent: true
  readonly verifierDidNotSendTurn: true
}

function validateAuthority(authority: H1ConnectionAuthority): void {
  if (!COMMIT_SHA_PATTERN.test(authority.sourceSha)
    || !SHA256_PATTERN.test(authority.hostArtifactSha256)
    || !Number.isSafeInteger(authority.hostBuildRunId) || authority.hostBuildRunId < 1) {
    evidenceFailure(KIND, 'authority')
  }
}

function validatePort(port: number): void {
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
    evidenceFailure(KIND, 'instance.cdpPort')
  }
}

async function canonicalInstance(instance: H1ConnectionInstance): Promise<H1ConnectionInstance> {
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
  return Object.freeze({
    appBundleRealpath,
    executableRealpath,
    mainPid: instance.mainPid,
    profileRealpath,
    cdpPort: instance.cdpPort,
  })
}

async function commandText(file: string, args: readonly string[]): Promise<string> {
  try {
    const result = await execFile(file, [...args], {
      encoding: 'utf8',
      maxBuffer: 128 * 1024,
      timeout: 5_000,
    })
    if (result.stderr.trim()) evidenceFailure(KIND, 'process inspection', 'failed')
    return result.stdout.trim()
  } catch {
    return evidenceFailure(KIND, 'process inspection', 'failed')
  }
}

async function inspectDarwinProcess(pid: number): Promise<ProcessObservation> {
  if (process.platform !== 'darwin') evidenceFailure(KIND, 'process inspection', 'requires macOS')
  const [uidSource, parentSource, executableSource, commandLine, textMappings, listeners] = await Promise.all([
    commandText('/bin/ps', ['-p', String(pid), '-o', 'uid=']),
    commandText('/bin/ps', ['-p', String(pid), '-o', 'ppid=']),
    commandText('/bin/ps', ['-ww', '-p', String(pid), '-o', 'comm=']),
    commandText('/bin/ps', ['-ww', '-p', String(pid), '-o', 'command=']),
    commandText('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'txt', '-Fn']),
    commandText('/usr/sbin/lsof', ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-Fn']),
  ])
  const uid = Number(uidSource)
  const parentPid = Number(parentSource)
  if (!Number.isSafeInteger(uid) || uid < 0 || !Number.isSafeInteger(parentPid) || parentPid < 0) {
    evidenceFailure(KIND, 'process inspection', 'returned an invalid identity')
  }
  const executableRealpath = resolve(executableSource)
  const mappedExecutable = textMappings.split('\n').some((line) => line === `n${executableRealpath}`)
  if (!mappedExecutable) evidenceFailure(KIND, 'process inspection', 'does not identify the executable mapping')
  const ports = listeners.split('\n').flatMap((line) => {
    const match = /^n127\.0\.0\.1:([0-9]+)(?: \(LISTEN\))?$/.exec(line)
    return match ? [Number(match[1])] : []
  })
  return {
    pid,
    uid,
    parentPid,
    executableRealpath,
    commandLine,
    loopbackListeningPorts: Object.freeze(ports),
  }
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
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) {
    evidenceFailure(KIND, 'CDP targets')
  }
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
    return { id, type, url, webSocketDebuggerUrl }
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
      try {
        message = JSON.parse(String(event.data))
      } catch {
        return
      }
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

const DEFAULT_DEPENDENCIES: H1ConnectionProbeDependencies = Object.freeze({
  inspectProcess: inspectDarwinProcess,
  discoverTargets: discoverCdpTargets,
  readAuthenticatedConnectionsPresent,
})

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function hasOneExactProcessArgument(commandLine: string, argument: string): boolean {
  const matches = commandLine.match(new RegExp(`(?:^|\\s)${escapeRegExp(argument)}(?=\\s|$)`, 'g'))
  return matches?.length === 1
}

function validatedCraftTarget(
  candidates: readonly CdpTarget[],
  instance: H1ConnectionInstance,
): CdpTarget {
  const resourcesRoot = join(instance.appBundleRealpath, 'Contents', 'Resources') + '/'
  const matches = candidates.filter((target) => {
    if (target.type !== 'page' || !SAFE_TARGET_ID.test(target.id)) return false
    let rendererUrl: URL
    let socketUrl: URL
    try {
      rendererUrl = new URL(target.url)
      socketUrl = new URL(target.webSocketDebuggerUrl)
    } catch {
      return false
    }
    if (rendererUrl.protocol !== 'file:' || rendererUrl.username || rendererUrl.password
      || rendererUrl.search || rendererUrl.hash) return false
    let rendererPath: string
    try { rendererPath = fileURLToPath(rendererUrl) } catch { return false }
    if (!rendererPath.startsWith(resourcesRoot) || !rendererPath.endsWith('/dist/renderer/index.html')) return false
    return socketUrl.protocol === 'ws:' && socketUrl.hostname === '127.0.0.1'
      && socketUrl.port === String(instance.cdpPort) && !socketUrl.username && !socketUrl.password
      && socketUrl.pathname === `/devtools/page/${target.id}` && !socketUrl.search && !socketUrl.hash
  })
  if (matches.length !== 1) evidenceFailure(KIND, 'dedicated Craft CDP target', 'was not uniquely identified')
  return matches[0]!
}

async function proveDedicatedInstance(
  instance: H1ConnectionInstance,
  dependencies: H1ConnectionProbeDependencies,
): Promise<void> {
  const observation = await dependencies.inspectProcess(instance.mainPid)
  const uid = typeof process.getuid === 'function' ? process.getuid() : observation.uid
  if (observation.pid !== instance.mainPid || observation.uid !== uid || observation.parentPid < 0
    || observation.executableRealpath !== instance.executableRealpath
    || !observation.loopbackListeningPorts.includes(instance.cdpPort)
    || !hasOneExactProcessArgument(observation.commandLine, `--remote-debugging-port=${instance.cdpPort}`)
    || !hasOneExactProcessArgument(observation.commandLine, `--user-data-dir=${instance.profileRealpath}`)) {
    evidenceFailure(KIND, 'dedicated process identity', 'does not match the expected app, PID, profile, and CDP port')
  }
  const target = validatedCraftTarget(await dependencies.discoverTargets(instance.cdpPort), instance)
  const authenticatedConnectionsPresent = await dependencies.readAuthenticatedConnectionsPresent(target)
  if (authenticatedConnectionsPresent !== true) {
    evidenceFailure(KIND, 'authenticatedConnectionsPresent', 'was not observed')
  }
}

function expectedProof(
  authority: H1ConnectionAuthority,
  instance: H1ConnectionInstance,
  observedAt: string,
): JsonObject {
  return {
    schemaVersion: 1,
    kind: 'open-design-m1-h1-connection-evidence',
    authority: {
      sourceSha: authority.sourceSha,
      hostBuildRunId: authority.hostBuildRunId,
      hostArtifactSha256: authority.hostArtifactSha256,
    },
    instance: {
      appBundleRealpath: instance.appBundleRealpath,
      executableRealpath: instance.executableRealpath,
      mainPid: instance.mainPid,
      profileRealpath: instance.profileRealpath,
      cdpPort: instance.cdpPort,
    },
    observation: {
      observedAt,
      authenticatedConnectionsPresent: true,
      verifierDidNotSendTurn: true,
    },
  }
}

export async function validateOpenDesignM1H1ConnectionEvidence(
  rootInput: string,
  authority: H1ConnectionAuthority,
  instanceInput: H1ConnectionInstance,
): Promise<H1ConnectionEvidenceResult> {
  validateAuthority(authority)
  const instance = await canonicalInstance(instanceInput)
  const root = await inventoryOwnerOnlyFiles(rootInput, [CHECKSUMS_PATH, PROOF_PATH], KIND)
  const proofPath = join(root, PROOF_PATH)
  const proof = objectAt(await readOwnerOnlyCanonicalJson(proofPath, MAX_PROOF_BYTES, KIND, PROOF_PATH), '$', KIND)
  exactKeys(proof, ['authority', 'instance', 'kind', 'observation', 'schemaVersion'], '$', KIND)
  if (proof.schemaVersion !== 1 || proof.kind !== 'open-design-m1-h1-connection-evidence') {
    evidenceFailure(KIND, '$')
  }
  const proofAuthority = objectAt(proof.authority, '$.authority', KIND)
  exactKeys(proofAuthority, ['hostArtifactSha256', 'hostBuildRunId', 'sourceSha'], '$.authority', KIND)
  const parsedAuthority: H1ConnectionAuthority = {
    sourceSha: commitAt(proofAuthority, 'sourceSha', '$.authority', KIND),
    hostBuildRunId: positiveIntegerAt(proofAuthority, 'hostBuildRunId', '$.authority', KIND),
    hostArtifactSha256: hashAt(proofAuthority, 'hostArtifactSha256', '$.authority', KIND),
  }
  const proofInstance = objectAt(proof.instance, '$.instance', KIND)
  exactKeys(proofInstance, [
    'appBundleRealpath', 'cdpPort', 'executableRealpath', 'mainPid', 'profileRealpath',
  ], '$.instance', KIND)
  const parsedInstance: H1ConnectionInstance = {
    appBundleRealpath: stringAt(proofInstance, 'appBundleRealpath', '$.instance', KIND),
    executableRealpath: stringAt(proofInstance, 'executableRealpath', '$.instance', KIND),
    mainPid: integerAt(proofInstance, 'mainPid', '$.instance', KIND),
    profileRealpath: stringAt(proofInstance, 'profileRealpath', '$.instance', KIND),
    cdpPort: integerAt(proofInstance, 'cdpPort', '$.instance', KIND),
  }
  const observation = objectAt(proof.observation, '$.observation', KIND)
  exactKeys(observation, [
    'authenticatedConnectionsPresent', 'observedAt', 'verifierDidNotSendTurn',
  ], '$.observation', KIND)
  const observedAt = stringAt(observation, 'observedAt', '$.observation', KIND)
  if (canonicalTimestamp(observedAt, '$.observation.observedAt', KIND) > Date.now() + 60_000) {
    evidenceFailure(KIND, '$.observation.observedAt', 'must not be in the future')
  }
  if (observation.authenticatedConnectionsPresent !== true || observation.verifierDidNotSendTurn !== true) {
    evidenceFailure(KIND, '$.observation')
  }
  const expected = expectedProof(authority, instance, observedAt)
  if (canonicalJson(proof) !== canonicalJson(expected)
    || canonicalJson(parsedAuthority) !== canonicalJson(authority)
    || canonicalJson(parsedInstance) !== canonicalJson(instance)) {
    evidenceFailure(KIND, '$', 'does not match the expected authority and dedicated instance')
  }
  const proofSource = canonicalJson(proof)
  const proofSha256 = sha256(proofSource)
  const sumsBytes = await readOwnerOnlyBoundedFile(
    join(root, CHECKSUMS_PATH),
    256,
    KIND,
    CHECKSUMS_PATH,
  )
  if (sumsBytes.toString('utf8') !== `${proofSha256}  ${PROOF_PATH}\n`) {
    evidenceFailure(KIND, CHECKSUMS_PATH)
  }
  return {
    objectPath: PROOF_PATH,
    sha256: proofSha256,
    observedAt,
    authenticatedConnectionsPresent: true,
    verifierDidNotSendTurn: true,
  }
}

export async function createOpenDesignM1H1ConnectionEvidence(
  rootInput: string,
  authority: H1ConnectionAuthority,
  instanceInput: H1ConnectionInstance,
  dependencies: H1ConnectionProbeDependencies = DEFAULT_DEPENDENCIES,
): Promise<H1ConnectionEvidenceResult> {
  validateAuthority(authority)
  const instance = await canonicalInstance(instanceInput)
  await proveDedicatedInstance(instance, dependencies)
  const observedAt = new Date().toISOString()
  const proofSource = canonicalJson(expectedProof(authority, instance, observedAt))
  const proofSha256 = sha256(proofSource)
  return publishOwnerOnlyDirectory(rootInput, KIND, async (temporaryRoot) => {
    await writeOwnerOnlyNewFile(join(temporaryRoot, PROOF_PATH), proofSource)
    await writeOwnerOnlyNewFile(join(temporaryRoot, CHECKSUMS_PATH), `${proofSha256}  ${PROOF_PATH}\n`)
    return validateOpenDesignM1H1ConnectionEvidence(temporaryRoot, authority, instance)
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

async function main(): Promise<void> {
  const [command, ...rest] = Bun.argv.slice(2)
  if (command !== 'produce' && command !== 'validate') evidenceFailure(KIND, 'arguments.command')
  const args = parseArgs(rest)
  const expectedKeys = [
    '--app-bundle', '--cdp-port', '--executable', '--host-artifact-sha256', '--host-build-run-id',
    '--main-pid', '--output-root', '--profile', '--source-sha',
  ].sort()
  if ([...args.keys()].sort().join('\n') !== expectedKeys.join('\n')) evidenceFailure(KIND, 'arguments')
  const authority: H1ConnectionAuthority = {
    sourceSha: requiredArg(args, '--source-sha'),
    hostBuildRunId: positiveIntegerArg(args, '--host-build-run-id'),
    hostArtifactSha256: requiredArg(args, '--host-artifact-sha256'),
  }
  const instance: H1ConnectionInstance = {
    appBundleRealpath: requiredArg(args, '--app-bundle'),
    executableRealpath: requiredArg(args, '--executable'),
    mainPid: positiveIntegerArg(args, '--main-pid'),
    profileRealpath: requiredArg(args, '--profile'),
    cdpPort: positiveIntegerArg(args, '--cdp-port'),
  }
  const result = command === 'produce'
    ? await createOpenDesignM1H1ConnectionEvidence(requiredArg(args, '--output-root'), authority, instance)
    : await validateOpenDesignM1H1ConnectionEvidence(requiredArg(args, '--output-root'), authority, instance)
  process.stdout.write(canonicalJson(result))
}

if (import.meta.main) await main()
