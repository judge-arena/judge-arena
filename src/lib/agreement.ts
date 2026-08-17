/**
 * A1 — inter-annotator agreement, and the method that produced it.
 *
 * PURE ON PURPOSE. No Prisma import, no clock, no environment. That is what
 * lets it run in the DB-free unit suite, and `src/lib/**` is measured by both
 * coverage configs while `src/app/api/**` is measured by neither — so every
 * rule that can be wrong lives here rather than in a route.
 *
 * The function returns a number AND the method that produced it, because
 * "reports an agreement number with a stated method" is an exit-gate clause
 * and prose in a UI cannot satisfy it. `itemCount` in particular is the
 * OVERLAP — items with at least two readings — never the set size. An
 * agreement number over three shared items in a 620-item set is not a floor,
 * it is an anecdote, and reporting what it was computed over is the only
 * thing that makes that visible from the number itself.
 *
 * ── FOUR RECORDED LIMITATIONS, none papered over ───────────────────────────
 *
 * 1. FLEISS HAS NO STANDARD WEIGHTED FORM. With more than two annotators the
 *    number is unweighted and is REPORTED as `weighting: 'none'`, whatever was
 *    asked for. Silently applying weights would make it incomparable to a
 *    weighted two-annotator figure while looking identical. Krippendorff's
 *    alpha is the tool that handles >2 raters AND ordinal data; the design
 *    named Fleiss, so this follows it and records the gap.
 *
 * 2. `overallScore` HAS NO DECLARED SCALE ANYWHERE in the schema. Kappa needs
 *    discrete categories, so the category set is the sorted union of OBSERVED
 *    values, returned in `categories` so a reader knows what the number was
 *    computed over. If one annotator uses {1,2,3} and another {1,5}, the
 *    derived scale is their union. A declared scale is a later schema
 *    question, deliberately not invented here.
 *
 * 3. PREFERENCES ARE UNWEIGHTED. Calling 'A>B'-vs-'tie' closer than
 *    'A>B'-vs-'B>A' is a claim about the domain, not a given. Non-numeric
 *    categories therefore carry no distance, and a requested weighting is
 *    downgraded to 'none' and SAID SO — the same honesty rule as Fleiss.
 *
 * 4. A SINGLE OBSERVED CATEGORY LEAVES NO ROOM FOR CHANCE CORRECTION. If every
 *    reading is '4', then pe = 1 and the textbook quotient is 0/0. This
 *    reports 1 — complete agreement — rather than NaN. Not cosmetic: NaN
 *    serialises to `null` through JSON, which is exactly the wire shape of the
 *    insufficiency case below, so a NaN would reach the UI as
 *    "not measurable" when the truth is "everyone agreed".
 *
 * ── AND ONE THING THAT IS NOT A LIMITATION ─────────────────────────────────
 *
 * Fewer than two annotators returns `value: null` with a `reason`, never 0.
 * 0 reads as TOTAL DISAGREEMENT, which is the opposite of "not measurable"
 * and is precisely the confidently-wrong number this phase exists to prevent.
 * THIS IS THE NORMAL CASE AT LAUNCH — one account means one annotator — so
 * the caller must render it as an explanation rather than as a broken number.
 */

export type AgreementMethod = {
  statistic: 'cohen' | 'fleiss';
  weighting: 'linear' | 'quadratic' | 'none';
  annotatorCount: number;
  /** The OVERLAP: items with >= 2 readings. Never the set size. */
  itemCount: number;
  /** The ordered category set the number was computed over. */
  categories: string[];
};

export type AgreementResult =
  | ({ value: number; reason: null } & AgreementMethod)
  | ({ value: null; reason: 'insufficient-annotators' | 'insufficient-overlap' } & AgreementMethod);

/** One annotator's reading of one item. `category` is a STRING for both
 *  protocols — a score becomes `String(score)`, a preference already is one.
 *  That is what lets one implementation serve scores and preferences without
 *  a second code path, and why `categories` is `string[]`. */
export type Reading = { itemId: string; raterId: string; category: string };

export type Weighting = 'linear' | 'quadratic' | 'none';

