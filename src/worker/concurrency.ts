/**
 * ─── Three different numbers. Do not conflate them. ─────────────────────────
 *
 *   HARD_CONCURRENCY_CAP    = 1   in-flight provider calls PER JUDGE
 *   LANE_PREFETCH           = 1   unacked deliveries per LANE consumer
 *   MAX_IN_FLIGHT_MESSAGES  = 4   unacked deliveries per NON-LANE consumer
 *
 * Conflating the first two is the entire bug this file was created to fix, and
 * the previous version of this file re-committed it in the other direction:
 * it set `prefetch = effective concurrency = 1` ON ONE SHARED QUEUE, which is
 * safe but says "one judgment anywhere in the fleet at a time". A 30-item run
 * against one llama.cpp box then blocks every other model for ~22 minutes
 * (measured: run cmthr58r100013s0sykuvn41x, 21m53s wall clock for 30 items),
 * including models on a completely different machine that was sitting idle.
 *
 * `LANE_PREFETCH` is 1 for the opposite reason and it does NOT reintroduce
 * that: there are `LANE_COUNT` lane queues, one per inference server, so a
 * prefetch of 1 per lane still allows `LANE_COUNT` judgments in flight — it
 * just guarantees they are on `LANE_COUNT` DIFFERENT servers.
 *
 * The safety property was never "one judgment at a time". It is:
 *
 *   AT MOST ONE IN-FLIGHT PROVIDER CALL PER INFERENCE SERVER.
 *
 * Judgments against different servers may proceed concurrently — they contend
 * for nothing. `HARD_CONCURRENCY_CAP` is that per-judge number and stays at 1.
 * `MAX_IN_FLIGHT_MESSAGES` is a different quantity entirely: how many
 * deliveries a NON-LANE consumer holds unacked at once. Raising a prefetch
 * does NOT raise the per-judge cap — `createKeyedGate()` below enforces that
 * independently, and it is the thing that keeps an inference server from
 * being over-subscribed.
 *
 * ── WHY OVER-SUBSCRIBING ONE SERVER IS A CORRECTNESS BUG, NOT A SLOWDOWN ────
 *
 * The first production calibration (2026-08-31, 30 items against a local
 * llama.cpp judge) DEAD-LETTERED 4 of 30 items with
 * `timed out after 300000ms`, and the model was not the problem: judgments
 * that completed averaged 94s, well inside the 300s ceiling.
 *
 * `EVALUATION_MODEL_CONCURRENCY_PER_RUN` was 2 and prefetch was
 * `concurrency * 4` = 8, so the worker held eight unacked messages and issued
 * eight concurrent HTTP requests to a server advertising `total_slots: 2`.
 * Requests three through eight queued INSIDE the inference server while their
 * client-side timeout ran. The clock a provider timeout measures is wall time
 * from request to response, and it does not care that most of that time was
 * spent waiting for a slot.
 *
 * Over-subscribing an inference server does not make it faster. It converts a
 * queue you can see (RabbitMQ, with depth, retries and a DLQ) into a queue you
 * cannot (the server's internal slot queue, invisible to every metric this
 * cluster has), and then times out against it.
 *
 * ── WHY THE GATE KEY IS THE JUDGE VERSION ───────────────────────────────────
 *
 * `ModelJudgment.judgeModelVersionId`. One `JudgeModelVersion` resolves to one
 * `ModelEndpoint` in practice (`resolveEndpointFor`,
 * src/lib/endpoint-resolution.ts), so the version id is a proxy for "which
 * server am I about to hit" that costs one indexed read and no queue-message
 * change — `JudgmentExecuteMsg` carries only `{judgmentId, runId, attempt}`
 * (src/lib/queue/publish.ts).
 *
 * KNOWN RESIDUAL OF THAT PROXY, stated rather than hidden: two versions served
 * by the SAME host get two separate permits and will run concurrently against
 * it — e.g. `granite4.1:3b` and `gemma4:26b`, both on the Ollama box at
 * 192.168.1.9:11434. The LANE topology (src/lib/queue/lanes.ts) is what
 * actually fixes that, because a lane is keyed on the normalized ORIGIN: both
 * models land on one lane queue, and a lane queue is serial at the broker
 * (prefetch 1 + `x-single-active-consumer`). The gate does not need to be
 * re-keyed to close the residual; it only needs to keep holding for the
 * traffic lanes do not cover. Which is the next section.
 *
 * ── THE GATE IS NOW REDUNDANT FOR LANED TRAFFIC, AND IT STAYS ANYWAY ────────
 *
 * DECISION (v2j phase 1b): every delivery takes a permit, whichever queue it
 * arrived on. Not "gate the fallback only". See `gateKeyForDelivery` below;
 * this is the reasoning.
 *
 * A lane queue at prefetch 1 with `x-single-active-consumer` is already serial
 * per server, so on laned traffic the gate is uncontended and grants
 * immediately. The tempting saving is to skip it for lane deliveries. That
 * saving is not just small — taking it would make the gate stop working:
 *
 *   1. LANE AND FALLBACK ARE NOT DISJOINT IN SERVER SPACE. `judgment.execute`
 *      is kept and consumed FOREVER (lanes.ts) and carries judgments for ANY
 *      server: messages published before lanes shipped, publishes whose lane
 *      lookup failed, and any future path that cannot resolve an endpoint. A
 *      fallback delivery and a lane delivery for the SAME server are handled
 *      by two different consumers at the same time. A mutex only excludes if
 *      BOTH sides take the permit — gate the fallback alone and the one case
 *      it exists for is exactly the case it cannot see.
 *   2. LANE ASSIGNMENT CAN DISAGREE WITH REALITY. The lane is computed by the
 *      PUBLISHER from the endpoint it resolved; the provider call is made by
 *      the CONSUMER against the endpoint IT resolves. Those two agree only for
 *      as long as `resolveEndpointFor` is genuinely shared and
 *      `ModelEndpoint` rows do not change under a queued message. When they
 *      disagree, two judgments for one server sit on two different lanes and
 *      the broker happily runs them in parallel. The in-process gate is the
 *      only thing left.
 *
 * The cost of keeping it is a Map insert and delete on an uncontended key: on
 * a lane it never parks, so it cannot consume the wait budget below. The cost
 * of removing it is a silent return of the over-subscription that dead-lettered
 * 4 of 30 items. `tests/lib/worker-concurrency.test.ts` pins the decision with
 * a test that fails under the fallback-only variant.
 *
 * ── WHY THE LANE PREFETCH IS 1 AND THE NON-LANE PREFETCH IS 4 ───────────────
 *
 * The cluster runs `worker.replicas: 1`
 * (docs/superpowers/specs/2026-08-07-public-users-roadmap.md:282), so these
 * numbers are the whole fleet's in-flight ceiling, not a per-replica share.
 *
 * LANE_PREFETCH = 1 is the mechanism, not a throttle: prefetch 1 is what makes
 * a lane serial, and `LANE_COUNT` lanes therefore allow `LANE_COUNT`
 * simultaneous judgments on `LANE_COUNT` different servers. It also means a
 * lane delivery NEVER parks on the gate (one delivery per server at a time,
 * and the gate key is a proxy for the server), so a lane consumer's unacked
 * window is just claim + provider + persist.
 *
 * MAX_IN_FLIGHT_MESSAGES = 4 governs the queues that are not lanes — the
 * fallback `judgment.execute` and `run.create`. It is unchanged, deliberately:
 * the fallback is the pre-lane path and this change must not alter how legacy
 * traffic behaves. It is deliberately not larger, and the reason is NOT modesty
 * — it is the bound on how long a fallback message can sit parked on a busy
 * gate:
 *
 *   worst-case gate wait  ≈  (MAX_IN_FLIGHT_MESSAGES - 1) x per-item latency
 *
 * because only that many deliveries can be parked at once, whatever the queue
 * depth behind them. At the measured max of 95.1s that is ~285s; at the full
 * 300s provider timeout it is ~900s. Both are inside `GATE_WAIT_TIMEOUT_MS`'s
 * budget below. A prefetch of, say, 16 would make the worst-case park 15 x
 * 300s = 75 minutes — past RabbitMQ's 30-minute `consumer_timeout`, which
 * closes the CHANNEL and takes every consumer on it with it. Prefetch and the
 * gate timeout are one design, not two knobs.
 *
 * ── COMPANION CONFIG THIS CHANGE NEEDS (docker-compose.yml, not this file) ──
 * `WORKER_DB_POOL_LIMIT` defaults to 4 and its comment derives that from
 * `EVALUATION_MODEL_CONCURRENCY_PER_RUN x 2`. The quantity it actually wants
 * is "concurrent handlers x 2". With lanes that is
 * `(LANE_COUNT + MAX_IN_FLIGHT_MESSAGES x 2) x 2` = 32 in the worst case
 * (8 lanes + 4 fallback + 4 run.create), up from 8. Left at 4, genuinely
 * parallel judges contend for four Prisma connections against
 * `pool_timeout=20`. Parked handlers hold no connection (the gate wait happens
 * before the claim and after the key read) and a provider call holds none
 * either, so this is a margin question rather than a deadlock — but lanes
 * raise the ceiling four-fold, and it is the one config change this file
 * cannot make itself.
 *
 * ── HEAD-OF-LINE BLOCKING: SOLVED FOR LANED TRAFFIC, NOT FOR THE FALLBACK ───
 * The fallback `judgment.execute` is still one FIFO queue: if the first N
 * messages on it all belong to judge X, judge Y's message is not delivered
 * until one of them acks, however idle Y's server is. That is why the lane
 * queues exist — a laned judgment for Y is on Y's own queue and is never
 * behind X. Fallback traffic keeps the old behaviour on purpose; the answer
 * for it is to resolve a lane at publish time, not to widen this prefetch.
 */

