import { describe, it, expect, beforeEach } from 'vitest';
import { createRateLimiter, rateLimitHeaders } from '@/lib/rate-limit';

describe('rate-limit', () => {
  describe('createRateLimiter', () => {
    let limiter: ReturnType<typeof createRateLimiter>;

    beforeEach(() => {
      limiter = createRateLimiter({ windowMs: 1000, maxRequests: 3 });
    });

    it('should allow requests within limit', () => {
      const result1 = limiter.check('user-1');
      expect(result1.allowed).toBe(true);
      expect(result1.remaining).toBe(2);

      const result2 = limiter.check('user-1');
      expect(result2.allowed).toBe(true);
      expect(result2.remaining).toBe(1);

      const result3 = limiter.check('user-1');
      expect(result3.allowed).toBe(true);
      expect(result3.remaining).toBe(0);
    });

    it('should deny requests over limit', () => {
      limiter.check('user-1');
      limiter.check('user-1');
      limiter.check('user-1');

      const result = limiter.check('user-1');
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
      expect(result.retryAfterMs).toBeGreaterThan(0);
    });

    it('should track different keys independently', () => {
      limiter.check('user-1');
      limiter.check('user-1');
      limiter.check('user-1');

      const result1 = limiter.check('user-1');
      expect(result1.allowed).toBe(false);

      const result2 = limiter.check('user-2');
      expect(result2.allowed).toBe(true);
      expect(result2.remaining).toBe(2);
    });

    it('should reset a specific key', () => {
      limiter.check('user-1');
      limiter.check('user-1');
      limiter.check('user-1');
      expect(limiter.check('user-1').allowed).toBe(false);

      limiter.reset('user-1');
      expect(limiter.check('user-1').allowed).toBe(true);
    });

    it('should allow requests after window expires', async () => {
      const fastLimiter = createRateLimiter({ windowMs: 50, maxRequests: 1 });

      fastLimiter.check('user-1');
      expect(fastLimiter.check('user-1').allowed).toBe(false);

      await new Promise((resolve) => setTimeout(resolve, 60));

      expect(fastLimiter.check('user-1').allowed).toBe(true);
    });

    it('should return correct resetAt timestamp', () => {
      const before = Date.now();
      const result = limiter.check('user-1');
      const after = Date.now();

      expect(result.resetAt).toBeGreaterThanOrEqual(before + 1000);
      expect(result.resetAt).toBeLessThanOrEqual(after + 1000);
    });
  });

  describe('rateLimitHeaders', () => {
    it('should include Retry-After when not allowed', () => {
      const headers = rateLimitHeaders({
        allowed: false,
        remaining: 0,
        resetAt: Date.now() + 30000,
        retryAfterMs: 30000,
      });

      expect(headers['Retry-After']).toBe('30');
      expect(headers['X-RateLimit-Remaining']).toBe('0');
    });

    it('should not include Retry-After when allowed', () => {
      const headers = rateLimitHeaders({
        allowed: true,
        remaining: 5,
        resetAt: Date.now() + 60000,
        retryAfterMs: 0,
      });

      expect(headers['Retry-After']).toBeUndefined();
      expect(headers['X-RateLimit-Remaining']).toBe('5');
    });
  });
});