/**
 * Sorted union of observed categories — NUMERICALLY when every one parses as
 * a number, lexicographically otherwise. The numeric branch is what makes
 * value-distance weighting possible at all; the lexicographic branch is what
 * keeps preferences ordered stably.
 */
function orderedCategories(readings: Reading[]): { categories: string[]; numeric: boolean } {
  const seen = Array.from(new Set(readings.map((r) => r.category)));
  const numeric = seen.length > 0 && seen.every((c) => c.trim() !== '' && Number.isFinite(Number(c)));
  const categories = numeric
    ? seen.sort((a, b) => Number(a) - Number(b))
    : seen.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { categories, numeric };
}

/**
 * The weight matrix, indexed by position in `categories`.
 *
 * Distances are computed on the PARSED VALUES, not on rank position: 1 vs 5
 * is four steps, not three ranks. On an unevenly spaced observed set — {1,2,5}
 * is the canonical one — those two readings disagree, and the value reading is
 * the one that matches what a score means.
 *
 * `range` is `max - min` of the category VALUES. When it is 0 there is exactly
 * one category, every pair is an exact match, and every weight is 1.
 */
function weightMatrix(categories: string[], weighting: Weighting, numeric: boolean): number[][] {
  const n = categories.length;
  const exact = () =>
    Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));

  if (weighting === 'none' || !numeric) return exact();

  const values = categories.map(Number);
  const range = Math.max(...values) - Math.min(...values);
  if (range === 0) return Array.from({ length: n }, () => Array.from({ length: n }, () => 1));

  return Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => {
      const d = Math.abs(values[i] - values[j]) / range;
      return weighting === 'linear' ? 1 - d : 1 - d * d;
    })
  );
}

/**
 * Complete agreement is 1 even when chance correction has nothing to work
 * with. See limitation 4 in the module doc: `(po - pe) / (1 - pe)` is 0/0
 * whenever pe reaches 1, and pe reaches 1 only when a single category was
 * ever used — in which case po is 1 too, and the honest answer is 1.
 */
function chanceCorrect(po: number, pe: number): number {
  if (1 - pe === 0) return 1;
  return (po - pe) / (1 - pe);
}

/** Weighted Cohen's kappa over exactly two raters. */
function cohen(
  byItem: Map<string, Reading[]>,
  categories: string[],
  weights: number[][],
  raters: string[]
): number {
  const index = new Map(categories.map((c, i) => [c, i]));
  const [ra, rb] = raters;

  // The confusion matrix as proportions, plus each rater's marginals.
  const n = byItem.size;
  const observed: number[][] = Array.from({ length: categories.length }, () =>
    Array.from({ length: categories.length }, () => 0)
  );
  const marginalA = Array.from({ length: categories.length }, () => 0);
  const marginalB = Array.from({ length: categories.length }, () => 0);

  for (const readings of byItem.values()) {
    // FIRST reading per rater, in input order. The partial unique index on
    // (goldenItemId, annotatorId, round) permits one live label per rater per
    // item PER ROUND, not per item — so a rater who has done a blind re-read
    // has two. Choosing between them is not this module's call: INTER-rater
    // agreement and INTRA-rater (test-retest) reliability are different
    // measurements, and mixing a rater's two rounds into one confusion matrix
    // would silently answer neither. Callers pass one round's readings; the
    // route that does so says which.
    const a = readings.find((r) => r.raterId === ra)!;
    const b = readings.find((r) => r.raterId === rb)!;
    const i = index.get(a.category)!;
    const j = index.get(b.category)!;
    observed[i][j] += 1 / n;
    marginalA[i] += 1 / n;
    marginalB[j] += 1 / n;
  }

  let po = 0;
  let pe = 0;
  for (let i = 0; i < categories.length; i++) {
    for (let j = 0; j < categories.length; j++) {
      po += weights[i][j] * observed[i][j];
      pe += weights[i][j] * marginalA[i] * marginalB[j];
    }
  }
  return chanceCorrect(po, pe);
}

