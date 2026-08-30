import { describe, expect, it } from 'vitest';
import { agreement } from '@/lib/agreement';
import {
  CalibrationReadingsError,
  GROUND_TRUTH_RATER_ID,
  groundTruthReadings,
  preferenceFromVerdict,
  type CalibrationVerdictRow,
} from '@/lib/calibration/readings';

/**
 * A2.1 — THE MAPPING TEST. This file exists for one reason: a sign error in
 * `preferenceFromVerdict` inverts the entire leaderboard and produces NO
 * symptom. Every downstream number stays in range, the confusion matrix stays
 * square, accuracy stays a plausible 0.4-ish, and the only visible effect is
 * that the best judge ranks worst. So the truth table is asserted arm by arm
 * rather than round-tripped, and each arm is spelled out in full.
 *
 * The table is fixed by golden-sets.ts: `label` on a GoldenCandidate is null
 * because POSITION IS THE IDENTITY (0 = A, 1 = B), and `pairOrder` on the
 * judgment records which order those two positions were SHOWN in. So under
 * 'BA' the model's "A" is candidate position 1, i.e. B — the verdict letter
 * refers to the slot on the screen, never to the stored candidate.
 */
describe('preferenceFromVerdict — the whole truth table, arm by arm', () => {
  it("verdict 'A' shown in order AB means the model preferred candidate 0: A>B", () => {
    expect(preferenceFromVerdict('A', 'AB')).toBe('A>B');
  });

  it("verdict 'B' shown in order AB means the model preferred candidate 1: B>A", () => {
    expect(preferenceFromVerdict('B', 'AB')).toBe('B>A');
  });

  it("verdict 'A' shown in order BA is the SWAPPED slot — candidate 1 — so B>A", () => {
    // The arm a naive implementation gets wrong. Under 'BA' the first slot on
    // the screen holds candidate position 1, so "A is better" is a vote for
    // the stored B. Reading the letter literally here is the leaderboard
    // inversion this module is built to prevent.
    expect(preferenceFromVerdict('A', 'BA')).toBe('B>A');
  });

  it("verdict 'B' shown in order BA is the SWAPPED slot — candidate 0 — so A>B", () => {
    expect(preferenceFromVerdict('B', 'BA')).toBe('A>B');
  });

  it('a tie is order-invariant, because there is no slot to swap', () => {
    expect(preferenceFromVerdict('tie', 'AB')).toBe('tie');
    expect(preferenceFromVerdict('tie', 'BA')).toBe('tie');
  });

  it('the two orders are exact mirrors of each other on the non-tie arms', () => {
    // A property that catches a half-applied swap: an implementation that
    // flips only one of the two letters passes two of the four arms above.
    expect(preferenceFromVerdict('A', 'AB')).toBe(preferenceFromVerdict('B', 'BA'));
    expect(preferenceFromVerdict('B', 'AB')).toBe(preferenceFromVerdict('A', 'BA'));
    expect(preferenceFromVerdict('A', 'AB')).not.toBe(preferenceFromVerdict('B', 'AB'));
  });

  it('an unrecognised verdict throws rather than defaulting to a preference', () => {
    // Unreachable through the type system; reachable from a DB column typed
    // `String?`. Falling through to 'tie' would file a corrupt row as a
    // deliberate no-preference, which counts as a MISS and silently drags a
    // judge's accuracy down for a reason nothing records.
    expect(() => preferenceFromVerdict('maybe' as 'A', 'AB')).toThrow(CalibrationReadingsError);
  });
});

/** One well-formed row, so each test below varies exactly one thing. */
function row(over: Partial<CalibrationVerdictRow> = {}): CalibrationVerdictRow {
  return {
    itemId: 'item-1',
    expected: 'A>B',
    raterId: 'judge-v1',
    verdict: 'A',
    pairOrder: 'AB',
    ...over,
  };
}

