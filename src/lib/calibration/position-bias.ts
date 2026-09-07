/**
 * ─── Position bias: how much of a verdict is the slot, not the content ──────
 *
 * TWO numbers, because one cannot separate the judges in this corpus.
 *
 *   positionBias  = |(verdicts naming slot A, both orders) / 2n − 0.5|
 *   orderFlipRate = fraction of paired items whose PREFERENCE changes on swap
 *
 * ── positionBias IS COMPUTED ON THE RAW VERDICT LETTER ──────────────────────
 *
 * Before `preferenceFromVerdict`, and that is the whole point. A verdict letter
 * names a SLOT ON THE SCREEN. Pooling the letters over both orders measures how
 * often the judge picked the first slot, which is exactly position bias, and it
 * is INDEPENDENT of the answer key's class balance: a correct judge names slot A
 * on the 'A>B' items in AB and on the 'B>A' items in BA, so its pooled rate is
 * 0.5 however lopsided the key.
 *
 * Computing it from PREFERENCES instead yields |p_AB − p_BA| / 2 — the
 * DIFFERENCE of the slot rates, which is a content-discrimination statistic
 * whose null is |keyBalance − 0.5|, and which is ANTICORRELATED with position
 * bias: a pure first-slot stamper scores 0.0 and a perfect judge scores 0.042
 * on this corpus. Every value in range, matrix square, no symptom. An earlier
 * draft of the design specified exactly that; the test file's third archetype
 * is the arm that catches it.
 *
 * ── WHY BOTH ────────────────────────────────────────────────────────────────
 *
 *   always first slot    0.5 / 1.0     symmetric flipper   0.0 / 1.0
 *   perfect content      0.0 / 0.0     uniformly random    0.0 / 0.5
 *
 * The symmetric flipper is entirely position-driven and `positionBias` alone
 * certifies it clean. `orderFlipRate` alone cannot say WHICH slot, and its
 * no-information point is 0.5, not 0 — any order-independent judge flips at
 * least half the time, so do not read 0.4 as "good".
 *
 * ── TIES ────────────────────────────────────────────────────────────────────
 *
 * 'tie' is order-invariant by construction (readings.ts:103) and is this
 * product's sanctioned no-answer channel, so an item that tied in EITHER order
 * is excluded from both estimators — and the exclusion is COUNTED. Without
 * `tieExcludedCount` beside them, an abstaining judge scores a flawless 0.0
 * position bias on n = 3.
 */
import { isPairOrder } from '@/lib/pair-order';

export type PairedVerdictRow = {
  itemId: string;
  /** `ModelJudgment.verdict`, RAW — 'A' | 'B' | 'tie' | null. */
  verdict: string | null;
  /** `ModelJudgment.pairOrder`. */
  pairOrder: string | null;
};

export type Interval = { low: number; high: number };

export type PositionBiasResult = {
  positionBias: number | null;
  orderFlipRate: number | null;
  /** The denominator BOTH estimators share. Never render either without it. */
  pairedDecisiveCount: number;
  /** Items that paired but tied in at least one order. */
  tieExcludedCount: number;
  /** Items that did not produce a usable verdict in both orders. */
  unpairedCount: number;
  positionBiasInterval: Interval | null;
  orderFlipRateInterval: Interval | null;
};

const Z = 1.959963984540054;

/** Wilson score interval. Correct for `orderFlipRate`: one Bernoulli per item. */
function wilson(successes: number, n: number): Interval {
  const p = successes / n;
  const d = 1 + (Z * Z) / n;
  const centre = p + (Z * Z) / (2 * n);
  const spread = Z * Math.sqrt((p * (1 - p)) / n + (Z * Z) / (4 * n * n));
  return { low: Math.max(0, (centre - spread) / d), high: Math.min(1, (centre + spread) / d) };
}

