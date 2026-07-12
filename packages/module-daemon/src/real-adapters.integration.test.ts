import { afterAll, describe, expect, test } from 'bun:test'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
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

function fixtureManifest(): ModuleManifest {
  const parsed = parseModuleManifest({
    schemaVersion: 1,
    id: 'org.simulator.real-fixture',
    version: '1.0.0',
    artifacts: [{
      platform: currentPlatform(),
      entrypoint: 'bin/daemon-fixture.ts',
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
  test.skipIf(process.platform === 'win32')('runs 20 start/stop cycles without parent or descendant orphans', async () => {
    const root = await mkdtemp(join(tmpdir(), 'simulator-daemon-real-'))
    roots.push(root)
    const executable = join(root, 'bin/daemon-fixture.ts')
    await mkdir(dirname(executable), { recursive: true })
    await copyFile(join(import.meta.dir, 'testing/fixtures/daemon-fixture.ts'), executable)
    await chmod(executable, 0o755)
    const childPidFile = join(root, 'child.pid')
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
      baseEnvironment: {
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        SIMULATOR_FIXTURE_CHILD_PID_FILE: childPidFile,
      },
    })

    const manifest = fixtureManifest()
    const endpoints = new Set<number>()
    for (let cycle = 0; cycle < 20; cycle += 1) {
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
    }

    expect(endpoints.size).toBeGreaterThan(1)
    await manager.drain()
  }, 30_000)
})
