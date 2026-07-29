import { afterAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { getServerSession } from 'next-auth';
import type { Channel, ConsumeMessage } from 'amqplib';
import { prisma } from '@/lib/db';
import { closeRabbit, getRabbit } from '@/lib/queue/connection';
import { assertTopology, QUEUE_JUDGMENT_EXECUTE, QUEUE_RUN_CREATE } from '@/lib/queue/topology';
import type { JudgmentExecuteMsg, RunCreateMsg } from '@/lib/queue/publish';
import { launchSingleRun, launchBulkRunCreates } from '@/lib/run-launch';
import {
  createJudgmentConsumer,
  type ProviderFn,
  type RespondProviderFn,
  type RunProviderJudgmentInput,
  type RunProviderResponseInput,
} from '@/worker/judgment-consumer';
import { createRunCreateConsumer } from '@/worker/run-create-consumer';
import { seedPromptTemplates } from '../../prisma/seed-prompt-templates';
import { POST as postHumanJudgment } from '@/app/api/evaluations/[id]/runs/[runId]/human-judgment/route';

// Integration suite — Task 9b (respond-mode restored as a first-class queue
// path, Trijeet decision 2026-07-29). Needs a live Postgres, a live
// RabbitMQ, and a live Redis (requireAuth()'s apiLimiter, gated through the
// human-judgment route) — same trio as tests/integration/producer.test.ts
// and worker-claims.test.ts, whose fixture/fake conventions this file
// mirrors. Run via `npm run test:integration`.
//
// v1's exact respond judgment shape (git show
// 2610871:src/lib/evaluation-run-manager.ts, the deleted in-process engine)
// is the contract under test: overallScore null, the generated text lands
// in `reasoning` (NOT a new field — src/app/evaluate/[id]/runs/[runId]/
// page.tsx's ModelJudgmentCard already reads `judgment.reasoning` for both
// modes), criteriaScores null, status completed, run finishes needs_human
// awaiting a human's best-model pick.

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
 * producer.test.ts's / worker-claims.test.ts's `drainQueue`. */
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

/** Judge-mode fake provider — same fixture shape worker-claims.test.ts /
 * finalization.test.ts use for the `provider` (judge) seam. Used ONLY by
 * the mode-dispatch regression test below to prove judge-mode still routes
 * through this seam and NOT the new respond one. */
function fakeJudgeProvider(callLog: RunProviderJudgmentInput[]): ProviderFn {
  return async (input) => {
    callLog.push(input);
    return {
      overallScore: 8,
      reasoning: 'fixture judge reasoning',
      criteriaScores: [
        { criterionId: 'c1', criterionName: 'Accuracy', score: 8, maxScore: 10, weight: 1, comment: 'fixture' },
      ],
      rawResponse: 'fixture judge raw response',
      latencyMs: 42,
      tokenCount: 100,
    };
  };
}

/** Respond-mode fake provider — the `providerResponse` seam under test.
 * Deliberately distinct fixture text from `fakeJudgeProvider`'s so the
 * mixed regression test can assert each judgment landed via the RIGHT
 * seam by inspecting the persisted `reasoning` text alone. */
function fakeRespondProvider(callLog: RunProviderResponseInput[]): RespondProviderFn {
  return async (input) => {
    callLog.push(input);
    return {
      responseText: 'fixture generated response',
      rawResponse: 'fixture respond raw response',
      latencyMs: 42,
      tokenCount: 100,
    };
  };
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
    data: { email: `${uniq('respond-mode-user')}@test.local`, passwordHash: 'fixture-hash' },
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
      protocolSupport: { pointwise: ['score'] },
    },
  });
  createdVersionIds.push(version.id);

  const endpoint = await prisma.modelEndpoint.create({
    data: { userId, judgeModelVersionId: version.id, isActive: true, verifiedAt: new Date() },
  });

  return { judgeModel, version, endpoint };
}

