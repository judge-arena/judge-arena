import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { db, mkRubric } from './helpers';
import { prisma } from '@/lib/db';
import { launchSingleRun, requireOwnedActiveEndpoints, RunLaunchError } from '@/lib/run-launch';
import { resolveEndpointFor } from '@/lib/endpoint-resolution';
import {
  LANE_FALLBACK_QUEUE,
  LANE_QUEUES,
  laneQueueFor,
  normalizeOrigin,
  __resetLaneCacheForTests,
} from '@/lib/queue/lanes';
import type { JudgmentExecuteMsg } from '@/lib/queue/publish';
import { seedPromptTemplates } from '../../prisma/seed-prompt-templates';

// ─── Lane routing at the PUBLISHER (v2j, phase 1b) ──────────────────────────
//
// Phase 1a declared the lane queues and unit-tested the pure key arithmetic
// (tests/lib/queue-lanes.test.ts). Nothing there could catch the failure this
// file exists for, because that failure is not in the arithmetic: it is in
// whether the publisher feeds the arithmetic THE RIGHT ENDPOINT, and whether
// the lane it computes is the one the message is actually published with.
//
// The assertions below are therefore all made through `launchSingleRun`'s real
// path — real endpoint resolution, real `QueueLane` assignment against the real
// table — with only the final broker hop replaced by a recording fake. That
// fake is the reason `LaunchSingleRunDeps.publish` takes the destination queue
// as a parameter: without it, "which lane did this judgment go to" is not
// observable from anywhere except a live RabbitMQ, and the routing could
// regress to a single shared queue with the entire suite still green.
//
// WHAT WOULD MAKE THESE TESTS WORTHLESS, and is guarded against: asserting only
// that two same-origin judgments got the SAME queue. Stubbing `laneQueueFor` to
// return the fallback for everything satisfies that trivially — one queue is
// very consistent. Every same-origin assertion below therefore ALSO asserts the
// destination is a real lane queue and not `LANE_FALLBACK_QUEUE`. Verified by
// injection: forcing `laneQueueFor` to return `LANE_FALLBACK_QUEUE`
// unconditionally turns both the same-origin and the different-origin cases
// red.
//
// `launchSingleRun` drives the `prisma` singleton (DATABASE_URL) while the
// fixtures here use `db` (TEST_DATABASE_URL) — same guard, same reason, as
// tests/db/calibration-link.test.ts:38.
//
// NOTE this file deliberately does NOT call `truncateAll()`. Every fixture is
// uniquely named and cleaned up by id in `afterAll`, and every lane assertion
// is scoped to a lane key this file invented, so it neither depends on nor
// destroys anything else in the database.

beforeAll(() => {
  if (!process.env.TEST_DATABASE_URL || process.env.DATABASE_URL !== process.env.TEST_DATABASE_URL) {
    throw new Error(
      'tests/db/lane-publishing.test.ts drives the src/lib prisma singleton (DATABASE_URL) against ' +
        'fixtures created on TEST_DATABASE_URL; they must be the same database. Run this with ' +
        '.env.test sourced.'
    );
  }
});

const createdUserIds: string[] = [];
const createdRunIds: string[] = [];
const createdEvaluationIds: string[] = [];
const createdVersionIds: string[] = [];
const createdJudgeModelIds: string[] = [];

function uniq(label: string): string {
  return `${label}-${randomUUID()}`;
}

/** A brand-new origin nothing has ever laned before, so a `QueueLane` row for
 *  it is provably this test's own — not a leftover from a previous run of this
 *  same file against a database that is not truncated between runs. */
function freshOrigin(): string {
  return `http://${uniq('lane-host').replace(/[^a-z0-9-]/g, '')}.test:11434`;
}

async function mkUser() {
  const user = await db.user.create({
    data: { email: `${uniq('lane-user')}@test.local`, passwordHash: 'fixture-hash' },
  });
  createdUserIds.push(user.id);
  return user;
}

/**
 * A catalog judge + version + ONE `ModelEndpoint` owned by `userId`.
 * `endpoint` is passed through verbatim (including `null`, which is the
 * hosted-API shape) because the endpoint URL is precisely the input under test.
 */
