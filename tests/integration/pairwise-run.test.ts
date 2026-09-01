import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Channel, ConsumeMessage } from 'amqplib';
import { prisma } from '@/lib/db';
import { closeRabbit, getRabbit } from '@/lib/queue/connection';
import { assertTopology } from '@/lib/queue/topology';
import { LANE_FALLBACK_QUEUE, LANE_QUEUES } from '@/lib/queue/lanes';
import type { JudgmentExecuteMsg } from '@/lib/queue/publish';
import { launchSingleRun } from '@/lib/run-launch';
import {
  createJudgmentConsumer,
  type PairwiseProviderFn,
  type RunProviderPairwiseInput,
} from '@/worker/judgment-consumer';
import { seedPromptTemplates, V1_PAIRWISE_JUDGMENT_SYSTEM_PROMPT } from '../../prisma/seed-prompt-templates';

// A0 integration suite — pairwise execution. Needs a live Postgres, a live
// RabbitMQ and a live Redis, the same trio as tests/integration/
// respond-mode.test.ts and producer.test.ts, whose fixture and cleanup
// conventions this file mirrors exactly (persistent DB, per-file id
// tracking, FK-safe afterAll — never truncateAll, which would nuke the
// other integration files' state). Run via `npm run test:integration`.
//
// The contract under test is A0 exit gate #5: a pairwise run completes with
// `ModelJudgment.verdict` and `ModelJudgment.pairOrder = 'AB'` populated,
// `overallScore` left NULL, and its RunCandidate comparison set written
// transactionally with the run.
//
// The launch path is `launchSingleRun`, and ONLY `launchSingleRun`: the
// `run.create` queue path refuses every non-pointwise message up front
// (src/worker/run-create-consumer.ts's first guard in `handle()`), because
// `RunCreateMsg` carries no candidate set to expand a comparison against.
// That refusal is covered by tests/integration/producer.test.ts, not here.

/** Consumes every message currently on `queue` until `quietMs` elapses with
 * no new arrival, acking each. Mirrors respond-mode.test.ts's `drainQueue`. */
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

function fakeChannel(): SpyChannel {
  const ackCalls: ConsumeMessage[] = [];
  return {
    ack: (msg: ConsumeMessage) => {
      ackCalls.push(msg);
    },
    ackCalls,
  } as unknown as SpyChannel;
}

