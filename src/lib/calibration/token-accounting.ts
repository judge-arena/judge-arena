/**
 * ─── Token accounting: what the provider COUNTED vs. what the model GENERATED ──
 *
 * `ModelJudgment.outputTokens` is `usage.completion_tokens` verbatim
 * (src/lib/llm/openai-compatible.ts:260). What that number MEANS varies by
 * MODEL — not by backend, and not by `reasoningSource`. Measured 2026-09-02,
 * two identical requests to Ollama 0.32.15 (qwen3.5:9b) differing only by
 * `response_format`:
 *
 *   plain                          completion_tokens 1069   reasoning 2583 chars + content 530
 *   + response_format json_schema  completion_tokens  196   reasoning 2304 chars + content 598
 *
 * The judge path ALWAYS sends the schema — `ollamaStructuredRequestFields`
 * (src/lib/llm/backends/ollama.ts:45) and `llamacppStructuredRequestFields`
 * (backends/llamacpp.ts:30) both emit `response_format: {type:'json_schema'}`,
 * and `openai-compatible.ts:210-212` attaches it to every `mode: 'judgment'`
 * call — so the judge path is the affected one.
 *
 * WHY THIS IS NOT A COLUMN. `reasoningContent` is already persisted verbatim
 * and never truncated (prisma/schema.prisma:514-519), so its length is exact
 * and free at read time. A `reasoningChars` column would duplicate a column
 * that is already there, would be NULL on every pre-existing row, and would
 * need writing at FOUR persist seams — `commonSuccessUpdateData`
 * (src/worker/judgment-consumer.ts:725-757, covering judge/respond/pairwise)
 * and `markJudgmentError` (:632-674), which is the seam that matters most
 * because a truncated or looping judgment is an `error` row. One missed seam
 * is the partial rollout that looked live in production for an hour
 * (handoff §5.1). Read time has zero seams and cannot drift from its source.
 *
 * NOTHING HERE IS EVER WRITTEN TO `outputTokens`. That column means, and
 * keeps meaning, "what the provider reported". Everything this module returns
 * is DERIVED and is labelled DERIVED wherever it is printed.
 *
 * NOT A TOKENIZER. No tokenizer is installed and none is being added; the
 * exact split is only obtainable from a second round trip to a native API,
 * which is deliberately out of scope.
 *
 * LEAF MODULE: zero imports, by design. `scripts/calibration/run.ts` is
 * bundled into the image's `calibration-run.js` by esbuild, and
 * `.dockerignore:72` promises that bundle pulls in `src/lib/calibration/**`
 * and `@/lib/db` only.
 */

/**
 * Characters of generated text per output token.
 *
 * DERIVED, with the arithmetic. On the two judges whose provider count
 * demonstrably INCLUDES the reasoning channel, `Σ length(reasoningContent) /
 * Σ outputTokens` measured 2026-09-02 over every completed judgment:
 *
 *   Qwen3.6-35B-A3B (llama.cpp, n=145)   3.52
 *   granite4.2:3b   (Ollama,    n= 40)   3.76
 *   mean                                 3.64   <- this constant
 *
 * Written as the literal `3.64`, not as `(3.52 + 3.76) / 2`, which evaluates
 * to 3.6399999999999997.
 *
 * WHY THE SLIGHT UNDERSTATEMENT IS DELIBERATE. Those two ratios divide
 * reasoning chars by ALL output tokens — reasoning plus content — so each
 * understates true chars-per-token, and a SMALLER constant produces a LARGER
 * token estimate, which is the safe direction for a budget warning. The
 * unbiased figure, `Σ (reasoningChars + rawResponseChars) / Σ outputTokens`
 * on the same two populations, is 3.762 and 3.868 (mean 3.82): 3.64 therefore
 * runs 3.82 / 3.64 = 1.049, about 5% high, on purpose.
 *
 * ERROR BARS: +-10%. Measured against the only available ground truth — the
 * provider's own count, on the two judges where it is comparable — the
 * whole-stream chars model reads +7.1% (Qwen3.6) and +7.6% (granite4.2). The
 * spread of the two inputs is 3.52…3.76, +-3.3% about the mean. Treat every
 * number derived from this constant as an estimate with a 10% band, never as
 * a measurement — which is why the report prints `outputTokens` and the raw
 * character count beside every estimate, so an operator can re-derive under a
 * different constant without re-running anything.
 */
export const CHARS_PER_TOKEN = 3.64;

