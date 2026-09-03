import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CHARS_PER_TOKEN,
  REASONING_EXCLUDED_RATIO,
  TRUNCATION_PROXIMITY_WARN,
  accountTokens,
  formatTokenAccountingLines,
  resolveMaxTokens,
  truncationProximity,
  type TokenAccountingRow,
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

// ─── The report corpus ─────────────────────────────────────────────────────
//
// Five real judgments, measured 2026-09-02. Row 2 is the item that motivated
// this work: 6144-token budget, finishReason 'stop', outputTokens 115, and an
// estimated 5065 tokens actually generated — 82.4% of budget, invisible in
// every number the report printed before this change. Row 5 is the
// repetition-loop shape from handoff §5.2: 44,287 chars of reasoning on a row
// that never produced a usable token count.
const CORPUS: TokenAccountingRow[] = [
  {
    goldenItemIndex: 8,
    status: 'completed',
    outputTokens: 7272,
    reasoningContent: chars(18819),
    samplingParams: { max_tokens: 8192, temperature: 0.3 },
  },
  {
    goldenItemIndex: 12,
    status: 'completed',
    outputTokens: 115,
    reasoningContent: chars(18019),
    samplingParams: { max_tokens: 6144, temperature: 0.3 },
  },
  {
    goldenItemIndex: 3,
    status: 'completed',
    outputTokens: 9160,
    reasoningContent: chars(35212),
    samplingParams: { max_tokens: 12288, temperature: 0.3 },
  },
  {
    goldenItemIndex: 5,
    status: 'completed',
    outputTokens: 163,
    reasoningContent: null,
    samplingParams: { max_tokens: 4096, temperature: 0.3 },
  },
  {
    goldenItemIndex: 9,
    status: 'error',
    outputTokens: null,
    reasoningContent: chars(44287),
    samplingParams: null,
  },
];

describe('calibration/token-accounting: resolveMaxTokens', () => {
  it('prefers the JUDGMENT over the run header — execution truth beats launch intent', () => {
    // v2k's whole point (src/lib/calibration/sampling-drift.ts): the header is
    // what the run was LAUNCHED under, each judgment is what it was EXECUTED
    // under, and they diverge when the version row is edited mid-run. Sizing
    // must use what actually ran.
    expect(
      resolveMaxTokens({ max_tokens: 12288, temperature: 0.3 }, { max_tokens: 6144, temperature: 0.3 })
    ).toEqual({ maxTokens: 12288, source: 'judgment' });
  });

  it('falls back to the run header, and says so', () => {
    // `markJudgmentError` (src/worker/judgment-consumer.ts:645-671) does not
    // write `samplingParams`, so an errored judgment — the truncation case —
    // has none. The v2k header is a recorded snapshot, not a default, and
    // `detectSamplingDrift` already warns when the two disagree.
    expect(resolveMaxTokens(null, { max_tokens: 6144, temperature: 0.3 })).toEqual({
      maxTokens: 6144,
      source: 'run_header',
    });
  });

  it('returns null rather than inventing a registry default', () => {
    // JUDGE_DEFAULT_SAMPLING_PARAMS.max_tokens is 4096 (src/lib/llm/sampling.ts:43).
    // Falling through to it would present a guess as the budget a run used —
    // the exact lie `describeSamplingSnapshot` exists to avoid.
    expect(resolveMaxTokens(null, null)).toBeNull();
    expect(resolveMaxTokens({ temperature: 0.3 }, {})).toBeNull();
    expect(resolveMaxTokens('4096', undefined)).toBeNull();
    expect(resolveMaxTokens({ max_tokens: '8192' }, null)).toBeNull();
    expect(resolveMaxTokens({ max_tokens: 0 }, null)).toBeNull();
  });
});