import { logger } from '@/lib/logger';
import { LANE_FALLBACK_QUEUE, LANE_QUEUES } from '@/lib/queue/lanes';

/** The most in-flight provider calls this worker will have open AGAINST ONE
 *  JUDGE, whatever the configuration asks for. Not the total — see
 *  `MAX_IN_FLIGHT_MESSAGES`, and read the module doc before changing either. */
export const HARD_CONCURRENCY_CAP = 1;

/**
 * The AMQP prefetch for the queues that are NOT lanes: the fallback
 * `judgment.execute` and `run.create`.
 *
 * PER CONSUMER, not per channel. `amqplib`'s `prefetch(count, global)`
 * defaults `global` to false (node_modules/amqplib/lib/api_args.js:284), and
 * RabbitMQ >= 3.3 applies a non-global `basic.qos` separately to each consumer
 * created on the channel AFTER the qos call. That "after" is why `main.ts`
 * gives the lane consumers their own channel rather than interleaving two
 * `prefetch()` calls with the `consume()` calls on one — see main.ts.
 *
 * NOT the per-judge concurrency (that is `HARD_CONCURRENCY_CAP`, and it is
 * enforced by the keyed gate below, not by this number). NOT derived from
 * `EVALUATION_MODEL_CONCURRENCY_PER_RUN` either: that env var names a
 * per-judge quantity, and letting it buy total in-flight is how the original
 * 8-concurrent-call incident happened. See the module doc for why 4.
 */
