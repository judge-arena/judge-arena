import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { getServerSession } from 'next-auth';
import { db, truncateAll, mkUser } from './helpers';
import { PUT } from '@/app/api/datasets/[id]/samples/route';

// A0 Task 1. GoldenItem.sourceDatasetSampleId is `onDelete: Restrict`, so the
// moment 20260812190000_v2d_golden_substrate lands, PUT /api/datasets/[id]/samples
// — which deletes every sample and recreates them with new ids — starts failing
// on any dataset a golden set has annotated. That failure is INTENDED (a corpus
// somebody has annotated must not drift under the annotation), but it must be a
// deliberate 409 naming the pinning sets, not a raw P2003 surfacing as a 500.

vi.mock('next-auth', () => ({ getServerSession: vi.fn() }));
vi.mock('next/headers', () => ({ headers: vi.fn(async () => new Headers()) }));

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

  it('still replaces samples when no golden set pins the dataset', async () => {
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
    expect(body.replaced).toBe(1);

    const rows = await db.datasetSample.findMany({ where: { datasetId: dataset.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).not.toBe(sample.id); // deleted + recreated, new id
    expect(rows[0].input).toBe('replacement');
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
