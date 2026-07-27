/**
 * ─── Redis-backed Circuit Breaker ──────────────────────────────────────────
 *
 * Replaces the old in-process `Map`-based breaker in `resilience.ts` (one
 * breaker per Node process, blind to every other replica/worker) with state
 * held in Redis, so every replica calling `getBreaker(key)` for the same
 * `key` observes and drives the *same* circuit — this is what makes
 * "5 failures split across two replicas opens the circuit for both" true.
 *
 * State per key:
 *   - `cb:{key}`          hash: { state: 'open', openedAt: <ms> } — absent
 *                          (or `state` unset) means closed. There is no
 *                          persisted "half-open" state; half-open is a
 *                          transient `allow()` return value derived from
 *                          `state === 'open'` plus elapsed cooldown — see
 *                          below.
 *   - `cb:{key}:failures` zset of failure timestamps (ms), same
 *                          ZADD/ZREMRANGEBYSCORE rolling-window pattern as
 *                          `rate-limit-redis.ts`'s sliding window.
 *   - `cb:{key}:probe`    `SET NX PX` lock — whoever wins it is the one
 *                          process, cluster-wide, allowed to send the
 *                          half-open probe request.
 *
 * All transitions run as a single Lua `EVAL` (atomic, single-threaded on
 * the Redis side), the same technique `rate-limit-redis.ts` uses for its
 * sliding-window check — no separate read then write from Node, so two
 * concurrent `onFailure()` calls (different replicas) can't both read
 * "4 failures" and both independently decide not to open.
 *
 * `onFailure()`/`onSuccess()` never throw: they're always called from the
 * caller's own success/failure path (see `llm/index.ts`), and a Redis
 * hiccup while recording breaker bookkeeping must not replace or mask the
 * real judgment outcome the caller is already returning/throwing. They fail
 * open silently (logged, not swallowed silently) — same trade-off
 * `rate-limit-redis.ts` makes for `check()`. `allow()` is the one gating
 * method: a `RedisConfigError` (production misconfiguration) propagates
 * (fail loud, matching `rate-limit-redis.ts`'s `check()`), while a
 * transient runtime error fails open by returning `'closed'` (don't block
 * traffic just because Redis blipped).
 */

import { randomUUID } from 'crypto';
import { getConnectedRedis, RedisConfigError } from '../redis';
import { logger } from '../logger';

/** Failures within this rolling window count toward the open threshold. */
const FAILURE_WINDOW_MS = 60_000;
/** Failures within the window before the circuit opens. */
const FAILURE_THRESHOLD = 5;
/** How long the circuit stays open before allowing a single probe. */
export const CIRCUIT_OPEN_MS = 30_000;
/** How long a probe holder gets exclusive use of the probe slot. */
const PROBE_TTL_MS = 10_000;
/**
 * TTL on the state hash itself — pure Redis hygiene (so an abandoned
 * breaker for a retired provider/endpoint doesn't linger forever), well
 * clear of `CIRCUIT_OPEN_MS` so it never expires mid-open-window.
 */
const STATE_TTL_MS = CIRCUIT_OPEN_MS * 10;

export type BreakerState = 'closed' | 'open' | 'half_open_probe';

export interface Breaker {
  allow(): Promise<BreakerState>;
  onSuccess(): Promise<void>;
  onFailure(): Promise<void>;
}

const ALLOW_SCRIPT = `
local stateKey = KEYS[1]
local probeKey = KEYS[2]
local now = tonumber(ARGV[1])
local openMs = tonumber(ARGV[2])
local probeTtlMs = tonumber(ARGV[3])

local state = redis.call('HGET', stateKey, 'state')
if state ~= 'open' then
  return 'closed'
end

local openedAt = tonumber(redis.call('HGET', stateKey, 'openedAt'))
if openedAt == nil then
  -- Corrupt/partial state (shouldn't happen) — fail open rather than wedge.
  return 'closed'
end

if (now - openedAt) < openMs then
  return 'open'
end

local won = redis.call('SET', probeKey, '1', 'NX', 'PX', probeTtlMs)
if won then
  return 'half_open_probe'
end
return 'open'
`;

