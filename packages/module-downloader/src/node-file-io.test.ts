import { describe, expect, it } from 'bun:test'
import { writeAll, type RandomAccessWriter } from './node-file-io.ts'

describe('writeAll', () => {
  it('persists every byte across deterministic short writes', async () => {
    const output = new Uint8Array(8)
    const positions: number[] = []
    const writer: RandomAccessWriter = {
      async write(buffer, offset, length, position) {
        const bytesWritten = Math.min(2, length)
        output.set(buffer.subarray(offset, offset + bytesWritten), position)
        positions.push(position)
        return { bytesWritten }
      },
    }

    await writeAll(writer, Uint8Array.from([1, 2, 3, 4, 5]), 2)

    expect([...output]).toEqual([0, 0, 1, 2, 3, 4, 5, 0])
    expect(positions).toEqual([2, 4, 6])
  })

  it('fails when a writer makes no progress', async () => {
    const writer: RandomAccessWriter = {
      async write() { return { bytesWritten: 0 } },
    }
    await expect(writeAll(writer, Uint8Array.of(1), 0)).rejects.toThrow('invalid progress')
  })
})
