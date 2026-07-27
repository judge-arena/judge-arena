import { getConnectedRedis, getRedis, type RedisClient } from '@/lib/redis';
import type { RealtimeEventBus } from './bus';
import type { RealtimeEnvelope, RealtimeEvent, RealtimeListener } from './types';

const STREAM_PREFIX = 'rt:stream:';
const STREAM_MAXLEN = 1000;

function streamKey(topic: string): string {
  return `${STREAM_PREFIX}${topic}`;
}

/** What actually gets stored in the stream / sent over PUBLISH — everything
 * except `id`, which is either assigned by XADD (publish) or read off the
 * stream entry itself (replay), never trusted from the JSON body. */
interface WireEvent {
  type: string;
  timestamp: string;
  payload: unknown;
}

function serializeWireEvent(event: RealtimeEvent, timestamp: string): string {
  const wire: WireEvent = { type: event.type, timestamp, payload: event.payload };
  return JSON.stringify(wire);
}

function envelopeFromWire(id: string, raw: string): RealtimeEnvelope {
  const wire = JSON.parse(raw) as WireEvent;
  return {
    id,
    type: wire.type,
    timestamp: wire.timestamp,
    payload: wire.payload,
  } as RealtimeEnvelope;
}

// ─── Shared subscriber connection ──────────────────────────────────────────
// node-redis can't issue non-pubsub commands on a connection that's in
// subscribe mode, so pub/sub needs its own duplicated connection separate
// from the shared getRedis()/getConnectedRedis() client (used here for
// XADD/XRANGE/PUBLISH, and elsewhere for rate limiting). Unlike that
// client's channels, though, this one is a genuine module-level singleton —
// "subscriber connection lifecycle managed once per process" — because
// node-redis natively supports many channel subscriptions (each with its
// own listener) multiplexed over one connection (see
// @redis/client/dist/lib/client/pub-sub.js), so every
// RedisRealtimeEventBus instance in the process shares it rather than each
// opening its own socket.
let subscriberClient: RedisClient | null = null;
let subscriberConnectPromise: Promise<RedisClient> | null = null;

async function getSubscriberClient(): Promise<RedisClient> {
  if (!subscriberClient) {
    subscriberClient = getRedis().duplicate();
    subscriberClient.on('error', (error) => {
      console.error('Redis realtime subscriber connection error:', error);
    });
  }

  if (subscriberClient.isOpen) return subscriberClient;

  if (!subscriberConnectPromise) {
    const client = subscriberClient;
    subscriberConnectPromise = client
      .connect()
      .then(() => client)
      .catch((error) => {
        subscriberConnectPromise = null; // allow a retry on the next call
        throw error;
      });
  }

  return subscriberConnectPromise;
}

/** Closes the shared subscriber connection. Used by integration tests (so
 * `vitest run` can exit cleanly) and available for graceful shutdown. */
export async function closeRealtimeRedisConnections(): Promise<void> {
  if (subscriberClient?.isOpen) {
    await subscriberClient.close();
  }
  subscriberClient = null;
  subscriberConnectPromise = null;
}

/**
 * Redis-backed realtime bus: Redis Pub/Sub for live fan-out, a capped Redis
 * Stream per topic (`rt:stream:{topic}`, MAXLEN ~1000) for resume. No
 * fallback path — a production deployment with no reachable Redis fails
 * every publish()/subscribe() call loudly (see publish()/subscribe()
 * below); it never silently degrades to delivering events only within the
 * process that happened to receive them (1a critique items 12/27: the old
 * "initialized-on-failure" + "silent local-emit fallback" behavior is gone).
 */
export class RedisRealtimeEventBus implements RealtimeEventBus {
  readonly name = 'redis';

  private sequence = 0;
  private listenersByTopic = new Map<string, Map<number, RealtimeListener>>();
  private redisListenerByTopic = new Map<string, (message: string) => void>();
  private topicSubscribePromises = new Map<string, Promise<void>>();

