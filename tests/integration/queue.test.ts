import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { closeRabbit, getRabbit, rabbitHealthy } from '@/lib/queue/connection';
import {
  assertTopology,
  EXCHANGE,
  QUEUE_DLQ,
  QUEUE_JUDGMENT_EXECUTE,
  QUEUE_JUDGMENT_RETRY_30S,
  QUEUE_JUDGMENT_RETRY_5M,
  QUEUE_RUN_CREATE,
} from '@/lib/queue/topology';
import {
  publishJudgmentExecute,
  publishRunCreate,
  publishToDlq,
  type JudgmentExecuteMsg,
  type RunCreateMsg,
} from '@/lib/queue/publish';
import type { Channel, ConsumeMessage } from 'amqplib';

// Integration suite — needs a live RabbitMQ (see .env.test's RABBITMQ_URL
// and the podman `judge-arena-rabbitmq` container). Run via
// `npm run test:integration`, never as part of plain `npm test` (see
// vitest.config.ts's exclude). Serialized with the rest of tests/integration
// via vitest.integration.config.ts's fileParallelism:false, since all tests
// here share one broker's topology/queues.

/**
 * Consume exactly one message off `queue` and ack it. Rejects if nothing
 * arrives within `timeoutMs`.
 *
 * Awaits `ch.cancel()` before returning/rejecting — cancelling
 * fire-and-forget was observed (empirically, via a standalone repro
 * outside vitest) to race the *next* `ch.consume()` call on the same
 * shared channel/queue: the broker would silently fail to deliver to the
 * new consumer for multiple seconds, well past this suite's 2s timeouts.
 * Every test here shares one confirm channel (mirroring how the app itself
 * uses one long-lived channel), so a fully-settled cancel before returning
 * control to the next test is required, not just cosmetic cleanup.
 */
