import { describe, it, expect, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';
import { db, truncateAll, mkUser } from './helpers';
import { GET } from '@/app/api/leaderboard/route';
import { refreshDatasetEvaluationSummary } from '@/lib/dataset-evaluation-summary';
import { tombstoneDataset, tombstoneSample } from '@/lib/tombstones';

// ─── Local fixture helpers ──────────────────────────────────────────────────
// Project/Evaluation/EvaluationRun/ModelJudgment/HumanJudgment/Dataset chain
// needed for both the leaderboard aggregation tests and the
// dataset-evaluation-summary respond-mode tests. Kept file-local per the
// established "shared only once actually shared" convention (see e.g.
// human-judgment-score.test.ts, meta-eval.test.ts).

async function mkProject(
  userId: string,
  overrides: Partial<Omit<Prisma.ProjectUncheckedCreateInput, 'userId'>> = {}
) {
  return db.project.create({
    data: { name: 'fixture-leaderboard-project', userId, ...overrides },
  });
}

async function mkModelConfig(
  userId: string,
  overrides: Partial<Omit<Prisma.ModelConfigUncheckedCreateInput, 'userId'>> = {}
) {
  return db.modelConfig.create({
    data: { name: 'fixture-model', provider: 'openai', modelId: 'gpt-4', userId, ...overrides },
  });
}

async function mkEvaluation(
  projectId: string,
  userId: string,
  overrides: Partial<Omit<Prisma.EvaluationUncheckedCreateInput, 'projectId' | 'userId'>> = {}
) {
  return db.evaluation.create({
    data: { projectId, userId, inputText: 'fixture input', ...overrides },
  });
}

async function mkEvaluationRun(
  evaluationId: string,
  overrides: Partial<Omit<Prisma.EvaluationRunUncheckedCreateInput, 'evaluationId'>> = {}
) {
  return db.evaluationRun.create({
    data: { evaluationId, ...overrides },
  });
}

async function mkModelJudgment(
  runId: string,
  modelConfigId: string,
  overrides: Partial<Omit<Prisma.ModelJudgmentUncheckedCreateInput, 'runId' | 'modelConfigId'>> = {}
) {
  return db.modelJudgment.create({
    data: { runId, modelConfigId, status: 'completed', ...overrides },
  });
}

async function mkHumanJudgment(
  runId: string,
  userId: string,
  overrides: Partial<Omit<Prisma.HumanJudgmentUncheckedCreateInput, 'runId' | 'userId'>> = {}
) {
  return db.humanJudgment.create({
    data: { runId, userId, overallScore: 0, ...overrides },
  });
}

async function mkDataset(
  userId: string,
  overrides: Partial<Omit<Prisma.DatasetUncheckedCreateInput, 'userId'>> = {}
) {
  return db.dataset.create({ data: { name: 'fixture-dataset', userId, ...overrides } });
}

const OLDER = new Date('2026-01-01T00:00:00.000Z');
const NEWER = new Date('2026-02-01T00:00:00.000Z');

describe('Leaderboard API: latest-finalized-run aggregation', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it('re-run: older completed run is excluded, only the newer completed run\'s judgment counts', async () => {
    const user = await mkUser();
    const project = await mkProject(user.id, { isDefault: true });
    const model = await mkModelConfig(user.id, { name: 'Model A' });
    const evaluation = await mkEvaluation(project.id, user.id, { responseText: 'some response' });

    const oldRun = await mkEvaluationRun(evaluation.id, { status: 'completed', createdAt: OLDER });
    await mkModelJudgment(oldRun.id, model.id, { overallScore: 3 });

    const newRun = await mkEvaluationRun(evaluation.id, { status: 'completed', createdAt: NEWER });
    await mkModelJudgment(newRun.id, model.id, { overallScore: 9 });

    const response = await GET();
    const data = await response.json();

    expect(data.models).toHaveLength(1);
    expect(data.models[0].avgScore).toBe(9); // NOT the average of 3 and 9
    expect(data.models[0].evaluationCount).toBe(1);
    expect(data.totalJudgments).toBe(1);
  });

  it('needs_human counts as finalized: a newer needs_human run wins over an older completed run', async () => {
    const user = await mkUser();
    const project = await mkProject(user.id, { isDefault: true });
    const model = await mkModelConfig(user.id, { name: 'Model B' });
    const evaluation = await mkEvaluation(project.id, user.id, { responseText: 'some response' });

    const oldRun = await mkEvaluationRun(evaluation.id, { status: 'completed', createdAt: OLDER });
    await mkModelJudgment(oldRun.id, model.id, { overallScore: 3 });

    const newRun = await mkEvaluationRun(evaluation.id, { status: 'needs_human', createdAt: NEWER });
    await mkModelJudgment(newRun.id, model.id, { overallScore: 8 });

    const response = await GET();
    const data = await response.json();

    expect(data.models).toHaveLength(1);
    expect(data.models[0].avgScore).toBe(8);
    expect(data.models[0].evaluationCount).toBe(1);
  });

  it('a non-finalized latest run (error) is skipped entirely — the older completed run still counts', async () => {
    const user = await mkUser();
    const project = await mkProject(user.id, { isDefault: true });
    const model = await mkModelConfig(user.id, { name: 'Model C' });
    const evaluation = await mkEvaluation(project.id, user.id, { responseText: 'some response' });

    const oldRun = await mkEvaluationRun(evaluation.id, { status: 'completed', createdAt: OLDER });
    await mkModelJudgment(oldRun.id, model.id, { overallScore: 6 });

    // Chronologically the latest run, but never reached a finalized status
    // (all its judgments errored) — the WHERE-status-first query must skip
    // it entirely and fall back to the older completed run, rather than
    // "latest run wins, then filter its judgments" (which would produce an
    // empty result for this evaluation instead).
    const newRun = await mkEvaluationRun(evaluation.id, { status: 'error', createdAt: NEWER });
    await mkModelJudgment(newRun.id, model.id, { status: 'error', overallScore: null });

    const response = await GET();
    const data = await response.json();

    expect(data.models).toHaveLength(1);
    expect(data.models[0].avgScore).toBe(6);
    expect(data.models[0].evaluationCount).toBe(1);
  });

  it('pending/judging runs (no judgments yet) contribute nothing and do not error', async () => {
    const user = await mkUser();
    const project = await mkProject(user.id, { isDefault: true });
    const evaluation = await mkEvaluation(project.id, user.id, { responseText: 'some response' });
    await mkEvaluationRun(evaluation.id, { status: 'pending', createdAt: NEWER });

    const response = await GET();
    const data = await response.json();

    expect(data.models).toHaveLength(0);
    expect(data.totalJudgments).toBe(0);
    expect(data.lastUpdated).toBeNull();
  });

  it('deterministic tie-break: identical createdAt on two runs picks the same (higher-id) run consistently', async () => {
    const user = await mkUser();
    const project = await mkProject(user.id, { isDefault: true });
    const model = await mkModelConfig(user.id, { name: 'Model TieBreak' });
    const evaluation = await mkEvaluation(project.id, user.id, { responseText: 'some response' });

    // Two runs with IDENTICAL createdAt — DISTINCT ON needs a secondary
    // deterministic key (id DESC) to ensure the same run is picked consistently
    const identical = new Date('2026-03-15T12:00:00.000Z');
    const run1 = await mkEvaluationRun(evaluation.id, { status: 'completed', createdAt: identical });
    await mkModelJudgment(run1.id, model.id, { overallScore: 5 });

    const run2 = await mkEvaluationRun(evaluation.id, { status: 'completed', createdAt: identical });
    await mkModelJudgment(run2.id, model.id, { overallScore: 9 });

    // Determine which run has the higher ID — that's the one the query should pick
    const higherIdRun = run1.id > run2.id ? run1 : run2;
    const expectedScore = higherIdRun.id === run1.id ? 5 : 9;

    // Run the query 5 times to confirm consistency
    const results: number[] = [];
    for (let i = 0; i < 5; i++) {
      const response = await GET();
      const data = await response.json();
      expect(data.models).toHaveLength(1);
      results.push(data.models[0].avgScore);
    }

    // All 5 queries should return the same score (deterministic)
    expect(new Set(results).size).toBe(1);
    // The score should be from the run with the higher ID
    expect(results[0]).toBe(expectedScore);
  });
});

