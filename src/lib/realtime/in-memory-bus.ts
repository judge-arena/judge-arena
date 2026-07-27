import type { RealtimeEventBus } from './bus';
import type { RealtimeEnvelope, RealtimeEvent, RealtimeListener } from './types';

const REPLAY_BUFFER_SIZE = 1000;

/**
 * In-process fan-out, no persistence beyond a small in-memory ring buffer
 * per topic. Only used under NODE_ENV=test (see factory.ts) — unit tests
 * must not require a live Redis, and per-test isolation matters more than
 * cross-process realism there. Every other environment gets
 * RedisRealtimeEventBus.
 */
export class InMemoryRealtimeEventBus implements RealtimeEventBus {
  readonly name = 'in-memory';

  private sequence = 0;
  private listenersByTopic = new Map<string, Map<number, RealtimeListener>>();
  private streamsByTopic = new Map<string, RealtimeEnvelope[]>();
  private nextEventId = 0;

  async subscribe(topic: string, listener: RealtimeListener): Promise<() => void> {
    this.sequence += 1;
    const listenerId = this.sequence;

    let topicListeners = this.listenersByTopic.get(topic);
    if (!topicListeners) {
      topicListeners = new Map();
      this.listenersByTopic.set(topic, topicListeners);
    }
    topicListeners.set(listenerId, listener);

    let unsubscribed = false;
    return () => {
      if (unsubscribed) return;
      unsubscribed = true;
      const listeners = this.listenersByTopic.get(topic);
      listeners?.delete(listenerId);
      if (listeners && listeners.size === 0) this.listenersByTopic.delete(topic);
    };
  }

  async publish(topic: string, event: RealtimeEvent): Promise<RealtimeEnvelope> {
    this.nextEventId += 1;
    const envelope: RealtimeEnvelope = {
      id: String(this.nextEventId),
      type: event.type,
      timestamp: new Date().toISOString(),
      payload: event.payload,
    } as RealtimeEnvelope;

    const stream = this.streamsByTopic.get(topic) ?? [];
    stream.push(envelope);
    if (stream.length > REPLAY_BUFFER_SIZE) stream.shift();
    this.streamsByTopic.set(topic, stream);

    const topicListeners = this.listenersByTopic.get(topic);
    if (topicListeners) {
      for (const listener of topicListeners.values()) {
        try {
          listener(envelope);
        } catch (error) {
          console.error('In-memory realtime listener failed:', error);
        }
      }
    }

    return envelope;
  }

  async replaySince(topic: string, lastEventId: string): Promise<RealtimeEnvelope[]> {
    const stream = this.streamsByTopic.get(topic) ?? [];
    const lastIdNum = Number(lastEventId);
    if (Number.isNaN(lastIdNum)) return [...stream];
    return stream.filter((event) => Number(event.id) > lastIdNum);
  }

  getSubscriberCount(): number {
    let total = 0;
    for (const listeners of this.listenersByTopic.values()) total += listeners.size;
    return total;
  }
}
