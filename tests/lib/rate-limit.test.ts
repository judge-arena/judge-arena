import { describe, it, expect } from 'vitest';
import {
  rateLimitHeaders,
  RATE_LIMIT_ENABLED,
  AUTH_LIMIT,
  API_LIMIT,
  JUDGE_LIMIT,
  HUGGINGFACE_LIMIT,
} from '@/lib/rate-limit';

// The Map-based in-memory limiter this file used to test (createRateLimiter
// et al.) was deleted — see rate-limit.ts's docstring. Redis-backed
// atomicity/window-expiry/cross-replica behavior is covered by
// tests/integration/rate-limit.test.ts (needs a live Redis, so it isn't
// part of this DB/Redis-free unit suite). What's left here is what's
// actually still pure, synchronous, config-parsing logic: the env-derived
// limit constants and the header-building helper.

describe('rate-limit (shared types & config)', () => {
  describe('env-derived limit constants', () => {
    it('default to the documented values when no RATE_LIMIT_* env vars are set', () => {
      // tests/setup.ts doesn't set any RATE_LIMIT_* env var, so these
      // reflect the fallback defaults baked into rate-limit.ts.
      expect(RATE_LIMIT_ENABLED).toBe(true);
      expect(AUTH_LIMIT).toBe(5);
      expect(API_LIMIT).toBe(120);
      expect(JUDGE_LIMIT).toBe(10);
      expect(HUGGINGFACE_LIMIT).toBe(30);
    });
  });

  describe('rateLimitHeaders', () => {
    it('includes Retry-After when not ok', () => {
      const headers = rateLimitHeaders(
        { ok: false, remaining: 0, resetAt: Date.now() + 30000 },
        10
      );

      expect(headers['Retry-After']).toBeDefined();
      expect(Number(headers['Retry-After'])).toBeGreaterThan(0);
      expect(headers['X-RateLimit-Remaining']).toBe('0');
      expect(headers['X-RateLimit-Limit']).toBe('10');
    });

    it('omits Retry-After when ok', () => {
      const headers = rateLimitHeaders(
        { ok: true, remaining: 5, resetAt: Date.now() + 60000 },
        10
      );

      expect(headers['Retry-After']).toBeUndefined();
      expect(headers['X-RateLimit-Remaining']).toBe('5');
      expect(headers['X-RateLimit-Limit']).toBe('10');
    });

    it('sets X-RateLimit-Reset to the resetAt timestamp in seconds', () => {
      const resetAt = Date.now() + 45000;
      const headers = rateLimitHeaders({ ok: true, remaining: 1, resetAt }, 10);

      expect(headers['X-RateLimit-Reset']).toBe(String(Math.ceil(resetAt / 1000)));
    });
  });
});