describe('calibration/token-accounting: truncationProximity', () => {
  it('warns at exactly the threshold — the boundary is >=, not >', () => {
    const acc = accountTokens({ outputTokens: 4096, reasoningContent: null });
    const prox = truncationProximity(acc, { maxTokens: 5120, source: 'judgment' });
    expect(prox?.fraction).toBe(TRUNCATION_PROXIMITY_WARN);
    expect(prox?.near).toBe(true);
  });

  it('does not warn just below it', () => {
    const acc = accountTokens({ outputTokens: 4095, reasoningContent: null });
    expect(truncationProximity(acc, { maxTokens: 5120, source: 'judgment' })?.near).toBe(false);
  });

  it('sees the item outputTokens hid: 5065 of 6144, reported as 115', () => {
    const acc = accountTokens({ outputTokens: 115, reasoningContent: chars(18019) });
    const prox = truncationProximity(acc, { maxTokens: 6144, source: 'judgment' });
    expect(prox?.estimatedGeneratedTokens).toBe(5065);
    expect(prox?.near).toBe(true);
    // What the report printed before this change, for the same judgment:
    expect(115 / 6144).toBeLessThan(0.02);
  });

  it('is null — never 0% and never 100% — when either input is absent', () => {
    const unmeasurable = accountTokens({ outputTokens: null, reasoningContent: chars(18019) });
    expect(truncationProximity(unmeasurable, { maxTokens: 6144, source: 'judgment' })).toBeNull();
    const measured = accountTokens({ outputTokens: 115, reasoningContent: chars(18019) });
    expect(truncationProximity(measured, null)).toBeNull();
  });
});

