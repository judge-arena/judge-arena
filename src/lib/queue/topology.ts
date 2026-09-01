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
import { LANE_QUEUES } from './lanes';

export const EXCHANGE = 'judge.direct';

export const QUEUE_JUDGMENT_EXECUTE = 'judgment.execute';
export const QUEUE_RUN_CREATE = 'run.create';
export const QUEUE_JUDGMENT_RETRY_30S = 'judgment.retry.30s';
export const QUEUE_JUDGMENT_RETRY_5M = 'judgment.retry.5m';
export const QUEUE_DLQ = 'judge.dlq';

/**
 * Fanout exchanges used ONLY as delay hops for lane-preserving retries.
 *
 * A retry has to come back to the SAME lane it left, or a judgment that failed
 * once stops being serialized against its own server. The existing retry queues
 * cannot do that: they pin `x-dead-letter-routing-key` to `judgment.execute`,
 * so everything they release lands on the fallback queue.
 *
 * RabbitMQ preserves a message's ORIGINAL routing key when dead-lettering only
 * if `x-dead-letter-routing-key` is absent. But publishing INTO a retry queue
 * through `judge.direct` (the invariant this file's header describes: routing
 * key == destination queue name) would make the retry queue's own name the
 * routing key, and dead-lettering would then send it straight back to itself.
 *
 * A FANOUT breaks that: routing key is ignored for routing but carried on the
 * message. So the worker publishes to `judge.delay.30s` with the LANE queue as
 * the routing key, the fanout delivers it to the v2 retry queue regardless, the
 * TTL expires, and the message dead-letters to `judge.direct` under the lane
 * routing key it has carried the whole time — landing on its own lane.
 */
export const EXCHANGE_DELAY_30S = 'judge.delay.30s';
export const EXCHANGE_DELAY_5M = 'judge.delay.5m';

/**
 * Lane-preserving retry queues. `.v2` because the originals cannot be amended:
 * re-declaring a queue with different arguments is a 406 that closes the
 * channel (see this file's `assertTopology` doc). The originals are left
 * untouched and keep draining whatever is already in them.
 */
export const QUEUE_JUDGMENT_RETRY_30S_V2 = 'judgment.retry.30s.v2';
export const QUEUE_JUDGMENT_RETRY_5M_V2 = 'judgment.retry.5m.v2';

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

  // ── Lane queues (v2j) ─────────────────────────────────────────────────────
  // One per serialization domain slot; see src/lib/queue/lanes.ts for why the
  // domain is the SERVER and not the model. Same quorum settings and the same
  // routing-key-equals-own-name binding as every other work queue, so nothing
  // about the publish path changes — only the destination.
  //
  // `x-single-active-consumer` is what makes a lane serial at the BROKER,
  // rather than by agreement among consumers: even if a second worker replica
  // appears, exactly one consumer receives from a given lane. That is the
  // property the previous in-process gate could not provide, and it is why
  // this design survives `worker.replicas > 1` where the gate silently would
  // not have.
  for (const lane of LANE_QUEUES) {
    // eslint-disable-next-line no-await-in-loop -- sequential declare at boot; see the loop above
    await ch.assertQueue(lane, {
      durable: true,
      arguments: { 'x-queue-type': 'quorum', 'x-single-active-consumer': true },
    });
    // eslint-disable-next-line no-await-in-loop
    await ch.bindQueue(lane, EXCHANGE, lane);
  }

  // Delay hops. Fanout so the routing key survives to the dead-letter, and the
  // v2 retry queues deliberately OMIT `x-dead-letter-routing-key` so RabbitMQ
  // preserves the lane the message came from.
  for (const [exchange, queue, ttl] of [
    [EXCHANGE_DELAY_30S, QUEUE_JUDGMENT_RETRY_30S_V2, RETRY_30S_TTL_MS],
    [EXCHANGE_DELAY_5M, QUEUE_JUDGMENT_RETRY_5M_V2, RETRY_5M_TTL_MS],
  ] as const) {
    // eslint-disable-next-line no-await-in-loop
    await ch.assertExchange(exchange, 'fanout', { durable: true });
    // eslint-disable-next-line no-await-in-loop
    await ch.assertQueue(queue, {
      durable: true,
      arguments: {
        'x-message-ttl': ttl,
        'x-dead-letter-exchange': EXCHANGE,
        // NO x-dead-letter-routing-key — that omission IS the mechanism.
      },
    });
    // eslint-disable-next-line no-await-in-loop
    await ch.bindQueue(queue, exchange, '');
  }
}
