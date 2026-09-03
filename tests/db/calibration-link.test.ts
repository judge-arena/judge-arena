import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import { db, truncateAll, mkUser, mkRubric } from './helpers';
import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';
import { isGoldenSetFrozen } from '@/lib/golden-sets';
import { effectiveSamplingParams } from '@/lib/llm/sampling';
import { resolveTimeoutBudgets } from '@/lib/llm/timeout-policy';
import { launchCalibrationRun, MAX_CALIBRATION_ITEMS } from '@/lib/calibration/launch';
import { DEADLINE_SLACK_MS } from '@/lib/run-launch';
import { seedPromptTemplates } from '../../prisma/seed-prompt-templates';

// ─── The calibration ⇄ golden-item link (A2.1, v2i) ────────────────────────
//
// Three things are pinned here and they are pinned together on purpose:
//
//   (1) THE MIGRATION'S OWN SEMANTICS —
//       `@@unique([calibrationRunId, goldenItemId])` under Postgres' DEFAULT
//       `NULLS DISTINCT`, and the two `onDelete: Restrict` arms. The NULLS
//       case is the one worth the most: `20260830120000_v2i_calibration_item_link`
//       deliberately did NOT hand-edit this index to NULLS NOT DISTINCT the way
//       `20260728215410_v2b_idempotency_tighten` did for ModelJudgment's, and
//       ORDINARY runs (both columns NULL) are the overwhelming majority of the
//       table. If someone "harmonises" the two indexes later, the second
//       ordinary run ever launched starts failing P2002 — and nothing else in
//       the suite would notice, because no other test creates two runs whose
//       calibration columns are both NULL and asserts they coexist.
//
//   (2) THE LAUNCH PATH THAT WRITES THAT LINK — `launchCalibrationRun`
//       (src/lib/calibration/launch.ts), including the batch-aware deadline
//       that keeps `src/worker/reaper.ts` from force-finalizing the tail of a
//       long batch as `'reaper: abandoned'`.
//
//   (3) THE LAUNCH-TIME SAMPLING SNAPSHOT (v2k) —
//       `CalibrationRun.samplingParams`, the RESOLVED
//       `effectiveSamplingParams(JudgeModelVersion.samplingDefaults)` written
//       inside the SAME launch transaction as the header. It lives in this
//       file for the same reason (2) does: `tests/db` is the only suite that
//       executes `launchCalibrationRun`, so it is the only place that can
//       prove launch.ts CALLS the resolver rather than storing the raw,
//       mutable `samplingDefaults` — and the only place that can show the
//       obvious join through the version reporting today's config for a
//       historical run.
//
// `launchCalibrationRun` goes through the `prisma` singleton (`@/lib/db`,
// DATABASE_URL) while the fixtures here go through `db` (TEST_DATABASE_URL) —
// two clients, one database, which `npm run test:db` guarantees by sourcing
// .env.test (where the two URLs are the same string). `beforeAll` refuses to
// run if that stops being true, because the failure mode otherwise is fixtures
// in one database and a launch in another: every assertion fails with a
// baffling "record not found" instead of naming the real cause.

beforeAll(() => {
  if (!process.env.TEST_DATABASE_URL || process.env.DATABASE_URL !== process.env.TEST_DATABASE_URL) {
    throw new Error(
      'tests/db/calibration-link.test.ts drives the src/lib prisma singleton (DATABASE_URL) against ' +
        'fixtures created on TEST_DATABASE_URL; they must be the same database. Run this via ' +
        '`npm run test:db`, which sources .env.test.'
    );
  }
});

afterAll(async () => {
  // The singleton opened its own pool (the fixture client's is torn down by
  // Vitest's own teardown of tests/db/helpers.ts's module scope).
  await prisma.$disconnect();
});

// ─── Local fixture helpers ──────────────────────────────────────────────────
// File-local with module counters, per tests/db/helpers.ts:13-40 and the
// established "shared only once actually shared" convention. The
// Dataset -> GoldenSet -> GoldenItem chain mirrors
// tests/db/golden-set-freeze.test.ts:11-38; the JudgeModelVersion +
// ModelEndpoint pair mirrors tests/integration/producer.test.ts's
// `mkJudgeVersionWithEndpoint` (active + verifiedAt is exactly what
// run-launch.ts's `requireOwnedActiveEndpoints` demands).

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

async function mkGoldenSet(datasetId: string, ownerId: string, protocol: 'pairwise' | 'pointwise' = 'pairwise') {
  const name = uniq('fixture-golden-set');
  return db.goldenSet.create({
    data: { name, slug: name, datasetId, protocol, ownerId },
  });
}

/** One golden item + its candidates, and the DatasetSample it is imported
 * from (`GoldenItem.sourceDatasetSampleId` is required and `Restrict`). */