/**
 * Above this ratio of `length(reasoningContent) / outputTokens`, the
 * provider's count EXCLUDES the reasoning channel.
 *
 * WHY A RATIO IS THE ONLY DISCRIMINATOR AVAILABLE: the semantics vary per
 * MODEL. granite4.2:3b and qwen3.5:9b are both Ollama and both report
 * `reasoningSource: 'reasoning'`, and they disagree — so neither
 * `servingBackend` nor `reasoningSource` separates them, and nothing on the
 * wire says which meaning applies.
 *
 * WHY 8. When the count INCLUDES reasoning, `reasoningTokens <= outputTokens`,
 * so this ratio is bounded above by the model's own chars-per-token — it
 * cannot physically exceed it. The largest chars-per-token measured on any
 * stream in this corpus is 4.909 (granite4.1:3b, content only), so a
 * physically consistent "includes" reading tops out near 5. Measured
 * 2026-09-02 over every completed judgment:
 *
 *   includes   Qwen3.6 + granite4.2 + granite4.1   n=245   ratio   0.00 …   4.73
 *   excludes   qwen3.5:9b                          n= 18   ratio  36.73 … 156.69
 *
 * 8 sits 1.69x above the highest "includes" reading and 4.6x below the lowest
 * "excludes" one. Any threshold in 5…37 classifies this corpus identically; 8
 * is placed just above the PHYSICAL ceiling rather than at the midpoint of an
 * empirical gap, because the ceiling is the part that generalises to a model
 * this corpus has never seen.
 *
 * The comparison is `>`, not `>=`: a ratio of exactly 8.0 is still a possible
 * tokenizer rate and is therefore not evidence of anything.
 */
export const REASONING_EXCLUDED_RATIO = 8;

/**
 * What `outputTokens` was found to count for one judgment.
 *
 * `unmeasurable` and `no_reasoning_channel` are separate values on purpose:
 * the first means the provider reported no usable token count, the second
 * means the model emitted no thinking. Collapsing either into
 * `includes_reasoning` would assert a measurement that was never made.
 */
export type ReasoningAccounting =
  | 'includes_reasoning'
  | 'excludes_reasoning'
  | 'no_reasoning_channel'
  | 'unmeasurable';

export interface TokenAccounting {
  accounting: ReasoningAccounting;
  /** `reasoningContent.length` — UTF-16 code units, the same definition
   * `scripts/calibration/run.ts`'s `cap()` prints as "N chars". Exact, and
   * free: the column is stored verbatim. */
  reasoningChars: number;
  /** `reasoningChars / outputTokens`. `null` when `outputTokens` is not a
   * usable positive count — never 0, which would read as a measured ratio. */
  charsPerOutputToken: number | null;
  /** DERIVED total tokens the model generated, reasoning included. `null`
   * when `outputTokens` is absent. NEVER written to `ModelJudgment
   * .outputTokens`, and never presented without the DERIVED label. */
  estimatedGeneratedTokens: number | null;
}

export function accountTokens(input: {
  outputTokens?: number | null;
  reasoningContent?: string | null;
}): TokenAccounting {
  const reasoningChars = input.reasoningContent?.length ?? 0;
  const outputTokens = input.outputTokens ?? null;

  // An absent or non-positive provider count is an ABSENCE. Returning 0 here
  // would put "this judgment generated nothing" into a tok/s denominator and
  // into a truncation fraction — the exact conflation the 2026-08-30 register
  // forbids for `reasoningTokens`, for the same reason.
  if (outputTokens === null || outputTokens <= 0) {
    return {
      accounting: 'unmeasurable',
      reasoningChars,
      charsPerOutputToken: null,
      estimatedGeneratedTokens: null,
    };
  }

  // No thinking was emitted at all, so there is no hidden channel that could
  // be missing from the count: the provider's number is the whole generation.
  // `extractReasoningChannel` (src/lib/llm/openai-compatible.ts:169-187) has
  // already looked at `reasoning_content`, `reasoning` and an in-band
  // `<think>` block, so "no channel here" means "no channel on the wire".
  if (reasoningChars === 0) {
    return {
      accounting: 'no_reasoning_channel',
      reasoningChars,
      charsPerOutputToken: 0,
      estimatedGeneratedTokens: outputTokens,
    };
  }

  const charsPerOutputToken = reasoningChars / outputTokens;

  if (charsPerOutputToken > REASONING_EXCLUDED_RATIO) {
    // The two channels add: `outputTokens` is the content alone.
    return {
      accounting: 'excludes_reasoning',
      reasoningChars,
      charsPerOutputToken,
      estimatedGeneratedTokens: outputTokens + Math.round(reasoningChars / CHARS_PER_TOKEN),
    };
  }

  // The provider already counted the thinking; adding a chars-derived
  // estimate on top would double-count it. Measured: on these judges
  // `Σ(reasoningChars + contentChars) / Σ outputTokens` is 3.762 and 3.868,
  // i.e. `outputTokens` already covers the whole generated stream.
  return {
    accounting: 'includes_reasoning',
    reasoningChars,
    charsPerOutputToken,
    estimatedGeneratedTokens: outputTokens,
  };
}
