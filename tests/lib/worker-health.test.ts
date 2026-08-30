/**
 * ─── Worker /health: LIVE consumer registration ─────────────────────────────
 *
 * Regression suite for the 2026-08-24T17:55Z -> 2026-08-29 silent death. A
 * Postgres roll dropped the AMQP connection; the socket came back but
 * `confirmChannel.consume()` was never re-issued, so this worker held ZERO
 * consumers for five days. The pod stayed 1/1 Running with 0 restarts and
 * /health returned 200 the whole time, so nothing alerted and the evaluation
 * pipeline was dead in silence.
 *
 * The trap these tests exist to nail down: main.ts used to track consumers in
 * an append-only `consumerTags: string[]` that was never spliced on cancel or
 * on channel loss. Reporting `consumerTags.length` would have reported 2 for
 * all five days — a green health check for a dead worker. Every "lost"
 * assertion below is therefore written to FAIL against a boot-time count and
 * pass only against live registration state. See the injection note in
 * `registry counts LIVE registration, not boot-time history`.
 *
 * These exercise the exported unit (`createConsumerRegistry`,
 * `trackConsumerRegistration`, `evaluateWorkerHealth`) rather than a booted
 * worker: the http server, RabbitMQ and Postgres are all out of reach of a
 * DB-free `environment: 'node'` unit run.
 *
 * WHAT THIS FILE DOES NOT COVER, stated so nobody reads 20 green tests as
 * more assurance than they are: every call site inside `main()` — the
 * `trackConsumerRegistration(...)` wiring, the two `register()` calls after
 * `consume()`, the `unregister()` on a null message, the `beginDrain()`
 * placement before the cancel loop, and `startHealthServer(consumers)` —
 * is unreachable from here, because `main()` is a closure over a live AMQP
 * channel. Verified by injection: deleting the `trackConsumerRegistration`
 * call, deleting `register(QUEUE_RUN_CREATE, ...)`, and moving
 * `beginDrain()` after the cancels each leave all 20 of these GREEN while
 * shipping the original five-day blind spot. Closing that gap needs the
 * registration loop lifted out of `main()` into an injectable function the
 * way `handleDispatchFailure` already was (see src/worker/dispatch-failure.ts).
 */

import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { QUEUE_JUDGMENT_EXECUTE, QUEUE_RUN_CREATE } from '@/lib/queue/topology';
import {
  EXPECTED_CONSUMER_COUNT,
  createConsumerRegistry,
  evaluateWorkerHealth,
  trackConsumerRegistration,
  type ConsumerRegistry,
} from '@/worker/health';

// ─── Fixtures ───────────────────────────────────────────────────────────────

/** amqplib's promise-API `ConfirmChannel` and `ChannelModel` are both plain
 * EventEmitters as far as this fix is concerned — it only ever listens for
 * 'close'/'error'. See node_modules/amqplib/lib/channel_model.js. */
function fakeAmqp(): { conn: EventEmitter; channel: EventEmitter } {
  return { conn: new EventEmitter(), channel: new EventEmitter() };
}

/** A registry with both consumers registered on a live channel — the state
 * the worker is in one line after boot completes. */
function bootedRegistry(lost: string[] = []): ConsumerRegistry {
  const registry = createConsumerRegistry((reason) => lost.push(reason));
  registry.register(QUEUE_JUDGMENT_EXECUTE, 'amq.ctag-judgment');
  registry.register(QUEUE_RUN_CREATE, 'amq.ctag-run-create');
  return registry;
}

const allDepsUp = {
  rabbitHealthy: async () => true,
  redisHealthy: async () => true,
  dbHealthy: async () => true,
};

// ─── Registry: live state, not boot-time history ────────────────────────────

