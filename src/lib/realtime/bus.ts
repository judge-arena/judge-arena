import type { RealtimeEnvelope, RealtimeEvent, RealtimeListener } from './types';

export interface RealtimeEventBus {
  readonly name: string;

  /**
   * Subscribe to a single topic (e.g. `user:{id}` or `run:{id}`). Resolves
   * once the subscription is actually active — for the Redis adapter, only
   * after Redis has acknowledged the SUBSCRIBE, so the caller can safely
   * treat "subscribed" as "no live events will be missed from this point
   * forward." Rejects if the underlying transport can't be reached (no
   * silent fallback — see redis-bus.ts).
   */
  subscribe(topic: string, listener: RealtimeListener): Promise<() => void>;

  /**
   * Publish `event` on `topic`, returning the full envelope (with its
   * assigned resume id) once durably recorded. Throws on any failure —
   * callers decide whether that's fatal (see publishEvent()'s docstring in
   * events.ts).
   */
  publish(topic: string, event: RealtimeEvent): Promise<RealtimeEnvelope>;

  /** Replay events published after `lastEventId` (exclusive) on `topic`. */
  replaySince(topic: string, lastEventId: string): Promise<RealtimeEnvelope[]>;

  getSubscriberCount(): number;
}
