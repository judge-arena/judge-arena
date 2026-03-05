import { describe, it, expect } from 'vitest';
import {
  escapeCsvField,
  toCsv,
  toJsonl,
  flattenDatasetSample,
} from '@/lib/export';

describe('export', () => {
  describe('escapeCsvField', () => {
    it('should return empty string for null/undefined', () => {
      expect(escapeCsvField(null)).toBe('');
      expect(escapeCsvField(undefined)).toBe('');
    });

    it('should pass through simple strings', () => {
      expect(escapeCsvField('hello')).toBe('hello');
    });

    it('should quote strings with commas', () => {
      expect(escapeCsvField('hello, world')).toBe('"hello, world"');
    });

    it('should escape double quotes', () => {
      expect(escapeCsvField('say "hello"')).toBe('"say ""hello"""');
    });

    it('should quote strings with newlines', () => {
      expect(escapeCsvField('line1\nline2')).toBe('"line1\nline2"');
    });

    it('should JSON-stringify objects', () => {
      expect(escapeCsvField({ key: 'value' })).toBe('"{""key"":""value""}"');
    });

    it('should convert numbers to string', () => {
      expect(escapeCsvField(42)).toBe('42');
    });
  });

  describe('toCsv', () => {
    it('should return empty string for empty array', () => {
      expect(toCsv([])).toBe('');
    });

    it('should generate valid CSV with headers', () => {
      const rows = [
        { name: 'Alice', score: 95 },
        { name: 'Bob', score: 87 },
      ];
      const csv = toCsv(rows);
      const lines = csv.trimEnd().split('\n');
      expect(lines[0]).toBe('name,score');
      expect(lines[1]).toBe('Alice,95');
      expect(lines[2]).toBe('Bob,87');
    });

    it('should handle rows with different columns', () => {
      const rows = [
        { a: 1, b: 2 },
        { b: 3, c: 4 },
      ];
      const csv = toCsv(rows);
      const lines = csv.trimEnd().split('\n');
      expect(lines[0]).toBe('a,b,c');
      expect(lines[1]).toBe('1,2,');
      expect(lines[2]).toBe(',3,4');
    });
  });

  describe('toJsonl', () => {
    it('should produce one JSON object per line', () => {
      const rows = [
        { name: 'Alice', score: 95 },
        { name: 'Bob', score: 87 },
      ];
      const jsonl = toJsonl(rows);
      const lines = jsonl.trimEnd().split('\n');
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0])).toEqual({ name: 'Alice', score: 95 });
      expect(JSON.parse(lines[1])).toEqual({ name: 'Bob', score: 87 });
    });
  });

  describe('flattenDatasetSample', () => {
    it('should flatten a sample with all fields', () => {
      const result = flattenDatasetSample({
        index: 0,
        input: 'prompt text',
        expected: 'expected output',
        metadata: '{"key": "value"}',
      });

      expect(result).toEqual({
        sample_index: 0,
        input: 'prompt text',
        expected: 'expected output',
        metadata: '{"key": "value"}',
      });
    });

    it('should handle null optional fields', () => {
      const result = flattenDatasetSample({
        index: 5,
        input: 'prompt',
        expected: null,
        metadata: null,
      });

      expect(result.expected).toBe('');
      expect(result.metadata).toBe('');
    });
  });
});
