import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createSession,
  getOrCreateSessionById,
  getSessionPath,
  saveSession,
  sessionPersistenceQueue,
  type StoredSession,
} from '..'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('saveSession durability', () => {
  it('rejects when the queued snapshot cannot be written', async () => {
    const root = mkdtempSync(join(tmpdir(), 'session-storage-durability-'))
    roots.push(root)
    const sessionId = 'durability-failure'
    // A directory at the final JSONL path lets staging succeed but forces the
    // atomic publish itself to fail on every supported platform.
    mkdirSync(join(root, 'sessions', sessionId, 'session.jsonl'), { recursive: true })
    const session: StoredSession = {
      id: sessionId,
      workspaceRootPath: root,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      messages: [],
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        contextTokens: 0,
        costUsd: 0,
      },
    }

    await expect(saveSession(session)).rejects.toThrow()
  })

  it('rejects and removes the allocated directory when the first Session commit fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'session-create-durability-'))
    roots.push(root)
    const originalFlushDurably = sessionPersistenceQueue.flushDurably
    sessionPersistenceQueue.flushDurably = async () => {
      throw new Error('injected-first-commit-failure')
    }

    try {
      await expect(createSession(root, {
        hidden: true,
        workingDirectory: root,
        moduleAgentRun: {
          transient: true,
          contractVersion: 2,
          moduleId: 'org.simulator.open-design',
          runHandle: `run_${'1'.repeat(32)}`,
          idempotencyKeyDigest: '2'.repeat(64),
          requestDigest: '3'.repeat(64),
          workerEpoch: 'epoch_storage_failure',
          state: 'accepted',
        },
      })).rejects.toThrow('injected-first-commit-failure')

      expect(readdirSync(join(root, 'sessions'))).toEqual([])
      expect(sessionPersistenceQueue.pendingCount).toBe(0)
    } finally {
      sessionPersistenceQueue.flushDurably = originalFlushDurably
    }
  })

  it('removes a newly allocated fixed-ID directory when its first commit fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fixed-session-create-durability-'))
    roots.push(root)
    const sessionId = 'fixed-session'
    const originalFlushDurably = sessionPersistenceQueue.flushDurably
    sessionPersistenceQueue.flushDurably = async () => {
      throw new Error('injected-fixed-first-commit-failure')
    }

    try {
      await expect(getOrCreateSessionById(root, sessionId)).rejects.toThrow(
        'injected-fixed-first-commit-failure',
      )
      expect(existsSync(getSessionPath(root, sessionId))).toBe(false)
      expect(sessionPersistenceQueue.pendingCount).toBe(0)
    } finally {
      sessionPersistenceQueue.flushDurably = originalFlushDurably
    }
  })

  it('preserves a pre-existing fixed-ID directory and sentinel when its first commit fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fixed-session-existing-durability-'))
    roots.push(root)
    const sessionId = 'fixed-session'
    const sessionPath = getSessionPath(root, sessionId)
    const sentinelPath = join(sessionPath, 'user-sentinel.txt')
    mkdirSync(sessionPath, { recursive: true })
    writeFileSync(sentinelPath, 'keep-existing-user-data')
    const originalFlushDurably = sessionPersistenceQueue.flushDurably
    sessionPersistenceQueue.flushDurably = async () => {
      throw new Error('injected-existing-first-commit-failure')
    }

    try {
      await expect(getOrCreateSessionById(root, sessionId)).rejects.toThrow(
        'injected-existing-first-commit-failure',
      )
      expect(readFileSync(sentinelPath, 'utf8')).toBe('keep-existing-user-data')
      expect(existsSync(sessionPath)).toBe(true)
      expect(sessionPersistenceQueue.pendingCount).toBe(0)
    } finally {
      sessionPersistenceQueue.flushDurably = originalFlushDurably
    }
  })
})
