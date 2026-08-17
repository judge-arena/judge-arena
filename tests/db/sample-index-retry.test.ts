import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { getServerSession } from 'next-auth';
import { db, truncateAll, mkUser } from './helpers';

/**
 * R1 at the ROUTE level: POST recovers from an ordinal collision instead of
 * reporting a bare 500.
 *
 * The collision is INJECTED rather than raced. Two concurrent POSTs may or may
 * not interleave, so a test built on real concurrency would pass without ever
 * exercising the retry — the worst kind of green. Here the first
 * `nextSampleIndex` call is forced to return an already-occupied ordinal, so
 * attempt 1 collides deterministically and the retry is the only thing that can
 * produce a 201.
 *
 * The real, unforced race is pinned separately and at the library level, in
 * tests/db/dataset-sample-tombstone.test.ts ('two concurrent transactions read
 * the SAME high-water mark'). That test still passes and is still true: it
 * calls `nextSampleIndex` directly, so it describes the function, not the
 * route.
 */

const hoisted = vi.hoisted(() => ({ calls: 0, staleFor: 1 }));

vi.mock('next-auth', () => ({ getServerSession: vi.fn() }));
vi.mock('next/headers', () => ({ headers: vi.fn(async () => new Headers()) }));
vi.mock('@/lib/rate-limit-redis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rate-limit-redis')>();
  return {
    ...actual,
    apiLimiter: {
      check: vi.fn(async () => ({ ok: true, remaining: 999, resetAt: Date.now() + 60_000 })),
    },
  };
});

// Only `nextSampleIndex` is replaced. `appendWithRetry` and the filters must
// stay the real ones — this test exists to exercise them.
vi.mock('@/lib/tombstones', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tombstones')>();
  return {
    ...actual,
    nextSampleIndex: vi.fn(async (tx: Parameters<typeof actual.nextSampleIndex>[0], datasetId: string) => {
      const real = await actual.nextSampleIndex(tx, datasetId);
      hoisted.calls += 1;
      // Hand back an ordinal that is already taken, so the insert collides.
      return hoisted.calls <= hoisted.staleFor ? real - 2 : real;
    }),
  };
});

const { POST } = await import('@/app/api/datasets/[id]/samples/route');
const { nextSampleIndex } = await import('@/lib/tombstones');

function sessionFor(user: { id: string; email: string }) {
  (getServerSession as unknown as Mock).mockResolvedValue({
    user: { id: user.id, email: user.email, name: 'Retry Tester' },
  });
}

let fixtureCounter = 0;

async function mkCorpus(userId: string) {
  fixtureCounter += 1;
  const dataset = await db.dataset.create({
    data: {
      name: 'Retry Fixture',
      slug: `retry-idx-${fixtureCounter}`,
      userId,
      visibility: 'private',
      inputType: 'query-response',
      sampleCount: 3,
    },
  });
  for (const index of [0, 1, 2]) {
    await db.datasetSample.create({
      data: { datasetId: dataset.id, index, input: `row ${index}`, expected: null, metadata: null },
    });
  }
  return dataset;
}

function postRequest(input: string) {
  return new Request('http://localhost/api/datasets/x/samples', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ samples: [{ input }] }),
  });
}

describe('POST /api/datasets/[id]/samples — the ordinal-collision retry (R1)', () => {
  beforeEach(async () => {
    await truncateAll();
    vi.clearAllMocks();
    hoisted.calls = 0;
    hoisted.staleFor = 1;
  });

  it('recovers from a collided high-water mark and appends at the real one', async () => {
    const owner = await mkUser();
    const dataset = await mkCorpus(owner.id);
    sessionFor(owner);

    const res = await POST(postRequest('appended after a collision'), {
      params: Promise.resolve({ id: dataset.id }),
    });

    // Before R1 this was a bare 500: the first attempt's P2002 propagated to
    // the handler's catch, which reports 'Failed to add samples'.
    expect(res.status).toBe(201);

    // NON-VACUITY: the retry must actually have fired. One call means the
    // injection never took effect and this test proves nothing.
    expect(nextSampleIndex).toHaveBeenCalledTimes(2);

    const body = await res.json();
    expect(body.samples[0].index).toBe(3);

    // And exactly one row landed — the rolled-back attempt left nothing.
    const rows = await db.datasetSample.findMany({
      where: { datasetId: dataset.id },
      orderBy: { index: 'asc' },
    });
    expect(rows.map((r) => r.index)).toEqual([0, 1, 2, 3]);
  });

  it('gives up after the bounded attempts rather than looping forever', async () => {
    const owner = await mkUser();
    const dataset = await mkCorpus(owner.id);
    sessionFor(owner);

    // Every attempt collides.
    hoisted.staleFor = Number.MAX_SAFE_INTEGER;

    const res = await POST(postRequest('never lands'), {
      params: Promise.resolve({ id: dataset.id }),
    });

    expect(res.status).toBe(500);
    expect(nextSampleIndex).toHaveBeenCalledTimes(3);

    // Nothing was written by any of the three rolled-back attempts.
    expect(await db.datasetSample.count({ where: { datasetId: dataset.id } })).toBe(3);
  });
});
