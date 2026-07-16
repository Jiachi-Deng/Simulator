import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ISessionManager } from '@craft-agent/server-core/handlers'
import type { HostAgentMessagePortLike } from '@simulator/host-agent-broker/message-port'
import { FakeModuleAgentSessionPort } from '@simulator/module-agent-gateway/testing'
import type { ModuleDaemonLaunchContext } from '@simulator/module-daemon'
import { createV1UtilityCompatibilityRuntime } from '../v1-compatibility-runtime'
import { startV1CompatibilityWorker } from '../v1-worker-runtime'
import type { HostAgentWorkerSupervisor } from '../supervisor'

type PortEvent = 'message' | 'close' | 'messageerror'

class PairedPort implements HostAgentMessagePortLike {
  peer?: PairedPort
  readonly posted: unknown[] = []
  dropMessage?: (message: unknown) => boolean
  transformMessage?: (message: unknown) => unknown
  readonly #listeners = new Map<PortEvent, Set<(message?: unknown) => void>>()
  #closed = false

  postMessage(message: unknown): void {
    const outbound = this.transformMessage?.(message) ?? message
    this.posted.push(outbound)
    if (!this.peer || this.#closed || this.peer.#closed) throw new Error('port closed')
    if (this.dropMessage?.(outbound)) return
    const peer = this.peer
    queueMicrotask(() => peer.#emit('message', { data: outbound }))
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
      async start() { return { epoch: 'epoch_v1_fixture' } },
      connection(protocol: string) {
        return protocol === 'v1'
          ? {
              protocol: 'v1',
              epoch: 'epoch_v1_fixture',
              tokenFile: join(root, 'worker.token'),
              address: { host: '127.0.0.1', port: 31_337, url: 'http://127.0.0.1:31337' },
            }
          : undefined
      },
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

  it('reaps a positively exited worker locally without remote lease cleanup or a first-crash circuit trip', async () => {
    const root = await mkdtemp(join(tmpdir(), 'simulator-v1-runtime-crash-'))
    roots.push(root)
    const workspaceRoot = join(root, 'workspace')
    await mkdir(workspaceRoot)
    const [hostPort, workerPort] = pair()
    const worker = await startV1CompatibilityWorker(workerPort, () => undefined, { stopTimeoutMs: 100 })
    let currentEpoch: string | undefined = 'epoch_v1_crashed'
    let stopCalls = 0
    const circuitTrips: string[] = []
    const supervisor = {
      async start() { return { epoch: currentEpoch } },
      connection(protocol: string) {
        return protocol === 'v1' && currentEpoch
          ? {
              protocol: 'v1', epoch: currentEpoch, tokenFile: join(root, 'worker.token'),
              address: { host: '127.0.0.1', port: 31_337, url: 'http://127.0.0.1:31337' },
            }
          : undefined
      },
      rpcPort(protocol: string) { return protocol === 'v1' ? hostPort : undefined },
      async stop() { stopCalls += 1 },
      tripCircuit(protocol: string) { circuitTrips.push(protocol) },
    } as unknown as HostAgentWorkerSupervisor
    const sessions = {
      getWorkspaces: () => [{
        id: 'workspace-1', name: 'Workspace', slug: 'workspace', rootPath: workspaceRoot, createdAt: 1,
      }],
    } as unknown as ISessionManager
    const sessionPort = new FakeModuleAgentSessionPort()
    const runtime = await createV1UtilityCompatibilityRuntime({
      storageRoot: root,
      sessions,
      sessionPort,
      supervisor,
      resolveWorkspaceId: () => 'workspace-1',
      requestTimeoutMs: 25,
      cleanupTimeoutMs: 250,
    })
    const controller = new AbortController()
    const lease = await runtime.prepareLaunch({
      id: 'open-design', version: '0.14.5', activatedRoot: '/activated/open-design',
      executable: '/activated/open-design/bin/open-design', endpoint: { host: '127.0.0.1', port: 31_337 },
      restartCount: 0, signal: controller.signal,
    } as ModuleDaemonLaunchContext)
    expect(runtime.hasActiveLaunch()).toBe(true)
    expect(await runtime.refreshDebugSnapshot()).toEqual({
      activeGrants: 1,
      activeSessions: 0,
      activeTurns: 0,
      activeSubscribers: 0,
    })
    const environment = lease.environment
    if (!environment) throw new Error('v1 fixture launch environment is missing')
    const url = environment.SIMULATOR_HOST_AGENT_URL
    const tokenFile = environment.SIMULATOR_HOST_AGENT_TOKEN_FILE
    if (!url || !tokenFile) throw new Error('v1 fixture launch environment is incomplete')
    const token = (await readFile(tokenFile, 'utf8')).trim()
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    const created = await fetch(`${url}/v1/module-sessions`, {
      method: 'POST', headers, body: JSON.stringify({
        contractVersion: 1,
        workingDirectory: await realpath(join(root, 'module-data', 'open-design')),
      }),
    })
    expect(created.status).toBe(201)
    const { sessionHandle } = await created.json() as { sessionHandle: string }
    expect(await runtime.refreshDebugSnapshot()).toMatchObject({ activeSessions: 1, activeTurns: 0 })
    const sent = await fetch(`${url}/v1/module-sessions/${sessionHandle}/turns`, {
      method: 'POST', headers, body: JSON.stringify({ contractVersion: 1, prompt: 'one turn only' }),
    })
    expect(sent.status).toBe(202)
    expect(sessionPort.sent).toHaveLength(1)
    expect(await runtime.refreshDebugSnapshot()).toMatchObject({ activeSessions: 1, activeTurns: 1 })
    sessionPort.emit({ type: 'turn.completed', sessionId: 'raw-1', finalText: 'done' })
    expect(await runtime.refreshDebugSnapshot()).toMatchObject({ activeSessions: 1, activeTurns: 0 })

    const requestsBeforeCrash = hostPort.posted.length
    workerPort.close()
    setTimeout(() => { currentEpoch = undefined }, 5)
    await expect(lease.cleanup('process-exit')).resolves.toBeUndefined()
    await expect(runtime.invalidateAfterWorkerExit('epoch_v1_crashed')).resolves.toBe(true)
    expect(runtime.hasActiveLaunch()).toBe(false)
    expect(hostPort.posted).toHaveLength(requestsBeforeCrash)
    expect(hostPort.posted.some((message) => (message as { method?: string }).method === 'disposeLease')).toBe(false)
    expect(sessionPort.deleted).toEqual(['raw-1'])
    expect(stopCalls).toBe(0)
    expect(circuitTrips).toEqual([])
    await expect(readFile(tokenFile, 'utf8')).rejects.toBeTruthy()
    await expect(runtime.refreshDebugSnapshot()).rejects.toThrow('snapshot is unavailable')

    await expect(lease.cleanup('process-exit')).resolves.toBeUndefined()
    await expect(runtime.dispose()).resolves.toBeUndefined()
    await worker.stop().catch(() => undefined)
  })

  it('ignores a stale worker epoch without touching the current v1 lease', async () => {
    const root = await mkdtemp(join(tmpdir(), 'simulator-v1-runtime-stale-'))
    roots.push(root)
    const workspaceRoot = join(root, 'workspace')
    await mkdir(workspaceRoot)
    const [hostPort, workerPort] = pair()
    const worker = await startV1CompatibilityWorker(workerPort, () => undefined, { stopTimeoutMs: 100 })
    let stopCalls = 0
    const supervisor = {
      async start() { return { epoch: 'epoch_v1_current' } },
      connection(protocol: string) {
        return protocol === 'v1'
          ? {
              protocol: 'v1', epoch: 'epoch_v1_current', tokenFile: join(root, 'worker.token'),
              address: { host: '127.0.0.1', port: 31_337, url: 'http://127.0.0.1:31337' },
            }
          : undefined
      },
      rpcPort(protocol: string) { return protocol === 'v1' ? hostPort : undefined },
      async stop() { stopCalls += 1; await worker.stop() },
      tripCircuit() { throw new Error('stale epoch must not trip the circuit') },
    } as unknown as HostAgentWorkerSupervisor
    const sessions = {
      getWorkspaces: () => [{
        id: 'workspace-1', name: 'Workspace', slug: 'workspace', rootPath: workspaceRoot, createdAt: 1,
      }],
    } as unknown as ISessionManager
    const runtime = await createV1UtilityCompatibilityRuntime({
      storageRoot: root, sessions, supervisor, resolveWorkspaceId: () => 'workspace-1',
    })
    const lease = await runtime.prepareLaunch({
      id: 'open-design', version: '0.14.5', activatedRoot: '/activated/open-design',
      executable: '/activated/open-design/bin/open-design', endpoint: { host: '127.0.0.1', port: 31_337 },
      restartCount: 0, signal: new AbortController().signal,
    } as ModuleDaemonLaunchContext)
    const environment = lease.environment
    if (!environment) throw new Error('v1 fixture launch environment is missing')
    const tokenFile = environment.SIMULATOR_HOST_AGENT_TOKEN_FILE
    if (!tokenFile) throw new Error('v1 fixture token file is missing')

    await expect(runtime.invalidateAfterWorkerExit('epoch_v1_old')).resolves.toBe(false)
    expect(runtime.hasActiveLaunch()).toBe(true)
    expect(await readFile(tokenFile, 'utf8')).not.toBeEmpty()
    await lease.cleanup('stop')
    expect(runtime.hasActiveLaunch()).toBe(false)
    await runtime.dispose()
    expect(stopCalls).toBe(1)
  })

  it('removes an owner-only token when the worker exits after creating a lease but before delivering its response', async () => {
    const root = await mkdtemp(join(tmpdir(), 'simulator-v1-runtime-lost-response-'))
    roots.push(root)
    const workspaceRoot = join(root, 'workspace')
    const tokenDirectory = join(await realpath(root), 'agent-grants', 'open-design')
    await mkdir(workspaceRoot)
    await mkdir(tokenDirectory, { recursive: true, mode: 0o700 })
    const sentinel = join(tokenDirectory, 'keep.txt')
    await writeFile(sentinel, 'not a bearer token\n', { mode: 0o600 })
    const [hostPort, workerPort] = pair()
    const worker = await startV1CompatibilityWorker(workerPort, () => undefined, { stopTimeoutMs: 100 })
    let currentEpoch: string | undefined = 'epoch_v1_lost_response'
    const circuitTrips: string[] = []
    const supervisor = {
      async start() { return { epoch: currentEpoch } },
      connection(protocol: string) {
        return protocol === 'v1' && currentEpoch
          ? {
              protocol: 'v1', epoch: currentEpoch, tokenFile: join(root, 'worker.token'),
              address: { host: '127.0.0.1', port: 31_337, url: 'http://127.0.0.1:31337' },
            }
          : undefined
      },
      rpcPort(protocol: string) { return protocol === 'v1' ? hostPort : undefined },
      async stop() { throw new Error('exited worker must not be stopped again') },
      tripCircuit(protocol: string) { circuitTrips.push(protocol) },
    } as unknown as HostAgentWorkerSupervisor
    const sessions = {
      getWorkspaces: () => [{
        id: 'workspace-1', name: 'Workspace', slug: 'workspace', rootPath: workspaceRoot, createdAt: 1,
      }],
    } as unknown as ISessionManager
    const runtime = await createV1UtilityCompatibilityRuntime({
      storageRoot: root, sessions, supervisor, resolveWorkspaceId: () => 'workspace-1',
      requestTimeoutMs: 100, cleanupTimeoutMs: 250,
    })
    let orphanTokenFile: string | undefined
    workerPort.dropMessage = (message) => {
      const frame = message as { kind?: string; payload?: unknown }
      const payload = frame.kind === 'host-agent.credit.frame' && frame.payload && typeof frame.payload === 'object'
        ? frame.payload as { kind?: string; ok?: boolean; result?: unknown }
        : undefined
      if (payload?.kind !== 'module-agent.worker.response' || !payload.ok) return false
      const result = payload.result as { environment?: Record<string, string> } | undefined
      orphanTokenFile = result?.environment?.SIMULATOR_HOST_AGENT_TOKEN_FILE
      currentEpoch = undefined
      workerPort.close()
      return true
    }

    await expect(runtime.prepareLaunch({
      id: 'open-design', version: '0.14.5', activatedRoot: '/activated/open-design',
      executable: '/activated/open-design/bin/open-design', endpoint: { host: '127.0.0.1', port: 31_337 },
      restartCount: 0, signal: new AbortController().signal,
    } as ModuleDaemonLaunchContext)).rejects.toThrow()
    if (!orphanTokenFile) throw new Error('fixture did not intercept the lost prepareLaunch response')
    // The response-loss path now fails closed immediately. Because process
    // exit was positively observed, the anonymous lease token is swept before
    // prepareLaunch rejects rather than waiting for a later exit callback.
    await expect(readFile(orphanTokenFile, 'utf8')).rejects.toBeTruthy()
    await expect(runtime.invalidateAfterWorkerExit('epoch_v1_lost_response')).resolves.toBe(true)
    expect(await readFile(sentinel, 'utf8')).toBe('not a bearer token\n')
    expect(runtime.hasActiveLaunch()).toBe(false)
    expect(circuitTrips).toEqual([])
    await worker.stop().catch(() => undefined)
  })

  it('fails closed and sweeps anonymous lease tokens for malformed prepare responses and forged token paths', async () => {
    for (const mode of ['malformed-schema', 'forged-token-path'] as const) {
      const root = await mkdtemp(join(tmpdir(), `simulator-v1-runtime-${mode}-`))
      roots.push(root)
      const workspaceRoot = join(root, 'workspace')
      await mkdir(workspaceRoot)
      const [hostPort, workerPort] = pair()
      const worker = await startV1CompatibilityWorker(workerPort, () => undefined, { stopTimeoutMs: 100 })
      const epoch = `epoch_v1_${mode}`
      let currentEpoch: string | undefined = epoch
      let stopCalls = 0
      const circuitTrips: string[] = []
      const supervisor = {
        async start() { return { epoch } },
        connection(protocol: string) {
          return protocol === 'v1' && currentEpoch
            ? {
                protocol: 'v1', epoch: currentEpoch, tokenFile: join(root, 'worker.token'),
                address: { host: '127.0.0.1', port: 31_337, url: 'http://127.0.0.1:31337' },
              }
            : undefined
        },
        rpcPort(protocol: string) { return protocol === 'v1' ? hostPort : undefined },
        async stop() {
          stopCalls += 1
          await worker.stop()
          currentEpoch = undefined
        },
        tripCircuit(protocol: string) { circuitTrips.push(protocol) },
      } as unknown as HostAgentWorkerSupervisor
      const sessions = {
        getWorkspaces: () => [{
          id: 'workspace-1', name: 'Workspace', slug: 'workspace', rootPath: workspaceRoot, createdAt: 1,
        }],
      } as unknown as ISessionManager
      const runtime = await createV1UtilityCompatibilityRuntime({
        storageRoot: root, sessions, supervisor, resolveWorkspaceId: () => 'workspace-1',
        requestTimeoutMs: 100, cleanupTimeoutMs: 250,
      })
      let originalTokenFile: string | undefined
      const encoder = new TextEncoder()
      workerPort.transformMessage = (message) => {
        const frame = message as Record<string, unknown>
        const payload = frame.kind === 'host-agent.credit.frame' && frame.payload && typeof frame.payload === 'object'
          ? frame.payload as Record<string, unknown>
          : undefined
        const result = payload?.kind === 'module-agent.worker.response' && payload.ok === true
          && payload.result && typeof payload.result === 'object'
          ? payload.result as Record<string, unknown>
          : undefined
        if (typeof result?.leaseId !== 'string') return message
        const environment = result.environment as Record<string, string>
        originalTokenFile = environment.SIMULATOR_HOST_AGENT_TOKEN_FILE
        const forgedResult = mode === 'malformed-schema'
          ? {
              ...result,
              snapshot: { ...(result.snapshot as Record<string, unknown>), activeTurns: 'not-a-count' },
            }
          : {
              ...result,
              environment: {
                ...environment,
                SIMULATOR_HOST_AGENT_TOKEN_FILE: join(root, 'outside-owner-directory.token'),
              },
            }
        const forgedPayload = { ...payload, result: forgedResult }
        return {
          ...frame,
          payload: forgedPayload,
          creditBytes: encoder.encode(JSON.stringify(forgedPayload)).byteLength,
        }
      }

      await expect(runtime.prepareLaunch({
        id: 'open-design', version: '0.14.5', activatedRoot: '/activated/open-design',
        executable: '/activated/open-design/bin/open-design', endpoint: { host: '127.0.0.1', port: 31_337 },
        restartCount: 0, signal: new AbortController().signal,
      } as ModuleDaemonLaunchContext)).rejects.toThrow(mode === 'malformed-schema'
        ? 'invalid snapshot'
        : 'token outside its owner-only directory')
      if (!originalTokenFile) throw new Error(`${mode} fixture did not capture the worker token`)
      await expect(readFile(originalTokenFile, 'utf8')).rejects.toBeTruthy()
      expect((await readdir(dirname(originalTokenFile))).filter((entry) => /^\.module-agent-.*\.token$/.test(entry))).toEqual([])
      expect(runtime.debugSnapshot()).toEqual({
        activeGrants: 0, activeSessions: 0, activeTurns: 0, activeSubscribers: 0,
      })
      expect(stopCalls).toBe(1)
      expect(circuitTrips).toEqual([])
      await expect(runtime.dispose()).resolves.toBeUndefined()
      await worker.stop().catch(() => undefined)
    }
  })

  it('retains retryable v1 ownership after an unconfirmed stop, then reaps every Session and token', async () => {
    const root = await mkdtemp(join(tmpdir(), 'simulator-v1-runtime-dispose-retry-'))
    roots.push(root)
    const workspaceRoot = join(root, 'workspace')
    await mkdir(workspaceRoot)
    const [hostPort, workerPort] = pair()
    const worker = await startV1CompatibilityWorker(workerPort, () => undefined, { stopTimeoutMs: 100 })
    const epoch = 'epoch_v1_dispose_retry'
    let currentEpoch: string | undefined = epoch
    let stopCalls = 0
    const circuitTrips: string[] = []
    const supervisor = {
      async start() { return { epoch } },
      connection(protocol: string) {
        return protocol === 'v1' && currentEpoch
          ? {
              protocol: 'v1', epoch: currentEpoch, tokenFile: join(root, 'worker.token'),
              address: { host: '127.0.0.1', port: 31_337, url: 'http://127.0.0.1:31337' },
            }
          : undefined
      },
      rpcPort(protocol: string) { return protocol === 'v1' ? hostPort : undefined },
      async stop() {
        stopCalls += 1
        if (stopCalls === 1) throw new Error('worker exit was not confirmed')
        currentEpoch = undefined
        await worker.stop()
      },
      tripCircuit(protocol: string) { circuitTrips.push(protocol) },
    } as unknown as HostAgentWorkerSupervisor
    const sessions = {
      getWorkspaces: () => [{
        id: 'workspace-1', name: 'Workspace', slug: 'workspace', rootPath: workspaceRoot, createdAt: 1,
      }],
    } as unknown as ISessionManager
    const sessionPort = new FakeModuleAgentSessionPort()
    const runtime = await createV1UtilityCompatibilityRuntime({
      storageRoot: root, sessions, sessionPort, supervisor,
      resolveWorkspaceId: () => 'workspace-1', requestTimeoutMs: 25, cleanupTimeoutMs: 100,
    })
    const lease = await runtime.prepareLaunch({
      id: 'open-design', version: '0.14.5', activatedRoot: '/activated/open-design',
      executable: '/activated/open-design/bin/open-design', endpoint: { host: '127.0.0.1', port: 31_337 },
      restartCount: 0, signal: new AbortController().signal,
    } as ModuleDaemonLaunchContext)
    const url = lease.environment?.SIMULATOR_HOST_AGENT_URL
    const tokenFile = lease.environment?.SIMULATOR_HOST_AGENT_TOKEN_FILE
    if (!url || !tokenFile) throw new Error('dispose-retry fixture environment is incomplete')
    const token = (await readFile(tokenFile, 'utf8')).trim()
    const created = await fetch(`${url}/v1/module-sessions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contractVersion: 1,
        workingDirectory: await realpath(join(root, 'module-data', 'open-design')),
      }),
    })
    expect(created.status).toBe(201)
    const tokenDirectory = dirname(tokenFile)
    const orphanToken = join(tokenDirectory, '.module-agent-0123456789abcdef.token')
    await writeFile(orphanToken, 'orphan\n', { mode: 0o600 })

    sessionPort.failDelete = true
    workerPort.close()
    const firstDispose = runtime.dispose()
    expect(runtime.dispose()).toBe(firstDispose)
    await expect(firstDispose).rejects.toThrow('v1 Compatibility runtime did not fully reap')
    expect(runtime.debugSnapshot()).toMatchObject({ activeGrants: 1, activeSessions: 1 })
    expect(await readFile(tokenFile, 'utf8')).not.toBeEmpty()

    sessionPort.failDelete = false
    const retryDispose = runtime.dispose()
    expect(retryDispose).not.toBe(firstDispose)
    await expect(retryDispose).resolves.toBeUndefined()
    expect(stopCalls).toBe(2)
    expect(circuitTrips).toEqual(['v1'])
    expect(sessionPort.deleted).toEqual(['raw-1'])
    expect(runtime.debugSnapshot()).toEqual({
      activeGrants: 0, activeSessions: 0, activeTurns: 0, activeSubscribers: 0,
    })
    await expect(readFile(tokenFile, 'utf8')).rejects.toBeTruthy()
    await expect(readFile(orphanToken, 'utf8')).rejects.toBeTruthy()
    expect((await readdir(tokenDirectory)).filter((entry) => /^\.module-agent-.*\.token$/.test(entry))).toEqual([])
    await worker.stop().catch(() => undefined)
  })

  it('fences only v1 when confirmed-exit local Session reap is uncertain, then permits a strict retry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'simulator-v1-runtime-reap-failure-'))
    roots.push(root)
    const workspaceRoot = join(root, 'workspace')
    await mkdir(workspaceRoot)
    const [hostPort, workerPort] = pair()
    const worker = await startV1CompatibilityWorker(workerPort, () => undefined, { stopTimeoutMs: 100 })
    let currentEpoch: string | undefined = 'epoch_v1_reap_failure'
    const circuitTrips: Array<{ protocol: string; failure?: string }> = []
    const supervisor = {
      async start() { return { epoch: currentEpoch } },
      connection(protocol: string) {
        return protocol === 'v1' && currentEpoch
          ? {
              protocol: 'v1', epoch: currentEpoch, tokenFile: join(root, 'worker.token'),
              address: { host: '127.0.0.1', port: 31_337, url: 'http://127.0.0.1:31337' },
            }
          : undefined
      },
      rpcPort(protocol: string) { return protocol === 'v1' ? hostPort : undefined },
      async stop() { throw new Error('confirmed worker exit must not call stop') },
      tripCircuit(protocol: string, failure?: string) { circuitTrips.push({ protocol, failure }) },
    } as unknown as HostAgentWorkerSupervisor
    const sessions = {
      getWorkspaces: () => [{
        id: 'workspace-1', name: 'Workspace', slug: 'workspace', rootPath: workspaceRoot, createdAt: 1,
      }],
    } as unknown as ISessionManager
    const sessionPort = new FakeModuleAgentSessionPort()
    const runtime = await createV1UtilityCompatibilityRuntime({
      storageRoot: root, sessions, sessionPort, supervisor,
      resolveWorkspaceId: () => 'workspace-1', cleanupTimeoutMs: 250,
    })
    const lease = await runtime.prepareLaunch({
      id: 'open-design', version: '0.14.5', activatedRoot: '/activated/open-design',
      executable: '/activated/open-design/bin/open-design', endpoint: { host: '127.0.0.1', port: 31_337 },
      restartCount: 0, signal: new AbortController().signal,
    } as ModuleDaemonLaunchContext)
    const environment = lease.environment
    const url = environment?.SIMULATOR_HOST_AGENT_URL
    const tokenFile = environment?.SIMULATOR_HOST_AGENT_TOKEN_FILE
    if (!url || !tokenFile) throw new Error('v1 reap-failure fixture environment is incomplete')
    const token = (await readFile(tokenFile, 'utf8')).trim()
    const created = await fetch(`${url}/v1/module-sessions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contractVersion: 1,
        workingDirectory: await realpath(join(root, 'module-data', 'open-design')),
      }),
    })
    expect(created.status).toBe(201)

    sessionPort.failDelete = true
    currentEpoch = undefined
    workerPort.close()
    await expect(runtime.invalidateAfterWorkerExit('epoch_v1_reap_failure')).rejects.toThrow(
      'worker-exit cleanup did not fully reap',
    )
    expect(circuitTrips).toEqual([{ protocol: 'v1', failure: 'cleanup-timeout' }])
    await expect(readFile(tokenFile, 'utf8')).rejects.toBeTruthy()

    sessionPort.failDelete = false
    await expect(runtime.invalidateAfterWorkerExit('epoch_v1_reap_failure')).resolves.toBe(true)
    expect(sessionPort.deleted).toEqual(['raw-1'])
    await expect(lease.cleanup('process-exit')).resolves.toBeUndefined()
    await worker.stop().catch(() => undefined)
  })
})
