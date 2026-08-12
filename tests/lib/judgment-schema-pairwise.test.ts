import { describe, expect, it } from 'vitest';
import {
  PAIRWISE_JUDGMENT_JSON_SCHEMA,
  tryParsePairwiseJudgment,
  JUDGMENT_JSON_SCHEMA,
} from '@/lib/llm/judgment-schema';

describe('PAIRWISE_JUDGMENT_JSON_SCHEMA', () => {
  it('requires exactly verdict and reasoning', () => {
    expect(PAIRWISE_JUDGMENT_JSON_SCHEMA.required).toEqual(['verdict', 'reasoning']);
  });

  it('does NOT require any of the pointwise fields (a pairwise judge emits no scores)', () => {
    const required = PAIRWISE_JUDGMENT_JSON_SCHEMA.required as readonly string[];
    expect(required).not.toContain('overallScore');
    expect(required).not.toContain('criteriaScores');
    expect(Object.keys(PAIRWISE_JUDGMENT_JSON_SCHEMA.properties)).toEqual(['verdict', 'reasoning']);
  });

  it('constrains verdict to the three legal values', () => {
    expect(PAIRWISE_JUDGMENT_JSON_SCHEMA.properties.verdict.enum).toEqual(['A', 'B', 'tie']);
    expect(PAIRWISE_JUDGMENT_JSON_SCHEMA.properties.verdict.type).toBe('string');
    expect(PAIRWISE_JUDGMENT_JSON_SCHEMA.properties.reasoning.type).toBe('string');
  });

  it('is a distinct object from the pointwise schema (guided decoding must not be handed the wrong one)', () => {
    expect(PAIRWISE_JUDGMENT_JSON_SCHEMA).not.toBe(JUDGMENT_JSON_SCHEMA);
    expect(JUDGMENT_JSON_SCHEMA.required).toEqual(['overallScore', 'reasoning', 'criteriaScores']);
  });
});

describe('tryParsePairwiseJudgment: conforming responses', () => {
  it('parses a bare JSON object', () => {
    expect(tryParsePairwiseJudgment('{"verdict":"A","reasoning":"A is more accurate"}')).toEqual({
      verdict: 'A',
      reasoning: 'A is more accurate',
    });
  });

  it('parses B', () => {
    expect(tryParsePairwiseJudgment('{"verdict":"B","reasoning":"B is complete"}')).toEqual({
      verdict: 'B',
      reasoning: 'B is complete',
    });
  });

  it('parses tie', () => {
    expect(tryParsePairwiseJudgment('{"verdict":"tie","reasoning":"neither wins"}')).toEqual({
      verdict: 'tie',
      reasoning: 'neither wins',
    });
  });

  it('strips a ```json markdown fence, like parseJudgmentResponse does', () => {
    const raw = 'Here you go:\n```json\n{"verdict":"B","reasoning":"clearer"}\n```\n';
    expect(tryParsePairwiseJudgment(raw)).toEqual({ verdict: 'B', reasoning: 'clearer' });
  });

  it('strips a bare ``` fence too', () => {
    const raw = '```\n{"verdict":"A","reasoning":"r"}\n```';
    expect(tryParsePairwiseJudgment(raw)).toEqual({ verdict: 'A', reasoning: 'r' });
  });

  it('normalizes verdict casing and surrounding whitespace', () => {
    expect(tryParsePairwiseJudgment('{"verdict":" a ","reasoning":"r"}')?.verdict).toBe('A');
    expect(tryParsePairwiseJudgment('{"verdict":"b","reasoning":"r"}')?.verdict).toBe('B');
    expect(tryParsePairwiseJudgment('{"verdict":"TIE","reasoning":"r"}')?.verdict).toBe('tie');
    expect(tryParsePairwiseJudgment('{"verdict":"Tie","reasoning":"r"}')?.verdict).toBe('tie');
  });

  it('accepts an empty-string reasoning (present and a string is the contract)', () => {
    expect(tryParsePairwiseJudgment('{"verdict":"A","reasoning":""}')).toEqual({
      verdict: 'A',
      reasoning: '',
    });
  });

  it('ignores extra properties the model volunteers', () => {
    expect(
      tryParsePairwiseJudgment('{"verdict":"A","reasoning":"r","confidence":0.9}')
    ).toEqual({ verdict: 'A', reasoning: 'r' });
  });
});

describe('tryParsePairwiseJudgment: non-conforming responses return null and never throw', () => {
  const cases: Array<[string, string]> = [
    ['not JSON at all', 'Response A is better, obviously.'],
    ['a JSON array', '[{"verdict":"A","reasoning":"r"}]'],
    ['a JSON scalar', '42'],
    ['JSON null', 'null'],
    ['a verdict outside the enum', '{"verdict":"C","reasoning":"r"}'],
    ['an empty verdict', '{"verdict":"","reasoning":"r"}'],
    ['a non-string verdict', '{"verdict":1,"reasoning":"r"}'],
    ['a missing verdict', '{"reasoning":"r"}'],
    ['a missing reasoning', '{"verdict":"A"}'],
    ['a non-string reasoning', '{"verdict":"A","reasoning":{"text":"r"}}'],
    ['a POINTWISE-shaped judgment', '{"overallScore":7,"reasoning":"r","criteriaScores":[]}'],
    ['an empty string', ''],
    ['whitespace only', '   \n  '],
  ];

  for (const [label, raw] of cases) {
    it(`returns null for ${label}`, () => {
      expect(() => tryParsePairwiseJudgment(raw)).not.toThrow();
      expect(tryParsePairwiseJudgment(raw)).toBeNull();
    });
  }
});
