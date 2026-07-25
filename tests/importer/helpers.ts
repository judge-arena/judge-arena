import { Prisma, PrismaClient as V1PrismaClient } from '@prisma/v1-client';

// ─── v1-side test helpers ───────────────────────────────────────────────────
// Mirrors tests/db/helpers.ts's `db`/`truncateAll`/`mkUser` shape, but points
// at the disposable v1 scratch database (V1_DATABASE_URL) that
// scripts/importer/** reads from — see prisma/v1/schema.v1.prisma. Used only
// by the *.db.test.ts specs in tests/importer/** (see vitest.db.config.ts);
// plain `npm test` never imports this file.

export const v1db = new V1PrismaClient({
  datasources: { db: { url: process.env.V1_DATABASE_URL } },
});

let v1UserCounter = 0;

export async function mkV1User(overrides: Partial<Prisma.UserUncheckedCreateInput> = {}) {
  v1UserCounter += 1;
  return v1db.user.create({
    data: {
      email: `v1-fixture-user-${v1UserCounter}@test.local`,
      passwordHash: 'v1-fixture-hash',
      ...overrides,
    },
  });
}

let v1ModelConfigCounter = 0;

export async function mkV1ModelConfig(
  userId: string,
  overrides: Partial<Omit<Prisma.ModelConfigUncheckedCreateInput, 'userId'>> = {}
) {
  v1ModelConfigCounter += 1;
  return v1db.modelConfig.create({
    data: {
      name: `v1-fixture-config-${v1ModelConfigCounter}`,
      provider: 'anthropic',
      modelId: 'claude-3-opus',
      userId,
      ...overrides,
    },
  });
}

// ─── Task 9 fixture helpers (artifacts + runs/judgments) ───────────────────
// Same counter-per-entity, sensible-defaults-plus-overrides shape as above.

let v1ProjectCounter = 0;

export async function mkV1Project(
  userId: string,
  overrides: Partial<Omit<Prisma.ProjectUncheckedCreateInput, 'userId'>> = {}
) {
  v1ProjectCounter += 1;
  return v1db.project.create({
    data: { name: `v1-fixture-project-${v1ProjectCounter}`, userId, ...overrides },
  });
}

let v1RubricCounter = 0;

export async function mkV1Rubric(
  userId: string,
  overrides: Partial<Omit<Prisma.RubricUncheckedCreateInput, 'userId'>> = {}
) {
  v1RubricCounter += 1;
  return v1db.rubric.create({
    data: { name: `v1-fixture-rubric-${v1RubricCounter}`, userId, ...overrides },
  });
}

let v1RubricCriterionCounter = 0;

export async function mkV1RubricCriterion(
  rubricId: string,
  overrides: Partial<Omit<Prisma.RubricCriterionUncheckedCreateInput, 'rubricId'>> = {}
) {
  v1RubricCriterionCounter += 1;
  return v1db.rubricCriterion.create({
    data: {
      rubricId,
      name: `v1-fixture-criterion-${v1RubricCriterionCounter}`,
      description: 'fixture criterion',
      ...overrides,
    },
  });
}

let v1DatasetCounter = 0;

export async function mkV1Dataset(
  userId: string,
  overrides: Partial<Omit<Prisma.DatasetUncheckedCreateInput, 'userId'>> = {}
) {
  v1DatasetCounter += 1;
  return v1db.dataset.create({
    data: { name: `v1-fixture-dataset-${v1DatasetCounter}`, userId, ...overrides },
  });
}

export async function mkV1DatasetSample(
  datasetId: string,
  index: number,
  overrides: Partial<Omit<Prisma.DatasetSampleUncheckedCreateInput, 'datasetId' | 'index'>> = {}
) {
  return v1db.datasetSample.create({
    data: { datasetId, index, input: `v1-fixture-sample-input-${index}`, ...overrides },
  });
}

let v1EvaluationCounter = 0;

export async function mkV1Evaluation(
  projectId: string,
  userId: string,
  overrides: Partial<Omit<Prisma.EvaluationUncheckedCreateInput, 'projectId' | 'userId'>> = {}
) {
  v1EvaluationCounter += 1;
  return v1db.evaluation.create({
    data: { projectId, userId, inputText: `v1-fixture-eval-input-${v1EvaluationCounter}`, ...overrides },
  });
}

export async function mkV1EvaluationRun(
  evaluationId: string,
  triggeredById: string,
  overrides: Partial<Omit<Prisma.EvaluationRunUncheckedCreateInput, 'evaluationId' | 'triggeredById'>> = {}
) {
  return v1db.evaluationRun.create({ data: { evaluationId, triggeredById, ...overrides } });
}

export async function mkV1ModelJudgment(
  runId: string,
  modelConfigId: string,
  overrides: Partial<Omit<Prisma.ModelJudgmentUncheckedCreateInput, 'runId' | 'modelConfigId'>> = {}
) {
  return v1db.modelJudgment.create({ data: { runId, modelConfigId, ...overrides } });
}

export async function mkV1HumanJudgment(
  runId: string,
  userId: string,
  overrides: Partial<Omit<Prisma.HumanJudgmentUncheckedCreateInput, 'runId' | 'userId'>> = {}
) {
  return v1db.humanJudgment.create({
    data: { runId, userId, overallScore: 8, ...overrides },
  });
}

/**
 * Truncates every table in the v1 scratch database's `public` schema
 * (except Prisma's own migrations bookkeeping table) and restarts identity
 * sequences — the v1 counterpart of tests/db/helpers.ts's `truncateAll`.
 * `npm run test:db`'s `prisma migrate reset` only touches the v2 schema
 * (DATABASE_URL), so this is the only thing that resets the v1 scratch DB
 * between tests.
 */
export async function truncateAllV1(): Promise<void> {
  const tables = await v1db.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename != '_prisma_migrations'
  `;

  if (tables.length === 0) return;

  const tableList = tables.map((t) => `"${t.tablename}"`).join(', ');
  await v1db.$executeRawUnsafe(`TRUNCATE TABLE ${tableList} RESTART IDENTITY CASCADE`);
}
