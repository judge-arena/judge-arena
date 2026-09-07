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
 * ── 2026-09-03: a THIRD condition feeds the same two-case disposition ──────
 * `deadlineAt` is `null` from creation until `src/worker/claim.ts`'s
 * `stampRunStartedAtFirstDequeue` sets it at FIRST DEQUEUE (see that
 * function's doc). Under SQL's three-valued logic `NULL < now` is `NULL`,
 * not true, so a null-deadline row was ALREADY invisible to the query
 * above — harmlessly, back when every launch path always stamped a
 * deadline at creation, but a run published and never claimed at all (dead
 * consumer, lost message, purged queue) would otherwise be IMMORTAL:
 * nothing would ever sweep it. `NEVER_STARTED_TIMEOUT_MS` is the safety
 * net — the query now ALSO matches `deadlineAt: null AND createdAt < now -
 * NEVER_STARTED_TIMEOUT_MS`, and the same two-case grace/abandon logic
 * above applies, substituting `createdAt + NEVER_STARTED_TIMEOUT_MS` for
 * `deadlineAt` as the threshold. See that constant's own doc for why it is
 * orders of magnitude looser than the execution deadline it stands in for,
 * what invariant that looseness assumes (one max-size batch per judge lane),
 * and what it costs (a lost message is no longer republished in minutes).
 *
 * Every per-item failure (a single republish, a single force-finalize) is
 * caught and logged individually so ONE bad row can't abort the rest of the
 * sweep — this is best-effort infrastructure healing, not a transaction.
 *
 * ── v2j: a republish goes back to its LANE, not to the shared queue ─────────
 * Both republish paths resolve the lane for the judgment's own server (see
 * `src/lib/queue/lanes.ts`). Without that, the reaper would be a lane leak: a
 * reclaimed judgment would land on the shared fallback queue and stop being
 * serialized against the box it calls, which is the failure lanes exist to
 * prevent, arriving precisely when the system is already unhealthy.
 *
 * The endpoint each lane is derived from is fetched in ONE batched query per
 * sweep path (`resolveEndpointsForPairs` for the cross-user stale sweep,
 * `resolveEndpointsForVersions` for a single overdue run), never one query per
 * judgment. And no lane failure can stop a republish: `resolveDestinationQueue`
 * degrades to the fallback queue, which is consumed — an unrouted judgment is
 * a lost judgment, an unlaned one is merely a slow one.
 */

import { randomUUID } from 'crypto';
import { getConnectedRedis } from '@/lib/redis';
import { prisma } from '@/lib/db';
import { logger, serializeError } from '@/lib/logger';
import { publishJudgmentExecute, resolveDestinationQueue } from '@/lib/queue/publish';
import { LANE_FALLBACK_QUEUE } from '@/lib/queue/lanes';
import { resolveEndpointsForPairs, resolveEndpointsForVersions } from '@/lib/endpoint-resolution';
import { maybeFinalizeRun } from '@/lib/run-finalizer';
import { clearRunDeadlineOnRequeue, LEASE_MS } from './claim';

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

