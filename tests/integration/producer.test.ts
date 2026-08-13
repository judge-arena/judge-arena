import { afterAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { getServerSession } from 'next-auth';
import type { Channel, ConsumeMessage } from 'amqplib';
import type { ServingBackend } from '@prisma/client';
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

// Integration suite — Task 9 (web tier becomes a RabbitMQ producer), rewired
// for Task 12 (runtime switches to JudgeModel/Version/Endpoint identity —
// EvaluationModelSelection/RunModelSelection are now selected by
// judgeModelVersionId directly, sourced from the selecting user's OWN
// ModelEndpoint; ModelConfig is no longer the selection source and no new
// ModelConfig rows are ever created by this path). Needs a live Postgres
// (see .env.test's DATABASE_URL — schema already migrated, e.g. by a prior
// `npm run test:db` run), a live RabbitMQ (RABBITMQ_URL), and a live Redis
// (REDIS_URL — requireAuth()'s apiLimiter + the judge route's judgeLimiter
// both gate through it). Run via `npm run test:integration`, never as part
// of plain `npm test`.
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

/**
 * Task 12 fixture: a catalog `JudgeModel` + `JudgeModelVersion` (ordinal 1)
 * plus an ACTIVE, VERIFIED `ModelEndpoint` owned by `userId` — the source of
 * a selectable "model" in the current runtime. Replaces the old
 * `mkModelConfig` (which created a `ModelConfig` the removed
 * `ensureJudgeIdentityForModelConfig` bridge would have resolved a version
 * for). `requireOwnedActiveEndpoints` (`src/lib/run-launch.ts`) requires
 * exactly this shape (active + `verifiedAt` set) to allow a launch.
 */
async function mkJudgeVersionWithEndpoint(
  userId: string,
  overrides: Partial<{ servingBackend: ServingBackend; baseModel: string }> = {}
) {
  const judgeModel = await prisma.judgeModel.create({
    data: {
      name: uniq('fixture-judge'),
      slug: uniq('fixture-judge-slug'),
      judgeClass: 'prompted_api',
      scoringMechanism: 'critique_generative',
      baseModel: overrides.baseModel ?? uniq('fixture-base-model'),
    },
  });
  createdJudgeModelIds.push(judgeModel.id);

  const version = await prisma.judgeModelVersion.create({
    data: {
      judgeModelId: judgeModel.id,
      ordinal: 1,
      servingBackend: overrides.servingBackend ?? 'openai',
      protocolSupport: { pointwise: ['score'] },
    },
  });
  createdVersionIds.push(version.id);

  const endpoint = await prisma.modelEndpoint.create({
    data: {
      userId,
      judgeModelVersionId: version.id,
      isActive: true,
      verifiedAt: new Date(),
    },
  });

  return { judgeModel, version, endpoint };
}

async function mkEvaluation(
  projectId: string,
  userId: string,
  opts: { rubricId?: string | null; judgeModelVersionIds: string[] }
) {
  const evaluation = await prisma.evaluation.create({
    data: {
      projectId,
      userId,
      inputText: 'fixture input',
      responseText: 'fixture response under judgment', // judge mode
      ...(opts.rubricId ? { rubricId: opts.rubricId } : {}),
      modelSelections: {
        create: opts.judgeModelVersionIds.map((judgeModelVersionId) => ({ judgeModelVersionId })),
      },
    },
  });
  createdEvaluationIds.push(evaluation.id);
  return evaluation;
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
  it('creates a pending run + pending judgments (judgeModelVersionId set, modelConfigId left null — Task 12 write path) and publishes exactly one judgment.execute per row', async () => {
    const user = await mkUser();
    const project = await mkProject(user.id);
    const rubric = await mkRubric(user.id);
    const modelA = await mkJudgeVersionWithEndpoint(user.id);
    const modelB = await mkJudgeVersionWithEndpoint(user.id);
    const evaluation = await mkEvaluation(project.id, user.id, {
      rubricId: rubric.id,
      judgeModelVersionIds: [modelA.version.id, modelB.version.id],
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
      expect(judgment.modelConfigId).toBeNull(); // Task 12: write path stops setting this
    }
    // Distinct versions -> distinct judge identities.
    expect(new Set(result.run.modelJudgments.map((j) => j.judgeModelVersionId))).toEqual(
      new Set([modelA.version.id, modelB.version.id])
    );

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
    const model = await mkJudgeVersionWithEndpoint(user.id);
    const evaluation = await mkEvaluation(project.id, user.id, {
      rubricId: rubric.id,
      judgeModelVersionIds: [model.version.id],
    });

    const result = await launchSingleRun(
      { evaluationId: evaluation.id, triggeredById: user.id },
      { publish: async () => { throw new Error('simulated broker outage'); } }
    );
    createdRunIds.push(result.run.id);

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
    const model = await mkJudgeVersionWithEndpoint(user.id);
    const evaluation = await mkEvaluation(project.id, user.id, {
      rubricId: rubric.id,
      judgeModelVersionIds: [model.version.id],
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
          // raised AFTER the broker already accepted it).
          await prisma.evaluationRun.update({
            where: { id: runId },
            data: { status: 'needs_human', finalizedAt: new Date() },
          });
          throw new Error('simulated in-doubt confirm timeout');
        },
      }
    );
    createdRunIds.push(result.run.id);

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
    const model = await mkJudgeVersionWithEndpoint(user.id);
    const evaluation = await mkEvaluation(project.id, user.id, {
      rubricId: rubric.id,
      judgeModelVersionIds: [model.version.id],
    });

    const response = await postRun(
      new Request(`http://localhost/api/evaluations/${evaluation.id}/runs`, { method: 'POST' }),
      { params: Promise.resolve({ id: evaluation.id }) }
    );
    expect(response.status).toBe(201);
    const body = await response.json();
    createdRunIds.push(body.id);

    expect(body.status).toBe('pending');
    expect(body.modelJudgments).toHaveLength(1);
    expect(body.modelJudgments[0].judgeModelVersionId).toBeTruthy();
  });

  it('no cross-user endpoint borrow: launching against a version the caller has no endpoint for fails with a clear 400, even if ANOTHER user has one', async () => {
    const owner = await mkUser();
    const stranger = await mkUser();
    const project = await mkProject(stranger.id);
    const rubric = await mkRubric(stranger.id);
    // owner has the endpoint; stranger does not.
    const model = await mkJudgeVersionWithEndpoint(owner.id);
    const evaluation = await mkEvaluation(project.id, stranger.id, {
      rubricId: rubric.id,
      judgeModelVersionIds: [model.version.id],
    });

    await expect(
      launchSingleRun({ evaluationId: evaluation.id, triggeredById: stranger.id })
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining(model.version.id),
    });
  });

  // A0 (Task 12): every rejection in launchSingleRun's protocol/candidate
  // validation block, pinned as a 400 with an actionable message. Each of
  // these otherwise surfaces as something that describes a symptom instead
  // of the cause: duplicate positions escape as a raw Prisma P2002 on
  // RunCandidate's @@unique([runId, position]) (a 500), and text-less
  // candidates survive all the way into buildPairwiseUserPrompt and come
  // back as a non_retryable "Failed to render judgment prompt".
  it('rejects unrunnable pairwise/listwise launches at the launch layer, before any row is written', async () => {
    const user = await mkUser();
    const project = await mkProject(user.id);
    const rubric = await mkRubric(user.id);
    const model = await mkJudgeVersionWithEndpoint(user.id);
    const evaluation = await mkEvaluation(project.id, user.id, {
      rubricId: rubric.id,
      judgeModelVersionIds: [model.version.id],
    });
    const base = { evaluationId: evaluation.id, triggeredById: user.id };
    const ok = [
      { position: 0, responseText: 'candidate zero' },
      { position: 1, responseText: 'candidate one' },
    ];

    await expect(
      launchSingleRun({ ...base, protocol: 'listwise', candidates: ok })
    ).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/not executable/i) });

    await expect(
      launchSingleRun({ ...base, protocol: 'pairwise', candidates: [ok[0]] })
    ).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/exactly 2 candidates, got 1/) });

    await expect(
      launchSingleRun({ ...base, protocol: 'pointwise', candidates: ok })
    ).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/takes no candidates/i) });

    await expect(
      launchSingleRun({
        ...base,
        protocol: 'pairwise',
        candidates: [
          { position: 0, responseText: 'a' },
          { position: 0, responseText: 'b' },
        ],
      })
    ).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/distinct candidate positions/i) });

    // Blank-text detection mirrors render.ts's `candidateText` exactly:
    // responseText ?? promptText, then trimmed. Whitespace-only counts as
    // empty; a null responseText falls back to promptText rather than
    // failing.
    await expect(
      launchSingleRun({
        ...base,
        protocol: 'pairwise',
        candidates: [
          { position: 0, responseText: 'a' },
          { position: 1, responseText: '   ', promptText: null },
        ],
      })
    ).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/position\(s\) \[1\] are empty/) });

    // Nothing above wrote a run — every rejection precedes the transaction.
    expect(await prisma.evaluationRun.count({ where: { evaluationId: evaluation.id } })).toBe(0);
  });
});

