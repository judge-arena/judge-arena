import { describe, expect, it } from 'vitest';
import { parseJudgmentResponse, tryParseStructuredJudgment } from '@/lib/llm/provider';
import { ProviderError } from '@/lib/llm/errors';
import { computeWeightedScore } from '@/lib/utils';
import type { RubricCriterionView } from '@/types';

const criteria: RubricCriterionView[] = [
  { id: 'c1', rubricId: 'r1', name: 'Accuracy', description: 'desc', maxScore: 10, weight: 2, order: 0 },
  { id: 'c2', rubricId: 'r1', name: 'Clarity', description: 'desc', maxScore: 5, weight: 1, order: 1 },
];

/** Five criteria, for the "model returned 4 of 5" partial-parse case. */
const fiveCriteria: RubricCriterionView[] = [
  { id: 'k1', rubricId: 'r2', name: 'Accuracy', description: 'd', maxScore: 10, weight: 1, order: 0 },
  { id: 'k2', rubricId: 'r2', name: 'Clarity', description: 'd', maxScore: 10, weight: 1, order: 1 },
  { id: 'k3', rubricId: 'r2', name: 'Depth', description: 'd', maxScore: 10, weight: 1, order: 2 },
  { id: 'k4', rubricId: 'r2', name: 'Tone', description: 'd', maxScore: 10, weight: 1, order: 3 },
  { id: 'k5', rubricId: 'r2', name: 'Safety', description: 'd', maxScore: 10, weight: 1, order: 4 },
];

/** Run `fn`, return whatever it threw (fails the test if it didn't throw). */
function captureThrow(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw, but it returned normally');
}

