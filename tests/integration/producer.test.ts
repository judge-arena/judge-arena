import { afterAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { getServerSession } from 'next-auth';
import type { Channel, ConsumeMessage } from 'amqplib';
import { prisma } from '@/lib/db';
import { closeRabbit, getRabbit } from '@/lib/queue/connection';
import { assertTopology, QUEUE_JUDGMENT_EXECUTE, QUEUE_RUN_CREATE } from '@/lib/queue/topology';
import type { JudgmentExecuteMsg, RunCreateMsg } from '@/lib/queue/publish';
import { launchSingleRun, launchBulkRunCreates } from '@/lib/run-launch';
import { createRunCreateConsumer } from '@/worker/run-create-consumer';
import { seedPromptTemplates } from '../../prisma/seed-prompt-templates';
import { POST as postRun } from '@/app/api/evaluations/[id]/runs/route';
import { POST as postEvaluations } from '@/app/api/evaluations/route';
import { GET as getStats } from '@/app/api/stats/route';

// Integration suite — Task 9 (web tier becomes a RabbitMQ producer). Needs a
// live Postgres (see .env.test's DATABASE_URL — schema already migrated,
// e.g. by a prior `npm run test:db` run), a live RabbitMQ (RABBITMQ_URL),
// and a live Redis (REDIS_URL — requireAuth()'s apiLimiter + the judge
// route's judgeLimiter both gate through it). Run via `npm run
// test:integration`, never as part of plain `npm test`.
//
// Persistent DB, same convention as tests/integration/worker-claims.test.ts:
// every fixture helper below tracks the ids it creates into module-level
// cleanup arrays, torn down in FK-safe order in `afterAll` (no `truncateAll`
// here — this suite shares one broker/DB with the rest of tests/integration/**
// and must not nuke other files' state).

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(),
}));
vi.mock('next/headers', () => ({
  headers: vi.fn(async () => new Headers()),
}));

function mockSessionFor(user: { id: string; email: string }) {
  (getServerSession as unknown as Mock).mockResolvedValue({
    user: { id: user.id, email: user.email },
  });
}

/** Consumes every message currently sitting on `queue` until `quietMs`
 * elapses with no new arrival, acking each as it's collected. Mirrors
 * worker-claims.test.ts's `drainQueue`. */
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

/** Fabricates a `ConsumeMessage`-shaped object carrying `payload` as its
 * JSON body — same pattern as tests/integration/worker-claims.test.ts's
 * `fakeMessage`, used below to feed a real, drained `run.create` message
 * straight into the consumer's `handle()` without a second live-broker
 * round trip. */
function fakeMessage(payload: unknown): ConsumeMessage {
  return {
    content: Buffer.from(JSON.stringify(payload)),
    fields: {} as ConsumeMessage['fields'],
    properties: {} as ConsumeMessage['properties'],
  } as ConsumeMessage;
}

interface SpyChannel extends Channel {
  ackCalls: ConsumeMessage[];
}

/** Minimal ack-recording spy channel — same pattern as
 * tests/integration/worker-claims.test.ts's `fakeChannel`. Deliberately NOT
 * the real confirmChannel: `fakeMessage()`'s fabricated `fields`/
 * `properties` have no real AMQP delivery tag for a live channel's `ack()`
 * to act on. */
function fakeChannel(): SpyChannel {
  const ackCalls: ConsumeMessage[] = [];
  return {
    ack: (msg: ConsumeMessage) => {
      ackCalls.push(msg);
    },
    ackCalls,
  } as unknown as SpyChannel;
}

// ─── Fixture helpers ────────────────────────────────────────────────────────

const createdUserIds: string[] = [];
const createdRunIds: string[] = [];
const createdEvaluationIds: string[] = [];
const createdVersionIds: string[] = [];
const createdJudgeModelIds: string[] = [];

let uniqCounter = 0;
function uniq(label: string): string {
  uniqCounter += 1;
  return `${label}-${Date.now()}-${uniqCounter}`;
}

async function mkUser() {
  const user = await prisma.user.create({
    data: { email: `${uniq('producer-user')}@test.local`, passwordHash: 'fixture-hash' },
  });
  createdUserIds.push(user.id);
  return user;
}

