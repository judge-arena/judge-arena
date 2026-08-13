import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { getServerSession } from 'next-auth';
import { db, truncateAll, mkUser } from './helpers';
import { PLATFORM_OWNER_EMAIL } from '@/lib/golden-sets';
import { GET as listGoldenSets, POST as createGoldenSet } from '@/app/api/golden-sets/route';
import {
  GET as getGoldenSet,
  PATCH as patchGoldenSet,
  DELETE as deleteGoldenSet,
} from '@/app/api/golden-sets/[id]/route';
import {
  GET as getItems,
  PATCH as patchItems,
  DELETE as deleteItems,
} from '@/app/api/golden-sets/[id]/items/route';
import { POST as forkRoute } from '@/app/api/golden-sets/[id]/fork/route';
import { POST as retireRoute } from '@/app/api/golden-sets/[id]/retire/route';

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

let counter = 0;
function uniq(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}`;
}

/** The platform system user — findFirst, not findUnique: User.email is
 * deliberately NOT db-unique (identity is (oidcIssuer, oidcSubject)). */
async function mkPlatformUser() {
  const existing = await db.user.findFirst({ where: { email: PLATFORM_OWNER_EMAIL } });
  if (existing) return existing;
  return db.user.create({
    data: { email: PLATFORM_OWNER_EMAIL, name: 'Judge Arena', passwordHash: '!platform-system-user' },
  });
}

async function mkPlatformDataset(sampleCount = 4, visibility: 'private' | 'public' = 'public') {
  const platform = await mkPlatformUser();
  const dataset = await db.dataset.create({
    data: { name: uniq('fixture-corpus'), userId: platform.id, visibility, inputType: 'query-response' },
  });
  await db.datasetSample.createMany({
    data: Array.from({ length: sampleCount }, (_, i) => ({
      datasetId: dataset.id,
      index: i,
      input: `question ${i}`,
      expected: i % 2 === 0 ? 'A>B' : 'B>A',
      metadata: JSON.stringify({
        split: 'gpt',
        pair_id: `p${i}`,
        response_A: `response A ${i}`,
        response_B: `response B ${i}`,
      }),
    })),
  });
  return { platform, dataset };
}

/** Direct-DB golden set, bypassing the route — for read/mutation tests that
 * don't want to re-exercise the importer. */
async function mkGoldenSet(
  ownerId: string,
  opts: { visibility?: 'private' | 'public'; itemCount?: number; protocol?: 'pointwise' | 'pairwise' | 'listwise' } = {}
) {
  const { dataset } = await mkPlatformDataset(opts.itemCount ?? 3);
  const samples = await db.datasetSample.findMany({
    where: { datasetId: dataset.id },
    orderBy: { index: 'asc' },
  });
  const goldenSet = await db.goldenSet.create({
    data: {
      name: uniq('fixture-golden-set'),
      slug: uniq('fixture-golden-set'),
      ownerId,
      datasetId: dataset.id,
      protocol: opts.protocol ?? 'pairwise',
      visibility: opts.visibility ?? 'private',
    },
  });
  for (const [i, s] of samples.entries()) {
    await db.goldenItem.create({
      data: {
        goldenSetId: goldenSet.id,
        index: i,
        inputText: s.input,
        protocol: opts.protocol ?? 'pairwise',
        expected: s.expected,
        sourceDatasetSampleId: s.id,
        candidates: {
          create: [
            { position: 0, responseText: `A${i}` },
            { position: 1, responseText: `B${i}` },
          ],
        },
      },
    });
  }
  return { goldenSet, dataset, samples };
}

describe('GET /api/golden-sets — list', () => {
  beforeEach(async () => {
    await truncateAll();
    (getServerSession as unknown as Mock).mockReset();
  });

  it('anonymous sees ONLY public sets, in the {data, pagination} envelope, PII-stripped', async () => {
    const owner = await mkUser({ email: 'owner-secret-pii@test.local' });
    const { goldenSet: pub } = await mkGoldenSet(owner.id, { visibility: 'public' });
    const { goldenSet: priv } = await mkGoldenSet(owner.id, { visibility: 'private' });

    (getServerSession as unknown as Mock).mockResolvedValue(null);
    const res = await listGoldenSets(new Request('http://localhost/api/golden-sets'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.pagination).toBeDefined();

    const ids = body.data.map((g: any) => g.id);
    expect(ids).toContain(pub.id);
    expect(ids).not.toContain(priv.id);

    expect(JSON.stringify(body)).not.toContain('owner-secret-pii@test.local');
    const row = body.data.find((g: any) => g.id === pub.id);
    expect(row.owner).toEqual({ id: owner.id, name: null });
    expect(row.itemCount).toBe(3);
  });

  it('an authed owner sees their own private sets and gets the RAW row, not the public projection', async () => {
    const owner = await mkUser();
    const { goldenSet: priv } = await mkGoldenSet(owner.id, { visibility: 'private' });

    mockSessionFor(owner);
    const res = await listGoldenSets(new Request('http://localhost/api/golden-sets'));
    const body = await res.json();
    const row = body.data.find((g: any) => g.id === priv.id);
    expect(row).toBeDefined();
    expect(row.datasetId).toBeDefined();
    expect(row.protocol).toBe('pairwise');
    expect(row._count.items).toBe(3);
  });

  it('filters retired and tombstoned sets out of every read path, with ?includeRetired=true as the escape', async () => {
    const owner = await mkUser();
    const { goldenSet: live } = await mkGoldenSet(owner.id);
    const { goldenSet: retired } = await mkGoldenSet(owner.id);
    const { goldenSet: tombstoned } = await mkGoldenSet(owner.id);
    await db.goldenSet.update({ where: { id: retired.id }, data: { retiredAt: new Date() } });
    await db.goldenSet.update({ where: { id: tombstoned.id }, data: { tombstonedAt: new Date() } });

    mockSessionFor(owner);
    const res = await listGoldenSets(new Request('http://localhost/api/golden-sets'));
    const ids = (await res.json()).data.map((g: any) => g.id);
    expect(ids).toEqual([live.id]);

    const allRes = await listGoldenSets(
      new Request('http://localhost/api/golden-sets?includeRetired=true')
    );
    const allIds = (await allRes.json()).data.map((g: any) => g.id).sort();
    expect(allIds).toEqual([live.id, retired.id, tombstoned.id].sort());
  });

  it('?protocol= filters, and an arbitrary value is ignored rather than throwing a Prisma enum validation error', async () => {
    const owner = await mkUser();
    const { goldenSet: pairwise } = await mkGoldenSet(owner.id, { protocol: 'pairwise' });
    const { goldenSet: pointwise } = await mkGoldenSet(owner.id, { protocol: 'pointwise' });

    mockSessionFor(owner);
    const filtered = await listGoldenSets(
      new Request('http://localhost/api/golden-sets?protocol=pointwise')
    );
    expect((await filtered.json()).data.map((g: any) => g.id)).toEqual([pointwise.id]);

    const garbage = await listGoldenSets(
      new Request('http://localhost/api/golden-sets?protocol=setwise')
    );
    expect(garbage.status).toBe(200);
    expect((await garbage.json()).data.map((g: any) => g.id).sort()).toEqual(
      [pairwise.id, pointwise.id].sort()
    );
  });
});

describe('POST /api/golden-sets — source gating', () => {
  beforeEach(async () => {
    await truncateAll();
    (getServerSession as unknown as Mock).mockReset();
  });

  it('a NON-owner can import a PUBLIC platform dataset — the source is gated by resolveResourceAccess on visibility, not by ownership', async () => {
    const { dataset } = await mkPlatformDataset(3);
    const user = await mkUser();
    mockSessionFor(user);

    const res = await createGoldenSet(
      jsonRequest('http://localhost/api/golden-sets', 'POST', {
        datasetId: dataset.id,
        protocol: 'pairwise',
        name: 'Imported by a stranger',
      })
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ownerId).toBe(user.id);
    expect(body._count.items).toBe(3);
  });

  it('ownerId comes from the SESSION, never the request body — a forged ownerId in the body is silently ignored', async () => {
    const { dataset } = await mkPlatformDataset(2);
    const user = await mkUser();
    const someoneElse = await mkUser();
    mockSessionFor(user);

    const res = await createGoldenSet(
      jsonRequest('http://localhost/api/golden-sets', 'POST', {
        datasetId: dataset.id,
        protocol: 'pairwise',
        name: 'Forged owner',
        ownerId: someoneElse.id,
      })
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ownerId).toBe(user.id);
    expect(body.ownerId).not.toBe(someoneElse.id);

    const created = await db.goldenSet.findUniqueOrThrow({ where: { id: body.id } });
    expect(created.ownerId).toBe(user.id);
  });

  it('403s on a dataset that is NOT owned by the platform user, even a public one (A0 restricts creation to platform corpora)', async () => {
    const someoneElse = await mkUser();
    const dataset = await db.dataset.create({
      data: { name: uniq('user-corpus'), userId: someoneElse.id, visibility: 'public' },
    });
    await db.datasetSample.create({
      data: { datasetId: dataset.id, index: 0, input: 'q', expected: 'A>B', metadata: '{}' },
    });

    const user = await mkUser();
    mockSessionFor(user);
    const res = await createGoldenSet(
      jsonRequest('http://localhost/api/golden-sets', 'POST', {
        datasetId: dataset.id,
        protocol: 'pairwise',
        name: 'Not a platform corpus',
      })
    );
    expect(res.status).toBe(403);
    await expect(db.goldenSet.count()).resolves.toBe(0);
  });

  it('403s a non-admin on a PRIVATE platform dataset (resolveResourceAccess), and 404s an unknown datasetId', async () => {
    const { dataset } = await mkPlatformDataset(2, 'private');
    const user = await mkUser();
    mockSessionFor(user);

    const forbidden = await createGoldenSet(
      jsonRequest('http://localhost/api/golden-sets', 'POST', {
        datasetId: dataset.id,
        protocol: 'pairwise',
        name: 'Private corpus',
      })
    );
    expect(forbidden.status).toBe(403);

    const missing = await createGoldenSet(
      jsonRequest('http://localhost/api/golden-sets', 'POST', {
        datasetId: 'no-such-dataset',
        protocol: 'pairwise',
        name: 'Ghost',
      })
    );
    expect(missing.status).toBe(404);
  });

  it('an anonymous POST is 401 and a malformed body is 400', async () => {
    const { dataset } = await mkPlatformDataset(2);
    (getServerSession as unknown as Mock).mockResolvedValue(null);
    const anon = await createGoldenSet(
      jsonRequest('http://localhost/api/golden-sets', 'POST', {
        datasetId: dataset.id,
        protocol: 'pairwise',
        name: 'Anon',
      })
    );
    expect(anon.status).toBe(401);

    const user = await mkUser();
    mockSessionFor(user);
    const bad = await createGoldenSet(
      jsonRequest('http://localhost/api/golden-sets', 'POST', {
        datasetId: dataset.id,
        protocol: 'setwise',
        name: '',
      })
    );
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe('Validation failed');
  });
});

/** A CalibrationRun is what freezes a set. It needs a JudgeModelVersion. */
async function mkCalibrationRun(goldenSetId: string) {
  const judgeModel = await db.judgeModel.create({
    data: {
      name: 'Fixture Judge',
      slug: uniq('fixture-judge'),
      judgeClass: 'prompted_api',
      scoringMechanism: 'critique_generative',
      baseModel: 'fixture-base-model',
    },
  });
  const version = await db.judgeModelVersion.create({
    data: {
      judgeModelId: judgeModel.id,
      ordinal: 1,
      servingBackend: 'anthropic',
      protocolSupport: { pointwise: ['score'] },
    },
  });
  return db.calibrationRun.create({
    data: { judgeModelVersionId: version.id, goldenSetId },
  });
}

describe('GET /api/golden-sets/[id]', () => {
  beforeEach(async () => {
    await truncateAll();
    (getServerSession as unknown as Mock).mockReset();
  });

  it('the owner gets the raw row with items and their candidates ordered', async () => {
    const owner = await mkUser();
    const { goldenSet } = await mkGoldenSet(owner.id);

    mockSessionFor(owner);
    const res = await getGoldenSet(new Request(`http://localhost/api/golden-sets/${goldenSet.id}`), {
      params: Promise.resolve({ id: goldenSet.id }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(3);
    expect(body.items.map((i: any) => i.index)).toEqual([0, 1, 2]);
    expect(body.items[0].candidates.map((c: any) => c.position)).toEqual([0, 1]);
    expect(body.datasetId).toBeDefined();
  });

  it('an anonymous caller on a PUBLIC set gets the PII-stripped projection, still carrying items', async () => {
    const owner = await mkUser({ email: 'owner-secret-pii@test.local' });
    const { goldenSet } = await mkGoldenSet(owner.id, { visibility: 'public' });

    (getServerSession as unknown as Mock).mockResolvedValue(null);
    const res = await getGoldenSet(new Request(`http://localhost/api/golden-sets/${goldenSet.id}`), {
      params: Promise.resolve({ id: goldenSet.id }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('owner-secret-pii@test.local');
    const body = JSON.parse(text);
    expect(body.itemCount).toBe(3);
    expect(body.items).toHaveLength(3);
    expect(body.protocol).toBe('pairwise');
  });

  it('404s a retired or tombstoned set unless ?includeRetired=true', async () => {
    const owner = await mkUser();
    const { goldenSet } = await mkGoldenSet(owner.id);
    await db.goldenSet.update({ where: { id: goldenSet.id }, data: { retiredAt: new Date() } });

    mockSessionFor(owner);
    const hidden = await getGoldenSet(
      new Request(`http://localhost/api/golden-sets/${goldenSet.id}`),
      { params: Promise.resolve({ id: goldenSet.id }) }
    );
    expect(hidden.status).toBe(404);

    const shown = await getGoldenSet(
      new Request(`http://localhost/api/golden-sets/${goldenSet.id}?includeRetired=true`),
      { params: Promise.resolve({ id: goldenSet.id }) }
    );
    expect(shown.status).toBe(200);
  });

  it('itemCount and the embedded items both exclude tombstoned rows', async () => {
    const owner = await mkUser();
    const { goldenSet } = await mkGoldenSet(owner.id, { visibility: 'public', itemCount: 4 });
    const items = await db.goldenItem.findMany({ where: { goldenSetId: goldenSet.id } });
    await db.goldenItem.update({
      where: { id: items[0].id },
      data: { tombstonedAt: new Date() },
    });

    (getServerSession as unknown as Mock).mockResolvedValue(null);
    const res = await getGoldenSet(new Request(`http://localhost/api/golden-sets/${goldenSet.id}`), {
      params: Promise.resolve({ id: goldenSet.id }),
    });
    const body = await res.json();
    expect(body.itemCount).toBe(3);
    expect(body.items).toHaveLength(3);
    expect(body.items.some((i: { id: string }) => i.id === items[0].id)).toBe(false);
  });
});

describe('PATCH /api/golden-sets/[id] — immutable datasetId, freeze guard on protocol', () => {
  beforeEach(async () => {
    await truncateAll();
    (getServerSession as unknown as Mock).mockReset();
  });

  it('renaming a CALIBRATED set still works — name/description/visibility are not what a calibration run measured', async () => {
    const owner = await mkUser();
    const { goldenSet } = await mkGoldenSet(owner.id);
    await mkCalibrationRun(goldenSet.id);

    mockSessionFor(owner);
    const res = await patchGoldenSet(
      jsonRequest(`http://localhost/api/golden-sets/${goldenSet.id}`, 'PATCH', {
        name: 'Typo fixed',
        visibility: 'public',
      }),
      { params: Promise.resolve({ id: goldenSet.id }) }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe('Typo fixed');
    expect(body.visibility).toBe('public');
  });

  it('409s a protocol change on a CALIBRATED set and offers the fork url, writing nothing', async () => {
    const owner = await mkUser();
    const { goldenSet } = await mkGoldenSet(owner.id);
    await mkCalibrationRun(goldenSet.id);

    mockSessionFor(owner);
    const res = await patchGoldenSet(
      jsonRequest(`http://localhost/api/golden-sets/${goldenSet.id}`, 'PATCH', {
        protocol: 'pointwise',
        name: 'Should not land either',
      }),
      { params: Promise.resolve({ id: goldenSet.id }) }
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.goldenSetId).toBe(goldenSet.id);
    expect(body.forkUrl).toBe(`/api/golden-sets/${goldenSet.id}/fork`);

    const after = await db.goldenSet.findUniqueOrThrow({ where: { id: goldenSet.id } });
    expect(after.protocol).toBe('pairwise');
    expect(after.name).toBe(goldenSet.name);
  });

  it('a protocol change on an UNcalibrated set lands', async () => {
    const owner = await mkUser();
    const { goldenSet } = await mkGoldenSet(owner.id);

    mockSessionFor(owner);
    const res = await patchGoldenSet(
      jsonRequest(`http://localhost/api/golden-sets/${goldenSet.id}`, 'PATCH', {
        protocol: 'listwise',
      }),
      { params: Promise.resolve({ id: goldenSet.id }) }
    );
    expect(res.status).toBe(200);
    expect((await res.json()).protocol).toBe('listwise');
  });

  it('400s a datasetId change on an UNCALIBRATED set — immutability is unconditional, not a freeze rule — and lands nothing else from the body either', async () => {
    const owner = await mkUser();
    const { goldenSet } = await mkGoldenSet(owner.id);
    const { dataset: other } = await mkPlatformDataset(2);

    mockSessionFor(owner);
    const res = await patchGoldenSet(
      jsonRequest(`http://localhost/api/golden-sets/${goldenSet.id}`, 'PATCH', {
        datasetId: other.id,
        name: 'Should not land either',
      }),
      { params: Promise.resolve({ id: goldenSet.id }) }
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/datasetId is immutable/);
    expect(body.forkUrl).toBe(`/api/golden-sets/${goldenSet.id}/fork`);

    const after = await db.goldenSet.findUniqueOrThrow({ where: { id: goldenSet.id } });
    expect(after.datasetId).toBe(goldenSet.datasetId);
    expect(after.name).toBe(goldenSet.name);
  });

  it('400s a SAME-VALUE datasetId echo too — the rule is about the field, so it never depends on reading the row', async () => {
    const owner = await mkUser();
    const { goldenSet } = await mkGoldenSet(owner.id);

    mockSessionFor(owner);
    const res = await patchGoldenSet(
      jsonRequest(`http://localhost/api/golden-sets/${goldenSet.id}`, 'PATCH', {
        datasetId: goldenSet.datasetId,
        name: 'Read-modify-write echo',
      }),
      { params: Promise.resolve({ id: goldenSet.id }) }
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/datasetId is immutable/);

    const after = await db.goldenSet.findUniqueOrThrow({ where: { id: goldenSet.id } });
    expect(after.name).toBe(goldenSet.name);
  });

  it('400s (not 409s) a datasetId change on a CALIBRATED set — immutability outranks the freeze, so the answer is never "fork and then repoint"', async () => {
    const owner = await mkUser();
    const { goldenSet } = await mkGoldenSet(owner.id);
    await mkCalibrationRun(goldenSet.id);
    const { dataset: other } = await mkPlatformDataset(2);

    mockSessionFor(owner);
    const res = await patchGoldenSet(
      jsonRequest(`http://localhost/api/golden-sets/${goldenSet.id}`, 'PATCH', {
        datasetId: other.id,
      }),
      { params: Promise.resolve({ id: goldenSet.id }) }
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/datasetId is immutable/);

    const after = await db.goldenSet.findUniqueOrThrow({ where: { id: goldenSet.id } });
    expect(after.datasetId).toBe(goldenSet.datasetId);
  });

  it('a rename that does not name datasetId still lands, and leaves datasetId alone — the guard is not over-broad', async () => {
    const owner = await mkUser();
    const { goldenSet } = await mkGoldenSet(owner.id);

    mockSessionFor(owner);
    const res = await patchGoldenSet(
      jsonRequest(`http://localhost/api/golden-sets/${goldenSet.id}`, 'PATCH', {
        name: 'Renamed, same corpus',
        description: 'still the annotation layer over one dataset',
      }),
      { params: Promise.resolve({ id: goldenSet.id }) }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe('Renamed, same corpus');

    const after = await db.goldenSet.findUniqueOrThrow({ where: { id: goldenSet.id } });
    expect(after.datasetId).toBe(goldenSet.datasetId);
    expect(after.description).toBe('still the annotation layer over one dataset');
  });
});

describe('DELETE /api/golden-sets/[id] — tombstone, never a row delete', () => {
  beforeEach(async () => {
    await truncateAll();
    (getServerSession as unknown as Mock).mockReset();
  });

  it('stamps tombstonedAt, keeps the row and its items, and makes the set invisible to subsequent reads', async () => {
    const owner = await mkUser();
    const { goldenSet } = await mkGoldenSet(owner.id);

    mockSessionFor(owner);
    const res = await deleteGoldenSet(
      new Request(`http://localhost/api/golden-sets/${goldenSet.id}`, { method: 'DELETE' }),
      { params: Promise.resolve({ id: goldenSet.id }) }
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, tombstoned: true });

    const row = await db.goldenSet.findUnique({ where: { id: goldenSet.id } });
    expect(row).not.toBeNull();
    expect(row!.tombstonedAt).not.toBeNull();
    await expect(db.goldenItem.count({ where: { goldenSetId: goldenSet.id } })).resolves.toBe(3);

    const after = await getGoldenSet(
      new Request(`http://localhost/api/golden-sets/${goldenSet.id}`),
      { params: Promise.resolve({ id: goldenSet.id }) }
    );
    expect(after.status).toBe(404);
  });

  it('tombstones a CALIBRATED set too — nothing is destroyed, so the Restrict on CalibrationRun.goldenSetId cannot abort', async () => {
    const owner = await mkUser();
    const { goldenSet } = await mkGoldenSet(owner.id);
    await mkCalibrationRun(goldenSet.id);

    mockSessionFor(owner);
    const res = await deleteGoldenSet(
      new Request(`http://localhost/api/golden-sets/${goldenSet.id}`, { method: 'DELETE' }),
      { params: Promise.resolve({ id: goldenSet.id }) }
    );
    expect(res.status).toBe(200);
    await expect(db.calibrationRun.count({ where: { goldenSetId: goldenSet.id } })).resolves.toBe(1);
  });
});

describe('/api/golden-sets/[id]/items', () => {
  beforeEach(async () => {
    await truncateAll();
    (getServerSession as unknown as Mock).mockReset();
  });

  it('GET exists (unlike datasets/[id]/samples) and returns items with candidates in the {data, pagination} envelope', async () => {
    const owner = await mkUser();
    const { goldenSet } = await mkGoldenSet(owner.id, { itemCount: 5 });

    mockSessionFor(owner);
    const res = await getItems(
      new Request(`http://localhost/api/golden-sets/${goldenSet.id}/items`),
      { params: Promise.resolve({ id: goldenSet.id }) }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(5);
    expect(body.pagination.total).toBe(5);
    expect(body.data.map((i: any) => i.index)).toEqual([0, 1, 2, 3, 4]);
    expect(body.data[0].candidates).toHaveLength(2);
  });

  it('GET on a PUBLIC set is readable anonymously; on a PRIVATE set it is 401', async () => {
    const owner = await mkUser();
    const { goldenSet: pub } = await mkGoldenSet(owner.id, { visibility: 'public' });
    const { goldenSet: priv } = await mkGoldenSet(owner.id, { visibility: 'private' });

    (getServerSession as unknown as Mock).mockResolvedValue(null);
    const open = await getItems(new Request(`http://localhost/api/golden-sets/${pub.id}/items`), {
      params: Promise.resolve({ id: pub.id }),
    });
    expect(open.status).toBe(200);

    const closed = await getItems(new Request(`http://localhost/api/golden-sets/${priv.id}/items`), {
      params: Promise.resolve({ id: priv.id }),
    });
    expect(closed.status).toBe(401);
  });

  it('PATCH updates per-item expected on an uncalibrated set', async () => {
    const owner = await mkUser();
    const { goldenSet } = await mkGoldenSet(owner.id, { itemCount: 2 });
    const items = await db.goldenItem.findMany({
      where: { goldenSetId: goldenSet.id },
      orderBy: { index: 'asc' },
    });

    mockSessionFor(owner);
    const res = await patchItems(
      jsonRequest(`http://localhost/api/golden-sets/${goldenSet.id}/items`, 'PATCH', {
        items: [
          { id: items[0].id, expected: 'B>A' },
          { id: items[1].id, expected: null, inputText: 'edited question' },
        ],
      }),
      { params: Promise.resolve({ id: goldenSet.id }) }
    );
    expect(res.status).toBe(200);
    expect((await res.json()).updated).toBe(2);

    const after = await db.goldenItem.findMany({
      where: { goldenSetId: goldenSet.id },
      orderBy: { index: 'asc' },
    });
    expect(after[0].expected).toBe('B>A');
    expect(after[1].expected).toBeNull();
    expect(after[1].inputText).toBe('edited question');
  });

  it('PATCH TOMBSTONES an item\'s GoldenLabel rows when its content actually changes, but a same-value field leaves them alone', async () => {
    // Owner ruling 2026-08-13 extended to labels: a human label is the
    // expensive, irreplaceable artifact this roadmap exists to protect, so
    // the score is retained with a tombstone rather than destroyed. It still
    // stops applying — every read filters it — but WHO said WHAT, and WHEN it
    // stopped applying, survive.
    const owner = await mkUser();
    const annotator = await mkUser();
    const { goldenSet } = await mkGoldenSet(owner.id, { itemCount: 2 });
    const items = await db.goldenItem.findMany({
      where: { goldenSetId: goldenSet.id },
      orderBy: { index: 'asc' },
    });
    const label0 = await db.goldenLabel.create({
      data: {
        goldenItemId: items[0].id,
        annotatorId: annotator.id,
        overallScore: 7,
        reasoning: 'B answers the question asked',
      },
    });
    const label1 = await db.goldenLabel.create({
      data: { goldenItemId: items[1].id, annotatorId: annotator.id, overallScore: 5 },
    });

    mockSessionFor(owner);
    const res = await patchItems(
      jsonRequest(`http://localhost/api/golden-sets/${goldenSet.id}/items`, 'PATCH', {
        items: [
          { id: items[0].id, inputText: 'a genuinely different question' },
          { id: items[1].id, expected: items[1].expected }, // restates the current value: not a change
        ],
      }),
      { params: Promise.resolve({ id: goldenSet.id }) }
    );
    expect(res.status).toBe(200);

    // Item 0's content changed -> its label is tombstoned, NOT destroyed.
    const dropped = await db.goldenLabel.findUniqueOrThrow({ where: { id: label0.id } });
    expect(dropped.tombstonedAt).not.toBeNull();
    expect(dropped.tombstonedReason).toBe('item-content-edit');
    expect(dropped.annotatorId).toBe(annotator.id);
    expect(dropped.overallScore).toBe(7);
    expect(dropped.reasoning).toBe('B answers the question asked');

    // Item 1's payload restated its existing value -> not a content change ->
    // the label is untouched, tombstone included.
    const survived = await db.goldenLabel.findUniqueOrThrow({ where: { id: label1.id } });
    expect(survived.tombstonedAt).toBeNull();
  });

  it('the same annotator can re-score an item after their earlier label was tombstoned by an edit', async () => {
    // The whole reason GoldenLabel's unique became partial. Under the old
    // whole-table @@unique([goldenItemId, annotatorId]) the retained row
    // occupied the slot forever and this insert was impossible — which would
    // have made "keep the label" and "let people re-annotate" mutually
    // exclusive.
    const owner = await mkUser();
    const annotator = await mkUser();
    const { goldenSet } = await mkGoldenSet(owner.id, { itemCount: 1 });
    const item = await db.goldenItem.findFirstOrThrow({ where: { goldenSetId: goldenSet.id } });
    await db.goldenLabel.create({
      data: { goldenItemId: item.id, annotatorId: annotator.id, overallScore: 7 },
    });

    mockSessionFor(owner);
    await patchItems(
      jsonRequest(`http://localhost/api/golden-sets/${goldenSet.id}/items`, 'PATCH', {
        items: [{ id: item.id, inputText: 'edited after annotation' }],
      }),
      { params: Promise.resolve({ id: goldenSet.id }) }
    );

    const relabel = await db.goldenLabel.create({
      data: { goldenItemId: item.id, annotatorId: annotator.id, overallScore: 3 },
    });
    expect(relabel.tombstonedAt).toBeNull();

    const live = await db.goldenLabel.findMany({
      where: { goldenItemId: item.id, tombstonedAt: null },
    });
    expect(live).toHaveLength(1);
    expect(live[0].id).toBe(relabel.id);
    expect(await db.goldenLabel.count({ where: { goldenItemId: item.id } })).toBe(2);
  });

  it('PATCH 400s on a TOMBSTONED item id — editing a removed item is not a silent no-op', async () => {
    const owner = await mkUser();
    const { goldenSet } = await mkGoldenSet(owner.id, { itemCount: 2 });
    const item = await db.goldenItem.findFirstOrThrow({ where: { goldenSetId: goldenSet.id } });
    await db.goldenItem.update({ where: { id: item.id }, data: { tombstonedAt: new Date() } });

    mockSessionFor(owner);
    const res = await patchItems(
      jsonRequest(`http://localhost/api/golden-sets/${goldenSet.id}/items`, 'PATCH', {
        items: [{ id: item.id, expected: 'B>A' }],
      }),
      { params: Promise.resolve({ id: goldenSet.id }) }
    );
    expect(res.status).toBe(400);
  });

  it('PATCH 409s on a CALIBRATED set and writes nothing', async () => {
    const owner = await mkUser();
    const { goldenSet } = await mkGoldenSet(owner.id, { itemCount: 2 });
    await mkCalibrationRun(goldenSet.id);
    const items = await db.goldenItem.findMany({
      where: { goldenSetId: goldenSet.id },
      orderBy: { index: 'asc' },
    });

    mockSessionFor(owner);
    const res = await patchItems(
      jsonRequest(`http://localhost/api/golden-sets/${goldenSet.id}/items`, 'PATCH', {
        items: [{ id: items[0].id, expected: 'B>A' }],
      }),
      { params: Promise.resolve({ id: goldenSet.id }) }
    );
    expect(res.status).toBe(409);
    expect((await res.json()).forkUrl).toBe(`/api/golden-sets/${goldenSet.id}/fork`);

    const after = await db.goldenItem.findUniqueOrThrow({ where: { id: items[0].id } });
    expect(after.expected).toBe(items[0].expected);
  });

  it('PATCH 400s on an item id belonging to a DIFFERENT golden set', async () => {
    const owner = await mkUser();
    const { goldenSet: a } = await mkGoldenSet(owner.id, { itemCount: 1 });
    const { goldenSet: b } = await mkGoldenSet(owner.id, { itemCount: 1 });
    const foreign = await db.goldenItem.findFirstOrThrow({ where: { goldenSetId: b.id } });

    mockSessionFor(owner);
    const res = await patchItems(
      jsonRequest(`http://localhost/api/golden-sets/${a.id}/items`, 'PATCH', {
        items: [{ id: foreign.id, expected: 'B>A' }],
      }),
      { params: Promise.resolve({ id: a.id }) }
    );
    expect(res.status).toBe(400);
  });

  it('DELETE TOMBSTONES and does NOT re-index — a tombstoned row keeps its ordinal, so no gap ever opens', async () => {
    // The old handler deleted the rows and renumbered the survivors 0..n-1 to
    // close the gap @@unique([goldenSetId, index]) would otherwise turn into a
    // constraint problem. Nothing is removed any more, so nothing to close —
    // and re-packing on top of a tombstone would collide with the tombstoned
    // row still holding index 0 (P2002) and abort every DELETE.
    const owner = await mkUser();
    const { goldenSet } = await mkGoldenSet(owner.id, { itemCount: 5 });
    const items = await db.goldenItem.findMany({
      where: { goldenSetId: goldenSet.id },
      orderBy: { index: 'asc' },
    });

    mockSessionFor(owner);
    const res = await deleteItems(
      jsonRequest(`http://localhost/api/golden-sets/${goldenSet.id}/items`, 'DELETE', {
        itemIds: [items[0].id, items[2].id],
      }),
      { params: Promise.resolve({ id: goldenSet.id }) }
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tombstoned: 2, remaining: 3 });

    // Every row is still there.
    await expect(db.goldenItem.count({ where: { goldenSetId: goldenSet.id } })).resolves.toBe(5);

    const survivors = await db.goldenItem.findMany({
      where: { goldenSetId: goldenSet.id, tombstonedAt: null },
      orderBy: { index: 'asc' },
    });
    expect(survivors.map((i) => i.id)).toEqual([items[1].id, items[3].id, items[4].id]);
    // 1, 3, 4 — NOT 0, 1, 2. The gaps are the record of what was removed.
    expect(survivors.map((i) => i.index)).toEqual([1, 3, 4]);

    const tombstoned = await db.goldenItem.findMany({
      where: { goldenSetId: goldenSet.id, tombstonedAt: { not: null } },
      orderBy: { index: 'asc' },
    });
    expect(tombstoned.map((i) => i.index)).toEqual([0, 2]);

    // GoldenCandidate has NO flag of its own and needs none: it is reachable
    // only through its item, so the item filter is the whole filter. The
    // rows survive because nothing was deleted for the Cascade to follow.
    await expect(
      db.goldenCandidate.count({ where: { goldenItemId: { in: [items[0].id, items[2].id] } } })
    ).resolves.toBe(4);

    // The GET no longer serves them.
    const after = await getItems(
      new Request(`http://localhost/api/golden-sets/${goldenSet.id}/items`),
      { params: Promise.resolve({ id: goldenSet.id }) }
    );
    expect((await after.json()).data.map((i: { index: number }) => i.index)).toEqual([1, 3, 4]);
  });

  it('DELETE is idempotent — re-tombstoning an already-tombstoned id reports 0 and is not a 400', async () => {
    const owner = await mkUser();
    const { goldenSet } = await mkGoldenSet(owner.id, { itemCount: 3 });
    const items = await db.goldenItem.findMany({
      where: { goldenSetId: goldenSet.id },
      orderBy: { index: 'asc' },
    });

    mockSessionFor(owner);
    const body = { itemIds: [items[0].id] };
    const first = await deleteItems(
      jsonRequest(`http://localhost/api/golden-sets/${goldenSet.id}/items`, 'DELETE', body),
      { params: Promise.resolve({ id: goldenSet.id }) }
    );
    expect(await first.json()).toEqual({ tombstoned: 1, remaining: 2 });

    // The ownership lookup is deliberately NOT lifecycle-filtered: the id
    // still belongs to this set, so a retried request must not 400.
    const second = await deleteItems(
      jsonRequest(`http://localhost/api/golden-sets/${goldenSet.id}/items`, 'DELETE', body),
      { params: Promise.resolve({ id: goldenSet.id }) }
    );
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ tombstoned: 0, remaining: 2 });

    const row = await db.goldenItem.findUniqueOrThrow({ where: { id: items[0].id } });
    expect(row.tombstonedAt).not.toBeNull();
  });

  it('GET ?includeTombstoned=true shows them to the OWNER and is ignored for a public reader', async () => {
    const owner = await mkUser();
    const { goldenSet } = await mkGoldenSet(owner.id, { visibility: 'public', itemCount: 3 });
    const items = await db.goldenItem.findMany({ where: { goldenSetId: goldenSet.id } });
    await db.goldenItem.update({
      where: { id: items[0].id },
      data: { tombstonedAt: new Date() },
    });

    mockSessionFor(owner);
    const asOwner = await getItems(
      new Request(
        `http://localhost/api/golden-sets/${goldenSet.id}/items?includeTombstoned=true`
      ),
      { params: Promise.resolve({ id: goldenSet.id }) }
    );
    const ownerBody = await asOwner.json();
    expect(ownerBody.data).toHaveLength(3);
    expect(ownerBody.pagination.total).toBe(3);

    (getServerSession as unknown as Mock).mockResolvedValue(null);
    const anon = await getItems(
      new Request(
        `http://localhost/api/golden-sets/${goldenSet.id}/items?includeTombstoned=true`
      ),
      { params: Promise.resolve({ id: goldenSet.id }) }
    );
    const anonBody = await anon.json();
    // The escape is owner/admin-only — a public reader of a public set asking
    // for tombstoned items gets the live ones, not a 403 and not the rows.
    expect(anonBody.data).toHaveLength(2);
    expect(anonBody.pagination.total).toBe(2);
  });

  it('DELETE 409s on a CALIBRATED set, deleting nothing', async () => {
    const owner = await mkUser();
    const { goldenSet } = await mkGoldenSet(owner.id, { itemCount: 3 });
    await mkCalibrationRun(goldenSet.id);
    const items = await db.goldenItem.findMany({ where: { goldenSetId: goldenSet.id } });

    mockSessionFor(owner);
    const res = await deleteItems(
      jsonRequest(`http://localhost/api/golden-sets/${goldenSet.id}/items`, 'DELETE', {
        itemIds: [items[0].id],
      }),
      { params: Promise.resolve({ id: goldenSet.id }) }
    );
    expect(res.status).toBe(409);
    await expect(db.goldenItem.count({ where: { goldenSetId: goldenSet.id } })).resolves.toBe(3);
  });

  it('a stranger cannot PATCH or DELETE items on someone else\'s set', async () => {
    const owner = await mkUser();
    const stranger = await mkUser();
    const { goldenSet } = await mkGoldenSet(owner.id, { itemCount: 2 });
    const item = await db.goldenItem.findFirstOrThrow({ where: { goldenSetId: goldenSet.id } });

    mockSessionFor(stranger);
    const patched = await patchItems(
      jsonRequest(`http://localhost/api/golden-sets/${goldenSet.id}/items`, 'PATCH', {
        items: [{ id: item.id, expected: 'B>A' }],
      }),
      { params: Promise.resolve({ id: goldenSet.id }) }
    );
    expect(patched.status).toBe(403);

    const deleted = await deleteItems(
      jsonRequest(`http://localhost/api/golden-sets/${goldenSet.id}/items`, 'DELETE', {
        itemIds: [item.id],
      }),
      { params: Promise.resolve({ id: goldenSet.id }) }
    );
    expect(deleted.status).toBe(403);
  });
});

