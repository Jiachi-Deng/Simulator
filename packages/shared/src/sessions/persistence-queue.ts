import { writeFile, unlink } from 'fs/promises'
import { renameSync, unlinkSync } from 'fs'
import { randomUUID } from 'node:crypto'
import { dirname } from 'path'
import type { StoredSession, SessionHeader } from './types.js'
import { getSessionFilePath, ensureSessionsDir, ensureSessionDir } from './storage.js'
import { toPortablePath } from '../utils/paths.js'
import { createSessionHeader, makeSessionPathPortable, readSessionHeader } from './jsonl.js'
import { debug } from '../utils/debug.js'

interface PendingWrite {
  data: StoredSession
  timer: ReturnType<typeof setTimeout>
  generation: WriteGeneration
}

interface WriteGeneration {
  readonly sequence: number
}

type WriteOutcome = 'committed' | 'superseded'

export interface SessionPersistenceQueueHooks {
  /** Test-only scheduling seam. Production queues leave this undefined. */
  beforeCommit?: (session: StoredSession) => Promise<void>
}

interface HeaderMetadataSignature {
  name?: string
  labels?: string[]
  isFlagged?: boolean
  sessionStatus?: string
  permissionMode?: string
  hasUnread?: boolean
  lastReadMessageId?: string
}

function getHeaderMetadataSignature(header: SessionHeader): string {
  const signature: HeaderMetadataSignature = {
    name: header.name,
    labels: header.labels,
    isFlagged: header.isFlagged,
    sessionStatus: header.sessionStatus,
    permissionMode: header.permissionMode,
    hasUnread: header.hasUnread,
    lastReadMessageId: header.lastReadMessageId,
  }
  return JSON.stringify(signature)
}

function mergeHeaderWithExternalMetadata(localHeader: SessionHeader, diskHeader: SessionHeader): SessionHeader {
  return {
    ...localHeader,
    name: diskHeader.name,
    labels: diskHeader.labels,
    isFlagged: diskHeader.isFlagged,
    sessionStatus: diskHeader.sessionStatus,
    permissionMode: diskHeader.permissionMode,
    hasUnread: diskHeader.hasUnread,
    lastReadMessageId: diskHeader.lastReadMessageId,
  }
}

/**
 * Debounced async session persistence queue.
 * Prevents main thread blocking by using async writes and coalescing
 * rapid successive persist calls into a single write.
 *
 * IMPORTANT: Writes are serialized per-session to prevent race conditions
 * when rapid successive flushes (e.g., clearSessionForRecovery + onSdkSessionIdUpdate)
 * would otherwise write to the same .tmp file concurrently.
 */
class SessionPersistenceQueue {
  private pending = new Map<string, PendingWrite>()
  private writeInProgress = new Map<string, Promise<void>>()
  private lastWrittenHeaderSignature = new Map<string, string>()
  private currentGeneration = new Map<string, WriteGeneration>()
  private authoritativeGeneration = new Map<string, WriteGeneration>()
  private generationSequence = 0
  private backgroundFlushFailureLogs = 0
  private debounceMs: number
  private hooks: SessionPersistenceQueueHooks

  constructor(debounceMs = 500, hooks: SessionPersistenceQueueHooks = {}) {
    this.debounceMs = debounceMs
    this.hooks = hooks
  }

  /**
   * Queue a session for persistence. If a write is already pending for this
   * session, it will be replaced with the new data and the timer reset.
   */
  enqueue(session: StoredSession): void {
    const existing = this.pending.get(session.id)
    if (existing) {
      clearTimeout(existing.timer)
    }

    const generation = this.createGeneration()
    // Ordinary last-writer-wins updates fence an older ordinary writer as soon
    // as they are enqueued. A terminal/cleanup authority is the exception: it
    // must publish first, so its concurrently queued autosave stays pending
    // until flush claims it after the authority settles.
    if (!this.authoritativeGeneration.has(session.id)) {
      this.currentGeneration.set(session.id, generation)
    }

    const timer = setTimeout(() => {
      void this.flush(session.id).catch(() => {
        // Background persistence errors must never become unhandled rejections
        // in the shared/headless Host. Keep this bounded and omit error/session
        // details so provider or path data cannot leak into logs.
        if (this.backgroundFlushFailureLogs < 5) {
          this.backgroundFlushFailureLogs++
          console.error('[PersistenceQueue] Background session flush failed')
        }
      })
    }, this.debounceMs)

    this.pending.set(session.id, { data: session, timer, generation })
  }

