import { describe, expect, it } from 'bun:test'
import type { ModuleId, ModuleVersion } from '@simulator/module-contract'
import type { ModuleDaemonSnapshot } from '@simulator/module-daemon'
import type { HostModuleCoordinatorRuntime } from './host-module-coordinator'
import {
  ModuleAgentWorkerRecoveryController,
  type ModuleAgentWorkerRecoveryPhase,
} from './module-agent-worker-recovery'
import {
  createOpenDesignMutationGate,
  type OpenDesignMutationGate,
} from './open-design-mutation-gate'

const MODULE_ID = 'org.simulator.open-design' as ModuleId

function daemon(
  version = '0.14.6-rc.1',
  state: ModuleDaemonSnapshot['state'] = 'healthy',
): ModuleDaemonSnapshot {
  return {
    id: MODULE_ID,
    version: version as ModuleVersion,
    state,
    restartCount: 0,
  }
}

function harness(
  initial = daemon(),
  mutationGate: OpenDesignMutationGate = createOpenDesignMutationGate(),
) {
  let current: ModuleDaemonSnapshot | undefined = initial
  let shuttingDown = false
  const calls: string[] = []
  const failures: string[] = []
  let restartResult: { ok: boolean; error?: string } = { ok: true }
  let stopResult: { ok: boolean; error?: string } = { ok: true }
  let restartGate: Promise<void> | undefined
  const runtime = {
    daemon: { get: () => current },
    coordinator: {
      async restart(input: { operationId?: string }) {
        calls.push(`restart:${input.operationId}`)
        await restartGate
        return restartResult
      },
      async stop(input: { operationId?: string }) {
        calls.push(`stop:${input.operationId}`)
        return stopResult
      },
    },
  } as unknown as HostModuleCoordinatorRuntime
  let operation = 0
  const controller = new ModuleAgentWorkerRecoveryController({
    moduleId: MODULE_ID,
    getRuntime: () => runtime,
    mutationGate,
    isShuttingDown: () => shuttingDown,
    protocolForVersion: (version) => version === '0.14.5' ? 'v1' : 'v2',
    createOperationId: (phase) => `${phase}-${++operation}`,
    onFailure: (phase, _request, error) => failures.push(`${phase}:${error instanceof Error ? error.message : String(error)}`),
  })
  const request = (overrides: Partial<Parameters<typeof controller.request>[0]> = {}) => controller.request({
    protocol: 'v2',
    epoch: 'epoch-v2',
    failure: 'unexpected-exit',
    circuitOpen: false,
    ...overrides,
  })
  return {
    controller,
    mutationGate,
    calls,
    failures,
    request,
    setDaemon(value: ModuleDaemonSnapshot | undefined) { current = value },
    setShuttingDown(value: boolean) { shuttingDown = value },
    setRestartResult(value: typeof restartResult) { restartResult = value },
    setStopResult(value: typeof stopResult) { stopResult = value },
    setRestartGate(value: Promise<void> | undefined) { restartGate = value },
  }
}

