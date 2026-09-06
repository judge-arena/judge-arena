/**
 * ─── A2.1: the constant-verdict floor, per denominator ──────────────────────
 *
 * WHAT A STAMP SCORES. A judge that answers the same preference on every item
 * is right exactly as often as that preference appears in the answer key. On
 * the target set (17 'A>B' / 13 'B>A') that is 0.5667 — a number that reads
 * as "a bit better than a coin flip" and is nothing of the kind. Until
 * v2l that figure lived only in prose (score.ts's header, the runbook,
 * the spec), and granite4.1:3b's 0.5000 was read as a faint signal when it
 * was WORSE than not thinking. Nothing on screen said so because nothing
 * computed the floor. This module does, and score.ts stores it beside the
 * accuracy it floors.
 *
 * THE FLOOR MOVES WITH THE DENOMINATOR. A partial run's scored subset has its
 * own key marginal: run 9 scored 25 of 30 items, keyed 14/11, so its floor is
 * 0.5600 rather than 0.5667. Comparing a partial run against the whole set's
 * floor flatters it — which is why the input here is the key counted OVER THE
 * SCORED ITEMS ONLY (score.ts accumulates it past the same null-verdict gate
 * as `verdictCount`), and why a leaderboard cannot compute this once and cache
 * it. Only the subset floor is ever reported; two floors on one line get the
 * wrong one quoted.
 *
 * TIES AMONG TOP CLASSES ARE REPORTED, NEVER BROKEN. A 12/12/6 key has two
 * best stamps at the same hit rate; naming only the first would print the
 * right number under a misleading label. `preferences` carries every class
 * that achieves the maximum, in PREFERENCES order. 'tie' is a class like the
 * other two: the import path rejects it, but PATCH /api/golden-sets/[id]/items
 * writes `expected` with no vocabulary check and readings.ts accepts it, so a
 * tie-keyed set is reachable and a 'tie' verdict against it is a hit.
 *
 * PURE, AND IMPORT-FREE BY DESIGN. Only the preference vocabulary comes from
 * readings.ts (whose sole import is type-only), so this runs in the DB-free
 * unit suite with no mock and drags nothing into any coverage denominator.
 */

import { PREFERENCES, type Preference } from '@/lib/calibration/readings';

export type ConstantBaseline = {
  /** Hit rate of the best constant verdict over the SCORED subset:
   *  max(keyCounts) / denominator. */
  accuracy: number;
  /** The constant(s) that achieve it, in PREFERENCES order. Length > 1 when the
   *  key's top classes tie; the accuracy is the same number either way. */
  preferences: Preference[];
  /** The answer key's marginal over the scored subset, fully populated over
   *  PREFERENCES (zeros included) — a copy, not the caller's object. */
  keyCounts: Record<Preference, number>;
  /** Sum of keyCounts. Must equal `CalibrationScore.verdictCount`. */
  denominator: number;
};

/**
 * The floor for a key with these class counts, or `null` when nothing has
 * been scored (mirrors `accuracy`'s null-not-0 rule in score.ts: 0 would read
 * as "the stamp was never right", which is a measurement, and "nothing has
 * been scored" is not).
 *
 * Throws on a negative, fractional, NaN or missing count. A count is never
 * any of those; a defensive clamp would turn a caller bug into a plausible
 * number.
 */
export function constantVerdictBaseline(
  keyCounts: Readonly<Record<Preference, number>>
): ConstantBaseline | null {
  let denominator = 0;
  let best = 0;
  for (const preference of PREFERENCES) {
    const n = keyCounts[preference];
    if (!Number.isInteger(n) || n < 0) {
      throw new RangeError(
        `constantVerdictBaseline: keyCounts[${JSON.stringify(preference)}] is ${String(n)}; ` +
          `a class count is a non-negative integer`
      );
    }
    denominator += n;
    if (n > best) best = n;
  }
  if (denominator === 0) return null;

  return {
    accuracy: best / denominator,
    preferences: PREFERENCES.filter((preference) => keyCounts[preference] === best),
    keyCounts: Object.fromEntries(
      PREFERENCES.map((preference) => [preference, keyCounts[preference]])
    ) as Record<Preference, number>,
    denominator,
  };
}

/** Four decimals, the same rendering as `fmt` in scripts/calibration/run.ts.
 *  Local and null-free: the guard in the formatter has already excluded null,
 *  and run.ts keeps its own `fmt` for the ACCURACY and kappa lines, which do
 *  print `n/a`. */
const fmt4 = (n: number): string => n.toFixed(4);

