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
      lenient: false,
    });
  });

  it('parses B', () => {
    expect(tryParsePairwiseJudgment('{"verdict":"B","reasoning":"B is complete"}')).toEqual({
      verdict: 'B',
      reasoning: 'B is complete',
      lenient: false,
    });
  });

  it('parses tie', () => {
    expect(tryParsePairwiseJudgment('{"verdict":"tie","reasoning":"neither wins"}')).toEqual({
      verdict: 'tie',
      reasoning: 'neither wins',
      lenient: false,
    });
  });

  it('strips a ```json markdown fence, like parseJudgmentResponse does — and reports it as lenient', () => {
    const raw = 'Here you go:\n```json\n{"verdict":"B","reasoning":"clearer"}\n```\n';
    expect(tryParsePairwiseJudgment(raw)).toEqual({ verdict: 'B', reasoning: 'clearer', lenient: true });
  });

  it('strips a bare ``` fence too — lenient', () => {
    const raw = '```\n{"verdict":"A","reasoning":"r"}\n```';
    expect(tryParsePairwiseJudgment(raw)).toEqual({ verdict: 'A', reasoning: 'r', lenient: true });
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
      lenient: false,
    });
  });

  it('ignores extra properties the model volunteers — and does NOT count them as lenient (extra keys are not repair)', () => {
    expect(
      tryParsePairwiseJudgment('{"verdict":"A","reasoning":"r","confidence":0.9}')
    ).toEqual({ verdict: 'A', reasoning: 'r', lenient: false });
  });
});

/**
 * #11 (handoff 2026-09-01 §7). `lenient` is the pairwise mirror of the
 * pointwise strict-then-lenient demotion: TRUE whenever the parser had to
 * REPAIR the text to read it — a fence was stripped, or the verdict needed
 * case/whitespace normalisation. registry.ts turns this into
 * `parseMode: 'structured' | 'fallback'`. The whole point is that a
 * guided-decoding backend whose output needed no repair is distinguishable,
 * afterwards, from one that wrapped its JSON in ``` or wrote "a".
 */
describe('tryParsePairwiseJudgment: the lenient flag', () => {
  it('is false for bare JSON with a canonical verdict', () => {
    expect(tryParsePairwiseJudgment('{"verdict":"tie","reasoning":"r"}')?.lenient).toBe(false);
  });

  it('is true when a ```json fence had to be stripped, even with a canonical verdict', () => {
    expect(tryParsePairwiseJudgment('```json\n{"verdict":"A","reasoning":"r"}\n```')?.lenient).toBe(true);
  });

  it('is true when the verdict needed case repair ("a", "TIE", "Tie")', () => {
    expect(tryParsePairwiseJudgment('{"verdict":"a","reasoning":"r"}')?.lenient).toBe(true);
    expect(tryParsePairwiseJudgment('{"verdict":"TIE","reasoning":"r"}')?.lenient).toBe(true);
    expect(tryParsePairwiseJudgment('{"verdict":"Tie","reasoning":"r"}')?.lenient).toBe(true);
  });

  it('is true when the verdict needed whitespace repair (" A ")', () => {
    expect(tryParsePairwiseJudgment('{"verdict":" A ","reasoning":"r"}')?.lenient).toBe(true);
  });

  it('is false when only the OUTER text had surrounding whitespace (trim is not repair of the verdict)', () => {
    expect(tryParsePairwiseJudgment('  \n{"verdict":"B","reasoning":"r"}\n  ')?.lenient).toBe(false);
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
