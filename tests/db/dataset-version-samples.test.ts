import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { getServerSession } from 'next-auth';
import { db, truncateAll, mkUser } from './helpers';
import { POST } from '@/app/api/datasets/[id]/versions/route';

// Mock next-auth's getServerSession so requireAuth() resolves a real session
// for a fixture user created in the test DB — this lets us call the exported
// POST handler directly instead of re-implementing its logic in the test.
vi.mock('next-auth', () => ({
  getServerSession: vi.fn(),
}));

// requireAuth() checks for a Bearer API key via next/headers before falling
// back to the session. Mock it to report no auth header so the session path
// is exercised.
vi.mock('next/headers', () => ({
  headers: vi.fn(async () => new Headers()),
}));

function mockSessionFor(user: { id: string; email: string }) {
  (getServerSession as unknown as Mock).mockResolvedValue({
    user: { id: user.id, email: user.email },
  });
}

function postRequest(body?: unknown) {
  const init: RequestInit = { method: 'POST' };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'content-type': 'application/json' };
  }
  return new Request('http://localhost/api/datasets/fixture/versions', init);
}

describe('Dataset version: samples validation and persistence (real POST route)', () => {
  beforeEach(async () => {
    await truncateAll();
    (getServerSession as unknown as Mock).mockReset();
  });

  it('valid samples → 201 + new version carries only the new samples', async () => {
    const user = await mkUser();
    mockSessionFor(user);

    const dataset = await db.dataset.create({
      data: {
        name: 'Test Dataset',
        userId: user.id,
        source: 'local',
        description: 'Test description',
        sampleCount: 2,
        splits: JSON.stringify(['train']),
        features: JSON.stringify([]),
        tags: JSON.stringify([]),
      },
    });

    await db.datasetSample.create({
      data: { datasetId: dataset.id, index: 0, input: 'original sample 1', expected: 'expected 1' },
    });
    await db.datasetSample.create({
      data: { datasetId: dataset.id, index: 1, input: 'original sample 2', expected: 'expected 2' },
    });

    const response = await POST(
      postRequest({
        samples: [
          { input: 'new sample 1', expected: 'new expected 1', metadata: { key: 'value1' } },
          { input: 'new sample 2', expected: 'new expected 2', metadata: { key: 'value2' } },
          { input: 'new sample 3', expected: null },
        ],
      }),
      { params: Promise.resolve({ id: dataset.id }) }
    );

    expect(response.status).toBe(201);
    const newVersion = await response.json();

    expect(newVersion.samples).toHaveLength(3);
    expect(newVersion.samples[0].input).toBe('new sample 1');
    expect(newVersion.samples[0].expected).toBe('new expected 1');
    expect(newVersion.samples[0].metadata).toBe(JSON.stringify({ key: 'value1' }));
    expect(newVersion.samples[1].input).toBe('new sample 2');
    expect(newVersion.samples[2].input).toBe('new sample 3');
    expect(newVersion.samples[2].expected).toBeNull();
    expect(newVersion.samples[2].metadata).toBeNull();

    // Original dataset samples are unchanged
    const originalDataset = await db.dataset.findUnique({
      where: { id: dataset.id },
      include: { samples: { orderBy: { index: 'asc' } } },
    });
    expect(originalDataset?.samples).toHaveLength(2);
    expect(originalDataset?.samples[0].input).toBe('original sample 1');
    expect(originalDataset?.samples[1].input).toBe('original sample 2');
  });

  it('`{}` body → 201 + prior samples copied (samples key absent)', async () => {
    const user = await mkUser();
    mockSessionFor(user);

    const dataset = await db.dataset.create({
      data: {
        name: 'Test Dataset',
        userId: user.id,
        source: 'local',
        description: 'Test description',
        sampleCount: 2,
        splits: JSON.stringify(['train']),
        features: JSON.stringify([]),
        tags: JSON.stringify([]),
      },
    });

    await db.datasetSample.create({
      data: { datasetId: dataset.id, index: 0, input: 'sample to copy 1', expected: 'expected 1' },
    });
    await db.datasetSample.create({
      data: { datasetId: dataset.id, index: 1, input: 'sample to copy 2', expected: 'expected 2' },
    });

    const response = await POST(postRequest({}), { params: Promise.resolve({ id: dataset.id }) });

    expect(response.status).toBe(201);
    const newVersion = await response.json();

    expect(newVersion.samples).toHaveLength(2);
    expect(newVersion.samples[0].input).toBe('sample to copy 1');
    expect(newVersion.samples[0].expected).toBe('expected 1');
    expect(newVersion.samples[1].input).toBe('sample to copy 2');
    expect(newVersion.samples[1].expected).toBe('expected 2');
  });

  it('NO body (regression) → 201 + fallback to prior samples, no throw', async () => {
    const user = await mkUser();
    mockSessionFor(user);

    const dataset = await db.dataset.create({
      data: {
        name: 'Test Dataset',
        userId: user.id,
        source: 'local',
        description: 'Test description',
        sampleCount: 1,
        splits: JSON.stringify(['train']),
        features: JSON.stringify([]),
        tags: JSON.stringify([]),
      },
    });

    await db.datasetSample.create({
      data: { datasetId: dataset.id, index: 0, input: 'no-body sample', expected: 'expected' },
    });

    // No body at all — request.json() throws (empty stream) unless the
    // route catches it and falls back gracefully.
    const response = await POST(postRequest(undefined), { params: Promise.resolve({ id: dataset.id }) });

    expect(response.status).toBe(201);
    const newVersion = await response.json();
    expect(newVersion.samples).toHaveLength(1);
    expect(newVersion.samples[0].input).toBe('no-body sample');
  });

  it('`null` body (regression) → 201 + fallback to prior samples, no throw', async () => {
    const user = await mkUser();
    mockSessionFor(user);

    const dataset = await db.dataset.create({
      data: {
        name: 'Test Dataset',
        userId: user.id,
        source: 'local',
        description: 'Test description',
        sampleCount: 1,
        splits: JSON.stringify(['train']),
        features: JSON.stringify([]),
        tags: JSON.stringify([]),
      },
    });

    await db.datasetSample.create({
      data: { datasetId: dataset.id, index: 0, input: 'null-body sample', expected: 'expected' },
    });

    // Body parses to JS `null` — `'samples' in body` throws unless guarded.
    const response = await POST(postRequest(null), { params: Promise.resolve({ id: dataset.id }) });

    expect(response.status).toBe(201);
    const newVersion = await response.json();
    expect(newVersion.samples).toHaveLength(1);
    expect(newVersion.samples[0].input).toBe('null-body sample');
  });

  it('invalid samples (string, not array) → 400 + no new version row created', async () => {
    const user = await mkUser();
    mockSessionFor(user);

    const dataset = await db.dataset.create({
      data: {
        name: 'Test Dataset',
        userId: user.id,
        source: 'local',
        description: 'Test description',
        sampleCount: 1,
        splits: JSON.stringify(['train']),
        features: JSON.stringify([]),
        tags: JSON.stringify([]),
      },
    });

    await db.datasetSample.create({
      data: { datasetId: dataset.id, index: 0, input: 'sample', expected: 'expected' },
    });

    const countBefore = await db.dataset.count();

    const response = await POST(
      postRequest({ samples: 'not-an-array' }),
      { params: Promise.resolve({ id: dataset.id }) }
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('Validation failed');

    const countAfter = await db.dataset.count();
    expect(countAfter).toBe(countBefore);
  });

  it('handles metadata as JSON objects correctly', async () => {
    const user = await mkUser();
    mockSessionFor(user);

    const dataset = await db.dataset.create({
      data: {
        name: 'Test Dataset',
        userId: user.id,
        source: 'local',
        description: 'Test description',
        sampleCount: 1,
        splits: JSON.stringify(['train']),
        features: JSON.stringify([]),
        tags: JSON.stringify([]),
      },
    });

    await db.datasetSample.create({
      data: { datasetId: dataset.id, index: 0, input: 'seed sample', expected: 'expected' },
    });

    const complexMetadata = {
      source: 'arxiv',
      score: 0.95,
      tags: ['important', 'reviewed'],
      nested: { key: 'value', count: 42 },
    };

    const response = await POST(
      postRequest({ samples: [{ input: 'test input', expected: 'test expected', metadata: complexMetadata }] }),
      { params: Promise.resolve({ id: dataset.id }) }
    );

    expect(response.status).toBe(201);
    const newVersion = await response.json();

    expect(newVersion.samples).toHaveLength(1);
    expect(newVersion.samples[0].metadata).toBe(JSON.stringify(complexMetadata));

    const parsedMetadata = JSON.parse(newVersion.samples[0].metadata || '{}');
    expect(parsedMetadata).toEqual(complexMetadata);
  });
});
