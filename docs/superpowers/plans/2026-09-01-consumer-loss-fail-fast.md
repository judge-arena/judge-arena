# Consumer Loss Fail-Fast Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the judge worker loses its AMQP consumers by any route, it logs once, flushes its fire-and-forget writes within a 2 s bound and exits 1, so Kubernetes' `restartPolicy` re-runs the one registration path that is proven to bring up all ten consumers — replacing today's "503 forever on a pod that never restarts".

**Architecture:** A new exported, idempotent `createConsumerLossPolicy(deps)` in `src/worker/health.ts` becomes the `onLost` callback of the existing `ConsumerRegistry` in `src/worker/main.ts`. Nothing re-consumes in-process (that would be a second registration path that drifts from boot — the §5.1 "N sibling call sites" shape) and nothing changes in `src/lib/queue/connection.ts` (shared with the web tier, which must keep publishing through reconnects). The tcpSocket liveness probe stays; the process is the thing that restarts itself. Three loss routes all already reach `onLost`: socket loss (conn `'error'`/`'close'`), channel-level close with the connection alive (channel `'error'`/`'close'` — the five-day-silence shape), and a broker `basic.cancel` (null message → `unregister`).

**Tech Stack:** TypeScript, amqplib 2.0.1 (`node_modules/amqplib/package.json`), vitest 3.2.4 (fake timers for the grace), the podman `judge-arena-rabbitmq` container for the integration suite, Helm chart comments in homelab-setup.

