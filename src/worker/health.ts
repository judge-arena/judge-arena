/**
 * ─── Worker health: LIVE consumer registration ──────────────────────────────
 *
 * Extracted from `main.ts` so a unit test can reach it WITHOUT importing the
 * worker entrypoint. That is not tidiness — it is what keeps the coverage gate
 * honest, and `vitest.config.ts` predicted this exact situation in prose before
 * it happened: `src/worker/**` reported functions 100 only because nothing in
 * the DB-free run imported anything but `dispatch-failure.ts`, and it warned
 * that "the first real unit test that imports src/worker/reaper.ts would
 * surface its genuine branch coverage, drag the glob average down, and fail
 * this gate — so the config would punish exactly the change it exists to
 * encourage."
 *
 * Importing `main.ts` from a unit test did precisely that: it pulled main and
 * its whole transitive graph (queue, realtime, the two consumers, the Prisma
 * client) into the denominator at near-zero coverage and failed four
 * thresholds. Living in its own module — the same shape `dispatch-failure.ts`
 * already has — the logic is unit-testable at full coverage and `main.ts`
 * stays out of the DB-free run, so no floor had to be lowered to go green.
 *
 * WHY THIS EXISTS AT ALL. From 2026-08-24T17:55Z to 2026-08-30 this worker
 * held ZERO AMQP consumers. A Postgres roll dropped the connection; the socket
 * reconnected and `consume()` was never re-issued. The pod stayed 1/1 Running
 * with 0 restarts and /health returned 200 the entire time, so nothing alerted
 * and the evaluation pipeline was dead in silence for five days.
 *
 * THE TRAP THIS AVOIDS: `main.ts` tracks consumer tags in an append-only array
 * that is never spliced on channel loss. Reporting its length would have
 * reported 2 for all five days. Registration here is LIVE state, cleared when
 * the channel or connection goes away — so a reconnect that fails to
 * re-subscribe reads as degraded, /health returns 503, readiness fails, and
 * the existing KubeDeploymentReplicasMismatch alert fires.
 *
 * DETECTION ONLY. Re-registering consumers on reconnect is the real fix and is
 * deliberately not attempted here.
 */

import type { EventEmitter } from 'node:events';
import { QUEUE_JUDGMENT_EXECUTE, QUEUE_RUN_CREATE } from '@/lib/queue/topology';

/** The queues this worker must hold a live consumer on to be doing its job at
 * all. Both are consumed below; this list exists so `/health` has something
 * to compare the live count against. */
export const WORKER_CONSUMER_QUEUES = [QUEUE_JUDGMENT_EXECUTE, QUEUE_RUN_CREATE] as const;
export const EXPECTED_CONSUMER_COUNT = WORKER_CONSUMER_QUEUES.length;

/**
 * Live view of which queues this process currently has a consumer registered
 * on, keyed by queue name.
 *
 * THIS IS NOT A COUNT OF `consume()` CALLS MADE. The version of this file
 * that produced the five-day outage tracked consumers in an append-only
 * `consumerTags: string[]` — pushed to after each `consume()`, never spliced
 * on cancel, on channel close, or on connection loss. Reporting
 * `consumerTags.length` from /health would have reported 2 for every one of
 * those five days and changed nothing. An entry exists here only while we
 * have positive reason to believe the broker still has that consumer:
 * `register()` on a successful (re)consume, and removal on every event that
 * invalidates it (`trackConsumerRegistration` below).
 *
 * Deliberately conservative in one direction: a consumer can be gone without
 * us hearing about it (nothing here polls the broker), but every path that
 * DOES tell us — channel close/error, connection close/error, a
 * broker-initiated `basic.cancel` — drops it. False "degraded" is a page
 * someone answers; false "healthy" is five silent days.
 */
export interface ConsumerRegistry {
  /** Record a live consumer for `queue`. Replaces any previous tag for that
   * queue, so a re-consume after a reconnect cannot double-count. */
  register(queue: string, consumerTag: string): void;
  /** Drop one queue's consumer — a broker-initiated `basic.cancel` (queue
   * deleted, mirrored-queue failover), which amqplib surfaces as a `null`
   * message to the consume callback. */
  unregister(queue: string, reason: string): void;
  /** Drop every consumer — channel or connection level loss. */
  clear(reason: string): void;
  /** Mark a deliberate shutdown, so the losses that follow are reported as
   * `draining` rather than as the incident (see `drain()`). */
  beginDrain(): void;
  registered(): number;
  draining(): boolean;
  /** Consumer tags to `channel.cancel()` during drain. */
  tags(): string[];
}

/**
 * @param onLost called once per event that actually dropped one or more live
 * consumers, and never during a deliberate drain — a log line that also fires
 * on every clean SIGTERM is a log line the operator learns to skip.
 */
