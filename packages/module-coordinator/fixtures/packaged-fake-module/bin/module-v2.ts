import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'

const host = process.env.SIMULATOR_MODULE_HEALTH_HOST
const port = Number(process.env.SIMULATOR_MODULE_HEALTH_PORT)
const mode = process.env.SIMULATOR_PACKAGED_FAKE_MODE ?? 'healthy'
const startupDelayMs = Number(process.env.SIMULATOR_PACKAGED_FAKE_STARTUP_DELAY_MS ?? '0')
const contractVersion = process.env.SIMULATOR_HOST_AGENT_CONTRACT_VERSION
const hostAgentUrl = process.env.SIMULATOR_HOST_AGENT_URL
const hostAgentTokenFile = process.env.SIMULATOR_HOST_AGENT_TOKEN_FILE
const hostAgentShimPath = process.env.SIMULATOR_HOST_AGENT_SHIM_PATH
const moduleDataRoot = process.env.SIMULATOR_MODULE_DATA_ROOT
const MAX_TRANSCRIPT_BYTES = 10 * 1024 * 1024
const SHIM_TIMEOUT_MS = 20_000
const HOST_AGENT_EVENT_TYPES = new Set([
  'run.accepted',
  'turn.started',
  'message.delta',
  'reasoning.delta',
  'activity',
  'presentation.item',
  'turn.completed',
  'turn.failed',
  'turn.interrupted',
  'run.closed',
])

if (host !== '127.0.0.1' || !Number.isSafeInteger(port) || port < 1 || port > 65_535
  || !Number.isSafeInteger(startupDelayMs) || startupDelayMs < 0 || startupDelayMs > 10_000
  || contractVersion !== '2') process.exit(64)

if (startupDelayMs > 0) await Bun.sleep(startupDelayMs)

const moduleRoot = join(dirname(process.execPath), '..')

interface HostAgentJsonEvent {
  contractVersion: number
  eventId: string
  sequence: number
  runHandle: string
  type: string
  occurredAt: number
  data: Record<string, unknown>
}

interface ShimInvocationEvidence {
  pid: number
  argv: readonly []
  promptBytes: number
  promptSha256: string
  stdinOnly: true
  eofClosed: true
  runHandle: string
  eventTypes: string[]
  eventCount: number
  terminalType: 'turn.completed'
  finalText: string
  exitCode: 0
  stderrBytes: 0
  processReaped: true
}

function requiredEnvironment(value: string | undefined, name: string): string {
  if (!value || value.includes('\0')) throw new Error(`${name} is missing`)
  return value
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex')
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

async function validateLaunchEnvironment(): Promise<{
  dataRoot: string
  projectRoot: string
  shim: { path: string; sha256: string; mode: number; size: number; nlink: 1 }
}> {
  const rawUrl = requiredEnvironment(hostAgentUrl, 'SIMULATOR_HOST_AGENT_URL')
  const url = new URL(rawUrl)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('SIMULATOR_HOST_AGENT_URL is invalid')
  }

  const tokenPath = requiredEnvironment(hostAgentTokenFile, 'SIMULATOR_HOST_AGENT_TOKEN_FILE')
  if (!isAbsolute(tokenPath) || resolve(tokenPath) !== tokenPath) {
    throw new Error('SIMULATOR_HOST_AGENT_TOKEN_FILE is invalid')
  }
  const tokenMetadata = await lstat(tokenPath)
  if (!tokenMetadata.isFile() || tokenMetadata.isSymbolicLink() || tokenMetadata.nlink !== 1
    || (process.platform !== 'win32' && (tokenMetadata.mode & 0o777) !== 0o600)
    || (typeof process.getuid === 'function' && tokenMetadata.uid !== process.getuid())) {
    throw new Error('SIMULATOR_HOST_AGENT_TOKEN_FILE is not an owner-only regular file')
  }

  const configuredShim = requiredEnvironment(hostAgentShimPath, 'SIMULATOR_HOST_AGENT_SHIM_PATH')
  if (!isAbsolute(configuredShim) || resolve(configuredShim) !== configuredShim) {
    throw new Error('SIMULATOR_HOST_AGENT_SHIM_PATH is invalid')
  }
  const canonicalShim = await realpath(configuredShim)
  if (canonicalShim !== configuredShim) throw new Error('SIMULATOR_HOST_AGENT_SHIM_PATH is not canonical')
  const shimMetadata = await lstat(canonicalShim)
  const trustedShimOwner = typeof process.getuid !== 'function'
    || shimMetadata.uid === process.getuid()
    || shimMetadata.uid === 0
  if (!shimMetadata.isFile() || shimMetadata.isSymbolicLink() || shimMetadata.nlink !== 1
    || !trustedShimOwner || (process.platform !== 'win32' && (shimMetadata.mode & 0o100) === 0)) {
    throw new Error('SIMULATOR_HOST_AGENT_SHIM_PATH is not a trusted executable')
  }

  const configuredDataRoot = requiredEnvironment(moduleDataRoot, 'SIMULATOR_MODULE_DATA_ROOT')
  if (!isAbsolute(configuredDataRoot) || resolve(configuredDataRoot) !== configuredDataRoot) {
    throw new Error('SIMULATOR_MODULE_DATA_ROOT is invalid')
  }
  await mkdir(configuredDataRoot, { recursive: true, mode: 0o700 })
  await chmod(configuredDataRoot, 0o700)
  const canonicalDataRoot = await realpath(configuredDataRoot)
  if (canonicalDataRoot !== configuredDataRoot) throw new Error('SIMULATOR_MODULE_DATA_ROOT is not canonical')
  const dataMetadata = await lstat(canonicalDataRoot)
  if (!dataMetadata.isDirectory() || dataMetadata.isSymbolicLink()
    || (typeof process.getuid === 'function' && dataMetadata.uid !== process.getuid())
    || (process.platform !== 'win32' && (dataMetadata.mode & 0o077) !== 0)) {
    throw new Error('SIMULATOR_MODULE_DATA_ROOT is not owner-only')
  }
  const projectRoot = join(canonicalDataRoot, 'smoke-project')
  await mkdir(projectRoot, { recursive: true, mode: 0o700 })
  await chmod(projectRoot, 0o700)

  const shimBytes = await readFile(canonicalShim)
  return {
    dataRoot: canonicalDataRoot,
    projectRoot,
    shim: {
      path: canonicalShim,
      sha256: sha256(shimBytes),
      mode: shimMetadata.mode & 0o777,
      size: shimMetadata.size,
      nlink: 1,
    },
  }
}

