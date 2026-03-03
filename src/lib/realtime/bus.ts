import type { RealtimeEnvelope, RealtimeListener } from './types';

export interface RealtimeEventBus {
  readonly name: string;
  subscribe(listener: RealtimeListener): () => void;
  publish(event: RealtimeEnvelope): Promise<void>;
  getSubscriberCount(): number;
}
