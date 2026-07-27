/**
 * ─── Redis-backed Rate Limiter ────────────────────────────────────────────
 *
 * Atomic sliding-window rate limiter, backed by one Redis sorted set per
 * (name, key). Every allowed `check()` adds a uniquely-named member scored
 * by its arrival time (ms); `ZREMRANGEBYSCORE` evicts everything older than
 * the window on every call, so `ZCARD` always reflects the live count.
 *
 * The whole read-check-write sequence runs as a single Lua script via
 * `EVAL`/`EVALSHA`, so concurrent callers — even across multiple app
 * replicas hitting the same Redis — can never over-admit past `limit`:
 * Redis executes scripts atomically and single-threaded, so there's no
 * read/check/write race window the way there would be issuing those same
 * four commands individually from Node.
 */

import { randomUUID } from 'crypto';
import { getConnectedRedis } from './redis';
import {
  RATE_LIMIT_ENABLED,
  AUTH_LIMIT,
  API_LIMIT,
  JUDGE_LIMIT,
  HUGGINGFACE_LIMIT,
  type RateLimiter,
  type RateLimitCheckResult,
} from './rate-limit';

const SLIDING_WINDOW_SCRIPT = `
local key = KEYS[1]
local now_ms = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]

redis.call('ZREMRANGEBYSCORE', key, '-inf', now_ms - window_ms)
local count = redis.call('ZCARD', key)

if count < limit then
  redis.call('ZADD', key, now_ms, member)
  redis.call('PEXPIRE', key, window_ms)
  return {1, limit - count - 1, now_ms + window_ms}
else
  return {0, 0, now_ms + window_ms}
end
`;

// The script is registered once per process (SCRIPT LOAD) and reused via
// EVALSHA across every limiter instance/check — this avoids resending the
// script body on every request. Shared module-level cache: all limiters use
// the identical script text, so there's exactly one SHA to track. If Redis
// evicts the script (e.g. a restart wiped the script cache), EVALSHA fails
// with NOSCRIPT and we reload + retry once.
let shaPromise: Promise<string> | null = null;

async function getScriptSha(): Promise<string> {
  const client = await getConnectedRedis();
  if (!shaPromise) {
    shaPromise = client.scriptLoad(SLIDING_WINDOW_SCRIPT).catch((error) => {
      shaPromise = null; // allow a retry on the next call
      throw error;
    });
  }
  return shaPromise;
}

async function evalSlidingWindow(
  redisKey: string,
  nowMs: number,
  windowMs: number,
  limit: number,
  member: string
): Promise<[number, number, number]> {
  const client = await getConnectedRedis();
  const args = [String(nowMs), String(windowMs), String(limit), member];

  try {
    const sha = await getScriptSha();
    const result = await client.evalSha(sha, { keys: [redisKey], arguments: args });
    return result as [number, number, number];
  } catch (error) {
    const isNoScript = error instanceof Error && error.message.includes('NOSCRIPT');
    if (!isNoScript) throw error;

    shaPromise = null;
    const sha = await getScriptSha();
    const result = await client.evalSha(sha, { keys: [redisKey], arguments: args });
    return result as [number, number, number];
  }
}

/**
 * Create a named rate limiter with an atomic Redis-backed sliding window.
 * `name` namespaces the Redis keys (`rl:{name}:{key}`) so different
 * limiters never collide even if callers reuse the same `key` (e.g. the
 * same client IP checked against both `auth` and `api`).
 */
export function createLimiter(name: string, limit: number, windowSec: number): RateLimiter {
  const windowMs = windowSec * 1000;

  return {
    async check(key: string): Promise<RateLimitCheckResult> {
      if (!RATE_LIMIT_ENABLED) {
        return { ok: true, remaining: limit, resetAt: Date.now() + windowMs };
      }

      const now = Date.now();
      const member = `${now}-${randomUUID()}`;
      const redisKey = `rl:${name}:${key}`;

      try {
        const [ok, remaining, resetAt] = await evalSlidingWindow(redisKey, now, windowMs, limit, member);
        return { ok: ok === 1, remaining, resetAt };
      } catch (error) {
        // Fail open: a transient Redis outage shouldn't 500 (or silently
        // block) every authenticated request. `/api/health`'s
        // `checks.redis` is the actual signal for "Redis is down" in
        // production — this just keeps traffic flowing while that fires,
        // rather than compounding a Redis outage into a full API outage.
        console.error(`Rate limiter '${name}' Redis check failed, failing open:`, error);
        return { ok: true, remaining: limit, resetAt: now + windowMs };
      }
    },
  };
}

// ─── Pre-configured limiters ────────────────────────────────────────────────
// All windows are 60s (per-minute); limits are env-overridable via the
// RATE_LIMIT_*_MAX constants re-exported from rate-limit.ts.

/** Login/registration endpoints. */
export const authLimiter = createLimiter('auth', AUTH_LIMIT, 60);

/**
 * General authenticated API surface. Wired into a single chokepoint —
 * `src/lib/auth-guard.ts`'s `requireAuth()` — rather than per-route
 * boilerplate, since every authenticated route already calls it.
 */
export const apiLimiter = createLimiter('api', API_LIMIT, 60);

/** Evaluation run launches (each one fans out to real LLM judge calls). */
export const judgeLimiter = createLimiter('judge', JUDGE_LIMIT, 60);

/** HuggingFace dataset preview/rows — proxies an upstream API with its own limits. */
export const huggingfaceLimiter = createLimiter('huggingface', HUGGINGFACE_LIMIT, 60);