describe('groundTruthReadings — ground truth is a rater, exactly once per item', () => {
  it('emits a PAIR per item: the answer key and the derived preference', () => {
    const out = groundTruthReadings([
      row({ itemId: 'i1', expected: 'A>B', verdict: 'A', pairOrder: 'AB' }),
      row({ itemId: 'i2', expected: 'B>A', verdict: 'A', pairOrder: 'BA' }),
    ]);

    expect(out.readings).toEqual([
      { itemId: 'i1', raterId: GROUND_TRUTH_RATER_ID, category: 'A>B' },
      { itemId: 'i1', raterId: 'judge-v1', category: 'A>B' },
      { itemId: 'i2', raterId: GROUND_TRUTH_RATER_ID, category: 'B>A' },
      { itemId: 'i2', raterId: 'judge-v1', category: 'B>A' },
    ]);
    expect(out.itemCount).toBe(2);
    expect(out.modelCount).toBe(1);
    expect(out.missingVerdicts).toBe(0);
  });

  it('the synthetic rater id is the same trick label-readings uses for rounds', () => {
    // testRetestReadings passes 'round-1'/'round-2' as raterIds — synthetic
    // labels for a thing that is not a person. 'ground-truth' is the same
    // move. It must be a CONSTANT, not a literal retyped at each call site,
    // because a typo produces a THIRD rater and silently switches the whole
    // statistic from Cohen to Fleiss.
    expect(GROUND_TRUTH_RATER_ID).toBe('ground-truth');
    const out = groundTruthReadings([row()]);
    expect(agreement(out.readings).statistic).toBe('cohen');
    expect(agreement(out.readings).annotatorCount).toBe(2);
  });

  it('a judge that produced no verdict yields NO readings, and is counted', () => {
    // Neither reading, never one. A lone ground-truth reading would be
    // dropped by agreement()'s overlap filter anyway, but it would make
    // itemCount disagree with the overlap the kappa is actually computed
    // over — two numbers for one thing, differing only when something failed.
    const out = groundTruthReadings([
      row({ itemId: 'i1' }),
      row({ itemId: 'i2', verdict: null, pairOrder: 'AB' }),
    ]);
    expect(out.readings.map((r) => r.itemId)).toEqual(['i1', 'i1']);
    expect(out.itemCount).toBe(1);
    expect(out.missingVerdicts).toBe(1);
    expect(agreement(out.readings).itemCount).toBe(out.itemCount);
  });

  it('a failed judge is still a judge: missing verdicts do not hide a second rater', () => {
    // modelCount is collected BEFORE the missing-verdict skip. A second judge
    // that errored on every item is exactly the case where a silent merge
    // would be hardest to notice later.
    expect(() =>
      groundTruthReadings([
        row({ itemId: 'i1', raterId: 'judge-a' }),
        row({ itemId: 'i2', raterId: 'judge-b', verdict: null }),
      ])
    ).toThrow(/more than one model rater/i);
  });
});

/**
 * THE TWO GUARDS. Both are aimed at phase 2's both-orders sweep, which adds a
 * SECOND ModelJudgment per run — same run, same judge, pairOrder 'BA'. Fed
 * naively into this function that becomes two readings for one (item, rater),
 * and Cohen's matrix builder takes `readings.find(...)` — the FIRST match —
 * so the second order would be silently discarded and the reported kappa
 * would describe an AB-only sweep while claiming to cover both. There is no
 * assertion downstream that could catch that. Throwing here is the catch.
 */