  /**
   * Write a session to disk immediately in JSONL format.
   * Uses atomic write (write-to-temp-then-rename) to prevent corruption on crash.
   */
  private async write(sessionId: string): Promise<void> {
    const entry = this.pending.get(sessionId)
    if (!entry) return

    this.pending.delete(sessionId)
    // A pending snapshot created behind an authoritative writer becomes the
    // current ordinary generation only when it is actually claimed.
    this.currentGeneration.set(sessionId, entry.generation)

    try {
      await this.writeSnapshot(entry.data, entry.generation)
    } catch (error) {
      console.error(`[PersistenceQueue] Failed to write session ${sessionId}:`, error)
    }
  }

  /**
   * Supersede every older pending/in-flight snapshot and commit this snapshot
   * without waiting for the ordinary per-session write tail. The generation is
   * checked immediately before a synchronous atomic rename, so a stale writer
   * can finish staging bytes but can never publish them over this authority.
   *
   * This is intentionally narrow: transient Module terminal/cleanup state uses
   * it to remain available even if an earlier active-state write never settles.
   */
  async supersede(session: StoredSession): Promise<void> {
    const existing = this.pending.get(session.id)
    if (existing) clearTimeout(existing.timer)
    this.pending.delete(session.id)
    // Generation fencing makes the old writer harmless, so it must not remain
    // the scheduling authority for later writes after this supersede commits.
    this.writeInProgress.delete(session.id)
    const generation = this.createGeneration()
    this.currentGeneration.set(session.id, generation)
    this.authoritativeGeneration.set(session.id, generation)
    const authorityPromise = this.writeSnapshot(session, generation).then((outcome) => {
      if (outcome !== 'committed') {
        throw new Error('Authoritative session snapshot was superseded before commit')
      }
    })
    // `flush()` historically contains persistence failures because several
    // SessionManager callbacks intentionally call it fire-and-forget. Publish a
    // never-reject tracked tail while the supersede owner awaits the raw result.
    const trackedPromise = authorityPromise.catch(() => undefined)
    // Although this authority bypasses the old tail, it becomes the new tail:
    // flush/flushAll must not acknowledge durability while its atomic publish
    // is still pending. Equality-safe cleanup keeps a later supersede intact.
    this.writeInProgress.set(session.id, trackedPromise)
    try {
      await authorityPromise
    } finally {
      if (this.authoritativeGeneration.get(session.id) === generation) {
        this.authoritativeGeneration.delete(session.id)
      }
      if (this.writeInProgress.get(session.id) === trackedPromise) {
        this.writeInProgress.delete(session.id)
      }
    }
  }

  private createGeneration(): WriteGeneration {
    return { sequence: ++this.generationSequence }
  }

  private async writeSnapshot(data: StoredSession, generation: WriteGeneration): Promise<WriteOutcome> {
    const sessionId = data.id
    ensureSessionsDir(data.workspaceRootPath)
    ensureSessionDir(data.workspaceRootPath, sessionId)

    const filePath = getSessionFilePath(data.workspaceRootPath, sessionId)

    // Prepare session with portable paths for cross-machine compatibility
    const storageSession: StoredSession = {
      ...data,
      workspaceRootPath: toPortablePath(data.workspaceRootPath),
      workingDirectory: data.workingDirectory ? toPortablePath(data.workingDirectory) : undefined,
      sdkCwd: data.sdkCwd ? toPortablePath(data.sdkCwd) : undefined,
      lastUsedAt: Date.now(),
    }

    const localHeader = createSessionHeader(storageSession)
    const localSig = getHeaderMetadataSignature(localHeader)
    const diskHeader = readSessionHeader(filePath)
    const previousSig = this.lastWrittenHeaderSignature.get(sessionId)
    const diskSig = diskHeader ? getHeaderMetadataSignature(diskHeader) : undefined
    const hasMetadataMismatch = !!diskHeader && !!diskSig && diskSig !== localSig
    const hasExternalMetadataChange = !!diskHeader && !!diskSig && !!previousSig && diskSig !== previousSig
    const header = hasExternalMetadataChange && diskHeader
      ? mergeHeaderWithExternalMetadata(localHeader, diskHeader)
      : localHeader

    if (hasMetadataMismatch) {
      const baseline = previousSig ? `, previousSig=${previousSig.slice(0, 12)}` : ', previousSig=<none>'
      const mode = hasExternalMetadataChange ? 'disk preserved' : 'local preserved'
      debug(`[PersistenceQueue] Session ${sessionId} metadata mismatch detected (${mode}${baseline})`)
    }

    const sessionDir = dirname(filePath)
    const lines = [
      makeSessionPathPortable(JSON.stringify(header), sessionDir),
      ...storageSession.messages.map(m => makeSessionPathPortable(JSON.stringify(m), sessionDir)),
    ]
    const tmpFile = `${filePath}.tmp.${process.pid}.${generation.sequence}.${randomUUID()}`
    try {
      await writeFile(tmpFile, lines.join('\n') + '\n', 'utf-8')
      await this.hooks.beforeCommit?.(data)

      // No await is permitted between this fence and renameSync. That makes
      // generation comparison + publication one indivisible JS turn: either
      // this snapshot is still authoritative, or it only cleans up its temp.
      if (this.currentGeneration.get(sessionId) !== generation) return 'superseded'
      const finalSignature = getHeaderMetadataSignature(header)
      this.lastWrittenHeaderSignature.set(sessionId, finalSignature)
      try {
        renameSync(tmpFile, filePath)
      } catch (error) {
        const code = error instanceof Error && 'code' in error ? String(error.code) : ''
        if (code !== 'EEXIST' && code !== 'EPERM') throw error
        try { unlinkSync(filePath) } catch { /* Target may already be absent. */ }
        renameSync(tmpFile, filePath)
      }
      debug(`[PersistenceQueue] Wrote session ${sessionId}`)
      return 'committed'
    } finally {
      try { await unlink(tmpFile) } catch { /* Renamed or already cleaned. */ }
    }
  }

