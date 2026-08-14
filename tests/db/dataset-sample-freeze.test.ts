import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { getServerSession } from 'next-auth';
import { db, truncateAll, mkUser } from './helpers';
import { PUT, DELETE as deleteSamples } from '@/app/api/datasets/[id]/samples/route';
import { DELETE as deleteDataset } from '@/app/api/datasets/[id]/route';
import { liveDatasetsOnly, liveSamplesOnly } from '@/lib/tombstones';

// A0 Task 1. GoldenItem.sourceDatasetSampleId is `onDelete: Restrict`, so the
// moment 20260812190000_v2d_golden_substrate lands, PUT /api/datasets/[id]/samples
// — which deletes every sample and recreates them with new ids — starts failing
// on any dataset a golden set has annotated. That failure is INTENDED (a corpus
// somebody has annotated must not drift under the annotation), but it must be a
// deliberate 409 naming the pinning sets, not a raw P2003 surfacing as a 500.
//
// FINAL-WAVE FIX (M1): the guard existed on exactly ONE of the four
// destructive paths. `GoldenSet.datasetId` and `GoldenItem.sourceDatasetSampleId`
// are BOTH `onDelete: Restrict`, so DELETE /api/datasets/[id]/samples, DELETE
// /api/datasets/[id] and the config importer's sample replace each surfaced a
// raw P2003 as a generic 500. All four now share ONE predicate,
// `findGoldenSetsPinningDataset` (src/lib/golden-sets.ts).

vi.mock('next-auth', () => ({ getServerSession: vi.fn() }));
vi.mock('next/headers', () => ({ headers: vi.fn(async () => new Headers()) }));

// Same fake, same reason, as tests/db/access-matrix.test.ts:78-98: requireAuth()
// hits a REAL Redis sliding window keyed by client IP (always '127.0.0.1'
// here), and `fileParallelism: false` makes that 120/min budget shared by every
// file in one `npm run test:db` run. This file drives three route handlers per
// test now rather than one.
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

/** A dataset with one sample, owned by `userId`. */
async function mkDatasetWithSample(userId: string) {
  fixtureCounter += 1;
  const dataset = await db.dataset.create({
    data: {
      name: `freeze-fixture-dataset-${fixtureCounter}`,
      userId,
      source: 'local',
      visibility: 'public',
      sampleCount: 1,
    },
  });
  const sample = await db.datasetSample.create({
    data: { datasetId: dataset.id, index: 0, input: 'the question', expected: 'A>B' },
  });
  return { dataset, sample };
}

/** A GoldenSet over `datasetId` whose single item sources `sampleId`. */
async function mkGoldenSetOver(
  ownerId: string,
  datasetId: string,
  sampleId: string,
  name: string
) {
  fixtureCounter += 1;
  return db.goldenSet.create({
    data: {
      name,
      slug: `freeze-fixture-golden-${fixtureCounter}`,
      ownerId,
      datasetId,
      protocol: 'pairwise',
      items: {
        create: [
          {
            index: 0,
            inputText: 'the question',
            protocol: 'pairwise',
            expected: 'A>B',
            sourceSample: { connect: { id: sampleId } },
          },
        ],
      },
    },
  });
}