/** `mode: 'judge'` sets responseText (an existing response is being
 * scored); `mode: 'respond'` sets promptText and leaves responseText unset
 * (no response exists yet — each selected model generates one). Mirrors
 * src/lib/run-mode.ts's `deriveRunMode` exactly — this fixture is what
 * makes each test's evaluation land in the mode its name claims. */
async function mkEvaluation(
  projectId: string,
  userId: string,
  opts: { mode: 'judge' | 'respond'; rubricId?: string | null; judgeModelVersionIds: string[] }
) {
  const evaluation = await prisma.evaluation.create({
    data: {
      projectId,
      userId,
      inputText: 'fixture input',
      ...(opts.mode === 'judge'
        ? { responseText: 'fixture response under judgment' }
        : { promptText: 'fixture prompt to respond to' }),
      ...(opts.rubricId ? { rubricId: opts.rubricId } : {}),
      modelSelections: {
        create: opts.judgeModelVersionIds.map((judgeModelVersionId) => ({ judgeModelVersionId })),
      },
    },
  });
  createdEvaluationIds.push(evaluation.id);
  return evaluation;
}

/** Tracks a judgeModelVersionId (and its parent JudgeModel) for FK-safe
 * cleanup — same convention as producer.test.ts / worker-claims.test.ts. */
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
  // FK-safe order — see producer.test.ts's / worker-claims.test.ts's own
  // afterAll for the full rationale.
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
  await seedPromptTemplates(prisma); // idempotent — the judge-mode regression case below needs a pointwise PromptTemplate row
});

describe('respond-mode: single run (launchSingleRun + judgment-consumer)', () => {
  it('launches with no rubric; the worker persists generated text into `reasoning` (v1 shape) via the respond seam; run finishes needs_human', async () => {
    const user = await mkUser();
    const project = await mkProject(user.id);
    const modelA = await mkJudgeVersionWithEndpoint(user.id);
    const modelB = await mkJudgeVersionWithEndpoint(user.id);
    const evaluation = await mkEvaluation(project.id, user.id, {
      mode: 'respond',
      judgeModelVersionIds: [modelA.version.id, modelB.version.id],
    });

    const { confirmChannel } = await getRabbit();
    await assertTopology(confirmChannel);
    await confirmChannel.purgeQueue(QUEUE_JUDGMENT_EXECUTE);

    const result = await launchSingleRun({ evaluationId: evaluation.id, triggeredById: user.id });
    createdRunIds.push(result.run.id);

    // No 501, no rubric requirement — launch succeeds exactly like judge
    // mode, just with rubricId/promptTemplateId left null.
    expect(result.publishFailed).toBe(false);
    expect(result.run.status).toBe('pending');
    expect(result.run.rubricId).toBeNull();
    expect(result.run.modelJudgments).toHaveLength(2);
    for (const judgment of result.run.modelJudgments) {
      expect(judgment.promptTemplateId).toBeNull(); // v1 shape: no rubric template to render
      expect(judgment.judgeModelVersionId).toBeTruthy();
      await trackJudgeIdentity(judgment.judgeModelVersionId!);
    }

    const published = await drainQueue(confirmChannel, QUEUE_JUDGMENT_EXECUTE);
    expect(published).toHaveLength(2);

    // `provider` (judge seam) deliberately NOT injected — if mode
    // derivation ever misrouted a respond judgment to the judge seam, the
    // real `defaultRunProviderJudgment` would run (no rubric -> it would
    // throw reading `rubric.criteria` on a null rubric, or the caller-side
    // guard above would already have errored the judgment) rather than
    // silently succeeding through the seam under test.
    const calls: RunProviderResponseInput[] = [];
    const consumer = createJudgmentConsumer({ providerResponse: fakeRespondProvider(calls) });

    for (const raw of published) {
      const msg = JSON.parse(raw.content.toString()) as JudgmentExecuteMsg;
      const ch = fakeChannel();
      // eslint-disable-next-line no-await-in-loop -- sequential, small N (2 judgments), no ordering dependency to parallelize around
      await consumer.handle(fakeMessage(msg), ch);
      expect(ch.ackCalls).toHaveLength(1);
    }

    expect(calls).toHaveLength(2); // both judgments went through the respond seam

    const judgments = await prisma.modelJudgment.findMany({ where: { runId: result.run.id } });
    expect(judgments).toHaveLength(2);
    for (const judgment of judgments) {
      expect(judgment.status).toBe('completed');
      expect(judgment.error).toBeNull();
      expect(judgment.overallScore).toBeNull(); // v1 shape: no scoring concept in respond mode
      expect(judgment.reasoning).toBe('fixture generated response'); // v1 shape: generated text -> reasoning
      expect(judgment.criteriaScores).toBeNull(); // v1 shape: Prisma.DbNull
      expect(judgment.rawResponse).toBe('fixture respond raw response');
      expect(judgment.latencyMs).toBe(42);
      expect(judgment.tokenCount).toBe(100);
    }

    const run = await prisma.evaluationRun.findUniqueOrThrow({ where: { id: result.run.id } });
    expect(run.status).toBe('needs_human'); // completed generation, awaiting a human's best-model pick
    expect(run.finalizedAt).not.toBeNull();
  });
});

