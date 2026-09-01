/**
 * ─── TIME TO COMPUTE: runtime as a first-class, queryable number ────────────
 *
 * The owner's spec, verbatim: "ensure that runtime is included (so we can mark
 * time-to-compute for a dataset, item, model tuple". This module is the read
 * side of that sentence, and the health signal the dynamic timeout policy
 * branches on.
 *
 * ── PUBLIC SURFACE (read this before importing) ─────────────────────────────
 *
 *   judgeLatencyBaseline(judgeModelVersionId, client?)
 *       -> Promise<LatencyBaseline | null>
 *
 *     `{ count, meanMs, p50Ms, p90Ms, maxMs }` over the COMPLETED judgments of
 *     one judge, or **`null` when that judge has never completed one**.
 *
 *     `null` IS THE CONTRACT, AND IT IS NOT INTERCHANGEABLE WITH ZEROS. The
 *     owner defined "health is good" as "either a successful response has been
 *     returned... If it's the first record (no successful response to baseline
 *     average response times), we allow up to 15min but return a response to
 *     error that 5min have elapsed". So the caller has exactly two states to
 *     distinguish — "I have seen this judge finish something" and "I have
 *     not" — and `null` is the second one. A zero-filled record collapses the
 *     distinction and, worse, lies in the dangerous direction: `meanMs: 0`
 *     reads as a judge that answers instantly, so every real call looks
 *     pathologically slow and the first-record branch never runs. Callers
 *     should write `if (!baseline)`, never `if (baseline.count === 0)`.
 *
 *   describeBaseline(baseline) -> string
 *
 *     The one-line rendering of the above, INCLUDING the words "no baseline"
 *     when it is null. Shared so the worker's 5-minute alert and the
 *     calibration CLI's overdue alert cannot drift into describing the same
 *     state with two different sentences.
 *
 *   timeToComputeByTuple(scope, client?) -> Promise<TimeToCompute[]>
 *
 *     The (dataset, item, model) projection. COMPUTED ON READ, per A2.3's rule
 *     that the report is a projection and not stored state — this module adds
 *     no column and writes nothing. The tuple is already reachable in the
 *     schema as it stands today:
 *
 *       ModelJudgment.judgeModelVersionId                    -> model
 *       ModelJudgment.runId -> EvaluationRun.goldenItemId    -> item
 *         -> GoldenItem.goldenSetId -> GoldenSet.datasetId   -> dataset
 *
 *     (schema.prisma:478-485, 419-420, 767-768, 720-721 — verified, not
 *     remembered.) `EvaluationRun.goldenItemId` is NULL on every ordinary run,
 *     which is why the projection is scoped through the golden item rather
 *     than run off `ModelJudgment` directly.
 *
 *   selectOverdue(rows, nowMs, budgetMs) -> OverdueJudgment[]
 *
 *     Which in-flight judgments have been `running` past a budget, derived
 *     from `ModelJudgment.startedAt` (schema.prisma:529, written by
 *     src/worker/claim.ts:107). No schema change, no server poll — the owner
 *     was explicit: "DON'T POLL THE SERVER".
 *
 * ── WHAT COUNTS AS HEALTH, AND WHAT COUNTS AS COST ──────────────────────────
 *
 * The two aggregates here deliberately disagree about failures.
 *
 * The BASELINE reads `status: 'completed'` only. A judgment that timed out at
 * 15 minutes is not evidence that this judge takes 15 minutes; it is evidence
 * that it did not answer. Folding it into the mean would let the failure the
 * timeout policy exists to catch inflate the budget meant to catch it — the
 * baseline would climb every time the judge got worse.
 *
 * The PROJECTION includes every judgment that recorded a runtime, failures
 * included, because time-to-compute is a COST question and a 15-minute
 * timeout is the most expensive thing in the corpus. A cost report that
 * silently omits the slow failures under-reports exactly where it matters.
 * That is only true because the failure path now persists a runtime at all —
 * see `markJudgmentError` in src/worker/judgment-consumer.ts; a timeout
 * carries no provider response, so its latency is derived from `startedAt`.
 *
 * Both aggregates drop judgments with a NULL `latencyMs` rather than reading
 * them as zero. Those are real: v1-imported rows carry `latencyMs:
 * v1.latencyMs` straight across, nullable, with `startedAt: null`
 * (scripts/importer/runs.ts:491,500). Summing them as zeros drags every mean
 * down silently; summing them as-is yields NaN.
 */

