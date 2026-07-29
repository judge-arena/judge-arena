import { afterAll, describe, expect, it } from 'vitest';
import type { Channel, ConsumeMessage } from 'amqplib';
import { prisma } from '@/lib/db';
import { closeRabbit, getRabbit } from '@/lib/queue/connection';
import {
  assertTopology,
  QUEUE_DLQ,
  QUEUE_JUDGMENT_EXECUTE,
  QUEUE_JUDGMENT_RETRY_30S,
  QUEUE_JUDGMENT_RETRY_5M,
} from '@/lib/queue/topology';
import { type DlqEnvelope, type JudgmentExecuteMsg, type RunCreateMsg } from '@/lib/queue/publish';
import { ProviderError } from '@/lib/llm/errors';
import {
  claimJudgment,
  LEASE_MS,
} from '@/worker/claim';
import {
  createJudgmentConsumer,
  type ProviderFn,
  type RunProviderJudgmentInput,
} from '@/worker/judgment-consumer';
import { createRunCreateConsumer } from '@/worker/run-create-consumer';
import { seedPromptTemplates } from '../../prisma/seed-prompt-templates';

// Integration suite — needs a live Postgres (see .env.test's DATABASE_URL,
// same `judge_arena_test` DB tests/db/** uses — `npm run test:integration`
// doesn't run `prisma migrate reset` itself, it relies on the schema
// already being migrated, e.g. by a prior `npm run test:db` run) AND a live
// RabbitMQ (see .env.test's RABBITMQ_URL, the podman `judge-arena-rabbitmq`
// container) for the run.create publish-count assertion. Run via `npm run
// test:integration`, never as part of plain `npm test`.
//
// Task 7's brief: "duplicate delivery of one judgment message -> exactly
// one provider call ... claim-abandon ... stale reclaim past lease ...
// run.create redelivery -> no duplicate judgment rows." Most scenarios here
// call `judgmentConsumer.handle()`/`runCreateConsumer.handle()` directly
// against a hand-built `ConsumeMessage`-shaped object and a spy `Channel`
// (no real broker round trip needed to exercise claim/dedupe LOGIC — that's
// pure DB + in-process code) — only the run.create test additionally drains
// the real `judgment.execute` queue, since "exactly one publish per row,
// not doubled" is a real-broker question `defaultRunProviderJudgment`
// itself is never exercised (every test injects a fake provider), so no
// live LLM/Redis-breaker dependency exists here either.

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
// File-local (mirrors tests/db/**'s own "shared only once actually shared"
// convention) — kept intentionally simple: every helper below pushes the
// ids it creates into the module-level cleanup arrays so a single afterAll
// pass can tear everything down in FK-safe order, regardless of which test
// created what. This suite runs against a persistent DB (no migrate reset
// between runs, unlike tests/db/**), so leaving rows behind would
// accumulate garbage across repeated `npm run test:integration` runs.

const createdUserIds: string[] = [];
const createdJudgeModelIds: string[] = [];
const createdVersionIds: string[] = [];
const createdRunIds: string[] = [];

let uniqCounter = 0;
function uniq(label: string): string {
  uniqCounter += 1;
  return `${label}-${Date.now()}-${uniqCounter}`;
}

async function mkUser() {
  const user = await prisma.user.create({
    data: { email: `${uniq('worker-claims-user')}@test.local`, passwordHash: 'fixture-hash' },
  });
  createdUserIds.push(user.id);
  return user;
}

async function mkProject(userId: string) {
  return prisma.project.create({ data: { name: 'fixture-project', userId } });
}

