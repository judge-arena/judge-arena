import { describe, it, expect } from 'vitest';
import {
  cn,
  formatDate,
  formatLatency,
  truncate,
  computeWeightedScore,
  resolveHumanOverallScore,
  getStatusColor,
  getScoreColor,
  getProviderInfo,
  safeParseJSON,
  generateId,
} from '@/lib/utils';

describe('utils', () => {
  describe('cn', () => {
    it('should merge class names', () => {
      expect(cn('foo', 'bar')).toBe('foo bar');
    });

    it('should handle conditional classes', () => {
      expect(cn('base', false && 'hidden', 'visible')).toBe('base visible');
    });

    it('should merge tailwind classes correctly', () => {
      expect(cn('px-2 py-1', 'px-4')).toBe('py-1 px-4');
    });
  });

  describe('formatDate', () => {
    it('should format a Date object', () => {
      const date = new Date('2025-06-15T12:00:00Z');
      const result = formatDate(date);
      expect(result).toContain('2025');
      expect(result).toContain('Jun');
      expect(result).toContain('15');
    });

    it('should format a date string', () => {
      // Use midday UTC to avoid timezone-dependent date shifts
      const result = formatDate('2025-06-15T12:00:00Z');
      expect(result).toContain('2025');
    });
  });

  describe('formatLatency', () => {
    it('should format milliseconds', () => {
      expect(formatLatency(500)).toBe('500ms');
    });

    it('should format seconds', () => {
      expect(formatLatency(2500)).toBe('2.5s');
    });

    it('should format minutes', () => {
      expect(formatLatency(90000)).toBe('1.5m');
    });
  });

  describe('truncate', () => {
    it('should not truncate short strings', () => {
      expect(truncate('hello', 10)).toBe('hello');
    });

    it('should truncate long strings with ellipsis', () => {
      expect(truncate('hello world', 8)).toBe('hello...');
    });

    it('should handle exact length', () => {
      expect(truncate('hello', 5)).toBe('hello');
    });
  });

  describe('computeWeightedScore', () => {
    it('should compute weighted average', () => {
      const scores = [
        { score: 8, weight: 2, maxScore: 10 },
        { score: 6, weight: 1, maxScore: 10 },
      ];
      const result = computeWeightedScore(scores);
      // (0.8*2 + 0.6*1) / 3 * 10 = 7.333...
      expect(result).toBeCloseTo(7.333, 2);
    });

    it('should return 0 for empty array', () => {
      expect(computeWeightedScore([])).toBe(0);
    });

    it('should handle zero total weight', () => {
      const scores = [{ score: 5, weight: 0, maxScore: 10 }];
      expect(computeWeightedScore(scores)).toBe(0);
    });
  });

  describe('resolveHumanOverallScore', () => {
    it('should use explicit overallScore when provided', () => {
      const result = resolveHumanOverallScore(8.5, undefined);
      expect(result).toBe(8.5);
    });

    it('should use explicit overallScore even when criteriaScores is also provided', () => {
      const criteriaScores = [
        { score: 8, weight: 2, maxScore: 10 },
        { score: 6, weight: 1, maxScore: 10 },
      ];
      const result = resolveHumanOverallScore(9.5, criteriaScores);
      // Should return the explicit value, not the computed one
      expect(result).toBe(9.5);
    });

    it('should compute overallScore from criteriaScores when overallScore is missing', () => {
      const criteriaScores = [
        { score: 8, weight: 2, maxScore: 10 },
        { score: 6, weight: 1, maxScore: 10 },
      ];
      const result = resolveHumanOverallScore(undefined, criteriaScores);
      // (0.8*2 + 0.6*1) / 3 * 10 = 7.333...
      expect(result).toBeCloseTo(7.333, 2);
    });

    it('should throw error when both overallScore and criteriaScores are missing', () => {
      expect(() => resolveHumanOverallScore(undefined, undefined)).toThrow(
        'overallScore or criteriaScores required'
      );
    });

    it('should throw error when both overallScore and criteriaScores are null', () => {
      expect(() => resolveHumanOverallScore(undefined, null)).toThrow(
        'overallScore or criteriaScores required'
      );
    });

    it('should throw error when criteriaScores is empty array', () => {
      expect(() => resolveHumanOverallScore(undefined, [])).toThrow(
        'overallScore or criteriaScores required'
      );
    });

    it('should handle 0 as valid explicit overallScore', () => {
      const result = resolveHumanOverallScore(0, undefined);
      expect(result).toBe(0);
    });
  });

  describe('getStatusColor', () => {
    it('should return correct colors for known statuses', () => {
      expect(getStatusColor('pending')).toContain('amber');
      expect(getStatusColor('completed')).toContain('emerald');
      expect(getStatusColor('error')).toContain('red');
      expect(getStatusColor('judging')).toContain('blue');
    });

    it('should return gray for unknown status', () => {
      expect(getStatusColor('unknown')).toContain('gray');
    });
  });

  describe('getScoreColor', () => {
    it('should return green for high scores', () => {
      expect(getScoreColor(9)).toContain('emerald');
    });

    it('should return red for low scores', () => {
      expect(getScoreColor(2)).toContain('red');
    });
  });

  describe('getProviderInfo', () => {
    it('should return correct info for known providers', () => {
      expect(getProviderInfo('anthropic').label).toBe('Anthropic');
      expect(getProviderInfo('openai').label).toBe('OpenAI');
      expect(getProviderInfo('local').label).toBe('Local');
    });

    it('should return raw name for unknown providers', () => {
      expect(getProviderInfo('custom').label).toBe('custom');
    });
  });

  describe('safeParseJSON', () => {
    it('should parse valid JSON', () => {
      expect(safeParseJSON('{"key":"value"}', {})).toEqual({ key: 'value' });
    });

    it('should return fallback for invalid JSON', () => {
      expect(safeParseJSON('not json', 'fallback')).toBe('fallback');
    });

    it('should return fallback for null/undefined', () => {
      expect(safeParseJSON(null, [])).toEqual([]);
      expect(safeParseJSON(undefined, [])).toEqual([]);
    });
  });

  describe('generateId', () => {
    it('should generate unique IDs', () => {
      const id1 = generateId();
      const id2 = generateId();
      expect(id1).not.toBe(id2);
    });

    it('should contain a timestamp component', () => {
      const id = generateId();
      expect(id).toContain('-');
    });
  });
});