import { prisma } from '@/lib/db';
import type { PrismaClient } from '@prisma/client';

// ─── Baseline ────────────────────────────────────────────────────────────────

/** A judge's observed completed-call runtimes, summarised. Only ever produced
 *  for a NON-EMPTY sample — see the module doc on why the empty case is
 *  `null` and never a zero-filled instance of this. */
export interface LatencyBaseline {
  /** How many completed judgments carried a runtime. The denominator, stated,
   *  because a p90 over 2 samples and a p90 over 200 are different claims. */
  count: number;
  meanMs: number;
  p50Ms: number;
  p90Ms: number;
  maxMs: number;
}

/**
 * Nearest-rank percentile over an ASCENDING array: the smallest observed value
 * at or above the requested rank, with no interpolation.
 *
 * DELIBERATELY NOT the interpolated median. The consumer of these numbers
 * sizes a timeout budget against them, and an interpolated p50 of `[10s, 20s]`
 * is 15s — a duration no call in the sample ever took. Every number this
 * module reports is a duration that actually happened.
 */
function nearestRank(ascending: readonly number[], p: number): number {
  const idx = Math.min(ascending.length - 1, Math.max(0, Math.ceil(p * ascending.length) - 1));
  return ascending[idx];
}

/**
 * Summarise raw latency samples, tolerating the nulls the schema allows.
 *
 * Returns `null` for an empty sample AND for a sample that is all nulls — in
 * both cases nothing has been observed, and the caller's branch is the same.
 * Pure, so the arithmetic is testable without a database anywhere near it.
 */
export function summarizeLatencies(values: readonly (number | null | undefined)[]): LatencyBaseline | null {
  const observed = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (observed.length === 0) return null;

  const ascending = [...observed].sort((a, b) => a - b);
  const total = ascending.reduce((sum, v) => sum + v, 0);

  return {
    count: ascending.length,
    // Whole milliseconds: sub-ms precision on a 60 tok/s CPU-hosted judge is
    // noise, and this number is printed into an operator-facing alert.
    meanMs: Math.round(total / ascending.length),
    p50Ms: nearestRank(ascending, 0.5),
    p90Ms: nearestRank(ascending, 0.9),
    maxMs: ascending[ascending.length - 1],
  };
}

/** The subset of `PrismaClient` the baseline needs — satisfied by the global
 *  singleton in production and by a structural stand-in in the DB-free unit
 *  run, the same seam `CalibrationScoreClient` (src/lib/calibration/score.ts)
 *  uses. */
export type JudgeLatencyClient = Pick<PrismaClient, 'modelJudgment'>;

/**
 * What this judge's successful calls have historically cost, or `null` if it
 * has never had one.
 *
 * THE `null` IS THE POINT — see the module doc. This is the value the dynamic
 * timeout policy reads to decide whether it is in the "health is good, extend
 * the budget" case or the owner's first-record case ("no successful response
 * to baseline average response times"), and the two are only distinguishable
 * because the absent case is absent rather than zeroed.
 *
 * Scoped to ONE judge on purpose. Judges live on different inference servers
 * with wildly different throughput (measured on this cluster: 60.2 tok/s on
 * the llama.cpp judge; 16.1s to 95.1s per item on Qwen), so a cross-judge
 * average describes nothing that exists.
 */
export async function judgeLatencyBaseline(
  judgeModelVersionId: string,
  client: JudgeLatencyClient = prisma
): Promise<LatencyBaseline | null> {
  const rows = await client.modelJudgment.findMany({
    // `status: 'completed'` in the WHERE, not in memory: this runs on the
    // alert path while a run is in flight, and it is served by
    // ModelJudgment_judgeModelVersionId_idx (schema.prisma:537).
    where: { judgeModelVersionId, status: 'completed' },
    select: { latencyMs: true },
  });

  // The null-latency filter lives in `summarizeLatencies`, NOT in the WHERE
  // above, so it is exercised by the unit suite instead of by Postgres.
  return summarizeLatencies(rows.map((r) => r.latencyMs));
}

/**
 * One line an operator can read, for both states.
 *
 * Exists so the worker's 5-minute alert and the calibration CLI's overdue
 * alert render "we have no baseline for this judge" identically. Two
 * hand-written sentences for one state is how "no baseline" quietly becomes
 * "baseline 0ms" on one of the two screens.
 */
