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
 * whatever's actually broken instead of backing off. For `judgment.execute`
 * messages specifically, route onto that queue's own 30s retry holding
 * queue instead — same TTL-then-dead-letter-back-onto-judgment.execute
 * mechanism `judgment-consumer.ts`'s own retryable-error disposition uses,
 * just entered from a different failure surface (a dispatch-level throw,
 * not a classified provider error). This is bounded because the message
 * keeps its original `attempt` field: once it's back on `judgment.execute`
 * and the handler runs successfully enough to reach its own disposition
 * logic, `judgment-consumer.ts`'s `effectiveAttempt` cap (`MAX_ATTEMPTS`)
 * still applies on that subsequent attempt, so a truly poison message still
 * eventually reaches the DLQ rather than retrying forever — this
 * dispatch-level guard only adds a delay before that normal cap-driven path
 * gets another chance to run. `run.create` messages have no equivalent
 * retry queue (their handler already swallows its own errors per its own
 * module doc — this whole catch is already the rare "shouldn't happen" case
 * for them), so they always fall through to the plain nack-requeue below
 * regardless of `redelivered`.
 */

import type { Channel, ConsumeMessage } from 'amqplib';
import { QUEUE_JUDGMENT_EXECUTE } from '@/lib/queue/topology';
import type { JudgmentExecuteMsg } from '@/lib/queue/publish';
import { logger, serializeError } from '@/lib/logger';

/** Constructor-injected seam so `handleDispatchFailure` never imports
 * `@/lib/queue/publish` (and transitively `@/lib/queue/connection`) itself —
 * tests inject a fake to assert routing decisions without a live RabbitMQ
 * connection. `main.ts` passes the real `publishJudgmentRetry30s`. */
export interface DispatchFailureDeps {
  publishJudgmentRetry30s: (msg: JudgmentExecuteMsg) => Promise<void>;
}

/**
 * Decide (and carry out) the ack/nack/retry-publish disposition for a
 * consumer handler that threw. See module doc for the full redelivered /
 * queue-specific reasoning. Behavior:
 *
 * - `queueName === QUEUE_JUDGMENT_EXECUTE` AND `raw.fields.redelivered`:
 *   parse `raw`'s body as a `JudgmentExecuteMsg`, publish it (attempt
 *   field untouched) onto `judgment.retry.30s` via
 *   `deps.publishJudgmentRetry30s`, then ack `raw`. If the parse or publish
 *   itself throws, falls through to the nack-requeue below instead of
 *   propagating.
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
  logger.error('unhandled consumer error', {
    queue: queueName,
    redelivered: Boolean(raw.fields.redelivered),
    error: serializeError(error),
  });

  if (raw.fields.redelivered && queueName === QUEUE_JUDGMENT_EXECUTE) {
    try {
      const parsed = JSON.parse(raw.content.toString()) as JudgmentExecuteMsg;
      await deps.publishJudgmentRetry30s(parsed);
      ch.ack(raw);
      return;
    } catch (routeError) {
      logger.error(
        'dispatch: failed to route a repeatedly-failing judgment.execute message to judgment.retry.30s — falling back to nack-requeue',
        { error: serializeError(routeError) }
      );
    }
  }

  // First failure on this delivery, a run.create message, or the
  // retry-queue routing attempt above itself failed — nack-requeue so
  // the message isn't lost; never drop it silently.
  ch.nack(raw, false, true);
}