async function mkJudge(
  userId: string,
  endpoint: string | null,
  opts: { verified?: boolean; createdAt?: Date } = {}
) {
  const name = uniq('lane-judge');
  const judgeModel = await db.judgeModel.create({
    data: { name, slug: name, judgeClass: 'prompted_api', scoringMechanism: 'critique_generative' },
  });
  createdJudgeModelIds.push(judgeModel.id);

  const version = await db.judgeModelVersion.create({
    data: {
      judgeModelId: judgeModel.id,
      ordinal: 1,
      servingBackend: 'openai',
      protocolSupport: { pointwise: ['score'] },
    },
  });
  createdVersionIds.push(version.id);

  await db.modelEndpoint.create({
    data: {
      userId,
      judgeModelVersionId: version.id,
      endpoint,
      isActive: true,
      verifiedAt: opts.verified === false ? null : new Date(),
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    },
  });

  return version;
}

async function mkEvaluation(userId: string, rubricId: string, judgeModelVersionIds: string[]) {
  const project = await db.project.create({ data: { name: uniq('lane-project'), userId } });
  const evaluation = await db.evaluation.create({
    data: {
      projectId: project.id,
      userId,
      inputText: 'fixture input',
      responseText: 'fixture response under judgment', // judge mode
      rubricId,
      modelSelections: {
        create: judgeModelVersionIds.map((judgeModelVersionId) => ({ judgeModelVersionId })),
      },
    },
  });
  createdEvaluationIds.push(evaluation.id);
  return evaluation;
}

interface PublishCall {
  msg: JudgmentExecuteMsg;
  destinationQueue: string;
}

/** The seam that makes routing observable without a broker — see the header. */
function recordingPublish(): { calls: PublishCall[]; publish: (m: JudgmentExecuteMsg, q: string) => Promise<void> } {
  const calls: PublishCall[] = [];
  return {
    calls,
    publish: async (msg, destinationQueue) => {
      calls.push({ msg, destinationQueue });
    },
  };
}

/** Launch one pointwise run over `versionIds` and return, per judgment, the
 *  judge version it was created for and the queue it was published to. */
async function launchAndCaptureLanes(userId: string, rubricId: string, versionIds: string[]) {
  const evaluation = await mkEvaluation(userId, rubricId, versionIds);
  const recorder = recordingPublish();
  const result = await launchSingleRun(
    { evaluationId: evaluation.id, triggeredById: userId },
    { publish: recorder.publish }
  );
  createdRunIds.push(result.run.id);

  expect(result.publishFailed).toBe(false);

  const versionByJudgmentId = new Map(
    result.run.modelJudgments.map((judgment) => [judgment.id, judgment.judgeModelVersionId])
  );
  return {
    result,
    routes: recorder.calls.map((call) => ({
      judgeModelVersionId: versionByJudgmentId.get(call.msg.judgmentId) ?? null,
      queue: call.destinationQueue,
    })),
  };
}

function queueForVersion(routes: Array<{ judgeModelVersionId: string | null; queue: string }>, versionId: string) {
  const route = routes.find((r) => r.judgeModelVersionId === versionId);
  expect(route, `no publish recorded for judge version ${versionId}`).toBeDefined();
  return route!.queue;
}

beforeEach(async () => {
  // The lane cache is process-local and PERMANENT by design (lanes.ts's module
  // doc: rows are never updated or deleted, so a cached id can never go stale).
  // That is exactly why it has to be cleared here: without it, the second case
  // in this file would answer from memory and never touch the table, so a
  // regression in the DB-backed assignment path would go unnoticed.
  __resetLaneCacheForTests();
  await seedPromptTemplates(prisma); // idempotent; launchSingleRun requires a pointwise template
});

afterAll(async () => {
  // FK-safe order, per tests/integration/producer.test.ts's afterAll: runs
  // before evaluations, evaluations before users, users before versions
  // (ModelEndpoint cascades with its user), versions before judge models.
  await db.evaluationRun.deleteMany({ where: { id: { in: createdRunIds } } });
  await db.evaluation.deleteMany({ where: { id: { in: createdEvaluationIds } } });
  await db.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await db.judgeModelVersion.deleteMany({ where: { id: { in: createdVersionIds } } });
  await db.judgeModel.deleteMany({ where: { id: { in: createdJudgeModelIds } } });

  __resetLaneCacheForTests();
  await prisma.$disconnect();
});