export function describeBaseline(baseline: LatencyBaseline | null): string {
  if (baseline === null) {
    return 'no baseline — this judge has never completed a judgment, so nothing here says what "normal" is yet';
  }
  return (
    `baseline n=${baseline.count}  ` +
    `mean ${formatDurationMs(baseline.meanMs)}  ` +
    `p50 ${formatDurationMs(baseline.p50Ms)}  ` +
    `p90 ${formatDurationMs(baseline.p90Ms)}  ` +
    `max ${formatDurationMs(baseline.maxMs)}`
  );
}

/** Milliseconds at the scale a human reads them: sub-second stays in ms,
 *  under a minute goes to one decimal of seconds, above that to `5m12s`. A
 *  raw `312000ms` in an alert is a number the reader has to do arithmetic on
 *  before they know whether to worry. */
export function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSeconds = Math.round(ms / 1000);
  return `${Math.floor(totalSeconds / 60)}m${totalSeconds % 60}s`;
}

// ─── The (dataset, item, model) projection ──────────────────────────────────

/** Time-to-compute for ONE (dataset, item, model) tuple. Derived on read;
 *  nothing in the schema stores any of it. */
export interface TimeToCompute {
  datasetId: string;
  /** Which annotation layer over that dataset the item came from — a dataset
   *  can carry several golden sets, and the same source sample can be
   *  annotated in more than one. Reported so a tuple is traceable back to the
   *  set that was actually frozen. */
  goldenSetId: string;
  goldenItemId: string;
  goldenItemIndex: number;
  judgeModelVersionId: string;
  /** Judgments with a RECORDED runtime. Not a row count: a judgment still
   *  pending, or a v1 import with no `latencyMs`, is not a measurement. */
  count: number;
  completedCount: number;
  failedCount: number;
  /** The tuple's time-to-compute: every recorded runtime for it, summed. More
   *  than one when the same judge measured the same item in a later
   *  calibration, or under both pair orders. */
  totalMs: number;
  maxMs: number;
}

/** Narrowing scope for the projection. All optional; an empty scope projects
 *  every calibration judgment in the database. */
export interface TimeToComputeScope {
  calibrationRunId?: string;
  datasetId?: string;
  judgeModelVersionId?: string;
}

/** The subset of `PrismaClient` the projection needs. */
export type TimeToComputeClient = Pick<PrismaClient, 'evaluationRun'>;

/**
 * Project stored judgments into per-(dataset, item, model) time-to-compute.
 *
 * Traverses the chain the schema already provides rather than adding a
 * denormalised column for it (A2.3: the report is a PROJECTION, not stored) —
 * a stored tuple key would have to be backfilled, kept in sync with a golden
 * set that can be forked, and would be wrong for every row written before it
 * existed.
 *
 * The result is SORTED HERE, by item index then judge, not by an `orderBy` in
 * the query. Postgres has no default row order, and the grouping below folds
 * many rows into one, so the report's stability has to be a property of this
 * function.
 */
