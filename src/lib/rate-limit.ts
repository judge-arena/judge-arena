/**
 * ─── Rate Limiting ────────────────────────────────────────────────────────
 *
 * In-memory sliding window rate limiter with per-key tracking.
 * For single-process deployments. Can be extended to Redis for multi-process.
 *
 * Usage:
 *   const limiter = createRateLimiter({ windowMs: 60000, maxRequests: 10 });
 *   const result = limiter.check('user-123');
 *   if (!result.allowed) { return 429 response }
 */

export interface RateLimitConfig {
  /** Window duration in milliseconds */
  windowMs: number;
  /** Maximum requests allowed per window */
  maxRequests: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number; // Unix timestamp (ms) when the window resets
  retryAfterMs: number; // 0 if allowed, else ms to wait
}

interface WindowEntry {
  timestamps: number[];
}

export interface RateLimiter {
  check(key: string): RateLimitResult;
  reset(key: string): void;
}

/**
 * Create an in-memory sliding window rate limiter.
 */
export function createRateLimiter(config: RateLimitConfig): RateLimiter {
  const { windowMs, maxRequests } = config;
  const windows = new Map<string, WindowEntry>();

  // Periodic cleanup every 5 minutes
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of windows.entries()) {
      entry.timestamps = entry.timestamps.filter((t) => now - t < windowMs);
      if (entry.timestamps.length === 0) {
        windows.delete(key);
      }
    }
  }, 5 * 60 * 1000);

  // Prevent the cleanup interval from keeping the process alive
  if (cleanupInterval.unref) {
    cleanupInterval.unref();
  }

  return {
    check(key: string): RateLimitResult {
      const now = Date.now();
      let entry = windows.get(key);

      if (!entry) {
        entry = { timestamps: [] };
        windows.set(key, entry);
      }

      // Remove expired timestamps
      entry.timestamps = entry.timestamps.filter((t) => now - t < windowMs);

      if (entry.timestamps.length >= maxRequests) {
        const oldestInWindow = entry.timestamps[0];
        const resetAt = oldestInWindow + windowMs;
        return {
          allowed: false,
          remaining: 0,
          resetAt,
          retryAfterMs: resetAt - now,
        };
      }

      entry.timestamps.push(now);

      return {
        allowed: true,
        remaining: maxRequests - entry.timestamps.length,
        resetAt: now + windowMs,
        retryAfterMs: 0,
      };
    },

    reset(key: string): void {
      windows.delete(key);
    },
  };
}

// ─── Pre-configured Limiters ──────────────────────────────────────────────

/** Auth endpoints: 5 requests per minute per IP */
export const authLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: Number(process.env.RATE_LIMIT_AUTH_MAX ?? '5'),
});

/** General API: 60 requests per minute per user */
export const apiLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: Number(process.env.RATE_LIMIT_API_MAX ?? '60'),
});

/** LLM judging: 10 requests per minute per user */
export const judgeLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 10,
});

/** Registration: 3 requests per hour per IP */
export const registrationLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000,
  maxRequests: 3,
});

/**
 * Build rate limit headers for HTTP responses.
 */
export function rateLimitHeaders(result: RateLimitResult, maxRequests: number): Record<string, string> {
  return {
    'X-RateLimit-Limit': String(maxRequests),
    'X-RateLimit-Remaining': String(result.remaining),
    'X-RateLimit-Reset': String(Math.ceil(result.resetAt / 1000)),
    ...(result.retryAfterMs > 0
      ? { 'Retry-After': String(Math.ceil(result.retryAfterMs / 1000)) }
      : {}),
  };
}