export function positionBiasFromPairs(rows: PairedVerdictRow[]): PositionBiasResult {
  // `AB`/`BA` are `string | null | undefined`: `undefined` means that order's
  // row never arrived at all; `null` means the row arrived but carried no
  // usable verdict (`ModelJudgment.verdict IS NULL`, e.g. an errored
  // judgment). Both are "not a usable verdict in both orders" and both must
  // route to `unpairedCount` below — neither may vanish from every counter,
  // which is what happened before this was a distinct case from "no row".
  //
  // A duplicate (itemId, pairOrder) row is last-write-wins here. That is
  // safe for the only wired caller: `ModelJudgment` is
  // `@@unique([runId, judgeModelVersionId, pairOrder])` (schema.prisma:568),
  // `EvaluationRun.runId` is `@@unique([calibrationRunId, goldenItemId])`
  // (schema.prisma:432), and a `CalibrationRun` carries a single
  // `judgeModelVersionId` (schema.prisma:939) — so within one calibration
  // run, (goldenItemId, pairOrder) is unique by construction and duplicates
  // can only arise from a caller mixing rows across runs, which is not this
  // module's contract to police.
  const byItem = new Map<string, { AB?: string | null; BA?: string | null }>();
  for (const row of rows) {
    if (!isPairOrder(row.pairOrder)) continue;
    const entry = byItem.get(row.itemId) ?? {};
    entry[row.pairOrder] = row.verdict;
    byItem.set(row.itemId, entry);
  }

  let unpairedCount = 0;
  let tieExcludedCount = 0;
  let flips = 0;
  /** Per-item count of verdicts naming slot A, in {0, 1, 2}. */
  const slotACounts: number[] = [];

  for (const { AB, BA } of byItem.values()) {
    if (AB === undefined || BA === undefined || AB === null || BA === null) {
      unpairedCount += 1;
      continue;
    }
    if (AB === 'tie' || BA === 'tie') {
      tieExcludedCount += 1;
      continue;
    }
    slotACounts.push((AB === 'A' ? 1 : 0) + (BA === 'A' ? 1 : 0));
    // The preference flips exactly when the SAME slot is named twice: under
    // BA, verdict 'A' means 'B>A'. So AB === BA <=> the judge followed the
    // slot rather than the candidate.
    if (AB === BA) flips += 1;
  }

  const n = slotACounts.length;
  if (n === 0) {
    return {
      positionBias: null, orderFlipRate: null, pairedDecisiveCount: 0,
      tieExcludedCount, unpairedCount,
      positionBiasInterval: null, orderFlipRateInterval: null,
    };
  }

  const slotATotal = slotACounts.reduce((a, b) => a + b, 0);
  const pA = slotATotal / (2 * n);
  const positionBias = Math.abs(pA - 0.5);
  const orderFlipRate = flips / n;

  // PAIRED interval, not Wilson. Each item contributes TWO clustered draws and
  // |·| folds the scale at 0.5, so a Wilson on pA shifted by 0.5 can exclude
  // its own point estimate. The variance is taken BETWEEN items, over the
  // per-item counts in {0,1,2}. This reduces to the closed form
  // 1.96*sqrt(f/4n) in the symmetric case, which is where the design's
  // resolution table comes from.
  //
  // At n = 1 the between-item variance is not estimable — there is only one
  // item to vary between — so the interval is `null` rather than collapsed
  // to `[positionBias, positionBias]`. A point interval would assert zero
  // uncertainty from a single observation: the same class of lie as
  // returning 0.0 for "no data", which this module already refuses to do.
  // The point estimate itself stays non-null at n = 1; only the interval
  // around it is unknowable.
  let positionBiasInterval: Interval | null = null;
  if (n >= 2) {
    const mean = slotATotal / n;
    const variance = slotACounts.reduce((acc, c) => acc + (c - mean) * (c - mean), 0) / (n - 1);
    const halfWidth = (Z * Math.sqrt(variance / n)) / 2;
    positionBiasInterval = {
      low: Math.max(0, positionBias - halfWidth),
      high: Math.min(0.5, positionBias + halfWidth),
    };
  }

  return {
    positionBias,
    orderFlipRate,
    pairedDecisiveCount: n,
    tieExcludedCount,
    unpairedCount,
    positionBiasInterval,
    orderFlipRateInterval: wilson(flips, n),
  };
}
