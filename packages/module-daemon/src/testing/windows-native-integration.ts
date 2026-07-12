import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { parseModuleManifest, type ModuleManifest, type ModulePlatform } from '@simulator/module-contract'
import { ModuleDaemonManager } from '../manager.ts'
import { LoopbackHttpHealthAdapter, RealClock, RealProcessAdapter } from '../real-adapters.ts'
import { resolveActivatedEntrypoint } from '../safety.ts'
import { ModuleDaemonError, type ModuleDaemonSnapshot } from '../types.ts'
import { KoffiWindowsJobProcessFactory } from '../windows-job.ts'

const roots: string[] = []

function windowsPlatform(): ModulePlatform {
  return `win32-${process.arch}` as ModulePlatform
}

function fixtureManifest(entrypoint: string): ModuleManifest {
  const parsed = parseModuleManifest({
    schemaVersion: 1,
    id: 'org.simulator.windows-native-fixture',
    version: '1.0.0',
    artifacts: [{
      platform: windowsPlatform(),
      entrypoint,
      url: 'https://modules.example.test/windows-native-fixture.zip',
      sha256: 'c'.repeat(64),
    }],
    capabilities: [],
  })
  if (!parsed.ok) throw new Error(`Invalid Windows fixture manifest: ${JSON.stringify(parsed.errors)}`)
  return parsed.value
}

function findBunExecutable(): string {
  const result = spawnSync('where.exe', ['bun'], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`Unable to locate Bun: ${result.stderr}`)
  const executable = result.stdout.split(/\r?\n/).find(Boolean)
  if (!executable) throw new Error('where.exe returned no Bun executable')
  return executable
}

async function run(executable: string, args: readonly string[]): Promise<void> {
  await new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(executable, [...args], { stdio: 'inherit', windowsHide: true })
    child.once('error', rejectRun)
    child.once('exit', (code, signal) => {
      if (code === 0) resolveRun()
      else rejectRun(new Error(`${executable} exited with code=${code ?? 'null'} signal=${signal ?? 'null'}`))
    })
  })
}

async function prepareFixture(bunExecutable: string, prefix: string): Promise<{
  readonly root: string
  readonly entrypoint: string
}> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  const entrypoint = 'bin/daemon-fixture.exe'
  const executable = join(root, entrypoint)
  await mkdir(dirname(executable), { recursive: true })
  const source = resolve(process.cwd(), 'src/testing/fixtures/daemon-fixture.ts')
  await run(bunExecutable, ['build', '--compile', source, '--outfile', executable])
  return { root, entrypoint }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

async function waitForExit(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000
  while (processExists(pid) && Date.now() < deadline) await new Promise((resolveWait) => setTimeout(resolveWait, 10))
  assert.equal(processExists(pid), false, `pid ${pid} remained alive`)
}

async function waitForFile(path: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      return await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 10))
  }
  throw new Error(`Timed out waiting for fixture file ${path}`)
}

async function readIfPresent(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '<missing>'
    throw error
  }
}

async function drainAfter<T>(manager: ModuleDaemonManager, operation: () => Promise<T>): Promise<T> {
  let result: T | undefined
  let failure: unknown
  try {
    result = await operation()
  } catch (error) {
    failure = error
  }
  try {
    await manager.drain()
  } catch (cleanupError) {
    failure = failure === undefined
      ? cleanupError
      : new AggregateError([failure, cleanupError], 'Windows native integration and manager cleanup both failed')
  }
  if (failure !== undefined) throw failure
  return result as T
}

async function removeIfPresent(path: string): Promise<void> {
  await unlink(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
  })
}

function managerFor(
  factory: KoffiWindowsJobProcessFactory,
  baseEnvironment: Readonly<Record<string, string>>,
): ModuleDaemonManager {
  return new ModuleDaemonManager({
    process: new RealProcessAdapter({ platform: 'win32', windowsJobFactory: factory }),
    clock: new RealClock(),
    health: new LoopbackHttpHealthAdapter(),
    startupTimeoutMs: 5_000,
    healthTimeoutMs: 250,
    healthIntervalMs: 20,
    unhealthyThreshold: 2,
    restartLimit: 0,
    restartBackoffMs: [0],
    idleTimeoutMs: 60_000,
    stopGraceMs: 2_000,
    baseEnvironment,
  })
}

async function verifyJunctionContainment(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'simulator-daemon-node-junction-'))
  const outsideRoot = await mkdtemp(join(tmpdir(), 'simulator-daemon-node-outside-'))
  roots.push(root, outsideRoot)
  await mkdir(join(root, 'bin'), { recursive: true })
  await writeFile(join(root, 'bin', 'inside.exe'), '')
  const outsideDirectory = join(outsideRoot, 'payload')
  await mkdir(outsideDirectory, { recursive: true })
  await writeFile(join(outsideDirectory, 'daemon.exe'), '')
  await symlink(outsideDirectory, join(root, 'bin', 'escape'), 'junction')

  const parsed = parseModuleManifest({
    schemaVersion: 1,
    id: 'org.simulator.windows-junction',
    version: '1.0.0',
    artifacts: [{
      platform: windowsPlatform(),
      entrypoint: 'bin/escape/daemon.exe',
      url: 'https://modules.example.test/escape.zip',
      sha256: 'd'.repeat(64),
    }],
    capabilities: [],
  })
  if (!parsed.ok) throw new Error(`Invalid junction manifest: ${JSON.stringify(parsed.errors)}`)

  await assert.rejects(
    resolveActivatedEntrypoint(root, parsed.value.artifacts[0]!),
    (error: unknown) => error instanceof ModuleDaemonError && error.code === 'ENTRYPOINT_OUTSIDE_ACTIVATED_ROOT',
  )
}

