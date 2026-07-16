import { describe, expect, it } from 'bun:test'
import { InMemoryHostAgentRunSessionPort } from '@simulator/host-agent-run-core/testing'
import { FakeModuleAgentSessionPort } from '@simulator/module-agent-gateway/testing'
import { MainProcessModuleTurnLease, ModuleTurnLeaseBusyError } from '../module-turn-lease'

describe('MainProcessModuleTurnLease', () => {
  it('admits exactly one provider prompt across a double-barrier v1-v2 race', async () => {
    const lease = new MainProcessModuleTurnLease()
    const v1Base = new FakeModuleAgentSessionPort()
    const v2Base = new InMemoryHostAgentRunSessionPort()
    const v1 = lease.wrapV1(v1Base)
    const v2 = lease.wrapV2(v2Base)

    let release!: () => void
    const barrier = new Promise<void>((resolve) => { release = resolve })
    let ready = 0
    const race = async (run: () => Promise<void>) => {
      ready += 1
      while (ready < 2) await Promise.resolve()
      await barrier
      return await run()
    }

    const leftPromise = race(() => v1.sendTurn('v1-session', 'v1 prompt'))
    const rightPromise = race(() => v2.sendTurn('v2-session', 'v2 prompt'))
    while (ready < 2) await Promise.resolve()
    release()
    const [left, right] = await Promise.allSettled([leftPromise, rightPromise])

    expect([left, right].filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejection = [left, right].find((result) => result.status === 'rejected') as PromiseRejectedResult
    expect(rejection.reason).toBeInstanceOf(ModuleTurnLeaseBusyError)
    expect(v1Base.sent.length + v2Base.prompts.length).toBe(1)
  })

  it('contains a timed-out preemption and keeps Craft admission bounded', async () => {
    const lease = new MainProcessModuleTurnLease()
    lease.acquire({ protocol: 'v1', sessionId: 'stuck' }, () => new Promise(() => undefined))
    lease.markCraftActive()

    const startedAt = Date.now()
    const result = await lease.preemptCurrent(20)
    expect(result.status).toBe('timed-out')
    expect(result.owner).toEqual({ protocol: 'v1', sessionId: 'stuck' })
    expect(Date.now() - startedAt).toBeLessThan(250)
    expect(() => lease.acquire({ protocol: 'v2', sessionId: 'blocked' }, async () => undefined))
      .toThrow(ModuleTurnLeaseBusyError)
  })

  it('keeps ownership fenced when strict Session reap rejects', async () => {
    const lease = new MainProcessModuleTurnLease()
    const v1 = lease.wrapV1(new FakeModuleAgentSessionPort())
    const v2Base = new InMemoryHostAgentRunSessionPort()
    v2Base.disposeAndReap = async () => { throw new Error('provider tree still alive') }
    const v2 = lease.wrapV2(v2Base)

    await v2.sendTurn('v2-stuck', 'prompt')
    await expect(v2.disposeAndReap('v2-stuck')).rejects.toThrow('provider tree still alive')
    expect(lease.snapshot().owner).toEqual({ protocol: 'v2', sessionId: 'v2-stuck' })
    await expect(v1.sendTurn('v1-blocked', 'prompt')).rejects.toBeInstanceOf(ModuleTurnLeaseBusyError)
  })

  it('retains v1 ownership after terminal and stopped acknowledgements until strict reap', async () => {
    const lease = new MainProcessModuleTurnLease()
    const v1Base = new FakeModuleAgentSessionPort()
    const v1 = lease.wrapV1(v1Base)
    const v2 = lease.wrapV2(new InMemoryHostAgentRunSessionPort())

    v1.subscribe('v1-session', () => undefined)
    await v1.sendTurn('v1-session', 'prompt')
    v1Base.emit({ type: 'turn.completed', sessionId: 'v1-session', finalText: 'done' })
    await v1.awaitStopped('v1-session')

    expect(lease.snapshot().owner).toEqual({ protocol: 'v1', sessionId: 'v1-session' })
    await expect(v2.sendTurn('v2-blocked', 'prompt')).rejects.toBeInstanceOf(ModuleTurnLeaseBusyError)

    await v1.disposeAndReap('v1-session')
    await v2.sendTurn('v2-admitted', 'prompt')
    expect(lease.snapshot().owner).toEqual({ protocol: 'v2', sessionId: 'v2-admitted' })
  })

  it('retains v2 ownership after terminal, stopped, and send failure until strict reap', async () => {
    const lease = new MainProcessModuleTurnLease()
    const v1 = lease.wrapV1(new FakeModuleAgentSessionPort())
    const v2Base = new InMemoryHostAgentRunSessionPort()
    const v2 = lease.wrapV2(v2Base)

    v2.subscribe('v2-session', () => undefined)
    await v2.sendTurn('v2-session', 'prompt')
    v2Base.emit('v2-session', { type: 'turn.completed', finalText: 'done' })
    await v2.awaitStopped('v2-session')

    expect(lease.snapshot().owner).toEqual({ protocol: 'v2', sessionId: 'v2-session' })
    await expect(v1.sendTurn('v1-blocked', 'prompt')).rejects.toBeInstanceOf(ModuleTurnLeaseBusyError)

    await v2.disposeAndReap('v2-session')
    v2Base.sendError = new Error('provider start failed')
    await expect(v2.sendTurn('v2-failed', 'prompt')).rejects.toThrow('provider start failed')
    expect(lease.snapshot().owner).toEqual({ protocol: 'v2', sessionId: 'v2-failed' })
    await expect(v1.sendTurn('v1-still-blocked', 'prompt')).rejects.toBeInstanceOf(ModuleTurnLeaseBusyError)
    await v2.disposeAndReap('v2-failed')
  })
})