describe('PUT /api/datasets/[id]/samples — golden-set freeze guard (A0 Task 1)', () => {
  beforeEach(async () => {
    await truncateAll();
    (getServerSession as unknown as Mock).mockReset();
  });

  it('409s naming every pinning golden set, and leaves the corpus untouched', async () => {
    const user = await mkUser();
    mockSessionFor(user);
    const { dataset, sample } = await mkDatasetWithSample(user.id);
    await mkGoldenSetOver(user.id, dataset.id, sample.id, 'Alpha golden set');
    await mkGoldenSetOver(user.id, dataset.id, sample.id, 'Beta golden set');

    const res = await PUT(
      jsonRequest(`http://localhost/api/datasets/${dataset.id}/samples`, 'PUT', {
        samples: [{ input: 'replacement' }],
      }),
      { params: Promise.resolve({ id: dataset.id }) }
    );

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain('Alpha golden set');
    expect(body.error).toContain('Beta golden set');
    expect(body.goldenSets).toHaveLength(2);

    // The guard refuses BEFORE the transaction — no sample was deleted and no
    // id was reminted, so no golden item is left pointing at a vanished row.
    const survived = await db.datasetSample.findMany({ where: { datasetId: dataset.id } });
    expect(survived).toHaveLength(1);
    expect(survived[0].id).toBe(sample.id);
    expect(survived[0].input).toBe('the question');
  });

  it('still replaces samples when no golden set pins the dataset — by HIDING the outgoing row, not destroying it', async () => {
    const user = await mkUser();
    mockSessionFor(user);
    const { dataset, sample } = await mkDatasetWithSample(user.id);

    const res = await PUT(
      jsonRequest(`http://localhost/api/datasets/${dataset.id}/samples`, 'PUT', {
        samples: [{ input: 'replacement' }],
      }),
      { params: Promise.resolve({ id: dataset.id }) }
    );

    expect(res.status).toBe(200);
    const body = await res.json();

    // The response read is FILTERED. Unfiltered it answers with the row it
    // just hid: `replaced: 2` over a one-row corpus, and a hidden row handed
    // back to the client as though it were live.
    expect(body.replaced).toBe(1);
    expect(body.samples).toHaveLength(1);
    expect(body.samples[0].input).toBe('replacement');
    expect(body.samples[0].id).not.toBe(sample.id);

    // …and nothing was destroyed. The old assertion here was
    // `expect(rows).toHaveLength(1)`, which passes under a hard delete — the
    // exact behaviour this task removes — so it is inverted rather than
    // adjusted: 2 rows on disk, one of them the ORIGINAL id, which is the id
    // any golden item would cite.
    const rows = await db.datasetSample.findMany({
      where: { datasetId: dataset.id },
      orderBy: { index: 'asc' },
    });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.id)).toContain(sample.id);
    // Appended ABOVE the high-water mark: index 1, not 0. Recreating at 0
    // collides with the hidden row that still holds 0 (@@unique([datasetId,
    // index]), prisma/schema.prisma).
    expect(rows.map((r) => r.index)).toEqual([0, 1]);
    expect(rows[1].input).toBe('replacement');

    const tomb = await db.tombstone.findUnique({ where: { datasetSampleId: sample.id } });
    expect(tomb?.isTombstone).toBe(true);

    // `sampleCount` is a LIVE count and is already correct here: after
    // tombstone-and-append the live set IS the incoming document.
    const after = await db.dataset.findUnique({
      where: { id: dataset.id },
      select: { sampleCount: true },
    });
    expect(after?.sampleCount).toBe(1);
  });

  it('a golden set over a DIFFERENT dataset does not block this one', async () => {
    const user = await mkUser();
    mockSessionFor(user);
    const target = await mkDatasetWithSample(user.id);
    const other = await mkDatasetWithSample(user.id);
    await mkGoldenSetOver(user.id, other.dataset.id, other.sample.id, 'Unrelated golden set');

    const res = await PUT(
      jsonRequest(`http://localhost/api/datasets/${target.dataset.id}/samples`, 'PUT', {
        samples: [{ input: 'replacement' }],
      }),
      { params: Promise.resolve({ id: target.dataset.id }) }
    );

    expect(res.status).toBe(200);
  });

  it('a TOMBSTONED golden item still pins the dataset — the FK does not care that the row is dead', async () => {
    // This is the one golden-item read path that must stay unfiltered.
    // GoldenItem.sourceDatasetSampleId is `onDelete: Restrict` and a
    // tombstoned row still holds that FK, so Postgres will still refuse the
    // sample delete. Sweep a `tombstonedAt: null` through this query and the
    // guard reports "not pinned", the PUT proceeds, and Postgres raises a
    // bare P2003 that the catch reports as a 500 — a worse failure than the
    // one this guard exists to prevent.
    const owner = await mkUser();
    const { dataset, sample } = await mkDatasetWithSample(owner.id);
    const goldenSet = await mkGoldenSetOver(owner.id, dataset.id, sample.id, 'pinning set');
    await db.goldenItem.updateMany({
      where: { goldenSetId: goldenSet.id },
      data: { tombstonedAt: new Date() },
    });

    mockSessionFor(owner);
    const res = await PUT(
      jsonRequest(`http://localhost/api/datasets/${dataset.id}/samples`, 'PUT', {
        samples: [{ input: 'a replacement question', expected: 'B>A' }],
      }),
      { params: Promise.resolve({ id: dataset.id }) }
    );

    expect(res.status).toBe(409);
    expect((await res.json()).goldenSets).toEqual([{ id: goldenSet.id, name: 'pinning set' }]);
    await expect(db.datasetSample.count({ where: { datasetId: dataset.id } })).resolves.toBe(1);
  });
});

