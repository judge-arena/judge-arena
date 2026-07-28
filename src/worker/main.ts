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
 */

import http from 'node:http';
import type { Channel, ConsumeMessage } from 'amqplib';
import { getRabbit, closeRabbit, rabbitHealthy } from '@/lib/queue/connection';
import { assertTopology, QUEUE_JUDGMENT_EXECUTE, QUEUE_RUN_CREATE } from '@/lib/queue/topology';
import { publishJudgmentRetry30s, type JudgmentExecuteMsg } from '@/lib/queue/publish';
import { redisHealthy } from '@/lib/redis';
import { prisma } from '@/lib/db';
import { logger, serializeError } from '@/lib/logger';
import { createJudgmentConsumer } from './judgment-consumer';
import { createRunCreateConsumer } from './run-create-consumer';
import { startReaper } from './reaper';

const MODEL_CONCURRENCY_PER_RUN = Number(process.env.EVALUATION_MODEL_CONCURRENCY_PER_RUN ?? '2');
const PREFETCH = Math.max(1, MODEL_CONCURRENCY_PER_RUN) * 4;
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

function startHealthServer(): http.Server {
  const server = http.createServer((req, res) => {
    if (req.url !== '/' && req.url !== '/health') {
      res.writeHead(404);
      res.end();
      return;
    }

    void (async () => {
      const [rabbitmq, redis, database] = await Promise.all([rabbitHealthy(), redisHealthy(), dbHealthy()]);
      const healthy = rabbitmq && redis && database;
      const body = JSON.stringify({
        status: healthy ? 'healthy' : 'degraded',
        checks: { rabbitmq, redis, database },
      });
      res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(body);
    })();
  });

  server.listen(HEALTH_PORT, () => {
    logger.info(`worker health server listening on :${HEALTH_PORT}`);
  });

  return server;
}

async function main(): Promise<void> {
  const { confirmChannel } = await getRabbit();
  await assertTopology(confirmChannel);
  await confirmChannel.prefetch(PREFETCH);

  const healthServer = startHealthServer();

  const judgmentConsumer = createJudgmentConsumer();
  const runCreateConsumer = createRunCreateConsumer();
  const reaper = startReaper();

  let inFlight = 0;
  let draining = false;
  const consumerTags: string[] = [];

  /**
   * Wraps a consumer's `handle()` with the in-flight counter and a
   * requeue-on-unexpected-failure fallback. A handler completing its own
   * claim/ack/retry/DLQ disposition should never throw — an escaping error
   * here means something upstream of that disposition broke (DB/queue
   * connectivity, a bug in context-loading, malformed message content).
   *
   * First failure on a given delivery (`msg.fields.redelivered === false`):
   * plain nack-requeue, same as before this task — gives a one-off
   * transient blip (a dropped DB connection that immediately reconnects)
   * the benefit of the doubt with an immediate retry.
   *
   * Second+ failure on the SAME message (`msg.fields.redelivered === true`
   * — this delivery is already a requeue of a previously-unacked message):
   * a bare nack-requeue here would just loop it back to this same consumer
   * at full speed (RabbitMQ's requeue-on-nack has no delay), spinning tight
   * on whatever's actually broken instead of backing off. For
   * `judgment.execute` messages specifically, route onto that queue's own
   * 30s retry holding queue instead — same TTL-then-dead-letter-back-onto-
   * judgment.execute mechanism judgment-consumer.ts's own retryable-error
   * disposition uses, just entered from a different failure surface (a
   * dispatch-level throw, not a classified provider error). This is bounded
   * because the message keeps its original `attempt` field: once it's back
   * on judgment.execute and the handler runs successfully enough to reach
   * its own disposition logic, judgment-consumer.ts's `effectiveAttempt`
   * cap (`MAX_ATTEMPTS`) still applies on that subsequent attempt, so a
   * truly poison message still eventually reaches the DLQ rather than
   * retrying forever — this dispatch-level guard only adds a delay before
   * that normal cap-driven path gets another chance to run. `run.create`
   * messages have no equivalent retry queue (their handler already
   * swallows its own errors per its own module doc — this whole catch is
   * already the rare "shouldn't happen" case for them), so they always fall
   * through to the plain nack-requeue below regardless of `redelivered`.
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
      logger.error('unhandled consumer error', {
        queue: queueName,
        redelivered: Boolean(msg.fields.redelivered),
        error: serializeError(error),
      });

      if (msg.fields.redelivered && queueName === QUEUE_JUDGMENT_EXECUTE) {
        try {
          const parsed = JSON.parse(msg.content.toString()) as JudgmentExecuteMsg;
          await publishJudgmentRetry30s(parsed);
          ch.ack(msg);
          return;
        } catch (routeError) {
          logger.error(
            'dispatch: failed to route a repeatedly-failing judgment.execute message to judgment.retry.30s — falling back to nack-requeue',
            { error: serializeError(routeError) }
          );
        }
      }

      // First failure on this delivery, a run.create message, or the
      // retry-queue routing attempt above itself failed — nack-requeue so
      // the message isn't lost; never drop it silently.
      ch.nack(msg, false, true);
    } finally {
      inFlight -= 1;
    }
  }

  const judgmentTag = await confirmChannel.consume(
    QUEUE_JUDGMENT_EXECUTE,
    (msg) => {
      if (!msg) return;
      void dispatch(msg, confirmChannel, judgmentConsumer.handle, QUEUE_JUDGMENT_EXECUTE);
    },
    { noAck: false }
  );
  consumerTags.push(judgmentTag.consumerTag);

  const runCreateTag = await confirmChannel.consume(
    QUEUE_RUN_CREATE,
    (msg) => {
      if (!msg) return;
      void dispatch(msg, confirmChannel, runCreateConsumer.handle, QUEUE_RUN_CREATE);
    },
    { noAck: false }
  );
  consumerTags.push(runCreateTag.consumerTag);

  logger.info('judge worker started', { prefetch: PREFETCH, healthPort: HEALTH_PORT });

  async function drain(signal: string): Promise<void> {
    if (draining) return;
    draining = true;
    logger.info(`${signal} received — draining worker`);

    reaper.stop();
    await Promise.all(consumerTags.map((tag) => confirmChannel.cancel(tag)));

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
    await prisma.$disconnect();

    logger.info('worker drained, exiting');
    process.exit(0);
  }

  process.on('SIGTERM', () => void drain('SIGTERM'));
  process.on('SIGINT', () => void drain('SIGINT'));
}

main().catch((error) => {
  logger.fatal('worker failed to start', { error: serializeError(error) });
  process.exit(1);
});
