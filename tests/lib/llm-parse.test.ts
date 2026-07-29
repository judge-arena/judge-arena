import { describe, expect, it } from 'vitest';
import { parseJudgmentResponse, tryParseStructuredJudgment } from '@/lib/llm/provider';
import { computeWeightedScore } from '@/lib/utils';
import type { RubricCriterionView } from '@/types';

const criteria: RubricCriterionView[] = [
  { id: 'c1', rubricId: 'r1', name: 'Accuracy', description: 'desc', maxScore: 10, weight: 2, order: 0 },
  { id: 'c2', rubricId: 'r1', name: 'Clarity', description: 'desc', maxScore: 5, weight: 1, order: 1 },
];

describe('parseJudgmentResponse: NaN normalization (1b correctness carry)', () => {
  it('a normal, well-formed response parses as before (parseMode "fallback")', () => {
    const raw = JSON.stringify({
      overallScore: 7,
      reasoning: 'solid',
      criteriaScores: [
        { criterionId: 'c1', criterionName: 'Accuracy', score: 8, comment: 'good' },
        { criterionId: 'c2', criterionName: 'Clarity', score: 4, comment: 'clear' },
      ],
    });

    const result = parseJudgmentResponse(raw, criteria);
    expect(result.overallScore).toBe(7);
    expect(result.parseMode).toBe('fallback');
    expect(result.criteriaScores.map((c) => c.score)).toEqual([8, 4]);
  });

  it('CRITICAL: a literal NaN overallScore in the raw JSON does not propagate as NaN — recomputed from criteria weights', () => {
    // NaN is not valid JSON, but a model can still emit it (many LLMs treat
    // JSON generation loosely) — JSON.parse would normally throw on this,
    // so exercise the exact code path via a value that survives JSON.parse
    // as a non-finite number: Infinity is likewise invalid JSON, but
    // "1e400" parses to Infinity through JSON.parse without complaint.
    const raw = JSON.stringify({
      reasoning: 'r',
      criteriaScores: [
        { criterionId: 'c1', criterionName: 'Accuracy', score: 8 },
        { criterionId: 'c2', criterionName: 'Clarity', score: 4 },
      ],
    }).replace('"reasoning"', '"overallScore": 1e400, "reasoning"');

    const result = parseJudgmentResponse(raw, criteria);
    expect(Number.isFinite(result.overallScore)).toBe(true);
    expect(result.overallScore).toBe(
      computeWeightedScore([
        { score: 8, weight: 2, maxScore: 10 },
        { score: 4, weight: 1, maxScore: 5 },
      ])
    );
  });

  it('a missing overallScore is recomputed from criteriaScores weights (not defaulted to 0)', () => {
    const raw = JSON.stringify({
      reasoning: 'r',
      criteriaScores: [
        { criterionId: 'c1', criterionName: 'Accuracy', score: 10 },
        { criterionId: 'c2', criterionName: 'Clarity', score: 5 },
      ],
    });

    const result = parseJudgmentResponse(raw, criteria);
    // both criteria maxed out -> weighted score should be the max, 10
    expect(result.overallScore).toBe(10);
  });

  it('missing overallScore AND no criteria at all -> 0 (no signal to recompute from)', () => {
    const raw = JSON.stringify({ reasoning: 'r', criteriaScores: [] });
    const result = parseJudgmentResponse(raw, []);
    expect(result.overallScore).toBe(0);
  });

  it('CRITICAL: a non-finite per-criterion score does not propagate as NaN — clamped to 0 instead', () => {
    const raw = JSON.stringify({
      overallScore: 5,
      reasoning: 'r',
      criteriaScores: [
        { criterionId: 'c1', criterionName: 'Accuracy', score: 8 },
        { criterionId: 'c2', criterionName: 'Clarity' }, // score omitted entirely — exercises the same non-finite-guard path
      ],
    });

    const result = parseJudgmentResponse(raw, criteria);
    const clarityScore = result.criteriaScores.find((c) => c.criterionId === 'c2')!;
    expect(Number.isFinite(clarityScore.score)).toBe(true);
    expect(clarityScore.score).toBe(0);
  });

  it('a legitimate score of exactly 0 is preserved, not misread as "missing" (falsy-zero guard)', () => {
    const raw = JSON.stringify({
      overallScore: 0,
      reasoning: 'worst possible',
      criteriaScores: [{ criterionId: 'c1', criterionName: 'Accuracy', score: 0 }],
    });

    const result = parseJudgmentResponse(raw, criteria);
    // A naive `?? 0` fallback can't distinguish these from "absent" either,
    // but the real risk is a naive truthiness check (`if (!score)`) or a
    // recompute-when-falsy branch — assert the LITERAL 0 survives untouched
    // rather than triggering the missing-value recompute path.
    expect(result.overallScore).toBe(0);
    expect(result.criteriaScores.find((c) => c.criterionId === 'c1')!.score).toBe(0);
  });

  it('an out-of-range overallScore is still clamped to [0, 10] (unchanged pre-existing behavior)', () => {
    const raw = JSON.stringify({ overallScore: 999, reasoning: 'r', criteriaScores: [] });
    const result = parseJudgmentResponse(raw, criteria);
    expect(result.overallScore).toBe(10);
  });

  it('an out-of-range per-criterion score is still clamped to [0, maxScore] (unchanged pre-existing behavior)', () => {
    const raw = JSON.stringify({
      overallScore: 5,
      reasoning: 'r',
      criteriaScores: [{ criterionId: 'c1', criterionName: 'Accuracy', score: 999 }],
    });
    const result = parseJudgmentResponse(raw, criteria);
    const accuracy = result.criteriaScores.find((c) => c.criterionId === 'c1')!;
    expect(accuracy.score).toBe(10); // clamped to maxScore
  });

  it('parses JSON wrapped in a markdown code block, unchanged behavior', () => {
    const raw = '```json\n' + JSON.stringify({ overallScore: 6, reasoning: 'r', criteriaScores: [] }) + '\n```';
    const result = parseJudgmentResponse(raw, []);
    expect(result.overallScore).toBe(6);
  });

  it('throws a clear error for genuinely unparseable text', () => {
    expect(() => parseJudgmentResponse('not json at all', criteria)).toThrow(/Failed to parse LLM judgment response/);
  });
});