**Spec:**
- Handoff: `/root/judge-arena/docs/superpowers/plans/2026-09-01-scoreboard-handoff.md` §7 item 4 (lines 307-311) and §1 standing check (lines 39-44).
- Register: `/root/judge-arena/docs/superpowers/plans/2026-08-30-state-and-next-steps.md` §3 (lines 206-226, the #932 warning at 224-226).
- Verified map: `/tmp/ja-plan-inputs/amqp-reconnect.json` (`map` + `verify.contradictions`/`corrections`, which override the map).
- Cross-item critique: `/tmp/ja-plan-inputs/critique.json` → `q2_missingInfoPerMap.amqp-reconnect`, `q3` (order: U3 first, then this), `q4` entry "#4 amqp-reconnect — option (b) fail-fast" (idempotency + bounded flush are load-bearing).

**Priority / wave:** Wave 1 / #2 (S).

**Depends on:** `u3-hardcap-escapes-retry` — recommended first, NOT a hard dependency. Without U3 a wedged judge can sit inside a 3 × hard-cap (2 700 s) in-process retry sequence, and that is the work an exiting worker abandons; with U3 the abandoned work is bounded to one hard cap. Nothing in this plan changes if U3 lands later.

**Owner decisions needed:** none — the binding decisions are recorded under "Decisions" below. One thing to WATCH after promotion (not a decision this plan needs): whether RabbitMQ 4.2 quorum lanes with `x-single-active-consumer` send `basic.cancel` on leader failover during a broker roll. If they do, a #932-style roll may restart the worker more than once. That is restart count, not correctness; it can only be measured live.

## Global Constraints

- Repo: /root/judge-arena (Next.js 15.5.22, TypeScript, Prisma on Postgres — Json maps to JSONB —, amqplib 2.0.1, vitest). Node >= 22. Always use `git -C /root/judge-arena` (handoff trap 2: a stale `cd` once hard-reset the wrong repo).
- Gates, in this order, all must be clean before every commit: `npm run lint` (0 warnings) → `npx tsc --noEmit` → `npm run test:coverage` (unit; per-glob floors in vitest.config.ts:187-220 — NEVER lower a floor; if a new test import drags a module into a denominator, mock the seam as tests/lib/judgment-consumer-escalation.test.ts:41-69 does) → `npm run test:db:coverage` (RESETS the database at .env.test — verified today to be localhost:5432, the local podman `judge-arena-pg`, NOT the k8s `judge-arena-pg-1`; re-confirm with `grep DATABASE_URL /root/judge-arena/.env.test` before the first run) → `npm run test:integration` → `npm run build`. Baseline on HEAD fc9e936: 869 unit / 55 files; 670 db; 80 integration.
- TDD with an INJECTION step (CONTRIBUTING.md:210-234): every behaviour test must be shown to go RED by a deliberate breakage of the implementation and GREEN again after; a test that stays green after injection is a finding. Each task's steps must include the injection.
- One concern per commit/PR (CONTRIBUTING.md:1560). Wrong statements in docs get an explicit CORRECTION note, never a silent overwrite (CONTRIBUTING.md:1571-1574).
- Commit subject: `type(scope): lowercase summary` (feat/fix/docs/ci; scopes seen: worker, llm, queue, calibration, ci, docker). Body: narrative, then a `Gates: lint 0, tsc 0, <n> unit / <n> db / <n> integration, coverage 0.` line, then EXACTLY these trailers:
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_018ACKb44as67Hz9R3sxexc7
- Commit LOCALLY only. Never push, never promote; the operator does that (push-to-main fires CI and builds an image; promotion is a separate homelab-setup PR).
- Migration naming: `prisma/migrations/<YYYYMMDDHHMMSS>_v2<letter>_<snake>/migration.sql`, timestamp must sort after 20260901000000 (v2j); narrative `-- v2x — ...` header in the v2i/v2j style; ZERO hand edits (content must equal what `prisma migrate diff` emits), then `npx prisma generate`.
- GREP TRAP live in HEAD: /root/judge-arena/src/lib/calibration/readings.ts:164 and /root/judge-arena/scripts/importer/reconcile.ts:294 contain a deliberate NUL byte; plain grep returns nothing for those files. Use `grep -a`. NEVER remove the NUL.
- Production is sha-d21f31d47c35; main (fc9e936) is 4 docs-only commits ahead. Do not touch homelab-setup from a judge-arena task except where the plan explicitly says "separate PR in /root/homelab-setup".
- Any cluster/DB access in a plan step is READ-ONLY (psql SELECT, kubectl get/logs, rabbitmqctl list_queues). No requeue-peeks of judge.dlq (quorum delivery_limit 20 — every peek burns one).

---

## Why this shape (read before Task 1)

Facts verified against the tree on 2026-09-01 (line numbers are CURRENT HEAD fc9e936; re-verify before editing):

| fact | where |
|---|---|
| The only `consume()` calls in production code are inside `main()`'s one-shot boot | `src/worker/main.ts:272` (lanes + fallback via `consumeJudgments`) and `:305` (`run.create`) |
| The reconnect loop restores socket + one confirm channel + topology, never prefetch, never the lane channel, never a consumer | `src/lib/queue/connection.ts:152-171` (scheduleReconnect), `:178-206` (ensureChannel), `:208-240` (createConnection); `main.ts:184-185` creates the lane channel once |
| `onLost` today only logs | `main.ts:187-194` |
| `onLost` fires TWICE per connection loss with the real wiring: two SCOPED trackers on one `conn`, and amqplib emits conn `'error'` before any `'close'`, so each scoped listener drops a non-empty subset and the size-unchanged guard cannot dedupe them | `main.ts:205-209`; `health.ts:149-160`, `:203-210`, `:217-220`; `node_modules/amqplib/lib/connection.js:295-304` (onSocketError → emit 'error' → toClosed), `:332-339` (_closeChannels), `:342-359` (toClosed → emit 'close') |
| `unregister()` (the `basic.cancel` route) already goes through `drop()` → `onLost`; a policy installed there exits on a single cancelled lane with NO extra wiring | `health.ts:166-168`; `main.ts:285-288`, `:308-311` |
| A channel-level close with the connection alive silently yields "one channel, zero consumers": `connection.ts:188-194` nulls the channel without logging and the next `rabbitHealthy()` recreates a consumer-less one | `connection.ts:188-194`, `:253-257`, `:292-312` |
| Liveness is `tcpSocket` on the health port; the http server keeps accepting TCP with zero consumers, so Kubernetes never restarts the pod. Only readiness (`httpGet /health`) fails | `/root/homelab-setup/charts/judge-arena/templates/deployment.yaml:315-336`; `main.ts:147-172` |
| `drain()` flushes background writes before `$disconnect()`; a bare `process.exit(1)` from `onLost` would drop them | `main.ts:395-406`; `src/lib/background-writes.ts:67-72` (`flushBackgroundWrites`, already imported by `main.ts:85`) |
| The registry suppresses `onLost` during a drain (so the policy is never consulted on SIGTERM) | `health.ts:158` |
| `.env.test` points at the local podman rig | `DATABASE_URL="postgresql://judge_arena:password@localhost:5432/judge_arena_test"` (grep verified 2026-09-01) |
| Current unit coverage for `src/worker/**`: statements 27.91 / branches 90.43 / functions 73.58 / lines 27.91 against floors 14 / 87 / 53 / 14; `health.ts` is 100/100/92.85/100 | `npm run test:coverage` on fc9e936, 2026-09-01 |

**Decisions (binding, from the item brief and the critique):**
1. Option (b) fail-fast. No in-process re-registration; nothing in `connection.ts`.
2. The policy is IDEMPOTENT per process (first `onLost` wins) — required because a deferred exit that is not idempotent fires twice.
3. Bounded teardown: `flushBackgroundWrites()` raced against a 2 000 ms grace timer, then `exit(1)`. Never `DRAIN_TIMEOUT_MS` — on a dead channel in-flight acks cannot succeed, so there is nothing to wait for beyond the writes.
4. A single-queue `basic.cancel` ALSO exits (default path; replicas=1 — a lane nobody consumes is a lane whose judgments queue forever, and nothing in-process re-consumes it).
5. No optional `graceMs` knob on the policy. It would add an uncovered `??` branch against 3.4 points of branch headroom in `src/worker/**` and nothing needs it (YAGNI); tests use the exported constant under fake timers.
6. Integration test asserts the EPOCH (registry emptied, `reconnectScheduled === true`, new connection, broker holds no consumer), never `process.exit`.
7. Docs: CONTRIBUTING.md:1221-1247 is rewritten with a CORRECTION note; README's matching blockquote gets a dated update paragraph; `main.ts`/`health.ts` docblocks change in the task that makes them true. The dated handoff/register documents are NOT edited (they are records; the U7 docs bundle owns them). This plan takes ownership of CONTRIBUTING.md:1240-1246 ("five queues / other three") because it sits inside the subsection being rewritten — U7 must drop that range.
8. homelab: comment-only edits to `deployment.yaml:282` and `:294-314`, own PR, NO Chart.yaml bump, NO stable.yaml entry. A comment-only template change re-packages the chart (reconcileStrategy `Revision`, `apps/public/judge-arena/helmrelease.yaml:130`) but renders an identical object, so no rollout occurs — Task 4 proves that with a render diff.
9. Homelab PR #932 (`feat/judge-arena-broker-zone-spread` @ 4cbcb97, OPEN, draft, title suffixed "[DO NOT MERGE — needs change window]") stays blocked until THIS change is promoted; merging it rolls all three brokers and would reproduce the outage on today's image.

**File map:**

| file | change |
|---|---|
| `src/worker/health.ts` | + `CONSUMER_LOSS_GRACE_MS`, `CONSUMER_LOSS_EXIT_CODE`, `ConsumerLossPolicyDeps`, `createConsumerLossPolicy` (Task 1); docblocks at :34-35 and :195-201 (Task 2) |
| `tests/lib/worker-health.test.ts` | + `describe('createConsumerLossPolicy …')` with 5 tests; header note (Task 1) |
| `src/worker/main.ts` | `onLost` → policy (:187-194); docblocks :41-43, :59-75; null-message comment :281-284 (Task 2) |
| `tests/integration/consumer-loss-epoch.test.ts` | NEW — socket-loss epoch + basic.cancel route against the real broker (Task 2) |
| `CONTRIBUTING.md:1221-1247`, `README.md:337-353` | contract rewrite with CORRECTION (Task 3) |
| `/root/homelab-setup/charts/judge-arena/templates/deployment.yaml:282-285`, `:294-314` | comment-only, separate PR (Task 4) |

---

### Task 1: The policy — idempotent, bounded flush, exit 1

**Files:**
- Modify: `/root/judge-arena/src/worker/health.ts:221-223` (insert between the end of `trackConsumerRegistration` and `export interface WorkerHealthDeps {`)
- Test: `/root/judge-arena/tests/lib/worker-health.test.ts` (imports at :50-60; header at :44-47; append a describe block at end of file)

**Interfaces:**
- Consumes: `createConsumerRegistry(onLost)` (`health.ts:143-145`, signature `(reason: string, remaining: number) => void`), `trackConsumerRegistration` (`health.ts:212-216`), `EXPECTED_CONSUMER_COUNT` (`health.ts:76`), `WORKER_CONSUMER_QUEUES` (`health.ts:71-75`).
- Produces (Task 2 relies on these exact names):
  ```ts
  export const CONSUMER_LOSS_GRACE_MS = 2_000;
  export const CONSUMER_LOSS_EXIT_CODE = 1;
  export interface ConsumerLossPolicyDeps {
    exit: (code: number) => void;
    log: (message: string, context: Record<string, unknown>) => void;
    flush: () => Promise<void>;
    missing: () => string[];
  }
  export function createConsumerLossPolicy(deps: ConsumerLossPolicyDeps): (reason: string, remaining: number) => void;
  ```

- [ ] **Step 1: Write the failing tests**

In `/root/judge-arena/tests/lib/worker-health.test.ts`, change the two import statements. Old (line 50):

```ts
import { describe, expect, it } from 'vitest';
```

New:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
```

Old (lines 53-60):

```ts
import {
  EXPECTED_CONSUMER_COUNT,
  WORKER_CONSUMER_QUEUES,
  createConsumerRegistry,
  evaluateWorkerHealth,
  trackConsumerRegistration,
  type ConsumerRegistry,
} from '@/worker/health';
```

New:

```ts
import {
  CONSUMER_LOSS_GRACE_MS,
  EXPECTED_CONSUMER_COUNT,
  WORKER_CONSUMER_QUEUES,
  createConsumerLossPolicy,
  createConsumerRegistry,
  evaluateWorkerHealth,
  trackConsumerRegistration,
  type ConsumerRegistry,
} from '@/worker/health';
```

Extend the header comment. Old (lines 44-47):

```ts
 * that gap needs the registration loop lifted out of `main()` into an
 * injectable function the way `handleDispatchFailure` already was (see
 * src/worker/dispatch-failure.ts).
 */
```

New:

```ts
 * that gap needs the registration loop lifted out of `main()` into an
 * injectable function the way `handleDispatchFailure` already was (see
 * src/worker/dispatch-failure.ts).
 *
 * ── FAIL-FAST (2026-09-01) ──────────────────────────────────────────────────
 * The registry's `onLost` in main.ts is now `createConsumerLossPolicy`, which
 * exits the process so restartPolicy re-runs boot. The policy is covered
 * below with an injected `exit`; the main.ts line that installs it is, like
 * every other main() call site, unreachable from here — it is verified by a
 * local smoke (kill the worker's broker connection, watch it exit 1) and by
 * tests/integration/consumer-loss-epoch.test.ts, which shows what a reconnect
 * restores WITHOUT the exit: a socket, a channel, zero consumers.
 */
```

Append at the very end of the file:

```ts

// ─── Fail-fast on consumer loss ─────────────────────────────────────────────

describe('createConsumerLossPolicy — consumer loss exits the process', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** A flush that never settles: the case the grace timer exists for. */
  const neverSettles = (): Promise<void> => new Promise<void>(() => {});

  /**
   * A booted registry whose onLost IS the policy, wired the way main.ts wires
   * it: `missing` reads back from the registry the policy is installed on.
   * Annotated so the self-reference inside `missing` is not a circular
   * inference for tsc.
   */
  function bootedWithPolicy(flush: () => Promise<void> = neverSettles) {
    const exit = vi.fn<(code: number) => void>();
    const log = vi.fn<(message: string, context: Record<string, unknown>) => void>();
    const registry: ConsumerRegistry = createConsumerRegistry(
      createConsumerLossPolicy({ exit, log, flush, missing: () => registry.missing() })
    );
    for (const queue of WORKER_CONSUMER_QUEUES) registry.register(queue, `amq.ctag-${queue}`);
    return { exit, log, registry };
  }

  it('exits exactly once with code 1 when a connection loss fires onLost TWICE (the real main.ts wiring)', async () => {
    // main.ts attaches two SCOPED trackers to ONE connection: the shared
    // confirm channel owns the fallback + run.create, the lane channel owns
    // the eight lanes. amqplib delivers a socket loss as conn 'error' FIRST
    // (connection.js onSocketError), and both scoped conn-'error' listeners
    // drop a non-empty subset, so the registry's size-unchanged guard cannot
    // dedupe them: onLost runs twice for one failure. A deferred exit that is
    // not idempotent therefore fires twice. Emission order below is
    // amqplib's: conn 'error' -> every channel 'close' -> conn 'close'.
    const conn = new EventEmitter();
    const confirmChannel = new EventEmitter();
    const laneChannel = new EventEmitter();
    const { exit, log, registry } = bootedWithPolicy();
    trackConsumerRegistration(registry, { conn, channel: confirmChannel }, [
      LANE_FALLBACK_QUEUE,
      QUEUE_RUN_CREATE,
    ]);
    trackConsumerRegistration(registry, { conn, channel: laneChannel }, LANE_QUEUES);

    conn.emit('error', new Error('ECONNRESET'));
    confirmChannel.emit('close');
    laneChannel.emit('close');
    conn.emit('close');

    expect(registry.registered()).toBe(0);
    // The flush never settles, so nothing exits until the grace elapses.
    await vi.advanceTimersByTimeAsync(CONSUMER_LOSS_GRACE_MS - 1);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(log).toHaveBeenCalledTimes(1);
    // The log line names the FIRST scope that went dark, and the expectation.
    expect(log.mock.calls[0][1]).toMatchObject({
      reason: 'amqp connection error',
      remaining: LANE_QUEUES.length,
      expected: EXPECTED_CONSUMER_COUNT,
      missing: [LANE_FALLBACK_QUEUE, QUEUE_RUN_CREATE],
      graceMs: CONSUMER_LOSS_GRACE_MS,
    });
  });

  it('exits on a single lane cancelled by the broker (basic.cancel -> null message -> unregister)', async () => {
    // DECISION: with replicas=1 a lane without a consumer is a lane whose
    // judgments queue forever, and nothing in-process re-consumes it. The
    // registry routes unregister() through the same onLost as a full clear,
    // so this needs no extra wiring — this test pins that it stays so.
    const { exit, log, registry } = bootedWithPolicy();

    registry.unregister(LANE_QUEUES[5], 'broker cancelled the consumer');
    await vi.advanceTimersByTimeAsync(CONSUMER_LOSS_GRACE_MS);

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(log.mock.calls[0][1]).toMatchObject({
      reason: 'broker cancelled the consumer',
      remaining: EXPECTED_CONSUMER_COUNT - 1,
      missing: [LANE_QUEUES[5]],
    });
  });

  it('does not exit during a deliberate drain', async () => {
    // SIGTERM cancels every consumer on purpose. The registry suppresses
    // onLost while draining (createConsumerRegistry), so the policy is never
    // consulted; a drain that exited 1 would turn every rollout into a crash
    // in the Deployment's history.
    const { exit, log, registry } = bootedWithPolicy();

    registry.beginDrain();
    registry.clear('drained');
    await vi.advanceTimersByTimeAsync(CONSUMER_LOSS_GRACE_MS * 2);

    expect(exit).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('exits as soon as the background writes are flushed, before the grace elapses', async () => {
    const flush = vi.fn(async () => {});
    const { exit, registry } = bootedWithPolicy(flush);

    registry.clear('amqp connection error');
    // Settle the promise chain WITHOUT moving the fake clock: tickAsync starts
    // on a real macrotask, so every pending microtask runs first.
    await vi.advanceTimersByTimeAsync(0);

    expect(flush).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    // The grace timer was cancelled — it must not exit a second time.
    await vi.advanceTimersByTimeAsync(CONSUMER_LOSS_GRACE_MS);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('a flush that outlives the grace does not exit twice when it finally settles', async () => {
    let release: () => void = () => {};
    const flush = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    const { exit, registry } = bootedWithPolicy(flush);

    registry.clear('amqp channel closed');
    await vi.advanceTimersByTimeAsync(CONSUMER_LOSS_GRACE_MS);
    expect(exit).toHaveBeenCalledTimes(1);

    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(exit).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the test file to verify it fails**

Run: `cd /root/judge-arena && npx vitest run tests/lib/worker-health.test.ts`
Expected: FAIL at import time — `SyntaxError: The requested module '/src/worker/health.ts' does not provide an export named 'CONSUMER_LOSS_GRACE_MS'` (or the same for `createConsumerLossPolicy`). Every test in the file is reported failed because the module fails to load; that is the expected red.

- [ ] **Step 3: Write the implementation**

In `/root/judge-arena/src/worker/health.ts`, insert the block below immediately BEFORE line 223 `export interface WorkerHealthDeps {` (i.e. after the closing `}` of `trackConsumerRegistration` at line 221 and its blank line). Use Edit with `old_string` = `export interface WorkerHealthDeps {` and `new_string` = the block followed by a blank line and `export interface WorkerHealthDeps {`:

```ts
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
```

- [ ] **Step 4: Run the test file to verify it passes**

Run: `cd /root/judge-arena && npx vitest run tests/lib/worker-health.test.ts`
Expected: PASS — 35 tests (30 existing + 5 new), 0 failed.

- [ ] **Step 5: Injection (three, each restored before the next)**

Injection A — the idempotency latch. In `health.ts` delete the line `    if (fired) return;` inside `createConsumerLossPolicy`.
Run: `cd /root/judge-arena && npx vitest run tests/lib/worker-health.test.ts -t "fires onLost TWICE"`
Expected: FAIL — `expected "spy" to be called 1 times, but got 2 times` on `expect(exit).toHaveBeenCalledTimes(1)` (and the `log` count assertion would fail the same way). Restore the line.

Injection B — the drain suppression the policy relies on. In `health.ts` `drop()` (line 158 before this task's insert) delete `    if (draining) return;`.
Run: `cd /root/judge-arena && npx vitest run tests/lib/worker-health.test.ts -t "does not exit during a deliberate drain"`
Expected: FAIL — `expected "spy" to be called 0 times, but got 1 times` on `expect(exit).not.toHaveBeenCalled()`. (The pre-existing test `does not log a consumer loss for the deliberate cancel` goes red too — same defect, second witness.) Restore the line.

Injection C — the early exit on flush. In `health.ts` change `      .then(exitOnce, exitOnce)` to `      .then(() => {}, () => {})`.
Run: `cd /root/judge-arena && npx vitest run tests/lib/worker-health.test.ts -t "before the grace elapses"`
Expected: FAIL — `expected "spy" to be called 1 times, but got 0 times` on the first `expect(exit).toHaveBeenCalledTimes(1)`. Restore.

After restoring all three: `npx vitest run tests/lib/worker-health.test.ts` → 35 passed.

- [ ] **Step 6: Gates**

```bash
grep DATABASE_URL /root/judge-arena/.env.test     # must print localhost:5432/judge_arena_test
cd /root/judge-arena && npm run lint && npx tsc --noEmit && npm run test:coverage
cd /root/judge-arena && npm run test:db:coverage && npm run test:integration && npm run build
```
Expected: lint 0 problems; tsc 0; unit `Tests  874 passed (874)` with every threshold met (health.ts stays 100/100/≥92.85/100; the two new `if`s are both covered on both arms, so `src/worker/**` branches do not fall below 90); db 670 passed; integration 80 passed; build succeeds.

- [ ] **Step 7: Commit**

```bash
cat > /tmp/ja-commit-1.txt <<'EOF'
feat(worker): consumer-loss policy — log once, flush, exit 1

The registry in src/worker/health.ts has known since b63d061 when this
worker stops consuming; it has never done anything about it, because the
tcpSocket liveness probe cannot see a 503 and connection.ts's reconnect loop
restores a socket, a channel and the topology and never a consumer. This adds
the thing that acts: createConsumerLossPolicy, an onLost that logs once,
flushes the fire-and-forget writes with a 2 s bound, and exits 1 so
restartPolicy re-runs boot — the ONE registration path proven to bring up all
ten consumers.

IDEMPOTENT BY NECESSITY, not tidiness. main.ts installs two SCOPED trackers
on one connection, and amqplib emits conn 'error' before any 'close', so a
connection loss calls onLost TWICE; the registry's size-unchanged guard cannot
dedupe two non-empty scoped drops. The unit test models that exact wiring —
two scoped trackConsumerRegistration calls sharing one conn EventEmitter,
emitted in amqplib's order — and goes red on a non-idempotent policy where the
single-tracker version of the test would not have.

THE FLUSH IS THE PART A BARE process.exit(1) WOULD HAVE SKIPPED. drain()
flushes background writes before $disconnect() and calls it "the worst time
to drop them"; a policy that exits from an event listener has no drain, so it
races flushBackgroundWrites() against a grace timer instead.

A single lane cancelled by the broker (basic.cancel -> null message ->
unregister) exits too, by the default path through drop() -> onLost, and a
test pins that. With replicas=1 a lane nobody consumes is a lane whose
judgments queue forever.

Not wired yet — main.ts's onLost still only logs. Next commit.

Gates: lint 0, tsc 0, 874 unit / 670 db / 80 integration, coverage 0.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_018ACKb44as67Hz9R3sxexc7
EOF
git -C /root/judge-arena add src/worker/health.ts tests/lib/worker-health.test.ts
git -C /root/judge-arena commit -F /tmp/ja-commit-1.txt
git -C /root/judge-arena log --oneline -1
```
If the gate run printed different counts than 874 / 670 / 80, put the printed numbers in the Gates line before committing.

---

### Task 2: Wire it into the worker, pin the epoch against a real broker, smoke the real exit

**Files:**
- Modify: `/root/judge-arena/src/worker/main.ts:97-104` (import), `:41-43` and `:69-76` (module doc), `:187-194` (`onLost`), `:281-285` (null-message comment)
- Modify: `/root/judge-arena/src/worker/health.ts:34-35` and `:195-201` (docblocks that say "detection only")
- Create: `/root/judge-arena/tests/integration/consumer-loss-epoch.test.ts`
- Test: `/root/judge-arena/tests/integration/consumer-loss-epoch.test.ts` + a local smoke against the podman broker

**Interfaces:**
- Consumes: `createConsumerLossPolicy`, `ConsumerLossPolicyDeps` (Task 1); `flushBackgroundWrites` (`src/lib/background-writes.ts:67`, already imported at `main.ts:85`); `logger.error(msg, data?)` (`src/lib/logger.ts` `Logger` interface); `getRabbit`/`closeRabbit`/`getConnectionState` (`src/lib/queue/connection.ts:275`, `:319`, `:346`); `createConsumerRegistry`/`trackConsumerRegistration` (`health.ts:143`, `:212`).
- Produces: a worker that exits 1 on consumer loss; `tests/integration/consumer-loss-epoch.test.ts` (2 tests) that Task 3's docs name.

- [ ] **Step 1: Write the failing integration test**

Create `/root/judge-arena/tests/integration/consumer-loss-epoch.test.ts`:

```ts
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
```

- [ ] **Step 2: Run it to verify it passes against the CURRENT tree, then make it red by injection**

This test pins behaviour that already exists (the epoch the fix relies on), so its first run is green; the red is produced by injection, per CONTRIBUTING.md:210-234.

Run: `cd /root/judge-arena && sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.integration.config.ts tests/integration/consumer-loss-epoch.test.ts'`
Expected: PASS — 2 tests.

Injection A — the reconnect. In `/root/judge-arena/src/lib/queue/connection.ts` delete line 223 `    scheduleReconnect();` (inside the `'close'` handler of `createConnection`).
Run: the same command.
Expected: FAIL — `expected false to be true` at `expect(lost.reconnectScheduled).toBe(true)`. Restore the line.

Injection B — the detector. In `/root/judge-arena/src/worker/health.ts` comment out all four `amqp.…on(...)` lines in `trackConsumerRegistration` (lines 217-220 on HEAD; shifted by Task 1's insert, which sits BELOW them, so still 217-220).
Run: the same command.
Expected: FAIL — `expected 1 to be 0` at `expect(registry.registered()).toBe(0)` in the first test. Restore.

Injection C — the null-message route. In `health.ts` change `unregister(queue, reason) { drop(reason, [queue]); }` to `drop(reason, []);`.
Run: the same command.
Expected: FAIL — the second test times out: `Test timed out in 5000ms` (the `reported` promise never resolves because `drop([])` changes nothing and `onLost` never fires). Restore.

After restoring all three: the file passes again (2 tests).

- [ ] **Step 3: Wire the policy into main.ts**

In `/root/judge-arena/src/worker/main.ts`:

(a) Import. Old (lines 97-104):

```ts
import {
  EXPECTED_CONSUMER_COUNT,
  WORKER_CONSUMER_QUEUES,
  createConsumerRegistry,
  evaluateWorkerHealth,
  trackConsumerRegistration,
  type ConsumerRegistry,
} from './health';
```

New:

```ts
import {
  EXPECTED_CONSUMER_COUNT,
  WORKER_CONSUMER_QUEUES,
  createConsumerLossPolicy,
  createConsumerRegistry,
  evaluateWorkerHealth,
  trackConsumerRegistration,
  type ConsumerRegistry,
} from './health';
```

(`EXPECTED_CONSUMER_COUNT` stays imported — the boot log at line 362 still uses it.)

(b) The `onLost`. Old (lines 187-194):

```ts
  const consumers = createConsumerRegistry((reason, remaining) => {
    logger.error('amqp consumers lost — this worker has stopped consuming', {
      reason,
      remaining,
      expected: EXPECTED_CONSUMER_COUNT,
      missing: consumers.missing(),
    });
  });
```

New:

```ts
  // FAIL FAST. Consumer loss is not recoverable in this process: connection.ts's
  // reconnect loop restores the socket, one confirm channel and the topology —
  // never the lane channel, never a prefetch, never a single consume() — and
  // the tcpSocket liveness probe cannot see any of that (the health server
  // keeps accepting TCP with zero consumers). Exiting hands recovery to the
  // ONE registration path proven to bring up all ten consumers — this
  // function — with Kubernetes' restartPolicy supplying the retry. See
  // createConsumerLossPolicy (health.ts) for the idempotency and the bounded
  // flush of fire-and-forget writes. Annotated because the policy's `missing`
  // reads back from the registry it is installed on.
  const consumers: ConsumerRegistry = createConsumerRegistry(
    createConsumerLossPolicy({
      exit: (code) => process.exit(code),
      log: (message, context) => logger.error(message, context),
      flush: flushBackgroundWrites,
      missing: () => consumers.missing(),
    })
  );
```

(c) Module doc, first site. Old (lines 41-43):

```
 * the regression. And the lane channel is NOT managed by connection.ts's
 * reconnect loop: it dies with its connection and is not recreated, exactly
 * like today's consumers. Detection, not recovery — see below.
```

New:

```
 * the regression. And the lane channel is NOT managed by connection.ts's
 * reconnect loop: it dies with its connection and is not recreated, exactly
 * like the consumers. That is why consumer loss EXITS — see below.
```

(d) Module doc, second site. Old (lines 69-76):

```
 * `checks.consumers` closes that gap: it is the LIVE registration count
 * (`ConsumerRegistry` below), and it participates in the `healthy`
 * conjunction, so zero consumers => 503 => the readiness probe fails => the
 * replica goes unavailable => the existing KubeDeploymentReplicasMismatch
 * alert fires. Detection only — the actual re-registration-on-reconnect fix
 * is separate, later work (see the FOLLOW-UP note on
 * `trackConsumerRegistration`).
 */
```

New:

```
 * `checks.consumers` closes that gap: it is the LIVE registration count
 * (`ConsumerRegistry` below), and it participates in the `healthy`
 * conjunction, so zero consumers => 503 => the readiness probe fails => the
 * replica goes unavailable => the existing KubeDeploymentReplicasMismatch
 * alert fires.
 *
 * ── Consumer loss EXITS the process (2026-09-01) ────────────────────────────
 * Detection alone left the pod 1/1 Running with a 503 forever: the liveness
 * probe is tcpSocket (homelab charts/judge-arena/templates/deployment.yaml)
 * and this health server keeps accepting TCP with zero consumers, so
 * Kubernetes never restarted it and recovery was a human running
 * `kubectl rollout restart`. The registry's `onLost` is now
 * `createConsumerLossPolicy` (health.ts): log once, flush the background
 * writes (bounded), `process.exit(1)`. restartPolicy brings the container
 * back through THIS function, the only consume path there is. All three loss
 * routes reach it — socket loss (conn 'error'/'close'), a channel-level close
 * with the connection alive (channel 'error'/'close'; the shape the five-day
 * silence most likely took), and a broker `basic.cancel` (null message ->
 * `unregister`). During a genuine broker outage this is a visible
 * CrashLoopBackOff (bounded, 5-minute backoff cap, self-clearing when the
 * broker returns) instead of a silent zombie. CORRECTION: the paragraph above
 * used to end "Detection only — the actual re-registration-on-reconnect fix
 * is separate, later work"; re-registration was rejected, not deferred (see
 * createConsumerLossPolicy's docblock for why).
 */
```

(e) Null-message comment. Old (lines 281-285):

```ts
        // On a lane this is not hypothetical: `x-single-active-consumer` makes
        // the broker cancel the losing consumer on failover, so the ONE thing
        // that keeps a lane serial is also the thing that hands this callback
        // a null.
        if (!msg) {
```

New:

```ts
        // On a lane this is not hypothetical: `x-single-active-consumer` makes
        // the broker cancel the losing consumer on failover, so the ONE thing
        // that keeps a lane serial is also the thing that hands this callback
        // a null. `unregister` reaches the loss policy, so this EXITS too:
        // with replicas=1 a lane nobody consumes is a lane whose judgments
        // queue forever, and nothing in-process re-consumes it.
        if (!msg) {
```

- [ ] **Step 4: Retire the "detection only" docblocks in health.ts**

In `/root/judge-arena/src/worker/health.ts`:

(a) Old (lines 34-36):

```
 * DETECTION ONLY. Re-registering consumers on reconnect is the real fix and is
 * deliberately not attempted here.
 */
```

New:

```
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
```

(b) Old (lines 195-201):

```
 * FOLLOW-UP (tier 2, deliberately NOT implemented here): re-registration
 * belongs in these same 'close' handlers — await a fresh `getRabbit()` with
 * backoff, re-`prefetch`, re-`consume` every queue, `register()` each new
 * tag. It does NOT belong in `src/lib/queue/connection.ts`'s reconnect loop:
 * that module is shared with the web tier, which publishes and never
 * consumes. Until that lands, this fix only makes the loss VISIBLE (503 ->
 * readiness -> KubeDeploymentReplicasMismatch); recovery is a pod restart.
```

New:

```
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
```

- [ ] **Step 5: Compile and run the two suites this touches**

Run: `cd /root/judge-arena && npx tsc --noEmit && npx vitest run tests/lib/worker-health.test.ts && sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.integration.config.ts tests/integration/consumer-loss-epoch.test.ts'`
Expected: tsc 0 errors (in particular no TS7022 on `consumers` — the annotation prevents it); 35 unit tests pass; 2 integration tests pass.

- [ ] **Step 6: Smoke the real exit against the podman broker (the only way to reach main()'s wiring)**

Run `npm run test:db:coverage` first if the gate order has not been run yet in this task — the worker's reaper queries the schema at `.env.test`, and that command is what keeps `judge_arena_test` migrated. Then:

```bash
# 1. Boot the worker against the podman rig on a spare health port; capture stdout+stderr and the exit code.
cd /root/judge-arena && (set -a; . ./.env.test; set +a; WORKER_HEALTH_PORT=19090 npx tsx src/worker/main.ts; echo "worker exit=$?") > /tmp/ja-consumer-loss-smoke.log 2>&1 &
sleep 12
grep -a -c 'judge worker started' /tmp/ja-consumer-loss-smoke.log          # expect: 1
grep -a 'judge worker started' /tmp/ja-consumer-loss-smoke.log | grep -a -o '"consumers":10,"expectedConsumers":10'   # expect a match

# 2. Find the worker's connection: it is the one holding TWO channels (confirm + lane), newest connected_at.
podman exec judge-arena-rabbitmq rabbitmqctl list_connections pid channels connected_at

# 3. Close it from the broker side (LOCAL podman broker only — never the cluster from a plan step).
podman exec judge-arena-rabbitmq rabbitmqctl close_connection '<the pid whose channels column is 2>' 'consumer-loss smoke'
sleep 4

# 4. Observe.
grep -a -E 'amqp consumers lost|worker exit=' /tmp/ja-consumer-loss-smoke.log
```
Expected, in this order, in the log: exactly ONE line containing `amqp consumers lost — exiting so the pod restarts and boot re-registers every consumer` with `"expected":10` and a non-empty `"missing":[...]`, then `worker exit=1` within ~2 s of it. (A server-initiated close arrives at amqplib as conn `'error'` then `'close'`, so `reason` will read `amqp connection error`.) If `worker exit=` is absent after 10 s, the process did not exit — that is a finding; do not proceed.

If the log shows the line TWICE, the idempotency latch is not in place — Task 1 was not applied.

- [ ] **Step 7: Gates**

```bash
grep DATABASE_URL /root/judge-arena/.env.test
cd /root/judge-arena && npm run lint && npx tsc --noEmit && npm run test:coverage
cd /root/judge-arena && npm run test:db:coverage && npm run test:integration && npm run build
```
Expected: lint 0; tsc 0; unit 874 passed, thresholds met (main.ts is still not imported by any unit test — the integration file imports `@/worker/health` and `@/lib/queue/connection` only, and the integration config has no coverage block); db 670; integration `Tests  82 passed (82)` (80 + 2); build ok.

- [ ] **Step 8: Commit**

```bash
cat > /tmp/ja-commit-2.txt <<'EOF'
fix(worker): exit on amqp consumer loss so restartPolicy re-registers

From 2026-08-24T17:55Z to 2026-08-29 this worker held zero AMQP consumers
while staying 1/1 Running with 0 restarts. b63d061 made that VISIBLE (/health
503 -> readiness -> KubeDeploymentReplicasMismatch) and nothing more: the
liveness probe is tcpSocket, the health server keeps accepting TCP with zero
consumers, so Kubernetes never restarted the pod, and recovery stayed a human
running `kubectl rollout restart`. The reconnect loop in connection.ts
restores a socket, one publish channel and the topology — never a prefetch,
never the lane channel, never a consume(). The only consume() calls in the
tree are in main()'s boot.

So main()'s onLost now IS the recovery: createConsumerLossPolicy logs once,
flushes the fire-and-forget writes with a 2 s bound, and exits 1;
restartPolicy re-runs boot. In-process re-registration was REJECTED, not
deferred: it is a second registration path that must re-create the lane
channel, re-prefetch both channels, re-consume ten queues, re-register each
tag AND re-attach the registry listeners on the new epoch's objects — or the
detector goes blind after the first recovery. That is the "N sibling call
sites, half-works without it" shape that shipped the escalating timeout into
one of three seams (60be6f6), and it is untestable until main()'s consume
loop is extracted. Nothing changes in connection.ts: the web tier shares it
and must keep publishing through reconnects.

ALL THREE LOSS ROUTES REACH THE POLICY through the registry: socket loss
(conn 'error'/'close'), channel-level close with the connection alive
(channel 'error'/'close' — the shape the five-day silence most likely took:
connection.ts silently recreates a consumer-less publish channel on the next
rabbitHealthy()), and broker basic.cancel (null message -> unregister). The
last exits on a SINGLE cancelled lane by design; replicas=1.

WHAT THE TESTS CAN AND CANNOT SHOW. The exit is unit-tested with an injected
exit (previous commit). tests/integration/consumer-loss-epoch.test.ts pins,
against the real broker, the epoch the fix relies on: destroy the socket
under a live consumer WITH an Error (amqplib listens only for 'error'/'end'
post-handshake — a bare destroy() emits 'close' and goes unnoticed for two
heartbeat intervals), and assert the registry empties, a reconnect is
scheduled, the next getRabbit() is a new connection, and the broker holds no
consumer. It does not assert process.exit — a real exit kills the vitest
worker. main()'s wiring is verified by the local smoke in the plan: boot the
worker against the podman broker, rabbitmqctl close_connection, one log line,
exit 1.

During a genuine broker outage the worker now CrashLoops visibly (bounded by
the 5-minute backoff cap, self-clearing when the broker returns) instead of
surviving as a zombie. The homelab liveness comment argued the opposite on a
premise that was false for consumers; a separate homelab PR corrects it.
homelab #932 (broker zone spread, rolls all three brokers) stays blocked until
this is promoted.

Gates: lint 0, tsc 0, 874 unit / 670 db / 82 integration, coverage 0.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_018ACKb44as67Hz9R3sxexc7
EOF
git -C /root/judge-arena add src/worker/main.ts src/worker/health.ts tests/integration/consumer-loss-epoch.test.ts
git -C /root/judge-arena commit -F /tmp/ja-commit-2.txt
git -C /root/judge-arena log --oneline -2
```
Put the printed counts in the Gates line if they differ from 874 / 670 / 82.

---

### Task 3: Docs — the contract is exit → restartPolicy → boot re-registers

**Files:**
- Modify: `/root/judge-arena/CONTRIBUTING.md:1221-1247` (the `### Known open production defect (2026-08-24 →, unfixed)` subsection, whole)
- Modify: `/root/judge-arena/README.md:351-353` (append a dated update to the blockquote that ends "roll can silently do this again.")
- Test: `npm run lint` (eslint does not lint markdown; the check here is `grep`-based, below)

**Interfaces:**
- Consumes: names from Tasks 1-2: `createConsumerLossPolicy`, `CONSUMER_LOSS_GRACE_MS`, `tests/lib/worker-health.test.ts`, `tests/integration/consumer-loss-epoch.test.ts`.
- Produces: nothing code-facing.

- [ ] **Step 1: Confirm the stale claims are where the plan says (line drift check)**

Run: `cd /root/judge-arena && grep -n "Known open production defect\|assert delivery resumes\|The reconnect defect is still open" CONTRIBUTING.md && grep -n "Live defect, open as of 2026-08-29\|roll can silently do this again" README.md`
Expected: CONTRIBUTING hits at 1221 and 1245 (the source's "asserting delivery resumes" phrasing deliberately does not match a literal "assert delivery resumes" grep — that is expected, not drift); README hits at 338 and 353. If they moved otherwise, edit at the printed lines.

- [ ] **Step 2: Rewrite the CONTRIBUTING subsection**

Replace lines 1221-1247 of `/root/judge-arena/CONTRIBUTING.md` — from `### Known open production defect (2026-08-24 →, unfixed)` through `blip reproduces this on a pod that stays `1/1 Running` with 0 restarts.` inclusive — with:

```markdown
### The 2026-08-24 consumer loss — what it was, and what now happens instead (fixed in code 2026-09-01; promoted separately)

Worth knowing before you touch the queue layer, because it was a code defect and not a config one:
**the evaluation pipeline was dead from 2026-08-24T17:55Z until the 2026-08-29 promote rolled the
worker.** At the time it was diagnosed, every work queue reported `consumer_count=0`. A Cozystack
v1.6.2 roll recreated `judge-arena-pg-1` at 17:54:57Z; 21 seconds later the worker logged `Can't
reach database server` / `terminating connection due to administrator command` (SQLSTATE `57P01`)
and then emitted no log line for five days. The pod was `1/1 Running` with 0 restarts throughout,
which is exactly why this is easy to miss. Its socket reconnected; **its AMQP consumers never
re-registered.** `src/lib/queue/connection.ts`'s reconnect loop restores the socket, one publish
channel and the topology — never a prefetch, never the lane channel, never a `consume()` — and the
only `consume()` calls in the tree are in `main()`'s boot (`src/worker/main.ts`).

**The contract now: consumer loss EXITS the process, and `restartPolicy` re-runs boot.** The
worker's `ConsumerRegistry` (`src/worker/health.ts`) drops a queue on every event that means its
consumer is gone — channel `'close'`/`'error'`, connection `'close'`/`'error'`, and a broker
`basic.cancel` (which amqplib hands the consume callback as a `null` message). Its `onLost` is
`createConsumerLossPolicy`: log once, race `flushBackgroundWrites()` against a
`CONSUMER_LOSS_GRACE_MS` (2 s) timer, `process.exit(1)`. Kubernetes restarts the container, and
boot — the one registration path that is proven to bring up all ten consumers — re-registers
everything. All three loss routes reach it, including a **single** cancelled lane (`replicas: 1`; a
lane nobody consumes is a lane whose judgments queue forever). A deliberate drain (SIGTERM) never
reaches it: the registry suppresses `onLost` after `beginDrain()`.

Three things follow from that, and two of them look like problems until you know why:

1. **During a genuine broker outage the worker CrashLoops.** That is intended. Boot throws in
   `getRabbit()`, `main().catch` exits 1, Kubernetes backs off to at most 5 minutes, and the loop
   clears itself the moment the broker answers. The alternative — a process that survives the
   outage and consumes nothing afterwards — is what August was. Do not "fix" it by switching the
   worker's liveness probe to `httpGet /health`; that would also restart on Redis/Postgres blips.
2. **In-process re-registration was rejected, not deferred.** It is a second registration path
   that must re-create the lane channel, re-`prefetch` both channels, re-`consume` ten queues,
   re-`register()` each tag *and* re-attach `trackConsumerRegistration` on the new epoch's objects
   (they are bound to boot-time `conn`/channel objects), or the detector goes blind after the first
   recovery. That is the shape of the §5.1 escalating-timeout miss — a feature spread across N
   sibling call sites that half-works without it — and it cannot be unit-tested until `main()`'s
   consume loop is extracted. Nothing changed in `connection.ts`: the web tier shares it and must
   keep publishing through reconnects.
3. **The tests are split by what a process can observe about itself.**
   `tests/lib/worker-health.test.ts` (`createConsumerLossPolicy — consumer loss exits the process`)
   drives the policy with an injected `exit` under fake timers, wired the way `main.ts` wires it —
   two scoped trackers on one connection, events emitted in amqplib's order (`conn 'error'` → each
   channel `'close'` → `conn 'close'`) — and asserts exit exactly once with 1; not during a drain;
   before the grace when the flush settles; never twice. `tests/integration/consumer-loss-epoch.test.ts`
   destroys the socket under a live consumer on the real broker (with
   `stream.destroy(new Error(...))` — amqplib listens only for `'error'`/`'end'` after the handshake,
   so a bare `destroy()` goes unnoticed for two heartbeat intervals) and asserts the epoch the fix
   relies on: the registry empties, a reconnect is scheduled, the next `getRabbit()` is a new
   connection, and the broker holds no consumer. Neither asserts `process.exit` in a real process;
   the wiring in `main()` is verified by booting the worker against the podman broker and
   `rabbitmqctl close_connection` on its connection — one log line, exit 1.

> **CORRECTION (2026-09-01).** Until this date this subsection was titled "Known open production
> defect (2026-08-24 →, unfixed)" and said three things that are no longer true or were wrong when
> written. (a) "The reconnect defect is still open" — closed by the change described above.
> (b) "If you fix it, the test for it belongs in `tests/integration/` (real broker), and … the
> injection to try is killing the connection out from under a live consumer and asserting delivery
> resumes." That prescription assumed the fix would re-consume in-process. Under fail-fast, delivery
> resumes in a **new** process, which no in-process test can assert — item 3 above is what replaced
> it. (c) "all five RabbitMQ queues … The other three (`judge.dlq`, `judgment.retry.30s`,
> `judgment.retry.5m`) still read 0 consumers and always should" — true of the topology on
> 2026-08-24, before per-server lanes (v2j). On 2026-09-01 `rabbitmqctl list_queues name consumers`
> on the production broker reported **fifteen** queues: eight `judgment.execute.lane.N`, the
> fallback `judgment.execute` and `run.create` with one consumer each (`consumers == expectedConsumers
> == 10` in the boot log), and `judge.dlq` plus four `judgment.retry.*` queues at 0 consumers by
> design. "Ten queues at one" is the shape of health now; "the two work queues at one" no longer is.
```

- [ ] **Step 3: Append the dated update to README's blockquote**

In `/root/judge-arena/README.md`, old (lines 351-353):

```markdown
> 0 consumers and always will — they have no consumer by design, so they are not a signal either way;
> the two work queues are.) Nothing about the reconnect path changed, so the next broker or Postgres
> roll can silently do this again.
```

New:

```markdown
> 0 consumers and always will — they have no consumer by design, so they are not a signal either way;
> the two work queues are.) Nothing about the reconnect path changed, so the next broker or Postgres
> roll can silently do this again.
>
> **Update (2026-09-01) — fixed, by exiting.** The worker no longer outlives a lost consumer set:
> the registry's `onLost` is `createConsumerLossPolicy` (`src/worker/health.ts`), which logs once,
> flushes the fire-and-forget writes with a 2 s bound and `process.exit(1)`s; Kubernetes'
> `restartPolicy` re-runs boot, the only path that registers consumers. In-process re-registration
> was rejected on purpose, and a broker outage now CrashLoops the worker visibly instead of leaving
> a zombie — both explained in CONTRIBUTING.md under "The 2026-08-24 consumer loss". The queue count
> quoted above was true on 2026-08-24; since per-server lanes landed there are ten consumed queues
> (`consumers == expectedConsumers == 10` in the worker's boot log).
```

- [ ] **Step 4: Verify (no test framework covers markdown; make the check explicit)**

Run: `cd /root/judge-arena && grep -n "Known open production defect\|assert delivery resumes\|The reconnect defect is still open" CONTRIBUTING.md; grep -n "fixed, by exiting" README.md; grep -c "createConsumerLossPolicy" CONTRIBUTING.md README.md src/worker/health.ts src/worker/main.ts`
Expected: the first grep prints exactly ONE line — "The reconnect defect is still open" inside item (a) of the `> **CORRECTION (2026-09-01).**` quote. `Known open production defect` does NOT match: in the new quote it opens "Known open production" at the end of one wrapped markdown line and continues "defect (2026-08-24 →, unfixed)" on the next, and grep matches per physical line. `assert delivery resumes` does not match either, for the same reason Step 1 does not: the quote's phrasing is "asserting delivery" / "resumes." split across two wrapped lines. The second grep prints the README update line; the third prints a non-zero count for every one of the four files (the symbol exists where the docs say it does — a doc that names a function the tree does not export is the defect this step exists to catch).

Injection for a doc task: temporarily rename the export in `health.ts` to `createConsumerLossPolicyX` and rerun the fourth grep — the count for `src/worker/health.ts` drops, which is what tells you the docs would be lying. Restore. (This is the doc-level analogue of "a test that cannot go red"; it is cheap and it is the only check that exists for prose.)

- [ ] **Step 5: Gates**

```bash
cd /root/judge-arena && npm run lint && npx tsc --noEmit && npm run test:coverage
cd /root/judge-arena && npm run test:db:coverage && npm run test:integration && npm run build
```
Expected: identical to Task 2's numbers (874 / 670 / 82) — markdown changes touch nothing measured.

- [ ] **Step 6: Commit**

```bash
cat > /tmp/ja-commit-3.txt <<'EOF'
docs(worker): the consumer-loss defect is closed by exiting — correct CONTRIBUTING and README

CONTRIBUTING's "Known open production defect (2026-08-24 →, unfixed)" said
three things that are now false or were wrong when written, and this repo
corrects rather than overwrites: (a) the defect is closed — onLost exits,
restartPolicy re-runs boot; (b) the prescribed test ("kill the connection
under a live consumer and assert delivery RESUMES") assumed an in-process
re-consume and cannot be satisfied by a fix that exits, so it names the two
tests that replaced it (the policy unit test with an injected exit; the
integration epoch test with stream.destroy(new Error) on the real broker);
(c) "five queues / the other three" described the pre-lane topology — the
production broker reports fifteen queues, ten consumed.

README's matching blockquote gets a dated update rather than a rewrite, in
the style of the update it already carries.

The dated handoff and register documents under docs/superpowers/plans are
records and are left as written.

Gates: lint 0, tsc 0, 874 unit / 670 db / 82 integration, coverage 0.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_018ACKb44as67Hz9R3sxexc7
EOF
git -C /root/judge-arena add CONTRIBUTING.md README.md
git -C /root/judge-arena commit -F /tmp/ja-commit-3.txt
git -C /root/judge-arena log --oneline -3
```

---

### Task 4: homelab-setup — correct the worker probe rationale (SEPARATE PR in /root/homelab-setup, comment-only)

**Files:**
- Modify: `/root/homelab-setup/charts/judge-arena/templates/deployment.yaml:282-285` (the `EVALUATION_MODEL_CONCURRENCY_PER_RUN` comment) and `:294-314` (the liveness rationale comment)
- NOT modified: `Chart.yaml` (0.3.1 — Revision strategy needs no bump for a re-package, and a comment-only change has no rendered effect to lose), `apps/public/judge-arena/stable.yaml` (only a promote entry touches it), `values.yaml`.
- Test: `helm template` render diff (must be empty) + `helm lint`

**Interfaces:**
- Consumes: the judge-arena contract from Tasks 1-3 (exit on consumer loss). This PR is safe to merge BEFORE the judge-arena image is promoted — it changes no object — but its text describes the post-promote behaviour, so it says so.
- Produces: a local branch + commit in `/root/homelab-setup` and a PR body for the operator. NO push (Global Constraints).

- [ ] **Step 1: Branch, and render the chart BEFORE the edit**

```bash
git -C /root/homelab-setup status --short          # must be empty
git -C /root/homelab-setup checkout -b docs/judge-arena-worker-probe-rationale main
cd /root/homelab-setup && helm template judge-arena charts/judge-arena > /tmp/ja-render-before.yaml && wc -l /tmp/ja-render-before.yaml
```
Expected: clean tree; branch created; render succeeds (805 lines on 2026-09-01 — the number is informational; what matters is Step 4's diff).

- [ ] **Step 2: Correct the prefetch comment**

In `/root/homelab-setup/charts/judge-arena/templates/deployment.yaml`, old (lines 282-285):

```yaml
            # Drives AMQP prefetch (main.ts sets prefetch = concurrency x 4)
            # and is the basis for worker.connectionLimit. Set explicitly so
            # the pool arithmetic in values.yaml stays checkable against a
            # value that is actually in the pod, not an app-side default.
```

New:

```yaml
            # The PER-JUDGE concurrency cap (src/worker/concurrency.ts
            # resolveWorkerConcurrency, clamped to HARD_CONCURRENCY_CAP) and
            # the basis for worker.connectionLimit. It does NOT drive AMQP
            # prefetch. CORRECTION (2026-09-01): this comment said "main.ts
            # sets prefetch = concurrency x 4"; prefetch is the constant
            # MAX_IN_FLIGHT_MESSAGES = 4 on the shared confirm channel and
            # LANE_PREFETCH = 1 on the lane channel (both in
            # src/worker/main.ts, from src/worker/concurrency.ts). Set
            # explicitly so the pool arithmetic in values.yaml stays checkable
            # against a value that is actually in the pod, not an app-side
            # default.
```

- [ ] **Step 3: Correct the liveness rationale**

Old (lines 294-314, the whole comment block between the `extraEnv` `{{- end }}` and `readinessProbe:`):

```yaml
          # :9090/health reports rabbitmq + redis + database (src/worker/
          # main.ts:70-77). That is the right signal for READINESS and the
          # wrong one for LIVENESS, for the same reason it is wrong on the web
          # tier — but the consequence here is worse, so the two probes point
          # at different things.
          #
          # Restarting a worker during a dependency outage is strictly worse
          # than leaving it alone. main() awaits getRabbit() (main.ts:89)
          # BEFORE it starts the health server (main.ts:93), and main().catch
          # calls process.exit(1) (main.ts:184-186). The running process holds
          # a reconnect loop with 1s->30s backoff (src/lib/queue/connection.ts)
          # that restores service the moment the broker returns; a restarted
          # process instead throws in getRabbit() and exits immediately, into
          # CrashLoopBackOff with up to 5-minute backoff. A dependency-health
          # liveness probe therefore converts a transient blip into an outage
          # that OUTLIVES it — and it fires on every replica simultaneously,
          # since they all observe the same broker.
          #
          # tcpSocket still catches what liveness is actually for: a process
          # whose listener has died or whose accept loop is wedged. It cannot
          # be tripped by a healthy worker patiently waiting on a broker.
```

New:

```yaml
          # :9090/health reports rabbitmq + redis + database reachability AND
          # live AMQP consumer registration (src/worker/health.ts
          # evaluateWorkerHealth; the handler is startHealthServer in
          # src/worker/main.ts). That is the right signal for READINESS and
          # the wrong one for LIVENESS, for the same reason it is wrong on the
          # web tier — but the consequence here is worse, so the two probes
          # point at different things.
          #
          # Restarting a worker during a DEPENDENCY outage is strictly worse
          # than leaving it alone. main() awaits getRabbit() BEFORE it starts
          # the health server, and main().catch calls process.exit(1) (all in
          # src/worker/main.ts; line numbers are deliberately not quoted here
          # — the ones this comment used to carry were stale within a month).
          # A restarted process throws in getRabbit() and exits immediately,
          # into CrashLoopBackOff with up to 5-minute backoff, and a
          # dependency-health liveness probe would fire on every replica at
          # once, since they all observe the same broker.
          #
          # CORRECTION (2026-09-01). This comment used to say the running
          # process "holds a reconnect loop ... that restores service the
          # moment the broker returns". For the WORKER that was false: the
          # loop (src/lib/queue/connection.ts) restores the socket, one
          # publish channel and the topology, and never re-issues a single
          # consume() — which is how the pipeline sat 1/1 Running, 0
          # restarts, consuming nothing from 2026-08-24 to 08-29 (stable.yaml
          # history). Since judge-arena's fail-fast change the worker EXITS 1
          # on consumer loss and restartPolicy re-runs boot, the only path
          # that registers consumers. So during a broker outage the worker
          # now CrashLoops VISIBLY (bounded, self-clearing when the broker
          # returns) instead of surviving as a zombie; that is intended, and
          # KubePodCrashLooping (for: 15m) alerts on it at the same latency
          # KubeDeploymentReplicasMismatch alerted on the NotReady zombie. Do
          # NOT "fix" it by switching liveness to httpGet /health — that would
          # also restart on Redis/Postgres blips, which the paragraph above
          # still rightly forbids.
          #
          # tcpSocket still catches what liveness is actually for: a process
          # whose listener has died or whose accept loop is wedged. It cannot
          # be tripped by a healthy worker patiently waiting on a broker.
```

- [ ] **Step 4: Prove it is comment-only — the rendered object must not change**

```bash
cd /root/homelab-setup && helm template judge-arena charts/judge-arena > /tmp/ja-render-after.yaml
diff <(grep -v '^[[:space:]]*#' /tmp/ja-render-before.yaml) <(grep -v '^[[:space:]]*#' /tmp/ja-render-after.yaml) && echo "RENDER IDENTICAL (comments excluded)"
helm lint charts/judge-arena
git -C /root/homelab-setup diff --stat
```
Expected: `RENDER IDENTICAL (comments excluded)`. `helm template` emits the templated TEXT verbatim — `#` comments pass straight through to stdout, so a raw (non-stripped) diff of this task's edit is NON-empty on purpose: the comment lines themselves changed. What proves the Kubernetes object is unchanged is that Helm's YAML parser drops `#` comments before the API server ever sees them, so comparing the two renders with comment lines excluded is what the API server effectively sees. Every line this task edits is a full-line block comment (never a trailing inline comment), so stripping `^[[:space:]]*#` lines is sound here. `helm lint` → `1 chart(s) linted, 0 chart(s) failed`; diff --stat shows exactly one file, `charts/judge-arena/templates/deployment.yaml`.

Injection (the doc analogue): temporarily change `port: health` under `livenessProbe` to `port: http`, re-render, and re-run the SAME comment-stripped diff — it is now non-empty (a real object change, not a comment, differs), which is what Step 4 exists to distinguish from the comment-only edit above, where it stays empty. Restore (`git -C /root/homelab-setup checkout -- charts/judge-arena/templates/deployment.yaml` would also discard Steps 2-3; instead revert only that one token by hand) and re-run the comment-stripped diff → `RENDER IDENTICAL (comments excluded)` again.

- [ ] **Step 5: Preflights that grep chart templates (comment text must not trip them)**

```bash
cd /root/homelab-setup && bash scripts/preflight/cluster-dns-suffix-check.sh && bash scripts/preflight/ingress-auth-buffer-check.sh
```
Expected: both pass (the new comments contain no `svc.cluster.local` and no `auth-url`).

- [ ] **Step 6: Commit locally (no push — the operator opens the PR)**

```bash
cat > /tmp/hl-commit-4.txt <<'EOF'
docs(judge-arena): worker probe rationale — the reconnect loop never restored consumers

Comment-only. `helm template` before/after is identical once comment lines
are excluded (Helm's YAML parser drops `#` comments before the API server
ever sees them; the raw rendered TEXT still carries them, so a non-stripped
diff is non-empty by design), so merging this re-packages the chart
(reconcileStrategy: Revision) and bumps the Helm release revision without
changing the rendered Deployment — no pod rolls. No Chart.yaml bump, no
stable.yaml entry: nothing about what runs changes here.

Two corrections, each marked CORRECTION in place rather than overwritten:

1. deployment.yaml's liveness rationale said the running worker "holds a
   reconnect loop ... that restores service the moment the broker returns".
   For consumers that was false — connection.ts restores the socket, one
   publish channel and the topology and never re-issues consume() — and it
   is the premise under which a worker sat 1/1 Running, 0 restarts,
   consuming nothing from 2026-08-24 to 08-29. judge-arena now EXITS 1 on
   consumer loss and restartPolicy re-runs boot, so a broker outage
   CrashLoops the worker visibly; the comment now says that is intended,
   that KubePodCrashLooping (for: 15m) alerts on it at the same latency
   KubeDeploymentReplicasMismatch alerted on the NotReady zombie, and that
   liveness must STAY tcpSocket (httpGet /health would restart on
   Redis/Postgres blips too). Its main.ts line references were stale; they
   are replaced by symbol names.

2. The EVALUATION_MODEL_CONCURRENCY_PER_RUN comment said main.ts sets
   "prefetch = concurrency x 4". Prefetch is the constant
   MAX_IN_FLIGHT_MESSAGES = 4 on the shared channel and LANE_PREFETCH = 1 on
   the lane channel; the variable is the per-judge concurrency cap.

The text describes the worker AFTER judge-arena's fail-fast change is
promoted. It is safe to merge before that promote (no object changes), but
PR #932 (broker zone spread, rolls all three brokers) stays blocked until the
promote lands: on today's image sha-d21f31d47c35 a broker roll reproduces the
August outage.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_018ACKb44as67Hz9R3sxexc7
EOF
git -C /root/homelab-setup add charts/judge-arena/templates/deployment.yaml
git -C /root/homelab-setup commit -F /tmp/hl-commit-4.txt
git -C /root/homelab-setup log --oneline -1
git -C /root/homelab-setup checkout main
```

- [ ] **Step 7: Leave the PR body for the operator**

Write `/tmp/hl-pr-4.md` with the following, and report its path; the operator pushes the branch and opens the PR (homelab's `gh pr edit` is broken per memory — use `gh pr create --body-file /tmp/hl-pr-4.md` once, not edit):

```markdown
## docs(judge-arena): worker probe rationale — the reconnect loop never restored consumers

**Comment-only.** `helm template charts/judge-arena` before/after is identical once comment lines are excluded (checked in the plan — Helm's parser drops `#` comments before the API server ever sees them; the raw rendered text still carries them, so a non-stripped diff is non-empty by design); reconcileStrategy `Revision` will re-package the chart and bump the release revision, but the rendered Deployment does not change, so **no pod rolls**. No `Chart.yaml` bump, no `stable.yaml` entry.

**What it corrects (marked CORRECTION in place):**
1. `deployment.yaml` liveness rationale: "the running process holds a reconnect loop … that restores service the moment the broker returns" was false for the worker's consumers — that premise is how the pipeline sat 1/1 Running, 0 restarts, consuming nothing 2026-08-24 → 08-29. judge-arena now exits 1 on consumer loss (`createConsumerLossPolicy`, `src/worker/health.ts`) and `restartPolicy` re-runs boot. A broker outage therefore CrashLoops the worker visibly; the comment says that is intended and that liveness must stay `tcpSocket`. Stale `main.ts:NN` references replaced by symbol names.
2. `EVALUATION_MODEL_CONCURRENCY_PER_RUN` comment: "prefetch = concurrency × 4" is stale; prefetch is constant 4 (shared channel) / 1 (lane channel).

**Ordering:** safe to merge before the judge-arena promote (changes no object). **PR #932 stays blocked** until the judge-arena fail-fast commit is promoted — on `sha-d21f31d47c35` a broker roll reproduces the August outage.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_018ACKb44as67Hz9R3sxexc7
```

---

## After the plan (operator, not the executor)

These are the steps the Global Constraints reserve for the operator. They are listed so the executor's final report can point at them, not so the executor runs them. Every cluster command below that is not `get`/`logs`/`list_queues`/`skopeo inspect` is a MUTATION and wants `preflight-mutation-review` first.

1. **Push judge-arena `main`** (three commits from Tasks 1-3). CI builds `sha-<12 of the Task 3 commit>`.
2. **Assert the image exists before anything else** (memory: green CI is not an image; handoff traps 3/4):
   `skopeo inspect --no-tags docker://harbor.cluster.asethi.com/homelab/judge-arena:sha-$(git -C /root/judge-arena rev-parse main | cut -c1-12)`
3. **Promote** — the usual two-file homelab PR: `apps/public/judge-arena/helmrelease.yaml:195` tag + `apps/public/judge-arena/stable.yaml:78` pin + a prepended history entry (`NO MIGRATION` — `git diff --name-only d21f31d..<sha> -- prisma/migrations/` is empty). The history entry should say this promote closes the "Detection only — the reconnect defect is still live, so PR #932 still needs a worker restart behind it" note at `stable.yaml:328-334`.
4. **Wait on the observable** — the worker Deployment's image string changing (handoff trap 5), then the boot log: `kubectl -n tenant-public logs deploy/judge-arena-worker --tail=20 | grep 'judge worker started'` → `consumers 10 / expectedConsumers 10`.
5. **Live verification (MUTATING — preflight first):** from a broker pod, `rabbitmqctl list_connections pid channels connected_at` (read-only) to find the worker's 2-channel connection, then `rabbitmqctl close_connection '<pid>' 'fail-fast verification'`. Expect: exactly one `amqp consumers lost` log line, `kubectl get pod` RESTARTS 1 on the worker, a fresh `judge worker started` with 10/10, and `rabbitmqctl list_queues name consumers` showing 1 on all ten work queues. Note the restart count — that is the number a #932 broker roll will multiply.
6. **Merge the Task 4 homelab PR** (any time; no roll).
7. **#932 becomes mergeable** without a manual worker restart. Its own remaining concerns (the two classic retry queues single-homed on server-2; broker `terminationGracePeriodSeconds: 604800`) are unrelated to this item.

---

## Self-review

**Spec coverage.** Item brief → task: fail-fast policy, idempotent, bounded `flushBackgroundWrites` with 2 000 ms grace, `deps.exit(1)` → Task 1. Wire into `main.ts` `onLost` → Task 2 Step 3. Single-queue `basic.cancel` also exits, documented why → Task 1 test 2 + Task 2 Step 3(e) + CONTRIBUTING text. Unit test with two scoped trackers sharing one conn, amqplib order, fake timers, exit exactly once with 1; not while draining; flush-early → Task 1 tests 1, 3, 4 (+ 2 and 5). Integration test with `stream.destroy(new Error(...))`, `reconnectScheduled === true`, registry emptied, no `process.exit` assertion → Task 2 Step 1. CONTRIBUTING.md:1221-1247 rewrite naming the two tests → Task 3. homelab `deployment.yaml:282` and `:294-314`, comment-only, does not roll the worker, #932 blocked → Task 4. Critique amendments (idempotency, bounded flush, three routes, U3 ordering, U7 range ownership) → "Why this shape" + Task 1 docblock + Depends on.

**Placeholder scan.** No TBD/TODO/"similar to"; every code block is complete; the only "fill in" instruction is to copy the gate output's actual test counts into the Gates line, which is a concrete action.

**Type consistency.** `createConsumerLossPolicy(deps: ConsumerLossPolicyDeps): (reason: string, remaining: number) => void` — identical in Task 1's Produces, its implementation, its tests (`bootedWithPolicy`) and Task 2's wiring. `ConsumerLossPolicyDeps` fields `exit`/`log`/`flush`/`missing` — identical across Task 1 interface, Task 1 tests, Task 2 `main.ts`. `CONSUMER_LOSS_GRACE_MS` (2_000) and `CONSUMER_LOSS_EXIT_CODE` (1) — same names in Task 1, the tests, Task 3 prose. `trackConsumerRegistration(registry, { conn, channel }, queues?)` used exactly as declared at `health.ts:212-216`. `getConnectionState()` shape `{ connected, reconnectScheduled, connectAttempts }` matches `connection.ts:346-356`. Integration file name `tests/integration/consumer-loss-epoch.test.ts` is the same string in Task 2, Task 3 and the test header note added in Task 1.
