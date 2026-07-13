import { afterAll, describe, expect, test } from 'bun:test'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseModuleManifest, type ModuleManifest, type ModulePlatform } from '@simulator/module-contract'
import { ModuleDaemonManager } from './manager.ts'
import { LoopbackHttpHealthAdapter, RealClock, RealProcessAdapter } from './real-adapters.ts'

const roots: string[] = []

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

function currentPlatform(): ModulePlatform {
  return `${process.platform}-${process.arch}` as ModulePlatform
}

function fixtureManifest(entrypoint: string): ModuleManifest {
  const parsed = parseModuleManifest({
    schemaVersion: 1,
    id: 'org.simulator.real-fixture',
    version: '1.0.0',
    artifacts: [{
      platform: currentPlatform(),
      entrypoint,
      url: 'https://modules.example.test/real-fixture.tar.gz',
      sha256: 'b'.repeat(64),
    }],
    capabilities: [],
  })
  if (!parsed.ok) throw new Error(`Invalid fixture manifest: ${JSON.stringify(parsed.errors)}`)
  return parsed.value
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
  const timeoutMs = 10_000
  const deadline = Date.now() + timeoutMs
  while (processExists(pid) && Date.now() < deadline) await Bun.sleep(10)
  if (processExists(pid)) throw new Error(`process ${pid} remained alive after ${timeoutMs}ms`)
}

function parseFixturePid(value: string): number | undefined {
  if (!/^[1-9]\d*$/.test(value)) return undefined
  const pid = Number(value)
  return Number.isSafeInteger(pid) ? pid : undefined
}

async function waitForPidFile(path: string, timeoutMs = 2_000): Promise<number> {
  const deadline = Date.now() + timeoutMs
  let lastValue: string | undefined
  while (Date.now() < deadline) {
    try {
      lastValue = await readFile(path, 'utf8')
      const pid = parseFixturePid(lastValue)
      if (pid !== undefined) return pid
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await Bun.sleep(10)
  }
  throw new Error(`Timed out waiting for a valid fixture PID in ${path}; last value: ${JSON.stringify(lastValue)}`)
}

describe('fixture PID readiness', () => {
  test('waits for an empty PID file to contain a canonical positive integer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'simulator-daemon-pid-'))
    roots.push(root)
    const path = join(root, 'child.pid')
    await Bun.write(path, '')
    setTimeout(() => { void Bun.write(path, String(process.pid)) }, 20)

    expect(await waitForPidFile(path, 1_000)).toBe(process.pid)
  })

  test('rejects values that must never reach process.kill', () => {
    for (const value of ['', '0', '-1', '1.5', '1x', '01', String(Number.MAX_SAFE_INTEGER + 1)]) {
      expect(parseFixturePid(value)).toBeUndefined()
    }
  })
})

