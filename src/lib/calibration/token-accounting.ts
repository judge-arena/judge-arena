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

/**
 * Warn when a judgment's estimated generation reaches this fraction of the
 * `max_tokens` it ran under.
 *
 * WHY 0.80, with the counts. Measured 2026-09-02 over all 263 completed
 * judgments with a usable token count, this threshold fires on exactly TWO:
 *
 *   item at 88.8%  Qwen3.6 @ 8192,  outputTokens 7272 — one long item from truncating
 *   item at 82.4%  qwen3.5:9b @ 6144, outputTokens 115 — the run that had to be voided
 *
 * and stays silent on the other 261, including every one of the 40
 * granite4.2:3b judgments, whose widest is 74.7% (3058 of 4096). So it is not
 * an "every long item warns" threshold.
 *
 * WHY NOT HIGHER, and why not lower. The estimator's measured residual against
 * the provider's own count is +7.1% / +7.6% (see CHARS_PER_TOKEN), so an item
 * truly at 87% or above always reads at or above 80% and cannot hide; pushing
 * the threshold to 0.90 would surrender that margin. Dropping it to 0.70 would
 * add FIVE more items — three granite4.2 @ 4096 (widest 74.7%), one
 * granite4.2 @ 12288 (74.5%) and one Qwen3.6 @ 8192 — all healthy, which is
 * how an operator is trained to ignore the line.
 *
 * IT IS A WARNING, NOT A VERDICT, and the direction of the right response is
 * not obvious: `finish_reason: 'length'` is ambiguous between "ran out of
 * room" and "never going to stop" (handoff §5.2 — five looping items burned 41
 * of one run's 82 minutes for zero verdicts), so the line points at runbook
 * §8.2 rather than telling anyone to raise the budget. It also prints
 * `outputTokens` and the raw character count beside every estimate, so the
 * number can be re-derived under a different constant without re-running.
 *
 * ONE ASSUMPTION, STATED BECAUSE NOTHING HERE TESTS IT. The fraction below
 * assumes `max_tokens` bounds the WHOLE generated stream, reasoning included,
 * even on a model whose `completion_tokens` excludes it. That is confirmed
 * only where the count INCLUDES reasoning: measured 2026-09-02, all 21
 * `finishReason: 'length'` judgments in the corpus (20 granite4.2:3b, 1
 * Qwen3.6) carry `outputTokens` exactly equal to their budget — 4096, 8192,
 * 12288. On qwen3.5:9b — the only judge where the count EXCLUDES reasoning,
 * and therefore the only judge whose fraction this module changes at all —
 * `finishReason: 'length'` has NEVER been observed, across 18 completed
 * judgments at two budgets. So the budget's scope on that path is INFERRED,
 * not measured. It is consistent with every row in the corpus (no item's
 * estimate has ever exceeded its budget) and it is the conservative reading,
 * but if it is false the fraction on an `excludes_reasoning` row is an
 * overstatement. That is why the line prints `outputTokens` and the raw
 * character count beside every estimate, and why it points at runbook §8.2
 * instead of advising a bigger budget.
 */
export const TRUNCATION_PROXIMITY_WARN = 0.8;

export interface MaxTokensResolution {
  maxTokens: number;
  source: 'judgment' | 'run_header';
}

/** `max_tokens` off a `SamplingParams`-shaped JSONB value, or `null`. Total
 * over everything a `Json?` column can hold; a non-number or a non-positive
 * number is not a budget. */
function readMaxTokens(value: unknown): number | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = (value as Record<string, unknown>).max_tokens;
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : null;
}

/**
 * The `max_tokens` a judgment actually ran under.
 *
 * ORDER MATTERS. `ModelJudgment.samplingParams` is EXECUTION truth and wins;
 * `CalibrationRun.samplingParams` (v2k) is the LAUNCH snapshot and is the
 * fallback, because `markJudgmentError` (src/worker/judgment-consumer.ts
 * :645-671) does not write `samplingParams` — so the errored rows, which are
 * exactly the truncation cases, have none of their own. The two agree by
 * construction unless the version row was edited mid-run, and
 * `detectSamplingDrift` already warns about that separately.
 *
 * `null` is returned rather than falling through to
 * `JUDGE_DEFAULT_SAMPLING_PARAMS` (src/lib/llm/sampling.ts:43, max_tokens
 * 4096). A registry default is a guess; presenting one as the budget a run
 * used is the lie `describeSamplingSnapshot` exists to avoid.
 */
export function resolveMaxTokens(
  judgmentSampling: unknown,
  headerSampling: unknown
): MaxTokensResolution | null {
  const fromJudgment = readMaxTokens(judgmentSampling);
  if (fromJudgment !== null) return { maxTokens: fromJudgment, source: 'judgment' };
  const fromHeader = readMaxTokens(headerSampling);
  if (fromHeader !== null) return { maxTokens: fromHeader, source: 'run_header' };
  return null;
}

export interface TruncationProximity {
  estimatedGeneratedTokens: number;
  maxTokens: number;
  maxTokensSource: 'judgment' | 'run_header';
  fraction: number;
  near: boolean;
}

/** `null` when either half is missing — never a 0% that would read as "this
 * judgment generated nothing", and never a fraction against a guessed budget. */
export function truncationProximity(
  accounting: TokenAccounting,
  maxTokens: MaxTokensResolution | null
): TruncationProximity | null {
  if (accounting.estimatedGeneratedTokens === null || maxTokens === null) return null;
  const fraction = accounting.estimatedGeneratedTokens / maxTokens.maxTokens;
  return {
    estimatedGeneratedTokens: accounting.estimatedGeneratedTokens,
    maxTokens: maxTokens.maxTokens,
    maxTokensSource: maxTokens.source,
    fraction,
    near: fraction >= TRUNCATION_PROXIMITY_WARN,
  };
}

