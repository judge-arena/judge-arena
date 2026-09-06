import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  constantVerdictBaseline,
  formatConstantBaselineLines,
  formatNoVerdictRateLine,
  formatSelectiveAccuracyLines,
} from '@/lib/calibration/baseline';

/**
 * The constant-verdict floor: what a judge that stamps the key's plurality
 * class on EVERY scored item would score. Every oracle below is worked by
 * hand from the counts — the function is a division, and the value of the
 * test is in the cases where a wrong division looks plausible (a partial
 * run, a tie among top classes, a key that is all ties).
 */
describe('constantVerdictBaseline — the floor is max(key class) / denominator', () => {
  it('the target set (17/13/0) floors at A>B = 17/30 = 0.5667, fully populated, over a COPY of the input', () => {
    const input = { 'A>B': 17, 'B>A': 13, tie: 0 };
    const floor = constantVerdictBaseline(input);
    expect(floor).toEqual({
      accuracy: 17 / 30,
      preferences: ['A>B'],
      keyCounts: { 'A>B': 17, 'B>A': 13, tie: 0 },
      denominator: 30,
    });
    expect(floor?.accuracy).toBeCloseTo(0.5667, 4);
    // The docblock promises a copy, so pin it: returning the caller's live
    // accumulator would make the score object alias score.ts's loop state.
    expect(floor?.keyCounts).not.toBe(input);
  });

  it("run 9's scored subset (14/11/0) floors at 14/25 = 0.5600 — NOT the full set's 0.5667", () => {
    // The floor moves with the denominator. granite4.2:3b scored 25 of 30
    // (five lost to a repetition loop); the 25 it scored were keyed 14/11.
    const floor = constantVerdictBaseline({ 'A>B': 14, 'B>A': 11, tie: 0 });
    expect(floor?.accuracy).toBeCloseTo(0.56, 10);
    expect(floor?.denominator).toBe(25);
    expect(Math.abs((floor?.accuracy ?? 0) - 17 / 30)).toBeGreaterThan(0.005);
  });

  it('a two-way tie among top classes (12/12/6) reports BOTH, in PREFERENCES order, at 12/30', () => {
    // A tie-containing key is reachable through PATCH /api/golden-sets/[id]/items
    // (no vocabulary check on an unfrozen set). Picking the first class would
    // report the right number under a misleading label.
    const floor = constantVerdictBaseline({ 'A>B': 12, 'B>A': 12, tie: 6 });
    expect(floor?.preferences).toEqual(['A>B', 'B>A']);
    expect(floor?.accuracy).toBeCloseTo(0.4, 10);
  });

  it('the order is PREFERENCES order, not the input object\'s key order (12 tie / 12 B>A / 6 A>B)', () => {
    // Every other fixture in this file is already written in PREFERENCES order,
    // and so is score.ts's accumulator literal — so an implementation reading
    // `Object.keys(keyCounts)` would pass all of them. This one is deliberately
    // out of order: insertion order would report ['tie', 'B>A'].
    const floor = constantVerdictBaseline({ tie: 12, 'B>A': 12, 'A>B': 6 });
    expect(floor?.preferences).toEqual(['B>A', 'tie']);
    expect(floor?.keyCounts).toEqual({ 'A>B': 6, 'B>A': 12, tie: 12 });
    expect(floor?.accuracy).toBeCloseTo(0.4, 10);
  });

  it('a three-way tie (10/10/10) reports all three at 1/3', () => {
    const floor = constantVerdictBaseline({ 'A>B': 10, 'B>A': 10, tie: 10 });
    expect(floor?.preferences).toEqual(['A>B', 'B>A', 'tie']);
    expect(floor?.accuracy).toBeCloseTo(1 / 3, 10);
  });

  it('when ties are the plurality (5/5/20) the stamp is tie at 20/30 — nothing assumes A>B', () => {
    const floor = constantVerdictBaseline({ 'A>B': 5, 'B>A': 5, tie: 20 });
    expect(floor?.preferences).toEqual(['tie']);
    expect(floor?.accuracy).toBeCloseTo(20 / 30, 10);
  });

  it('a one-class key (30/0/0) floors at 1.0 — the case no judge can beat', () => {
    const floor = constantVerdictBaseline({ 'A>B': 30, 'B>A': 0, tie: 0 });
    expect(floor?.accuracy).toBe(1);
    expect(floor?.preferences).toEqual(['A>B']);
  });

  it('an empty key returns null, not 0 — nothing scored is not a floor of zero', () => {
    expect(constantVerdictBaseline({ 'A>B': 0, 'B>A': 0, tie: 0 })).toBeNull();
  });

  it('a negative count throws — a count is never negative, and clamping would hide the caller bug', () => {
    expect(() => constantVerdictBaseline({ 'A>B': -1, 'B>A': 13, tie: 0 })).toThrow(
      /non-negative integer/
    );
  });

  it('a fractional or missing count throws for the same reason', () => {
    expect(() => constantVerdictBaseline({ 'A>B': 16.5, 'B>A': 13, tie: 0 })).toThrow(
      /non-negative integer/
    );
    expect(() =>
      constantVerdictBaseline({ 'A>B': 17, 'B>A': 13 } as unknown as Record<'A>B' | 'B>A' | 'tie', number>)
    ).toThrow(/non-negative integer/);
  });
});

