/**
 * ─── A2.1: scoring one calibration run against its answer key ───────────────
 *
 * ACCURACY IS THE PRIMARY NUMBER. KAPPA IS A LABELLED SECONDARY. Both are
 * stored, and the reason for the ordering is not a preference — it is that
 * kappa is answering a question nobody asked here.
 *
 * 1. GROUND TRUTH IS AN ANSWER KEY, NOT A PEER RATER. Cohen's kappa
 *    chance-corrects on BOTH raters' marginals, which presumes two annotators
 *    who could each have been wrong and whose response tendencies are both
 *    part of the noise. The corpus is not one of those. Its marginal is a
 *    property of the SET — 17 'A>B' and 13 'B>A' for the target set, fixed
 *    forever the moment the set was frozen — so discounting a judge's hits
 *    against it treats a constant as a source of chance. That is a category
 *    error, and it is why `thresholdMetric` is written as 'accuracy': the
 *    gate is "how often was the judge right", which accuracy states directly
 *    and kappa states only after mixing in a fact about the corpus.
 *
 * 2. KAPPA IS NOT COMPARABLE ACROSS SETS, AND CROSS-SET IS THE GOAL. Because
 *    pe depends on the key's own class balance, the same judge with the same
 *    hit rate scores a different kappa on a 17/13 set than on a 15/15 one —
 *    and a set that happens to be near-unanimous drives pe toward 1, where
 *    tiny differences in po swing kappa wildly. A leaderboard whose whole
 *    purpose is ranking judges across sets cannot be built on a statistic
 *    that moves when the set changes and the judge does not.
 *
 * SO WHY COMPUTE IT AT ALL? Because accuracy alone cannot tell a judge that
 * learned something from a judge that answers 'A>B' every time. Kappa scores
 * that judge 0.0000, which is exactly right; the two numbers fail in opposite
 * directions, so both are stored, and `kappaVariant`/`kappaWeighting` record
 * what produced the second one. A kappa with no stated method is a number
 * nobody can check a year from now.
 *
 * ── THE CONSTANT FLOOR IS COMPUTED, NOT RECITED ────────────────────────────
 *
 * Until v2l this header SAID that the always-'A>B' judge scores 0.5667
 * on the target set, and nothing computed it — so granite4.1:3b's 0.5000 was
 * read as a weak signal when it was worse than a stamp. `constantBaseline`
 * (src/lib/calibration/baseline.ts) is now emitted beside `accuracy`, with
 * `marginOverConstant` = accuracy − floor, and the floor's accuracy is stored
 * as `CalibrationRun.constantBaselineAccuracy` (v2l) in the same overwrite as
 * `rawAgreement`, so the scoreboard SQL reads both from one row.
 *
 * THE FLOOR MOVES WITH THE DENOMINATOR. It is max(key class)/verdictCount over
 * the SCORED subset, not over the set: the full key is 17/13 (0.5667), but
 * run 9 scored 25 of 30 items whose key was 14/11 — a floor of 0.5600.
 * Comparing a partial run against the whole set's floor flatters it, which is
 * why `keyCounts` below is accumulated past the same null-verdict gate as
 * `verdictCount`, and why a leaderboard cannot compute this number once and
 * cache it.
 *
 * ── WHAT COUNTS AND WHAT DOES NOT ──────────────────────────────────────────
 *
 * A 'tie' IS A MISS ON THIS CORPUS. The target set has no ties
 * (`GoldenItem.expected` is 'A>B' or 'B>A' — golden-sets.ts rejects anything
 * else at import), so there is no item a tie could be right about. Crediting
 * it as a partial hit, or dropping it from the denominator, would both let a
 * judge raise its score by refusing to answer. A tie KEY is nonetheless
 * reachable — PATCH /api/golden-sets/[id]/items writes `expected` with no
 * vocabulary check on an unfrozen set, and readings.ts accepts 'tie' — and
 * against such an item a 'tie' verdict is a hit by the same `actual ===
 * expected` rule below. The constant floor treats 'tie' as a class like the
 * other two for the same reason; do not "fix" either.
 *
 * A JUDGMENT THAT NEVER COMPLETED IS NOT A WRONG ANSWER. Every judgment row is
 * loaded regardless of status (the partition below is what filters to
 * `status: 'completed'`, per-pairOrder — see score.ts's partitioning comment),
 * so an in-flight calibration scores what it has rather than scoring pending
 * work as failure — otherwise the metric would climb as the queue drained,
 * improving while nothing improved.
 *
 * ── IDEMPOTENCE ────────────────────────────────────────────────────────────
 *
 * Every field is recomputed from the source rows and written as a FULL
 * OVERWRITE. Nothing increments. `verdictCount` is the landmine — an `Int`
 * with `@default(0)`, so an implementation reaching for `{ increment }` reads
 * perfectly and returns 60 on the second pass — and the
 * `@@unique([calibrationRunId, goldenItemId])` added in
 * 20260830120000_v2i_calibration_item_link is what guarantees the source rows
 * cannot be double-counted either. Re-scoring after a partial failure resumes;
 * it does not accumulate.
 */

