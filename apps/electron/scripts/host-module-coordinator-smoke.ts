import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { publicWrapperFailure } from './host-module-smoke-public-failure'

type SmokeScenario = 'v1-compat' | 'v2-open-design-rc'

interface SmokeScenarioConfig {
  readonly scenario: SmokeScenario
  readonly moduleId: 'org.simulator.open-design'
  readonly version: '0.14.5' | '0.14.6-rc.1'
  readonly contractVersion: 1 | 2
  readonly fixtureEntry: 'module.ts' | 'module-v2.ts'
}

const INNER_WATCHDOG_TIMEOUT_MS = 40_000
const OUTER_CLEANUP_BUDGET_MS = 10_000
const OUTER_WATCHDOG_MARGIN_MS = 5_000
const OUTER_WATCHDOG_TIMEOUT_MS = INNER_WATCHDOG_TIMEOUT_MS
  + OUTER_CLEANUP_BUDGET_MS
  + OUTER_WATCHDOG_MARGIN_MS
const GRACEFUL_PROCESS_EXIT_MS = 3_000
const FORCED_PROCESS_EXIT_MS = 2_000

function closedFailure(
  code: string,
  details: Readonly<Record<string, number | undefined>> = {},
): Error {
  const suffix = Object.entries(details)
    .filter((entry): entry is [string, number] => Number.isFinite(entry[1]))
    .map(([key, value]) => `${key}=${value}`)
    .join(' ')
  return new Error(suffix ? `${code} ${suffix}` : code)
}

let reportingFatalFailure = false
function reportFatalFailure(error: unknown): never {
  if (!reportingFatalFailure) {
    reportingFatalFailure = true
    process.stderr.write(`[simulator-module-smoke] ${publicWrapperFailure(error)}\n`)
  }
  process.exit(1)
}

process.on('uncaughtException', reportFatalFailure)
process.on('unhandledRejection', reportFatalFailure)

function acceptanceTestTiming(name: string, fallback: number): number {
  if (process.env.SIMULATOR_HOST_MODULE_ACCEPTANCE_TEST !== '1') return fallback
  const value = Number(process.env[name])
  return Number.isSafeInteger(value) && value >= 10 && value <= 10_000 ? value : fallback
}

