import { describe, it, expect, beforeEach } from 'vitest';
import { db, truncateAll, mkUser } from './helpers';

// ─── Local fixture helpers ──────────────────────────────────────────────────
// Mirrors tests/db/judgment-provenance.test.ts's file-local shape (Project ->
// Evaluation -> EvaluationRun chain + a JudgeModelVersion) — kept file-local
// per the established "shared only once actually shared" convention (see
// tests/db/account-deletion.test.ts's own comment to the same effect).

async function mkProject(userId: string) {
  return db.project.create({ data: { name: 'fixture-project', userId } });
}

async function mkEvaluation(projectId: string, userId: string) {
  return db.evaluation.create({
    data: { projectId, userId, inputText: 'fixture input' },
  });
}

async function mkEvaluationRun(
  evaluationId: string,
  triggeredById: string | null,
  overrides: Partial<{ status: 'pending' | 'judging' | 'needs_human' | 'completed' | 'error'; finalizedAt: Date | null; updatedAt: Date }> = {}
) {
  return db.evaluationRun.create({
    data: { evaluationId, triggeredById, ...overrides },
  });
}

async function mkModelConfig(userId: string) {
  return db.modelConfig.create({
    data: { name: 'fixture-model', provider: 'openai', modelId: 'gpt-4', userId },
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

// DB-backed (v2b, Task 6): exercises the migration hand-edits in
// prisma/migrations/20260728215410_v2b_idempotency_tighten/migration.sql —
// the NULLS NOT DISTINCT recreation of the ModelJudgment unique index, the
// nullable modelConfigId column, and the needs_human finalizedAt backfill.
describe('v2b idempotency tightening (DB)', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it('two pointwise judgments (pairOrder null) on the same (run, judge version) collide P2002 — proves NULLS NOT DISTINCT is live', async () => {
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
        pairOrder: null,
        overallScore: 8,
      },
    });

    // Before this migration, Postgres's default NULLS DISTINCT semantics let
    // this second row (same run, same judge version, pairOrder still null)
    // insert freely — the exact 1a handoff flag I2 gap this migration closes.
    await expect(
      db.modelJudgment.create({
        data: {
          runId: run.id,
          modelConfigId: modelConfig.id,
          judgeModelVersionId: version.id,
          pairOrder: null,
          overallScore: 2,
        },
      })
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('two pointwise judgments on the same run but DISTINCT judge versions still coexist', async () => {
    const user = await mkUser();
    const project = await mkProject(user.id);
    const evaluation = await mkEvaluation(project.id, user.id);
    const run = await mkEvaluationRun(evaluation.id, user.id);
    const modelConfig = await mkModelConfig(user.id);
    const versionA = await mkJudgeModelVersion();
    const versionB = await mkJudgeModelVersion();

    const rowA = await db.modelJudgment.create({
      data: { runId: run.id, modelConfigId: modelConfig.id, judgeModelVersionId: versionA.id, pairOrder: null },
    });
    const rowB = await db.modelJudgment.create({
      data: { runId: run.id, modelConfigId: modelConfig.id, judgeModelVersionId: versionB.id, pairOrder: null },
    });

    expect(rowA.id).not.toBe(rowB.id);
    const rows = await db.modelJudgment.findMany({ where: { runId: run.id } });
    expect(rows).toHaveLength(2);
  });

  it('pairwise AB + BA on the same (run, judge version) coexist (distinct non-null pairOrder values)', async () => {
    const user = await mkUser();
    const project = await mkProject(user.id);
    const evaluation = await mkEvaluation(project.id, user.id);
    const run = await mkEvaluationRun(evaluation.id, user.id);
    const modelConfig = await mkModelConfig(user.id);
    const version = await mkJudgeModelVersion();

    const rowAB = await db.modelJudgment.create({
      data: { runId: run.id, modelConfigId: modelConfig.id, judgeModelVersionId: version.id, pairOrder: 'AB' },
    });
    const rowBA = await db.modelJudgment.create({
      data: { runId: run.id, modelConfigId: modelConfig.id, judgeModelVersionId: version.id, pairOrder: 'BA' },
    });

    expect(rowAB.id).not.toBe(rowBA.id);
    const rows = await db.modelJudgment.findMany({ where: { runId: run.id } });
    expect(rows).toHaveLength(2);
  });

  it('modelConfigId is optional — a ModelJudgment can be created with no ModelConfig at all', async () => {
    const user = await mkUser();
    const project = await mkProject(user.id);
    const evaluation = await mkEvaluation(project.id, user.id);
    const run = await mkEvaluationRun(evaluation.id, user.id);
    const version = await mkJudgeModelVersion();

    const judgment = await db.modelJudgment.create({
      data: { runId: run.id, judgeModelVersionId: version.id, pairOrder: null },
    });

    expect(judgment.modelConfigId).toBeNull();
    const fetched = await db.modelJudgment.findUniqueOrThrow({ where: { id: judgment.id } });
    expect(fetched.modelConfigId).toBeNull();
  });

  it('needs_human backfill: the migration UPDATE sets finalizedAt = updatedAt for needs_human rows that predate it', async () => {
    const user = await mkUser();
    const project = await mkProject(user.id);
    const evaluation = await mkEvaluation(project.id, user.id);

    // Simulates a pre-migration row shape: needs_human, finalizedAt still
    // null (the semantic gap 1a handoff flag M4 flags — pre-Task-6,
    // finalization only reliably set finalizedAt for `completed`).
    const staleUpdatedAt = new Date('2026-07-01T00:00:00.000Z');
    const run = await mkEvaluationRun(evaluation.id, user.id, {
      status: 'needs_human',
      finalizedAt: null,
      updatedAt: staleUpdatedAt,
    });
    expect(run.finalizedAt).toBeNull();

    // A completed run with finalizedAt already null must NOT be touched by
    // this backfill (it's a separate, already-handled case — finalization
    // (Task 8) is responsible for it, not this one-time migration statement).
    const completedRun = await mkEvaluationRun(evaluation.id, user.id, {
      status: 'completed',
      finalizedAt: null,
      updatedAt: staleUpdatedAt,
    });

    // Re-run the exact migration statement (idempotent — WHERE ... IS NULL
    // guards it) rather than re-running the whole migration chain, matching
    // the task brief's "simpler: run the backfill UPDATE statement raw".
    await db.$executeRawUnsafe(
      `UPDATE "EvaluationRun" SET "finalizedAt" = "updatedAt" WHERE status = 'needs_human' AND "finalizedAt" IS NULL`
    );

    const backfilled = await db.evaluationRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(backfilled.finalizedAt?.getTime()).toBe(staleUpdatedAt.getTime());

    const untouchedCompleted = await db.evaluationRun.findUniqueOrThrow({ where: { id: completedRun.id } });
    expect(untouchedCompleted.finalizedAt).toBeNull();
  });
});
