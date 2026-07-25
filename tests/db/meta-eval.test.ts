import { describe, it, expect, beforeEach } from 'vitest';
import { db, truncateAll, mkUser } from './helpers';

// ─── Local fixture helpers ──────────────────────────────────────────────────
// A CalibrationRun needs a JudgeModelVersion; no other tests/db/** spec
// shares this exact chain-builder yet (judgment-provenance.test.ts has its
// own file-local copy too), so it's kept file-local per the established
// "shared only once actually shared" convention. Shape matches
// tests/db/judge-identity.test.ts.

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

async function mkGoldenSet(ownerId?: string) {
  return db.goldenSet.create({
    data: { name: 'fixture-golden-set', ownerId },
  });
}

async function mkGoldenItem(goldenSetId: string, index = 0) {
  return db.goldenItem.create({
    data: { goldenSetId, index, inputText: 'fixture input' },
  });
}

describe('meta-eval tables (GoldenSet/GoldenItem/GoldenLabel/CalibrationRun)', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it('two annotators can label the same item; the same annotator twice rejects P2002 pinned to (goldenItemId, annotatorId)', async () => {
    const owner = await mkUser();
    const annotatorA = await mkUser();
    const annotatorB = await mkUser();
    const goldenSet = await mkGoldenSet(owner.id);
    const item = await mkGoldenItem(goldenSet.id);

    const labelA = await db.goldenLabel.create({
      data: { goldenItemId: item.id, annotatorId: annotatorA.id, overallScore: 8 },
    });
    const labelB = await db.goldenLabel.create({
      data: { goldenItemId: item.id, annotatorId: annotatorB.id, overallScore: 6 },
    });
    expect(labelA.id).not.toBe(labelB.id);

    await expect(
      db.goldenLabel.create({
        data: { goldenItemId: item.id, annotatorId: annotatorA.id, overallScore: 9 },
      })
    ).rejects.toMatchObject({
      code: 'P2002',
      meta: { target: ['goldenItemId', 'annotatorId'] },
    });
  });

  it('GoldenItem (goldenSetId, index) is unique', async () => {
    const goldenSet = await mkGoldenSet();
    await mkGoldenItem(goldenSet.id, 0);

    await expect(mkGoldenItem(goldenSet.id, 0)).rejects.toMatchObject({ code: 'P2002' });
  });

  it('deleting a golden set with a CalibrationRun is restricted (P2003)', async () => {
    const goldenSet = await mkGoldenSet();
    const judgeModelVersion = await mkJudgeModelVersion();
    await db.calibrationRun.create({
      data: { judgeModelVersionId: judgeModelVersion.id, goldenSetId: goldenSet.id },
    });

    await expect(db.goldenSet.delete({ where: { id: goldenSet.id } })).rejects.toMatchObject({
      code: 'P2003',
    });
  });

  it('deleting the owning JudgeModelVersion of a CalibrationRun is restricted (P2003)', async () => {
    const goldenSet = await mkGoldenSet();
    const judgeModelVersion = await mkJudgeModelVersion();
    await db.calibrationRun.create({
      data: { judgeModelVersionId: judgeModelVersion.id, goldenSetId: goldenSet.id },
    });

    await expect(
      db.judgeModelVersion.delete({ where: { id: judgeModelVersion.id } })
    ).rejects.toMatchObject({ code: 'P2003' });
  });

  it('deleting the owner of a GoldenSet nulls ownerId but the set survives', async () => {
    const owner = await mkUser();
    const goldenSet = await mkGoldenSet(owner.id);

    await db.user.delete({ where: { id: owner.id } });

    const survived = await db.goldenSet.findUnique({ where: { id: goldenSet.id } });
    expect(survived).not.toBeNull();
    expect(survived?.ownerId).toBeNull();
  });

  it('deleting the annotator of a GoldenLabel nulls annotatorId but the label survives', async () => {
    const goldenSet = await mkGoldenSet();
    const item = await mkGoldenItem(goldenSet.id);
    const annotator = await mkUser();
    const label = await db.goldenLabel.create({
      data: { goldenItemId: item.id, annotatorId: annotator.id, overallScore: 7 },
    });

    await db.user.delete({ where: { id: annotator.id } });

    const survived = await db.goldenLabel.findUnique({ where: { id: label.id } });
    expect(survived).not.toBeNull();
    expect(survived?.annotatorId).toBeNull();
  });

  it('deleting a GoldenSet cascades to its GoldenItems and their GoldenLabels', async () => {
    const goldenSet = await mkGoldenSet();
    const item = await mkGoldenItem(goldenSet.id);
    const annotator = await mkUser();
    await db.goldenLabel.create({
      data: { goldenItemId: item.id, annotatorId: annotator.id, overallScore: 5 },
    });

    await db.goldenSet.delete({ where: { id: goldenSet.id } });

    expect(await db.goldenItem.findUnique({ where: { id: item.id } })).toBeNull();
    expect(await db.goldenLabel.findMany({ where: { goldenItemId: item.id } })).toHaveLength(0);
  });

  it('GoldenSet.visibility defaults to private; CalibrationRun.verdictCount defaults to 0', async () => {
    const goldenSet = await mkGoldenSet();
    expect(goldenSet.visibility).toBe('private');

    const judgeModelVersion = await mkJudgeModelVersion();
    const run = await db.calibrationRun.create({
      data: { judgeModelVersionId: judgeModelVersion.id, goldenSetId: goldenSet.id },
    });
    expect(run.verdictCount).toBe(0);
    expect(run.passed).toBeNull();
    expect(run.finishedAt).toBeNull();
  });
});
