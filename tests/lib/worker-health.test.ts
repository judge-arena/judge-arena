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
 * ── v2j PHASE 1b: THE SAME BLIND SPOT, EIGHT TIMES OVER ─────────────────────
 * The worker now consumes one queue per LANE (src/lib/queue/lanes.ts) as well
 * as the fallback and `run.create`. A detector still comparing against a
 * hard-coded 2 would have called a worker with zero lane consumers healthy —
 * the identical failure, on the queues that now carry essentially all judgment
 * traffic. `EXPECTED_CONSUMER_COUNT` is therefore arithmetic on `LANE_QUEUES`,
 * and the assertions below are written against that list rather than against
 * literal queue names, so adding a lane cannot leave a test passing.
 *
 * WHAT THIS FILE DOES NOT COVER, stated so nobody reads 30 green tests as
 * more assurance than they are: every call site inside `main()` — the
 * `trackConsumerRegistration(...)` wiring, the `register()` calls after each
 * `consume()`, the `unregister()` on a null message, the `beginDrain()`
 * placement before the cancel loop, the `channelFor()` routing that decides
 * which channel cancels which tag, and `startHealthServer(consumers)` — is
 * unreachable from here, because `main()` is a closure over a live AMQP
 * channel. Verified by injection: deleting the `trackConsumerRegistration`
 * call, deleting `register(QUEUE_RUN_CREATE, ...)`, moving `beginDrain()`
 * after the cancels, and `LANE_QUEUES.slice(1)` in main's consume loop each
 * leave every test in this file GREEN while shipping a blind spot. Closing
 * that gap needs the registration loop lifted out of `main()` into an
 * injectable function the way `handleDispatchFailure` already was (see
 * src/worker/dispatch-failure.ts).
 */