/**
 * One judgment as the report reads it. EVERY FIELD IS REQUIRED on purpose:
 * `scripts/calibration/run.ts` maps its Prisma rows into this shape field by
 * field, and an explicit mapping that silently drops a field is failure mode
 * 14 — a partial rollout with tsc green. Required fields make the drop a type
 * error instead.
 */
export interface TokenAccountingRow {
  goldenItemIndex: number | null;
  status: string;
  outputTokens: number | null;
  reasoningContent: string | null;
  samplingParams: unknown;
}

function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

/**
 * The Token-accounting block of the calibration capture report.
 *
 * The STRINGS live here rather than in the script because `scripts/**` is
 * outside every coverage `include` (vitest.config.ts:37) and has no harness,
 * and the `>= 0.80` boundary is exactly the rule that must stay tested
 * (CONTRIBUTING.md:247 — "Put every rule that can be silently wrong into
 * `src/lib/**` so that it *can* be unit-tested" — the same argument
 * `sampling-drift.ts` was extracted under).
 *
 * Nothing is ever dropped silently: judgments with no usable `outputTokens`
 * and judgments with no resolvable `max_tokens` are excluded from the ratios
 * and the fractions, and the count of each is printed. A partial denominator
 * that looks like a whole one is this repo's most expensive recurring defect.
 */
export function formatTokenAccountingLines(
  rows: ReadonlyArray<TokenAccountingRow>,
  headerSampling: unknown
): string[] {
  const counts: Record<ReasoningAccounting, number> = {
    includes_reasoning: 0,
    excludes_reasoning: 0,
    no_reasoning_channel: 0,
    unmeasurable: 0,
  };
  const ratios: number[] = [];
  const near: Array<{ row: TokenAccountingRow; prox: TruncationProximity }> = [];
  let widest: TruncationProximity | null = null;
  let sized = 0;
  let noMaxTokens = 0;

  for (const row of rows) {
    const acc = accountTokens(row);
    counts[acc.accounting] += 1;

    // A 0.00 from a judge with no thinking channel at all (granite4.1:3b)
    // would drag the printed range down and read as a suspiciously dense
    // tokenizer rather than as an absent channel.
    if (acc.charsPerOutputToken !== null && acc.reasoningChars > 0) {
      ratios.push(acc.charsPerOutputToken);
    }

    const prox = truncationProximity(acc, resolveMaxTokens(row.samplingParams, headerSampling));
    if (prox === null) {
      if (acc.estimatedGeneratedTokens !== null) noMaxTokens += 1;
      continue;
    }
    sized += 1;
    if (widest === null || prox.fraction > widest.fraction) widest = prox;
    if (prox.near) near.push({ row, prox });
  }

  const lines: string[] = [
    `  accounting          includes_reasoning ${counts.includes_reasoning}   ` +
      `excludes_reasoning ${counts.excludes_reasoning}   ` +
      `no_reasoning_channel ${counts.no_reasoning_channel}   ` +
      `unmeasurable ${counts.unmeasurable}`,
  ];

  lines.push(
    ratios.length > 0
      ? `  chars/outputToken   ${Math.min(...ratios).toFixed(2)} … ${Math.max(...ratios).toFixed(2)} ` +
          `over ${ratios.length} judgment(s) with a reasoning channel   ` +
          `(> ${REASONING_EXCLUDED_RATIO} ⇒ the provider's count EXCLUDES reasoning)`
      : '  chars/outputToken   no judgment carried both a reasoning channel and an outputTokens count'
  );

  lines.push(
    widest !== null
      ? `  est. generation     closest to budget: ${widest.estimatedGeneratedTokens} tok = ${pct(widest.fraction)} ` +
          `of max_tokens ${widest.maxTokens}   (DERIVED at ${CHARS_PER_TOKEN} chars/token, ±10%)`
      : '  est. generation     no judgment had both an outputTokens count and a max_tokens — nothing to size against'
  );

  if (near.length > 0) {
    lines.push(
      `  ⚠ ${near.length} of ${sized} sized judgment(s) estimate at or above ` +
        `${pct(TRUNCATION_PROXIMITY_WARN)} of max_tokens. Size the next run from the ESTIMATE, ` +
        'not from outputTokens — but read runbook §8.2 first: a large estimate can be a ' +
        'repetition loop, which a bigger budget makes worse.'
    );
    // Capped at ten, matching the Failures block below it in the report.
    for (const { row, prox } of near.slice(0, 10)) {
      lines.push(
        `       item ${row.goldenItemIndex ?? '?'}  ${row.status}  ` +
          `est ${prox.estimatedGeneratedTokens} = ${pct(prox.fraction)} of ${prox.maxTokens} ` +
          `(max_tokens from the ${prox.maxTokensSource === 'judgment' ? 'judgment' : 'run header'})  ` +
          `[outputTokens ${row.outputTokens ?? 'NULL'}, reasoning ${row.reasoningContent?.length ?? 0} chars]`
      );
    }
  }

  if (counts.unmeasurable > 0 || noMaxTokens > 0) {
    lines.push(
      `  ⓘ ${counts.unmeasurable} judgment(s) had no usable outputTokens and ${noMaxTokens} had ` +
        'no max_tokens on the judgment or the run header — excluded from every number above, ' +
        'never counted as zero.'
    );
  }

  return lines;
}