function parseTranscript(stdout: string): {
  runHandle: string
  eventTypes: string[]
  terminalType: 'turn.completed'
  finalText: string
} {
  if (!stdout.endsWith('\n') || stdout.includes('\r') || Buffer.byteLength(stdout, 'utf8') > MAX_TRANSCRIPT_BYTES) {
    throw new Error('Shim stdout is not bounded canonical JSONL')
  }
  const lines = stdout.slice(0, -1).split('\n')
  if (lines.length < 4 || lines.some((line) => line.length === 0)) {
    throw new Error('Shim stdout does not contain a complete JSONL transcript')
  }
  const events = lines.map((line, index): HostAgentJsonEvent => {
    let value: unknown
    try { value = JSON.parse(line) } catch { throw new Error('Shim stdout contains non-JSON output') }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Shim JSONL event is invalid')
    const event = value as HostAgentJsonEvent
    const keys = Reflect.ownKeys(event)
    const expectedKeys = ['contractVersion', 'eventId', 'sequence', 'runHandle', 'occurredAt', 'type', 'data']
    if (event.contractVersion !== 2 || event.sequence !== index + 1 || event.eventId !== String(index + 1)
      || !/^run_[a-f0-9]{32}$/.test(event.runHandle)
      || typeof event.type !== 'string' || !HOST_AGENT_EVENT_TYPES.has(event.type)
      || keys.length !== expectedKeys.length
      || keys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))
      || !Number.isSafeInteger(event.occurredAt)
      || !event.data || typeof event.data !== 'object' || Array.isArray(event.data)) {
      throw new Error('Shim JSONL event violates the v2 envelope')
    }
    return event
  })
  const runHandle = events[0]!.runHandle
  if (events.some((event) => event.runHandle !== runHandle)) throw new Error('Shim JSONL changed runHandle')
  if (events[0]!.type !== 'run.accepted' || events[1]!.type !== 'turn.started') {
    throw new Error('Shim JSONL omitted the accepted/started prefix')
  }
  const terminals = events.filter((event) => (
    event.type === 'turn.completed' || event.type === 'turn.failed' || event.type === 'turn.interrupted'
  ))
  if (terminals.length !== 1 || terminals[0]!.type !== 'turn.completed'
    || events.at(-2) !== terminals[0] || events.at(-1)!.type !== 'run.closed') {
    throw new Error('Shim JSONL must contain one completed terminal followed by run.closed')
  }
  if (events.filter((event) => event.type === 'run.closed').length !== 1) {
    throw new Error('Shim JSONL contains duplicate run.closed events')
  }
  const text = terminals[0]!.data.finalText
  return {
    runHandle,
    eventTypes: events.map((event) => event.type),
    terminalType: 'turn.completed',
    finalText: typeof text === 'string' ? text : '',
  }
}

