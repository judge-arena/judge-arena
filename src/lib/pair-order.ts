/**
 * ─── Which order the two candidates were rendered in ────────────────────────
 *
 * Lives HERE, not in `calibration/readings.ts`, because it is needed by both
 * sides and the read layer is the wrong place for a writer to import from.
 * `ModelJudgment.pairOrder` is a nullable `String` in Prisma
 * (`schema.prisma:490`) — NOT a Prisma enum — so nothing at the database layer
 * rejects `'ba'` or `'Ab'`. Before this module the only typed form was in the
 * read layer, which meant a bad value was caught at SCORE time, after the
 * inference for a whole run had been paid for.
 */
export type PairOrder = 'AB' | 'BA';

/** Both orders, AB first — the order a paired sweep dispatches them in. */
export const PAIR_ORDERS: readonly PairOrder[] = ['AB', 'BA'] as const;

export function isPairOrder(value: unknown): value is PairOrder {
  return value === 'AB' || value === 'BA';
}

/** The other order. Used by the paired-launch path to derive the second
 *  judgment from the first rather than repeating the literal. */
export function oppositeOrder(order: PairOrder): PairOrder {
  return order === 'AB' ? 'BA' : 'AB';
}