  /**
   * Immediately flush a specific session if pending.
   * Waits for any in-progress write to complete before starting a new one
   * to prevent race conditions on the shared .tmp file.
   */
  async flush(sessionId: string): Promise<void> {
    // Drain until both the current writer and pending slot are empty. Multiple
    // callers may await the same old writer; after it settles, only one caller
    // may claim the pending snapshot and the others must then join that new
    // writer. A single-pass implementation can otherwise replace the tracked
    // writer with a resolved no-op and acknowledge durability too early.
    while (true) {
      const inProgress = this.writeInProgress.get(sessionId)
      if (inProgress) {
        await inProgress
        continue
      }

      const entry = this.pending.get(sessionId)
      if (!entry) return
      clearTimeout(entry.timer)

      // Start new write and track it
      const writePromise = this.write(sessionId)
      this.writeInProgress.set(sessionId, writePromise)

      try {
        await writePromise
      } finally {
        if (this.writeInProgress.get(sessionId) === writePromise) {
          this.writeInProgress.delete(sessionId)
        }
      }
    }
  }

  /**
   * Cancel a pending write for a session (e.g., when deleting the session).
   */
  cancel(sessionId: string): void {
    const entry = this.pending.get(sessionId)
    if (entry) {
      clearTimeout(entry.timer)
      this.pending.delete(sessionId)
      debug(`[PersistenceQueue] Cancelled pending write for session ${sessionId}`)
    }
    // Removing the current generation invalidates every staged writer. A
    // future Session reusing this id receives a distinct generation object.
    this.currentGeneration.delete(sessionId)
    this.authoritativeGeneration.delete(sessionId)
    this.writeInProgress.delete(sessionId)
    this.lastWrittenHeaderSignature.delete(sessionId)
  }

  /**
   * Flush all pending sessions. Call this on app quit.
   */
  async flushAll(): Promise<void> {
    const sessionIds = new Set([
      ...this.pending.keys(),
      ...this.writeInProgress.keys(),
    ])
    await Promise.all([...sessionIds].map(id => this.flush(id)))
  }

  /**
   * Check if a session has a pending write.
   */
  hasPending(sessionId: string): boolean {
    return this.pending.has(sessionId)
  }

  /**
   * Get the metadata signature of the last header we wrote for a session.
   * Used by ConfigWatcher to suppress self-triggered metadata change events.
   */
  getLastWrittenSignature(sessionId: string): string | undefined {
    return this.lastWrittenHeaderSignature.get(sessionId)
  }

  /**
   * Get count of pending writes.
   */
  get pendingCount(): number {
    return this.pending.size
  }
}

// Singleton instance
export const sessionPersistenceQueue = new SessionPersistenceQueue()

// Named exports for testing/customization
export { SessionPersistenceQueue, getHeaderMetadataSignature, mergeHeaderWithExternalMetadata }
