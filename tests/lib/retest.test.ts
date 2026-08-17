import { describe, expect, it } from 'vitest';
import { retestEligibility } from '@/lib/retest';
import { selectNext, type QueueCandidate } from '@/lib/labelling-queue';

describe('retestEligibility', () => {
  it('is not eligible at K-1 and IS at K — the boundary, not "eventually"', () => {
    const at = (n: number) =>
      retestEligibility({
        intervalItems: 20,
        labelledSinceRound1: n,
        hasRound1: true,
        hasRound2: false,
      });
    expect(at(19)).toEqual({ eligible: false, labelsUntilEligible: 1 });
    expect(at(20)).toEqual({ eligible: true });
  });

  it('is never eligible without a first reading', () => {
    expect(
      retestEligibility({
        intervalItems: 0,
        labelledSinceRound1: 99,
        hasRound1: false,
        hasRound2: false,
      })
    ).toEqual({ eligible: false, labelsUntilEligible: 0 });
  });

  it('is never eligible once a second reading exists', () => {
    expect(
      retestEligibility({
        intervalItems: 0,
        labelledSinceRound1: 99,
        hasRound1: true,
        hasRound2: true,
      })
    ).toEqual({ eligible: false, labelsUntilEligible: 0 });
  });

  it('a shortfall of 0 that is STILL not eligible is deliberate, not a rounding artifact', () => {
    // The two structural blockers report labelsUntilEligible: 0 because the
    // blocker is not a count — labelling more items will never unblock them.
    // A caller that renders "0 more to go" from this is reading the wrong
    // field; `eligible` is the answer and the number is only ever a hint.
    const noFirstReading = retestEligibility({
      intervalItems: 20,
      labelledSinceRound1: 0,
      hasRound1: false,
      hasRound2: false,
    });
    expect(noFirstReading).toEqual({ eligible: false, labelsUntilEligible: 0 });

    // Contrast: the same zero-progress state WITH a first reading reports the
    // full interval, because there the count is exactly the blocker.
    expect(
      retestEligibility({
        intervalItems: 20,
        labelledSinceRound1: 0,
        hasRound1: true,
        hasRound2: false,
      })
    ).toEqual({ eligible: false, labelsUntilEligible: 20 });
  });

  it('an interval of 0 makes a first reading immediately re-readable', () => {
    // K = 0 is the "no intervening gap required" configuration, used by tests
    // that need two rounds without labelling 20 filler items. It must be
    // eligible rather than off-by-one into never.
    expect(
      retestEligibility({
        intervalItems: 0,
        labelledSinceRound1: 0,
        hasRound1: true,
        hasRound2: false,
      })
    ).toEqual({ eligible: true });
  });
});

const tenEligible: QueueCandidate[] = Array.from({ length: 10 }, (_, i) => ({
  itemId: `i${i}`,
  round: 1,
  eligible: true,
}));

describe('selectNext', () => {
  it('is deterministic for a given seed — reproducible in tests, not inferable from order', () => {
    expect(selectNext(tenEligible, 'annA:setA')).toEqual(selectNext(tenEligible, 'annA:setA'));
  });

  it('different annotators get different orders over the same set', () => {
    const a = selectNext(tenEligible, 'annA:setA');
    const b = selectNext(tenEligible, 'annB:setA');
    expect(a.next!.itemId).not.toBe(b.next!.itemId);
  });

  it('order does not follow the input order — position must not be inferable', () => {
    // A `candidates[0]` implementation passes both determinism tests above
    // while leaking exactly what the shuffle exists to hide: with an
    // index-ordered input, the first item offered would always be the
    // lowest-numbered one an annotator has not done.
    const picks = new Set(
      ['a:s', 'b:s', 'c:s', 'd:s', 'e:s', 'f:s'].map((seed) => selectNext(tenEligible, seed).next!.itemId)
    );
    expect(picks.size).toBeGreaterThan(1);
    expect(picks).not.toEqual(new Set(['i0']));
  });

  it('reports set-complete when there is nothing left at all', () => {
    expect(selectNext([], 'x')).toEqual({ next: null, reason: 'set-complete' });
  });

  it('reports the retest shortfall when the ONLY candidates are not yet eligible', () => {
    // The small-set case: intervening-items-only can leave a set with nothing
    // servable, and an empty queue would look broken instead of "label more".
    const r = selectNext([{ itemId: 'i1', round: 2, eligible: false, labelsUntilEligible: 7 }], 'x');
    expect(r).toEqual({ next: null, reason: 'retest-not-yet-eligible', labelsUntilRetest: 7 });
  });

  it('reports the SMALLEST shortfall among ineligible candidates', () => {
    // "Label 3 more" is actionable; "label 9 more" when 3 would do is a lie
    // the annotator cannot detect.
    const r = selectNext(
      [
        { itemId: 'i1', round: 2, eligible: false, labelsUntilEligible: 9 },
        { itemId: 'i2', round: 2, eligible: false, labelsUntilEligible: 3 },
      ],
      'x'
    );
    // Asserted as a whole object rather than by reaching for
    // `r.labelsUntilRetest`: that property exists only on the null-next branch
    // of QueueResult, so the property access does not typecheck against the
    // union — and the shortest way past that (a cast) would erase the very
    // field under assertion.
    expect(r).toEqual({ next: null, reason: 'retest-not-yet-eligible', labelsUntilRetest: 3 });
  });

  it('prefers an eligible candidate over an ineligible one', () => {
    const r = selectNext(
      [
        { itemId: 'i1', round: 2, eligible: false, labelsUntilEligible: 3 },
        { itemId: 'i2', round: 1, eligible: true },
      ],
      'x'
    );
    expect(r.next!.itemId).toBe('i2');
  });

  it('carries the round out of the candidate — the queue decides it, not a request', () => {
    const r = selectNext([{ itemId: 'i1', round: 2, eligible: true }], 'x');
    expect(r.next).toEqual({ itemId: 'i1', round: 2 });
  });
});