async function mkProject(userId: string) {
  return prisma.project.create({ data: { name: 'fixture-project', userId } });
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

async function mkModelConfig(userId: string, overrides: Partial<{ provider: string; modelId: string; endpoint: string | null }> = {}) {
  return prisma.modelConfig.create({
    data: {
      name: uniq('fixture-model'),
      provider: overrides.provider ?? 'openai',
      modelId: overrides.modelId ?? uniq('fixture-model-id'),
      endpoint: overrides.endpoint ?? null,
      isActive: true,
      isVerified: true,
      userId,
    },
  });
}

async function mkEvaluation(
  projectId: string,
  userId: string,
  opts: { rubricId?: string | null; modelConfigIds: string[] }
) {
  const evaluation = await prisma.evaluation.create({
    data: {
      projectId,
      userId,
      inputText: 'fixture input',
      responseText: 'fixture response under judgment', // judge mode
      ...(opts.rubricId ? { rubricId: opts.rubricId } : {}),
      modelSelections: {
        create: opts.modelConfigIds.map((modelConfigId) => ({ modelConfigId })),
      },
    },
  });
  createdEvaluationIds.push(evaluation.id);
  return evaluation;
}

/** Tracks a judgeModelVersionId (and its parent JudgeModel) for FK-safe
 * cleanup — `ensureJudgeIdentityForModelConfig` (called internally by
 * launchSingleRun/launchBulkRunCreates) creates these as a side effect. */
async function trackJudgeIdentity(versionId: string): Promise<void> {
  if (createdVersionIds.includes(versionId)) return;
  createdVersionIds.push(versionId);
  const version = await prisma.judgeModelVersion.findUnique({
    where: { id: versionId },
    select: { judgeModelId: true },
  });
  if (version && !createdJudgeModelIds.includes(version.judgeModelId)) {
    createdJudgeModelIds.push(version.judgeModelId);
  }
}

afterAll(async () => {
  // FK-safe order — see worker-claims.test.ts's afterAll for the full
  // rationale (runs before users unblocks Rubric's Restrict; users before
  // versions unblocks ModelEndpoint's cascade-then-Restrict chain; versions
  // before judge models unblocks JudgeModelVersion's Restrict).
  await prisma.evaluationRun.deleteMany({ where: { id: { in: createdRunIds } } });
  await prisma.evaluation.deleteMany({ where: { id: { in: createdEvaluationIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.judgeModelVersion.deleteMany({ where: { id: { in: createdVersionIds } } });
  await prisma.judgeModel.deleteMany({ where: { id: { in: createdJudgeModelIds } } });

  await closeRabbit();
  await prisma.$disconnect();
});

beforeEach(async () => {
  (getServerSession as unknown as Mock).mockReset();
  await seedPromptTemplates(prisma); // idempotent — launchSingleRun/launchBulkRunCreates require a pointwise PromptTemplate row
});

describe('launchSingleRun (src/lib/run-launch.ts)', () => {
  it('creates a pending run + pending judgments (judgeModelVersionId + modelConfigId set on every row) and publishes exactly one judgment.execute per row', async () => {
    const user = await mkUser();
    const project = await mkProject(user.id);
    const rubric = await mkRubric(user.id);
    const modelA = await mkModelConfig(user.id);
    const modelB = await mkModelConfig(user.id);
    const evaluation = await mkEvaluation(project.id, user.id, {
      rubricId: rubric.id,
      modelConfigIds: [modelA.id, modelB.id],
    });

    const { confirmChannel } = await getRabbit();
    await assertTopology(confirmChannel);
    await confirmChannel.purgeQueue(QUEUE_JUDGMENT_EXECUTE);

    const result = await launchSingleRun({ evaluationId: evaluation.id, triggeredById: user.id });
    createdRunIds.push(result.run.id);

    expect(result.publishFailed).toBe(false);
    expect(result.run.status).toBe('pending');
    expect(result.run.modelJudgments).toHaveLength(2);
    for (const judgment of result.run.modelJudgments) {
      expect(judgment.status).toBe('pending');
      expect(judgment.judgeModelVersionId).toBeTruthy();
      expect(judgment.modelConfigId).toBeTruthy(); // dual-write, legacy
      await trackJudgeIdentity(judgment.judgeModelVersionId!);
    }
    // Distinct ModelConfigs with distinct modelIds -> distinct judge identities.
    expect(new Set(result.run.modelJudgments.map((j) => j.judgeModelVersionId)).size).toBe(2);

    const published = await drainQueue(confirmChannel, QUEUE_JUDGMENT_EXECUTE);
    expect(published).toHaveLength(2);
    const publishedIds = published
      .map((m) => (JSON.parse(m.content.toString()) as JudgmentExecuteMsg).judgmentId)
      .sort();
    expect(publishedIds).toEqual(result.run.modelJudgments.map((j) => j.id).sort());
  });

  it('a publish failure after commit marks the run "error" (compensating update) and reports publishFailed/publishError', async () => {
    const user = await mkUser();
    const project = await mkProject(user.id);
    const rubric = await mkRubric(user.id);
    const model = await mkModelConfig(user.id);
    const evaluation = await mkEvaluation(project.id, user.id, {
      rubricId: rubric.id,
      modelConfigIds: [model.id],
    });

    const result = await launchSingleRun(
      { evaluationId: evaluation.id, triggeredById: user.id },
      { publish: async () => { throw new Error('simulated broker outage'); } }
    );
    createdRunIds.push(result.run.id);
    for (const judgment of result.run.modelJudgments) {
      await trackJudgeIdentity(judgment.judgeModelVersionId!);
    }

    expect(result.publishFailed).toBe(true);
    expect(result.publishError).toBe('simulated broker outage');
    expect(result.run.status).toBe('error');

    // Row really is durably 'error' in the DB, not just in the returned object.
    const persisted = await prisma.evaluationRun.findUniqueOrThrow({ where: { id: result.run.id } });
    expect(persisted.status).toBe('error');
  });

  it('an in-doubt publish failure (broker actually had the message) is NOT reported as failed — the guarded compensating update no-ops instead of clobbering a legitimate terminal status', async () => {
    const user = await mkUser();
    const project = await mkProject(user.id);
    const rubric = await mkRubric(user.id);
    const model = await mkModelConfig(user.id);
    const evaluation = await mkEvaluation(project.id, user.id, {
      rubricId: rubric.id,
      modelConfigIds: [model.id],
    });

    const result = await launchSingleRun(
      { evaluationId: evaluation.id, triggeredById: user.id },
      {
        publish: async ({ runId }) => {
          // Simulate the race this fix targets: a worker actually claimed
          // and finished the judgment (finalizer moved the run to
          // 'needs_human') before our publish() call's confirm-ack came
          // back — the message really was delivered, but publish() throws
          // on our side anyway (e.g. a timed-out confirm or a socket error
          // raised after the broker already accepted it).
          await prisma.evaluationRun.update({
            where: { id: runId },
            data: { status: 'needs_human', finalizedAt: new Date() },
          });
          throw new Error('simulated in-doubt confirm timeout');
        },
      }
    );
    createdRunIds.push(result.run.id);
    for (const judgment of result.run.modelJudgments) {
      await trackJudgeIdentity(judgment.judgeModelVersionId!);
    }

    // Reported as accepted, not failed — the guarded updateMany found the
    // run already off pending/judging (count 0) and backed off rather than
    // stomping the real 'needs_human' transition back to 'error'.
    expect(result.publishFailed).toBe(false);
    expect(result.publishError).toBeUndefined();
    expect(result.run.status).toBe('needs_human');

    const persisted = await prisma.evaluationRun.findUniqueOrThrow({ where: { id: result.run.id } });
    expect(persisted.status).toBe('needs_human'); // NOT stomped to 'error'
  });

  it('end-to-end through the real POST /api/evaluations/[id]/runs route: 201 with judgeModelVersionId set', async () => {
    const user = await mkUser();
    mockSessionFor(user);
    const project = await mkProject(user.id);
    const rubric = await mkRubric(user.id);
    const model = await mkModelConfig(user.id);
    const evaluation = await mkEvaluation(project.id, user.id, {
      rubricId: rubric.id,
      modelConfigIds: [model.id],
    });

    const response = await postRun(
      new Request(`http://localhost/api/evaluations/${evaluation.id}/runs`, { method: 'POST' }),
      { params: Promise.resolve({ id: evaluation.id }) }
    );
    expect(response.status).toBe(201);
    const body = await response.json();
    createdRunIds.push(body.id);
    for (const judgment of body.modelJudgments) {
      await trackJudgeIdentity(judgment.judgeModelVersionId);
    }

    expect(body.status).toBe('pending');
    expect(body.modelJudgments).toHaveLength(1);
    expect(body.modelJudgments[0].judgeModelVersionId).toBeTruthy();
  });
});

describe('launchBulkRunCreates (src/lib/run-launch.ts)', () => {
  it('2 evaluations, one with no rubric assigned -> 1 accepted / 1 failed; run.create published only for the accepted one', async () => {
    const user = await mkUser();
    const project = await mkProject(user.id);
    const rubric = await mkRubric(user.id);
    const model = await mkModelConfig(user.id);

    const goodEvaluation = await mkEvaluation(project.id, user.id, {
      rubricId: rubric.id,
      modelConfigIds: [model.id],
    });
    const badEvaluation = await mkEvaluation(project.id, user.id, {
      rubricId: null, // judge mode (responseText set) with no rubric -> invalid
      modelConfigIds: [model.id],
    });

    const { confirmChannel } = await getRabbit();
    await assertTopology(confirmChannel);
    await confirmChannel.purgeQueue(QUEUE_RUN_CREATE);

    const result = await launchBulkRunCreates([goodEvaluation.id, badEvaluation.id], user.id);

    expect(result.accepted).toEqual([goodEvaluation.id]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({ evaluationId: badEvaluation.id });
    expect(result.failed[0].reason).toMatch(/rubric/i);

    const published = await drainQueue(confirmChannel, QUEUE_RUN_CREATE);
    expect(published).toHaveLength(1);
    const msg = JSON.parse(published[0].content.toString()) as RunCreateMsg;
    expect(msg.evaluationId).toBe(goodEvaluation.id);
    expect(msg.runSpec.modelSelections).toEqual([
      expect.objectContaining({ modelConfigId: model.id }),
    ]);
    for (const sel of msg.runSpec.modelSelections) {
      await trackJudgeIdentity(sel.judgeModelVersionId);
    }
  });

  it('bulk launch end-to-end (Task 9 review fix #1): consumer-created judgments have BOTH judgeModelVersionId and modelConfigId, RunModelSelection rows exist, and the leaderboard join includes them', async () => {
    const user = await mkUser();
    const project = await mkProject(user.id);
    const rubric = await mkRubric(user.id);
    const modelA = await mkModelConfig(user.id);
    const modelB = await mkModelConfig(user.id);
    const evaluation = await mkEvaluation(project.id, user.id, {
      rubricId: rubric.id,
      modelConfigIds: [modelA.id, modelB.id],
    });

    const { confirmChannel } = await getRabbit();
    await assertTopology(confirmChannel);
    await confirmChannel.purgeQueue(QUEUE_RUN_CREATE);

    const result = await launchBulkRunCreates([evaluation.id], user.id);
    expect(result.accepted).toEqual([evaluation.id]);
    expect(result.failed).toEqual([]);

    // Producer side: the real, drained run.create message carries a
    // {judgeModelVersionId, modelConfigId} pair per selected model — not a
    // bare judgeModelVersionId[] (the pre-fix shape that left the consumer
    // with nothing to dual-write).
    const published = await drainQueue(confirmChannel, QUEUE_RUN_CREATE);
    expect(published).toHaveLength(1);
    const msg = JSON.parse(published[0].content.toString()) as RunCreateMsg;
    expect(new Set(msg.runSpec.modelSelections.map((sel) => sel.modelConfigId))).toEqual(
      new Set([modelA.id, modelB.id])
    );
    for (const sel of msg.runSpec.modelSelections) {
      await trackJudgeIdentity(sel.judgeModelVersionId);
    }

    // Consumer side: feed the real drained message straight into the
    // run.create consumer (same "fabricated ConsumeMessage into handle()"
    // pattern tests/integration/worker-claims.test.ts uses) — no live
    // worker process needed to exercise the actual expansion + dual-write.
    const consumer = createRunCreateConsumer();
    const ch = fakeChannel();
    await consumer.handle(fakeMessage(msg), ch);
    expect(ch.ackCalls).toHaveLength(1);

    const run = await prisma.evaluationRun.findFirstOrThrow({ where: { evaluationId: evaluation.id } });
    createdRunIds.push(run.id);
    expect(run.status).toBe('pending');

    const judgments = await prisma.modelJudgment.findMany({ where: { runId: run.id } });
    expect(judgments).toHaveLength(2);
    for (const judgment of judgments) {
      expect(judgment.judgeModelVersionId).toBeTruthy();
      expect(judgment.modelConfigId).toBeTruthy(); // dual-write — was null before the fix
    }
    expect(new Set(judgments.map((j) => j.modelConfigId))).toEqual(new Set([modelA.id, modelB.id]));

    // RunModelSelection rows — never written by the bulk path before the fix.
    const selections = await prisma.runModelSelection.findMany({ where: { runId: run.id } });
    expect(new Set(selections.map((s) => s.modelConfigId))).toEqual(new Set([modelA.id, modelB.id]));

    // The leaderboard aggregation path (src/app/api/leaderboard/route.ts)
    // selects `modelJudgment.modelConfig` and does
    // `if (j.modelConfig === null) continue` — assert that exact join is
    // non-null for every judgment this bulk launch created.
    const withModelConfig = await prisma.modelJudgment.findMany({
      where: { runId: run.id },
      select: { modelConfig: { select: { id: true, name: true, provider: true, modelId: true } } },
    });
    expect(withModelConfig).toHaveLength(2);
    for (const j of withModelConfig) {
      expect(j.modelConfig).not.toBeNull();
    }
  });

  it('end-to-end through the real POST /api/evaluations (dataset-batch, create_and_run) route: 202 with accepted/failed', async () => {
    const user = await mkUser();
    mockSessionFor(user);
    const project = await mkProject(user.id);
    const rubric = await mkRubric(user.id);
    const model = await mkModelConfig(user.id);

    const dataset = await prisma.dataset.create({
      data: {
        name: uniq('fixture-dataset'),
        userId: user.id,
        source: 'local',
        sampleCount: 2,
        splits: JSON.stringify(['train']),
        features: JSON.stringify([]),
        tags: JSON.stringify([]),
        inputType: 'query-response',
        samples: {
          create: [
            { index: 0, input: 'q1', expected: 'a1' },
            { index: 1, input: 'q2', expected: 'a2' },
          ],
        },
      },
    });

    const response = await postEvaluations(
      new Request('http://localhost/api/evaluations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          mode: 'dataset',
          runMode: 'create_and_run',
          projectId: project.id,
          datasetId: dataset.id,
          rubricId: rubric.id,
          modelConfigIds: [model.id],
        }),
      })
    );

    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body.evaluationsCreated).toBe(2);
    expect(body.accepted).toHaveLength(2);
    expect(body.failed).toEqual([]);
    createdEvaluationIds.push(...body.evaluationIds);

    const { confirmChannel } = await getRabbit();
    const published = await drainQueue(confirmChannel, QUEUE_RUN_CREATE);
    expect(published.length).toBeGreaterThanOrEqual(2);
    for (const raw of published) {
      const msg = JSON.parse(raw.content.toString()) as RunCreateMsg;
      if (body.evaluationIds.includes(msg.evaluationId)) {
        for (const sel of msg.runSpec.modelSelections) {
          await trackJudgeIdentity(sel.judgeModelVersionId);
        }
      }
    }
  });
});

describe('GET /api/stats — DB-backed queue counts (replaces getQueueStats())', () => {
  it('returns queue.{pendingRuns,judgingRuns,pendingJudgments,runningJudgments,rabbitHealthy} reflecting real DB state', async () => {
    const user = await mkUser();
    mockSessionFor(user);
    const project = await mkProject(user.id);
    const rubric = await mkRubric(user.id);
    const model = await mkModelConfig(user.id);
    const evaluation = await mkEvaluation(project.id, user.id, {
      rubricId: rubric.id,
      modelConfigIds: [model.id],
    });

    const launch = await launchSingleRun({ evaluationId: evaluation.id, triggeredById: user.id });
    createdRunIds.push(launch.run.id);
    for (const judgment of launch.run.modelJudgments) {
      await trackJudgeIdentity(judgment.judgeModelVersionId!);
    }

    const response = await getStats();
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.queue).toBeTruthy();
    expect(typeof body.queue.rabbitHealthy).toBe('boolean');
    expect(body.queue.rabbitHealthy).toBe(true); // the broker IS live in this suite
    expect(body.queue.pendingRuns).toBeGreaterThanOrEqual(1);
    expect(body.queue.pendingJudgments).toBeGreaterThanOrEqual(1);

    // Sanity: counts reflect exactly-this-user's data (matches the
    // pre-existing pendingEvaluations filter's own scoping convention).
    const dbPendingRuns = await prisma.evaluationRun.count({
      where: { status: { in: ['pending', 'judging'] }, triggeredById: user.id },
    });
    expect(body.queue.pendingRuns).toBe(dbPendingRuns);
  });
});
