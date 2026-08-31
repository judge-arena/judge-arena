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
 * learned something from a judge that answers 'A>B' every time. On the target
 * set that degenerate judge scores 0.5667 — comfortably "better than chance"
 * to the naked eye — and kappa scores it 0.0000, which is exactly right. The
 * two numbers fail in opposite directions, so both are stored, and
 * `kappaVariant`/`kappaWeighting` record what produced the second one. A
 * kappa with no stated method is a number nobody can check a year from now.
 *
 * ── WHAT COUNTS AND WHAT DOES NOT ──────────────────────────────────────────
 *
 * A 'tie' IS A MISS. The corpus has no ties (`GoldenItem.expected` is 'A>B'
 * or 'B>A' — golden-sets.ts rejects anything else at import), so there is no
 * item a tie could be right about. Crediting it as a partial hit, or dropping
 * it from the denominator, would both let a judge raise its score by refusing
 * to answer.
 *
 * A JUDGMENT THAT NEVER COMPLETED IS NOT A WRONG ANSWER. Only
 * `status: 'completed'` judgments are loaded, so an in-flight calibration
 * scores what it has rather than scoring pending work as failure — otherwise
 * the metric would climb as the queue drained, improving while nothing
 * improved.
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
import {
  groundTruthReadings,
  preferenceFromVerdict,
  PREFERENCES,
  type CalibrationVerdictRow,
  type PairOrder,
  type Preference,
  type Verdict,
} from '@/lib/calibration/readings';
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
};

type LoadedJudgment = {
  verdict: string | null;
  pairOrder: string | null;
  judgeModelVersionId: string | null;
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
        // See the module doc: pending/running/error judgments are absent
        // answers, not wrong ones.
        where: { status: 'completed' },
        select: { verdict: true, pairOrder: true, judgeModelVersionId: true },
      },
    },
    // Stable output for the disagreement list and for the reading order the
    // confusion matrix is built in. `index` is the item's ordinal in the
    // golden set, which is what an operator will be looking at.
    orderBy: { goldenItem: { index: 'asc' } },
  })) as unknown as LoadedRun[];

  const rows: CalibrationVerdictRow[] = [];
  // Parallel to `rows`, so the per-item outputs below can be built from the
  // SAME narrowing groundTruthReadings does rather than a second copy of it.
  const context: Array<{ runId: string; itemIndex: number }> = [];

  // Items that were LAUNCHED but produced nothing — the judgment errored,
  // DLQ'd, or is still in flight. They must be counted here and nowhere else:
  // the query above selects only `status: 'completed'` judgments, so such a run
  // arrives with an EMPTY `modelJudgments` array, contributes no row below, and
  // is therefore invisible to `groundTruthReadings` — which can only report a
  // missing verdict for a row it was actually handed.
  //
  // Getting this wrong is not cosmetic. The first production calibration
  // (2026-08-31) reported `missingVerdicts 0` while FOUR of thirty items had
  // dead-lettered, directly under an accuracy line whose own denominator said
  // 26. A reader is entitled to trust the field named "how many are missing"
  // over arithmetic they have to do themselves, and that reading was wrong.
  let unjudgedItems = 0;

  for (const run of runs) {
    // A calibration EvaluationRun without a goldenItem cannot be scored
    // against anything. The @@unique([calibrationRunId, goldenItemId]) makes
    // the pair the identity of the row, so this is a shape nothing writes;
    // skipping beats crashing a whole calibration over it, and it cannot go
    // unnoticed because the run contributes to no count.
    if (run.goldenItem === null) continue;
    if (run.modelJudgments.length === 0) {
      unjudgedItems += 1;
      continue;
    }
    // One judgment per run in phase 1 (pairOrder 'AB' only). If phase 2's BA
    // sweep lands and this is still flattening both orders into one pile,
    // groundTruthReadings throws on the duplicate (item, rater) rather than
    // letting Cohen quietly keep the first and discard the second.
    for (const judgment of run.modelJudgments) {
      rows.push({
        itemId: run.goldenItem.id,
        expected: run.goldenItem.expected,
        raterId: judgment.judgeModelVersionId ?? 'model',
        verdict: judgment.verdict,
        pairOrder: judgment.pairOrder,
      });
      context.push({ runId: run.id, itemIndex: run.goldenItem.index });
    }
  }

  const projection = groundTruthReadings(rows);

  const verdictDistribution: Record<string, number> = { A: 0, B: 0, tie: 0 };
  const confusion: Record<string, Record<string, number>> = {};
  for (const expected of PREFERENCES) {
    confusion[expected] = {};
    for (const judged of PREFERENCES) confusion[expected][judged] = 0;
  }

  const disagreements: CalibrationDisagreement[] = [];
  let correctCount = 0;
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
    confusion[expected][actual] += 1;

    if (actual === expected) {
      correctCount += 1;
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

  const score: CalibrationScore = {
    calibrationRunId,
    accuracy,
    kappa: result.value,
    verdictCount,
    itemCount: projection.itemCount,
    // Both shapes of "this item produced no answer": a row whose verdict is
    // null (judged, but the judge said nothing usable) and a run with no
    // completed judgment at all (errored, dead-lettered, or still running).
    missingVerdicts: projection.missingVerdicts + unjudgedItems,
    correctCount,
    verdictDistribution,
    confusion,
    disagreements,
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