describe('parseJudgmentResponse: an unscored criterion is a loud failure, never a fabricated 0', () => {
  // The bug this suite pins: `finiteNumberOrUndefined(found?.score) ?? 0`
  // turned "the judge never scored this criterion" into a real, persisted
  // 0, the overall score was then recomputed FROM those zeros, and the
  // judgment was written with status 'completed'. Nothing downstream — the
  // leaderboard, the calibration input — could tell a fabricated 0/10 from
  // a judge that genuinely hated the submission. The pairwise path already
  // refuses to guess (registry.ts's `executePairwiseCall`: no usable
  // verdict -> `non_retryable` ProviderError); these tests hold the
  // pointwise path to the same contract.

  it('CRITICAL: a criterion the model never scored throws instead of yielding 0', () => {
    const raw = JSON.stringify({
      overallScore: 5,
      reasoning: 'r',
      criteriaScores: [{ criterionId: 'c1', criterionName: 'Accuracy', score: 8 }],
    });

    expect(() => parseJudgmentResponse(raw, criteria)).toThrow(/Clarity/);
  });

  it('CRITICAL: a criterion present but with the score key omitted throws instead of yielding 0', () => {
    const raw = JSON.stringify({
      overallScore: 5,
      reasoning: 'r',
      criteriaScores: [
        { criterionId: 'c1', criterionName: 'Accuracy', score: 8 },
        { criterionId: 'c2', criterionName: 'Clarity', comment: 'no score given' },
      ],
    });

    expect(() => parseJudgmentResponse(raw, criteria)).toThrow(/Clarity/);
  });

  it('CRITICAL: an empty criteriaScores array against a real rubric throws — it must not produce an all-zero judgment', () => {
    const raw = JSON.stringify({ overallScore: 4, reasoning: 'r', criteriaScores: [] });

    const error = captureThrow(() => parseJudgmentResponse(raw, criteria));
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as Error).message).toMatch(/Accuracy/);
    expect((error as Error).message).toMatch(/Clarity/);
  });

  it('the thrown error is a non_retryable ProviderError, matching the pairwise path exactly', () => {
    // Type and kind both matter downstream. `classify()` passes a
    // ProviderError through untouched, and judgment-consumer.ts routes
    // `non_retryable` to `markJudgmentError` (status 'error') + ack — a
    // VISIBLE failed judgment, no retry budget burned, no breaker damage
    // beyond the single recorded failure. A plain `Error` would instead
    // fall through classify()'s unknown-shape default of `retryable` and
    // re-ask the same model the same question three times before DLQ.
    const raw = JSON.stringify({
      overallScore: 5,
      reasoning: 'r',
      criteriaScores: [{ criterionId: 'c1', criterionName: 'Accuracy', score: 8 }],
    });

    const error = captureThrow(() => parseJudgmentResponse(raw, criteria));
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).kind).toBe('non_retryable');
  });

  it('the error names the model when the caller supplies call context (pairwise message style)', () => {
    const raw = JSON.stringify({
      overallScore: 5,
      reasoning: 'r',
      criteriaScores: [{ criterionId: 'c1', criterionName: 'Accuracy', score: 8 }],
    });

    const error = captureThrow(() =>
      parseJudgmentResponse(raw, criteria, { provider: 'openai', modelId: 'gpt-4o' })
    );
    expect((error as Error).message).toContain('model "gpt-4o"');
    expect((error as ProviderError).provider).toBe('openai');
  });

  it('PARTIAL PARSE: 4 of 5 criteria scored is a FAILURE, not a partial success', () => {
    // Explicit decision, not emergent behaviour: `overallScore` is a
    // weighted composite over the WHOLE rubric. Accepting 4 of 5 would
    // silently change what the number means (the 5th criterion's weight
    // either vanishes or contributes a fabricated 0) while still persisting
    // status 'completed'. All-or-nothing, same stance as pairwise's
    // "no usable verdict".
    const raw = JSON.stringify({
      overallScore: 7,
      reasoning: 'r',
      criteriaScores: [
        { criterionName: 'Accuracy', score: 9 },
        { criterionName: 'Clarity', score: 8 },
        { criterionName: 'Depth', score: 7 },
        { criterionName: 'Tone', score: 6 },
      ],
    });

    const error = captureThrow(() => parseJudgmentResponse(raw, fiveCriteria));
    expect(error).toBeInstanceOf(ProviderError);
    // Only the ONE missing criterion is named — the other four parsed fine.
    expect((error as Error).message).toMatch(/Safety/);
    expect((error as Error).message).not.toMatch(/Accuracy/);
    // The count is the operator's first signal of scale ("the judge lost one
    // criterion" vs "the judge scored nothing"), so pin the wording too.
    expect((error as Error).message).toContain('1 of 5 rubric criteria');
  });

  it.each([
    ['null', null],
    ['a string', '8'],
    ['a numeric-looking string', '8.5'],
    ['a boolean', true],
    ['an object', { value: 8 }],
    ['an array', [8]],
  ])('CRITICAL: %s as a score is unparseable and throws (never coerced, never 0)', (_label, badScore) => {
    const raw = JSON.stringify({
      overallScore: 5,
      reasoning: 'r',
      criteriaScores: [
        { criterionId: 'c1', criterionName: 'Accuracy', score: 8 },
        { criterionId: 'c2', criterionName: 'Clarity', score: badScore },
      ],
    });

    const error = captureThrow(() => parseJudgmentResponse(raw, criteria));
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as Error).message).toMatch(/Clarity/);
  });

  it('CRITICAL: a non-finite (Infinity) per-criterion score throws rather than clamping to 0', () => {
    // `1e400` is the only way a non-finite number survives `JSON.parse`
    // (literal `NaN`/`Infinity` tokens are invalid JSON and fail earlier,
    // in the JSON.parse guard). Before the fix this hit
    // `finiteNumberOrUndefined(...) ?? 0` and was persisted as a real 0.
    const raw = JSON.stringify({
      overallScore: 5,
      reasoning: 'r',
      criteriaScores: [
        { criterionId: 'c1', criterionName: 'Accuracy', score: 8 },
        { criterionId: 'c2', criterionName: 'Clarity', score: 0 },
      ],
    }).replace('"score":0', '"score":1e400');

    const error = captureThrow(() => parseJudgmentResponse(raw, criteria));
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as Error).message).toMatch(/Clarity/);
  });

  it('a non-record element in criteriaScores throws for the criterion it failed to score, rather than zeroing it', () => {
    // `normalizeParsedJudgment` drops non-record elements (a stray
    // `null`/string) instead of crashing on `cs.criterionId` — that stays
    // true, but a dropped element now leaves its criterion UNSCORED, which
    // is a failure rather than a silent 0.
    const raw = JSON.stringify({
      overallScore: 6,
      reasoning: 'mixed',
      criteriaScores: [{ criterionId: 'c1', criterionName: 'Accuracy', score: 9 }, 'notanobject'],
    });

    const error = captureThrow(() => parseJudgmentResponse(raw, criteria));
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as Error).message).toMatch(/Clarity/);
  });
});

