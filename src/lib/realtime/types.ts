/**
 * ─── Realtime Event Types ──────────────────────────────────────────────────
 *
 * v2: topics are ownership-scoped and orthogonal to event type — a topic is
 * just a Redis pub/sub channel name (and the key of its backing resume
 * stream, `rt:stream:{topic}`), and publishers pick which topic(s) an event
 * goes to at the call site (see `userTopic`/`runTopic` below). This is what
 * makes ownership scoping possible: the SSE route (src/app/api/events/route.ts)
 * only ever subscribes to `user:{self}` and, after an ownership check,
 * `run:{id}` — it can no longer receive an event meant for a different user
 * just because event *type* filtering happened to miss it client-side (the
 * v1 bug this replaces).
 */

export interface DatasetSummaryUpdatedPayload {
  datasetId: string;
  summary: {
    updatedAt: string;
    sampleCount: number;
    samplesWithModelScores: number;
    samplesWithHumanScores: number;
    averageModelScore: number | null;
    averageHumanScore: number | null;
  };
}

export interface RunStatusChangedPayload {
  runId: string;
  evaluationId: string;
  status: string;
}

export interface JudgmentCompletedPayload {
  runId: string;
  judgmentId: string;
  judgeModelVersionId?: string;
  status: string;
}

export interface RealtimeEventMap {
  'dataset.summary.updated': DatasetSummaryUpdatedPayload;
  // Not published by anything yet — worker publishers land in a later task.
  // The bus/types only need to support the shape today.
  'run.status.changed': RunStatusChangedPayload;
  'judgment.completed': JudgmentCompletedPayload;
}

export type RealtimeEventName = keyof RealtimeEventMap;

/** What a publisher hands to `publishEvent()` — pre-id, pre-timestamp. */
export interface RealtimeEvent<TName extends RealtimeEventName = RealtimeEventName> {
  type: TName;
  payload: RealtimeEventMap[TName];
}

/**
 * What a subscriber/SSE client receives. `id` is the monotonic Redis Stream
 * entry id assigned at publish time (`rt:stream:{topic}`'s XADD result) —
 * it's what the SSE endpoint sends as the `id:` field and what a
 * reconnecting client's `Last-Event-ID` resumes from via XRANGE.
 */
export interface RealtimeEnvelope<TName extends RealtimeEventName = RealtimeEventName> {
  id: string;
  type: TName;
  timestamp: string;
  payload: RealtimeEventMap[TName];
}

export type RealtimeListener = (event: RealtimeEnvelope) => void;

/** Topic a user's own SSE connection always subscribes to. */
export function userTopic(userId: string): string {
  return `user:${userId}`;
}

/** Topic for a single evaluation run — subscribed only after an ownership check. */
export function runTopic(runId: string): string {
  return `run:${runId}`;
}
