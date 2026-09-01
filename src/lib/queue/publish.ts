/**
 * ─── RabbitMQ Publishers ──────────────────────────────────────────────────
 *
 * Typed, publisher-confirmed producers for judge-arena's queue messages.
 * Every message carries ids only — never credentials, prompt text, or
 * model responses — since the queue (and its management UI) is a wider
 * trust boundary than the app's own database.
 *
 * All publishes go through `getRabbit()`'s singleton confirm channel,
 * persistent delivery mode (survives a broker restart on the durable/
 * quorum queues `topology.ts` declares), and await the broker's per-message
 * ack/nack via the confirm-channel callback before resolving — a caller
 * that awaits `publishJudgmentExecute()` knows the broker has durably
 * accepted the message, not just that it was written to a socket buffer.
 */

import { getRabbit } from './connection';
import { LANE_FALLBACK_QUEUE, laneQueueFor } from './lanes';
import { logger, serializeError } from '@/lib/logger';
import {
  EXCHANGE,
  QUEUE_DLQ,
  QUEUE_JUDGMENT_RETRY_30S,
  QUEUE_JUDGMENT_RETRY_5M,
  QUEUE_RUN_CREATE,
} from './topology';
import type { ConfirmChannel } from 'amqplib';
import type { RunProtocol } from '@prisma/client';

export interface JudgmentExecuteMsg {
  judgmentId: string;
  runId: string;
  attempt: number;
}

export interface RunCreateMsg {
  evaluationId: string;
  runSpec: {
    rubricId?: string;
    /**
     * One entry per selected model. `judgeModelVersionId` is the identity
     * `run-create-consumer.ts` actually creates `ModelJudgment`/
     * `RunModelSelection` rows against — the ONLY field the worker's
     * judgment-consumer executes on. `modelConfigId` is Task 12's legacy
     * dual-write field (see `src/lib/run-launch.ts`'s module doc): always
     * `null` for runs launched by the current write path, since nothing
     * derives a `ModelConfig` back-reference for a `JudgeModelVersion`
     * created via the catalog or a custom-model POST. Kept on the message
     * shape (rather than removed) so `ModelJudgment.modelConfigId` can still
     * be set for the rare case a future caller resolves one — see
     * run-create-consumer.ts's dedupe/write logic, which is keyed on
     * `judgeModelVersionId` (NOT `modelConfigId` — every entry can be `null`
     * now, so a `modelConfigId`-keyed `Map` would silently collapse them
     * all into one).
     */
    modelSelections: Array<{ judgeModelVersionId: string; modelConfigId: string | null }>;
    triggeredById: string;
    /**
     * A0: widened from the literal `'pointwise'` to the real enum.
     * `run-create-consumer.ts` already used this field for BOTH the
     * `EvaluationRun.protocol` column and its `resolveCurrentPromptTemplate`
     * lookup — the literal type was the only thing keeping either from
     * seeing a second protocol.
     *
     * Widened, NOT yet honoured: `run-create-consumer.ts` refuses every
     * value but `'pointwise'` (see its module doc), because this message
     * carries no candidate set for a pairwise expansion to compare. So the
     * `pairOrder` it writes is an unconditional NULL rather than something
     * derived from this field — the only writer that emits `'AB'` is
     * `run-launch.ts`'s `launchSingleRun`, which is also the only one that
     * writes the `RunCandidate` rows such a judgment needs.
     */
    protocol: RunProtocol;
  };
}

/**
 * Envelope written to `judge.dlq` by `publishToDlq()`. Keeps the original
 * (poison) message payload separate from failure metadata, rather than
 * mutating/spreading fields into it, so a DLQ consumer/operator can always
 * tell the two apart regardless of the original message's shape.
 */
export interface DlqEnvelope {
  originalMessage: unknown;
  reason: string;
  failedAt: string;
}

/**
 * Publish `message` (JSON-serialized) to `exchange`/`routingKey` on a
 * publisher-confirms channel, resolving once the broker acks it and
 * rejecting on nack or channel error. Persistent delivery mode (2) and
 * `application/json` content type on every message.
 */
async function publishConfirmed(
  ch: ConfirmChannel,
  exchange: string,
  routingKey: string,
  message: unknown
): Promise<void> {
  const content = Buffer.from(JSON.stringify(message));

  await new Promise<void>((resolve, reject) => {
    ch.publish(
      exchange,
      routingKey,
      content,
      { persistent: true, contentType: 'application/json' },
      (err) => {
        if (err) reject(err instanceof Error ? err : new Error(String(err)));
        else resolve();
      }
    );
  });
}

