import { createRealtimeBus } from './factory';
import type {
  RealtimeEnvelope,
  RealtimeEvent,
  RealtimeEventMap,
  RealtimeEventName,
  RealtimeListener,
} from './types';
import { runTopic, userTopic } from './types';

const realtimeBus = createRealtimeBus();

/**
 * Publish `event` on `topic` (see `userTopic`/`runTopic`).
 *
 * Throws on any bus failure — in production that means a real Redis
 * failure (connection down, misconfigured REDIS_URL, etc.) propagates all
 * the way to the caller. The bus never silently downgrades to a local-only
 * emit, so it's the caller's job to decide what a failed publish means:
 * today's only caller (dataset-evaluation-summary.ts) lets it propagate;
 * worker publishers arriving in later tasks are expected to treat it as
 * retryable-nonfatal (log + continue) rather than fail the job that
 * produced the event.
 */
export async function publishEvent<TName extends RealtimeEventName>(
  topic: string,
  event: RealtimeEvent<TName>
): Promise<void> {
  await realtimeBus.publish(topic, event);
}

/** Subscribe to a single topic. Resolves once the subscription is live. */
export async function subscribeTopic(
  topic: string,
  listener: RealtimeListener
): Promise<() => void> {
  return realtimeBus.subscribe(topic, listener);
}

/** Replay events published after `lastEventId` (exclusive) on `topic`. */
export async function replayTopicSince(
  topic: string,
  lastEventId: string
): Promise<RealtimeEnvelope[]> {
  return realtimeBus.replaySince(topic, lastEventId);
}

export function getRealtimeSubscriberCount(): number {
  return realtimeBus.getSubscriberCount();
}

export { userTopic, runTopic };

export type {
  RealtimeEnvelope,
  RealtimeEvent,
  RealtimeEventMap,
  RealtimeEventName,
  RealtimeListener,
};

export type {
  DatasetSummaryUpdatedPayload,
  JudgmentCompletedPayload,
  RunStatusChangedPayload,
} from './types';
