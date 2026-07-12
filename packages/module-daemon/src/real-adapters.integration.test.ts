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
  const deadline = Date.now() + 2_000
  while (processExists(pid) && Date.now() < deadline) await Bun.sleep(10)
  expect(processExists(pid)).toBe(false)
}

describe('real local module daemon fixture', () => {
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
      const childPid = Number(await readFile(childPidFile, 'utf8'))
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

  test.skipIf(process.platform !== 'win32')('kills descendants after the Windows leader exits first', async () => {
    const systemRoot = process.env.SystemRoot
    if (!systemRoot) throw new Error('Windows integration requires SystemRoot')
    const root = await mkdtemp(join(tmpdir(), 'simulator-daemon-win-crash-'))
    roots.push(root)
    const entrypoint = 'bin/daemon-fixture.exe'
    const executable = join(root, entrypoint)
    await mkdir(dirname(executable), { recursive: true })
    const build = Bun.spawn([
      process.execPath,
      'build',
      '--compile',
      join(import.meta.dir, 'testing/fixtures/daemon-fixture.ts'),
      '--outfile',
      executable,
    ], { stdout: 'inherit', stderr: 'inherit' })
    expect(await build.exited).toBe(0)
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
        PATH: dirname(process.execPath),
        SystemRoot: systemRoot,
        SIMULATOR_FIXTURE_CHILD_PID_FILE: childPidFile,
        SIMULATOR_FIXTURE_CHILD_STOP_FILE: join(root, 'child-stopped'),
        SIMULATOR_FIXTURE_RUNTIME: process.execPath,
        SIMULATOR_FIXTURE_EXIT_AFTER_READY: '1',
      },
    })
    const manifest = fixtureManifest(entrypoint)
    await manager.start({ manifest, activatedRoot: root, platform: currentPlatform() })
    const childPid = Number(await readFile(childPidFile, 'utf8'))
    const deadline = Date.now() + 5_000
    while (manager.get(manifest.id)?.state !== 'crashed' && Date.now() < deadline) await Bun.sleep(10)
    expect(manager.get(manifest.id)).toMatchObject({
      state: 'crashed',
      diagnostic: { code: 'RESTART_BUDGET_EXHAUSTED' },
    })
    await waitForExit(childPid)
  }, 30_000)
})
