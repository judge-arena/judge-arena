import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RedisConfigError } from '@/lib/redis';

// Mock the redis module before importing rate-limit-redis
vi.mock('@/lib/redis', async () => {
  const actual = await vi.importActual<typeof import('@/lib/redis')>('@/lib/redis');
  return {
    ...actual,
    getConnectedRedis: vi.fn(),
  };
});

const { getConnectedRedis } = await import('@/lib/redis');

describe('rate-limit-redis: error handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('propagates RedisConfigError (misconfiguration) instead of failing open', async () => {
    const { createLimiter } = await import('@/lib/rate-limit-redis');

    const mockError = new RedisConfigError('REDIS_URL is not set. Redis is required in production.');
    vi.mocked(getConnectedRedis).mockRejectedValue(mockError);

    const limiter = createLimiter('config-error-test', 5, 60);

    await expect(limiter.check('test-key')).rejects.toThrow(RedisConfigError);
    await expect(limiter.check('test-key')).rejects.toThrow(
      'REDIS_URL is not set. Redis is required in production.'
    );
  });

  it('fails open (returns ok=true) for generic transient errors', async () => {
    const { createLimiter } = await import('@/lib/rate-limit-redis');

    const transientError = new Error('Connection timeout');
    vi.mocked(getConnectedRedis).mockRejectedValue(transientError);

    const limiter = createLimiter('transient-error-test', 5, 60);
    const result = await limiter.check('test-key');

    expect(result.ok).toBe(true);
    expect(result.remaining).toBe(5);
  });
});