describe('formatConstantBaselineLines — the two CLI lines, pinned where a test can reach them', () => {
  /** scripts/calibration/** is outside every coverage include (vitest.config.ts:37)
   *  and has no harness, so a template literal built inside run.ts would ship
   *  with no permanent guard. These are the exact strings run.ts prints. */
  it('AT the floor: margin +0.0000 AND the ⚠ — equality is precisely the stamping judge', () => {
    const constantBaseline = constantVerdictBaseline({ 'A>B': 14, 'B>A': 11, tie: 0 });
    const lines = formatConstantBaselineLines({
      accuracy: 14 / 25,
      constantBaseline,
      marginOverConstant: 0,
    });
    expect(lines).toEqual([
      "  constant   0.5600   (a judge stamping 'A>B' on every SCORED item: 14/25)   margin +0.0000",
      '  ⚠ accuracy is at or below the constant floor — on this subset the judge is not distinguishable from a stamp.',
    ]);
  });

  it('ABOVE the floor: one line, a signed + margin, no warning — run 9 as it will actually print', () => {
    const constantBaseline = constantVerdictBaseline({ 'A>B': 14, 'B>A': 11, tie: 0 });
    const lines = formatConstantBaselineLines({
      accuracy: 0.6,
      constantBaseline,
      marginOverConstant: 0.6 - 14 / 25,
    });
    expect(lines).toEqual([
      "  constant   0.5600   (a judge stamping 'A>B' on every SCORED item: 14/25)   margin +0.0400",
    ]);
  });

  it("BELOW the floor: `sign` stays empty, the minus comes from toFixed, and the ⚠ is there — granite4.1:3b's case", () => {
    const constantBaseline = constantVerdictBaseline({ 'A>B': 2, 'B>A': 1, tie: 0 });
    const lines = formatConstantBaselineLines({
      accuracy: 1 / 3,
      constantBaseline,
      marginOverConstant: 1 / 3 - 2 / 3,
    });
    expect(lines).toEqual([
      "  constant   0.6667   (a judge stamping 'A>B' on every SCORED item: 2/3)   margin -0.3333",
      '  ⚠ accuracy is at or below the constant floor — on this subset the judge is not distinguishable from a stamp.',
    ]);
  });

  it('a two-way tie names BOTH classes and counts the FIRST one, so stamped/denominator stays honest', () => {
    const constantBaseline = constantVerdictBaseline({ 'A>B': 12, 'B>A': 12, tie: 6 });
    const lines = formatConstantBaselineLines({
      accuracy: 0.5,
      constantBaseline,
      marginOverConstant: 0.5 - 0.4,
    });
    expect(lines).toEqual([
      "  constant   0.4000   (a judge stamping 'A>B/B>A' on every SCORED item: 12/30)   margin +0.1000",
    ]);
  });

  it('nothing scored → no lines at all, rather than a line reading n/a', () => {
    expect(
      formatConstantBaselineLines({ accuracy: null, constantBaseline: null, marginOverConstant: null })
    ).toEqual([]);
  });
});

