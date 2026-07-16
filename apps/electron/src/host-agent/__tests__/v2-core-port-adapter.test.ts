import { describe, expect, it } from 'bun:test'
import {
  MessagePortByteCreditChannel,
  MessagePortHostAgentBrokerCoreClient,
  type HostAgentMessagePortLike,
} from '@simulator/host-agent-broker/message-port'
import { HOST_AGENT_LIMITS, type HostAgentEvent, type HostAgentRunSnapshot } from '@simulator/host-agent-contract'
import type { ModuleAgentRunCore } from '@simulator/host-agent-run-core'
import { V2CorePortAdapter } from '../v2-core-port-adapter'

type PortEvent = 'message' | 'close' | 'messageerror'

class PairedPort implements HostAgentMessagePortLike {
  peer?: PairedPort
  readonly #listeners = new Map<PortEvent, Set<(message?: unknown) => void>>()
  closed = false
  holdCreditAcks = false
  readonly heldCreditAcks: unknown[] = []

  postMessage(message: unknown): void {
    if (this.closed || !this.peer || this.peer.closed) throw new Error('port closed')
    if (this.holdCreditAcks && (message as { kind?: unknown })?.kind === 'host-agent.credit.ack') {
      this.heldCreditAcks.push(message)
      return
    }
    const peer = this.peer
    queueMicrotask(() => peer.#emit('message', { data: message }))
  }

  releaseCreditAcks(): void {
    this.holdCreditAcks = false
    const peer = this.peer
    if (!peer || peer.closed) return
    for (const message of this.heldCreditAcks.splice(0)) {
      queueMicrotask(() => peer.#emit('message', { data: message }))
    }
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
    if (this.closed) return
    this.closed = true
    this.#emit('close')
    const peer = this.peer
    if (peer) peer.#emit('close')
  }

  #emit(event: PortEvent, message?: unknown): void {
    for (const listener of this.#listeners.get(event) ?? []) listener(message)
  }
}

function portPair(): [PairedPort, PairedPort] {
  const left = new PairedPort()
  const right = new PairedPort()
  left.peer = right
  right.peer = left
  return [left, right]
}

const runHandle = 'run_0123456789abcdef0123456789abcdef'
const snapshot: HostAgentRunSnapshot = {
  contractVersion: 2,
  runHandle,
  state: 'running',
  createdAt: 1,
  updatedAt: 2,
}

function event(sequence: number, delta: string): HostAgentEvent {
  return {
    contractVersion: 2,
    eventId: String(sequence),
    sequence,
    runHandle,
    occurredAt: sequence,
    type: 'message.delta',
    data: { delta },
  }
}

function completedEvent(sequence: number, finalText?: string): HostAgentEvent {
  return {
    contractVersion: 2,
    eventId: String(sequence),
    sequence,
    runHandle,
    occurredAt: sequence,
    type: 'turn.completed',
    data: finalText === undefined ? {} : { finalText },
  }
}

describe('V2CorePortAdapter', () => {
  it('maps only grant-bound run operations and orders subscription metadata before replay', async () => {
    const [hostPort, workerPort] = portPair()
    const calls: Array<{ method: string; args: unknown[] }> = []
    let liveListener: ((value: HostAgentEvent) => void) | undefined
    let unsubscribed = 0
    let disconnected = 0
    const core = {
      async createRun(input: unknown) { calls.push({ method: 'createRun', args: [input] }); return snapshot },
      getRun(...args: unknown[]) { calls.push({ method: 'getRun', args }); return snapshot },
      subscribe(...args: unknown[]) {
        calls.push({ method: 'subscribe', args: args.slice(0, 3) })
        liveListener = args[3] as (value: HostAgentEvent) => void
        liveListener(event(1, 'replay'))
        return {
          replayed: 1,
          earliestEventId: '1',
          latestEventId: '1',
          unsubscribe: () => { unsubscribed += 1 },
        }
      },
      async cancelRun(...args: unknown[]) { calls.push({ method: 'cancelRun', args }); return snapshot },
      async closeRun(...args: unknown[]) {
        calls.push({ method: 'closeRun', args })
        return { ...snapshot, state: 'closed', updatedAt: 4, terminalAt: 3, closedAt: 4 }
      },
      async disconnectGrant(...args: unknown[]) { calls.push({ method: 'disconnectGrant', args }); disconnected += 1 },
    } as unknown as ModuleAgentRunCore

    const adapter = new V2CorePortAdapter({ core, grantId: 'grant_fixture', port: hostPort })
    const channel = new MessagePortByteCreditChannel(workerPort)
    const client = new MessagePortHostAgentBrokerCoreClient(channel)

    expect(await client.createRun('fixture-key', { contractVersion: 2, prompt: 'hello' })).toEqual(snapshot)
    expect(calls[0]).toEqual({
      method: 'createRun',
      args: [{ grantId: 'grant_fixture', idempotencyKey: 'fixture-key', request: { contractVersion: 2, prompt: 'hello' } }],
    })
    expect(await client.getRun(runHandle)).toEqual(snapshot)

    const received: HostAgentEvent[] = []
    const subscription = await client.subscribeRun(runHandle, undefined, (value) => received.push(value))
    expect(subscription.replayed).toBe(1)
    await Promise.resolve()
    await Promise.resolve()
    expect(received).toEqual([event(1, 'replay')])
    liveListener?.(event(2, 'live'))
    await Promise.resolve()
    await Promise.resolve()
    expect(received).toEqual([event(1, 'replay'), event(2, 'live')])

    await client.cancelRun(runHandle)
    await client.closeRun(runHandle)
    await subscription.unsubscribe()
    expect(unsubscribed).toBe(1)

    await adapter.disconnect()
    expect(disconnected).toBe(1)
    expect(calls.filter((call) => call.method === 'disconnectGrant')[0]?.args).toEqual(['grant_fixture'])
  })

  it('disconnects the grant on a malformed or duplicated wire request', async () => {
    const [hostPort, workerPort] = portPair()
    let disconnected = 0
    const core = {
      async disconnectGrant() { disconnected += 1 },
    } as unknown as ModuleAgentRunCore
    new V2CorePortAdapter({ core, grantId: 'grant_fixture', port: hostPort })
    workerPort.postMessage({ kind: 'not-an-rpc-request' })
    await Promise.resolve()
    await Promise.resolve()
    expect(disconnected).toBe(1)
  })

  it('surfaces strict grant cleanup failure and permits an explicit retry', async () => {
    const [hostPort] = portPair()
    let attempts = 0
    const core = {
      async disconnectGrant() {
        attempts += 1
        if (attempts === 1) throw new Error('provider tree still alive')
      },
    } as unknown as ModuleAgentRunCore
    const adapter = new V2CorePortAdapter({ core, grantId: 'grant_fixture', port: hostPort })

    await expect(adapter.disconnect()).rejects.toThrow('provider tree still alive')
    await expect(adapter.disconnect()).resolves.toBeUndefined()
    expect(attempts).toBe(2)
  })

  it('keeps terminal delivery behind earlier business events when business credit is exhausted', async () => {
    const [hostPort, workerPort] = portPair()
    let liveListener: ((value: HostAgentEvent) => void) | undefined
    const core = {
      subscribe(...args: unknown[]) {
        liveListener = args[3] as (value: HostAgentEvent) => void
        return { replayed: 0, unsubscribe: () => undefined }
      },
      async disconnectGrant() {},
    } as unknown as ModuleAgentRunCore
    const adapter = new V2CorePortAdapter({ core, grantId: 'grant_fixture', port: hostPort })
    const channel = new MessagePortByteCreditChannel(workerPort)
    const client = new MessagePortHostAgentBrokerCoreClient(channel)
    const received: HostAgentEvent[] = []
    const subscription = await client.subscribeRun(runHandle, undefined, (value) => received.push(value))

    workerPort.holdCreditAcks = true
    for (let sequence = 1; sequence <= 40; sequence += 1) {
      liveListener?.(event(sequence, 'x'.repeat(60 * 1024)))
    }
    liveListener?.(completedEvent(41))
    await Bun.sleep(0)
    expect(workerPort.heldCreditAcks.length).toBeGreaterThan(0)
    expect(received.some((value) => value.type === 'turn.completed')).toBe(false)

    workerPort.releaseCreditAcks()
    const deadline = Date.now() + 2_000
    while (received.length < 41 && Date.now() < deadline) await Bun.sleep(1)
    expect(received.map((value) => value.sequence)).toEqual(Array.from({ length: 41 }, (_, index) => index + 1))
    expect(received.at(-1)?.type).toBe('turn.completed')

    await subscription.unsubscribe()
    await adapter.disconnect()
  })

  it('delivers a legal large completion on business credit while cancel and close retain control credit', async () => {
    const [hostPort, workerPort] = portPair()
    let liveListener: ((value: HostAgentEvent) => void) | undefined
    const closedSnapshot: HostAgentRunSnapshot = {
      ...snapshot,
      state: 'closed',
      updatedAt: 4,
      terminalAt: 3,
      closedAt: 4,
    }
    const core = {
      subscribe(...args: unknown[]) {
        liveListener = args[3] as (value: HostAgentEvent) => void
        return { replayed: 0, unsubscribe: () => undefined }
      },
      async cancelRun() { return snapshot },
      async closeRun() { return closedSnapshot },
      async disconnectGrant() {},
    } as unknown as ModuleAgentRunCore
    const adapter = new V2CorePortAdapter({ core, grantId: 'grant_fixture', port: hostPort })
    const channel = new MessagePortByteCreditChannel(workerPort)
    const client = new MessagePortHostAgentBrokerCoreClient(channel)
    const received: HostAgentEvent[] = []
    const subscription = await client.subscribeRun(runHandle, undefined, (value) => received.push(value))

    // Hold Host-bound credit ACKs so the large completion remains charged to
    // the business lane while cancel/close responses exercise terminal credit.
    workerPort.holdCreditAcks = true
    const largeCompletion = completedEvent(1, 'x'.repeat(240 * 1024))
    const encodedCompletionBytes = new TextEncoder().encode(JSON.stringify(largeCompletion)).byteLength
    expect(encodedCompletionBytes).toBeGreaterThan(HOST_AGENT_LIMITS.terminalControlReserveBytes)
    expect(encodedCompletionBytes).toBeLessThanOrEqual(HOST_AGENT_LIMITS.maxEventBytes)
    liveListener?.(largeCompletion)
    const deadline = Date.now() + 2_000
    while (received.length === 0 && Date.now() < deadline) await Bun.sleep(1)
    expect(received).toEqual([largeCompletion])
    expect(workerPort.heldCreditAcks.length).toBeGreaterThan(0)

    await expect(client.cancelRun(runHandle)).resolves.toEqual(snapshot)
    await expect(client.closeRun(runHandle)).resolves.toEqual(closedSnapshot)

    workerPort.releaseCreditAcks()
    await subscription.unsubscribe()
    await adapter.disconnect()
  })

  it('disconnects instead of retaining an unbounded synchronous subscription replay', async () => {
    const [hostPort, workerPort] = portPair()
    let unsubscribed = 0
    let disconnected = 0
    const core = {
      subscribe(...args: unknown[]) {
        const listener = args[3] as (value: HostAgentEvent) => void
        for (let sequence = 1; sequence <= 1_025; sequence += 1) listener(event(sequence, 'x'))
        return { replayed: 1_025, unsubscribe: () => { unsubscribed += 1 } }
      },
      async disconnectGrant() { disconnected += 1 },
    } as unknown as ModuleAgentRunCore
    new V2CorePortAdapter({ core, grantId: 'grant_fixture', port: hostPort })
    const channel = new MessagePortByteCreditChannel(workerPort)
    const client = new MessagePortHostAgentBrokerCoreClient(channel)

    const subscribing = client.subscribeRun(runHandle, undefined, () => undefined)
    void subscribing.catch(() => undefined)
    const deadline = Date.now() + 2_000
    while (disconnected === 0 && Date.now() < deadline) await Bun.sleep(1)
    expect(unsubscribed).toBe(1)
    expect(disconnected).toBe(1)
    // The broker channel owns peer-close propagation. Explicit close keeps this
    // fixture compatible with both the pre-close seam and its hardened form.
    if (!hostPort.closed && !workerPort.closed) workerPort.close()
    await expect(subscribing).rejects.toThrow()
  })
})
