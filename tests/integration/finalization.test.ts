import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Channel, ConsumeMessage } from 'amqplib';
import { prisma } from '@/lib/db';
import { closeRabbit, getRabbit } from '@/lib/queue/connection';
import { assertTopology } from '@/lib/queue/topology';
import { LANE_FALLBACK_QUEUE, LANE_QUEUES, laneQueueFor } from '@/lib/queue/lanes';
import type { JudgmentExecuteMsg } from '@/lib/queue/publish';
import { getConnectedRedis } from '@/lib/redis';
import { maybeFinalizeRun, markRunCompleted } from '@/lib/run-finalizer';
import { runReaperSweep, REAPER_LOCK_KEY, NEVER_STARTED_TIMEOUT_MS } from '@/worker/reaper';
import { MAX_CALIBRATION_ITEMS } from '@/lib/calibration/launch';
import { resolveTimeoutBudgets } from '@/lib/llm/timeout-policy';
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

/** ── v2j lane routing ───────────────────────────────────────────────────────
 * A `judgment.execute` message is no longer published to one known queue:
 * `publishJudgmentExecute` routes it to the LANE for the judge's endpoint
 * origin (src/lib/queue/lanes.ts), and which lane that is depends on
 * `QueueLane` assignment order — not something a test can name as a constant.
 *
 * These assertions were never about the queue NAME; they are about "was this
 * judgment enqueued for execution at all". So they drain every queue a
 * judgment can legally land on: the 8 lanes plus `LANE_FALLBACK_QUEUE`, which
 * is the original `judgment.execute` and is kept and consumed forever. The
 * lane CHOICE is asserted where it belongs, in
 * tests/db/lane-publishing.test.ts. */
const EXECUTE_QUEUES = [...LANE_QUEUES, LANE_FALLBACK_QUEUE];

async function purgeExecuteQueues(ch: Channel): Promise<void> {
  await Promise.all(EXECUTE_QUEUES.map((queue) => ch.purgeQueue(queue)));
}

async function drainExecuteQueues(ch: Channel, quietMs = 400): Promise<ConsumeMessage[]> {
  const drained = await Promise.all(EXECUTE_QUEUES.map((queue) => drainQueue(ch, queue, quietMs)));
  return drained.flat();
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
    createdAt: Date;
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
    await purgeExecuteQueues(confirmChannel);

    await runReaperSweep();

    const afterSweep = await prisma.modelJudgment.findUniqueOrThrow({ where: { id: judgment.id } });
    expect(afterSweep.status).toBe('pending');
    expect(afterSweep.attemptCount).toBe(1); // reaper does NOT bump attemptCount — see reaper.ts's doc

    // v2j: the republish goes back to the judgment's OWN lane, not to the
    // shared fallback queue. Asserted by draining that one lane rather than
    // everything: a reaper that republished onto `judgment.execute` would
    // silently un-lane every judgment it touched — exactly when the system is
    // already unhealthy — and a "drained from somewhere" assertion would stay
    // green through it. This fixture's endpoint has no URL, so the lane key is
    // `version:<id>` (see lanes.ts's laneKeyFor).
    const expectedLane = await laneQueueFor(null, base.version.id);
    expect(expectedLane).not.toBe(LANE_FALLBACK_QUEUE);

    const published = await drainQueue(confirmChannel, expectedLane);
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
    await purgeExecuteQueues(confirmChannel);

    await runReaperSweep();

    const afterSweep = await prisma.modelJudgment.findUniqueOrThrow({ where: { id: judgment.id } });
    expect(afterSweep.status).toBe('running'); // untouched — well within LEASE_MS

    const published = await drainExecuteQueues(confirmChannel, 200);
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
    await purgeExecuteQueues(confirmChannel);

    await runReaperSweep();

    const afterSweep = await prisma.modelJudgment.findUniqueOrThrow({ where: { id: judgment.id } });
    expect(afterSweep.status).toBe('pending'); // not force-errored — still within grace

    const persistedRun = await prisma.evaluationRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(persistedRun.status).toBe('judging'); // not finalized yet

    // Same lane assertion as the stale-judgment case above, for the other of
    // the reaper's two republish paths (`republishPendingForRun`).
    const expectedLane = await laneQueueFor(null, base.version.id);
    expect(expectedLane).not.toBe(LANE_FALLBACK_QUEUE);

    const published = await drainQueue(confirmChannel, expectedLane);
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
    await purgeExecuteQueues(confirmChannel);

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
    const published = await drainExecuteQueues(confirmChannel, 200);
    const relevant = published.filter(
      (m) => (JSON.parse(m.content.toString()) as JudgmentExecuteMsg).judgmentId === judgment.id
    );
    expect(relevant).toHaveLength(0);
  });
});

