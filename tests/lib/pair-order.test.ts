import { describe, expect, it } from 'vitest';
import { PAIR_ORDERS, isPairOrder, oppositeOrder } from '@/lib/pair-order';

describe('pair-order', () => {
  it('accepts only the two canonical spellings', () => {
    expect(isPairOrder('AB')).toBe(true);
    expect(isPairOrder('BA')).toBe(true);
    expect(isPairOrder('ba')).toBe(false);
    expect(isPairOrder('')).toBe(false);
    expect(isPairOrder(null)).toBe(false);
    expect(isPairOrder(undefined)).toBe(false);
  });

  it('lists both orders, AB first', () => {
    expect(PAIR_ORDERS).toEqual(['AB', 'BA']);
  });

  it('maps each order to the other', () => {
    expect(oppositeOrder('AB')).toBe('BA');
    expect(oppositeOrder('BA')).toBe('AB');
  });
});