export const MAX_IN_FLIGHT_MESSAGES = 4;

/**
 * The AMQP prefetch for a LANE consumer, and the reason a lane is serial.
 *
 * `x-single-active-consumer` (topology.ts) guarantees only ONE CONSUMER per
 * lane — it says nothing about how many messages that consumer may hold
 * unacked. Without this, one consumer would happily take N lane deliveries and
 * run N concurrent provider calls against the one server the lane exists to
 * protect, which is the original over-subscription with extra queues. The two
 * settings are one mechanism: single-active-consumer makes the lane
 * single-writer, prefetch 1 makes that writer sequential.
 *
 * Fixed at 1 rather than configurable: any value above 1 silently converts a
 * lane back into the shared queue this design replaced.
 */
export const LANE_PREFETCH = 1;

/**
 * How long a delivery may wait for its judge's permit before giving up and
 * being nack-REQUEUED (not acked, not dropped) back onto `judgment.execute`.
 *
 * THE CEILING THIS IS CHOSEN AGAINST: RabbitMQ's `consumer_timeout` defaults
 * to 30 minutes. A delivery that stays unacked longer than that gets its
 * CHANNEL closed — and this worker runs both consumers on one shared confirm
 * channel (src/worker/main.ts), so blowing it takes the whole worker's
 * consumption with it, which is exactly the five-day silent-death shape
 * main.ts's `checks.consumers` exists to catch.
 *
 * The budget: gate wait + post-gate work must stay well inside 1,800,000ms.
 * Post-gate work is bounded by the provider timeout plus persistence slack —
 * `LEASE_MS` (claim.ts) = 330s in production. 600,000 + 330,000 = 930s, ~52%
 * of the ceiling; the provider timeout could double and this would still fit.
 *
 * The floor: the module doc's `(MAX_IN_FLIGHT_MESSAGES - 1) x per-item
 * latency` bound is ~285s at the measured worst item (95.1s), so ordinary
 * same-judge queueing never reaches this timeout and never requeues. Hitting
 * it means three predecessors each ran >200s, i.e. the server is already
 * pathological — and in exactly that case handing the message back to the
 * broker (visible queue depth, no claim held, no attempt burned) beats parking
 * it for another ten minutes.
 */
