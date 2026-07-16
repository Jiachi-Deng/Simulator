import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

const appFlag = process.argv.indexOf('--app')
const packagedApp = appFlag >= 0 ? process.argv[appFlag + 1] : undefined
if (appFlag >= 0 && !packagedApp) throw new Error('--app requires a packaged Electron app or executable path')

const electronRoot = resolve(import.meta.dir, '..')
const repoRoot = resolve(electronRoot, '..', '..')
const fixtureRoot = join(repoRoot, 'packages', 'module-coordinator', 'fixtures', 'packaged-fake-module')
const temporary = mkdtempSync(join(tmpdir(), 'simulator-electron-module-coordinator-smoke-'))
const runtimeRoot = join(temporary, 'runtime')
const moduleId = 'org.simulator.electron-product-smoke'
const version = '1.0.0'
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
  join(fixtureRoot, 'bin', 'module.ts'),
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
    url: 'https://modules.example.test/electron-product-smoke.tar.gz',
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
  if (existsSync(join(configRoot, '.server.lock'))) throw new Error('Electron before-quit left the embedded server lock behind')
  const sessionPath = builtInAgent.sessionPath
  if (typeof sessionPath !== 'string' || !existsSync(join(sessionPath, 'session.jsonl'))) {
    throw new Error(`Electron before-quit did not flush the built-in Agent session: ${JSON.stringify(result)}`)
  }
  console.log(`Electron host module coordinator smoke passed: ${JSON.stringify(result)}`)
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