describe('consumer registry', () => {
  it('counts LIVE registration, not boot-time history', () => {
    // THE injection test. Revert the fix (report the append-only
    // `consumerTags.length` instead of live state) and this line reports 2.
    const registry = bootedRegistry();
    expect(registry.registered()).toBe(EXPECTED_CONSUMER_COUNT);

    registry.clear('channel closed');

    expect(registry.registered()).toBe(0);
  });

  it('re-registering after a loss restores the count (the tier-2 fix must be observable here)', () => {
    const registry = bootedRegistry();
    registry.clear('channel closed');

    registry.register(QUEUE_JUDGMENT_EXECUTE, 'amq.ctag-judgment-2');
    registry.register(QUEUE_RUN_CREATE, 'amq.ctag-run-create-2');

    expect(registry.registered()).toBe(EXPECTED_CONSUMER_COUNT);
  });

  it('is keyed by queue, so a re-consume of one queue cannot inflate the count', () => {
    const registry = createConsumerRegistry();
    registry.register(QUEUE_JUDGMENT_EXECUTE, 'amq.ctag-1');
    registry.register(QUEUE_JUDGMENT_EXECUTE, 'amq.ctag-2');

    expect(registry.registered()).toBe(1);
    expect(registry.tags()).toEqual(['amq.ctag-2']);
  });

  it('unregisters a single queue on a broker-initiated cancel', () => {
    const registry = bootedRegistry();

    registry.unregister(QUEUE_RUN_CREATE, 'broker cancelled the consumer');

    expect(registry.registered()).toBe(1);
    expect(registry.tags()).toEqual(['amq.ctag-judgment']);
  });

  it('reports a loss exactly once per event, and not when there was nothing to lose', () => {
    const lost: string[] = [];
    const registry = bootedRegistry(lost);

    registry.clear('channel closed');
    registry.clear('connection closed');

    expect(lost).toEqual(['channel closed']);
  });
});

// ─── The AMQP wiring ────────────────────────────────────────────────────────

describe('trackConsumerRegistration', () => {
  it("clears registration when the channel emits 'close' (the incident)", () => {
    const { conn, channel } = fakeAmqp();
    const registry = bootedRegistry();
    trackConsumerRegistration(registry, { conn, channel });

    channel.emit('close');

    expect(registry.registered()).toBe(0);
  });

  it("clears registration when the connection emits 'close'", () => {
    const { conn, channel } = fakeAmqp();
    const registry = bootedRegistry();
    trackConsumerRegistration(registry, { conn, channel });

    conn.emit('close');

    expect(registry.registered()).toBe(0);
  });

  it("clears registration on a channel 'error', without relying on a following 'close'", () => {
    const { conn, channel } = fakeAmqp();
    const registry = bootedRegistry();
    trackConsumerRegistration(registry, { conn, channel });

    channel.emit('error', new Error('PRECONDITION_FAILED'));

    expect(registry.registered()).toBe(0);
  });

  it("clears registration on a connection 'error'", () => {
    const { conn, channel } = fakeAmqp();
    const registry = bootedRegistry();
    trackConsumerRegistration(registry, { conn, channel });

    conn.emit('error', new Error('ECONNRESET'));

    expect(registry.registered()).toBe(0);
  });

  it("does not throw on an 'error' event with no other listener attached", () => {
    // EventEmitter rethrows an 'error' with no listeners; amqplib's own
    // handlers live in src/lib/queue/connection.ts, but this must stand on
    // its own if that ever changes.
    const { conn, channel } = fakeAmqp();
    trackConsumerRegistration(bootedRegistry(), { conn, channel });

    expect(() => channel.emit('error', new Error('boom'))).not.toThrow();
    expect(() => conn.emit('error', new Error('boom'))).not.toThrow();
  });
});

// ─── /health body + status code ─────────────────────────────────────────────