function parseArguments(argv: readonly string[]): { packagedApp?: string; scenario: SmokeScenario } {
  let packagedApp: string | undefined
  let scenario: SmokeScenario | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument !== '--app' && argument !== '--scenario') throw new Error('Unknown argument')
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`)
    index += 1
    if (argument === '--app') {
      if (packagedApp !== undefined) throw new Error('--app may be specified only once')
      packagedApp = value
      continue
    }
    if (scenario !== undefined) throw new Error('--scenario may be specified only once')
    if (value !== 'v1-compat' && value !== 'v2-open-design-rc') {
      throw new Error('--scenario must be v1-compat or v2-open-design-rc')
    }
    scenario = value
  }
  if (!scenario) throw new Error('--scenario is required')
  return { ...(packagedApp ? { packagedApp } : {}), scenario }
}

const options = parseArguments(process.argv.slice(2))
const packagedApp = options.packagedApp
const scenarioConfig: SmokeScenarioConfig = options.scenario === 'v1-compat'
  ? {
      scenario: 'v1-compat',
      moduleId: 'org.simulator.open-design',
      version: '0.14.5',
      contractVersion: 1,
      fixtureEntry: 'module.ts',
    }
  : {
      scenario: 'v2-open-design-rc',
      moduleId: 'org.simulator.open-design',
      version: '0.14.6-rc.1',
      contractVersion: 2,
      fixtureEntry: 'module-v2.ts',
    }

const electronRoot = resolve(import.meta.dir, '..')
const repoRoot = resolve(electronRoot, '..', '..')
const fixtureRoot = join(repoRoot, 'packages', 'module-coordinator', 'fixtures', 'packaged-fake-module')
const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'simulator-electron-module-coordinator-smoke-')))
const runtimeRoot = join(temporary, 'runtime')
const moduleId = scenarioConfig.moduleId
const version = scenarioConfig.version
const entrypoint = process.platform === 'win32' ? 'bin/module.exe' : 'bin/module'
const installed = join(runtimeRoot, 'installed', 'modules', moduleId)
const versionRoot = join(installed, 'versions', version)
const executable = join(versionRoot, ...entrypoint.split('/'))
const resultPath = join(temporary, 'result.json')
const manifestPath = join(temporary, 'manifest.json')
const configRoot = join(temporary, 'craft-config')
const homeRoot = join(temporary, 'home')
mkdirSync(homeRoot, { recursive: true })

mkdirSync(dirname(executable), { recursive: true })
mkdirSync(join(versionRoot, 'frontend'), { recursive: true })
const build = Bun.spawnSync([
  process.execPath,
  'build',
  '--compile',
  '--minify',
  join(fixtureRoot, 'bin', scenarioConfig.fixtureEntry),
  '--outfile',
  executable,
], { stdout: 'pipe', stderr: 'pipe' })
if (build.exitCode !== 0) {
  throw closedFailure('FIXTURE_BUILD_FAILED', {
    status: build.exitCode,
    stdoutBytes: build.stdout.byteLength,
    stderrBytes: build.stderr.byteLength,
  })
}
writeFileSync(join(versionRoot, 'frontend', 'index.html'), readFileSync(join(fixtureRoot, 'frontend', 'index.html')))
writeFileSync(join(versionRoot, 'data.txt'), readFileSync(join(fixtureRoot, 'data.txt')))
mkdirSync(installed, { recursive: true })
writeFileSync(join(installed, 'state.json'), `${JSON.stringify({
  schemaVersion: 1,
  activeVersion: version,
  lastKnownGoodVersion: version,
})}\n`)

const platform = `${process.platform}-${process.arch}`
writeFileSync(manifestPath, `${JSON.stringify({
  schemaVersion: 1,
  id: moduleId,
  version,
  artifacts: [{
    platform,
    entrypoint,
    url: `https://modules.example.test/open-design/${version}.tar.gz`,
    sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  }],
  capabilities: ['host-agent.use'],
})}\n`)

function packagedExecutable(path: string): string {
  const absolute = resolve(repoRoot, path)
  if (!absolute.endsWith('.app')) return absolute
  return join(absolute, 'Contents', 'MacOS', basename(absolute, '.app'))
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

function processGroupExists(pgid: number): boolean {
  if (process.platform === 'win32') return false
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

async function waitForProcessesToExit(pids: readonly number[], timeoutMs: number): Promise<number[]> {
  const deadline = Date.now() + timeoutMs
  let remaining = [...new Set(pids)].filter(processExists)
  while (remaining.length > 0 && Date.now() < deadline) {
    await Bun.sleep(50)
    remaining = remaining.filter(processExists)
  }
  return remaining
}

async function waitForProcessGroupsToExit(pgids: readonly number[], timeoutMs: number): Promise<number[]> {
  const deadline = Date.now() + timeoutMs
  let remaining = [...new Set(pgids)].filter(processGroupExists)
  while (remaining.length > 0 && Date.now() < deadline) {
    await Bun.sleep(50)
    remaining = remaining.filter(processGroupExists)
  }
  return remaining
}

async function drainByteCount(stream: ReadableStream<Uint8Array>): Promise<number> {
  const reader = stream.getReader()
  let bytes = 0
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) return bytes
    bytes += chunk.value.byteLength
  }
}

async function awaitChildExitWithin(
  child: { readonly exited: Promise<number> },
  timeoutMs: number,
): Promise<{ exited: true; status: number } | { exited: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      child.exited.then((status) => ({ exited: true as const, status })),
      new Promise<{ exited: false }>((resolvePromise) => {
        timer = setTimeout(() => resolvePromise({ exited: false }), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function collectedSmokeOwnedProcessGroups(path: string): number[] {
  try {
    const result = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    const values = result.smokeOwnedProcessGroups
    if (!Array.isArray(values)) return []
    return [...new Set(values.filter((value): value is number => (
      Number.isSafeInteger(value) && value > 1
    )))]
  } catch {
    return []
  }
}

function signalProcessGroups(pgids: readonly number[], signal: NodeJS.Signals): void {
  for (const pgid of pgids) {
    try {
      process.kill(-pgid, signal)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        throw closedFailure('SMOKE_OWNED_PROCESS_SIGNAL_FAILED')
      }
    }
  }
}

async function reapCollectedProcessGroups(pgids: readonly number[]): Promise<void> {
  if (process.platform === 'win32' || pgids.length === 0) return
  signalProcessGroups(pgids, 'SIGTERM')
  let remaining = await waitForProcessGroupsToExit(pgids, acceptanceTestTiming(
    'SIMULATOR_HOST_MODULE_ACCEPTANCE_GRACE_MS',
    GRACEFUL_PROCESS_EXIT_MS,
  ))
  if (remaining.length === 0) return
  signalProcessGroups(remaining, 'SIGKILL')
  remaining = await waitForProcessGroupsToExit(remaining, acceptanceTestTiming(
    'SIMULATOR_HOST_MODULE_ACCEPTANCE_FORCE_WAIT_MS',
    FORCED_PROCESS_EXIT_MS,
  ))
  if (remaining.length > 0) {
    throw closedFailure('SMOKE_OWNED_PROCESS_REAP_FAILED')
  }
}

const executablePath = packagedApp
  ? packagedExecutable(packagedApp)
  : join(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron')
const appArguments = packagedApp ? [] : [electronRoot]
if (!existsSync(executablePath)) throw closedFailure('SMOKE_EXECUTABLE_MISSING')

const child = Bun.spawn([
  executablePath,
  `--user-data-dir=${join(temporary, 'electron-user-data')}`,
  ...appArguments,
  // Electron 39 passes a bare --debug through Node's removed legacy debug
  // parser unless application arguments are separated explicitly.
  '--',
  '--debug',
  `--host-module-smoke-root=${runtimeRoot}`,
  `--host-module-smoke-manifest=${manifestPath}`,
  `--host-module-smoke-result=${resultPath}`,
  ...(!packagedApp ? [`--host-module-smoke-node-runtime=${process.execPath}`] : []),
], {
  cwd: repoRoot,
  env: {
    ...process.env,
    CRAFT_CONFIG_DIR: configRoot,
    HOME: homeRoot,
    USERPROFILE: homeRoot,
    APPDATA: join(homeRoot, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(homeRoot, 'AppData', 'Local'),
    ELECTRON_ENABLE_LOGGING: '1',
    SIMULATOR_HOST_MODULE_ACCEPTANCE: '1',
  },
  stdout: 'pipe',
  stderr: 'pipe',
})
const stdoutBytesPromise = drainByteCount(child.stdout)
const stderrBytesPromise = drainByteCount(child.stderr)
const outerTimeoutMs = acceptanceTestTiming(
  'SIMULATOR_HOST_MODULE_ACCEPTANCE_OUTER_TIMEOUT_MS',
  OUTER_WATCHDOG_TIMEOUT_MS,
)
let exit = await awaitChildExitWithin(child, outerTimeoutMs)
let watchdogTimedOut = false
if (!exit.exited) {
  watchdogTimedOut = true
  const ownedProcessGroups = collectedSmokeOwnedProcessGroups(resultPath)
  child.kill('SIGTERM')
  exit = await awaitChildExitWithin(child, acceptanceTestTiming(
    'SIMULATOR_HOST_MODULE_ACCEPTANCE_GRACE_MS',
    GRACEFUL_PROCESS_EXIT_MS,
  ))
  if (!exit.exited) {
    child.kill('SIGKILL')
    exit = await awaitChildExitWithin(child, acceptanceTestTiming(
      'SIMULATOR_HOST_MODULE_ACCEPTANCE_FORCE_WAIT_MS',
      FORCED_PROCESS_EXIT_MS,
    ))
  }
  await reapCollectedProcessGroups(ownedProcessGroups)
  if (!exit.exited) throw closedFailure('SMOKE_CHILD_REAP_FAILED')
}
const [stdoutBytes, stderrBytes] = await Promise.all([stdoutBytesPromise, stderrBytesPromise])
const exitCode = exit.status

try {
  if (watchdogTimedOut) {
    throw closedFailure('SMOKE_CHILD_TIMEOUT', { status: exitCode, stdoutBytes, stderrBytes })
  }
  if (!existsSync(resultPath)) {
    throw closedFailure('SMOKE_RESULT_MISSING', { status: exitCode, stdoutBytes, stderrBytes })
  }
  const resultBuffer = readFileSync(resultPath)
  let result: Record<string, unknown>
  try {
    result = JSON.parse(resultBuffer.toString('utf8')) as Record<string, unknown>
  } catch {
    throw closedFailure('SMOKE_RESULT_INVALID', {
      status: exitCode,
      resultBytes: resultBuffer.byteLength,
      stdoutBytes,
      stderrBytes,
    })
  }
  if (exitCode !== 0 || result.ok !== true) {
    throw closedFailure('SMOKE_CHILD_FAILED', {
      status: exitCode,
      resultBytes: resultBuffer.byteLength,
      stdoutBytes,
      stderrBytes,
    })
  }
  if (result.packaged !== Boolean(packagedApp)) throw closedFailure('SMOKE_PACKAGED_STATE_INVALID')
  if (result.protocolFixture !== true
    || result.acceptanceScope !== 'deterministic-packaged-protocol-fixture-not-real-rc-or-paid-preview-acceptance'
    || result.scenario !== scenarioConfig.scenario
    || result.moduleId !== moduleId
    || result.moduleVersion !== version) {
    throw closedFailure('SMOKE_FIXTURE_IDENTITY_INVALID')
  }
  const cleanup = result.cleanup as Record<string, unknown> | undefined
  const builtInAgent = result.builtInAgent as Record<string, unknown> | undefined
  const hostAgentRuntime = result.hostAgentRuntime as Record<string, unknown> | undefined
  const processEvidence = result.processEvidence as Record<string, unknown> | undefined
  const visibleTurns = builtInAgent?.visibleTurns as Array<Record<string, unknown>> | undefined
  const expectedVisibleMarkers = [
    'craft-before-module',
    'craft-after-worker-recovery',
    'craft-after-daemon-recovery',
  ]
  const visibleTurnsValid = builtInAgent?.visibleTurnCount === 3
    && Array.isArray(visibleTurns) && visibleTurns.length === 3
    && visibleTurns.every((turn, index) => (
      turn.marker === expectedVisibleMarkers[index]
      && turn.assistantCountBefore === index
      && turn.assistantCountAfter === index + 1
    ))
    && Number.isSafeInteger(builtInAgent.hostMainProcessId) && (builtInAgent.hostMainProcessId as number) > 0
    && Number.isSafeInteger(builtInAgent.hostWebContentsId) && (builtInAgent.hostWebContentsId as number) > 0
    && Number.isSafeInteger(builtInAgent.hostRendererProcessId) && (builtInAgent.hostRendererProcessId as number) > 0
  if (result.preloadIsolated !== true || result.noOrphanWebContents !== true || result.builtInAgentIndependent !== true
    || result.workerCrashRecovered !== true || result.moduleCrashRestarted !== true
    || result.beforeQuitObserved !== true || result.repeatedBeforeQuitIdempotent !== true
    || cleanup?.coordinatorDrained !== true || cleanup.sessionFlushed !== true || cleanup.serverStopped !== true || cleanup.viewsDisposed !== true
    || cleanup.moduleAgentStopped !== true
    || hostAgentRuntime?.deterministicTurns !== true || hostAgentRuntime.crashGrantRotated !== true
    || hostAgentRuntime.workerEpochRotated !== true || hostAgentRuntime.oldGrantRevoked !== true
    || hostAgentRuntime.stopGrantRevoked !== true || hostAgentRuntime.zeroHiddenSessions !== true
    || builtInAgent?.deterministicTurn !== true || !visibleTurnsValid
    || builtInAgent.serverHealthyBeforeModule !== true || builtInAgent.serverHealthyAfterModule !== true) {
    throw closedFailure('SMOKE_ASSERTIONS_FAILED')
  }
  if (hostAgentRuntime.contractVersion !== scenarioConfig.contractVersion) {
    throw closedFailure('SMOKE_CONTRACT_VERSION_INVALID')
  }
  if (scenarioConfig.scenario === 'v2-open-design-rc'
    && (hostAgentRuntime.ordinaryJsonEventStreamCli !== true
      || hostAgentRuntime.oneTurnPerSession !== true
      || hostAgentRuntime.shimResourceHashVerified !== true)) {
    // M1 #129 integration contract: main-process smoke must forward and verify
    // the strict fixture evidence. Never substitute the legacy multi-turn bit
    // for one-Turn/one-Session v2 proof.
    throw closedFailure('SMOKE_V2_EVIDENCE_INCOMPLETE')
  }
  if (scenarioConfig.scenario === 'v1-compat' && hostAgentRuntime.deterministicMultiTurn !== true) {
    throw closedFailure('SMOKE_V1_EVIDENCE_INCOMPLETE')
  }
  const observedPids = processEvidence?.observedPids
  const providerProcessGroups = processEvidence?.providerProcessGroups
  const processRecords = processEvidence?.records
  if (processEvidence?.checkWithinMs !== 10_000 || !Array.isArray(observedPids)
    || observedPids.length === 0
    || observedPids.some((pid) => !Number.isSafeInteger(pid) || pid <= 0)
    || !Array.isArray(providerProcessGroups) || providerProcessGroups.length < 3
    || providerProcessGroups.some((pgid) => !Number.isSafeInteger(pgid) || pgid <= 0)
    || !Array.isArray(processRecords) || processRecords.length === 0
    || processRecords.some((input) => {
      const record = input as Record<string, unknown>
      return !Number.isSafeInteger(record.pid) || (record.pid as number) <= 0
        || !Number.isSafeInteger(record.ppid) || (record.ppid as number) <= 0
        || !Number.isSafeInteger(record.pgid) || (record.pgid as number) <= 0
        || !['host-descendant', 'module-provider-root', 'module-provider-descendant'].includes(String(record.role))
        || typeof record.executable !== 'string' || record.executable.length === 0
        || record.executable.includes('/') || record.executable.includes('\\')
        || Object.keys(record).some((key) => !['pid', 'ppid', 'pgid', 'role', 'executable'].includes(key))
    })
    || processRecords.filter((input) => (
      (input as Record<string, unknown>).role === 'module-provider-root'
    )).length < 3) {
    throw closedFailure('SMOKE_PROCESS_EVIDENCE_INVALID')
  }
  const remainingPids = await waitForProcessesToExit(observedPids as number[], 10_000)
  if (remainingPids.length > 0) {
    throw closedFailure('SMOKE_PROCESS_RESIDUE')
  }
  const remainingProcessGroups = await waitForProcessGroupsToExit(providerProcessGroups as number[], 10_000)
  if (remainingProcessGroups.length > 0) {
    throw closedFailure('SMOKE_PROCESS_GROUP_RESIDUE')
  }
  if (existsSync(join(configRoot, '.server.lock'))) throw closedFailure('SMOKE_SERVER_LOCK_RESIDUE')
  if (builtInAgent.sessionPersistenceVerified !== true) {
    throw closedFailure('SMOKE_SESSION_PERSISTENCE_INVALID')
  }
  console.log(`Electron host module coordinator smoke passed (${scenarioConfig.scenario})`)
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
