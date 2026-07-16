import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

type SmokeScenario = 'v1-compat' | 'v2-open-design-rc'

interface SmokeScenarioConfig {
  readonly scenario: SmokeScenario
  readonly moduleId: 'org.simulator.open-design'
  readonly version: '0.14.5' | '0.14.6-rc.1'
  readonly contractVersion: 1 | 2
  readonly fixtureEntry: 'module.ts' | 'module-v2.ts'
}

function parseArguments(argv: readonly string[]): { packagedApp?: string; scenario: SmokeScenario } {
  let packagedApp: string | undefined
  let scenario: SmokeScenario | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument !== '--app' && argument !== '--scenario') throw new Error(`Unknown argument: ${argument}`)
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
const temporary = mkdtempSync(join(tmpdir(), 'simulator-electron-module-coordinator-smoke-'))
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
  throw new Error(`Could not compile Electron smoke fixture: ${build.stdout.toString()}\n${build.stderr.toString()}`)
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

const executablePath = packagedApp
  ? packagedExecutable(packagedApp)
  : join(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron')
const appArguments = packagedApp ? [] : [electronRoot]
if (!existsSync(executablePath)) throw new Error(`Electron executable not found: ${executablePath}`)

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
const timeout = setTimeout(() => child.kill(), 45_000)
const [exitCode, stdout, stderr] = await Promise.all([
  child.exited,
  new Response(child.stdout).text(),
  new Response(child.stderr).text(),
])
clearTimeout(timeout)

try {
  if (!existsSync(resultPath)) throw new Error(`Electron host module smoke produced no result (${exitCode})\n${stdout}\n${stderr}`)
  const result = JSON.parse(readFileSync(resultPath, 'utf8')) as Record<string, unknown>
  if (exitCode !== 0 || result.ok !== true) {
    throw new Error(`Electron host module smoke failed (${exitCode}): ${JSON.stringify(result)}\n${stdout}\n${stderr}`)
  }
  if (result.packaged !== Boolean(packagedApp)) throw new Error(`Unexpected packaged state: ${JSON.stringify(result)}`)
  if (result.protocolFixture !== true
    || result.acceptanceScope !== 'deterministic-packaged-protocol-fixture-not-real-rc-or-paid-preview-acceptance'
    || result.scenario !== scenarioConfig.scenario
    || result.moduleId !== moduleId
    || result.moduleVersion !== version) {
    throw new Error(`Electron smoke did not return closed protocol-fixture identity: ${JSON.stringify(result)}`)
  }
  const cleanup = result.cleanup as Record<string, unknown> | undefined
  const builtInAgent = result.builtInAgent as Record<string, unknown> | undefined
  const hostAgentRuntime = result.hostAgentRuntime as Record<string, unknown> | undefined
  if (result.preloadIsolated !== true || result.noOrphanWebContents !== true || result.builtInAgentIndependent !== true
    || result.moduleCrashRestarted !== true || result.beforeQuitObserved !== true || result.repeatedBeforeQuitIdempotent !== true
    || cleanup?.coordinatorDrained !== true || cleanup.sessionFlushed !== true || cleanup.serverStopped !== true || cleanup.viewsDisposed !== true
    || cleanup.moduleAgentStopped !== true
    || hostAgentRuntime?.deterministicMultiTurn !== true || hostAgentRuntime.crashGrantRotated !== true
    || hostAgentRuntime.oldGrantRevoked !== true || hostAgentRuntime.stopGrantRevoked !== true
    || builtInAgent?.deterministicTurn !== true || builtInAgent.serverHealthyBeforeModule !== true || builtInAgent.serverHealthyAfterModule !== true) {
    throw new Error(`Electron host module smoke assertions failed: ${JSON.stringify(result)}`)
  }
  if (hostAgentRuntime.contractVersion !== scenarioConfig.contractVersion) {
    throw new Error(`Electron smoke used the wrong Host Agent contract: ${JSON.stringify(result)}`)
  }
  if (scenarioConfig.scenario === 'v2-open-design-rc'
    && (hostAgentRuntime.ordinaryJsonEventStreamCli !== true
      || hostAgentRuntime.oneTurnPerSession !== true
      || hostAgentRuntime.shimResourceHashVerified !== true)) {
    // M1 #129 integration contract: main-process smoke must forward and verify
    // the strict fixture evidence. Never substitute the legacy multi-turn bit
    // for one-Turn/one-Session v2 proof.
    throw new Error(`Electron v2 packaged protocol evidence is incomplete: ${JSON.stringify(result)}`)
  }
  if (existsSync(join(configRoot, '.server.lock'))) throw new Error('Electron before-quit left the embedded server lock behind')
  const sessionPath = builtInAgent.sessionPath
  if (typeof sessionPath !== 'string' || !existsSync(join(sessionPath, 'session.jsonl'))) {
    throw new Error(`Electron before-quit did not flush the built-in Agent session: ${JSON.stringify(result)}`)
  }
  console.log(`Electron host module coordinator smoke passed (${scenarioConfig.scenario}): ${JSON.stringify(result)}`)
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