describe('ModuleAgentWorkerRecoveryController', () => {
  it('waits behind an active mutation, blocks new UI leases, and then completes recovery exactly once', async () => {
    const mutationGate = createOpenDesignMutationGate()
    const activeAcceptance = mutationGate.tryAcquire('acceptance')!
    const system = harness(daemon(), mutationGate)

    system.request()
    await Bun.sleep(0)
    expect(system.calls).toEqual([])
    expect(mutationGate.tryAcquire('ordinary')).toBeUndefined()
    expect(mutationGate.tryAcquire('acceptance')).toBeUndefined()

    activeAcceptance.release()
    await system.controller.drain()
    expect(system.calls).toEqual(['restart:restart-1'])
    const afterRecovery = mutationGate.tryAcquire('ordinary')
    expect(afterRecovery).toBeDefined()
    afterRecovery?.release()
  })

  it('queues a circuit safety stop without running concurrently with the active mutation', async () => {
    const mutationGate = createOpenDesignMutationGate()
    const activeOrdinary = mutationGate.tryAcquire('ordinary')!
    const system = harness(daemon(), mutationGate)

    system.request({ circuitOpen: true })
    await Bun.sleep(0)
    expect(system.calls).toEqual([])
    activeOrdinary.release()
    await system.controller.drain()
    expect(system.calls).toEqual(['stop:circuit-stop-1'])
  })

  it('rotates the daemon once after local Worker cleanup and serializes repeated exits', async () => {
    const system = harness()
    let release!: () => void
    system.setRestartGate(new Promise<void>((resolve) => { release = resolve }))
    system.request()
    system.request({ epoch: 'epoch-v2-next' })
    await Bun.sleep(0)
    expect(system.calls).toEqual(['restart:restart-1'])
    release()
    await system.controller.drain()
    expect(system.calls).toEqual(['restart:restart-1', 'restart:restart-2'])
    expect(system.failures).toEqual([])
  })

  it('stops only the optional Module when the protocol circuit is open', async () => {
    const system = harness()
    system.request({ circuitOpen: true })
    await system.controller.drain()
    expect(system.calls).toEqual(['stop:circuit-stop-1'])
  })

  it('rotates the daemon before grant expiry without opening the circuit', async () => {
    const system = harness()
    system.request({ failure: 'grant-expiring', circuitOpen: false })
    await system.controller.drain()
    expect(system.calls).toEqual(['restart:restart-1'])
    expect(system.failures).toEqual([])
  })

  it('fails closed to stop when restart cannot rotate the launch lease', async () => {
    const system = harness()
    system.setRestartResult({ ok: false, error: 'restart denied' })
    system.request()
    await system.controller.drain()
    expect(system.calls).toEqual(['restart:restart-1', 'stop:fallback-stop-2'])
    expect(system.failures).toEqual(['restart:restart denied'])
  })

  it('contains stop and diagnostic failures without rejecting drain', async () => {
    const system = harness()
    system.setStopResult({ ok: false, error: 'stop denied' })
    system.request({ circuitOpen: true })
    await expect(system.controller.drain()).resolves.toBeUndefined()
    expect(system.failures).toEqual(['circuit-stop:stop denied'])
  })

  it('ignores inactive, mismatched, shutdown, and disposed recovery work', async () => {
    const system = harness()
    system.setDaemon(daemon('0.14.6-rc.1', 'stopped'))
    system.request()
    system.setDaemon(daemon('0.14.5'))
    system.request({ protocol: 'v2' })
    system.setShuttingDown(true)
    system.request({ protocol: 'v1' })
    await system.controller.drain()
    system.setShuttingDown(false)
    system.controller.dispose()
    system.request({ protocol: 'v1' })
    await system.controller.drain()
    expect(system.calls).toEqual([])
  })

  it('stops an active unsupported version instead of guessing its contract', async () => {
    const system = harness(daemon('0.14.7'))
    // Replace the default resolver's permissive v2 branch with a rejecting
    // controller to exercise the production fail-closed path.
    const phases: ModuleAgentWorkerRecoveryPhase[] = []
    const runtime = {
      daemon: { get: () => daemon('0.14.7') },
      coordinator: {
        restart: async () => { throw new Error('must not restart') },
        stop: async () => {
          phases.push('circuit-stop')
          return { ok: true }
        },
      },
    } as unknown as HostModuleCoordinatorRuntime
    const controller = new ModuleAgentWorkerRecoveryController({
      moduleId: MODULE_ID,
      getRuntime: () => runtime,
      mutationGate: createOpenDesignMutationGate(),
      isShuttingDown: () => false,
      protocolForVersion: () => { throw new Error('unsupported') },
      createOperationId: (phase) => phase,
    })
    controller.request({ protocol: 'v2', epoch: 'old', failure: 'unexpected-exit', circuitOpen: false })
    await controller.drain()
    expect(phases).toEqual(['circuit-stop'])
    expect(system.calls).toEqual([])
  })
})
