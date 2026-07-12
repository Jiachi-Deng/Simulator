import { describe, expect, test } from 'bun:test'
import type { Stats } from 'node:fs'

import { filesInScanRoot } from './check-i18n-coverage'

type FileSystem = Parameters<typeof filesInScanRoot>[1]
type FileStat = Pick<Stats, 'isDirectory' | 'isFile'>

const directory: FileStat = {
  isDirectory: () => true,
  isFile: () => false,
}

const file: FileStat = {
  isDirectory: () => false,
  isFile: () => true,
}

function fsError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code })
}

describe('filesInScanRoot', () => {
  test('ignores ENOENT only when the scan root itself is missing', () => {
    let readdirCalled = false
    const fs: FileSystem = {
      statSync: () => {
        throw fsError('ENOENT')
      },
      readdirSync: () => {
        readdirCalled = true
        return []
      },
    }

    expect(filesInScanRoot('/repo/optional-root', fs)).toEqual([])
    expect(readdirCalled).toBe(false)
  })

  test('fails closed when the scan root cannot be statted for another reason', () => {
    const error = fsError('EACCES')
    const fs: FileSystem = {
      statSync: () => {
        throw error
      },
      readdirSync: () => [],
    }

    expect(() => filesInScanRoot('/repo/apps', fs)).toThrow(error)
  })

  test('fails closed on a permission error while reading a nested directory', () => {
    const error = fsError('EACCES')
    const fs: FileSystem = {
      statSync: () => directory,
      readdirSync: (path) => {
        if (path === '/repo/apps') return ['nested']
        throw error
      },
    }

    expect(() => filesInScanRoot('/repo/apps', fs)).toThrow(error)
  })

  test('fails closed when a directory disappears during traversal', () => {
    const error = fsError('ENOENT')
    const fs: FileSystem = {
      statSync: () => directory,
      readdirSync: (path) => {
        if (path === '/repo/apps') return ['nested']
        throw error
      },
    }

    expect(() => filesInScanRoot('/repo/apps', fs)).toThrow(error)
  })

  test('fails closed when entry stat reports a broken symlink', () => {
    const error = fsError('ENOENT')
    const fs: FileSystem = {
      statSync: (path) => {
        if (path === '/repo/apps') return directory
        if (path === '/repo/apps/existing.ts') return file
        throw error
      },
      readdirSync: () => ['existing.ts', 'broken-link.ts'],
    }

    expect(() => filesInScanRoot('/repo/apps', fs)).toThrow(error)
  })
})
