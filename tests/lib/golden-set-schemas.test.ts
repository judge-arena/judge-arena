import { describe, it, expect } from 'vitest';
import {
  createGoldenSetSchema,
  updateGoldenSetSchema,
  updateGoldenItemsSchema,
  deleteGoldenItemsSchema,
  forkGoldenSetSchema,
  retireGoldenSetSchema,
  goldenSetInclude,
  goldenSetDetailInclude,
} from '@/app/api/golden-sets/shared';

describe('golden-set route schemas', () => {
  it('createGoldenSetSchema accepts the documented body and defaults sampleIndices to undefined (= import every sample)', () => {
    const parsed = createGoldenSetSchema.parse({
      datasetId: 'judgebench-v1',
      protocol: 'pairwise',
      name: 'JudgeBench pairwise',
    });
    expect(parsed.datasetId).toBe('judgebench-v1');
    expect(parsed.protocol).toBe('pairwise');
    expect(parsed.sampleIndices).toBeUndefined();
    expect(parsed.description).toBeUndefined();
  });

  it('createGoldenSetSchema accepts an explicit sampleIndices subset, preserving the caller order', () => {
    const parsed = createGoldenSetSchema.parse({
      datasetId: 'd1',
      protocol: 'pointwise',
      name: 'Subset',
      sampleIndices: [5, 3, 0],
    });
    expect(parsed.sampleIndices).toEqual([5, 3, 0]);
  });

  it('createGoldenSetSchema rejects duplicate sampleIndices — two golden items from one sample is never what the caller meant', () => {
    expect(() =>
      createGoldenSetSchema.parse({
        datasetId: 'd1',
        protocol: 'pointwise',
        name: 'Dupes',
        sampleIndices: [1, 1],
      })
    ).toThrow();
  });

  it('createGoldenSetSchema refuses sampleIndices and limit together — two different selections, not a precedence rule', () => {
    expect(() =>
      createGoldenSetSchema.parse({
        datasetId: 'd1',
        protocol: 'pairwise',
        name: 'Both',
        sampleIndices: [0, 1],
        limit: 5,
      })
    // Message widened when randomCount/randomPercent joined the mutually
    // exclusive group: 'not both' became 'at most one of', because four
    // fields now answer the same question. Matched on the stable half.
    ).toThrow(/at most one of/);

    // Each ALONE still parses. A refusal that rejected both would satisfy the
    // assertion above while deleting the feature.
    expect(
      createGoldenSetSchema.parse({ datasetId: 'd1', protocol: 'pairwise', name: 'L', limit: 5 }).limit
    ).toBe(5);
    expect(
      createGoldenSetSchema.parse({ datasetId: 'd1', protocol: 'pairwise', name: 'S', sampleIndices: [3] })
        .sampleIndices
    ).toEqual([3]);
    // And omitting both is still "every live sample".
    expect(
      createGoldenSetSchema.parse({ datasetId: 'd1', protocol: 'pairwise', name: 'All' }).limit
    ).toBeUndefined();
  });

  it('createGoldenSetSchema rejects an unknown protocol', () => {
    expect(() =>
      createGoldenSetSchema.parse({ datasetId: 'd1', protocol: 'setwise', name: 'X' })
    ).toThrow();
  });

  it('updateGoldenSetSchema parses an empty body (the access-matrix PATCH probe), carries protocol so the route can freeze-guard it, and has NO datasetId key — an immutable field is not in the mutable shape', () => {
    expect(updateGoldenSetSchema.parse({})).toEqual({});
    const parsed = updateGoldenSetSchema.parse({ datasetId: 'd2', protocol: 'listwise' });
    expect(parsed.protocol).toBe('listwise');
    expect(parsed).toEqual({ protocol: 'listwise' });
    expect('datasetId' in parsed).toBe(false);
  });

  it('updateGoldenItemsSchema requires at least one item and an id per item', () => {
    expect(() => updateGoldenItemsSchema.parse({ items: [] })).toThrow();
    expect(() => updateGoldenItemsSchema.parse({ items: [{ expected: 'A>B' }] })).toThrow();
    const parsed = updateGoldenItemsSchema.parse({
      items: [{ id: 'gi1', expected: 'A>B' }, { id: 'gi2', expected: null }],
    });
    expect(parsed.items[1].expected).toBeNull();
  });

  it('deleteGoldenItemsSchema requires a non-empty itemIds array', () => {
    expect(() => deleteGoldenItemsSchema.parse({ itemIds: [] })).toThrow();
    expect(deleteGoldenItemsSchema.parse({ itemIds: ['gi1'] }).itemIds).toEqual(['gi1']);
  });

  it('forkGoldenSetSchema and retireGoldenSetSchema both parse an empty body', () => {
    expect(forkGoldenSetSchema.parse({})).toEqual({});
    expect(retireGoldenSetSchema.parse({})).toEqual({ retired: true });
    expect(retireGoldenSetSchema.parse({ retired: false })).toEqual({ retired: false });
  });

  it('every include that feeds toPublicGoldenSet carries owner{id,name} and a TOMBSTONE-FILTERED _count.items', () => {
    // A0, tombstone-not-delete ruling (2026-08-13): `_count.items` is a
    // FILTERED relation count. Unfiltered, `toPublicGoldenSet(g).itemCount`
    // over-reports on every list row — and that is the number a reader uses
    // to decide whether a set is worth calibrating against.
    expect(goldenSetInclude.owner).toEqual({ select: { id: true, name: true } });
    expect(goldenSetInclude._count).toEqual({
      select: { items: { where: { tombstonedAt: null } } },
    });
    expect(goldenSetDetailInclude.owner).toEqual({ select: { id: true, name: true } });
    expect(goldenSetDetailInclude._count).toEqual({
      select: { items: { where: { tombstonedAt: null } } },
    });
    expect(goldenSetDetailInclude.items).toEqual({
      where: { tombstonedAt: null },
      orderBy: { index: 'asc' },
      include: { candidates: { orderBy: { position: 'asc' } } },
    });
  });
});
