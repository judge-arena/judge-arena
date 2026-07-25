import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db, truncateAll, mkUser } from './helpers';
import { resolveHumanOverallScore } from '@/lib/utils';

// ─── Local fixture helpers ──────────────────────────────────────────────────
// EvaluationRun chain needed for HumanJudgment tests.

async function mkProject(userId: string) {
  return db.project.create({ data: { name: 'fixture-project', userId } });
}

async function mkEvaluation(projectId: string, userId: string) {
  return db.evaluation.create({
    data: { projectId, userId, inputText: 'fixture input' },
  });
}

async function mkEvaluationRun(evaluationId: string) {
  return db.evaluationRun.create({
    data: { evaluationId },
  });
}

describe('HumanJudgment score resolution: null-vs-0 correctness', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it('payload without overallScore but WITH criteriaScores → stored overallScore equals weighted recomputation', async () => {
    const user = await mkUser();
    const project = await mkProject(user.id);
    const evaluation = await mkEvaluation(project.id, user.id);
    const run = await mkEvaluationRun(evaluation.id);

    const criteriaScores = [
      { criterionId: 'c1', criterionName: 'Accuracy', score: 8, maxScore: 10, weight: 2 },
      { criterionId: 'c2', criterionName: 'Clarity', score: 6, maxScore: 10, weight: 1 },
    ];

    // Simulate what the route handler does: resolve the score first
    const resolvedScore = resolveHumanOverallScore(undefined, criteriaScores);

    // Expected computation: (0.8*2 + 0.6*1) / 3 * 10 = 7.333...
    const expectedScore = (((8 / 10) * 2 + (6 / 10) * 1) / 3) * 10;

    // Now persist with the resolved score (as the route would)
    const judgment = await db.humanJudgment.create({
      data: {
        runId: run.id,
        userId: user.id,
        overallScore: resolvedScore,
        criteriaScores,
        reasoning: 'Test reasoning',
      },
    });

    // Verify the stored overallScore matches the weighted computation
    expect(judgment.overallScore).toBeCloseTo(expectedScore, 2);
    expect(judgment.criteriaScores).toEqual(criteriaScores);
    expect(resolvedScore).toBeCloseTo(expectedScore, 2);
  });

  it('payload without overallScore and without criteriaScores → resolveHumanOverallScore throws error', () => {
    // This test verifies that the route will reject requests when both are missing
    expect(() => resolveHumanOverallScore(undefined, undefined)).toThrow(
      'overallScore or criteriaScores required'
    );
  });

  it('payload WITH overallScore → stored overallScore equals provided value', async () => {
    const user = await mkUser();
    const project = await mkProject(user.id);
    const evaluation = await mkEvaluation(project.id, user.id);
    const run = await mkEvaluationRun(evaluation.id);

    // Simulate route: resolve the score
    const resolvedScore = resolveHumanOverallScore(8.5, undefined);

    const judgment = await db.humanJudgment.create({
      data: {
        runId: run.id,
        userId: user.id,
        overallScore: resolvedScore,
        reasoning: 'Explicit score',
      },
    });

    expect(judgment.overallScore).toBe(8.5);
    expect(resolvedScore).toBe(8.5);
  });

  it('payload WITH both overallScore and criteriaScores → stored overallScore equals provided value (not recomputed)', async () => {
    const user = await mkUser();
    const project = await mkProject(user.id);
    const evaluation = await mkEvaluation(project.id, user.id);
    const run = await mkEvaluationRun(evaluation.id);

    const criteriaScores = [
      { criterionId: 'c1', criterionName: 'Accuracy', score: 8, maxScore: 10, weight: 2 },
      { criterionId: 'c2', criterionName: 'Clarity', score: 6, maxScore: 10, weight: 1 },
    ];

    // Simulate route: resolve the score (explicit takes precedence)
    const resolvedScore = resolveHumanOverallScore(9.5, criteriaScores);

    // When both are provided, explicit overallScore takes precedence
    const judgment = await db.humanJudgment.create({
      data: {
        runId: run.id,
        userId: user.id,
        overallScore: resolvedScore, // Different from what would be computed
        criteriaScores,
        reasoning: 'Both provided',
      },
    });

    expect(judgment.overallScore).toBe(9.5); // Should use the explicit value, not recompute
    expect(judgment.criteriaScores).toEqual(criteriaScores);
    expect(resolvedScore).toBe(9.5);
  });
});
