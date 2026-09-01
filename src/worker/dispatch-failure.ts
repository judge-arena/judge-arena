/**
 * ─── Dispatch-Level Failure Routing ─────────────────────────────────────────
 *
 * Decision logic for `main.ts`'s `dispatch()` wrapper — what to do when a
 * consumer's `handle()` throws instead of completing its own claim/ack/
 * retry/DLQ disposition. Pulled out of `main.ts` (rather than left as an
 * unexported closure) so it can be unit-tested with a mocked `Channel` and
 * an injected `publishJudgmentRetry30s`, without booting the real worker
 * (`main.ts` calls `main()` at module scope, which opens a live RabbitMQ
 * connection — importing it for its side effects alone would be wrong for
 * a unit test).
 *
 * First failure on a given delivery (`raw.fields.redelivered === false`):
 * plain nack-requeue, same as before this task — gives a one-off transient
 * blip (a dropped DB connection that immediately reconnects) the benefit of
 * the doubt with an immediate retry.
 *
 * Second+ failure on the SAME message (`raw.fields.redelivered === true` —
 * this delivery is already a requeue of a previously-unacked message): a
 * bare nack-requeue here would just loop it back to this same consumer at
 * full speed (RabbitMQ's requeue-on-nack has no delay), spinning tight on
 * whatever's actually broken instead of backing off. For JUDGMENT messages
 * specifically, route onto a 30s retry holding queue instead — same
 * TTL-then-dead-letter mechanism `judgment-consumer.ts`'s own retryable-error
 * disposition uses, just entered from a different failure surface (a
 * dispatch-level throw, not a classified provider error). This is bounded
 * because the message keeps its original `attempt` field: once it's back on a
 * judgment queue and the handler runs successfully enough to reach its own
 * disposition logic, `judgment-consumer.ts`'s `effectiveAttempt` cap
 * (`MAX_ATTEMPTS`) still applies on that subsequent attempt, so a truly poison
 * message still eventually reaches the DLQ rather than retrying forever — this
 * dispatch-level guard only adds a delay before that normal cap-driven path
 * gets another chance to run. `run.create` messages have no equivalent
 * retry queue (their handler already swallows its own errors per its own
 * module doc — this whole catch is already the rare "shouldn't happen" case
 * for them), so they always fall through to the plain nack-requeue below
 * regardless of `redelivered`.
 *
 * ── "JUDGMENT MESSAGES" IS NO LONGER ONE QUEUE NAME ─────────────────────────
 * This module used to ask `queueName === QUEUE_JUDGMENT_EXECUTE`. With eight
 * lane queues (src/lib/queue/lanes.ts) that equality is FALSE for essentially
 * all judgment traffic, and false in the silent direction: every repeatedly
 * failing laned judgment would have been downgraded from "hold for 30s, then
 * try again" to "nack-requeue immediately", spinning at full speed on whatever
 * is broken — the exact behaviour the redelivered branch exists to prevent,
 * reintroduced by a string comparison that still reads correctly. `isJudgmentQueue`
 * (./concurrency.ts) is the membership test that replaces it.
 *
 * And the retry must go back to the lane it came from, or a judgment that
 * failed once stops being serialized against its own inference server. The lane
 * is `raw.fields.routingKey` — what the broker actually routed on — passed to
 * the injected publisher rather than recomputed from the database.
 */

import type { Channel, ConsumeMessage } from 'amqplib';
import type { JudgmentExecuteMsg } from '@/lib/queue/publish';
import { logger, serializeError } from '@/lib/logger';
import { isJudgmentQueue, laneOfDelivery } from './concurrency';

/** Constructor-injected seam so `handleDispatchFailure` never imports
 * `@/lib/queue/publish` (and transitively `@/lib/queue/connection`) itself —
 * tests inject a fake to assert routing decisions without a live RabbitMQ
 * connection. `main.ts` passes a lane-aware wrapper around the real publishers
 * (`publishJudgmentRetryPreservingLane`).
 *
 * `lane` is OMITTED, not passed as `undefined`, when the delivery did not
 * arrive on a lane — so the legacy call shape is byte-identical to what it was
 * before lanes, and a fake that only accepts one argument still sees one. */
export interface DispatchFailureDeps {
  publishJudgmentRetry30s: (msg: JudgmentExecuteMsg, lane?: string) => Promise<void>;
}

/**
 * Decide (and carry out) the ack/nack/retry-publish disposition for a
 * consumer handler that threw. See module doc for the full redelivered /
 * queue-specific reasoning. Behavior:
 *
 * - `isJudgmentQueue(queueName)` (a lane or the fallback) AND
 *   `raw.fields.redelivered`: parse `raw`'s body as a `JudgmentExecuteMsg`,
 *   publish it (attempt field untouched) onto a 30s retry hold via
 *   `deps.publishJudgmentRetry30s`, carrying the lane when there is one, then
 *   ack `raw`. If the parse or publish itself throws, falls through to the
 *   nack-requeue below instead of propagating.
 * - Everything else (first delivery, `run.create`, or the retry-routing
 *   attempt above itself failed): nack-requeue (`ch.nack(raw, false,
 *   true)`) — never drop the message silently.
 */
export async function handleDispatchFailure(
  ch: Channel,
  raw: ConsumeMessage,
  queueName: string,
  error: unknown,
  deps: DispatchFailureDeps
): Promise<void> {
  const lane = laneOfDelivery(raw.fields.routingKey);

  logger.error('unhandled consumer error', {
    queue: queueName,
    lane,
    redelivered: Boolean(raw.fields.redelivered),
    error: serializeError(error),
  });

  if (raw.fields.redelivered && isJudgmentQueue(queueName)) {
    try {
      const parsed = JSON.parse(raw.content.toString()) as JudgmentExecuteMsg;
      // Two call shapes on purpose, not `publish(parsed, lane ?? undefined)`:
      // a delivery with no lane must reach the publisher exactly as it did
      // before lanes existed, so the legacy path cannot start behaving
      // differently because an extra `undefined` showed up in its arguments.
      if (lane) await deps.publishJudgmentRetry30s(parsed, lane);
      else await deps.publishJudgmentRetry30s(parsed);
      ch.ack(raw);
      return;
    } catch (routeError) {
      logger.error(
        'dispatch: failed to route a repeatedly-failing judgment message to the 30s retry hold — falling back to nack-requeue',
        { queue: queueName, lane, error: serializeError(routeError) }
      );
    }
  }

  // First failure on this delivery, a run.create message, or the
  // retry-queue routing attempt above itself failed — nack-requeue so
  // the message isn't lost; never drop it silently.
  ch.nack(raw, false, true);
}