/**
 * The lines the CLI prints for the floor: the `constant` line, and the `⚠`
 * when the judge is AT OR BELOW it. `[]` when nothing was scored — a line
 * reading `n/a` would suggest a floor exists and could not be rendered.
 *
 * WHY THE RENDERING IS HERE AND NOT IN THE SCRIPT. `scripts/calibration/**` is
 * outside every coverage include (vitest.config.ts:37) and has no test harness,
 * so a template literal built there is permanently unguarded — and the
 * load-bearing part is the `<=`: relaxing it to `<` silences the warning on
 * exactly the judge it exists for, the one that lands ON the floor by stamping.
 * Here `tests/lib/calibration-baseline.test.ts` pins it. Same reasoning, and
 * the same shape, as `describeSamplingSnapshot` in sampling-drift.ts (v2k).
 *
 * The parameter is a structural literal rather than `Pick<CalibrationScore,
 * …>` because score.ts imports THIS module; a type import back would close an
 * import cycle. A whole `CalibrationScore` satisfies it, which is how run.ts
 * calls it.
 *
 * The guard names all three fields even though, coming from `score.ts`, they
 * are null TOGETHER (`accuracy` is null iff verdictCount is 0; the floor is
 * null iff its denominator is, and `keyCounts[expected] += 1` sits past the
 * same gate as `verdictCount += 1`). It names them because the parameter is
 * structural, so TypeScript narrows each field independently and the two
 * arithmetic uses below would otherwise be `number | null`. That is a type
 * requirement, not a defensive clamp — and it does mean the `||` chain
 * short-circuits on the one null fixture, so operands two and three never
 * reach their TRUE outcome in any test. Do not claim "100% branches" for this
 * file from that shape; read the printed coverage row (Task 3 Step 13).
 */
export function formatConstantBaselineLines(score: {
  accuracy: number | null;
  constantBaseline: ConstantBaseline | null;
  marginOverConstant: number | null;
}): string[] {
  const floor = score.constantBaseline;
  if (floor === null || score.accuracy === null || score.marginOverConstant === null) return [];

  // `preferences` lists EVERY top class when the key ties; the count printed is
  // the first one's, and they are equal by construction (that is what a tie
  // among top classes means), so the pair stays honest under either label.
  const stamped = floor.keyCounts[floor.preferences[0]];
  const sign = score.marginOverConstant >= 0 ? '+' : '';
  const lines = [
    `  constant   ${fmt4(floor.accuracy)}   (a judge stamping '${floor.preferences.join('/')}' on every SCORED item: ` +
      `${stamped}/${floor.denominator})   margin ${sign}${fmt4(score.marginOverConstant)}`,
  ];
  if (score.accuracy <= floor.accuracy) {
    lines.push(
      '  ⚠ accuracy is at or below the constant floor — on this subset the judge is not distinguishable from a stamp.'
    );
  }
  return lines;
}

/**
 * The COVERAGE block: how often the judge answered, how often it was right when
 * it did, and the floor that second number has to clear.
 *
 * WHY THESE TWO NUMBERS AND NOT ONE. The golden key is FORCED CHOICE — 620
 * items, 336 'A>B' / 284 'B>A', no ties — so a 'tie' verdict can never be
 * correct and `rawAgreement` is the PRODUCT of two independent quantities:
 * coverage, and accuracy given coverage. Measured 2026-09-06 on that set,
 * lfm2.5:8b and lfm2.5-thinking:1.2b differ 5.3x on rawAgreement (0.0929 vs
 * 0.4887) — which reads as "broken vs mediocre" — and are statistically
 * indistinguishable on selective accuracy (0.5437 vs 0.5363). Same
 * discriminative ability; they differ only in how they express uncertainty.
 *
 * THE FLOOR HERE IS THE ONE OVER THE COMMITTED SUBSET, AND THAT IS THE WHOLE
 * POINT. `formatConstantBaselineLines` above prints the floor over every SCORED
 * item; this one prints the floor over the items the judge COMMITTED to.
 * Quoting the first beside selective accuracy is precisely the error v2l exists
 * to prevent, one level down, and on production data it FLIPS THE SIGN of the
 * margin for two of four judges (lfm2.5-thinking: +0.0071 over its committed
 * floor of 0.5292, −0.0056 against the full subset's 0.5419). The two can even
 * name different top classes, which is what the unit test pins.
 *
 * NULL-NOT-ZERO, and the two nulls mean different things. `coverage` is null
 * only when nothing was scored; coverage 0.0000 over a non-zero denominator IS
 * a measurement — the judge replied and committed to none of them.
 * `selectiveAccuracy` is null whenever coverage is 0, and the line says
 * UNDEFINED rather than printing 0.0000, which would read as "never right".
 *
 * A TIE-CONTAINING KEY GETS A CAVEAT RATHER THAN A SUPPRESSION. "A tie is an
 * abstention" is a property of a forced-choice key. Both live golden sets are
 * tie-free, but PATCH /api/golden-sets/[id]/items writes `expected` with no
 * vocabulary check on an unfrozen set, so the shape is reachable — and when it
 * is, these two lines are still arithmetically correct and no longer mean what
 * their labels say. The `ⓘ` says so on the same screen rather than leaving the
 * reader to work it out.
 *
 * The parameter is a structural literal rather than `Pick<CalibrationScore, …>`
 * for the same reason `formatConstantBaselineLines`'s is: score.ts imports THIS
 * module, and a type import back would close an import cycle. A whole
 * `CalibrationScore` satisfies it, which is how run.ts calls it. TypeScript
 * therefore narrows each field independently, which is why the guard below
 * names all three of the selective fields even though score.ts makes them null
 * together. The same structural requirement produces one arm that NO caller can
 * take: `coverage` is null only when `verdictCount` is 0, which the first guard
 * has already returned on, so the `'n/a'` in the coverage line is unreachable
 * from `score.ts` and exists purely to narrow `number | null` to `number`. That
 * is exactly the shape `formatConstantBaselineLines` documents above about its
 * `||` chain, and it carries the same instruction: **do not claim "100%
 * branches" for this file; read the printed coverage row** (Task 3 Step 15).
 */
