import { describe, it, expect, beforeEach } from 'vitest';
import { db, truncateAll, mkUser } from './helpers';
import { resolveHumanJudgmentScore } from '@/lib/utils';

// ─── Local fixture helpers ──────────────────────────────────────────────────
// EvaluationRun chain needed for HumanJudgment tests.

async function mkProject(userId: string) {
  return db.project.create({ data: { name: 'fixture-project', userId } });
}

async function mkEvaluation(
  projectId: string,
  userId: string,
  overrides: Partial<{ responseText: string | null }> = {}
) {
  return db.evaluation.create({
    data: { projectId, userId, inputText: 'fixture input', ...overrides },
  });
}

async function mkEvaluationRun(evaluationId: string) {
  return db.evaluationRun.create({
    data: { evaluationId },
  });
}

async function mkModelConfig(userId: string) {
  return db.modelConfig.create({
    data: { name: 'fixture-model', provider: 'openai', modelId: 'gpt-4', userId },
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

    // Simulate what the route handler does in judge mode: resolve the score first
    const resolvedScore = resolveHumanJudgmentScore({
      mode: 'judge',
      overallScore: undefined,
      criteriaScores,
    });

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

  it('judge mode payload without overallScore and without criteriaScores → resolveHumanJudgmentScore throws error', () => {
    // This test verifies that the route will reject judge-mode requests when both are missing
    expect(() =>
      resolveHumanJudgmentScore({ mode: 'judge', overallScore: undefined, criteriaScores: undefined })
    ).toThrow('overallScore or criteriaScores required');
  });

  it('payload WITH overallScore → stored overallScore equals provided value', async () => {
    const user = await mkUser();
    const project = await mkProject(user.id);
    const evaluation = await mkEvaluation(project.id, user.id);
    const run = await mkEvaluationRun(evaluation.id);

    // Simulate route: resolve the score (judge mode)
    const resolvedScore = resolveHumanJudgmentScore({
      mode: 'judge',
      overallScore: 8.5,
      criteriaScores: undefined,
    });

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

    // Simulate route: resolve the score (judge mode, explicit takes precedence)
    const resolvedScore = resolveHumanJudgmentScore({
      mode: 'judge',
      overallScore: 9.5,
      criteriaScores,
    });

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

describe('HumanJudgment score resolution: respond-mode persistence', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it('respond mode payload (overallScore undefined, criteriaScores [], selectedBestModelId set) → row written with placeholder 0, no 400 logic applies', async () => {
    const user = await mkUser();
    const project = await mkProject(user.id);
    // responseText left unset so this evaluation lines up with the route's
    // respond-mode detection (`run.evaluation.responseText?.trim()` falsy).
    const evaluation = await mkEvaluation(project.id, user.id, { responseText: null });
    const run = await mkEvaluationRun(evaluation.id);
    const bestModel = await mkModelConfig(user.id);

    // Simulate exactly what the form sends in respond mode and what the
    // route resolves it to: overallScore undefined, criteriaScores [].
    const resolvedScore = resolveHumanJudgmentScore({
      mode: 'respond',
      overallScore: undefined,
      criteriaScores: [],
    });

    expect(resolvedScore).toBe(0);

    // Now persist with the resolved score (as the route would in respond mode) —
    // no 400 branch is reachable for this payload shape.
    const judgment = await db.humanJudgment.create({
      data: {
        runId: run.id,
        userId: user.id,
        overallScore: resolvedScore,
        criteriaScores: [],
        selectedBestModelId: bestModel.id,
        reasoning: 'This response was clearer and more concise.',
      },
    });

    expect(judgment.overallScore).toBe(0);
    expect(judgment.selectedBestModelId).toBe(bestModel.id);
  });
});