describe('calibration/token-accounting: formatTokenAccountingLines', () => {
  it('prints the corpus exactly', () => {
    expect(formatTokenAccountingLines(CORPUS, { max_tokens: 8192, temperature: 0.3 })).toEqual([
      '  accounting          includes_reasoning 2   excludes_reasoning 1   no_reasoning_channel 1   unmeasurable 1',
      "  chars/outputToken   2.59 … 156.69 over 3 judgment(s) with a reasoning channel   (> 8 ⇒ the provider's count EXCLUDES reasoning)",
      '  est. generation     closest to budget: 7272 tok = 88.8% of max_tokens 8192   (DERIVED at 3.64 chars/token, ±10%)',
      '  ⚠ 2 of 4 sized judgment(s) estimate at or above 80.0% of max_tokens. Size the next run from the ESTIMATE, not from outputTokens — but read runbook §8.2 first: a large estimate can be a repetition loop, which a bigger budget makes worse.',
      '       item 8  completed  est 7272 = 88.8% of 8192 (max_tokens from the judgment)  [outputTokens 7272, reasoning 18819 chars]',
      '       item 12  completed  est 5065 = 82.4% of 6144 (max_tokens from the judgment)  [outputTokens 115, reasoning 18019 chars]',
      '  ⓘ 1 judgment(s) had no usable outputTokens and 0 had no max_tokens on the judgment or the run header — excluded from every number above, never counted as zero.',
    ]);
  });

  it('names the run header when that is where max_tokens came from', () => {
    const errored: TokenAccountingRow[] = [
      {
        goldenItemIndex: 20,
        status: 'error',
        outputTokens: 115,
        reasoningContent: chars(18019),
        samplingParams: null,
      },
    ];
    const lines = formatTokenAccountingLines(errored, { max_tokens: 6144, temperature: 0.3 });
    expect(lines.some((l) => l.includes('(max_tokens from the run header)'))).toBe(true);
  });

  it('counts the judgments it could not size, rather than dropping them silently', () => {
    // A partial denominator that looks like a whole one is this repo's most
    // expensive recurring defect (runbook §4's expired-poll box, handoff §6
    // trap 8). Nothing is ever excluded without being counted.
    const unsizable: TokenAccountingRow[] = [
      {
        goldenItemIndex: 1,
        status: 'completed',
        outputTokens: 7272,
        reasoningContent: chars(18819),
        samplingParams: null,
      },
    ];
    expect(formatTokenAccountingLines(unsizable, null)).toEqual([
      '  accounting          includes_reasoning 1   excludes_reasoning 0   no_reasoning_channel 0   unmeasurable 0',
      "  chars/outputToken   2.59 … 2.59 over 1 judgment(s) with a reasoning channel   (> 8 ⇒ the provider's count EXCLUDES reasoning)",
      '  est. generation     no judgment had both an outputTokens count and a max_tokens — nothing to size against',
      '  ⓘ 0 judgment(s) had no usable outputTokens and 1 had no max_tokens on the judgment or the run header — excluded from every number above, never counted as zero.',
    ]);
  });

  it('omits the exclusions line only when there is genuinely nothing excluded', () => {
    const clean: TokenAccountingRow[] = [
      {
        goldenItemIndex: 3,
        status: 'completed',
        outputTokens: 9160,
        reasoningContent: chars(35212),
        samplingParams: { max_tokens: 12288, temperature: 0.3 },
      },
    ];
    const lines = formatTokenAccountingLines(clean, null);
    expect(lines).toHaveLength(3);
    expect(lines.some((l) => l.includes('excluded from every number above'))).toBe(false);
    expect(lines.some((l) => l.startsWith('  ⚠'))).toBe(false);
  });

  it('says so rather than printing an empty range when nothing is measurable', () => {
    const nothing: TokenAccountingRow[] = [
      {
        goldenItemIndex: 9,
        status: 'error',
        outputTokens: null,
        reasoningContent: chars(44287),
        samplingParams: null,
      },
    ];
    expect(formatTokenAccountingLines(nothing, null)).toEqual([
      '  accounting          includes_reasoning 0   excludes_reasoning 0   no_reasoning_channel 0   unmeasurable 1',
      '  chars/outputToken   no judgment carried both a reasoning channel and an outputTokens count',
      '  est. generation     no judgment had both an outputTokens count and a max_tokens — nothing to size against',
      '  ⓘ 1 judgment(s) had no usable outputTokens and 0 had no max_tokens on the judgment or the run header — excluded from every number above, never counted as zero.',
    ]);
  });

  it('is total over an empty run', () => {
    expect(formatTokenAccountingLines([], null)).toEqual([
      '  accounting          includes_reasoning 0   excludes_reasoning 0   no_reasoning_channel 0   unmeasurable 0',
      '  chars/outputToken   no judgment carried both a reasoning channel and an outputTokens count',
      '  est. generation     no judgment had both an outputTokens count and a max_tokens — nothing to size against',
    ]);
  });

  it('the real truncated shape: status error, samplingParams NULL, outputTokens == max_tokens', () => {
    // Measured 2026-09-02: 21 judgments carry finishReason 'length' — 20
    // granite4.2:3b and 1 Qwen3.6 — each with `outputTokens` exactly equal to
    // its budget (4096, 8192, 12288), `status: 'error'`, and NO samplingParams
    // of their own, because `markJudgmentError` does not write them. This is
    // the shape the report will print most often, and it is the only fixture
    // that exercises the run-header fallback and the 100%-of-budget path at
    // once. Without it, an implementation that clamped `fraction` below 1, or
    // returned null when estimate === maxTokens, passes every other test here.
    const truncated: TokenAccountingRow[] = [
      {
        goldenItemIndex: 4,
        status: 'error',
        outputTokens: 12288,
        reasoningContent: chars(56004),
        samplingParams: null,
      },
    ];
    const lines = formatTokenAccountingLines(truncated, { max_tokens: 12288, temperature: 0.3 });
    expect(lines[2]).toBe(
      '  est. generation     closest to budget: 12288 tok = 100.0% of max_tokens 12288   (DERIVED at 3.64 chars/token, ±10%)'
    );
    expect(lines[4]).toBe(
      '       item 4  error  est 12288 = 100.0% of 12288 (max_tokens from the run header)  [outputTokens 12288, reasoning 56004 chars]'
    );
  });

  it('lists at most ten near-budget items, and still counts all of them', () => {
    // `near.slice(0, 10)` is claimed behaviour with, otherwise, no coverage:
    // every other fixture has at most two near items, so deleting the cap — or
    // shrinking it to 1 — leaves the whole suite green while a run with 11+
    // near items prints a ⚠ header saying "12 of 12" above a list of one. The
    // visibility half is the entire deliverable, so it gets an assertion.
    const many: TokenAccountingRow[] = Array.from({ length: 12 }, (_, i) => ({
      goldenItemIndex: i,
      status: 'completed',
      outputTokens: 115,
      reasoningContent: chars(18019),
      samplingParams: { max_tokens: 6144, temperature: 0.3 },
    }));
    const lines = formatTokenAccountingLines(many, null);
    expect(lines.filter((l) => l.startsWith('       item ')).length).toBe(10);
    // The header counts all twelve: the cap truncates the LIST, never the
    // denominator. A cap that also dropped them from the count would be the
    // partial-denominator defect this module exists to avoid.
    expect(lines.some((l) => l.startsWith('  ⚠ 12 of 12 sized judgment(s)'))).toBe(true);
  });
});

