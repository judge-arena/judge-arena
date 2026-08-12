import { describe, it, expect, beforeEach } from 'vitest';
import { db, truncateAll, mkUser } from './helpers';
import { audit } from '@/lib/audit';
import { trackBackgroundWrite, flushBackgroundWrites } from '@/lib/background-writes';

// ─── Why this file exists ──────────────────────────────────────────────────
//
// The DB-backed CI Job (Stage 6) surfaced an intermittent Postgres deadlock
// on its SECOND run — 40P01, zero occurrences on run 1 and four on run 2,
// against identical test code:
//
//   Process 451 waits for RowShareLock on relation 16726;
//   blocked by process 449.
//   Process 449 waits for AccessExclusiveLock on relation 16861;
//   blocked by process 451.
//
// `audit()` is deliberately fire-and-forget: it does not await the INSERT,
// so the write can still be in flight when the test that triggered it ends.
// `truncateAll()` then issues TRUNCATE ... CASCADE, which takes an
// AccessExclusiveLock on every table. The in-flight INSERT holds a lock on
// AuditLog and needs a RowShareLock on User for its FK check; the TRUNCATE
// already holds User and wants AuditLog. That is a cycle, and Postgres kills
// one side of it.
//
// The reason this is worth a test rather than a retry: WHICH side dies is
// Postgres's choice. Both times it picked the audit write, whose `.catch()`
// swallows the error into a log line — so the suite stayed green at 286/286
// and only the pod log knew anything had happened. When it picks the
// TRUNCATE instead, `beforeEach` rejects and an unrelated test goes red.
// That is a flake generator sitting under the suite that guards Roadmap A.
//
// `src/lib/auth-guard.ts` has the same shape (an unawaited `lastUsedAt`
// update) and is strictly worse: its `.catch(() => {})` discards the error
// entirely, so its deadlock would not even reach the log. Hence a shared
// registry rather than an audit-specific flush.

beforeEach(async () => {
  await truncateAll();
});

describe('background write registry', () => {
  // The deterministic guard. Reverting flushBackgroundWrites() to a no-op
  // (or to a single non-awaiting pass) fails this every time, with no
  // reliance on hitting the lock race.
  it('does not resolve until every tracked write has settled', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    trackBackgroundWrite(pending);

    let flushed = false;
    const flushing = flushBackgroundWrites().then(() => {
      flushed = true;
    });

    // Give the microtask queue every chance to run flushing to completion.
    // If flush is a no-op, `flushed` is already true here.
    await Promise.resolve();
    await Promise.resolve();
    expect(flushed).toBe(false);

    release();
    await flushing;
    expect(flushed).toBe(true);
  });

  it('a rejected tracked write does not make the flush reject', async () => {
    // Background writes are best-effort by design; a caller flushing them
    // is asking "are they finished", not "did they succeed". If a rejection
    // propagated here it would take down the shutdown path and truncateAll.
    trackBackgroundWrite(Promise.reject(new Error('write failed')));
    await expect(flushBackgroundWrites()).resolves.toBeUndefined();
  });

  it('drains writes that are enqueued while the flush is already awaiting', async () => {
    // A single Promise.all over a snapshot would miss this one and return
    // with a write still in flight — which is the deadlock, reintroduced.
    let release!: () => void;
    const first = new Promise<void>((resolve) => {
      release = resolve;
    });
    trackBackgroundWrite(first);

    let secondSettled = false;
    const flushing = flushBackgroundWrites();

    release();
    // Enqueued after the flush began, and settling on a TIMER rather than a
    // microtask. An already-scheduled microtask would run during the single
    // `await` below even if the flush did nothing, so a resolved promise
    // here would let a no-op implementation pass this test.
    trackBackgroundWrite(
      new Promise<void>((resolve) => {
        setTimeout(() => {
          secondSettled = true;
          resolve();
        }, 50);
      })
    );

    await flushing;
    expect(secondSettled).toBe(true);
  });
});

describe('truncateAll vs in-flight audit writes (40P01 regression)', () => {
  it('lets in-flight audit writes land before TRUNCATE takes its locks', async () => {
    const user = await mkUser();

    // Enough concurrent unawaited INSERTs to make the lock overlap likely
    // if truncateAll did not drain first.
    for (let i = 0; i < 25; i += 1) {
      audit({ action: 'user.login', userId: user.id, resource: 'session' });
    }

    await flushBackgroundWrites();
    expect(await db.auditLog.count()).toBe(25);

    // The operation that used to deadlock. It must complete, and it must
    // leave the table empty rather than losing the race to a straggler.
    await truncateAll();
    expect(await db.auditLog.count()).toBe(0);
  });
});
