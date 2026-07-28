/**
 * ─── Run Finalizer ──────────────────────────────────────────────────────────
 *
 * Replaces judgment-consumer.ts's old placeholder `maybeFinalizeRun` (no row
 * lock — see git history for the "TASK 8 replaces" comment it carried) with
 * a real concurrency-safe finalization pass.
 *
 * `maybeFinalizeRun(runId)` — the ONLY correctness-critical piece is a
 * single `$transaction` that:
 *   1. `SELECT id, status FROM "EvaluationRun" WHERE id = $1 FOR UPDATE`
 *      (`$queryRaw`, not the query builder — Prisma has no `FOR UPDATE`
 *      helper). This serializes every concurrent `maybeFinalizeRun(runId)`
 *      call for the SAME run on Postgres's own row lock: the second caller
 *      blocks until the first's transaction commits (or rolls back), no
 *      app-level mutex needed.
 *   2. Guard: if the row's status is already terminal (not `pending` or
 *      `judging`), return `null` — this is what makes the dual-completion
 *      race safe. Two judgments finishing at nearly the same instant both
 *      call `maybeFinalizeRun(runId)`; both transactions queue on the row
 *      lock; whichever acquires it first sees `judging`/`pending`, recomputes,
 *      and (if nothing remains pending/running) transitions the row off
 *      pending/judging and commits. The second then acquires the lock,
 *      re-reads the row (now terminal), and the guard above returns `null`
 *      — it never re-transitions an already-finalized run.
 *   3. Recompute the judgment aggregate (counts by status) INSIDE the same
 *      transaction (so it observes a state consistent with the lock, not a
 *      stale pre-lock snapshot) and decide:
 *      - any `pending`/`running` remain -> not yet finalizable, return `null`.
 *      - none remain, at least one `completed` -> `needs_human`.
 *      - none remain, zero `completed` (all `error`, or zero judgments at
 *        all) -> `error`.
 *      Either transition stamps `finalizedAt` (Task 6 semantics: both
 *      `completed`-eligible states — `needs_human` here, `completed` via
 *      `markRunCompleted` below — get `finalizedAt` set at the moment they
 *      leave their prior state, not just `completed`).
 *
 * `run.status.changed` is published AFTER the transaction commits, not
 * inside it (a realtime publish must never hold the row lock open across a
 * network round trip to Redis, and a publish failure must never roll back an
 * already-decided, already-durable status transition). Best-effort: logged,
 * not fatal, matching every other post-commit publish in this codebase (see
 * dataset-evaluation-summary.ts, judgment-consumer.ts's `judgment.completed`
 * publish).
 *
 * Dataset summary recompute is likewise triggered post-commit, as a
 * SEPARATE concern from finalization itself — a summary-refresh failure
 * must never be mistaken for (or roll back) a successful run finalization.
 * See `refreshDatasetEvaluationSummaryForEvaluation`'s own doc
 * (dataset-evaluation-summary.ts) for how ITS internal race (two runs on the
 * same dataset finalizing concurrently) is handled — a separate row lock on
 * `Dataset`, orthogonal to this module's `EvaluationRun` lock.
 *
 * ── markRunCompleted ─────────────────────────────────────────────────────
 * The human-judgment route (src/app/api/evaluations/[id]/runs/[runId]/
 * human-judgment/route.ts) used to write `status: 'completed'` unconditionally
 * whenever the current status wasn't already `completed` — i.e. it would
 * happily stamp `completed` over a run still `pending`/`judging` (automated
 * judging not even finished yet) or, worse, race a concurrent finalizer
 * transition. `markRunCompleted` is the guarded replacement: a single
 * conditional `updateMany` (`WHERE status = 'needs_human'`) — the ONLY
 * legal transition into `completed`. Calling it on a run that's already
 * `completed`, or that hasn't reached `needs_human` yet, is a safe no-op
 * (`count: 0`), never a silent regression.
 */

