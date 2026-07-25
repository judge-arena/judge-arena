import { describe, it, expect, beforeEach } from 'vitest';
import { db, truncateAll, mkUser } from './helpers';
import { buildRefreshUpdate } from '@/lib/dataset-refresh-update';
import { DatasetMetadata } from '@/lib/huggingface';
import { DatasetEvaluationSummary } from '@/lib/dataset-evaluation-summary';

describe('Dataset refresh: evaluation summary and sample count preservation', () => {
  describe('buildRefreshUpdate function', () => {
    it('preserves evaluationSummary when merging fresh HF metadata', () => {
      const existingSummary: DatasetEvaluationSummary = {
        updatedAt: '2026-07-21T12:00:00Z',
        sampleCount: 5,
        samplesWithModelScores: 3,
        samplesWithHumanScores: 2,
        averageModelScore: 4.2,
        averageHumanScore: 4.5,
      };

      const existingMetadata = {
        id: 'test-dataset',
        evaluationSummary: existingSummary,
        someOtherField: 'value',
      };

      const freshHfMeta: DatasetMetadata = {
        id: 'test-dataset',
        name: 'Test Dataset',
        author: 'test-author',
        description: 'Updated description',
        lastModified: '2026-07-21T10:00:00Z',
        isPrivate: false,
        downloads: 1000,
        likes: 50,
        tags: ['test', 'dataset'],
        cardData: { task_categories: ['text-classification'] },
        splits: ['train', 'test'],
        features: [],
        sampleCount: 1000, // HF corpus total - should be ignored
        configs: ['default'],
        configSplits: { default: ['train', 'test'] },
        serverCapabilities: null,
        hasDatasetScript: false,
      };

      const localSampleCount = 5;

      const result = buildRefreshUpdate(
        JSON.stringify(existingMetadata),
        freshHfMeta,
        localSampleCount
      );

      const updatedMetadata = JSON.parse(result.remoteMetadata);

      // evaluationSummary should be preserved
      expect(updatedMetadata.evaluationSummary).toEqual(existingSummary);

      // Fresh HF fields should be updated
      expect(updatedMetadata.description).toBe('Updated description');
      expect(updatedMetadata.downloads).toBe(1000);
      expect(updatedMetadata.likes).toBe(50);
      expect(updatedMetadata.lastModified).toBe('2026-07-21T10:00:00Z');

      // sampleCount should be local count, not HF total
      expect(result.sampleCount).toBe(5);
      expect(result.sampleCount).not.toBe(1000);
    });

    it('drops evaluationSummary when it does not exist in existing metadata', () => {
      const existingMetadata = {
        id: 'test-dataset',
        someField: 'value',
      };

      const freshHfMeta: DatasetMetadata = {
        id: 'test-dataset',
        name: 'Test Dataset',
        author: 'test-author',
        description: 'New description',
        lastModified: '2026-07-21T10:00:00Z',
        isPrivate: false,
        downloads: 500,
        likes: 25,
        tags: [],
        cardData: {},
        splits: [],
        features: [],
        sampleCount: 500,
        configs: [],
        configSplits: {},
        serverCapabilities: null,
        hasDatasetScript: false,
      };

      const result = buildRefreshUpdate(
        JSON.stringify(existingMetadata),
        freshHfMeta,
        10
      );

      const updatedMetadata = JSON.parse(result.remoteMetadata);

      expect(updatedMetadata.evaluationSummary).toBeUndefined();
      expect(result.sampleCount).toBe(10);
    });

    it('handles null existing metadata gracefully', () => {
      const freshHfMeta: DatasetMetadata = {
        id: 'new-dataset',
        name: 'New Dataset',
        author: 'author',
        description: 'Description',
        lastModified: '2026-07-21T10:00:00Z',
        isPrivate: false,
        downloads: 0,
        likes: 0,
        tags: [],
        cardData: {},
        splits: [],
        features: [],
        sampleCount: 100,
        configs: [],
        configSplits: {},
        serverCapabilities: null,
        hasDatasetScript: false,
      };

      const result = buildRefreshUpdate(null, freshHfMeta, 25);

      const updatedMetadata = JSON.parse(result.remoteMetadata);

      expect(updatedMetadata.id).toBe('new-dataset');
      expect(updatedMetadata.evaluationSummary).toBeUndefined();
      expect(result.sampleCount).toBe(25);
    });

    it('handles malformed existing metadata gracefully', () => {
      const freshHfMeta: DatasetMetadata = {
        id: 'test-dataset',
        name: 'Test',
        author: 'author',
        description: 'Description',
        lastModified: '2026-07-21T10:00:00Z',
        isPrivate: false,
        downloads: 0,
        likes: 0,
        tags: [],
        cardData: {},
        splits: [],
        features: [],
        sampleCount: 100,
        configs: [],
        configSplits: {},
        serverCapabilities: null,
        hasDatasetScript: false,
      };

      // Malformed JSON
      const result = buildRefreshUpdate('{ invalid json', freshHfMeta, 15);

      const updatedMetadata = JSON.parse(result.remoteMetadata);

      expect(updatedMetadata.id).toBe('test-dataset');
      expect(updatedMetadata.evaluationSummary).toBeUndefined();
      expect(result.sampleCount).toBe(15);
    });
  });

  describe('Database persistence', () => {
    beforeEach(async () => {
      await truncateAll();
    });

    it('preserves evaluationSummary in remoteMetadata after refresh', async () => {
      const user = await mkUser();

      // Create a dataset with remote metadata and an evaluation summary
      const existingSummary: DatasetEvaluationSummary = {
        updatedAt: '2026-07-21T12:00:00Z',
        sampleCount: 5,
        samplesWithModelScores: 3,
        samplesWithHumanScores: 2,
        averageModelScore: 4.2,
        averageHumanScore: 4.5,
      };

      const initialRemoteMetadata = {
        id: 'huggingface/dataset',
        name: 'Original Dataset',
        description: 'Original description',
        evaluationSummary: existingSummary,
        oldField: 'old-value',
      };

      const dataset = await db.dataset.create({
        data: {
          name: 'Test Dataset',
          userId: user.id,
          source: 'remote',
          huggingFaceId: 'test/dataset',
          sourceUrl: 'https://huggingface.co/datasets/test/dataset',
          description: 'Original description',
          remoteMetadata: JSON.stringify(initialRemoteMetadata),
          sampleCount: 5,
          splits: JSON.stringify(['train']),
          features: JSON.stringify([]),
          tags: JSON.stringify([]),
        },
      });

      // Create some local samples
      for (let i = 0; i < 5; i++) {
        await db.datasetSample.create({
          data: {
            datasetId: dataset.id,
            index: i,
            input: `sample ${i}`,
          },
        });
      }

      // Simulate fresh HF metadata (simulating what fetchDatasetMetadata returns)
      const freshHfMeta: DatasetMetadata = {
        id: 'huggingface/dataset',
        name: 'Updated Dataset',
        author: 'test-author',
        description: 'Updated description from HF',
        lastModified: '2026-07-21T10:00:00Z',
        isPrivate: false,
        downloads: 1000,
        likes: 50,
        tags: ['new-tag'],
        cardData: { updated: true },
        splits: ['train', 'val', 'test'],
        features: [],
        sampleCount: 1000, // HF corpus total - should NOT override local count
        configs: ['default'],
        configSplits: { default: ['train', 'val', 'test'] },
        serverCapabilities: null,
        hasDatasetScript: true,
      };

      // Get the existing metadata and sample count
      const existingDataset = await db.dataset.findUnique({
        where: { id: dataset.id },
        include: { _count: { select: { samples: true } } },
      });

      if (!existingDataset) throw new Error('Dataset not found');

      // Build the update using the utility function
      const refreshUpdate = buildRefreshUpdate(
        existingDataset.remoteMetadata,
        freshHfMeta,
        existingDataset._count.samples
      );

      // Apply the update to the database
      const updated = await db.dataset.update({
        where: { id: dataset.id },
        data: {
          description: freshHfMeta.description,
          remoteMetadata: refreshUpdate.remoteMetadata,
          sampleCount: refreshUpdate.sampleCount,
          splits: JSON.stringify(freshHfMeta.splits),
          features: JSON.stringify(freshHfMeta.features),
          tags: JSON.stringify(freshHfMeta.tags),
        },
        include: {
          _count: { select: { samples: true } },
        },
      });

      // Verify that evaluationSummary is preserved
      expect(updated.remoteMetadata).not.toBeNull();
      const updatedMetadata = JSON.parse(updated.remoteMetadata!);

      expect(updatedMetadata.evaluationSummary).toEqual(existingSummary);

      // Verify that HF fields were updated
      expect(updatedMetadata.description).toBe('Updated description from HF');
      expect(updatedMetadata.downloads).toBe(1000);
      expect(updatedMetadata.lastModified).toBe('2026-07-21T10:00:00Z');
      expect(updatedMetadata.name).toBe('Updated Dataset');

      // Verify that the sample count is the local count, not HF total
      expect(updated.sampleCount).toBe(5);
      expect(updated._count.samples).toBe(5);

      // Verify other fields were updated
      expect(updated.description).toBe('Updated description from HF');
      expect(updated.splits).not.toBeNull();
      expect(JSON.parse(updated.splits!)).toEqual(['train', 'val', 'test']);
    });

    it('creates proper remoteMetadata when no existing evaluation summary', async () => {
      const user = await mkUser();

      const initialRemoteMetadata = {
        id: 'huggingface/fresh-dataset',
        name: 'Fresh Dataset',
      };

      const dataset = await db.dataset.create({
        data: {
          name: 'Fresh Dataset',
          userId: user.id,
          source: 'remote',
          huggingFaceId: 'fresh/dataset',
          sourceUrl: 'https://huggingface.co/datasets/fresh/dataset',
          description: 'Fresh dataset',
          remoteMetadata: JSON.stringify(initialRemoteMetadata),
          sampleCount: 0,
          splits: JSON.stringify([]),
          features: JSON.stringify([]),
          tags: JSON.stringify([]),
        },
      });

      // Create 3 local samples
      for (let i = 0; i < 3; i++) {
        await db.datasetSample.create({
          data: {
            datasetId: dataset.id,
            index: i,
            input: `sample ${i}`,
          },
        });
      }

      const freshHfMeta: DatasetMetadata = {
        id: 'huggingface/fresh-dataset',
        name: 'Fresh Dataset from HF',
        author: 'fresh-author',
        description: 'Fresh dataset description',
        lastModified: '2026-07-21T09:00:00Z',
        isPrivate: false,
        downloads: 100,
        likes: 10,
        tags: ['fresh'],
        cardData: {},
        splits: ['train'],
        features: [],
        sampleCount: 500,
        configs: [],
        configSplits: {},
        serverCapabilities: null,
        hasDatasetScript: false,
      };

      const existingDataset = await db.dataset.findUnique({
        where: { id: dataset.id },
        include: { _count: { select: { samples: true } } },
      });

      if (!existingDataset) throw new Error('Dataset not found');

      const refreshUpdate = buildRefreshUpdate(
        existingDataset.remoteMetadata,
        freshHfMeta,
        existingDataset._count.samples
      );

      const updated = await db.dataset.update({
        where: { id: dataset.id },
        data: {
          description: freshHfMeta.description,
          remoteMetadata: refreshUpdate.remoteMetadata,
          sampleCount: refreshUpdate.sampleCount,
          splits: JSON.stringify(freshHfMeta.splits),
          features: JSON.stringify(freshHfMeta.features),
          tags: JSON.stringify(freshHfMeta.tags),
        },
        include: {
          _count: { select: { samples: true } },
        },
      });

      expect(updated.remoteMetadata).not.toBeNull();
      const updatedMetadata = JSON.parse(updated.remoteMetadata!);

      expect(updatedMetadata.name).toBe('Fresh Dataset from HF');
      expect(updatedMetadata.description).toBe('Fresh dataset description');
      expect(updatedMetadata.evaluationSummary).toBeUndefined();
      expect(updated.sampleCount).toBe(3); // 3 local samples, not HF's 500
    });
  });
});
