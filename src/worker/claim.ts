/**
 * ─── Idempotent Judgment Claim ─────────────────────────────────────────────
 *
 * A single conditional UPDATE is the whole claim protocol: `pending ->
 * running` only succeeds for exactly one caller, even under concurrent
 * redelivery (two workers racing the same `judgment.execute` message, or a
 * message redelivered while the original consumer is still mid-flight) —
 * Postgres's row-level locking on `UPDATE ... WHERE` makes the race atomic,
 * no `SELECT ... FOR UPDATE` or app-level mutex required.
 *
 * `'already_done'` means a genuinely terminal row (`completed`/`error`) —
 * don't call the provider, just ack. A `running` row still comfortably
 * inside its lease (someone else's live claim, not yet stale — or this
 * call's own loss of the reclaim race below) is a DIFFERENT outcome,
 * `'in_progress'`: unlike a terminal row, it isn't safe to just strand the
 * message until the lease expires (Task 8's reclaim-sweeping reaper doesn't
 * exist yet, so nothing would ever re-check it) — the consumer instead
 * republishes the same message onto the 30s retry queue for a delayed
 * re-check (see judgment-consumer.ts). Only a `running` row whose
 * `updatedAt` has aged past `LEASE_MS` (the original claimant presumably
 * died mid-flight — killed process, dropped connection, crashed before ack)
 * is worth reclaiming, and that reclaim is itself just another conditional
 * UPDATE (`status: 'running', updatedAt: { lt: staleBefore }`), so a second
 * racing reclaim attempt loses cleanly the same way the initial claim does
 * (falls through to `'in_progress'`, not a crash or a double-claim).
 *
 * `'retry_claim'` covers a narrow inspection race: the initial conditional
 * UPDATE (`WHERE status = 'pending'`) can find 0 rows because the row
 * wasn't `pending` at that instant, yet by the time this function's
 * follow-up `SELECT` runs, a concurrent write (e.g. another delivery's
 * retryable-error disposition resetting the row back to `pending`) has
 * landed in that gap and the row reads `pending` again — a real, live
 * claim opportunity, not a terminal state. Misreporting it as
 * `'already_done'` would silently strand a claimable judgment. The caller
 * retries `claimJudgment()` once more; if that still doesn't resolve to
 * `'claimed'`/`'stale_running'`, nack-requeue the message rather than loop
 * claim attempts inline.
 */

import { prisma } from '@/lib/db';
import { leaseMsFor, resolveTimeoutBudgets } from '@/lib/llm/timeout-policy';

/**
 * Claim lease: how long a `running` judgment is presumed still in-flight
 * before another delivery is allowed to reclaim it. Generous slack (30s,
 * `POST_CALL_SLACK_MS`) over the model call's own budget — the budget bounds
 * the provider call itself, but the DB writes / event publish / finalization
 * that happen after the call returns need their own margin before a claimant
 * is declared dead.
 *
 * ── DERIVED FROM THE HARD CAP, NOT THE INITIAL BUDGET. THIS IS A CORRECTNESS
 *    BUG FIX, NOT A TUNING CHANGE. ─────────────────────────────────────────
 * This used to read `EVALUATION_MODEL_TIMEOUT_MS + 30_000`. Under the
 * escalating timeout (`src/lib/llm/timeout-policy.ts`) that variable is only
 * the ALERT point — a provider call may now legitimately run to
 * `EVALUATION_MODEL_HARD_CAP_MS` (15 minutes) before anything aborts it. The
 * old derivation therefore produced a 330s lease over a call allowed to take
 * 900s.
 *
 * What that costs, concretely: nothing writes the judgment row between the
 * claim above and the persist after the provider returns, so `updatedAt`
 * sits at claim time for the entire call. `src/worker/reaper.ts`'s
 * `reclaimStaleJudgments` sweeps `status: 'running' AND updatedAt < now −
 * LEASE_MS`, so at t=330s it would find a PERFECTLY HEALTHY in-flight
 * judgment, declare its claimant dead, and republish it — a second provider
 * call for the same row (billed, and on the local CPU judge a second
 * quarter-hour occupancy of a server that does one call at a time), then two
 * writers racing to persist one judgment. The row that survives is whichever
 * finished last; nothing in the data afterwards says it happened twice.
 *
 * ONE hard cap, not two: the second of the two allowed attempts arrives as a
 * separate delivery that re-claims the row and re-stamps `updatedAt`, so it
 * gets its own lease. Read at module load (matching this file's existing
 * convention and `run-launch.ts`/`run-create-consumer.ts`), which is why
 * `tests/lib/timeout-policy.test.ts` asserts the relationship
 * `LEASE_MS > hardCapMs` rather than a literal.
 */
export const LEASE_MS = leaseMsFor(resolveTimeoutBudgets());

export type ClaimResult = 'claimed' | 'already_done' | 'not_found' | 'stale_running' | 'in_progress' | 'retry_claim';

/**
 * Attempt to claim `judgmentId` for processing.
 *
 * - `'claimed'` — this call won a normal `pending -> running` transition;
 *   proceed to process it.
 * - `'stale_running'` — the row was `running` but its lease had expired;
 *   this call won the reclaim (fresh `updatedAt`/incremented
 *   `attemptCount`); proceed to process it exactly like `'claimed'`.
 * - `'in_progress'` — the row is `running` and still within its lease (a
 *   live claim — either someone else's, or this call lost a reclaim race to
 *   a concurrent caller). Don't call the provider; the caller republishes
 *   this same message onto the 30s retry queue for a delayed re-check
 *   rather than dropping it (see judgment-consumer.ts).
 * - `'already_done'` — the row is terminal (`completed`/`error`). Ack
 *   without calling the provider or republishing anything.
 * - `'retry_claim'` — an inspection-race artifact: the row read `pending`
 *   again by the time of the follow-up SELECT (see module doc). The caller
 *   should call `claimJudgment()` once more.
 * - `'not_found'` — no such judgment row. Ack (nothing to do).
 */
export async function claimJudgment(judgmentId: string): Promise<ClaimResult> {
  const now = new Date();

  const claim = await prisma.modelJudgment.updateMany({
    where: { id: judgmentId, status: 'pending' },
    data: { status: 'running', startedAt: now, attemptCount: { increment: 1 } },
  });
  if (claim.count > 0) return 'claimed';

  const row = await prisma.modelJudgment.findUnique({
    where: { id: judgmentId },
    select: { status: true, updatedAt: true },
  });
  if (!row) return 'not_found';

  if (row.status === 'pending') {
    // Inspection race: the row wasn't 'pending' when the conditional UPDATE
    // above ran, but is 'pending' again now — a concurrent reset landed in
    // the gap. Live claim opportunity; let the caller retry the attempt.
    return 'retry_claim';
  }

  if (row.status !== 'running') {
    // 'completed' or 'error' — terminal, nothing to reclaim.
    return 'already_done';
  }

  const staleBefore = new Date(now.getTime() - LEASE_MS);
  if (row.updatedAt >= staleBefore) {
    // Running, still within lease — duplicate delivery of a live claim.
    // The holder will finish (and ack) or its lease will eventually expire.
    return 'in_progress';
  }

  const reclaim = await prisma.modelJudgment.updateMany({
    where: { id: judgmentId, status: 'running', updatedAt: { lt: staleBefore } },
    data: { status: 'running', startedAt: now, attemptCount: { increment: 1 } },
  });
  if (reclaim.count > 0) return 'stale_running';

  // Lost the reclaim race to a concurrent caller (or the original claimant
  // resumed and touched the row again just in time) — treat as a live claim
  // this call doesn't own.
  return 'in_progress';
}