/**
 * Publish a judgment for execution.
 *
 * ── THE LANE RIDES THE ROUTING KEY, NOT THE MESSAGE ─────────────────────────
 * `JudgmentExecuteMsg` is deliberately UNCHANGED by lanes (v2j). Every queue in
 * `topology.ts` is bound with `routingKey == its own name`, so choosing a
 * destination is choosing a routing key and nothing else — which means a
 * message published by code that predates lanes (or one already sitting in a
 * queue when lanes deploy) still carries a routing key that is bound to a
 * queue somebody consumes. Putting the lane IN the payload would instead have
 * made every in-flight message unroutable-by-the-new-rules the moment it was
 * read by new code.
 *
 * `destinationQueue` defaults to `LANE_FALLBACK_QUEUE` — the original
 * `judgment.execute`, kept and consumed forever (see lanes.ts). So a caller
 * that does not know about lanes behaves EXACTLY as it did before: same
 * exchange, same routing key, same queue. Callers that can resolve a lane pass
 * one; callers that cannot must still pass the fallback rather than skipping
 * the publish, because losing lane isolation is a slowdown and losing the
 * publish is a lost judgment.
 */
export async function publishJudgmentExecute(
  msg: JudgmentExecuteMsg,
  destinationQueue: string = LANE_FALLBACK_QUEUE
): Promise<void> {
  const { confirmChannel } = await getRabbit();
  await publishConfirmed(confirmChannel, EXCHANGE, destinationQueue, msg);
}

/**
 * The destination queue for a judgment, resolved so that FAILING TO RESOLVE IT
 * CANNOT FAIL THE PUBLISH.
 *
 * `laneQueueFor` is documented as never throwing, and for the lane ARITHMETIC
 * that is true — but its body awaits `prisma.$executeRaw` and
 * `prisma.queueLane.findUnique` with no try/catch of its own, so a dropped
 * connection, an exhausted pool or a statement timeout propagates out of it.
 * At a publish site that would abort the loop and (in `launchSingleRun`)
 * compensate the whole run to `status: 'error'` — a lost run, caused by an
 * optimisation. Every caller therefore goes through this, never through
 * `laneQueueFor` directly.
 *
 * The fallback is the original `judgment.execute`, which is declared, bound and
 * consumed forever: landing there costs lane isolation (a performance
 * regression, visible as one lane's worth of serialization not happening) and
 * costs nothing else. That trade — degrade the routing, never drop the message
 * — is the whole failure posture of lanes.
 */
export async function resolveDestinationQueue(
  endpointUrl: string | null | undefined,
  judgeModelVersionId: string
): Promise<string> {
  try {
    return await laneQueueFor(endpointUrl, judgeModelVersionId);
  } catch (error) {
    logger.warn(
      'lane resolution failed — publishing to the fallback queue, which is consumed; ' +
        'this judgment loses lane isolation but is NOT lost',
      { judgeModelVersionId, error: serializeError(error) }
    );
    return LANE_FALLBACK_QUEUE;
  }
}

/** Publish a run-creation request — consumed off `run.create`. */
export async function publishRunCreate(msg: RunCreateMsg): Promise<void> {
  const { confirmChannel } = await getRabbit();
  await publishConfirmed(confirmChannel, EXCHANGE, QUEUE_RUN_CREATE, msg);
}

/**
 * Publish a judgment onto the 30s retry holding queue (Task 7's worker,
 * first retryable failure on a message's `attempt` 1 -> 2). The queue's own
 * `x-message-ttl` + `x-dead-letter-exchange`/`-routing-key` (see
 * topology.ts) redeliver it onto `judgment.execute` once the TTL elapses —
 * this function only ever puts the message on the holding queue, it never
 * touches `judgment.execute` directly.
 */
export async function publishJudgmentRetry30s(msg: JudgmentExecuteMsg): Promise<void> {
  const { confirmChannel } = await getRabbit();
  await publishConfirmed(confirmChannel, EXCHANGE, QUEUE_JUDGMENT_RETRY_30S, msg);
}

/**
 * Publish a judgment onto the 5m retry holding queue (Task 7's worker,
 * second retryable failure on attempt 2 -> 3, or any breaker-open failure
 * regardless of attempt — see judgment-consumer.ts's disposition logic).
 * Same dead-letter-back-onto-`judgment.execute` mechanism as
 * `publishJudgmentRetry30s`, just the longer-TTL queue.
 */
export async function publishJudgmentRetry5m(msg: JudgmentExecuteMsg): Promise<void> {
  const { confirmChannel } = await getRabbit();
  await publishConfirmed(confirmChannel, EXCHANGE, QUEUE_JUDGMENT_RETRY_5M, msg);
}

/**
 * Publish straight to the dead-letter queue, bypassing the retry queues
 * entirely. Used by workers (Task 7) once a judgment has exhausted its
 * retry budget ("poison message" cap) — there's no further retry queue
 * after this one, so it routes directly on `judge.dlq`'s own binding key
 * rather than relying on a queue-level TTL dead-letter chain.
 */
export async function publishToDlq(msg: unknown, reason: string): Promise<void> {
  const { confirmChannel } = await getRabbit();
  const envelope: DlqEnvelope = {
    originalMessage: msg,
    reason,
    failedAt: new Date().toISOString(),
  };
  await publishConfirmed(confirmChannel, EXCHANGE, QUEUE_DLQ, envelope);
}
