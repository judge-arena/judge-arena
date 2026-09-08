import { describe, expect, it } from 'vitest';
import { canonicalOrderRunWhere } from '@/lib/run-counting';

// Task 9 (spec §2): pins the exact shape of the filter every "count/pick one
// EvaluationRun per Evaluation" surface (project page run-count badge,
// rubric evaluationRuns count) uses to exclude a permuted calibration's 'BA'
// half. Regression-critical specifically because `{ not: 'BA' }` would be a
// plausible-looking rewrite that silently drops every NULL-pairOrder row
// (ordinary pointwise runs) under Postgres' three-valued NULL comparison —
// see run-counting.ts's own doc, and src/app/api/leaderboard/route.ts's
// identical trap in raw SQL.
describe('canonicalOrderRunWhere', () => {
  it('admits NULL (pointwise) and AB (pairwise default / calibration primary order) by name', () => {
    expect(canonicalOrderRunWhere).toEqual({
      OR: [{ pairOrder: null }, { pairOrder: 'AB' }],
    });
  });

  it('does not spell the exclusion as a negation of BA', () => {
    // A `{ not: 'BA' }` rewrite would still satisfy some superficial specs
    // but reintroduces the NULL trap this module exists to avoid. Assert the
    // literal shape rather than behavior-testing Prisma's SQL compilation
    // (that's what the DB-level test in tests/db exercises against a real
    // permuted calibration + a real ordinary pointwise run).
    const serialized = JSON.stringify(canonicalOrderRunWhere);
    expect(serialized).not.toContain('"not"');
  });
});
