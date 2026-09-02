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
 * DETECTION HERE, RECOVERY BY EXIT. Re-registering consumers on reconnect was
 * the follow-up this file originally deferred; what landed instead is
 * `createConsumerLossPolicy` below — the registry's `onLost` exits the
 * process and Kubernetes' restartPolicy re-runs the one registration path
 * that is proven to bring up all ten consumers (main.ts's boot). CORRECTION
 * (2026-09-01): this line used to read "DETECTION ONLY. Re-registering
 * consumers on reconnect is the real fix and is deliberately not attempted
 * here." In-process re-registration was rejected, not merely deferred — the
 * policy's docblock says why.
 */

import type { EventEmitter } from 'node:events';
import { LANE_FALLBACK_QUEUE, LANE_QUEUES } from '@/lib/queue/lanes';
import { QUEUE_RUN_CREATE } from '@/lib/queue/topology';

/**
 * The queues this worker must hold a live consumer on to be doing its job at
 * all: every lane, the fallback that lanes never retire, and `run.create`.
 * `main.ts` consumes exactly this set; this list exists so `/health` has
 * something to compare the live registration against.
 *
 * ── THIS LIST IS A COMPILE-TIME CONSTANT ON PURPOSE. DO NOT DERIVE IT FROM
 *    THE BROKER. ───────────────────────────────────────────────────────────
 * The obvious-looking "improvement" is to ask RabbitMQ which queues have
 * consumers and check that they match. That inverts the detector into a
 * tautology: a lane whose `consume()` never fired has no consumer AND is not
 * in the broker-derived expectation, so the two agree and /health says
 * healthy. This is the exact shape of the 2026-08-24 -> 08-29 outage, where
 * every check was about a dependency being reachable and none was about this
 * process doing its job. The expectation has to come from the SOURCE — what
 * this build intends to consume — so that reality failing to meet it is
 * visible.
 *
 * Adding a lane (`LANE_COUNT` in lanes.ts) therefore raises
 * `EXPECTED_CONSUMER_COUNT` automatically, and a worker that declares nine
 * lanes but consumes eight reports 503 rather than a comfortable 200.
 *
 * `LANE_FALLBACK_QUEUE` and `QUEUE_JUDGMENT_EXECUTE` are the SAME string; the
 * fallback name is used here because "the queue lanes fall back to" is why it
 * is still consumed. Listing both would make `EXPECTED_CONSUMER_COUNT` one
 * higher than the number of distinct queues the registry can ever hold, and
 * /health would then be permanently degraded — `tests/lib/worker-health.test.ts`
 * asserts the list has no duplicates for exactly that reason.
 */
export const WORKER_CONSUMER_QUEUES: readonly string[] = [
  ...LANE_QUEUES,
  LANE_FALLBACK_QUEUE,
  QUEUE_RUN_CREATE,
];
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
  /**
   * Drop consumers on a channel/connection level loss.
   *
   * `queues` SCOPES the clear, and it exists because the worker now runs its
   * consumers on TWO channels (see main.ts): the lane channel and the shared
   * confirm channel. An unscoped clear from the lane channel's 'close' would
   * report `run.create` as lost while it is still happily consuming — which is
   * a lie in the safe direction, but it also erases the tag drain() needs to
   * cancel it with. Omitted means "everything", which is what a connection
   * loss means.
   */
  clear(reason: string, queues?: readonly string[]): void;
  /** Mark a deliberate shutdown, so the losses that follow are reported as
   * `draining` rather than as the incident (see `drain()`). */
  beginDrain(): void;
  registered(): number;
  draining(): boolean;
  /** Consumer tags to `channel.cancel()` during drain. */
  tags(): string[];
  /**
   * Queue + tag pairs, for a drain that must cancel each tag on the channel
   * that owns it. `tags()` alone was enough when every consumer lived on one
   * channel; cancelling a lane's tag on the shared confirm channel is a
   * broker-side error that would close the channel the drain still needs.
   */
  entries(): Array<{ queue: string; tag: string }>;
  /** Which of `WORKER_CONSUMER_QUEUES` currently have no live consumer.
   *  Reported by /health so "9 of 10" says WHICH one, rather than making an
   *  operator diff two lists by hand at 3am. */
  missing(expected?: readonly string[]): string[];
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
    clear(reason, queues) {
      drop(reason, [...(queues ?? tagByQueue.keys())]);
    },
    beginDrain() {
      // Only flips the flag — the tags stay readable so drain()'s cancel loop
      // still has something to cancel.
      draining = true;
    },
    registered: () => tagByQueue.size,
    draining: () => draining,
    tags: () => [...tagByQueue.values()],
    entries: () => [...tagByQueue].map(([queue, tag]) => ({ queue, tag })),
    missing: (expected = WORKER_CONSUMER_QUEUES) =>
      expected.filter((queue) => !tagByQueue.has(queue)),
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
 * RECOVERY (2026-09-01): none of these handlers re-consumes, and none will.
 * The registry's `onLost` is `createConsumerLossPolicy` (below), which exits
 * the process so the pod restarts and boot re-registers everything. The
 * earlier FOLLOW-UP here proposed re-registration in these same 'close'
 * handlers; that is a SECOND registration path — re-create the lane channel,
 * re-`prefetch` both channels, re-`consume` ten queues, re-`register()` each
 * tag AND re-attach these very listeners on the new epoch's objects, or the
 * detector goes blind after the first recovery — the "N sibling call sites,
 * half-works without it" shape that shipped the escalating timeout into one
 * of three seams. It still does NOT belong in `src/lib/queue/connection.ts`'s
 * reconnect loop either: that module is shared with the web tier, which
 * publishes and never consumes and must keep publishing through a reconnect.
 *
 * @param queues the consumers this emitter pair owns. Called once per CHANNEL
 * now that lanes live on their own (main.ts), so a lane-channel failure clears
 * the lanes and leaves `run.create`'s registration — and its cancellable tag —
 * intact. Omit for "this emitter owns everything". A connection loss fires
 * both channels' listeners (amqplib's `_closeChannels` calls `toClosed()` on
 * every channel under a dying connection), so the scoped clears still add up
 * to a full clear; the visible cost is two log lines for one failure, each
 * naming a scope that really was lost.
 */