import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { LANE_COUNT, LANE_FALLBACK_QUEUE, LANE_QUEUES } from '@/lib/queue/lanes';
import { QUEUE_JUDGMENT_EXECUTE, QUEUE_RUN_CREATE } from '@/lib/queue/topology';
import {
  EXPECTED_CONSUMER_COUNT,
  WORKER_CONSUMER_QUEUES,
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

/** A registry with EVERY consumer registered on a live channel — the state the
 * worker is in one line after boot completes. Built from
 * `WORKER_CONSUMER_QUEUES` rather than a hand-written list, because a fixture
 * that hard-coded two queues would keep passing after a lane was added to the
 * source of truth and never consumed. */
function bootedRegistry(lost: string[] = []): ConsumerRegistry {
  const registry = createConsumerRegistry((reason) => lost.push(reason));
  for (const queue of WORKER_CONSUMER_QUEUES) registry.register(queue, `amq.ctag-${queue}`);
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

    for (const queue of WORKER_CONSUMER_QUEUES) registry.register(queue, `amq.ctag-${queue}-2`);

    expect(registry.registered()).toBe(EXPECTED_CONSUMER_COUNT);
    expect(registry.missing()).toEqual([]);
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

    expect(registry.registered()).toBe(EXPECTED_CONSUMER_COUNT - 1);
    expect(registry.tags()).not.toContain(`amq.ctag-${QUEUE_RUN_CREATE}`);
    expect(registry.missing()).toEqual([QUEUE_RUN_CREATE]);
  });

  it('unregisters ONE LANE on a broker-initiated cancel, leaving the other seven', () => {
    // `x-single-active-consumer` makes this the ordinary case, not an exotic
    // one: the broker cancels the losing consumer on lane failover, and
    // amqplib surfaces that as a null message to the consume callback.
    const registry = bootedRegistry();

    registry.unregister(LANE_QUEUES[5], 'broker cancelled the consumer');

    expect(registry.registered()).toBe(EXPECTED_CONSUMER_COUNT - 1);
    expect(registry.missing()).toEqual([LANE_QUEUES[5]]);
  });

  it('scopes a clear to one channel, so a lane-channel loss leaves run.create registered', () => {
    // main.ts runs the lanes on their own channel. An unscoped clear from that
    // channel's 'close' would report run.create as lost while it is still
    // consuming AND erase the tag drain() needs to cancel it with.
    const registry = bootedRegistry();

    registry.clear('amqp channel closed', LANE_QUEUES);

    expect(registry.registered()).toBe(2);
    expect(registry.missing()).toEqual([...LANE_QUEUES]);
    expect(registry.entries().map((entry) => entry.queue).sort()).toEqual(
      [LANE_FALLBACK_QUEUE, QUEUE_RUN_CREATE].sort()
    );
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
  it('200 healthy when every dependency is up AND every consumer is registered', async () => {
    const result = await evaluateWorkerHealth({ ...allDepsUp, consumers: bootedRegistry() });

    expect(result.statusCode).toBe(200);
    expect(result.body).toEqual({
      status: 'healthy',
      checks: { rabbitmq: true, redis: true, database: true, consumers: EXPECTED_CONSUMER_COUNT },
      expectedConsumers: EXPECTED_CONSUMER_COUNT,
      missingConsumers: [],
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
    expect(result.body.missingConsumers).toEqual([...WORKER_CONSUMER_QUEUES]);
  });

  it('503 degraded when only the LEGACY consumers are gone', async () => {
    const consumers = bootedRegistry();
    consumers.unregister(QUEUE_RUN_CREATE, 'broker cancelled the consumer');

    const result = await evaluateWorkerHealth({ ...allDepsUp, consumers });

    expect(result.statusCode).toBe(503);
    expect(result.body.checks.consumers).toBe(EXPECTED_CONSUMER_COUNT - 1);
    expect(result.body.missingConsumers).toEqual([QUEUE_RUN_CREATE]);
  });

  it('recovers to 200 when the consumers are re-registered on a fresh channel', async () => {
    const { conn, channel } = fakeAmqp();
    const consumers = bootedRegistry();
    trackConsumerRegistration(consumers, { conn, channel });
    channel.emit('close');

    for (const queue of WORKER_CONSUMER_QUEUES) consumers.register(queue, `amq.ctag-${queue}-2`);
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

    expect(consumers.tags()).toHaveLength(EXPECTED_CONSUMER_COUNT);
    expect(consumers.entries().map((entry) => entry.queue).sort()).toEqual(
      [...WORKER_CONSUMER_QUEUES].sort()
    );
  });
});

// ─── The expectation must grow with the lanes ───────────────────────────────

describe('WORKER_CONSUMER_QUEUES — the detector, sized from the topology', () => {
  it('expects one consumer per lane, plus the fallback, plus run.create', () => {
    // The count is arithmetic on the source of truth, not a number someone
    // remembered to bump. Raising LANE_COUNT without teaching main.ts to
    // consume the new lane must fail this build's /health, not pass it.
    expect(EXPECTED_CONSUMER_COUNT).toBe(LANE_QUEUES.length + 2);
    expect(EXPECTED_CONSUMER_COUNT).toBe(LANE_COUNT + 2);
    expect(WORKER_CONSUMER_QUEUES).toHaveLength(EXPECTED_CONSUMER_COUNT);
  });

  it('names every lane, the fallback, and run.create — and nothing else', () => {
    expect([...WORKER_CONSUMER_QUEUES].sort()).toEqual(
      [...LANE_QUEUES, LANE_FALLBACK_QUEUE, QUEUE_RUN_CREATE].sort()
    );
  });

  it('has no duplicate entries — a duplicate would make /health permanently degraded', () => {
    // `LANE_FALLBACK_QUEUE` and `QUEUE_JUDGMENT_EXECUTE` are the same string.
    // Listing both would push EXPECTED_CONSUMER_COUNT one above the number of
    // distinct queues the registry can ever hold, and the conjunction in
    // evaluateWorkerHealth could then never be satisfied — a readiness probe
    // that fails forever on a perfectly healthy worker.
    expect(LANE_FALLBACK_QUEUE).toBe(QUEUE_JUDGMENT_EXECUTE);
    expect(new Set(WORKER_CONSUMER_QUEUES).size).toBe(WORKER_CONSUMER_QUEUES.length);
  });
});

describe('/health degrades when a LANE consumer is missing', () => {
  it('503 degraded with a single lane dark, every dependency up', async () => {
    // THE injection this change exists for, and the one the pre-lane detector
    // could not see: before this commit /health compared against a hard-coded
    // 2, so a worker consuming `judgment.execute` and `run.create` and NONE of
    // the eight lanes reported 200 healthy while every laned judgment queued
    // forever. Dropping one lane from main.ts's consume loop now shows up here.
    const consumers = bootedRegistry();
    consumers.unregister(LANE_QUEUES[3], 'never registered');

    const result = await evaluateWorkerHealth({ ...allDepsUp, consumers });

    expect(result.statusCode).toBe(503);
    expect(result.body.status).toBe('degraded');
    expect(result.body.missingConsumers).toEqual([LANE_QUEUES[3]]);
    expect(result.body.checks.consumers).toBe(EXPECTED_CONSUMER_COUNT - 1);
    expect(result.body.expectedConsumers).toBe(EXPECTED_CONSUMER_COUNT);
  });

  it('503 degraded when EVERY lane is dark but the legacy two are fine', async () => {
    // The shape of a worker built before lanes, or one whose lane channel died
    // (main.ts runs the lanes on their own channel). It is doing exactly what
    // the old code did and exactly what the old /health called healthy.
    const consumers = createConsumerRegistry();
    consumers.register(LANE_FALLBACK_QUEUE, 'amq.ctag-fallback');
    consumers.register(QUEUE_RUN_CREATE, 'amq.ctag-run-create');

    const result = await evaluateWorkerHealth({ ...allDepsUp, consumers });

    expect(result.statusCode).toBe(503);
    expect(result.body.status).toBe('degraded');
    expect(result.body.missingConsumers).toEqual([...LANE_QUEUES]);
  });

  it('names WHICH lanes are missing, not just how many', async () => {
    // With ten consumers, "consumers: 8" is an invitation to guess. The probe
    // only reads the status code; a human reads this.
    const consumers = bootedRegistry();
    consumers.unregister(LANE_QUEUES[0], 'broker cancelled the consumer');
    consumers.unregister(LANE_QUEUES[7], 'broker cancelled the consumer');

    const result = await evaluateWorkerHealth({ ...allDepsUp, consumers });

    expect(result.body.missingConsumers).toEqual([LANE_QUEUES[0], LANE_QUEUES[7]]);
  });

  it('degrades on the wrong SET even when the COUNT is right', async () => {
    // `consumers >= EXPECTED_CONSUMER_COUNT` would pass this. Lane names are
    // built by string interpolation (`laneQueue(i)`), so an off-by-one consume
    // loop registers a live consumer on a queue nobody publishes to while a
    // real lane sits dark — same count, one lane permanently starved.
    const consumers = bootedRegistry();
    consumers.unregister(LANE_QUEUES[2], 'never registered');
    consumers.register(`judgment.execute.lane.${LANE_COUNT}`, 'amq.ctag-off-by-one');

    const result = await evaluateWorkerHealth({ ...allDepsUp, consumers });

    expect(result.body.checks.consumers).toBe(EXPECTED_CONSUMER_COUNT);
    expect(result.statusCode).toBe(503);
    expect(result.body.missingConsumers).toEqual([LANE_QUEUES[2]]);
  });

  it('still reports healthy when all ten are present — the detector must not cry wolf', async () => {
    const result = await evaluateWorkerHealth({ ...allDepsUp, consumers: bootedRegistry() });

    expect(result.statusCode).toBe(200);
    expect(result.body.missingConsumers).toEqual([]);
  });
});
