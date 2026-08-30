import { describe, expect, it } from 'vitest';
import { agreement, type Reading } from '@/lib/agreement';

/** A two-rater, two-category fixture with the arithmetic worked out by hand,
 *  so this test is an ORACLE rather than a snapshot of our own output:
 *
 *    n = 50: 20 (yes,yes), 5 (yes,no), 10 (no,yes), 15 (no,no)
 *    p0 = (20 + 15) / 50                     = 0.70
 *    A: yes 25/50 = 0.5, no 25/50 = 0.5
 *    B: yes 30/50 = 0.6, no 20/50 = 0.4
 *    pe = (0.5 x 0.6) + (0.5 x 0.4)          = 0.50
 *    kappa = (0.70 - 0.50) / (1 - 0.50)      = 0.40   <- exactly
 *
 *  Built as explicit readings so the input is the shape production uses. */
function cohenFixture(): Reading[] {
  const out: Reading[] = [];
  const push = (n: number, x: string, y: string) => {
    for (let i = 0; i < n; i++) {
      const itemId = `i${out.length}`;
      out.push({ itemId, raterId: 'A', category: x }, { itemId, raterId: 'B', category: y });
    }
  };
  push(20, 'yes', 'yes');
  push(5, 'yes', 'no');
  push(10, 'no', 'yes');
  push(15, 'no', 'no');
  return out;
}

describe('agreement — Cohen', () => {
  it('reproduces the textbook unweighted kappa to 4dp', () => {
    const r = agreement(cohenFixture(), { weighting: 'none' });
    expect(r.statistic).toBe('cohen');
    expect(r.annotatorCount).toBe(2);
    expect(r.itemCount).toBe(50);
    expect(r.value).toBeCloseTo(0.4, 4);
  });

  it('perfect agreement is 1, and the method still travels with it', () => {
    const readings: Reading[] = [
      { itemId: 'a', raterId: 'A', category: '5' },
      { itemId: 'a', raterId: 'B', category: '5' },
      { itemId: 'b', raterId: 'A', category: '1' },
      { itemId: 'b', raterId: 'B', category: '1' },
    ];
    const r = agreement(readings, { weighting: 'none' });
    expect(r.value).toBe(1);
    expect(r.categories).toEqual(['1', '5']);
  });
});

/**
 * VALUE DISTANCE vs RANK DISTANCE — the property, and why the fixture looks
 * like this.
 *
 * These two fixtures share the category set {1, 2, 5}, which is UNEVENLY
 * SPACED on purpose. That is the only shape in which the two candidate
 * implementations disagree at all:
 *
 *   - by VALUE, 2-vs-5 is 3 of the 4 available steps  -> w = 0.25
 *   - by RANK,  2-vs-5 is 1 of the 2 available steps  -> w = 0.50
 *
 * On an evenly spaced set — or on any two-category set — value and rank
 * normalise to exactly the same weights, and no assertion over them can tell
 * the implementations apart.
 *
 * THIS IS A CORRECTION TO THE PLAN, recorded rather than quietly fixed. The
 * plan's fixture compared a {1,5} call against a separate {4,5} call and
 * asserted `near > far`. Because `range` is derived per call from that call's
 * OWN observed categories, the single disagreement is the full range in both
 * — w = 0 either way — so both kappas are exactly 0 and the assertion
 * `0 > 0` can never pass, under any implementation. Worked by hand before
 * writing a line of the module, which is the only reason it was caught
 * before it became a green-looking mystery.
 *
 * Both fixtures below are pinned to an exact hand-worked value rather than to
 * each other, so each one alone falsifies a rank implementation.
 */
function spacedFixture(disagreement: '1v5' | '2v5'): Reading[] {
  const pairs: Array<[string, string]> = [
    ['1', '1'],
    ['2', '2'],
    ['5', '5'],
    disagreement === '1v5' ? ['1', '5'] : ['2', '5'],
  ];
  return pairs.flatMap(([a, b], i) => [
    { itemId: `i${i}`, raterId: 'A', category: a },
    { itemId: `i${i}`, raterId: 'B', category: b },
  ]);
}

