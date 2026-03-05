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
  });
});
