import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { getServerSession } from 'next-auth';
import { db, truncateAll, mkUser } from './helpers';
import {
  DELETE as deleteSamples,
  POST as addSamples,
  PUT as replaceSamples,
} from '@/app/api/datasets/[id]/samples/route';
import { liveSamplesOnly } from '@/lib/tombstones';

// A1, the tombstone overlay. DELETE /api/datasets/[id]/samples HIDES the named
// rows: the DatasetSample survives on disk with its ordinal, a Tombstone row
// carries the hidden flag, and every filtered read stops returning it. That is
// what lets an annotated corpus shed a bad row —
// GoldenItem.sourceDatasetSampleId is `onDelete: Restrict`, so a hard delete
// either fails outright or takes the annotation with it.
//
// Ordinals stop being dense as a direct consequence, because a tombstone frees
// nothing: @@unique([datasetId, index]) is not partial, so the hidden row keeps
// index 0 forever. The re-index loop this handler used to run is therefore
// deleted rather than adapted — see the route.

vi.mock('next-auth', () => ({ getServerSession: vi.fn() }));
vi.mock('next/headers', () => ({ headers: vi.fn(async () => new Headers()) }));

// Same fake, same reason, as tests/db/dataset-sample-freeze.test.ts:29-35 and
// tests/db/access-matrix.test.ts:94-100: requireAuth() hits a REAL Redis
// sliding window keyed by client IP (always '127.0.0.1' here), and
// `fileParallelism: false` makes that 120/min budget shared by every file in
// one `npm run test:db` run — so a route-driving file can intermittently fail
// OTHER files without this.
vi.mock('@/lib/rate-limit-redis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rate-limit-redis')>();
  return {
    ...actual,
    apiLimiter: { check: vi.fn(async () => ({ ok: true, remaining: 999, resetAt: Date.now() + 60_000 })) },
  };
});

function mockSessionFor(user: { id: string; email: string }) {
  (getServerSession as unknown as Mock).mockResolvedValue({
    user: { id: user.id, email: user.email },
  });
}

function jsonRequest(url: string, method: string, body?: unknown) {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'content-type': 'application/json' };
  }
  return new Request(url, init);
}

let fixtureCounter = 0;

/**
 * A dataset owned by `userId` whose samples sit at exactly `indices` — the
 * literal ordinals, not a count. Every fixture in this file cares about the
 * SHAPE of the ordinal sequence, and a helper that only took a length could
 * not express a corpus with holes in it.
 */
async function mkCorpus(userId: string, indices: number[]) {
  fixtureCounter += 1;
  return db.dataset.create({
    data: {
      name: `tombstone-fixture-dataset-${fixtureCounter}`,
      userId,
      source: 'local',
      visibility: 'public',
      sampleCount: indices.length,
      samples: {
        create: indices.map((index) => ({
          index,
          input: `question-${index}`,
          expected: 'A>B',
        })),
      },
    },
    include: { samples: { orderBy: { index: 'asc' } } },
  });
}

async function callDelete(datasetId: string, sampleIds: string[]) {
  return deleteSamples(
    jsonRequest(`http://localhost/api/datasets/${datasetId}/samples`, 'DELETE', { sampleIds }),
    { params: Promise.resolve({ id: datasetId }) }
  );
}

async function callPut(datasetId: string, samples: { input: string; expected?: string }[]) {
  return replaceSamples(
    jsonRequest(`http://localhost/api/datasets/${datasetId}/samples`, 'PUT', { samples }),
    { params: Promise.resolve({ id: datasetId }) }
  );
}

