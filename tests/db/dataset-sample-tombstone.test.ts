import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { getServerSession } from 'next-auth';
import { db, truncateAll, mkUser } from './helpers';
import {
  DELETE as deleteSamples,
  POST as addSamples,
  PUT as replaceSamples,
  PATCH as patchSample,
} from '@/app/api/datasets/[id]/samples/route';
import {
  DELETE as deleteDataset,
  PATCH as patchDataset,
  GET as getDataset,
} from '@/app/api/datasets/[id]/route';
import { GET as exportConfig } from '@/app/api/config/export/route';
import { POST as importConfig } from '@/app/api/config/import/route';
import { POST as createEvaluations } from '@/app/api/evaluations/route';
import { GET as exportProject } from '@/app/api/projects/[id]/export/route';
import { POST as createGoldenSet } from '@/app/api/golden-sets/route';
import {
  POST as createVersion,
  GET as listVersions,
} from '@/app/api/datasets/[id]/versions/route';
import { GET as exportDataset } from '@/app/api/datasets/[id]/export/route';
import { POST as refreshDataset } from '@/app/api/datasets/[id]/refresh/route';
import { liveDatasetsOnly, liveSamplesOnly } from '@/lib/tombstones';
import { PLATFORM_OWNER_EMAIL } from '@/lib/golden-sets';

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

  it('WRITES sampleCount, and writes the incoming length — not the stale value, not the row count', async () => {
    // The `tx.dataset.update` that stores `sampleCount` is the one write in
    // this handler the task was told to leave ALONE, and until this test it
    // was the one write nothing pinned: both other PUT fixtures happen to
    // replace an N-row corpus with N samples, so the value that was already
    // stored is the value being asserted and DELETING the update outright
    // leaves them green.
    //
    // The fixture breaks that coincidence by making all three candidate
    // numbers distinct. Two live rows in, THREE samples out:
    //
    //   never written (stale fixture value) = 2  <- what deleting the write leaves
    //   row count after the replace         = 5  <- 2 hidden + 3 appended
    //   startIndex + n                      = 5  <- 2 + 3, the POST's old bug
    //   data.samples.length                 = 3  <- the rule, and the live count
    //
    // The last two agree here BY CONSTRUCTION rather than by luck, and that is
    // the property being pinned: after tombstone-and-append the live set IS
    // the incoming document, so `data.samples.length` is already the live
    // count. That is why the write must not be "fixed" to count rows.
    const user = await mkUser();
    mockSessionFor(user);
    const dataset = await mkCorpus(user.id, [0, 1]);
    await expect(
      db.dataset.findUnique({ where: { id: dataset.id }, select: { sampleCount: true } })
    ).resolves.toEqual({ sampleCount: 2 });

    const res = await callPut(dataset.id, [
      { input: 'first' },
      { input: 'second' },
      { input: 'third' },
    ]);

    expect(res.status).toBe(200);
    expect((await res.json()).replaced).toBe(3);

    // Five rows on disk, three of them live.
    await expect(db.datasetSample.count({ where: { datasetId: dataset.id } })).resolves.toBe(5);
    await expect(
      db.datasetSample.count({ where: { datasetId: dataset.id, ...liveSamplesOnly() } })
    ).resolves.toBe(3);
    const rows = await db.datasetSample.findMany({
      where: { datasetId: dataset.id },
      orderBy: { index: 'asc' },
    });
    expect(rows.map((r) => r.index)).toEqual([0, 1, 2, 3, 4]);

    // THE ASSERTION THIS TEST EXISTS FOR. 3 — not the 2 left behind by a
    // missing write, and not the 5 a row count or `startIndex + n` would
    // store. The UI ladder reads this value FIRST, so a wrong one shadows the
    // live count beneath it.
    const after = await db.dataset.findUnique({
      where: { id: dataset.id },
      select: { sampleCount: true },
    });
    expect(after?.sampleCount).toBe(3);
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

// ─── A1 Task 6: DELETE /api/datasets/[id] tombstones the dataset ────────────
// The handler ended in a bare `prisma.dataset.delete`, and `Dataset →
// DatasetSample` is `onDelete: Cascade`, so that one statement took an entire
// corpus with it. It is now a `tombstoneDataset` upsert.
//
// The samples are NOT tombstoned one by one (Decision 16): they inherit the
// parent's hidden state through `liveSamplesOnly()`'s `dataset:` clause. The
// row-state and no-per-sample-loop halves are pinned in
// tests/db/dataset-sample-freeze.test.ts, on the happy-path test this task
// inverted. What is pinned here is the parent-arm inheritance itself and the
// convergence property.
//
// NOT ASSERTED ANYWHERE YET, on purpose: that a hidden dataset stops appearing
// in GET /api/datasets. That read belongs to the dataset read sweep later in
// this plan, which owns the route assertion.
describe('DELETE /api/datasets/[id] — the overlay (A1 Task 6)', () => {
  beforeEach(async () => {
    await truncateAll();
    (getServerSession as unknown as Mock).mockReset();
  });

  it('hides EVERY sample of the corpus through the parent arm, without writing one sample tombstone', async () => {
    // A multi-row corpus, and one of its rows is ALREADY hidden in its own
    // right. That is what keeps the inheritance claim honest: with a single
    // clean row, `liveSamplesOnly()` returning [] is equally explained by the
    // sample arm, by the parent arm, or by a per-sample loop. Here the parent
    // arm has to hide the three rows carrying NO tombstone of their own, and
    // the sample tombstone count stays at exactly the one that was there
    // before the verb ran — so a loop would push it to 4.
    const user = await mkUser();
    mockSessionFor(user);
    const dataset = await mkCorpus(user.id, [0, 1, 2, 3]);
    await db.tombstone.create({
      data: {
        datasetSampleId: dataset.samples[2].id,
        isTombstone: true,
        reason: 'deleted by hand',
      },
    });

    // Live before: three of the four.
    await expect(
      db.datasetSample.count({ where: { datasetId: dataset.id, ...liveSamplesOnly() } })
    ).resolves.toBe(3);

    const res = await deleteDataset(
      new Request(`http://localhost/api/datasets/${dataset.id}`, { method: 'DELETE' }),
      { params: Promise.resolve({ id: dataset.id }) }
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });

    // Live after: none — through the parent arm, for the three that carry no
    // tombstone of their own.
    await expect(
      db.datasetSample.count({ where: { datasetId: dataset.id, ...liveSamplesOnly() } })
    ).resolves.toBe(0);

    // Every row survives on disk with its ordinal. `onDelete: Cascade` did not
    // fire, because nothing was deleted.
    const rows = await db.datasetSample.findMany({
      where: { datasetId: dataset.id },
      orderBy: { index: 'asc' },
    });
    expect(rows.map((r) => r.index)).toEqual([0, 1, 2, 3]);

    // ONE dataset tombstone, and the sample-tombstone population is untouched:
    // still just the hand-made one, still carrying its own reason. A loop over
    // the corpus would make this 4 and would overwrite that reason.
    await expect(db.tombstone.count({ where: { datasetId: dataset.id } })).resolves.toBe(1);
    await expect(
      db.tombstone.count({ where: { datasetSampleId: { not: null } } })
    ).resolves.toBe(1);
    const untouched = await db.tombstone.findUnique({
      where: { datasetSampleId: dataset.samples[2].id },
    });
    expect(untouched?.reason).toBe('deleted by hand');
  });

  it('converges on hidden when repeated — never P2002, never a silent no-op', async () => {
    // `Tombstone.datasetId` is @unique, so a second delete that `create`d
    // rather than `upsert`ed raises P2002 and surfaces as a generic 500. And
    // an upsert whose `update:` arm is EMPTY leaves a dataset that was
    // deleted, restored, then deleted again VISIBLE — a delete that silently
    // does nothing. Both are pinned here, and the restore in the middle is
    // what makes the second half non-vacuous: without it the second delete
    // writes `isTombstone: true` over `isTombstone: true` and an empty update
    // arm looks correct.
    const user = await mkUser();
    mockSessionFor(user);
    const dataset = await mkCorpus(user.id, [0]);

    const first = await deleteDataset(
      new Request(`http://localhost/api/datasets/${dataset.id}`, { method: 'DELETE' }),
      { params: Promise.resolve({ id: dataset.id }) }
    );
    expect(first.status).toBe(200);
    expect(await db.tombstone.count({ where: { datasetId: dataset.id } })).toBe(1);

    await db.tombstone.update({
      where: { datasetId: dataset.id },
      data: { isTombstone: false, reason: null },
    });
    // Restored: live again, and so are its samples — the parent arm is what
    // put them back, since none of them ever carried a tombstone.
    await expect(
      db.dataset.count({ where: { id: dataset.id, ...liveDatasetsOnly() } })
    ).resolves.toBe(1);
    await expect(
      db.datasetSample.count({ where: { datasetId: dataset.id, ...liveSamplesOnly() } })
    ).resolves.toBe(1);

    const second = await deleteDataset(
      new Request(`http://localhost/api/datasets/${dataset.id}`, { method: 'DELETE' }),
      { params: Promise.resolve({ id: dataset.id }) }
    );
    expect(second.status).toBe(200);

    expect(await db.tombstone.count({ where: { datasetId: dataset.id } })).toBe(1);
    const tomb = await db.tombstone.findUnique({ where: { datasetId: dataset.id } });
    expect(tomb?.isTombstone).toBe(true);
    // The reason is re-asserted too, not left null by an update that only
    // touched the flag.
    expect(tomb?.reason).toBe('dataset deleted');
  });
});

// ─── A1 Task 7: a hidden dataset is closed to writes (Decision 15) ──────────
// Every mutation handler opens with an ownership guard read of its dataset,
// and not one of them filtered — so once Task 6 made DELETE hide a dataset
// rather than destroy it, a tombstoned corpus stayed completely writable
// through the API. (The list and detail READS are still unfiltered at this
// commit too; closing those is Task 9. The two halves land in that order, so
// for one commit a hidden dataset is readable and unwritable.)
//
// TWO OF THESE ARE LIVE DEFECTS ON THIS BRANCH, not hypotheticals, and both
// are the same shape: `liveSamplesOnly()` carries a PARENT arm, so the sample
// reads inside POST and PUT already see nothing under a hidden dataset while
// the writes around them still land. POST therefore stores `sampleCount: 0`,
// and PUT answers `replaced: 0` while appending rows AND never tombstoning the
// outgoing ones — so un-hiding the corpus hands back BOTH sets with a
// `sampleCount` describing only the later one. The guard closes both, and
// each has its own test below.
//
// NON-VACUITY. Every fixture carries a REAL Tombstone row, and the last two
// carry `isTombstone: false` rows: without those, a filter written as the
// simpler `{ tombstone: { is: null } }` passes this entire block while
// silently keeping an UN-deleted dataset closed to writes forever.
describe('a hidden dataset is closed to writes (A1 Task 7, Decision 15)', () => {
  beforeEach(async () => {
    await truncateAll();
    (getServerSession as unknown as Mock).mockReset();
  });

  /**
   * A public dataset with two PAIRWISE-SHAPED samples, owned by `userId`.
   *
   * Distinct from `mkCorpus` above, which cares about ordinal shape and writes
   * no metadata: `mapSampleToGoldenItem` (src/lib/golden-sets.ts) THROWS on a
   * sample with no `response_A`/`response_B`, so the golden-set import tests
   * below need a corpus that is a real pair set.
   */
  async function t7Corpus(userId: string) {
    fixtureCounter += 1;
    const dataset = await db.dataset.create({
      data: {
        name: `t7-corpus-${fixtureCounter}`,
        userId,
        source: 'local',
        visibility: 'public',
        inputType: 'query-response',
        sampleCount: 2,
      },
    });
    const a = await db.datasetSample.create({
      data: {
        datasetId: dataset.id,
        index: 0,
        input: 'who wrote hamlet',
        expected: 'A>B',
        metadata: JSON.stringify({ response_A: 'shakespeare', response_B: 'bacon' }),
      },
    });
    const b = await db.datasetSample.create({
      data: {
        datasetId: dataset.id,
        index: 1,
        input: 'what is 2 + 2',
        expected: 'B>A',
        metadata: JSON.stringify({ response_A: 'five', response_B: 'four' }),
      },
    });
    return { dataset, a, b };
  }

  async function t7Hide(datasetId: string) {
    await db.tombstone.create({
      data: { datasetId, isTombstone: true, reason: 'hidden by the Task 7 fixture' },
    });
  }

  /** Un-hide, so an assertion can look at what the hidden write left behind. */
  async function t7Unhide(datasetId: string) {
    await db.tombstone.update({
      where: { datasetId },
      data: { isTombstone: false, reason: null },
    });
  }

  it('POST /api/datasets/[id]/samples 404s on a hidden dataset and appends nothing', async () => {
    const user = await mkUser();
    mockSessionFor(user);
    const { dataset } = await t7Corpus(user.id);
    await t7Hide(dataset.id);

    const res = await addSamples(
      jsonRequest(`http://localhost/api/datasets/${dataset.id}/samples`, 'POST', {
        samples: [{ input: 'a third question' }],
      }),
      { params: Promise.resolve({ id: dataset.id }) }
    );

    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('Dataset not found');
    // A handler that 404s AND writes is the worse bug, so assert the corpus,
    // not just the status.
    await expect(
      db.datasetSample.count({ where: { datasetId: dataset.id } })
    ).resolves.toBe(2);
  });

  it('DEFECT: POST onto a hidden dataset used to store sampleCount 0 — a corpus that lies about itself the moment it comes back', async () => {
    // The concrete harm the guard removes, and it is NOT the append. POST's
    // live-count read (samples/route.ts, inside the insert transaction) spreads
    // `liveSamplesOnly()`, whose PARENT arm sees nothing under a hidden
    // dataset — so the handler happily wrote `sampleCount: 0` over a two-row
    // corpus and returned 201. Un-hide and the dataset advertises 0 samples
    // while holding three, and the UI ladder reads the STORED value first.
    const user = await mkUser();
    mockSessionFor(user);
    const { dataset } = await t7Corpus(user.id);
    await t7Hide(dataset.id);

    const res = await addSamples(
      jsonRequest(`http://localhost/api/datasets/${dataset.id}/samples`, 'POST', {
        samples: [{ input: 'appended under a tombstone' }],
      }),
      { params: Promise.resolve({ id: dataset.id }) }
    );
    expect(res.status).toBe(404);

    // Restoring the dataset is what makes the damage visible: while it is
    // hidden, every filtered read answers empty either way.
    await t7Unhide(dataset.id);

    const live = await db.datasetSample.findMany({
      where: { datasetId: dataset.id, ...liveSamplesOnly() },
      orderBy: { index: 'asc' },
    });
    expect(live.map((s) => s.input)).toEqual(['who wrote hamlet', 'what is 2 + 2']);

    const after = await db.dataset.findUniqueOrThrow({
      where: { id: dataset.id },
      select: { sampleCount: true },
    });
    // Was 0 before the guard landed. `2` is both the stored value and the live
    // count, which is the property `sampleCount` is supposed to have.
    expect(after.sampleCount).toBe(2);
  });

  it('PATCH /api/datasets/[id]/samples 404s on a hidden dataset and edits nothing', async () => {
    const user = await mkUser();
    mockSessionFor(user);
    const { dataset, a } = await t7Corpus(user.id);
    await t7Hide(dataset.id);

    const res = await patchSample(
      jsonRequest(`http://localhost/api/datasets/${dataset.id}/samples`, 'PATCH', {
        sampleId: a.id,
        input: 'edited under a tombstone',
      }),
      { params: Promise.resolve({ id: dataset.id }) }
    );

    expect(res.status).toBe(404);
    await expect(
      db.datasetSample.findUniqueOrThrow({ where: { id: a.id } })
    ).resolves.toMatchObject({ input: 'who wrote hamlet' });
  });

  it('DELETE /api/datasets/[id]/samples 404s on a hidden dataset and hides nothing', async () => {
    const user = await mkUser();
    mockSessionFor(user);
    const { dataset, a, b } = await t7Corpus(user.id);
    await t7Hide(dataset.id);

    const res = await callDelete(dataset.id, [a.id]);

    expect(res.status).toBe(404);
    // A surviving ROW COUNT proves nothing here: since Task 3 this verb hides
    // rather than removes, so the rows survive either way. Assert on the
    // OVERLAY — no sample tombstone was written.
    await expect(
      db.tombstone.count({ where: { datasetSampleId: { in: [a.id, b.id] } } })
    ).resolves.toBe(0);
  });

  it('PUT /api/datasets/[id]/samples 404s on a hidden dataset and replaces nothing', async () => {
    const user = await mkUser();
    mockSessionFor(user);
    const { dataset } = await t7Corpus(user.id);
    await t7Hide(dataset.id);

    const res = await callPut(dataset.id, [{ input: 'a wholly different corpus' }]);

    expect(res.status).toBe(404);
    const rows = await db.datasetSample.findMany({
      where: { datasetId: dataset.id },
      orderBy: { index: 'asc' },
    });
    expect(rows.map((s) => s.input)).toEqual(['who wrote hamlet', 'what is 2 + 2']);
  });

  it('DEFECT: PUT onto a hidden dataset used to answer replaced: 0 while writing rows — un-hiding then returned BOTH corpora', async () => {
    // The sharpest of the two, and the status code was the least of it. PUT
    // reads its outgoing set with `liveSamplesOnly()`, so under a hidden parent
    // that read came back EMPTY: nothing was tombstoned, the incoming document
    // was appended anyway above the high-water mark, `sampleCount` was written
    // as the incoming length, and the filtered response read answered `[]` —
    // an HTTP 200 saying `replaced: 0` from a handler that had just written.
    //
    // Un-hide and the corpus holds the OLD rows and the NEW ones, live, with a
    // `sampleCount` describing only the new ones. There is no un-mix: nothing
    // records which set was which.
    const user = await mkUser();
    mockSessionFor(user);
    const { dataset } = await t7Corpus(user.id);
    await t7Hide(dataset.id);

    const res = await callPut(dataset.id, [{ input: 'a wholly different corpus' }]);
    expect(res.status).toBe(404);

    // Not one outgoing row was tombstoned — which, before the guard, was true
    // of the 200 response too, and is exactly what made the mix permanent.
    await expect(
      db.tombstone.count({ where: { datasetSampleId: { not: null } } })
    ).resolves.toBe(0);

    await t7Unhide(dataset.id);

    const live = await db.datasetSample.findMany({
      where: { datasetId: dataset.id, ...liveSamplesOnly() },
      orderBy: { index: 'asc' },
    });
    // Before the guard this was the two originals PLUS 'a wholly different
    // corpus', all live, with nothing to say which was which.
    expect(live.map((s) => s.input)).toEqual(['who wrote hamlet', 'what is 2 + 2']);

    const after = await db.dataset.findUniqueOrThrow({
      where: { id: dataset.id },
      select: { sampleCount: true },
    });
    // Was 1 — the incoming length — against three live rows.
    expect(after.sampleCount).toBe(2);
  });

  it('PATCH /api/datasets/[id] 404s on a hidden dataset — you cannot rename a corpus you have deleted', async () => {
    // `requireOwnership('dataset', …)` reads UNFILTERED and is shared with
    // eight other resource types whose access-matrix tests pin that behaviour,
    // so the liveness check is explicit and local to this handler
    // (`assertDatasetLive`). Without it you can rename a corpus you have
    // already deleted — and once Task 9 filters the list and detail reads, that
    // rename lands on a row nothing returns.
    const user = await mkUser();
    mockSessionFor(user);
    const { dataset } = await t7Corpus(user.id);
    const originalName = dataset.name;
    await t7Hide(dataset.id);

    const res = await patchDataset(
      jsonRequest(`http://localhost/api/datasets/${dataset.id}`, 'PATCH', {
        name: 'renamed after deletion',
      }),
      { params: Promise.resolve({ id: dataset.id }) }
    );

    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('Dataset not found');
    await expect(
      db.dataset.findUniqueOrThrow({ where: { id: dataset.id } })
    ).resolves.toMatchObject({ name: originalName });
  });

  it('DELETE /api/datasets/[id] 404s on an ALREADY hidden dataset, and the retry writes nothing at all', async () => {
    // THE ASYMMETRY, STATED: a retried SAMPLE delete is 200-and-idempotent
    // (pinned in the Task 3 block above) because it operates on rows inside a
    // corpus that is still live and still writable. A retried DATASET delete
    // is 404 because its target IS the hidden row. Both are deliberate.
    //
    // The first delete goes through the ROUTE, not the fixture, so every value
    // asserted below is one a caller can actually produce. A fixture-written
    // `reason` would pin a string no API path emits — the handler passes a
    // hard-coded 'dataset deleted' — and the assertion would be unfalsifiable
    // by anything a user could do.
    const user = await mkUser();
    mockSessionFor(user);
    const { dataset } = await t7Corpus(user.id);

    const first = await deleteDataset(
      new Request(`http://localhost/api/datasets/${dataset.id}`, { method: 'DELETE' }),
      { params: Promise.resolve({ id: dataset.id }) }
    );
    expect(first.status).toBe(200);
    const afterFirst = await db.tombstone.findUniqueOrThrow({
      where: { datasetId: dataset.id },
    });
    expect(afterFirst.isTombstone).toBe(true);
    expect(afterFirst.reason).toBe('dataset deleted');

    const second = await deleteDataset(
      new Request(`http://localhost/api/datasets/${dataset.id}`, { method: 'DELETE' }),
      { params: Promise.resolve({ id: dataset.id }) }
    );
    expect(second.status).toBe(404);

    // The retry wrote NOTHING: the whole row is exactly what the first delete
    // left, `updatedAt` included. That column is what makes this observable at
    // all — `tombstoneDataset`'s upsert writes `isTombstone` and `reason` to
    // the values they already hold, so on every OTHER column a second upsert
    // is indistinguishable from no upsert. `Tombstone.updatedAt` is
    // `@updatedAt`, so it moves on any update whether or not a value changed.
    const afterSecond = await db.tombstone.findUniqueOrThrow({
      where: { datasetId: dataset.id },
    });
    expect(afterSecond).toEqual(afterFirst);
    await expect(db.tombstone.count({ where: { datasetId: dataset.id } })).resolves.toBe(1);
  });

  it('POST /api/golden-sets 404s over a hidden corpus — nothing is minted onto rows Restrict then pins forever', async () => {
    // The corpus is PLATFORM-OWNED and public, so every OTHER check in the
    // route passes. Unfiltered, this request returns 201 and writes two
    // GoldenItems whose `sourceDatasetSampleId` is `onDelete: Restrict` — an
    // unreleasable pin on a corpus its owner has already hidden.
    const platform = await db.user.create({
      data: { email: PLATFORM_OWNER_EMAIL, passwordHash: 'fixture-hash' },
    });
    const { dataset } = await t7Corpus(platform.id);
    await t7Hide(dataset.id);

    const importer = await mkUser();
    mockSessionFor(importer);

    const res = await createGoldenSet(
      jsonRequest('http://localhost/api/golden-sets', 'POST', {
        datasetId: dataset.id,
        protocol: 'pairwise',
        name: 'Minted from a hidden corpus',
      })
    );

    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('Dataset not found');
    await expect(db.goldenSet.count()).resolves.toBe(0);
    await expect(db.goldenItem.count()).resolves.toBe(0);
  });

  it('POST /api/datasets/[id]/versions 404s on a hidden parent and forks nothing', async () => {
    const user = await mkUser();
    mockSessionFor(user);
    const { dataset } = await t7Corpus(user.id);
    await t7Hide(dataset.id);

    const res = await createVersion(
      jsonRequest(`http://localhost/api/datasets/${dataset.id}/versions`, 'POST', {}),
      { params: Promise.resolve({ id: dataset.id }) }
    );

    expect(res.status).toBe(404);
    // Unfiltered this mints a CHILD dataset carrying a live copy of the corpus,
    // which is a hidden dataset walking back into circulation under a new id.
    await expect(db.dataset.count()).resolves.toBe(1);
  });

  it('GET /api/datasets/[id]/versions 404s on a hidden dataset', async () => {
    // The one guard in the nine that gates a READ rather than a write, and it
    // is in the list for a reason: without it the version ladder of a hidden
    // corpus stays enumerable — id, version, sampleCount and timestamps for
    // every sibling — to anyone, since this route is `optionalAuth` and the
    // fixture is public. The list is served by the same handler whose POST
    // twin above must 404, so leaving them disagreeing about whether the
    // dataset exists is its own bug.
    const user = await mkUser();
    const { dataset } = await t7Corpus(user.id);
    await t7Hide(dataset.id);

    const res = await listVersions(
      new Request(`http://localhost/api/datasets/${dataset.id}/versions`),
      { params: Promise.resolve({ id: dataset.id }) }
    );

    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('Dataset not found');
  });

  it('POST /api/datasets/[id]/refresh 404s on a hidden dataset BEFORE it reaches the source check', async () => {
    // The discrimination is the whole test, and it needs no HuggingFace mock:
    // the fixture is `source: 'local'`, so an unfiltered guard read falls
    // through to `Only remote HuggingFace datasets can be refreshed` — a 400.
    // A filtered one answers 404 first. 400 vs 404 is exactly the difference
    // between "this dataset exists and cannot be refreshed" and "this dataset
    // is gone", and refresh PERSISTS a new sampleCount and new remote
    // metadata, so it is a write.
    const user = await mkUser();
    mockSessionFor(user);
    const { dataset } = await t7Corpus(user.id);
    await t7Hide(dataset.id);

    const res = await refreshDataset(
      new Request(`http://localhost/api/datasets/${dataset.id}/refresh`, { method: 'POST' }),
      { params: Promise.resolve({ id: dataset.id }) }
    );

    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('Dataset not found');
  });

  it('GET /api/datasets/[id]/export 404s on a hidden dataset', async () => {
    // No session is mocked: this route is `optionalAuth` and serves public
    // datasets to anonymous callers, which is exactly why it must stop serving
    // a corpus its owner has hidden.
    const user = await mkUser();
    const { dataset } = await t7Corpus(user.id);
    await t7Hide(dataset.id);

    const res = await exportDataset(
      new Request(`http://localhost/api/datasets/${dataset.id}/export?format=csv`),
      { params: Promise.resolve({ id: dataset.id }) }
    );

    expect(res.status).toBe(404);
  });

  it('an isTombstone: false row leaves the dataset OPEN to writes — the filter is `NOT`, not `{ tombstone: { is: null } }`', async () => {
    // Vacuity shape 2. Every other test in this block uses an
    // `isTombstone: true` fixture, so a filter written as the simpler
    // `{ tombstone: { is: null } }` passes all of them — and leaves an
    // un-deleted dataset closed to writes forever, with no way back. Only a
    // Tombstone row that EXISTS and says `false` separates the two.
    const user = await mkUser();
    mockSessionFor(user);
    const { dataset } = await t7Corpus(user.id);
    await db.tombstone.create({
      data: { datasetId: dataset.id, isTombstone: false },
    });

    const res = await addSamples(
      jsonRequest(`http://localhost/api/datasets/${dataset.id}/samples`, 'POST', {
        samples: [{ input: 'a third question' }],
      }),
      { params: Promise.resolve({ id: dataset.id }) }
    );

    expect(res.status).toBe(201);
    await expect(
      db.datasetSample.count({ where: { datasetId: dataset.id } })
    ).resolves.toBe(3);
  });

  it('an un-hidden platform corpus can still be imported into a golden set', async () => {
    // The other half of shape 2, on the path that matters most: restoring the
    // dataset must restore the import, not merely stop 404ing the list page.
    const platform = await db.user.create({
      data: { email: PLATFORM_OWNER_EMAIL, passwordHash: 'fixture-hash' },
    });
    const { dataset } = await t7Corpus(platform.id);
    await db.tombstone.create({
      data: { datasetId: dataset.id, isTombstone: false },
    });

    const importer = await mkUser();
    mockSessionFor(importer);

    const res = await createGoldenSet(
      jsonRequest('http://localhost/api/golden-sets', 'POST', {
        datasetId: dataset.id,
        protocol: 'pairwise',
        name: 'Restored corpus import',
      })
    );

    expect(res.status).toBe(201);
    await expect(db.goldenItem.count()).resolves.toBe(2);
  });
});

// ─── A1 Task 8: the sample read sweep ───────────────────────────────────────
// Ten filtered sample reads, one test each. The fixture below hides the MIDDLE
// row of three, not the tail, so a read that merely TRUNCATES (a stray `take`,
// a wrong `orderBy`) can never be mistaken for a read that filters.
//
// TWO OF THE TEN ARE NOT LEAKS.
//   versions/route.ts RESURRECTS. The overlay is keyed on row id and the child
//   version's rows are `create`d fresh, so they are born untombstoned — an
//   unfiltered copy does not show a hidden sample in the new version, it
//   promotes it back to a permanently live row and leaves the only record of
//   the hide behind on the parent.
//   config/import/route.ts MISBINDS. It builds `sampleIdByInput` in `index`
//   order keeping the FIRST hit, so a hidden row at a low index shadows a
//   perfectly good live duplicate at a higher one and the imported golden item
//   binds to the dead row — through `GoldenItem.sourceDatasetSampleId`, which
//   is `onDelete: Restrict`, permanently.
//
// TWO SAMPLE READS STAY UNFILTERED and are not this block's to change; both
// already say why in place (samples/route.ts). The POST high-water `_count`
// must see hidden rows or a new append reuses an ordinal a hidden row still
// holds and violates @@unique([datasetId, index]); the DELETE membership
// lookup must accept an already-hidden id so a retried delete converges on
// hidden instead of 400ing that the id is foreign. Both are pinned by the
// Task 3 and Task 4 blocks above, which is what keeps the sweep honest: a
// later hand that "completes" it by filtering them turns those tests red.
describe('the sample read sweep: a hidden sample is invisible to every filtered read (A1 Task 8)', () => {
  beforeEach(async () => {
    await truncateAll();
    (getServerSession as unknown as Mock).mockReset();
  });

  /** Three pairwise-shaped samples, the MIDDLE one tombstoned. */
  async function t8CorpusWithHiddenMiddle(userId: string, projectId?: string) {
    fixtureCounter += 1;
    const dataset = await db.dataset.create({
      data: {
        name: `t8-corpus-${fixtureCounter}`,
        userId,
        projectId,
        source: 'local',
        visibility: 'public',
        inputType: 'query-response',
        sampleCount: 3,
      },
    });
    const mk = (index: number, input: string) =>
      db.datasetSample.create({
        data: {
          datasetId: dataset.id,
          index,
          input,
          expected: index % 2 === 0 ? 'A>B' : 'B>A',
          metadata: JSON.stringify({ response_A: `A-${index}`, response_B: `B-${index}` }),
        },
      });
    const live0 = await mk(0, 't8-live-0');
    const hidden1 = await mk(1, 't8-hidden-1');
    const live2 = await mk(2, 't8-live-2');
    await db.tombstone.create({
      data: { datasetSampleId: hidden1.id, isTombstone: true, reason: 'a bad row' },
    });
    return { dataset, live0, hidden1, live2 };
  }

  it('version-create copies only the LIVE rows — unfiltered it silently RESURRECTS every hidden sample', async () => {
    // A version test over a tombstone-free parent passes unfiltered and proves
    // nothing, which is why this fixture tombstones a parent row BEFORE the
    // fork.
    //
    // And the harm is worse than a leak. The overlay is keyed on ROW ID, and
    // the child's rows are created fresh — so they are born untombstoned. An
    // unfiltered copy promotes the hidden row back to permanently live in the
    // new version, leaving the only record of the hide behind on the parent.
    const user = await mkUser();
    mockSessionFor(user);
    const { dataset } = await t8CorpusWithHiddenMiddle(user.id);

    const res = await createVersion(
      jsonRequest(`http://localhost/api/datasets/${dataset.id}/versions`, 'POST', {}),
      { params: Promise.resolve({ id: dataset.id }) }
    );
    expect(res.status).toBe(201);
    const child = await res.json();

    expect(child.samples.map((s: { input: string }) => s.input)).toEqual([
      't8-live-0',
      't8-live-2',
    ]);
    // createDatasetVersion re-packs to 0..n-1 and stores the same length, so a
    // filtered copy leaves the child dense and its stored count truthful.
    expect(child.samples.map((s: { index: number }) => s.index)).toEqual([0, 1]);
    expect(child.sampleCount).toBe(2);
    // Nothing in the child is tombstoned — which is precisely why the PARENT's
    // filter is the only thing between a hidden row and a live one.
    await expect(
      db.tombstone.count({ where: { datasetSample: { is: { datasetId: child.id } } } })
    ).resolves.toBe(0);
  });

  it('PATCH /api/datasets/[id]/samples 404s on a hidden sample instead of silently editing it', async () => {
    const user = await mkUser();
    mockSessionFor(user);
    const { dataset, hidden1 } = await t8CorpusWithHiddenMiddle(user.id);

    const res = await patchSample(
      jsonRequest(`http://localhost/api/datasets/${dataset.id}/samples`, 'PATCH', {
        sampleId: hidden1.id,
        input: 'edited a hidden row',
      }),
      { params: Promise.resolve({ id: dataset.id }) }
    );

    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('Sample not found in this dataset');
    // 404-and-write is the worse bug: assert the row, not just the status.
    await expect(
      db.datasetSample.findUniqueOrThrow({ where: { id: hidden1.id } })
    ).resolves.toMatchObject({ input: 't8-hidden-1' });
  });

  it('GET /api/datasets/[id] embeds the live samples only — and an UN-hidden row comes back', async () => {
    // Vacuity shape 2. With only `isTombstone: true` fixtures, a filter written
    // as `{ tombstone: { is: null } }` passes every other test in this block
    // while permanently hiding restored rows. The row carrying an
    // `isTombstone: false` tombstone is the only fixture that separates the two
    // formulations — and it must be VISIBLE.
    const user = await mkUser();
    mockSessionFor(user);
    const { dataset, live2 } = await t8CorpusWithHiddenMiddle(user.id);
    await db.tombstone.create({
      data: { datasetSampleId: live2.id, isTombstone: false },
    });

    const res = await getDataset(
      new Request(`http://localhost/api/datasets/${dataset.id}`),
      { params: Promise.resolve({ id: dataset.id }) }
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.samples.map((s: { input: string }) => s.input)).toEqual([
      't8-live-0',
      't8-live-2',
    ]);
  });

  it('POST /api/golden-sets imports the live rows only — a hidden row must not become a golden item', async () => {
    const platform = await db.user.create({
      data: { email: PLATFORM_OWNER_EMAIL, passwordHash: 'fixture-hash' },
    });
    const { dataset, hidden1 } = await t8CorpusWithHiddenMiddle(platform.id);
    const importer = await mkUser();
    mockSessionFor(importer);

    const res = await createGoldenSet(
      jsonRequest('http://localhost/api/golden-sets', 'POST', {
        datasetId: dataset.id,
        protocol: 'pairwise',
        name: 'Live rows only',
      })
    );
    expect(res.status).toBe(201);
    const body = await res.json();

    expect(body._count.items).toBe(2);
    const items = await db.goldenItem.findMany({
      where: { goldenSetId: body.id },
      orderBy: { index: 'asc' },
    });
    expect(items.map((i) => i.inputText)).toEqual(['t8-live-0', 't8-live-2']);
    // The pin is the harm, not the row count: sourceDatasetSampleId is
    // `onDelete: Restrict`, so a single item on the hidden row holds it forever.
    expect(items.map((i) => i.sourceDatasetSampleId)).not.toContain(hidden1.id);
  });

  it('GET /api/datasets/[id]/export leaves the hidden row out of the CSV', async () => {
    // Anonymous, on a public dataset: this route serves the document to callers
    // with no session, so a hidden row leaking here leaks furthest.
    const user = await mkUser();
    const { dataset } = await t8CorpusWithHiddenMiddle(user.id);

    const res = await exportDataset(
      new Request(`http://localhost/api/datasets/${dataset.id}/export?format=csv`),
      { params: Promise.resolve({ id: dataset.id }) }
    );
    expect(res.status).toBe(200);
    const csv = await res.text();

    expect(csv).toContain('t8-live-0');
    expect(csv).toContain('t8-live-2');
    expect(csv).not.toContain('t8-hidden-1');
  });

  it('GET /api/config/export?includeSamples=true carries what the instance SHOWS, not what its tables hold', async () => {
    // The config document is a portable VIEW of the instance. A hidden row in
    // it is worse than a leak on a page: re-import it anywhere and the row is
    // live again, on a fresh id, with no tombstone and nothing recording that
    // it was ever withdrawn.
    const user = await mkUser();
    mockSessionFor(user);
    await t8CorpusWithHiddenMiddle(user.id);

    const res = await exportConfig(
      new Request('http://localhost/api/config/export?include=datasets&includeSamples=true')
    );
    expect(res.status).toBe(200);
    const yaml = await res.text();

    expect(yaml).toContain('t8-live-0');
    expect(yaml).toContain('t8-live-2');
    expect(yaml).not.toContain('t8-hidden-1');
  });

  it('POST /api/evaluations batch creates one evaluation per LIVE sample, never one for a withdrawn row', async () => {
    // Unfiltered, every batch run scores rows the owner has already withdrawn,
    // and the results look like ordinary judgments — indistinguishable, after
    // the fact, from judgments on rows that were meant to be scored.
    const user = await mkUser();
    mockSessionFor(user);
    const project = await db.project.create({ data: { name: 't8-project', userId: user.id } });
    const { dataset, hidden1 } = await t8CorpusWithHiddenMiddle(user.id);

    const res = await createEvaluations(
      jsonRequest('http://localhost/api/evaluations', 'POST', {
        projectId: project.id,
        datasetId: dataset.id,
        // Explicit empty selection: the route treats `undefined` as "use my
        // verified endpoints", and this file configures none.
        judgeModelVersionIds: [],
      })
    );
    expect(res.status).toBe(201);
    expect((await res.json()).evaluationsCreated).toBe(2);

    const evaluations = await db.evaluation.findMany({
      where: { datasetId: dataset.id },
      select: { datasetSampleId: true, promptText: true },
    });
    expect(evaluations.map((e) => e.promptText).sort()).toEqual(['t8-live-0', 't8-live-2']);
    expect(evaluations.map((e) => e.datasetSampleId)).not.toContain(hidden1.id);
  });

  it('GET /api/projects/[id]/export?scope=datasets leaves the hidden row out', async () => {
    const user = await mkUser();
    mockSessionFor(user);
    const project = await db.project.create({ data: { name: 't8-project-ds', userId: user.id } });
    await t8CorpusWithHiddenMiddle(user.id, project.id);

    const res = await exportProject(
      new Request(
        `http://localhost/api/projects/${project.id}/export?scope=datasets&format=csv`
      ),
      { params: Promise.resolve({ id: project.id }) }
    );
    expect(res.status).toBe(200);
    const csv = await res.text();

    expect(csv).toContain('t8-live-0');
    expect(csv).toContain('t8-live-2');
    expect(csv).not.toContain('t8-hidden-1');
  });

  it('GET /api/projects/[id]/export?scope=all&format=jsonl leaves the hidden row out — the SECOND read in that file', async () => {
    // Its own test rather than a second assertion on the one above: the two
    // reads in projects/[id]/export are textually identical apart from
    // indentation and sit in different branches (`scope=all` JSONL vs
    // `scope=datasets`), so filtering one and not the other is invisible to a
    // test that only exercises one branch.
    const user = await mkUser();
    mockSessionFor(user);
    const project = await db.project.create({ data: { name: 't8-project-all', userId: user.id } });
    await t8CorpusWithHiddenMiddle(user.id, project.id);

    const res = await exportProject(
      new Request(`http://localhost/api/projects/${project.id}/export?scope=all&format=jsonl`),
      { params: Promise.resolve({ id: project.id }) }
    );
    expect(res.status).toBe(200);
    const jsonl = await res.text();

    expect(jsonl).toContain('t8-live-0');
    expect(jsonl).toContain('t8-live-2');
    expect(jsonl).not.toContain('t8-hidden-1');
  });

  it('a config import binds its golden item to the LIVE duplicate, never to the hidden row at the lower index', async () => {
    // The importer builds `sampleIdByInput` in `index` order and keeps the
    // FIRST hit per inputText. This fixture puts the hidden row at index 0 and
    // its live twin at index 1, so unfiltered the item binds to the DEAD row —
    // through `onDelete: Restrict`, permanently. A fixture with the duplicate
    // at a LOWER index than the hidden row passes unfiltered and proves nothing.
    const user = await mkUser();
    mockSessionFor(user);
    const dataset = await db.dataset.create({
      data: {
        name: 't8-duplicate-corpus',
        slug: 't8-dup-corpus',
        userId: user.id,
        source: 'local',
        visibility: 'private',
        inputType: 'query-response',
        sampleCount: 2,
      },
    });
    const dead = await db.datasetSample.create({
      data: { datasetId: dataset.id, index: 0, input: 'who wrote hamlet', expected: 'A>B' },
    });
    const alive = await db.datasetSample.create({
      data: { datasetId: dataset.id, index: 1, input: 'who wrote hamlet', expected: 'A>B' },
    });
    await db.tombstone.create({
      data: { datasetSampleId: dead.id, isTombstone: true, reason: 'a bad row' },
    });

    const doc = {
      version: '1.0',
      exportedAt: '2026-08-14T00:00:00.000Z',
      goldenSets: [
        {
          slug: 't8-gs-dup',
          name: 'Duplicate resolution',
          visibility: 'private',
          protocol: 'pairwise',
          datasetSlug: 't8-dup-corpus',
          version: 1,
          items: [
            {
              index: 0,
              inputText: 'who wrote hamlet',
              expected: 'A>B',
              candidates: [
                { position: 0, responseText: 'shakespeare' },
                { position: 1, responseText: 'bacon' },
              ],
            },
          ],
        },
      ],
    };

    const res = await importConfig(
      new Request('http://localhost/api/config/import?dryRun=false', {
        method: 'POST',
        body: JSON.stringify(doc),
        headers: { 'content-type': 'application/json' },
      })
    );
    expect(res.status).toBe(200);
    // Asserted so a resolution failure reads as "skipped" rather than as a
    // silent zero-row query further down.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const diff = (await res.json()).items.find((i: any) => i.type === 'goldenSet');
    expect(diff.action).toBe('create');

    const item = await db.goldenItem.findFirstOrThrow({
      where: { goldenSet: { slug: 't8-gs-dup' } },
    });
    expect(item.sourceDatasetSampleId).toBe(alive.id);
    expect(item.sourceDatasetSampleId).not.toBe(dead.id);
  });
});