import { agreement, type AgreementMethod } from '@/lib/agreement';
import { constantVerdictBaseline, type ConstantBaseline } from '@/lib/calibration/baseline';
import {
  groundTruthReadings,
  preferenceFromVerdict,
  PREFERENCES,
  type CalibrationVerdictRow,
  type PairOrder,
  type Preference,
  type Verdict,
} from '@/lib/calibration/readings';
import { SCORING_RULES_VERSION } from '@/lib/calibration/scoring-version';
import { prisma } from '@/lib/db';
import type { PrismaClient } from '@prisma/client';

/** The subset of `PrismaClient` this module needs — satisfied by the global
 *  `prisma` singleton in production and by a structural stand-in in the
 *  DB-free unit run. Same shape as `JudgeModelCatalogClient`
 *  (src/lib/model-catalog.ts) and `OidcUserClient` (src/lib/oidc-user.ts). */
export type CalibrationScoreClient = Pick<PrismaClient, 'evaluationRun' | 'calibrationRun'>;

/** One item the judge got wrong, with everything needed to go look at it:
 *  the key, what the judge meant, and the raw (verdict, pairOrder) it meant
 *  it with — because "the judge said B" is unreadable without the order. */
export type CalibrationDisagreement = {
  itemId: string;
  itemIndex: number;
  runId: string;
  expected: string;
  actual: Preference;
  verdict: string;
  pairOrder: string;
};

