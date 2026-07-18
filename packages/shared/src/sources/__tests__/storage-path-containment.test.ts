import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deleteSource, validateSourceSlug } from '../storage.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('source path containment', () => {
  it('rejects traversal and never follows a direct-child symlink during delete', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'source-path-containment-'))
    roots.push(workspaceRoot)
    const moduleDir = join(workspaceRoot, 'sessions', 'module-secret')
    const sentinel = join(moduleDir, 'session.jsonl')
    mkdirSync(moduleDir, { recursive: true })
    writeFileSync(sentinel, 'private')
    mkdirSync(join(workspaceRoot, 'sources'), { recursive: true })

    expect(() => validateSourceSlug('../sessions/module-secret')).toThrow('Invalid source slug')
    expect(() => deleteSource(workspaceRoot, '../sessions/module-secret')).toThrow('Invalid source slug')
    symlinkSync(moduleDir, join(workspaceRoot, 'sources', 'linked-module'), 'dir')
    expect(() => deleteSource(workspaceRoot, 'linked-module')).toThrow('direct directory')
    expect(existsSync(sentinel)).toBe(true)
  })
})
