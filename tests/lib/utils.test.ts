import { describe, it, expect } from 'vitest';
// Value import, not `import type`: the ServingBackend coverage test below
// enumerates the enum at runtime. Same precedent as tests/lib/append-retry
// .test.ts's `import { Prisma }` — reading the generated client's enum
// object needs no database, so the DB-free unit run stays DB-free.
import { ServingBackend } from '@prisma/client';
import {
  cn,
  formatDate,
  formatLatency,
  truncate,
  computeWeightedScore,
  resolveHumanJudgmentScore,
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

  describe('resolveHumanJudgmentScore', () => {
    describe('judge mode', () => {
      it('should use explicit overallScore when provided', () => {
        const result = resolveHumanJudgmentScore({
          mode: 'judge',
          overallScore: 8.5,
          criteriaScores: undefined,
        });
        expect(result).toBe(8.5);
      });

      it('should use explicit overallScore even when criteriaScores is also provided', () => {
        const criteriaScores = [
          { score: 8, weight: 2, maxScore: 10 },
          { score: 6, weight: 1, maxScore: 10 },
        ];
        const result = resolveHumanJudgmentScore({
          mode: 'judge',
          overallScore: 9.5,
          criteriaScores,
        });
        // Should return the explicit value, not the computed one
        expect(result).toBe(9.5);
      });

      it('should compute overallScore from criteriaScores when overallScore is missing', () => {
        const criteriaScores = [
          { score: 8, weight: 2, maxScore: 10 },
          { score: 6, weight: 1, maxScore: 10 },
        ];
        const result = resolveHumanJudgmentScore({
          mode: 'judge',
          overallScore: undefined,
          criteriaScores,
        });
        // (0.8*2 + 0.6*1) / 3 * 10 = 7.333...
        expect(result).toBeCloseTo(7.333, 2);
      });

      it('should throw error when both overallScore and criteriaScores are missing', () => {
        expect(() =>
          resolveHumanJudgmentScore({ mode: 'judge', overallScore: undefined, criteriaScores: undefined })
        ).toThrow('overallScore or criteriaScores required');
      });

      it('should throw error when both overallScore and criteriaScores are null', () => {
        expect(() =>
          resolveHumanJudgmentScore({ mode: 'judge', overallScore: undefined, criteriaScores: null })
        ).toThrow('overallScore or criteriaScores required');
      });

      it('should throw error when criteriaScores is empty array', () => {
        expect(() =>
          resolveHumanJudgmentScore({ mode: 'judge', overallScore: undefined, criteriaScores: [] })
        ).toThrow('overallScore or criteriaScores required');
      });

      it('should handle 0 as valid explicit overallScore', () => {
        const result = resolveHumanJudgmentScore({
          mode: 'judge',
          overallScore: 0,
          criteriaScores: undefined,
        });
        expect(result).toBe(0);
      });
    });

    describe('respond mode', () => {
      it('should return the 0 placeholder when overallScore and criteriaScores are both absent', () => {
        const result = resolveHumanJudgmentScore({
          mode: 'respond',
          overallScore: undefined,
          criteriaScores: [],
        });
        expect(result).toBe(0);
      });

      it('should never throw, even though judge mode would reject the same empty payload', () => {
        expect(() =>
          resolveHumanJudgmentScore({ mode: 'respond', overallScore: undefined, criteriaScores: undefined })
        ).not.toThrow();
      });

      it('should ignore overallScore/criteriaScores if present and still return 0', () => {
        // Respond mode never receives these from the form, but resolution
        // must not depend on the caller withholding them correctly.
        const result = resolveHumanJudgmentScore({
          mode: 'respond',
          overallScore: 9,
          criteriaScores: [{ score: 8, weight: 2, maxScore: 10 }],
        });
        expect(result).toBe(0);
      });
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

    it('renders llamacpp as llama.cpp with its own colour, not the unknown-provider grey', () => {
      const info = getProviderInfo('llamacpp');
      // The default branch returns the raw `provider` string, so an
      // unhandled ServingBackend does not look broken — it renders as a grey
      // "llamacpp" chip and reads like a deliberate style. Asserting the
      // pretty label AND the absence of grey is what distinguishes "handled"
      // from "fell through"; the label alone would pass on the raw string if
      // the case were ever removed.
      expect(info.label).toBe('llama.cpp');
      expect(info.color).not.toContain('gray');
    });

    it('gives every ServingBackend its own handled case, and a distinct colour', () => {
      // The backend list is DERIVED from prisma's enum, never hand-copied.
      // A copied literal reproduces, inside the test, the exact drift this
      // change exists to fix: the next `ServingBackend` added to the schema
      // would be missing from getProviderInfo AND from the list policing
      // it, and the suite would stay green. Measured — with a literal list
      // here, deleting `case 'ollama'` from getProviderInfo left all 37
      // tests passing while a real backend rendered as a grey raw slug.
      const backends = Object.values(ServingBackend);

      // Falling through to `default` is the silent failure: it returns the
      // raw enum slug on a grey chip, which reads as a deliberate style
      // rather than an unhandled case. Both halves are needed — the colour
      // catches an added case that forgot a colour, the label catches a
      // case that was never added at all.
      for (const backend of backends) {
        const info = getProviderInfo(backend);
        expect(info.color, `${backend} fell through to the unknown-provider grey`).not.toContain('gray');
        expect(info.label, `${backend} renders as its raw enum slug`).not.toBe(backend);
      }

      // getProviderInfo is the only thing separating these in the UI. vllm
      // and the legacy 'local' deliberately share purple (both mean
      // self-hosted, and 'local' is the pre-Task-12 spelling of the same
      // thing), so 'local' is not a ServingBackend and not in this set —
      // every other pair must differ, or a llamacpp endpoint is visually
      // indistinguishable from the ollama one it is NOT interchangeable
      // with (ollama is refused for scored runs).
      const colors = backends.map((b) => getProviderInfo(b).color);
      expect(new Set(colors).size).toBe(backends.length);
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
