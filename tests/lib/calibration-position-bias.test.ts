import { describe, expect, it } from 'vitest';
import { positionBiasFromPairs } from '@/lib/calibration/position-bias';

/** n items, each with an AB and a BA judgment. `ab`/`ba` pick the raw letter. */
const pairs = (n: number, ab: (i: number) => string | null, ba: (i: number) => string | null) =>
  Array.from({ length: n }, (_, i) => [
    { itemId: `i${i}`, verdict: ab(i), pairOrder: 'AB' },
    { itemId: `i${i}`, verdict: ba(i), pairOrder: 'BA' },
  ]).flat();

describe('positionBiasFromPairs', () => {
  it('scores a pure first-slot stamper 0.5 / 1.0', () => {
    // Always names slot A. Maximally position-driven.
    const r = positionBiasFromPairs(pairs(100, () => 'A', () => 'A'));
    expect(r.positionBias).toBeCloseTo(0.5, 10);
    expect(r.orderFlipRate).toBeCloseTo(1.0, 10);
    expect(r.pairedDecisiveCount).toBe(100);
  });

  it('scores a symmetric flipper 0.0 / 1.0 — the case marginal alone misses', () => {
    // Names the same slot in both orders, but no net side: half A, half B.
    const r = positionBiasFromPairs(pairs(100, (i) => (i % 2 ? 'A' : 'B'), (i) => (i % 2 ? 'A' : 'B')));
    expect(r.positionBias).toBeCloseTo(0.0, 10);
    expect(r.orderFlipRate).toBeCloseTo(1.0, 10);
  });

  it('scores a PERFECT CONTENT JUDGE 0.0 / 0.0 on a LOPSIDED key', () => {
    // THE LOAD-BEARING ARM. 62 of 100 items keyed A>B, mirroring the real
    // 336/284 set. A correct judge names slot A on the A>B items in AB and on
    // the B>A items in BA, so its pooled slot-A rate is exactly 0.5.
    // Computing this from PREFERENCES instead returns 0.12 here — a real
    // effect where there is none, and anticorrelated with position bias.
    const keyIsAB = (i: number) => i < 62;
    const r = positionBiasFromPairs(
      pairs(100, (i) => (keyIsAB(i) ? 'A' : 'B'), (i) => (keyIsAB(i) ? 'B' : 'A'))
    );
    expect(r.positionBias).toBeCloseTo(0.0, 10);
    expect(r.orderFlipRate).toBeCloseTo(0.0, 10);
  });

  it('excludes an item that tied in either order, and counts the exclusion', () => {
    const rows = [
      { itemId: 'i1', verdict: 'A', pairOrder: 'AB' },
      { itemId: 'i1', verdict: 'tie', pairOrder: 'BA' },
      { itemId: 'i2', verdict: 'A', pairOrder: 'AB' },
      { itemId: 'i2', verdict: 'A', pairOrder: 'BA' },
    ];
    const r = positionBiasFromPairs(rows);
    expect(r.pairedDecisiveCount).toBe(1);
    expect(r.tieExcludedCount).toBe(1);
  });

  it('returns nulls, not zeros, when nothing is decisive', () => {
    const r = positionBiasFromPairs(pairs(10, () => 'tie', () => 'tie'));
    expect(r.positionBias).toBeNull();
    expect(r.orderFlipRate).toBeNull();
    expect(r.pairedDecisiveCount).toBe(0);
  });

  it('does not pair an item that only ran in one order', () => {
    const r = positionBiasFromPairs([{ itemId: 'i1', verdict: 'A', pairOrder: 'AB' }]);
    expect(r.pairedDecisiveCount).toBe(0);
    expect(r.unpairedCount).toBe(1);
    expect(r.positionBias).toBeNull();
  });

  it('gives a flip-rate interval that narrows with n', () => {
    const small = positionBiasFromPairs(pairs(20, () => 'A', () => 'A'));
    const large = positionBiasFromPairs(pairs(620, () => 'A', () => 'A'));
    const width = (i: { low: number; high: number } | null) => (i ? i.high - i.low : Infinity);
    expect(width(large.orderFlipRateInterval)).toBeLessThan(width(small.orderFlipRateInterval));
  });

  it('has a point estimate but no paired interval at n = 1 (between-item variance is not estimable)', () => {
    const r = positionBiasFromPairs(pairs(1, () => 'A', () => 'A'));
    expect(r.pairedDecisiveCount).toBe(1);
    expect(r.positionBias).toBeCloseTo(0.5, 10);
    expect(r.positionBiasInterval).toBeNull();
    // The Wilson side is unaffected by this — it stays honestly wide at n=1.
    expect(r.orderFlipRateInterval).not.toBeNull();
  });

  it('counts an item with a null verdict in BOTH orders as unpaired, not vanished', () => {
    const rows = [
      { itemId: 'i1', verdict: null, pairOrder: 'AB' },
      { itemId: 'i1', verdict: null, pairOrder: 'BA' },
    ];
    const r = positionBiasFromPairs(rows);
    expect(r.unpairedCount).toBe(1);
    expect(r.pairedDecisiveCount).toBe(0);
    expect(r.tieExcludedCount).toBe(0);
    expect(r.positionBias).toBeNull();
    expect(r.orderFlipRate).toBeNull();
  });
});
