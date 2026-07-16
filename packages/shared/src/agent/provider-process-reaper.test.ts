import { describe, expect, it } from 'bun:test'
import { spawn } from 'node:child_process'
import {
  ProviderIteratorReturnTimeoutError,
  ProviderProcessTree,
  returnProviderIteratorAndReap,
  type ProviderProcessReaper,
} from './provider-process-reaper'

describe('ProviderProcessTree', () => {
  const testOnPosix = process.platform === 'win32' ? it.skip : it

  testOnPosix('waits until a dedicated provider process group has no live descendants', async () => {
    const child = spawn(process.execPath, ['-e', [
      "const { spawn } = require('node:child_process')",
      "spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
      'setInterval(() => {}, 1000)',
    ].join(';')], {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    const pid = child.pid
    expect(pid).toBeNumber()
    const tree = new ProviderProcessTree(child, { processGroup: true })
    expect(tree.isAlive()).toBe(true)

    await tree.reap()
    expect(tree.isAlive()).toBe(false)
    expect(() => process.kill(-pid!, 0)).toThrow()
  })

  testOnPosix('reaps the process group when iterator return never settles', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    const pid = child.pid
    expect(pid).toBeNumber()
    const tree = new ProviderProcessTree(child, { processGroup: true })
    const startedAt = Date.now()

    try {
      await expect(returnProviderIteratorAndReap(
        () => new Promise<never>(() => {}),
        [tree],
        {
          iteratorReturnTimeoutMs: 30,
          reapGraceMs: 250,
          reapKillAckMs: 250,
        },
      )).rejects.toBeInstanceOf(ProviderIteratorReturnTimeoutError)

      expect(Date.now() - startedAt).toBeLessThan(1_500)
      expect(tree.isAlive()).toBe(false)
      expect(() => process.kill(-pid!, 0)).toThrow()
    } finally {
      if (tree.isAlive()) await tree.reap(1, 500)
    }
  })

  it('preserves an iterator return rejection after successful reap', async () => {
    const iteratorError = new Error('iterator return rejected')
    let reapCalls = 0
    const reaper: ProviderProcessReaper = {
      async reap() { reapCalls += 1 },
    }

    await expect(returnProviderIteratorAndReap(
      () => Promise.reject(iteratorError),
      [reaper],
      { iteratorReturnTimeoutMs: 30 },
    )).rejects.toBe(iteratorError)
    expect(reapCalls).toBe(1)
  })

  it('preserves a reap rejection after successful iterator return', async () => {
    const reapError = new Error('process acknowledgement rejected')
    const reaper: ProviderProcessReaper = {
      async reap() { throw reapError },
    }

    await expect(returnProviderIteratorAndReap(
      async () => {},
      [reaper],
      { iteratorReturnTimeoutMs: 30 },
    )).rejects.toBe(reapError)
  })

  it('aggregates iterator and all reap failures without hiding cleanup debt', async () => {
    const iteratorError = new Error('iterator return rejected')
    const firstReapError = new Error('first process acknowledgement rejected')
    const secondReapError = new Error('second process acknowledgement rejected')
    const reapers: ProviderProcessReaper[] = [
      { async reap() { throw firstReapError } },
      { async reap() { throw secondReapError } },
    ]

    let failure: unknown
    try {
      await returnProviderIteratorAndReap(
        () => Promise.reject(iteratorError),
        reapers,
        { iteratorReturnTimeoutMs: 30 },
      )
    } catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toEqual([
      iteratorError,
      firstReapError,
      secondReapError,
    ])
  })
})