async function mkGoldenItem(
  goldenSetId: string,
  datasetId: string,
  index: number,
  opts: { candidateCount?: number } = {}
) {
  const sample = await db.datasetSample.create({
    data: { datasetId, index, input: `question ${index}`, expected: 'A>B' },
  });
  const candidateCount = opts.candidateCount ?? 2;
  return db.goldenItem.create({
    data: {
      goldenSetId,
      index,
      inputText: `question ${index}`,
      protocol: 'pairwise',
      expected: 'A>B',
      sourceDatasetSampleId: sample.id,
      candidates: {
        create: Array.from({ length: candidateCount }, (_, position) => ({
          position,
          responseText: `item ${index} candidate ${position}`,
        })),
      },
    },
  });
}

async function mkJudgeVersionWithEndpoint(
  userId: string,
  opts: { samplingDefaults?: Prisma.InputJsonValue } = {}
) {
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
      // UNSET by default (not null): every pre-v2k test below stays exactly
      // what it was, and block (4) exercises the resolver's "no defaults" arm.
      ...(opts.samplingDefaults !== undefined ? { samplingDefaults: opts.samplingDefaults } : {}),
    },
  });
  await db.modelEndpoint.create({
    data: { userId, judgeModelVersionId: version.id, isActive: true, verifiedAt: new Date() },
  });
  return version;
}

/** Everything a calibration launch needs, assembled once per test. */
async function mkWorld(
  opts: { items?: number; protocol?: 'pairwise' | 'pointwise'; samplingDefaults?: Prisma.InputJsonValue } = {}
) {
  const user = await mkUser();
  const project = await db.project.create({ data: { name: 'fixture-project', userId: user.id } });
  const rubric = await mkRubric(user.id);
  const dataset = await mkDataset(user.id);
  const goldenSet = await mkGoldenSet(dataset.id, user.id, opts.protocol ?? 'pairwise');
  const items = [];
  for (let index = 0; index < (opts.items ?? 3); index += 1) {
    // eslint-disable-next-line no-await-in-loop -- fixture setup; ordered so GoldenItem.index is deterministic
    items.push(await mkGoldenItem(goldenSet.id, dataset.id, index));
  }
  const version = await mkJudgeVersionWithEndpoint(user.id, { samplingDefaults: opts.samplingDefaults });
  return { user, project, rubric, dataset, goldenSet, items, version };
}

/** Never touches a broker: every DB test here injects this instead of the
 * real `publishJudgmentExecute`, so `npm run test:db` stays broker-free
 * (vitest.db.config.ts has no RabbitMQ anywhere in it). */
const noopPublish = async () => {};

function launchParamsFrom(world: Awaited<ReturnType<typeof mkWorld>>) {
  return {
    goldenSetId: world.goldenSet.id,
    judgeModelVersionId: world.version.id,
    rubricId: world.rubric.id,
    projectId: world.project.id,
    triggeredById: world.user.id,
  };
}

/**
 * One judgment in this judge's HISTORY, carrying the two columns the
 * throughput estimate reads. Hung off its own ordinary Evaluation/Run so it
 * is history, not part of the calibration under test. `status` defaults to
 * completed; pass 'error' to plant a row that must NOT count.
 *
 * Deliberately does NOT set `reasoningContent` (defaults to `null`). Since
 * `token-accounting`, `judgeThroughputEstimate` reads it too and pools
 * `accountTokens(row).estimatedGeneratedTokens`, not raw `outputTokens` —
 * but with `reasoningContent: null`, `accountTokens` classifies every row
 * here `no_reasoning_channel` and returns `estimatedGeneratedTokens ===
 * outputTokens` exactly. So the four fixtures below (2 tok/s against
 * 6144/300000, etc.) are UNCHANGED by that plan: this file tests the WIRING
 * (does `launchCalibrationRun` call the right functions with the right
 * values), and Task 1's own unit test is what pins the reasoning-channel
 * arithmetic — duplicating it here would only be a slower copy of that test.
 */
async function mkHistoryJudgment(
  world: Awaited<ReturnType<typeof mkWorld>>,
  measure: { outputTokens: number | null; latencyMs: number | null; status?: 'completed' | 'error' }
) {
  const evaluation = await db.evaluation.create({
    data: { projectId: world.project.id, userId: world.user.id, inputText: 'history' },
  });
  const run = await db.evaluationRun.create({ data: { evaluationId: evaluation.id } });
  return db.modelJudgment.create({
    data: {
      runId: run.id,
      judgeModelVersionId: world.version.id,
      status: measure.status ?? 'completed',
      outputTokens: measure.outputTokens,
      latencyMs: measure.latencyMs,
    },
  });
}