/**
 * How long an `EvaluationRun` may sit `pending`/`judging` with ZERO
 * judgments ever dequeued before the reaper treats it as abandoned, even
 * though `deadlineAt` is still `null`.
 *
 * ── THE LEAK THIS CLOSES ─────────────────────────────────────────────────
 * `sweepOverdueRuns`'s query used to be `deadlineAt: { lt: now }` alone.
 * Under SQL's three-valued logic, `NULL < now` evaluates to `NULL`, which a
 * `WHERE` clause treats as "no match" — so a row with `deadlineAt: null`
 * was ALREADY, silently, invisible to this query, and the
 * `run.deadlineAt !== null` guard that used to sit inside the loop below it
 * was dead code protecting against a state that could never occur, because
 * every launch path always stamped a deadline at creation. Once
 * `src/lib/run-launch.ts`, `src/lib/calibration/launch.ts` and
 * `src/worker/run-create-consumer.ts` stop doing that and leave
 * `deadlineAt` null until `src/worker/claim.ts`'s
 * `stampRunStartedAtFirstDequeue` sets it at FIRST DEQUEUE, that dormant
 * state becomes reachable on every single run: a `judgment.execute`
 * message that is published and then never claimed — a dead consumer at
 * publish time, a message lost between the broker and a worker, a purged
 * queue — leaves its `EvaluationRun` with `deadlineAt: null` FOREVER.
 * Nothing would ever sweep it. It would sit `pending` indefinitely — for a
 * calibration, permanently blocking that item from ever being scored, with
 * no error, no alert, and no operator-visible signal that anything is
 * wrong.
 *
 * ── WHY A SEPARATE, MUCH LARGER CONSTANT THAN THE EXECUTION DEADLINE ───────
 * The execution deadline (`deadlineAt`, once stamped) bounds "how long has
 * THIS run been executing since ITS OWN first dequeue" — a TIGHT bound,
 * sized on the run's own judgment count (`runStartBudgetMs`, ~16 minutes
 * for a calibration's one judgment). This constant bounds something
 * categorically different: "how long has this run sat with ZERO progress
 * since it was CREATED" — and unlike the execution deadline, it has NO way
 * to size itself against the run's own work, because the run hasn't
 * started any work yet. The only information available is queue depth — of
 * every OTHER run competing for the same judge, launched by every other
 * user — which is exactly the thing this whole task exists to stop
 * depending on for the execution deadline. So this net is deliberately
 * loose rather than tight: it must outlast the longest LEGITIMATE queue
 * wait in the system, or it reintroduces the exact bug this task fixes,
 * just relocated from "queue position" to "batch size".
 *
 * ── THE NUMBER, AND THE ARITHMETIC BEHIND IT ────────────────────────────
 * Sized on what a batch may LEGALLY take, NOT on measured throughput — the
 * same hard-cap-not-initial-budget discipline `runStartBudgetMs` uses. A
 * calibration serialises through ONE judge's gate
 * (`src/worker/judgment-consumer.ts`'s per-judge permit); each item may
 * legally run to `hardCapMs` (900_000 ms) and may be delivered up to
 * `MAX_ATTEMPTS` (3) times:
 *
 *   MAX_CALIBRATION_ITEMS (1000) x 3 x 900_000 ms = 750 h = 31.25 days.
 *
 * 45 days rounds that up. Measured throughput (5.03 min/item, so 3.49 days
 * for 1000 items — see the plan's Measurements table) is the EXPECTATION,
 * and sizing a force-finalize threshold on an expectation is exactly what
 * killed 4 of 30 items in the first place. The relationship, not the
 * literal, is pinned by a test in
 * `tests/integration/finalization.test.ts`, so raising
 * `MAX_CALIBRATION_ITEMS` again without revisiting this constant goes red.
 *
 * ── WHAT THIS NUMBER IS NOT ───────────────────────────────────────────────
 * It is NOT immune to queue depth. Unlike the execution deadline, this net
 * measures wall clock from `createdAt`, so N batches queued on the SAME
 * judge lane SUM: two back-to-back 1000-item batches are 62.5 days of legal
 * worst case against this 45-day bound. THE INVARIANT THIS CONSTANT
 * ASSUMES, stated so it can be checked: at most ONE calibration anywhere
 * near `MAX_CALIBRATION_ITEMS` in flight per judge lane at a time. If that
 * stops holding, raise THIS constant, not `MAX_CALIBRATION_ITEMS`.
 *
 * ── THE COST, STATED RATHER THAN HIDDEN ───────────────────────────────────
 * This net is the ONLY thing that republishes a never-dequeued run, and it
 * does so at 45 days. Before this change, a lost `judgment.execute` message
 * on an ordinary run was republished within `N x hardCapMs + slack` of
 * CREATION — ~16 minutes — and abandoned ~3 minutes later. That self-heal
 * is gone: a lost message now costs 45 days of silence, during which
 * `src/worker/run-create-consumer.ts:182` dedupes away every subsequent
 * `run.create` for that evaluation ("active run already exists — deduping"),
 * so the evaluation is silently un-runnable through the bulk path for the
 * whole period. This is an ACCEPTED trade, not an oversight: a tight net
 * cannot tell a lost message from a healthy queued batch, and killing the
 * healthy batch is the failure this whole change exists to remove. The
 * operator's real detector is unchanged — `scripts/calibration/run.ts`'s
 * `--poll-timeout` notices a stuck run in minutes, long before this fires.
 *
 * ── A SECOND, NON-LAUNCH SOURCE OF NULL-DEADLINE ROWS ─────────────────────
 * `scripts/importer/runs.ts:384` writes `deadlineAt: null` explicitly, with
 * the v1 run's own `createdAt` (`:387`) and a `status` (`:369`) that is
 * `'pending'`/`'judging'` unless the v1 row was stranded (24 h,
 * `runs.ts:204`). Such a row is older than this net on the day it is
 * imported, so this arm republishes its judgments onto a live judge lane and
 * then force-finalizes them. Production had ZERO such rows when this landed
 * (read-only check, 2026-09-03); re-run that check before any future import.
 */
export const NEVER_STARTED_TIMEOUT_MS = 45 * 24 * 60 * 60 * 1000;

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

