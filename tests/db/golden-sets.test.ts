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
});

describe('PATCH /api/golden-sets/[id] — freeze guard on content fields only', () => {
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

  it('409s a datasetId or protocol change on a CALIBRATED set and offers the fork url, writing nothing', async () => {
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
