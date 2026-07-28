/**
 * ─── Cluster Reaper ─────────────────────────────────────────────────────────
 *
 * A self-healing safety net, independent of RabbitMQ's own redelivery
 * mechanics. Under normal operation, a worker that dies mid-message drops
 * its AMQP connection, and the broker redelivers the unacked message — that
 * redelivery is what drives claim.ts's own `'stale_running'` reclaim path
 * (see judgment-consumer.ts). But a worker that HANGS (deadlocked,
 * event-loop-blocked, or otherwise unresponsive without actually
 * disconnecting) never triggers that: the message stays "delivered but
 * unacked" forever from the broker's point of view, and the `ModelJudgment`
 * row it claimed stays `running` forever from the DB's. This module scans
 * the DB directly, on its own timer, for exactly that condition — and for
 * the parallel condition at the run level (an `EvaluationRun` whose
 * `deadlineAt` has passed while it's still `pending`/`judging`).
 *
 * ── Cluster-wide single runner ──────────────────────────────────────────────
 * Every worker replica runs `startReaper()`, but only one replica's sweep
 * does real work at a time: each tick, every replica races to
 * `SET reaper:lock NX PX 55000` (mirrors `llm/breaker-redis.ts`'s probe-lock
 * pattern) — the TTL (55s) is deliberately shorter than the sweep interval
 * (60s), so the lock always expires before the next tick even starts,
 * without needing an explicit release. Losing the race is not an error;
 * that replica just skips this tick's sweep (some other replica is already
 * covering it).
 *
 * ── (a) Stale `running` judgment reclaim ────────────────────────────────────
 * `status = 'running' AND updatedAt < now - LEASE_MS` (same lease constant
 * claim.ts's own reclaim path uses). For each: a conditional
 * `running -> pending` reset — SAME shape as claim.ts's guarded UPDATE, but
 * deliberately does NOT increment `attemptCount` here (unlike claim.ts's own
 * reclaim). The reaper isn't claiming the judgment for itself to process; it
 * is only making it claimable again for whichever consumer picks up the
 * republished message next — THAT consumer's own `claimJudgment()` call
 * performs the actual `pending -> running` transition and its own
 * `attemptCount` increment. Incrementing here too would double-count.
 * `publishJudgmentExecute` republishes with `attempt: attemptCount + 1`
 * (the count as read, pre-reset) — matches the numbering
 * judgment-consumer.ts's own retry disposition uses
 * (`effectiveAttempt + 1`), so the next claim's own increment lines back up.
 *
 * ── (b) Overdue-run sweep ────────────────────────────────────────────────────
 * `status IN ('pending','judging') AND deadlineAt < now`. Two cases:
 *   - Less than 3 sweep intervals (~180s) past the deadline: re-publish
 *     `judgment.execute` for every judgment on the run still `pending`
 *     (never `running` — those are (a)'s job). Safe to repeat sweep after
 *     sweep: `claimJudgment()` is idempotent, a duplicate `judgment.execute`
 *     for an already-claimed/already-done row just no-ops on delivery.
 *   - 3+ sweep intervals past the deadline (`deadlineAt < now - 180_000`,
 *     a schema-free heuristic — no per-run sweep counter column, just
 *     "3 sweeps' worth of wall-clock time have passed"): give up waiting.
 *     Guarded `updateMany` marks every still-`pending` judgment on the run
 *     `error` (`'reaper: abandoned'`), then calls `maybeFinalizeRun(runId)`
 *     so the run itself transitions instead of staying stuck `judging`
 *     forever. If some judgments are still genuinely `running` (a real
 *     in-flight provider call, not yet stale per (a)'s own lease check),
 *     `maybeFinalizeRun` correctly no-ops for now — this run gets another
 *     chance on a later sweep, once those either complete or go stale
 *     themselves.
 *
 * Every per-item failure (a single republish, a single force-finalize) is
 * caught and logged individually so ONE bad row can't abort the rest of the
 * sweep — this is best-effort infrastructure healing, not a transaction.
 */

import { randomUUID } from 'crypto';
import { getConnectedRedis } from '@/lib/redis';
import { prisma } from '@/lib/db';
import { logger, serializeError } from '@/lib/logger';
import { publishJudgmentExecute } from '@/lib/queue/publish';
import { maybeFinalizeRun } from '@/lib/run-finalizer';
import { LEASE_MS } from './claim';

/** How often each replica attempts a sweep (whether or not it wins the lock). */
export const SWEEP_INTERVAL_MS = 60_000;

/** Exported for tests — lets the integration suite clear the lock between
 * cases instead of waiting out its TTL. */
export const REAPER_LOCK_KEY = 'reaper:lock';
/** Deliberately shorter than SWEEP_INTERVAL_MS — see module doc. */
const REAPER_LOCK_TTL_MS = 55_000;

/** Give up re-publishing an overdue run's still-pending judgments after
 * this many sweep intervals past its deadline and force-finalize instead.
 * No schema change (no per-run sweep counter) — a deadline-plus-wall-clock
 * heuristic equivalent, per the module doc. */
const FORCE_FINALIZE_GRACE_MS = 3 * SWEEP_INTERVAL_MS;

