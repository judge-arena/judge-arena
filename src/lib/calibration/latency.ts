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
 *   judgeThroughputEstimate(judgeModelVersionId, client?)
 *       -> Promise<ThroughputEstimate | null>
 *
 *     `{ tokPerSec, n }` POOLED over the COMPLETED judgments of one judge
 *     (`Σ accountTokens(row).estimatedGeneratedTokens / Σ (latencyMs / 1000)`,
 *     via `accountTokens` from `@/lib/calibration/token-accounting` —
 *     **never** raw `Σ outputTokens / Σ latencyMs`: `outputTokens` is
 *     `usage.completion_tokens` verbatim and OMITS the reasoning channel on
 *     some models when the request carries `response_format: json_schema`,
 *     which the judge path always sends — see token-accounting.ts's module
 *     doc), or **`null` when none carried a usable estimate** — the same
 *     null-not-zero contract as the baseline, for the same reason: zero
 *     tok/s reads as "emits nothing" and a caller dividing max_tokens by it
 *     gets Infinity. It cannot come from the endpoint verify probe, which
 *     sends `max_tokens: 1`. This is the input to the stacked-limits check
 *     (runbook §8.6) that `launchCalibrationRun` runs.
 *
 *   budgetWarningFor({ maxTokens, throughput, hardCapMs }) -> string | null
 *
 *     The stacked-limits rule as one operator sentence: `max_tokens /
 *     tokPerSec` strictly over the hard cap yields a warning naming the
 *     budget, the rate, the sample size, both durations and the fact that
 *     the figure is a LOWER bound; `null` otherwise — including when
 *     `throughput` is null, because a first-ever judge must still launch.
 *     Pure. WARNS, NEVER REFUSES; the caller decides where it goes.
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

import { accountTokens } from '@/lib/calibration/token-accounting';
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

// ─── Throughput: the input to the stacked-limits check ──────────────────────

/** A judge's measured output throughput, pooled over its COMPLETED judgments.
 *  Only ever produced for a NON-EMPTY sample — the empty case is `null`, for
 *  the same reason `LatencyBaseline`'s is (module doc): a zero here would read
 *  as "this judge produces nothing", and `max_tokens / 0` is Infinity. */
export interface ThroughputEstimate {
  /** Σ `accountTokens(row).estimatedGeneratedTokens` / Σ (latencyMs / 1000)
   *  over the rows that carried both. POOLED, not a mean of per-judgment
   *  rates: a mean of rates weights a 109-token verdict the same as a
   *  7,000-token one, and the number a budget is sized against is "how fast
   *  does this judge emit tokens", not "what is the average of its per-call
   *  speeds". NEVER raw `outputTokens` — see `summarizeThroughput`'s doc for
   *  why. */
  tokPerSec: number;
  /** How many completed judgments carried a usable estimate — the
   *  denominator, stated, because a rate over 1 judgment and over 30 are
   *  different claims. */
  n: number;
}

/** The columns the estimate reads, as a plain shape so the arithmetic is a
 *  pure function of rows the caller chose (the `RunningJudgmentRow` /
 *  `selectOverdue` pattern below). `reasoningContent` is read by
 *  `accountTokens`, not by this module, to tell whether `outputTokens`
 *  already counted it. */
export interface ThroughputRow {
  outputTokens: number | null;
  latencyMs: number | null;
  reasoningContent: string | null;
}

/**
 * Pool DERIVED generated-token counts over wall-clock seconds.
 *
 * Reads `estimatedGeneratedTokens` from `accountTokens()`
 * (`@/lib/calibration/token-accounting`), NOT the raw `outputTokens` column.
 * `ModelJudgment.outputTokens` is `usage.completion_tokens` verbatim, and on
 * some models it does not count the reasoning channel at all when the
 * request carried `response_format: json_schema` — which the judge path
 * always does. `accountTokens` is the already-landed, already-tested
 * primitive that tells the two cases apart per row
 * (`REASONING_EXCLUDED_RATIO`); this function's own job is only to pool what
 * `accountTokens` already classified, and to guard `latencyMs`, which
 * `accountTokens` does not touch at all.
 *
 * Drops any row whose `latencyMs` is missing, non-positive or non-finite (0
 * would divide by zero), and any row whose `accountTokens(row)
 * .estimatedGeneratedTokens` is not a finite number. That already covers a
 * v1-imported judgment (`outputTokens: null`, scripts/importer/runs.ts:494)
 * and a completed judgment that emitted nothing (`outputTokens <= 0`):
 * `accountTokens` returns `estimatedGeneratedTokens: null` for both, per its
 * own "an absent or non-positive provider count is an ABSENCE" contract —
 * `summarizeThroughput` does not reimplement that decision, only propagates
 * it. `ThroughputRow` is exported, so a caller can still hand in a NaN
 * `outputTokens` with no reasoning channel: `accountTokens` does NOT reject
 * that value (`NaN <= 0` is `false`, so its own early-return guard does not
 * fire, and with no reasoning channel it returns the NaN straight back as
 * `estimatedGeneratedTokens`) — caught here by `Number.isFinite`, not by
 * `accountTokens`. Returns `null` when nothing survives — the same contract
 * as `summarizeLatencies`.
 * Pure, so the arithmetic is testable without a database anywhere near it —
 * `accountTokens` is a leaf module (zero imports) for the same reason.
 */