describe('calibration/baseline: formatSelectiveAccuracyLines', () => {
  // The rendering lives here and not in scripts/calibration/run.ts for the same
  // reason formatConstantBaselineLines does: that file is outside every
  // coverage include (vitest.config.ts:37) and has no harness, so a template
  // built there ships untested — and the load-bearing parts of these strings
  // are the `<=` that decides the ⚠ and the CHOICE of floor, both of which are
  // silently wrong in exactly the way nothing downstream can detect.

  it('renders the production Qwen3.6 shape exactly, coverage first', () => {
    // cmtozu76f00012l5w4llb4pae, measured 2026-09-06: 619 verdicts, 610
    // committed, 549 correct, committed key 330 'A>B' / 280 'B>A'.
    const selectiveBaseline = constantVerdictBaseline({ 'A>B': 330, 'B>A': 280, tie: 0 });
    const constantBaseline = constantVerdictBaseline({ 'A>B': 336, 'B>A': 283, tie: 0 });
    expect(
      formatSelectiveAccuracyLines({
        verdictCount: 619,
        committedCount: 610,
        abstainedCount: 9,
        committedCorrectCount: 549,
        coverage: 610 / 619,
        selectiveAccuracy: 549 / 610,
        selectiveBaseline,
        selectiveMarginOverConstant: 549 / 610 - 330 / 610,
        constantBaseline,
      })
    ).toEqual([
      "  coverage   0.9855   (610/619 scored items the judge COMMITTED on; 9 abstained with 'tie')",
      "  selective  0.9000   (549/610 right where it COMMITTED)   floor 0.5410 ('A>B': 330/610)   margin +0.3590",
    ]);
  });

  it('warns when selective accuracy is AT OR BELOW the floor over the committed subset', () => {
    // Constructed, not measured: no completed production run is at or below its
    // own committed floor (Qwen3.6 +0.3590, lfm2.5-thinking +0.0071, lfm2.5:8b
    // +0.0194). The branch still has to exist and be pinned, because the judge
    // it exists for — one that stamps whenever it does commit — is exactly the
    // judge a coverage metric would otherwise flatter.
    const selectiveBaseline = constantVerdictBaseline({ 'A>B': 2, 'B>A': 1, tie: 0 });
    const constantBaseline = constantVerdictBaseline({ 'A>B': 5, 'B>A': 1, tie: 0 });
    expect(
      formatSelectiveAccuracyLines({
        verdictCount: 6,
        committedCount: 3,
        abstainedCount: 3,
        committedCorrectCount: 1,
        coverage: 0.5,
        selectiveAccuracy: 1 / 3,
        selectiveBaseline,
        selectiveMarginOverConstant: 1 / 3 - 2 / 3,
        constantBaseline,
      })
    ).toEqual([
      "  coverage   0.5000   (3/6 scored items the judge COMMITTED on; 3 abstained with 'tie')",
      "  selective  0.3333   (1/3 right where it COMMITTED)   floor 0.6667 ('A>B': 2/3)   margin -0.3333",
      '  ⚠ selective accuracy is at or below the floor OVER THE COMMITTED SUBSET — where it answers, the judge is not distinguishable from a stamp.',
    ]);
  });

  it('prints the COMMITTED floor, never the full-subset one, when the two name different classes', () => {
    // Fixture S3. Feeding the full-subset floor here renders "'A>B': 6/10"
    // instead of "'B>A': 4/7" — a wrong number under a wrong label, on the line
    // a reader uses to decide whether a judge beat a stamp.
    const lines = formatSelectiveAccuracyLines({
      verdictCount: 10,
      committedCount: 7,
      abstainedCount: 3,
      committedCorrectCount: 5,
      coverage: 0.7,
      selectiveAccuracy: 5 / 7,
      selectiveBaseline: constantVerdictBaseline({ 'A>B': 3, 'B>A': 4, tie: 0 }),
      selectiveMarginOverConstant: 5 / 7 - 4 / 7,
      constantBaseline: constantVerdictBaseline({ 'A>B': 6, 'B>A': 4, tie: 0 }),
    });
    expect(lines[1]).toContain("floor 0.5714 ('B>A': 4/7)");
    expect(lines[1]).not.toContain('A>B');
    expect(lines[1]).not.toContain('0.6000');
  });

  it('zero coverage prints the coverage line and says UNDEFINED — never a selective number', () => {
    expect(
      formatSelectiveAccuracyLines({
        verdictCount: 3,
        committedCount: 0,
        abstainedCount: 3,
        committedCorrectCount: 0,
        coverage: 0,
        selectiveAccuracy: null,
        selectiveBaseline: null,
        selectiveMarginOverConstant: null,
        constantBaseline: constantVerdictBaseline({ 'A>B': 3, 'B>A': 0, tie: 0 }),
      })
    ).toEqual([
      "  coverage   0.0000   (0/3 scored items the judge COMMITTED on; 3 abstained with 'tie')",
      '  ⚠ the judge committed on NOTHING (0/3) — selective accuracy is UNDEFINED, not 0 and not 1.',
    ]);
  });

  it('the UNDEFINED line reports the REAL committedCount, not a hardcoded 0', () => {
    // The parameter is a structural literal by design (baseline.ts documents
    // that in three places), so `selectiveAccuracy: null` with a NON-zero
    // committedCount is a reachable shape even though score.ts never builds
    // one — it makes the three selective fields null together. A `0` baked
    // into the warning string prints a count this row does not have, which is
    // the one number a reader would use to check the claim. This pins the
    // count against the argument rather than against the sentence.
    const lines = formatSelectiveAccuracyLines({
      verdictCount: 10,
      committedCount: 5,
      abstainedCount: 5,
      committedCorrectCount: 0,
      coverage: 0.5,
      selectiveAccuracy: null,
      selectiveBaseline: null,
      selectiveMarginOverConstant: null,
      constantBaseline: null,
    });
    expect(lines).toEqual([
      "  coverage   0.5000   (5/10 scored items the judge COMMITTED on; 5 abstained with 'tie')",
      '  ⚠ the judge committed on NOTHING (5/10) — selective accuracy is UNDEFINED, not 0 and not 1.',
    ]);
    expect(lines[1]).not.toContain('(0/10)');
  });

  it('nothing scored → no lines at all, rather than a line reading n/a', () => {
    // Same contract as formatConstantBaselineLines: a line reading n/a suggests
    // a number exists and could not be rendered.
    expect(
      formatSelectiveAccuracyLines({
        verdictCount: 0,
        committedCount: 0,
        abstainedCount: 0,
        committedCorrectCount: 0,
        coverage: null,
        selectiveAccuracy: null,
        selectiveBaseline: null,
        selectiveMarginOverConstant: null,
        constantBaseline: null,
      })
    ).toEqual([]);
  });

  it('a key that CONTAINS ties says so — on such a set these two lines do not measure abstention', () => {
    // The whole framing "a tie is an abstention" is a property of a FORCED-
    // CHOICE key. GoldenSet cmt057h5d00097y01ymubpre5 is 336/284/0 and
    // cmt057hd001g17y01lhjzgfuj is 17/13/0, so this branch is unreachable on
    // today's corpus — and it is reachable through the API, which is precisely
    // when a reader would be most likely to quote the number wrongly.
    const lines = formatSelectiveAccuracyLines({
      verdictCount: 30,
      committedCount: 27,
      abstainedCount: 3,
      committedCorrectCount: 20,
      coverage: 0.9,
      selectiveAccuracy: 20 / 27,
      selectiveBaseline: constantVerdictBaseline({ 'A>B': 14, 'B>A': 10, tie: 3 }),
      selectiveMarginOverConstant: 20 / 27 - 14 / 27,
      constantBaseline: constantVerdictBaseline({ 'A>B': 17, 'B>A': 10, tie: 3 }),
    });
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe(
      "  ⓘ this answer key CONTAINS ties (3 of 30 scored items), so a 'tie' verdict is a real ANSWER here, " +
        'not an abstention — the two lines above do not measure abstention on this set.'
    );
  });
});

