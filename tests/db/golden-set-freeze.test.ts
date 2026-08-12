import { describe, it, expect, beforeEach } from 'vitest';
import { db, truncateAll, mkUser } from './helpers';
import { isGoldenSetFrozen } from '@/lib/golden-sets';

// ─── Local fixture helpers ──────────────────────────────────────────────────
// Kept file-local with module counters, per tests/db/helpers.ts:13-40 and the
// established "shared only once actually shared" convention. The
// JudgeModelVersion chain matches tests/db/meta-eval.test.ts:13-31; a
// CalibrationRun cannot exist without one.

let datasetCounter = 0;

async function mkDataset(userId: string) {
  datasetCounter += 1;
  return db.dataset.create({
    data: {
      name: `fixture-dataset-${datasetCounter}`,
      slug: `fixture-dataset-${datasetCounter}`,
      visibility: 'public',
      inputType: 'query-response',
      userId,
    },
  });
}

let goldenSetCounter = 0;

async function mkGoldenSet(datasetId: string, ownerId: string) {
  goldenSetCounter += 1;
  return db.goldenSet.create({
    data: {
      name: `fixture-golden-set-${goldenSetCounter}`,
      slug: `fixture-golden-set-${goldenSetCounter}`,
      datasetId,
      protocol: 'pairwise',
      ownerId,
    },
  });
}

let judgeModelCounter = 0;

async function mkJudgeModelVersion() {
  judgeModelCounter += 1;
  const judgeModel = await db.judgeModel.create({
    data: {
      name: `fixture-judge-${judgeModelCounter}`,
      slug: `fixture-judge-${judgeModelCounter}`,
      judgeClass: 'prompted_api',
      scoringMechanism: 'critique_generative',
    },
  });
  return db.judgeModelVersion.create({
    data: {
      judgeModelId: judgeModel.id,
      ordinal: 1,
      servingBackend: 'openai',
      protocolSupport: { pointwise: ['score'] },
    },
  });
}

describe('isGoldenSetFrozen (live DB)', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it('is false for a golden set no CalibrationRun references', async () => {
    const owner = await mkUser();
    const dataset = await mkDataset(owner.id);
    const goldenSet = await mkGoldenSet(dataset.id, owner.id);

    const frozen = await db.$transaction((tx) => isGoldenSetFrozen(tx, goldenSet.id));
    expect(frozen).toBe(false);
  });

  it('is true once a CalibrationRun references it', async () => {
    const owner = await mkUser();
    const dataset = await mkDataset(owner.id);
    const goldenSet = await mkGoldenSet(dataset.id, owner.id);
    const judgeModelVersion = await mkJudgeModelVersion();
    await db.calibrationRun.create({
      data: { judgeModelVersionId: judgeModelVersion.id, goldenSetId: goldenSet.id },
    });

    const frozen = await db.$transaction((tx) => isGoldenSetFrozen(tx, goldenSet.id));
    expect(frozen).toBe(true);
  });

  it('is true for a run that never finished — finishedAt is not consulted', async () => {
    const owner = await mkUser();
    const dataset = await mkDataset(owner.id);
    const goldenSet = await mkGoldenSet(dataset.id, owner.id);
    const judgeModelVersion = await mkJudgeModelVersion();
    const run = await db.calibrationRun.create({
      data: { judgeModelVersionId: judgeModelVersion.id, goldenSetId: goldenSet.id },
    });
    expect(run.finishedAt).toBeNull();

    // CalibrationRun has no status enum, so "still running" and "crashed"
    // are indistinguishable. Excluding unfinished runs would let a crashed
    // run's set drift under the numbers it already produced.
    expect(await db.$transaction((tx) => isGoldenSetFrozen(tx, goldenSet.id))).toBe(true);
  });

  it('does not freeze a sibling set measured by the same judge version', async () => {
    const owner = await mkUser();
    const dataset = await mkDataset(owner.id);
    const measured = await mkGoldenSet(dataset.id, owner.id);
    const untouched = await mkGoldenSet(dataset.id, owner.id);
    const judgeModelVersion = await mkJudgeModelVersion();
    await db.calibrationRun.create({
      data: { judgeModelVersionId: judgeModelVersion.id, goldenSetId: measured.id },
    });

    expect(await db.$transaction((tx) => isGoldenSetFrozen(tx, measured.id))).toBe(true);
    expect(await db.$transaction((tx) => isGoldenSetFrozen(tx, untouched.id))).toBe(false);
  });

  it('sees a CalibrationRun written earlier in the SAME transaction', async () => {
    // This is why the predicate takes the caller's tx rather than the module
    // singleton: the count and the mutation it guards must be one
    // transaction, or a calibration run started between them measures a set
    // that changed underneath it — with nothing logged anywhere.
    const owner = await mkUser();
    const dataset = await mkDataset(owner.id);
    const goldenSet = await mkGoldenSet(dataset.id, owner.id);
    const judgeModelVersion = await mkJudgeModelVersion();

    const observed = await db.$transaction(async (tx) => {
      const before = await isGoldenSetFrozen(tx, goldenSet.id);
      await tx.calibrationRun.create({
        data: { judgeModelVersionId: judgeModelVersion.id, goldenSetId: goldenSet.id },
      });
      const after = await isGoldenSetFrozen(tx, goldenSet.id);
      return { before, after };
    });

    expect(observed).toEqual({ before: false, after: true });
  });
});