export type CalibrationScore = {
  calibrationRunId: string;
  /** correct / itemsWithAVerdict. `null` — never 0 — when the denominator is
   *  0: 0 reads as "agreed with the key on nothing", which is a measurement,
   *  and "nothing has been scored yet" is not. Same rule `agreement()` applies
   *  to its own insufficiency cases. */
  accuracy: number | null;
  kappa: number | null;
  /** Items with a completed, non-null verdict — the accuracy denominator. */
  verdictCount: number;
  /** Items that produced a (key, judge) reading pair. Equal to `verdictCount`
   *  by construction; carried separately so the two being unequal is visible
   *  rather than assumed away. */
  itemCount: number;
  missingVerdicts: number;
  correctCount: number;
  /** RAW verdict counts ('A' | 'B' | 'tie'), NOT derived preferences. The raw
   *  letters are the only place position bias is visible — a judge that says
   *  'A' 90% of the time regardless of order is the thing phase 2's BA sweep
   *  goes looking for, and deriving first would average that signal away. The
   *  derived distribution is recoverable as this matrix's column sums. */
  verdictDistribution: Record<string, number>;
  /** `confusion[expectedPreference][judgedPreference]`. Fully populated over
   *  PREFERENCES in both dimensions, zeros included, so one set's matrix is
   *  the same shape as another's. */
  confusion: Record<string, Record<string, number>>;
  disagreements: CalibrationDisagreement[];
  /** What produced `kappa`. A kappa with no stated method cannot be checked
   *  later, and this is what gets mirrored onto the row's `kappaVariant` /
   *  `kappaWeighting`. */
  method: AgreementMethod;
  /** The best constant verdict's hit rate over the SAME denominator as
   *  `accuracy` — max(key class)/verdictCount over the scored subset. `null`
   *  exactly when `accuracy` is. Computed per scoring because the floor moves
   *  with the denominator (17/30 = 0.5667 on the full set; 14/25 = 0.5600 on
   *  run 9's scored subset). Its `accuracy` is mirrored onto the row's
   *  `constantBaselineAccuracy`. */
  constantBaseline: ConstantBaseline | null;
  /** accuracy − constantBaseline.accuracy. Negative means the judge did worse
   *  than stamping. `null` when either side is. */
  marginOverConstant: number | null;
  /** `EvaluationRun` rows for this calibration run that carry a `goldenItem` —
   *  the items the judge was ASKED. OBSERVED, never derived. Equal to
   *  `verdictCount + missingVerdicts` in phase 1 (one judgment per run); carried
   *  separately so a future BA sweep breaking that identity is VISIBLE rather
   *  than assumed away, exactly as `itemCount` is carried beside `verdictCount`. */
  dispatchedItemCount: number;
  /** `missingVerdicts / dispatchedItemCount` — the share of asked items that
   *  produced no verdict at all. `null` — never 0, never NaN — when nothing was
   *  dispatched; `0` (not null) when everything answered, because "nothing was
   *  lost" is a measurement.
   *
   *  THIS IS A PROPERTY OF THE FLEET, NOT OF THE JUDGE, AND MUST NOT BE READ AS
   *  ABSTENTION. Measured 2026-09-06 over the four completed runs on the 620-item
   *  set (n = 2,480 item-rows): judge-behaviour refusals 0, prose-not-JSON 0,
   *  token-budget truncations 18, infrastructure 0. Every no-verdict row is a
   *  `finishReason='length'` truncation or a dead request. A judge that declines
   *  says `tie` — the enum has no other channel (M6 Result 1) — and that lands in
   *  `coverage`, not here. It exists because `rawAgreement`'s denominator
   *  otherwise varies silently per judge: 619, 620 and 603 on the SAME set, so
   *  lfm2.5:8b is scored over a strictly easier-to-reach subset than its peers
   *  with nothing on the scoreboard saying so (M6 Result 6). */
  noVerdictRate: number | null;
  /** Items the judge COMMITTED on — a raw verdict other than 'tie'. The
   *  denominator of `selectiveAccuracy`. */
  committedCount: number;
  /** Items the judge ABSTAINED on — raw verdict 'tie'. Equal to
   *  `verdictCount − committedCount` by construction; carried separately so the
   *  two being unequal is visible rather than assumed away, the same rule
   *  `itemCount` follows. */
  abstainedCount: number;
  /** Correct answers among the COMMITTED ones. EQUAL to `correctCount` on a
   *  forced-choice key and strictly smaller on a key that contains ties, where a
   *  'tie' verdict can itself be a hit. Reusing `correctCount` as the selective
   *  numerator over this denominator yields a "selective accuracy" above 1. */
  committedCorrectCount: number;
  /** committedCount / verdictCount — how often the judge COMMITTED, **CONDITIONAL
   *  ON HAVING ANSWERED AT ALL**. Not "how often it answered": a 'tie' IS an
   *  answer, and both operands here count only completed non-null verdicts, so an
   *  item that errored, dead-lettered or truncated is in NEITHER of them. A judge
   *  that fails outright therefore reads as HIGHER-coverage than one that ties —
   *  lfm2.5:8b's 500 ties give 0.1708, and the same 500 as truncations would give
   *  1.0000 over a verdictCount of 103. Always read this beside `missingVerdicts`.
   *  `null` — never 0 — when nothing was scored. Coverage 0 with a non-zero
   *  verdictCount IS a measurement: the judge replied and committed to none of
   *  them. And it is monotonically improvable by abstaining on your own errors,
   *  so `selectiveAccuracy` is never a ranking key without a coverage guard
   *  (Task 1 Step 1's scoreboard query). */
  coverage: number | null;
  /** committedCorrectCount / committedCount — how often the judge was RIGHT
   *  WHEN IT ANSWERED. `null` — never 0, never 1, never NaN — at zero coverage,
   *  because "it was never right when it answered" is a claim about answers
   *  that do not exist. `rawAgreement` is `coverage × selectiveAccuracy` and
   *  multiplying the two is exactly what hides a stamper: lfm2.5:8b and
   *  lfm2.5-thinking differ 5.3x on rawAgreement (0.0929 / 0.4887) and are
   *  indistinguishable here (0.5437 / 0.5363). */
  selectiveAccuracy: number | null;
  /** The constant floor over the COMMITTED subset — max(committed key
   *  class)/committedCount. NOT `constantBaseline`, which is over every scored
   *  item: comparing selective accuracy against THAT is the error v2l exists to
   *  prevent, one level down, and on production data it flips the margin's sign
   *  for two of four judges. The two can even name different top classes. */
  selectiveBaseline: ConstantBaseline | null;
  /** selectiveAccuracy − selectiveBaseline.accuracy. `null` when either is. */
  selectiveMarginOverConstant: number | null;
};

