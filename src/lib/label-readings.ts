import type { Reading } from '@/lib/agreement';

/**
 * A1 — turning stored `GoldenLabel` rows into the shapes the statistics take.
 *
 * Pure, and in `src/lib/**` rather than in the reporting routes, for the
 * reason the whole phase is laid out this way: `src/app/api/**` is outside
 * every coverage `include`, so a projection that decides WHICH readings feed a
 * kappa is a rule no coverage number would describe if it lived in a handler.
 *
 * Three separate questions, deliberately three functions, because conflating
 * any two of them produces a plausible number that answers neither:
 *
 *   - INTER-annotator agreement compares DIFFERENT PEOPLE on the same item.
 *   - TEST-RETEST compares ONE PERSON WITH THEMSELVES across two blind
 *     readings.
 *   - DISAGREEMENT RANKING is not a kappa at all; it is a per-item spread.
 */

/** The stored columns these projections read. */
export type LabelRow = {
  goldenItemId: string;
  annotatorId: string | null;
  round: number;
  overallScore: number | null;
  preference: string | null;
};

/**
 * The category a reading falls in — a score stringified, or a preference
 * verbatim. `null` only if the CHECK constraint were absent, which is why
 * callers drop rather than coerce: a label with neither value is not a
 * judgment, and inventing one for it would put a fabricated category into the
 * set the number is reported over.
 */
export function labelCategory(label: LabelRow): string | null {
  if (label.overallScore !== null) return String(label.overallScore);
  return label.preference;
}

/**
 * Round-1 readings by identified annotators.
 *
 * ROUND 1 ONLY. Mixing an annotator's re-read into an inter-annotator matrix
 * would let one person contribute two readings to one item and be compared
 * against themselves inside a statistic that means "do different people
 * agree".
 *
 * ANONYMISED READINGS ARE EXCLUDED, AND COUNTED. Account deletion nulls
 * `annotatorId` by design (anonymise rather than destroy), so such a reading
 * cannot be attributed — and treating all of them as one rater would merge two
 * deleted people into one, silently changing the statistic. Dropping them is
 * right. Dropping them QUIETLY is the confidently-wrong-number failure this
 * phase exists to prevent, so the count travels back with them.
 */
export function interAnnotatorReadings(labels: LabelRow[]): {
  readings: Reading[];
  excludedAnonymised: number;
} {
  const readings: Reading[] = [];
  let excludedAnonymised = 0;

  for (const label of labels) {
    if (label.round !== 1) continue;
    const category = labelCategory(label);
    if (category === null) continue;
    if (label.annotatorId === null) {
      excludedAnonymised += 1;
      continue;
    }
    readings.push({ itemId: label.goldenItemId, raterId: label.annotatorId, category });
  }

  return { readings, excludedAnonymised };
}

/**
 * Test-retest readings, pooled across annotators.
 *
 * Modelled as a two-"rater" problem — round 1 versus round 2 — over the pairs
 * `(annotator, item)` that actually have both. Pooling is what makes the
 * number computable at all while one account exists: it is the only
 * reliability signal that yields a value before a second annotator exists.
 *
 * `itemId` is namespaced by annotator so two people re-reading the SAME item
 * stay two independent pairs rather than colliding into one.
 *
 * The returned `annotatorCount` is the count of DISTINCT PEOPLE contributing a
 * pair. It has to be reported separately because `agreement()` would derive 2
 * from the rater ids — which here are 'round-1' and 'round-2', not people, and
 * reporting that as an annotator count would be a straightforwardly false
 * statement about who produced the number.
 */
export function testRetestReadings(labels: LabelRow[]): {
  readings: Reading[];
  annotatorCount: number;
} {
  const byPair = new Map<string, { round1?: string; round2?: string; annotatorId: string }>();

  for (const label of labels) {
    if (label.annotatorId === null) continue;
    const category = labelCategory(label);
    if (category === null) continue;
    const key = `${label.annotatorId}:${label.goldenItemId}`;
    const entry = byPair.get(key) ?? { annotatorId: label.annotatorId };
    if (label.round === 1) entry.round1 = category;
    else if (label.round === 2) entry.round2 = category;
    byPair.set(key, entry);
  }

  const readings: Reading[] = [];
  const annotators = new Set<string>();
  for (const [key, entry] of byPair) {
    if (entry.round1 === undefined || entry.round2 === undefined) continue;
    readings.push(
      { itemId: key, raterId: 'round-1', category: entry.round1 },
      { itemId: key, raterId: 'round-2', category: entry.round2 }
    );
    annotators.add(entry.annotatorId);
  }

  return { readings, annotatorCount: annotators.size };
}

/**
 * How far apart an item's readings are.
 *
 * For scores, `max - min` on the values. For preferences, the number of
 * DISTINCT verdicts — because 'A>B' and 'tie' have no defined distance, and
 * inventing one would be a claim about the domain rather than a measurement
 * (the same reason preference agreement is unweighted).
 *
 * A single reading has nothing to diverge from and is not ranked at all;
 * callers filter first. Zero spread and "only one person looked" are different
 * facts, and a list that shows them identically is worse than one that omits
 * the second.
 */
export function readingSpread(categories: string[]): number {
  const numeric = categories.every((c) => c.trim() !== '' && Number.isFinite(Number(c)));
  if (numeric) {
    const values = categories.map(Number);
    return Math.max(...values) - Math.min(...values);
  }
  return new Set(categories).size;
}