export const GATE_WAIT_TIMEOUT_MS = 600_000;

export interface ResolvedConcurrency {
  /** What the configuration asked for, after parsing. */
  requested: number;
  /** What will actually be used, PER JUDGE. */
  effective: number;
  /** True when the request exceeded the cap and was clamped. Callers log this;
   *  it must not be silent to an OPERATOR, only to the configuration. Someone
   *  who sets 8 and sees no change deserves to know why. */
  capped: boolean;
}

/**
 * Resolve the PER-JUDGE concurrency from `EVALUATION_MODEL_CONCURRENCY_PER_RUN`.
 *
 * Deliberately returns no `prefetch` field any more. It used to, and the field
 * was a lie waiting to happen: the prefetch is `MAX_IN_FLIGHT_MESSAGES`, a
 * constant this input cannot influence. A knob named "concurrency" that
 * silently sets the total in-flight ceiling is the original bug.
 */
export function resolveWorkerConcurrency(raw: string | undefined): ResolvedConcurrency {
  const parsed = Number(raw ?? '2');
  // A non-numeric or sub-1 value floors to 1 rather than throwing: this runs at
  // module load in the worker entrypoint, and a boot crash over a typo'd env
  // var is a worse failure than quietly doing the safe thing.
  const requested = Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : 1;
  const effective = Math.min(requested, HARD_CONCURRENCY_CAP);
  return { requested, effective, capped: requested > HARD_CONCURRENCY_CAP };
}

// ─── The per-judge gate ──────────────────────────────────────────────────────