type LoadedJudgment = {
  verdict: string | null;
  pairOrder: string | null;
  judgeModelVersionId: string | null;
  status: string;
};

type LoadedRun = {
  id: string;
  goldenItem: { id: string; index: number; expected: string | null } | null;
  modelJudgments: LoadedJudgment[];
};

/**
 * Score one calibration run and write the result onto its `CalibrationRun`.
 *
 * `client` is injected so this is exercisable without a live Postgres; every
 * caller in the app passes nothing and gets the singleton.
 */
export async function scoreCalibrationRun(
  calibrationRunId: string,
  client: CalibrationScoreClient = prisma
): Promise<CalibrationScore> {
  const runs = (await client.evaluationRun.findMany({
    where: { calibrationRunId },
    select: {
      id: true,
      goldenItem: { select: { id: true, index: true, expected: true } },
      modelJudgments: {
        // NO `where: { status: 'completed' }` any more. With two judgments per
        // run, filtering here made a run whose AB errored and whose BA
        // completed arrive with `length === 1` — escaping the `length === 0`
        // unjudged test, contributing no AB row, and reporting
        // `missingVerdicts 0` over a short denominator. That is the 2026-08-31
        // failure this file's comment below memorialises, in the direction
        // that HIDES loss. The status gate moved into the partition.
        select: { verdict: true, pairOrder: true, judgeModelVersionId: true, status: true },
      },
    },
    // Stable output for the disagreement list and for the reading order the
    // confusion matrix is built in. `index` is the item's ordinal in the
    // golden set, which is what an operator will be looking at.
    orderBy: { goldenItem: { index: 'asc' } },
  })) as unknown as LoadedRun[];

  type Partition = {
    rows: CalibrationVerdictRow[];
    /** Parallel to `rows` WITHIN this partition. It must travel with the rows,
     * not beside the whole set: `rows` is indexed positionally at the
     * disagreement push below, so grouping rows alone slides every
     * disagreement past the first BA row onto another item's runId. */
    context: Array<{ runId: string; itemIndex: number }>;
    unjudgedItems: number;
    dispatchedItemCount: number;
  };

  /** Key for a partition. Pointwise judgments carry `pairOrder: null` and all
   *  belong to one partition; the empty string cannot collide with 'AB'/'BA'. */
  const partitionKey = (pairOrder: string | null): string => pairOrder ?? '';

  const partitions = new Map<string, Partition>();
  const ensure = (key: string): Partition => {
    let p = partitions.get(key);
    if (!p) {
      p = { rows: [], context: [], unjudgedItems: 0, dispatchedItemCount: 0 };
      partitions.set(key, p);
    }
    return p;
  };

  // A run with NO judgment rows at all belongs to whichever partition ends up
  // primary: the OLD flat loop counted it in dispatchedItemCount and
  // unjudgedItems, and this task must not change that. It cannot be attributed
  // inside the loop because the primary key is not known until every run has
  // been seen. Unreachable today — launchSingleRun creates a run's judgments
  // nested in the same evaluationRun.create — but inertness is this task's
  // entire point, so it is restored rather than argued away.
  let judgmentlessRuns = 0;

  for (const run of runs) {
    // A calibration EvaluationRun without a goldenItem cannot be scored
    // against anything. The @@unique([calibrationRunId, goldenItemId]) makes
    // the pair the identity of the row, so this is a shape nothing writes;
    // skipping beats crashing a whole calibration over it, and it cannot go
    // unnoticed because the run contributes to no count.
    if (run.goldenItem === null) continue;

    // Which orders were ASKED of this item — derived from the judgment rows
    // that exist at all, regardless of status, which is exactly why the query
    // no longer filters on `completed`.
    const askedKeys = new Set(run.modelJudgments.map((j) => partitionKey(j.pairOrder)));
    if (askedKeys.size === 0) {
      judgmentlessRuns += 1;
      continue;
    }

    for (const key of askedKeys) {
      const partition = ensure(key);
      partition.dispatchedItemCount += 1;
      const completed = run.modelJudgments.filter(
        (j) => partitionKey(j.pairOrder) === key && j.status === 'completed'
      );
      if (completed.length === 0) {
        partition.unjudgedItems += 1;
        continue;
      }
      for (const judgment of completed) {
        partition.rows.push({
          itemId: run.goldenItem.id,
          expected: run.goldenItem.expected,
          raterId: judgment.judgeModelVersionId ?? 'model',
          verdict: judgment.verdict,
          pairOrder: judgment.pairOrder,
        });
        partition.context.push({ runId: run.id, itemIndex: run.goldenItem.index });
      }
    }
  }

  // THE PARTITION THAT FEEDS THE STORED COLUMNS. 'AB' when a pairwise
  // calibration ran, otherwise the single partition a pointwise one produced.
  // Per the spec's D2 the stored rawAgreement/kappa/verdictCount stay AB-only,
  // so every one of the 22 historical rows scores bit-identically.
  // `[...partitions.keys()][0]` is deterministic for every reachable shape —
  // zero or one non-AB key — and only depends on Map insertion order in the
  // hypothetical of a mixed calibration with no 'AB' partition at all, which
  // nothing today produces.
  const primaryKey = partitions.has('AB') ? 'AB' : ([...partitions.keys()][0] ?? '');
  const primary = ensure(primaryKey);
  // Judgment-less runs belong to the primary partition once it is known — see
  // the accumulator's own comment above for why this can't happen in the loop.
  primary.dispatchedItemCount += judgmentlessRuns;
  primary.unjudgedItems += judgmentlessRuns;
  const { rows, context } = primary;
  // Items that were LAUNCHED but produced nothing for this partition — the
  // judgment errored, DLQ'd, or is still in flight. They must be counted here
  // and nowhere else: `groundTruthReadings` can only report a missing verdict
  // for a row it was actually handed.
  //
  // Getting this wrong is not cosmetic. The first production calibration
  // (2026-08-31) reported `missingVerdicts 0` while FOUR of thirty items had
  // dead-lettered, directly under an accuracy line whose own denominator said
  // 26. A reader is entitled to trust the field named "how many are missing"
  // over arithmetic they have to do themselves, and that reading was wrong.
  const unjudgedItems = primary.unjudgedItems;
  // Items the judge was ASKED — counted past the same `goldenItem === null`
  // gate as everything else, so a row that cannot be scored against anything
  // is not counted as having been asked either.
  const dispatchedItemCount = primary.dispatchedItemCount;

  const projection = groundTruthReadings(rows);

  const verdictDistribution: Record<string, number> = { A: 0, B: 0, tie: 0 };
  const confusion: Record<string, Record<string, number>> = {};
  for (const expected of PREFERENCES) {
    confusion[expected] = {};
    for (const judged of PREFERENCES) confusion[expected][judged] = 0;
  }
  // The answer key's marginal over the SCORED subset — incremented past the
  // same null-verdict gate as `verdictCount`, so its sum IS `verdictCount`.
  // A separate accumulator rather than the confusion row sums, in this file's
  // own style (see the loop comment below): the test pins the two equal, and
  // a regression in either is a failure rather than one shared wrong answer.
  const keyCounts: Record<Preference, number> = { 'A>B': 0, 'B>A': 0, tie: 0 };
  // The SAME marginal, restricted to the items the judge COMMITTED on. It is
  // the selective floor's denominator, and it is not derivable from `keyCounts`
  // — the abstentions do not fall evenly across the key. On production data the
  // two floors can name DIFFERENT top classes, and quoting the wrong one is a
  // wrong number under a wrong label on the line a reader uses to decide
  // whether a judge beat a stamp.
  const committedKeyCounts: Record<Preference, number> = { 'A>B': 0, 'B>A': 0, tie: 0 };

  const disagreements: CalibrationDisagreement[] = [];
  let correctCount = 0;
  // Correct answers among the COMMITTED ones only. A 'tie' verdict against a
  // tie-KEYED item is a hit (score.ts's header, and constantVerdictBaseline
  // treats 'tie' as a class for the same reason), so `correctCount` can contain
  // hits that `committedCount` excluded — and 3/2 is a selective accuracy of
  // 1.5. Separate accumulator, past the same gate.
  let committedCorrectCount = 0;
  let verdictCount = 0;

  rows.forEach((row, i) => {
    // Already validated by groundTruthReadings above, which THREW on a missing
    // or non-preference key, an unrecognised verdict, and an unusable
    // pairOrder. Everything reaching here is well-formed, which is why the
    // casts below are safe and why neither index needs an existence check:
    // `verdictDistribution` is pre-seeded with all three verdicts and
    // `confusion` with all of PREFERENCES in both dimensions, so a defensive
    // `?? 0` here would be unreachable code claiming a case the guard already
    // owns. Recomputing the preference rather than reading it back out of
    // `readings` keeps the two loops independent: a regression in either is a
    // test failure, not one shared wrong answer.
    if (row.verdict === null) return;
    verdictCount += 1;
    verdictDistribution[row.verdict] += 1;

    const actual = preferenceFromVerdict(row.verdict as Verdict, row.pairOrder as PairOrder);
    const expected = row.expected as Preference;
    keyCounts[expected] += 1;
    confusion[expected][actual] += 1;
    // ABSTENTION IS THE RAW VERDICT 'tie', NOT THE DERIVED PREFERENCE. The two
    // agree here — `preferenceFromVerdict` maps 'tie' to 'tie' and maps nothing
    // else to it — but the raw letter is what the judge SAID, and this split
    // has to keep meaning the same thing under phase 2's BA sweep, which swaps
    // 'A'/'B' and leaves 'tie' alone.
    if (row.verdict !== 'tie') committedKeyCounts[expected] += 1;

    if (actual === expected) {
      correctCount += 1;
      if (row.verdict !== 'tie') committedCorrectCount += 1;
      return;
    }
    disagreements.push({
      itemId: row.itemId,
      itemIndex: context[i].itemIndex,
      runId: context[i].runId,
      expected,
      actual,
      verdict: row.verdict,
      pairOrder: row.pairOrder as string,
    });
  });

  const accuracy = verdictCount === 0 ? null : correctCount / verdictCount;
  const result = agreement(projection.readings);
  // Null exactly when `accuracy` is: both share the denominator.
  const constantBaseline = constantVerdictBaseline(keyCounts);
  const marginOverConstant =
    accuracy !== null && constantBaseline !== null ? accuracy - constantBaseline.accuracy : null;

  // ── Coverage and selective accuracy ──────────────────────────────────────
  // The SAME pure function, over a DIFFERENT denominator. `denominator` is read
  // back off the baseline rather than accumulated a third time: it is the sum
  // of `committedKeyCounts` by construction, and a second counter that could
  // disagree with the floor's own denominator is two numbers for one thing.
  const selectiveBaseline = constantVerdictBaseline(committedKeyCounts);
  const committedCount = selectiveBaseline === null ? 0 : selectiveBaseline.denominator;
  const abstainedCount = verdictCount - committedCount;
  const coverage = verdictCount === 0 ? null : committedCount / verdictCount;
  // NULL, not 0 and not NaN. `0/0` is NaN and would flow into JSON and into the
  // column as null anyway — but by accident, and `committedCorrectCount / 0`
  // with a non-zero numerator is Infinity. Neither is a measurement.
  const selectiveAccuracy = committedCount === 0 ? null : committedCorrectCount / committedCount;
  const selectiveMarginOverConstant =
    selectiveAccuracy !== null && selectiveBaseline !== null
      ? selectiveAccuracy - selectiveBaseline.accuracy
      : null;

  // Both shapes of "this item produced no answer": a row whose verdict is null
  // (judged, but the judge said nothing usable) and a run with no completed
  // judgment at all (errored, dead-lettered, or still running). Lifted to a
  // const because `noVerdictRate` below divides it — computing the sum twice is
  // how the stored count and the printed rate drift apart.
  const missingVerdicts = projection.missingVerdicts + unjudgedItems;
  // Null at zero dispatched, 0 when everything answered. See the field's doc:
  // this is a fleet property and is not part of coverage.
  const noVerdictRate = dispatchedItemCount === 0 ? null : missingVerdicts / dispatchedItemCount;

  const score: CalibrationScore = {
    calibrationRunId,
    accuracy,
    kappa: result.value,
    verdictCount,
    itemCount: projection.itemCount,
    missingVerdicts,
    correctCount,
    verdictDistribution,
    confusion,
    disagreements,
    constantBaseline,
    marginOverConstant,
    dispatchedItemCount,
    noVerdictRate,
    committedCount,
    abstainedCount,
    committedCorrectCount,
    coverage,
    selectiveAccuracy,
    selectiveBaseline,
    selectiveMarginOverConstant,
    method: {
      statistic: result.statistic,
      weighting: result.weighting,
      annotatorCount: result.annotatorCount,
      itemCount: result.itemCount,
      categories: result.categories,
    },
  };

  await client.calibrationRun.update({
    where: { id: calibrationRunId },
    data: {
      // rawAgreement IS accuracy. The column predates this phase and its name
      // is inherited; storing anything else there would leave two columns
      // that sound like the same number disagreeing about it.
      rawAgreement: accuracy,
      kappa: result.value,
      verdictCount,
      // The floor beside the number it floors, on the row the §8 scoreboard
      // SQL reads. Same full-overwrite rule as everything here: re-scoring
      // after a drain moves verdictCount and this moves with it. baseline.ts
      // is the source of truth; this is its stored copy.
      constantBaselineAccuracy: constantBaseline === null ? null : constantBaseline.accuracy,
      // v2n. `coverage` is deliberately NOT written: it is committedCount /
      // verdictCount and both operands are on this row, so a stored copy is a
      // derived duplicate that a partial re-score would leave stale.
      committedCount,
      selectiveAccuracy,
      selectiveBaselineAccuracy: selectiveBaseline === null ? null : selectiveBaseline.accuracy,
      // v2m. Scoring is ex post and re-runnable, so the numbers above are
      // uninterpretable without the generation that produced them. Written from
      // the CONSTANT, never a literal, in the same full overwrite: the stamp and
      // the numbers cannot move independently.
      scoringVersion: SCORING_RULES_VERSION,
      // Mirrored from the method `agreement()` actually USED rather than
      // written as literals. Both are 'cohen'/'none' by construction here —
      // exactly two raters, and preferences carry no distance so any
      // requested weighting is downgraded — but a literal would keep saying
      // so after the construction changed, which is how a stored label starts
      // lying about the number beside it.
      kappaVariant: result.statistic,
      kappaWeighting: result.weighting,
      // The gate is accuracy, for the two reasons in the module doc. Recorded
      // per A0 decision #3: `passed` alone is uninterpretable a year later.
      thresholdMetric: 'accuracy',
      // Stamps the pass that produced the numbers stored beside it. Re-scoring
      // an unchanged calibration moves this and nothing else, because every
      // other field is a pure function of the source rows.
      finishedAt: new Date(),
    },
  });

  return score;
}
