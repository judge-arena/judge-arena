import { describe, it, expect } from 'vitest';
import { createVersionSchema } from '@/app/api/datasets/[id]/versions/schema';

describe('createVersionSchema validation', () => {
  it('accepts valid samples array with all fields', () => {
    const valid = {
      samples: [
        {
          input: 'test input',
          expected: 'test expected',
          metadata: { key: 'value' },
        },
        {
          input: 'another input',
          expected: null,
          metadata: { nested: { data: true } },
        },
      ],
    };

    const result = createVersionSchema.safeParse(valid);
    expect(result.success).toBe(true);
    if (result.success && result.data.samples) {
      expect(result.data.samples).toHaveLength(2);
      expect(result.data.samples[0].input).toBe('test input');
      expect(result.data.samples[0].expected).toBe('test expected');
      expect(result.data.samples[0].metadata).toEqual({ key: 'value' });
      expect(result.data.samples[1].expected).toBeNull();
    }
  });

  it('accepts valid samples with missing optional fields', () => {
    const valid = {
      samples: [
        { input: 'just input' },
        { input: 'with expected', expected: 'expected' },
      ],
    };

    const result = createVersionSchema.safeParse(valid);
    expect(result.success).toBe(true);
    if (result.success && result.data.samples) {
      expect(result.data.samples).toHaveLength(2);
      expect(result.data.samples[0].expected).toBeUndefined();
      expect(result.data.samples[0].metadata).toBeUndefined();
      expect(result.data.samples[1].expected).toBe('expected');
    }
  });

  it('accepts body with absent samples key (fallback signal)', () => {
    const noSamples = {};
    const result = createVersionSchema.safeParse(noSamples);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.samples).toBeUndefined();
    }
  });

  it('accepts body with samples: undefined', () => {
    const undefinedSamples = { samples: undefined };
    const result = createVersionSchema.safeParse(undefinedSamples);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.samples).toBeUndefined();
    }
  });

  it('rejects samples as string (not array)', () => {
    const invalid = {
      samples: 'not-an-array',
    };

    const result = createVersionSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('rejects samples as object (not array)', () => {
    const invalid = {
      samples: { input: 'test', expected: 'test' },
    };

    const result = createVersionSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('rejects sample with empty input string', () => {
    const invalid = {
      samples: [{ input: '', expected: 'test' }],
    };

    const result = createVersionSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('rejects sample missing required input field', () => {
    const invalid = {
      samples: [{ expected: 'test' }],
    };

    const result = createVersionSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('accepts sample with expected as null', () => {
    const valid = {
      samples: [{ input: 'test', expected: null }],
    };

    const result = createVersionSchema.safeParse(valid);
    expect(result.success).toBe(true);
    if (result.success && result.data.samples) {
      expect(result.data.samples[0].expected).toBeNull();
    }
  });

  it('accepts sample with unexpected extra fields (zod allows unknown fields by default)', () => {
    const withExtra = {
      samples: [{ input: 'test', extra: 'field' }],
    };

    const result = createVersionSchema.safeParse(withExtra);
    expect(result.success).toBe(true);
    if (result.success && result.data.samples) {
      expect(result.data.samples[0].input).toBe('test');
    }
  });

  it('accepts empty samples array', () => {
    const valid = {
      samples: [],
    };

    const result = createVersionSchema.safeParse(valid);
    expect(result.success).toBe(true);
    if (result.success && result.data.samples) {
      expect(result.data.samples).toHaveLength(0);
    }
  });

  it('accepts complex metadata objects', () => {
    const complexMetadata = {
      source: 'arxiv',
      score: 0.95,
      tags: ['important', 'reviewed'],
      nested: { key: 'value', count: 42, arr: [1, 2, 3] },
    };

    const valid = {
      samples: [
        {
          input: 'test',
          metadata: complexMetadata,
        },
      ],
    };

    const result = createVersionSchema.safeParse(valid);
    expect(result.success).toBe(true);
    if (result.success && result.data.samples) {
      expect(result.data.samples[0].metadata).toEqual(complexMetadata);
    }
  });
});
