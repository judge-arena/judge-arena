import { describe, it, expect, beforeAll, beforeEach, afterAll, vi, type Mock } from 'vitest';
import { getServerSession } from 'next-auth';
import { db, truncateAll, mkUser, mkRubric } from './helpers';
import { prisma } from '@/lib/db';
import { launchCalibrationRun } from '@/lib/calibration/launch';
import { launchSingleRun } from '@/lib/run-launch';
import { seedPromptTemplates } from '../../prisma/seed-prompt-templates';

import { GET as getProject } from '@/app/api/projects/[id]/route';
import { GET as listRubrics } from '@/app/api/rubrics/route';
import { GET as getRubric } from '@/app/api/rubrics/[id]/route';
import { GET as getRunDetail } from '@/app/api/evaluations/[id]/runs/[runId]/route';
import { GET as getGoldenSet } from '@/app/api/golden-sets/[id]/route';

// ─── Task 9: the frontend reads N, not 2N (spec §2, DB) ─────────────────────
//
// "in the front-end and users point of view, they're all the same record but
// with a 'BA vs AB bias'" (owner, 2026-09-07). A permuted calibration
// launches TWO EvaluationRuns per golden item (pairOrder 'AB'/'BA') sharing
// ONE Evaluation (launch.ts D3). This file drives the REAL route handlers —
// not a raw Prisma query — against a real permuted calibration, so it proves
// the serializer a browser actually receives, not just the underlying SQL
// semantics (those are pinned separately in tests/lib/run-counting.test.ts).
//
// Mirrors tests/db/calibration-link.test.ts's local fixtures (that file's own
// stated convention: "shared only once actually shared" — these are small
// enough, and specific enough to route-handler auth mocking, that
// duplicating them here is the right call over a shared export) and
// tests/db/access-matrix.test.ts's "call the real handler, mock next-auth for
// the session" pattern.

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(),
}));
vi.mock('next/headers', () => ({
  headers: vi.fn(async () => new Headers()),
}));
vi.mock('@/lib/rate-limit-redis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rate-limit-redis')>();
  return {
    ...actual,
    apiLimiter: { check: vi.fn(async () => ({ ok: true, remaining: 999, resetAt: Date.now() + 60_000 })) },
  };
});

