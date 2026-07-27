import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RedisConfigError } from '@/lib/redis';

// Mock the redis module before importing breaker-redis — same pattern as
// tests/lib/rate-limit-redis.test.ts, which covers the same two behaviors
// for the sibling Redis-backed rate limiter.
vi.mock('@/lib/redis', async () => {
  const actual = await vi.importActual<typeof import('@/lib/redis')>('@/lib/redis');
  return {
    ...actual,
    getConnectedRedis: vi.fn(),
  };
});

const { getConnectedRedis } = await import('@/lib/redis');

describe('breaker-redis: error handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('allow() propagates RedisConfigError (misconfiguration) instead of failing open', async () => {
    const { getBreaker } = await import('@/lib/llm/breaker-redis');

    const mockError = new RedisConfigError('REDIS_URL is not set. Redis is required in production.');
    vi.mocked(getConnectedRedis).mockRejectedValue(mockError);

    const breaker = getBreaker('config-error-test');

    await expect(breaker.allow()).rejects.toThrow(RedisConfigError);
    await expect(breaker.allow()).rejects.toThrow(
      'REDIS_URL is not set. Redis is required in production.'
    );
  });

  it('allow() fails open (returns "closed") for generic transient Redis errors', async () => {
    const { getBreaker } = await import('@/lib/llm/breaker-redis');

    vi.mocked(getConnectedRedis).mockRejectedValue(new Error('Connection timeout'));

    const breaker = getBreaker('transient-error-test');
    await expect(breaker.allow()).resolves.toBe('closed');
  });

  it('onFailure() never throws, even for a RedisConfigError — bookkeeping must not mask the caller\'s real error', async () => {
    const { getBreaker } = await import('@/lib/llm/breaker-redis');

    vi.mocked(getConnectedRedis).mockRejectedValue(
      new RedisConfigError('REDIS_URL is not set. Redis is required in production.')
    );

    const breaker = getBreaker('on-failure-config-error-test');
    await expect(breaker.onFailure()).resolves.toBeUndefined();
  });

  it('onFailure() never throws for a generic transient Redis error', async () => {
    const { getBreaker } = await import('@/lib/llm/breaker-redis');

    vi.mocked(getConnectedRedis).mockRejectedValue(new Error('Connection timeout'));

    const breaker = getBreaker('on-failure-transient-test');
    await expect(breaker.onFailure()).resolves.toBeUndefined();
  });

  it('onSuccess() never throws, even for a RedisConfigError', async () => {
    const { getBreaker } = await import('@/lib/llm/breaker-redis');

    vi.mocked(getConnectedRedis).mockRejectedValue(
      new RedisConfigError('REDIS_URL is not set. Redis is required in production.')
    );

    const breaker = getBreaker('on-success-config-error-test');
    await expect(breaker.onSuccess()).resolves.toBeUndefined();
  });

  it('onSuccess() never throws for a generic transient Redis error', async () => {
    const { getBreaker } = await import('@/lib/llm/breaker-redis');

    vi.mocked(getConnectedRedis).mockRejectedValue(new Error('Connection timeout'));

    const breaker = getBreaker('on-success-transient-test');
    await expect(breaker.onSuccess()).resolves.toBeUndefined();
  });
});
