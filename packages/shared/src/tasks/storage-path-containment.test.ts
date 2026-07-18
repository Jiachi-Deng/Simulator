import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendRunLog,
  readNodeOutput,
  readRunLog,
  writeNodeOutput,
  writeRunSpecSnapshot,
} from './storage.ts'
import type { TaskSpec } from './schema.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('task storage path containment', () => {
  it('rejects untrusted slug, run, and node segments before touching a sibling Session tree', () => {
    const root = mkdtempSync(join(tmpdir(), 'task-storage-containment-'))
    roots.push(root)
    const protectedRoot = join(root, 'sessions', 'module-secret')
    const sentinelPath = join(protectedRoot, 'sentinel.txt')
    mkdirSync(protectedRoot, { recursive: true })
    writeFileSync(sentinelPath, 'module-private', 'utf8')

    const started = {
      t: '2026-07-17T00:00:00.000Z',
      kind: 'run-started' as const,
      taskId: 'demo',
      runId: 'run-1',
    }
    const spec = {
      id: 'demo',
      title: 'Demo',
      goal: 'Contain task paths',
      nodes: [{ id: 'node-1', kind: 'session', prompt: 'noop' }],
    } as TaskSpec

    expect(() => appendRunLog(root, '../sessions/module-secret', 'run-1', started))
      .toThrow('Invalid task slug')
    expect(() => appendRunLog(root, 'demo', '../../../sessions/module-secret', started))
      .toThrow('Invalid task run id')
    expect(() => writeRunSpecSnapshot(root, 'demo', '../../../sessions/module-secret', spec))
      .toThrow('Invalid task run id')
    expect(() => writeNodeOutput(root, 'demo', 'run-1', '../../session', { text: 'overwrite' }))
      .toThrow('Invalid task node id')
    expect(() => readNodeOutput(root, 'demo', 'run-1', '../../session'))
      .toThrow('Invalid task node id')
    expect(() => readRunLog(root, 'demo', '../../../sessions/module-secret'))
      .toThrow('Invalid task run id')

    expect(readFileSync(sentinelPath, 'utf8')).toBe('module-private')
    expect(existsSync(join(protectedRoot, 'run-log.jsonl'))).toBe(false)

    writeNodeOutput(root, 'demo', 'run-1', '__verdict__', { text: 'safe' })
    expect(readNodeOutput(root, 'demo', 'run-1', '__verdict__')).toEqual({ text: 'safe' })
  })
})