describe('Dataset evaluation summary: averageHumanScore excludes respond-mode placeholder zeros', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it('respond-mode judgment (placeholder 0 + selectedBestModelId) is excluded from averageHumanScore; the row itself is untouched', async () => {
    const user = await mkUser();
    const project = await mkProject(user.id);
    const dataset = await mkDataset(user.id);
    const bestModel = await mkModelConfig(user.id, { name: 'Best Model' });

    // responseText left unset → respond mode, matching the human-judgment
    // route's own derivation (`responseText?.trim() ? 'judge' : 'respond'`).
    const evaluation = await mkEvaluation(project.id, user.id, {
      responseText: null,
      datasetId: dataset.id,
    });
    const run = await mkEvaluationRun(evaluation.id, { status: 'completed' });
    await mkHumanJudgment(run.id, user.id, {
      overallScore: 0,
      selectedBestModelId: bestModel.id,
    });

    await refreshDatasetEvaluationSummary(dataset.id);

    const updated = await db.dataset.findUnique({ where: { id: dataset.id } });
    const summary = JSON.parse(updated!.remoteMetadata!).evaluationSummary;

    expect(summary.sampleCount).toBe(1);
    expect(summary.samplesWithHumanScores).toBe(0);
    expect(summary.averageHumanScore).toBeNull();

    // Excluded from the AVERAGE only — the judgment row (and its
    // selectedBestModelId, respond mode's actual signal) is untouched.
    const persisted = await db.humanJudgment.findUnique({ where: { runId: run.id } });
    expect(persisted?.overallScore).toBe(0);
    expect(persisted?.selectedBestModelId).toBe(bestModel.id);
  });

  it('judge-mode judgment is included in averageHumanScore', async () => {
    const user = await mkUser();
    const project = await mkProject(user.id);
    const dataset = await mkDataset(user.id);

    const evaluation = await mkEvaluation(project.id, user.id, {
      responseText: 'an actual response',
      datasetId: dataset.id,
    });
    const run = await mkEvaluationRun(evaluation.id, { status: 'completed' });
    await mkHumanJudgment(run.id, user.id, { overallScore: 7.5 });

    await refreshDatasetEvaluationSummary(dataset.id);

    const updated = await db.dataset.findUnique({ where: { id: dataset.id } });
    const summary = JSON.parse(updated!.remoteMetadata!).evaluationSummary;

    expect(summary.samplesWithHumanScores).toBe(1);
    expect(summary.averageHumanScore).toBe(7.5);
  });

  it('mixed dataset: one judge-mode + one respond-mode sample → average reflects only the judge-mode sample', async () => {
    const user = await mkUser();
    const project = await mkProject(user.id);
    const dataset = await mkDataset(user.id);
    const bestModel = await mkModelConfig(user.id, { name: 'Best Model 2' });

    const judgeEval = await mkEvaluation(project.id, user.id, {
      responseText: 'an actual response',
      datasetId: dataset.id,
    });
    const judgeRun = await mkEvaluationRun(judgeEval.id, { status: 'completed' });
    await mkHumanJudgment(judgeRun.id, user.id, { overallScore: 4 });

    const respondEval = await mkEvaluation(project.id, user.id, {
      responseText: null,
      datasetId: dataset.id,
    });
    const respondRun = await mkEvaluationRun(respondEval.id, { status: 'completed' });
    await mkHumanJudgment(respondRun.id, user.id, {
      overallScore: 0,
      selectedBestModelId: bestModel.id,
    });

    await refreshDatasetEvaluationSummary(dataset.id);

    const updated = await db.dataset.findUnique({ where: { id: dataset.id } });
    const summary = JSON.parse(updated!.remoteMetadata!).evaluationSummary;

    expect(summary.sampleCount).toBe(2);
    expect(summary.samplesWithHumanScores).toBe(1);
    expect(summary.averageHumanScore).toBe(4);
  });
});