export function trackConsumerRegistration(
  registry: ConsumerRegistry,
  amqp: { conn: EventEmitter; channel: EventEmitter },
  queues?: readonly string[]
): void {
  amqp.channel.on('close', () => registry.clear('amqp channel closed', queues));
  amqp.channel.on('error', () => registry.clear('amqp channel error', queues));
  amqp.conn.on('close', () => registry.clear('amqp connection closed', queues));
  amqp.conn.on('error', () => registry.clear('amqp connection error', queues));
}

/**
 * How long `createConsumerLossPolicy` waits for `flushBackgroundWrites()` to
 * settle before exiting anyway. Two seconds covers an audit INSERT on a
 * healthy Postgres and is short enough that a wedged one cannot keep a worker
 * that consumes nothing alive. Never `DRAIN_TIMEOUT_MS`: a drain waits for
 * in-flight handlers whose acks can still succeed; on a dead channel they
 * cannot, so there is nothing to wait for beyond the writes.
 */
export const CONSUMER_LOSS_GRACE_MS = 2_000;

/**
 * Non-zero on purpose. `restartPolicy: Always` restarts the container on any
 * code, but a 1 records the loss in `kubectl get pod`'s RESTARTS column with
 * a last-state reason of Error rather than Completed — the difference between
 * "it crashed" and "it decided to stop", read at 3am.
 */
export const CONSUMER_LOSS_EXIT_CODE = 1;

export interface ConsumerLossPolicyDeps {
  /** `process.exit` in main.ts; a spy in tests. Called at most once. */
  exit: (code: number) => void;
  /** `logger.error` in main.ts. Called exactly once, before the flush. */
  log: (message: string, context: Record<string, unknown>) => void;
  /** `flushBackgroundWrites` (src/lib/background-writes.ts) in main.ts —
   *  awaited, bounded by `CONSUMER_LOSS_GRACE_MS`. */
  flush: () => Promise<void>;
  /** `consumers.missing()` on the registry this policy is installed on;
   *  evaluated at loss time so the log line names the queues that went dark. */
  missing: () => string[];
}

