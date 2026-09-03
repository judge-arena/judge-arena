import { describe, expect, it } from 'vitest';

/**
 * The repetition-loop detector, in isolation.
 *
 * THE FAILURE THIS EXISTS TO PREVENT (handoff 2026-09-01 §5.2): granite4.2:3b
 * failed 5 of 30 calibration items with finish_reason 'length' at
 * max_tokens 12288, and the guard's message told the operator to raise
 * max_tokens. All five were degenerate repetition — 26k-56k chars of one
 * clause cycling — and a larger budget buys a longer loop. Those five
 * consumed 41 of the run's 82 minutes for zero verdicts.
 *
 * Imports ONLY the pure module and the fixture generators, on purpose: this
 * file must never pull the consumer (or anything with a DB/queue/realtime
 * import) into the unit coverage denominator — see
 * tests/lib/judgment-consumer-escalation.test.ts:51-60 for what that does to
 * the src/lib/realtime/** floor. Execute()-level cases live in
 * tests/lib/llm-truncation.test.ts, which already carries that import.
 *
 * Every assertion is DETECTED / NOT DETECTED, never a ratio band: the ratio is
 * a property of the literal fixture text (the same "numbered loop" idea
 * measured 8.96x in one draft and 31.9x in another) and rises with length
 * even for prose. The fixture module's header records the measured ratios.
 */
import {
  REPETITION_MIN_CHARS,
  REPETITION_RATIO_THRESHOLD,
  detectRepetitionLoop,
  isLoopRatio,
  measureRepetition,
} from '@/lib/llm/degeneration';
import { LOOP_CLAUSE, judgmentJson, legitLong, loopAfterPrefix, loopNumbered, loopPure } from './reasoning-fixtures';

describe('the fixtures are what their names say', () => {
  it('generators are deterministic and length-exact', () => {
    expect(legitLong(20_000)).toBe(legitLong(20_000));
    expect(legitLong(20_000)).toHaveLength(20_000);
    expect(loopPure()).toHaveLength(44_000);
    expect(loopAfterPrefix()).toHaveLength(44_287);
    expect(loopNumbered()).toHaveLength(44_000);
    expect(loopPure()).toContain(LOOP_CLAUSE);
    // The content-channel negative must clear the detector's floor, or the
    // case below would pass for the wrong reason (too short to measure).
    expect(judgmentJson()).toBe(judgmentJson());
    expect(judgmentJson().length).toBeGreaterThan(8_000);
    expect(JSON.parse(judgmentJson()).criteriaScores).toHaveLength(5);
  });

  it('the constants are the documented ones, and the ratio comparison is INCLUSIVE (a change here is a policy change, not a refactor)', () => {
    expect(REPETITION_MIN_CHARS).toBe(8_000);
    expect(REPETITION_RATIO_THRESHOLD).toBe(5);
    // The `>=` vs `>` boundary was previously UNPINNED and this plan said so
    // in the module docblock: no fixture and no production row lands at
    // exactly 5.00, so a `>` implementation passed every other case in this
    // file. That mutant is not cosmetic — it drops run 9's 52,702-char
    // failure at 5.23x only when the ratio happens to land on 5.00, but more
    // importantly it silently converts the binding decision (threshold 5)
    // into the alternative that was explicitly rejected. `isLoopRatio` exists
    // so the operator can be pinned by two literals; Injection E breaks it.
    expect(isLoopRatio(5)).toBe(true);
    expect(isLoopRatio(4.999)).toBe(false);
  });
});

describe('measureRepetition', () => {
  it('measures BYTES, reports CHARS, and echoes the channel', () => {
    // 3-byte characters: 10,000 chars is 30,000 bytes. The ratio must be a
    // bytes/bytes figure or a CJK reasoner would read three times too
    // compressible.
    const m = measureRepetition('漢字の判定'.repeat(2_000), 'reasoning');
    expect(m.chars).toBe(10_000);
    expect(m.bytes).toBe(30_000);
    expect(m.compressedBytes).toBeGreaterThan(0);
    expect(m.ratio).toBe(m.bytes / m.compressedBytes);
    expect(m.channel).toBe('reasoning');
  });

  it('a content-channel measure says so', () => {
    expect(measureRepetition('abc', 'content').channel).toBe('content');
  });
});