describe('lane routing: the serialization domain is the SERVER', () => {
  it('two different judges on ONE origin publish to ONE lane queue', async () => {
    // This is the owner's per-model proposal failing on purpose: two DIFFERENT
    // judge model versions, one inference server. Keyed per model they would
    // run concurrently against a box with a fixed slot pool — the exact
    // over-subscription that dead-lettered 4 of 30 items on 2026-08-31.
    const origin = freshOrigin();
    const user = await mkUser();
    const rubric = await mkRubric(user.id);
    // Different PATHS on the same host: one server, one slot pool. If the lane
    // key ever stops collapsing the path, this catches it here rather than as
    // an unexplained timeout in production.
    const judgeA = await mkJudge(user.id, `${origin}/v1`);
    const judgeB = await mkJudge(user.id, `${origin}/v1/chat/completions`);

    const { routes } = await launchAndCaptureLanes(user.id, rubric.id, [judgeA.id, judgeB.id]);

    const queueA = queueForVersion(routes, judgeA.id);
    const queueB = queueForVersion(routes, judgeB.id);
    expect(queueA).toBe(queueB);
    // NOT the fallback. Without this line, stubbing lane resolution to return
    // `judgment.execute` for everything would satisfy the equality above and
    // this test would certify a total loss of lane isolation as a pass.
    expect(queueA).not.toBe(LANE_FALLBACK_QUEUE);
    expect(LANE_QUEUES).toContain(queueA);

    // And the lane really was recorded against the ORIGIN, not against either
    // version id — one row for two judges.
    const laneRows = await db.queueLane.findMany({ where: { laneKey: normalizeOrigin(origin)! } });
    expect(laneRows).toHaveLength(1);
  });

  it('two judges on DIFFERENT origins publish to DIFFERENT lane queues', async () => {
    // Two servers must be able to run at the same time; that is the entire
    // point of the change. Both keys are brand new, so `QueueLane.id` assigns
    // them consecutively and `(id - 1) % LANE_COUNT` cannot collide — a
    // collision needs LANE_COUNT intervening assignments.
    const user = await mkUser();
    const rubric = await mkRubric(user.id);
    const judgeA = await mkJudge(user.id, `${freshOrigin()}/v1`);
    const judgeB = await mkJudge(user.id, `${freshOrigin()}/v1`);

    const { routes } = await launchAndCaptureLanes(user.id, rubric.id, [judgeA.id, judgeB.id]);

    const queueA = queueForVersion(routes, judgeA.id);
    const queueB = queueForVersion(routes, judgeB.id);
    expect(queueA).not.toBe(queueB);
    expect(LANE_QUEUES).toContain(queueA);
    expect(LANE_QUEUES).toContain(queueB);
  });

  it('a judge with NO endpoint URL gets a version: lane and still publishes somewhere consumed', async () => {
    // A hosted API (Anthropic/OpenAI/OpenRouter) has no self-hosted server to
    // serialize against. It must not fall into one shared lane with every other
    // hosted judge — that would serialize providers that were never
    // slot-limited — and it must not fail to route at all.
    const user = await mkUser();
    const rubric = await mkRubric(user.id);
    const judge = await mkJudge(user.id, null);

    const { routes } = await launchAndCaptureLanes(user.id, rubric.id, [judge.id]);

    const queue = queueForVersion(routes, judge.id);
    expect([...LANE_QUEUES, LANE_FALLBACK_QUEUE]).toContain(queue);
    expect(queue).not.toBe(LANE_FALLBACK_QUEUE); // a lane was genuinely resolved

    const laneRow = await db.queueLane.findUnique({ where: { laneKey: `version:${judge.id}` } });
    expect(laneRow).not.toBeNull();
  });
});

