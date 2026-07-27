/**
 * ─── Redis Client ─────────────────────────────────────────────────────────
 *
 * Lazy singleton `redis` v5 client shared by the Lua sliding-window rate
 * limiter (`rate-limit-redis.ts`) and the Redis-backed realtime event bus
 * (`realtime/redis-bus.ts` uses its own dynamic import today; this module
 * is the one new call sites should use going forward).
 *
 * Fail-fast contract: in production, calling `getRedis()` (directly, or
 * transitively via `getConnectedRedis()`/`redisHealthy()`) without
 * REDIS_URL set throws immediately with a clear message — Redis backs rate
 * limiting on every authenticated request (see `auth-guard.ts`), so a
 * silently-missing Redis in production would mean silently-missing rate
 * limits, not a loud, obvious failure. Non-production environments (dev,
 * test) default to `redis://localhost:6379` so contributors don't need to
 * set REDIS_URL just to run the app or the test suite locally.
 */

import { createClient } from 'redis';

export type RedisClient = ReturnType<typeof createClient>;

/**
 * Thrown by `getRedis()` in production when REDIS_URL is not configured.
 * Used to differentiate configuration errors (which must propagate, never
 * fail-open) from transient runtime/connection errors (which may fail-open
 * to avoid cascading outages).
 */
export class RedisConfigError extends Error {
  override name = 'RedisConfigError';

  constructor(message: string) {
    super(message);
  }
}

let client: RedisClient | null = null;
let connectPromise: Promise<RedisClient> | null = null;

function resolveRedisUrl(): string {
  const url = process.env.REDIS_URL;
  if (url) return url;

  if (process.env.NODE_ENV === 'production') {
    throw new RedisConfigError(
      'REDIS_URL is not set. Redis is required in production (rate limiting, ' +
        'realtime SSE fan-out). Set REDIS_URL=redis://host:6379 (or rediss:// ' +
        'for TLS) in the environment before starting the app.'
    );
  }

  return 'redis://localhost:6379';
}

function createRedisClient(): RedisClient {
  const c = createClient({ url: resolveRedisUrl() });

  // node-redis rethrows (crashing the process) if an 'error' event has no
  // listener. Reconnection itself relies on the client's built-in default
  // backoff strategy — we deliberately don't override `socket.reconnectStrategy`.
  c.on('error', (error) => {
    console.error('Redis client error:', error);
  });

  return c;
}

/**
 * Lazy singleton Redis client. Creates (but does not connect) the client on
 * first call. Throws in production if REDIS_URL is unset — see module
 * docstring.
 *
 * Most callers want `getConnectedRedis()` instead, which guarantees the
 * socket is open before returning.
 */
export function getRedis(): RedisClient {
  if (!client) {
    client = createRedisClient();
  }
  return client;
}

/**
 * Resolve the singleton client with its socket connected, connecting (once,
 * de-duplicated across concurrent callers) if necessary.
 */
export async function getConnectedRedis(): Promise<RedisClient> {
  const c = getRedis();
  if (c.isOpen) return c;

  if (!connectPromise) {
    connectPromise = c
      .connect()
      .then(() => c)
      .catch((error) => {
        connectPromise = null; // allow a retry on the next call
        throw error;
      });
  }

  return connectPromise;
}

/**
 * PING with a 500ms timeout. Never throws — returns false for any failure,
 * including connection errors, timeouts, or `getRedis()` itself throwing in
 * production without REDIS_URL configured. Used by `/api/health`.
 */
export async function redisHealthy(): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const pingPromise = (async () => {
      const c = await getConnectedRedis();
      return c.ping();
    })();

    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('redis health check timed out')), 500);
    });

    const result = await Promise.race([pingPromise, timeoutPromise]);
    return result === 'PONG';
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Close the singleton connection. Used by integration tests (so `vitest
 * run` can exit cleanly) and available for graceful shutdown hooks. Safe to
 * call even if the client was never connected.
 */
export async function disconnectRedis(): Promise<void> {
  if (client?.isOpen) {
    await client.close();
  }
  client = null;
  connectPromise = null;
}
