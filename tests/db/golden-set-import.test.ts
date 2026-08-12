import { describe, it, expect, beforeEach, beforeAll, afterAll, vi, type Mock } from 'vitest';
import { getServerSession } from 'next-auth';
import { db, truncateAll, mkUser } from './helpers';
import { seedAll } from '../../prisma/seed-core';
import { JUDGEBENCH_DATASET_ID } from '../../prisma/seed-judgebench';
import { POST } from '@/app/api/golden-sets/route';

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

/**
 * Creation is import, and the import reads samples SERVER-SIDE. The whole
 * point of these assertions is 620, not 100: a client-side import through
 * GET /api/datasets/[id] (`samples: { take: 100 }`) imports 100 of 620 rows,
 * errors nothing, and looks like it worked.
 */
describe('POST /api/golden-sets — create-by-import against real JudgeBench rows', () => {
  beforeAll(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterAll(() => {
    vi.restoreAllMocks();
  });

  beforeEach(async () => {
    await truncateAll();
    (getServerSession as unknown as Mock).mockReset();
    await seedAll(db);
  });

  it('imports ALL 620 JudgeBench samples at pairwise, two candidates each, never the 100-row detail-route cap', async () => {
    const user = await mkUser();
    mockSessionFor(user);

    const res = await POST(
      jsonRequest('http://localhost/api/golden-sets', 'POST', {
        datasetId: JUDGEBENCH_DATASET_ID,
        protocol: 'pairwise',
        name: 'JudgeBench pairwise',
      })
    );
    expect(res.status).toBe(201);
    const body = await res.json();

    expect(body._count.items).toBe(620);
    expect(body.protocol).toBe('pairwise');
    expect(body.datasetId).toBe(JUDGEBENCH_DATASET_ID);
    expect(body.ownerId).toBe(user.id);
    expect(body.version).toBe(1);
    expect(body.parentId).toBeNull();

    await expect(db.goldenItem.count({ where: { goldenSetId: body.id } })).resolves.toBe(620);
    await expect(
      db.goldenCandidate.count({ where: { goldenItem: { goldenSetId: body.id } } })
    ).resolves.toBe(1240);
  });

  it('maps the QUESTION into inputText and the pair into candidates — never the evaluations mapping, which would put the two-character label "A>B" in inputText on all 620 rows', async () => {
    const user = await mkUser();
    mockSessionFor(user);

    const res = await POST(
      jsonRequest('http://localhost/api/golden-sets', 'POST', {
        datasetId: JUDGEBENCH_DATASET_ID,
        protocol: 'pairwise',
        name: 'JudgeBench pairwise mapping',
      })
    );
    const body = await res.json();

    const sample = await db.datasetSample.findFirstOrThrow({
      where: { datasetId: JUDGEBENCH_DATASET_ID, index: 0 },
    });
    const meta = JSON.parse(sample.metadata ?? '{}') as Record<string, string>;

    const item = await db.goldenItem.findFirstOrThrow({
      where: { goldenSetId: body.id, index: 0 },
      include: { candidates: { orderBy: { position: 'asc' } } },
    });

    expect(item.inputText).toBe(sample.input);
    expect(item.inputText).not.toBe('A>B');
    expect(item.inputText).not.toBe('B>A');
    expect(item.protocol).toBe('pairwise');
    expect(item.expected).toBe(sample.expected);
    expect(item.sourceDatasetSampleId).toBe(sample.id);
    expect(item.candidates).toHaveLength(2);
    expect(item.candidates[0].responseText).toBe(meta.response_A);
    expect(item.candidates[1].responseText).toBe(meta.response_B);
  });

  it('a POINTWISE import of JudgeBench yields expected: null on every item — the label is a preference between two responses, not a score for one', async () => {
    const user = await mkUser();
    mockSessionFor(user);

    const res = await POST(
      jsonRequest('http://localhost/api/golden-sets', 'POST', {
        datasetId: JUDGEBENCH_DATASET_ID,
        protocol: 'pointwise',
        name: 'JudgeBench pointwise',
      })
    );
    expect(res.status).toBe(201);
    const body = await res.json();

    expect(body._count.items).toBe(620);
    await expect(
      db.goldenItem.count({ where: { goldenSetId: body.id, expected: null } })
    ).resolves.toBe(620);
    await expect(
      db.goldenItem.count({ where: { goldenSetId: body.id, expected: { not: null } } })
    ).resolves.toBe(0);
    // One candidate per item at pointwise, not two.
    await expect(
      db.goldenCandidate.count({ where: { goldenItem: { goldenSetId: body.id } } })
    ).resolves.toBe(620);
  });

  it('sampleIndices selects a subset IN THE ORDER GIVEN and re-indexes GoldenItem 0..n-1 over the selection, not inheriting DatasetSample.index', async () => {
    const user = await mkUser();
    mockSessionFor(user);

    const res = await POST(
      jsonRequest('http://localhost/api/golden-sets', 'POST', {
        datasetId: JUDGEBENCH_DATASET_ID,
        protocol: 'pairwise',
        name: 'JudgeBench subset',
        sampleIndices: [7, 2],
      })
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body._count.items).toBe(2);

    const items = await db.goldenItem.findMany({
      where: { goldenSetId: body.id },
      orderBy: { index: 'asc' },
    });
    expect(items.map((i) => i.index)).toEqual([0, 1]);

    const seven = await db.datasetSample.findFirstOrThrow({
      where: { datasetId: JUDGEBENCH_DATASET_ID, index: 7 },
    });
    const two = await db.datasetSample.findFirstOrThrow({
      where: { datasetId: JUDGEBENCH_DATASET_ID, index: 2 },
    });
    expect(items[0].sourceDatasetSampleId).toBe(seven.id);
    expect(items[1].sourceDatasetSampleId).toBe(two.id);
  });

  it('a listwise import stores the preference as a candidate ordering', async () => {
    const user = await mkUser();
    mockSessionFor(user);

    const res = await POST(
      jsonRequest('http://localhost/api/golden-sets', 'POST', {
        datasetId: JUDGEBENCH_DATASET_ID,
        protocol: 'listwise',
        name: 'JudgeBench listwise',
        sampleIndices: [0],
      })
    );
    const body = await res.json();
    const item = await db.goldenItem.findFirstOrThrow({ where: { goldenSetId: body.id } });
    const sample = await db.datasetSample.findFirstOrThrow({
      where: { id: item.sourceDatasetSampleId },
    });
    expect(item.expected).toBe(sample.expected === 'A>B' ? '0,1' : '1,0');
  });

  it('400s on a sampleIndices value that does not exist in the dataset, creating nothing', async () => {
    const user = await mkUser();
    mockSessionFor(user);
    const before = await db.goldenSet.count();

    const res = await POST(
      jsonRequest('http://localhost/api/golden-sets', 'POST', {
        datasetId: JUDGEBENCH_DATASET_ID,
        protocol: 'pairwise',
        name: 'Bad subset',
        sampleIndices: [99999],
      })
    );
    expect(res.status).toBe(400);
    await expect(db.goldenSet.count()).resolves.toBe(before);
  });
});
