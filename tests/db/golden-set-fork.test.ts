import { describe, it, expect, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';
import { db, truncateAll, mkUser } from './helpers';
import { forkGoldenSet, ForkGoldenSetInput } from '@/lib/golden-set-versions';

// ─── A0 Task 4: golden-set forking ─────────────────────────────────────────
//
// Mirrors tests/db/dataset-version-race.test.ts (which covers the identical
// max-version-read + create race for Dataset), tested directly against the
// extracted lib function rather than through the route, per the precedent
// tests/db/rubric-version-race.test.ts and dataset-version-race.test.ts set.
//
// What is specific to golden sets: the copy is two levels deep (items ->
// candidates), and GoldenLabel rows ride along with their item. Labels are
// copied UNCONDITIONALLY here because forkGoldenSet applies no edits — the
// drop-on-edited-item half of decision #5 belongs to PATCH
// /api/golden-sets/[id]/items, which is the only caller that can observe an
// edit.

let datasetCounter = 0;

async function mkDatasetWithSamples(userId: string, count: number) {
  datasetCounter += 1;
  return db.dataset.create({
    data: {
      name: `fixture-golden-dataset-${datasetCounter}`,
      slug: `fixture-golden-dataset-${datasetCounter}`,
      userId,
      visibility: 'public',
      inputType: 'query-response',
      samples: {
        create: Array.from({ length: count }, (_, i) => ({
          index: i,
          input: `question-${i}`,
          expected: 'A>B',
          metadata: JSON.stringify({ response_A: `answer-a-${i}`, response_B: `answer-b-${i}` }),
        })),
      },
    },
    include: { samples: { orderBy: { index: 'asc' } } },
  });
}

let goldenSetCounter = 0;

async function mkGoldenSet(ownerId: string, datasetId: string, sampleIds: string[]) {
  goldenSetCounter += 1;
  return db.goldenSet.create({
    data: {
      name: `fixture-golden-set-${goldenSetCounter}`,
      slug: `fixture-golden-set-${goldenSetCounter}`,
      ownerId,
      datasetId,
      protocol: 'pairwise',
      items: {
        create: sampleIds.map((sampleId, i) => ({
          index: i,
          inputText: `question-${i}`,
          protocol: 'pairwise' as const,
          expected: 'A>B',
          sourceDatasetSampleId: sampleId,
          candidates: {
            create: [
              { position: 0, responseText: `answer-a-${i}`, label: 'A' },
              { position: 1, responseText: `answer-b-${i}`, label: 'B' },
            ],
          },
        })),
      },
    },
    include: { items: { orderBy: { index: 'asc' } } },
  });
}

const forkInput = (
  rootGoldenSetId: string,
  sourceGoldenSetId: string,
  ownerId: string,
  overrides: Partial<ForkGoldenSetInput> = {}
): ForkGoldenSetInput => ({
  rootGoldenSetId,
  sourceGoldenSetId,
  ownerId,
  name: 'forked golden set',
  description: null,
  ...overrides,
});

describe('forkGoldenSet: versioning, lineage and deep copy', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it('forking the root lands on version 2, parented at the root, inheriting datasetId and protocol', async () => {
    const owner = await mkUser();
    const dataset = await mkDatasetWithSamples(owner.id, 2);
    const root = await mkGoldenSet(
      owner.id,
      dataset.id,
      dataset.samples.map((s) => s.id)
    );

    const v2 = await forkGoldenSet(db, forkInput(root.id, root.id, owner.id));

    expect(v2.id).not.toBe(root.id);
    expect(v2.version).toBe(2);
    expect(v2.parentId).toBe(root.id);
    expect(v2.datasetId).toBe(dataset.id);
    expect(v2.protocol).toBe('pairwise');
    expect(v2.ownerId).toBe(owner.id);
    expect(v2.name).toBe('forked golden set');
    // A fork is owned by the forking user, so it never inherits the source's
    // public visibility — publishing stays a deliberate act.
    expect(v2.visibility).toBe('private');
    expect(v2.publishedAt).toBeNull();
    expect(v2.slug).toBe('forked-golden-set-v2');
  });

  it('forking a v2 parents the v3 at the ROOT, not at the set it was forked from', async () => {
    const owner = await mkUser();
    const dataset = await mkDatasetWithSamples(owner.id, 2);
    const root = await mkGoldenSet(
      owner.id,
      dataset.id,
      dataset.samples.map((s) => s.id)
    );

    const v2 = await forkGoldenSet(db, forkInput(root.id, root.id, owner.id));
    // The route computes rootGoldenSetId as `existing.parentId ?? existing.id`
    // — forking v2 therefore passes the ROOT as parent and v2 as source.
    const v3 = await forkGoldenSet(db, forkInput(root.id, v2.id, owner.id, { name: 'third cut' }));

    expect(v3.version).toBe(3);
    expect(v3.parentId).toBe(root.id);
    expect(v3.parentId).not.toBe(v2.id);
    expect(v3.slug).toBe('third-cut-v3');

    const family = await db.goldenSet.findMany({
      where: { OR: [{ id: root.id }, { parentId: root.id }] },
      orderBy: { version: 'asc' },
    });
    expect(family.map((g) => g.version)).toEqual([1, 2, 3]);
  });

  it('items are copied with fresh ids, preserving index, content and source provenance', async () => {
    const owner = await mkUser();
    const dataset = await mkDatasetWithSamples(owner.id, 3);
    const root = await mkGoldenSet(
      owner.id,
      dataset.id,
      dataset.samples.map((s) => s.id)
    );

    const v2 = await forkGoldenSet(db, forkInput(root.id, root.id, owner.id));

    expect(v2._count.items).toBe(3);
    expect(v2.items.map((i) => i.index)).toEqual([0, 1, 2]);
    expect(v2.items.map((i) => i.inputText)).toEqual(['question-0', 'question-1', 'question-2']);
    expect(v2.items.map((i) => i.expected)).toEqual(['A>B', 'A>B', 'A>B']);
    expect(v2.items.map((i) => i.protocol)).toEqual(['pairwise', 'pairwise', 'pairwise']);
    // Provenance survives the fork: every copied item still points at the
    // DatasetSample it was imported from (that FK is `Restrict`).
    expect(v2.items.map((i) => i.sourceDatasetSampleId)).toEqual(
      dataset.samples.map((s) => s.id)
    );
    // Fresh rows, not re-parented originals.
    const rootItemIds = new Set(root.items.map((i) => i.id));
    for (const item of v2.items) {
      expect(rootItemIds.has(item.id)).toBe(false);
      expect(item.goldenSetId).toBe(v2.id);
    }
    // The source keeps all of its items.
    expect(await db.goldenItem.count({ where: { goldenSetId: root.id } })).toBe(3);
  });

  it('candidates are deep-copied under each forked item with fresh ids and stable positions', async () => {
    const owner = await mkUser();
    const dataset = await mkDatasetWithSamples(owner.id, 2);
    const root = await mkGoldenSet(
      owner.id,
      dataset.id,
      dataset.samples.map((s) => s.id)
    );

    const v2 = await forkGoldenSet(db, forkInput(root.id, root.id, owner.id));

    expect(v2.items).toHaveLength(2);
    for (const [i, item] of v2.items.entries()) {
      expect(item.candidates.map((c) => c.position)).toEqual([0, 1]);
      expect(item.candidates.map((c) => c.responseText)).toEqual([
        `answer-a-${i}`,
        `answer-b-${i}`,
      ]);
      expect(item.candidates.map((c) => c.label)).toEqual(['A', 'B']);
      for (const candidate of item.candidates) {
        expect(candidate.goldenItemId).toBe(item.id);
      }
    }

    // Source candidates are untouched — the fork added rows, it did not move
    // them. 2 items x 2 candidates on each side.
    const rootCandidates = await db.goldenCandidate.count({
      where: { goldenItem: { goldenSetId: root.id } },
    });
    const forkCandidates = await db.goldenCandidate.count({
      where: { goldenItem: { goldenSetId: v2.id } },
    });
    expect(rootCandidates).toBe(4);
    expect(forkCandidates).toBe(4);
  });

  it('labels are copied onto the forked items, preserving annotator, score, criteriaScores and reasoning', async () => {
    const owner = await mkUser();
    const annotatorA = await mkUser();
    const annotatorB = await mkUser();
    const dataset = await mkDatasetWithSamples(owner.id, 2);
    const root = await mkGoldenSet(
      owner.id,
      dataset.id,
      dataset.samples.map((s) => s.id)
    );
    const [item0, item1] = root.items;

    await db.goldenLabel.create({
      data: {
        goldenItemId: item0.id,
        annotatorId: annotatorA.id,
        overallScore: 8.5,
        criteriaScores: { accuracy: 9, tone: 8 },
        reasoning: 'A is more accurate',
      },
    });
    await db.goldenLabel.create({
      data: {
        goldenItemId: item0.id,
        annotatorId: annotatorB.id,
        overallScore: 6,
        criteriaScores: Prisma.DbNull,
        reasoning: null,
      },
    });
    // annotatorId is nullable (`onDelete: SetNull` — a label survives its
    // annotator's account deletion). That null must survive the fork too,
    // rather than being silently re-attributed to the forking user.
    await db.goldenLabel.create({
      data: { goldenItemId: item1.id, annotatorId: null, overallScore: 3 },
    });

    const v2 = await forkGoldenSet(db, forkInput(root.id, root.id, owner.id));

    const forkedLabels = await db.goldenLabel.findMany({
      where: { goldenItem: { goldenSetId: v2.id } },
      orderBy: [{ goldenItem: { index: 'asc' } }, { overallScore: 'desc' }],
      include: { goldenItem: { select: { index: true } } },
    });
    expect(forkedLabels).toHaveLength(3);

    expect(forkedLabels[0].goldenItem.index).toBe(0);
    expect(forkedLabels[0].annotatorId).toBe(annotatorA.id);
    expect(forkedLabels[0].overallScore).toBe(8.5);
    expect(forkedLabels[0].criteriaScores).toEqual({ accuracy: 9, tone: 8 });
    expect(forkedLabels[0].reasoning).toBe('A is more accurate');

    expect(forkedLabels[1].goldenItem.index).toBe(0);
    expect(forkedLabels[1].annotatorId).toBe(annotatorB.id);
    expect(forkedLabels[1].overallScore).toBe(6);
    expect(forkedLabels[1].criteriaScores).toBeNull();
    expect(forkedLabels[1].reasoning).toBeNull();

    expect(forkedLabels[2].goldenItem.index).toBe(1);
    expect(forkedLabels[2].annotatorId).toBeNull();
    expect(forkedLabels[2].overallScore).toBe(3);

    // The source keeps its own labels — a fork copies, it does not move.
    const rootLabels = await db.goldenLabel.count({
      where: { goldenItem: { goldenSetId: root.id } },
    });
    expect(rootLabels).toBe(3);
  });
});
