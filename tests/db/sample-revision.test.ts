import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { getServerSession } from 'next-auth';
import { db, truncateAll, mkUser } from './helpers';
import { PATCH } from '@/app/api/datasets/[id]/samples/route';

// L2, the revision log. Every mutation to a DatasetSample appends one
// SampleRevision carrying the values as they stood BEFORE the change, so the
// text a row held is recoverable rather than overwritten.
//
// Nothing in this file filters the log by the tombstone overlay, deliberately:
// the history of a hidden sample is exactly what you read when deciding
// whether to restore it.

vi.mock('next-auth', () => ({ getServerSession: vi.fn() }));
// requireAuth() awaits headers() from next/headers before any auth work, and
// there is no request scope in a node-environment test — without this mock
// every route call throws before it reaches the handler.
vi.mock('next/headers', () => ({ headers: vi.fn(async () => new Headers()) }));

// The DB suite shares a finite 120/min Redis budget ACROSS FILES, so
// route-driving tests here use the established fake rather than the real
// limiter — same shape as tests/db/access-matrix.test.ts:94-100.
vi.mock('@/lib/rate-limit-redis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rate-limit-redis')>();
  return {
    ...actual,
    apiLimiter: {
      check: vi.fn(async () => ({ ok: true, remaining: 999, resetAt: Date.now() + 60_000 })),
    },
  };
});

function sessionFor(user: { id: string; email: string }) {
  (getServerSession as unknown as Mock).mockResolvedValue({
    user: { id: user.id, email: user.email, name: 'Rev Tester' },
  });
}

function jsonRequest(body: unknown) {
  return new Request('http://localhost/api/datasets/x/samples', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

let fixtureCounter = 0;

async function mkDatasetWithSample(userId: string) {
  fixtureCounter += 1;
  const dataset = await db.dataset.create({
    data: {
      name: 'Revision Fixture',
      slug: `rev-fixture-${fixtureCounter}`,
      userId,
      visibility: 'private',
      inputType: 'query-response',
      sampleCount: 1,
    },
  });
  const sample = await db.datasetSample.create({
    data: {
      datasetId: dataset.id,
      index: 0,
      input: 'original question',
      expected: 'original answer',
      metadata: JSON.stringify({ split: 'train' }),
    },
  });
  return { dataset, sample };
}

describe('PATCH /api/datasets/[id]/samples — the revision log', () => {
  beforeEach(async () => {
    await truncateAll();
    vi.clearAllMocks();
  });

  it('an edit records the values as they stood BEFORE it, not after', async () => {
    const owner = await mkUser();
    const { dataset, sample } = await mkDatasetWithSample(owner.id);
    sessionFor(owner);

    const res = await PATCH(
      jsonRequest({ sampleId: sample.id, input: 'edited question', expected: 'edited answer' }),
      { params: Promise.resolve({ id: dataset.id }) }
    );
    expect(res.status).toBe(200);

    // The row now holds the NEW text...
    const after = await db.datasetSample.findUnique({ where: { id: sample.id } });
    expect(after?.input).toBe('edited question');

    // ...and the log holds the OLD text. This is the whole point of the task:
    // before L2, 'original question' was gone the moment the update committed.
    const revisions = await db.sampleRevision.findMany({
      where: { datasetSampleId: sample.id },
    });
    expect(revisions).toHaveLength(1);
    expect(revisions[0].changeType).toBe('edit');
    expect(revisions[0].input).toBe('original question');
    expect(revisions[0].expected).toBe('original answer');
    expect(revisions[0].metadata).toBe(JSON.stringify({ split: 'train' }));
    expect(revisions[0].actorId).toBe(owner.id);
  });

  it('records the full before-image even when the request changes only one field', async () => {
    const owner = await mkUser();
    const { dataset, sample } = await mkDatasetWithSample(owner.id);
    sessionFor(owner);

    await PATCH(jsonRequest({ sampleId: sample.id, input: 'only input changed' }), {
      params: Promise.resolve({ id: dataset.id }),
    });

    // `expected` and `metadata` were not in the request, but the revision still
    // carries them: the log answers "what did this row look like before", not
    // "which keys were in the payload". A partial before-image would be
    // unusable for reconstruction.
    const rev = await db.sampleRevision.findFirst({ where: { datasetSampleId: sample.id } });
    expect(rev?.input).toBe('original question');
    expect(rev?.expected).toBe('original answer');
    expect(rev?.metadata).toBe(JSON.stringify({ split: 'train' }));
  });

  it('two edits leave two revisions, oldest first by `at`', async () => {
    const owner = await mkUser();
    const { dataset, sample } = await mkDatasetWithSample(owner.id);
    sessionFor(owner);

    // Two SEPARATE requests, so two separate transactions and therefore two
    // distinct `now()` values. Seeding both in one createMany would give them
    // the identical transaction timestamp and leave this ordering undefined.
    await PATCH(jsonRequest({ sampleId: sample.id, input: 'second' }), {
      params: Promise.resolve({ id: dataset.id }),
    });
    await PATCH(jsonRequest({ sampleId: sample.id, input: 'third' }), {
      params: Promise.resolve({ id: dataset.id }),
    });

    const revisions = await db.sampleRevision.findMany({
      where: { datasetSampleId: sample.id },
      orderBy: { at: 'asc' },
    });
    expect(revisions.map((r) => r.input)).toEqual(['original question', 'second']);
  });

  it('a refused edit writes no revision claiming it happened', async () => {
    const owner = await mkUser();
    const { dataset } = await mkDatasetWithSample(owner.id);
    sessionFor(owner);

    // A sample id belonging to no dataset: the handler refuses at the
    // membership lookup, BEFORE the transaction opens.
    //
    // Note what this does and does not pin. It proves no revision is written
    // without a mutation, which is the property that matters here. It does NOT
    // exercise a genuine mid-transaction rollback — that would need fault
    // injection into the update, and the transaction boundary is instead
    // pinned structurally by both writes sharing one `tx`.
    const res = await PATCH(jsonRequest({ sampleId: 'smp_does_not_exist', input: 'x' }), {
      params: Promise.resolve({ id: dataset.id }),
    });
    expect(res.status).toBe(404);
    expect(await db.sampleRevision.count()).toBe(0);
  });
});
