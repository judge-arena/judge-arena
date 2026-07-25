import { describe, it, expect, beforeEach } from 'vitest';
import { db, truncateAll, mkUser } from './helpers';

describe('Dataset version: samples validation and persistence', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it('creates a new version with explicit samples; the new version carries the new samples, not duplicates of the old ones', async () => {
    const user = await mkUser();

    // Create a dataset with initial samples
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

    // Add initial samples to the dataset
    const initialSample1 = await db.datasetSample.create({
      data: {
        datasetId: dataset.id,
        index: 0,
        input: 'original sample 1',
        expected: 'expected 1',
      },
    });

    const initialSample2 = await db.datasetSample.create({
      data: {
        datasetId: dataset.id,
        index: 1,
        input: 'original sample 2',
        expected: 'expected 2',
      },
    });

    // Create a new version with new samples (simulating what the POST route does)
    const newSamplesData = [
      { input: 'new sample 1', expected: 'new expected 1', metadata: { key: 'value1' } },
      { input: 'new sample 2', expected: 'new expected 2', metadata: { key: 'value2' } },
      { input: 'new sample 3', expected: null, metadata: null },
    ];

    const newVersion = await db.dataset.create({
      data: {
        name: dataset.name,
        userId: user.id,
        parentId: dataset.id,
        version: 2,
        slug: `${dataset.slug}-v2`,
        source: dataset.source,
        description: dataset.description,
        sampleCount: newSamplesData.length,
        splits: dataset.splits,
        features: dataset.features,
        tags: dataset.tags,
        samples: {
          create: newSamplesData.map((s, i) => ({
            index: i,
            input: s.input,
            expected: s.expected,
            metadata: s.metadata ? JSON.stringify(s.metadata) : null,
          })),
        },
      },
      include: {
        samples: { orderBy: { index: 'asc' } },
      },
    });

    // Verify the new version has the new samples, not duplicates of the old ones
    expect(newVersion.samples).toHaveLength(3);
    expect(newVersion.samples[0].input).toBe('new sample 1');
    expect(newVersion.samples[0].expected).toBe('new expected 1');
    expect(newVersion.samples[0].metadata).toBe(JSON.stringify({ key: 'value1' }));
    expect(newVersion.samples[1].input).toBe('new sample 2');
    expect(newVersion.samples[1].expected).toBe('new expected 2');
    expect(newVersion.samples[1].metadata).toBe(JSON.stringify({ key: 'value2' }));
    expect(newVersion.samples[2].input).toBe('new sample 3');
    expect(newVersion.samples[2].expected).toBeNull();
    expect(newVersion.samples[2].metadata).toBeNull();

    // Verify the original dataset samples are unchanged
    const originalDataset = await db.dataset.findUnique({
      where: { id: dataset.id },
      include: { samples: { orderBy: { index: 'asc' } } },
    });

    expect(originalDataset?.samples).toHaveLength(2);
    expect(originalDataset?.samples[0].input).toBe('original sample 1');
    expect(originalDataset?.samples[1].input).toBe('original sample 2');
  });

  it('creates a new version with fallback samples when samples key is absent from request; copies prior samples', async () => {
    const user = await mkUser();

    // Create a dataset with initial samples
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

    // Add initial samples
    await db.datasetSample.create({
      data: {
        datasetId: dataset.id,
        index: 0,
        input: 'sample to copy 1',
        expected: 'expected 1',
      },
    });

    await db.datasetSample.create({
      data: {
        datasetId: dataset.id,
        index: 1,
        input: 'sample to copy 2',
        expected: 'expected 2',
      },
    });

    // Get the existing samples (simulating what the route does when key is absent)
    const existingDataset = await db.dataset.findUnique({
      where: { id: dataset.id },
      include: { samples: { orderBy: { index: 'asc' } } },
    });

    if (!existingDataset) throw new Error('Dataset not found');

    // Create a new version using copied samples (no samples key in request)
    const newVersion = await db.dataset.create({
      data: {
        name: existingDataset.name,
        userId: user.id,
        parentId: dataset.id,
        version: 2,
        slug: `${dataset.slug}-v2`,
        source: existingDataset.source,
        description: existingDataset.description,
        sampleCount: existingDataset.samples.length,
        splits: existingDataset.splits,
        features: existingDataset.features,
        tags: existingDataset.tags,
        samples: {
          create: existingDataset.samples.map((s, i) => ({
            index: i,
            input: s.input,
            expected: s.expected,
            metadata: s.metadata,
          })),
        },
      },
      include: {
        samples: { orderBy: { index: 'asc' } },
      },
    });

    // Verify the new version copied the prior samples
    expect(newVersion.samples).toHaveLength(2);
    expect(newVersion.samples[0].input).toBe('sample to copy 1');
    expect(newVersion.samples[0].expected).toBe('expected 1');
    expect(newVersion.samples[1].input).toBe('sample to copy 2');
    expect(newVersion.samples[1].expected).toBe('expected 2');
  });

  it('handles metadata as JSON objects correctly', async () => {
    const user = await mkUser();

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

    const complexMetadata = {
      source: 'arxiv',
      score: 0.95,
      tags: ['important', 'reviewed'],
      nested: { key: 'value', count: 42 },
    };

    const newVersion = await db.dataset.create({
      data: {
        name: dataset.name,
        userId: user.id,
        parentId: dataset.id,
        version: 2,
        slug: `${dataset.slug}-v2`,
        source: dataset.source,
        description: dataset.description,
        sampleCount: 1,
        splits: dataset.splits,
        features: dataset.features,
        tags: dataset.tags,
        samples: {
          create: [
            {
              index: 0,
              input: 'test input',
              expected: 'test expected',
              metadata: JSON.stringify(complexMetadata),
            },
          ],
        },
      },
      include: {
        samples: { orderBy: { index: 'asc' } },
      },
    });

    // Verify metadata is stored correctly
    expect(newVersion.samples).toHaveLength(1);
    expect(newVersion.samples[0].metadata).toBe(JSON.stringify(complexMetadata));

    // Verify it can be parsed back
    const parsedMetadata = JSON.parse(newVersion.samples[0].metadata || '{}');
    expect(parsedMetadata).toEqual(complexMetadata);
  });
});