describe('detectRepetitionLoop: the reasoning channel', () => {
  it('detects the spec §5.4.2 clause cycling verbatim', () => {
    const hit = detectRepetitionLoop({ text: '', reasoningText: loopPure() }, 'judgment');
    expect(hit).toBeDefined();
    expect(hit!.channel).toBe('reasoning');
    expect(hit!.chars).toBe(44_000);
  });

  it('detects the measured production shape: 8k of prose, then the loop', () => {
    expect(detectRepetitionLoop({ text: '', reasoningText: loopAfterPrefix() }, 'judgment')).toBeDefined();
  });

  it('detects a NON-verbatim loop (an incrementing counter inside the cycle)', () => {
    expect(detectRepetitionLoop({ text: '', reasoningText: loopNumbered() }, 'judgment')).toBeDefined();
  });

  it('does NOT flag genuinely long reasoning at the loop fixtures\' own lengths', () => {
    // Tested at 44k and 56k, not 13k: the deflate ratio of prose RISES with
    // length (more back-references), so a negative case at 13k chars proves
    // nothing about a 56k truncation.
    expect(detectRepetitionLoop({ text: '', reasoningText: legitLong(44_287) }, 'judgment')).toBeUndefined();
    expect(detectRepetitionLoop({ text: '', reasoningText: legitLong(56_004) }, 'judgment')).toBeUndefined();
  });

  it('does NOT flag a short truncation, however compressible — the length floor is the whole point', () => {
    // tests/lib/llm-truncation.test.ts pins 'x'.repeat(1164) as a GENUINE
    // truncation whose message must still name samplingDefaults.max_tokens.
    // That string deflates at 64x; without the floor it would read as a loop.
    expect(detectRepetitionLoop({ text: '', reasoningText: 'x'.repeat(1_164) }, 'judgment')).toBeUndefined();
    expect(detectRepetitionLoop({ text: '', reasoningText: legitLong(1_164) }, 'judgment')).toBeUndefined();
  });

  it('the floor is inclusive at exactly 8,000 chars', () => {
    // LITERALS, not `REPETITION_MIN_CHARS ± 1`. Interpolating the constant
    // makes the case self-referential: it would still pass at any floor, and
    // Injection B (floor -> 0) would turn the inputs into 'x'.repeat(0) and
    // 'x'.repeat(-1) — the second a RangeError — so the injection would go
    // red for a reason that is not the defect. Measured: 'x'.repeat(8_000)
    // deflates 285.71x, 'x'.repeat(7_999) 266.63x; both are far above the 5x
    // threshold, so ONLY the floor decides these two lines. The separate
    // constants test above is the policy pin.
    expect(detectRepetitionLoop({ text: '', reasoningText: 'x'.repeat(8_000) })).toBeDefined();
    expect(detectRepetitionLoop({ text: '', reasoningText: 'x'.repeat(7_999) })).toBeUndefined();
    // And the floor is CHARS, not BYTES. Every other probe here is ASCII, so
    // `Buffer.byteLength(reasoning) >= REPETITION_MIN_CHARS` would pass them
    // all. 7,500 CJK chars are 22,500 UTF-8 bytes and deflate at 258.6x: a
    // bytes-floor implementation measures them and flags them, a chars-floor
    // one does not. The consequence is real — a CJK judge looping inside
    // 3,000 chars would otherwise be flagged below the documented floor.
    expect(detectRepetitionLoop({ text: '', reasoningText: '漢字の判定'.repeat(1_500) })).toBeUndefined();
  });

  it('measures the reasoning channel regardless of mode', () => {
    expect(detectRepetitionLoop({ text: '', reasoningText: loopPure() }, 'respond')).toBeDefined();
    expect(detectRepetitionLoop({ text: '', reasoningText: loopPure() }, undefined)).toBeDefined();
  });
});

