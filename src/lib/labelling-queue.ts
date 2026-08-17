/**
 * A1 — blinded next-item selection.
 *
 * ITS BLINDING IS LOAD-BEARING. Test-retest measures whether an annotator
 * reaches the same judgment twice WITHOUT knowing it is the same item. An
 * annotator who can tell a re-read from a first reading — from the response
 * shape, from a helpfully-included prior answer, or from position in a
 * predictable order — is no longer being measured; they are being asked
 * whether they remember. That is why the round travels back to the route in
 * `QueueResult` but must never reach the wire, and why order is a
 * deterministic hash rather than an index walk.
 *
 * THE ROUND IS DECIDED HERE, FROM DATA — never accepted from a request. If a
 * client could name it, blinding would be client-trusted and a stale tab
 * would defeat the signal. The submit route re-derives it the same way rather
 * than trusting even this module's own output round-tripped through a
 * browser.
 *
 * `Math.random()` is deliberately absent: it makes the queue untestable and
 * the order irreproducible, so a support question about "which item did it
 * offer" would be unanswerable.
 */

import { retestEligibility } from '@/lib/retest';

export type QueueCandidate = {
  itemId: string;
  /** Which reading this WOULD be. Decided by the caller from stored labels. */
  round: number;
  eligible: boolean;
  /** Only meaningful when `eligible` is false. */
  labelsUntilEligible?: number;
};

export type QueueResult =
  | { next: { itemId: string; round: number }; reason: null }
  | {
      next: null;
      reason: 'no-assignment' | 'set-complete' | 'retest-not-yet-eligible';
      labelsUntilRetest?: number;
    };

/**
 * What one annotator has already read on one item, reduced to the three facts
 * the protocol turns into a round. Built from LIVE labels only: a tombstoned
 * reading applied to text that no longer exists, so it neither counts as
 * having read the item nor blocks re-reading it.
 */
export type ItemReadingState = {
  itemId: string;
  hasRound1: boolean;
  hasRound2: boolean;
  /** OTHER items this annotator has labelled since their round-1 reading of THIS one. */
  labelledSinceRound1: number;
};

/**
 * WHICH READING WOULD THIS BE — 1, 2, or null when the item is finished.
 *
 * THE SINGLE SOURCE OF THE ROUND, and the reason it is exported rather than
 * inlined into the queue. The submit route must re-derive the round rather
 * than trust one that travelled through a browser, and "re-derives it exactly
 * as the queue did" is a claim a comment cannot keep true. Both callers go
 * through this function, so they cannot drift apart.
 */
export function nextRoundFor(state: { hasRound1: boolean; hasRound2: boolean }): 1 | 2 | null {
  if (!state.hasRound1) return 1;
  if (!state.hasRound2) return 2;
  return null;
}

/**
 * Turn per-item reading state into queue candidates.
 *
 * A finished item (both rounds read) is DROPPED rather than carried as
 * ineligible: it will never become eligible, and leaving it in would make it
 * a candidate for the `retest-not-yet-eligible` shortfall — reporting a wait
 * for something that is already done.
 */
export function buildCandidates(
  states: ItemReadingState[],
  intervalItems: number
): QueueCandidate[] {
  const out: QueueCandidate[] = [];
  for (const state of states) {
    const round = nextRoundFor(state);
    if (round === null) continue;
    if (round === 1) {
      out.push({ itemId: state.itemId, round: 1, eligible: true });
      continue;
    }
    const verdict = retestEligibility({
      intervalItems,
      labelledSinceRound1: state.labelledSinceRound1,
      hasRound1: state.hasRound1,
      hasRound2: state.hasRound2,
    });
    out.push({
      itemId: state.itemId,
      round: 2,
      eligible: verdict.eligible,
      ...(verdict.eligible ? {} : { labelsUntilEligible: verdict.labelsUntilEligible }),
    });
  }
  return out;
}

/** One live GoldenLabel of this annotator's, reduced to what the protocol reads. */
export type LabelRow = { goldenItemId: string; round: number; createdAt: Date };

/**
 * Reading state per item, from this annotator's LIVE labels across the WHOLE
 * SET.
 *
 * `labels` must be every live label this annotator holds in the set, not only
 * the ones on `itemIds`: the retest gate counts K OTHER items labelled since
 * the round-1 reading, and "other" ranges over the set rather than over the
 * current assignment. Passing a narrowed list understates the count and makes
 * a retest permanently unreachable.
 *
 * A TOMBSTONED label is not a reading. Its item's content has since changed,
 * so it neither counts as having read the item nor blocks re-reading it —
 * which is the same predicate the partial unique index uses, so the two can
 * never disagree about what "already labelled" means.
 */