describe('parseJudgmentResponse: valid responses are untouched (regression guard)', () => {
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
    expect(result.criteriaScores.map((c) => c.comment)).toEqual(['good', 'clear']);
  });

  it('a complete response matched only by criterion NAME (no ids) still parses', () => {
    const raw = JSON.stringify({
      overallScore: 7,
      reasoning: 'r',
      criteriaScores: [
        { criterionName: 'accuracy', score: 6 }, // case-insensitive name match
        { criterionName: 'Clarity', score: 3 },
      ],
    });

    const result = parseJudgmentResponse(raw, criteria);
    expect(result.criteriaScores.map((c) => c.score)).toEqual([6, 3]);
  });

  it('a complete response matched only by ARRAY POSITION (no ids, no matching names) still parses', () => {
    const raw = JSON.stringify({
      overallScore: 7,
      reasoning: 'r',
      criteriaScores: [{ score: 6 }, { score: 3 }],
    });

    const result = parseJudgmentResponse(raw, criteria);
    expect(result.criteriaScores.map((c) => c.score)).toEqual([6, 3]);
  });

  it('CRITICAL: a response that RENAMES every criterion still matches positionally — it must not become an unscored failure', () => {
    // The boundary the completeness check must never cross. Models routinely
    // paraphrase the rubric's criterion labels ("Correctness" for
    // "Accuracy"), and the positional rescue is the only thing that saves
    // those responses. Before this change, tightening the matcher merely
    // swapped real scores for fabricated zeros; NOW it would hard-fail every
    // judgment from such a model, so the blast radius of an over-strict
    // matcher is far larger than it used to be. Pin the lenient half of
    // "lenient about SHAPE, strict about SUBSTANCE" explicitly.
    const raw = JSON.stringify({
      overallScore: 7,
      reasoning: 'r',
      criteriaScores: [
        { criterionName: 'Correctness', score: 9 },
        { criterionName: 'Readability', score: 9 },
      ],
    });

    expect(() => parseJudgmentResponse(raw, criteria)).not.toThrow();
    const result = parseJudgmentResponse(raw, criteria);
    // 9 and 5, not 9 and 9: the second entry landed on Clarity (maxScore 5)
    // and clamped, which is what proves it was matched by POSITION rather
    // than dropped and then rescued by some other coincidence.
    expect(result.criteriaScores.map((c) => c.score)).toEqual([9, 5]);
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

  it('a missing overallScore is recomputed from a COMPLETE set of criteriaScores (not defaulted to 0)', () => {
    // Now safe to recompute precisely because every criterion is guaranteed
    // scored by the time this branch runs — that was the second half of the
    // bug: the recompute averaged fabricated zeros.
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

  it('a legitimate score of exactly 0 is preserved, not misread as "missing" (falsy-zero guard)', () => {
    const raw = JSON.stringify({
      overallScore: 0,
      reasoning: 'worst possible',
      criteriaScores: [
        { criterionId: 'c1', criterionName: 'Accuracy', score: 0 },
        { criterionId: 'c2', criterionName: 'Clarity', score: 0 },
      ],
    });

    const result = parseJudgmentResponse(raw, criteria);
    // The whole point of the fix is that a REAL 0 and a FABRICATED 0 are no
    // longer the same value — a real one must still survive untouched.
    expect(result.overallScore).toBe(0);
    expect(result.criteriaScores.map((c) => c.score)).toEqual([0, 0]);
  });

  it('an out-of-range overallScore is still clamped to [0, 10] (unchanged pre-existing behavior)', () => {
    const raw = JSON.stringify({
      overallScore: 999,
      reasoning: 'r',
      criteriaScores: [
        { criterionId: 'c1', criterionName: 'Accuracy', score: 5 },
        { criterionId: 'c2', criterionName: 'Clarity', score: 3 },
      ],
    });
    const result = parseJudgmentResponse(raw, criteria);
    expect(result.overallScore).toBe(10);
  });

  it('an out-of-range per-criterion score is still clamped to [0, maxScore] (unchanged pre-existing behavior)', () => {
    const raw = JSON.stringify({
      overallScore: 5,
      reasoning: 'r',
      criteriaScores: [
        { criterionId: 'c1', criterionName: 'Accuracy', score: 999 },
        { criterionId: 'c2', criterionName: 'Clarity', score: -4 },
      ],
    });
    const result = parseJudgmentResponse(raw, criteria);
    expect(result.criteriaScores.map((c) => c.score)).toEqual([10, 0]);
  });

  it('an empty rubric (no criteria at all) is not a parse failure — there is nothing to fabricate', () => {
    // Unreachable for a real judge call (config.ts requires
    // `criteria: z.array(criterionSchema).min(1)`), but this is the branch
    // that decides whether "no criteria" is treated as "every criterion is
    // missing". It is not: the completeness check is about criteria the
    // rubric HAS.
    const raw = JSON.stringify({ overallScore: 6, reasoning: 'r', criteriaScores: [] });
    const result = parseJudgmentResponse(raw, []);
    expect(result.overallScore).toBe(6);
    expect(result.criteriaScores).toEqual([]);
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

describe('tryParseStructuredJudgment: still never throws — an unscored criterion demotes to the lenient path, which then fails loudly', () => {
  // `registry.ts`'s `parseJudgmentText` composes these two:
  // `tryParseStructuredJudgment(...) ?? parseJudgmentResponse(...)` on the
  // IDENTICAL raw text. The strict path's "never throws" promise must
  // survive the new completeness check (otherwise a raw TypeError/
  // ProviderError escapes before the intended fallback + warning), and the
  // lenient path must then be the one that raises the visible failure.

  it('a criteriaScores array containing null rejects the structured parse (returns undefined, does NOT throw) — the lenient fallback then THROWS rather than scoring both criteria 0', () => {
    const raw = JSON.stringify({
      overallScore: 8,
      reasoning: 'solid',
      criteriaScores: [null],
    });

    expect(() => tryParseStructuredJudgment(raw, criteria)).not.toThrow();
    expect(tryParseStructuredJudgment(raw, criteria)).toBeUndefined();

    const error = captureThrow(() => parseJudgmentResponse(raw, criteria));
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as Error).message).toMatch(/Accuracy/);
  });

  it('a conforming-looking response that is nonetheless missing a criterion does not throw out of the strict path', () => {
    // Every top-level type check passes (`overallScore` number, `reasoning`
    // string, `criteriaScores` an all-record array) so this reaches
    // `normalizeParsedJudgment`, where the new completeness check fires.
    // The strict path must swallow that and return `undefined`.
    const raw = JSON.stringify({
      overallScore: 8,
      reasoning: 'solid',
      criteriaScores: [{ criterionId: 'c1', criterionName: 'Accuracy', score: 9 }],
    });

    expect(() => tryParseStructuredJudgment(raw, criteria)).not.toThrow();
    expect(tryParseStructuredJudgment(raw, criteria)).toBeUndefined();
    expect(() => parseJudgmentResponse(raw, criteria)).toThrow(ProviderError);
  });

  it('a criteriaScores array mixing a well-formed object with a non-object element ("notanobject") rejects the structured parse without throwing', () => {
    const raw = JSON.stringify({
      overallScore: 6,
      reasoning: 'mixed',
      criteriaScores: [{ criterionId: 'c1', criterionName: 'Accuracy', score: 9 }, 'notanobject'],
    });

    expect(() => tryParseStructuredJudgment(raw, criteria)).not.toThrow();
    expect(tryParseStructuredJudgment(raw, criteria)).toBeUndefined();
  });

  it('a conforming (all-record, complete) criteriaScores array still parses via the strict path, unaffected by the new checks', () => {
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