/**
 * The gate key for a judgment.
 *
 * `judgeModelVersionId` is NULLABLE on `ModelJudgment`
 * (prisma/schema.prisma:484), so this has to decide what a null means. It gets
 * a key UNIQUE TO THE JUDGMENT — never a shared `'null'` lane, and never a
 * bypass.
 *
 * - Not a shared lane, because a single `judge:null` key would collapse every
 *   null-version judgment in the system into one global serial queue. They
 *   have nothing to do with each other and share no server; making one wait
 *   behind another is the fleet-wide serialisation this whole change exists to
 *   remove, just reintroduced through the back door on a subset of rows.
 * - Not a bypass, because "skip the gate when the key is missing" is the kind
 *   of hole that quietly stops protecting anything the day some other code
 *   path starts leaving the column null. Every message takes the same
 *   acquire/release path, counts against the same in-flight ceiling, and is
 *   released by the same `finally`.
 *
 * A unique-per-row key is safe here for a load-bearing reason, not a hopeful
 * one: a null `judgeModelVersionId` CANNOT produce a provider call at all.
 * `judgment-consumer.ts`'s own guard marks such a row `error`
 * ("ModelJudgment has no judgeModelVersionId set — the worker path requires
 * one") and acks, before any provider seam is reached. There is no inference
 * server to over-subscribe, so there is nothing to serialise against.
 *
 * The same key shape covers "no such judgment row" (the pre-claim read found
 * nothing) — that message is about to be acked as `not_found` for the same
 * reason.
 */
export function judgeGateKey(
  judgmentId: string,
  judgeModelVersionId: string | null | undefined
): string {
  return judgeModelVersionId ? `judge:${judgeModelVersionId}` : `judgment:${judgmentId}`;
}

/**
 * The gate key for a delivery, given the queue it arrived on.
 *
 * `queueName` IS DELIBERATELY IGNORED, and that is the decision this function
 * exists to make explicit and to make testable. The alternative implementation
 * — `return queueName === LANE_FALLBACK_QUEUE ? judgeGateKey(...) : null`, i.e.
 * "lanes are already serial at the broker, skip the gate" — is the one the
 * module doc's "THE GATE IS NOW REDUNDANT FOR LANED TRAFFIC" section argues
 * against at length. The one-line version of that argument:
 *
 *   a fallback delivery and a lane delivery for the SAME server run on two
 *   different consumers at the same time, so a gate only the fallback side
 *   takes excludes nothing at all.
 *
 * Taking `queueName` as a parameter it does not read is not an oversight; it
 * is how the call sites in judgment-consumer.ts stay honest about the fact
 * that they HAVE the queue and are choosing not to branch on it, and how
 * `tests/lib/worker-concurrency.test.ts` can pin the choice — that test fails
 * if this ever starts returning a lane-dependent key.
 */
export function gateKeyForDelivery(
  queueName: string | undefined,
  judgmentId: string,
  judgeModelVersionId: string | null | undefined
): string {
  return judgeGateKey(judgmentId, judgeModelVersionId);
}

/**
 * The lane a delivery arrived on, or `null` when it did not arrive on one.
 *
 * Callers pass `raw.fields.routingKey`. Every queue in topology.ts is bound
 * with `routingKey == its own name`, and the v2 retry queues omit
 * `x-dead-letter-routing-key` so a retry keeps the routing key it was
 * published with — so the routing key on a delivery IS the lane it belongs to,
 * with no DB read and no recomputation.
 *
 * MEMBERSHIP IS CHECKED, NOT ASSUMED, and that check is load-bearing rather
 * than defensive. A retry is republished to a fanout with this value as the
 * routing key, and when the TTL expires the message dead-letters into
 * `judge.direct` under it. `judge.direct` is a plain direct exchange with no
 * alternate-exchange: a routing key nothing is bound to is silently DROPPED.
 * So echoing an unrecognised routing key would turn one failed judgment into
 * one lost judgment. Anything not in `LANE_QUEUES` — `undefined` (a
 * hand-constructed test message, or amqplib before this field existed), the
 * fallback queue, a key left over from a shovel or an operator republish —
 * returns null and takes the legacy retry path, which is bound and consumed.
 */
export function laneOfDelivery(routingKey: string | undefined | null): string | null {
  if (!routingKey) return null;
  return LANE_QUEUES.includes(routingKey) ? routingKey : null;
}

/**
 * Whether `queueName` is a queue that carries `JudgmentExecuteMsg` — a lane or
 * the fallback.
 *
 * Replaces the `queueName === QUEUE_JUDGMENT_EXECUTE` equality test that
 * dispatch-failure.ts used to make. With eight lane queues that equality is
 * false for essentially all judgment traffic, which would have quietly
 * downgraded every repeatedly-failing laned judgment from "hold it for 30s and
 * try again" to "nack-requeue at full speed", spinning on whatever is broken.
 */