function fakePairwiseProvider(callLog: RunProviderPairwiseInput[]): PairwiseProviderFn {
  return async (input) => {
    callLog.push(input);
    return {
      verdict: 'B',
      reasoning: 'fixture pairwise reasoning',
      rawResponse: '{"verdict":"B","reasoning":"fixture pairwise reasoning"}',
      latencyMs: 42,
      tokenCount: 100,
    };
  };
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

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
    data: { email: `${uniq('pairwise-user')}@test.local`, passwordHash: 'fixture-hash' },
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

async function mkJudgeVersionWithEndpoint(userId: string) {
  const judgeModel = await prisma.judgeModel.create({
    data: {
      name: uniq('fixture-judge'),
      slug: uniq('fixture-judge-slug'),
      judgeClass: 'prompted_api',
      scoringMechanism: 'critique_generative',
      baseModel: uniq('fixture-base-model'),
    },
  });
  createdJudgeModelIds.push(judgeModel.id);

  const version = await prisma.judgeModelVersion.create({
    data: {
      judgeModelId: judgeModel.id,
      ordinal: 1,
      servingBackend: 'openai',
      protocolSupport: { pairwise: ['verdict'] },
    },
  });
  createdVersionIds.push(version.id);

  await prisma.modelEndpoint.create({
    data: { userId, judgeModelVersionId: version.id, isActive: true, verifiedAt: new Date() },
  });

  return { judgeModel, version };
}

/** A pairwise evaluation carries ONLY the question. The two responses are
 * RunCandidate rows, not evaluation columns — which is exactly why
 * `deriveRunMode` must not decide a pairwise run's mode. */
async function mkPairwiseEvaluation(projectId: string, userId: string, rubricId: string, versionIds: string[]) {
  const evaluation = await prisma.evaluation.create({
    data: {
      projectId,
      userId,
      rubricId,
      inputText: 'What is the capital of France?',
      modelSelections: { create: versionIds.map((judgeModelVersionId) => ({ judgeModelVersionId })) },
    },
  });
  createdEvaluationIds.push(evaluation.id);
  return evaluation;
}

afterAll(async () => {
  await prisma.evaluationRun.deleteMany({ where: { id: { in: createdRunIds } } });
  await prisma.evaluation.deleteMany({ where: { id: { in: createdEvaluationIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.judgeModelVersion.deleteMany({ where: { id: { in: createdVersionIds } } });
  await prisma.judgeModel.deleteMany({ where: { id: { in: createdJudgeModelIds } } });

  await closeRabbit();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await seedPromptTemplates(prisma); // idempotent — this suite needs the v1-pairwise row
});

describe('a0 pairwise: the seeder ships a runnable v1-pairwise template', () => {
  it('upserts a pairwise PromptTemplate under a distinct name (@@unique is [name, version])', async () => {
    const pairwise = await prisma.promptTemplate.findUnique({
      where: { name_version: { name: 'v1-pairwise', version: 0 } },
    });
    expect(pairwise).not.toBeNull();
    expect(pairwise!.protocol).toBe('pairwise');
    expect(pairwise!.body).toBe(V1_PAIRWISE_JUDGMENT_SYSTEM_PROMPT);

    const legacy = await prisma.promptTemplate.findUnique({
      where: { name_version: { name: 'v1-legacy', version: 0 } },
    });
    expect(legacy!.protocol).toBe('pointwise');
  });
});

describe('a0 pairwise: launchSingleRun + judgment-consumer end to end', () => {
  it('persists verdict and pairOrder "AB", leaves overallScore NULL, and pins the v1-pairwise template', async () => {
    const user = await mkUser();
    const project = await mkProject(user.id);
    const rubric = await mkRubric(user.id);
    const judge = await mkJudgeVersionWithEndpoint(user.id);
    const evaluation = await mkPairwiseEvaluation(project.id, user.id, rubric.id, [judge.version.id]);

    const { confirmChannel } = await getRabbit();
    await assertTopology(confirmChannel);
    await purgeExecuteQueues(confirmChannel);

    // Passed in DESCENDING position order on purpose. `position`, not array
    // index, is what defines which candidate is A and which is B — so every
    // ordering assertion below is only meaningful if the two disagree here.
    const result = await launchSingleRun({
      evaluationId: evaluation.id,
      triggeredById: user.id,
      protocol: 'pairwise',
      candidates: [
        { position: 1, promptText: null, responseText: 'Lyon is the capital.', label: null },
        { position: 0, promptText: null, responseText: 'Paris is the capital.', label: 'A>B' },
      ],
    });
    createdRunIds.push(result.run.id);

    expect(result.publishFailed).toBe(false);
    expect(result.run.protocol).toBe('pairwise');
    expect(result.run.rubricId).toBe(rubric.id);

    // RunCandidate rows land in the SAME transaction as the run.
    const candidates = await prisma.runCandidate.findMany({
      where: { runId: result.run.id },
      orderBy: { position: 'asc' },
    });
    expect(candidates).toHaveLength(2);
    expect(candidates[0].responseText).toBe('Paris is the capital.');
    expect(candidates[0].label).toBe('A>B');
    expect(candidates[1].responseText).toBe('Lyon is the capital.');

    // pairOrder written explicitly at creation, and the pinned template is
    // the pairwise one — not v1-legacy.
    const pairwiseTemplate = await prisma.promptTemplate.findUniqueOrThrow({
      where: { name_version: { name: 'v1-pairwise', version: 0 } },
    });
    const created = await prisma.modelJudgment.findFirstOrThrow({ where: { runId: result.run.id } });
    expect(created.pairOrder).toBe('AB');
    expect(created.promptTemplateId).toBe(pairwiseTemplate.id);
    expect(created.verdict).toBeNull();

    const published = await drainExecuteQueues(confirmChannel);
    expect(published).toHaveLength(1);

    // `provider`/`providerResponse` deliberately NOT injected — if protocol
    // dispatch ever misrouted a pairwise judgment, the real pointwise or
    // respond seam would run and this assertion set would fail loudly
    // instead of quietly passing through the wrong path.
    const calls: RunProviderPairwiseInput[] = [];
    const consumer = createJudgmentConsumer({ providerPairwise: fakePairwiseProvider(calls) });

    const execMsg = JSON.parse(published[0].content.toString()) as JudgmentExecuteMsg;
    const ch = fakeChannel();
    await consumer.handle(fakeMessage(execMsg), ch);
    expect(ch.ackCalls).toHaveLength(1);

    // The A slot is the position-0 candidate — the order the judge is shown
    // comes from `position`, never from the order the candidates arrived in.
    expect(calls).toHaveLength(1);
    expect(calls[0].run.runCandidates.map((c) => c.position)).toEqual([0, 1]);
    expect(calls[0].run.runCandidates.map((c) => c.responseText)).toEqual([
      'Paris is the capital.',
      'Lyon is the capital.',
    ]);

    const persisted = await prisma.modelJudgment.findUniqueOrThrow({ where: { id: created.id } });
    expect(persisted.status).toBe('completed');
    expect(persisted.error).toBeNull();
    expect(persisted.verdict).toBe('B'); // stored RAW, as the model said it
    expect(persisted.pairOrder).toBe('AB'); // unchanged by persistence
    expect(persisted.overallScore).toBeNull(); // a preference is not a score
    expect(persisted.criteriaScores).toBeNull();
    expect(persisted.reasoning).toBe('fixture pairwise reasoning');
    expect(persisted.rawResponse).toBe('{"verdict":"B","reasoning":"fixture pairwise reasoning"}');
    expect(persisted.latencyMs).toBe(42);

    const run = await prisma.evaluationRun.findUniqueOrThrow({ where: { id: result.run.id } });
    expect(run.status).toBe('needs_human');
    expect(run.finalizedAt).not.toBeNull();
  });

  it('rejects a pairwise launch that does not carry exactly 2 candidates', async () => {
    const user = await mkUser();
    const project = await mkProject(user.id);
    const rubric = await mkRubric(user.id);
    const judge = await mkJudgeVersionWithEndpoint(user.id);
    const evaluation = await mkPairwiseEvaluation(project.id, user.id, rubric.id, [judge.version.id]);

    await expect(
      launchSingleRun({
        evaluationId: evaluation.id,
        triggeredById: user.id,
        protocol: 'pairwise',
        candidates: [{ position: 0, responseText: 'only one' }],
      })
    ).rejects.toThrow(/exactly 2 candidates, got 1/);

    expect(await prisma.evaluationRun.count({ where: { evaluationId: evaluation.id } })).toBe(0);
  });

  it('refuses to launch a listwise run (storable and annotatable in A0, not runnable)', async () => {
    const user = await mkUser();
    const project = await mkProject(user.id);
    const rubric = await mkRubric(user.id);
    const judge = await mkJudgeVersionWithEndpoint(user.id);
    const evaluation = await mkPairwiseEvaluation(project.id, user.id, rubric.id, [judge.version.id]);

    await expect(
      launchSingleRun({ evaluationId: evaluation.id, triggeredById: user.id, protocol: 'listwise' })
    ).rejects.toThrow(/Listwise runs are not executable/);
  });
});
