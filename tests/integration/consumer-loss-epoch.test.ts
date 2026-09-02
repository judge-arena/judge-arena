/**
 * ─── Consumer-loss epoch: what a reconnect restores, against a REAL broker ──
 *
 * The fail-fast policy (src/worker/health.ts createConsumerLossPolicy) rests
 * on one claim about src/lib/queue/connection.ts: after a socket loss the
 * reconnect loop brings back a connection, a confirm channel and the
 * topology, and NOTHING consumes. This file pins that claim with amqplib's
 * real event sequence instead of the EventEmitter fakes in
 * tests/lib/worker-health.test.ts, and pins the third loss route — a broker
 * basic.cancel arriving as a null message — the same way.
 *
 * It does NOT assert `process.exit`. A real exit kills the vitest worker, and
 * the exit is unit-tested with an injected `exit` in worker-health.test.ts.
 * CONTRIBUTING.md used to prescribe "kill the connection under a live
 * consumer and assert delivery resumes"; that assumed an in-process
 * re-consume. Under fail-fast, delivery resumes in a NEW process, which no
 * in-process test can observe. This is the half a test can show.
 *
 * THE INJECTION IS `stream.destroy(new Error(...))`, NOT `stream.destroy()`.
 * After the handshake amqplib listens for 'error' and 'end' on the socket
 * (node_modules/amqplib/lib/connection.js, `succeed()` inside `open`) and
 * has no 'close' listener. A bare destroy() emits only 'close', so amqplib
 * would notice nothing until the heartbeat timer missed two intervals —
 * ~120 s at RabbitMQ's default 60 s heartbeat, far past any test timeout.
 * Passing an Error emits 'error' -> onSocketError -> conn 'error' -> every
 * channel 'close' -> conn 'close', which is what a real ECONNRESET looks
 * like.
 *
 * Integration suite — needs the podman `judge-arena-rabbitmq` container
 * (.env.test's RABBITMQ_URL) and NO other consumer on run.create (a locally
 * running `npm run worker` fails the broker-side assertion, as it would fail
 * queue.test.ts's consumeOne). Run via `npm run test:integration`. Serialized
 * with the rest of tests/integration by fileParallelism:false, and each file
 * gets its own module registry, so connection.ts's singletons start fresh
 * here.
 */

import type { Socket } from 'node:net';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { closeRabbit, getConnectionState, getRabbit } from '@/lib/queue/connection';
import { QUEUE_RUN_CREATE } from '@/lib/queue/topology';
import { createConsumerRegistry, trackConsumerRegistration } from '@/worker/health';

afterAll(async () => {
  await closeRabbit();
});

describe('consumer-loss epoch (real broker)', () => {
  it('a socket loss clears the registry, and the reconnect that follows restores ZERO consumers', async () => {
    const { conn, confirmChannel } = await getRabbit();
    const before = getConnectionState();
    expect(before.connected).toBe(true);
    expect(before.reconnectScheduled).toBe(false);

    // Wired the way main.ts wires the shared confirm channel. The default
    // no-op onLost stands in for the policy — see the module doc.
    const registry = createConsumerRegistry();
    trackConsumerRegistration(registry, { conn, channel: confirmChannel }, [QUEUE_RUN_CREATE]);
    const { consumerTag } = await confirmChannel.consume(QUEUE_RUN_CREATE, () => {}, {
      noAck: false,
    });
    registry.register(QUEUE_RUN_CREATE, consumerTag);
    expect(registry.registered()).toBe(1);

    const closed = new Promise<void>((resolve) => conn.once('close', () => resolve()));
    // ChannelModel.connection is amqplib's raw Connection; .stream is the socket.
    const socket = (conn as unknown as { connection: { stream: Socket } }).connection.stream;
    socket.destroy(new Error('injected: socket loss under a live consumer'));
    await closed;

    // What the detector sees ...
    expect(registry.registered()).toBe(0);
    expect(registry.missing([QUEUE_RUN_CREATE])).toEqual([QUEUE_RUN_CREATE]);
    // ... and what connection.ts does about it: a reconnect, nothing more.
    const lost = getConnectionState();
    expect(lost.connected).toBe(false);
    expect(lost.reconnectScheduled).toBe(true);

    const next = await getRabbit();
    expect(next.conn).not.toBe(conn);
    expect(next.confirmChannel).not.toBe(confirmChannel);
    expect(getConnectionState()).toEqual({
      connected: true,
      reconnectScheduled: false,
      connectAttempts: before.connectAttempts + 1,
    });

    // The broker agrees: nobody consumes run.create in the new epoch. Polled
    // briefly because the broker tears the old connection down asynchronously
    // after the TCP reset. This is the five-day shape, and the reason the
    // worker exits instead of waiting here.
    await vi.waitFor(
      async () => {
        const { consumerCount } = await next.confirmChannel.checkQueue(QUEUE_RUN_CREATE);
        expect(consumerCount).toBe(0);
      },
      { timeout: 3000, interval: 100 }
    );
  });

  it('a broker-side basic.cancel reaches the consume callback as null — the route main.ts turns into unregister()', async () => {
    const { confirmChannel } = await getRabbit();
    const queue = `test.consumer-loss.cancel.${Date.now()}`;
    await confirmChannel.assertQueue(queue, { durable: false, autoDelete: false });

    let report: (loss: { reason: string; remaining: number }) => void = () => {};
    const reported = new Promise<{ reason: string; remaining: number }>((resolve) => {
      report = resolve;
    });
    const registry = createConsumerRegistry((reason, remaining) => report({ reason, remaining }));
    const { consumerTag } = await confirmChannel.consume(
      queue,
      (msg) => {
        // The shape of main.ts's null-message branch: null is the broker
        // saying "gone", not "idle".
        if (!msg) registry.unregister(queue, 'broker cancelled the consumer');
      },
      { noAck: false }
    );
    registry.register(queue, consumerTag);
    expect(registry.registered()).toBe(1);

    // Deleting a queue out from under its consumer is how a broker cancels
    // one (consumer_cancel_notify, which amqplib advertises); on a lane the
    // same frame arrives on x-single-active-consumer failover.
    await confirmChannel.deleteQueue(queue);

    await expect(reported).resolves.toEqual({
      reason: 'broker cancelled the consumer',
      remaining: 0,
    });
    expect(registry.registered()).toBe(0);
  });
});
