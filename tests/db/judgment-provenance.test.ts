import { describe, it, expect, beforeEach } from 'vitest';
import { db, truncateAll, mkUser, mkRubric } from './helpers';

// ─── Local fixture helpers ──────────────────────────────────────────────────
// ModelJudgment/EvaluationRun provenance needs an Evaluation + Project chain
// that tests/db/helpers.ts doesn't build (only User/Rubric are shared there).
// Kept file-local since no other tests/db/** spec needs this shape yet.

async function mkProject(userId: string) {
  return db.project.create({ data: { name: 'fixture-project', userId } });
}

async function mkEvaluation(
  projectId: string,
  userId: string,
  overrides: Partial<{ rubricId: string }> = {}
) {
  return db.evaluation.create({
    data: { projectId, userId, inputText: 'fixture input', ...overrides },
  });
}

async function mkModelConfig(userId: string) {
  return db.modelConfig.create({
    data: { name: 'fixture-model', provider: 'openai', modelId: 'gpt-4', userId },
  });
}

async function mkEvaluationRun(
  evaluationId: string,
  triggeredById: string | null,
  overrides: Partial<{ rubricId: string }> = {}
) {
  return db.evaluationRun.create({
    data: { evaluationId, triggeredById, ...overrides },
  });
}

let judgeModelCounter = 0;

async function mkJudgeModelVersion() {
  judgeModelCounter += 1;
  const judgeModel = await db.judgeModel.create({
    data: {
      name: `fixture-judge-${judgeModelCounter}`,
      slug: `fixture-judge-${judgeModelCounter}`,
      judgeClass: 'prompted_api',
      scoringMechanism: 'critique_generative',
    },
  });
  return db.judgeModelVersion.create({
    data: {
      judgeModelId: judgeModel.id,
      ordinal: 1,
      servingBackend: 'openai',
      protocolSupport: { pointwise: ['score'] },
    },
  });
}

describe('ModelJudgment / EvaluationRun v2 provenance', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it('unique (runId, judgeModelVersionId, pairOrder) is NULLS NOT DISTINCT (v2b): duplicate rejects P2002, and a shared-NULL tuple collides too', async () => {
    const user = await mkUser();
    const project = await mkProject(user.id);
    const evaluation = await mkEvaluation(project.id, user.id);
    const run = await mkEvaluationRun(evaluation.id, user.id);
    const modelConfig = await mkModelConfig(user.id);
    const version = await mkJudgeModelVersion();

    await db.modelJudgment.create({
      data: {
        runId: run.id,
        modelConfigId: modelConfig.id,
        judgeModelVersionId: version.id,
        pairOrder: 'a',
      },
    });

    await expect(
      db.modelJudgment.create({
        data: {
          runId: run.id,
          modelConfigId: modelConfig.id,
          judgeModelVersionId: version.id,
          pairOrder: 'a',
        },
      })
    ).rejects.toMatchObject({ code: 'P2002' });

    // v2b (Task 6) recreates this index NULLS NOT DISTINCT (see the
    // v2b_idempotency_tighten migration) — a NULL judgeModelVersionId is now
    // treated as equal to another NULL, same as any other value, so two rows
    // sharing (runId, judgeModelVersionId=NULL, pairOrder='a') collide just
    // like the real-version duplicate above. Before this migration, Postgres's
    // default NULLS DISTINCT semantics let this second insert through.
    const nullRow1 = await db.modelJudgment.create({
      data: { runId: run.id, modelConfigId: modelConfig.id, pairOrder: 'a' },
    });
    await expect(
      db.modelJudgment.create({
        data: { runId: run.id, modelConfigId: modelConfig.id, pairOrder: 'a' },
      })
    ).rejects.toMatchObject({ code: 'P2002' });

    // A differing pairOrder still disambiguates two null-judgeModelVersionId
    // rows — NULLS NOT DISTINCT only changes how NULLs compare to NULLs, not
    // whether distinct non-null column values keep disambiguating.
    const nullRow2 = await db.modelJudgment.create({
      data: { runId: run.id, modelConfigId: modelConfig.id, pairOrder: 'b' },
    });
    expect(nullRow1.id).not.toBe(nullRow2.id);
    expect(nullRow1.judgeModelVersionId).toBeNull();
    expect(nullRow2.judgeModelVersionId).toBeNull();
  });

  it('deleting a rubric pinned by a run is restricted (P2003)', async () => {
    const user = await mkUser();
    const rubric = await mkRubric(user.id);
    const project = await mkProject(user.id);
    const evaluation = await mkEvaluation(project.id, user.id);
    await mkEvaluationRun(evaluation.id, user.id, { rubricId: rubric.id });

    await expect(db.rubric.delete({ where: { id: rubric.id } })).rejects.toMatchObject({
      code: 'P2003',
    });
  });

  it('deleting the triggering user nulls triggeredById but the run survives (P1.7 anonymize path)', async () => {
    const owner = await mkUser();
    const triggeredBy = await mkUser();
    const project = await mkProject(owner.id);
    const evaluation = await mkEvaluation(project.id, owner.id);
    const run = await mkEvaluationRun(evaluation.id, triggeredBy.id);

    await db.user.delete({ where: { id: triggeredBy.id } });

    const survived = await db.evaluationRun.findUnique({ where: { id: run.id } });
    expect(survived).not.toBeNull();
    expect(survived?.triggeredById).toBeNull();
  });

  it('criteriaScores accepts a JS object/array and round-trips through Postgres JSONB', async () => {
    const user = await mkUser();
    const project = await mkProject(user.id);
    const evaluation = await mkEvaluation(project.id, user.id);
    const run = await mkEvaluationRun(evaluation.id, user.id);
    const modelConfig = await mkModelConfig(user.id);

    const scores = [
      { criterionId: 'c1', criterionName: 'Accuracy', score: 8, maxScore: 10, weight: 1.5, comment: 'good' },
      { criterionId: 'c2', criterionName: 'Clarity', score: 6, maxScore: 10, weight: 1 },
    ];

    const judgment = await db.modelJudgment.create({
      data: { runId: run.id, modelConfigId: modelConfig.id, criteriaScores: scores },
    });
    expect(judgment.criteriaScores).toEqual(scores);

    const fetched = await db.modelJudgment.findUniqueOrThrow({ where: { id: judgment.id } });
    expect(fetched.criteriaScores).toEqual(scores);

    // HumanJudgment.criteriaScores made the same String -> Json move.
    const human = await db.humanJudgment.create({
      data: {
        runId: run.id,
        userId: user.id,
        overallScore: 7,
        criteriaScores: scores,
      },
    });
    expect(human.criteriaScores).toEqual(scores);
  });

  it('RunCandidate: (runId, position) unique + cascades on run delete', async () => {
    const user = await mkUser();
    const project = await mkProject(user.id);
    const evaluation = await mkEvaluation(project.id, user.id);
    const run = await mkEvaluationRun(evaluation.id, user.id);

    const candidate = await db.runCandidate.create({
      data: { runId: run.id, position: 0, promptText: 'p', responseText: 'r', label: 'A' },
    });
    expect(candidate.id).toBeTruthy();

    await expect(
      db.runCandidate.create({ data: { runId: run.id, position: 0 } })
    ).rejects.toMatchObject({ code: 'P2002' });

    await db.evaluationRun.delete({ where: { id: run.id } });
    const survivors = await db.runCandidate.findMany({ where: { runId: run.id } });
    expect(survivors).toHaveLength(0);
  });
});