export function isJudgmentQueue(queueName: string): boolean {
  return queueName === LANE_FALLBACK_QUEUE || LANE_QUEUES.includes(queueName);
}

/** Thrown by `acquire`/`runExclusive` when the bounded wait elapses. The
 *  caller's contract on seeing this is nack-REQUEUE — see judgment-consumer.ts.
 *  A distinct class (not a bare Error) so that disposition can never be
 *  confused with a provider or persistence failure, which have completely
 *  different handling. */
export class JudgeGateTimeoutError extends Error {
  readonly key: string;
  readonly waitedMs: number;

  constructor(key: string, waitedMs: number) {
    super(`timed out after ${waitedMs}ms waiting for the judge gate on ${key}`);
    this.name = 'JudgeGateTimeoutError';
    this.key = key;
    this.waitedMs = waitedMs;
  }
}

export interface KeyedGate {
  /** Wait for the permit for `key`. Resolves with a release function that is
   *  safe to call more than once. Rejects with `JudgeGateTimeoutError` if the
   *  permit does not arrive within `timeoutMs`. */
  acquire(key: string, timeoutMs?: number): Promise<() => void>;
  /** `acquire` + `try/finally` release. The release lives HERE rather than at
   *  each call site so there is exactly one place a `finally` can go missing,
   *  and so it is directly unit-testable. */
  runExclusive<T>(key: string, fn: () => Promise<T>, timeoutMs?: number): Promise<T>;
  /** Observability/tests: how many keys currently hold a permit. */
  heldKeys(): number;
  /** Observability/tests: how many deliveries are parked on `key`. */
  waiting(key: string): number;
}

interface Waiter {
  settled: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  grant: () => void;
  fail: (error: Error) => void;
}

/**
 * A keyed mutex: one permit per key, FIFO among waiters on the same key,
 * different keys entirely independent.
 *
 * ── IN-PROCESS IS CORRECT HERE, AND THAT IS A DECISION, NOT AN OVERSIGHT ────
 *
 * There is exactly one worker replica (`worker.replicas: 1`,
 * docs/superpowers/specs/2026-08-07-public-users-roadmap.md:282), so this
 * process is the ONLY thing that issues judge provider calls. A `Map` in its
 * heap is therefore a complete and exact record of what is in flight. A Redis
 * lock would add a network dependency and a brand-new failure mode — Redis
 * unreachable, or a lock TTL expiring under a judgment that is still running
 * and handing a second caller a permit — in exchange for coordinating with
 * replicas that do not exist.
 *
 * ── WHAT MUST CHANGE IF `worker.replicas` EVER GROWS ────────────────────────
 *
 * This gate silently stops holding. Two replicas each keep their own Map, each
 * believes it holds the only permit for a judge, and the fleet issues two
 * concurrent calls per judge — which is exactly the over-subscription that
 * dead-lettered 4 of 30 items, just harder to see because each replica's logs
 * look correct in isolation. It would NOT be caught by any test here: every
 * test in this repo runs in one process.
 *
 * The replacement is a Redis lock keyed the same way, following
 * `src/lib/llm/breaker-redis.ts`'s existing `SET key NX PX` pattern (and
 * `src/worker/reaper.ts`'s use of it), with a TTL >= `LEASE_MS` so the lock
 * cannot expire under a live claim, plus a heartbeat or an explicit release in
 * the same `finally`. Redis is already a hard dependency of this worker
 * (breaker + reaper lock), so the dependency argument above is about the
 * failure mode, not the connection.
 */
