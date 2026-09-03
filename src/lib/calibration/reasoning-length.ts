/**
 * Length of the captured thinking channel, summarised for the calibration
 * report (scripts/calibration/run.ts).
 *
 * WHY CHARS AND NOT TOKENS. `ModelJudgment.reasoningTokens` is usage-reported
 * (`usage.completion_tokens_details.reasoning_tokens`, read at
 * src/lib/llm/openai-compatible.ts) and is NULL on every backend this fleet
 * runs — llama.cpp and Ollama emit no `completion_tokens_details`, and the
 * Anthropic adapter never sets it. An exact derivation needs the served
 * model's tokenizer, which this process does not have; an estimate would be a
 * fabricated number under a column documented as measured. The character
 * length of `reasoningContent` IS available. §5.2's signal was the CONTRAST
 * between two populations of it — failed judgments at mean 44,287 chars with
 * empty content, against completed ones at mean 13,138 — so the report calls
 * this once per terminal status rather than once over the whole run: a single
 * pooled figure (18,330 on that run) is neither number and separates nothing.
 *
 * NULL-NOT-ZERO, same contract as `summarizeLatencies` (./latency.ts): no
 * judgment carried a reasoning channel → `null`, never `{n: 0, mean: 0}`,
 * which would read as "the judge thought for zero characters". An EMPTY
 * string is a present-but-empty channel and counts as 0 chars.
 */
export interface ReasoningLengthSummary {
  /** Judgments whose `reasoningContent` was captured (non-null). */
  n: number;
  /** Whole characters — the report prints this beside token counts. */
  meanChars: number;
  maxChars: number;
}

export function summarizeReasoningLength(
  contents: readonly (string | null | undefined)[]
): ReasoningLengthSummary | null {
  const lengths = contents.flatMap((c) => (c == null ? [] : [c.length]));
  if (lengths.length === 0) return null;

  const total = lengths.reduce((sum, n) => sum + n, 0);
  return {
    n: lengths.length,
    meanChars: Math.round(total / lengths.length),
    maxChars: Math.max(...lengths),
  };
}

/**
 * One capture-report line for one POPULATION of judgments, formatted HERE
 * rather than in `scripts/calibration/run.ts`: that script is outside every
 * vitest `include`, so a template written there has no test and no injection
 * behind it. Both arms are pinned by
 * tests/lib/calibration-reasoning-length.test.ts.
 *
 * `label` is the judgment status the summary was computed over. It is
 * REQUIRED, not defaulted: the whole value of this line is the comparison
 * between `completed` and `error`, and an unlabelled line is the pooled line
 * that §5.2 shows cannot separate a loop from a verbose judge.
 */
export function formatReasoningLengthLine(
  summary: ReasoningLengthSummary | null,
  label: string
): string {
  return summary
    ? `  reasoningContent chars   ${label}  n=${summary.n}  mean=${summary.meanChars}  max=${summary.maxChars}`
    : `  reasoningContent chars   ${label}  none captured`;
}