describe('launchBulkRunCreates (src/lib/run-launch.ts)', () => {
  it('2 evaluations, one with no rubric assigned -> 1 accepted / 1 failed; run.create published only for the accepted one', async () => {
    const user = await mkUser();
    const project = await mkProject(user.id);
    const rubric = await mkRubric(user.id);
    const model = await mkJudgeVersionWithEndpoint(user.id);

    const goodEvaluation = await mkEvaluation(project.id, user.id, {
      rubricId: rubric.id,
      judgeModelVersionIds: [model.version.id],
    });
    const badEvaluation = await mkEvaluation(project.id, user.id, {
      rubricId: null, // judge mode (responseText set) with no rubric -> invalid
      judgeModelVersionIds: [model.version.id],
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
      expect.objectContaining({ judgeModelVersionId: model.version.id, modelConfigId: null }),
    ]);
  });

  it('bulk launch end-to-end (Task 9 review fix #1, carried through Task 12): consumer-created judgments carry judgeModelVersionId (modelConfigId null), RunModelSelection rows exist, and the leaderboard join resolves via judgeModelVersion', async () => {
    const user = await mkUser();
    const project = await mkProject(user.id);
    const rubric = await mkRubric(user.id);
    const modelA = await mkJudgeVersionWithEndpoint(user.id);
    const modelB = await mkJudgeVersionWithEndpoint(user.id);
    const evaluation = await mkEvaluation(project.id, user.id, {
      rubricId: rubric.id,
      judgeModelVersionIds: [modelA.version.id, modelB.version.id],
    });

    const { confirmChannel } = await getRabbit();
    await assertTopology(confirmChannel);
    await confirmChannel.purgeQueue(QUEUE_RUN_CREATE);

    const result = await launchBulkRunCreates([evaluation.id], user.id);
    expect(result.accepted).toEqual([evaluation.id]);
    expect(result.failed).toEqual([]);

    // Producer side: the real, drained run.create message carries
    // {judgeModelVersionId, modelConfigId: null} per selected model.
    const published = await drainQueue(confirmChannel, QUEUE_RUN_CREATE);
    expect(published).toHaveLength(1);
    const msg = JSON.parse(published[0].content.toString()) as RunCreateMsg;
    expect(new Set(msg.runSpec.modelSelections.map((sel) => sel.judgeModelVersionId))).toEqual(
      new Set([modelA.version.id, modelB.version.id])
    );
    expect(msg.runSpec.modelSelections.every((sel) => sel.modelConfigId === null)).toBe(true);

    // Consumer side: feed the real drained message straight into the
    // run.create consumer (same "fabricated ConsumeMessage into handle()"
    // pattern tests/integration/worker-claims.test.ts uses) — no live
    // worker process needed to exercise the actual expansion.
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
      expect(judgment.modelConfigId).toBeNull(); // Task 12: no dual-write anymore
    }
    expect(new Set(judgments.map((j) => j.judgeModelVersionId))).toEqual(
      new Set([modelA.version.id, modelB.version.id])
    );

    // RunModelSelection rows — never written by the bulk path before the
    // Task 9 review fix; still written, now judgeModelVersionId-keyed.
    const selections = await prisma.runModelSelection.findMany({ where: { runId: run.id } });
    expect(new Set(selections.map((s) => s.judgeModelVersionId))).toEqual(
      new Set([modelA.version.id, modelB.version.id])
    );

    // The leaderboard aggregation path (src/app/api/leaderboard/route.ts)
    // now resolves identity via the judgeModelVersion/judgeModel join
    // (modelConfig is null on every Task-12-created row) — assert that
    // join is non-null for every judgment this bulk launch created.
    const withJudgeModelVersion = await prisma.modelJudgment.findMany({
      where: { runId: run.id },
      select: { judgeModelVersion: { select: { id: true, judgeModel: { select: { id: true } } } } },
    });
    expect(withJudgeModelVersion).toHaveLength(2);
    for (const j of withJudgeModelVersion) {
      expect(j.judgeModelVersion).not.toBeNull();
    }
  });

  it('no cross-user endpoint borrow: a bulk-launched evaluation whose selection has no endpoint owned by the triggering user fails per-evaluation, not silently', async () => {
    const owner = await mkUser();
    const stranger = await mkUser();
    const project = await mkProject(stranger.id);
    const rubric = await mkRubric(stranger.id);
    const model = await mkJudgeVersionWithEndpoint(owner.id); // NOT stranger's endpoint
    const evaluation = await mkEvaluation(project.id, stranger.id, {
      rubricId: rubric.id,
      judgeModelVersionIds: [model.version.id],
    });

    const result = await launchBulkRunCreates([evaluation.id], stranger.id);
    expect(result.accepted).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].reason).toContain(model.version.id);
  });

  it('end-to-end through the real POST /api/evaluations (dataset-batch, create_and_run) route: 202 with accepted/failed', async () => {
    const user = await mkUser();
    mockSessionFor(user);
    const project = await mkProject(user.id);
    const rubric = await mkRubric(user.id);
    const model = await mkJudgeVersionWithEndpoint(user.id);

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
          judgeModelVersionIds: [model.version.id],
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
  });

  // A0 (Task 12): `RunCreateMsg.protocol` became a real `RunProtocol`, so a
  // non-pointwise value is now REPRESENTABLE on this queue even though no
  // producer emits one (`launchBulkRunCreates` hardcodes 'pointwise'). The
  // consumer cannot expand one correctly — `RunCreateMsg` carries no
  // candidate set — so it must refuse rather than half-honour it. Without
  // the refusal, such a message expands as respond-mode (a pairwise
  // evaluation has no `responseText` for `deriveRunMode` to see), writing
  // judgments with promptTemplateId null and pairOrder 'AB' against a run
  // with zero RunCandidate rows.
  it('refuses a non-pointwise run.create: books an errored run and expands nothing (A0 — RunCreateMsg carries no candidate set)', async () => {
    const user = await mkUser();
    const project = await mkProject(user.id);
    const rubric = await mkRubric(user.id);
    const model = await mkJudgeVersionWithEndpoint(user.id);
    const evaluation = await mkEvaluation(project.id, user.id, {
      rubricId: rubric.id,
      judgeModelVersionIds: [model.version.id],
    });

    const msg: RunCreateMsg = {
      evaluationId: evaluation.id,
      runSpec: {
        rubricId: rubric.id,
        modelSelections: [{ judgeModelVersionId: model.version.id, modelConfigId: null }],
        triggeredById: user.id,
        protocol: 'pairwise',
      },
    };

    const consumer = createRunCreateConsumer();
    const ch = fakeChannel();
    await consumer.handle(fakeMessage(msg), ch);

    // Acked, not requeued — a deterministic refusal would fail identically forever.
    expect(ch.ackCalls).toHaveLength(1);

    // Recorded as a visible errored run (recordExpansionFailure's
    // never-committed branch), not silently swallowed.
    const run = await prisma.evaluationRun.findFirstOrThrow({ where: { evaluationId: evaluation.id } });
    createdRunIds.push(run.id);
    expect(run.status).toBe('error');

    // Nothing expanded: no judgments, no selections, and therefore no row
    // carrying pairOrder 'AB' with nothing to compare.
    expect(await prisma.modelJudgment.count({ where: { runId: run.id } })).toBe(0);
    expect(await prisma.runModelSelection.count({ where: { runId: run.id } })).toBe(0);
  });
});

describe('GET /api/stats — DB-backed queue counts (replaces getQueueStats())', () => {
  it('returns queue.{pendingRuns,judgingRuns,pendingJudgments,runningJudgments,rabbitHealthy} reflecting real DB state', async () => {
    const user = await mkUser();
    mockSessionFor(user);
    const project = await mkProject(user.id);
    const rubric = await mkRubric(user.id);
    const model = await mkJudgeVersionWithEndpoint(user.id);
    const evaluation = await mkEvaluation(project.id, user.id, {
      rubricId: rubric.id,
      judgeModelVersionIds: [model.version.id],
    });

    const launch = await launchSingleRun({ evaluationId: evaluation.id, triggeredById: user.id });
    createdRunIds.push(launch.run.id);

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