describe.skipIf(process.platform === 'win32')('real local module daemon fixture', () => {
  test('runs 20 start/stop cycles without parent or descendant orphans', async () => {
    const root = await mkdtemp(join(tmpdir(), 'simulator-daemon-real-'))
    roots.push(root)
    const entrypoint = process.platform === 'win32' ? 'bin/daemon-fixture.exe' : 'bin/daemon-fixture.ts'
    const executable = join(root, entrypoint)
    await mkdir(dirname(executable), { recursive: true })
    const fixtureSource = join(import.meta.dir, 'testing/fixtures/daemon-fixture.ts')
    if (process.platform === 'win32') {
      const build = Bun.spawn([process.execPath, 'build', '--compile', fixtureSource, '--outfile', executable], {
        stdout: 'inherit',
        stderr: 'inherit',
      })
      expect(await build.exited).toBe(0)
    } else {
      await copyFile(fixtureSource, executable)
      await chmod(executable, 0o755)
    }
    const childPidFile = join(root, 'child.pid')
    const childStopFile = join(root, 'child-stopped')
    const baseEnvironment: Record<string, string> = {
      PATH: process.platform === 'win32' ? dirname(process.execPath) : `${dirname(process.execPath)}:/usr/bin:/bin`,
      SIMULATOR_FIXTURE_CHILD_PID_FILE: childPidFile,
      SIMULATOR_FIXTURE_CHILD_STOP_FILE: childStopFile,
      SIMULATOR_FIXTURE_RUNTIME: process.execPath,
    }
    if (process.platform === 'win32' && process.env.SystemRoot) baseEnvironment.SystemRoot = process.env.SystemRoot
    const manager = new ModuleDaemonManager({
      process: new RealProcessAdapter(),
      clock: new RealClock(),
      health: new LoopbackHttpHealthAdapter(),
      startupTimeoutMs: 3_000,
      healthTimeoutMs: 250,
      healthIntervalMs: 20,
      unhealthyThreshold: 2,
      restartLimit: 0,
      restartBackoffMs: [0],
      idleTimeoutMs: 60_000,
      stopGraceMs: 500,
      baseEnvironment,
    })

    const manifest = fixtureManifest(entrypoint)
    const endpoints = new Set<number>()
    for (let cycle = 0; cycle < 20; cycle += 1) {
      await Promise.all([childPidFile, childStopFile].map((path) => unlink(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
      })))
      const started = await manager.start({ manifest, activatedRoot: root, platform: currentPlatform() })
      expect(started.state).toBe('healthy')
      endpoints.add(started.endpoint!.port)
      const parentPid = started.pid!
      const childPid = await waitForPidFile(childPidFile)
      expect(processExists(parentPid)).toBe(true)
      expect(processExists(childPid)).toBe(true)

      const stopped = await manager.stop(manifest.id)
      expect(stopped?.state).toBe('stopped')
      await Promise.all([waitForExit(parentPid), waitForExit(childPid)])
      if (process.platform !== 'win32') expect(await readFile(childStopFile, 'utf8')).toBe('graceful')
    }

    expect(endpoints.size).toBeGreaterThan(1)
    await manager.drain()
  }, 30_000)

  test('kills descendants after the process-group leader exits first', async () => {
    const systemRoot = process.env.SystemRoot
    if (process.platform === 'win32' && !systemRoot) throw new Error('Windows integration requires SystemRoot')
    const root = await mkdtemp(join(tmpdir(), 'simulator-daemon-leader-crash-'))
    roots.push(root)
    const entrypoint = process.platform === 'win32' ? 'bin/daemon-fixture.exe' : 'bin/daemon-fixture.ts'
    const executable = join(root, entrypoint)
    await mkdir(dirname(executable), { recursive: true })
    const fixtureSource = join(import.meta.dir, 'testing/fixtures/daemon-fixture.ts')
    if (process.platform === 'win32') {
      const build = Bun.spawn([
        process.execPath,
        'build',
        '--compile',
        fixtureSource,
        '--outfile',
        executable,
      ], { stdout: 'inherit', stderr: 'inherit' })
      expect(await build.exited).toBe(0)
    } else {
      await copyFile(fixtureSource, executable)
      await chmod(executable, 0o755)
    }
    const childPidFile = join(root, 'child.pid')
    const manager = new ModuleDaemonManager({
      process: new RealProcessAdapter(),
      clock: new RealClock(),
      health: new LoopbackHttpHealthAdapter(),
      startupTimeoutMs: 5_000,
      healthTimeoutMs: 250,
      healthIntervalMs: 20,
      restartLimit: 0,
      restartBackoffMs: [0],
      idleTimeoutMs: 60_000,
      stopGraceMs: 2_000,
      baseEnvironment: {
        PATH: process.platform === 'win32' ? dirname(process.execPath) : `${dirname(process.execPath)}:/usr/bin:/bin`,
        ...(systemRoot ? { SystemRoot: systemRoot } : {}),
        SIMULATOR_FIXTURE_CHILD_PID_FILE: childPidFile,
        SIMULATOR_FIXTURE_CHILD_STOP_FILE: join(root, 'child-stopped'),
        SIMULATOR_FIXTURE_RUNTIME: process.execPath,
        SIMULATOR_FIXTURE_EXIT_AFTER_READY: '1',
      },
    })
    const manifest = fixtureManifest(entrypoint)
    await manager.start({ manifest, activatedRoot: root, platform: currentPlatform() })
    const childPid = await waitForPidFile(childPidFile)
    const deadline = Date.now() + 5_000
    while (manager.get(manifest.id)?.state !== 'crashed' && Date.now() < deadline) await Bun.sleep(10)
    expect(manager.get(manifest.id)).toMatchObject({
      state: 'crashed',
      diagnostic: { code: 'RESTART_BUDGET_EXHAUSTED' },
    })
    await waitForExit(childPid)
  }, 30_000)
})
