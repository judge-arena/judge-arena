/**
 * ─── Judge Worker Entrypoint ────────────────────────────────────────────────
 *
 * Boots RabbitMQ topology, sets prefetch, and starts two consumers
 * (`judgment.execute`, `run.create`) on the shared confirm channel — the
 * same channel `src/lib/queue/publish.ts`'s producers use via `getRabbit()`,
 * so a retry/DLQ publish made from inside a message handler reuses the
 * already-open channel rather than opening a second one.
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
import { assertTopology, QUEUE_JUDGMENT_EXECUTE, QUEUE_RUN_CREATE } from '@/lib/queue/topology';
import { publishJudgmentRetry30s } from '@/lib/queue/publish';
import { redisHealthy } from '@/lib/redis';
import { prisma } from '@/lib/db';
import { flushBackgroundWrites, pendingBackgroundWrites } from '@/lib/background-writes';
import { logger, serializeError } from '@/lib/logger';
import { createJudgmentConsumer } from './judgment-consumer';
import { createRunCreateConsumer } from './run-create-consumer';
import { startReaper } from './reaper';
import { handleDispatchFailure } from './dispatch-failure';
import {
  HARD_CONCURRENCY_CAP,
  MAX_IN_FLIGHT_MESSAGES,
  resolveWorkerConcurrency,
} from './concurrency';
import {
  EXPECTED_CONSUMER_COUNT,
  createConsumerRegistry,
  evaluateWorkerHealth,
  trackConsumerRegistration,
  type ConsumerRegistry,
} from './health';

// TWO DIFFERENT NUMBERS — do not collapse them back into one.
//
// PREFETCH is the TOTAL in-flight ceiling: `dispatch` starts a handler for
// every message the broker delivers, so a prefetch of N parks or runs N
// judgments at once. It bounds how many DISTINCT JUDGES can be executing
// simultaneously — that is the point of raising it above 1, and it is the
// whole reason a 30-item run against one server no longer blocks every other
// model for 22 minutes.
//
// CONCURRENCY.effective is the PER-JUDGE limit, and it is still 1. Prefetch
// does not buy it: judgment-consumer.ts holds a per-`judgeModelVersionId`
// permit across its claim+execute span, so N in flight means N different
// judges, never N calls to one server. The original incident was eight
// concurrent calls to a two-slot llama.cpp box (`concurrency * 4`), which
// dead-lettered four items of the first production calibration.
// See ./concurrency.ts for the full account.
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

  const consumers = createConsumerRegistry((reason, remaining) => {
    logger.error('amqp consumers lost — this worker has stopped consuming', {
      reason,
      remaining,
      expected: EXPECTED_CONSUMER_COUNT,
    });
  });
  trackConsumerRegistration(consumers, { conn, channel: confirmChannel });

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
      await handleDispatchFailure(ch, msg, queueName, error, { publishJudgmentRetry30s });
    } finally {
      inFlight -= 1;
    }
  }

  const judgmentTag = await confirmChannel.consume(
    QUEUE_JUDGMENT_EXECUTE,
    (msg) => {
      // A null message is amqplib delivering a broker-initiated
      // `basic.cancel` (queue deleted, mirrored-queue failover) — the
      // consumer is GONE, not idle, and the broker will never send another.
      // Before this fix that was silently returned from, which is a second
      // route into the same five-day silence.
      if (!msg) {
        consumers.unregister(QUEUE_JUDGMENT_EXECUTE, 'broker cancelled the consumer');
        return;
      }
      void dispatch(msg, confirmChannel, judgmentConsumer.handle, QUEUE_JUDGMENT_EXECUTE);
    },
    { noAck: false }
  );
  consumers.register(QUEUE_JUDGMENT_EXECUTE, judgmentTag.consumerTag);

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

  if (CONCURRENCY.capped) {
    // Not silent to an OPERATOR, only to the configuration: someone who sets 8
    // and sees no change deserves to be told the value was clamped, and why.
    logger.warn('EVALUATION_MODEL_CONCURRENCY_PER_RUN clamped to the per-judge hard cap', {
      requested: CONCURRENCY.requested,
      effective: CONCURRENCY.effective,
      maxJudgesInFlight: PREFETCH,
      reason:
        'this knob is PER JUDGE, and concurrent calls to one judge queue INSIDE its inference server while their client timeout runs. Parallelism across DIFFERENT judges is governed by MAX_IN_FLIGHT_MESSAGES, not by this value — see src/worker/concurrency.ts',
    });
  }

  // Both numbers, both named for what they actually bound. A boot log that
  // said only `concurrency: 1` next to `prefetch: 4` would read as a
  // contradiction and invite someone to "fix" one of them.
  logger.info('judge worker started', {
    prefetch: PREFETCH,
    maxJudgesInFlight: PREFETCH,
    perJudgeConcurrency: CONCURRENCY.effective,
    perJudgeCap: HARD_CONCURRENCY_CAP,
    healthPort: HEALTH_PORT,
    consumers: consumers.registered(),
  });

  async function drain(signal: string): Promise<void> {
    if (draining) return;
    draining = true;
    logger.info(`${signal} received — draining worker`);

    reaper.stop();
    // Before the cancels, so the losses they cause are attributed to the
    // drain and /health reports `draining` rather than the incident.
    consumers.beginDrain();
    await Promise.all(consumers.tags().map((tag) => confirmChannel.cancel(tag)));
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