describe('DELETE /api/datasets/[id]/samples — the overlay (A1 Task 3)', () => {
  beforeEach(async () => {
    await truncateAll();
    (getServerSession as unknown as Mock).mockReset();
  });

  it('HIDES the named rows, leaves them on disk, and reports a LIVE remaining count', async () => {
    const user = await mkUser();
    mockSessionFor(user);
    const dataset = await mkCorpus(user.id, [0, 1, 2, 3]);

    // The corpus carries a hidden row BEFORE the verb runs. Without that, the
    // live count and the row count are the same number and every count
    // assertion below passes vacuously against the unchanged handler — the
    // spec's Testing shapes 1 ("the overlay hides rows") and 5 ("the two
    // sampleCount writes").
    await db.tombstone.create({
      data: {
        datasetSampleId: dataset.samples[3].id,
        isTombstone: true,
        reason: 'deleted by hand',
      },
    });

    const res = await callDelete(dataset.id, [dataset.samples[0].id]);

    expect(res.status).toBe(200);
    // `remaining` counts LIVE rows — indices 1 and 2. There are 4 rows on
    // disk, and the `remaining.length` this replaces reported 3.
    expect(await res.json()).toEqual({ tombstoned: 1, remaining: 2 });

    // Nothing was destroyed. The id a GoldenItem.sourceDatasetSampleId would
    // cite is still there and still addressable — the entire point.
    await expect(db.datasetSample.count({ where: { datasetId: dataset.id } })).resolves.toBe(4);
    await expect(
      db.datasetSample.findUnique({ where: { id: dataset.samples[0].id } })
    ).resolves.not.toBeNull();

    const tomb = await db.tombstone.findUnique({
      where: { datasetSampleId: dataset.samples[0].id },
    });
    expect(tomb?.isTombstone).toBe(true);
    expect(tomb?.reason).toBe('sample deleted');

    // …and hidden, by the one definition of hidden.
    const live = await db.datasetSample.findMany({
      where: { datasetId: dataset.id, ...liveSamplesOnly() },
      orderBy: { index: 'asc' },
    });
    expect(live.map((s) => s.index)).toEqual([1, 2]);

    // The stored count is the live count, not the row count. The UI ladder
    // reads this value FIRST, so a stale one shadows the live count beneath
    // it — the import picker advertises 620 and the import yields 610.
    const after = await db.dataset.findUnique({
      where: { id: dataset.id },
      select: { sampleCount: true },
    });
    expect(after?.sampleCount).toBe(2);

    // The pre-existing tombstone is untouched: this delete never named that
    // id, and re-tombstoning it would overwrite the record of why it went
    // away with this delete's reason.
    const untouched = await db.tombstone.findUnique({
      where: { datasetSampleId: dataset.samples[3].id },
    });
    expect(untouched?.reason).toBe('deleted by hand');
  });

  it('a REPEATED delete of an already-hidden id is 200 and stays hidden — the sole reason the membership lookup is unfiltered', async () => {
    // The spec's Testing shape 4, and it is worth being precise about why it
    // needs its own test: a delete -> un-delete -> delete sequence does NOT
    // cover this. That sequence's second call hits the membership lookup
    // against a LIVE row, so it passes even when the lookup is filtered. Only
    // a straight retry, with the row still hidden, discriminates.
    const user = await mkUser();
    mockSessionFor(user);
    const dataset = await mkCorpus(user.id, [0, 1]);

    const first = await callDelete(dataset.id, [dataset.samples[0].id]);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ tombstoned: 1, remaining: 1 });

    const second = await callDelete(dataset.id, [dataset.samples[0].id]);
    // 200, not the 400 a filtered membership lookup would produce: the row
    // still BELONGS to this dataset, it is merely hidden.
    expect(second.status).toBe(200);
    // `tombstoned` counts ids NOW HIDDEN, not ids newly hidden, so the retry
    // reports 1. That differs on purpose from the golden-items route, whose
    // `updateMany … tombstonedAt: null` reports 0 on a retry
    // (tests/db/golden-sets.test.ts:1123). "Now hidden" is the property this
    // handler converges on, and it is what makes the retry's `remaining`
    // meaningful rather than an accident.
    expect(await second.json()).toEqual({ tombstoned: 1, remaining: 1 });

    // One row per entity, upserted on a @unique FK: never P2002, never a
    // duplicate.
    await expect(
      db.tombstone.count({ where: { datasetSampleId: dataset.samples[0].id } })
    ).resolves.toBe(1);
    const tomb = await db.tombstone.findUnique({
      where: { datasetSampleId: dataset.samples[0].id },
    });
    expect(tomb?.isTombstone).toBe(true);
  });

  it('converges on hidden after an un-delete — the write arm is not empty', async () => {
    const user = await mkUser();
    mockSessionFor(user);
    const dataset = await mkCorpus(user.id, [0, 1]);

    expect((await callDelete(dataset.id, [dataset.samples[0].id])).status).toBe(200);
    const afterFirst = await db.tombstone.findUnique({
      where: { datasetSampleId: dataset.samples[0].id },
    });
    expect(afterFirst?.isTombstone).toBe(true);

    // Un-hide it, exactly as `restoreSample` does: flip the flag, clear the
    // reason, keep the row.
    await db.tombstone.update({
      where: { datasetSampleId: dataset.samples[0].id },
      data: { isTombstone: false, reason: null },
    });
    await expect(
      db.datasetSample.count({ where: { datasetId: dataset.id, ...liveSamplesOnly() } })
    ).resolves.toBe(2);

    const again = await callDelete(dataset.id, [dataset.samples[0].id]);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ tombstoned: 1, remaining: 1 });

    // The restore in the middle is what makes this non-vacuous: without it the
    // second delete writes `isTombstone: true` over `isTombstone: true`, and a
    // writer whose update arm was EMPTY would look correct. With it, an empty
    // arm leaves the row VISIBLE — a delete that returns 200 and silently does
    // nothing. The property is not "idempotent no-op": it is never P2002, and
    // always converges on hidden.
    const tomb = await db.tombstone.findUnique({
      where: { datasetSampleId: dataset.samples[0].id },
    });
    expect(tomb?.isTombstone).toBe(true);
    // The reason is re-asserted too, not left null by an update that only
    // touched the flag.
    expect(tomb?.reason).toBe('sample deleted');
  });

  it('does NOT re-index the survivors — every ordinal keeps its hole, and the hidden row keeps its own', async () => {
    const user = await mkUser();
    mockSessionFor(user);
    const dataset = await mkCorpus(user.id, [0, 1, 2]);

    const res = await callDelete(dataset.id, [dataset.samples[0].id]);
    expect(res.status).toBe(200);

    const rows = await db.datasetSample.findMany({
      where: { datasetId: dataset.id },
      orderBy: { index: 'asc' },
    });
    // Three rows, still at 0, 1, 2. The loop this task deletes renumbered the
    // survivors to 0 and 1; adapted to live rows it renumbers the first
    // survivor to 0 and collides with the hidden row still holding 0 (P2002 on
    // @@unique([datasetId, index]), which is not partial).
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.index)).toEqual([0, 1, 2]);
    expect(rows[0].id).toBe(dataset.samples[0].id);
    expect(rows[0].index).toBe(0);

    const live = await db.datasetSample.findMany({
      where: { datasetId: dataset.id, ...liveSamplesOnly() },
      orderBy: { index: 'asc' },
    });
    expect(live.map((s) => s.index)).toEqual([1, 2]);
  });

  it('an id from ANOTHER dataset is still a clean 400, not a P2003 in a 500', async () => {
    // The membership lookup is UNFILTERED, not absent, and this is the
    // difference. `tombstoneSamples` raises P2003 for an id that is not a real
    // DatasetSample — `skipDuplicates` skips unique conflicts, not foreign-key
    // ones — so without this read a foreign id would surface as a generic 500.
    //
    // Unlike the four cases above, this one is GREEN before the change too. It
    // is a regression guard on a read this task must not remove while it is
    // busy refusing to filter it.
    const user = await mkUser();
    mockSessionFor(user);
    const target = await mkCorpus(user.id, [0]);
    const other = await mkCorpus(user.id, [0]);

    const res = await callDelete(target.id, [other.samples[0].id]);

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Some samples not found in this dataset');
    await expect(db.tombstone.count()).resolves.toBe(0);
    await expect(
      db.dataset.findUnique({ where: { id: target.id }, select: { sampleCount: true } })
    ).resolves.toEqual({ sampleCount: 1 });
  });
});

