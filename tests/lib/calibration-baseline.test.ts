import { describe, expect, it } from 'vitest';
import { constantVerdictBaseline } from '@/lib/calibration/baseline';

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