/**
 * Fleiss's kappa over more than two raters. UNWEIGHTED — see limitation 1.
 *
 * Items whose rater count differs are handled per item (each item's own `m`),
 * which is the standard treatment for the unbalanced case and is the normal
 * shape here: assignment is per (item, annotator), so a partially-completed
 * overlap is expected rather than exceptional.
 */
function fleiss(byItem: Map<string, Reading[]>, categories: string[]): number {
  const index = new Map(categories.map((c, i) => [c, i]));
  const items = Array.from(byItem.values());

  let agreementSum = 0;
  const categoryTotals = Array.from({ length: categories.length }, () => 0);
  let ratingTotal = 0;

  for (const readings of items) {
    const m = readings.length;
    const counts = Array.from({ length: categories.length }, () => 0);
    for (const r of readings) counts[index.get(r.category)!] += 1;

    // P_i = (SUM n_ij^2 - m) / (m(m - 1)). Guarded because an item with a
    // single reading contributes a 0/0; such items are filtered out before
    // this is called, so the guard is a belt rather than a branch anyone hits.
    if (m < 2) continue;
    const sumSquares = counts.reduce((acc, c) => acc + c * c, 0);
    agreementSum += (sumSquares - m) / (m * (m - 1));

    for (let c = 0; c < counts.length; c++) categoryTotals[c] += counts[c];
    ratingTotal += m;
  }

  const pBar = agreementSum / items.length;
  const pe = categoryTotals.reduce((acc, total) => {
    const p = total / ratingTotal;
    return acc + p * p;
  }, 0);
  return chanceCorrect(pBar, pe);
}

/**
 * Inter-annotator agreement over a flat list of readings.
 *
 * Cohen's for exactly two annotators, Fleiss's for more. `opts.weighting`
 * defaults to 'linear' for numeric categories and is forced to 'none' for
 * non-numeric ones and for Fleiss — in every case the value actually USED is
 * what comes back in `weighting`.
 */
export function agreement(readings: Reading[], opts?: { weighting?: Weighting }): AgreementResult {
  const { categories, numeric } = orderedCategories(readings);
  const annotatorCount = new Set(readings.map((r) => r.raterId)).size;

  // THE OVERLAP: items read by at least two DISTINCT annotators. Not "items
  // with at least two readings" — those are different sets, and the
  // difference is not academic. One annotator's blind re-read gives an item
  // two readings from one person; counting it as overlap would both inflate
  // the denominator the UI shows and, for Cohen, leave the second rater
  // absent from an item the matrix builder assumes both rated.
  const byItem = new Map<string, Reading[]>();
  for (const r of readings) {
    const bucket = byItem.get(r.itemId);
    if (bucket) bucket.push(r);
    else byItem.set(r.itemId, [r]);
  }
  for (const [itemId, bucket] of byItem) {
    if (new Set(bucket.map((r) => r.raterId)).size < 2) byItem.delete(itemId);
  }

  const statistic: 'cohen' | 'fleiss' = annotatorCount > 2 ? 'fleiss' : 'cohen';
  const requested = opts?.weighting ?? (numeric ? 'linear' : 'none');
  const weighting: Weighting = statistic === 'fleiss' || !numeric ? 'none' : requested;

  const method: AgreementMethod = {
    statistic,
    weighting,
    annotatorCount,
    itemCount: byItem.size,
    categories,
  };

  // Both insufficiency cases still populate every method field they can — a
  // null beside an empty method block reads as a crash rather than as an
  // explanation.
  if (annotatorCount < 2) return { value: null, reason: 'insufficient-annotators', ...method };
  if (byItem.size === 0) return { value: null, reason: 'insufficient-overlap', ...method };

  if (statistic === 'fleiss') {
    return { value: fleiss(byItem, categories), reason: null, ...method };
  }

  const weights = weightMatrix(categories, weighting, numeric);
  // Sorted so the pairing is stable regardless of the order readings arrived
  // in; Cohen's kappa is symmetric, but a stable assignment keeps the
  // confusion matrix reproducible for anything that later inspects it.
  const raters = Array.from(new Set(readings.map((r) => r.raterId))).sort();
  return { value: cohen(byItem, categories, weights, raters), reason: null, ...method };
}
