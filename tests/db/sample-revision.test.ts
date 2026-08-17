import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { getServerSession } from 'next-auth';
import { db, truncateAll, mkUser } from './helpers';
import { DELETE, PATCH, PUT } from '@/app/api/datasets/[id]/samples/route';
import { POST as POST_RESTORE } from '@/app/api/datasets/[id]/samples/[sampleId]/restore/route';
import { GET as GET_REVISIONS } from '@/app/api/datasets/[id]/samples/[sampleId]/revisions/route';

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

describe('the bulk verbs record a revision per hidden row', () => {
  beforeEach(async () => {
    await truncateAll();
    vi.clearAllMocks();
  });

  async function mkCorpus(userId: string, inputs: string[]) {
    fixtureCounter += 1;
    const dataset = await db.dataset.create({
      data: {
        name: 'Bulk Fixture',
        slug: `bulk-${fixtureCounter}`,
        userId,
        visibility: 'private',
        inputType: 'query-response',
        sampleCount: inputs.length,
      },
    });
    const samples = [];
    for (const [i, input] of inputs.entries()) {
      samples.push(
        await db.datasetSample.create({
          data: { datasetId: dataset.id, index: i, input, expected: null, metadata: null },
        })
      );
    }
    return { dataset, samples };
  }

  function bulkRequest(method: 'DELETE' | 'PUT', body: unknown) {
    return new Request('http://localhost/api/datasets/x/samples', {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('DELETE records one `delete` revision per sample it hides', async () => {
    const owner = await mkUser();
    const { dataset, samples } = await mkCorpus(owner.id, ['first', 'second']);
    sessionFor(owner);

    const res = await DELETE(bulkRequest('DELETE', { sampleIds: samples.map((s) => s.id) }), {
      params: Promise.resolve({ id: dataset.id }),
    });
    expect(res.status).toBe(200);

    const revisions = await db.sampleRevision.findMany({ orderBy: { at: 'asc' } });
    expect(revisions).toHaveLength(2);
    expect(revisions.every((r) => r.changeType === 'delete')).toBe(true);
    expect(revisions.every((r) => r.actorId === owner.id)).toBe(true);
    // A delete changes no content, so the before-image columns stay NULL.
    expect(revisions.every((r) => r.input === null)).toBe(true);
  });

  it('a retried DELETE of an already-hidden id records NO second revision', async () => {
    const owner = await mkUser();
    const { dataset, samples } = await mkCorpus(owner.id, ['only']);
    sessionFor(owner);

    const body = { sampleIds: [samples[0].id] };
    await DELETE(bulkRequest('DELETE', body), { params: Promise.resolve({ id: dataset.id }) });
    const second = await DELETE(bulkRequest('DELETE', body), {
      params: Promise.resolve({ id: dataset.id }),
    });
    expect(second.status).toBe(200);

    // L1 made the retry converge on hidden rather than error, and it reports
    // `tombstoned: 1` both times because that count means "distinct ids now
    // hidden". The log must NOT agree with that number: the row was deleted
    // ONCE. A second revision would claim a deletion that did not happen,
    // which is exactly the kind of false history that makes a log worse than
    // none.
    expect(await db.sampleRevision.count()).toBe(1);
  });

  it('PUT bulk-replace records one `delete` revision per outgoing live row', async () => {
    const owner = await mkUser();
    const { dataset } = await mkCorpus(owner.id, ['out-a', 'out-b', 'out-c']);
    sessionFor(owner);

    const res = await PUT(
      bulkRequest('PUT', { samples: [{ input: 'incoming', expected: null }] }),
      { params: Promise.resolve({ id: dataset.id }) }
    );
    expect(res.status).toBe(200);

    // Three outgoing rows hidden, one incoming row appended above the
    // high-water mark. The incoming row is a CREATE and gets no revision —
    // a row's first state is the row itself.
    const revisions = await db.sampleRevision.findMany();
    expect(revisions).toHaveLength(3);
    expect(revisions.every((r) => r.changeType === 'delete')).toBe(true);
    expect(revisions.every((r) => r.actorId === owner.id)).toBe(true);
  });

  it('a PUT over an already-empty corpus records nothing', async () => {
    const owner = await mkUser();
    const { dataset } = await mkCorpus(owner.id, []);
    sessionFor(owner);

    const res = await PUT(bulkRequest('PUT', { samples: [{ input: 'first ever', expected: null }] }), {
      params: Promise.resolve({ id: dataset.id }),
    });
    expect(res.status).toBe(200);

    // Nothing transitioned, so nothing is logged. This is what L1's
    // `if (outgoing.length > 0)` guard buys, and why the revision write goes
    // INSIDE it rather than beside it.
    expect(await db.sampleRevision.count()).toBe(0);
  });
});

describe('POST /api/datasets/[id]/samples/[sampleId]/restore', () => {
  beforeEach(async () => {
    await truncateAll();
    vi.clearAllMocks();
  });

  async function mkHiddenSample(userId: string, opts: { hideSample?: boolean; hideDataset?: boolean } = {}) {
    fixtureCounter += 1;
    const dataset = await db.dataset.create({
      data: {
        name: 'Restore Fixture',
        slug: `restore-${fixtureCounter}`,
        userId,
        visibility: 'private',
        inputType: 'query-response',
        sampleCount: 1,
      },
    });
    const sample = await db.datasetSample.create({
      data: { datasetId: dataset.id, index: 0, input: 'hidden then back', expected: null, metadata: null },
    });
    if (opts.hideSample) {
      await db.tombstone.create({ data: { datasetSampleId: sample.id, isTombstone: true } });
    }
    if (opts.hideDataset) {
      await db.tombstone.create({ data: { datasetId: dataset.id, isTombstone: true } });
    }
    return { dataset, sample };
  }

  const restoreRequest = () => new Request('http://localhost/x', { method: 'POST' });

  it('un-hides a hidden sample and records a `restore` revision', async () => {
    const owner = await mkUser();
    const { dataset, sample } = await mkHiddenSample(owner.id, { hideSample: true });
    sessionFor(owner);

    const res = await POST_RESTORE(restoreRequest(), {
      params: Promise.resolve({ id: dataset.id, sampleId: sample.id }),
    });
    expect(res.status).toBe(200);

    // The tombstone row SURVIVES with the flag flipped — it is not deleted.
    // That is what preserves "this was hidden once", and it is why the read
    // filter is written as a NOT rather than an is-null check.
    const tomb = await db.tombstone.findUnique({ where: { datasetSampleId: sample.id } });
    expect(tomb).not.toBeNull();
    expect(tomb?.isTombstone).toBe(false);

    const revisions = await db.sampleRevision.findMany({ where: { datasetSampleId: sample.id } });
    expect(revisions).toHaveLength(1);
    expect(revisions[0].changeType).toBe('restore');
    expect(revisions[0].input).toBeNull();
    expect(revisions[0].actorId).toBe(owner.id);
  });

  it('the restored sample keeps its original ordinal — nothing ever reused it', async () => {
    const owner = await mkUser();
    const { dataset, sample } = await mkHiddenSample(owner.id, { hideSample: true });
    sessionFor(owner);

    await POST_RESTORE(restoreRequest(), {
      params: Promise.resolve({ id: dataset.id, sampleId: sample.id }),
    });

    // The high-water-mark rule exists precisely so this holds: a restored
    // sample lands back in its original position rather than at the end.
    const after = await db.datasetSample.findUniqueOrThrow({ where: { id: sample.id } });
    expect(after.index).toBe(0);
  });

  it('409s a sample that is not hidden, and records nothing', async () => {
    const owner = await mkUser();
    const { dataset, sample } = await mkHiddenSample(owner.id);
    sessionFor(owner);

    const res = await POST_RESTORE(restoreRequest(), {
      params: Promise.resolve({ id: dataset.id, sampleId: sample.id }),
    });
    expect(res.status).toBe(409);
    expect(await db.sampleRevision.count()).toBe(0);
  });

  it('404s when the PARENT dataset is hidden — a hidden dataset is closed to writes', async () => {
    const owner = await mkUser();
    const { dataset, sample } = await mkHiddenSample(owner.id, { hideSample: true, hideDataset: true });
    sessionFor(owner);

    // Owner decision, 2026-08-16: both new routes filter the parent with
    // liveDatasetsOnly(), following design decisions 15 and 16. Un-hiding one
    // sample beneath a hidden dataset would surface nothing anyway — every
    // sample of a hidden dataset is hidden by inheritance, and there is no
    // restoreDataset to lift the parent.
    const res = await POST_RESTORE(restoreRequest(), {
      params: Promise.resolve({ id: dataset.id, sampleId: sample.id }),
    });
    expect(res.status).toBe(404);
    expect(await db.sampleRevision.count()).toBe(0);

    // And the sample is still hidden — a 404 that wrote anyway is the worse bug.
    const tomb = await db.tombstone.findUnique({ where: { datasetSampleId: sample.id } });
    expect(tomb?.isTombstone).toBe(true);
  });

  it('404s a sample that belongs to a different dataset', async () => {
    const owner = await mkUser();
    const mine = await mkHiddenSample(owner.id, { hideSample: true });
    const theirs = await mkHiddenSample(owner.id, { hideSample: true });
    sessionFor(owner);

    const res = await POST_RESTORE(restoreRequest(), {
      params: Promise.resolve({ id: mine.dataset.id, sampleId: theirs.sample.id }),
    });
    expect(res.status).toBe(404);
    expect(await db.sampleRevision.count()).toBe(0);
  });
});

describe('restore and the stored sampleCount', () => {
  beforeEach(async () => {
    await truncateAll();
    vi.clearAllMocks();
  });

  it('a restore puts the sample back INTO the stored live count', async () => {
    // L1 made `sampleCount` a LIVE row count and had DELETE rewrite it. A
    // restore moves that count in the other direction, so it has to rewrite it
    // too — otherwise the stored value under-reports by one for every restored
    // row, permanently. The UI ladder reads the stored value FIRST, so a stale
    // one shadows the live count beneath it: the same failure L1 documented as
    // "the import picker advertises 620 and the import yields 610", pointing
    // the other way.
    const owner = await mkUser();
    fixtureCounter += 1;
    const dataset = await db.dataset.create({
      data: {
        name: 'Count Fixture',
        slug: `count-${fixtureCounter}`,
        userId: owner.id,
        visibility: 'private',
        inputType: 'query-response',
        sampleCount: 2,
      },
    });
    const a = await db.datasetSample.create({
      data: { datasetId: dataset.id, index: 0, input: 'a', expected: null, metadata: null },
    });
    await db.datasetSample.create({
      data: { datasetId: dataset.id, index: 1, input: 'b', expected: null, metadata: null },
    });
    sessionFor(owner);

    // Hide one through the real verb, so the stored count is whatever DELETE
    // leaves rather than something this test asserts into place.
    await DELETE(
      new Request('http://localhost/api/datasets/x/samples', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sampleIds: [a.id] }),
      }),
      { params: Promise.resolve({ id: dataset.id }) }
    );
    expect((await db.dataset.findUniqueOrThrow({ where: { id: dataset.id } })).sampleCount).toBe(1);

    const res = await POST_RESTORE(new Request('http://localhost/x', { method: 'POST' }), {
      params: Promise.resolve({ id: dataset.id, sampleId: a.id }),
    });
    expect(res.status).toBe(200);

    const after = await db.dataset.findUniqueOrThrow({ where: { id: dataset.id } });
    expect(after.sampleCount).toBe(2);
  });
});