describe('evaluateWorkerHealth', () => {
  it('200 healthy when every dependency is up AND both consumers are registered', async () => {
    const result = await evaluateWorkerHealth({ ...allDepsUp, consumers: bootedRegistry() });

    expect(result.statusCode).toBe(200);
    expect(result.body).toEqual({
      status: 'healthy',
      checks: { rabbitmq: true, redis: true, database: true, consumers: EXPECTED_CONSUMER_COUNT },
    });
  });

  it('503 degraded once the channel closes and the consumers are gone', async () => {
    // The five-day outage, end to end: every dependency probe still passes
    // (the broker socket reconnected, Redis and Postgres are fine) and the
    // ONLY thing wrong is that nothing is consuming.
    const { conn, channel } = fakeAmqp();
    const consumers = bootedRegistry();
    trackConsumerRegistration(consumers, { conn, channel });

    channel.emit('close');
    const result = await evaluateWorkerHealth({ ...allDepsUp, consumers });

    expect(result.statusCode).toBe(503);
    expect(result.body.status).toBe('degraded');
    expect(result.body.checks).toEqual({
      rabbitmq: true,
      redis: true,
      database: true,
      consumers: 0,
    });
  });

  it('503 degraded when only ONE of the two consumers is left', async () => {
    const consumers = bootedRegistry();
    consumers.unregister(QUEUE_RUN_CREATE, 'broker cancelled the consumer');

    const result = await evaluateWorkerHealth({ ...allDepsUp, consumers });

    expect(result.statusCode).toBe(503);
    expect(result.body.checks.consumers).toBe(1);
  });

  it('recovers to 200 when the consumers are re-registered on a fresh channel', async () => {
    const { conn, channel } = fakeAmqp();
    const consumers = bootedRegistry();
    trackConsumerRegistration(consumers, { conn, channel });
    channel.emit('close');

    consumers.register(QUEUE_JUDGMENT_EXECUTE, 'amq.ctag-judgment-2');
    consumers.register(QUEUE_RUN_CREATE, 'amq.ctag-run-create-2');
    const result = await evaluateWorkerHealth({ ...allDepsUp, consumers });

    expect(result.statusCode).toBe(200);
    expect(result.body.status).toBe('healthy');
  });

  it('still fails on a dependency outage with consumers registered (pre-existing conjunction intact)', async () => {
    const consumers = bootedRegistry();

    const result = await evaluateWorkerHealth({
      ...allDepsUp,
      dbHealthy: async () => false,
      consumers,
    });

    expect(result.statusCode).toBe(503);
    expect(result.body.checks).toEqual({
      rabbitmq: true,
      redis: true,
      database: false,
      consumers: EXPECTED_CONSUMER_COUNT,
    });
  });

  it('runs the three dependency probes concurrently, not serially', async () => {
    // The handler is on a readiness probe's timeout budget; three serial
    // 500ms-bounded checks would blow past a 1s probe timeout.
    let concurrent = 0;
    let peak = 0;
    const slow = async () => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 5));
      concurrent -= 1;
      return true;
    };

    await evaluateWorkerHealth({
      rabbitHealthy: slow,
      redisHealthy: slow,
      dbHealthy: slow,
      consumers: bootedRegistry(),
    });

    expect(peak).toBe(3);
  });
});

// ─── Deliberate SIGTERM drain ───────────────────────────────────────────────

describe('drain (the registry half of it — drain() itself is unreachable from a unit run)', () => {
  it('reports 503 draining — a truthful not-ready, distinguishable from the silent death', async () => {
    // DECISION (see main.ts's beginDrain doc): a drain does NOT get a 200
    // pass. Reporting "healthy" while consuming nothing is the exact lie this
    // whole change exists to remove, and a `draining` escape hatch that
    // suppresses the 503 would resurrect it the first time the flag is set by
    // mistake. The 503 is not a flap: drain() ends in process.exit(0), so the
    // transition is terminal, never healthy -> degraded -> healthy.
    const consumers = bootedRegistry();
    consumers.beginDrain();
    consumers.clear('drained');

    const result = await evaluateWorkerHealth({ ...allDepsUp, consumers });

    expect(result.statusCode).toBe(503);
    expect(result.body.status).toBe('draining');
    expect(result.body.checks.consumers).toBe(0);
  });

  it('says draining rather than degraded from the moment the drain starts', async () => {
    // beginDrain() runs BEFORE the cancels complete, so the window where
    // consumers are still registered but the process is on its way out is
    // labelled correctly too.
    const consumers = bootedRegistry();
    consumers.beginDrain();

    const result = await evaluateWorkerHealth({ ...allDepsUp, consumers });

    expect(result.body.status).toBe('draining');
    expect(result.statusCode).toBe(503);
  });

  it('does not log a consumer loss for the deliberate cancel', async () => {
    // Losing consumers on purpose is not the incident; paging on it would
    // train the operator to ignore the log line that matters.
    const lost: string[] = [];
    const consumers = bootedRegistry(lost);

    consumers.beginDrain();
    consumers.clear('drained');

    expect(lost).toEqual([]);
  });

  it('still exposes the tags to cancel after beginDrain()', async () => {
    // drain() cancels by tag; beginDrain() must not wipe them out from under
    // the cancel loop or SIGTERM would leave the broker's consumers dangling
    // until the TCP connection drops.
    const consumers = bootedRegistry();

    consumers.beginDrain();

    expect(consumers.tags().sort()).toEqual(['amq.ctag-judgment', 'amq.ctag-run-create']);
  });
});
