import { afterEach, describe, expect, it, vi } from 'vitest';
import { withRetry } from '@/lib/llm/resilience';
import { ProviderError } from '@/lib/llm/errors';

function providerError(kind: 'retryable' | 'non_retryable' | 'rate_limited', extra: Partial<{ retryAfterMs: number }> = {}) {
  return new ProviderError('boom', { kind, provider: 'anthropic', ...extra });
}

describe('withRetry', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves on the first successful attempt without ever consulting isRetryable', async () => {
    const isRetryable = vi.fn();
    const fn = vi.fn().mockResolvedValue('ok');

    await expect(withRetry(fn, { isRetryable })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(isRetryable).not.toHaveBeenCalled();
  });

  it('retries a retryable failure up to maxAttempts, then throws the last error', async () => {
    const error = providerError('retryable');
    const fn = vi.fn().mockRejectedValue(error);

    await expect(
      withRetry(fn, { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 5 })
    ).rejects.toBe(error);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('succeeds on a later attempt after transient failures', async () => {
    const error = providerError('retryable');
    const fn = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce('recovered');

    await expect(
      withRetry(fn, { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 5 })
    ).resolves.toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not retry when isRetryable returns false — fails on the first attempt', async () => {
    const error = providerError('non_retryable');
    const fn = vi.fn().mockRejectedValue(error);
    const isRetryable = vi.fn().mockReturnValue(false);

    await expect(withRetry(fn, { maxAttempts: 5, isRetryable })).rejects.toBe(error);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  describe('default isRetryable (taxonomy-driven via classify())', () => {
    it('retries a ProviderError with kind "retryable"', async () => {
      const fn = vi.fn().mockRejectedValue(providerError('retryable'));
      await expect(withRetry(fn, { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 5 })).rejects.toThrow();
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('retries a ProviderError with kind "rate_limited"', async () => {
      const fn = vi.fn().mockRejectedValue(providerError('rate_limited'));
      await expect(withRetry(fn, { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 5 })).rejects.toThrow();
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('does NOT retry a ProviderError with kind "non_retryable"', async () => {
      const fn = vi.fn().mockRejectedValue(providerError('non_retryable'));
      await expect(withRetry(fn, { maxAttempts: 5 })).rejects.toThrow();
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('retries a raw, unclassified error — classify()\'s conservative default is retryable', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('mystery failure'));
      await expect(withRetry(fn, { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 5 })).rejects.toThrow();
      expect(fn).toHaveBeenCalledTimes(2);
    });
  });

  describe('retryAfterMs (rate_limited backoff)', () => {
    it('waits at least retryAfterMs before the next attempt, even when the exponential delay would be shorter', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0); // deterministic exponential component

      const error = providerError('rate_limited', { retryAfterMs: 150 });
      const fn = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce('ok');

      const start = Date.now();
      await withRetry(fn, { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1000 });
      const elapsed = Date.now() - start;

      // baseDelayMs=1 alone would retry almost immediately; retryAfterMs=150
      // must be the one actually governing the wait.
      expect(elapsed).toBeGreaterThanOrEqual(140);
    });

    it('caps retryAfterMs at maxDelayMs — an upstream cannot stall the loop indefinitely', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0);

      const error = providerError('rate_limited', { retryAfterMs: 10_000 });
      const fn = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce('ok');

      const start = Date.now();
      await withRetry(fn, { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 50 });
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(500); // nowhere near the requested 10s
    });
  });
});