describe('calibration/baseline: formatNoVerdictRateLine', () => {
  // A SEPARATE formatter, and a separate line in the report, deliberately not
  // folded into the coverage block. Coverage is what the JUDGE did; this is
  // what the FLEET did. Measured over the four completed runs on the 620-item
  // set (n = 2,480 item-rows): judge-behaviour refusals 0, prose-not-JSON 0,
  // token-budget truncations 18, infrastructure 0 — so every one of these is a
  // truncation or a dead request, and a reader who sees it under a coverage
  // heading will read it as the judge declining.

  it('N1 — the lfm2.5:8b shape renders exactly, and says FLEET, not abstention', () => {
    expect(
      formatNoVerdictRateLine({ noVerdictRate: 17 / 620, missingVerdicts: 17, dispatchedItemCount: 620 })
    ).toEqual([
      '  no verdict 0.0274   17 of 620 asked items produced none — FLEET property (truncation/dead request), NOT abstention',
    ]);
  });

  it('N3 — a rate of 0 is PRINTED, because "nothing was lost" is a measurement', () => {
    // The tempting suppression: hide the line when there is nothing to report.
    // A silent line and a line reading 0.0000 are different claims, and only
    // the second one says the denominator was checked.
    expect(
      formatNoVerdictRateLine({ noVerdictRate: 0, missingVerdicts: 0, dispatchedItemCount: 620 })
    ).toEqual([
      '  no verdict 0.0000   0 of 620 asked items produced none — FLEET property (truncation/dead request), NOT abstention',
    ]);
  });

  it('N4 — nothing dispatched → no line at all, rather than 0.0000 or NaN', () => {
    expect(
      formatNoVerdictRateLine({ noVerdictRate: null, missingVerdicts: 0, dispatchedItemCount: 0 })
    ).toEqual([]);
  });

  it('the empty return is keyed on the NULL RATE, not on a zero denominator', () => {
    // The parameter is a structural literal (same reason as the two formatters
    // above: score.ts imports this module), so TypeScript narrows each field
    // independently and this shape is constructible. An implementation that
    // returned [] on `dispatchedItemCount === 0` passes N4 and renders `NaN`
    // or `null` here — which is exactly the "a NULL is not a 0.0000" contract.
    expect(
      formatNoVerdictRateLine({ noVerdictRate: null, missingVerdicts: 3, dispatchedItemCount: 620 })
    ).toEqual([]);
  });
});