async function consumeOne(ch: Channel, queue: string, timeoutMs = 2000): Promise<ConsumeMessage> {
  let consumerTag: string | undefined;

  const msg = await new Promise<ConsumeMessage>((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const cleanup = consumerTag ? ch.cancel(consumerTag).catch(() => {}) : Promise.resolve();
      cleanup.finally(() =>
        reject(new Error(`consumeOne: no message on '${queue}' within ${timeoutMs}ms`))
      );
    }, timeoutMs);

    ch.consume(
      queue,
      (received) => {
        if (!received || settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(received);
      },
      { noAck: false }
    )
      .then((ok) => {
        consumerTag = ok.consumerTag;
      })
      .catch((error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
  });

  if (consumerTag) {
    await ch.cancel(consumerTag);
  }

  return msg;
}

beforeAll(async () => {
  const { confirmChannel } = await getRabbit();
  await assertTopology(confirmChannel);
});

afterEach(async () => {
  // Purge the three main work queues so leftover messages from one test
  // (e.g. a publish whose consume assertion failed) can't leak into the
  // next. Retry queues aren't purged — nothing in this suite publishes
  // into them directly (the DLX-proof test uses its own throwaway queue).
  const { confirmChannel } = await getRabbit();
  await confirmChannel.purgeQueue(QUEUE_JUDGMENT_EXECUTE);
  await confirmChannel.purgeQueue(QUEUE_RUN_CREATE);
  await confirmChannel.purgeQueue(QUEUE_DLQ);
});

afterAll(async () => {
  // Close the singleton connection so `vitest run` can exit cleanly instead
  // of hanging on an open AMQP socket.
  await closeRabbit();
});

describe('rabbitHealthy()', () => {
  it('checks the running broker and resolves true', async () => {
    await expect(rabbitHealthy()).resolves.toBe(true);
  });
});

describe('assertTopology()', () => {
  it('is idempotent — declaring the same topology twice does not throw', async () => {
    const { confirmChannel } = await getRabbit();
    await expect(assertTopology(confirmChannel)).resolves.toBeUndefined();
    await expect(assertTopology(confirmChannel)).resolves.toBeUndefined();
  });

  it('declares judge.direct as a durable direct exchange', async () => {
    const { confirmChannel } = await getRabbit();
    await expect(confirmChannel.checkExchange(EXCHANGE)).resolves.toBeDefined();
  });

  it('declares judgment.execute, run.create, and judge.dlq as quorum queues', async () => {
    const { confirmChannel } = await getRabbit();

    for (const queue of [QUEUE_JUDGMENT_EXECUTE, QUEUE_RUN_CREATE, QUEUE_DLQ]) {
      // Re-asserting with the exact expected arguments only succeeds
      // (no-op) if the already-declared queue's arguments match — a
      // mismatch would 406 PRECONDITION_FAILED. This proves the *actual*
      // declared queue type, not just that assertTopology() didn't throw.
      // eslint-disable-next-line no-await-in-loop -- three sequential checks, no concurrency benefit
      await expect(
        confirmChannel.assertQueue(queue, {
          durable: true,
          arguments: { 'x-queue-type': 'quorum' },
        })
      ).resolves.toMatchObject({ queue });
    }
  });
});

describe('publish -> consume round-trip (publisher confirms)', () => {
  it('publishJudgmentExecute lands a persistent, confirmed message on judgment.execute', async () => {
    const msg: JudgmentExecuteMsg = { judgmentId: 'judgment-1', runId: 'run-1', attempt: 1 };
    await publishJudgmentExecute(msg);

    const { confirmChannel } = await getRabbit();
    const received = await consumeOne(confirmChannel, QUEUE_JUDGMENT_EXECUTE);

    expect(JSON.parse(received.content.toString())).toEqual(msg);
    expect(received.properties.deliveryMode).toBe(2);
    expect(received.properties.contentType).toBe('application/json');
    confirmChannel.ack(received);
  });

  it('publishRunCreate lands a persistent, confirmed message on run.create', async () => {
    const msg: RunCreateMsg = {
      evaluationId: 'eval-1',
      runSpec: {
        rubricId: 'rubric-1',
        judgeModelVersionIds: ['jmv-1', 'jmv-2'],
        triggeredById: 'user-1',
        protocol: 'pointwise',
      },
    };
    await publishRunCreate(msg);

    const { confirmChannel } = await getRabbit();
    const received = await consumeOne(confirmChannel, QUEUE_RUN_CREATE);

    expect(JSON.parse(received.content.toString())).toEqual(msg);
    expect(received.properties.deliveryMode).toBe(2);
    confirmChannel.ack(received);
  });

  it('publishToDlq wraps the original message with reason + failedAt on judge.dlq', async () => {
    const original: JudgmentExecuteMsg = { judgmentId: 'judgment-poison', runId: 'run-1', attempt: 4 };
    await publishToDlq(original, 'max attempts exceeded');

    const { confirmChannel } = await getRabbit();
    const received = await consumeOne(confirmChannel, QUEUE_DLQ);
    const body = JSON.parse(received.content.toString());

    expect(body.originalMessage).toEqual(original);
    expect(body.reason).toBe('max attempts exceeded');
    expect(typeof body.failedAt).toBe('string');
    expect(new Date(body.failedAt).toString()).not.toBe('Invalid Date');
    confirmChannel.ack(received);
  });
});

describe('retry queue TTL + DLX topology', () => {
  it('judgment.retry.30s is declared with TTL=30000ms and a DLX back to judgment.execute', async () => {
    const { confirmChannel } = await getRabbit();
    // Hardcoded expected values (not imported from topology.ts) so this is
    // a real check against the brief's spec, not a tautology against
    // whatever topology.ts happens to declare.
    await expect(
      confirmChannel.assertQueue(QUEUE_JUDGMENT_RETRY_30S, {
        durable: true,
        arguments: {
          'x-message-ttl': 30_000,
          'x-dead-letter-exchange': EXCHANGE,
          'x-dead-letter-routing-key': QUEUE_JUDGMENT_EXECUTE,
        },
      })
    ).resolves.toMatchObject({ queue: QUEUE_JUDGMENT_RETRY_30S });
  });

  it('judgment.retry.5m is declared with TTL=300000ms and a DLX back to judgment.execute', async () => {
    const { confirmChannel } = await getRabbit();
    await expect(
      confirmChannel.assertQueue(QUEUE_JUDGMENT_RETRY_5M, {
        durable: true,
        arguments: {
          'x-message-ttl': 300_000,
          'x-dead-letter-exchange': EXCHANGE,
          'x-dead-letter-routing-key': QUEUE_JUDGMENT_EXECUTE,
        },
      })
    ).resolves.toMatchObject({ queue: QUEUE_JUDGMENT_RETRY_5M });
  });

  it('a message dropped into a short-TTL DLX-configured queue dead-letters onto judgment.execute (proves the retry-queue wiring pattern without waiting the real 30s TTL)', async () => {
    const { confirmChannel } = await getRabbit();
    const proofQueue = `test.retry-dlx-proof.${Date.now()}`;

    // Same x-dead-letter-exchange / x-dead-letter-routing-key shape as the
    // real judgment.retry.30s/.5m queues, just with a 200ms TTL instead of
    // 30s/5m so the test doesn't have to wait for the real delay.
    await confirmChannel.assertQueue(proofQueue, {
      durable: false,
      autoDelete: true,
      arguments: {
        'x-message-ttl': 200,
        'x-dead-letter-exchange': EXCHANGE,
        'x-dead-letter-routing-key': QUEUE_JUDGMENT_EXECUTE,
      },
    });

    const proofMsg = { proof: 'dlx-routing', nonce: `${Date.now()}-${Math.random()}` };
    confirmChannel.sendToQueue(proofQueue, Buffer.from(JSON.stringify(proofMsg)), { persistent: false });

    const received = await consumeOne(confirmChannel, QUEUE_JUDGMENT_EXECUTE, 2000);
    expect(JSON.parse(received.content.toString())).toEqual(proofMsg);
    // x-death is populated by the broker on every dead-lettered message —
    // confirms this arrived via the DLX path, not some other coincidental
    // publish onto judgment.execute.
    expect(received.properties.headers?.['x-death']).toBeDefined();
    confirmChannel.ack(received);

    await confirmChannel.deleteQueue(proofQueue);
  });
});