export function formatSelectiveAccuracyLines(score: {
  verdictCount: number;
  committedCount: number;
  abstainedCount: number;
  committedCorrectCount: number;
  coverage: number | null;
  selectiveAccuracy: number | null;
  selectiveBaseline: ConstantBaseline | null;
  selectiveMarginOverConstant: number | null;
  constantBaseline: ConstantBaseline | null;
}): string[] {
  // Nothing scored: no lines at all. A line reading `n/a` would suggest a
  // number exists and could not be rendered — the same contract as above.
  if (score.verdictCount === 0) return [];

  const lines = [
    `  coverage   ${score.coverage === null ? 'n/a' : fmt4(score.coverage)}   ` +
      `(${score.committedCount}/${score.verdictCount} scored items the judge COMMITTED on; ` +
      `${score.abstainedCount} abstained with 'tie')`,
  ];

  if (
    score.selectiveAccuracy === null ||
    score.selectiveBaseline === null ||
    score.selectiveMarginOverConstant === null
  ) {
    lines.push(
      `  ⚠ the judge committed on NOTHING (0/${score.verdictCount}) — selective accuracy is UNDEFINED, not 0 and not 1.`
    );
  } else {
    const floor = score.selectiveBaseline;
    // `preferences` lists EVERY top class when the committed key ties; the count
    // printed is the first one's, and they are equal by construction, so the
    // pair stays honest under either label — same as above.
    const stamped = floor.keyCounts[floor.preferences[0]];
    const sign = score.selectiveMarginOverConstant >= 0 ? '+' : '';
    lines.push(
      `  selective  ${fmt4(score.selectiveAccuracy)}   ` +
        `(${score.committedCorrectCount}/${score.committedCount} right where it COMMITTED)   ` +
        `floor ${fmt4(floor.accuracy)} ('${floor.preferences.join('/')}': ${stamped}/${floor.denominator})   ` +
        `margin ${sign}${fmt4(score.selectiveMarginOverConstant)}`
    );
    // `<=`, not `<`: the judge this warning exists for is the one that lands ON
    // the floor by stamping whenever it does commit.
    if (score.selectiveAccuracy <= floor.accuracy) {
      lines.push(
        '  ⚠ selective accuracy is at or below the floor OVER THE COMMITTED SUBSET — where it answers, the judge is not distinguishable from a stamp.'
      );
    }
  }

  if (score.constantBaseline !== null && score.constantBaseline.keyCounts.tie > 0) {
    lines.push(
      `  ⓘ this answer key CONTAINS ties (${score.constantBaseline.keyCounts.tie} of ${score.constantBaseline.denominator} scored items), ` +
        "so a 'tie' verdict is a real ANSWER here, " +
        'not an abstention — the two lines above do not measure abstention on this set.'
    );
  }
  return lines;
}

/** The no-verdict rate on its own line, under its own label, deliberately NOT
 *  inside the coverage block. Coverage is what the JUDGE did; this is what the
 *  FLEET did. Rendering them as one block is the exact conflation M6 rejects —
 *  a reader who sees them adjacent under one heading will read a truncation as
 *  an abstention. Returns [] when the rate is null: a NULL is not a 0.0000.
 *
 *  THE GUARD IS ON THE RATE, NOT ON `dispatchedItemCount`. The two coincide
 *  coming from score.ts (the rate is null exactly when nothing was dispatched),
 *  but the parameter is a structural literal for the same reason the two
 *  formatters above take one — score.ts imports THIS module, so a type import
 *  back would close an import cycle — and TypeScript narrows each field
 *  independently. Keying the empty return on the denominator would render
 *  `null` or `NaN` on any other shape, which is precisely what "a NULL is not a
 *  0.0000" forbids.
 *
 *  A RATE OF 0 IS PRINTED, not suppressed. "Nothing was lost" is a measurement,
 *  and a silent line does not say the denominator was checked. */
export function formatNoVerdictRateLine(score: {
  noVerdictRate: number | null;
  missingVerdicts: number;
  dispatchedItemCount: number;
}): string[] {
  if (score.noVerdictRate === null) return [];
  return [
    `  no verdict ${fmt4(score.noVerdictRate)}   ` +
      `${score.missingVerdicts} of ${score.dispatchedItemCount} asked items produced none — ` +
      'FLEET property (truncation/dead request), NOT abstention',
  ];
}
