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
 * `'already_done'` is intentionally overloaded to cover two distinct DB
 * states — a genuinely terminal (`completed`/`error`) row, AND a `running`
 * row still comfortably inside its lease (someone else's live claim, not
 * yet stale). Both mean the same thing to a `judgment.execute` consumer:
 * don't call the provider, just ack. Only a `running` row whose `updatedAt`
 * has aged past `LEASE_MS` (the original claimant presumably died
 * mid-flight — killed process, dropped connection, crashed before ack) is
 * worth reclaiming, and that reclaim is itself just another conditional
 * UPDATE (`status: 'running', updatedAt: { lt: staleBefore }`), so a second
 * racing reclaim attempt loses cleanly the same way the initial claim does
 * (falls through to `'already_done'`, not a crash or a double-claim).
 */

import { prisma } from '@/lib/db';

const EVALUATION_MODEL_TIMEOUT_MS = Number(process.env.EVALUATION_MODEL_TIMEOUT_MS ?? '120000');

/**
 * Claim lease: how long a `running` judgment is presumed still in-flight
 * before another delivery is allowed to reclaim it. Generous slack (30s)
 * over the model call's own timeout — the timeout bounds the provider call
 * itself, but the DB writes / event publish / finalization that happen
 * after the call returns need their own margin before a claimant is
 * declared dead.
 */
export const LEASE_MS = EVALUATION_MODEL_TIMEOUT_MS + 30_000;

export type ClaimResult = 'claimed' | 'already_done' | 'not_found' | 'stale_running';

/**
 * Attempt to claim `judgmentId` for processing.
 *
 * - `'claimed'` — this call won a normal `pending -> running` transition;
 *   proceed to process it.
 * - `'stale_running'` — the row was `running` but its lease had expired;
 *   this call won the reclaim (fresh `updatedAt`/incremented
 *   `attemptCount`); proceed to process it exactly like `'claimed'`.
 * - `'already_done'` — the row is terminal (`completed`/`error`), OR it's
 *   `running` and still within its lease (a live claim — either someone
 *   else's, or this call lost a reclaim race to a concurrent caller). Ack
 *   without calling the provider.
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

  if (row.status !== 'running') {
    // 'completed' or 'error' — terminal, nothing to reclaim.
    return 'already_done';
  }

  const staleBefore = new Date(now.getTime() - LEASE_MS);
  if (row.updatedAt >= staleBefore) {
    // Running, still within lease — duplicate delivery of a live claim.
    // The holder will finish (and ack) or its lease will eventually expire.
    return 'already_done';
  }

  const reclaim = await prisma.modelJudgment.updateMany({
    where: { id: judgmentId, status: 'running', updatedAt: { lt: staleBefore } },
    data: { status: 'running', startedAt: now, attemptCount: { increment: 1 } },
  });
  if (reclaim.count > 0) return 'stale_running';

  // Lost the reclaim race to a concurrent caller (or the original claimant
  // resumed and touched the row again just in time) — treat as a live claim
  // this call doesn't own.
  return 'already_done';
}
