import { describe, expect, it } from 'bun:test'
import { BeforeQuitCleanupController, type BeforeQuitEvent } from '../before-quit-cleanup'

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

describe('BeforeQuitCleanupController', () => {
  it('prevents quit synchronously, drains once, and ignores re-entry after completion', async () => {
    const order: string[] = []
    const drain = deferred()
    let cleanupCalls = 0
    let controller!: BeforeQuitCleanupController
    const completedEvent = { preventDefault: () => order.push('unexpected-completed-prevent') }
    controller = new BeforeQuitCleanupController({
      cleanup: async () => {
        cleanupCalls += 1
        order.push('cleanup-start')
        await drain.promise
        order.push('cleanup-complete')
      },
      continueQuit: () => {
        order.push('continue-quit')
        controller.handleBeforeQuit(completedEvent)
      },
    })
    const event = (label: string): BeforeQuitEvent => ({
      preventDefault: () => order.push(`prevent:${label}`),
    })

    controller.handleBeforeQuit(event('first'))
    controller.handleBeforeQuit(event('duplicate'))

    expect(order).toEqual(['prevent:first', 'cleanup-start', 'prevent:duplicate'])
    expect(cleanupCalls).toBe(1)
    expect(controller.state).toBe('cleanup-in-progress')

    drain.resolve()
    await controller.completion

    expect(controller.state).toBe('completed')
    expect(cleanupCalls).toBe(1)
    expect(order).toEqual([
      'prevent:first',
      'cleanup-start',
      'prevent:duplicate',
      'cleanup-complete',
      'continue-quit',
    ])
  })

  it('continues quitting after a reported cleanup failure', async () => {
    const errors: unknown[] = []
    let continued = 0
    const controller = new BeforeQuitCleanupController({
      cleanup: async () => { throw new Error('drain failed') },
      onCleanupError: (error) => errors.push(error),
      continueQuit: () => { continued += 1 },
    })

    controller.handleBeforeQuit({ preventDefault() {} })
    await controller.completion

    expect(errors).toHaveLength(1)
    expect(continued).toBe(1)
    expect(controller.state).toBe('completed')
  })
})