async function runShim(
  shimPath: string,
  projectRoot: string,
  prompt: string,
): Promise<ShimInvocationEvidence> {
  // This exact one-element command is the ordinary Runtime contract: the
  // executable receives no resume/model/provider/MCP arguments. Prompt bytes
  // are written only to stdin and EOF is closed before output is accepted.
  const child = Bun.spawn([shimPath], {
    cwd: projectRoot,
    env: process.env,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const pid = child.pid
  const timer = setTimeout(() => child.kill('SIGTERM'), SHIM_TIMEOUT_MS)
  timer.unref()
  child.stdin.write(prompt)
  child.stdin.end()
  try {
    const [exitCode, stdoutBytes, stderrBytes] = await Promise.all([
      child.exited,
      new Response(child.stdout).arrayBuffer(),
      new Response(child.stderr).arrayBuffer(),
    ])
    const stdout = Buffer.from(stdoutBytes)
    const stderr = Buffer.from(stderrBytes)
    if (stdout.byteLength > MAX_TRANSCRIPT_BYTES || stderr.byteLength > 0) {
      throw new Error('Shim output exceeded the closed stdout/stderr contract')
    }
    if (exitCode !== 0) throw new Error(`Shim exited with code ${exitCode}`)
    const transcript = parseTranscript(stdout.toString('utf8'))
    if (processExists(pid)) throw new Error('Shim process was not reaped after terminal close')
    return {
      pid,
      argv: [],
      promptBytes: Buffer.byteLength(prompt, 'utf8'),
      promptSha256: sha256(prompt),
      stdinOnly: true,
      eofClosed: true,
      runHandle: transcript.runHandle,
      eventTypes: transcript.eventTypes,
      eventCount: transcript.eventTypes.length,
      terminalType: transcript.terminalType,
      finalText: transcript.finalText,
      exitCode: 0,
      stderrBytes: 0,
      processReaped: true,
    }
  } finally {
    clearTimeout(timer)
  }
}

async function runHostAgentSmoke(): Promise<Record<string, unknown>> {
  const launch = await validateLaunchEnvironment()
  const prompts = [
    'OpenDesign packaged Shim one-Turn Session one',
    'OpenDesign packaged Shim one-Turn Session two',
  ]
  const invocations: ShimInvocationEvidence[] = []
  for (const prompt of prompts) invocations.push(await runShim(launch.shim.path, launch.projectRoot, prompt))
  if (invocations[0]!.pid === invocations[1]!.pid
    || invocations[0]!.runHandle === invocations[1]!.runHandle) {
    throw new Error('Ordinary Runtime reused a Shim process or Run handle')
  }
  return {
    ok: true,
    protocolFixture: true,
    acceptanceScope: 'deterministic-packaged-protocol-fixture-not-real-rc-or-paid-preview-acceptance',
    capability: 'host-agent.use',
    contractVersion: 2,
    transport: 'ordinary-json-event-stream-cli-v2',
    oneTurnPerProcess: true,
    invocationCount: invocations.length,
    replies: invocations.map((invocation) => invocation.finalText),
    invocations,
    shim: launch.shim,
    tokenFile: hostAgentTokenFile,
  }
}

const hostAgentSmoke = runHostAgentSmoke().catch((error) => ({
  ok: false,
  protocolFixture: true,
  acceptanceScope: 'deterministic-packaged-protocol-fixture-not-real-rc-or-paid-preview-acceptance',
  error: error instanceof Error ? error.message : String(error),
  tokenFile: hostAgentTokenFile,
}))

const server = Bun.serve({
  hostname: host,
  port,
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === '/health') {
      if (mode === 'readiness-failure') return Response.json({ status: 'unhealthy' }, { status: 503 })
      return Response.json({ status: 'healthy' })
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(Bun.file(join(moduleRoot, 'frontend', 'index.html')), {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    }
    if (url.pathname === '/resource/data.txt') return new Response(Bun.file(join(moduleRoot, 'data.txt')))
    if (url.pathname === '/host-agent-smoke') return Response.json(await hostAgentSmoke)
    if (url.pathname === '/crash') {
      setTimeout(() => process.exit(23), 5)
      return new Response('crashing')
    }
    return new Response('not found', { status: 404 })
  },
})

function stop(): void {
  server.stop(true)
  process.exit(0)
}

process.on('SIGTERM', stop)
process.on('SIGINT', stop)