/**
 * Lane queue per judgment id, resolved ONCE per distinct
 * (endpoint URL, judge version) pair rather than once per judgment.
 *
 * A sweep can reclaim many judgments that all target one server; resolving a
 * lane per judgment would issue an `INSERT .. ON CONFLICT` plus a `SELECT` for
 * each of them the first time that key is seen in this process. The dedupe key
 * is a JSON tuple rather than a concatenation because an endpoint URL may
 * legitimately contain any separator character, and two different pairs
 * colliding on one key would route a judgment to another server's lane —
 * silently, and with the queue depth still looking healthy.
 *
 * Never throws: `resolveDestinationQueue` swallows lane failures into the
 * fallback queue, and any judgment this map somehow misses also takes the
 * fallback at the call site. A reaper that threw here would stop reclaiming.
 */
async function lanesByJudgmentId(
  rows: Array<{ id: string; judgeModelVersionId: string | null; endpointUrl: string | null }>
): Promise<Map<string, string>> {
  const dedupeKey = (row: { judgeModelVersionId: string | null; endpointUrl: string | null }): string =>
    JSON.stringify([row.endpointUrl, row.judgeModelVersionId]);

  const distinct = new Map<string, (typeof rows)[number]>();
  for (const row of rows) distinct.set(dedupeKey(row), row);

  const laneByKey = new Map(
    await Promise.all(
      [...distinct].map(
        async ([key, row]) =>
          [
            key,
            row.judgeModelVersionId
              ? await resolveDestinationQueue(row.endpointUrl, row.judgeModelVersionId)
              : LANE_FALLBACK_QUEUE,
          ] as const
      )
    )
  );

  return new Map(rows.map((row) => [row.id, laneByKey.get(dedupeKey(row)) ?? LANE_FALLBACK_QUEUE]));
}