/**
 * A1 wave 1 — a decision, pinned rather than left to be rediscovered.
 *
 * `refreshDatasetEvaluationSummary` aggregates over `Evaluation`, which the
 * tombstone overlay never hides, and writes the result to
 * `Dataset.remoteMetadata` where it PERSISTS. Whether hiding a sample should
 * retract the judgments made against it was undecided and untested either way.
 * The decision is that it should not — the reasoning is in the module — and
 * this test exists so the alternative cannot be adopted silently.
 */
describe('Dataset evaluation summary vs. the tombstone overlay (A1 wave 1)', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it('a HIDDEN sample\'s judgments still count — the summary describes the evaluations, not the live corpus', async () => {
    const user = await mkUser();
    const project = await mkProject(user.id);
    const dataset = await mkDataset(user.id, { sampleCount: 2 });
    const model = await mkModelConfig(user.id);

    const samples = await Promise.all([
      db.datasetSample.create({ data: { datasetId: dataset.id, index: 0, input: 'q0' } }),
      db.datasetSample.create({ data: { datasetId: dataset.id, index: 1, input: 'q1' } }),
    ]);

    for (const [i, sample] of samples.entries()) {
      const evaluation = await mkEvaluation(project.id, user.id, {
        responseText: 'an actual response',
        datasetId: dataset.id,
        datasetSampleId: sample.id,
      });
      const run = await mkEvaluationRun(evaluation.id, { status: 'completed' });
      await mkModelJudgment(run.id, model.id, { overallScore: i === 0 ? 2 : 8 });
    }

    // Withdraw the first row, through the one definition of hidden.
    await tombstoneSample(db, samples[0].id, 'summary decision fixture');
    await db.dataset.update({ where: { id: dataset.id }, data: { sampleCount: 1 } });

    await refreshDatasetEvaluationSummary(dataset.id);

    const updated = await db.dataset.findUniqueOrThrow({ where: { id: dataset.id } });
    const summary = JSON.parse(updated.remoteMetadata!).evaluationSummary;

    // BOTH judgments are still counted, and the average is still the mean of
    // both. Filtering on sample liveness would give 1 / 8.
    expect(summary.sampleCount).toBe(2);
    expect(summary.samplesWithModelScores).toBe(2);
    expect(summary.averageModelScore).toBe(5);

    // The stated cost, asserted rather than described: the summary's count
    // exceeds the corpus's live `sampleCount`. They measure different things.
    expect(summary.samplesWithModelScores).toBeGreaterThan(updated.sampleCount!);
  });

  it('a hidden DATASET does not zero its own persisted summary', async () => {
    // The third reason in the module doc, made concrete. `liveSamplesOnly()`
    // carries decision 16's parent arm, so spreading it into that read would
    // make a straggler run finalizing after a dataset delete overwrite the
    // persisted aggregate with zeroes — destroying data on a delete the
    // overlay calls reversible.
    const user = await mkUser();
    const project = await mkProject(user.id);
    const dataset = await mkDataset(user.id, { sampleCount: 1 });
    const model = await mkModelConfig(user.id);

    const sample = await db.datasetSample.create({
      data: { datasetId: dataset.id, index: 0, input: 'q0' },
    });
    const evaluation = await mkEvaluation(project.id, user.id, {
      responseText: 'an actual response',
      datasetId: dataset.id,
      datasetSampleId: sample.id,
    });
    const run = await mkEvaluationRun(evaluation.id, { status: 'completed' });
    await mkModelJudgment(run.id, model.id, { overallScore: 6 });

    await tombstoneDataset(db, dataset.id, 'summary decision fixture');
    await refreshDatasetEvaluationSummary(dataset.id);

    const updated = await db.dataset.findUniqueOrThrow({ where: { id: dataset.id } });
    const summary = JSON.parse(updated.remoteMetadata!).evaluationSummary;
    expect(summary.samplesWithModelScores).toBe(1);
    expect(summary.averageModelScore).toBe(6);
  });
});