export function summarizeThroughput(rows: readonly ThroughputRow[]): ThroughputEstimate | null {
  let tokens = 0;
  let ms = 0;
  let n = 0;
  for (const row of rows) {
    if (typeof row.latencyMs !== 'number' || !Number.isFinite(row.latencyMs) || row.latencyMs <= 0) continue;
    const estimatedGeneratedTokens = accountTokens(row).estimatedGeneratedTokens;
    if (typeof estimatedGeneratedTokens !== 'number' || !Number.isFinite(estimatedGeneratedTokens)) continue;
    tokens += estimatedGeneratedTokens;
    ms += row.latencyMs;
    n += 1;
  }
  if (n === 0) return null;
  return { tokPerSec: tokens / (ms / 1000), n };
}

/**
 * How fast this judge has historically emitted output tokens, DERIVED via
 * `accountTokens` (never the raw `outputTokens` column — see
 * `summarizeThroughput`'s doc), or `null` if it has never completed a
 * judgment that produced a usable estimate.
 *
 * Same scope and same status filter as `judgeLatencyBaseline`, for the same
 * reason: a call that timed out is evidence that the judge did not answer,
 * not evidence about its speed. And it cannot come from the endpoint verify
 * probe — `src/lib/llm/verify.ts` sends `max_tokens: 1`, and one token is
 * not a rate.
 *
 * Consumed by `launchCalibrationRun` (src/lib/calibration/launch.ts) for the
 * stacked-limits warning: `max_tokens / tokPerSec` must fit under the hard
 * cap, or a judgment that needs its whole budget is aborted rather than
 * truncated (runbook §8.6; register §5.6/8).
 */
export async function judgeThroughputEstimate(
  judgeModelVersionId: string,
  client: JudgeLatencyClient = prisma
): Promise<ThroughputEstimate | null> {
  const rows = await client.modelJudgment.findMany({
    // Same WHERE as the baseline, served by the same index
    // (ModelJudgment_judgeModelVersionId_idx). Runs once per launch.
    where: { judgeModelVersionId, status: 'completed' },
    // `reasoningContent` alongside the two columns the raw formula used —
    // `accountTokens` needs it to tell whether `outputTokens` already
    // counted the reasoning channel. There is deliberately no stored
    // "reasoningChars" column (token-accounting.ts's module doc): the
    // character count is derived at read time from the column already here.
    select: { outputTokens: true, latencyMs: true, reasoningContent: true },
  });

  // The null/zero/non-finite filter lives in `summarizeThroughput`, NOT in
  // the WHERE above, so it is exercised by the unit suite instead of by
  // Postgres.
  return summarizeThroughput(rows);
}

export interface BudgetWarningInput {
  /** The EFFECTIVE `max_tokens` the run will execute under — the resolved
   *  snapshot on the CalibrationRun header (`effectiveSamplingParams`), never
   *  the raw, nullable `JudgeModelVersion.samplingDefaults`. */
  maxTokens: number;
  /** `judgeThroughputEstimate(...)`. `null` = no history, which is NOT a
   *  warning: a first-ever judge has nothing to be measured against. */
  throughput: ThroughputEstimate | null;
  /** `resolveTimeoutBudgets().hardCapMs` — the abort, not the alert. */
  hardCapMs: number;
}