describe('POST /api/golden-sets/[id]/fork', () => {
  beforeEach(async () => {
    await truncateAll();
    (getServerSession as unknown as Mock).mockReset();
  });

  it('forks a CALIBRATED set to version 2 under the same root, inheriting datasetId and protocol', async () => {
    const owner = await mkUser();
    const { goldenSet } = await mkGoldenSet(owner.id, { itemCount: 3 });
    await mkCalibrationRun(goldenSet.id);

    mockSessionFor(owner);
    const res = await forkRoute(
      jsonRequest(`http://localhost/api/golden-sets/${goldenSet.id}/fork`, 'POST', {}),
      { params: Promise.resolve({ id: goldenSet.id }) }
    );
    expect(res.status).toBe(201);
    const body = await res.json();

    expect(body.version).toBe(2);
    expect(body.parentId).toBe(goldenSet.id);
    expect(body.datasetId).toBe(goldenSet.datasetId);
    expect(body.protocol).toBe(goldenSet.protocol);
    expect(body.ownerId).toBe(owner.id);
    expect(body._count.items).toBe(3);
    expect(body.items).toHaveLength(3);
    expect(body.items[0].candidates).toHaveLength(2);

    // The original is untouched — a fork is additive.
    const original = await db.goldenSet.findUniqueOrThrow({ where: { id: goldenSet.id } });
    expect(original.version).toBe(1);
    await expect(db.goldenItem.count({ where: { goldenSetId: goldenSet.id } })).resolves.toBe(3);
  });

  it('forking a v2 keeps the ROOT as parentId (existing.parentId ?? existing.id) rather than chaining', async () => {
    const owner = await mkUser();
    const { goldenSet: root } = await mkGoldenSet(owner.id, { itemCount: 2 });

    mockSessionFor(owner);
    const first = await forkRoute(
      jsonRequest(`http://localhost/api/golden-sets/${root.id}/fork`, 'POST', {}),
      { params: Promise.resolve({ id: root.id }) }
    );
    const v2 = await first.json();

    const second = await forkRoute(
      jsonRequest(`http://localhost/api/golden-sets/${v2.id}/fork`, 'POST', {}),
      { params: Promise.resolve({ id: v2.id }) }
    );
    expect(second.status).toBe(201);
    const v3 = await second.json();
    expect(v3.version).toBe(3);
    expect(v3.parentId).toBe(root.id);
  });

  it('accepts an overriding name/description, and works with no request body at all', async () => {
    const owner = await mkUser();
    const { goldenSet } = await mkGoldenSet(owner.id, { itemCount: 1 });

    mockSessionFor(owner);
    const named = await forkRoute(
      jsonRequest(`http://localhost/api/golden-sets/${goldenSet.id}/fork`, 'POST', {
        name: 'Renamed fork',
        description: 'why I forked',
      }),
      { params: Promise.resolve({ id: goldenSet.id }) }
    );
    const namedBody = await named.json();
    expect(namedBody.name).toBe('Renamed fork');
    expect(namedBody.description).toBe('why I forked');

    const bodyless = await forkRoute(
      new Request(`http://localhost/api/golden-sets/${goldenSet.id}/fork`, { method: 'POST' }),
      { params: Promise.resolve({ id: goldenSet.id }) }
    );
    expect(bodyless.status).toBe(201);
    expect((await bodyless.json()).name).toBe(goldenSet.name);
  });

  it('is 404 on an unknown id and 403 for a stranger', async () => {
    const owner = await mkUser();
    const stranger = await mkUser();
    const { goldenSet } = await mkGoldenSet(owner.id, { itemCount: 1 });

    mockSessionFor(owner);
    const missing = await forkRoute(
      jsonRequest('http://localhost/api/golden-sets/nope/fork', 'POST', {}),
      { params: Promise.resolve({ id: 'nope' }) }
    );
    expect(missing.status).toBe(404);

    mockSessionFor(stranger);
    const forbidden = await forkRoute(
      jsonRequest(`http://localhost/api/golden-sets/${goldenSet.id}/fork`, 'POST', {}),
      { params: Promise.resolve({ id: goldenSet.id }) }
    );
    expect(forbidden.status).toBe(403);
  });
});