export function createKeyedGate(): KeyedGate {
  // Key present => permit held. The array is that key's FIFO waiter queue.
  // NOT called `lanes`: a lane is now a QUEUE (src/lib/queue/lanes.ts), and
  // reusing the word for the gate's per-key permit table made two unrelated
  // serialization mechanisms read as one.
  const permits = new Map<string, Waiter[]>();

  function handOff(key: string): void {
    const queue = permits.get(key);
    if (!queue) return;

    while (queue.length > 0) {
      const next = queue.shift()!;
      // A waiter that already timed out must NOT be granted the permit: its
      // delivery has been nack-requeued and nothing will ever call its
      // release, so the permit would be held forever and that judge would
      // stop making progress until the process restarts.
      if (next.settled) continue;
      next.settled = true;
      if (next.timer) clearTimeout(next.timer);
      next.grant();
      return; // permit stays held, now by `next`
    }

    // Nobody waiting — free the permit. Deleting rather than leaving an empty
    // array is what keeps this Map bounded by concurrent judges rather than
    // by every judge ever seen.
    permits.delete(key);
  }

  function makeRelease(key: string): () => void {
    let released = false;
    return () => {
      // Idempotent: a second release must not hand out a second permit while
      // the first holder is still running. Cheap insurance against a caller
      // that releases in both a catch and a finally.
      if (released) return;
      released = true;
      handOff(key);
    };
  }

  async function acquire(key: string, timeoutMs: number = GATE_WAIT_TIMEOUT_MS): Promise<() => void> {
    const queue = permits.get(key);
    if (!queue) {
      permits.set(key, []);
      return makeRelease(key);
    }

    const startedAt = Date.now();
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        settled: false,
        timer: undefined,
        grant: () => resolve(makeRelease(key)),
        fail: reject,
      };
      // Not `unref()`d on purpose. An unref'd timer would let the process exit
      // while a delivery is parked and unacked; `main.ts`'s drain already
      // bounds shutdown (DRAIN_TIMEOUT_MS) and exits explicitly, so nothing
      // needs this timer to be invisible to the event loop.
      waiter.timer = setTimeout(() => {
        if (waiter.settled) return;
        waiter.settled = true;
        // Left in the queue; `handOff` skips settled waiters. Splicing here
        // would be O(n) for no benefit at these queue depths.
        waiter.fail(new JudgeGateTimeoutError(key, Date.now() - startedAt));
      }, timeoutMs);
      queue.push(waiter);
    });
  }

  async function runExclusive<T>(
    key: string,
    fn: () => Promise<T>,
    timeoutMs: number = GATE_WAIT_TIMEOUT_MS
  ): Promise<T> {
    const release = await acquire(key, timeoutMs);
    try {
      return await fn();
    } finally {
      // A throw from `fn` must not leak the permit. Without this, one
      // unexpected error inside a judgment handler permanently wedges that
      // judge: every later message for it waits out the full
      // GATE_WAIT_TIMEOUT_MS and requeues, forever, while the server sits idle.
      release();
    }
  }

  return {
    acquire,
    runExclusive,
    heldKeys: () => permits.size,
    waiting: (key: string) => (permits.get(key) ?? []).filter((w) => !w.settled).length,
  };
}

/**
 * The process-wide gate. A module singleton because the invariant it enforces
 * is process-wide: `createJudgmentConsumer()` may be called more than once
 * (the integration suites do), and two consumers each holding a private gate
 * would each grant a permit for the same judge.
 */
export const judgeGate: KeyedGate = createKeyedGate();

/** Log the requeue decision. Split out so the disposition is one named thing
 *  the consumer calls rather than an inline block, and so its wording stays
 *  next to the reasoning above. */
export function logGateTimeout(error: JudgeGateTimeoutError, judgmentId: string, runId: string): void {
  logger.warn('judge gate wait timed out — nack-requeueing the delivery', {
    judgmentId,
    runId,
    gateKey: error.key,
    waitedMs: error.waitedMs,
    reason:
      'another judgment is still in flight against this judge; requeue rather than hold an unacked delivery toward RabbitMQ consumer_timeout (30m) — see src/worker/concurrency.ts',
  });
}