describe('respond-mode: bulk launch (launchBulkRunCreates + run-create-consumer)', () => {
  it('accepts a respond-mode evaluation with NO rubric assigned; run.create expansion writes promptTemplateId:null judgments that complete via the respond seam', async () => {
    const user = await mkUser();
    const project = await mkProject(user.id);
    const model = await mkJudgeVersionWithEndpoint(user.id);
    const evaluation = await mkEvaluation(project.id, user.id, {
      mode: 'respond',
      rubricId: null,
      judgeModelVersionIds: [model.version.id],
    });

    const { confirmChannel } = await getRabbit();
    await assertTopology(confirmChannel);
    await confirmChannel.purgeQueue(QUEUE_RUN_CREATE);

    const result = await launchBulkRunCreates([evaluation.id], user.id);
    // The old (Task 9) behavior 501'd this exact shape (no rubric, no
    // responseText) via RESPOND_MODE_UNSUPPORTED_MESSAGE — asserting
    // `failed` is empty is the direct regression check for that removal.
    expect(result.failed).toEqual([]);
    expect(result.accepted).toEqual([evaluation.id]);

    const published = await drainQueue(confirmChannel, QUEUE_RUN_CREATE);
    expect(published).toHaveLength(1);
    const msg = JSON.parse(published[0].content.toString()) as RunCreateMsg;
    expect(msg.runSpec.rubricId).toBeUndefined();
    for (const sel of msg.runSpec.modelSelections) {
      await trackJudgeIdentity(sel.judgeModelVersionId);
    }

    await confirmChannel.purgeQueue(QUEUE_JUDGMENT_EXECUTE);
    const runCreateConsumer = createRunCreateConsumer();
    const rcCh = fakeChannel();
    await runCreateConsumer.handle(fakeMessage(msg), rcCh);
    expect(rcCh.ackCalls).toHaveLength(1);

    const run = await prisma.evaluationRun.findFirstOrThrow({ where: { evaluationId: evaluation.id } });
    createdRunIds.push(run.id);
    expect(run.rubricId).toBeNull();
    expect(run.status).toBe('pending');

    const judgments = await prisma.modelJudgment.findMany({ where: { runId: run.id } });
    expect(judgments).toHaveLength(1);
    expect(judgments[0].promptTemplateId).toBeNull(); // mode-conditional gate — no rubric template resolved for respond expansion

    const executePublished = await drainQueue(confirmChannel, QUEUE_JUDGMENT_EXECUTE);
    expect(executePublished).toHaveLength(1);

    const calls: RunProviderResponseInput[] = [];
    const consumer = createJudgmentConsumer({ providerResponse: fakeRespondProvider(calls) });
    const execMsg = JSON.parse(executePublished[0].content.toString()) as JudgmentExecuteMsg;
    await consumer.handle(fakeMessage(execMsg), fakeChannel());
    expect(calls).toHaveLength(1);

    const persisted = await prisma.modelJudgment.findUniqueOrThrow({ where: { id: judgments[0].id } });
    expect(persisted.status).toBe('completed');
    expect(persisted.overallScore).toBeNull();
    expect(persisted.reasoning).toBe('fixture generated response');

    const finalRun = await prisma.evaluationRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(finalRun.status).toBe('needs_human');
  });
});

