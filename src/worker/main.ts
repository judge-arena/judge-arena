/**
 * ─── Judge Worker Entrypoint ────────────────────────────────────────────────
 *
 * Boots RabbitMQ topology, sets prefetch, and starts one consumer per queue in
 * `health.ts`'s `WORKER_CONSUMER_QUEUES`: every lane
 * (`judgment.execute.lane.0..N`), the fallback `judgment.execute`, and
 * `run.create`.
 *
 * ── WHY THE LANES GET THEIR OWN CHANNEL ─────────────────────────────────────
 *
 * `run.create` and the fallback stay on the shared confirm channel — the same
 * channel `src/lib/queue/publish.ts`'s producers use via `getRabbit()`, so a
 * retry/DLQ publish made from inside a message handler reuses the already-open
 * channel rather than opening a second one. The eight lane consumers go on a
 * second, consume-only channel. Two reasons, in order of weight:
 *
 * 1. PREFETCH IS A CHANNEL SETTING APPLIED AT CONSUME TIME, NOT A CONSUMER
 *    ARGUMENT. `confirmChannel.prefetch(n)` is amqplib's `basic.qos(n, global:
 *    false)` (node_modules/amqplib/lib/api_args.js:284), and a non-global qos
 *    applies to each consumer created on that channel AFTER the call. A lane
 *    needs prefetch 1 (that is what makes it serial — see concurrency.ts's
 *    `LANE_PREFETCH`) and `run.create` wants 4, so one channel would mean
 *    `prefetch(1)` -> consume the lanes -> `prefetch(4)` -> consume the rest.
 *    That works, and it makes the in-flight ceiling a property of STATEMENT
 *    ORDER: someone tidying this function by grouping the `consume()` calls
 *    would silently give every lane a prefetch of 4 and re-create the
 *    eight-concurrent-calls-to-a-two-slot-server incident, with no test able to
 *    see it. On two channels the setting is structural.
 *
 * 2. BLAST RADIUS. A delivery left unacked past RabbitMQ's `consumer_timeout`
 *    (30 minutes) closes the CHANNEL it arrived on. Putting eight more
 *    long-running consumers on the channel that also carries every publish this
 *    process makes — retry, DLQ, run.create — multiplies the ways to lose the
 *    publish path by five. A lane channel that dies takes the lanes down
 *    (visible: /health degrades, see below) and leaves publishing intact.
 *
 * Note what this does NOT fix: the fallback `judgment.execute` consumer is
 * still on the shared channel, so it can still take the publish path down. That
 * is the pre-existing arrangement, unchanged here on purpose — lane traffic is
 * what this change adds, and adding it to the existing hazard would have been
 * the regression. And the lane channel is NOT managed by connection.ts's
 * reconnect loop: it dies with its connection and is not recreated, exactly
 * like today's consumers. Detection, not recovery — see below.
 *
 * Dev/local: `npm run worker` (`tsx src/worker/main.ts`). Build wiring
 * (bundling this into a deployable worker image/target, a docker-compose
 * `worker` service, etc.) is Task 16's job — this file only needs to run
 * correctly under `tsx` today.
 *
 * Graceful shutdown (SIGTERM/SIGINT): cancel both consumers so no new
 * messages arrive, wait for in-flight handlers (tracked by a plain counter)
 * to finish acking/nacking, close the health server and the RabbitMQ
 * connection, disconnect Prisma, exit 0. Bounded by `DRAIN_TIMEOUT_MS` so a
 * wedged in-flight handler can't hang shutdown forever — orchestrators
 * (Kubernetes, systemd) enforce their own hard kill timeout regardless, this
 * is just about exiting cleanly when possible rather than always racing
 * that hard kill.
 *
 * ── /health reports CONSUMER REGISTRATION, not just dependency reachability ──
 * INCIDENT 2026-08-24T17:55Z -> 2026-08-29. A Postgres roll dropped the AMQP
 * connection. The socket reconnected (connection.ts hand-rolls that), but
 * nothing ever re-issued `confirmChannel.consume()`, so this worker sat with
 * ZERO registered consumers for five days. The pod stayed 1/1 Running with 0
 * restarts, /health returned 200 healthy the entire time, and the evaluation
 * pipeline was silently dead — because every check /health made
 * (rabbitmq/redis/database) was about a dependency being *reachable*, and
 * none was about this process actually doing its job.
 *
 * `checks.consumers` closes that gap: it is the LIVE registration count
 * (`ConsumerRegistry` below), and it participates in the `healthy`
 * conjunction, so zero consumers => 503 => the readiness probe fails => the
 * replica goes unavailable => the existing KubeDeploymentReplicasMismatch
 * alert fires. Detection only — the actual re-registration-on-reconnect fix
 * is separate, later work (see the FOLLOW-UP note on
 * `trackConsumerRegistration`).
 */