describe('calibration/token-accounting: the CLI actually calls it', () => {
  // scripts/** is outside every coverage include (vitest.config.ts:37) and no
  // test can import run.ts (it calls main() at module scope), so the only
  // available guard on the wiring is the source text. This is a CALL-SITE
  // guard, not a behaviour test, and it is stated as such:
  //
  //   what it catches   — the block being deleted, renamed, computed and never
  //                       printed, called with the wrong header argument, or
  //                       built from the wrong Prisma columns
  //   what it does NOT  — anything about WHERE in the report the block appears,
  //                       and anything at all about whether the script RUNS
  //                       (nothing here executes run.ts; see the Post-landing
  //                       checklist item 3)
  const RUN_TS = readFileSync(new URL('../../scripts/calibration/run.ts', import.meta.url), 'utf8');

  it('imports and calls formatTokenAccountingLines, and prints every line it returns', () => {
    // A bare substring count cannot tell `formatTokenAccountingLines` from a
    // renamed `formatTokenAccountingLinesV2` (failure mode 3), so the `(`
    // is part of the pattern and the import is asserted separately.
    expect(RUN_TS).toContain("from '@/lib/calibration/token-accounting'");
    expect(RUN_TS.match(/formatTokenAccountingLines\(/g)).toHaveLength(1);
    // Returned lines must reach stdout. A computed-and-discarded call is the
    // exact wrong implementation the previous assertion cannot see.
    //
    // The ARGUMENTS are pinned, not skipped with `[^)]*`. The second parameter
    // is typed `unknown`, so `formatTokenAccountingLines(accountingRows, null)`
    // type-checks, lints, and passes every other assertion here — while
    // destroying the feature's core case: `markJudgmentError` writes no
    // `samplingParams` (all 46 production `status='error'` rows have it NULL),
    // so a null header unsizes every errored judgment and the truncated item
    // this plan exists to surface is never printed.
    expect(RUN_TS).toMatch(
      /for \(const line of formatTokenAccountingLines\(accountingRows, headerSampling\)\) console\.log\(line\);/
    );
    // And the row mapping, because tsc only closes the DROPPED-field half of
    // the mis-mapping risk, not the SWAPPED-field half: `reasoningContent:
    // j.reasoning` is `string | null` on both sides and would silently feed
    // the parsed rationale (also in the select at run.ts:294) to a function
    // that thinks it is reading the thinking channel.
    expect(RUN_TS).toContain('    outputTokens: j.outputTokens,');
    expect(RUN_TS).toContain('    reasoningContent: j.reasoningContent,');
    expect(RUN_TS).toContain('    samplingParams: j.samplingParams,');
  });
});
