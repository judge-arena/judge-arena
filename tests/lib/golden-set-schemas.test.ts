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

  it('createGoldenSetSchema rejects an unknown protocol', () => {
    expect(() =>
      createGoldenSetSchema.parse({ datasetId: 'd1', protocol: 'setwise', name: 'X' })
    ).toThrow();
  });

  it('updateGoldenSetSchema parses an empty body (the access-matrix PATCH probe) and carries the frozen content fields so the route can guard them', () => {
    expect(updateGoldenSetSchema.parse({})).toEqual({});
    const withContent = updateGoldenSetSchema.parse({ datasetId: 'd2', protocol: 'listwise' });
    expect(withContent.datasetId).toBe('d2');
    expect(withContent.protocol).toBe('listwise');
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

  it('every include that feeds toPublicGoldenSet carries owner{id,name} and _count.items', () => {
    expect(goldenSetInclude.owner).toEqual({ select: { id: true, name: true } });
    expect(goldenSetInclude._count).toEqual({ select: { items: true } });
    expect(goldenSetDetailInclude.owner).toEqual({ select: { id: true, name: true } });
    expect(goldenSetDetailInclude._count).toEqual({ select: { items: true } });
    expect(goldenSetDetailInclude.items).toEqual({
      orderBy: { index: 'asc' },
      include: { candidates: { orderBy: { position: 'asc' } } },
    });
  });
});
