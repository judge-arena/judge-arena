/**
 * Deterministic reasoning-channel fixtures for the repetition-loop detector
 * (src/lib/llm/degeneration.ts).
 *
 * NOT a test file: vitest's include is the three-glob array
 * ['src/**\/*.test.ts', 'src/**\/*.test.tsx', 'tests/**\/*.test.ts']
 * (vitest.config.ts:8) and this file matches none of them, so it is never
 * collected; it is imported by
 * tests/lib/degeneration.test.ts and tests/lib/llm-truncation.test.ts.
 *
 * WHY GENERATORS AND NOT CHECKED-IN MODEL OUTPUT: the honest fixture would be
 * a real granite4.2 `reasoningContent` row, but that is ~50 KB of model output
 * quoting JudgeBench candidate text. These are synthetic, seeded and
 * length-pinned instead, and the numbers below were measured with node zlib
 * (default level) on 2026-09-01 so a future reader can tell whether the
 * detector or the fixture moved:
 *
 *   loopPure(44_000)        140.1x   the spec §5.4.2 clause, verbatim, forever
 *   loopAfterPrefix()        14.4x   8k of prose, then the clause (the measured
 *                                    shape: a judgment reasons, then cycles)
 *   loopNumbered()           31.8x   a NON-verbatim loop (counter increments)
 *   legitLong(13_138)         3.08x  seeded prose at the completed-mean length
 *   legitLong(44_287)         3.35x  seeded prose at the failed-mean length
 *   legitLong(56_004)         3.39x  seeded prose at the longest failed length
 *   judgmentJson()            3.21x  20,814 chars — the CONTENT channel in the
 *                                    shape a pointwise judge is actually asked
 *                                    for (see below)
 *
 * THE CONTENT-CHANNEL NEGATIVE IS NOT PROSE. A judgment's `text` never carries
 * a word stream; it carries the JSON of src/lib/llm/judgment-schema.ts. TWO
 * seams set `mode: 'judgment'` — `executeJudgmentCall` (pointwise,
 * `JUDGMENT_JSON_SCHEMA`) and `executePairwiseCall`
 * (`PAIRWISE_JUDGMENT_JSON_SCHEMA` = `{verdict, reasoning}`) — so the channel
 * holds TWO shapes, not one. `judgmentJson` models the pointwise one, which is
 * the harder case; the pairwise one is measured inline in
 * tests/lib/degeneration.test.ts (20,158 chars at 3.17x) because it is nearly
 * pure prose with less boilerplate, hence a LOWER ratio. The pointwise shape is
 * `overallScore` / `reasoning` / `criteriaScores[]`, where the array entries
 * carry criterionId/criterionName/score/maxScore and NO prose, so all the
 * entropy sits in the single top-level `reasoning` string and the array is
 * pure boilerplate. That shape's ratio is therefore driven by the RUBRIC SIZE,
 * and it was measured across the range before the content channel was kept
 * (node zlib, default level, 2026-09-02):
 *
 *   judgmentJson(5,   8_500)   9,241 chars   3.02x   the seed catalog's rubric
 *   judgmentJson(5,  20_000)  20,814 chars   3.21x   (prisma/seed-core.ts:300
 *   judgmentJson(5,  56_000)  57,042 chars   3.42x    — "1 Rubric with 5
 *   judgmentJson(10, 20_000)  21,425 chars   3.28x    criteria")
 *   judgmentJson(20,  8_000)  10,604 chars   3.45x
 *   judgmentJson(40,  4_000)   9,067 chars   4.41x   still under the threshold
 *   judgmentJson(60,  2_000)   9,558 chars   6.10x   FLAGGED — the boundary
 *   judgmentJson(100, 1_000)  13,547 chars   8.15x   FLAGGED
 *   judgmentJson(200, 0)      25,103 chars  10.46x   FLAGGED
 *
 * So the content channel is safe at every rubric size that ships today, and
 * the false positive it can produce needs a rubric of roughly 60+ criteria
 * scored with a terse rationale. degeneration.ts's docblock records that as
 * the accepted trade and names the remedy (drop the channel, do not raise the
 * threshold).
 *
 * Production for comparison (deflate on real rows, same day): completed
 * granite4.2 3.00-4.09x on run 9's sample (5.38x population max at 33k
 * chars); run 9's five loops 5.23-29.27x. The tests assert DETECTED / NOT
 * DETECTED, never a ratio band — the ratio is a property of the literal text
 * and rises with length even for prose.
 *
 * `legitLong` MUST NOT be a tiled paragraph: tiling compresses like a loop and
 * would make the negative case meaningless. It is a seeded word stream with a
 * pseudo-random number every ninth token, which is what keeps it under 3.5x
 * at 56k chars.
 */

