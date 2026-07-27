import type { RealtimeEventBus } from './bus';
import { InMemoryRealtimeEventBus } from './in-memory-bus';
import { RedisRealtimeEventBus } from './redis-bus';

/**
 * Adapter selection mirrors src/lib/redis.ts's fail-fast contract — no
 * env-driven opt-in/opt-out and no silent fallback (the old
 * REALTIME_ADAPTER var and its "no REDIS_URL => memory" default are gone):
 *
 *  - NODE_ENV=test: always in-memory. Unit tests must not require a live
 *    Redis, and per-test isolation matters more than cross-process realism
 *    here (integration tests exercise RedisRealtimeEventBus directly,
 *    bypassing this factory, against the real thing).
 *  - everything else (dev, production): always RedisRealtimeEventBus, which
 *    lazily resolves its connection via getRedis()/getConnectedRedis()
 *    (src/lib/redis.ts) on first publish/subscribe — production REQUIRES
 *    REDIS_URL (throws RedisConfigError otherwise), dev defaults to
 *    redis://localhost:6379. A Redis outage surfaces as a thrown error from
 *    publish()/subscribe(), never a quiet downgrade to in-process-only
 *    delivery.
 */
export function createRealtimeBus(): RealtimeEventBus {
  if (process.env.NODE_ENV === 'test') {
    return new InMemoryRealtimeEventBus();
  }
  return new RedisRealtimeEventBus();
}