describe('agreement — weighting is on VALUE distance, not rank', () => {
  /*  categories {1,2,5}, range = 5 - 1 = 4, linear w = 1 - |a-b|/4
   *  w(1,1)=1  w(1,2)=0.75  w(1,5)=0
   *  w(2,1)=0.75  w(2,2)=1  w(2,5)=0.25
   *  w(5,1)=0  w(5,2)=0.25  w(5,5)=1
   *
   *  Items: (1,1) (2,2) (5,5) (2,5), each 1/4 of n.
   *  po = 0.25(1) + 0.25(1) + 0.25(1) + 0.25(0.25)          = 0.8125
   *  A marginals: 1 -> 0.25, 2 -> 0.50, 5 -> 0.25
   *  B marginals: 1 -> 0.25, 2 -> 0.25, 5 -> 0.50
   *  pe = SUM pA_i pB_j w_ij                                 = 0.53125
   *  kappa = (0.8125 - 0.53125) / (1 - 0.53125)
   *        = 0.28125 / 0.46875                               = 0.60  exactly
   *
   *  Under RANK distance the same fixture gives 0.7142857 — w(2,5) becomes
   *  0.5, so po = 0.875 and pe = 0.5625. That is the number this assertion
   *  refuses. */
  it('a 3-of-4-steps disagreement gives the hand-worked 0.60, not rank distance 0.7143', () => {
    const r = agreement(spacedFixture('2v5'), { weighting: 'linear' });
    expect(r.statistic).toBe('cohen');
    expect(r.weighting).toBe('linear');
    expect(r.categories).toEqual(['1', '2', '5']);
    expect(r.value).toBeCloseTo(0.6, 4);
  });

  /*  Same category set, the disagreement moved to 1-vs-5 (the full range).
   *  w(1,5) = 0, so po = 0.75; marginals shift to A{1:0.5, 2:0.25, 5:0.25},
   *  B{1:0.25, 2:0.25, 5:0.5}, giving pe = 0.5 and
   *  kappa = (0.75 - 0.5) / (1 - 0.5) = 0.50 exactly.
   *  Rank distance would give 0.5294118 here. */
  it('widening the SAME disagreement to the full range lowers kappa to 0.50', () => {
    const r = agreement(spacedFixture('1v5'), { weighting: 'linear' });
    expect(r.value).toBeCloseTo(0.5, 4);
  });

  it('and therefore the nearer disagreement scores higher than the wider one', () => {
    // The plan's original intent, kept — but over one shared category set, so
    // the two numbers are actually comparable.
    const near = agreement(spacedFixture('2v5'), { weighting: 'linear' });
    const far = agreement(spacedFixture('1v5'), { weighting: 'linear' });
    expect(near.value!).toBeGreaterThan(far.value!);
  });

  it('non-numeric categories cannot carry a distance, so weighting is reported as none', () => {
    // A preference is 'A>B' | 'B>A' | 'tie'. Calling 'A>B'-vs-'tie' closer
    // than 'A>B'-vs-'B>A' is a claim about the domain, not a given — so a
    // requested weighting is DOWNGRADED and SAID SO, never silently applied
    // to a scale that does not exist.
    const r = agreement(
      [
        { itemId: 'a', raterId: 'A', category: 'A>B' },
        { itemId: 'a', raterId: 'B', category: 'tie' },
        { itemId: 'b', raterId: 'A', category: 'B>A' },
        { itemId: 'b', raterId: 'B', category: 'B>A' },
      ],
      { weighting: 'quadratic' }
    );
    expect(r.weighting).toBe('none');
    expect(r.categories).toEqual(['A>B', 'B>A', 'tie']);
  });
});