describe('GET /api/datasets/[id]/samples/[sampleId]/revisions', () => {
  beforeEach(async () => {
    await truncateAll();
    vi.clearAllMocks();
  });

  async function mkHistory(userId: string, opts: { hideSample?: boolean; hideDataset?: boolean } = {}) {
    fixtureCounter += 1;
    const dataset = await db.dataset.create({
      data: {
        name: 'History Fixture',
        slug: `hist-${fixtureCounter}`,
        userId,
        visibility: 'private',
        inputType: 'query-response',
        sampleCount: 1,
      },
    });
    const sample = await db.datasetSample.create({
      data: { datasetId: dataset.id, index: 0, input: 'v3', expected: null, metadata: null },
    });
    // `at` is set EXPLICITLY and distinctly. @default(now()) is Postgres's
    // now(), which is the TRANSACTION timestamp — both rows of a single
    // createMany would get the identical value and `orderBy: { at: 'desc' }`
    // would have no defined order between them, so the assertion below would
    // pass or fail on insertion-order luck.
    await db.sampleRevision.createMany({
      data: [
        {
          datasetSampleId: sample.id,
          changeType: 'edit',
          input: 'v1',
          actorId: userId,
          at: new Date('2026-08-15T10:00:00.000Z'),
        },
        {
          datasetSampleId: sample.id,
          changeType: 'edit',
          input: 'v2',
          actorId: userId,
          at: new Date('2026-08-15T11:00:00.000Z'),
        },
      ],
    });
    if (opts.hideSample) {
      await db.tombstone.create({ data: { datasetSampleId: sample.id, isTombstone: true } });
    }
    if (opts.hideDataset) {
      await db.tombstone.create({ data: { datasetId: dataset.id, isTombstone: true } });
    }
    return { dataset, sample };
  }

  const historyRequest = () => new Request('http://localhost/x');

  it('returns the history newest first, including for a HIDDEN sample', async () => {
    const owner = await mkUser();
    // Hidden. The history of a hidden sample is exactly what you read when
    // deciding whether to restore it, so this route does NOT filter on the
    // sample's own tombstone.
    const { dataset, sample } = await mkHistory(owner.id, { hideSample: true });
    sessionFor(owner);

    const res = await GET_REVISIONS(historyRequest(), {
      params: Promise.resolve({ id: dataset.id, sampleId: sample.id }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.revisions.map((r: { input: string }) => r.input)).toEqual(['v2', 'v1']);
    expect(body.revisions[0].actor.id).toBe(owner.id);
  });

  it('projects the actor as id and name only — never an email', async () => {
    const owner = await mkUser();
    const { dataset, sample } = await mkHistory(owner.id);
    sessionFor(owner);

    const res = await GET_REVISIONS(historyRequest(), {
      params: Promise.resolve({ id: dataset.id, sampleId: sample.id }),
    });
    const body = await res.json();
    expect(Object.keys(body.revisions[0].actor).sort()).toEqual(['id', 'name']);
    expect(JSON.stringify(body)).not.toContain(owner.email);
  });

  it('403s a stranger', async () => {
    const owner = await mkUser();
    const stranger = await mkUser();
    const { dataset, sample } = await mkHistory(owner.id);
    sessionFor(stranger);

    const res = await GET_REVISIONS(historyRequest(), {
      params: Promise.resolve({ id: dataset.id, sampleId: sample.id }),
    });
    expect(res.status).toBe(403);
  });

  it('404s when the PARENT dataset is hidden', async () => {
    const owner = await mkUser();
    const { dataset, sample } = await mkHistory(owner.id, { hideDataset: true });
    sessionFor(owner);

    const res = await GET_REVISIONS(historyRequest(), {
      params: Promise.resolve({ id: dataset.id, sampleId: sample.id }),
    });
    expect(res.status).toBe(404);
  });

  it('404s a sample that belongs to a different dataset', async () => {
    const owner = await mkUser();
    const mine = await mkHistory(owner.id);
    const theirs = await mkHistory(owner.id);
    sessionFor(owner);

    const res = await GET_REVISIONS(historyRequest(), {
      params: Promise.resolve({ id: mine.dataset.id, sampleId: theirs.sample.id }),
    });
    expect(res.status).toBe(404);
  });

  it('a sample with no history is an empty array, not a 404', async () => {
    const owner = await mkUser();
    fixtureCounter += 1;
    const dataset = await db.dataset.create({
      data: {
        name: 'No History',
        slug: `nohist-${fixtureCounter}`,
        userId: owner.id,
        visibility: 'private',
        inputType: 'query-response',
        sampleCount: 1,
      },
    });
    const sample = await db.datasetSample.create({
      data: { datasetId: dataset.id, index: 0, input: 'never edited', expected: null, metadata: null },
    });
    sessionFor(owner);

    const res = await GET_REVISIONS(historyRequest(), {
      params: Promise.resolve({ id: dataset.id, sampleId: sample.id }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).revisions).toEqual([]);
  });
});
