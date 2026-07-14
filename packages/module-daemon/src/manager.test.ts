import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseModuleManifest, type ModuleArtifact, type ModuleManifest, type ModulePlatform } from '@simulator/module-contract'
import { ModuleDaemonManager } from './manager.ts'
import { ModuleDaemonError, type ActivationAdapter, type ModuleDaemonSnapshot } from './types.ts'
import { FakeClock, FakeHealthAdapter, FakeProcessAdapter } from './testing/fakes.ts'
import { createMinimalEnvironment } from './safety.ts'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function currentPlatform(): ModulePlatform {
  return `${process.platform}-${process.arch}` as ModulePlatform
}

function manifest(id = 'org.simulator.daemon', entrypoint = 'bin/daemon', version = '1.2.3'): ModuleManifest {
  const result = parseModuleManifest({
    schemaVersion: 1,
    id,
    version,
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
  test('reserves host-owned env and rejects Windows case-folded duplicates', () => {
    const values = {
      id: 'org.simulator.daemon',
      version: '1.2.3',
      endpoint: { host: '127.0.0.1' as const, port: 41_000 },
    }
    expect(() => createMinimalEnvironment({ simulator_module_id: 'shadow' }, values, 'win32'))
      .toThrow('cannot override host-owned')
    expect(() => createMinimalEnvironment({ Path: 'one', PATH: 'two' }, values, 'win32'))
      .toThrow('duplicate entry')
    expect(() => createMinimalEnvironment({ SIMULATOR_MODULE_ID: 'shadow' }, values, 'linux'))
      .toThrow('cannot override host-owned')
    expect(() => createMinimalEnvironment({ SIMULATOR_MODULE_DATA_ROOT: '/tmp/shadow' }, values, 'linux'))
      .toThrow('cannot override host-owned')
  })

  test('injects a host-derived persistent data root without exposing it to base env overrides', async () => {
    const root = await activatedRoot()
    const moduleDataRoot = join(tmpdir(), 'simulator-module-data')
    const { manager, processAdapter } = harness({ moduleDataRoot })

    const started = await manager.start({ manifest: manifest(), activatedRoot: root, platform: currentPlatform() })
    expect(processAdapter.requests[0]!.env.SIMULATOR_MODULE_DATA_ROOT)
      .toBe(join(moduleDataRoot, 'org.simulator.daemon'))
    await manager.stop(started.id)
  })

  test('rejects a relative or non-normalized module data root', () => {
    expect(() => harness({ moduleDataRoot: 'relative' })).toThrow('normalized absolute path')
    expect(() => harness({ moduleDataRoot: '/tmp/../tmp/modules' })).toThrow('normalized absolute path')
  })

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

  test('rejects an entrypoint link that escapes the activated root', async () => {
    const root = await activatedRoot('bin/inside')
    const outsideRoot = await activatedRoot('outside/daemon')
    await symlink(
      join(outsideRoot, 'outside'),
      join(root, 'bin/escape'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    const { manager } = harness()

    await expect(manager.start({
      manifest: manifest('org.simulator.escape', 'bin/escape/daemon'),
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

  test('retains process ownership when explicit cleanup fails and retries stop', async () => {
    const root = await activatedRoot()
    const { manager, processAdapter } = harness()
    const started = await manager.start({ manifest: manifest(), activatedRoot: root, platform: currentPlatform() })
    const ownedProcess = processAdapter.processes[0]!
    ownedProcess.failStopNext()

    await expect(manager.stop(started.id)).rejects.toMatchObject({ code: 'PROCESS_CLEANUP_FAILED' })
    expect(manager.get(started.id)).toMatchObject({
      state: 'crashed',
      pid: ownedProcess.pid,
      diagnostic: { code: 'PROCESS_CLEANUP_FAILED' },
    })
    expect(ownedProcess.stopCalls).toBe(1)
    await expect(manager.start({ manifest: manifest(), activatedRoot: root, platform: currentPlatform() }))
      .rejects.toMatchObject({ code: 'PROCESS_CLEANUP_FAILED' })
    expect(processAdapter.processes).toHaveLength(1)

    await expect(manager.stop(started.id)).resolves.toMatchObject({ state: 'stopped' })
    expect(manager.get(started.id)?.pid).toBeUndefined()
    expect(ownedProcess.stopCalls).toBe(2)
  })

  test('does not restart after leader crash when tree cleanup fails and permits later retry', async () => {
    const root = await activatedRoot()
    const { manager, processAdapter, clock } = harness({ restartBackoffMs: [10] })
    const started = await manager.start({ manifest: manifest(), activatedRoot: root, platform: currentPlatform() })
    const ownedProcess = processAdapter.processes[0]!
    ownedProcess.failStopNext()
    ownedProcess.crash(17)

    await waitFor(() => manager.get(started.id)?.diagnostic?.code === 'PROCESS_CLEANUP_FAILED')
    expect(manager.get(started.id)).toMatchObject({ state: 'crashed', pid: ownedProcess.pid })
    await clock.advance(10)
    await settle()
    expect(processAdapter.processes).toHaveLength(1)

    ownedProcess.failStopNext()
    await expect(manager.stop(started.id)).rejects.toMatchObject({ code: 'PROCESS_CLEANUP_FAILED' })
    expect(manager.get(started.id)).toMatchObject({ state: 'crashed', pid: ownedProcess.pid })
    await expect(manager.stop(started.id)).resolves.toMatchObject({ state: 'stopped' })
    expect(manager.get(started.id)?.pid).toBeUndefined()
    expect(ownedProcess.stopCalls).toBe(3)
  })

  test('cancels a pending start during activation resolution before spawn', async () => {
    const root = await activatedRoot()
    let releaseResolution!: () => void
    let resolutionStarted!: () => void
    const startedResolution = new Promise<void>((resolve) => { resolutionStarted = resolve })
    const resolutionGate = new Promise<void>((resolve) => { releaseResolution = resolve })
    const activation: ActivationAdapter = {
      async resolveEntrypoint(activatedRoot: string, artifact: ModuleArtifact) {
        resolutionStarted()
        await resolutionGate
        return {
          activatedRoot: await realpath(activatedRoot),
          executable: await realpath(join(activatedRoot, ...artifact.entrypoint.split('/'))),
        }
      },
    }
    const { manager, processAdapter } = harness({ activation })
    const moduleManifest = manifest('org.simulator.slow-realpath')
    const starting = manager.start({ manifest: moduleManifest, activatedRoot: root, platform: currentPlatform() })
    await startedResolution
    const stopping = manager.stop(moduleManifest.id)
    releaseResolution()

    await expect(stopping).resolves.toMatchObject({ state: 'stopped', diagnostic: { code: 'STOP_REQUESTED' } })
    await expect(starting).rejects.toMatchObject({ code: 'STOP_REQUESTED' })
    expect(processAdapter.requests).toHaveLength(0)
  })

  test('stop cancels a pending version and a queued replacement before either can spawn', async () => {
    const root = await activatedRoot()
    let releaseResolution!: () => void
    let resolutionStarted!: () => void
    const startedResolution = new Promise<void>((resolve) => { resolutionStarted = resolve })
    const resolutionGate = new Promise<void>((resolve) => { releaseResolution = resolve })
    const activation: ActivationAdapter = {
      async resolveEntrypoint(activatedRoot: string, artifact: ModuleArtifact) {
        resolutionStarted()
        await resolutionGate
        return {
          activatedRoot: await realpath(activatedRoot),
          executable: await realpath(join(activatedRoot, ...artifact.entrypoint.split('/'))),
        }
      },
    }
    const { manager, processAdapter } = harness({ activation })
    const id = 'org.simulator.queued-stop'
    const moduleId = manifest(id).id
    const request = (version: string) => ({
      manifest: manifest(id, 'bin/daemon', version),
      activatedRoot: root,
      platform: currentPlatform(),
    })
    const versionOne = manager.start(request('1.0.0'))
    const versionTwo = manager.start(request('2.0.0'))
    await startedResolution
    const stopping = manager.stop(moduleId)
    let stopSettled = false
    void stopping.finally(() => { stopSettled = true })
    await settle()
    expect(stopSettled).toBe(false)
    await expect(manager.start(request('3.0.0'))).rejects.toMatchObject({ code: 'STOP_REQUESTED' })
    releaseResolution()

    await expect(stopping).resolves.toMatchObject({ state: 'stopped' })
    await expect(versionOne).rejects.toMatchObject({ code: 'STOP_REQUESTED' })
    await expect(versionTwo).rejects.toMatchObject({ code: 'STOP_REQUESTED' })
    expect(processAdapter.requests).toHaveLength(0)
    expect(manager.get(moduleId)).toMatchObject({ state: 'stopped' })

    const restarted = await manager.start(request('2.0.0'))
    expect(restarted).toMatchObject({ state: 'healthy', version: '2.0.0' })
    expect(processAdapter.requests).toHaveLength(1)
    await manager.stop(moduleId)
  })

  test('stop invalidates every version already queued for a module', async () => {
    const root = await activatedRoot()
    let releaseResolution!: () => void
    let resolutionStarted!: () => void
    const startedResolution = new Promise<void>((resolve) => { resolutionStarted = resolve })
    const resolutionGate = new Promise<void>((resolve) => { releaseResolution = resolve })
    const activation: ActivationAdapter = {
      async resolveEntrypoint(activatedRoot: string, artifact: ModuleArtifact) {
        resolutionStarted()
        await resolutionGate
        return {
          activatedRoot: await realpath(activatedRoot),
          executable: await realpath(join(activatedRoot, ...artifact.entrypoint.split('/'))),
        }
      },
    }
    const { manager, processAdapter } = harness({ activation })
    const id = 'org.simulator.many-queued'
    const moduleId = manifest(id).id
    const starts = ['1.0.0', '2.0.0', '3.0.0', '4.0.0'].map((version) => manager.start({
      manifest: manifest(id, 'bin/daemon', version),
      activatedRoot: root,
      platform: currentPlatform(),
    }))
    await startedResolution
    const stopping = manager.stop(moduleId)
    releaseResolution()

    await stopping
    const results = await Promise.allSettled(starts)
    expect(results.every((result) => result.status === 'rejected'
      && result.reason instanceof ModuleDaemonError
      && result.reason.code === 'STOP_REQUESTED')).toBe(true)
    expect(processAdapter.requests).toHaveLength(0)
    expect(manager.get(moduleId)?.state).toBe('stopped')
  })

  test('publishes the stop gate before a stopping subscriber can reenter start or stop', async () => {
    const root = await activatedRoot()
    let releaseSecondResolution!: () => void
    const secondResolutionGate = new Promise<void>((resolve) => { releaseSecondResolution = resolve })
    let resolutionCalls = 0
    const activation: ActivationAdapter = {
      async resolveEntrypoint(activatedRoot: string, artifact: ModuleArtifact) {
        resolutionCalls += 1
        if (resolutionCalls === 2) await secondResolutionGate
        return {
          activatedRoot: await realpath(activatedRoot),
          executable: await realpath(join(activatedRoot, ...artifact.entrypoint.split('/'))),
        }
      },
    }
    const { manager, processAdapter } = harness({ activation })
    const id = manifest('org.simulator.reentrant-stop').id
    const request = (version: string) => ({
      manifest: manifest(id, 'bin/daemon', version),
      activatedRoot: root,
      platform: currentPlatform(),
    })
    await manager.start(request('1.0.0'))
    let reentrantStart: Promise<ModuleDaemonSnapshot> | undefined
    let reentrantStop: Promise<ModuleDaemonSnapshot | undefined> | undefined
    manager.subscribe((snapshot) => {
      if (snapshot.id === id && snapshot.state === 'stopping' && !reentrantStart) {
        reentrantStart = manager.start(request('2.0.0'))
        reentrantStop = manager.stop(id)
      }
    })

    const stopping = manager.stop(id)
    const stopped = await stopping
    await expect(reentrantStart!).rejects.toMatchObject({ code: 'STOP_REQUESTED' })
    expect(reentrantStop).toBe(stopping)
    await expect(reentrantStop!).resolves.toEqual(stopped)
    expect(resolutionCalls).toBe(1)
    expect(processAdapter.processes).toHaveLength(1)

    const restarted = manager.start(request('2.0.0'))
    await settle()
    expect(resolutionCalls).toBe(2)
    expect(processAdapter.processes).toHaveLength(1)
    releaseSecondResolution()
    await expect(restarted).resolves.toMatchObject({ state: 'healthy', version: '2.0.0' })
    expect(processAdapter.processes).toHaveLength(2)
    await manager.stop(id)
  })

  test('drain cancels a pending activation resolution before spawn', async () => {
    const root = await activatedRoot()
    let releaseResolution!: () => void
    let resolutionStarted!: () => void
    const startedResolution = new Promise<void>((resolve) => { resolutionStarted = resolve })
    const resolutionGate = new Promise<void>((resolve) => { releaseResolution = resolve })
    const activation: ActivationAdapter = {
      async resolveEntrypoint(activatedRoot: string, artifact: ModuleArtifact) {
        resolutionStarted()
        await resolutionGate
        return {
          activatedRoot: await realpath(activatedRoot),
          executable: await realpath(join(activatedRoot, ...artifact.entrypoint.split('/'))),
        }
      },
    }
    const { manager, processAdapter } = harness({ activation })
    const moduleManifest = manifest('org.simulator.slow-drain')
    const starting = manager.start({ manifest: moduleManifest, activatedRoot: root, platform: currentPlatform() })
    await startedResolution
    const draining = manager.drain()
    releaseResolution()

    await draining
    await expect(starting).rejects.toMatchObject({ code: 'STOP_REQUESTED' })
    expect(processAdapter.requests).toHaveLength(0)
  })

  test('drain invalidates all queued versions and permanently rejects later starts', async () => {
    const root = await activatedRoot()
    let releaseResolution!: () => void
    let resolutionStarted!: () => void
    const startedResolution = new Promise<void>((resolve) => { resolutionStarted = resolve })
    const resolutionGate = new Promise<void>((resolve) => { releaseResolution = resolve })
    const activation: ActivationAdapter = {
      async resolveEntrypoint(activatedRoot: string, artifact: ModuleArtifact) {
        resolutionStarted()
        await resolutionGate
        return {
          activatedRoot: await realpath(activatedRoot),
          executable: await realpath(join(activatedRoot, ...artifact.entrypoint.split('/'))),
        }
      },
    }
    const { manager, processAdapter } = harness({ activation })
    const id = 'org.simulator.queued-drain'
    const moduleId = manifest(id).id
    const requests = ['1.0.0', '2.0.0', '3.0.0'].map((version) => ({
      manifest: manifest(id, 'bin/daemon', version),
      activatedRoot: root,
      platform: currentPlatform(),
    }))
    const starts = requests.map((request) => manager.start(request))
    await startedResolution
    const draining = manager.drain()
    releaseResolution()

    await draining
    const results = await Promise.allSettled(starts)
    expect(results.every((result) => result.status === 'rejected')).toBe(true)
    expect(processAdapter.requests).toHaveLength(0)
    expect(manager.get(moduleId)?.state).toBe('stopped')
    await expect(manager.start(requests[2]!)).rejects.toMatchObject({ code: 'MANAGER_DRAINING' })
  })

  test('publishes draining before a stopping subscriber can reenter start', async () => {
    const root = await activatedRoot()
    const { manager, processAdapter } = harness()
    const id = manifest('org.simulator.reentrant-drain').id
    const firstRequest = {
      manifest: manifest(id, 'bin/daemon', '1.0.0'),
      activatedRoot: root,
      platform: currentPlatform(),
    }
    const secondRequest = {
      manifest: manifest(id, 'bin/daemon', '2.0.0'),
      activatedRoot: root,
      platform: currentPlatform(),
    }
    await manager.start(firstRequest)
    let reentrantStart: Promise<ModuleDaemonSnapshot> | undefined
    manager.subscribe((snapshot) => {
      if (snapshot.id === id && snapshot.state === 'stopping' && !reentrantStart) {
        reentrantStart = manager.start(secondRequest)
      }
    })

    await manager.drain()
    await expect(reentrantStart!).rejects.toMatchObject({ code: 'MANAGER_DRAINING' })
    expect(processAdapter.processes).toHaveLength(1)
    expect(manager.get(id)?.state).toBe('stopped')
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

  test('start during restart backoff joins the existing supervisor', async () => {
    const root = await activatedRoot()
    const { manager, processAdapter, clock } = harness({ restartBackoffMs: [50] })
    const request = { manifest: manifest(), activatedRoot: root, platform: currentPlatform() }
    const started = await manager.start(request)
    processAdapter.processes[0]!.crash()
    await waitFor(() => manager.get(started.id)?.state === 'crashed')

    const restarted = manager.start(request)
    await settle()
    expect(processAdapter.processes).toHaveLength(1)
    await clock.advance(50)
    const recovered = await restarted
    expect(recovered).toMatchObject({ state: 'healthy', restartCount: 1 })
    expect(processAdapter.processes).toHaveLength(2)
    await manager.stop(started.id)
  })

  test('throwing subscribers cannot alter daemon supervision', async () => {
    const root = await activatedRoot()
    const listenerErrors: unknown[] = []
    const { manager, processAdapter } = harness({
      onListenerError: (error) => listenerErrors.push(error),
    })
    manager.subscribe(() => {
      throw new Error('listener failure')
    })

    const started = await manager.start({ manifest: manifest(), activatedRoot: root, platform: currentPlatform() })
    expect(started.state).toBe('healthy')
    expect(processAdapter.processes).toHaveLength(1)
    expect(listenerErrors.length).toBeGreaterThan(0)
    await manager.stop(started.id)
  })

  test('idle deadline aborts a pending health probe', async () => {
    const root = await activatedRoot()
    const { manager, health, clock } = harness({
      healthIntervalMs: 5,
      healthTimeoutMs: 100,
      idleTimeoutMs: 20,
    })
    const started = await manager.start({ manifest: manifest(), activatedRoot: root, platform: currentPlatform() })
    health.queuePendingProbe()
    await clock.advance(5)
    await waitFor(() => health.checks.length >= 2)
    expect(health.checks.at(-1)?.timeoutMs).toBe(15)
    await clock.advance(15)
    await waitFor(() => manager.get(started.id)?.state === 'stopped')
    expect(manager.get(started.id)?.diagnostic?.code).toBe('IDLE_TIMEOUT')
  })

  test('canonical root aliases deduplicate to one active process', async () => {
    if (process.platform === 'win32') return
    const root = await activatedRoot()
    const aliasParent = await mkdtemp(join(tmpdir(), 'simulator-daemon-alias-'))
    temporaryRoots.push(aliasParent)
    const alias = join(aliasParent, 'activated')
    await symlink(root, alias)
    const { manager, processAdapter } = harness()
    const moduleManifest = manifest()

    const first = await manager.start({ manifest: moduleManifest, activatedRoot: root, platform: currentPlatform() })
    const second = await manager.start({ manifest: moduleManifest, activatedRoot: alias, platform: currentPlatform() })
    expect(second.pid).toBe(first.pid)
    expect(processAdapter.processes).toHaveLength(1)
    await manager.stop(first.id)
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