async function acquireLock(): Promise<boolean> {
  try {
    const client = await getConnectedRedis();
    const result = await client.set(REAPER_LOCK_KEY, randomUUID(), { NX: true, PX: REAPER_LOCK_TTL_MS });
    return result === 'OK';
  } catch (error) {
    logger.error('reaper: failed to acquire the cluster-wide lock — skipping this sweep', {
      error: serializeError(error),
    });
    return false;
  }
}

async function reclaimStaleJudgments(): Promise<void> {
  const staleBefore = new Date(Date.now() - LEASE_MS);

  const stale = await prisma.modelJudgment.findMany({
    where: { status: 'running', updatedAt: { lt: staleBefore } },
    select: { id: true, runId: true, attemptCount: true },
  });

  for (const judgment of stale) {
    // eslint-disable-next-line no-await-in-loop -- sequential per-row reclaim; sweeps run every 60s and reclaim volume is expected to be small, not worth Promise.all's harder-to-reason partial-failure semantics here
    const reset = await prisma.modelJudgment.updateMany({
      where: { id: judgment.id, status: 'running', updatedAt: { lt: staleBefore } },
      data: { status: 'pending' },
    });
    if (reset.count === 0) {
      // Lost the guarded UPDATE to something else (the original claimant
      // resumed and touched the row, or a concurrent process already reset
      // it) between the read above and this UPDATE — nothing to republish.
      continue;
    }

    try {
      // eslint-disable-next-line no-await-in-loop -- see above
      await publishJudgmentExecute({
        judgmentId: judgment.id,
        runId: judgment.runId,
        attempt: judgment.attemptCount + 1,
      });
    } catch (error) {
      logger.error('reaper: failed to republish a reclaimed stale judgment', {
        judgmentId: judgment.id,
        runId: judgment.runId,
        error: serializeError(error),
      });
    }
  }
}

async function forceFinalizeAbandonedRun(runId: string): Promise<void> {
  try {
    await prisma.modelJudgment.updateMany({
      where: { runId, status: 'pending' },
      data: { status: 'error', error: 'reaper: abandoned' },
    });
    await maybeFinalizeRun(runId);
  } catch (error) {
    logger.error('reaper: force-finalize failed for an abandoned overdue run', {
      runId,
      error: serializeError(error),
    });
  }
}

async function republishPendingForRun(runId: string): Promise<void> {
  const pending = await prisma.modelJudgment.findMany({
    where: { runId, status: 'pending' },
    select: { id: true, attemptCount: true },
  });

  for (const judgment of pending) {
    try {
      // eslint-disable-next-line no-await-in-loop -- sequential per-row republish; same "small volume, not worth Promise.all" reasoning as reclaimStaleJudgments
      await publishJudgmentExecute({ judgmentId: judgment.id, runId, attempt: judgment.attemptCount + 1 });
    } catch (error) {
      logger.error('reaper: failed to republish a still-pending judgment for an overdue run', {
        judgmentId: judgment.id,
        runId,
        error: serializeError(error),
      });
    }
  }
}

async function sweepOverdueRuns(): Promise<void> {
  const now = Date.now();

  const overdueRuns = await prisma.evaluationRun.findMany({
    where: { status: { in: ['pending', 'judging'] }, deadlineAt: { lt: new Date(now) } },
    select: { id: true, deadlineAt: true },
  });

  for (const run of overdueRuns) {
    const abandoned = run.deadlineAt !== null && run.deadlineAt.getTime() < now - FORCE_FINALIZE_GRACE_MS;

    if (abandoned) {
      // eslint-disable-next-line no-await-in-loop -- sequential per-run handling; overdue runs are expected to be rare
      await forceFinalizeAbandonedRun(run.id);
    } else {
      // eslint-disable-next-line no-await-in-loop -- see above
      await republishPendingForRun(run.id);
    }
  }
}

/** One sweep, exported for direct invocation (tests, or a manual trigger)
 * without waiting on the interval timer. Also what `startReaper()`'s
 * interval calls. */
export async function runReaperSweep(): Promise<void> {
  const acquired = await acquireLock();
  if (!acquired) return;

  try {
    await reclaimStaleJudgments();
  } catch (error) {
    logger.error('reaper: stale-judgment sweep failed', { error: serializeError(error) });
  }

  try {
    await sweepOverdueRuns();
  } catch (error) {
    logger.error('reaper: overdue-run sweep failed', { error: serializeError(error) });
  }
}

export interface Reaper {
  stop(): void;
}

/** Starts the interval-driven sweep loop. Returns a handle whose `stop()`
 * clears the interval — called from main.ts's `drain()` so the reaper isn't
 * left running (and potentially starting a new sweep) after shutdown has
 * begun. */
export function startReaper(intervalMs: number = SWEEP_INTERVAL_MS): Reaper {
  const timer = setInterval(() => {
    void runReaperSweep();
  }, intervalMs);
  // Don't let the interval keep the process alive on its own — drain()
  // explicitly stops it, but this is defense in depth against anything that
  // forgets to.
  timer.unref?.();

  return {
    stop(): void {
      clearInterval(timer);
    },
  };
}