describe('POST /api/golden-sets/[id]/retire', () => {
  beforeEach(async () => {
    await truncateAll();
    (getServerSession as unknown as Mock).mockReset();
  });

  it('stamps retiredAt and takes the set out of the list, and retire is NOT freeze-guarded', async () => {
    const owner = await mkUser();
    const { goldenSet } = await mkGoldenSet(owner.id);
    await mkCalibrationRun(goldenSet.id);

    mockSessionFor(owner);
    const res = await retireRoute(
      jsonRequest(`http://localhost/api/golden-sets/${goldenSet.id}/retire`, 'POST', {}),
      { params: Promise.resolve({ id: goldenSet.id }) }
    );
    expect(res.status).toBe(200);
    expect((await res.json()).retiredAt).not.toBeNull();

    const listed = await listGoldenSets(new Request('http://localhost/api/golden-sets'));
    expect((await listed.json()).data).toHaveLength(0);
  });

  it('retired: false un-retires — the reader and the writer agree', async () => {
    const owner = await mkUser();
    const { goldenSet } = await mkGoldenSet(owner.id);
    await db.goldenSet.update({ where: { id: goldenSet.id }, data: { retiredAt: new Date() } });

    mockSessionFor(owner);
    const res = await retireRoute(
      jsonRequest(`http://localhost/api/golden-sets/${goldenSet.id}/retire`, 'POST', {
        retired: false,
      }),
      { params: Promise.resolve({ id: goldenSet.id }) }
    );
    expect(res.status).toBe(200);
    expect((await res.json()).retiredAt).toBeNull();

    const listed = await listGoldenSets(new Request('http://localhost/api/golden-sets'));
    expect((await listed.json()).data.map((g: any) => g.id)).toEqual([goldenSet.id]);
  });

  it('a stranger gets 403 and an anonymous caller 401', async () => {
    const owner = await mkUser();
    const stranger = await mkUser();
    const { goldenSet } = await mkGoldenSet(owner.id);

    mockSessionFor(stranger);
    const forbidden = await retireRoute(
      jsonRequest(`http://localhost/api/golden-sets/${goldenSet.id}/retire`, 'POST', {}),
      { params: Promise.resolve({ id: goldenSet.id }) }
    );
    expect(forbidden.status).toBe(403);

    (getServerSession as unknown as Mock).mockResolvedValue(null);
    const anon = await retireRoute(
      jsonRequest(`http://localhost/api/golden-sets/${goldenSet.id}/retire`, 'POST', {}),
      { params: Promise.resolve({ id: goldenSet.id }) }
    );
    expect(anon.status).toBe(401);
  });
});
