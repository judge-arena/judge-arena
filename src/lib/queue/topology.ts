/**
 * ─── RabbitMQ Topology ────────────────────────────────────────────────────
 *
 * Declares judge-arena's queue topology: one direct exchange, three quorum
 * queues (replicated, crash-safe — the actual work queues), and two classic
 * TTL+dead-letter "retry" queues that hold a failed judgment for a fixed
 * delay before it dead-letters back onto `judgment.execute` for another
 * attempt.
 *
 *   judge.direct (exchange, direct, durable)
 *     ├─ judgment.execute        (quorum)  — routing key: judgment.execute
 *     ├─ run.create              (quorum)  — routing key: run.create
 *     ├─ judge.dlq               (quorum)  — routing key: judge.dlq
 *     ├─ judgment.retry.30s      (classic) — routing key: judgment.retry.30s
 *     │    TTL 30s -> dead-letters to judge.direct/judgment.execute
 *     └─ judgment.retry.5m       (classic) — routing key: judgment.retry.5m
 *          TTL 5m  -> dead-letters to judge.direct/judgment.execute
 *
 * Every queue is bound to `judge.direct` with a routing key equal to its
 * own name, so a producer (or a worker re-publishing a failed judgment onto
 * a retry queue) always publishes through the exchange with
 * `routingKey = <target queue name>`, never `sendToQueue` directly — one
 * uniform publish path regardless of destination.
 *
 * Retry queues are intentionally classic, not quorum: `x-message-ttl` +
 * `x-dead-letter-exchange` are supported on quorum queues too as of newer
 * RabbitMQ, but the retry queues here are pure short-lived TTL holding
 * pens with no consumer of their own — durability semantics that matter
 * (crash-safety, replication) belong on the queues judgments are actually
 * consumed from and dead-lettered back onto, not on the holding pen.
 */

import type { Channel } from 'amqplib';

export const EXCHANGE = 'judge.direct';

export const QUEUE_JUDGMENT_EXECUTE = 'judgment.execute';
export const QUEUE_RUN_CREATE = 'run.create';
export const QUEUE_JUDGMENT_RETRY_30S = 'judgment.retry.30s';
export const QUEUE_JUDGMENT_RETRY_5M = 'judgment.retry.5m';
export const QUEUE_DLQ = 'judge.dlq';

const RETRY_30S_TTL_MS = 30_000;
const RETRY_5M_TTL_MS = 300_000;

/**
 * Idempotently declare the full topology described above. All `assert*`
 * calls are idempotent per the AMQP spec — re-declaring an existing
 * exchange/queue with identical arguments is a no-op; only a conflicting
 * re-declare with *different* arguments errors (406 PRECONDITION_FAILED,
 * closing the channel). Safe to call on every process boot and repeatedly
 * from tests.
 */
export async function assertTopology(ch: Channel): Promise<void> {
  await ch.assertExchange(EXCHANGE, 'direct', { durable: true });

  const quorumQueues = [QUEUE_JUDGMENT_EXECUTE, QUEUE_RUN_CREATE, QUEUE_DLQ];
  for (const queue of quorumQueues) {
    // eslint-disable-next-line no-await-in-loop -- sequential declare of three queues at boot/test-setup; no concurrency benefit worth the complexity
    await ch.assertQueue(queue, {
      durable: true,
      arguments: { 'x-queue-type': 'quorum' },
    });
    // eslint-disable-next-line no-await-in-loop
    await ch.bindQueue(queue, EXCHANGE, queue);
  }

  await ch.assertQueue(QUEUE_JUDGMENT_RETRY_30S, {
    durable: true,
    arguments: {
      'x-message-ttl': RETRY_30S_TTL_MS,
      'x-dead-letter-exchange': EXCHANGE,
      'x-dead-letter-routing-key': QUEUE_JUDGMENT_EXECUTE,
    },
  });
  await ch.bindQueue(QUEUE_JUDGMENT_RETRY_30S, EXCHANGE, QUEUE_JUDGMENT_RETRY_30S);

  await ch.assertQueue(QUEUE_JUDGMENT_RETRY_5M, {
    durable: true,
    arguments: {
      'x-message-ttl': RETRY_5M_TTL_MS,
      'x-dead-letter-exchange': EXCHANGE,
      'x-dead-letter-routing-key': QUEUE_JUDGMENT_EXECUTE,
    },
  });
  await ch.bindQueue(QUEUE_JUDGMENT_RETRY_5M, EXCHANGE, QUEUE_JUDGMENT_RETRY_5M);
}
