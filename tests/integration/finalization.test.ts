import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Channel, ConsumeMessage } from 'amqplib';
import { prisma } from '@/lib/db';
import { closeRabbit, getRabbit } from '@/lib/queue/connection';
import { assertTopology, QUEUE_JUDGMENT_EXECUTE } from '@/lib/queue/topology';
import type { JudgmentExecuteMsg } from '@/lib/queue/publish';
import { getConnectedRedis } from '@/lib/redis';
import { maybeFinalizeRun, markRunCompleted } from '@/lib/run-finalizer';
import { runReaperSweep, REAPER_LOCK_KEY } from '@/worker/reaper';
import { LEASE_MS } from '@/worker/claim';
import { createJudgmentConsumer, type ProviderFn, type RunProviderJudgmentInput } from '@/worker/judgment-consumer';
import { seedPromptTemplates } from '../../prisma/seed-prompt-templates';

// Integration suite (Task 8) — needs a live Postgres (tests/db/**'s
// `judge_arena_test` DB, already migrated) AND a live Redis (the reaper's
// cluster-wide lock) AND a live RabbitMQ (the reaper's own republish, and
// draining `judgment.execute` to prove it). Run via `npm run test:integration`.
//
// Fixture/fake helpers below intentionally mirror
// tests/integration/worker-claims.test.ts's own file-local conventions
// (fakeMessage/fakeChannel/drainQueue, uniq(), per-test cleanup arrays) —
// established "shared only once actually shared" pattern, not duplicated by
// oversight.

// ─── Fake amqplib primitives ────────────────────────────────────────────────

function fakeMessage(payload: unknown): ConsumeMessage {
  return {
    content: Buffer.from(JSON.stringify(payload)),
    fields: {} as ConsumeMessage['fields'],
    properties: {} as ConsumeMessage['properties'],
  } as ConsumeMessage;
}

interface SpyChannel extends Channel {
  ackCalls: ConsumeMessage[];
  nackCalls: Array<{ msg: ConsumeMessage; allUpTo: boolean; requeue: boolean }>;
}

function fakeChannel(): SpyChannel {
  const ackCalls: ConsumeMessage[] = [];
  const nackCalls: SpyChannel['nackCalls'] = [];
  return {
    ack: (msg: ConsumeMessage) => {
      ackCalls.push(msg);
    },
    nack: (msg: ConsumeMessage, allUpTo?: boolean, requeue?: boolean) => {
      nackCalls.push({ msg, allUpTo: Boolean(allUpTo), requeue: Boolean(requeue) });
    },
    ackCalls,
    nackCalls,
  } as unknown as SpyChannel;
}

function fakeProvider(
  callLog: RunProviderJudgmentInput[],
  overrides: Partial<Awaited<ReturnType<ProviderFn>>> = {}
): ProviderFn {
  return async (input) => {
    callLog.push(input);
    return {
      overallScore: 8,
      reasoning: 'fixture reasoning',
      criteriaScores: [],
      rawResponse: 'fixture raw response',
      latencyMs: 42,
      tokenCount: 100,
      ...overrides,
    };
  };
}

/** Consumes messages off `queue` until `quietMs` elapses with no new
 * message, then cancels and returns everything collected. Every collected
 * message is acked (draining, not just peeking). */
async function drainQueue(ch: Channel, queue: string, quietMs = 400): Promise<ConsumeMessage[]> {
  const messages: ConsumeMessage[] = [];
  let consumerTag: string | undefined;

  await new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout>;
    const resetTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const cleanup = consumerTag ? ch.cancel(consumerTag).catch(() => {}) : Promise.resolve();
        void cleanup.finally(resolve);
      }, quietMs);
    };

    ch.consume(
      queue,
      (msg) => {
        if (!msg) return;
        messages.push(msg);
        ch.ack(msg);
        resetTimer();
      },
      { noAck: false }
    ).then((ok) => {
      consumerTag = ok.consumerTag;
      resetTimer();
    });
  });

  return messages;
}

// ─── Fixture helpers ────────────────────────────────────────────────────────

const createdUserIds: string[] = [];
const createdJudgeModelIds: string[] = [];
const createdVersionIds: string[] = [];
const createdRunIds: string[] = [];
const createdDatasetIds: string[] = [];

let uniqCounter = 0;
function uniq(label: string): string {
  uniqCounter += 1;
  return `${label}-${Date.now()}-${uniqCounter}`;
}