// ─── A1 Task 4: POST appends above the high-water mark ──────────────────────
// New samples land at max(index) over ALL rows including hidden, + 1. Never a
// count: a tombstone frees no ordinal, so the count and the high-water mark
// diverge the moment anything is hidden OR the moment the corpus arrives with
// gaps from a filtered re-import.
describe('POST /api/datasets/[id]/samples — the high-water mark (A1 Task 4)', () => {
  beforeEach(async () => {
    await truncateAll();
    (getServerSession as unknown as Mock).mockReset();
  });

  it('appends above max(index) over ALL rows on a GAPPED corpus with a hidden tail', async () => {
    const user = await mkUser();
    mockSessionFor(user);

    // Indices 0, 1, 3, 4 — a HOLE at 2. This is what a corpus re-imported from
    // a filtered export looks like: src/lib/config.ts:389 emits
    // `index: s.index` verbatim and the importer writes it back, so the rows
    // arrive with gaps and count < max + 1. A freshly-appended corpus has
    // count == max + 1 and NOTHING collides, which is why this bug is
    // invisible without this shape and why a test over a dense corpus would
    // pass against the unchanged handler.
    const dataset = await mkCorpus(user.id, [0, 1, 3, 4]);

    // …and the TAIL is hidden, which is what defeats the other two wrong
    // formulations. With the tail live, count(), max over live rows and max
    // over all rows all agree, and only the unfiltered-count bug shows.
    await db.tombstone.create({
      data: {
        datasetSampleId: dataset.samples[3].id,
        isTombstone: true,
        reason: 'deleted by hand',
      },
    });

    // Every wrong formulation lands on an OCCUPIED ordinal here:
    //   unfiltered count()   = 4  -> index 4 is taken   (this is the old code)
    //   live count()         = 3  -> index 3 is taken
    //   max over LIVE  + 1   = 4  -> index 4 is taken
    //   max over ALL   + 1   = 5  -> free. This is the rule.
    const res = await addSamples(
      jsonRequest(`http://localhost/api/datasets/${dataset.id}/samples`, 'POST', {
        samples: [{ input: 'appended one' }, { input: 'appended two' }],
      }),
      { params: Promise.resolve({ id: dataset.id }) }
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.added).toBe(2);
    expect(body.samples.map((s: { index: number }) => s.index)).toEqual([5, 6]);

    const rows = await db.datasetSample.findMany({
      where: { datasetId: dataset.id },
      orderBy: { index: 'asc' },
    });
    // The hole at 2 stays a hole. `index` is not a position into the live
    // array and nothing back-fills it — its only guarantees are uniqueness
    // within the dataset and monotonic insertion order.
    expect(rows.map((r) => r.index)).toEqual([0, 1, 3, 4, 5, 6]);

    // The hidden tail is untouched: still on disk, still hidden, still holding
    // ordinal 4.
    const tail = await db.datasetSample.findUnique({ where: { id: dataset.samples[3].id } });
    expect(tail?.index).toBe(4);
    const tomb = await db.tombstone.findUnique({
      where: { datasetSampleId: dataset.samples[3].id },
    });
    expect(tomb?.isTombstone).toBe(true);
  });

  it('stores a LIVE sampleCount, not startIndex + n and not a row count', async () => {
    const user = await mkUser();
    mockSessionFor(user);

    // A dense corpus with a hidden HEAD this time, so the append itself
    // succeeds even against the unchanged handler. That isolates the count
    // from the ordinal: this test fails on exactly one assertion, and it is
    // the one about sampleCount.
    const dataset = await mkCorpus(user.id, [0, 1, 2]);
    await db.tombstone.create({
      data: {
        datasetSampleId: dataset.samples[0].id,
        isTombstone: true,
        reason: 'deleted by hand',
      },
    });

    const res = await addSamples(
      jsonRequest(`http://localhost/api/datasets/${dataset.id}/samples`, 'POST', {
        samples: [{ input: 'appended one' }, { input: 'appended two' }],
      }),
      { params: Promise.resolve({ id: dataset.id }) }
    );
    expect(res.status).toBe(201);
    expect((await res.json()).samples.map((s: { index: number }) => s.index)).toEqual([3, 4]);

    // Five rows on disk, four of them live. `startIndex + n` is 3 + 2 = 5 —
    // the ROW count, which is what the replaced line stored, and the number
    // the UI ladder would then read FIRST and display over the live count
    // beneath it.
    await expect(db.datasetSample.count({ where: { datasetId: dataset.id } })).resolves.toBe(5);
    await expect(
      db.datasetSample.count({ where: { datasetId: dataset.id, ...liveSamplesOnly() } })
    ).resolves.toBe(4);

    const after = await db.dataset.findUnique({
      where: { id: dataset.id },
      select: { sampleCount: true },
    });
    expect(after?.sampleCount).toBe(4);
  });
});

