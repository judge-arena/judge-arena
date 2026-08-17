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
