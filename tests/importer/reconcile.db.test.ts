import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createImportCtx } from '../../scripts/importer/context';
import { resolveOwners, ARCHIVE_USER_EMAIL } from '../../scripts/importer/owners';
import { synthesizeJudges } from '../../scripts/importer/judges';
import { importArtifacts } from '../../scripts/importer/artifacts';
import { importRuns } from '../../scripts/importer/runs';
import { reconcile } from '../../scripts/importer/reconcile';
import { runImport } from '../../scripts/importer/cli';
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
import type { ImportCtx, OwnerMap } from '../../scripts/importer/context';

// DB-backed: needs BOTH the v1 scratch DB (V1_DATABASE_URL) and the v2 test
// DB (DATABASE_URL/TEST_DATABASE_URL) reachable. Named *.db.test.ts and
// listed in vitest.db.config.ts's include (NOT vitest.config.ts's), so
// plain `npm test` never runs this file — see tests/importer/helpers.ts.
describe('reconcile (DB)', () => {
  // reconcile() itself fires a dozen-plus concurrent v1+v2 queries per call
  // (see computeRowCounts's Promise.all) — noticeably more connection
  // pressure than the other tests/importer/**/*.db.test.ts files' plain
  // find/create fixtures. Left undisconnected (the pattern those other
  // files use, relying on process exit), enough ctxs pile up across this
  // file's several tests to exhaust Postgres's max_connections before the
  // file finishes. Every ctx this file creates is tracked here and
  // disconnected in afterEach instead.
  let liveCtxs: ImportCtx[] = [];

  beforeEach(async () => {
    await truncateAll();
    await truncateAllV1();
    const { seedPromptTemplates } = await import('../../prisma/seed-prompt-templates');
    await seedPromptTemplates(db);
  });

  afterEach(async () => {
    await Promise.all(liveCtxs.map((ctx) => Promise.all([ctx.v1.$disconnect(), ctx.v2.$disconnect()])));
    liveCtxs = [];
  });

  afterAll(async () => {
    await v1db.$disconnect();
    await db.$disconnect();
  });

  /**
   * A fixture deliberately touching all 14 rowCounts entities and both
   * "drop" paths (explicit ownerMap 'drop' on a private artifact; an
   * isDefault project falling back to archive) so the clean-run assertion
   * below ("all entities accounted") is a real exercise, not a vacuous one:
   *
   *   - userA: mapped/kept.               userB: explicit 'drop'.
   *   - 3 v1 ModelConfigs -> 3 distinct (provider,modelId,endpoint) triples:
   *     configA (userA, referenced by a surviving judgment), configB
   *     (userB, referenced by a surviving judgment -> ensured under
   *     archive), configC (userB, never referenced by any judgment at all).
   *   - project (userA, survives), droppedProject (userB, dropped),
   *     defaultProject (userB, isDefault -> archived + public).
   *   - rubric (userA, 2 criteria, survives), droppedRubric (userB, dropped
   *     with its 1 criterion — no archive path for Rubric).
   *   - dataset (userA, 2 samples, survives), droppedDataset (userB,
   *     private, dropped with its 1 sample).
   *   - evaluation (userA, survives) with a run (completed, 2 judgments +
   *     1 human judgment); droppedEvaluation (under droppedProject,
   *     cascades away) with its own run + judgment + human judgment.
   */
  async function buildFixture() {
    const userA = await mkV1User();
    const userB = await mkV1User();
    const ownerMap: OwnerMap = {
      [userA.id]: { email: 'a@v2.example', oidcIssuer: 'https://idp.test.local', oidcSubject: 'sub-a' },
      [userB.id]: 'drop',
    };

    const configA = await mkV1ModelConfig(userA.id, { provider: 'anthropic', modelId: 'claude-3-opus' });
    const configB = await mkV1ModelConfig(userB.id, { provider: 'openai', modelId: 'gpt-4o' });
    const configC = await mkV1ModelConfig(userB.id, { provider: 'local', modelId: 'llama-3' });

    const project = await mkV1Project(userA.id, { name: 'Main project' });
    const droppedProject = await mkV1Project(userB.id, { name: 'Dropped project' });
    const defaultProject = await mkV1Project(userB.id, { name: 'Leaderboard', isDefault: true });

    const rubric = await mkV1Rubric(userA.id, { name: 'Quality' });
    const crit1 = await mkV1RubricCriterion(rubric.id, { name: 'Accuracy', order: 0 });
    const crit2 = await mkV1RubricCriterion(rubric.id, { name: 'Clarity', order: 1 });

    const droppedRubric = await mkV1Rubric(userB.id, { name: 'Owned by dropped user' });
    await mkV1RubricCriterion(droppedRubric.id, { name: 'N/A' });

    const dataset = await mkV1Dataset(userA.id, { name: 'Eval set', projectId: project.id, visibility: 'private' });
    const sample1 = await mkV1DatasetSample(dataset.id, 0, { input: 'q1', expected: 'a1' });
    await mkV1DatasetSample(dataset.id, 1, { input: 'q2', expected: 'a2' });

    const droppedDataset = await mkV1Dataset(userB.id, { visibility: 'private' });
    await mkV1DatasetSample(droppedDataset.id, 0);

    const evaluation = await mkV1Evaluation(project.id, userA.id, {
      title: 'Surviving eval',
      rubricId: rubric.id,
      datasetId: dataset.id,
      datasetSampleId: sample1.id,
    });
    const droppedEvaluation = await mkV1Evaluation(droppedProject.id, userB.id, {
      title: 'Dropped-with-its-project eval',
    });

    return {
      userA,
      userB,
      ownerMap,
      configA,
      configB,
      configC,
      project,
      droppedProject,
      defaultProject,
      rubric,
      crit1,
      crit2,
      droppedRubric,
      dataset,
      sample1,
      droppedDataset,
      evaluation,
      droppedEvaluation,
    };
  }

  /** Runs the full phase pipeline (owners -> judges -> artifacts -> runs)
   * against a shared ctx, so ctx.report accumulates every phase's tallies
   * together — exactly how cli.ts's runImport threads one ctx through all
   * four phases before calling reconcile. */
  async function runFullPipeline(ownerMap: OwnerMap) {
    const ctx = createImportCtx({ mode: 'apply', ownerMap });
    liveCtxs.push(ctx);
    const owners = await resolveOwners(ctx);
    const judges = await synthesizeJudges(ctx, owners);
    const ids = await importArtifacts(ctx, owners);
    await importRuns(ctx, owners, ids, judges);
    return { ctx, owners, judges, ids };
  }

  it('clean full-pipeline fixture: reconcile is ok:true with every rowCount and spotCheck accounted', async () => {
    const f = await buildFixture();

    const run = await mkV1EvaluationRun(f.evaluation.id, f.userA.id, { status: 'completed' });
    const judgment1 = await mkV1ModelJudgment(run.id, f.configA.id, {
      status: 'completed',
      overallScore: 8,
      criteriaScores: JSON.stringify([
        { criterionId: f.crit1.id, criterionName: 'Accuracy', score: 8, maxScore: 10, weight: 1 },
      ]),
    });
    await mkV1ModelJudgment(run.id, f.configB.id, {
      status: 'completed',
      overallScore: 6,
      criteriaScores: JSON.stringify([
        { criterionId: f.crit2.id, criterionName: 'Clarity', score: 6, maxScore: 10, weight: 1 },
      ]),
    });
    await mkV1HumanJudgment(run.id, f.userA.id, { overallScore: 7, selectedBestModelId: judgment1.modelConfigId });

    // Everything under droppedEvaluation cascades away (its own project was
    // dropped) — exercises non-zero EvaluationRun/ModelJudgment/HumanJudgment
    // 'dropped' tallies, not just the trivial all-zero case.
    const droppedRun = await mkV1EvaluationRun(f.droppedEvaluation.id, f.userB.id, { status: 'completed' });
    await mkV1ModelJudgment(droppedRun.id, f.configA.id, { status: 'completed', overallScore: 5 });
    await mkV1HumanJudgment(droppedRun.id, f.userB.id, { overallScore: 5 });

    const { ctx, ids } = await runFullPipeline(f.ownerMap);
    const result = await reconcile(ctx, ids);

    const entities = result.rowCounts.map((r) => r.entity);
    expect(entities).toEqual([
      'User',
      'JudgeModel',
      'JudgeModelVersion',
      'ModelEndpoint',
      'ModelConfig',
      'Project',
      'Rubric',
      'RubricCriterion',
      'Dataset',
      'DatasetSample',
      'Evaluation',
      'EvaluationRun',
      'ModelJudgment',
      'HumanJudgment',
    ]);

    for (const row of result.rowCounts) {
      expect(row.ok, `rowCount ${row.entity} expected ok, got ${JSON.stringify(row)}`).toBe(true);
    }
    for (const check of result.spotChecks) {
      expect(check.ok, `spotCheck ${check.name} expected ok, got ${JSON.stringify(check)}`).toBe(true);
    }
    expect(result.ok).toBe(true);

    // Spot a few concrete numbers so this isn't just "every ok flag is true"
    // (which a formula that always agrees with itself could satisfy).
    const byEntity = Object.fromEntries(result.rowCounts.map((r) => [r.entity, r]));
    expect(byEntity.User).toMatchObject({ v1: 2, v2: 2 });
    expect(byEntity.JudgeModel).toMatchObject({ v1: 3, v2: 3 });
    expect(byEntity.JudgeModelVersion).toMatchObject({ v1: 3, v2: 3 });
    expect(byEntity.ModelEndpoint).toMatchObject({ v1: 1, v2: 1 });
    expect(byEntity.ModelConfig).toMatchObject({ v2: 2 });
    expect(byEntity.Project).toMatchObject({ v1: 3, v2: 2 });
    expect(byEntity.Rubric).toMatchObject({ v1: 2, v2: 1 });
    expect(byEntity.RubricCriterion).toMatchObject({ v1: 3, v2: 2 });
    expect(byEntity.Dataset).toMatchObject({ v1: 2, v2: 1 });
    expect(byEntity.DatasetSample).toMatchObject({ v1: 3, v2: 2 });
    expect(byEntity.Evaluation).toMatchObject({ v1: 2, v2: 1 });
    expect(byEntity.EvaluationRun).toMatchObject({ v1: 2, v2: 1, expectedDelta: 1 });
    expect(byEntity.ModelJudgment).toMatchObject({ v1: 3, v2: 2, expectedDelta: 1 });
    expect(byEntity.HumanJudgment).toMatchObject({ v1: 2, v2: 1, expectedDelta: 1 });
  });

  it('injected mismatch: deleting a v2 ModelJudgment after import flips reconcile to ok:false with the ModelJudgment row flagged', async () => {
    const f = await buildFixture();
    const run = await mkV1EvaluationRun(f.evaluation.id, f.userA.id, { status: 'completed' });
    await mkV1ModelJudgment(run.id, f.configA.id, { status: 'completed', overallScore: 8 });
    await mkV1ModelJudgment(run.id, f.configB.id, { status: 'completed', overallScore: 6 });

    const { ctx, ids } = await runFullPipeline(f.ownerMap);

    // Sanity: clean state reconciles ok before we tamper.
    const before = await reconcile(ctx, ids);
    expect(before.ok).toBe(true);

    // Simulate an external mismatch (e.g. a botched manual fix, a crashed
    // partial rollback) — NOT something the importer itself did, and
    // therefore invisible to ctx.report's tallies.
    const victim = await db.modelJudgment.findFirstOrThrow();
    await db.modelJudgment.delete({ where: { id: victim.id } });

    const after = await reconcile(ctx, ids);
    expect(after.ok).toBe(false);

    const judgmentRow = after.rowCounts.find((r) => r.entity === 'ModelJudgment')!;
    expect(judgmentRow.ok).toBe(false);
    expect(judgmentRow.v2).toBe(judgmentRow.v1 - judgmentRow.expectedDelta - 1);

    // Every OTHER rowCount is unaffected by deleting one ModelJudgment.
    for (const row of after.rowCounts) {
      if (row.entity === 'ModelJudgment') continue;
      expect(row.ok, `rowCount ${row.entity} unexpectedly flipped to not-ok`).toBe(true);
    }
  });

  it('dropped-user leakage: a clean fixture with a dropped user reconciles ok; manually inserting a v2 User with the dropped email flips ok:false', async () => {
    const f = await buildFixture();
    const run = await mkV1EvaluationRun(f.evaluation.id, f.userA.id, { status: 'completed' });
    await mkV1ModelJudgment(run.id, f.configA.id, { status: 'completed', overallScore: 8 });

    const { ctx, ids } = await runFullPipeline(f.ownerMap);

    const clean = await reconcile(ctx, ids);
    expect(clean.ok).toBe(true);
    const cleanLeakCheck = clean.spotChecks.find((s) => s.name === 'no-v1-owner-leakage')!;
    expect(cleanLeakCheck.ok).toBe(true);

    // The dropped user's v1 email resurfaces as a real v2 User row — exactly
    // the leak spot check 4 exists to catch (it must never let a dropped
    // user's identity re-materialize under its own email).
    await db.user.create({ data: { email: f.userB.email, passwordHash: 'leaked-in' } });

    const tampered = await reconcile(ctx, ids);
    expect(tampered.ok).toBe(false);
    const leakCheck = tampered.spotChecks.find((s) => s.name === 'no-v1-owner-leakage')!;
    expect(leakCheck.ok).toBe(false);
    expect(leakCheck.detail).toMatch(/1 dropped-user email/);
  });

  it('runImport (apply mode, real DB): clean import returns exitCode 0 and prints an OK reconciliation report', async () => {
    const f = await buildFixture();
    const run = await mkV1EvaluationRun(f.evaluation.id, f.userA.id, { status: 'completed' });
    await mkV1ModelJudgment(run.id, f.configA.id, { status: 'completed', overallScore: 8 });

    const tmpDir = mkdtempSync(join(tmpdir(), 'judge-arena-owner-map-'));
    const ownerMapPath = join(tmpDir, 'owners.json');
    writeFileSync(ownerMapPath, JSON.stringify(f.ownerMap));

    try {
      const result = await runImport(['--mode=apply', `--owner-map=${ownerMapPath}`]);
      expect(result).toEqual({ exitCode: 0 });
      expect(await db.evaluationRun.count()).toBe(1);
      expect(await db.modelJudgment.count()).toBe(1);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('runImport (apply mode, real DB): a pre-existing owner leak makes reconcile fail, forcing exitCode 1', async () => {
    const f = await buildFixture();
    const run = await mkV1EvaluationRun(f.evaluation.id, f.userA.id, { status: 'completed' });
    await mkV1ModelJudgment(run.id, f.configA.id, { status: 'completed', overallScore: 8 });

    // Pre-seed v2 with the dropped user's v1 email BEFORE the import runs.
    // assertApplyAllowed only guards on existing Project rows, so this
    // doesn't trip the pre-existing-data guard — the import proceeds
    // normally, writes everything correctly, and it's reconcile's spot
    // check 4 that catches the leak and forces the non-zero exit.
    await db.user.create({ data: { email: f.userB.email, passwordHash: 'pre-existing-leak' } });

    const tmpDir = mkdtempSync(join(tmpdir(), 'judge-arena-owner-map-'));
    const ownerMapPath = join(tmpDir, 'owners.json');
    writeFileSync(ownerMapPath, JSON.stringify(f.ownerMap));

    try {
      const result = await runImport(['--mode=apply', `--owner-map=${ownerMapPath}`]);
      expect(result).toEqual({ exitCode: 1 });
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('report mode: reconcile is never called (report-mode phases only tally what an apply run would do)', async () => {
    const f = await buildFixture();
    const run = await mkV1EvaluationRun(f.evaluation.id, f.userA.id, { status: 'completed' });
    await mkV1ModelJudgment(run.id, f.configA.id, { status: 'completed', overallScore: 8 });

    const tmpDir = mkdtempSync(join(tmpdir(), 'judge-arena-owner-map-'));
    const ownerMapPath = join(tmpDir, 'owners.json');
    writeFileSync(ownerMapPath, JSON.stringify(f.ownerMap));

    try {
      const result = await runImport(['--mode=report', `--owner-map=${ownerMapPath}`]);
      expect(result).toEqual({ exitCode: 0 });
      // Report mode never writes — real v2 tables stay empty.
      expect(await db.evaluationRun.count()).toBe(0);
      expect(await db.modelJudgment.count()).toBe(0);
      expect(await db.user.findUnique({ where: { email: ARCHIVE_USER_EMAIL } })).toBeNull();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