export function deriveReadingStates(itemIds: string[], labels: LabelRow[]): ItemReadingState[] {
  const round1At = new Map<string, Date>();
  const round2 = new Set<string>();
  for (const label of labels) {
    if (label.round === 1) round1At.set(label.goldenItemId, label.createdAt);
    else round2.add(label.goldenItemId);
  }

  return itemIds.map((itemId) => {
    const first = round1At.get(itemId) ?? null;
    return {
      itemId,
      hasRound1: first !== null,
      hasRound2: round2.has(itemId),
      // DISTINCT items, not label count: labelling one item twice is not two
      // items of intervening work, and counting it as such would let an
      // annotator shorten their own retest gap.
      labelledSinceRound1:
        first === null
          ? 0
          : new Set(
              labels
                .filter((l) => l.goldenItemId !== itemId && l.createdAt > first)
                .map((l) => l.goldenItemId)
            ).size,
    };
  });
}

/**
 * Does any of this annotator's ACTIVE assignments cover this (item, round)?
 *
 * Two granularities, two rules:
 *
 *   - A WHOLE-SET assignment (`goldenItemId: null`) means "work this set under
 *     its protocol", and the blind re-read IS the protocol — so it covers
 *     every item at every round. Requiring a second assignment for round 2
 *     would make the retest visible as a queue event, which is precisely the
 *     leak blinding exists to prevent.
 *   - An ITEM assignment is a targeted request — an adjudication, or one
 *     specific re-read — so it covers exactly the round it names. That is also
 *     what the active-assignment unique index is keyed on, so the two
 *     descriptions of "this piece of work" agree.
 */
export function coversCandidate(
  assignments: Array<{ goldenItemId: string | null; round: number }>,
  candidate: { itemId: string; round: number }
): boolean {
  return assignments.some((a) =>
    a.goldenItemId === null
      ? true
      : a.goldenItemId === candidate.itemId && a.round === candidate.round
  );
}

/**
 * FNV-1a, 32-bit. Chosen for being short enough to read and verify inline
 * rather than for cryptographic strength — nothing here is a secret, the
 * requirement is only that the order be stable, cheap, and not the input
 * order. `>>> 0` keeps it unsigned after the 32-bit multiply.
 */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * The next item to serve, or an explicit reason there is none.
 *
 * `seed` is `${annotatorId}:${goldenSetId}`: one annotator sees a stable order
 * over one set across requests, and two annotators over the same set see
 * different orders — which is what stops position from being a signal, and
 * what keeps the overlap between them from being ordered identically.
 *
 * An empty candidate list is `set-complete`, not `no-assignment`. The two are
 * different facts — "you have done everything asked of you" versus "nothing
 * was asked of you" — and only the caller knows which, because only the caller
 * looked for assignments. `no-assignment` is in the union for that caller to
 * return; this function never produces it.
 */
export function selectNext(candidates: QueueCandidate[], seed: string): QueueResult {
  const eligible = candidates.filter((c) => c.eligible);

  if (eligible.length > 0) {
    // Sorted by hash, then by itemId as a tiebreak, so a hash collision does
    // not make the order depend on input order after all.
    const [first] = [...eligible].sort((a, b) => {
      const ha = fnv1a(`${seed}:${a.itemId}`);
      const hb = fnv1a(`${seed}:${b.itemId}`);
      return ha === hb ? (a.itemId < b.itemId ? -1 : 1) : ha - hb;
    });
    return { next: { itemId: first.itemId, round: first.round }, reason: null };
  }

  if (candidates.length === 0) return { next: null, reason: 'set-complete' };

  // Everything left is a retest that has not aged enough. Report the SMALLEST
  // shortfall: it is the soonest anything becomes available, and quoting a
  // larger one would understate progress in a way the annotator cannot check.
  const labelsUntilRetest = Math.min(
    ...candidates.map((c) => c.labelsUntilEligible ?? Number.POSITIVE_INFINITY)
  );
  return {
    next: null,
    reason: 'retest-not-yet-eligible',
    ...(Number.isFinite(labelsUntilRetest) ? { labelsUntilRetest } : {}),
  };
}
