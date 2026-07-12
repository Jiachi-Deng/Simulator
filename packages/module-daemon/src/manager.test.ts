import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseModuleManifest, type ModuleId, type ModuleManifest, type ModulePlatform } from '@simulator/module-contract'
import { ModuleDaemonManager } from './manager.ts'
import { ModuleDaemonError, type ModuleDaemonSnapshot } from './types.ts'
import { FakeClock, FakeHealthAdapter, FakeProcessAdapter } from './testing/fakes.ts'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function currentPlatform(): ModulePlatform {
  return `${process.platform}-${process.arch}` as ModulePlatform
}

function manifest(id = 'org.simulator.daemon', entrypoint = 'bin/daemon'): ModuleManifest {
  const result = parseModuleManifest({
    schemaVersion: 1,
    id,
    version: '1.2.3',
    artifacts: [{
      platform: currentPlatform(),
      entrypoint,
      url: 'https://modules.example.test/daemon.tar.gz',
      sha256: 'a'.repeat(64),
    }],
    capabilities: [],
  })
  if (!result.ok) throw new Error(`Invalid test manifest: ${JSON.stringify(result.errors)}`)
  return result.value
}

async function activatedRoot(entrypoint = 'bin/daemon'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'simulator-daemon-unit-'))
  temporaryRoots.push(root)
  const executable = join(root, ...entrypoint.split('/'))
  await mkdir(join(executable, '..'), { recursive: true })
  await writeFile(executable, '#!/bin/sh\nexit 0\n')
  await chmod(executable, 0o755)
  return root
}

function harness(overrides: Partial<ConstructorParameters<typeof ModuleDaemonManager>[0]> = {}) {
  const clock = new FakeClock()
  const processAdapter = new FakeProcessAdapter()
  const health = new FakeHealthAdapter()
  const manager = new ModuleDaemonManager({
    process: processAdapter,
    clock,
    health,
    startupTimeoutMs: 100,
    healthTimeoutMs: 10,
    healthIntervalMs: 10,
    unhealthyThreshold: 2,
    restartLimit: 1,
    restartBackoffMs: [10],
    idleTimeoutMs: 1_000,
    stopGraceMs: 10,
    baseEnvironment: { PATH: '/usr/bin:/bin' },
    ...overrides,
  })
  return { clock, processAdapter, health, manager }
}

async function settle(turns = 12): Promise<void> {
  for (let index = 0; index < turns; index += 1) await Promise.resolve()
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000
  while (!predicate() && Date.now() < deadline) await Bun.sleep(1)
  expect(predicate()).toBe(true)
}

