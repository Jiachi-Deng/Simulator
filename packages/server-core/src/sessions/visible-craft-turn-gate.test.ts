import { describe, expect, it } from 'bun:test'
import { VisibleCraftTurnGate } from './visible-craft-turn-gate'

describe('VisibleCraftTurnGate', () => {
  it('awaits the first active transition and serializes concurrent visible starts', async () => {
    const gate = new VisibleCraftTurnGate()
    const events: string[] = []
    let release!: () => void
    const barrier = new Promise<void>((resolve) => { release = resolve })
    gate.subscribe(async (change) => {
      events.push(`${change.active}:${change.sessionId}:${change.activeSessionCount}:begin`)
      if (change.active) await barrier
      events.push(`${change.active}:${change.sessionId}:${change.activeSessionCount}:end`)
    })

    let firstStarted = false
    let secondStarted = false
    const first = gate.begin('craft-a').then(() => { firstStarted = true })
    const second = gate.begin('craft-b').then(() => { secondStarted = true })
    await Promise.resolve()

    expect(firstStarted).toBe(false)
    expect(secondStarted).toBe(false)
    release()
    await Promise.all([first, second])

    expect(events).toEqual(['true:craft-a:1:begin', 'true:craft-a:1:end'])
    expect(gate.snapshot()).toEqual({ activeSessionCount: 2 })
  })

  it('emits inactive only after the final visible session stops', async () => {
    const gate = new VisibleCraftTurnGate()
    const events: string[] = []
    gate.subscribe((change) => {
      events.push(`${change.active}:${change.sessionId}:${change.activeSessionCount}`)
    })

    await gate.begin('craft-a')
    await gate.begin('craft-b')
    await gate.end('craft-a')
    await gate.end('craft-b')

    expect(events).toEqual(['true:craft-a:1', 'false:craft-b:0'])
  })

  it('contains listener failures so Module coordination cannot break Craft', async () => {
    const errors: string[] = []
    const gate = new VisibleCraftTurnGate({
      onListenerError: (error) => errors.push(error instanceof Error ? error.message : String(error)),
    })
    gate.subscribe(() => { throw new Error('module path unavailable') })

    await expect(gate.begin('craft-a')).resolves.toBeUndefined()
    await expect(gate.end('craft-a')).resolves.toBeUndefined()
    expect(errors).toEqual(['module path unavailable', 'module path unavailable'])
  })

  it('does not emit duplicate transitions for duplicate begin/end calls', async () => {
    const gate = new VisibleCraftTurnGate()
    const states: boolean[] = []
    gate.subscribe((change) => {
      states.push(change.active)
    })

    await gate.begin('craft-a')
    await gate.begin('craft-a')
    await gate.end('unknown')
    await gate.end('craft-a')
    await gate.end('craft-a')

    expect(states).toEqual([true, false])
  })
})