// ─── A1 Task 5: PUT is tombstone-and-append ─────────────────────────────────
// Decision 11. Bulk replace hides the outgoing rows and appends the incoming
// document above the high-water mark — on drafts as well as published corpora,
// because otherwise the verb that destroys the most is the one still doing it.
// This handler is also the revert path: src/app/datasets/[id]/page.tsx:416-435
// PUTs a target version's samples here.
describe('PUT /api/datasets/[id]/samples — tombstone-and-append (A1 Task 5)', () => {
  beforeEach(async () => {
    await truncateAll();
    (getServerSession as unknown as Mock).mockReset();
  });

  it('counts only the LIVE set when the corpus already carries a hidden row, and leaves that row alone', async () => {
    const user = await mkUser();
    mockSessionFor(user);

    // The corpus carries a tombstone BEFORE the verb runs. Without that, the
    // filtered and the unfiltered formulations return the same number and
    // every assertion below passes vacuously — the spec's Testing shapes 1
    // ("the overlay hides rows") and 5 ("the sampleCount writes"). It is also
    // a TAIL row (index 1, the max), which is what makes the high-water
    // assertion bite: with the tail live, count(), max over live and max over
    // all agree.
    const dataset = await mkCorpus(user.id, [0, 1]);
    const live = dataset.samples[0];
    const alreadyHidden = dataset.samples[1];
    await db.tombstone.create({
      data: { datasetSampleId: alreadyHidden.id, isTombstone: true, reason: 'deleted by hand' },
    });

    const res = await callPut(dataset.id, [
      { input: 'first replacement' },
      { input: 'second replacement' },
    ]);

    expect(res.status).toBe(200);
    const body = await res.json();
    // Four rows will exist; exactly two are live. An unfiltered response read
    // reports `replaced: 4` and hands back two hidden rows.
    expect(body.replaced).toBe(2);
    expect(body.samples.map((s: { input: string }) => s.input)).toEqual([
      'first replacement',
      'second replacement',
    ]);

    const rows = await db.datasetSample.findMany({
      where: { datasetId: dataset.id },
      orderBy: { index: 'asc' },
    });
    expect(rows).toHaveLength(4);
    // The high-water mark is max(index) over ALL rows — including the hidden
    // one at 1 — so the incoming pair lands at 2 and 3. Derived from a live
    // count() it would be 1, and the first insert would collide.
    expect(rows.map((r) => r.index)).toEqual([0, 1, 2, 3]);

    // The outgoing read is filtered, so the already-hidden row is not
    // re-tombstoned. Re-tombstoning it would overwrite the record of why it
    // went away with this replace's reason.
    const untouched = await db.tombstone.findUnique({
      where: { datasetSampleId: alreadyHidden.id },
    });
    expect(untouched?.reason).toBe('deleted by hand');

    // The row that WAS live is now hidden.
    const hidden = await db.tombstone.findUnique({ where: { datasetSampleId: live.id } });
    expect(hidden?.isTombstone).toBe(true);

    // Live count, not row count: 2, not 4.
    const after = await db.dataset.findUnique({
      where: { id: dataset.id },
      select: { sampleCount: true },
    });
    expect(after?.sampleCount).toBe(2);
  });

  it('hides an UN-DELETED row too — a tombstone row with isTombstone: false is live', async () => {
    // Every other fixture in this file hides rows with `isTombstone: true`, so
    // an outgoing read written as the simpler `{ tombstone: { is: null } }`
    // passes all of them (spec, Testing shape 2). Here that filter skips this
    // row: it is never tombstoned, so it stays LIVE underneath the
    // replacement and the corpus quietly keeps a row the user replaced away —
    // while the response, filtered the same wrong way, does not show it.
    const user = await mkUser();
    mockSessionFor(user);
    const dataset = await mkCorpus(user.id, [0]);
    const sample = dataset.samples[0];
    await db.tombstone.create({
      data: { datasetSampleId: sample.id, isTombstone: false },
    });

    const res = await callPut(dataset.id, [{ input: 'replacement' }]);

    expect(res.status).toBe(200);
    expect((await res.json()).replaced).toBe(1);

    const tomb = await db.tombstone.findUnique({ where: { datasetSampleId: sample.id } });
    expect(tomb?.isTombstone).toBe(true);
    // Converged rather than duplicated: one row per entity, upserted on a
    // @unique FK, never P2002.
    expect(await db.tombstone.count({ where: { datasetSampleId: sample.id } })).toBe(1);
  });
});