/**
 * The stacked-limits rule (runbook §8.6), as one sentence an operator reads:
 * `max_tokens / tok_per_s` must fit under the HARD CAP, or a judgment that
 * needs its whole budget is ABORTED rather than truncated.
 *
 * WHICH WALL, PRECISELY — because the obvious one-line history is wrong and
 * a wrong motivation would mis-set every reader's expectation. granite4.2's
 * 2026-09-01 stall (runbook §8.6) was the 300 s PROVIDER timeout: 35 tok/s
 * against a 12288 budget is ~351 s, which overran 300 s and fits 900 s
 * comfortably. This rule would have been SILENT on granite, correctly, and
 * it is not the check that would have caught it. What it guards is the wall
 * that is still an abort: as of `sha-414e826a3ba3` (runbook §8.7) the 300 s
 * `EVALUATION_MODEL_TIMEOUT_MS` only WARNS and keeps waiting, and
 * `EVALUATION_MODEL_HARD_CAP_MS` (900 000 ms) is the only value that aborts.
 * The live case this exists for is qwen3.5:9b: its judge path always sends
 * response_format: json_schema, and outputTokens EXCLUDES the reasoning
 * channel on this model, so the rate below is `judgeThroughputEstimate`'s
 * `accountTokens`-derived pooled figure, never a raw outputTokens count —
 * measured against judge-arena-pg-1 (read-only psql, 2026-09-02) at
 * 12.0 tok/s (Σ estimatedGeneratedTokens / Σ latencyMs over its 15 completed
 * judgments): 12288 / 12.0 = 1024 s against a 900 s cap.
 *
 * WHOSE CAP. `hardCapMs` is the LAUNCHER's `resolveTimeoutBudgets().hardCapMs`
 * — the env of the process that runs the CLI — while the abort happens in the
 * WORKER pod, which reads its own `EVALUATION_MODEL_HARD_CAP_MS`. If the two
 * differ the check silently uses the wrong ceiling (a worker configured at
 * 600 000 aborts a run the launcher called fine). This adds no new coupling:
 * `launch.ts`'s batch deadline (:312-314) already assumes the same equality.
 * It is stated so an operator knows to confirm it before trusting silence.
 *
 * SCOPE — one of four launch paths, deliberately. This runs at CALIBRATION
 * launch only. `launchSingleRun` / `launchBulkRunCreates` are also reached
 * from `src/app/api/evaluations/[id]/runs/route.ts:84` and
 * `src/app/api/evaluations/route.ts:303 / :494 / :605`; those ordinary and
 * bulk launches execute under the same `samplingDefaults` and the same hard
 * cap and get NO warning. That is a scope decision, not an oversight, and it
 * is recorded rather than left to be discovered (handoff §5.1: the escalating
 * timeout shipped into ONE of three seams and looked live).
 *
 * WHAT SILENCE DOES NOT MEAN. The rule fires only when the OPTIMISTIC,
 * flat-rate estimate already exceeds the cap, and the flat model understates
 * the tail by ~51% at 12k tokens (spec §5.4.1): granite4.2's flat-rate
 * estimate at 12288 tokens is 351 s (35 tok/s) but the real run took 529 s,
 * ~1.51x the flat estimate. So a judge whose flat-rate estimate lands
 * anywhere in roughly 0.65x-1.0x of the cap (900 s / 1.51 ≈ 597 s and up)
 * can still abort at it with no warning. Deliberate — a second, softer band
 * would need its own sentence, its own test and its own injection, and this
 * commit does one thing — but it means "no warning" is not a clean bill. The
 * runbook paragraph says so.
 *
 * WARNS, NEVER REFUSES. `null` means "nothing to say", covering both "it
 * fits" and "no history yet" — deliberately one value, because the caller's
 * action is identical (launch) and the two states are told apart by the
 * launch log, not by a refusal.
 *
 * The estimate is a LOWER BOUND on duration and the text says so: throughput
 * DECAYS with output length (granite4.2 ran 35.9 tok/s at 4.5k tokens and
 * 23.2 tok/s at 12k — scoreboard spec §5.4.1), so a budget that "just fits"
 * at the pooled rate does not fit.
 *
 * Strictly `>`: exhausting exactly at the cap is the boundary of the abort
 * and nothing here is precise to the millisecond. The `!( … > …)` form also
 * swallows a NaN estimate rather than rendering it — that is load-bearing,
 * not incidental: the equivalent-looking `estimatedMs <= hardCapMs` would
 * print "max_tokens NaN cannot be produced …" at an operator, because
 * `NaN <= cap` is false. Pinned by the 'a NaN estimate is silence' test.
 *
 * The advice deliberately does NOT say "raise samplingDefaults.max_tokens"
 * (registry.ts's truncation advice): raising it is what produces this
 * condition, and `samplingDefaults` is meant to be immutable under a
 * judgment (prisma/seed-core.ts:223-229 — a different value is a new
 * ordinal). The other lever it names is bounded: `src/lib/env.ts:111`
 * clamps EVALUATION_MODEL_HARD_CAP_MS with `.max(MAX_HARD_CAP_MS)` and
 * MAX_HARD_CAP_MS is 1_170_000 ms (src/lib/llm/timeout-policy.ts:94), so
 * the sentence says so rather than offering an unreachable remedy.
 */
export function budgetWarningFor(input: BudgetWarningInput): string | null {
  const { maxTokens, throughput, hardCapMs } = input;
  if (throughput === null) return null;
  const estimatedMs = (maxTokens / throughput.tokPerSec) * 1000;
  if (!(estimatedMs > hardCapMs)) return null;
  return (
    `max_tokens ${maxTokens} cannot be produced inside the ${formatDurationMs(hardCapMs)} hard cap ` +
    `at this judge's measured ${throughput.tokPerSec.toFixed(1)} tok/s ` +
    `(n=${throughput.n} completed judgment(s)): exhausting the budget takes ~${formatDurationMs(estimatedMs)}, ` +
    `and a judgment that needs its full budget will be ABORTED at the cap, not truncated. ` +
    `Throughput decays with output length, so that figure is a LOWER bound on the duration, not an estimate. ` +
    `Register a new ordinal with a smaller max_tokens (never edit samplingDefaults mid-run), ` +
    `or raise EVALUATION_MODEL_HARD_CAP_MS (bounded: env.ts refuses anything above MAX_HARD_CAP_MS, 1170000 ms).`
  );
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
