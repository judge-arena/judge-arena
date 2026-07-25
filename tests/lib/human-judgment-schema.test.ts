import { describe, it, expect } from 'vitest';
import { humanJudgmentSchema } from '@/app/api/evaluations/[id]/runs/[runId]/human-judgment/route';

// ─── humanJudgmentSchema: maxScore NaN guard ────────────────────────────────
// criteriaScores[].maxScore feeds computeWeightedScore's `score / maxScore`
// division (see src/lib/utils.ts). A maxScore of 0 produces NaN/Infinity,
// which then poisons the weighted average and, downstream, dataset/leaderboard
// aggregates. Mirrors the same guard already applied to rubric criteria in
// src/lib/config.ts (`maxScore: z.number().int().min(1).max(100)`).

describe('humanJudgmentSchema', () => {
  const basePayload = {
    reasoning: 'Looks good',
    criteriaScores: [
      {
        criterionId: 'c1',
        criterionName: 'Accuracy',
        score: 5,
        maxScore: 0,
        weight: 1,
      },
    ],
  };

  it('rejects a criteriaScores entry with maxScore 0 (would divide by zero / produce NaN)', () => {
    const result = humanJudgmentSchema.safeParse(basePayload);
    expect(result.success).toBe(false);
  });

  it('accepts a criteriaScores entry with maxScore >= 1', () => {
    const result = humanJudgmentSchema.safeParse({
      ...basePayload,
      criteriaScores: [{ ...basePayload.criteriaScores[0], maxScore: 10 }],
    });
    expect(result.success).toBe(true);
  });
});