describe('agreement — insufficiency is not a number', () => {
  it('ONE annotator returns null with a reason, never 0', () => {
    // 0 would read as TOTAL DISAGREEMENT, the opposite of "not measurable".
    // This is the normal case at launch: one account means one annotator.
    const r = agreement([{ itemId: 'a', raterId: 'A', category: '3' }]);
    expect(r.value).toBeNull();
    expect(r.reason).toBe('insufficient-annotators');
    expect(r.annotatorCount).toBe(1);
  });

  it('two annotators who never overlap return insufficient-overlap', () => {
    const r = agreement([
      { itemId: 'a', raterId: 'A', category: '3' },
      { itemId: 'b', raterId: 'B', category: '4' },
    ]);
    expect(r.value).toBeNull();
    expect(r.reason).toBe('insufficient-overlap');
    expect(r.itemCount).toBe(0);
  });

  it('overlap counts DISTINCT ANNOTATORS, not readings — one rater twice is not overlap', () => {
    // A blind re-read gives an item two readings from ONE person. Counting
    // that as overlap inflates the denominator the UI shows, and — because
    // Cohen's matrix builder assumes both raters rated every overlap item —
    // it also puts an item in the matrix that the second rater never saw.
    // The first version of this module used `bucket.length >= 2` and would
    // have dereferenced an undefined reading here.
    const r = agreement([
      { itemId: 'solo', raterId: 'A', category: '4' }, // round 1
      { itemId: 'solo', raterId: 'A', category: '5' }, // round 2, same person
      { itemId: 'shared', raterId: 'A', category: '4' },
      { itemId: 'shared', raterId: 'B', category: '4' },
    ]);
    expect(r.itemCount).toBe(1);
    expect(r.value).not.toBeNull();
  });

  it('an insufficient result still carries the method fields it CAN report', () => {
    // The UI shows "why not" beside "over what". A null with an empty method
    // block reads as a crash.
    const r = agreement([{ itemId: 'a', raterId: 'A', category: '3' }]);
    expect(r.annotatorCount).toBe(1);
    expect(r.itemCount).toBe(0);
    expect(r.categories).toEqual(['3']);
    expect(r.statistic).toBe('cohen');
  });
});

describe('agreement — Fleiss', () => {
  it('THREE annotators switch to Fleiss and report weighting: none', () => {
    // Fleiss has no standard weighted form. Reporting 'none' is the honest
    // record; silently applying weights would make the number incomparable
    // to a weighted two-annotator figure while looking identical.
    const readings: Reading[] = [];
    for (const itemId of ['a', 'b', 'c']) {
      for (const raterId of ['A', 'B', 'C']) readings.push({ itemId, raterId, category: '4' });
    }
    const r = agreement(readings, { weighting: 'quadratic' });
    expect(r.statistic).toBe('fleiss');
    expect(r.weighting).toBe('none');
    // NOTE: this is the DEGENERATE case the textbook formula leaves
    // undefined — one observed category makes Pe = 1, so kappa is 0/0. See
    // the module doc: complete agreement reports 1 rather than NaN, because
    // NaN serialises to `null` in JSON and would be indistinguishable from
    // the insufficiency case two describes up.
    expect(r.value).toBe(1);
  });

  /*  Fleiss ORACLE — the worked example from Fleiss (1971) as reproduced in
   *  every textbook treatment, reduced to a hand-checkable size.
   *
   *  4 items, 3 raters, categories {1, 2}:
   *    item a: 3x'1'          -> SUM n_ij^2 = 9;  P_a = (9 - 3) / (3*2) = 1
   *    item b: 2x'1', 1x'2'   -> SUM = 4 + 1 = 5; P_b = (5 - 3) / 6 = 1/3
   *    item c: 1x'1', 2x'2'   -> SUM = 1 + 4 = 5; P_c = 1/3
   *    item d: 3x'2'          -> SUM = 9;         P_d = 1
   *    Pbar = (1 + 1/3 + 1/3 + 1) / 4 = (8/3) / 4 = 2/3
   *
   *  Category marginals over all 12 ratings: '1' = 6, '2' = 6 -> p = 0.5 each
   *    Pe = 0.5^2 + 0.5^2 = 0.5
   *    kappa = (2/3 - 1/2) / (1 - 1/2) = (1/6) / (1/2) = 1/3   <- exactly */
  it('reproduces a hand-worked Fleiss kappa of 1/3 over 4 items and 3 raters', () => {
    const layout: Record<string, string[]> = {
      a: ['1', '1', '1'],
      b: ['1', '1', '2'],
      c: ['1', '2', '2'],
      d: ['2', '2', '2'],
    };
    const readings: Reading[] = Object.entries(layout).flatMap(([itemId, cats]) =>
      cats.map((category, i) => ({ itemId, raterId: `R${i}`, category }))
    );
    const r = agreement(readings);
    expect(r.statistic).toBe('fleiss');
    expect(r.annotatorCount).toBe(3);
    expect(r.itemCount).toBe(4);
    expect(r.value).toBeCloseTo(1 / 3, 4);
  });
});