import http from 'node:http';
import type { Channel, ConsumeMessage } from 'amqplib';
import { getRabbit, closeRabbit, rabbitHealthy } from '@/lib/queue/connection';
import { assertTopology, QUEUE_RUN_CREATE } from '@/lib/queue/topology';
import { LANE_FALLBACK_QUEUE, LANE_QUEUES } from '@/lib/queue/lanes';
import { redisHealthy } from '@/lib/redis';
import { prisma } from '@/lib/db';
import { flushBackgroundWrites, pendingBackgroundWrites } from '@/lib/background-writes';
import { logger, serializeError } from '@/lib/logger';
import { createJudgmentConsumer, publishJudgmentRetryPreservingLane } from './judgment-consumer';
import { createRunCreateConsumer } from './run-create-consumer';
import { startReaper } from './reaper';
import { handleDispatchFailure } from './dispatch-failure';
import {
  HARD_CONCURRENCY_CAP,
  LANE_PREFETCH,
  MAX_IN_FLIGHT_MESSAGES,
  resolveWorkerConcurrency,
} from './concurrency';
import {
  EXPECTED_CONSUMER_COUNT,
  WORKER_CONSUMER_QUEUES,
  createConsumerRegistry,
  evaluateWorkerHealth,
  trackConsumerRegistration,
  type ConsumerRegistry,
} from './health';

// THREE DIFFERENT NUMBERS — do not collapse them back into one.
//
// PREFETCH is the in-flight ceiling PER NON-LANE CONSUMER (`run.create` and
// the fallback `judgment.execute`): `dispatch` starts a handler for every
// message the broker delivers, so a prefetch of N parks or runs N judgments at
// once on that consumer.
//
// LANE_PREFETCH is 1, and on a lane that is not a throttle — it IS the
// serialization. Eight lanes at prefetch 1 give eight simultaneous judgments
// on eight different servers, which is why a 30-item run against one server no
// longer blocks every other model for 22 minutes.
//
// CONCURRENCY.effective is the PER-JUDGE limit, and it is still 1. No prefetch
// buys it: judgment-consumer.ts holds a per-`judgeModelVersionId` permit
// across its claim+execute span, so N in flight means N different judges, never
// N calls to one server. The original incident was eight concurrent calls to a
// two-slot llama.cpp box (`concurrency * 4`), which dead-lettered four items of
// the first production calibration. See ./concurrency.ts for the full account.
const CONCURRENCY = resolveWorkerConcurrency(process.env.EVALUATION_MODEL_CONCURRENCY_PER_RUN);
const PREFETCH = MAX_IN_FLIGHT_MESSAGES;
const HEALTH_PORT = Number(process.env.WORKER_HEALTH_PORT ?? '9090');
const DRAIN_TIMEOUT_MS = 30_000;

/** 500ms-bounded, never-throws DB check — same contract as
 * `redisHealthy()`/`rabbitHealthy()` (see src/lib/redis.ts, src/lib/queue/connection.ts). */