async function mkUser() {
  const user = await prisma.user.create({
    data: { email: `${uniq('finalization-user')}@test.local`, passwordHash: 'fixture-hash' },
  });
  createdUserIds.push(user.id);
  return user;
}

async function mkProject(userId: string) {
  return prisma.project.create({ data: { name: 'fixture-project', userId } });
}

async function mkDataset(userId: string, overrides: Partial<{ remoteMetadata: string | null }> = {}) {
  const dataset = await prisma.dataset.create({
    data: { name: uniq('fixture-dataset'), userId, ...overrides },
  });
  createdDatasetIds.push(dataset.id);
  return dataset;
}

async function mkEvaluation(
  projectId: string,
  userId: string,
  overrides: Partial<{ datasetId: string | null }> = {}
) {
  // responseText set -> judge mode (src/lib/run-mode.ts's deriveRunMode) —
  // this suite's one judgment-consumer call site (below) injects a
  // judge-mode fake provider with a rubric attached; every other test here
  // manipulates ModelJudgment/EvaluationRun rows directly and never goes
  // through mode-sensitive code at all.
  return prisma.evaluation.create({
    data: { projectId, userId, inputText: 'fixture input', responseText: 'fixture response under judgment', ...overrides },
  });
}

async function mkRubric(userId: string) {
  return prisma.rubric.create({
    data: {
      name: uniq('fixture-rubric'),
      userId,
      criteria: {
        create: [{ name: 'Accuracy', description: 'How accurate the response is', maxScore: 10, weight: 1, order: 0 }],
      },
    },
  });
}

async function mkEvaluationRun(
  evaluationId: string,
  triggeredById: string,
  rubricId: string,
  overrides: Partial<{
    status: 'pending' | 'judging' | 'needs_human' | 'completed' | 'error';
    deadlineAt: Date | null;
    finalizedAt: Date | null;
  }> = {}
) {
  const run = await prisma.evaluationRun.create({
    data: { evaluationId, triggeredById, rubricId, ...overrides },
  });
  createdRunIds.push(run.id);
  return run;
}

async function mkJudgeModelVersion() {
  const judgeModel = await prisma.judgeModel.create({
    data: {
      name: uniq('fixture-judge'),
      slug: uniq('fixture-judge'),
      judgeClass: 'prompted_api',
      scoringMechanism: 'critique_generative',
      baseModel: 'fixture-model-id',
    },
  });
  createdJudgeModelIds.push(judgeModel.id);

  const version = await prisma.judgeModelVersion.create({
    data: {
      judgeModelId: judgeModel.id,
      ordinal: 1,
      servingBackend: 'openai',
      protocolSupport: { pointwise: ['score'] },
    },
  });
  createdVersionIds.push(version.id);

  return { judgeModel, version };
}

async function mkEndpoint(userId: string, judgeModelVersionId: string) {
  return prisma.modelEndpoint.create({ data: { userId, judgeModelVersionId, isActive: true } });
}

async function mkJudgment(
  runId: string,
  judgeModelVersionId: string,
  promptTemplateId: string,
  overrides: Partial<{
    status: 'pending' | 'running' | 'completed' | 'error';
    overallScore: number | null;
    attemptCount: number;
    updatedAt: Date;
  }> = {}
) {
  const { updatedAt, ...data } = overrides;
  const judgment = await prisma.modelJudgment.create({
    data: { runId, judgeModelVersionId, promptTemplateId, status: 'pending', ...data },
  });
  if (updatedAt) {
    await prisma.$executeRaw`UPDATE "ModelJudgment" SET "updatedAt" = ${updatedAt} WHERE id = ${judgment.id}`;
    return prisma.modelJudgment.findUniqueOrThrow({ where: { id: judgment.id } });
  }
  return judgment;
}

interface BaseFixture {
  user: Awaited<ReturnType<typeof mkUser>>;
  project: Awaited<ReturnType<typeof mkProject>>;
  rubric: Awaited<ReturnType<typeof mkRubric>>;
  version: Awaited<ReturnType<typeof mkJudgeModelVersion>>['version'];
  promptTemplateId: string;
}

