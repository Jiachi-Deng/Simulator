/**
 * Tests for SessionPersistenceQueue in sessions/persistence-queue.ts
 *
 * Key behavior: Writes to the same session must be serialized to prevent
 * race conditions when rapid successive flushes write to the same .tmp file.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync, readFileSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SessionPersistenceQueue } from '../src/sessions/persistence-queue.ts';
import type { StoredSession } from '../src/sessions/types.ts';

// Create a minimal stored session for testing
function createTestSession(
  id: string,
  workspaceRootPath: string,
  sdkSessionId?: string
): StoredSession {
  return {
    id,
    workspaceRootPath,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    lastMessageAt: Date.now(),
    messages: [],
    sdkSessionId,
  };
}

describe('SessionPersistenceQueue', () => {
  let testDir: string;
  let queue: SessionPersistenceQueue;

  beforeEach(() => {
    // Create a unique test directory
    testDir = join(tmpdir(), `persistence-queue-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    // Create sessions subdirectory structure
    mkdirSync(join(testDir, 'sessions', 'test-session'), { recursive: true });
    // Use 0ms debounce for immediate writes in tests
    queue = new SessionPersistenceQueue(0);
  });

  afterEach(() => {
    // Clean up test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('writes session to disk', async () => {
    const session = createTestSession('test-session', testDir, 'sdk-123');
    queue.enqueue(session);
    await queue.flush('test-session');

    const filePath = join(testDir, 'sessions', 'test-session', 'session.jsonl');
    expect(existsSync(filePath)).toBe(true);

    const content = readFileSync(filePath, 'utf-8');
    const header = JSON.parse(content.split('\n')[0]);
    expect(header.sdkSessionId).toBe('sdk-123');
  });

  it('serializes concurrent flushes for the same session', async () => {
    // This test verifies the fix for the race condition where
    // clearSessionForRecovery() + onSdkSessionIdUpdate() would
    // both flush rapidly and corrupt each other's writes.

    // Simulate the problematic sequence:
    // 1. First write with sdkSessionId = undefined (clearing)
    const session1 = createTestSession('test-session', testDir, undefined);
    queue.enqueue(session1);
    const flush1 = queue.flush('test-session');

    // 2. Second write with new sdkSessionId (before first completes)
    const session2 = createTestSession('test-session', testDir, 'new-thread-id');
    queue.enqueue(session2);
    const flush2 = queue.flush('test-session');

    // Wait for both to complete
    await Promise.all([flush1, flush2]);

    // The final file should have the NEWER data (new-thread-id)
    const filePath = join(testDir, 'sessions', 'test-session', 'session.jsonl');
    const content = readFileSync(filePath, 'utf-8');
    const header = JSON.parse(content.split('\n')[0]);

    // Before the fix, this could randomly be undefined due to race condition
    expect(header.sdkSessionId).toBe('new-thread-id');
  });

  it('keeps every concurrent flush joined to the latest claimed writer', async () => {
    let releaseOld!: () => void;
    const oldBlocked = new Promise<void>((resolve) => { releaseOld = resolve; });
    let oldReachedCommit!: () => void;
    const oldAtCommit = new Promise<void>((resolve) => { oldReachedCommit = resolve; });
    let releaseLatest!: () => void;
    const latestBlocked = new Promise<void>((resolve) => { releaseLatest = resolve; });
    let latestReachedCommit!: () => void;
    const latestAtCommit = new Promise<void>((resolve) => { latestReachedCommit = resolve; });
    queue = new SessionPersistenceQueue(60_000, {
      beforeCommit: async (session) => {
        if (session.sdkSessionId === 'old-in-flight') {
          oldReachedCommit();
          await oldBlocked;
        }
        if (session.sdkSessionId === 'latest-pending') {
          latestReachedCommit();
          await latestBlocked;
        }
      },
    });

    queue.enqueue(createTestSession('test-session', testDir, 'old-in-flight'));
    const oldFlush = queue.flush('test-session');
    await oldAtCommit;

    queue.enqueue(createTestSession('test-session', testDir, 'intermediate-pending'));
    const firstWaitingFlush = queue.flush('test-session');
    queue.enqueue(createTestSession('test-session', testDir, 'latest-pending'));
    let latestFlushSettled = false;
    const latestFlush = queue.flush('test-session').then(() => { latestFlushSettled = true; });

    releaseOld();
    await latestAtCommit;
    await Promise.resolve();
    expect(latestFlushSettled).toBe(false);

    releaseLatest();
    await Promise.all([oldFlush, firstWaitingFlush, latestFlush]);
    const filePath = join(testDir, 'sessions', 'test-session', 'session.jsonl');
    expect(JSON.parse(readFileSync(filePath, 'utf-8').split('\n')[0]).sdkSessionId).toBe('latest-pending');
  });

  it('lets a durable flush observe a failure from the ordinary writer it joins', async () => {
    let releaseWrite!: () => void;
    const writeBlocked = new Promise<void>((resolve) => { releaseWrite = resolve; });
    let reachedCommit!: () => void;
    const atCommit = new Promise<void>((resolve) => { reachedCommit = resolve; });
    queue = new SessionPersistenceQueue(60_000, {
      beforeCommit: async () => {
        reachedCommit();
        await writeBlocked;
        throw new Error('injected-write-failure');
      },
    });

    queue.enqueue(createTestSession('test-session', testDir, 'will-fail'));
    const ordinaryFlush = queue.flush('test-session').then(
      () => 'resolved' as const,
      () => 'rejected' as const,
    );
    await atCommit;
    const durableFlush = queue.flushDurably('test-session').then(
      () => 'resolved' as const,
      (error: unknown) => error,
    );

    releaseWrite();
    expect(await ordinaryFlush).toBe('resolved');
    const durableFailure = await durableFlush;
    expect(durableFailure).toBeInstanceOf(Error);
    expect((durableFailure as Error).message).toBe('injected-write-failure');
  });

  it('lets a later pending snapshot repair an earlier failure in the same durable drain', async () => {
    let releaseFailedWrite!: () => void;
    const failedWriteBlocked = new Promise<void>((resolve) => { releaseFailedWrite = resolve; });
    let failedWriteReachedCommit!: () => void;
    const failedWriteAtCommit = new Promise<void>((resolve) => { failedWriteReachedCommit = resolve; });
    let repairedWriteReachedCommit!: () => void;
    const repairedWriteAtCommit = new Promise<void>((resolve) => { repairedWriteReachedCommit = resolve; });
    queue = new SessionPersistenceQueue(60_000, {
      beforeCommit: async (session) => {
        if (session.sdkSessionId === 'failed-write') {
          failedWriteReachedCommit();
          await failedWriteBlocked;
          throw new Error('repairable-write-failure');
        }
        if (session.sdkSessionId === 'repaired-write') repairedWriteReachedCommit();
      },
    });

    queue.enqueue(createTestSession('test-session', testDir, 'failed-write'));
    const ordinaryFlush = queue.flush('test-session');
    await failedWriteAtCommit;
    queue.enqueue(createTestSession('test-session', testDir, 'repaired-write'));
    const durableFlush = queue.flushDurably('test-session');

    releaseFailedWrite();
    await repairedWriteAtCommit;
    await Promise.all([ordinaryFlush, durableFlush]);

    const filePath = join(testDir, 'sessions', 'test-session', 'session.jsonl');
    expect(JSON.parse(readFileSync(filePath, 'utf-8').split('\n')[0]).sdkSessionId).toBe('repaired-write');
  });

  it('contains ordinary write failures without rejection or an unhandled rejection', async () => {
    queue = new SessionPersistenceQueue(60_000, {
      beforeCommit: async () => {
        throw new Error('contained-write-failure');
      },
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      queue.enqueue(createTestSession('test-session', testDir, 'will-fail-safely'));
      const result = await queue.flush('test-session').then(
        () => 'resolved' as const,
        () => 'rejected' as const,
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect(result).toBe('resolved');
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('allows parallel writes to different sessions', async () => {
    // Different sessions should write in parallel without blocking each other
    mkdirSync(join(testDir, 'sessions', 'session-a'), { recursive: true });
    mkdirSync(join(testDir, 'sessions', 'session-b'), { recursive: true });

    const sessionA = createTestSession('session-a', testDir, 'id-a');
    const sessionB = createTestSession('session-b', testDir, 'id-b');

    queue.enqueue(sessionA);
    queue.enqueue(sessionB);

    // Flush both in parallel
    await Promise.all([
      queue.flush('session-a'),
      queue.flush('session-b'),
    ]);

    // Both should be written correctly
    const contentA = readFileSync(
      join(testDir, 'sessions', 'session-a', 'session.jsonl'),
      'utf-8'
    );
    const contentB = readFileSync(
      join(testDir, 'sessions', 'session-b', 'session.jsonl'),
      'utf-8'
    );

    expect(JSON.parse(contentA.split('\n')[0]).sdkSessionId).toBe('id-a');
    expect(JSON.parse(contentB.split('\n')[0]).sdkSessionId).toBe('id-b');
  });

  it('lets an authoritative snapshot supersede a stuck older writer without late regression', async () => {
    let releaseOld!: () => void;
    const oldBlocked = new Promise<void>((resolve) => { releaseOld = resolve; });
    let oldReachedCommit!: () => void;
    const oldAtCommit = new Promise<void>((resolve) => { oldReachedCommit = resolve; });
    queue = new SessionPersistenceQueue(60_000, {
      beforeCommit: async (session) => {
        if (session.sdkSessionId !== 'old-active-state') return;
        oldReachedCommit();
        await oldBlocked;
      },
    });

    queue.enqueue(createTestSession('test-session', testDir, 'old-active-state'));
    const staleFlush = queue.flush('test-session');
    await oldAtCommit;

    await queue.supersede(createTestSession('test-session', testDir, 'terminal-authority'));
    const filePath = join(testDir, 'sessions', 'test-session', 'session.jsonl');
    expect(JSON.parse(readFileSync(filePath, 'utf-8').split('\n')[0]).sdkSessionId).toBe('terminal-authority');

    releaseOld();
    await staleFlush;
    expect(JSON.parse(readFileSync(filePath, 'utf-8').split('\n')[0]).sdkSessionId).toBe('terminal-authority');
    expect(readdirSync(join(testDir, 'sessions', 'test-session')).filter((name) => name.includes('.tmp.'))).toEqual([]);
  });

  it('keeps flush and flushAll joined to a blocked authoritative supersede', async () => {
    let releaseAuthority!: () => void;
    const authorityBlocked = new Promise<void>((resolve) => { releaseAuthority = resolve; });
    let authorityReachedCommit!: () => void;
    const authorityAtCommit = new Promise<void>((resolve) => { authorityReachedCommit = resolve; });
    queue = new SessionPersistenceQueue(60_000, {
      beforeCommit: async (session) => {
        if (session.sdkSessionId !== 'terminal-authority') return;
        authorityReachedCommit();
        await authorityBlocked;
      },
    });

    const authorityWrite = queue.supersede(
      createTestSession('test-session', testDir, 'terminal-authority'),
    );
    await authorityAtCommit;

    let flushSettled = false;
    let flushAllSettled = false;
    const concurrentFlush = queue.flush('test-session').then(() => { flushSettled = true; });
    const concurrentFlushAll = queue.flushAll().then(() => { flushAllSettled = true; });
    await Promise.resolve();
    expect(flushSettled).toBe(false);
    expect(flushAllSettled).toBe(false);

    releaseAuthority();
    await Promise.all([authorityWrite, concurrentFlush, concurrentFlushAll]);
    const filePath = join(testDir, 'sessions', 'test-session', 'session.jsonl');
    expect(JSON.parse(readFileSync(filePath, 'utf-8').split('\n')[0]).sdkSessionId).toBe('terminal-authority');
  });

  it('commits a blocked authority before a concurrently enqueued autosave can supersede it', async () => {
    let releaseAuthority!: () => void;
    const authorityBlocked = new Promise<void>((resolve) => { releaseAuthority = resolve; });
    let authorityReachedCommit!: () => void;
    const authorityAtCommit = new Promise<void>((resolve) => { authorityReachedCommit = resolve; });
    queue = new SessionPersistenceQueue(60_000, {
      beforeCommit: async (session) => {
        if (session.sdkSessionId !== 'terminal-authority') return;
        authorityReachedCommit();
        await authorityBlocked;
      },
    });

    queue.enqueue(createTestSession('test-session', testDir, 'baseline'));
    await queue.flush('test-session');
    const authorityWrite = queue.supersede(
      createTestSession('test-session', testDir, 'terminal-authority'),
    );
    await authorityAtCommit;
    queue.enqueue(createTestSession('test-session', testDir, 'terminal-autosave'));

    releaseAuthority();
    await authorityWrite;
    const filePath = join(testDir, 'sessions', 'test-session', 'session.jsonl');
    expect(JSON.parse(readFileSync(filePath, 'utf-8').split('\n')[0]).sdkSessionId).toBe('terminal-authority');

    await queue.flush('test-session');
    expect(JSON.parse(readFileSync(filePath, 'utf-8').split('\n')[0]).sdkSessionId).toBe('terminal-autosave');
  });

  it('contains a failing authority for fire-and-forget flush and safely drains its queued retry', async () => {
    let releaseAuthority!: () => void;
    const authorityBlocked = new Promise<void>((resolve) => { releaseAuthority = resolve; });
    let authorityReachedCommit!: () => void;
    const authorityAtCommit = new Promise<void>((resolve) => { authorityReachedCommit = resolve; });
    let retryReachedCommit!: () => void;
    const retryAtCommit = new Promise<void>((resolve) => { retryReachedCommit = resolve; });
    queue = new SessionPersistenceQueue(0, {
      beforeCommit: async (session) => {
        if (session.sdkSessionId === 'failing-authority') {
          authorityReachedCommit();
          await authorityBlocked;
          throw new Error('injected-authority-failure');
        }
        if (session.sdkSessionId === 'safe-retry') retryReachedCommit();
      },
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const authorityResult = queue.supersede(
        createTestSession('test-session', testDir, 'failing-authority'),
      ).then(
        () => 'resolved' as const,
        (error: unknown) => error,
      );
      await authorityAtCommit;
      // The 0ms debounce path joins the never-reject tracked authority tail.
      queue.enqueue(createTestSession('test-session', testDir, 'safe-retry'));
      releaseAuthority();

      expect(await authorityResult).toBeInstanceOf(Error);
      await retryAtCommit;
      await queue.flush('test-session');
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
      const filePath = join(testDir, 'sessions', 'test-session', 'session.jsonl');
      expect(JSON.parse(readFileSync(filePath, 'utf-8').split('\n')[0]).sdkSessionId).toBe('safe-retry');
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('rejects a cancelled authority and cannot resurrect the deleted session', async () => {
    let releaseAuthority!: () => void;
    const authorityBlocked = new Promise<void>((resolve) => { releaseAuthority = resolve; });
    let authorityReachedCommit!: () => void;
    const authorityAtCommit = new Promise<void>((resolve) => { authorityReachedCommit = resolve; });
    queue = new SessionPersistenceQueue(60_000, {
      beforeCommit: async () => {
        authorityReachedCommit();
        await authorityBlocked;
      },
    });

    const authorityResult = queue.supersede(
      createTestSession('test-session', testDir, 'must-not-resurrect'),
    ).then(
      () => 'resolved' as const,
      (error: unknown) => error,
    );
    await authorityAtCommit;
    queue.cancel('test-session');
    const filePath = join(testDir, 'sessions', 'test-session', 'session.jsonl');
    try { unlinkSync(filePath); } catch { /* The authority has not committed. */ }

    releaseAuthority();
    expect(await authorityResult).toBeInstanceOf(Error);
    expect(existsSync(filePath)).toBe(false);
    expect(readdirSync(join(testDir, 'sessions', 'test-session')).filter((name) => name.includes('.tmp.'))).toEqual([]);
  });

  it('invalidates an in-flight writer on cancel so deletion cannot resurrect the session', async () => {
    let releaseWrite!: () => void;
    const writeBlocked = new Promise<void>((resolve) => { releaseWrite = resolve; });
    let reachedCommit!: () => void;
    const atCommit = new Promise<void>((resolve) => { reachedCommit = resolve; });
    queue = new SessionPersistenceQueue(60_000, {
      beforeCommit: async () => {
        reachedCommit();
        await writeBlocked;
      },
    });

    queue.enqueue(createTestSession('test-session', testDir, 'must-not-resurrect'));
    const staleFlush = queue.flush('test-session');
    await atCommit;
    queue.cancel('test-session');
    const filePath = join(testDir, 'sessions', 'test-session', 'session.jsonl');
    try { unlinkSync(filePath); } catch { /* The staged writer has not committed yet. */ }

    releaseWrite();
    await staleFlush;
    expect(existsSync(filePath)).toBe(false);
    expect(readdirSync(join(testDir, 'sessions', 'test-session')).filter((name) => name.includes('.tmp.'))).toEqual([]);
  });

  it('rejects a durable flush when its in-flight generation is cancelled', async () => {
    let releaseWrite!: () => void;
    const writeBlocked = new Promise<void>((resolve) => { releaseWrite = resolve; });
    let reachedCommit!: () => void;
    const atCommit = new Promise<void>((resolve) => { reachedCommit = resolve; });
    queue = new SessionPersistenceQueue(60_000, {
      beforeCommit: async () => {
        reachedCommit();
        await writeBlocked;
      },
    });

    queue.enqueue(createTestSession('test-session', testDir, 'must-be-durable'));
    const durableFlush = queue.flushDurably('test-session').then(
      () => 'resolved' as const,
      (error: unknown) => error,
    );
    await atCommit;
    queue.cancel('test-session');
    releaseWrite();

    const result = await durableFlush;
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toBe('Session persistence was superseded before durable commit');
  });

  it('does not let a post-cancel same-ID generation satisfy the old durable waiter', async () => {
    let releaseOld!: () => void;
    const oldBlocked = new Promise<void>((resolve) => { releaseOld = resolve; });
    let oldReachedCommit!: () => void;
    const oldAtCommit = new Promise<void>((resolve) => { oldReachedCommit = resolve; });
    let releaseNew!: () => void;
    const newBlocked = new Promise<void>((resolve) => { releaseNew = resolve; });
    let newReachedCommit!: () => void;
    const newAtCommit = new Promise<void>((resolve) => { newReachedCommit = resolve; });
    queue = new SessionPersistenceQueue(60_000, {
      beforeCommit: async (session) => {
        if (session.sdkSessionId === 'old-generation') {
          oldReachedCommit();
          await oldBlocked;
        }
        if (session.sdkSessionId === 'new-generation') {
          newReachedCommit();
          await newBlocked;
        }
      },
    });

    queue.enqueue(createTestSession('test-session', testDir, 'old-generation'));
    const oldDurableFlush = queue.flushDurably('test-session').then(
      () => 'resolved' as const,
      (error: unknown) => error,
    );
    await oldAtCommit;
    queue.cancel('test-session');

    queue.enqueue(createTestSession('test-session', testDir, 'new-generation'));
    const newDurableFlush = queue.flushDurably('test-session').then(
      () => 'resolved' as const,
      (error: unknown) => error,
    );
    await newAtCommit;

    releaseOld();
    releaseNew();
    const [oldResult, newResult] = await Promise.all([oldDurableFlush, newDurableFlush]);
    expect(oldResult).toBeInstanceOf(Error);
    expect((oldResult as Error).message).toBe('Session persistence was superseded before durable commit');
    expect(newResult).toBe('resolved');
  });

  it('releases live lifecycle tokens after many unique Session cancellations', () => {
    queue = new SessionPersistenceQueue(60_000);
    for (let index = 0; index < 1_000; index++) {
      const sessionId = `cancelled-session-${index}`;
      queue.enqueue(createTestSession(sessionId, testDir, `sdk-${index}`));
      queue.cancel(sessionId);
    }

    expect(queue.pendingCount).toBe(0);
    expect(queue.liveLifecycleCount).toBe(0);
  });
});
