/**
 * ─── Rate Limiting — shared types & config ────────────────────────────────
 *
 * The actual limiter implementation lives in `rate-limit-redis.ts` (atomic
 * Lua sliding window over a shared Redis instance). This file is retained
 * for two things only:
 *
 *   1. The `RateLimiter` / `RateLimitCheckResult` interface shape, so code
 *      that wants to fake a limiter in a test (without touching Redis) has
 *      a type to implement.
 *   2. The env-derived numeric limit constants, parsed once here so
 *      `rate-limit-redis.ts` doesn't duplicate the `Number(process.env.X ??
 *      fallback)` parsing, and so overriding a limit for ops purposes stays
 *      a one-env-var change.
 *
 * The previous in-memory `Map`-based sliding-window implementation (plus
 * its `createRateLimiter`/`authLimiter`/`apiLimiter`/`judgeLimiter`/
 * `registrationLimiter` exports) was deleted: a per-process `Map` can't
 * enforce a shared budget across multiple replicas, which is exactly the
 * gap the Redis-backed limiter closes. Node's Edge middleware had its own
 * *second*, independent in-memory limiter (deleted from `src/middleware.ts`
 * in the same change) — Edge can't hold a Redis connection, so rate
 * limiting now happens in route handlers (and the shared `requireAuth()`
 * chokepoint) instead of middleware.
 */

export interface RateLimitCheckResult {
  ok: boolean;
  remaining: number;
  resetAt: number; // Unix timestamp (ms) when the window resets
}

export interface RateLimiter {
  check(key: string): Promise<RateLimitCheckResult>;
}

// ─── Env-derived limit constants ───────────────────────────────────────────
// All four limiters use a 60s (per-minute) window. Override via env for ops
// tuning without a code change — see .env.example.

export const RATE_LIMIT_ENABLED = (process.env.RATE_LIMIT_ENABLED ?? 'true') !== 'false';
export const AUTH_LIMIT = Number(process.env.RATE_LIMIT_AUTH_MAX ?? '5');
export const API_LIMIT = Number(process.env.RATE_LIMIT_API_MAX ?? '120');
export const JUDGE_LIMIT = Number(process.env.RATE_LIMIT_JUDGE_MAX ?? '10');
export const HUGGINGFACE_LIMIT = Number(process.env.RATE_LIMIT_HUGGINGFACE_MAX ?? '30');

/**
 * Build rate-limit HTTP response headers from a check result.
 */
export function rateLimitHeaders(result: RateLimitCheckResult, limit: number): Record<string, string> {
  const headers: Record<string, string> = {
    'X-RateLimit-Limit': String(limit),
    'X-RateLimit-Remaining': String(result.remaining),
    'X-RateLimit-Reset': String(Math.ceil(result.resetAt / 1000)),
  };

  if (!result.ok) {
    headers['Retry-After'] = String(Math.max(0, Math.ceil((result.resetAt - Date.now()) / 1000)));
  }

  return headers;
}