/**
 * A2.1 — THE DEGENERATE COHEN PATH, which is NOT the degenerate Fleiss path
 * already covered above.
 *
 * Both reach `pe = 1`. They reach it by different arithmetic, and only one of
 * them lands on the number the guard in `chanceCorrect` tests for:
 *
 *   - FLEISS builds pe from `categoryTotals[c] / ratingTotal` — two exact
 *     integers — so a single observed category gives pe === 1 EXACTLY, the
 *     `1 - pe === 0` guard fires, and the Fleiss test above passes.
 *   - COHEN builds pe by ACCUMULATING `1/n` into its marginals. Thirty
 *     additions of 1/30 sum to 0.9999999999999999, not 1. So pe is
 *     0.9999999999999998, `1 - pe` is 2.22e-16, the guard does NOT fire, and
 *     the quotient reduces to S/(1 + S) — which is 0.5 for every n whose
 *     reciprocal does not sum exactly.
 *
 * 0.5 IS THE WORST POSSIBLE FAILURE SHAPE. It is not NaN, not null, not out
 * of range, and nothing downstream can distinguish it from a real 0.5: a
 * judge that agreed with the answer key on all thirty items would be filed
 * under "moderate agreement". That is the confidently-wrong number this whole
 * module exists to refuse.
 *
 * n = 30 is the calibration set size, so this is a live path rather than a
 * hypothetical — and a 3- or 4-item hand fixture would never have found it,
 * because those n DO sum exactly and return 1.
 */
describe('agreement — a single observed category through COHEN', () => {
  function unanimous(n: number, category: string): Reading[] {
    const readings: Reading[] = [];
    for (let i = 0; i < n; i++) {
      readings.push(
        { itemId: `i${i}`, raterId: 'ground-truth', category },
        { itemId: `i${i}`, raterId: 'model', category }
      );
    }
    return readings;
  }

  it('thirty items, one category, two raters is 1 — not the float artifact 0.5', () => {
    const r = agreement(unanimous(30, 'A>B'));
    expect(r.statistic).toBe('cohen');
    expect(r.annotatorCount).toBe(2);
    expect(r.itemCount).toBe(30);
    expect(r.categories).toEqual(['A>B']);
    expect(r.value).toBe(1);
  });

  it('and NO set size from 2 to 200 produces a NaN or a kappa above 1', () => {
    // The failure is a property of whether 1/n sums exactly, which is a
    // property of n's binary expansion — 3 and 4 are fine, 30 is not. Pinning
    // one n would leave the next set size unpinned, so this sweeps.
    for (let n = 2; n <= 200; n++) {
      const value = agreement(unanimous(n, 'B>A')).value;
      expect(Number.isNaN(value)).toBe(false);
      expect(value).toBe(1);
    }
  });
});