describe('ModuleDaemonManager', () => {
  test('starts healthy with a contained entrypoint, minimal env, and shell disabled', async () => {
    const root = await activatedRoot()
    const { manager, processAdapter } = harness()

    const started = await manager.start({ manifest: manifest(), activatedRoot: root, platform: currentPlatform() })
    expect(started.state).toBe('healthy')
    expect(started.endpoint?.host).toBe('127.0.0.1')
    expect(processAdapter.requests).toHaveLength(1)
    expect(processAdapter.requests[0]).toMatchObject({
      args: [],
      cwd: await realpath(root),
      shell: false,
    })
    expect(processAdapter.requests[0]!.env).toEqual({
      PATH: '/usr/bin:/bin',
      SIMULATOR_MODULE_ID: 'org.simulator.daemon',
      SIMULATOR_MODULE_VERSION: '1.2.3',
      SIMULATOR_MODULE_HEALTH_HOST: '127.0.0.1',
      SIMULATOR_MODULE_HEALTH_PORT: String(started.endpoint!.port),
    })
    expect(processAdapter.requests[0]!.env.HOME).toBeUndefined()
    expect(await manager.stop(started.id)).toMatchObject({ state: 'stopped' })
  })

  test('rejects an entrypoint symlink that escapes the activated root', async () => {
    if (process.platform === 'win32') return
    const root = await activatedRoot('bin/inside')
    const outsideRoot = await activatedRoot('outside')
    await symlink(join(outsideRoot, 'outside'), join(root, 'bin/escape'))
    const { manager } = harness()

    await expect(manager.start({
      manifest: manifest('org.simulator.escape', 'bin/escape'),
      activatedRoot: root,
      platform: currentPlatform(),
    })).rejects.toMatchObject({ code: 'ENTRYPOINT_OUTSIDE_ACTIVATED_ROOT' })
  })

  test('rejects non-loopback endpoint advertisement', async () => {
    const root = await activatedRoot()
    const { manager, health } = harness({ restartLimit: 0 })
    health.nextHost = '0.0.0.0'
    const states: ModuleDaemonSnapshot[] = []
    manager.subscribe((snapshot) => states.push(snapshot))

    await expect(manager.start({ manifest: manifest(), activatedRoot: root, platform: currentPlatform() }))
      .rejects.toMatchObject({ code: 'RESTART_BUDGET_EXHAUSTED' })
    expect(states.some((snapshot) => snapshot.diagnostic?.code === 'ENDPOINT_NOT_LOOPBACK')).toBe(true)
  })

  test('covers endpoint allocation failure and malformed readiness deterministically', async () => {
    const root = await activatedRoot()
    const allocation = harness({ restartLimit: 0 })
    allocation.health.failAllocationNext()
    const allocationStates: ModuleDaemonSnapshot[] = []
    allocation.manager.subscribe((snapshot) => allocationStates.push(snapshot))
    await expect(allocation.manager.start({ manifest: manifest(), activatedRoot: root, platform: currentPlatform() }))
      .rejects.toBeInstanceOf(ModuleDaemonError)
    expect(allocationStates.some((snapshot) => snapshot.diagnostic?.code === 'ENDPOINT_ALLOCATION_FAILED')).toBe(true)

    const malformed = harness({ restartLimit: 0 })
    malformed.health.queueProbe({ status: 'malformed', detail: 'not readiness JSON' })
    const malformedStates: ModuleDaemonSnapshot[] = []
    malformed.manager.subscribe((snapshot) => malformedStates.push(snapshot))
    await expect(malformed.manager.start({ manifest: manifest(), activatedRoot: root, platform: currentPlatform() }))
      .rejects.toMatchObject({ code: 'RESTART_BUDGET_EXHAUSTED' })
    expect(malformedStates.some((snapshot) => snapshot.diagnostic?.code === 'READINESS_MALFORMED')).toBe(true)
  })

  test('times out startup using the injected clock', async () => {
    const root = await activatedRoot()
    const { manager, health, clock } = harness({ restartLimit: 0 })
    health.defaultResult = { status: 'unhealthy', detail: 'not listening' }
    const states: ModuleDaemonSnapshot[] = []
    manager.subscribe((snapshot) => states.push(snapshot))
    const starting = manager.start({ manifest: manifest(), activatedRoot: root, platform: currentPlatform() })
    await waitFor(() => health.checks.length > 0)
    await clock.advance(100)
    await settle(30)
    await expect(starting).rejects.toMatchObject({ code: 'RESTART_BUDGET_EXHAUSTED' })
    expect(states.some((snapshot) => snapshot.diagnostic?.code === 'STARTUP_TIMEOUT')).toBe(true)
  })

  test('reallocates a fresh endpoint after a collision-like startup timeout', async () => {
    const root = await activatedRoot()
    const { manager, health, processAdapter, clock } = harness({ restartBackoffMs: [10] })
    health.defaultResult = { status: 'unhealthy', detail: 'address already in use' }
    const starting = manager.start({ manifest: manifest(), activatedRoot: root, platform: currentPlatform() })
    await waitFor(() => health.checks.length > 0)
    await clock.advance(100)
    health.defaultResult = { status: 'healthy' }
    await settle(20)
    await clock.advance(10)

    const started = await starting
    expect(processAdapter.processes).toHaveLength(2)
    expect(health.allocated).toHaveLength(2)
    expect(health.allocated[0]).not.toEqual(health.allocated[1])
    expect(started).toMatchObject({ state: 'healthy', restartCount: 1 })
    await manager.stop(started.id)
  })

  test('restarts after crash with bounded backoff and stops after exhaustion', async () => {
    const root = await activatedRoot()
    const { manager, processAdapter, clock } = harness({ restartLimit: 1, restartBackoffMs: [10] })
    const started = await manager.start({ manifest: manifest(), activatedRoot: root, platform: currentPlatform() })

    processAdapter.processes[0]!.crash(7)
    await settle()
    expect(manager.get(started.id)?.state).toBe('crashed')
    expect(processAdapter.processes).toHaveLength(1)
    await clock.advance(10)
    await settle(30)
    expect(processAdapter.processes).toHaveLength(2)
    expect(manager.get(started.id)).toMatchObject({ state: 'healthy', restartCount: 1 })

    processAdapter.processes[1]!.crash(8)
    await settle()
    expect(manager.get(started.id)).toMatchObject({
      state: 'crashed',
      diagnostic: { code: 'RESTART_BUDGET_EXHAUSTED' },
    })
    expect(processAdapter.processes).toHaveLength(2)
  })

  test('tracks degraded health and restarts after the failure threshold', async () => {
    const root = await activatedRoot()
    const { manager, processAdapter, health, clock } = harness({ restartBackoffMs: [0] })
    const started = await manager.start({ manifest: manifest(), activatedRoot: root, platform: currentPlatform() })
    health.queueProbe(
      { status: 'unhealthy', detail: 'probe one' },
      { status: 'unhealthy', detail: 'probe two' },
    )

    await clock.advance(10)
    await settle()
    expect(manager.get(started.id)?.state).toBe('degraded')
    await clock.advance(10)
    await waitFor(() => manager.get(started.id)?.state === 'healthy')
    expect(processAdapter.processes).toHaveLength(2)
    expect(manager.get(started.id)).toMatchObject({ state: 'healthy', restartCount: 1 })
    await manager.stop(started.id)
  })

  test('classifies repeated health probe timeouts before bounded restart', async () => {
    const root = await activatedRoot()
    const { manager, health, clock } = harness({ restartBackoffMs: [10] })
    const diagnostics: string[] = []
    manager.subscribe((snapshot) => {
      if (snapshot.diagnostic) diagnostics.push(snapshot.diagnostic.code)
    })
    const started = await manager.start({ manifest: manifest(), activatedRoot: root, platform: currentPlatform() })
    health.queueProbe(
      { status: 'unhealthy', detail: 'Health probe timed out' },
      { status: 'unhealthy', detail: 'Health probe timed out' },
    )
    await clock.advance(10)
    await settle()
    await clock.advance(10)
    await settle()

    expect(diagnostics).toContain('HEALTH_TIMEOUT')
    expect(manager.get(started.id)?.state).toBe('crashed')
    await manager.stop(started.id)
  })

  test('stops idle daemons without spending restart budget', async () => {
    const root = await activatedRoot()
    const { manager, clock } = harness({ idleTimeoutMs: 20, healthIntervalMs: 5 })
    const started = await manager.start({ manifest: manifest(), activatedRoot: root, platform: currentPlatform() })
    await clock.advance(20)
    await settle()

    expect(manager.get(started.id)).toMatchObject({
      state: 'stopped',
      restartCount: 0,
      diagnostic: { code: 'IDLE_TIMEOUT' },
    })
  })

  test('stop during readiness is race-safe and idempotent', async () => {
    const root = await activatedRoot()
    const { manager, health, processAdapter } = harness()
    health.queuePendingProbe()
    const starting = manager.start({ manifest: manifest(), activatedRoot: root, platform: currentPlatform() })
    await waitFor(() => processAdapter.requests.length === 1)
    const id = manifest().id

    const [first, second] = await Promise.all([manager.stop(id), manager.stop(id)])
    expect(first).toEqual(second)
    expect(first?.state).toBe('stopped')
    await expect(starting).rejects.toMatchObject({ code: 'STOP_REQUESTED' })
    expect(processAdapter.processes[0]!.stopCalls).toBeGreaterThanOrEqual(1)
  })

  test('stop during a health probe and restart backoff cannot launch a replacement', async () => {
    const healthRoot = await activatedRoot()
    const healthHarness = harness()
    const healthStarted = await healthHarness.manager.start({
      manifest: manifest('org.simulator.health-stop'),
      activatedRoot: healthRoot,
      platform: currentPlatform(),
    })
    healthHarness.health.queuePendingProbe()
    await healthHarness.clock.advance(10)
    await waitFor(() => healthHarness.health.checks.length >= 2)
    await healthHarness.manager.stop(healthStarted.id)
    expect(healthHarness.manager.get(healthStarted.id)?.state).toBe('stopped')
    expect(healthHarness.processAdapter.processes).toHaveLength(1)

    const restartRoot = await activatedRoot()
    const restartHarness = harness({ restartBackoffMs: [50] })
    const restartStarted = await restartHarness.manager.start({
      manifest: manifest('org.simulator.restart-stop'),
      activatedRoot: restartRoot,
      platform: currentPlatform(),
    })
    restartHarness.processAdapter.processes[0]!.crash()
    await waitFor(() => restartHarness.manager.get(restartStarted.id)?.state === 'crashed')
    await restartHarness.manager.stop(restartStarted.id)
    await restartHarness.clock.advance(50)
    await settle()
    expect(restartHarness.manager.get(restartStarted.id)?.state).toBe('stopped')
    expect(restartHarness.processAdapter.processes).toHaveLength(1)
  })

  test('deduplicates concurrent starts for the same activated module', async () => {
    const root = await activatedRoot()
    const { manager, processAdapter } = harness()
    const request = { manifest: manifest(), activatedRoot: root, platform: currentPlatform() }
    const [first, second] = await Promise.all([manager.start(request), manager.start(request)])
    expect(first).toEqual(second)
    expect(processAdapter.processes).toHaveLength(1)
    await manager.stop(first.id)
  })

  test('isolates concurrent process, environment, and endpoint state', async () => {
    const rootA = await activatedRoot()
    const rootB = await activatedRoot()
    const { manager, processAdapter } = harness()
    const [a, b] = await Promise.all([
      manager.start({ manifest: manifest('org.simulator.alpha'), activatedRoot: rootA, platform: currentPlatform() }),
      manager.start({ manifest: manifest('org.simulator.beta'), activatedRoot: rootB, platform: currentPlatform() }),
    ])

    expect(a.pid).not.toBe(b.pid)
    expect(a.endpoint).not.toEqual(b.endpoint)
    expect(processAdapter.requests.map((request) => request.env.SIMULATOR_MODULE_ID).sort())
      .toEqual(['org.simulator.alpha', 'org.simulator.beta'])
    await manager.drain()
    expect(manager.list().every((snapshot) => snapshot.state === 'stopped')).toBe(true)
    await expect(manager.start({ manifest: manifest('org.simulator.gamma'), activatedRoot: rootA, platform: currentPlatform() }))
      .rejects.toMatchObject({ code: 'MANAGER_DRAINING' })
  })
})
