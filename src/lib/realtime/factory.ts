import type { RealtimeEventBus } from './bus';
import { InMemoryRealtimeEventBus } from './in-memory-bus';
import { RedisRealtimeEventBus } from './redis-bus';
import type { RealtimeEnvelope } from './types';

const REDIS_CHANNEL = process.env.REALTIME_REDIS_CHANNEL ?? 'judge-arena:realtime';

type AdapterKind = 'memory' | 'redis';

function emitToLocal(bus: InMemoryRealtimeEventBus, event: RealtimeEnvelope): Promise<void> {
  return bus.publish(event);
}

export function createRealtimeBus(): RealtimeEventBus {
  const memoryBus = new InMemoryRealtimeEventBus();

  const explicitAdapter = (process.env.REALTIME_ADAPTER ?? '').toLowerCase() as AdapterKind | '';
  const hasRedisUrl = !!process.env.REDIS_URL;

  const adapter: AdapterKind =
    explicitAdapter === 'redis'
      ? 'redis'
      : explicitAdapter === 'memory'
        ? 'memory'
        : hasRedisUrl
          ? 'redis'
          : 'memory';

  if (adapter === 'memory') {
    return memoryBus;
  }

  return new RedisRealtimeEventBus(
    process.env.REDIS_URL as string,
    REDIS_CHANNEL,
    (event) => emitToLocal(memoryBus, event)
  );
}