describe('calibration/baseline: the CLI actually prints the coverage block', () => {
  //   what it catches  — the block being deleted, renamed, computed and never
  //                      printed, or called with the wrong argument
  //   what it does NOT — where in the report the block appears, and anything
  //                      at all about whether the script RUNS
  const RUN_TS = readFileSync(new URL('../../scripts/calibration/run.ts', import.meta.url), 'utf8');

  it('imports formatSelectiveAccuracyLines and prints every line it returns', () => {
    // A bare substring count cannot tell `formatSelectiveAccuracyLines` from a
    // renamed `formatSelectiveAccuracyLinesV2` (failure mode 3), so the `(` is
    // part of the pattern.
    // NOT `toContain("from '@/lib/calibration/baseline'")` — that substring is
    // already in run.ts:60 at 2e7e142, so it is green before, during and after
    // this edit and guards nothing. Pin the SYMBOL into the import instead: this
    // regex is FALSE before Edit 8a and true after.
    expect(RUN_TS).toMatch(
      /import \{ formatConstantBaselineLines, formatSelectiveAccuracyLines, formatNoVerdictRateLine \} from '@\/lib\/calibration\/baseline';/
    );
    expect(RUN_TS.match(/formatSelectiveAccuracyLines\(/g)).toHaveLength(1);
    expect(RUN_TS).toMatch(
      /for \(const line of formatSelectiveAccuracyLines\(score\)\) console\.log\(line\);/
    );
    // And the scoring-version line, which is the other half of this commit.
    expect(RUN_TS).toContain("from '@/lib/calibration/scoring-version'");
    expect(RUN_TS).toContain('describeScoringVersion(SCORING_RULES_VERSION)');
  });

  it('prints the no-verdict line too, and prints it OUTSIDE the coverage block', () => {
    // Same computed-and-discarded guard as above. The SEPARATION is the other
    // half: rendering the fleet's losses inside the coverage block is the
    // conflation this formatter exists to avoid, so the line is emitted by its
    // own call rather than appended to formatSelectiveAccuracyLines' output.
    expect(RUN_TS.match(/formatNoVerdictRateLine\(/g)).toHaveLength(1);
    expect(RUN_TS).toMatch(
      /for \(const line of formatNoVerdictRateLine\(score\)\) console\.log\(line\);/
    );
  });
});
