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
import { EXCHANGE, QUEUE_DLQ, QUEUE_JUDGMENT_EXECUTE, QUEUE_RUN_CREATE } from './topology';
import type { ConfirmChannel } from 'amqplib';

export interface JudgmentExecuteMsg {
  judgmentId: string;
  runId: string;
  attempt: number;
}

export interface RunCreateMsg {
  evaluationId: string;
  runSpec: {
    rubricId?: string;
    judgeModelVersionIds: string[];
    triggeredById: string;
    protocol: 'pointwise';
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

/** Publish a judgment for execution — consumed off `judgment.execute`. */
export async function publishJudgmentExecute(msg: JudgmentExecuteMsg): Promise<void> {
  const { confirmChannel } = await getRabbit();
  await publishConfirmed(confirmChannel, EXCHANGE, QUEUE_JUDGMENT_EXECUTE, msg);
}

/** Publish a run-creation request — consumed off `run.create`. */
export async function publishRunCreate(msg: RunCreateMsg): Promise<void> {
  const { confirmChannel } = await getRabbit();
  await publishConfirmed(confirmChannel, EXCHANGE, QUEUE_RUN_CREATE, msg);
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