beforeAll(() => {
  if (!process.env.TEST_DATABASE_URL || process.env.DATABASE_URL !== process.env.TEST_DATABASE_URL) {
    throw new Error(
      'tests/db/calibration-frontend-projection.test.ts drives the src/lib prisma singleton ' +
        '(DATABASE_URL) against fixtures created on TEST_DATABASE_URL; they must be the same ' +
        'database. Run this via `npm run test:db`, which sources .env.test.'
    );
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

let counter = 0;
function uniq(label: string): string {
  counter += 1;
  return `${label}-${counter}`;
}

async function mkDataset(userId: string) {
  const name = uniq('fixture-dataset');
  return db.dataset.create({
    data: { name, slug: name, visibility: 'public', inputType: 'query-response', userId },
  });
}

async function mkGoldenSet(datasetId: string, ownerId: string) {
  const name = uniq('fixture-golden-set');
  return db.goldenSet.create({
    data: { name, slug: name, datasetId, protocol: 'pairwise', ownerId },
  });
}

async function mkGoldenItem(goldenSetId: string, datasetId: string, index: number) {
  const sample = await db.datasetSample.create({
    data: { datasetId, index, input: `question ${index}`, expected: 'A>B' },
  });
  return db.goldenItem.create({
    data: {
      goldenSetId,
      index,
      inputText: `question ${index}`,
      protocol: 'pairwise',
      expected: 'A>B',
      sourceDatasetSampleId: sample.id,
      candidates: {
        create: [
          { position: 0, responseText: `item ${index} candidate 0` },
          { position: 1, responseText: `item ${index} candidate 1` },
        ],
      },
    },
  });
}

async function mkJudgeVersionWithEndpoint(userId: string) {
  const name = uniq('fixture-judge');
  const judgeModel = await db.judgeModel.create({
    data: { name, slug: name, judgeClass: 'prompted_api', scoringMechanism: 'critique_generative' },
  });
  const version = await db.judgeModelVersion.create({
    data: {
      judgeModelId: judgeModel.id,
      ordinal: 1,
      servingBackend: 'openai',
      protocolSupport: { pairwise: ['preference'] },
    },
  });
  await db.modelEndpoint.create({
    data: { userId, judgeModelVersionId: version.id, isActive: true, verifiedAt: new Date() },
  });
  return version;
}

const noopPublish = async () => {};

describe('Task 9: run-detail/project/rubric surfaces read N, not 2N (DB)', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await truncateAll();
    await seedPromptTemplates(db);
  });

  it('GET /api/projects/[id]: a permuted calibration item counts as ONE run, and the canonical pick is the AB run', async () => {
    const user = await mkUser();
    const project = await db.project.create({ data: { name: 'fixture-project', userId: user.id } });
    const rubric = await mkRubric(user.id);
    const dataset = await mkDataset(user.id);
    const goldenSet = await mkGoldenSet(dataset.id, user.id);
    const item = await mkGoldenItem(goldenSet.id, dataset.id, 0);
    const version = await mkJudgeVersionWithEndpoint(user.id);

    const result = await launchCalibrationRun(
      {
        goldenSetId: goldenSet.id,
        judgeModelVersionId: version.id,
        rubricId: rubric.id,
        projectId: project.id,
        triggeredById: user.id,
        orders: ['AB', 'BA'],
      },
      { publish: noopPublish }
    );
    expect(result.failed).toEqual([]);

    const realRuns = await db.evaluationRun.findMany({ where: { calibrationRunId: result.calibrationRunId } });
    expect(realRuns).toHaveLength(2); // the raw table really does have 2N

    (getServerSession as unknown as Mock).mockResolvedValue({ user: { id: user.id } });
    const res = await getProject(new Request(`http://localhost/api/projects/${project.id}`), {
      params: Promise.resolve({ id: project.id }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.evaluations).toHaveLength(1); // Evaluation.count stays N (D3)
    const evaluation = body.evaluations[0];
    expect(evaluation._count.runs).toBe(1); // NOT 2 — the frontend truth this task exists for
    expect(evaluation.runs).toHaveLength(1);

    const abRun = realRuns.find((r) => r.pairOrder === 'AB')!;
    const baRun = realRuns.find((r) => r.pairOrder === 'BA')!;
    // BA is created after AB (launch.ts's `for (const order of orders)` loop
    // with orders === ['AB', 'BA']) — without canonicalOrderRunWhere,
    // `orderBy: createdAt desc, take: 1` would silently pick BA instead.
    expect(baRun.createdAt.getTime()).toBeGreaterThanOrEqual(abRun.createdAt.getTime());
    expect(evaluation.runs[0].id).toBe(abRun.id);
    void item;
  });

  it('an ordinary evaluation with 2 genuinely separate runs still counts 2 — the filter excludes BA only, never a real second run', async () => {
    const user = await mkUser();
    const project = await db.project.create({ data: { name: 'fixture-project', userId: user.id } });
    const rubric = await mkRubric(user.id);
    const evaluation = await db.evaluation.create({
      data: { projectId: project.id, userId: user.id, rubricId: rubric.id, inputText: 'q', responseText: 'a' },
    });
    // Two ordinary pointwise runs launched by hand — both pairOrder NULL.
    await db.evaluationRun.create({ data: { evaluationId: evaluation.id, triggeredById: user.id } });
    await db.evaluationRun.create({ data: { evaluationId: evaluation.id, triggeredById: user.id } });

    (getServerSession as unknown as Mock).mockResolvedValue({ user: { id: user.id } });
    const res = await getProject(new Request(`http://localhost/api/projects/${project.id}`), {
      params: Promise.resolve({ id: project.id }),
    });
    const body = await res.json();

    const projected = body.evaluations.find((e: { id: string }) => e.id === evaluation.id);
    expect(projected._count.runs).toBe(2);
  });

  it('GET /api/rubrics and GET /api/rubrics/[id]: evaluationRuns reads N, not 2N, for a rubric used by a permuted calibration', async () => {
    const user = await mkUser();
    const project = await db.project.create({ data: { name: 'fixture-project', userId: user.id } });
    const rubric = await mkRubric(user.id);
    const dataset = await mkDataset(user.id);
    const goldenSet = await mkGoldenSet(dataset.id, user.id);
    await mkGoldenItem(goldenSet.id, dataset.id, 0);
    await mkGoldenItem(goldenSet.id, dataset.id, 1);
    const version = await mkJudgeVersionWithEndpoint(user.id);

    const result = await launchCalibrationRun(
      {
        goldenSetId: goldenSet.id,
        judgeModelVersionId: version.id,
        rubricId: rubric.id,
        projectId: project.id,
        triggeredById: user.id,
        orders: ['AB', 'BA'],
      },
      { publish: noopPublish }
    );
    expect(result.failed).toEqual([]);
    expect(await db.evaluationRun.count({ where: { calibrationRunId: result.calibrationRunId } })).toBe(4); // 2 items x 2 orders

    (getServerSession as unknown as Mock).mockResolvedValue({ user: { id: user.id } });

    const listRes = await listRubrics();
    const list = await listRes.json();
    const listed = list.find((r: { id: string }) => r.id === rubric.id);
    expect(listed._count.evaluationRuns).toBe(2); // N items, not 2N runs

    const detailRes = await getRubric(new Request(`http://localhost/api/rubrics/${rubric.id}`), {
      params: Promise.resolve({ id: rubric.id }),
    });
    const detail = await detailRes.json();
    expect(detail._count.evaluationRuns).toBe(2);
  });

  it('GET /api/evaluations/[id]/runs/[runId]: attaches the sibling for a calibration pair, and null for an ordinary run', async () => {
    const user = await mkUser();
    const project = await db.project.create({ data: { name: 'fixture-project', userId: user.id } });
    const rubric = await mkRubric(user.id);
    const dataset = await mkDataset(user.id);
    const goldenSet = await mkGoldenSet(dataset.id, user.id);
    await mkGoldenItem(goldenSet.id, dataset.id, 0);
    const version = await mkJudgeVersionWithEndpoint(user.id);

    const result = await launchCalibrationRun(
      {
        goldenSetId: goldenSet.id,
        judgeModelVersionId: version.id,
        rubricId: rubric.id,
        projectId: project.id,
        triggeredById: user.id,
        orders: ['AB', 'BA'],
      },
      { publish: noopPublish }
    );
    expect(result.failed).toEqual([]);
    const runs = await db.evaluationRun.findMany({ where: { calibrationRunId: result.calibrationRunId } });
    const abRun = runs.find((r) => r.pairOrder === 'AB')!;
    const baRun = runs.find((r) => r.pairOrder === 'BA')!;

    (getServerSession as unknown as Mock).mockResolvedValue({ user: { id: user.id } });

    const abRes = await getRunDetail(new Request(`http://localhost/api/evaluations/${abRun.evaluationId}/runs/${abRun.id}`), {
      params: Promise.resolve({ id: abRun.evaluationId, runId: abRun.id }),
    });
    const abBody = await abRes.json();
    expect(abBody.pairedRun).not.toBeNull();
    expect(abBody.pairedRun.id).toBe(baRun.id);
    expect(abBody.pairedRun.pairOrder).toBe('BA');

    const baRes = await getRunDetail(new Request(`http://localhost/api/evaluations/${baRun.evaluationId}/runs/${baRun.id}`), {
      params: Promise.resolve({ id: baRun.evaluationId, runId: baRun.id }),
    });
    const baBody = await baRes.json();
    expect(baBody.pairedRun.id).toBe(abRun.id);
    expect(baBody.pairedRun.pairOrder).toBe('AB');

    // An ordinary run (launched by hand, no calibrationRunId) gets no sibling.
    const evaluation = await db.evaluation.create({
      data: { projectId: project.id, userId: user.id, rubricId: rubric.id, inputText: 'q', responseText: 'a' },
    });
    const ordinaryLaunch = await launchSingleRun(
      {
        evaluationId: evaluation.id,
        triggeredById: user.id,
        rubricId: rubric.id,
        judgeModelVersionIds: [version.id],
      },
      { publish: noopPublish }
    );
    const ordinaryRes = await getRunDetail(
      new Request(`http://localhost/api/evaluations/${evaluation.id}/runs/${ordinaryLaunch.run.id}`),
      { params: Promise.resolve({ id: evaluation.id, runId: ordinaryLaunch.run.id }) }
    );
    const ordinaryBody = await ordinaryRes.json();
    expect(ordinaryBody.pairedRun).toBeNull();
  });

  it('a permuted calibration does NOT move the golden set item count — GET /api/golden-sets/[id] still reads N items (verified, not assumed)', async () => {
    const user = await mkUser();
    const project = await db.project.create({ data: { name: 'fixture-project', userId: user.id } });
    const rubric = await mkRubric(user.id);
    const dataset = await mkDataset(user.id);
    const goldenSet = await mkGoldenSet(dataset.id, user.id);
    await mkGoldenItem(goldenSet.id, dataset.id, 0);
    await mkGoldenItem(goldenSet.id, dataset.id, 1);
    await mkGoldenItem(goldenSet.id, dataset.id, 2);
    const version = await mkJudgeVersionWithEndpoint(user.id);

    (getServerSession as unknown as Mock).mockResolvedValue({ user: { id: user.id } });

    const before = await getGoldenSet(new Request(`http://localhost/api/golden-sets/${goldenSet.id}`), {
      params: Promise.resolve({ id: goldenSet.id }),
    });
    const beforeBody = await before.json();
    expect(beforeBody._count.items).toBe(3);

    const result = await launchCalibrationRun(
      {
        goldenSetId: goldenSet.id,
        judgeModelVersionId: version.id,
        rubricId: rubric.id,
        projectId: project.id,
        triggeredById: user.id,
        orders: ['AB', 'BA'],
      },
      { publish: noopPublish }
    );
    expect(result.failed).toEqual([]);
    expect(await db.evaluationRun.count({ where: { calibrationRunId: result.calibrationRunId } })).toBe(6); // 3 items x 2 orders

    const after = await getGoldenSet(new Request(`http://localhost/api/golden-sets/${goldenSet.id}`), {
      params: Promise.resolve({ id: goldenSet.id }),
    });
    const afterBody = await after.json();
    // Still 3 — GoldenItem is never created or touched by a calibration
    // launch (spec §2: "The GoldenSet and its item count are untouched").
    expect(afterBody._count.items).toBe(3);
    expect(afterBody.items).toHaveLength(3);
  });
});