describe('groundTruthReadings — the guards, which are phase-2 landmines today', () => {
  it('throws on two model raters, because that is a Fleiss run wearing a Cohen label', () => {
    const err = (() => {
      try {
        groundTruthReadings([row({ raterId: 'judge-a' }), row({ itemId: 'i2', raterId: 'judge-b' })]);
        return null;
      } catch (e) {
        return e as CalibrationReadingsError;
      }
    })();
    expect(err).toBeInstanceOf(CalibrationReadingsError);
    expect(err!.code).toBe('multiple-model-raters');
    // The message must name both, or the operator cannot tell which run leaked.
    expect(err!.message).toContain('judge-a');
    expect(err!.message).toContain('judge-b');
  });

  it('throws on two readings for the same (itemId, raterId) — the BA sweep shape', () => {
    const err = (() => {
      try {
        groundTruthReadings([
          row({ itemId: 'i1', verdict: 'A', pairOrder: 'AB' }),
          row({ itemId: 'i1', verdict: 'B', pairOrder: 'BA' }),
        ]);
        return null;
      } catch (e) {
        return e as CalibrationReadingsError;
      }
    })();
    expect(err).toBeInstanceOf(CalibrationReadingsError);
    expect(err!.code).toBe('duplicate-reading');
    expect(err!.message).toContain('i1');
  });

  it('throws even when the duplicate pair AGREES — the count is what is wrong', () => {
    // Two identical readings do not change the confusion matrix, so a
    // "compare the categories first" guard would let this through and only
    // fire on the disagreeing half of a real sweep. The invariant is one
    // reading per (item, rater), not one VALUE per (item, rater).
    expect(() =>
      groundTruthReadings([
        row({ itemId: 'i1', verdict: 'A', pairOrder: 'AB' }),
        row({ itemId: 'i1', verdict: 'B', pairOrder: 'BA' }),
      ])
    ).toThrow(CalibrationReadingsError);
  });

  it('throws when a model calls itself ground-truth, which would erase the answer key', () => {
    // Not a hypothetical rater name: this is what happens if a caller passes
    // the ground-truth reading list back in. One reading per (item, rater)
    // catches it, and the alternative is a kappa of 1 for every judge.
    expect(() => groundTruthReadings([row({ raterId: GROUND_TRUTH_RATER_ID })])).toThrow(
      CalibrationReadingsError
    );
  });

  it('throws on an item with no answer key rather than scoring it as a miss', () => {
    // GoldenItem.expected is null for every POINTWISE import (golden-sets.ts:
    // "such a set is not calibration-ready"). Treating that as a miss would
    // report a judge as wrong for a question that has no right answer, and
    // the number would look entirely normal.
    const err = (() => {
      try {
        groundTruthReadings([row({ itemId: 'no-key', expected: null })]);
        return null;
      } catch (e) {
        return e as CalibrationReadingsError;
      }
    })();
    expect(err!.code).toBe('missing-ground-truth');
    expect(err!.message).toContain('no-key');
  });

  it('throws on an answer key that is not a preference at all — the LISTWISE hole', () => {
    // The null guard above catches a POINTWISE set (expected = null). A
    // LISTWISE set is the other wrong-protocol case and it does NOT look
    // broken: golden-sets.ts maps it to a ranking string, expected = '0,1'.
    // Left unchecked, every verdict misses it, so the calibration reports
    // accuracy 0.0 for a perfectly good judge and the number is entirely
    // plausible. Guarding only the null half would advertise a protocol check
    // that is not there.
    const err = (() => {
      try {
        groundTruthReadings([row({ itemId: 'listwise-item', expected: '0,1' })]);
        return null;
      } catch (e) {
        return e as CalibrationReadingsError;
      }
    })();
    expect(err).toBeInstanceOf(CalibrationReadingsError);
    expect(err!.code).toBe('unrecognised-ground-truth');
    expect(err!.message).toContain('0,1');
  });

  it('throws on a verdict with no pairOrder, because the mapping has no input', () => {
    // pairOrder is NULL on every pointwise judgment (run-launch.ts writes it
    // explicitly). A verdict without one cannot be resolved to a preference,
    // and assuming 'AB' would be a coin flip recorded as a measurement.
    const err = (() => {
      try {
        groundTruthReadings([row({ verdict: 'B', pairOrder: null })]);
        return null;
      } catch (e) {
        return e as CalibrationReadingsError;
      }
    })();
    expect(err!.code).toBe('missing-pair-order');
  });

  it('an empty input is not an error — it is a calibration with nothing in it yet', () => {
    expect(groundTruthReadings([])).toEqual({
      readings: [],
      itemCount: 0,
      modelCount: 0,
      missingVerdicts: 0,
    });
  });
});
