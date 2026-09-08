import type { Prisma } from '@prisma/client';

/**
 * ─── The "canonical order" filter for counting/selecting EvaluationRuns ────
 *
 * Task 9 (spec `docs/superpowers/specs/2026-09-07-permuted-run-design.md`
 * §2). A permuted calibration launches TWO `EvaluationRun`s per golden item
 * — `pairOrder` `'AB'` and `'BA'` — sharing ONE `Evaluation`
 * (`src/lib/calibration/launch.ts`, decision D3). From the frontend's point
 * of view they are "the same record ... with a BA vs AB bias" (owner,
 * 2026-09-07), not two runs to count or pick between.
 *
 * This is the SAME exclusion the leaderboard route already applies (design
 * D6 / T7): "exclude `pairOrder = 'BA'`". Reused here for every OTHER
 * surface that counts EvaluationRuns per Evaluation/Rubric, or picks "the"
 * latest run — so a permuted calibration item reads as ONE run everywhere a
 * plain (non-calibration) evaluation would, and the same run (AB) is always
 * the one a single-slot UI (a "latest run" badge) picks.
 *
 * Does NOT apply to `src/app/api/evaluations/[id]/route.ts` (the run-detail
 * page's data source) or `src/lib/calibration/score.ts` — both need BOTH
 * orders: the former to render the collapsed AB/BA row
 * (`src/lib/dataset-run-groups.ts`'s `projectCalibrationRunRows`), the
 * latter to score them. This filter is only for surfaces that reduce a run
 * list to a single number or a single "latest" pick.
 *
 * NULL-SAFETY, spelled out rather than left to `{ not: 'BA' }`: every
 * ordinary run — pointwise, or pairwise outside calibration — carries
 * `pairOrder: 'AB'` (pairwise; `run-launch.ts`'s `params.pairOrder ?? 'AB'`
 * default) or `pairOrder: null` (pointwise), never anything else. The only
 * writer that ever produces `'BA'` is a permuted calibration launch. Naming
 * the two ADMITTED values with `OR` sidesteps NULL comparison semantics
 * entirely, rather than relying on how Prisma compiles `{ not: 'BA' }` for a
 * nullable column — `src/app/api/leaderboard/route.ts`'s own comment
 * documents why the equivalent raw-SQL `<>` silently drops NULL rows and
 * needed `IS DISTINCT FROM` instead; this avoids the question rather than
 * re-deriving the answer.
 */
export const canonicalOrderRunWhere: Prisma.EvaluationRunWhereInput = {
  OR: [{ pairOrder: null }, { pairOrder: 'AB' }],
};
