import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createImportCtx } from '../../scripts/importer/context';
import { resolveOwners, ARCHIVE_USER_EMAIL } from '../../scripts/importer/owners';
import { synthesizeJudges } from '../../scripts/importer/judges';
import { importArtifacts } from '../../scripts/importer/artifacts';
import { importRuns } from '../../scripts/importer/runs';
import { db, truncateAll } from '../db/helpers';
import {
  v1db,
  truncateAllV1,
  mkV1User,
  mkV1ModelConfig,
  mkV1Project,
  mkV1Rubric,
  mkV1RubricCriterion,
  mkV1Dataset,
  mkV1DatasetSample,
  mkV1Evaluation,
  mkV1EvaluationRun,
  mkV1ModelJudgment,
  mkV1HumanJudgment,
} from './helpers';
import type { OwnerMap } from '../../scripts/importer/context';

const HOUR_MS = 60 * 60 * 1000;

// DB-backed: needs BOTH the v1 scratch DB (V1_DATABASE_URL) and the v2 test
// DB (DATABASE_URL/TEST_DATABASE_URL) reachable. Named *.db.test.ts and
// listed in vitest.db.config.ts's include (NOT vitest.config.ts's), so
// plain `npm test` never runs this file — see tests/importer/helpers.ts.
describe('importRuns (DB)', () => {
  beforeEach(async () => {
    await truncateAll();
    await truncateAllV1();
    const { seedPromptTemplates } = await import('../../prisma/seed-prompt-templates');
    await seedPromptTemplates(db);
  });

  afterAll(async () => {
    await v1db.$disconnect();
    await db.$disconnect();
  });

  /** Builds the fixture shared by most tests below: 1 project, 1 rubric (2
   * criteria), 1 dataset (2 samples), 2 evaluations, 2 ModelConfigs (one
   * owned by the mapped user, one by the dropped user), across a mapped
   * user (userA) and a dropped user (userB, absent from ownerMap). */
  async function buildFixture() {
    const userA = await mkV1User();
    const userB = await mkV1User();
    const ownerMap: OwnerMap = {
      [userA.id]: { email: 'a@v2.example', oidcIssuer: 'https://idp.test.local', oidcSubject: 'sub-a' },
    };

    const modelConfigA = await mkV1ModelConfig(userA.id, { provider: 'anthropic', modelId: 'claude-3-opus' });
    const modelConfigB = await mkV1ModelConfig(userB.id, { provider: 'openai', modelId: 'gpt-4o' });

    const project = await mkV1Project(userA.id);
    const rubric = await mkV1Rubric(userA.id);
    const crit1 = await mkV1RubricCriterion(rubric.id, { name: 'Accuracy' });
    const crit2 = await mkV1RubricCriterion(rubric.id, { name: 'Clarity' });
    const dataset = await mkV1Dataset(userA.id, { projectId: project.id });
    const sample1 = await mkV1DatasetSample(dataset.id, 0);
    await mkV1DatasetSample(dataset.id, 1);

    const evalA = await mkV1Evaluation(project.id, userA.id, {
      rubricId: rubric.id,
      datasetId: dataset.id,
      datasetSampleId: sample1.id,
    });
    const evalB = await mkV1Evaluation(project.id, userA.id);

    return { userA, userB, ownerMap, modelConfigA, modelConfigB, project, rubric, crit1, crit2, dataset, evalA, evalB };
  }

  it(
    'full fixture: completed run (2 judgments + human judgment) and a stranded run — ' +
      'criterion remap, unmapped-criterion preservation, stranded overrides, ModelConfig ensure, timestamps',
    async () => {
      const f = await buildFixture();

      const now = new Date();
      const staleUpdatedAt = new Date(now.getTime() - 25 * HOUR_MS);

      // ── Run 1: completed, triggered by the DROPPED user, 2 judgments + a human judgment ──
      const run1 = await mkV1EvaluationRun(f.evalA.id, f.userB.id, {
        status: 'completed',
        updatedAt: now,
      });
      const judgment1a = await mkV1ModelJudgment(run1.id, f.modelConfigA.id, {
        status: 'completed',
        overallScore: 8,
        criteriaScores: JSON.stringify([
          { criterionId: f.crit1.id, criterionName: 'Accuracy', score: 8, maxScore: 10, weight: 1, comment: 'good' },
          { criterionId: 'v1-criterion-does-not-exist', criterionName: 'Ghost', score: 5, maxScore: 10, weight: 1 },
        ]),
      });
      await mkV1ModelJudgment(run1.id, f.modelConfigB.id, {
        status: 'completed',
        overallScore: 6,
        criteriaScores: JSON.stringify([
          { criterionId: f.crit2.id, criterionName: 'Clarity', score: 6, maxScore: 10, weight: 1 },
        ]),
      });
      const humanJudgment1 = await mkV1HumanJudgment(run1.id, f.userB.id, {
        overallScore: 7,
        selectedBestModelId: f.modelConfigA.id,
        criteriaScores: JSON.stringify([
          { criterionId: f.crit1.id, criterionName: 'Accuracy', score: 7, maxScore: 10, weight: 1 },
        ]),
      });

      // ── Run 2: stuck in 'judging' for >24h -> stranded; its lone judgment
      // is still 'running' (non-terminal) -> also force-terminalized. ──
      const run2 = await mkV1EvaluationRun(f.evalB.id, f.userA.id, {
        status: 'judging',
        updatedAt: staleUpdatedAt,
      });
      await mkV1ModelJudgment(run2.id, f.modelConfigA.id, {
        status: 'running',
      });

      const ctx = createImportCtx({ mode: 'apply', ownerMap: f.ownerMap });
      const owners = await resolveOwners(ctx);
      const judges = await synthesizeJudges(ctx, owners);
      const ids = await importArtifacts(ctx, owners);
      await importRuns(ctx, owners, ids, judges);

      const archiveUser = await db.user.findUnique({ where: { email: ARCHIVE_USER_EMAIL } });
      const v2UserA = owners.get(f.userA.id)!;

      // ── Run 1: completed, terminal, triggeredById null (dropped triggerer) ──
      const v2Run1 = await db.evaluationRun.findFirst({ where: { evaluationId: ids.evaluation.get(f.evalA.id) } });
      expect(v2Run1).toMatchObject({
        protocol: 'pointwise',
        status: 'completed',
        triggeredById: null,
      });
      expect(v2Run1!.finalizedAt?.getTime()).toBe(run1.updatedAt.getTime());
      expect(v2Run1!.createdAt.getTime()).toBe(run1.createdAt.getTime());
      expect(v2Run1!.updatedAt.getTime()).toBe(run1.updatedAt.getTime());

      // ── Run 2: stranded -> error, now terminal (finalizedAt set) ──
      const v2Run2 = await db.evaluationRun.findFirst({ where: { evaluationId: ids.evaluation.get(f.evalB.id) } });
      expect(v2Run2).toMatchObject({ status: 'error', triggeredById: v2UserA });
      expect(v2Run2!.finalizedAt?.getTime()).toBe(run2.updatedAt.getTime());

      // ── Judgment 1a: criterion remapped; unmapped entry preserved with null + _unmappedV1CriterionId ──
      const v2Judgment1a = await db.modelJudgment.findFirst({
        where: { runId: v2Run1!.id, overallScore: 8 },
      });
      expect(v2Judgment1a).toBeTruthy();
      expect(v2Judgment1a!.status).toBe('completed');
      expect(v2Judgment1a!.tokenCount).toBe(judgment1a.tokenCount);
      expect(v2Judgment1a!.samplingParams).toMatchObject({
        temperature: 0.3,
        max_tokens: 4096,
        source: 'v1-defaults',
      });
      const scores1a = v2Judgment1a!.criteriaScores as Array<Record<string, unknown>>;
      expect(scores1a[0]).toMatchObject({ criterionId: ids.criterion.get(f.crit1.id) });
      expect(scores1a[1]).toMatchObject({
        criterionId: null,
        _unmappedV1CriterionId: 'v1-criterion-does-not-exist',
      });

      // ── Judgment 1b: modelConfigId points at an ENSURED v2 ModelConfig
      // owned by archive (its v1 owner, userB, is dropped). ──
      const v2Judgment1b = await db.modelJudgment.findFirst({
        where: { runId: v2Run1!.id, overallScore: 6 },
        include: { modelConfig: true },
      });
      expect(v2Judgment1b!.modelConfig.userId).toBe(archiveUser!.id);
      expect(v2Judgment1b!.modelConfig.provider).toBe('openai');
      expect(v2Judgment1b!.modelConfig.modelId).toBe('gpt-4o');
      expect(v2Judgment1b!.modelConfig.slug).toBeNull();
      expect(v2Judgment1b!.modelConfig.apiKey).toBeNull();

      // judgeModelVersionId comes straight from the synthesized judges map.
      expect(v2Judgment1a!.judgeModelVersionId).toBe(judges.get(f.modelConfigA.id)!.versionId);
      expect(v2Judgment1b!.judgeModelVersionId).toBe(judges.get(f.modelConfigB.id)!.versionId);

      // Both judgments pin the same seeded v1-legacy PromptTemplate.
      const legacyTemplate = await db.promptTemplate.findUnique({ where: { name_version: { name: 'v1-legacy', version: 0 } } });
      expect(v2Judgment1a!.promptTemplateId).toBe(legacyTemplate!.id);
      expect(v2Judgment1b!.promptTemplateId).toBe(legacyTemplate!.id);

      // ── Human judgment 1: author (dropped) -> archive; criterion remapped; selectedBestModelId ensured ──
      const v2HumanJudgment1 = await db.humanJudgment.findUnique({ where: { runId: v2Run1!.id } });
      expect(v2HumanJudgment1!.userId).toBe(archiveUser!.id);
      expect(v2HumanJudgment1!.createdAt.getTime()).toBe(humanJudgment1.createdAt.getTime());
      const humanScores = v2HumanJudgment1!.criteriaScores as Array<Record<string, unknown>>;
      expect(humanScores[0]).toMatchObject({ criterionId: ids.criterion.get(f.crit1.id) });
      const v2ModelConfigA = await db.modelConfig.findFirst({ where: { userId: v2UserA, provider: 'anthropic' } });
      expect(v2HumanJudgment1!.selectedBestModelId).toBe(v2ModelConfigA!.id);

      // ── Judgment 2: stranded run forces its non-terminal judgment to error ──
      const v2Judgment2 = await db.modelJudgment.findFirst({ where: { runId: v2Run2!.id } });
      expect(v2Judgment2).toMatchObject({ status: 'error', error: 'v1-import: stranded' });

      // ── Report counts match the fixture arithmetic ──
      const counts = ctx.report.counts();
      expect(counts.EvaluationRun).toMatchObject({ created: 2 });
      expect(counts.ModelJudgment).toMatchObject({ created: 3 });
      expect(counts.HumanJudgment).toMatchObject({ created: 1 });
      expect(counts.ModelJudgmentCriteriaUnmapped).toMatchObject({ skipped: 1 });
      // modelConfigA (userA) + modelConfigB->archive: 2 ensured rows; the
      // human judgment's selectedBestModelId reuses modelConfigA's row from
      // the in-call cache (no additional DB round trip / tally).
      expect(counts.ModelConfig).toMatchObject({ created: 2 });

      expect(await db.evaluationRun.count()).toBe(2);
      expect(await db.modelJudgment.count()).toBe(3);
      expect(await db.humanJudgment.count()).toBe(1);
      expect(await db.modelConfig.count()).toBe(2);
    }
  );

  it('is idempotent in apply mode: re-running importRuns against the same v1 data leaves row counts stable', async () => {
    const f = await buildFixture();
    const run1 = await mkV1EvaluationRun(f.evalA.id, f.userA.id, { status: 'completed' });
    await mkV1ModelJudgment(run1.id, f.modelConfigA.id, { status: 'completed', overallScore: 9 });
    await mkV1HumanJudgment(run1.id, f.userA.id, { overallScore: 9 });

    const ctx1 = createImportCtx({ mode: 'apply', ownerMap: f.ownerMap });
    const owners1 = await resolveOwners(ctx1);
    const judges1 = await synthesizeJudges(ctx1, owners1);
    const ids1 = await importArtifacts(ctx1, owners1);
    await importRuns(ctx1, owners1, ids1, judges1);

    const ctx2 = createImportCtx({ mode: 'apply', ownerMap: f.ownerMap });
    const owners2 = await resolveOwners(ctx2);
    const judges2 = await synthesizeJudges(ctx2, owners2);
    const ids2 = await importArtifacts(ctx2, owners2);
    await importRuns(ctx2, owners2, ids2, judges2);

    expect(await db.evaluationRun.count()).toBe(1);
    expect(await db.modelJudgment.count()).toBe(1);
    expect(await db.humanJudgment.count()).toBe(1);
    expect(await db.modelConfig.count()).toBe(1);

    expect(ctx2.report.counts().EvaluationRun).toMatchObject({ created: 0, skipped: 1 });
    expect(ctx2.report.counts().ModelJudgment).toMatchObject({ created: 0, skipped: 1 });
    expect(ctx2.report.counts().HumanJudgment).toMatchObject({ created: 0, skipped: 1 });
  });

  it('a run under a dropped evaluation is dropped along with its judgments and human judgment', async () => {
    const f = await buildFixture();
    // A project owned by the dropped user never makes it into ids.project,
    // so an evaluation under it is dropped, and so is everything under that.
    const droppedProject = await mkV1Project(f.userB.id);
    const droppedEval = await mkV1Evaluation(droppedProject.id, f.userB.id);
    const droppedRun = await mkV1EvaluationRun(droppedEval.id, f.userB.id, { status: 'completed' });
    await mkV1ModelJudgment(droppedRun.id, f.modelConfigA.id, { status: 'completed' });
    await mkV1HumanJudgment(droppedRun.id, f.userB.id);

    const ctx = createImportCtx({ mode: 'apply', ownerMap: f.ownerMap });
    const owners = await resolveOwners(ctx);
    const judges = await synthesizeJudges(ctx, owners);
    const ids = await importArtifacts(ctx, owners);
    await importRuns(ctx, owners, ids, judges);

    expect(await db.evaluationRun.count()).toBe(0);
    expect(await db.modelJudgment.count()).toBe(0);
    expect(await db.humanJudgment.count()).toBe(0);
    expect(ctx.report.counts().EvaluationRun).toMatchObject({ dropped: 1 });
    expect(ctx.report.counts().ModelJudgment).toMatchObject({ dropped: 1 });
    expect(ctx.report.counts().HumanJudgment).toMatchObject({ dropped: 1 });
  });

  it('report mode tallies counts but writes nothing to v2', async () => {
    const f = await buildFixture();
    const run1 = await mkV1EvaluationRun(f.evalA.id, f.userA.id, { status: 'completed' });
    await mkV1ModelJudgment(run1.id, f.modelConfigA.id, { status: 'completed' });

    const ctx = createImportCtx({ mode: 'report', ownerMap: f.ownerMap });
    const owners = await resolveOwners(ctx);
    const judges = await synthesizeJudges(ctx, owners);
    const ids = await importArtifacts(ctx, owners);
    await importRuns(ctx, owners, ids, judges);

    expect(await db.evaluationRun.count()).toBe(0);
    expect(await db.modelJudgment.count()).toBe(0);
    expect(await db.modelConfig.count()).toBe(0);
    expect(ctx.report.counts().EvaluationRun).toMatchObject({ created: 1 });
    expect(ctx.report.counts().ModelJudgment).toMatchObject({ created: 1 });
  });

  it('throws a clear error when the seeded v1-legacy PromptTemplate is missing', async () => {
    // Deliberately skip seeding for this one test.
    await db.promptTemplate.deleteMany();

    const f = await buildFixture();
    const run1 = await mkV1EvaluationRun(f.evalA.id, f.userA.id, { status: 'completed' });
    await mkV1ModelJudgment(run1.id, f.modelConfigA.id, { status: 'completed' });

    const ctx = createImportCtx({ mode: 'apply', ownerMap: f.ownerMap });
    const owners = await resolveOwners(ctx);
    const judges = await synthesizeJudges(ctx, owners);
    const ids = await importArtifacts(ctx, owners);

    await expect(importRuns(ctx, owners, ids, judges)).rejects.toThrow(/v1-legacy/);
  });
});
