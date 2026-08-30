import { describe, expect, it } from 'vitest';
import {
  buildImportSelection,
  resolveCount,
  type SubsetSpec,
} from '@/lib/sample-selection';

/** A deterministic stand-in for Math.random: cycles a fixed sequence in [0,1). */
function seededRng(seq: number[]): () => number {
  let i = 0;
  return () => seq[i++ % seq.length];
}

const indices = (n: number) => Array.from({ length: n }, (_, i) => i);

describe('resolveCount — how many items a spec asks for', () => {
  it('a count is taken literally', () => {
    expect(resolveCount({ kind: 'random-count', count: 30 }, 620)).toBe(30);
  });

  it('a percent is of the AVAILABLE rows, rounded', () => {
    expect(resolveCount({ kind: 'random-percent', percent: 10 }, 620)).toBe(62);
    expect(resolveCount({ kind: 'random-percent', percent: 50 }, 31)).toBe(16); // 15.5 rounds up
  });

  it('clamps to what actually exists — asking for more than the dataset holds is not an error', () => {
    // The alternative is a 400 the user cannot act on: they asked for "200
    // items" of a 30-row dataset, and 30 is unambiguously what they meant.
    expect(resolveCount({ kind: 'random-count', count: 200 }, 30)).toBe(30);
    expect(resolveCount({ kind: 'random-percent', percent: 150 }, 30)).toBe(30);
  });

  it('never resolves to 0 when something was asked for and rows exist', () => {
    // 1% of 30 is 0.3, which rounds to 0 — and a golden set with no items is
    // not what anybody meant by "1%". The floor is 1.
    expect(resolveCount({ kind: 'random-percent', percent: 1 }, 30)).toBe(1);
    expect(resolveCount({ kind: 'random-count', count: 0 }, 30)).toBe(1);
    expect(resolveCount({ kind: 'random-count', count: -5 }, 30)).toBe(1);
  });

  it('resolves to 0 only when there is genuinely nothing to select', () => {
    expect(resolveCount({ kind: 'random-count', count: 10 }, 0)).toBe(0);
  });
});

describe('buildImportSelection — what actually goes on the wire', () => {
  it('ALL sends neither limit nor sampleIndices', () => {
    // The API refuses both together, and "everything" is the absence of both.
    expect(buildImportSelection({ kind: 'all' }, indices(620))).toEqual({});
  });

  it('FIRST N sends limit, never sampleIndices — the server does the slicing', () => {
    expect(buildImportSelection({ kind: 'first', count: 30 }, indices(620))).toEqual({ limit: 30 });
  });

  it('RANDOM N sends exactly N DISTINCT indices, all real', () => {
    const available = indices(620);
    const out = buildImportSelection({ kind: 'random-count', count: 30 }, available, Math.random);
    const picked = out.sampleIndices!;
    expect(picked).toHaveLength(30);
    expect(new Set(picked).size).toBe(30);        // distinct — the API refines on this
    expect(picked.every((i) => available.includes(i))).toBe(true);
    expect(out.limit).toBeUndefined();            // never both
  });

  it('RANDOM PERCENT resolves against the available rows', () => {
    const out = buildImportSelection({ kind: 'random-percent', percent: 10 }, indices(620), Math.random);
    expect(out.sampleIndices).toHaveLength(62);
  });

  it('picks from the ACTUAL indices, not from 0..n-1 — a sparse dataset is the case that breaks', () => {
    // Tombstoned samples leave gaps: a dataset can hold indices 0,5,9,40 and
    // nothing else. Generating random numbers in [0, count) would produce
    // indices that do not exist, and the importer would silently import fewer
    // items than asked for — or none.
    const sparse = [0, 5, 9, 40, 77, 101];
    const out = buildImportSelection({ kind: 'random-count', count: 4 }, sparse, Math.random);
    expect(out.sampleIndices).toHaveLength(4);
    expect(out.sampleIndices!.every((i) => sparse.includes(i))).toBe(true);
  });

  it('returns indices in ASCENDING order, so the request is stable and readable', () => {
    const out = buildImportSelection({ kind: 'random-count', count: 20 }, indices(200), Math.random);
    const picked = out.sampleIndices!;
    expect([...picked].sort((a, b) => a - b)).toEqual(picked);
  });

  it('is genuinely RANDOM, not a prefix or a stride', () => {
    // The failure this catches is an implementation that "randomises" by
    // taking the first N, or every k-th row. Both look shuffled in a small
    // sample and are systematically biased on an ordered corpus — which
    // JudgeBench is, being grouped by source.
    const available = indices(620);
    const runs = Array.from({ length: 12 }, () =>
      buildImportSelection({ kind: 'random-count', count: 30 }, available, Math.random).sampleIndices!
    );
    const asKeys = new Set(runs.map((r) => r.join(',')));
    expect(asKeys.size).toBeGreaterThan(1);                      // not deterministic
    expect(runs.some((r) => r.join(',') !== indices(30).join(','))).toBe(true); // not the prefix
    // and the union across runs should cover well beyond the first 30 rows
    const union = new Set(runs.flat());
    expect(Math.max(...union)).toBeGreaterThan(100);
  });

  it('uses the INJECTED rng, so selection is reproducible when it needs to be', () => {
    const available = indices(100);
    const a = buildImportSelection({ kind: 'random-count', count: 5 }, available, seededRng([0.1, 0.9, 0.4, 0.7, 0.2]));
    const b = buildImportSelection({ kind: 'random-count', count: 5 }, available, seededRng([0.1, 0.9, 0.4, 0.7, 0.2]));
    expect(a.sampleIndices).toEqual(b.sampleIndices);
  });

  it('asking for everything at random degenerates to everything, without duplicating', () => {
    const available = indices(15);
    const out = buildImportSelection({ kind: 'random-count', count: 15 }, available, Math.random);
    expect([...out.sampleIndices!].sort((a, b) => a - b)).toEqual(available);
  });

  it('an empty dataset yields no indices rather than an empty-array request', () => {
    // `sampleIndices: []` fails the API's .min(1); {} means "import all", which
    // of an empty dataset is also nothing. The latter is the honest request.
    expect(buildImportSelection({ kind: 'random-count', count: 10 }, [])).toEqual({});
  });
});

describe('the spec type covers exactly the four modes the UI offers', () => {
  it('every kind builds something the API accepts', () => {
    const specs: SubsetSpec[] = [
      { kind: 'all' },
      { kind: 'first', count: 10 },
      { kind: 'random-count', count: 10 },
      { kind: 'random-percent', percent: 25 },
    ];
    for (const spec of specs) {
      const out = buildImportSelection(spec, indices(100), Math.random);
      // Never both — the API's refine rejects that pair outright.
      expect(out.limit !== undefined && out.sampleIndices !== undefined).toBe(false);
      if (out.sampleIndices) expect(out.sampleIndices.length).toBeGreaterThan(0);
    }
  });
});