  async subscribe(topic: string, listener: RealtimeListener): Promise<() => void> {
    this.sequence += 1;
    const listenerId = this.sequence;

    let topicListeners = this.listenersByTopic.get(topic);
    if (!topicListeners) {
      topicListeners = new Map();
      this.listenersByTopic.set(topic, topicListeners);
    }
    topicListeners.set(listenerId, listener);

    let ensureSubscribed = this.topicSubscribePromises.get(topic);
    if (!ensureSubscribed) {
      ensureSubscribed = (async () => {
        const client = await getSubscriberClient();
        const redisListener = (message: string) => this.handleMessage(topic, message);
        this.redisListenerByTopic.set(topic, redisListener);
        await client.subscribe(topic, redisListener);
      })();
      this.topicSubscribePromises.set(topic, ensureSubscribed);
    }

    try {
      await ensureSubscribed;
    } catch (error) {
      // Never went live — undo the local registration rather than handing
      // back an unsubscribe() for a subscription that doesn't exist.
      topicListeners.delete(listenerId);
      if (topicListeners.size === 0) this.listenersByTopic.delete(topic);
      this.topicSubscribePromises.delete(topic);
      throw error;
    }

    let unsubscribed = false;
    return () => {
      if (unsubscribed) return;
      unsubscribed = true;
      void this.removeListener(topic, listenerId);
    };
  }

  private async removeListener(topic: string, listenerId: number): Promise<void> {
    const topicListeners = this.listenersByTopic.get(topic);
    topicListeners?.delete(listenerId);
    if (!topicListeners || topicListeners.size > 0) return;

    this.listenersByTopic.delete(topic);
    this.topicSubscribePromises.delete(topic);
    const redisListener = this.redisListenerByTopic.get(topic);
    this.redisListenerByTopic.delete(topic);
    if (!redisListener) return;

    try {
      const client = await getSubscriberClient();
      await client.unsubscribe(topic, redisListener);
    } catch (error) {
      console.error(`Redis realtime: failed to unsubscribe topic "${topic}":`, error);
    }
  }

  private handleMessage(topic: string, message: string): void {
    let envelope: RealtimeEnvelope;
    try {
      envelope = JSON.parse(message) as RealtimeEnvelope;
    } catch (error) {
      console.error('Redis realtime: failed to parse pub/sub message:', error);
      return;
    }

    const topicListeners = this.listenersByTopic.get(topic);
    if (!topicListeners) return;
    for (const listener of topicListeners.values()) {
      try {
        listener(envelope);
      } catch (error) {
        console.error('Redis realtime listener failed:', error);
      }
    }
  }

  async publish(topic: string, event: RealtimeEvent): Promise<RealtimeEnvelope> {
    const timestamp = new Date().toISOString();
    // No try/catch: a Redis failure here (including RedisConfigError from a
    // misconfigured production deployment) must propagate to the caller —
    // see publishEvent()'s docstring in events.ts.
    const client = await getConnectedRedis();

    const id = await client.xAdd(
      streamKey(topic),
      '*',
      { data: serializeWireEvent(event, timestamp) },
      { TRIM: { strategy: 'MAXLEN', strategyModifier: '~', threshold: STREAM_MAXLEN } }
    );

    const envelope: RealtimeEnvelope = {
      id,
      type: event.type,
      timestamp,
      payload: event.payload,
    } as RealtimeEnvelope;

    // Publish the full envelope (including the id XADD just assigned) so
    // live subscribers see the same id a resume XRANGE would produce for
    // this entry.
    await client.publish(topic, JSON.stringify(envelope));

    return envelope;
  }

  async replaySince(topic: string, lastEventId: string): Promise<RealtimeEnvelope[]> {
    const client = await getConnectedRedis();
    const entries = await client.xRange(streamKey(topic), `(${lastEventId}`, '+');
    return entries.map((entry) => envelopeFromWire(entry.id, entry.message.data as string));
  }

  getSubscriberCount(): number {
    let total = 0;
    for (const listeners of this.listenersByTopic.values()) total += listeners.size;
    return total;
  }
}