export function createConsumerRegistry(
  onLost: (reason: string, remaining: number) => void = () => {}
): ConsumerRegistry {
  const tagByQueue = new Map<string, string>();
  let draining = false;

  function drop(reason: string, queues: string[]): void {
    const before = tagByQueue.size;
    for (const queue of queues) tagByQueue.delete(queue);
    // Nothing changed: an already-empty registry re-cleared by the second of
    // amqplib's two events for one failure (a channel 'error' is followed by
    // its 'close'; a connection teardown closes every channel under it — see
    // amqplib/lib/connection.js `_closeChannels`). Reporting per event rather
    // than per failure would double every alert.
    if (tagByQueue.size === before) return;
    if (draining) return;
    onLost(reason, tagByQueue.size);
  }

  return {
    register(queue, consumerTag) {
      tagByQueue.set(queue, consumerTag);
    },
    unregister(queue, reason) {
      drop(reason, [queue]);
    },
    clear(reason) {
      drop(reason, [...tagByQueue.keys()]);
    },
    beginDrain() {
      // Only flips the flag — the tags stay readable so drain()'s cancel loop
      // still has something to cancel.
      draining = true;
    },
    registered: () => tagByQueue.size,
    draining: () => draining,
    tags: () => [...tagByQueue.values()],
  };
}

/**
 * Invalidate the registry on every amqplib event that means "your consumers
 * are gone". Both objects are plain EventEmitters
 * (amqplib/lib/channel_model.js): the connection re-emits its socket's
 * 'error'/'close', and a connection teardown also calls `toClosed()` on every
 * channel under it, so in practice the channel listener alone would cover the
 * common case — all four are wired anyway because the cost is nothing and the
 * failure this guards against is invisible for days.
 *
 * FOLLOW-UP (tier 2, deliberately NOT implemented here): re-registration
 * belongs in these same 'close' handlers — await a fresh `getRabbit()` with
 * backoff, re-`prefetch`, re-`consume` both queues, `register()` each new
 * tag. It does NOT belong in `src/lib/queue/connection.ts`'s reconnect loop:
 * that module is shared with the web tier, which publishes and never
 * consumes. Until that lands, this fix only makes the loss VISIBLE (503 ->
 * readiness -> KubeDeploymentReplicasMismatch); recovery is a pod restart.
 */
export function trackConsumerRegistration(
  registry: ConsumerRegistry,
  amqp: { conn: EventEmitter; channel: EventEmitter }
): void {
  amqp.channel.on('close', () => registry.clear('amqp channel closed'));
  amqp.channel.on('error', () => registry.clear('amqp channel error'));
  amqp.conn.on('close', () => registry.clear('amqp connection closed'));
  amqp.conn.on('error', () => registry.clear('amqp connection error'));
}

export interface WorkerHealthDeps {
  rabbitHealthy: () => Promise<boolean>;
  redisHealthy: () => Promise<boolean>;
  dbHealthy: () => Promise<boolean>;
  consumers: ConsumerRegistry;
}

export interface WorkerHealthResult {
  statusCode: 200 | 503;
  body: {
    status: 'healthy' | 'degraded' | 'draining';
    checks: { rabbitmq: boolean; redis: boolean; database: boolean; consumers: number };
  };
}

/**
 * The /health body and status code, as a pure function of its dependencies —
 * extracted from the request handler purely so tests/lib/worker-health.test.ts
 * can exercise it without a live broker, DB, Redis or socket.
 *
 * A DRAIN REPORTS 503, deliberately. During SIGTERM the consumers are
 * cancelled on purpose, so the count legitimately goes to zero; the tempting
 * alternative is to keep answering 200 until the process exits. That would
 * reintroduce, as an explicit code path, the exact lie this change removes —
 * "healthy" while consuming nothing — and any bug that set the flag
 * spuriously would restore the five-day blind spot. So the probe fails, and
 * `status` says `draining` instead of `degraded` so the two are
 * distinguishable at a glance and in logs.
 *
 * That is not a flap. `drain()` ends in `process.exit(0)`, so the transition
 * is terminal (never healthy -> degraded -> healthy), it lasts at most
 * DRAIN_TIMEOUT_MS, and a failing readiness probe on a pod that is already
 * Terminating is what you want: it pulls the pod out of any Service
 * endpoints early. KubeDeploymentReplicasMismatch needs a SUSTAINED mismatch
 * (its `for:` window is far longer than a 30s drain), so a rollout cannot
 * trip it.
 */
export async function evaluateWorkerHealth(deps: WorkerHealthDeps): Promise<WorkerHealthResult> {
  const [rabbitmq, redis, database] = await Promise.all([
    deps.rabbitHealthy(),
    deps.redisHealthy(),
    deps.dbHealthy(),
  ]);
  const consumers = deps.consumers.registered();
  const draining = deps.consumers.draining();

  const healthy =
    rabbitmq && redis && database && consumers >= EXPECTED_CONSUMER_COUNT && !draining;

  return {
    statusCode: healthy ? 200 : 503,
    body: {
      status: draining ? 'draining' : healthy ? 'healthy' : 'degraded',
      checks: { rabbitmq, redis, database, consumers },
    },
  };
}
