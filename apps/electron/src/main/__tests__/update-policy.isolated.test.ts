import { afterEach, describe, expect, mock, test } from 'bun:test'

const original = process.env.SIMULATOR_DISABLE_UPDATES

afterEach(() => {
  if (original === undefined) delete process.env.SIMULATOR_DISABLE_UPDATES
  else process.env.SIMULATOR_DISABLE_UPDATES = original
  mock.restore()
})

describe('engineering RC update policy', () => {
  test('disables updates only for the explicit build value', async () => {
    process.env.SIMULATOR_DISABLE_UPDATES = '1'
    const disabled = await import(`../update-policy.ts?disabled=${Date.now()}`)
    expect(disabled.AUTO_UPDATES_DISABLED).toBe(true)

    process.env.SIMULATOR_DISABLE_UPDATES = '0'
    const enabled = await import(`../update-policy.ts?enabled=${Date.now()}`)
    expect(enabled.AUTO_UPDATES_DISABLED).toBe(false)
  })
})