async function mkEvaluation(projectId: string, userId: string) {
  // responseText set -> judge mode (src/lib/run-mode.ts's deriveRunMode).
  // Every test in this file exercises the judge-mode provider seam
  // (`provider`, injected as `fakeProvider`) with a rubric attached — see
  // tests/integration/respond-mode.test.ts for this file's respond-mode
  // counterpart, added by Task 9b.
  return prisma.evaluation.create({
    data: { projectId, userId, inputText: 'fixture input', responseText: 'fixture response under judgment' },
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

async function mkEvaluationRun(evaluationId: string, triggeredById: string, rubricId: string) {
  const run = await prisma.evaluationRun.create({
    data: { evaluationId, triggeredById, rubricId },
  });
  createdRunIds.push(run.id);
  return run;
}

async function mkModelConfig(userId: string) {
  // Tracked for cleanup via the owning user's cascade (ModelConfig.userId is
  // Cascade) — no separate tracking array needed, same convention as
  // mkEndpoint above.
  return prisma.modelConfig.create({
    data: {
      name: uniq('fixture-model'),
      provider: 'openai',
      modelId: uniq('fixture-model-id'),
      isActive: true,
      isVerified: true,
      userId,
    },
  });
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
  // Cascade-deleted with its owning User (ModelEndpoint.user onDelete:
  // Cascade) — no separate tracking array needed.
  return prisma.modelEndpoint.create({ data: { userId, judgeModelVersionId, isActive: true } });
}

async function mkJudgment(
  runId: string,
  judgeModelVersionId: string,
  promptTemplateId: string
) {
  return prisma.modelJudgment.create({
    data: { runId, judgeModelVersionId, promptTemplateId, status: 'pending' },
  });
}

interface EvaluationOnlyFixture {
  user: Awaited<ReturnType<typeof mkUser>>;
  evaluation: Awaited<ReturnType<typeof mkEvaluation>>;
  rubric: Awaited<ReturnType<typeof mkRubric>>;
  judgeModel: Awaited<ReturnType<typeof mkJudgeModelVersion>>['judgeModel'];
  version: Awaited<ReturnType<typeof mkJudgeModelVersion>>['version'];
  promptTemplateId: string;
}

interface Fixture extends EvaluationOnlyFixture {
  run: Awaited<ReturnType<typeof mkEvaluationRun>>;
}

/** user -> project -> evaluation -> rubric -> judge version -> endpoint,
 * deliberately WITHOUT a pre-made run — the run.create tests need an
 * evaluation with NO active run yet (that's exactly what they're creating),
 * so they must not reuse `createFixture()`'s run-included shape. Every test
 * gets its own (unique slugs/emails via `uniq()`), so tests never interfere
 * with each other's DB state even though they share one persistent DB and
 * (per vitest.integration.config.ts) run sequentially in this file. */
async function createEvaluationOnlyFixture(): Promise<EvaluationOnlyFixture> {
  const user = await mkUser();
  const project = await mkProject(user.id);
  const evaluation = await mkEvaluation(project.id, user.id);
  const rubric = await mkRubric(user.id);
  const { judgeModel, version } = await mkJudgeModelVersion();
  await mkEndpoint(user.id, version.id);
  const promptTemplate = await seedPromptTemplates(prisma);

  return { user, evaluation, rubric, judgeModel, version, promptTemplateId: promptTemplate.id };
}

/** `createEvaluationOnlyFixture()` plus a pre-made `EvaluationRun` — what
 * every judgment-consumer test wants (a run + judge version + endpoint
 * ready to attach judgments to). */
async function createFixture(): Promise<Fixture> {
  const base = await createEvaluationOnlyFixture();
  const run = await mkEvaluationRun(base.evaluation.id, base.user.id, base.rubric.id);
  return { ...base, run };
}

afterAll(async () => {
  // FK-safe order:
  //  1. Runs first (cascades ModelJudgment) — unblocks Rubric's Restrict
  //     from EvaluationRun.rubricId.
  //  2. Users next (cascades Project/Evaluation/Rubric, AND ModelEndpoint —
  //     ModelEndpoint.userId is Cascade) — unblocks JudgeModelVersion's
  //     Restrict from ModelEndpoint.judgeModelVersionId. Deleting users
  //     before versions is required: a version can't be deleted while any
  //     ModelEndpoint still references it, and endpoints only disappear via
  //     their owning user's cascade, not on their own.
  //  3. Versions, now that both ModelJudgment and ModelEndpoint referencing
  //     them are gone.
  //  4. Judge models, now that their versions are gone.
  await prisma.evaluationRun.deleteMany({ where: { id: { in: createdRunIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.judgeModelVersion.deleteMany({ where: { id: { in: createdVersionIds } } });
  await prisma.judgeModel.deleteMany({ where: { id: { in: createdJudgeModelIds } } });

  await closeRabbit();
  await prisma.$disconnect();
});

describe('worker claim idempotency (src/worker/claim.ts, judgment-consumer.ts, run-create-consumer.ts)', () => {
  it('duplicate judgment.execute delivery results in exactly one provider call; the second delivery still acks', async () => {
    const fixture = await createFixture();
    const judgment = await mkJudgment(fixture.run.id, fixture.version.id, fixture.promptTemplateId);

    const calls: RunProviderJudgmentInput[] = [];
    const consumer = createJudgmentConsumer({ provider: fakeProvider(calls) });
    const msg: JudgmentExecuteMsg = { judgmentId: judgment.id, runId: fixture.run.id, attempt: 1 };

    const ch1 = fakeChannel();
    await consumer.handle(fakeMessage(msg), ch1);

    const ch2 = fakeChannel();
    await consumer.handle(fakeMessage(msg), ch2);

    expect(calls).toHaveLength(1);
    expect(ch1.ackCalls).toHaveLength(1);
    expect(ch2.ackCalls).toHaveLength(1);
    expect(ch1.nackCalls).toHaveLength(0);
    expect(ch2.nackCalls).toHaveLength(0);

    const persisted = await prisma.modelJudgment.findUniqueOrThrow({ where: { id: judgment.id } });
    expect(persisted.status).toBe('completed');
    expect(persisted.attemptCount).toBe(1);
    expect(persisted.overallScore).toBe(8);
  });

  it('claim then abandon: a redelivery within the lease is treated as a duplicate — ack, no provider call, no reclaim', async () => {
    const fixture = await createFixture();
    const judgment = await mkJudgment(fixture.run.id, fixture.version.id, fixture.promptTemplateId);

    // Simulate a worker that claimed the judgment directly and then died
    // before doing anything else — no persist, no ack, no further action.
    const claimResult = await claimJudgment(judgment.id);
    expect(claimResult).toBe('claimed');

    const calls: RunProviderJudgmentInput[] = [];
    const consumer = createJudgmentConsumer({ provider: fakeProvider(calls) });
    const msg: JudgmentExecuteMsg = { judgmentId: judgment.id, runId: fixture.run.id, attempt: 1 };
    const ch = fakeChannel();

    await consumer.handle(fakeMessage(msg), ch);

    expect(calls).toHaveLength(0);
    expect(ch.ackCalls).toHaveLength(1);
    expect(ch.nackCalls).toHaveLength(0);

    const persisted = await prisma.modelJudgment.findUniqueOrThrow({ where: { id: judgment.id } });
    expect(persisted.status).toBe('running'); // untouched — still the original claim
    expect(persisted.attemptCount).toBe(1); // not bumped by the duplicate delivery
  });

  it('a running judgment past its lease is reclaimed on redelivery: attemptCount increments and the provider runs', async () => {
    const fixture = await createFixture();
    const judgment = await mkJudgment(fixture.run.id, fixture.version.id, fixture.promptTemplateId);

    const claimResult = await claimJudgment(judgment.id);
    expect(claimResult).toBe('claimed');

    // Backdate updatedAt past LEASE_MS via raw SQL — same "set the
    // timestamp directly" trick tests/db/idempotency-tighten.test.ts uses
    // for its finalizedAt backfill test — to simulate a claimant that died
    // and never came back, without actually waiting out the real lease.
    const staleUpdatedAt = new Date(Date.now() - LEASE_MS - 5_000);
    await prisma.$executeRaw`UPDATE "ModelJudgment" SET "updatedAt" = ${staleUpdatedAt} WHERE id = ${judgment.id}`;

    const calls: RunProviderJudgmentInput[] = [];
    const consumer = createJudgmentConsumer({ provider: fakeProvider(calls) });
    const msg: JudgmentExecuteMsg = { judgmentId: judgment.id, runId: fixture.run.id, attempt: 1 };
    const ch = fakeChannel();

    await consumer.handle(fakeMessage(msg), ch);

    expect(calls).toHaveLength(1);
    expect(ch.ackCalls).toHaveLength(1);

    const persisted = await prisma.modelJudgment.findUniqueOrThrow({ where: { id: judgment.id } });
    expect(persisted.status).toBe('completed');
    expect(persisted.attemptCount).toBe(2); // once for the original claim, once for the reclaim
  });

  it('run.create redelivery is idempotent: one EvaluationRun, one ModelJudgment (+ RunModelSelection) per model selection, exactly one judgment.execute publish per row', async () => {
    const fixture = await createEvaluationOnlyFixture(); // no pre-made run — this test creates it
    const { version: version2 } = await mkJudgeModelVersion();
    const modelConfig1 = await mkModelConfig(fixture.user.id);
    const modelConfig2 = await mkModelConfig(fixture.user.id);

    const { confirmChannel } = await getRabbit();
    await assertTopology(confirmChannel);
    await confirmChannel.purgeQueue(QUEUE_JUDGMENT_EXECUTE);

    const runCreateConsumer = createRunCreateConsumer();
    const msg: RunCreateMsg = {
      evaluationId: fixture.evaluation.id,
      runSpec: {
        rubricId: fixture.rubric.id,
        modelSelections: [
          { judgeModelVersionId: fixture.version.id, modelConfigId: modelConfig1.id },
          { judgeModelVersionId: version2.id, modelConfigId: modelConfig2.id },
        ],
        triggeredById: fixture.user.id,
        protocol: 'pointwise',
      },
    };

    const ch1 = fakeChannel();
    await runCreateConsumer.handle(fakeMessage(msg), ch1);
    const ch2 = fakeChannel();
    await runCreateConsumer.handle(fakeMessage(msg), ch2); // redelivery of the identical message

    expect(ch1.ackCalls).toHaveLength(1);
    expect(ch2.ackCalls).toHaveLength(1); // deduped delivery still acks, doesn't hang/nack

    const runs = await prisma.evaluationRun.findMany({ where: { evaluationId: fixture.evaluation.id } });
    expect(runs).toHaveLength(1);
    createdRunIds.push(runs[0].id);

    const judgments = await prisma.modelJudgment.findMany({ where: { runId: runs[0].id } });
    expect(judgments).toHaveLength(2);
    expect(new Set(judgments.map((j) => j.judgeModelVersionId))).toEqual(
      new Set([fixture.version.id, version2.id])
    );
    // Dual-write (Task 9 review fix #1): modelConfigId is set on every row,
    // not left null — this is exactly what the leaderboard's
    // `if (j.modelConfig === null) continue` join depends on.
    expect(new Set(judgments.map((j) => j.modelConfigId))).toEqual(
      new Set([modelConfig1.id, modelConfig2.id])
    );
    const withModelConfig = await prisma.modelJudgment.findMany({
      where: { runId: runs[0].id },
      include: { modelConfig: { select: { id: true } } },
    });
    for (const judgment of withModelConfig) {
      expect(judgment.modelConfig).not.toBeNull();
    }

    // RunModelSelection rows — never written by this path before the fix.
    const selections = await prisma.runModelSelection.findMany({ where: { runId: runs[0].id } });
    expect(new Set(selections.map((s) => s.modelConfigId))).toEqual(
      new Set([modelConfig1.id, modelConfig2.id])
    );

    const published = await drainQueue(confirmChannel, QUEUE_JUDGMENT_EXECUTE);
    expect(published).toHaveLength(2); // exactly once per row, not doubled by the redelivery
    const publishedIds = published
      .map((m) => (JSON.parse(m.content.toString()) as JudgmentExecuteMsg).judgmentId)
      .sort();
    expect(publishedIds).toEqual(judgments.map((j) => j.id).sort());
  });

  it('run.create expansion failure (no modelSelections to expand) records an errored EvaluationRun rather than silently dropping the message', async () => {
    const fixture = await createEvaluationOnlyFixture();
    const runCreateConsumer = createRunCreateConsumer();
    const msg: RunCreateMsg = {
      evaluationId: fixture.evaluation.id,
      runSpec: {
        rubricId: fixture.rubric.id,
        modelSelections: [],
        triggeredById: fixture.user.id,
        protocol: 'pointwise',
      },
    };

    const ch = fakeChannel();
    await runCreateConsumer.handle(fakeMessage(msg), ch);

    expect(ch.ackCalls).toHaveLength(1); // no silent swallow, but not requeued forever either

    const runs = await prisma.evaluationRun.findMany({ where: { evaluationId: fixture.evaluation.id } });
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('error');
    createdRunIds.push(runs[0].id);
  });

  it('a non_retryable provider error marks the judgment error and acks — no retry/DLQ publish — and the finalizer flips the run to error (zero completed)', async () => {
    const fixture = await createFixture();
    const judgment = await mkJudgment(fixture.run.id, fixture.version.id, fixture.promptTemplateId);

    const consumer = createJudgmentConsumer({
      provider: async () => {
        throw new ProviderError('bad request: malformed rubric', {
          kind: 'non_retryable',
          provider: 'openai',
          status: 400,
        });
      },
    });
    const msg: JudgmentExecuteMsg = { judgmentId: judgment.id, runId: fixture.run.id, attempt: 1 };
    const ch = fakeChannel();

    await consumer.handle(fakeMessage(msg), ch);

    expect(ch.ackCalls).toHaveLength(1);
    expect(ch.nackCalls).toHaveLength(0);

    const persisted = await prisma.modelJudgment.findUniqueOrThrow({ where: { id: judgment.id } });
    expect(persisted.status).toBe('error');
    expect(persisted.error).toContain('bad request: malformed rubric');

    // The run had exactly this one judgment, and it errored — the real
    // finalizer (src/lib/run-finalizer.ts, Task 8) distinguishes "at least
    // one completed" (-> needs_human) from "zero completed, all error"
    // (-> error) once nothing remains pending/running. See
    // tests/integration/finalization.test.ts for the finalizer's own
    // dedicated coverage of both branches.
    const run = await prisma.evaluationRun.findUniqueOrThrow({ where: { id: fixture.run.id } });
    expect(run.status).toBe('error');
    expect(run.finalizedAt).not.toBeNull();
  });

  // ── Retry/DLQ disposition + persist-failure/within-lease hardening ──────
  // (Task 7 review follow-up: disposition scope, strand-proof duplicates,
  // attempt-cap integrity — see judgment-consumer.ts / claim.ts docstrings.)

  it('a retryable provider failure on attempt 1 resets the judgment to pending and republishes onto judgment.retry.30s with attempt 2', async () => {
    const fixture = await createFixture();
    const judgment = await mkJudgment(fixture.run.id, fixture.version.id, fixture.promptTemplateId);

    const { confirmChannel } = await getRabbit();
    await assertTopology(confirmChannel);
    await confirmChannel.purgeQueue(QUEUE_JUDGMENT_RETRY_30S);

    const consumer = createJudgmentConsumer({
      provider: async () => {
        throw new ProviderError('temporary provider hiccup', { kind: 'retryable', provider: 'openai', status: 503 });
      },
    });
    const msg: JudgmentExecuteMsg = { judgmentId: judgment.id, runId: fixture.run.id, attempt: 1 };
    const ch = fakeChannel();

    await consumer.handle(fakeMessage(msg), ch);

    expect(ch.ackCalls).toHaveLength(1);
    expect(ch.nackCalls).toHaveLength(0);

    const persisted = await prisma.modelJudgment.findUniqueOrThrow({ where: { id: judgment.id } });
    expect(persisted.status).toBe('pending');
    expect(persisted.attemptCount).toBe(1); // claim's own increment; not bumped again here

    const published = await drainQueue(confirmChannel, QUEUE_JUDGMENT_RETRY_30S);
    expect(published).toHaveLength(1);
    const republished = JSON.parse(published[0].content.toString()) as JudgmentExecuteMsg;
    expect(republished.judgmentId).toBe(judgment.id);
    expect(republished.attempt).toBe(2);
  });

  it('a retryable provider failure once effectiveAttempt reaches the 3-cap marks the judgment error and DLQs it instead of retrying again', async () => {
    const fixture = await createFixture();
    const judgment = await mkJudgment(fixture.run.id, fixture.version.id, fixture.promptTemplateId);
    // Pre-seed attemptCount=2 (as if two prior attempts already ran) so
    // claimJudgment's own increment brings it to 3 on this delivery —
    // effectiveAttempt = max(msg.attempt, judgment.attemptCount) must hit
    // the cap here even though msg.attempt alone (3) already would too;
    // this is the "normal sequential" shape of the cap, exercised
    // alongside the crash-reclaim shape covered by claim.ts's own tests.
    await prisma.modelJudgment.update({ where: { id: judgment.id }, data: { attemptCount: 2 } });

    const { confirmChannel } = await getRabbit();
    await assertTopology(confirmChannel);
    await confirmChannel.purgeQueue(QUEUE_DLQ);

    const consumer = createJudgmentConsumer({
      provider: async () => {
        throw new ProviderError('still failing after retries', { kind: 'retryable', provider: 'openai', status: 503 });
      },
    });
    const msg: JudgmentExecuteMsg = { judgmentId: judgment.id, runId: fixture.run.id, attempt: 3 };
    const ch = fakeChannel();

    await consumer.handle(fakeMessage(msg), ch);

    expect(ch.ackCalls).toHaveLength(1);
    expect(ch.nackCalls).toHaveLength(0);

    const persisted = await prisma.modelJudgment.findUniqueOrThrow({ where: { id: judgment.id } });
    expect(persisted.status).toBe('error');
    expect(persisted.error).toContain('still failing after retries');

    const dlqMessages = await drainQueue(confirmChannel, QUEUE_DLQ);
    expect(dlqMessages).toHaveLength(1);
    const envelope = JSON.parse(dlqMessages[0].content.toString()) as DlqEnvelope;
    expect(envelope.reason).toContain('still failing after retries');
    expect((envelope.originalMessage as JudgmentExecuteMsg).judgmentId).toBe(judgment.id);
  });

  it('a breakerOpen provider failure routes to judgment.retry.5m regardless of attempt', async () => {
    const fixture = await createFixture();
    const judgment = await mkJudgment(fixture.run.id, fixture.version.id, fixture.promptTemplateId);

    const { confirmChannel } = await getRabbit();
    await assertTopology(confirmChannel);
    await confirmChannel.purgeQueue(QUEUE_JUDGMENT_RETRY_5M);

    const consumer = createJudgmentConsumer({
      provider: async () => {
        throw new ProviderError('circuit breaker open', {
          kind: 'retryable',
          provider: 'openai',
          breakerOpen: true,
        });
      },
    });
    const msg: JudgmentExecuteMsg = { judgmentId: judgment.id, runId: fixture.run.id, attempt: 1 };
    const ch = fakeChannel();

    await consumer.handle(fakeMessage(msg), ch);

    expect(ch.ackCalls).toHaveLength(1);
    expect(ch.nackCalls).toHaveLength(0);

    const persisted = await prisma.modelJudgment.findUniqueOrThrow({ where: { id: judgment.id } });
    expect(persisted.status).toBe('pending');

    const published = await drainQueue(confirmChannel, QUEUE_JUDGMENT_RETRY_5M);
    expect(published).toHaveLength(1);
    const republished = JSON.parse(published[0].content.toString()) as JudgmentExecuteMsg;
    expect(republished.judgmentId).toBe(judgment.id);
    expect(republished.attempt).toBe(2);
  });

  it('a provider success with persistSuccess failing 3x DLQs the full result and leaves the judgment row running, never re-executing the provider', async () => {
    const fixture = await createFixture();
    const judgment = await mkJudgment(fixture.run.id, fixture.version.id, fixture.promptTemplateId);

    const { confirmChannel } = await getRabbit();
    await assertTopology(confirmChannel);
    await confirmChannel.purgeQueue(QUEUE_DLQ);

    const calls: RunProviderJudgmentInput[] = [];
    let persistAttempts = 0;
    const consumer = createJudgmentConsumer({
      provider: fakeProvider(calls, { overallScore: 9, reasoning: 'persist-failure fixture reasoning' }),
      persist: async () => {
        persistAttempts += 1;
        throw new Error('simulated persist failure');
      },
    });
    const msg: JudgmentExecuteMsg = { judgmentId: judgment.id, runId: fixture.run.id, attempt: 1 };
    const ch = fakeChannel();

    await consumer.handle(fakeMessage(msg), ch);

    expect(calls).toHaveLength(1); // provider called exactly once — a persist failure never re-executes it
    expect(persistAttempts).toBe(3); // bounded local retry budget (3 attempts) exhausted
    expect(ch.ackCalls).toHaveLength(1);
    expect(ch.nackCalls).toHaveLength(0);

    const persisted = await prisma.modelJudgment.findUniqueOrThrow({ where: { id: judgment.id } });
    expect(persisted.status).toBe('running'); // left running for a future reaper reclaim, not flipped to error
    expect(persisted.overallScore).toBeNull(); // persistSuccess never actually wrote — every local attempt threw

    const dlqMessages = await drainQueue(confirmChannel, QUEUE_DLQ);
    expect(dlqMessages).toHaveLength(1);
    const envelope = JSON.parse(dlqMessages[0].content.toString()) as DlqEnvelope;
    expect(envelope.reason).toBe('persist-failed-after-success');
    const original = envelope.originalMessage as JudgmentExecuteMsg & {
      result: { overallScore: number; reasoning: string };
    };
    expect(original.judgmentId).toBe(judgment.id);
    expect(original.result.overallScore).toBe(9); // the FULL JudgmentResult travels with the DLQ envelope
    expect(original.result.reasoning).toBe('persist-failure fixture reasoning');
  });

  it('a redelivery landing on a within-lease running claim republishes the SAME message onto judgment.retry.30s instead of stranding it', async () => {
    const fixture = await createFixture();
    const judgment = await mkJudgment(fixture.run.id, fixture.version.id, fixture.promptTemplateId);

    // Same "claimed and died" simulation as the claim-then-abandon test
    // above, but this test asserts the NEW republish-not-strand behavior.
    const claimResult = await claimJudgment(judgment.id);
    expect(claimResult).toBe('claimed');

    const { confirmChannel } = await getRabbit();
    await assertTopology(confirmChannel);
    await confirmChannel.purgeQueue(QUEUE_JUDGMENT_RETRY_30S);

    const calls: RunProviderJudgmentInput[] = [];
    const consumer = createJudgmentConsumer({ provider: fakeProvider(calls) });
    const msg: JudgmentExecuteMsg = { judgmentId: judgment.id, runId: fixture.run.id, attempt: 1 };
    const ch = fakeChannel();

    await consumer.handle(fakeMessage(msg), ch);

    expect(calls).toHaveLength(0); // this delivery doesn't own the claim — never touches the provider
    expect(ch.ackCalls).toHaveLength(1);
    expect(ch.nackCalls).toHaveLength(0);

    const persisted = await prisma.modelJudgment.findUniqueOrThrow({ where: { id: judgment.id } });
    expect(persisted.status).toBe('running'); // untouched — still the original claim
    expect(persisted.attemptCount).toBe(1); // not bumped by this delivery

    const published = await drainQueue(confirmChannel, QUEUE_JUDGMENT_RETRY_30S);
    expect(published).toHaveLength(1);
    const republished = JSON.parse(published[0].content.toString()) as JudgmentExecuteMsg;
    expect(republished.judgmentId).toBe(judgment.id);
    expect(republished.attempt).toBe(1); // unchanged — a delayed re-check, not a new attempt
  });
});
