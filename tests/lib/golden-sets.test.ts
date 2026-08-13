import { describe, it, expect, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import {
  GoldenSetFrozenError,
  PLATFORM_OWNER_EMAIL,
  goldenItemLifecycleWhere,
  isGoldenSetFrozen,
  mapSampleToGoldenItem,
  parseIncludeTombstoned,
  type SourceSample,
} from '@/lib/golden-sets';
import { PLATFORM_USER_EMAIL } from '../../prisma/seed-core';
import { flattenJudgeBench } from '../../prisma/seed-judgebench';

// Pure-function unit tests — no DB (vitest.config.ts includes
// `tests/**/*.test.ts` and excludes `tests/db/**`). The mapping is pinned
// HERE rather than only in the DB import test for two reasons: src/lib/** is
// inside both coverage `include` sets and the aggregate floor has ~371
// uncovered lines of room total (vitest.config.ts:96-103), and the failure
// mode this guards against is silent — reusing the evaluations dataset
// mapping (src/app/api/evaluations/route.ts:538-546) maps every one of the
// 620 JudgeBench rows, errors on none, and yields `inputText: 'A>B'`.

/** Shaped exactly as prisma/seed-judgebench.ts:186-206 writes a DatasetSample. */
const SAMPLE: SourceSample = {
  id: 'sample-1',
  input: 'A college student sued his former roommate. Is the evidence admissible?',
  expected: 'A>B',
  metadata: JSON.stringify({
    split: 'gpt',
    pair_id: 'e302b0a0-28d5-5a3c-b1af-fedcf5543e72',
    original_id: 1420,
    source: 'mmlu-pro-law',
    response_model: 'gpt-4o-2024-05-13',
    response_A: 'Yes, reputation evidence is admissible here.',
    response_B: 'No, character evidence is barred here.',
  }),
};

describe('mapSampleToGoldenItem', () => {
  it('pointwise: one candidate (response_A) and NO ground truth', () => {
    expect(mapSampleToGoldenItem(SAMPLE, 'pointwise', 0)).toEqual({
      index: 0,
      inputText: SAMPLE.input,
      promptText: null,
      responseText: null,
      protocol: 'pointwise',
      // JudgeBench's label is a PREFERENCE between two responses, not a
      // score for one, so a pointwise import legitimately arrives
      // unlabelled and waits for A1's human scores.
      expected: null,
      sourceDatasetSampleId: 'sample-1',
      candidates: [
        {
          position: 0,
          promptText: null,
          responseText: 'Yes, reputation evidence is admissible here.',
          label: null,
        },
      ],
    });
  });

  it('pairwise: two candidates in A,B order and the preference label verbatim', () => {
    expect(mapSampleToGoldenItem(SAMPLE, 'pairwise', 3)).toEqual({
      index: 3,
      inputText: SAMPLE.input,
      promptText: null,
      responseText: null,
      protocol: 'pairwise',
      expected: 'A>B',
      sourceDatasetSampleId: 'sample-1',
      candidates: [
        {
          position: 0,
          promptText: null,
          responseText: 'Yes, reputation evidence is admissible here.',
          label: null,
        },
        {
          position: 1,
          promptText: null,
          responseText: 'No, character evidence is barred here.',
          label: null,
        },
      ],
    });
  });

  it('listwise: A>B becomes the ranking 0,1', () => {
    const item = mapSampleToGoldenItem(SAMPLE, 'listwise', 0);
    expect(item.expected).toBe('0,1');
    expect(item.candidates.map((c) => c.responseText)).toEqual([
      'Yes, reputation evidence is admissible here.',
      'No, character evidence is barred here.',
    ]);
  });

  it('listwise: B>A becomes the ranking 1,0 (candidate order does NOT change)', () => {
    const item = mapSampleToGoldenItem({ ...SAMPLE, expected: 'B>A' }, 'listwise', 0);
    expect(item.expected).toBe('1,0');
    expect(item.candidates.map((c) => c.responseText)).toEqual([
      'Yes, reputation evidence is admissible here.',
      'No, character evidence is barred here.',
    ]);
  });

  it('pairwise: an unlabelled sample passes through as expected: null', () => {
    expect(mapSampleToGoldenItem({ ...SAMPLE, expected: null }, 'pairwise', 0).expected).toBeNull();
  });

  it('index is the caller-assigned position in the SELECTION, echoed unchanged', () => {
    // POST /api/golden-sets assigns 0..n-1 over `sampleIndices`, so this
    // function must never derive an index from the sample itself.
    expect(mapSampleToGoldenItem(SAMPLE, 'pairwise', 41).index).toBe(41);
  });

  it('maps a real vendored JudgeBench row, guarding against seeder drift', () => {
    const row = flattenJudgeBench()[0];
    const sample: SourceSample = {
      id: 'db-sample-0',
      input: row.question,
      expected: row.label,
      // Byte-for-byte the object prisma/seed-judgebench.ts:195-203 stores.
      metadata: JSON.stringify({
        split: row.split,
        pair_id: row.pair_id,
        original_id: row.original_id,
        source: row.source,
        response_model: row.response_model,
        response_A: row.response_A,
        response_B: row.response_B,
      }),
    };

    const item = mapSampleToGoldenItem(sample, 'pairwise', 0);
    expect(item.inputText).toBe(row.question);
    expect(item.candidates.map((c) => c.responseText)).toEqual([row.response_A, row.response_B]);
    expect(item.expected).toBe(row.label);
    expect(['A>B', 'B>A']).toContain(row.label);
  });
});

describe('mapSampleToGoldenItem — a corrupt source row fails loudly', () => {
  // `JSON.parse(sample.metadata ?? '{}')` is the obvious thing to write and
  // the wrong one: it turns a row carrying no responses into a golden item
  // with empty candidate bodies and imports it. A golden set is ground
  // truth; a silently empty one is worse than an import that refused.

  it('throws, naming the sample, when metadata is null', () => {
    expect(() => mapSampleToGoldenItem({ ...SAMPLE, metadata: null }, 'pairwise', 0)).toThrow(
      /dataset sample sample-1 has no metadata/
    );
  });

  it('throws, naming the sample, when metadata is not valid JSON', () => {
    expect(() =>
      mapSampleToGoldenItem({ ...SAMPLE, metadata: '{"response_A": ' }, 'pairwise', 0)
    ).toThrow(/dataset sample sample-1 has metadata that is not valid JSON/);
  });

  it('throws when metadata parses to something that is not an object', () => {
    expect(() =>
      mapSampleToGoldenItem({ ...SAMPLE, metadata: '["response_A"]' }, 'pairwise', 0)
    ).toThrow(/dataset sample sample-1 has metadata that is not a JSON object/);
  });

  it('throws at POINTWISE too when response_B is missing, not just at pairwise', () => {
    // Uniform failure on purpose: the corpus shape is a pair, and a pointwise
    // import is a projection of that pair onto its A side. A row that imports
    // at one protocol and explodes at another is a corpus nobody can trust.
    const halfRow = JSON.stringify({ split: 'gpt', response_A: 'only A' });
    expect(() => mapSampleToGoldenItem({ ...SAMPLE, metadata: halfRow }, 'pointwise', 0)).toThrow(
      /dataset sample sample-1 is missing response_A\/response_B/
    );
  });

  it('listwise: throws on a preference label it has no ranking for', () => {
    // null passes through as null (an unlabelled corpus is legitimate); a
    // label present but untranslatable is not — silently nulling it drops
    // ground truth and hands A1 a set that merely looks unlabelled.
    expect(() =>
      mapSampleToGoldenItem({ ...SAMPLE, expected: 'A=B' }, 'listwise', 0)
    ).toThrow(/has expected "A=B", which has no listwise ranking/);
    expect(mapSampleToGoldenItem({ ...SAMPLE, expected: null }, 'listwise', 0).expected).toBeNull();
  });

  it('throws on a protocol outside the RunProtocol enum instead of guessing', () => {
    expect(() =>
      mapSampleToGoldenItem(SAMPLE, 'ranked' as unknown as Parameters<typeof mapSampleToGoldenItem>[1], 0)
    ).toThrow(/unsupported protocol/);
  });

  it('pairwise: throws on a garbage preference label (not A>B or B>A)', () => {
    expect(() =>
      mapSampleToGoldenItem({ ...SAMPLE, expected: 'A=B' }, 'pairwise', 0)
    ).toThrow(/dataset sample sample-1 has expected "A=B", which is not an allowed preference label/);
  });

  it('pairwise: null expected passes through without error', () => {
    const item = mapSampleToGoldenItem({ ...SAMPLE, expected: null }, 'pairwise', 0);
    expect(item.expected).toBeNull();
  });
});

/** A transaction client that answers exactly one question, so the predicate's
 *  shape can be asserted without a database (tests/db/golden-set-freeze.test.ts
 *  asserts it against the real FK). */
function stubTx(calibrationRunCount: number) {
  const count = vi.fn().mockResolvedValue(calibrationRunCount);
  return { tx: { calibrationRun: { count } } as unknown as Prisma.TransactionClient, count };
}

describe('isGoldenSetFrozen', () => {
  it('is false when no calibration run references the set', async () => {
    const { tx, count } = stubTx(0);

    expect(await isGoldenSetFrozen(tx, 'gs-1')).toBe(false);
    // The where clause is the whole predicate, and `finishedAt` is
    // deliberately absent from it: CalibrationRun has no status enum, only
    // startedAt/finishedAt, so "still running" and "crashed" are the same
    // state — excluding unfinished runs would let a crashed run's set drift
    // underneath the numbers it already produced.
    expect(count).toHaveBeenCalledWith({ where: { goldenSetId: 'gs-1' } });
  });

  it('is true as soon as one calibration run references the set', async () => {
    const { tx } = stubTx(1);
    expect(await isGoldenSetFrozen(tx, 'gs-1')).toBe(true);
  });
});

describe('GoldenSetFrozenError', () => {
  it('carries the golden set id, names itself, and points at the fork', () => {
    const error = new GoldenSetFrozenError('gs-1');

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('GoldenSetFrozenError');
    expect(error.goldenSetId).toBe('gs-1');
    expect(error.message).toContain('gs-1');
    expect(error.message).toMatch(/fork/i);
  });
});

describe('PLATFORM_OWNER_EMAIL', () => {
  it('is the seeder platform user verbatim', () => {
    // The importer resolves the only permitted source owner by this address;
    // prisma/seed-core.ts owns the value, and src/ must not import a seed
    // module at runtime, so the literal is duplicated and pinned here.
    expect(PLATFORM_OWNER_EMAIL).toBe(PLATFORM_USER_EMAIL);
  });
});

describe('goldenItemLifecycleWhere / parseIncludeTombstoned', () => {
  it('hides tombstoned items by default', () => {
    expect(goldenItemLifecycleWhere(false)).toEqual({ tombstonedAt: null });
  });

  it('returns an EMPTY predicate when tombstoned items are wanted, not a truthy filter', () => {
    // Spreading `{}` into a `where` is a no-op; spreading
    // `{ tombstonedAt: { not: null } }` would show ONLY tombstoned rows,
    // which is not what any caller means by "include".
    expect(goldenItemLifecycleWhere(true)).toEqual({});
  });

  it('accepts exactly the string "true", matching ?includeRetired and ?includeSamples', () => {
    expect(parseIncludeTombstoned(new URLSearchParams('includeTombstoned=true'))).toBe(true);
    expect(parseIncludeTombstoned(new URLSearchParams(''))).toBe(false);
    expect(parseIncludeTombstoned(new URLSearchParams('includeTombstoned='))).toBe(false);
    expect(parseIncludeTombstoned(new URLSearchParams('includeTombstoned=1'))).toBe(false);
    expect(parseIncludeTombstoned(new URLSearchParams('includeTombstoned=TRUE'))).toBe(false);
  });
});