async function createBaseFixture(): Promise<BaseFixture> {
  const user = await mkUser();
  const project = await mkProject(user.id);
  const rubric = await mkRubric(user.id);
  const { version } = await mkJudgeModelVersion();
  await mkEndpoint(user.id, version.id);
  const promptTemplate = await seedPromptTemplates(prisma);
  return { user, project, rubric, version, promptTemplateId: promptTemplate.id };
}

async function clearReaperLock(): Promise<void> {
  const client = await getConnectedRedis();
  await client.del(REAPER_LOCK_KEY);
}

beforeEach(async () => {
  await clearReaperLock();
});

afterAll(async () => {
  // FK-safe order — same reasoning as worker-claims.test.ts's own afterAll:
  // runs before users (unblocks Rubric's Restrict), users before versions
  // (ModelEndpoint cascades with its user), versions before judge models.
  await prisma.evaluationRun.deleteMany({ where: { id: { in: createdRunIds } } });
  await prisma.dataset.deleteMany({ where: { id: { in: createdDatasetIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.judgeModelVersion.deleteMany({ where: { id: { in: createdVersionIds } } });
  await prisma.judgeModel.deleteMany({ where: { id: { in: createdJudgeModelIds } } });

  await clearReaperLock();
  await closeRabbit();
  await prisma.$disconnect();
});

describe('maybeFinalizeRun (src/lib/run-finalizer.ts)', () => {
  it(
    'dual-completion race: two concurrent maybeFinalizeRun calls on a run whose last two ' +
      'judgments just completed -> exactly one non-null (terminal) result, finalizedAt set once',
    async () => {
      for (let i = 0; i < 5; i += 1) {
        const base = await createBaseFixture();
        const evaluation = await mkEvaluation(base.project.id, base.user.id);
        const run = await mkEvaluationRun(evaluation.id, base.user.id, base.rubric.id, { status: 'judging' });

        // Both judgments already completed — simulates the last two
        // judgment.completed events landing at nearly the same instant,
        // each triggering its own safeFinalizeRun -> maybeFinalizeRun(runId).
        await mkJudgment(run.id, base.version.id, base.promptTemplateId, {
          status: 'completed',
          overallScore: 7,
        });
        const { version: version2 } = await mkJudgeModelVersion();
        await mkJudgment(run.id, version2.id, base.promptTemplateId, {
          status: 'completed',
          overallScore: 9,
        });

        // eslint-disable-next-line no-await-in-loop -- intentionally sequential fixture setup between loop iterations; the concurrency under test is the Promise.all below
        const [a, b] = await Promise.all([maybeFinalizeRun(run.id), maybeFinalizeRun(run.id)]);
        const results = [a, b];

        expect(results.filter((r) => r !== null)).toHaveLength(1);
        expect(results).toContain('needs_human');

        // eslint-disable-next-line no-await-in-loop -- verifying this iteration's outcome before starting the next
        const persisted = await prisma.evaluationRun.findUniqueOrThrow({ where: { id: run.id } });
        expect(persisted.status).toBe('needs_human');
        expect(persisted.finalizedAt).not.toBeNull();
      }
    },
    20_000
  );

  it('a run with pending/running judgments remaining is not finalized (returns null, status untouched)', async () => {
    const base = await createBaseFixture();
    const evaluation = await mkEvaluation(base.project.id, base.user.id);
    const run = await mkEvaluationRun(evaluation.id, base.user.id, base.rubric.id, { status: 'judging' });
    await mkJudgment(run.id, base.version.id, base.promptTemplateId, { status: 'completed', overallScore: 7 });
    const { version: version2 } = await mkJudgeModelVersion();
    await mkJudgment(run.id, version2.id, base.promptTemplateId, { status: 'pending' });

    const result = await maybeFinalizeRun(run.id);
    expect(result).toBeNull();

    const persisted = await prisma.evaluationRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(persisted.status).toBe('judging');
    expect(persisted.finalizedAt).toBeNull();
  });

  it('a run whose judgments are all error (zero completed) finalizes to error', async () => {
    const base = await createBaseFixture();
    const evaluation = await mkEvaluation(base.project.id, base.user.id);
    const run = await mkEvaluationRun(evaluation.id, base.user.id, base.rubric.id, { status: 'judging' });
    await mkJudgment(run.id, base.version.id, base.promptTemplateId, { status: 'error' });

    const result = await maybeFinalizeRun(run.id);
    expect(result).toBe('error');

    const persisted = await prisma.evaluationRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(persisted.status).toBe('error');
    expect(persisted.finalizedAt).not.toBeNull();
  });

  it('a run already in a terminal state (needs_human) is a guarded no-op — returns null, untouched', async () => {
    const base = await createBaseFixture();
    const evaluation = await mkEvaluation(base.project.id, base.user.id);
    const finalizedAt = new Date('2026-01-01T00:00:00.000Z');
    const run = await mkEvaluationRun(evaluation.id, base.user.id, base.rubric.id, {
      status: 'needs_human',
      finalizedAt,
    });

    const result = await maybeFinalizeRun(run.id);
    expect(result).toBeNull();

    const persisted = await prisma.evaluationRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(persisted.status).toBe('needs_human');
    expect(persisted.finalizedAt?.getTime()).toBe(finalizedAt.getTime()); // untouched, not re-stamped
  });
});

describe('markRunCompleted (src/lib/run-finalizer.ts)', () => {
  it('needs_human -> completed: updates exactly one row and stamps finalizedAt', async () => {
    const base = await createBaseFixture();
    const evaluation = await mkEvaluation(base.project.id, base.user.id);
    const run = await mkEvaluationRun(evaluation.id, base.user.id, base.rubric.id, { status: 'needs_human' });

    const count = await markRunCompleted(run.id);
    expect(count).toBe(1);

    const persisted = await prisma.evaluationRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(persisted.status).toBe('completed');
    expect(persisted.finalizedAt).not.toBeNull();
  });

  it('completed -> needs_human regression guard: calling markRunCompleted on an already-completed run is a no-op (count 0)', async () => {
    const base = await createBaseFixture();
    const evaluation = await mkEvaluation(base.project.id, base.user.id);
    const finalizedAt = new Date('2026-01-01T00:00:00.000Z');
    const run = await mkEvaluationRun(evaluation.id, base.user.id, base.rubric.id, {
      status: 'completed',
      finalizedAt,
    });

    const count = await markRunCompleted(run.id);
    expect(count).toBe(0);

    const persisted = await prisma.evaluationRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(persisted.status).toBe('completed'); // unchanged, never regressed
    expect(persisted.finalizedAt?.getTime()).toBe(finalizedAt.getTime()); // untouched
  });

  it('a run still pending/judging (automated judging not finished) is NOT completable via markRunCompleted', async () => {
    const base = await createBaseFixture();
    const evaluation = await mkEvaluation(base.project.id, base.user.id);
    const run = await mkEvaluationRun(evaluation.id, base.user.id, base.rubric.id, { status: 'judging' });

    const count = await markRunCompleted(run.id);
    expect(count).toBe(0);

    const persisted = await prisma.evaluationRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(persisted.status).toBe('judging');
  });
});

describe('reaper (src/worker/reaper.ts): stale-judgment resweep end-to-end', () => {
  it('a stale running judgment is reset to pending and republished by the reaper, then a worker consumer completes it', async () => {
    const base = await createBaseFixture();
    const evaluation = await mkEvaluation(base.project.id, base.user.id);
    const run = await mkEvaluationRun(evaluation.id, base.user.id, base.rubric.id, { status: 'judging' });

    const staleUpdatedAt = new Date(Date.now() - LEASE_MS - 5_000);
    const judgment = await mkJudgment(run.id, base.version.id, base.promptTemplateId, {
      status: 'running',
      attemptCount: 1,
      updatedAt: staleUpdatedAt,
    });

    const { confirmChannel } = await getRabbit();
    await assertTopology(confirmChannel);
    await confirmChannel.purgeQueue(QUEUE_JUDGMENT_EXECUTE);

    await runReaperSweep();

    const afterSweep = await prisma.modelJudgment.findUniqueOrThrow({ where: { id: judgment.id } });
    expect(afterSweep.status).toBe('pending');
    expect(afterSweep.attemptCount).toBe(1); // reaper does NOT bump attemptCount — see reaper.ts's doc

    const published = await drainQueue(confirmChannel, QUEUE_JUDGMENT_EXECUTE);
    expect(published).toHaveLength(1);
    const republished = JSON.parse(published[0].content.toString()) as JudgmentExecuteMsg;
    expect(republished.judgmentId).toBe(judgment.id);
    expect(republished.runId).toBe(run.id);
    expect(republished.attempt).toBe(2); // attemptCount (1) + 1

    // Simulate the worker consuming the republished message — same pattern
    // worker-claims.test.ts uses (handle() called directly against a
    // hand-built message, fake provider).
    const calls: RunProviderJudgmentInput[] = [];
    const consumer = createJudgmentConsumer({ provider: fakeProvider(calls) });
    const ch = fakeChannel();
    await consumer.handle(fakeMessage(republished), ch);

    expect(calls).toHaveLength(1);
    expect(ch.ackCalls).toHaveLength(1);

    const completed = await prisma.modelJudgment.findUniqueOrThrow({ where: { id: judgment.id } });
    expect(completed.status).toBe('completed');
    expect(completed.attemptCount).toBe(2); // claimJudgment's own increment on this (re)claim

    // This was the run's only judgment — the consumer's own finalization
    // pass should have flipped the run too.
    const persistedRun = await prisma.evaluationRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(persistedRun.status).toBe('needs_human');
  });

  it('a running judgment still within its lease is left untouched by the reaper', async () => {
    const base = await createBaseFixture();
    const evaluation = await mkEvaluation(base.project.id, base.user.id);
    const run = await mkEvaluationRun(evaluation.id, base.user.id, base.rubric.id, { status: 'judging' });
    const judgment = await mkJudgment(run.id, base.version.id, base.promptTemplateId, {
      status: 'running',
      attemptCount: 1,
    });

    const { confirmChannel } = await getRabbit();
    await assertTopology(confirmChannel);
    await confirmChannel.purgeQueue(QUEUE_JUDGMENT_EXECUTE);

    await runReaperSweep();

    const afterSweep = await prisma.modelJudgment.findUniqueOrThrow({ where: { id: judgment.id } });
    expect(afterSweep.status).toBe('running'); // untouched — well within LEASE_MS

    const published = await drainQueue(confirmChannel, QUEUE_JUDGMENT_EXECUTE, 200);
    expect(published).toHaveLength(0);
  });
});

describe('reaper (src/worker/reaper.ts): overdue-run handling', () => {
  it('an overdue run within the force-finalize grace period re-publishes judgment.execute for its still-pending judgments', async () => {
    const base = await createBaseFixture();
    const evaluation = await mkEvaluation(base.project.id, base.user.id);
    // Overdue (deadline in the past) but recently so — well inside the
    // 3-sweep (~180s) force-finalize grace window.
    const deadlineAt = new Date(Date.now() - 5_000);
    const run = await mkEvaluationRun(evaluation.id, base.user.id, base.rubric.id, {
      status: 'judging',
      deadlineAt,
    });
    const judgment = await mkJudgment(run.id, base.version.id, base.promptTemplateId, {
      status: 'pending',
      attemptCount: 0,
    });

    const { confirmChannel } = await getRabbit();
    await assertTopology(confirmChannel);
    await confirmChannel.purgeQueue(QUEUE_JUDGMENT_EXECUTE);

    await runReaperSweep();

    const afterSweep = await prisma.modelJudgment.findUniqueOrThrow({ where: { id: judgment.id } });
    expect(afterSweep.status).toBe('pending'); // not force-errored — still within grace

    const persistedRun = await prisma.evaluationRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(persistedRun.status).toBe('judging'); // not finalized yet

    const published = await drainQueue(confirmChannel, QUEUE_JUDGMENT_EXECUTE);
    const relevant = published.filter(
      (m) => (JSON.parse(m.content.toString()) as JudgmentExecuteMsg).judgmentId === judgment.id
    );
    expect(relevant).toHaveLength(1);
    expect(relevant[0]).toBeDefined();
    const republished = JSON.parse(relevant[0].content.toString()) as JudgmentExecuteMsg;
    expect(republished.attempt).toBe(1); // attemptCount (0) + 1

    // This run stays overdue (deadlineAt is still in the past, still within
    // grace) — left as-is, it would keep getting re-swept by every later
    // test's runReaperSweep() call in this same persistent-DB suite,
    // re-publishing yet another judgment.execute for it each time. Force it
    // out of the "overdue pending/judging" population directly (not via the
    // reaper) so it doesn't pollute later tests' own queue assertions.
    await prisma.evaluationRun.update({ where: { id: run.id }, data: { status: 'error' } });
  });

  it('an overdue run past the force-finalize grace period marks stranded pending judgments error and finalizes the run', async () => {
    const base = await createBaseFixture();
    const evaluation = await mkEvaluation(base.project.id, base.user.id);
    // 3 sweep intervals (180s) + slack past the deadline.
    const deadlineAt = new Date(Date.now() - 200_000);
    const run = await mkEvaluationRun(evaluation.id, base.user.id, base.rubric.id, {
      status: 'judging',
      deadlineAt,
    });
    const judgment = await mkJudgment(run.id, base.version.id, base.promptTemplateId, { status: 'pending' });

    const { confirmChannel } = await getRabbit();
    await assertTopology(confirmChannel);
    await confirmChannel.purgeQueue(QUEUE_JUDGMENT_EXECUTE);

    await runReaperSweep();

    const afterSweep = await prisma.modelJudgment.findUniqueOrThrow({ where: { id: judgment.id } });
    expect(afterSweep.status).toBe('error');
    expect(afterSweep.error).toBe('reaper: abandoned');

    const persistedRun = await prisma.evaluationRun.findUniqueOrThrow({ where: { id: run.id } });
    // Zero completed judgments on this run -> maybeFinalizeRun's "all error"
    // branch.
    expect(persistedRun.status).toBe('error');
    expect(persistedRun.finalizedAt).not.toBeNull();

    // Nothing should have been republished for THIS judgment — filtered by
    // id rather than asserting total queue emptiness, since another overdue
    // (but still-within-grace) run from an earlier test in this same
    // persistent-DB suite could legitimately still be republishing on its
    // own account.
    const published = await drainQueue(confirmChannel, QUEUE_JUDGMENT_EXECUTE, 200);
    const relevant = published.filter(
      (m) => (JSON.parse(m.content.toString()) as JudgmentExecuteMsg).judgmentId === judgment.id
    );
    expect(relevant).toHaveLength(0);
  });
});

describe('dataset summary recompute race (src/lib/dataset-evaluation-summary.ts, via maybeFinalizeRun)', () => {
  it(
    'two concurrent finalizations of runs on the same dataset leave a summary consistent with the DB ' +
      'and preserve unrelated remoteMetadata fields (no lost update)',
    async () => {
      const base = await createBaseFixture();
      const dataset = await mkDataset(base.user.id, {
        remoteMetadata: JSON.stringify({ description: 'seed-description', cardData: { foo: 'bar' } }),
      });

      const evaluation1 = await mkEvaluation(base.project.id, base.user.id, { datasetId: dataset.id });
      const run1 = await mkEvaluationRun(evaluation1.id, base.user.id, base.rubric.id, { status: 'judging' });
      await mkJudgment(run1.id, base.version.id, base.promptTemplateId, { status: 'completed', overallScore: 8 });

      const evaluation2 = await mkEvaluation(base.project.id, base.user.id, { datasetId: dataset.id });
      const run2 = await mkEvaluationRun(evaluation2.id, base.user.id, base.rubric.id, { status: 'judging' });
      const { version: version2 } = await mkJudgeModelVersion();
      await mkJudgment(run2.id, version2.id, base.promptTemplateId, { status: 'completed', overallScore: 4 });

      const [resultA, resultB] = await Promise.all([maybeFinalizeRun(run1.id), maybeFinalizeRun(run2.id)]);
      expect(resultA).toBe('needs_human');
      expect(resultB).toBe('needs_human');

      const persistedDataset = await prisma.dataset.findUniqueOrThrow({ where: { id: dataset.id } });
      const metadata = JSON.parse(persistedDataset.remoteMetadata as string) as {
        description: string;
        cardData: { foo: string };
        evaluationSummary: {
          sampleCount: number;
          samplesWithModelScores: number;
          averageModelScore: number | null;
        };
      };

      // Unrelated remoteMetadata fields survive — this is what a
      // read-modify-write race would silently drop.
      expect(metadata.description).toBe('seed-description');
      expect(metadata.cardData).toEqual({ foo: 'bar' });

      // Summary consistent with the DB — recomputed expected: both
      // evaluations' latest (only) run each has one completed judgment
      // (scores 8 and 4).
      expect(metadata.evaluationSummary.sampleCount).toBe(2);
      expect(metadata.evaluationSummary.samplesWithModelScores).toBe(2);
      expect(metadata.evaluationSummary.averageModelScore).toBeCloseTo((8 + 4) / 2, 5);
    },
    20_000
  );
});