describe('reaper (src/worker/reaper.ts): the never-started safety net (deadlineAt IS NULL)', () => {
  it('NEVER_STARTED_TIMEOUT_MS is 45 days', () => {
    expect(NEVER_STARTED_TIMEOUT_MS).toBe(45 * 24 * 60 * 60 * 1000);
  });

  it('the never-started net outlasts the LEGAL drain time of a full-cap calibration batch', () => {
    // The RELATIONSHIP, not a second literal — this repo's own idiom (cf.
    // tests/lib/timeout-policy.test.ts:320, `LEASE_MS > hardCapMs`). A
    // calibration serialises through ONE judge's gate; each item may legally
    // run to hardCapMs and be delivered MAX_ATTEMPTS (3) times. If someone
    // raises MAX_CALIBRATION_ITEMS again without revisiting this net, this
    // goes red instead of silently re-arming the bug the net exists to
    // prevent — a batch force-finalized while still healthily queued.
    // The 3 mirrors judgment-consumer.ts:199's MAX_ATTEMPTS (not exported).
    // Raising that number invalidates NEVER_STARTED_TIMEOUT_MS and must
    // move this literal too.
    const legalWorstCaseMs = MAX_CALIBRATION_ITEMS * 3 * resolveTimeoutBudgets().hardCapMs;
    expect(NEVER_STARTED_TIMEOUT_MS).toBeGreaterThan(legalWorstCaseMs);
  });

  it('a run created long before NEVER_STARTED_TIMEOUT_MS, never dequeued, past the grace period is force-finalized', async () => {
    const base = await createBaseFixture();
    const evaluation = await mkEvaluation(base.project.id, base.user.id);
    // Never started: deadlineAt stays null (nothing has claimed a
    // judgment), createdAt is far enough in the past that even
    // NEVER_STARTED_TIMEOUT_MS + the 180s grace has elapsed.
    const createdAt = new Date(Date.now() - NEVER_STARTED_TIMEOUT_MS - 200_000);
    const run = await mkEvaluationRun(evaluation.id, base.user.id, base.rubric.id, {
      status: 'pending',
      deadlineAt: null,
      createdAt,
    });
    const judgment = await mkJudgment(run.id, base.version.id, base.promptTemplateId, { status: 'pending' });

    const { confirmChannel } = await getRabbit();
    await assertTopology(confirmChannel);
    await purgeExecuteQueues(confirmChannel);

    await runReaperSweep();

    const afterSweep = await prisma.modelJudgment.findUniqueOrThrow({ where: { id: judgment.id } });
    expect(afterSweep.status).toBe('error');
    expect(afterSweep.error).toBe('reaper: abandoned');

    const persistedRun = await prisma.evaluationRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(persistedRun.status).toBe('error');
    expect(persistedRun.finalizedAt).not.toBeNull();
  });

  it('a run created recently, never dequeued, is left alone — this is the queued-but-healthy case the whole task exists to protect', async () => {
    const base = await createBaseFixture();
    const evaluation = await mkEvaluation(base.project.id, base.user.id);
    const run = await mkEvaluationRun(evaluation.id, base.user.id, base.rubric.id, {
      status: 'pending',
      deadlineAt: null,
      // createdAt defaults to now() — well inside NEVER_STARTED_TIMEOUT_MS.
    });
    const judgment = await mkJudgment(run.id, base.version.id, base.promptTemplateId, { status: 'pending' });

    const { confirmChannel } = await getRabbit();
    await assertTopology(confirmChannel);
    await purgeExecuteQueues(confirmChannel);

    await runReaperSweep();

    const afterSweep = await prisma.modelJudgment.findUniqueOrThrow({ where: { id: judgment.id } });
    expect(afterSweep.status).toBe('pending'); // untouched — not even swept

    const persistedRun = await prisma.evaluationRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(persistedRun.status).toBe('pending'); // untouched

    // Not even a republish — this row was never in the sweep's candidate
    // set at all (the query's OR excludes it).
    const published = await drainExecuteQueues(confirmChannel, 200);
    const relevant = published.filter(
      (m) => (JSON.parse(m.content.toString()) as JudgmentExecuteMsg).judgmentId === judgment.id
    );
    expect(relevant).toHaveLength(0);
  });

  it('a STARTED run (deadlineAt set, in the future) with an ancient createdAt is governed by its execution deadline, not the never-started net', async () => {
    const base = await createBaseFixture();
    const evaluation = await mkEvaluation(base.project.id, base.user.id);
    // deadlineAt is set and comfortably in the FUTURE — this run has begun
    // executing and is well within its own budget — even though createdAt
    // is older than NEVER_STARTED_TIMEOUT_MS. A wrong implementation that
    // ORs on createdAt unconditionally (forgetting the `deadlineAt: null`
    // guard on the second arm) would catch and republish for this run;
    // the real one must not touch it at all.
    const run = await mkEvaluationRun(evaluation.id, base.user.id, base.rubric.id, {
      status: 'judging',
      deadlineAt: new Date(Date.now() + 10 * 60_000),
      createdAt: new Date(Date.now() - NEVER_STARTED_TIMEOUT_MS - 200_000),
    });
    const judgment = await mkJudgment(run.id, base.version.id, base.promptTemplateId, { status: 'pending' });

    const { confirmChannel } = await getRabbit();
    await assertTopology(confirmChannel);
    await purgeExecuteQueues(confirmChannel);

    await runReaperSweep();

    const afterSweep = await prisma.modelJudgment.findUniqueOrThrow({ where: { id: judgment.id } });
    expect(afterSweep.status).toBe('pending'); // not force-errored

    const persistedRun = await prisma.evaluationRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(persistedRun.status).toBe('judging'); // untouched — deadlineAt is in the future

    const published = await drainExecuteQueues(confirmChannel, 200);
    const relevant = published.filter(
      (m) => (JSON.parse(m.content.toString()) as JudgmentExecuteMsg).judgmentId === judgment.id
    );
    expect(relevant).toHaveLength(0); // not even a republish — outside the sweep's candidate set
  });

  it('a never-started run just PAST the net but inside the grace period is REPUBLISHED, not force-finalized', async () => {
    const base = await createBaseFixture();
    const evaluation = await mkEvaluation(base.project.id, base.user.id);
    // Past NEVER_STARTED_TIMEOUT_MS by 30s — so the second arm matches — but
    // well inside FORCE_FINALIZE_GRACE_MS (180s), so the gentler branch must
    // run. This is the ONLY test that pins WHICH branch the substituted
    // threshold selects: `run.deadlineAt ?? new Date(0)` (force-finalize
    // everything the second arm catches, never republish) passes every other
    // test in this block and the whole pre-existing suite.
    const createdAt = new Date(Date.now() - NEVER_STARTED_TIMEOUT_MS - 30_000);
    const run = await mkEvaluationRun(evaluation.id, base.user.id, base.rubric.id, {
      status: 'pending',
      deadlineAt: null,
      createdAt,
    });
    const judgment = await mkJudgment(run.id, base.version.id, base.promptTemplateId, { status: 'pending' });

    const { confirmChannel } = await getRabbit();
    await assertTopology(confirmChannel);
    await purgeExecuteQueues(confirmChannel);

    await runReaperSweep();

    const afterSweep = await prisma.modelJudgment.findUniqueOrThrow({ where: { id: judgment.id } });
    expect(afterSweep.status).toBe('pending'); // NOT 'reaper: abandoned'
    expect(afterSweep.error).toBeNull();

    const persistedRun = await prisma.evaluationRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(persistedRun.status).toBe('pending');
    expect(persistedRun.finalizedAt).toBeNull();

    const published = await drainExecuteQueues(confirmChannel, 200);
    const relevant = published.filter(
      (m) => (JSON.parse(m.content.toString()) as JudgmentExecuteMsg).judgmentId === judgment.id
    );
    expect(relevant).toHaveLength(1); // republished exactly once
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
