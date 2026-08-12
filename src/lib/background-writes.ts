/**
 * ─── Background write registry ────────────────────────────────────────────
 *
 * Two write paths in this codebase are deliberately fire-and-forget, because
 * blocking a request on them would be worse than losing them:
 *
 *   - `audit()` (src/lib/audit.ts) — the AuditLog INSERT
 *   - the `lastUsedAt` bump on a developer API key (src/lib/auth-guard.ts)
 *
 * "Not awaited by the caller" is the point. "Untracked by anyone" was an
 * accident, and it cost two things:
 *
 * 1. A LOST WRITE AT SHUTDOWN. The worker's drain (src/worker/main.ts) waits
 *    for in-flight message handlers and then calls `prisma.$disconnect()`.
 *    An audit INSERT still in flight at that moment is discarded — silently,
 *    because both call sites swallow their own errors. For a table whose
 *    entire purpose is "what happened, and when", dropping records at
 *    exactly the moment a process is being terminated is the worst time to
 *    do it.
 *
 * 2. A DEADLOCK AGAINST TRUNCATE. tests/db/helpers.ts truncates every table
 *    between tests. An unawaited INSERT holding a lock on AuditLog and
 *    waiting on a User FK check, against a TRUNCATE holding User and waiting
 *    on AuditLog, is a cycle — Postgres 40P01. It showed up on the second
 *    run of the DB-backed CI Job and not the first. See
 *    tests/db/background-writes.test.ts for the full incident.
 *
 * Registering the promise costs nothing at the call site and makes both
 * fixable. Callers still do not await; something that cares about
 * quiescence — a shutdown path, a truncate — awaits on their behalf.
 *
 * NOT a queue, a retry mechanism, or a durability guarantee. These writes
 * remain best-effort. This only answers "are they finished yet".
 */

const inFlight = new Set<Promise<unknown>>();

/**
 * Register a fire-and-forget write so `flushBackgroundWrites()` can wait for
 * it. The promise is not awaited here and its rejection is not re-thrown —
 * the caller keeps whatever error handling it already had.
 */
export function trackBackgroundWrite(write: Promise<unknown>): void {
  // Swallow here as well as at the call site. An entry sitting in the set
  // with no rejection handler of its own would surface as an
  // unhandledRejection, which in the worker is a process-level fault.
  const tracked = write.catch(() => {});
  inFlight.add(tracked);
  void tracked.finally(() => {
    inFlight.delete(tracked);
  });
}

/**
 * Resolve once every currently-tracked write has settled.
 *
 * Drains in PASSES rather than awaiting one snapshot: settling a write can
 * enqueue another (a handler that audits what it just finished), and
 * returning while one is still in flight is precisely the deadlock this
 * exists to prevent. Bounded so a caller that audits in a tight loop cannot
 * wedge a shutdown here forever — at that point the writes are losable, and
 * a hung SIGTERM is not.
 *
 * Never rejects: a caller is asking whether the writes are finished, not
 * whether they succeeded.
 */
export async function flushBackgroundWrites(): Promise<void> {
  for (let pass = 0; pass < 10 && inFlight.size > 0; pass += 1) {
    // eslint-disable-next-line no-await-in-loop -- passes are inherently sequential: each one exists to catch writes enqueued by the previous one settling
    await Promise.allSettled([...inFlight]);
  }
}

/**
 * Number of writes currently in flight. Exposed for assertions and for
 * shutdown logging — not a control signal.
 */
export function pendingBackgroundWrites(): number {
  return inFlight.size;
}