describe('mode-dispatch regression: judge and respond runs handled by the SAME consumer instance route to distinct provider seams', () => {
  it('a judge-mode judgment is handled only by `provider`; a respond-mode judgment is handled only by `providerResponse` — never crossed', async () => {
    const user = await mkUser();
    const project = await mkProject(user.id);
    const rubric = await mkRubric(user.id);
    const judgeModel = await mkJudgeVersionWithEndpoint(user.id);
    const respondModel = await mkJudgeVersionWithEndpoint(user.id);

    const judgeEval = await mkEvaluation(project.id, user.id, {
      mode: 'judge',
      rubricId: rubric.id,
      judgeModelVersionIds: [judgeModel.version.id],
    });
    const respondEval = await mkEvaluation(project.id, user.id, {
      mode: 'respond',
      judgeModelVersionIds: [respondModel.version.id],
    });

    const { confirmChannel } = await getRabbit();
    await assertTopology(confirmChannel);
    await confirmChannel.purgeQueue(QUEUE_JUDGMENT_EXECUTE);

    const judgeLaunch = await launchSingleRun({ evaluationId: judgeEval.id, triggeredById: user.id });
    createdRunIds.push(judgeLaunch.run.id);
    const respondLaunch = await launchSingleRun({ evaluationId: respondEval.id, triggeredById: user.id });
    createdRunIds.push(respondLaunch.run.id);
    for (const judgment of [...judgeLaunch.run.modelJudgments, ...respondLaunch.run.modelJudgments]) {
      await trackJudgeIdentity(judgment.judgeModelVersionId!);
    }
    // Judge-mode judgment gets a real promptTemplateId; respond-mode gets
    // null — the same mode-conditional gate under test in the "single run"
    // describe block above, asserted again here for the mixed case.
    expect(judgeLaunch.run.modelJudgments[0].promptTemplateId).toBeTruthy();
    expect(respondLaunch.run.modelJudgments[0].promptTemplateId).toBeNull();

    const judgeCalls: RunProviderJudgmentInput[] = [];
    const respondCalls: RunProviderResponseInput[] = [];
    const consumer = createJudgmentConsumer({
      provider: fakeJudgeProvider(judgeCalls),
      providerResponse: fakeRespondProvider(respondCalls),
    });

    const published = await drainQueue(confirmChannel, QUEUE_JUDGMENT_EXECUTE);
    expect(published).toHaveLength(2);
    for (const raw of published) {
      const msg = JSON.parse(raw.content.toString()) as JudgmentExecuteMsg;
      const ch = fakeChannel();
      // eslint-disable-next-line no-await-in-loop -- sequential, small N (2 judgments), no ordering dependency to parallelize around
      await consumer.handle(fakeMessage(msg), ch);
      expect(ch.ackCalls).toHaveLength(1);
    }

    expect(judgeCalls).toHaveLength(1); // exactly the judge-mode judgment
    expect(respondCalls).toHaveLength(1); // exactly the respond-mode judgment

    const judgeJudgment = await prisma.modelJudgment.findFirstOrThrow({ where: { runId: judgeLaunch.run.id } });
    expect(judgeJudgment.status).toBe('completed');
    expect(judgeJudgment.overallScore).toBe(8);
    expect(judgeJudgment.reasoning).toBe('fixture judge reasoning');
    expect(Array.isArray(judgeJudgment.criteriaScores)).toBe(true);

    const respondJudgment = await prisma.modelJudgment.findFirstOrThrow({ where: { runId: respondLaunch.run.id } });
    expect(respondJudgment.status).toBe('completed');
    expect(respondJudgment.overallScore).toBeNull();
    expect(respondJudgment.reasoning).toBe('fixture generated response');
    expect(respondJudgment.criteriaScores).toBeNull();

    const judgeRun = await prisma.evaluationRun.findUniqueOrThrow({ where: { id: judgeLaunch.run.id } });
    expect(judgeRun.status).toBe('needs_human');
    const respondRun = await prisma.evaluationRun.findUniqueOrThrow({ where: { id: respondLaunch.run.id } });
    expect(respondRun.status).toBe('needs_human');
  });
});

