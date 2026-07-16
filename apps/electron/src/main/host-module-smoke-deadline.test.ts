import { describe, expect, it } from 'bun:test'

import { AuthoritativeSmokeWatchdogState, waitForAcceptedValue } from './host-module-smoke-deadline'

describe('Host Module smoke deadline', () => {
  it('never permits a success commit after the inner watchdog fires', () => {
    const watchdog = new AuthoritativeSmokeWatchdogState()
    watchdog.assertMayCommitSuccess()
    watchdog.markTimedOut()
    expect(watchdog.timedOut).toBe(true)
    expect(() => watchdog.assertMayCommitSuccess()).toThrow('SMOKE_TIMEOUT')
    watchdog.markTimedOut()
    expect(() => watchdog.assertMayCommitSuccess()).toThrow('SMOKE_TIMEOUT')
  })

  it('rejects a clean snapshot that arrives only after the deadline', async () => {
    const lateClean = waitForAcceptedValue({
      timeoutMs: 20,
      pollMs: 1,
      refresh: async () => {
        await Bun.sleep(40)
        return 'clean'
      },
      accept: (value) => value,
    })

    await expect(lateClean).rejects.toMatchObject({ code: 'SMOKE_DEADLINE_EXCEEDED' })
  })

  it('accepts a clean snapshot reached inside the same absolute deadline', async () => {
    let refreshCount = 0
    const result = await waitForAcceptedValue({
      timeoutMs: 200,
      pollMs: 1,
      refresh: async () => ++refreshCount,
      accept: (value) => {
        if (value < 2) throw new Error('not clean')
        return value
      },
    })

    expect(result).toBe(2)
  })
})