describe('tryParseStructuredJudgment: non-object criteriaScores elements never throw (1b Task 11 review MINOR fix)', () => {
  // `tryParseStructuredJudgment`'s docstring claims "never throws", but a
  // criteriaScores array containing a non-object element (e.g. `null`) used
  // to reach `normalizeParsedJudgment`'s `cs.criterionId` property access on
  // that element and throw an uncaught TypeError — `registry.ts`'s
  // `executeJudgmentCall` has no try/catch around this call, so the whole
  // judgment call would fail instead of degrading to the fallback parse it
  // was designed to. These tests exercise the exact real-world composition
  // registry.ts's `parseJudgmentText` uses on identical raw text:
  // `tryParseStructuredJudgment(...) ?? parseJudgmentResponse(...)`.

  it('a criteriaScores array containing null rejects the structured parse (returns undefined, does NOT throw) — the lenient fallback then succeeds on the identical raw text, parseMode "fallback"', () => {
    const raw = JSON.stringify({
      overallScore: 8,
      reasoning: 'solid',
      criteriaScores: [null],
    });

    expect(() => tryParseStructuredJudgment(raw, criteria)).not.toThrow();
    expect(tryParseStructuredJudgment(raw, criteria)).toBeUndefined();

    expect(() => parseJudgmentResponse(raw, criteria)).not.toThrow();
    const fallback = parseJudgmentResponse(raw, criteria);
    expect(fallback.parseMode).toBe('fallback');
    expect(fallback.overallScore).toBe(8);
    // The null element matched nothing — both criteria fall back to 0,
    // exactly as if criteriaScores had been empty.
    expect(fallback.criteriaScores.map((c) => c.score)).toEqual([0, 0]);
  });

  it('a criteriaScores array mixing a well-formed object with a non-object element ("notanobject") also rejects the structured parse and falls back cleanly, preserving the well-formed entry\'s score', () => {
    const raw = JSON.stringify({
      overallScore: 6,
      reasoning: 'mixed',
      criteriaScores: [{ criterionId: 'c1', criterionName: 'Accuracy', score: 9 }, 'notanobject'],
    });

    expect(() => tryParseStructuredJudgment(raw, criteria)).not.toThrow();
    expect(tryParseStructuredJudgment(raw, criteria)).toBeUndefined();

    const fallback = parseJudgmentResponse(raw, criteria);
    expect(fallback.parseMode).toBe('fallback');
    expect(fallback.criteriaScores.find((c) => c.criterionId === 'c1')!.score).toBe(9);
    expect(fallback.criteriaScores.find((c) => c.criterionId === 'c2')!.score).toBe(0);
  });

  it('a conforming (all-record) criteriaScores array still parses via the strict path, unaffected by the new element check', () => {
    const raw = JSON.stringify({
      overallScore: 9,
      reasoning: 'clean',
      criteriaScores: [
        { criterionId: 'c1', criterionName: 'Accuracy', score: 10 },
        { criterionId: 'c2', criterionName: 'Clarity', score: 5 },
      ],
    });

    const result = tryParseStructuredJudgment(raw, criteria);
    expect(result).toBeDefined();
    expect(result!.parseMode).toBe('structured');
    expect(result!.overallScore).toBe(9);
  });
});