// ─── M1: the same guard on the OTHER destructive paths ──────────────────────
// The PUT above was guarded when the migration landed; the three paths below
// were not, and every one of them destroys rows an `onDelete: Restrict` FK is
// holding. Each test asserts the 409 AND that the rows survived — a guard that
// answers 409 after the damage is done would pass the status assertion alone.
describe('the other destructive paths onto a golden-set-pinned corpus (M1)', () => {
  beforeEach(async () => {
    await truncateAll();
    (getServerSession as unknown as Mock).mockReset();
  });

  it('DELETE /api/datasets/[id]/samples 409s naming the pinning sets, instead of a bare P2003 in a 500', async () => {
    const user = await mkUser();
    mockSessionFor(user);
    const { dataset, sample } = await mkDatasetWithSample(user.id);
    const pinning = await mkGoldenSetOver(user.id, dataset.id, sample.id, 'Alpha golden set');

    const res = await deleteSamples(
      jsonRequest(`http://localhost/api/datasets/${dataset.id}/samples`, 'DELETE', {
        sampleIds: [sample.id],
      }),
      { params: Promise.resolve({ id: dataset.id }) }
    );

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain('Alpha golden set');
    expect(body.goldenSets).toEqual([{ id: pinning.id, name: 'Alpha golden set' }]);
    // The sample is still there and still carries the id the golden item cites.
    const survived = await db.datasetSample.findMany({ where: { datasetId: dataset.id } });
    expect(survived.map((s) => s.id)).toEqual([sample.id]);
  });

  it('DELETE /api/datasets/[id]/samples HIDES the sample when nothing pins the dataset', async () => {
    const user = await mkUser();
    mockSessionFor(user);
    const { dataset, sample } = await mkDatasetWithSample(user.id);

    const res = await deleteSamples(
      jsonRequest(`http://localhost/api/datasets/${dataset.id}/samples`, 'DELETE', {
        sampleIds: [sample.id],
      }),
      { params: Promise.resolve({ id: dataset.id }) }
    );

    expect(res.status).toBe(200);
    // `deleted` became `tombstoned` — nothing is deleted here any more, and a
    // key called `deleted` is the one word that would let a caller conclude
    // the row is gone. Same rename A0 made on the sibling endpoint
    // (src/app/api/golden-sets/[id]/items/route.ts:313).
    expect(await res.json()).toEqual({ tombstoned: 1, remaining: 0 });

    // The old assertion here was `count()` → 0. It is inverted rather than
    // adjusted: the row survives, carrying the id any golden item would cite,
    // and it is the Tombstone row that makes it invisible.
    await expect(db.datasetSample.count({ where: { datasetId: dataset.id } })).resolves.toBe(1);
    const tomb = await db.tombstone.findUnique({ where: { datasetSampleId: sample.id } });
    expect(tomb?.isTombstone).toBe(true);

    // `sampleCount` is a live count, and the response body reads the same
    // value — they move together.
    const after = await db.dataset.findUnique({
      where: { id: dataset.id },
      select: { sampleCount: true },
    });
    expect(after?.sampleCount).toBe(0);
  });

  it('DELETE /api/datasets/[id] 409s naming the pinning sets, and the dataset survives', async () => {
    const user = await mkUser();
    mockSessionFor(user);
    const { dataset, sample } = await mkDatasetWithSample(user.id);
    await mkGoldenSetOver(user.id, dataset.id, sample.id, 'Alpha golden set');
    await mkGoldenSetOver(user.id, dataset.id, sample.id, 'Beta golden set');

    const res = await deleteDataset(
      new Request(`http://localhost/api/datasets/${dataset.id}`, { method: 'DELETE' }),
      { params: Promise.resolve({ id: dataset.id }) }
    );

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain('Alpha golden set');
    expect(body.error).toContain('Beta golden set');
    expect(body.goldenSets).toHaveLength(2);
    await expect(db.dataset.count({ where: { id: dataset.id } })).resolves.toBe(1);
  });

  it('DELETE /api/datasets/[id] HIDES an unpinned dataset instead of destroying it', async () => {
    const user = await mkUser();
    mockSessionFor(user);
    const { dataset, sample } = await mkDatasetWithSample(user.id);

    const res = await deleteDataset(
      new Request(`http://localhost/api/datasets/${dataset.id}`, { method: 'DELETE' }),
      { params: Promise.resolve({ id: dataset.id }) }
    );

    expect(res.status).toBe(200);

    // The old assertion here was `count()` → 0. A tombstone can never satisfy
    // it, and it passed for the wrong reason anyway: it is equally satisfied
    // by cascading an annotated corpus away.
    await expect(db.dataset.count({ where: { id: dataset.id } })).resolves.toBe(1);
    const tomb = await db.tombstone.findUnique({ where: { datasetId: dataset.id } });
    expect(tomb?.isTombstone).toBe(true);

    // …and it is hidden, by the one definition of hidden.
    await expect(
      db.dataset.findMany({ where: { id: dataset.id, ...liveDatasetsOnly() } })
    ).resolves.toEqual([]);

    // Decision 16: the samples are NOT tombstoned one by one. They survive on
    // disk untouched — no cascade, because nothing was deleted — and they are
    // hidden by INHERITANCE, through liveSamplesOnly()'s `dataset:` clause.
    // Asserting only the empty live read would pass under a per-sample loop
    // too, so the zero-sample-tombstones half is pinned as well.
    await expect(db.datasetSample.count({ where: { datasetId: dataset.id } })).resolves.toBe(1);
    await expect(
      db.tombstone.count({ where: { datasetSampleId: { not: null } } })
    ).resolves.toBe(0);
    await expect(
      db.datasetSample.findMany({ where: { datasetId: dataset.id, ...liveSamplesOnly() } })
    ).resolves.toEqual([]);

    // The row a golden item's `Restrict` FK would cite is still there and
    // still addressable by id. That is the whole point of the overlay.
    await expect(
      db.datasetSample.findUnique({ where: { id: sample.id } })
    ).resolves.not.toBeNull();

    // NOT ASSERTED HERE, on purpose: that a hidden dataset stops appearing in
    // GET /api/datasets. That read is swept by the dataset read sweep later in
    // this plan, and asserting it now would fail for a reason this task cannot
    // fix. This task pins the row state and the overlay row; the sweep pins
    // the route.
  });

  it('a golden set with NO items still blocks the dataset delete — GoldenSet.datasetId is the other Restrict FK', async () => {
    // The item-level FK is not the only one. `GoldenSet.datasetId` is
    // `onDelete: Restrict` too, so a set that declares itself the annotation
    // layer over this corpus blocks the delete even with zero items — and the
    // config importer can create exactly that (`items` defaults to `[]` in
    // configDocumentSchema). A pin predicate that only looked at items would
    // report "not pinned" here and hand the caller a 500.
    const user = await mkUser();
    mockSessionFor(user);
    const { dataset } = await mkDatasetWithSample(user.id);
    const empty = await db.goldenSet.create({
      data: {
        name: 'Empty golden set',
        slug: 'empty-golden-set',
        ownerId: user.id,
        datasetId: dataset.id,
        protocol: 'pairwise',
      },
    });

    const res = await deleteDataset(
      new Request(`http://localhost/api/datasets/${dataset.id}`, { method: 'DELETE' }),
      { params: Promise.resolve({ id: dataset.id }) }
    );

    expect(res.status).toBe(409);
    expect((await res.json()).goldenSets).toEqual([{ id: empty.id, name: 'Empty golden set' }]);
    await expect(db.dataset.count({ where: { id: dataset.id } })).resolves.toBe(1);
  });
});