const ON_FAILURE_SCRIPT = `
local stateKey = KEYS[1]
local failuresKey = KEYS[2]
local probeKey = KEYS[3]
local now = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local threshold = tonumber(ARGV[3])
local member = ARGV[4]
local stateTtlMs = tonumber(ARGV[5])

local state = redis.call('HGET', stateKey, 'state')

if state == 'open' then
  -- Already open — this failure is either the half-open probe failing, or
  -- a straggling in-flight call that started before the circuit opened.
  -- Either way: extend the open window with a fresh cooldown and release
  -- the probe slot so the next probe attempt starts clean.
  redis.call('HSET', stateKey, 'state', 'open', 'openedAt', now)
  redis.call('PEXPIRE', stateKey, stateTtlMs)
  redis.call('DEL', probeKey)
  return 'open'
end

redis.call('ZREMRANGEBYSCORE', failuresKey, '-inf', now - windowMs)
redis.call('ZADD', failuresKey, now, member)
redis.call('PEXPIRE', failuresKey, windowMs)
local count = redis.call('ZCARD', failuresKey)

if count >= threshold then
  redis.call('HSET', stateKey, 'state', 'open', 'openedAt', now)
  redis.call('PEXPIRE', stateKey, stateTtlMs)
  redis.call('DEL', probeKey)
  redis.call('DEL', failuresKey)
  return 'open'
end

return 'closed'
`;

// One SHA cache entry per distinct script body (SCRIPT LOAD once, reused via
// EVALSHA — same reasoning as rate-limit-redis.ts's single-script cache,
// generalized here to the two scripts this module uses).
const shaCache = new Map<string, Promise<string>>();

async function getSha(script: string): Promise<string> {
  let shaPromise = shaCache.get(script);
  if (!shaPromise) {
    const client = await getConnectedRedis();
    shaPromise = client.scriptLoad(script).catch((error) => {
      shaCache.delete(script);
      throw error;
    });
    shaCache.set(script, shaPromise);
  }
  return shaPromise;
}

async function evalScript(script: string, keys: string[], args: string[]): Promise<string> {
  const client = await getConnectedRedis();

  try {
    const sha = await getSha(script);
    const result = await client.evalSha(sha, { keys, arguments: args });
    return result as string;
  } catch (error) {
    const isNoScript = error instanceof Error && error.message.includes('NOSCRIPT');
    if (!isNoScript) throw error;

    shaCache.delete(script);
    const sha = await getSha(script);
    const result = await client.evalSha(sha, { keys, arguments: args });
    return result as string;
  }
}

/**
 * Get a breaker handle for `key`. Cheap and stateless to construct — all
 * real state lives in Redis, so there's nothing to cache locally (unlike
 * the retired in-process `Map`, calling this twice for the same key from
 * two different processes is exactly the intended usage).
 */
export function getBreaker(key: string): Breaker {
  const stateKey = `cb:${key}`;
  const failuresKey = `cb:${key}:failures`;
  const probeKey = `cb:${key}:probe`;

  return {
    async allow(): Promise<BreakerState> {
      try {
        const result = await evalScript(
          ALLOW_SCRIPT,
          [stateKey, probeKey],
          [String(Date.now()), String(CIRCUIT_OPEN_MS), String(PROBE_TTL_MS)]
        );
        return result as BreakerState;
      } catch (error) {
        if (error instanceof RedisConfigError) throw error;

        logger.error('Circuit breaker allow() Redis check failed, failing open', {
          key,
          error: error instanceof Error ? error.message : String(error),
        });
        return 'closed';
      }
    },

    async onSuccess(): Promise<void> {
      try {
        const client = await getConnectedRedis();
        await client.multi().del(stateKey).del(probeKey).del(failuresKey).exec();
      } catch (error) {
        logger.error('Circuit breaker onSuccess() Redis update failed (state may be stale)', {
          key,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },

    async onFailure(): Promise<void> {
      try {
        await evalScript(
          ON_FAILURE_SCRIPT,
          [stateKey, failuresKey, probeKey],
          [
            String(Date.now()),
            String(FAILURE_WINDOW_MS),
            String(FAILURE_THRESHOLD),
            `${Date.now()}-${randomUUID()}`,
            String(STATE_TTL_MS),
          ]
        );
      } catch (error) {
        logger.error('Circuit breaker onFailure() Redis update failed (failure not recorded)', {
          key,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}