export async function timeToComputeByTuple(
  scope: TimeToComputeScope = {},
  client: TimeToComputeClient = prisma
): Promise<TimeToCompute[]> {
  const runs = await client.evaluationRun.findMany({
    where: {
      // Scoping only. `goldenItem` is re-checked below because the column is
      // nullable and a run without one names no tuple.
      goldenItemId: { not: null },
      ...(scope.calibrationRunId !== undefined ? { calibrationRunId: scope.calibrationRunId } : {}),
      ...(scope.datasetId !== undefined ? { goldenItem: { goldenSet: { datasetId: scope.datasetId } } } : {}),
    },
    select: {
      goldenItem: {
        select: {
          id: true,
          index: true,
          goldenSetId: true,
          goldenSet: { select: { datasetId: true } },
        },
      },
      modelJudgments: {
        where: scope.judgeModelVersionId !== undefined
          ? { judgeModelVersionId: scope.judgeModelVersionId }
          : undefined,
        select: { latencyMs: true, status: true, judgeModelVersionId: true },
      },
    },
  });

  const byTuple = new Map<string, TimeToCompute>();

  for (const run of runs) {
    const item = run.goldenItem;
    // An ordinary (non-calibration) EvaluationRun. It has runtimes, but no
    // item and therefore no dataset — there is no tuple to file it under.
    if (!item) continue;

    for (const judgment of run.modelJudgments) {
      // A runtime nobody can attribute to a model is not a (dataset, item,
      // model) measurement. `judgeModelVersionId` is nullable
      // (schema.prisma:484) and null on pre-Task-12 rows.
      if (judgment.judgeModelVersionId === null) continue;
      // Never started, still running, or a v1 import with no runtime — not a
      // measurement. Counting it as 0ms would drag every mean down.
      if (judgment.latencyMs === null) continue;

      // PRINTABLE delimiter, not NUL. `\x00` is unambiguous — a cuid cannot
      // contain one — but it makes this SOURCE FILE binary: `file` reports
      // "data", and grep silently skips it, so the module becomes invisible to
      // every text search someone runs while debugging it. This repo already
      // decided that once, in 41147c8 "printable judge-grouping key (drop NUL
      // delimiters)"; `|` is equally unambiguous against cuids, which are
      // [a-z0-9] only.
      const key = `${item.goldenSet.datasetId}|${item.id}|${judgment.judgeModelVersionId}`;
      let row = byTuple.get(key);
      if (!row) {
        row = {
          datasetId: item.goldenSet.datasetId,
          goldenSetId: item.goldenSetId,
          goldenItemId: item.id,
          goldenItemIndex: item.index,
          judgeModelVersionId: judgment.judgeModelVersionId,
          count: 0,
          completedCount: 0,
          failedCount: 0,
          totalMs: 0,
          maxMs: 0,
        };
        byTuple.set(key, row);
      }

      row.count += 1;
      if (judgment.status === 'completed') row.completedCount += 1;
      else if (judgment.status === 'error') row.failedCount += 1;
      row.totalMs += judgment.latencyMs;
      row.maxMs = Math.max(row.maxMs, judgment.latencyMs);
    }
  }

  return [...byTuple.values()].sort(
    (a, b) =>
      a.goldenItemIndex - b.goldenItemIndex ||
      a.judgeModelVersionId.localeCompare(b.judgeModelVersionId)
  );
}

// ─── In-flight: which judgments are past their budget ───────────────────────

/** The columns `selectOverdue` needs off a `running` `ModelJudgment`. Kept as
 *  a plain shape rather than a Prisma type so the caller chooses its own
 *  query and this stays a pure function. */
export interface RunningJudgmentRow {
  id: string;
  /** `ModelJudgment.startedAt` — stamped by claim.ts on every claim and
   *  reclaim, so it is THIS attempt's start, not the first attempt's. */
  startedAt: Date | null;
  judgeModelVersionId: string | null;
  goldenItemIndex: number | null;
}

export interface OverdueJudgment {
  id: string;
  judgeModelVersionId: string | null;
  goldenItemIndex: number | null;
  elapsedMs: number;
  /** Non-null by construction (a row without one is skipped). Echoed back so a
   *  caller can identify the ATTEMPT rather than the judgment — a reclaim
   *  re-stamps this, and "already alerted about judgment X" keyed on the id
   *  alone would swallow the alert for the second attempt. */
  startedAt: Date;
}

/**
 * Which of these in-flight judgments have been running for at least
 * `budgetMs`, worst first.
 *
 * DERIVED FROM `startedAt`, WITH NO SERVER POLL AND NO SCHEMA CHANGE. The
 * owner was explicit that health is not a probe: "DON'T POLL THE SERVER".
 *
 * `>=`, not `>`: a call sitting exactly at the budget has reached it, and the
 * alert exists to be raised before the operator is already staring at a run
 * that looks stalled.
 *
 * A row with no `startedAt` is SKIPPED, not treated as started at the epoch.
 * `now - 0` is roughly 56 years, so one v1-imported judgment (`startedAt:
 * null`, scripts/importer/runs.ts:500) would otherwise produce a screaming
 * overdue alert on every five-second poll, forever, for a judgment nobody is
 * waiting on. A `startedAt` in the future (clock skew) is skipped for the
 * same reason: a negative age is not an overdue call.
 */
export function selectOverdue(
  rows: readonly RunningJudgmentRow[],
  nowMs: number,
  budgetMs: number
): OverdueJudgment[] {
  const overdue: OverdueJudgment[] = [];

  for (const row of rows) {
    if (row.startedAt === null) continue;
    const elapsedMs = nowMs - row.startedAt.getTime();
    if (elapsedMs < 0) continue;
    if (elapsedMs < budgetMs) continue;
    overdue.push({
      id: row.id,
      judgeModelVersionId: row.judgeModelVersionId,
      goldenItemIndex: row.goldenItemIndex,
      elapsedMs,
      startedAt: row.startedAt,
    });
  }

  return overdue.sort((a, b) => b.elapsedMs - a.elapsedMs);
}
