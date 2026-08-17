import { describe, it, expect, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import {
  liveDatasetsOnly,
  liveSamplesOnly,
  nextSampleIndex,
  restoreSample,
  tombstoneDataset,
  tombstoneSample,
  tombstoneSamples,
} from '@/lib/tombstones';

// Pure-shape unit tests — no DB (vitest.config.ts includes `tests/**/*.test.ts`
// and excludes `tests/db/**`). Deliberately mirrors the RETURNED-fragment
// assertions in tests/lib/golden-sets.test.ts:388-426, not the argument-capture
// style at :245-277: these are functions that return a `where` fragment, so the
// fragment itself is the unit and it is pinned verbatim.
//
// WHY THE SHAPE AND NOT THE BEHAVIOUR. The spec names a shape that passes
// vacuously (Testing, shape 2): every DB fixture in this branch tombstones a
// row with `isTombstone: true`, so a filter written as the simpler
// `{ tombstone: { is: null } }` satisfies ALL of them. Only the UN-DELETED arm
// distinguishes the two formulations, and the exact-object assertion below is
// what makes the difference visible without a database. The behavioural half —
// a restored sample is visible again — lives in tests/db/dataset-sample-
// tombstone.test.ts against a real `isTombstone: false` row.

describe('liveSamplesOnly', () => {
  it('returns the NOT formulation on both the sample and its parent dataset', () => {
    // Two clauses, because a sample inherits its parent dataset's hidden state
    // (design decision 16). A one-clause filter leaves every sample of a
    // tombstoned dataset readable while the dataset itself has vanished.
    expect(liveSamplesOnly()).toEqual({
      NOT: { tombstone: { is: { isTombstone: true } } },
      dataset: { NOT: { tombstone: { is: { isTombstone: true } } } },
    });

    // `toEqual` treats an `undefined`-valued key as absent, so it cannot see a
    // stray key sneaking in. Pin the key set separately.
    expect(Object.keys(liveSamplesOnly()).sort()).toEqual(['NOT', 'dataset']);
  });

  it('uses NOT rather than OR, on purpose, at both levels', () => {
    // The obvious spelling is
    //   { OR: [{ tombstone: { is: null } }, { tombstone: { isTombstone: false } }] }
    // and it is wrong for a structural reason nothing else would catch: an
    // object literal cannot carry two `OR` keys, and FOUR dataset read sites
    // already build their own (datasets/route.ts, stats/route.ts,
    // datasets/[id]/versions/route.ts, dataset-versions.ts — grep `OR:` in
    // each; the line numbers this comment used to carry all went stale on this
    // branch). Spreading
    // an OR into those clobbers one clause or the other with no type error and
    // no test failure — which is exactly why it needs a test here.
    const where = liveSamplesOnly();
    expect(where).not.toHaveProperty('OR');
    expect(JSON.stringify(where)).not.toContain('"OR"');
  });

  it('returns a fresh object per call, so a caller cannot poison the next one', () => {
    // Every read site spreads this into a `where` it then mutates
    // (datasets/route.ts:63 builds `const where: any = {}` and assigns into
    // it). A shared frozen constant would be a cross-request bug with no
    // reproduction; a module-level `const` returned by reference is the exact
    // shape that fails here.
    expect(liveSamplesOnly()).not.toBe(liveSamplesOnly());
    expect(liveSamplesOnly().dataset).not.toBe(liveSamplesOnly().dataset);
  });
});

describe('liveDatasetsOnly', () => {
  it('returns the single NOT clause', () => {
    expect(liveDatasetsOnly()).toEqual({
      NOT: { tombstone: { is: { isTombstone: true } } },
    });
    expect(Object.keys(liveDatasetsOnly())).toEqual(['NOT']);
    expect(liveDatasetsOnly()).not.toHaveProperty('OR');
  });

  it('returns a fresh object per call', () => {
    expect(liveDatasetsOnly()).not.toBe(liveDatasetsOnly());
  });
});

describe('neither filter touches A0’s column form', () => {
  it('mentions no tombstonedAt, retiredAt or publishedAt anywhere', () => {
    // A0's `tombstonedAt` columns on GoldenSet/GoldenItem/GoldenLabel are a
    // DIFFERENT mechanism with a different capability: goldenSetLifecycleWhere
    // pins `tombstonedAt: null` in both arms precisely so there is no way
    // back, while this overlay is reversible. The design says in as many words
    // that the two must not be harmonised, so a filter that started reaching
    // for a lifecycle column would be a silent merge of the two. Neither model
    // this filter targets even HAS those columns, so the leak would surface as
    // a Prisma validation error at runtime, in whichever route drew it first.
    for (const where of [liveSamplesOnly(), liveDatasetsOnly()]) {
      const json = JSON.stringify(where);
      expect(json).not.toContain('tombstonedAt');
      expect(json).not.toContain('retiredAt');
      expect(json).not.toContain('publishedAt');
    }
  });
});

/**
 * Argument capture on a stubbed transaction client — the writers have no
 * return value worth asserting, so the payload IS the unit.
 *
 * TWO DELIBERATE OMISSIONS FROM THE STUB, both load-bearing:
 *   - `datasetSample` exposes `aggregate` and NOT `count`. A `nextSampleIndex`
 *     written as a count would fail here with a TypeError rather than quietly
 *     passing on a fixture where count happens to equal max+1.
 *   - `tombstone` exposes `update` even though nothing should call it, so
 *     `restoreSample` using `update` (which throws P2025 on a missing row)
 *     instead of `updateMany` is visible as a call, not as an absence.
 */
function stubTx() {
  const upsert = vi.fn().mockResolvedValue({});
  const update = vi.fn().mockResolvedValue({});
  const updateMany = vi.fn().mockResolvedValue({ count: 0 });
  const createMany = vi.fn().mockResolvedValue({ count: 0 });
  const aggregate = vi.fn().mockResolvedValue({ _max: { index: null } });
  const tx = {
    tombstone: { upsert, update, updateMany, createMany },
    datasetSample: { aggregate },
  } as unknown as Prisma.TransactionClient;
  return { tx, upsert, update, updateMany, createMany, aggregate };
}

describe('tombstoneSample', () => {
  it('upserts with a NON-EMPTY update arm', async () => {
    const { tx, upsert } = stubTx();
    await tombstoneSample(tx, 'smp-1', 'bad row');

    expect(upsert).toHaveBeenCalledWith({
      where: { datasetSampleId: 'smp-1' },
      create: { datasetSampleId: 'smp-1', isTombstone: true, reason: 'bad row' },
      update: { isTombstone: true, reason: 'bad row' },
    });

    // THE POINT OF THIS TEST. An empty `update: {}` arm still satisfies "never
    // P2002" and reads as a harmless idempotency guard, but it makes
    // delete -> un-delete -> delete leave the row VISIBLE: the second delete
    // finds the restored row, writes nothing, and returns 200. The property is
    // not "idempotent no-op", it is: never P2002, always converges on hidden.
    // It writes every time.
    expect(Object.keys(upsert.mock.calls[0][0].update).length).toBeGreaterThan(0);
    expect(upsert.mock.calls[0][0].update.isTombstone).toBe(true);
  });

  it('normalises a missing reason to null rather than leaving it undefined', async () => {
    const { tx, upsert } = stubTx();
    await tombstoneSample(tx, 'smp-1');

    const { update } = upsert.mock.calls[0][0];
    // `toEqual` treats undefined and absent as equal, so it CANNOT see this
    // bug — assert the key set and the null explicitly. `reason: undefined` in
    // a Prisma update means "leave the column alone", so a reasonless
    // re-delete would silently inherit the previous delete's reason and the
    // row would claim a justification nobody gave it.
    expect(Object.keys(update).sort()).toEqual(['isTombstone', 'reason']);
    expect(update.reason).toBeNull();
    expect(upsert.mock.calls[0][0].create.reason).toBeNull();
  });
});

describe('tombstoneSamples', () => {
  it('dedupes, updates the existing rows, creates the rest, and returns the total', async () => {
    const { tx, updateMany, createMany } = stubTx();
    updateMany.mockResolvedValue({ count: 1 });
    createMany.mockResolvedValue({ count: 2 });

    // 'b' twice on purpose: PUT bulk-replace and the config importer both
    // build this list from a document, and a duplicated id must not double
    // count nor collide inside the INSERT.
    expect(await tombstoneSamples(tx, ['a', 'b', 'c', 'b'], 'bulk-replace')).toBe(3);

    expect(updateMany).toHaveBeenCalledWith({
      where: { datasetSampleId: { in: ['a', 'b', 'c'] } },
      data: { isTombstone: true, reason: 'bulk-replace' },
    });
    expect(createMany).toHaveBeenCalledWith({
      data: [
        { datasetSampleId: 'a', isTombstone: true, reason: 'bulk-replace' },
        { datasetSampleId: 'b', isTombstone: true, reason: 'bulk-replace' },
        { datasetSampleId: 'c', isTombstone: true, reason: 'bulk-replace' },
      ],
      skipDuplicates: true,
    });

    // Without skipDuplicates a re-delete of an already-hidden batch raises
    // P2002 on Tombstone_datasetSampleId_key — the exact failure the whole
    // "never P2002, always converges on hidden" property denies. Pinned
    // separately from the toHaveBeenCalledWith above so it cannot be lost in
    // a payload reshuffle.
    expect(createMany.mock.calls[0][0].skipDuplicates).toBe(true);
  });

  it('issues no statement at all for an empty list', async () => {
    const { tx, updateMany, createMany } = stubTx();
    expect(await tombstoneSamples(tx, [])).toBe(0);
    expect(updateMany).not.toHaveBeenCalled();
    expect(createMany).not.toHaveBeenCalled();
  });

  it('normalises a missing reason to null in BOTH statements', async () => {
    const { tx, updateMany, createMany } = stubTx();
    await tombstoneSamples(tx, ['a']);

    // THE PATH THE NEXT-BUT-ONE TASK WALKS DOWN. Task 11 may call this
    // without a reason, and the reason-bearing test above cannot see the
    // fallback at all — delete `?? null` from either statement and it stays
    // green. `reason: undefined` in the updateMany's `data` means "leave the
    // column alone", so a reasonless bulk re-delete would silently inherit
    // whatever justification an earlier delete gave, on rows nobody named.
    // Asserted with toBeNull() rather than by key presence for the same
    // reason as tombstoneSample's case: toEqual cannot tell undefined from
    // null, so only the strict assertion discriminates.
    expect(updateMany.mock.calls[0][0].data.reason).toBeNull();
    expect(createMany.mock.calls[0][0].data[0].reason).toBeNull();
  });
});

describe('tombstoneDataset', () => {
  it('upserts on datasetId and never mentions datasetSampleId', async () => {
    const { tx, upsert } = stubTx();
    await tombstoneDataset(tx, 'ds-1', 'owner deleted');

    expect(upsert).toHaveBeenCalledWith({
      where: { datasetId: 'ds-1' },
      create: { datasetId: 'ds-1', isTombstone: true, reason: 'owner deleted' },
      update: { isTombstone: true, reason: 'owner deleted' },
    });

    // Setting both FKs makes num_nonnulls = 2 and the row is refused by
    // Tombstone_exactly_one_entity — a 500 out of DELETE /api/datasets/[id],
    // not a validation error the client could explain.
    expect(JSON.stringify(upsert.mock.calls[0][0])).not.toContain('datasetSampleId');
  });

  it('normalises a missing reason to null in both arms', async () => {
    const { tx, upsert } = stubTx();
    await tombstoneDataset(tx, 'ds-1');

    // Same gap as tombstoneSamples above: the reason-bearing test cannot see
    // the `?? null` fallback, so deleting it leaves the suite green. The
    // update arm is the one that bites — `reason: undefined` there means
    // "leave the column alone", so re-deleting a dataset with no reason would
    // leave an earlier delete's justification standing on the row.
    expect(upsert.mock.calls[0][0].create.reason).toBeNull();
    expect(upsert.mock.calls[0][0].update.reason).toBeNull();
  });
});

describe('restoreSample', () => {
  it('flips the flag and clears the reason through updateMany, not update', async () => {
    const { tx, update, updateMany } = stubTx();
    await restoreSample(tx, 'smp-1');

    // `update` on a sample that was never hidden raises P2025 — restoring a
    // live row must be a clean no-op, not a 500.
    expect(update).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenCalledWith({
      where: { datasetSampleId: 'smp-1' },
      data: { isTombstone: false, reason: null },
    });

    // Explicit null, not undefined: a stale "removed as a duplicate" left on a
    // row that is live again is a lie the audit trail cannot detect.
    expect(updateMany.mock.calls[0][0].data.reason).toBeNull();
  });
});

describe('nextSampleIndex', () => {
  it('is max(index) + 1 over ALL rows, hidden included', async () => {
    const { tx, aggregate } = stubTx();
    aggregate.mockResolvedValue({ _max: { index: 7 } });

    expect(await nextSampleIndex(tx, 'ds-1')).toBe(8);
    expect(aggregate).toHaveBeenCalledWith({
      where: { datasetId: 'ds-1' },
      _max: { index: true },
    });

    // THE LOAD-BEARING HALF. Filter this read to live rows and the fixture
    // that breaks is a tombstoned TAIL: samples 0..4 with 4 hidden gives a
    // live-max of 3, so the next insert lands on 4 — occupied — and P2002s on
    // @@unique([datasetId, index]). count() has the mirror-image bug: hide
    // sample 0 of 3 and the count is 2 while index 2 is taken. Both are
    // invisible on a tombstone-free corpus, where count, live-max+1 and
    // all-max+1 all agree.
    const arg = JSON.stringify(aggregate.mock.calls[0][0]);
    expect(arg).not.toContain('tombstone');
    expect(arg).not.toContain('NOT');
  });

  it('starts an empty dataset at 0', async () => {
    const { tx, aggregate } = stubTx();
    aggregate.mockResolvedValue({ _max: { index: null } });
    expect(await nextSampleIndex(tx, 'ds-empty')).toBe(0);
  });
});