/**
 * The `onLost` for `createConsumerRegistry` in the worker: log once, flush
 * the fire-and-forget writes (bounded), exit 1.
 *
 * WHY EXIT RATHER THAN RE-CONSUME. Consumer loss is not recoverable in this
 * process. `src/lib/queue/connection.ts`'s reconnect loop restores the
 * socket, one confirm channel and the topology — never a prefetch, never the
 * lane channel, never a single `consume()` — and the worker's liveness probe
 * is `tcpSocket` on a health server that keeps accepting TCP with zero
 * consumers, so Kubernetes never restarted the pod either. That is how the
 * pipeline sat 1/1 Running, 0 restarts, consuming nothing for five days in
 * August. In-process re-registration would be a SECOND registration path
 * that has to re-create the lane channel, re-`prefetch` both channels,
 * re-`consume` ten queues, re-`register()` each tag AND re-attach
 * `trackConsumerRegistration` on the new epoch's objects — or the detector
 * goes blind after the first recovery — which is exactly the "feature spread
 * across N sibling call sites, half-works without it" shape that shipped the
 * escalating timeout into one of three seams. Exiting hands recovery to the
 * ONE path proven to bring up all ten consumers (main.ts's boot), with
 * `restartPolicy` supplying the retry and backoff. During a genuine broker
 * outage that is a visible CrashLoopBackOff (bounded, 5-minute backoff cap,
 * self-clearing when the broker returns) instead of a silent zombie.
 *
 * IDEMPOTENT, and it has to be. main.ts installs two SCOPED
 * `trackConsumerRegistration`s on ONE connection, and amqplib emits conn
 * 'error' before any 'close' (amqplib/lib/connection.js onSocketError), so
 * on a connection loss both scoped listeners drop a non-empty subset and the
 * registry's size-unchanged guard cannot dedupe them: `onLost` runs twice for
 * one failure. A synchronous `process.exit` would mask that; the deferred
 * exit below would fire twice without the `fired` latch.
 *
 * THREE ROUTES REACH HERE, all through the registry: a socket loss (conn
 * 'error'/'close'), a channel-level close with the connection still up
 * (channel 'error'/'close' — a RabbitMQ `consumer_timeout` or any server
 * ChannelClose; connection.ts recreates a consumer-less publish channel on
 * the next `rabbitHealthy()` without a log line, which is why "one channel,
 * zero consumers, silence" is the five-day shape), and a broker
 * `basic.cancel` (null message -> `unregister`). The last one exits on a
 * SINGLE cancelled lane by design: with replicas=1 a lane nobody consumes is
 * a lane whose judgments queue forever.
 *
 * NOT DURING A DRAIN. `createConsumerRegistry` never calls `onLost` after
 * `beginDrain()`, so a SIGTERM rollout is never reported as an exit-1 crash.
 *
 * WHAT IS LOST. In-flight judgments: their acks would fail on the dead channel
 * anyway and the reaper reclaims the leased rows — the same loss as today,
 * bounded to one call. NOT lost: fire-and-forget writes (audit rows, API-key
 * lastUsedAt), which a bare `process.exit(1)` from here would have dropped —
 * `drain()` flushes them for the same reason, and calls it "the worst time to
 * drop them".
 */
export function createConsumerLossPolicy(
  deps: ConsumerLossPolicyDeps
): (reason: string, remaining: number) => void {
  let fired = false;

  return (reason, remaining) => {
    if (fired) return;
    fired = true;

    deps.log('amqp consumers lost — exiting so the pod restarts and boot re-registers every consumer', {
      reason,
      remaining,
      expected: EXPECTED_CONSUMER_COUNT,
      missing: deps.missing(),
      graceMs: CONSUMER_LOSS_GRACE_MS,
    });

    let exited = false;
    const exitOnce = (): void => {
      if (exited) return;
      exited = true;
      deps.exit(CONSUMER_LOSS_EXIT_CODE);
    };
    const grace = setTimeout(exitOnce, CONSUMER_LOSS_GRACE_MS);
    void Promise.resolve()
      .then(() => deps.flush())
      .then(exitOnce, exitOnce)
      .finally(() => clearTimeout(grace));
  };
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
    /** What `checks.consumers` is compared against — printed so a reader of
     *  the body never has to know `LANE_COUNT` to interpret the number. */
    expectedConsumers: number;
    /** The queues in `WORKER_CONSUMER_QUEUES` with no live consumer. Empty on
     *  a healthy worker. With ten consumers, "consumers: 9" on its own is an
     *  invitation to guess; this says `judgment.execute.lane.3`. */
    missingConsumers: string[];
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
  const missingConsumers = deps.consumers.missing();

  // `missingConsumers.length === 0` rather than `consumers >= EXPECTED`: a
  // count comparison passes whenever the worker holds the right NUMBER of
  // consumers, even on the wrong SET. With one shared queue that was a
  // distinction without a difference; with eight lane names built by string
  // interpolation (`laneQueue(i)`, lanes.ts) it is not — a consume loop that
  // is off by one registers a live consumer on a queue nobody publishes to
  // while a real lane sits dark, and the count still says 10. The count stays
  // in the body because it is the number the incident report cited, but the
  // healthy/degraded conjunction is driven by the set.
  const healthy = rabbitmq && redis && database && missingConsumers.length === 0 && !draining;

  return {
    statusCode: healthy ? 200 : 503,
    body: {
      status: draining ? 'draining' : healthy ? 'healthy' : 'degraded',
      checks: { rabbitmq, redis, database, consumers },
      expectedConsumers: EXPECTED_CONSUMER_COUNT,
      missingConsumers,
    },
  };
}
