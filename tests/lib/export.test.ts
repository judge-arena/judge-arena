import { describe, it, expect } from 'vitest';
import {
  escapeCsvField,
  toCsv,
  toJsonl,
  flattenDatasetSample,
  flattenEvaluationForExport,
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

  describe('flattenEvaluationForExport', () => {
    const criteriaScoresArray = [{ criterionId: 'x', score: 4 }];

    // Minimal evaluation-shaped fixture the function actually reads.
    function buildEvaluation(
      modelCriteriaScores: unknown,
      humanCriteriaScores?: unknown
    ) {
      return {
        id: 'eval-1',
        title: 'Test Evaluation',
        inputText: 'input',
        runs: [
          {
            id: 'run-1',
            status: 'completed',
            createdAt: '2026-07-24T00:00:00.000Z',
            humanJudgment:
              humanCriteriaScores === undefined
                ? undefined
                : {
                    overallScore: 9,
                    reasoning: 'human take',
                    criteriaScores: humanCriteriaScores,
                  },
            modelJudgments: [
              {
                status: 'completed',
                overallScore: 8,
                reasoning: 'looks good',
                rawResponse: '{}',
                criteriaScores: modelCriteriaScores,
                latencyMs: 120,
                tokenCount: 42,
                modelConfig: { id: 'model-gpt-4', name: 'GPT-4', provider: 'openai', modelId: 'gpt-4' },
              },
            ],
          },
        ],
      };
    }

    it('serializes an object-array criteriaScores exactly once (no double-stringify)', () => {
      const evaluation = buildEvaluation(criteriaScoresArray, criteriaScoresArray);
      const rows = flattenEvaluationForExport(evaluation);
      const expectedJson = JSON.stringify(criteriaScoresArray);

      expect(rows).toHaveLength(1);
      // CSV cell: already a plain JSON string, not re-escaped/re-encoded.
      expect(rows[0].model_criteria_scores).toBe(expectedJson);
      expect(rows[0].human_criteria_scores).toBe(expectedJson);

      const csv = toCsv(rows as unknown as Array<Record<string, unknown>>);
      expect(csv).toContain(expectedJson.replace(/"/g, '""'));

      // JSONL: the line must parse back to an object whose criteria_scores
      // fields are STRINGS containing valid JSON — i.e. stringified exactly
      // once (matches v1's export format). A double-stringify bug would
      // instead show up as a JSON string containing escaped quotes
      // (`"[{\"criterionId\"...`) rather than parsing cleanly.
      const jsonl = toJsonl(rows as unknown as Array<Record<string, unknown>>);
      const parsedLine = JSON.parse(jsonl.trim().split('\n')[0]);

      expect(typeof parsedLine.model_criteria_scores).toBe('string');
      expect(JSON.parse(parsedLine.model_criteria_scores)).toEqual(criteriaScoresArray);

      expect(typeof parsedLine.human_criteria_scores).toBe('string');
      expect(JSON.parse(parsedLine.human_criteria_scores)).toEqual(criteriaScoresArray);
    });

    it('emits an empty field for null criteriaScores (model and human)', () => {
      const evaluation = buildEvaluation(null, null);
      const rows = flattenEvaluationForExport(evaluation);

      expect(rows).toHaveLength(1);
      expect(rows[0].model_criteria_scores).toBe('');
      expect(rows[0].human_criteria_scores).toBe('');

      const jsonl = toJsonl(rows as unknown as Array<Record<string, unknown>>);
      const parsedLine = JSON.parse(jsonl.trim().split('\n')[0]);
      expect(parsedLine.model_criteria_scores).toBe('');
      expect(parsedLine.human_criteria_scores).toBe('');
    });

    it('emits fallback values when modelConfig is null', () => {
      const evaluation = {
        id: 'eval-1',
        title: 'Test Evaluation',
        inputText: 'input',
        runs: [
          {
            id: 'run-1',
            status: 'completed',
            createdAt: '2026-07-24T00:00:00.000Z',
            modelJudgments: [
              {
                status: 'completed',
                overallScore: 8,
                reasoning: 'looks good',
                rawResponse: '{}',
                criteriaScores: criteriaScoresArray,
                latencyMs: 120,
                tokenCount: 42,
                modelConfig: null,
              },
            ],
          },
        ],
      };
      const rows = flattenEvaluationForExport(evaluation);

      expect(rows).toHaveLength(1);
      expect(rows[0].model_name).toBe('unknown-model');
      expect(rows[0].model_provider).toBe('unknown');
      expect(rows[0].model_id).toBe('unknown');

      // Verify CSV row is produced without throwing
      const csv = toCsv(rows as unknown as Array<Record<string, unknown>>);
      expect(csv).toContain('unknown-model');
      expect(csv).toContain('unknown');

      // Verify JSONL row is produced without throwing
      const jsonl = toJsonl(rows as unknown as Array<Record<string, unknown>>);
      const parsedLine = JSON.parse(jsonl.trim().split('\n')[0]);
      expect(parsedLine.model_name).toBe('unknown-model');
      expect(parsedLine.model_provider).toBe('unknown');
      expect(parsedLine.model_id).toBe('unknown');
    });
  });
});
