/**
 * ─── Degenerate-repetition detector ───────────────────────────────────────
 *
 * Distinguishes "the model needed more room" from "the model is never going
 * to stop" when a call ends at the token budget. `finish_reason: 'length'`
 * is genuinely ambiguous between the two, and the guard in `registry.ts`'s
 * `assertUsableContent` used to assume the first — its advice ("raise
 * samplingDefaults.max_tokens") is correct for a truncation and actively
 * harmful for a loop, where a larger budget buys a longer loop at more
 * wall-clock. Handoff 2026-09-01 §5.2: granite4.2:3b looped on 5 of 30 items
 * at 12288 tokens and those five consumed half the run's compute for zero
 * verdicts.
 *
 * THE SIGNAL: repetitive text compresses far better than prose. Measured
 * with node zlib (default level) on production `reasoningContent`, 2026-09-01:
 * granite4.2 judgments that finished deflate at 3.0-4.1x (population max
 * 5.38x at 33k chars, verbose but not cycling); the five run-9 loops deflate
 * at 5.23x, 6.26x, 7.07x, 10.79x and 29.27x. Qwen3.6 prose: 2.6-3.8x.
 *
 * TWO GATES, both deliberate:
 * - A LENGTH FLOOR (`REPETITION_MIN_CHARS`). Short strings compress
 *   pathologically ('x'.repeat(1164) reads 64x) and a loop under ~2k tokens
 *   is indistinguishable from a short truncation; there the max_tokens
 *   advice is harmless — one raise surfaces a longer loop that this module
 *   will then name.
 * - PER-CHANNEL measurement, NEVER concatenated. For a `think_tag` model the
 *   reasoning text is a substring of `text` (openai-compatible.ts:252 keeps
 *   `choice.message.content` WHOLE — the `<think>` block is not stripped from
 *   it — and :253 additionally extracts the reasoning from it), so a
 *   concatenated measure would double-count. Each channel that clears the
 *   floor is measured on its own; either exceeding the threshold is a loop.
 *   One consequence, stated so nobody rediscovers it as a bug: for a
 *   `think_tag` JUDGMENT whose reasoning is under the floor but whose `text`
 *   (think block included) is over it, the content channel re-measures the
 *   same reasoning bytes and the message reports them as "N content chars".
 *   That is not a double-count and not a false positive — the loop is real —
 *   but the channel LABEL points at `rawResponse` where the operator will
 *   find the reasoning too.
 *
 * THE CONTENT CHANNEL IS ONLY MEASURED IN JUDGMENT MODE. A judgment's
 * content is a small JSON object, so 8k+ chars of it at the budget is
 * anomalous in itself. A respond-mode answer can legitimately be a long
 * structured list, and structure alone compresses well above the 5x
 * threshold — a large JSON array or a long markdown table is mostly repeated
 * delimiters and field names. (No specific ratio is quoted here on purpose:
 * an earlier revision pinned "a 400-object JSON array 13.9x, a 300-row
 * markdown table 8.3x" in this docblock and in the commit body, with no
 * generator, seed or shape recorded anywhere, so nobody could re-derive it.
 * Every other number in this module reproduces from
 * tests/lib/reasoning-fixtures.ts; those two did not, and an unreproducible
 * number in a docblock that exists to correct unmeasured claims is the
 * failure this whole change is about.) Telling that caller "raising
 * max_tokens buys a longer loop" would be the same wrong advice in the other
 * direction.
 *
 * THE CONTENT CHANNEL IS A PRECAUTION WITH NO MEASURED PRODUCTION INSTANCE
 * BEHIND IT. All five production loops were in the REASONING channel. Task 1
 * of the plan scans `rawResponse` as well as `reasoningContent` (and the
 * shipping rubric sizes), so if a production content-channel instance exists
 * it is on the record; the expected outcome is that none clears 8,000 chars.
 * The judgment-mode gate is what makes it safe for respond mode; what makes
 * it safe for judgments was measured before shipping. TWO seams set that
 * mode — `executeJudgmentCall` (pointwise, `JUDGMENT_JSON_SCHEMA`) and
 * `executePairwiseCall` (`PAIRWISE_JUDGMENT_JSON_SCHEMA` = `{verdict,
 * reasoning}`) — so the channel holds two shapes. The measurement below is
 * the POINTWISE one (one top-level `reasoning` string plus a prose-free
 * `criteriaScores` array, so the ratio tracks the RUBRIC SIZE and not the
 * length), which is the harder of the two; the pairwise payload is nearly
 * pure prose with less boilerplate and measures 3.17x at 20,158 chars, below
 * the pointwise figure, and is pinned as its own assertion in
 * tests/lib/degeneration.test.ts. Over the seed
 * catalog's 5-criterion rubric it reads 3.02x at 9,241 chars and 3.42x at
 * 57,042; 20 criteria with an 8k rationale reads 3.45x; 40 criteria reads
 * 4.41x. It first crosses 5x at roughly 60 criteria scored with a terse
 * (2k-char) rationale — 9,558 chars, 6.10x — and reaches 10.5x at 200. So
 * the false positive is not demonstrated at any rubric that ships today, but
 * a very large rubric with a terse rationale WOULD be told the opposite of
 * what it needs. If that appears, DROP THE CONTENT CHANNEL rather than
 * raising the threshold: raising it would also stop catching the 5.23x
 * reasoning row this module exists for.
 * (tests/lib/reasoning-fixtures.ts's `judgmentJson` is that measurement, kept
 * runnable; tests/lib/degeneration.test.ts pins the 5-criterion and
 * 20-criterion cases as negatives.)
 *
 * Pure and synchronous. `deflateSync` costs ~0.07 ms on a 44k loop and
 * ~1 ms on 56k of incompressible prose — the real worst case (measured on
 * node 22.23.1, 50 iterations) — and runs only on the failure path (after
 * the guard has decided to throw).
 * Bare `'zlib'` import: src/lib's convention for node builtins
 * (registry.ts imports `'crypto'` the same way).
 */