async function runTwentyCycles(
  factory: KoffiWindowsJobProcessFactory,
  bunExecutable: string,
  systemRoot: string,
): Promise<void> {
  const { root, entrypoint } = await prepareFixture(bunExecutable, 'simulator-daemon-node-cycles-')
  const childPidFile = join(root, 'child.pid')
  const childStopFile = join(root, 'child-stopped')
  const statusFile = join(root, 'fixture-status.log')
  const manager = managerFor(factory, {
    PATH: `${dirname(bunExecutable)};${join(systemRoot, 'System32')}`,
    SystemRoot: systemRoot,
    SIMULATOR_FIXTURE_CHILD_PID_FILE: childPidFile,
    SIMULATOR_FIXTURE_CHILD_STOP_FILE: childStopFile,
    SIMULATOR_FIXTURE_RUNTIME: bunExecutable,
    SIMULATOR_FIXTURE_STATUS_FILE: statusFile,
  })
  const manifest = fixtureManifest(entrypoint)
  const diagnostics: string[] = []
  const unsubscribe = manager.subscribe((snapshot) => {
    if (snapshot.diagnostic) {
      diagnostics.push(`${snapshot.state}:${snapshot.diagnostic.code}:${snapshot.diagnostic.message}`)
    }
  })
  try {
    await drainAfter(manager, async () => {
      for (let cycle = 0; cycle < 20; cycle += 1) {
        await Promise.all([childPidFile, childStopFile, statusFile].map(removeIfPresent))
        diagnostics.length = 0
        const startedAt = Date.now()
        let started: ModuleDaemonSnapshot
        try {
          started = await manager.start({ manifest, activatedRoot: root, platform: windowsPlatform() })
        } catch (error) {
          const fixtureStatus = await readIfPresent(statusFile)
          const snapshot = manager.get(manifest.id)
          throw new Error(
            `Windows native cycle ${cycle + 1}/20 failed to start after ${Date.now() - startedAt}ms; `
            + `snapshot=${JSON.stringify(snapshot)} diagnostics=${JSON.stringify(diagnostics)} `
            + `fixtureStatus=${JSON.stringify(fixtureStatus)}`,
            { cause: error },
          )
        }
        assert.equal(started.state, 'healthy')
        assert.ok(started.pid)
        const childPid = Number(await waitForFile(childPidFile, 5_000))
        assert.equal(processExists(started.pid), true)
        assert.equal(processExists(childPid), true)
        console.log(
          `Windows native cycle ${cycle + 1}/20 healthy in ${Date.now() - startedAt}ms `
          + `endpoint=${started.endpoint?.host}:${started.endpoint?.port} parent=${started.pid} child=${childPid}`,
        )
        const stopped = await manager.stop(manifest.id)
        assert.equal(stopped?.state, 'stopped')
        await Promise.all([waitForExit(started.pid), waitForExit(childPid)])
      }
    })
  } finally {
    unsubscribe()
  }
}

async function runLeaderFirst(
  factory: KoffiWindowsJobProcessFactory,
  bunExecutable: string,
  systemRoot: string,
): Promise<void> {
  const { root, entrypoint } = await prepareFixture(bunExecutable, 'simulator-daemon-node-leader-')
  const childPidFile = join(root, 'child.pid')
  const statusFile = join(root, 'fixture-status.log')
  const manager = managerFor(factory, {
    PATH: `${dirname(bunExecutable)};${join(systemRoot, 'System32')}`,
    SystemRoot: systemRoot,
    SIMULATOR_FIXTURE_CHILD_PID_FILE: childPidFile,
    SIMULATOR_FIXTURE_CHILD_STOP_FILE: join(root, 'child-stopped'),
    SIMULATOR_FIXTURE_RUNTIME: bunExecutable,
    SIMULATOR_FIXTURE_EXIT_AFTER_READY: '1',
    SIMULATOR_FIXTURE_STATUS_FILE: statusFile,
  })
  const manifest = fixtureManifest(entrypoint)
  await drainAfter(manager, async () => {
    await manager.start({ manifest, activatedRoot: root, platform: windowsPlatform() })
    const childPid = Number(await waitForFile(childPidFile, 5_000))
    const deadline = Date.now() + 5_000
    while (manager.get(manifest.id)?.state !== 'crashed' && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 10))
    }
    assert.deepEqual(manager.get(manifest.id)?.diagnostic?.code, 'RESTART_BUDGET_EXHAUSTED')
    await waitForExit(childPid)
  })
}

async function main(): Promise<void> {
  assert.equal(process.platform, 'win32', 'Windows native integration must run on Windows')
  const systemRoot = process.env.SystemRoot
  if (!systemRoot) throw new Error('Windows native integration requires SystemRoot')
  const bunExecutable = findBunExecutable()
  let factory: KoffiWindowsJobProcessFactory | undefined
  try {
    await verifyJunctionContainment()
    factory = new KoffiWindowsJobProcessFactory()
    await runTwentyCycles(factory, bunExecutable, systemRoot)
    await runLeaderFirst(factory, bunExecutable, systemRoot)
    await factory.dispose()
    factory = undefined
    console.log('Windows Node native integration passed: junction, 20 cycles, leader-first cleanup')
  } finally {
    await factory?.dispose()
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