/** The clause granite4.2 cycled verbatim on run 9. Source: the scoreboard
 * spec, §5.4.2 ("IT WAS NOT TRUNCATION. IT WAS A REPETITION LOOP"), the fenced
 * excerpt beginning "the person who likes chess". Section heading, no line
 * range — the range has already gone stale twice. */
export const LOOP_CLAUSE =
  '"the person who likes chess" refers to the person whose hobby is chess; ' +
  '"the person who likes rock-climbing" refers to the person whose hobby is rock-climbing; ' +
  '"the person who likes collecting" refers to the person whose hobby is collecting; ' +
  '"the person who likes traveling" refers to the person whose hobby is traveling; ';

const VOCAB = (
  'the response candidate rubric criterion answer because however evidence claims verifies step ' +
  'assume contradiction constraint earlier later therefore weigh accuracy clarity omits includes ' +
  'correct incorrect partial hobby chess travel collecting climbing person house clue position ' +
  'ordering fifth second third first fourth conclude recheck note also but so if then which that ' +
  'this each only both neither either one two three four five given implies unless whereas ' +
  'otherwise consistent inconsistent violates satisfies premise deduce eliminate remaining option ' +
  'list swap adjacent between leftmost rightmost middle count total remainder alternative ' +
  'hypothesis reject accept confirm mention explicit implicit detail summary format length tone ' +
  'helpful harmful concise verbose accurate vague specific general cites source quotes number ' +
  'date name place'
).split(' ');

/** xorshift32 — tiny, dependency-free, and identical on every platform. */
function xorshift32(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x;
  };
}

/** Genuinely non-repeating prose-shaped text of exactly `chars` characters. */
export function legitLong(chars: number, seed = 42): string {
  const next = xorshift32(seed);
  let out = '';
  let i = 0;
  while (out.length < chars) {
    const w = VOCAB[next() % VOCAB.length];
    out += i % 9 === 8 ? `${w} (${(next() % 9000) + 1000}) ` : i % 17 === 16 ? `${w}.\n` : `${w} `;
    i += 1;
  }
  return out.slice(0, chars);
}

/** The clause repeated to exactly `chars` characters. */
export function loopPure(chars = 44_000): string {
  return LOOP_CLAUSE.repeat(Math.ceil(chars / LOOP_CLAUSE.length)).slice(0, chars);
}

/** Prose for `prefixChars`, then the clause, cut to exactly `total`. 44,287 is
 * run 9's mean failed length (spec §5.4.2 table). */
export function loopAfterPrefix(prefixChars = 8_000, total = 44_287): string {
  return (legitLong(prefixChars) + loopPure(total)).slice(0, total);
}

/** A loop that is NOT verbatim — the step counter changes every cycle. */
export function loopNumbered(total = 44_000): string {
  let out = '';
  for (let n = 1; out.length < total; n += 1) {
    out += `Step ${n}: Let me re-check whether response A addresses the constraint better than response B. `;
  }
  return out.slice(0, total);
}

/**
 * A pointwise judgment's CONTENT channel, in the shape the judge is actually
 * asked for (`JUDGMENT_JSON_SCHEMA` in src/lib/llm/judgment-schema.ts — symbol,
 * not a line range, because this comment is committed and ranges go stale).
 * The per-criterion entries
 * carry no prose — criterionId/criterionName/score/maxScore only — so the
 * array is boilerplate and the entropy is the one `reasoning` string; that is
 * why the ratio climbs with the CRITERIA count, not with the length. Defaults
 * are the seed catalog's rubric size (5) and a long-but-plausible rationale:
 * 20,814 chars at 3.21x, i.e. over the detector's floor and under its
 * threshold, which is exactly the case the content channel's negative test
 * needs. See this file's header for the measured range.
 */
export function judgmentJson(criteria = 5, reasoningChars = 20_000, seed = 7): string {
  const next = xorshift32(seed);
  const criteriaScores = Array.from({ length: criteria }, (_, i) => ({
    criterionId: `crit-${i + 1}`,
    criterionName: `${VOCAB[next() % VOCAB.length]} ${VOCAB[next() % VOCAB.length]}`,
    score: next() % 11,
    maxScore: 10,
  }));
  return JSON.stringify({ overallScore: 7.5, reasoning: legitLong(reasoningChars, seed), criteriaScores }, null, 2);
}
