import { describe, expect, it } from 'vitest';
import {
  CHARS_PER_TOKEN,
  REASONING_EXCLUDED_RATIO,
  accountTokens,
} from '@/lib/calibration/token-accounting';

// ─── Real judgments, measured 2026-09-02 against judge-arena-pg-1 ──────────
//
// `ModelJudgment.outputTokens` is `usage.completion_tokens` verbatim
// (src/lib/llm/openai-compatible.ts:260) and whether it includes the
// reasoning channel varies PER MODEL. granite4.2:3b and qwen3.5:9b are both
// Ollama and both report `reasoningSource: 'reasoning'`, and they disagree —
// so neither `servingBackend` nor `reasoningSource` can be the discriminator.
// Only `length(reasoningContent) / outputTokens` separates them.
//
// Only the LENGTH of reasoningContent is ever read, so a repeat() string of
// the measured length is the whole fixture.
const chars = (n: number): string => 'x'.repeat(n);

const QWEN36_MAX_RATIO = { outputTokens: 2628, reasoningContent: chars(12428) }; // ratio 4.73
const QWEN36_NEAR_BUDGET = { outputTokens: 7272, reasoningContent: chars(18819) }; // ratio 2.59
const GRANITE42_MAX_OUT = { outputTokens: 9160, reasoningContent: chars(35212) }; // ratio 3.84
const GRANITE41_NO_REASONING = { outputTokens: 163, reasoningContent: null }; // no channel at all
const Q35_MIN_RATIO = { outputTokens: 148, reasoningContent: chars(5589) }; // ratio 37.76
const Q35_THE_INCIDENT = { outputTokens: 115, reasoningContent: chars(18019) }; // ratio 156.69

describe('calibration/token-accounting: the constants are what the measurement says', () => {
  it('CHARS_PER_TOKEN is the literal 3.64, not a computed mean', () => {
    // (3.52 + 3.76) / 2 evaluates to 3.6399999999999997 in IEEE754, which
    // would make every estimate depend on how the constant was spelled.
    expect(CHARS_PER_TOKEN).toBe(3.64);
    expect(CHARS_PER_TOKEN).not.toBe((3.52 + 3.76) / 2);
  });

  it('REASONING_EXCLUDED_RATIO sits between the two measured bands', () => {
    // Measured 2026-09-02 over all 263 completed judgments with a usable count:
    //   includes-reasoning band, n=245:   0.00 …   4.73
    //   excludes-reasoning band, n= 18:  36.73 … 156.69
    // The lower bound of the second band moves as runs drain (it was 37.76
    // before the relaunched 8192 run finished). The GAP does not — see the
    // REASONING_EXCLUDED_RATIO doc comment for why 8 is placed against the
    // physical ceiling of the first band rather than the midpoint of the gap.
    expect(REASONING_EXCLUDED_RATIO).toBeGreaterThan(4.73);
    expect(REASONING_EXCLUDED_RATIO).toBeLessThan(36.73);
  });
});

describe('calibration/token-accounting: accountTokens classification', () => {
  it('a ratio inside the 2-5 band means the provider ALREADY counted the reasoning', () => {
    for (const row of [QWEN36_MAX_RATIO, QWEN36_NEAR_BUDGET, GRANITE42_MAX_OUT]) {
      expect(accountTokens(row).accounting).toBe('includes_reasoning');
    }
    const acc = accountTokens(QWEN36_MAX_RATIO);
    expect(acc.charsPerOutputToken).toBeCloseTo(4.7291, 3);
    expect(acc.reasoningChars).toBe(12428);
  });

  it('a ratio far above the tokenizer ceiling means the count EXCLUDES reasoning', () => {
    for (const row of [Q35_MIN_RATIO, Q35_THE_INCIDENT]) {
      expect(accountTokens(row).accounting).toBe('excludes_reasoning');
    }
    expect(accountTokens(Q35_THE_INCIDENT).charsPerOutputToken).toBeCloseTo(156.687, 2);
  });

  it('exactly at the threshold the count is treated as INCLUDING reasoning', () => {
    // The boundary is `> REASONING_EXCLUDED_RATIO`, not `>=`. 8.0 is still a
    // physically possible chars-per-token, so it is not evidence of exclusion;
    // only a ratio that cannot be a tokenizer rate is.
    expect(800 / 100).toBe(REASONING_EXCLUDED_RATIO);
    expect(accountTokens({ outputTokens: 100, reasoningContent: chars(800) }).accounting).toBe(
      'includes_reasoning'
    );
    expect(accountTokens({ outputTokens: 100, reasoningContent: chars(801) }).accounting).toBe(
      'excludes_reasoning'
    );
  });

  it('no reasoning channel is its own answer, never "includes"', () => {
    // granite4.1:3b emits no thinking at all. Claiming `includes_reasoning`
    // here would assert a measurement that was never made.
    const acc = accountTokens(GRANITE41_NO_REASONING);
    expect(acc.accounting).toBe('no_reasoning_channel');
    expect(acc.reasoningChars).toBe(0);
    expect(acc.charsPerOutputToken).toBe(0);
  });

  it('an empty-string reasoning channel is the same as none', () => {
    expect(accountTokens({ outputTokens: 163, reasoningContent: '' }).accounting).toBe(
      'no_reasoning_channel'
    );
  });
});

describe('calibration/token-accounting: estimatedGeneratedTokens is DERIVED and never a fabrication', () => {
  it('when the provider already counted reasoning, the estimate IS the provider count', () => {
    // Adding a chars-derived reasoning estimate here would double-count: the
    // measured `Σ(reasoningChars+contentChars)/Σ outputTokens` on this judge
    // is 3.762, i.e. outputTokens already covers the whole generated stream.
    expect(accountTokens(QWEN36_NEAR_BUDGET).estimatedGeneratedTokens).toBe(7272);
    expect(accountTokens(GRANITE42_MAX_OUT).estimatedGeneratedTokens).toBe(9160);
    expect(accountTokens(GRANITE41_NO_REASONING).estimatedGeneratedTokens).toBe(163);
  });

  it('when it did not, the two channels ADD — this is the item nothing could see', () => {
    // The live incident: 6144-token budget, finishReason 'stop', outputTokens
    // 115. 115 + round(18019 / 3.64) = 115 + 4950 = 5065 tokens generated.
    expect(accountTokens(Q35_THE_INCIDENT).estimatedGeneratedTokens).toBe(5065);
    expect(accountTokens(Q35_MIN_RATIO).estimatedGeneratedTokens).toBe(1683);
  });

  it('an absent outputTokens yields null, NEVER zero', () => {
    // The 2026-08-30 register forbids conflating an absent measurement with a
    // measured one. A 0 here would flow into a tok/s denominator and into a
    // truncation fraction as "this judgment generated nothing", which is the
    // opposite of what an unmeasured row means.
    for (const outputTokens of [null, undefined, 0]) {
      const acc = accountTokens({ outputTokens, reasoningContent: chars(44287) });
      expect(acc.accounting).toBe('unmeasurable');
      expect(acc.estimatedGeneratedTokens).toBeNull();
      expect(acc.charsPerOutputToken).toBeNull();
      // The one thing that IS measured on such a row is still reported.
      expect(acc.reasoningChars).toBe(44287);
    }
  });

  it('a negative outputTokens is unmeasurable, not a negative estimate', () => {
    expect(accountTokens({ outputTokens: -1, reasoningContent: chars(10) }).accounting).toBe(
      'unmeasurable'
    );
  });
});