async function reclaimStaleJudgments(): Promise<void> {
  const staleBefore = new Date(Date.now() - LEASE_MS);

  const stale = await prisma.modelJudgment.findMany({
    where: { status: 'running', updatedAt: { lt: staleBefore } },
    // v2j: judgeModelVersionId and the run's OWNER are what a lane is resolved
    // from. `judgeModelVersionId` is a column on the row already being read;
    // the nested `run` select costs one additional query for the whole sweep
    // (Prisma loads a to-one relation with a second batched statement, not a
    // JOIN) — one query, not one per judgment, which is the property that
    // matters here.
    select: {
      id: true,
      runId: true,
      attemptCount: true,
      judgeModelVersionId: true,
      run: { select: { triggeredById: true } },
    },
  });

  // ONE endpoint query for the whole sweep. Unlike the two publishers, a stale
  // sweep spans runs from DIFFERENT users, so the batch is over (owner, judge
  // version) PAIRS — the same composite identity `ModelEndpoint` is keyed on.
  // Resolved before the reclaim loop so the loop keeps its one-row-at-a-time,
  // individually-attributable failure shape.
  const endpoints = await resolveEndpointsForPairs(
    stale
      .filter((judgment) => judgment.run.triggeredById && judgment.judgeModelVersionId)
      .map((judgment) => ({
        userId: judgment.run.triggeredById as string,
        judgeModelVersionId: judgment.judgeModelVersionId as string,
      }))
  );
  const lanes = await lanesByJudgmentId(
    stale.map((judgment) => ({
      id: judgment.id,
      judgeModelVersionId: judgment.judgeModelVersionId,
      endpointUrl: judgment.judgeModelVersionId
        ? endpoints(judgment.run.triggeredById, judgment.judgeModelVersionId)?.endpoint ?? null
        : null,
    }))
  );

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
      await publishJudgmentExecute(
        {
          judgmentId: judgment.id,
          runId: judgment.runId,
          attempt: judgment.attemptCount + 1,
        },
        // `?? LANE_FALLBACK_QUEUE` is belt-and-braces: `lanesByJudgmentId`
        // returns an entry for every row it was given. A missing entry must
        // still publish somewhere consumed — an `undefined` routing key would
        // be published as the empty string and dropped by the direct exchange,
        // turning a reclaim into a permanently stuck judgment.
        lanes.get(judgment.id) ?? LANE_FALLBACK_QUEUE
      );
    } catch (error) {
      logger.error('reaper: failed to republish a reclaimed stale judgment', {
        judgmentId: judgment.id,
        runId: judgment.runId,
        error: serializeError(error),
      });
      continue;
    }

    // The run's execution deadline was sized for a judgment that is no
    // longer executing. Every OTHER running -> pending path clears it —
    // judgment-consumer.ts:1346 on a retryable error — and claim.ts:252-254
    // states the invariant this restores: "deadlineAt is non-null EXACTLY
    // WHILE the run has a claimed judgment in flight."
    //
    // Without it this sweep kills the judgment it just rescued.
    // LEASE_MS is hardCapMs + 30_000 and runStartBudgetMs(1) is
    // hardCapMs + 60_000, so a stale reclaim lands 30s or more PAST the
    // run's own deadline; sweepOverdueRuns then runs later in this SAME
    // runReaperSweep() call, sees deadlineAt < now, and stamps every
    // `pending` judgment on the run `reaper: abandoned` — including this
    // one, which is `pending` because we just made it so. One production
    // judgment (cmtluq5t5038x2l0s83p3h1aw) died exactly this way.
    //
    // AFTER the publish, never before: clearing first and then failing to
    // publish leaves a `pending` judgment with no deadline AND no queue
    // message, reachable only by the 45-day never-started net. Best-effort,
    // like the consumer's call — a failure here must not fail the reclaim.
    try {
      await clearRunDeadlineOnRequeue(judgment.runId);
    } catch (error) {
      logger.error('reaper: failed to clear the run deadline after reclaiming a stale judgment', {
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

async function republishPendingForRun(runId: string, triggeredById: string | null): Promise<void> {
  const pending = await prisma.modelJudgment.findMany({
    where: { runId, status: 'pending' },
    // v2j: judgeModelVersionId is the lane key. Selected here rather than
    // re-read per judgment.
    select: { id: true, attemptCount: true, judgeModelVersionId: true },
  });

  // ONE endpoint query for this run. A run has exactly one owner
  // (`triggeredById`, passed in from the sweep's own query rather than re-read
  // here), so the batch is over the run's distinct judge versions — the
  // single-user shape, same as the two publishers.
  const endpoints = await resolveEndpointsForVersions(
    triggeredById,
    pending.map((judgment) => judgment.judgeModelVersionId).filter((id): id is string => !!id)
  );
  const lanes = await lanesByJudgmentId(
    pending.map((judgment) => ({
      id: judgment.id,
      judgeModelVersionId: judgment.judgeModelVersionId,
      endpointUrl: judgment.judgeModelVersionId
        ? endpoints.get(judgment.judgeModelVersionId)?.endpoint ?? null
        : null,
    }))
  );

  for (const judgment of pending) {
    try {
      // eslint-disable-next-line no-await-in-loop -- sequential per-row republish; same "small volume, not worth Promise.all" reasoning as reclaimStaleJudgments
      await publishJudgmentExecute(
        { judgmentId: judgment.id, runId, attempt: judgment.attemptCount + 1 },
        // See the identical guard in reclaimStaleJudgments: never `undefined`,
        // because a message with an empty routing key is silently discarded.
        lanes.get(judgment.id) ?? LANE_FALLBACK_QUEUE
      );
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
  const neverStartedBefore = new Date(now - NEVER_STARTED_TIMEOUT_MS);

  const overdueRuns = await prisma.evaluationRun.findMany({
    where: {
      status: { in: ['pending', 'judging'] },
      OR: [
        { deadlineAt: { lt: new Date(now) } },
        // THE LEAK, closed: a null deadline is invisible to the first arm
        // (SQL's `NULL < now` is `NULL`, not true — see
        // NEVER_STARTED_TIMEOUT_MS's own doc). This second arm is the ONLY
        // thing that can ever catch a run that was published and never
        // dequeued.
        { deadlineAt: null, createdAt: { lt: neverStartedBefore } },
      ],
    },
    // v2j: triggeredById is the owner half of the endpoint identity a lane is
    // resolved from. Selected here, on a query that was already reading these
    // rows, so `republishPendingForRun` needs no extra round trip for it.
    select: { id: true, deadlineAt: true, createdAt: true, triggeredById: true },
  });

  for (const run of overdueRuns) {
    // `run.deadlineAt` is set for every row that matched the query's FIRST
    // arm (a run that has begun executing — see claim.ts's
    // `stampRunStartedAtFirstDequeue`): the EXECUTION deadline governs,
    // exactly as before this task. `run.deadlineAt === null` means this
    // row only matched the SECOND arm — never dequeued, sitting since
    // `createdAt` past NEVER_STARTED_TIMEOUT_MS — so the never-started
    // net's own threshold stands in for the execution deadline this run
    // never got.
    const threshold = run.deadlineAt ?? new Date(run.createdAt.getTime() + NEVER_STARTED_TIMEOUT_MS);
    const abandoned = threshold.getTime() < now - FORCE_FINALIZE_GRACE_MS;

    if (abandoned) {
      // eslint-disable-next-line no-await-in-loop -- sequential per-run handling; overdue runs are expected to be rare
      await forceFinalizeAbandonedRun(run.id);
    } else {
      // eslint-disable-next-line no-await-in-loop -- see above
      await republishPendingForRun(run.id, run.triggeredById);
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
