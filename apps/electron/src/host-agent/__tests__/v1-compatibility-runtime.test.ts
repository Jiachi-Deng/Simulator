import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ISessionManager } from '@craft-agent/server-core/handlers'
import type { HostAgentMessagePortLike } from '@simulator/host-agent-broker/message-port'
import type { ModuleDaemonLaunchContext } from '@simulator/module-daemon'
import { createV1UtilityCompatibilityRuntime } from '../v1-compatibility-runtime'
import { startV1CompatibilityWorker } from '../v1-worker-runtime'
import type { HostAgentWorkerSupervisor } from '../supervisor'

type PortEvent = 'message' | 'close' | 'messageerror'

class PairedPort implements HostAgentMessagePortLike {
  peer?: PairedPort
  readonly #listeners = new Map<PortEvent, Set<(message?: unknown) => void>>()
  #closed = false

  postMessage(message: unknown): void {
    if (!this.peer || this.#closed || this.peer.#closed) throw new Error('port closed')
    const peer = this.peer
    queueMicrotask(() => peer.#emit('message', { data: message }))
  }

  on(event: PortEvent, listener: (message?: unknown) => void): this {
    let listeners = this.#listeners.get(event)
    if (!listeners) this.#listeners.set(event, listeners = new Set())
    listeners.add(listener)
    return this
  }

  off(event: PortEvent, listener: (message?: unknown) => void): this {
    this.#listeners.get(event)?.delete(listener)
    return this
  }

  start(): void {}

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#emit('close')
    const peer = this.peer
    if (peer) peer.#emit('close')
  }

  #emit(event: PortEvent, message?: unknown): void {
    for (const listener of this.#listeners.get(event) ?? []) listener(message)
  }
}

function pair(): [PairedPort, PairedPort] {
  const host = new PairedPort()
  const worker = new PairedPort()
  host.peer = worker
  worker.peer = host
  return [host, worker]
}

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('v1 Compatibility Host runtime cleanup', () => {
  it('fences only v1 and settles when lease cleanup and worker stop fail', async () => {
    const root = await mkdtemp(join(tmpdir(), 'simulator-v1-runtime-stop-'))
    roots.push(root)
    const workspaceRoot = join(root, 'workspace')
    await mkdir(workspaceRoot)
    const [hostPort, workerPort] = pair()
    const worker = await startV1CompatibilityWorker(workerPort, () => undefined, { stopTimeoutMs: 100 })
    let stopCalls = 0
    const circuitTrips: Array<{ protocol: string; failure: string | undefined }> = []
    const supervisor = {
      async start() { return {} },
      rpcPort(protocol: string) { return protocol === 'v1' ? hostPort : undefined },
      stop() {
        stopCalls += 1
        return new Promise<void>(() => undefined)
      },
      tripCircuit(protocol: string, failure?: string) { circuitTrips.push({ protocol, failure }) },
    } as unknown as HostAgentWorkerSupervisor
    const sessions = {
      getWorkspaces: () => [{
        id: 'workspace-1',
        name: 'Workspace',
        slug: 'workspace',
        rootPath: workspaceRoot,
        createdAt: 1,
      }],
    } as unknown as ISessionManager
    const runtime = await createV1UtilityCompatibilityRuntime({
      storageRoot: root,
      sessions,
      supervisor,
      resolveWorkspaceId: () => 'workspace-1',
      requestTimeoutMs: 25,
      cleanupTimeoutMs: 25,
    })
    const controller = new AbortController()
    await runtime.prepareLaunch({
      id: 'open-design',
      version: '0.14.5',
      activatedRoot: '/activated/open-design',
      executable: '/activated/open-design/bin/open-design',
      endpoint: { host: '127.0.0.1', port: 31_337 },
      restartCount: 0,
      signal: controller.signal,
    } as ModuleDaemonLaunchContext)

    // Model a Compatibility worker disappearing before launch cleanup. The
    // runtime must not wait forever for either its lease or a broken stop ACK.
    workerPort.close()
    const startedAt = Date.now()
    const firstDispose = runtime.dispose()
    const coalescedDispose = runtime.dispose()
    expect(coalescedDispose).toBe(firstDispose)
    await expect(firstDispose).rejects.toThrow('v1 Compatibility runtime did not fully reap')
    expect(Date.now() - startedAt).toBeLessThan(1_000)
    expect(stopCalls).toBe(1)
    expect(circuitTrips.length).toBeGreaterThanOrEqual(1)
    expect(circuitTrips.every((trip) => trip.protocol === 'v1' && trip.failure === 'cleanup-timeout')).toBe(true)

    await expect(runtime.prepareLaunch({
      id: 'open-design', version: '0.14.5', activatedRoot: '/activated/open-design',
      executable: '/activated/open-design/bin/open-design', endpoint: { host: '127.0.0.1', port: 31_337 },
      restartCount: 0, signal: controller.signal,
    } as ModuleDaemonLaunchContext)).rejects.toThrow('runtime is disposed')
    await worker.stop()
  })
})
