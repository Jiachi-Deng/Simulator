import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createSession,
  getOrCreateSessionById,
  getSessionPath,
  listSessions,
  saveSession,
  sessionPersistenceQueue,
  type StoredSession,
} from '..'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('saveSession durability', () => {
  it('uses the real folder identity for Module recovery and ignores ordinary header mismatches', async () => {
    const root = mkdtempSync(join(tmpdir(), 'session-folder-identity-'))
    roots.push(root)
    const ownership = {
      transient: true as const,
      contractVersion: 2 as const,
      moduleId: 'org.simulator.open-design',
      runHandle: `run_${'1'.repeat(32)}`,
      idempotencyKeyDigest: '2'.repeat(64),
      requestDigest: '3'.repeat(64),
      workerEpoch: 'epoch_folder_identity',
      state: 'accepted' as const,
    }
    const actualIds = ['actual-valid-module', 'actual-malformed-module']
    await createSession(root, { hidden: true, moduleAgentRun: ownership }, { sessionId: actualIds[0] })
    await createSession(root, { hidden: true, moduleAgentRun: ownership }, { sessionId: actualIds[1] })
    await createSession(root, {}, { sessionId: 'ordinary-victim' })
    await createSession(root, {}, { sessionId: 'ordinary-mismatch' })

    const rewriteHeader = (folderId: string, mutate: (header: Record<string, unknown>) => void) => {
      const file = join(getSessionPath(root, folderId), 'session.jsonl')
      const lines = readFileSync(file, 'utf8').split('\n')
      const header = JSON.parse(lines[0]!) as Record<string, unknown>
      mutate(header)
      lines[0] = JSON.stringify(header)
      writeFileSync(file, lines.join('\n'))
      sessionPersistenceQueue.cancel(folderId)
    }
    rewriteHeader(actualIds[0]!, (header) => { header.id = 'ordinary-victim' })
    rewriteHeader(actualIds[1]!, (header) => {
      header.id = 'ordinary-victim'
      header.moduleAgentRun = { transient: true }
    })
    rewriteHeader('ordinary-mismatch', (header) => { header.id = 'ordinary-victim' })
    const crashedImport = join(root, 'sessions', '.session-import-crashed')
    mkdirSync(crashedImport, { recursive: true })
    writeFileSync(join(crashedImport, 'session.jsonl'), '{"id":"attacker","createdAt":1}\n')

    const listed = listSessions(root)
    const listedIds = new Set(listed.map((session) => session.id))
    expect(listedIds.has('ordinary-victim')).toBe(true)
    expect(listedIds.has('ordinary-mismatch')).toBe(false)
    expect(listedIds.has(actualIds[0]!)).toBe(true)
    expect(listedIds.has(actualIds[1]!)).toBe(true)
    expect(listed.find((session) => session.id === actualIds[1])?.moduleAgentRun as unknown)
      .toEqual({ transient: true })
    expect(existsSync(crashedImport)).toBe(false)
  })

  it('commits a Host-preallocated Session ID exactly once', async () => {
    const root = mkdtempSync(join(tmpdir(), 'session-create-preallocated-'))
    roots.push(root)
    const sessionId = 'preallocated-module-session'

    const created = await createSession(root, { hidden: true }, { sessionId })
    expect(created.id).toBe(sessionId)
    expect(existsSync(getSessionPath(root, sessionId))).toBe(true)
    await expect(createSession(root, { hidden: true }, { sessionId })).rejects.toThrow(
      `Session ${sessionId} already exists`,
    )
    sessionPersistenceQueue.cancel(sessionId)
  })

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
