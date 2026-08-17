/**
 * A1 — test-retest eligibility.
 *
 * Test-retest is the ONE reliability signal that produces a number while a
 * single account exists: every inter-annotator statistic needs two annotators
 * and returns an insufficiency instead (see src/lib/agreement.ts). So this
 * gate is not a nicety — it is the entire measurable reliability surface at
 * launch, and getting the boundary wrong silently changes what the number
 * means.
 *
 * ── WHY INTERVENING ITEMS RATHER THAN ELAPSED TIME ─────────────────────────
 * A time gap alone fails the burst case. An annotator who labels a whole set
 * in one sitting still remembers the striking items a week later, so "re-read
 * anything older than 7 days" hands them back an item they can recall rather
 * than re-judge, and the resulting consistency number measures memory. K OTHER
 * items in between is what actually displaces the specific item from working
 * memory.
 *
 * ── ACCEPTED LIMITATION, NOT A BUG ─────────────────────────────────────────
 * A set with fewer than K items can never produce a retest at all: there are
 * not enough other items to put in between. The queue must therefore SAY so
 * — `retest-not-yet-eligible` with a shortfall — rather than appear empty,
 * because "nothing to do" and "nothing eligible yet" are different states and
 * only one of them means the annotator is finished.
 */

export type RetestEligibility = { eligible: true } | { eligible: false; labelsUntilEligible: number };

export function retestEligibility(args: {
  /** K, from `GoldenSet.retestIntervalItems` — the protocol IN FORCE for this set. */
  intervalItems: number;
  /** How many OTHER items this annotator has labelled since their round-1 reading. */
  labelledSinceRound1: number;
  hasRound1: boolean;
  hasRound2: boolean;
}): RetestEligibility {
  // The two STRUCTURAL blockers. Both report a shortfall of 0, and a shortfall
  // of 0 that is still not eligible is deliberate: the blocker is not a count,
  // so no amount of further labelling changes the answer. There is nothing to
  // re-read without a first reading, and nothing left to measure once a second
  // one exists — a third round is not part of this protocol.
  if (!args.hasRound1 || args.hasRound2) return { eligible: false, labelsUntilEligible: 0 };

  const shortfall = args.intervalItems - args.labelledSinceRound1;
  if (shortfall <= 0) return { eligible: true };
  return { eligible: false, labelsUntilEligible: shortfall };
}