describe('lane assignment is permanent, and races converge', () => {
  it('a second launch for the same origin reuses the lane and inserts no second QueueLane row', async () => {
    const origin = freshOrigin();
    const user = await mkUser();
    const rubric = await mkRubric(user.id);
    const judge = await mkJudge(user.id, `${origin}/v1`);

    const first = await launchAndCaptureLanes(user.id, rubric.id, [judge.id]);
    const firstQueue = queueForVersion(first.routes, judge.id);

    // Clear the process-local cache so the SECOND launch has to re-derive the
    // lane from the table. With the cache warm this assertion would be a
    // tautology about a `Map`, and the property that actually matters — that
    // the DB, not the cache, is what makes an assignment permanent — would be
    // untested.
    __resetLaneCacheForTests();

    const second = await launchAndCaptureLanes(user.id, rubric.id, [judge.id]);
    expect(queueForVersion(second.routes, judge.id)).toBe(firstQueue);

    const laneRows = await db.queueLane.findMany({ where: { laneKey: normalizeOrigin(origin)! } });
    expect(laneRows).toHaveLength(1);
  });

  it('two concurrent first-sightings of one key converge on ONE row and ONE lane', async () => {
    // The insert is ON CONFLICT DO NOTHING followed by a read precisely so this
    // cannot produce two ids for one origin. Two ids would be two lanes, and
    // two lanes for one server means its judgments run concurrently against it
    // — the failure lanes exist to prevent, reintroduced by the mechanism that
    // was supposed to prevent it.
    const origin = freshOrigin();
    const versionId = `unseen-${randomUUID()}`;
    __resetLaneCacheForTests();

    const [queueA, queueB] = await Promise.all([
      laneQueueFor(`${origin}/v1`, versionId),
      laneQueueFor(`${origin}/v1`, versionId),
    ]);

    expect(queueA).toBe(queueB);
    expect(LANE_QUEUES).toContain(queueA);

    const laneRows = await db.queueLane.findMany({ where: { laneKey: normalizeOrigin(origin)! } });
    expect(laneRows).toHaveLength(1);
  });
});

describe('the publisher and the consumer resolve the SAME endpoint row', () => {
  it('routes to the lane of the row the worker will call, not the oldest row', async () => {
    // THE BUG THIS CLOSES. `ModelEndpoint` has no
    // @@unique([userId, judgeModelVersionId]), so several rows per pair are
    // legal. The publisher used to filter `verifiedAt: { not: null }` with no
    // ordering while the consumer took the OLDEST active row with no
    // verifiedAt filter — so the launch could be authorised against one server
    // and executed against another. Under lanes that also means the judgment is
    // serialized against a box it never calls.
    const staleOrigin = freshOrigin();
    const liveOrigin = freshOrigin();
    const user = await mkUser();
    const rubric = await mkRubric(user.id);

    // The judge's own endpoint is the VERIFIED, newer one at `liveOrigin`.
    const judge = await mkJudge(user.id, `${liveOrigin}/v1`);
    // ...and an OLDER, never-verified row at a different origin. This is the
    // row the pre-fix consumer would have executed against.
    await db.modelEndpoint.create({
      data: {
        userId: user.id,
        judgeModelVersionId: judge.id,
        endpoint: `${staleOrigin}/v1`,
        isActive: true,
        verifiedAt: null,
        createdAt: new Date(Date.now() - 86_400_000),
      },
    });

    const resolved = await resolveEndpointFor(user.id, judge.id);
    expect(resolved?.endpoint).toBe(`${liveOrigin}/v1`);

    const { routes } = await launchAndCaptureLanes(user.id, rubric.id, [judge.id]);
    expect(queueForVersion(routes, judge.id)).toBe(await laneQueueFor(`${liveOrigin}/v1`, judge.id));
    expect(queueForVersion(routes, judge.id)).not.toBe(await laneQueueFor(`${staleOrigin}/v1`, judge.id));
  });

  it('admission control is still strict: an active but never-verified endpoint cannot launch', async () => {
    // The shared resolver PREFERS verified rows rather than filtering to them
    // (see endpoint-resolution.ts's DECISION 1 — filtering in the consumer
    // would refuse judgments that run fine today). That must not have loosened
    // the launch gate, which is a different protection: a run should not start
    // against an endpoint that has never once been proven to answer.
    const user = await mkUser();
    const rubric = await mkRubric(user.id);
    const judge = await mkJudge(user.id, `${freshOrigin()}/v1`, { verified: false });
    const evaluation = await mkEvaluation(user.id, rubric.id, [judge.id]);

    await expect(
      launchSingleRun({ evaluationId: evaluation.id, triggeredById: user.id }, { publish: async () => {} })
    ).rejects.toBeInstanceOf(RunLaunchError);

    await expect(requireOwnedActiveEndpoints(user.id, [judge.id])).rejects.toThrow(/No active, verified endpoint/);

    // The consumer, by contrast, still resolves it — that asymmetry is the
    // deliberate part.
    expect((await resolveEndpointFor(user.id, judge.id))?.verifiedAt).toBeNull();
  });
});
