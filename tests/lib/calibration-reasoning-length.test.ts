import { describe, expect, it } from 'vitest';
import { formatReasoningLengthLine, summarizeReasoningLength } from '@/lib/calibration/reasoning-length';

/**
 * #10 (handoff 2026-09-01 §7). `reasoningTokens` is usage-reported and NULL on
 * every backend this fleet runs, so the capture report stops counting it as a
 * capture failure and prints the length of the thinking channel instead.
 *
 * §5.2's signal was a SPLIT, not a pool: failed n=5 mean 44,287 chars against
 * completed n=25 mean 13,138 on the same run. Pooling those 30 rows gives
 * 18,330 — neither number, and indistinguishable from one judge that simply
 * writes long. So the report prints one line PER TERMINAL STATUS and the last
 * fixture below pins that the two lines differ where a pooled one would not.
 * (Per-FAILURE chars were already printed by `cap()` in the Failures block of
 * scripts/calibration/run.ts; what was missing is the completed-population
 * baseline to read them against.)
 *
 * Same null-not-zero contract as `summarizeLatencies`: an absent measurement
 * is `null`, never a row of zeros that reads as "the judge thought for 0
 * characters".
 */
describe('summarizeReasoningLength', () => {
  it('returns null, not zeros, when no judgment carried a reasoning channel', () => {
    expect(summarizeReasoningLength([])).toBeNull();
    expect(summarizeReasoningLength([null, undefined, null])).toBeNull();
  });

  it('ignores rows with no reasoningContent and summarises the rest', () => {
    // The maximum is deliberately FIRST, not last: with the longest row last,
    // `maxChars: lengths[lengths.length - 1]` (and `Math.max` over an
    // unfiltered map) give the right answer for the wrong reason, and no
    // injection here would catch it.
    const summary = summarizeReasoningLength(['abcdefghij', null, 'abcd', undefined, 'ab']);
    expect(summary).toEqual({ n: 3, meanChars: 5, maxChars: 10 });
  });

  it('counts an EMPTY reasoning channel as present with 0 chars (captured-but-empty is a fact, absent is another)', () => {
    expect(summarizeReasoningLength(['', 'abc'])).toEqual({ n: 2, meanChars: 2, maxChars: 3 });
  });

  it('rounds the mean to whole characters (7 + 8 -> 7.5 -> 8)', () => {
    expect(summarizeReasoningLength(['1234567', '12345678'])).toEqual({ n: 2, meanChars: 8, maxChars: 8 });
  });
});

/**
 * The report LINE is formatted here and NOT in scripts/calibration/run.ts,
 * which is outside every vitest `include` and therefore untestable: a swapped
 * mean/max, a dropped label or a dropped null branch written there would be
 * caught by nothing except an operator reading the output after a promote.
 * Keeping the template here shrinks that zero-verification surface to an
 * import, two filter/map expressions and two `console.log`s (Step 6
 * VERIFICATION LIMIT). What remains outside it — which status each line is
 * computed over — is the one thing no test in this file can see.
 */
describe('formatReasoningLengthLine', () => {
  it('prints the status label, then n, then mean, then max — in that order', () => {
    expect(formatReasoningLengthLine({ n: 25, meanChars: 13138, maxChars: 26549 }, 'completed')).toBe(
      '  reasoningContent chars   completed  n=25  mean=13138  max=26549'
    );
  });

  it('prints "none captured" for the null summary, never a row of zeros — and still carries the label', () => {
    expect(formatReasoningLengthLine(null, 'error')).toBe('  reasoningContent chars   error  none captured');
  });

  it('the STATUS SPLIT is what makes a repetition loop visible; a pooled line hides it (handoff §5.2)', () => {
    // The measured granite4.2 shape: 25 completed at ~13,138 chars, 5 failed
    // at ~44,287 (handoff §5.2's pg_column_size table). Uniform lengths so the
    // arithmetic is checkable by hand.
    const completed = Array.from({ length: 25 }, () => 'x'.repeat(13138));
    const failed = Array.from({ length: 5 }, () => 'x'.repeat(44287));

    expect(formatReasoningLengthLine(summarizeReasoningLength(completed), 'completed')).toBe(
      '  reasoningContent chars   completed  n=25  mean=13138  max=13138'
    );
    expect(formatReasoningLengthLine(summarizeReasoningLength(failed), 'error')).toBe(
      '  reasoningContent chars   error  n=5  mean=44287  max=44287'
    );

    // What the FIRST draft of this plan specified — one pooled line over all
    // 30 rows. 549,885 / 30 = 18,329.5 -> 18,330: neither population's mean,
    // and exactly what "one judge that writes long" also prints. This
    // assertion exists so that a future "simplification" back to a single
    // pooled line is red, not silently green.
    expect(formatReasoningLengthLine(summarizeReasoningLength([...completed, ...failed]), 'all')).toBe(
      '  reasoningContent chars   all  n=30  mean=18330  max=44287'
    );
  });
});