describe('detectRepetitionLoop: the content channel', () => {
  it('measures CONTENT only in judgment mode — a judgment\'s content is a small JSON object, so 8k+ of it at the budget is itself anomalous', () => {
    const hit = detectRepetitionLoop({ text: loopPure() }, 'judgment');
    expect(hit).toBeDefined();
    expect(hit!.channel).toBe('content');
    expect(hit!.chars).toBe(44_000);
  });

  it('never measures CONTENT in respond mode or with no mode: long structured answers (big JSON arrays, long markdown tables) deflate like loops legitimately, because they are mostly repeated delimiters and field names', () => {
    expect(detectRepetitionLoop({ text: loopPure() }, 'respond')).toBeUndefined();
    expect(detectRepetitionLoop({ text: loopPure() }, undefined)).toBeUndefined();
  });

  it('does NOT flag a REAL judgment payload in judgment mode, pointwise OR pairwise — clearing the floor is not the same as looping', () => {
    // The content channel has its own ratio comparison; this is the case
    // where it is measured (judgment mode, over the floor) and does NOT read
    // as a loop. Without it the false arm of that comparison is never
    // executed.
    //
    // The fixture is judgmentJson, not legitLong: a judgment's `text` never
    // carries a word stream, it carries a JSON object, and the pointwise
    // shape is half boilerplate (criteriaScores entries have no prose).
    // A prose negative would prove nothing about the shapes this channel
    // actually holds. Measured 3.21x at the seed catalog's 5-criterion rubric,
    // 3.02-3.45x from 9k to 57k chars and up to 20 criteria; the fixture
    // header records where it does cross 5x (~60 criteria with a terse
    // rationale, 6.10x) and degeneration.ts's docblock records the remedy.
    expect(detectRepetitionLoop({ text: judgmentJson() }, 'judgment')).toBeUndefined();
    expect(detectRepetitionLoop({ text: judgmentJson(20, 8_000) }, 'judgment')).toBeUndefined();
    // TWO seams set mode 'judgment', not one: executeJudgmentCall (pointwise,
    // JUDGMENT_JSON_SCHEMA) and executePairwiseCall (PAIRWISE_JUDGMENT_JSON_-
    // SCHEMA = `{verdict, reasoning}`, src/lib/llm/judgment-schema.ts:95-110).
    // The pairwise payload is near-pure prose with LESS boilerplate than the
    // pointwise one, so its ratio should sit below it — but "should" is what
    // this plan exists to stop doing, so it is measured and asserted:
    // 20,158 chars at 3.17x (node zlib, default level, 2026-09-02), i.e. over
    // the floor and under the threshold, which is the arm that must execute.
    expect(
      detectRepetitionLoop({ text: JSON.stringify({ verdict: 'A', reasoning: legitLong(20_000) }) }, 'judgment')
    ).toBeUndefined();
  });

  it('the CONTENT floor is inclusive at exactly 8,000 chars too — the second gate is not decoration', () => {
    // Without this case the whole content-channel length gate is unpinned:
    // `mode === 'judgment' && result.text.length > 0` passes every other test
    // in this file AND every case in tests/lib/llm-truncation.test.ts,
    // because no fixture anywhere lands in (0, 8_000) chars with a ratio
    // >= 5. Coverage does not catch it either — the gate's false arm is
    // executed by the reasoning-channel cases (where `text` is ''), so
    // degeneration.ts still reads 100/100/100/100 with the mutant in place.
    //
    // LITERALS, for the same reason as the reasoning floor above: measured
    // 285.71x for 'x'.repeat(8_000) and 266.63x for 'x'.repeat(7_999), so
    // only the floor decides these two lines.
    expect(detectRepetitionLoop({ text: 'x'.repeat(8_000) }, 'judgment')).toMatchObject({ channel: 'content' });
    expect(detectRepetitionLoop({ text: 'x'.repeat(7_999) }, 'judgment')).toBeUndefined();
  });

  it('measures each channel INDEPENDENTLY — a loop confined to the shorter channel is still found', () => {
    // 20k of legitimate reasoning plus 10k of looping content. A "pick the
    // longer channel" implementation measures the reasoning (~3x) and misses
    // the loop.
    const hit = detectRepetitionLoop({ text: loopPure(10_000), reasoningText: legitLong(20_000) }, 'judgment');
    expect(hit).toBeDefined();
    expect(hit!.channel).toBe('content');
  });

  it('never CONCATENATES the channels: a think_tag response carries the reasoning inside text too', () => {
    // openai-compatible.ts's extractReasoningChannel is additive — for
    // `<think>` responses, reasoningText is a substring of text. Summing the
    // two would double-count the loop and report a chars figure that matches
    // no channel an operator can look at.
    const thinking = loopPure();
    const hit = detectRepetitionLoop({ text: `<think>${thinking}</think>`, reasoningText: thinking }, 'judgment');
    expect(hit).toBeDefined();
    expect(hit!.channel).toBe('reasoning');
    expect(hit!.chars).toBe(thinking.length);
  });

  it('returns undefined, and does not throw, on an empty result', () => {
    expect(detectRepetitionLoop({ text: '' }, 'judgment')).toBeUndefined();
    expect(detectRepetitionLoop({ text: '', reasoningText: undefined }, 'judgment')).toBeUndefined();
  });
});
