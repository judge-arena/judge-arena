import { describe, expect, it } from 'vitest';
import { HARD_CONCURRENCY_CAP, resolveWorkerConcurrency } from '@/worker/concurrency';

describe('worker concurrency — a HARD cap, not a default', () => {
  it('clamps any request above the cap, and reports that it did', () => {
    // The configuration is allowed to ask (env.ts permits 1-16). It is not
    // allowed to get. Asking must not throw — only fail to take effect.
    for (const asked of ['2', '4', '8', '16']) {
      const r = resolveWorkerConcurrency(asked);
      expect(r.effective).toBe(HARD_CONCURRENCY_CAP);
      expect(r.capped).toBe(true);
      expect(r.requested).toBe(Number(asked));
    }
  });

  it('PREFETCH EQUALS the effective concurrency — this is the whole fix', () => {
    // The bug was `prefetch = concurrency * 4`. Prefetch is not a buffer here:
    // `dispatch` starts a handler for every delivered message, so a prefetch of
    // 8 issues 8 concurrent provider calls. Requests beyond the inference
    // server's slot count then queue INSIDE the server while their client
    // timeout runs, and time out against a wait that has nothing to do with
    // model speed. Four of thirty items dead-lettered exactly that way.
    for (const asked of [undefined, '1', '2', '8', '16']) {
      const r = resolveWorkerConcurrency(asked);
      expect(r.prefetch).toBe(r.effective);
      expect(r.prefetch).toBe(1); // sequential, while the cap is 1
    }
  });

  it('does not flag capped when the request is already at or below the cap', () => {
    const r = resolveWorkerConcurrency('1');
    expect(r.effective).toBe(1);
    expect(r.capped).toBe(false);
  });

  it('defaults to the env default of 2 and clamps it', () => {
    const r = resolveWorkerConcurrency(undefined);
    expect(r.requested).toBe(2);
    expect(r.effective).toBe(1);
    expect(r.capped).toBe(true);
  });

  it('floors garbage and sub-1 values to 1 rather than throwing', () => {
    // This runs at module load in the worker entrypoint. A boot crash over a
    // typo'd env var is a worse failure than quietly doing the safe thing.
    for (const bad of ['', 'two', 'NaN', '0', '-5', '0.5']) {
      const r = resolveWorkerConcurrency(bad);
      expect(r.effective).toBe(1);
      expect(r.prefetch).toBe(1);
      expect(Number.isFinite(r.requested)).toBe(true);
      expect(r.requested).toBeGreaterThanOrEqual(1);
    }
  });

  it('truncates a fractional request rather than passing a float to prefetch', () => {
    // amqplib's prefetch takes an integer; 2.7 unacked messages is not a thing.
    expect(resolveWorkerConcurrency('2.7').requested).toBe(2);
    expect(Number.isInteger(resolveWorkerConcurrency('2.7').prefetch)).toBe(true);
  });
});
