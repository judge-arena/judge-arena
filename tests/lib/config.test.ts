import { describe, it, expect } from 'vitest';
import {
  generateSlug,
  generateUniqueSlug,
  serializeConfig,
  deserializeConfig,
  dbProjectToConfig,
  dbRubricToConfig,
  dbModelToConfig,
  dbDatasetToConfig,
  dbGoldenSetToConfig,
  configDocumentSchema,
} from '@/lib/config';

describe('config', () => {
  describe('generateSlug', () => {
    it('should convert name to slug', () => {
      expect(generateSlug('My Project')).toBe('my-project');
    });

    it('should strip special characters', () => {
      expect(generateSlug('Hello, World!')).toBe('hello-world');
    });

    it('should collapse multiple hyphens', () => {
      expect(generateSlug('hello---world')).toBe('hello-world');
    });

    it('should trim leading/trailing hyphens', () => {
      expect(generateSlug('-hello-')).toBe('hello');
    });

    it('should return unnamed for empty strings', () => {
      expect(generateSlug('   ')).toBe('unnamed');
      expect(generateSlug('!!!')).toBe('unnamed');
    });

    it('should truncate to 80 chars', () => {
      const long = 'a'.repeat(100);
      expect(generateSlug(long).length).toBeLessThanOrEqual(80);
    });
  });

  describe('generateUniqueSlug', () => {
    it('should return base slug if not taken', () => {
      expect(generateUniqueSlug('Test', ['other'])).toBe('test');
    });

    it('should append counter if slug exists', () => {
      expect(generateUniqueSlug('Test', ['test'])).toBe('test-2');
    });

    it('should increment counter until unique', () => {
      expect(generateUniqueSlug('Test', ['test', 'test-2', 'test-3'])).toBe('test-4');
    });
  });

  describe('serializeConfig / deserializeConfig', () => {
    it('should round-trip a config document', () => {
      const config = {
        version: '1.0' as const,
        exportedAt: '2025-01-01T00:00:00Z',
        projects: [
          { slug: 'test-project', name: 'Test Project', isDefault: false },
        ],
        rubrics: [
          {
            slug: 'quality',
            name: 'Quality',
            version: 1,
            criteria: [
              { name: 'Accuracy', description: 'Is it correct?', maxScore: 10, weight: 1, order: 0 },
            ],
          },
        ],
        models: [
          { slug: 'claude', name: 'Claude', provider: 'anthropic', modelId: 'claude-3-haiku', isActive: true },
        ],
        datasets: [],
        goldenSets: [],
      };

      const yaml = serializeConfig(config);
      expect(yaml).toContain('version: "1.0"');

      const parsed = deserializeConfig(yaml);
      expect(parsed.projects[0].name).toBe('Test Project');
      expect(parsed.rubrics[0].criteria).toHaveLength(1);
      expect(parsed.models[0].provider).toBe('anthropic');
    });

    it('should throw on invalid YAML', () => {
      expect(() => deserializeConfig('version: 2.0')).toThrow();
    });

    // Task 12 review fix: config export now emits the model's REAL
    // ServingBackend (src/app/api/config/export/route.ts), not the legacy
    // 3-value ModelConfig.provider string — the model's `provider` field
    // must accept the full set so a catalog+endpoint-domain export
    // round-trips through import without failing validation.
    it('should round-trip a model with a real (non-legacy) ServingBackend provider value', () => {
      const config = {
        version: '1.0' as const,
        exportedAt: '2025-01-01T00:00:00Z',
        projects: [],
        rubrics: [],
        models: [
          { slug: 'self-hosted-judge', name: 'Self-Hosted Judge', provider: 'vllm', modelId: 'meta-llama/Llama-3-70b-Instruct', isActive: true },
        ],
        datasets: [],
        goldenSets: [],
      };

      const yaml = serializeConfig(config);
      const parsed = deserializeConfig(yaml);
      expect(parsed.models[0].provider).toBe('vllm');
    });

    it('should still accept the legacy "local" provider value (backward-compat with pre-fix exports)', () => {
      const result = configDocumentSchema.safeParse({
        version: '1.0',
        exportedAt: '2025-01-01',
        models: [
          { slug: 'legacy-local', name: 'Legacy Local Judge', provider: 'local', modelId: 'local-model', isActive: true },
        ],
      });
      expect(result.success).toBe(true);
    });
  });

  describe('configDocumentSchema', () => {
    it('should accept a minimal valid document', () => {
      const result = configDocumentSchema.safeParse({
        version: '1.0',
        exportedAt: '2025-01-01',
      });
      expect(result.success).toBe(true);
    });

    it('should reject invalid version', () => {
      const result = configDocumentSchema.safeParse({
        version: '2.0',
        exportedAt: '2025-01-01',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('DB converters', () => {
    it('dbProjectToConfig should convert project', () => {
      const result = dbProjectToConfig({
        name: 'My Project',
        description: 'A test project',
        isDefault: false,
        slug: 'my-project',
      });
      expect(result).toEqual({
        slug: 'my-project',
        name: 'My Project',
        description: 'A test project',
        isDefault: false,
      });
    });

    it('dbProjectToConfig should generate slug from name if missing', () => {
      const result = dbProjectToConfig({ name: 'Auto Slug' });
      expect(result.slug).toBe('auto-slug');
    });

    it('dbRubricToConfig should include criteria', () => {
      const result = dbRubricToConfig({
        name: 'Test Rubric',
        version: 2,
        criteria: [
          { name: 'C1', description: 'Desc', maxScore: 10, weight: 1.5, order: 0 },
        ],
      });
      expect(result.version).toBe(2);
      expect(result.criteria).toHaveLength(1);
      expect(result.criteria[0].weight).toBe(1.5);
    });

    it('dbModelToConfig should exclude API keys', () => {
      const result = dbModelToConfig({
        name: 'Claude',
        provider: 'anthropic',
        modelId: 'claude-3',
        apiKey: 'secret-key',
        isActive: true,
      });
      expect(result).not.toHaveProperty('apiKey');
    });

    it('dbDatasetToConfig should parse tags from JSON string', () => {
      const result = dbDatasetToConfig({
        name: 'Test Dataset',
        source: 'local',
        visibility: 'private',
        tags: '["nlp","benchmark"]',
      });
      expect(result.tags).toEqual(['nlp', 'benchmark']);
    });

    it('dbGoldenSetToConfig embeds items and candidates and emits the dataset as a slug', () => {
      const result = dbGoldenSetToConfig({
        slug: 'gs-alpha',
        name: 'Golden Set Alpha',
        description: 'a description',
        visibility: 'private',
        protocol: 'pairwise',
        version: 2,
        dataset: { slug: 'ds-alpha', name: 'Dataset Alpha' },
        items: [
          {
            index: 0,
            inputText: 'who wrote hamlet',
            promptText: null,
            responseText: null,
            expected: 'A>B',
            candidates: [
              { position: 0, promptText: null, responseText: 'shakespeare', label: 'A' },
              { position: 1, promptText: null, responseText: 'bacon', label: 'B' },
            ],
          },
        ],
      });

      expect(result).toEqual({
        slug: 'gs-alpha',
        name: 'Golden Set Alpha',
        description: 'a description',
        visibility: 'private',
        protocol: 'pairwise',
        datasetSlug: 'ds-alpha',
        version: 2,
        items: [
          {
            index: 0,
            inputText: 'who wrote hamlet',
            expected: 'A>B',
            candidates: [
              { position: 0, responseText: 'shakespeare', label: 'A' },
              { position: 1, responseText: 'bacon', label: 'B' },
            ],
          },
        ],
      });
    });

    it('dbGoldenSetToConfig falls back to a generated slug for both the set and its dataset', () => {
      const result = dbGoldenSetToConfig({
        name: 'Auto Slug Set',
        visibility: 'public',
        protocol: 'pointwise',
        dataset: { slug: null, name: 'Auto Slug Dataset' },
        items: [],
      });
      expect(result.slug).toBe('auto-slug-set');
      expect(result.datasetSlug).toBe('auto-slug-dataset');
      expect(result.version).toBe(1);
      expect(result.items).toEqual([]);
    });

    it('dbGoldenSetToConfig emits item- and candidate-level prompt/response text when they are set, and omits empty ones', () => {
      // The other direction of every conditional in the converter: the case
      // above has promptText/responseText null on the item and no prompt on
      // the candidates, which is what all three protocol mappings produce
      // today (src/lib/golden-sets.ts). A hand-built or future set can carry
      // them, and they have to survive the export.
      const result = dbGoldenSetToConfig({
        slug: 'gs-verbose',
        name: 'Verbose Set',
        protocol: 'pointwise',
        dataset: { slug: 'ds-verbose' },
        items: [
          {
            index: 3,
            inputText: 'summarise this',
            promptText: 'You are a summariser.',
            responseText: 'a summary',
            expected: null,
            candidates: [
              { position: 0, promptText: 'candidate prompt', responseText: 'candidate response', label: null },
            ],
          },
        ],
      });

      expect(result.items[0]).toEqual({
        index: 3,
        inputText: 'summarise this',
        promptText: 'You are a summariser.',
        responseText: 'a summary',
        candidates: [{ position: 0, promptText: 'candidate prompt', responseText: 'candidate response' }],
      });
      // Absent, not emitted as null — `goldenItemSchema` types these optional.
      expect(result.items[0]).not.toHaveProperty('expected');
      expect(result.items[0].candidates[0]).not.toHaveProperty('label');
    });

    it('configDocumentSchema accepts a goldenSets section and defaults it to []', () => {
      const withGolden = configDocumentSchema.safeParse({
        version: '1.0',
        exportedAt: '2026-01-01',
        goldenSets: [
          {
            slug: 'gs-alpha',
            name: 'Golden Set Alpha',
            protocol: 'pairwise',
            datasetSlug: 'ds-alpha',
            items: [{ index: 0, inputText: 'q', candidates: [{ position: 0, responseText: 'r' }] }],
          },
        ],
      });
      expect(withGolden.success).toBe(true);
      if (withGolden.success) {
        expect(withGolden.data.goldenSets[0].version).toBe(1);
        expect(withGolden.data.goldenSets[0].visibility).toBe('private');
      }

      const withoutGolden = configDocumentSchema.safeParse({ version: '1.0', exportedAt: '2026-01-01' });
      expect(withoutGolden.success).toBe(true);
      if (withoutGolden.success) expect(withoutGolden.data.goldenSets).toEqual([]);
    });
  });
});