describe('v2i calibration ⇄ golden item link + v2k sampling snapshot (DB)', () => {
  beforeEach(async () => {
    // No `restoreMocks` in vitest.db.config.ts. The budget-warning test spies
    // on logger.warn; a spy that survived a mid-test failure would silence
    // every later warn in this file.
    vi.restoreAllMocks();
    await truncateAll();
    // A pairwise launch resolves the `v1-pairwise` PromptTemplate row, and
    // truncateAll drops it with everything else.
    await seedPromptTemplates(db);
  });

  // ── (1) The index itself ─────────────────────────────────────────────────

  it('rejects a second run for the same (calibrationRun, goldenItem) — P2002', async () => {
    const world = await mkWorld({ items: 1 });
    const evaluation = await db.evaluation.create({
      data: { projectId: world.project.id, userId: world.user.id, inputText: 'q' },
    });
    const calibrationRun = await db.calibrationRun.create({
      data: { judgeModelVersionId: world.version.id, goldenSetId: world.goldenSet.id },
    });

    await db.evaluationRun.create({
      data: {
        evaluationId: evaluation.id,
        calibrationRunId: calibrationRun.id,
        goldenItemId: world.items[0].id,
      },
    });

    // This is what makes a re-launch after a partial failure resumable rather
    // than double-counting: the same item cannot be measured twice inside one
    // calibration.
    await expect(
      db.evaluationRun.create({
        data: {
          evaluationId: evaluation.id,
          calibrationRunId: calibrationRun.id,
          goldenItemId: world.items[0].id,
        },
      })
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('two ORDINARY runs (both columns NULL) coexist — the index is NULLS DISTINCT, and must stay that way', async () => {
    const world = await mkWorld({ items: 0 });
    const evaluation = await db.evaluation.create({
      data: { projectId: world.project.id, userId: world.user.id, inputText: 'q' },
    });

    const first = await db.evaluationRun.create({ data: { evaluationId: evaluation.id } });
    const second = await db.evaluationRun.create({ data: { evaluationId: evaluation.id } });

    // Postgres' DEFAULT NULLS DISTINCT is load-bearing here, and the v2i
    // migration relies on it deliberately (no hand-edit, unlike
    // 20260728215410_v2b_idempotency_tighten's ModelJudgment index). Hand-edit
    // this one to NULLS NOT DISTINCT and EVERY ordinary run after the first
    // fails P2002 — this assertion is the tripwire for that.
    expect(first.id).not.toBe(second.id);
    expect(first.calibrationRunId).toBeNull();
    expect(first.goldenItemId).toBeNull();
    const rows = await db.evaluationRun.findMany({ where: { evaluationId: evaluation.id } });
    expect(rows).toHaveLength(2);
  });

  it('refuses to delete a GoldenItem a run measured — onDelete: Restrict (P2003)', async () => {
    const world = await mkWorld({ items: 1 });
    const evaluation = await db.evaluation.create({
      data: { projectId: world.project.id, userId: world.user.id, inputText: 'q' },
    });
    const calibrationRun = await db.calibrationRun.create({
      data: { judgeModelVersionId: world.version.id, goldenSetId: world.goldenSet.id },
    });
    await db.evaluationRun.create({
      data: {
        evaluationId: evaluation.id,
        calibrationRunId: calibrationRun.id,
        goldenItemId: world.items[0].id,
      },
    });

    // The number a run produced is uninterpretable without the item it was
    // measured against — same reasoning as CalibrationRun.goldenSetId's own
    // Restrict. (Item deletion is a tombstone everywhere in the product; this
    // is the backstop for anything that reaches for a real DELETE.)
    await expect(db.goldenItem.delete({ where: { id: world.items[0].id } })).rejects.toMatchObject({
      code: 'P2003',
    });
  });

  // ── (2) The launch path ──────────────────────────────────────────────────

  it('launches one run per live item, each carrying goldenItemId + calibrationRunId', async () => {
    const world = await mkWorld({ items: 3 });

    const result = await launchCalibrationRun(launchParamsFrom(world), { publish: noopPublish });

    expect(result.failed).toEqual([]);
    expect(new Set(result.accepted)).toEqual(new Set(world.items.map((item) => item.id)));

    const runs = await db.evaluationRun.findMany({
      where: { calibrationRunId: result.calibrationRunId },
      include: { runCandidates: true, modelJudgments: true },
    });
    expect(runs).toHaveLength(3);
    expect(new Set(runs.map((run) => run.goldenItemId))).toEqual(
      new Set(world.items.map((item) => item.id))
    );
    for (const run of runs) {
      expect(run.protocol).toBe('pairwise');
      expect(run.status).toBe('pending');
      expect(run.rubricId).toBe(world.rubric.id);
      // The comparison set is copied onto the run, not read from the item at
      // execution time — the worker renders from RunCandidate.
      expect(run.runCandidates).toHaveLength(2);
      // POSITION IS THE IDENTITY: 0 is slot A, 1 is slot B, and the answer key
      // (`GoldenItem.expected`, 'A>B'/'B>A') names those slots. A copy that
      // renumbers or reorders the pair inverts every verdict relative to the
      // key with NO SYMPTOM — accuracy lands on a plausible 1 - x, the
      // confusion matrix stays square, and the only effect is that the best
      // judge ranks worst (src/lib/calibration/readings.ts's module doc names
      // this exact class). A count assertion cannot see it, so assert the TEXT
      // at each position, and assert it against the item THIS run is linked to
      // — which also pins run-to-item pairing, not just the two id sets.
      const item = world.items.find((candidate) => candidate.id === run.goldenItemId)!;
      const byPosition = [...run.runCandidates].sort((a, b) => a.position - b.position);
      expect(byPosition.map((candidate) => candidate.position)).toEqual([0, 1]);
      expect(byPosition.map((candidate) => candidate.responseText)).toEqual([
        `item ${item.index} candidate 0`,
        `item ${item.index} candidate 1`,
      ]);
      expect(run.modelJudgments).toHaveLength(1);
      expect(run.modelJudgments[0].pairOrder).toBe('AB');
      expect(run.modelJudgments[0].judgeModelVersionId).toBe(world.version.id);
    }

    // The CalibrationRun header records the rubric in force — a kappa under
    // rubric X is not comparable to one under rubric Y.
    const header = await db.calibrationRun.findUniqueOrThrow({ where: { id: result.calibrationRunId } });
    expect(header.rubricId).toBe(world.rubric.id);
    expect(header.goldenSetId).toBe(world.goldenSet.id);
    expect(header.judgeModelVersionId).toBe(world.version.id);
  });

  it('stamps a BATCH-aware deadline, far beyond the naive single-model one the reaper would abandon', async () => {
    const world = await mkWorld({ items: 3 });
    const launchedAt = Date.now();

    const result = await launchCalibrationRun(launchParamsFrom(world), { publish: noopPublish });

    const runs = await db.evaluationRun.findMany({ where: { calibrationRunId: result.calibrationRunId } });
    expect(runs).toHaveLength(3);

    // THE REAPER FIX. `launchSingleRun`'s own formula is
    // now + (#models × timeout) + slack, which for one model is ~180s — but a
    // 3-item batch is 3 judgments deep in ONE queue, and the runs at the back
    // do not start executing for as long as the ones ahead of them take.
    // src/worker/reaper.ts force-finalizes a run 180s past its deadline by
    // stamping every still-pending judgment `error: 'reaper: abandoned'`, so
    // the naive deadline silently scores only the head of the batch.
    // Both bounds are computed from the HARD CAP, not the initial budget, and
    // that is the point rather than an implementation detail. Since the
    // escalating timeout landed, reaching EVALUATION_MODEL_TIMEOUT_MS only
    // raises an alert — the call keeps running to the cap. A deadline sized on
    // the initial budget would therefore let the reaper abandon judgments that
    // are still legitimately executing, which is the same failure this test was
    // written to prevent, reintroduced through the timeout rather than through
    // the batch size.
    const perCallCeilingMs = resolveTimeoutBudgets().hardCapMs;
    const naiveSingleModelDeadline = launchedAt + perCallCeilingMs + DEADLINE_SLACK_MS;
    const batchAwareDeadline = launchedAt + 3 * perCallCeilingMs + DEADLINE_SLACK_MS;
    for (const run of runs) {
      expect(run.deadlineAt).not.toBeNull();
      expect(run.deadlineAt!.getTime()).toBeGreaterThan(naiveSingleModelDeadline);
      // Widened from "models in this run" to "judgments queued ahead of this
      // one" — the same formula, not a bigger fudge factor. Every run in the
      // batch carries the SAME deadline (the batch finishes as a unit), so the
      // bound holds for all of them, ±the wall clock spent launching.
      expect(run.deadlineAt!.getTime()).toBeGreaterThanOrEqual(batchAwareDeadline);
      expect(run.deadlineAt!.getTime()).toBeLessThan(batchAwareDeadline + 60_000);
    }
  });

  it('freezes the golden set: isGoldenSetFrozen is false before the launch and true after', async () => {
    const world = await mkWorld({ items: 2 });

    expect(await db.$transaction((tx) => isGoldenSetFrozen(tx, world.goldenSet.id))).toBe(false);

    const first = await launchCalibrationRun(launchParamsFrom(world), { publish: noopPublish });

    // IRREVERSIBLE. There is no unfreeze verb anywhere in the product — the
    // way to change a measured set's items is to fork it.
    expect(await db.$transaction((tx) => isGoldenSetFrozen(tx, world.goldenSet.id))).toBe(true);

    // `frozeGoldenSet` is the ONLY thing a caller fronting a human can warn
    // on, and it is a boolean whose two values look equally plausible in every
    // downstream log and response — so an inverted flag is invisible except to
    // an assertion on both branches. THIS launch is the one that froze the set;
    // a second calibration of the same set does not (it was already frozen),
    // and "it was already frozen" is not worth a confirmation prompt.
    expect(first.frozeGoldenSet).toBe(true);
    const second = await launchCalibrationRun(launchParamsFrom(world), { publish: noopPublish });
    expect(second.frozeGoldenSet).toBe(false);
    expect(second.calibrationRunId).not.toBe(first.calibrationRunId);
  });

  it('skips tombstoned items — a removed item is not measured, and does not fail the launch either', async () => {
    const world = await mkWorld({ items: 3 });
    await db.goldenItem.update({
      where: { id: world.items[1].id },
      data: { tombstonedAt: new Date() },
    });

    const result = await launchCalibrationRun(launchParamsFrom(world), { publish: noopPublish });

    expect(result.failed).toEqual([]);
    expect(new Set(result.accepted)).toEqual(new Set([world.items[0].id, world.items[2].id]));
    const runs = await db.evaluationRun.findMany({ where: { calibrationRunId: result.calibrationRunId } });
    expect(runs).toHaveLength(2);
  });

  it('is ITEM-ATOMIC: one bad item is reported and the rest still launch', async () => {
    const world = await mkWorld({ items: 3 });
    // A pairwise run needs exactly 2 candidates; this item has 1. Reaching
    // launchSingleRun's own refusal is the point — the failure has to be
    // per-item, not a batch-wide rollback.
    const broken = await mkGoldenItem(world.goldenSet.id, world.dataset.id, 3, { candidateCount: 1 });

    const result = await launchCalibrationRun(launchParamsFrom(world), { publish: noopPublish });

    expect(new Set(result.accepted)).toEqual(new Set(world.items.map((item) => item.id)));
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].goldenItemId).toBe(broken.id);
    expect(result.failed[0].reason).toMatch(/exactly 2 candidates/);

    // The three good items are durably launched — no 4-way rollback.
    const runs = await db.evaluationRun.findMany({ where: { calibrationRunId: result.calibrationRunId } });
    expect(runs).toHaveLength(3);
  });

  it('reports a publish failure as a FAILED item — a run nothing will ever execute is not "accepted"', async () => {
    const world = await mkWorld({ items: 2 });

    // `launchSingleRun` does not throw on a broker failure: it compensates the
    // run to `status: 'error'` and RETURNS `publishFailed`. Counting that item
    // as accepted is the failure this pins — the run row exists and looks
    // launched, no `judgment.execute` was ever delivered, and the caller (and
    // the operator reading `accepted`) would wait forever for a verdict that
    // no worker has been told to produce.
    const result = await launchCalibrationRun(launchParamsFrom(world), {
      publish: async () => {
        throw new Error('broker unreachable');
      },
    });

    expect(result.accepted).toEqual([]);
    expect(new Set(result.failed.map((failure) => failure.goldenItemId))).toEqual(
      new Set(world.items.map((item) => item.id))
    );
    expect(result.failed[0].reason).toMatch(/broker unreachable/);

    // Compensated, not left `pending` for the reaper to rediscover.
    const runs = await db.evaluationRun.findMany({ where: { calibrationRunId: result.calibrationRunId } });
    expect(runs).toHaveLength(2);
    expect(runs.every((run) => run.status === 'error')).toBe(true);
  });

  // ── (3) The refusals, and what they must NOT leave behind ────────────────

  it('refuses a non-pairwise golden set WITHOUT freezing it', async () => {
    const world = await mkWorld({ items: 1, protocol: 'pointwise' });

    await expect(
      launchCalibrationRun(launchParamsFrom(world), { publish: noopPublish })
    ).rejects.toThrow(/pairwise/i);

    // A refusal that had already written the CalibrationRun header would have
    // frozen the set forever for a calibration that measured nothing.
    expect(await db.$transaction((tx) => isGoldenSetFrozen(tx, world.goldenSet.id))).toBe(false);
    expect(await db.calibrationRun.count()).toBe(0);
  });

  it(`refuses more than ${MAX_CALIBRATION_ITEMS} items rather than silently truncating`, async () => {
    const world = await mkWorld({ items: 0 });
    // Bulk-created (createMany, no candidates needed — the cap is refused
    // before any item is launched).
    await db.datasetSample.createMany({
      data: Array.from({ length: MAX_CALIBRATION_ITEMS + 1 }, (_, index) => ({
        datasetId: world.dataset.id,
        index,
        input: `question ${index}`,
      })),
    });
    const samples = await db.datasetSample.findMany({ where: { datasetId: world.dataset.id } });
    await db.goldenItem.createMany({
      data: samples.map((sample, index) => ({
        goldenSetId: world.goldenSet.id,
        index,
        inputText: sample.input,
        protocol: 'pairwise' as const,
        sourceDatasetSampleId: sample.id,
      })),
    });

    await expect(
      launchCalibrationRun(launchParamsFrom(world), { publish: noopPublish })
    ).rejects.toThrow(new RegExp(String(MAX_CALIBRATION_ITEMS)));

    // Not truncated to the cap and launched anyway: nothing ran, and the set
    // is not frozen.
    expect(await db.evaluationRun.count()).toBe(0);
    expect(await db.$transaction((tx) => isGoldenSetFrozen(tx, world.goldenSet.id))).toBe(false);
  });

  it('refuses a judge the caller has no active verified endpoint for — and does not freeze the set', async () => {
    const world = await mkWorld({ items: 2 });
    await db.modelEndpoint.updateMany({
      where: { judgeModelVersionId: world.version.id },
      data: { isActive: false },
    });

    // Checked BEFORE the header is written. Without the pre-flight this
    // failure is knowable up front but only surfaces per item — after the
    // freeze — so the set would be pinned forever by a calibration in which
    // every single item failed.
    await expect(
      launchCalibrationRun(launchParamsFrom(world), { publish: noopPublish })
    ).rejects.toThrow(/endpoint/i);

    expect(await db.$transaction((tx) => isGoldenSetFrozen(tx, world.goldenSet.id))).toBe(false);
  });

  it('refuses a golden set with no live items — an empty calibration would freeze a set and measure nothing', async () => {
    const world = await mkWorld({ items: 0 });

    await expect(
      launchCalibrationRun(launchParamsFrom(world), { publish: noopPublish })
    ).rejects.toThrow(/no live items/i);

    expect(await db.$transaction((tx) => isGoldenSetFrozen(tx, world.goldenSet.id))).toBe(false);
  });

  // ── (4) The sampling snapshot (v2k) ──────────────────────────────────────
  //
  // `JudgeModelVersion.samplingDefaults` is MUTABLE — no history, no
  // updatedAt, three in-tree writers — so a join from a historical run through
  // its version reports TODAY's config (scoreboard spec §4.1: raising
  // granite4.2 from 4096 to 12288 for run #9 silently rewrote what that join
  // says about run #7). prisma/seed-core.ts:223-229 already declares a version
  // immutable under a judgment; nothing enforces it. The header therefore
  // snapshots the RESOLVED params at launch, with the same
  // `effectiveSamplingParams` the worker's pairwise seam resolves per call
  // (registry.ts prepareJudgmentCall; judgment-consumer.ts's pairwise seam
  // passes no overrides), so header == every ModelJudgment.samplingParams of
  // the run unless the row moved mid-run — and header ≠ judgment is the tell.

  it('snapshots the EFFECTIVE sampling params on the header at launch — the resolver the worker uses, not the raw JSON', async () => {
    const world = await mkWorld({ items: 1, samplingDefaults: { temperature: 0.2, max_tokens: 12288 } });

    const result = await launchCalibrationRun(launchParamsFrom(world), { publish: noopPublish });

    const header = await db.calibrationRun.findUniqueOrThrow({ where: { id: result.calibrationRunId } });
    expect(header.samplingParams).toEqual({ temperature: 0.2, max_tokens: 12288 });
    // One resolver, not two: what the header says equals what the worker will
    // persist on each judgment of this run.
    expect(header.samplingParams).toEqual(effectiveSamplingParams(world.version.samplingDefaults));
    // Returned to the caller too, so the CLI prints the snapshot without a re-read.
    expect(result.samplingParams).toEqual({ temperature: 0.2, max_tokens: 12288 });
  });

  it('editing samplingDefaults AFTER the launch does not move the header — and the join through the version now lies', async () => {
    const world = await mkWorld({ items: 1, samplingDefaults: { temperature: 0.3, max_tokens: 4096 } });
    const result = await launchCalibrationRun(launchParamsFrom(world), { publish: noopPublish });

    // The production edit, in shape: a raw update of the version row
    // (spec §4.1, 4096 -> 12288 for a re-run).
    await db.judgeModelVersion.update({
      where: { id: world.version.id },
      data: { samplingDefaults: { temperature: 0.3, max_tokens: 12288 } },
    });

    const header = await db.calibrationRun.findUniqueOrThrow({
      where: { id: result.calibrationRunId },
      include: { judgeModelVersion: { select: { samplingDefaults: true } } },
    });
    // The snapshot is what ran.
    expect(header.samplingParams).toEqual({ temperature: 0.3, max_tokens: 4096 });
    // LOAD-BEARING: the obvious join really does report today's config for
    // the historical run. Without this the assertion above is a shape test
    // of a column, not a behaviour test of the hazard the column exists for.
    expect(header.judgeModelVersion.samplingDefaults).toEqual({ temperature: 0.3, max_tokens: 12288 });
  });

  it('a version with NO samplingDefaults snapshots the registry default — NULL means "launched before v2k" and nothing else', async () => {
    const world = await mkWorld({ items: 1 }); // samplingDefaults unset

    const result = await launchCalibrationRun(launchParamsFrom(world), { publish: noopPublish });

    const header = await db.calibrationRun.findUniqueOrThrow({ where: { id: result.calibrationRunId } });
    expect(header.samplingParams).not.toBeNull();
    expect(header.samplingParams).toEqual({ temperature: 0.3, max_tokens: 4096 });
  });

  it('a PARTIAL samplingDefaults is resolved field-by-field before it is stored — the header is never a copy of the raw JSON', async () => {
    // The production shape (spec §4.1): granite4.2's max_tokens was raised
    // 4096 -> 12288 and `temperature` was never set. This is the ONLY test
    // here that distinguishes the resolver from the obvious shortcut
    // `version.samplingDefaults ?? JUDGE_DEFAULT_SAMPLING_PARAMS` — under that
    // implementation the three tests above all still pass (their fixtures are
    // full pairs or unset), and this one stores `{ max_tokens: 12288 }` with
    // no temperature, breaking the schema comment's "never the raw, nullable,
    // possibly partial samplingDefaults" and the field-for-field comparison
    // with ModelJudgment.samplingParams that the drift detector rests on.
    const world = await mkWorld({ items: 1, samplingDefaults: { max_tokens: 12288 } });

    const result = await launchCalibrationRun(launchParamsFrom(world), { publish: noopPublish });

    const header = await db.calibrationRun.findUniqueOrThrow({ where: { id: result.calibrationRunId } });
    // Full pair on the header; the version's own field is still partial.
    expect(header.samplingParams).toEqual({ temperature: 0.3, max_tokens: 12288 });
    expect(world.version.samplingDefaults).toEqual({ max_tokens: 12288 });
  });

  // ── (5) The stacked-limits warning (runbook §8.6; register §5.6/8) ───────
  // (Block (4) is the v2k sampling snapshot, added by calibration-sampling-snapshot.)
  //
  // `max_tokens / tok_per_s` must fit under the HARD CAP, or a judgment that
  // needs its whole budget is ABORTED rather than truncated. Which wall,
  // precisely: NOT the 300 s provider timeout granite4.2 stalled on in
  // runbook §8.6 — 35 tok/s × 12288 is ~351 s, over 300 s but well under
  // 900 s, so this rule is correctly SILENT on granite and is not the check
  // that would have caught it. §8.7 made 300 s an alert that keeps waiting;
  // the hard cap is now the only wall that aborts. The live case is
  // qwen3.5:9b: its judge path always sends response_format: json_schema,
  // and outputTokens excludes the reasoning channel on this model, so the
  // rate has to be `judgeThroughputEstimate`'s accountTokens-derived pooled
  // figure, never raw outputTokens — measured against judge-arena-pg-1 on
  // 2026-09-02 at 12.0 tok/s (pooled over its 15 completed judgments):
  // 12288 / 12.0 = 1024 s against 900 s. (The db fixtures below use plainer
  // round numbers — 2 tok/s against 6144/300000 — chosen for the wiring
  // this task tests, not to reproduce that live figure; Task 1's own
  // `pools via accountTokens` unit test is what pins this arithmetic.) The
  // launch computes it from the judge's COMPLETED history and the RESOLVED
  // snapshot (`samplingParams`, v2k) and WARNS. It never refuses: the first
  // calibration of any judge has no history to measure.

  it('warns when the effective max_tokens cannot be produced inside the hard cap — and still launches', async () => {
    // `logger` is a plain object (`src/lib/logger.ts:104`), so a spy needs no
    // `vi.mock` and no hoisting — the same shape `tests/lib/backends.test.ts`
    // :263 / :294 uses. `vitest.db.config.ts` sets no `restoreMocks`, which is
    // why Step 3(f) adds `vi.restoreAllMocks()` to this file's `beforeEach`
    // (:186-191): a spy left installed by a mid-test failure would otherwise
    // swallow every later warn in the file and turn one red into a cascade.
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const world = await mkWorld({ items: 1, samplingDefaults: { temperature: 0.3, max_tokens: 12288 } });
    // 600 tokens in 300 s = 2.0 tok/s, so 12288 tokens take 6144 s, which
    // formatDurationMs renders `102m24s` (it has no hours unit).
    // Chosen far above the 900 s default and above MAX_HARD_CAP_MS (1170 s,
    // the value env.ts refuses at boot), so no hard cap this deployment can
    // legally run under makes 12288 tokens fit.
    await mkHistoryJudgment(world, { outputTokens: 600, latencyMs: 300_000 });

    const result = await launchCalibrationRun(launchParamsFrom(world), { publish: noopPublish });

    // NOT `.not.toBeNull()`: before the property exists, `budgetWarning` is
    // `undefined`, and `expect(undefined).not.toBeNull()` PASSES — an
    // assertion that cannot fail for the case it is guarding (CONTRIBUTING.md
    // :227-230, "a green test can be impossible to fail"). `typeof` goes red
    // for both `null` and `undefined`.
    expect(typeof result.budgetWarning).toBe('string');
    // The EFFECTIVE budget from the snapshot, not the registry default 4096.
    expect(result.budgetWarning).toMatch(/max_tokens 12288/);
    expect(result.budgetWarning).toMatch(/2\.0 tok\/s/);
    // `/n=1/` alone would also match `n=10`, `n=12`, `n=100` (failure mode 3,
    // the substring class). Pin the rendered CLAUSE so the sample size is
    // asserted in its role.
    expect(result.budgetWarning).toMatch(/n=1 completed judgment/);
    expect(result.budgetWarning).toMatch(/LOWER bound/);
    // A warning, not a refusal: the run launched.
    expect(result.accepted).toEqual([world.items[0].id]);
    expect(result.failed).toEqual([]);

    // ── The LOG, which is the only DURABLE record of this warning ─────────
    // The CLI print is transient stdout; `CalibrationLaunchResult` is gone
    // the moment the caller returns. Without this assertion the wrong
    // implementation that survives every other gate is: delete the whole
    // `if (budgetWarning !== null) { logger.warn(...) }` block, or ship it
    // with a mis-keyed payload. Three docs (the Architecture paragraph, the
    // runbook and the register DONE marker) claim this log exists, so it
    // gets an assertion and an injection like any other behaviour.
    // `toHaveBeenCalledTimes(1)`, and it is NOT brittle — the other three
    // `logger.warn` calls reachable from this path are all provably silent
    // here: launch.ts:212 fires only over MAX_CALIBRATION_ITEMS (this world
    // has 1 item), launch.ts:447 only when `failed` is non-empty (asserted
    // empty above), and run-launch.ts:661 only when `publish()` throws
    // (`noopPublish` cannot). If this count ever reads 2, something new is
    // warning on the happy path and that is worth knowing, not worth
    // loosening the assertion for.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [msg, payload] = warnSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(msg).toMatch(/cannot be produced inside the hard cap/);
    expect(payload).toMatchObject({
      calibrationRunId: result.calibrationRunId,
      judgeModelVersionId: world.version.id,
      maxTokens: 12288,
      warning: result.budgetWarning,
    });
    warnSpy.mockRestore();
  });

  it('a judge with no COMPLETED judgment gets no warning — first-ever judges must launch', async () => {
    const world = await mkWorld({ items: 1, samplingDefaults: { temperature: 0.3, max_tokens: 12288 } });
    // An ERRORED judgment with terrible numbers is present and must NOT
    // count: a call that timed out says the judge did not answer, not how
    // fast it answers.
    await mkHistoryJudgment(world, { outputTokens: 600, latencyMs: 300_000, status: 'error' });

    const result = await launchCalibrationRun(launchParamsFrom(world), { publish: noopPublish });

    expect(result.budgetWarning).toBeNull();
    expect(result.accepted).toEqual([world.items[0].id]);
  });

  it('a judge fast enough for its budget gets no warning', async () => {
    // Kept deliberately, though it looks redundant beside the errored-history
    // test: it is the ONLY test here that would go red if `hardCapMs` were
    // mis-wired (e.g. a hard-coded 0, or `resolveTimeoutBudgets()` dropped).
    // With hardCapMs = 0 the over-cap and RESOLVED-budget tests still warn
    // and the errored-history test still returns null — only a judge that
    // genuinely FITS discriminates. It is also the only end-to-end guard
    // against a false-positive warning on a healthy judge, which is the
    // failure mode an operator would actually notice.
    //
    // Qwen's measured envelope: 2869 output tokens in 49.0 s = 58.5 tok/s;
    // the registry-default 4096 budget exhausts in ~70 s against the cap
    // (900 s by default — this assumes the cap is not configured below 70 s).
    const world = await mkWorld({ items: 1 });
    await mkHistoryJudgment(world, { outputTokens: 2869, latencyMs: 49_000 });

    const result = await launchCalibrationRun(launchParamsFrom(world), { publish: noopPublish });

    expect(result.budgetWarning).toBeNull();
    expect(result.accepted).toEqual([world.items[0].id]);
  });

  it('reads the RESOLVED budget: a version pinning only temperature inherits max_tokens 4096 and is warned on it', async () => {
    // The raw samplingDefaults has NO max_tokens here. Only the resolver
    // (effectiveSamplingParams, per-field merge with the registry default
    // { temperature: 0.3, max_tokens: 4096 }) produces a number; a raw read
    // of `samplingDefaults.max_tokens` is `undefined`, the division is NaN,
    // and `!(NaN > cap)` is silence. 4096 / 2.0 tok/s = 2048 s, over any
    // cap this deployment can legally run under (MAX_HARD_CAP_MS is 1170 s).
    const world = await mkWorld({ items: 1, samplingDefaults: { temperature: 0.3 } });
    await mkHistoryJudgment(world, { outputTokens: 600, latencyMs: 300_000 });

    const result = await launchCalibrationRun(launchParamsFrom(world), { publish: noopPublish });

    expect(result.budgetWarning).toMatch(/max_tokens 4096/);
    expect(result.accepted).toEqual([world.items[0].id]);
  });
});