describe('respond-mode: human best-model selection completes the run (human-judgment route -> markRunCompleted)', () => {
  it('POSTing selectedBestModelId on a needs_human respond run transitions it to completed', async () => {
    const user = await mkUser();
    mockSessionFor(user);
    const project = await mkProject(user.id);
    const model = await mkJudgeVersionWithEndpoint(user.id);
    const evaluation = await mkEvaluation(project.id, user.id, { mode: 'respond', judgeModelVersionIds: [model.version.id] });

    const { confirmChannel } = await getRabbit();
    await assertTopology(confirmChannel);
    await confirmChannel.purgeQueue(QUEUE_JUDGMENT_EXECUTE);

    const launch = await launchSingleRun({ evaluationId: evaluation.id, triggeredById: user.id });
    createdRunIds.push(launch.run.id);
    for (const judgment of launch.run.modelJudgments) {
      await trackJudgeIdentity(judgment.judgeModelVersionId!);
    }

    const published = await drainQueue(confirmChannel, QUEUE_JUDGMENT_EXECUTE);
    const consumer = createJudgmentConsumer({ providerResponse: fakeRespondProvider([]) });
    for (const raw of published) {
      const msg = JSON.parse(raw.content.toString()) as JudgmentExecuteMsg;
      // eslint-disable-next-line no-await-in-loop -- sequential, small N (1 judgment here), no ordering dependency to parallelize around
      await consumer.handle(fakeMessage(msg), fakeChannel());
    }

    const preRun = await prisma.evaluationRun.findUniqueOrThrow({ where: { id: launch.run.id } });
    expect(preRun.status).toBe('needs_human');

    const completedJudgment = await prisma.modelJudgment.findFirstOrThrow({ where: { runId: launch.run.id } });
    expect(completedJudgment.judgeModelVersionId).toBe(model.version.id);
    expect(completedJudgment.modelConfigId).toBeNull(); // Task 12: write path stops setting this

    const response = await postHumanJudgment(
      new Request(`http://localhost/api/evaluations/${evaluation.id}/runs/${launch.run.id}/human-judgment`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ selectedBestModelId: completedJudgment.judgeModelVersionId }),
      }),
      { params: Promise.resolve({ id: evaluation.id, runId: launch.run.id }) }
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    // Task 12: a judgeModelVersionId-shaped selection lands in the NEW
    // selectedBestJudgeModelVersionId column, not the legacy one.
    expect(body.selectedBestJudgeModelVersionId).toBe(model.version.id);
    expect(body.selectedBestModelId).toBeNull();
    expect(body.overallScore).toBe(0); // placeholder — respond mode has no scoring concept (resolveHumanJudgmentScore)

    // markRunCompleted's guarded needs_human -> completed transition.
    const finalRun = await prisma.evaluationRun.findUniqueOrThrow({ where: { id: launch.run.id } });
    expect(finalRun.status).toBe('completed');
    expect(finalRun.finalizedAt).not.toBeNull();
  });
});