async function dbHealthy(): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const checkPromise = prisma.$queryRaw`SELECT 1`;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('db health check timed out')), 500);
    });
    await Promise.race([checkPromise, timeoutPromise]);
    return true;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function startHealthServer(consumers: ConsumerRegistry): http.Server {
  const server = http.createServer((req, res) => {
    if (req.url !== '/' && req.url !== '/health') {
      res.writeHead(404);
      res.end();
      return;
    }

    void (async () => {
      const { statusCode, body } = await evaluateWorkerHealth({
        rabbitHealthy,
        redisHealthy,
        dbHealthy,
        consumers,
      });
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    })();
  });

  server.listen(HEALTH_PORT, () => {
    logger.info(`worker health server listening on :${HEALTH_PORT}`);
  });

  return server;
}

async function main(): Promise<void> {
  const { conn, confirmChannel } = await getRabbit();
  await assertTopology(confirmChannel);
  await confirmChannel.prefetch(PREFETCH);

  // See the module doc for why this is a second channel rather than a second
  // `prefetch()` call on the shared one. Plain (not confirm) because nothing
  // publishes on it — publisher confirms are a producer concern, and every
  // publish this process makes still goes through `getRabbit()`'s confirm
  // channel.
  const laneChannel = await conn.createChannel();
  await laneChannel.prefetch(LANE_PREFETCH);

  const consumers = createConsumerRegistry((reason, remaining) => {
    logger.error('amqp consumers lost — this worker has stopped consuming', {
      reason,
      remaining,
      expected: EXPECTED_CONSUMER_COUNT,
      missing: consumers.missing(),
    });
  });

  /** Which channel owns a queue's consumer. Drain cancels by tag, and a tag can
   *  only be cancelled on the channel that created it — asking the shared
   *  channel to cancel a lane's tag is a broker-side error that would close the
   *  channel mid-shutdown. */
  const channelFor = (queue: string): Channel =>
    LANE_QUEUES.includes(queue) ? laneChannel : confirmChannel;

  // Scoped per channel: a lane-channel failure must not report `run.create` as
  // lost (it is still consuming) or erase the tag drain() needs to cancel it.
  trackConsumerRegistration(consumers, { conn, channel: confirmChannel }, [
    LANE_FALLBACK_QUEUE,
    QUEUE_RUN_CREATE,
  ]);
  trackConsumerRegistration(consumers, { conn, channel: laneChannel }, LANE_QUEUES);

  // Started before the consumers are registered, so the window between
  // listening and consuming reports 503 rather than a premature 200 — that is
  // exactly what a readiness probe is for.
  const healthServer = startHealthServer(consumers);

  const judgmentConsumer = createJudgmentConsumer();
  const runCreateConsumer = createRunCreateConsumer();
  const reaper = startReaper();

  let inFlight = 0;
  let draining = false;

  /**
   * Wraps a consumer's `handle()` with the in-flight counter and a
   * requeue-on-unexpected-failure fallback. A handler completing its own
   * claim/ack/retry/DLQ disposition should never throw — an escaping error
   * here means something upstream of that disposition broke (DB/queue
   * connectivity, a bug in context-loading, malformed message content).
   *
   * The actual ack/nack/retry-publish decision lives in
   * `handleDispatchFailure` (./dispatch-failure.ts) — pulled out so it can
   * be unit-tested with a mocked `Channel` and an injected
   * `publishJudgmentRetry30s`, independent of this file's module-scope
   * `main()` call. See that module's doc for the full redelivered /
   * queue-specific reasoning.
   */
  async function dispatch(
    msg: ConsumeMessage,
    ch: Channel,
    handler: (msg: ConsumeMessage, ch: Channel) => Promise<void>,
    queueName: string
  ): Promise<void> {
    inFlight += 1;
    try {
      await handler(msg, ch);
    } catch (error) {
      await handleDispatchFailure(ch, msg, queueName, error, {
        // The `lane` argument is what keeps a dispatch-level retry on the queue
        // it came from. Absent (a fallback or legacy delivery) it publishes to
        // the original `judgment.retry.30s`, which is exactly what this call
        // did before lanes existed.
        publishJudgmentRetry30s: (retryMsg, lane) =>
          publishJudgmentRetryPreservingLane(retryMsg, '30s', lane ?? null),
      });
    } finally {
      inFlight -= 1;
    }
  }

  /**
   * Register one judgment consumer on `queue` and record its tag.
   *
   * Every lane and the fallback run the SAME handler — a lane is a routing
   * decision, not a different kind of work, and `judgment-consumer.ts` reads
   * the lane it needs off `raw.fields.routingKey`. Writing the consume call
   * once is also what keeps the lanes and the fallback from drifting apart:
   * the null-message unregister below is the second route into the five-day
   * silence, and eight hand-copied consume blocks is eight places to forget it.
   */
  async function consumeJudgments(queue: string): Promise<void> {
    const channel = channelFor(queue);
    const tag = await channel.consume(
      queue,
      (msg) => {
        // A null message is amqplib delivering a broker-initiated
        // `basic.cancel` (queue deleted, mirrored-queue failover) — the
        // consumer is GONE, not idle, and the broker will never send another.
        // Before this fix that was silently returned from, which is a second
        // route into the same five-day silence.
        //
        // On a lane this is not hypothetical: `x-single-active-consumer` makes
        // the broker cancel the losing consumer on failover, so the ONE thing
        // that keeps a lane serial is also the thing that hands this callback
        // a null.
        if (!msg) {
          consumers.unregister(queue, 'broker cancelled the consumer');
          return;
        }
        void dispatch(msg, channel, judgmentConsumer.handle, queue);
      },
      { noAck: false }
    );
    consumers.register(queue, tag.consumerTag);
  }

  for (const lane of LANE_QUEUES) {
    // eslint-disable-next-line no-await-in-loop -- sequential consume of eight queues at boot; a failure must stop registration rather than leave a half-registered worker reporting healthy
    await consumeJudgments(lane);
  }
  // The fallback is NOT retired by lanes (see lanes.ts): pre-lane messages,
  // publishes whose lane lookup failed, and any future unresolvable endpoint
  // land here. Dropping this consumer would strand every one of them.
  await consumeJudgments(LANE_FALLBACK_QUEUE);

  const runCreateTag = await confirmChannel.consume(
    QUEUE_RUN_CREATE,
    (msg) => {
      if (!msg) {
        consumers.unregister(QUEUE_RUN_CREATE, 'broker cancelled the consumer');
        return;
      }
      void dispatch(msg, confirmChannel, runCreateConsumer.handle, QUEUE_RUN_CREATE);
    },
    { noAck: false }
  );
  consumers.register(QUEUE_RUN_CREATE, runCreateTag.consumerTag);

  // The registration loop above and `WORKER_CONSUMER_QUEUES` are two lists that
  // must agree, and /health only detects a shortfall against the second one. A
  // queue consumed here but absent there would be invisible to the probe; a
  // queue there but not consumed here would make the worker permanently
  // degraded. Say so at boot rather than letting either read as a broker
  // problem hours later.
  const unexpected = consumers
    .entries()
    .map((entry) => entry.queue)
    .filter((queue) => !WORKER_CONSUMER_QUEUES.includes(queue));
  if (unexpected.length > 0 || consumers.missing().length > 0) {
    logger.error('worker consume loop and WORKER_CONSUMER_QUEUES disagree', {
      unexpected,
      missing: consumers.missing(),
      reason:
        '/health compares live registration against WORKER_CONSUMER_QUEUES (src/worker/health.ts); a queue in one list and not the other is either an undetectable gap or a permanent 503',
    });
  }

  if (CONCURRENCY.capped) {
    // Not silent to an OPERATOR, only to the configuration: someone who sets 8
    // and sees no change deserves to be told the value was clamped, and why.
    logger.warn('EVALUATION_MODEL_CONCURRENCY_PER_RUN clamped to the per-judge hard cap', {
      requested: CONCURRENCY.requested,
      effective: CONCURRENCY.effective,
      maxServersInFlight: LANE_QUEUES.length,
      reason:
        'this knob is PER JUDGE, and concurrent calls to one judge queue INSIDE its inference server while their client timeout runs. Parallelism across DIFFERENT servers is governed by the number of LANE queues (src/lib/queue/lanes.ts), not by this value — see src/worker/concurrency.ts',
    });
  }

  // Every number, each named for what it actually bounds. A boot log that said
  // only `concurrency: 1` next to `prefetch: 4` would read as a contradiction
  // and invite someone to "fix" one of them; `lanePrefetch: 1` next to
  // `lanes: 8` is the same trap, so both appear with the ceiling they produce.
  logger.info('judge worker started', {
    lanes: LANE_QUEUES.length,
    lanePrefetch: LANE_PREFETCH,
    fallbackPrefetch: PREFETCH,
    maxServersInFlight: LANE_QUEUES.length,
    perJudgeConcurrency: CONCURRENCY.effective,
    perJudgeCap: HARD_CONCURRENCY_CAP,
    healthPort: HEALTH_PORT,
    consumers: consumers.registered(),
    expectedConsumers: EXPECTED_CONSUMER_COUNT,
  });

  async function drain(signal: string): Promise<void> {
    if (draining) return;
    draining = true;
    logger.info(`${signal} received — draining worker`);

    reaper.stop();
    // Before the cancels, so the losses they cause are attributed to the
    // drain and /health reports `draining` rather than the incident.
    consumers.beginDrain();
    // By OWNING channel, not by `confirmChannel` for everything: a consumer tag
    // is scoped to the channel that created it, and asking the shared channel
    // to cancel a lane's tag is a broker-side error that closes the channel
    // this drain still needs.
    await Promise.all(
      consumers.entries().map(({ queue, tag }) => channelFor(queue).cancel(tag))
    );
    consumers.clear('drained');

    const drainStart = Date.now();
    while (inFlight > 0 && Date.now() - drainStart < DRAIN_TIMEOUT_MS) {
      // eslint-disable-next-line no-await-in-loop -- polling a plain in-process counter until it drains or times out; there's nothing to parallelize
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (inFlight > 0) {
      logger.error(`drain timed out with ${inFlight} handler(s) still in flight — exiting anyway`);
    }

    await new Promise<void>((resolve) => healthServer.close(() => resolve()));
    await closeRabbit();

    // Fire-and-forget writes (audit records, API-key lastUsedAt) are not
    // awaited by their callers, so without this a write still in flight here
    // is destroyed by the $disconnect() below — silently, since both call
    // sites swallow their own errors. Dropping audit records at exactly the
    // moment a process is being terminated is the worst time to drop them.
    const pending = pendingBackgroundWrites();
    if (pending > 0) {
      logger.info(`flushing ${pending} background write(s) before disconnect`);
    }
    await flushBackgroundWrites();

    await prisma.$disconnect();

    logger.info('worker drained, exiting');
    process.exit(0);
  }

  process.on('SIGTERM', () => void drain('SIGTERM'));
  process.on('SIGINT', () => void drain('SIGINT'));
}

// Booting on import would open a real AMQP connection, start consuming, and
// bind :9090 inside the vitest worker process — tests/lib/worker-health.test.ts
// imports this module for the exported health unit above. `VITEST` is set to
// 'true' by the runner in every worker process and by nothing else; an
// `import.meta.url === argv[1]` direct-run check (the shape
// scripts/importer/cli.ts uses) would be wrong here, because the deployed
// entry point is `node worker.js` -> root worker.ts, which IMPORTS this
// module rather than being it.
if (!process.env.VITEST) {
  main().catch((error) => {
    logger.fatal('worker failed to start', { error: serializeError(error) });
    process.exit(1);
  });
}
