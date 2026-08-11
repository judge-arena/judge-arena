import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';

import { seedAll, PLATFORM_USER_EMAIL } from '../../prisma/seed-core';
import { JUDGEBENCH_DATASET_ID } from '../../prisma/seed-judgebench';

import { db, truncateAll } from './helpers';

/**
 * These are regression guards on the things the seeder must NOT do, not a
 * restatement of what it does. Each one corresponds to a specific defect that
 * shipped in the previous seeder and would be silent if it came back:
 * password accounts in a public deployment, operator-funded endpoints, fake
 * run history, and duplicate rows on a second run.
 */
describe('prisma seed', () => {
  beforeAll(() => {
    // The seeder is chatty by design when run by a human; that noise buries
    // the test output. Assertions read the database, never the log.
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  beforeEach(async () => {
    await truncateAll();
  });

  it('creates no credentials accounts — only a platform user that cannot log in', async () => {
    await seedAll(db);

    const users = await db.user.findMany();
    expect(users).toHaveLength(1);
    expect(users[0].email).toBe(PLATFORM_USER_EMAIL);

    // The old seeder shipped admin@judgearena.local / demo@judgearena.local
    // with the passwords `admin123` / `demo1234`.
    const seededEmails = users.map((u) => u.email);
    expect(seededEmails).not.toContain('admin@judgearena.local');
    expect(seededEmails).not.toContain('demo@judgearena.local');

    // A bcrypt hash is `$2a$`/`$2b$`-prefixed. The sentinel deliberately is
    // not one, so no password can ever compare true against this row.
    expect(users[0].passwordHash?.startsWith('$2')).toBe(false);
  });

  it('creates no ModelEndpoints — endpoints are BYOK and per-user', async () => {
    await seedAll(db);

    // The old seeder created three keyless anthropic endpoints marked
    // verifiedAt, which resolve through the operator's ANTHROPIC_API_KEY and
    // so silently bill the operator for every run made through them.
    await expect(db.modelEndpoint.count()).resolves.toBe(0);

    // The shared catalog they hung off must still be there — it is what the
    // UI selects from, and an empty catalog is the blocker this seeder exists
    // to clear.
    await expect(db.judgeModel.count()).resolves.toBe(3);
    await expect(db.judgeModelVersion.count()).resolves.toBe(3);
  });

  it('creates no evaluations or runs, so run counts stay meaningful', async () => {
    await seedAll(db);

    // The old seeder left an EvaluationRun at status `pending`, which made
    // `EvaluationRun > 0` stop being evidence that anything had ever run.
    await expect(db.evaluation.count()).resolves.toBe(0);
    await expect(db.evaluationRun.count()).resolves.toBe(0);
  });

  it('publishes JudgeBench to every user, with both splits and ground-truth labels', async () => {
    await seedAll(db);

    const dataset = await db.dataset.findUnique({ where: { id: JUDGEBENCH_DATASET_ID } });
    expect(dataset).not.toBeNull();
    expect(dataset?.visibility).toBe('public');
    expect(dataset?.publishedAt).not.toBeNull();
    expect(dataset?.huggingFaceId).toBe('ScalerLab/JudgeBench');

    const samples = await db.datasetSample.findMany({
      where: { datasetId: JUDGEBENCH_DATASET_ID },
      orderBy: { index: 'asc' },
    });
    expect(samples).toHaveLength(620);
    expect(dataset?.sampleCount).toBe(620);

    // Every row must carry a ground-truth label; a sample without one is
    // useless as calibration substrate.
    expect(samples.every((s) => s.expected === 'A>B' || s.expected === 'B>A')).toBe(true);

    // Both response families are present — seeding only one would bias any
    // judge calibrated against it toward that family's style.
    const splits = new Set(
      samples.map((s) => (JSON.parse(s.metadata ?? '{}') as { split?: string }).split)
    );
    expect(splits).toEqual(new Set(['gpt', 'claude']));

    // The pair itself is preserved losslessly, because `input` holds only the
    // question — the runtime has no pairwise protocol yet, so this is where
    // the responses have to live for A0's golden-set import to find them.
    const first = JSON.parse(samples[0].metadata ?? '{}') as Record<string, unknown>;
    expect(first.response_A).toBeTruthy();
    expect(first.response_B).toBeTruthy();
    expect(samples[0].input).toBeTruthy();
  });

  it('is idempotent — a second run adds nothing', async () => {
    await seedAll(db);

    const before = {
      users: await db.user.count(),
      rubrics: await db.rubric.count(),
      criteria: await db.rubricCriterion.count(),
      judgeModels: await db.judgeModel.count(),
      projects: await db.project.count(),
      datasets: await db.dataset.count(),
      samples: await db.datasetSample.count(),
      templates: await db.promptTemplate.count(),
    };

    await seedAll(db);

    // The old seeder used bare `create` for the rubric and the sample
    // project/evaluation/run, so a re-seed duplicated them. This ships inside
    // the image and may well be invoked more than once.
    await expect(db.user.count()).resolves.toBe(before.users);
    await expect(db.rubric.count()).resolves.toBe(before.rubrics);
    await expect(db.rubricCriterion.count()).resolves.toBe(before.criteria);
    await expect(db.judgeModel.count()).resolves.toBe(before.judgeModels);
    await expect(db.project.count()).resolves.toBe(before.projects);
    await expect(db.dataset.count()).resolves.toBe(before.datasets);
    await expect(db.datasetSample.count()).resolves.toBe(before.samples);
    await expect(db.promptTemplate.count()).resolves.toBe(before.templates);
  });
});
