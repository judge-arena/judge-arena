import { createRealtimeBus } from './factory';
import type {
  RealtimeEnvelope,
  RealtimeEventMap,
  RealtimeEventName,
  RealtimeListener,
  RealtimeTopic,
  DatasetSummaryUpdatedPayload,
} from './types';

const eventTopicMap: Record<RealtimeEventName, RealtimeTopic> = {
  'dataset.summary.updated': 'datasets',
};

const realtimeBus = createRealtimeBus();

export function subscribeRealtime(listener: RealtimeListener): () => void {
  return realtimeBus.subscribe(listener);
}

export async function publishRealtimeEvent<TName extends RealtimeEventName>(
  type: TName,
  payload: RealtimeEventMap[TName]['payload']
): Promise<void> {
  const envelope: RealtimeEnvelope<TName> = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    type,
    topic: eventTopicMap[type],
    timestamp: new Date().toISOString(),
    payload,
  };

  await realtimeBus.publish(envelope);
}

export function getRealtimeSubscriberCount(): number {
  return realtimeBus.getSubscriberCount();
}

export type {
  RealtimeEnvelope,
  RealtimeEventMap,
  RealtimeEventName,
  RealtimeListener,
  RealtimeTopic,
  DatasetSummaryUpdatedPayload,
};
