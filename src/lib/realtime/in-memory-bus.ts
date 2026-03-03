import type { RealtimeEventBus } from './bus';
import type { RealtimeEnvelope, RealtimeListener } from './types';

export class InMemoryRealtimeEventBus implements RealtimeEventBus {
  readonly name = 'in-memory';

  private sequence = 0;
  private listeners = new Map<number, RealtimeListener>();

  subscribe(listener: RealtimeListener): () => void {
    this.sequence += 1;
    const listenerId = this.sequence;
    this.listeners.set(listenerId, listener);

    return () => {
      this.listeners.delete(listenerId);
    };
  }

  async publish(event: RealtimeEnvelope): Promise<void> {
    for (const listener of this.listeners.values()) {
      try {
        listener(event);
      } catch (error) {
        console.error('In-memory realtime listener failed:', error);
      }
    }
  }

  getSubscriberCount(): number {
    return this.listeners.size;
  }
}
