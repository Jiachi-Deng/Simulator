import { describe, expect, test } from 'bun:test'
import { HOST_AGENT_CONTRACT_VERSION, type HostAgentRunSnapshot } from '@simulator/host-agent-contract'
import {
  HostAgentMessagePortCapacityError,
  MessagePortByteCreditChannel,
  MessagePortHostAgentBrokerCoreClient,
  type HostAgentBrokerRpcRequest,
  type HostAgentMessagePortLike,
} from './message-port.ts'
import { HostAgentBrokerDisconnectedError } from './errors.ts'

type EventName = 'message' | 'close' | 'messageerror'

class FakePort implements HostAgentMessagePortLike {
  readonly listeners = new Map<EventName, Set<(value?: unknown) => void>>()
  readonly sent: unknown[] = []
  peer?: FakePort

  postMessage(message: unknown): void {
    this.sent.push(structuredClone(message))
    if (this.peer) queueMicrotask(() => this.peer?.emit('message', structuredClone(message)))
  }

  on(event: EventName, listener: (value?: unknown) => void): void {
    const listeners = this.listeners.get(event) ?? new Set()
    listeners.add(listener)
    this.listeners.set(event, listeners)
  }

  off(event: EventName, listener: (value?: unknown) => void): void { this.listeners.get(event)?.delete(listener) }
  start(): void {}

  emit(event: EventName, value?: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value)
  }
}

function portPair(): [FakePort, FakePort] {
  const first = new FakePort()
  const second = new FakePort()
  first.peer = second
  second.peer = first
  return [first, second]
}

function frameId(value: unknown): string {
  return (value as { messageId: string }).messageId
}

describe('MessagePortByteCreditChannel', () => {
  test('queues business traffic until ACK while terminal reserve remains available', async () => {
    const port = new FakePort()
    const channel = new MessagePortByteCreditChannel(port, {
      businessCreditBytes: 64,
      terminalCreditBytes: 32,
      maxQueuedBusinessBytes: 64,
      maxQueuedTerminalBytes: 32,
    })
    await channel.send('x'.repeat(50), 'business')
    const queued = channel.send('y'.repeat(50), 'business')
    await channel.send('cancel', 'terminal')
    expect(port.sent).toHaveLength(2)
    expect(channel.debugSnapshot().businessQueued).toBeGreaterThan(0)
    port.emit('message', { kind: 'host-agent.credit.ack', messageId: frameId(port.sent[0]) })
    await queued
    expect(port.sent).toHaveLength(3)
  })

  test('enforces a bounded queue hard limit', async () => {
    const port = new FakePort()
    const channel = new MessagePortByteCreditChannel(port, {
      businessCreditBytes: 64,
      terminalCreditBytes: 32,
      maxQueuedBusinessBytes: 64,
      maxQueuedTerminalBytes: 32,
    })
    await channel.send('x'.repeat(50))
    void channel.send('y'.repeat(50))
    await expect(channel.send('z'.repeat(50))).rejects.toBeInstanceOf(HostAgentMessagePortCapacityError)
  })

  test('ACK restores exact credit and paired channels exchange payloads', async () => {
    const [firstPort, secondPort] = portPair()
    const first = new MessagePortByteCreditChannel(firstPort, { businessCreditBytes: 128 })
    const second = new MessagePortByteCreditChannel(secondPort, { businessCreditBytes: 128 })
    let received: unknown
    second.onMessage((payload) => { received = payload })
    await first.send({ hello: 'world' })
    await Bun.sleep(0)
    expect(received).toEqual({ hello: 'world' })
    expect(first.debugSnapshot().businessInFlight).toBe(0)
  })

  test('charges createRun application bytes without rejecting fixed RPC envelope overhead', async () => {
    const port = new FakePort()
    const channel = new MessagePortByteCreditChannel(port, {
      businessCreditBytes: 64,
      terminalCreditBytes: 32,
      maxQueuedBusinessBytes: 64,
      maxQueuedTerminalBytes: 32,
    })
    await channel.send({
      kind: 'host-agent.rpc.request',
      requestId: 'rpc_1',
      method: 'createRun',
      params: {
        idempotencyKey: 'key',
        request: { contractVersion: 2, prompt: 'x' },
      },
    })
    expect(channel.debugSnapshot().businessInFlight).toBeLessThanOrEqual(64)
    expect(JSON.stringify(port.sent[0]).length).toBeGreaterThan(64)
  })
})

describe('MessagePortHostAgentBrokerCoreClient', () => {
  test('round-trips a validated RPC result over byte-credit frames', async () => {
    const [clientPort, hostPort] = portPair()
    const clientChannel = new MessagePortByteCreditChannel(clientPort)
    const hostChannel = new MessagePortByteCreditChannel(hostPort)
    const client = new MessagePortHostAgentBrokerCoreClient(clientChannel)
    const result: HostAgentRunSnapshot = {
      contractVersion: HOST_AGENT_CONTRACT_VERSION,
      runHandle: 'run_00000000000000000000000000000001',
      state: 'running',
      createdAt: 1,
      updatedAt: 1,
    }
    hostChannel.onMessage((payload) => {
      const request = payload as HostAgentBrokerRpcRequest
      void hostChannel.send({
        kind: 'host-agent.rpc.response',
        requestId: request.requestId,
        ok: true,
        result,
      })
    })
    await expect(client.getRun(result.runHandle)).resolves.toEqual(result)
  })

  test('disconnect rejects pending RPC without leaking request data', async () => {
    const port = new FakePort()
    const channel = new MessagePortByteCreditChannel(port)
    const client = new MessagePortHostAgentBrokerCoreClient(channel)
    const pending = client.getRun('run_00000000000000000000000000000001')
    port.emit('close')
    await expect(pending).rejects.toBeInstanceOf(HostAgentBrokerDisconnectedError)
  })

  test('malformed RPC output fails closed and rejects rather than hanging', async () => {
    const [clientPort, hostPort] = portPair()
    const clientChannel = new MessagePortByteCreditChannel(clientPort)
    const hostChannel = new MessagePortByteCreditChannel(hostPort)
    const client = new MessagePortHostAgentBrokerCoreClient(clientChannel)
    hostChannel.onMessage((payload) => {
      const request = payload as HostAgentBrokerRpcRequest
      void hostChannel.send({
        kind: 'host-agent.rpc.response',
        requestId: request.requestId,
        ok: true,
        result: { runHandle: 'not-a-valid-snapshot' },
      })
    })
    await expect(client.getRun('run_00000000000000000000000000000001')).rejects.toBeInstanceOf(HostAgentBrokerDisconnectedError)
  })
})
