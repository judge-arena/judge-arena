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
