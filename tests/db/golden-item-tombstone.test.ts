import { describe, it, expect, beforeEach } from 'vitest';
import { db, truncateAll, mkUser } from './helpers';
import { nextGoldenItemIndex } from '@/lib/golden-sets';

// A0, tombstone-not-delete ruling (2026-08-13). GoldenItem.index is assigned
// 0..n-1 by the importer over its selection, which stays true because import
// runs against an empty set. Once ANY item is tombstoned the sequence stops
// being dense, and the only safe next index is a HIGH-WATER MARK over every
// row including the tombstoned ones — because a tombstoned row keeps its
// ordinal and @@unique([goldenSetId, index]) is not partial.

let counter = 0;

async function mkSetWithItems(itemCount: number) {
  counter += 1;
  const owner = await mkUser();
  const dataset = await db.dataset.create({
    data: {
      name: `tombstone-fixture-${counter}`,
      userId: owner.id,
      source: 'local',
      visibility: 'public',
      samples: {
        create: Array.from({ length: itemCount }, (_, i) => ({
          index: i,
          input: `question-${i}`,
          expected: 'A>B',
        })),
      },
    },
    include: { samples: { orderBy: { index: 'asc' } } },
  });
  const goldenSet = await db.goldenSet.create({
    data: {
      name: `tombstone-fixture-set-${counter}`,
      slug: `tombstone-fixture-set-${counter}`,
      ownerId: owner.id,
      datasetId: dataset.id,
      protocol: 'pairwise',
      items: {
        create: dataset.samples.map((s, i) => ({
          index: i,
          inputText: s.input,
          protocol: 'pairwise' as const,
          expected: 'A>B',
          sourceDatasetSampleId: s.id,
        })),
      },
    },
    include: { items: { orderBy: { index: 'asc' } } },
  });
  return { owner, dataset, goldenSet };
}

describe('nextGoldenItemIndex — the high-water-mark rule', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it('is 0 on an empty set and n on a dense set of n items', async () => {
    const { goldenSet: empty } = await mkSetWithItems(0);
    await expect(nextGoldenItemIndex(db, empty.id)).resolves.toBe(0);

    const { goldenSet: dense } = await mkSetWithItems(5);
    await expect(nextGoldenItemIndex(db, dense.id)).resolves.toBe(5);
  });

  it('counts TOMBSTONED rows too — a count() of live rows would collide immediately', async () => {
    const { goldenSet } = await mkSetWithItems(3);
    await db.goldenItem.updateMany({
      where: { goldenSetId: goldenSet.id, index: 0 },
      data: { tombstonedAt: new Date() },
    });

    // Two live rows, at indices 1 and 2. count() says 2 — and index 2 is
    // taken, so an insert at 2 is an immediate P2002.
    await expect(
      db.goldenItem.count({ where: { goldenSetId: goldenSet.id, tombstonedAt: null } })
    ).resolves.toBe(2);
    await expect(nextGoldenItemIndex(db, goldenSet.id)).resolves.toBe(3);
  });

  it('survives a tombstoned TAIL, where max(index) over LIVE rows would also collide', async () => {
    const { goldenSet } = await mkSetWithItems(5);
    await db.goldenItem.updateMany({
      where: { goldenSetId: goldenSet.id, index: { in: [3, 4] } },
      data: { tombstonedAt: new Date() },
    });

    const liveMax = await db.goldenItem.aggregate({
      where: { goldenSetId: goldenSet.id, tombstonedAt: null },
      _max: { index: true },
    });
    expect(liveMax._max.index).toBe(2); // live-max + 1 = 3, which is TAKEN

    const next = await nextGoldenItemIndex(db, goldenSet.id);
    expect(next).toBe(5);

    // And the rule actually holds against the constraint.
    const sample = await db.datasetSample.findFirstOrThrow({
      where: { dataset: { goldenSets: { some: { id: goldenSet.id } } } },
    });
    const appended = await db.goldenItem.create({
      data: {
        goldenSetId: goldenSet.id,
        index: next,
        inputText: 'appended after two tombstones',
        protocol: 'pairwise',
        sourceDatasetSampleId: sample.id,
      },
    });
    expect(appended.index).toBe(5);
  });
});