import type { JudgmentStatus, RunStatus } from '@prisma/client';
import { prisma } from '@/lib/db';
import { logger, serializeError } from '@/lib/logger';
import { publishEvent, runTopic } from '@/lib/realtime/events';
import { refreshDatasetEvaluationSummaryForEvaluation } from '@/lib/dataset-evaluation-summary';

/** Statuses `maybeFinalizeRun` is willing to transition OUT of. Anything
 * else (`needs_human`, `completed`, `error`) is already terminal from the
 * finalizer's point of view — see the guard in the transaction below. */
const ACTIVE_RUN_STATUSES: RunStatus[] = ['pending', 'judging'];

interface FinalizeCommitResult {
  newStatus: RunStatus;
  evaluationId: string;
}

async function publishRunStatusChanged(
  runId: string,
  evaluationId: string,
  status: RunStatus
): Promise<void> {
  try {
    await publishEvent(runTopic(runId), {
      type: 'run.status.changed',
      payload: { runId, evaluationId, status },
    });
  } catch (error) {
    logger.error('run.status.changed publish failed — continuing (non-fatal)', {
      runId,
      status,
      error: serializeError(error),
    });
  }
}

/**
 * Recompute + (if finalizable) transition a run's status under a row lock.
 * See module doc for the full protocol. Returns the new status once this
 * call actually performed the transition, or `null` if the run was already
 * terminal (guard) or still has pending/running judgments.
 */
export async function maybeFinalizeRun(runId: string): Promise<RunStatus | null> {
  const commit = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string; status: RunStatus }>>`
      SELECT id, status FROM "EvaluationRun" WHERE id = ${runId} FOR UPDATE
    `;
    const run = rows[0];
    if (!run) return null;

    if (!ACTIVE_RUN_STATUSES.includes(run.status)) {
      // Already finalized (or errored) by this call or a concurrent one
      // that won the row lock first — this is the dual-completion race
      // guard. Nothing to do.
      return null;
    }

    const counts = await tx.modelJudgment.groupBy({
      by: ['status'],
      where: { runId },
      _count: { _all: true },
    });
    const countOf = (status: JudgmentStatus): number =>
      counts.find((c) => c.status === status)?._count._all ?? 0;

    const stillActive = countOf('pending') + countOf('running');
    if (stillActive > 0) {
      // Not yet finalizable — some other judgment is still in flight.
      return null;
    }

    const newStatus: RunStatus = countOf('completed') > 0 ? 'needs_human' : 'error';

    const updated = await tx.evaluationRun.update({
      where: { id: runId },
      data: { status: newStatus, finalizedAt: new Date() },
      select: { evaluationId: true },
    });

    const result: FinalizeCommitResult = { newStatus, evaluationId: updated.evaluationId };
    return result;
  });

  if (!commit) return null;

  await publishRunStatusChanged(runId, commit.evaluationId, commit.newStatus);

  try {
    await refreshDatasetEvaluationSummaryForEvaluation(commit.evaluationId);
  } catch (error) {
    // Separate concern from finalization itself — never let a summary
    // recompute failure look like (or be mistaken for) a finalization
    // failure. Log and move on; the summary will catch up on the next
    // finalization or HF refresh.
    logger.error('post-finalization dataset summary refresh failed — continuing (non-fatal)', {
      runId,
      evaluationId: commit.evaluationId,
      error: serializeError(error),
    });
  }

  return commit.newStatus;
}

/**
 * Guarded `needs_human -> completed` transition — see module doc. Returns
 * the number of rows updated (0 or 1): 0 means the run wasn't `needs_human`
 * (already `completed`, or not yet finalized) and no write happened.
 */
export async function markRunCompleted(runId: string): Promise<number> {
  const updated = await prisma.evaluationRun.updateMany({
    where: { id: runId, status: 'needs_human' },
    data: { status: 'completed', finalizedAt: new Date() },
  });

  if (updated.count === 0) return 0;

  const run = await prisma.evaluationRun.findUnique({
    where: { id: runId },
    select: { evaluationId: true },
  });
  if (run) {
    await publishRunStatusChanged(runId, run.evaluationId, 'completed');
  }

  return updated.count;
}