import { deflateSync } from 'zlib';
import type { ProviderCallResult } from './provider';

/** Below this many characters a loop cannot be told from a short truncation,
 * and the max_tokens advice is harmless. Keeps the 1,164/762-char fixtures in
 * tests/lib/llm-truncation.test.ts (64x/51x) on the truncation message. */
export const REPETITION_MIN_CHARS = 8_000;

/** bytes / deflated bytes. Prose measures 2.6-4.1x on the two self-hosted
 * judges; run 9's loops measured 5.23x and up. The comparison is INCLUSIVE
 * (`>=`) and it is load-bearing for exactly one row: run 9's 52,702-char
 * failure at 5.23x, which clears the bar by 0.23 and is the row that decides
 * threshold 5 over the rejected alternative 6. */
export const REPETITION_RATIO_THRESHOLD = 5;

/**
 * The ratio gate, extracted so the `>=` boundary can be PINNED by two
 * literals rather than left to review.
 *
 * No fixture and no production row lands at exactly 5.00, so an
 * implementation using `>` passes every detect/undetect case in
 * tests/lib/degeneration.test.ts and every execute()-level case in
 * tests/lib/llm-truncation.test.ts — an earlier revision of this module
 * documented that gap and accepted it ("a REVIEW-ENFORCED property, not a
 * pinned one"). That is failure mode 5 (an assertion with no injection behind
 * it): the surviving mutant silently converts the binding decision into the
 * alternative it rejected, with the suite green. `expect(isLoopRatio(5))` and
 * `expect(isLoopRatio(4.999))` are the pin; Injection E is the red.
 *
 * Both ratio gates below call this — never inline the comparison, or the pin
 * stops guarding the gate it was written for.
 */
export function isLoopRatio(ratio: number): boolean {
  return ratio >= REPETITION_RATIO_THRESHOLD;
}

export interface RepetitionMeasure {
  /** UTF-16 code units, i.e. what `.length` and `ModelJudgment` column
   * lengths report. */
  chars: number;
  /** UTF-8 bytes actually compressed. */
  bytes: number;
  compressedBytes: number;
  /** `bytes / compressedBytes`. */
  ratio: number;
  channel: 'reasoning' | 'content';
}

export function measureRepetition(text: string, channel: RepetitionMeasure['channel']): RepetitionMeasure {
  const buf = Buffer.from(text, 'utf8');
  // deflateSync never returns an empty buffer (2-byte header + 4-byte
  // adler32 at minimum), so the division is safe without a guard.
  const compressedBytes = deflateSync(buf).length;
  return { chars: text.length, bytes: buf.byteLength, compressedBytes, ratio: buf.byteLength / compressedBytes, channel };
}

/**
 * Returns the measure of the first channel that reads as a loop — reasoning
 * first (the channel the loops were found in), then content — or `undefined`
 * when neither does.
 */
export function detectRepetitionLoop(
  result: Pick<ProviderCallResult, 'text' | 'reasoningText'>,
  mode?: 'judgment' | 'respond'
): RepetitionMeasure | undefined {
  const reasoning = result.reasoningText ?? '';
  if (reasoning.length >= REPETITION_MIN_CHARS) {
    const measure = measureRepetition(reasoning, 'reasoning');
    if (isLoopRatio(measure.ratio)) return measure;
  }

  if (mode === 'judgment' && result.text.length >= REPETITION_MIN_CHARS) {
    const measure = measureRepetition(result.text, 'content');
    if (isLoopRatio(measure.ratio)) return measure;
  }

  return undefined;
}
