import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  MAX_APPEND_ATTEMPTS,
  appendWithRetry,
  isRetryableAppendConflict,
} from '@/lib/tombstones';

/**
 * R1. These pin the PREDICATE and the BOUND, which is where this fix can fail
 * silently: a predicate that does not match the error shape Prisma actually
 * emits fails OPEN — the retry never fires, every test that does not force a
 * collision still passes, and the defect looks fixed.
 */

function p2002(target: unknown): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '6.19.2',
    meta: { target },
  });
}

describe('isRetryableAppendConflict', () => {
  it('matches the FIELD-LIST shape of the ordinal constraint', () => {
    expect(isRetryableAppendConflict(p2002(['datasetId', 'index']))).toBe(true);
  });

  it('matches the CONSTRAINT-NAME shape of the same constraint', () => {
    // Prisma reports either shape depending on the error path. Handling only
    // one is the fail-open case this test exists for.
    expect(isRetryableAppendConflict(p2002('DatasetSample_datasetId_index_key'))).toBe(true);
  });

  it('does NOT match a slug collision — a retry could only fail it more slowly', () => {
    expect(isRetryableAppendConflict(p2002(['userId', 'slug']))).toBe(false);
  });

  it('does NOT match a partial field list', () => {
    // `datasetId` alone is not the ordinal constraint.
    expect(isRetryableAppendConflict(p2002(['datasetId']))).toBe(false);
  });

  it('does NOT match a non-P2002 Prisma error, or a plain Error', () => {
    const p2025 = new Prisma.PrismaClientKnownRequestError('Not found', {
      code: 'P2025',
      clientVersion: '6.19.2',
      meta: { target: ['datasetId', 'index'] },
    });
    expect(isRetryableAppendConflict(p2025)).toBe(false);
    expect(isRetryableAppendConflict(new Error('Unique constraint failed'))).toBe(false);
    expect(isRetryableAppendConflict(undefined)).toBe(false);
  });
});

describe('appendWithRetry', () => {
  it('returns the first success without retrying — the uncontended case costs nothing', async () => {
    const run = vi.fn(async () => 'ok');
    expect(await appendWithRetry(run)).toBe('ok');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('retries an ordinal collision and returns the later success', async () => {
    let calls = 0;
    const run = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw p2002(['datasetId', 'index']);
      return 'ok on the second attempt';
    });
    expect(await appendWithRetry(run)).toBe('ok on the second attempt');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it(`gives up after ${MAX_APPEND_ATTEMPTS} attempts and rethrows the original error`, async () => {
    const run = vi.fn(async () => {
      throw p2002(['datasetId', 'index']);
    });
    await expect(appendWithRetry(run)).rejects.toMatchObject({ code: 'P2002' });
    // Bounded, so a persistent collision fails loudly instead of hammering the
    // database. Same bound and same reasoning as createDatasetVersion.
    expect(run).toHaveBeenCalledTimes(MAX_APPEND_ATTEMPTS);
  });

  it('does NOT retry an error it cannot fix — it rethrows on the first attempt', async () => {
    const run = vi.fn(async () => {
      throw p2002(['userId', 'slug']);
    });
    await expect(appendWithRetry(run)).rejects.toMatchObject({ code: 'P2002' });
    expect(run).toHaveBeenCalledTimes(1);
  });
});
