# judge.dlq Admin CLI (`--list` / `--replay` / `--drop-stale`) + broker scrape & DLQ alert Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `judge.dlq` an operator verb — a bundled admin CLI that classifies dead-lettered judgments from the database, replays a chosen judgment through the real lane path with the three state resets the pipeline requires, and drops stale envelopes — and give the broker a scrape plus an audit-mode alert so a DLQ backlog is a signal instead of a hand-run `rabbitmqctl`.

**Architecture:** `scripts/admin/dlq.ts` exports `parseDlqArgs(argv)` and `runDlq(args, deps)` with every side effect constructor-injected (`DlqDeps`: a structural Prisma subset, a four-method channel, `publish`, `resolveLane`, `now`, `out`) in the shape of `DispatchFailureDeps` (src/worker/dispatch-failure.ts:69-71), so the unit suite drives it with in-memory fakes and no broker. `--list` is DB-side and never fetches a message (the queue's quorum `delivery_limit` of 20 makes every requeue-peek destructive); `--replay`/`--drop-stale` consume with `basic.get` only under `--yes` and ack an envelope strictly after the committed transaction and the confirmed publish. The deadline the replay stamps comes from ONE new shared helper, `batchDeadlineMs`, which also replaces the three existing hand-copied copies of the formula (the §5.1 drift shape). A separate homelab-setup PR adds the `VMServiceScrape` of `rabbitmq-judge-arena:prometheus` (`/metrics` + `/metrics/detailed?family=queue_coarse_metrics`) and an audit-mode `VMRule` on `max by (queue)(rabbitmq_detailed_queue_messages_ready{queue="judge.dlq"}) > 0`.

**Tech Stack:** TypeScript, Prisma 6.19.2 (`$transaction`, `satisfies Prisma.ModelJudgmentSelect`), amqplib 2.0.1 (`checkQueue`, `get` with `noAck:false`, `ack`/`nack`), vitest (unit only — no new integration file), esbuild (sixth Dockerfile bundle block), VictoriaMetrics operator CRDs (`VMServiceScrape`, `VMRule`) in homelab-setup.

**Spec:**
- Handoff: `/root/judge-arena/docs/superpowers/plans/2026-09-01-scoreboard-handoff.md` §1 (:46-49, :63) and §7 #5 (:312-313 — the "grew from 4" claim is FALSE, see Global facts below).
- Register: `/root/judge-arena/docs/superpowers/plans/2026-08-30-state-and-next-steps.md` §5.6 #10 (:444-446, same false claim), §5.5/3, T5 note (:313-331).
- Verified map: `/tmp/ja-plan-inputs/dlq-replay.json` — its `verify.contradictions` and `verify.corrections` OVERRIDE the map's `proposedChange` (in particular: `--list` is DB-side; no `queues` block on `/health`; the reaper's helpers are module-private; there are THREE deadline sites; the Dockerfile block is the SIXTH).
- Cross-item critique: `/tmp/ja-plan-inputs/critique.json` — `q2_missingInfoPerMap.dlq-replay`, `q3` (order: U3 → U2 → #1 → #5), `q4[0]` (list without consuming) and `q4[1]` (no /health depth) are binding.
- Conventions: `/tmp/ja-plan-inputs/product-health-facts.json`; CONTRIBUTING.md:205-266, :1488-1577.

**Priority / wave:** Wave 3 / #10 (M).

**Depends on:**
- `u3-hardcap-escapes-retry` (`docs/superpowers/plans/2026-09-01-u3-hardcap-escapes-retry.md`) — MUST be merged AND promoted to production before the replay verb is ever run against production: without it one replayed delivery of a wedged judge runs 3 × 900 s under a 930 s lease and re-creates exactly the attempt-3/attempt-4 duplicate envelopes this tool exists to drain.
- `finalizer-error-to-needs-human` (`docs/superpowers/plans/2026-09-01-finalizer-error-to-needs-human.md`) — with it, the run this CLI sets back to `judging` re-finalizes itself when the replayed judgment lands. The CLI still writes `status: 'judging', finalizedAt: null, deadlineAt` (binding decision 3).
- `calibration-sampling-snapshot` (`docs/superpowers/plans/2026-09-01-calibration-sampling-snapshot.md`) — `--list` prints sampling drift from `CalibrationRun.samplingParams` via `@/lib/calibration/sampling-drift` and resolves what a replay would run under via `@/lib/llm/sampling`'s `effectiveSamplingParams`. Both modules are created by that plan; this plan does not compile before it lands.

**Owner decisions needed:** ONE, recorded here and NOT made by this plan: disposition of the 10 live envelopes. They are 5 judgments × 2 envelopes from calibration run 1 (`cmtgib0xr00016k2r8nlyj1py`, 2026-08-31 01:20-01:44Z): 4 judgments still `error`/attemptCount 4 (`cmtgib1hu00216k2r4ms5kmg2`, `cmtgib1jf00296k2rb4wvsbd7`, `cmtgib1kq002h6k2r9r4727bj`, `cmtgib1t4003t6k2rm98mg19t`), 1 later COMPLETED (`cmtgib28w00696k2rrh64vmhp`, attemptCount 6 — its 2 envelopes are stale). Run 1's 26 scored judgments executed at `max_tokens` 8192; the judge version's `samplingDefaults` is now 12288, so `--replay` today produces a mixed-config calibration (open #1's hazard), and run 1 is already superseded by run 2 (30/30). The choice is `--replay=all --yes` (accept the mixed config, re-score with `--score-only`) or `--drop-stale --yes` for the 2 stale envelopes plus leaving/replaying the other 8. The plan ships both verbs and the `--list` output that shows the drift; the operator chooses.

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

## Global facts this plan is built on (all verified 2026-09-01; cite, do not re-derive)

- `judge.dlq` is a quorum queue declared with `{ 'x-queue-type': 'quorum' }` only (src/lib/queue/topology.ts:90-99): no DLX, no policy, so RabbitMQ 4.2.4's default `delivery_limit` = 20 applies. Every `basic.get`/management peek that ends in nack-requeue increments `x-delivery-count`; at 20 the broker DROPS the message silently. The 10 live envelopes already carry ONE delivery each (the map's single peek).
- Exactly two DLQ writers, both in `src/worker/judgment-consumer.ts`: `:927` `publishToDlq({ ...msg, result }, 'persist-failed-after-success')` (row left `running`) and `:1262` `publishToDlq({ ...msg, attempt: effectiveAttempt }, providerError.message)` after `markJudgmentError` (row `error`). `publishToDlq` (src/lib/queue/publish.ts:219-227) is the only writer. The envelope is `DlqEnvelope { originalMessage: JudgmentExecuteMsg; reason: string; failedAt: string }` (:83-87, :30-34); `reason` is also on `ModelJudgment.error`, so `--list` needs no envelope.
- `MAX_ATTEMPTS = 3` is module-private at `src/worker/judgment-consumer.ts:199` today (runbook §8.1 cites `:154` — stale). Task 2 moves it to a leaf module so the CLI can read it without importing the consumer.
- The claim path only claims `pending` rows (src/worker/claim.ts:105-109); `error`/`completed` → `already_done` (:124-127). `LEASE_MS` (claim.ts:78) derives from the hard cap. `hardCapAbortKind(attempt)` (src/lib/llm/timeout-policy.ts:349) reads the ROW's attemptCount via the consumer, so a replay MUST reset `attemptCount` to 0 or the first hard-cap abort is `non_retryable`.
- The reaper's lane path is module-private (`lanesByJudgmentId` reaper.ts:134, `reclaimStaleJudgments` :160); its pattern is `resolveEndpointsForPairs` (src/lib/endpoint-resolution.ts:191-213) → `resolveDestinationQueue` (publish.ts:165-179, never throws, degrades to `judgment.execute`) → `publishJudgmentExecute(msg, queue)` (publish.ts:138-144, publisher-confirmed). Null guard for `triggeredById`/`judgeModelVersionId` as reaper.ts:187-191. Only names in `LANE_QUEUES`/`LANE_FALLBACK_QUEUE` are bound (topology.ts:90-99, :133-141).
- `sweepOverdueRuns` (reaper.ts:301-323) force-finalizes a `pending`/`judging` run whose `deadlineAt` is >180 s stale and stamps its pending judgments `error: 'reaper: abandoned'`. The 5 affected runs have `deadlineAt` 2026-08-31 01:36 — the replay MUST extend it in the same transaction.
- THREE sites carry the deadline formula `now + count × resolveTimeoutBudgets().hardCapMs + DEADLINE_SLACK_MS`: src/lib/calibration/launch.ts:298-300, src/lib/run-launch.ts:523-531 (exports `DEADLINE_SLACK_MS` at :125), src/worker/run-create-consumer.ts:248-252 (re-declares `DEADLINE_SLACK_MS` privately at :107). A fourth copy in the CLI is the §5.1 drift shape; Task 1 extracts one helper.
- Coverage denominators: `scripts/admin/**` is outside every coverage include (vitest.config.ts:37). The unit run ALREADY loads src/lib/queue/{connection,lanes,topology,publish}.ts, src/lib/endpoint-resolution.ts, src/worker/claim.ts, src/lib/run-mode.ts, src/lib/tombstones.ts (tests/lib/tombstones.test.ts, queue-lanes.test.ts, timeout-policy.test.ts, judgment-consumer-escalation.test.ts), and `src/lib/run-launch.ts` is coverage-excluded (vitest.config.ts:38-56). So the CLI and its tests add NO file to any glob denominator. The imports that WOULD (never use them from the CLI or its test): `@/lib/run-finalizer` (→ src/lib/realtime/**) and `@/worker/reaper` (→ @/lib/redis + run-finalizer).
- The web pod has the broker env and NetworkPolicy egress to rabbitmq:5672 (charts/judge-arena/templates/deployment.yaml:102, networkpolicy.yaml:145-153), so `kubectl -n tenant-public exec deploy/judge-arena-web -- node /app/admin-dlq.js …` reaches both the DB and the broker once the image carrying the bundle is promoted.
- Broker metrics: default `/metrics` has no `queue` label; `/metrics/detailed?family=queue_coarse_metrics` emits `rabbitmq_detailed_queue_messages_ready{vhost="/",queue="judge.dlq"}` ONLY on the quorum leader (server-1 emitted `10`; server-0 emitted only `rabbitmq_detailed_queue_info{membership="follower"}`). Service `rabbitmq-judge-arena` (label `app.kubernetes.io/name: rabbitmq-judge-arena`) publishes ports `amqp`/`management`/`prometheus`(15692); the headless `rabbitmq-judge-arena-nodes` carries the same label but only `epmd`/`cluster-rpc`, so `port: prometheus` selects exactly one Service. Nothing in homelab-setup scrapes or alerts on the broker (grep over apps/, clusters/, charts/: 0 hits). `cozy-monitoring/vmagent` has `selectAllByDefault: true`; VMRule `authentik-public` in `tenant-public` is the live precedent for a public-tier rule.

---

### Task 1: `batchDeadlineMs` — one deadline formula for the three launch sites

**Files:**
- Modify: `/root/judge-arena/src/lib/run-launch.ts:121-125` (doc + new export after `DEADLINE_SLACK_MS`), `:523-531` (use it)
- Modify: `/root/judge-arena/src/lib/calibration/launch.ts:43-52` (imports), `:298-300` (use it)
- Modify: `/root/judge-arena/src/worker/run-create-consumer.ts:98` (import), `:103-107` (delete the private constant), `:248-253` (use it)
- Create: `/root/judge-arena/tests/lib/run-launch-deadline.test.ts`

**Interfaces:**
- Consumes: `resolveTimeoutBudgets(): { initialBudgetMs: number; hardCapMs: number }` (src/lib/llm/timeout-policy.ts:149); `DEADLINE_SLACK_MS = 60_000` (run-launch.ts:125, unchanged and still exported — tests/db/calibration-link.test.ts:7 imports it).
- Produces: `export function batchDeadlineMs(count: number, nowMs?: number, hardCapMs?: number): number` from `@/lib/run-launch` — epoch milliseconds of `nowMs + count * hardCapMs + DEADLINE_SLACK_MS`, defaults `Date.now()` and `resolveTimeoutBudgets().hardCapMs`. Task 3's CLI calls `new Date(batchDeadlineMs(targets.length, nowMs))`.

- [ ] **Step 1: Write the failing test**

Create `/root/judge-arena/tests/lib/run-launch-deadline.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { batchDeadlineMs, DEADLINE_SLACK_MS } from '@/lib/run-launch';
import { resolveTimeoutBudgets } from '@/lib/llm/timeout-policy';

// The ONE deadline formula. Until this helper existed the same literal lived
// in src/lib/calibration/launch.ts, src/lib/run-launch.ts and
// src/worker/run-create-consumer.ts (which even re-declared the slack
// constant privately). Handoff §5.1's lesson is that a feature spread over N
// sibling sites drifts silently; this pins the arithmetic once so the fourth
// caller (scripts/admin/dlq.ts) cannot disagree with the first three.
//
// DB-free: run-launch.ts is coverage-excluded and everything it imports is
// already loaded by the unit run (tombstones, run-mode, queue/*, claim), so
// this file moves no per-glob denominator.
describe('batchDeadlineMs', () => {
  it('multiplies the HARD CAP by the count and adds the slack exactly once', () => {
    // 3 judgments × 900 s + 60 s slack, from an explicit clock — no env, no Date.now().
    expect(batchDeadlineMs(3, 1_000, 900_000)).toBe(1_000 + 3 * 900_000 + 60_000);
    expect(batchDeadlineMs(1, 0, 900_000)).toBe(960_000);
  });

  it('count 0 is slack only — a batch with nothing queued ahead still gets the DB/publish overhead', () => {
    expect(batchDeadlineMs(0, 5, 900_000)).toBe(5 + DEADLINE_SLACK_MS);
  });

  it('defaults read the wall clock and resolveTimeoutBudgets().hardCapMs, never the initial budget', () => {
    const before = Date.now();
    const value = batchDeadlineMs(2);
    const after = Date.now();
    const cap = resolveTimeoutBudgets().hardCapMs;
    expect(value).toBeGreaterThanOrEqual(before + 2 * cap + DEADLINE_SLACK_MS);
    expect(value).toBeLessThanOrEqual(after + 2 * cap + DEADLINE_SLACK_MS);
    // The initial budget is smaller than the cap by construction
    // (resolveTimeoutBudgets clamps hardCapMs >= initialBudgetMs); a deadline
    // sized on it would let the reaper abandon a call that is still legal.
    expect(value - before).toBeGreaterThanOrEqual(2 * resolveTimeoutBudgets().initialBudgetMs + DEADLINE_SLACK_MS);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /root/judge-arena && npx vitest run tests/lib/run-launch-deadline.test.ts`
Expected: FAIL — `TypeError: batchDeadlineMs is not a function` (3 tests fail; the import resolves because run-launch.ts exists, the export does not).

- [ ] **Step 3: Write minimal implementation — the helper, then the three call sites**

3a. In `/root/judge-arena/src/lib/run-launch.ts`, replace lines 121-125:

```ts
/** Same slack literal as src/worker/run-create-consumer.ts's
 * `DEADLINE_SLACK_MS` — covers DB round trips, queue publish latency, and
 * finalization overhead on top of the per-model provider timeout budget.
 * Exported for the same reason as `EVALUATION_MODEL_TIMEOUT_MS` above. */
export const DEADLINE_SLACK_MS = 60_000;
```

with:

```ts
/** Slack on top of `count × hardCapMs` — covers DB round trips, queue publish
 * latency, and finalization overhead on top of the per-model provider timeout
 * budget. Exported because tests/db/calibration-link.test.ts asserts the
 * batch-aware bound in terms of it; production code should call
 * `batchDeadlineMs` rather than re-assemble the formula. */
export const DEADLINE_SLACK_MS = 60_000;

/**
 * THE deadline formula: `nowMs + count × hardCapMs + DEADLINE_SLACK_MS`.
 *
 * `count` is "work that must drain before this run can finish" — the number
 * of models in a single run, the number of items in a calibration batch, or
 * the number of judgments an admin replay puts back on a lane. `hardCapMs`,
 * not the initial budget: since 414e826 a call may legally run to the hard
 * cap while the initial budget only raises an alert, so a deadline sized on
 * the initial budget lets `src/worker/reaper.ts` force-finalize a run whose
 * judgments are still executing — the failure that silently scored 4 of 30
 * items once already.
 *
 * ONE definition, on purpose. Until 2026-09-01 this literal lived in three
 * sibling sites (calibration/launch.ts, this file, worker/run-create-consumer.ts
 * — the last with its own private copy of the slack constant). Handoff §5.1:
 * a feature spread across N sibling call sites drifts, and the seam count is
 * the thing to check. `nowMs`/`hardCapMs` are parameters so a unit test can
 * pin the arithmetic without touching the clock or the environment.
 */
export function batchDeadlineMs(
  count: number,
  nowMs: number = Date.now(),
  hardCapMs: number = resolveTimeoutBudgets().hardCapMs
): number {
  return nowMs + count * hardCapMs + DEADLINE_SLACK_MS;
}
```

3b. Same file, replace lines 523-531:

```ts
  const deadlineAt =
    params.deadlineAt ??
    // The HARD CAP, not the initial budget. A call may now legally run to the
    // hard cap while the initial budget only triggers an alert, so sizing the
    // deadline on the initial budget would let the reaper force-finalize a run
    // whose judgments are still legitimately executing — the same failure that
    // silently scored 4 of 30 items once already, reintroduced by a timeout
    // change rather than by a concurrency one.
    new Date(Date.now() + selectedVersionIds.length * resolveTimeoutBudgets().hardCapMs + DEADLINE_SLACK_MS);
```

with:

```ts
  const deadlineAt =
    params.deadlineAt ??
    // The HARD CAP, not the initial budget — see `batchDeadlineMs`, the one
    // formula this file, calibration/launch.ts and run-create-consumer.ts share.
    new Date(batchDeadlineMs(selectedVersionIds.length));
```

(`resolveTimeoutBudgets` stays imported at :109 — the helper uses it.)

3c. In `/root/judge-arena/src/lib/calibration/launch.ts`, replace the import lines 43-52:

```ts
import { resolveTimeoutBudgets } from '@/lib/llm/timeout-policy';
import {
  DEADLINE_SLACK_MS,
  launchSingleRun,
  requireOwnedActiveEndpoints,
  resolveCurrentPromptTemplate,
  RunLaunchError,
  type LaunchRunCandidateInput,
  type LaunchSingleRunDeps,
} from '@/lib/run-launch';
```

with:

```ts
import {
  batchDeadlineMs,
  launchSingleRun,
  requireOwnedActiveEndpoints,
  resolveCurrentPromptTemplate,
  RunLaunchError,
  type LaunchRunCandidateInput,
  type LaunchSingleRunDeps,
} from '@/lib/run-launch';
```

(If `calibration-sampling-snapshot` landed first there is an extra `import { effectiveSamplingParams, type SamplingParams } from '@/lib/llm/sampling';` line between them — leave it; anchor the edit on the text above, not on line numbers.)

Same file, replace lines 298-300:

```ts
  const deadlineAt = new Date(
    Date.now() + items.length * resolveTimeoutBudgets().hardCapMs + DEADLINE_SLACK_MS
  );
```

with:

```ts
  // `batchDeadlineMs` — the one formula shared with run-launch.ts and
  // run-create-consumer.ts; `items.length` is the whole batch, per the
  // reasoning above.
  const deadlineAt = new Date(batchDeadlineMs(items.length));
```

3d. In `/root/judge-arena/src/worker/run-create-consumer.ts`, replace line 98:

```ts
import { resolveTimeoutBudgets } from '@/lib/llm/timeout-policy';
```

with:

```ts
import { batchDeadlineMs } from '@/lib/run-launch';
```

Delete lines 103-107 entirely:

```ts
/** Slack added on top of `judgmentCount * EVALUATION_MODEL_TIMEOUT_MS` when
 * computing `EvaluationRun.deadlineAt` — covers DB round trips, queue
 * publish latency, and finalization overhead that isn't part of any single
 * provider call's own timeout budget. */
const DEADLINE_SLACK_MS = 60_000;
```

Replace lines 248-253:

```ts
      const deadlineAt = new Date(
        // Hard cap, mirroring run-launch.ts: a judgment may legally run to the
        // cap, so a deadline sized on the initial budget would let the reaper
        // abandon work that is still executing.
        Date.now() + modelSelections.length * resolveTimeoutBudgets().hardCapMs + DEADLINE_SLACK_MS
      );
```

with:

```ts
      // Hard cap, via the ONE shared formula (run-launch.ts `batchDeadlineMs`):
      // a judgment may legally run to the cap, so a deadline sized on the
      // initial budget would let the reaper abandon work that is still executing.
      const deadlineAt = new Date(batchDeadlineMs(modelSelections.length));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /root/judge-arena && npx vitest run tests/lib/run-launch-deadline.test.ts tests/lib/timeout-policy.test.ts`
Expected: PASS — 3 new tests plus every existing timeout-policy test.

Also confirm the three sites are the only formula copies left:
Run: `grep -rn "hardCapMs + DEADLINE_SLACK_MS\|const DEADLINE_SLACK_MS" /root/judge-arena/src /root/judge-arena/scripts`
Expected: exactly one hit — `src/lib/run-launch.ts` (`export const DEADLINE_SLACK_MS = 60_000;` — the `hardCapMs + DEADLINE_SLACK_MS` text now appears only inside `batchDeadlineMs`'s body; if `grep` shows a second file, a copy survived).

- [ ] **Step 5: Injection**

Break: in `batchDeadlineMs` change `return nowMs + count * hardCapMs + DEADLINE_SLACK_MS;` to `return nowMs + (count + 1) * hardCapMs + DEADLINE_SLACK_MS;`.
Run: `cd /root/judge-arena && npx vitest run tests/lib/run-launch-deadline.test.ts`
Expected: FAIL — `multiplies the HARD CAP by the count…`: `expected 3661000 to be 2761000`, and `count 0 is slack only`: `expected 960005 to be 60005`. Restore.

Second injection (the call sites, not just the helper): in `src/lib/calibration/launch.ts` change `batchDeadlineMs(items.length)` to `batchDeadlineMs(1)`.
Run: `cd /root/judge-arena && sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.db.config.ts tests/db/calibration-link.test.ts'`
Expected: FAIL — the batch-aware deadline test (`expect(run.deadlineAt!.getTime()).toBeGreaterThanOrEqual(batchAwareDeadline)`, calibration-link.test.ts:339). Restore.

- [ ] **Step 6: Gates**

```bash
cd /root/judge-arena && npm run lint && npx tsc --noEmit && npm run test:coverage
grep DATABASE_URL /root/judge-arena/.env.test   # must be localhost:5432 (podman judge-arena-pg)
npm run test:db:coverage && npm run test:integration && npm run build
```
Expected: lint 0 warnings (the removed `resolveTimeoutBudgets` import in calibration/launch.ts and the removed private constant in run-create-consumer.ts are what would otherwise trip `no-unused-vars`); tsc 0; unit = baseline + 3; db and integration counts unchanged; every coverage floor passes.

- [ ] **Step 7: Commit**

```bash
git -C /root/judge-arena add src/lib/run-launch.ts src/lib/calibration/launch.ts src/worker/run-create-consumer.ts tests/lib/run-launch-deadline.test.ts
git -C /root/judge-arena commit -F - <<'EOF'
refactor(worker): one batch-deadline formula for the three launch sites

`now + count × resolveTimeoutBudgets().hardCapMs + DEADLINE_SLACK_MS` lived
in THREE sibling files — src/lib/calibration/launch.ts, src/lib/run-launch.ts
and src/worker/run-create-consumer.ts, the last with its own private copy of
the slack constant. That is the §5.1 shape: a rule spread over N call sites,
each of which half-works alone, so a change to one never announces that the
other two are now wrong. The escalating timeout already had to be re-applied
to every copy once (the hard cap replacing the initial budget).

`batchDeadlineMs(count, nowMs?, hardCapMs?)` on run-launch.ts is now the
only definition; the three sites call it, and the admin DLQ replay verb that
follows will be the fourth caller instead of the fourth copy. `nowMs` and
`hardCapMs` are parameters so tests/lib/run-launch-deadline.test.ts pins the
arithmetic without the clock or the environment. DEADLINE_SLACK_MS stays
exported for tests/db/calibration-link.test.ts, which asserts the batch-aware
bound in terms of it and stays green unchanged.

Injected: (count + 1) in the helper -> unit red; batchDeadlineMs(1) at the
calibration site -> the db batch-aware bound red.

Gates: lint 0, tsc 0, <n> unit / <n> db / <n> integration, coverage 0.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_018ACKb44as67Hz9R3sxexc7
EOF
```
(Replace each `<n>` with the number the gate run printed.)

---

### Task 2: `admin-dlq --list` — DB-side classification, depth via `checkQueue`, sampling drift, shipped in the image

**Files:**
- Create: `/root/judge-arena/src/lib/queue/attempts.ts`
- Modify: `/root/judge-arena/src/worker/judgment-consumer.ts:165` (add import after it), `:196-199` (delete the private constant)
- Create: `/root/judge-arena/scripts/admin/dlq.ts`
- Create: `/root/judge-arena/scripts/admin/dlq-entry.ts`
- Modify: `/root/judge-arena/Dockerfile:157` (insert the sixth esbuild block after the calibration-run block, before `# ─── Stage 2b`)
- Create: `/root/judge-arena/tests/admin/dlq.test.ts`

**Interfaces:**
- Consumes: `batchDeadlineMs` (Task 1 — imported now, used by Task 3); `MAX_ATTEMPTS` (moved here); `LEASE_MS` (src/worker/claim.ts:78); `QUEUE_DLQ` (topology.ts:42); `LANE_FALLBACK_QUEUE` (lanes.ts:75); `resolveEndpointsForPairs` (endpoint-resolution.ts:191); `resolveDestinationQueue`, types `DlqEnvelope`, `JudgmentExecuteMsg` (publish.ts:165, :83, :30); from the sampling-snapshot plan: `effectiveSamplingParams(versionDefaults: unknown, overrides?, registryDefault?): SamplingParams` (`@/lib/llm/sampling`) and `canonicalJson(value: unknown): string`, `detectSamplingDrift(header: unknown, judgments: ReadonlyArray<{ status: string; samplingParams: unknown }>): SamplingDrift` (`@/lib/calibration/sampling-drift`).
- Produces (from `scripts/admin/dlq.ts`, all `export`ed; Task 3 adds bodies for the two mutating verbs without changing any signature):
  - `MAX_ATTEMPTS = 3` from `@/lib/queue/attempts`
  - `interface DlqArgs { verb: 'list' | 'replay' | 'drop-stale'; replay: 'all' | string[]; yes: boolean }`; `parseDlqArgs(argv: string[]): DlqArgs`
  - `JUDGMENT_SELECT`, `type DlqJudgmentRow`, `CALIBRATION_SELECT`, `type DlqCalibrationRow`, `type DlqClient = Pick<PrismaClient, 'modelJudgment' | 'calibrationRun' | '$transaction'>`
  - `interface DlqChannel { checkQueue; get; ack; nack }` (exact shape in the code)
  - `interface DlqDeps { client: DlqClient; channel: DlqChannel; publish: (msg: JudgmentExecuteMsg, destinationQueue: string) => Promise<void>; resolveLane: (triggeredById: string | null, judgeModelVersionId: string | null) => Promise<string>; now?: () => Date; out?: (line: string) => void }`
  - `type DlqClass = 'max_attempts' | 'persist_failed_candidate' | 'stale'`; `classifyJudgment(row, nowMs): DlqClass | null`; `candidateWhere(nowMs): Prisma.ModelJudgmentWhereInput`; `describeSamplingDrift(cal: DlqCalibrationRow): string`; `resolveReplayLane(triggeredById, judgeModelVersionId): Promise<string>`
  - `runDlq(args: DlqArgs, deps: DlqDeps): Promise<{ exitCode: number }>`

- [ ] **Step 1: Write the failing test**

Create `/root/judge-arena/tests/admin/dlq.test.ts` (Task 3 appends its `describe` blocks to this same file — the fixtures below are shared):

```ts
import { describe, expect, it } from 'vitest';
import type { GetMessage } from 'amqplib';
import type { DlqEnvelope, JudgmentExecuteMsg } from '@/lib/queue/publish';
import { LANE_FALLBACK_QUEUE } from '@/lib/queue/lanes';
import { QUEUE_DLQ } from '@/lib/queue/topology';
import { MAX_ATTEMPTS } from '@/lib/queue/attempts';
import { LEASE_MS } from '@/worker/claim';
import {
  classifyJudgment,
  describeSamplingDrift,
  parseDlqArgs,
  resolveReplayLane,
  runDlq,
  type DlqCalibrationRow,
  type DlqChannel,
  type DlqClient,
  type DlqDeps,
  type DlqJudgmentRow,
} from '@/../scripts/admin/dlq';

// DB-free, broker-free. Every side effect of scripts/admin/dlq.ts is behind
// DlqDeps (the DispatchFailureDeps pattern, src/worker/dispatch-failure.ts:69):
// a structural Prisma subset, a four-method channel, a recording publisher and
// a fixed lane. scripts/admin/** sits outside every coverage include
// (vitest.config.ts:37) and every src module this pulls in is already loaded
// by the unit run, so this file moves no per-glob denominator.

const NOW = new Date('2026-09-01T12:00:00.000Z');
const OLD = new Date(NOW.getTime() - LEASE_MS - 60_000);
const CAL = 'cmtgib0xr00016k2r8nlyj1py';
const LANE = 'judgment.execute.lane.1';

function row(over: Partial<DlqJudgmentRow> & { id: string }): DlqJudgmentRow {
  return {
    status: 'error',
    error: 'Provider call to "llamacpp" (Qwen3.6-35B-A3B-UD-Q3_K_XL.gguf) timed out after 300000ms',
    attemptCount: 4,
    updatedAt: OLD,
    runId: `run-${over.id}`,
    judgeModelVersionId: 'v-1',
    run: { status: 'error', triggeredById: 'user-1', deadlineAt: OLD, finalizedAt: OLD, calibrationRunId: CAL },
    ...over,
  };
}

const calibration: DlqCalibrationRow = {
  id: CAL,
  samplingParams: { max_tokens: 8192, temperature: 0.3 },
  judgeModelVersion: { samplingDefaults: { max_tokens: 12288, temperature: 0.3 } },
  evaluationRuns: [
    { modelJudgments: [{ status: 'completed', samplingParams: { max_tokens: 8192, temperature: 0.3 } }] },
    { modelJudgments: [{ status: 'error', samplingParams: null }] },
  ],
};

function envelope(judgmentId: string, attempt: number): DlqEnvelope {
  return {
    originalMessage: { judgmentId, runId: `run-${judgmentId}`, attempt },
    reason: 'Provider call to "llamacpp" timed out after 300000ms',
    failedAt: '2026-08-31T01:20:35.000Z',
  };
}

function fakeClient(rows: DlqJudgmentRow[], calibrations: DlqCalibrationRow[] = []) {
  const wheres: unknown[] = [];
  const events: string[] = [];
  const judgmentUpdates: Array<{ id: string; data: Record<string, unknown> }> = [];
  const runUpdates: Array<{ id: string; data: Record<string, unknown> }> = [];
  const tx = {
    modelJudgment: {
      update: async (args: any) => {
        judgmentUpdates.push({ id: args.where.id, data: args.data });
        events.push(`tx:judgment:${args.where.id}`);
        return {};
      },
    },
    evaluationRun: {
      update: async (args: any) => {
        runUpdates.push({ id: args.where.id, data: args.data });
        events.push(`tx:run:${args.where.id}`);
        return {};
      },
    },
  };
  const client = {
    modelJudgment: {
      findMany: async (args: any) => {
        wheres.push(args.where);
        const ids: string[] | undefined = args.where?.id?.in;
        return ids ? rows.filter((r) => ids.includes(r.id)) : rows;
      },
    },
    calibrationRun: {
      findUnique: async (args: any) => calibrations.find((c) => c.id === args.where.id) ?? null,
    },
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  } as unknown as DlqClient;
  return { client, wheres, events, judgmentUpdates, runUpdates };
}

function fakeChannel(envelopes: DlqEnvelope[], events: string[]) {
  const pending: GetMessage[] = envelopes.map((e, i) => ({
    content: Buffer.from(JSON.stringify(e)),
    fields: {
      deliveryTag: i + 1,
      redelivered: false,
      exchange: 'judge.direct',
      routingKey: QUEUE_DLQ,
      messageCount: envelopes.length - i - 1,
    },
    properties: {} as GetMessage['properties'],
  }));
  const acked: number[] = [];
  const nacked: Array<{ tag: number; requeue: boolean }> = [];
  let gets = 0;
  const channel: DlqChannel = {
    checkQueue: async () => ({ messageCount: envelopes.length, consumerCount: 0 }),
    get: async () => {
      gets += 1;
      return pending.shift() ?? false;
    },
    ack: (m) => {
      acked.push(m.fields.deliveryTag);
      events.push(`ack:${m.fields.deliveryTag}`);
    },
    nack: (m, _allUpTo, requeue) => {
      nacked.push({ tag: m.fields.deliveryTag, requeue });
    },
  };
  return { channel, acked, nacked, gets: () => gets };
}

function makeDeps(opts: {
  rows: DlqJudgmentRow[];
  envelopes?: DlqEnvelope[];
  calibrations?: DlqCalibrationRow[];
  publish?: DlqDeps['publish'];
}) {
  const db = fakeClient(opts.rows, opts.calibrations ?? []);
  const ch = fakeChannel(opts.envelopes ?? [], db.events);
  const lines: string[] = [];
  const published: Array<{ msg: JudgmentExecuteMsg; queue: string }> = [];
  const publish: DlqDeps['publish'] =
    opts.publish ??
    (async (msg, queue) => {
      published.push({ msg, queue });
      db.events.push(`publish:${msg.judgmentId}:${queue}`);
    });
  const deps: DlqDeps = {
    client: db.client,
    channel: ch.channel,
    publish,
    resolveLane: async () => LANE,
    now: () => NOW,
    out: (line) => lines.push(line),
  };
  return { deps, db, ch, lines, published, text: () => lines.join('\n') };
}

describe('parseDlqArgs', () => {
  it('parses each verb, --replay ids and all, and --yes as a bare flag', () => {
    expect(parseDlqArgs(['--list'])).toEqual({ verb: 'list', replay: [], yes: false });
    expect(parseDlqArgs(['--replay=a,b', '--yes'])).toEqual({ verb: 'replay', replay: ['a', 'b'], yes: true });
    expect(parseDlqArgs(['--replay=all'])).toEqual({ verb: 'replay', replay: 'all', yes: false });
    expect(parseDlqArgs(['--drop-stale', '--yes'])).toEqual({ verb: 'drop-stale', replay: [], yes: true });
  });

  it('rejects an unknown flag, two verbs, no verb, and an empty --replay=', () => {
    expect(() => parseDlqArgs(['--list', '--wat'])).toThrow(/Unrecognized argument "--wat"/);
    expect(() => parseDlqArgs(['--list', '--drop-stale'])).toThrow(/Exactly one verb/);
    expect(() => parseDlqArgs(['--yes'])).toThrow(/Exactly one verb/);
    expect(() => parseDlqArgs(['--replay='])).toThrow(/--replay needs/);
  });
});

describe('classifyJudgment — the three shapes the two DLQ writers leave behind', () => {
  const nowMs = NOW.getTime();

  it('an error row at attemptCount >= MAX_ATTEMPTS is max_attempts (the judgment-consumer.ts:1258 branch)', () => {
    expect(classifyJudgment(row({ id: 'j', attemptCount: MAX_ATTEMPTS }), nowMs)).toBe('max_attempts');
    expect(classifyJudgment(row({ id: 'j', attemptCount: MAX_ATTEMPTS + 1 }), nowMs)).toBe('max_attempts');
  });

  it('an error row BELOW the budget is not dead-lettered (non_retryable: truncation, 4xx) — null', () => {
    expect(classifyJudgment(row({ id: 'j', attemptCount: MAX_ATTEMPTS - 1, error: 'CUT OFF' }), nowMs)).toBeNull();
  });

  it('a running row with no error and an expired lease is a persist-failed candidate (the :927 branch leaves it running)', () => {
    expect(classifyJudgment(row({ id: 'j', status: 'running', error: null, updatedAt: OLD }), nowMs)).toBe('persist_failed_candidate');
    // Inside the lease it is simply in flight.
    expect(classifyJudgment(row({ id: 'j', status: 'running', error: null, updatedAt: NOW }), nowMs)).toBeNull();
  });

  it('a completed row is stale — any envelope still parked for it must not be replayed', () => {
    expect(classifyJudgment(row({ id: 'j', status: 'completed', attemptCount: 6 }), nowMs)).toBe('stale');
  });
});

describe('describeSamplingDrift', () => {
  it('names the drift between what the run executed under and what a replay would run under today', () => {
    const line = describeSamplingDrift(calibration);
    expect(line).toContain('SAMPLING DRIFT');
    expect(line).toContain('{"max_tokens":8192,"temperature":0.3}');
    expect(line).toContain('{"max_tokens":12288,"temperature":0.3}');
  });

  it('says so when the run and a replay agree', () => {
    const same: DlqCalibrationRow = {
      ...calibration,
      judgeModelVersion: { samplingDefaults: { max_tokens: 8192, temperature: 0.3 } },
    };
    expect(describeSamplingDrift(same)).toContain('sampling consistent');
  });
});

describe('resolveReplayLane', () => {
  it('a run with no owner or a judgment with no version has no lane and takes the fallback WITHOUT touching the database', async () => {
    await expect(resolveReplayLane(null, 'v-1')).resolves.toBe(LANE_FALLBACK_QUEUE);
    await expect(resolveReplayLane('user-1', null)).resolves.toBe(LANE_FALLBACK_QUEUE);
  });
});

describe('runDlq --list', () => {
  it('touches NO message: depth via checkQueue, classification from the database, exit 0', async () => {
    const t = makeDeps({
      rows: [
        row({ id: 'j-err' }),
        row({ id: 'j-done', status: 'completed', attemptCount: 6 }),
        row({ id: 'j-run', status: 'running', error: null }),
        row({ id: 'j-trunc', attemptCount: 1, error: 'CUT OFF' }),
      ],
      envelopes: [envelope('j-err', 3), envelope('j-err', 4)],
      calibrations: [calibration],
    });
    const result = await runDlq(parseDlqArgs(['--list']), t.deps);
    expect(result).toEqual({ exitCode: 0 });
    expect(t.ch.gets()).toBe(0);
    expect(t.ch.acked).toEqual([]);
    expect(t.ch.nacked).toEqual([]);
    expect(t.db.judgmentUpdates).toEqual([]);
    expect(t.published).toEqual([]);
    const text = t.text();
    expect(text).toContain(`${QUEUE_DLQ}: 2 message(s), 0 consumer(s)`);
    expect(text).toMatch(/j-err\s+max_attempts/);
    expect(text).toMatch(/j-done\s+stale/);
    expect(text).toMatch(/j-run\s+persist_failed_candidate/);
    expect(text).not.toContain('j-trunc');
    expect(text).toContain('SAMPLING DRIFT');
    expect(text).toContain('delivery');
  });

  it('asks the database for attemptCount >= MAX_ATTEMPTS OR a lease-stale running row with no error', async () => {
    const t = makeDeps({ rows: [] });
    await runDlq(parseDlqArgs(['--list']), t.deps);
    expect(t.db.wheres[0]).toEqual({
      OR: [
        { attemptCount: { gte: MAX_ATTEMPTS } },
        { status: 'running', error: null, updatedAt: { lt: new Date(NOW.getTime() - LEASE_MS) } },
      ],
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /root/judge-arena && npx vitest run tests/admin/dlq.test.ts`
Expected: FAIL — `Error: Failed to resolve import "@/lib/queue/attempts"` (the first missing module; the file does not run past its imports).

- [ ] **Step 3: Write minimal implementation**

3a. Create `/root/judge-arena/src/lib/queue/attempts.ts`:

```ts
/**
 * Attempt budget for one judgment: 1st delivery (attempt=1) plus up to 2
 * retries. On the 3rd failed attempt the judgment goes to `judge.dlq` instead
 * of a further retry queue (src/worker/judgment-consumer.ts, the
 * `effectiveAttempt >= MAX_ATTEMPTS` branch).
 *
 * A leaf module, not a consumer-private constant, so scripts/admin/dlq.ts can
 * classify `error` rows by the SAME number the consumer dead-letters on
 * without importing the consumer — whose closure is the provider SDKs, the
 * realtime bus and the run finalizer, none of which an admin CLI should carry
 * and all of which would land in a unit-coverage denominator.
 */
export const MAX_ATTEMPTS = 3;
```

3b. In `/root/judge-arena/src/worker/judgment-consumer.ts`, after line 165

```ts
import { EXCHANGE_DELAY_30S, EXCHANGE_DELAY_5M } from '@/lib/queue/topology';
```

insert:

```ts
import { MAX_ATTEMPTS } from '@/lib/queue/attempts';
```

and delete lines 196-199 (now shifted by one):

```ts
/** Attempt budget: 1st delivery (attempt=1) plus up to 2 retries. On the
 * 3rd failed attempt the judgment goes to the DLQ instead of a further
 * retry queue. */
const MAX_ATTEMPTS = 3;
```

(The single use at `if (effectiveAttempt >= MAX_ATTEMPTS) {` is unchanged.)

3c. Create `/root/judge-arena/scripts/admin/dlq.ts`. Task 3 fills the two `TODO`-free stubs marked `// Task 3` with their bodies; in this task they return the dry-run listing so the file compiles and `--list` is complete:

```ts
/**
 * ─── judge.dlq admin verbs: --list, --replay, --drop-stale ──────────────────
 *
 * `judge.dlq` is a parked store, not a retry loop: nothing consumes it
 * (`WORKER_CONSUMER_QUEUES`, src/worker/health.ts, pins that by test) and
 * until this script existed nothing could drain it either. Exactly two writers
 * put an envelope there, both in src/worker/judgment-consumer.ts: attempt
 * exhaustion (`effectiveAttempt >= MAX_ATTEMPTS`, after `markJudgmentError`,
 * row `error`) and persist-failed-after-success (the provider answered, three
 * local persist attempts failed, the row is left `running` for the reaper).
 *
 * THE TRAP THIS SCRIPT IS SHAPED AROUND: judge.dlq is a quorum queue with the
 * RabbitMQ 4.x default `delivery_limit` of 20 and no dead-letter exchange of
 * its own (topology.ts:90-99). Every delivery that is not acked — a
 * management-UI peek, a `rabbitmqadmin get`, a `basic.get` followed by
 * nack-requeue — increments the message's delivery count, and at 20 the broker
 * DROPS it silently. Ten "harmless" dry-runs would erase the queue. So:
 *
 *   --list           is DB-SIDE. It classifies ModelJudgment rows (the
 *                    reason is on `ModelJudgment.error`, written by
 *                    markJudgmentError before publishToDlq) and reads the depth
 *                    with `checkQueue`. It never fetches a message.
 *   --replay / --drop-stale
 *                    consume (`basic.get`, noAck:false) ONLY under --yes, and
 *                    ack an envelope only after the committed transaction and
 *                    the confirmed publish that replace it. Every envelope a
 *                    pass leaves behind is nack-requeued, which costs it one
 *                    delivery — the tool prints that count on every pass.
 *
 * REPLAY IS THREE STATE RESETS, NOT A REPUBLISH. claim.ts only claims
 * `pending` rows; `hardCapAbortKind` reads the row's attemptCount, so
 * attemptCount 4 makes the first hard-cap abort non_retryable; the reaper
 * force-finalizes any run whose deadlineAt is >180 s stale and stamps its
 * pending judgments `reaper: abandoned`; and run-finalizer only transitions
 * an ACTIVE run. Hence, in one transaction: judgment -> pending / error null /
 * attemptCount 0, run -> judging / finalizedAt null / deadlineAt extended via
 * the ONE shared formula (`batchDeadlineMs`), then publish attempt 1 to the
 * lane the reaper would choose, then ack.
 *
 * Usage (inside the cluster, where the database and the broker are reachable):
 *   kubectl -n tenant-public exec deploy/judge-arena-web -- node /app/admin-dlq.js --list
 *   kubectl -n tenant-public exec deploy/judge-arena-web -- node /app/admin-dlq.js --replay=<judgmentId,...>|all [--yes]
 *   kubectl -n tenant-public exec deploy/judge-arena-web -- node /app/admin-dlq.js --drop-stale [--yes]
 */
import type { GetMessage } from 'amqplib';
import type { Prisma, PrismaClient } from '@prisma/client';
import { resolveDestinationQueue, type DlqEnvelope, type JudgmentExecuteMsg } from '@/lib/queue/publish';
import { QUEUE_DLQ } from '@/lib/queue/topology';
import { MAX_ATTEMPTS } from '@/lib/queue/attempts';
import { LANE_FALLBACK_QUEUE } from '@/lib/queue/lanes';
import { LEASE_MS } from '@/worker/claim';
import { batchDeadlineMs } from '@/lib/run-launch';
import { effectiveSamplingParams } from '@/lib/llm/sampling';
import { canonicalJson, detectSamplingDrift } from '@/lib/calibration/sampling-drift';
import { resolveEndpointsForPairs } from '@/lib/endpoint-resolution';

// ─── Arguments ───────────────────────────────────────────────────────────────

export interface DlqArgs {
  verb: 'list' | 'replay' | 'drop-stale';
  /** Only meaningful when `verb === 'replay'`; `[]` otherwise. */
  replay: 'all' | string[];
  yes: boolean;
}

const USAGE = 'usage: --list | --replay=<judgmentId,...>|all [--yes] | --drop-stale [--yes]';

export function parseDlqArgs(argv: string[]): DlqArgs {
  const verbs: DlqArgs['verb'][] = [];
  let replay: DlqArgs['replay'] = [];
  for (const arg of argv) {
    if (arg === '--list') {
      verbs.push('list');
    } else if (arg === '--drop-stale') {
      verbs.push('drop-stale');
    } else if (arg.startsWith('--replay=')) {
      verbs.push('replay');
      const value = arg.slice('--replay='.length);
      replay =
        value === 'all'
          ? 'all'
          : value
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean);
      if (replay !== 'all' && replay.length === 0) {
        throw new Error(`--replay needs <judgmentId,...> or all. ${USAGE}`);
      }
    } else if (arg !== '--yes') {
      throw new Error(`Unrecognized argument "${arg}". ${USAGE}`);
    }
  }
  if (verbs.length !== 1) throw new Error(`Exactly one verb is required. ${USAGE}`);
  return { verb: verbs[0], replay, yes: argv.includes('--yes') };
}

// ─── Database shapes ─────────────────────────────────────────────────────────

export const JUDGMENT_SELECT = {
  id: true,
  status: true,
  error: true,
  attemptCount: true,
  updatedAt: true,
  runId: true,
  judgeModelVersionId: true,
  run: {
    select: {
      status: true,
      triggeredById: true,
      deadlineAt: true,
      finalizedAt: true,
      calibrationRunId: true,
    },
  },
} satisfies Prisma.ModelJudgmentSelect;

export type DlqJudgmentRow = Prisma.ModelJudgmentGetPayload<{ select: typeof JUDGMENT_SELECT }>;

/** What a calibration ran under vs what a replay would run under today. */
export const CALIBRATION_SELECT = {
  id: true,
  samplingParams: true,
  judgeModelVersion: { select: { samplingDefaults: true } },
  evaluationRuns: { select: { modelJudgments: { select: { status: true, samplingParams: true } } } },
} satisfies Prisma.CalibrationRunSelect;

export type DlqCalibrationRow = Prisma.CalibrationRunGetPayload<{ select: typeof CALIBRATION_SELECT }>;

/** The subset of `PrismaClient` this CLI needs — the global `prisma` singleton
 *  in production, a structural fake in tests/admin/dlq.test.ts (same shape as
 *  `CalibrationScoreClient`, src/lib/calibration/score.ts). */
export type DlqClient = Pick<PrismaClient, 'modelJudgment' | 'calibrationRun' | '$transaction'>;

/** The four channel methods the verbs use — satisfied structurally by
 *  amqplib's `ConfirmChannel` (`getRabbit().confirmChannel`). */
export interface DlqChannel {
  checkQueue(queue: string): Promise<{ messageCount: number; consumerCount: number }>;
  get(queue: string, options: { noAck: boolean }): Promise<GetMessage | false>;
  ack(message: GetMessage): void;
  nack(message: GetMessage, allUpTo: boolean, requeue: boolean): void;
}

/** Constructor-injected seams, the `DispatchFailureDeps` pattern
 *  (src/worker/dispatch-failure.ts:69-71): the unit suite never opens amqplib
 *  or Prisma. `dlq-entry.ts` wires the real ones. */
export interface DlqDeps {
  client: DlqClient;
  channel: DlqChannel;
  /** `publishJudgmentExecute` in production — publisher-confirmed. */
  publish: (msg: JudgmentExecuteMsg, destinationQueue: string) => Promise<void>;
  /** `resolveReplayLane` in production. */
  resolveLane: (triggeredById: string | null, judgeModelVersionId: string | null) => Promise<string>;
  now?: () => Date;
  out?: (line: string) => void;
}

// ─── Classification (DB-side, never touches a message) ───────────────────────

export type DlqClass = 'max_attempts' | 'persist_failed_candidate' | 'stale';

/**
 * Which DLQ writer could have produced an envelope for this row.
 *  - `max_attempts`: `error` at or past the budget — judgment-consumer.ts's
 *    `effectiveAttempt >= MAX_ATTEMPTS` branch. REPLAYABLE.
 *  - `persist_failed_candidate`: `running`, no error, lease expired — the
 *    persist-failed-after-success branch leaves the row exactly so. The
 *    provider already answered and the result is IN THE ENVELOPE; never
 *    replay it through the provider. The reaper normally reclaims these
 *    within a sweep, so this class is empty in a healthy system.
 *  - `stale`: `completed` — a later attempt succeeded; any envelope still
 *    parked for it must be dropped, not replayed (`--drop-stale`).
 *  - `null`: not dead-lettered. An `error` row below the budget is a
 *    non_retryable failure (truncation, 4xx, hard-cap abort on attempt >= 2),
 *    which the consumer acks WITHOUT an envelope.
 */
export function classifyJudgment(
  row: Pick<DlqJudgmentRow, 'status' | 'attemptCount' | 'error' | 'updatedAt'>,
  nowMs: number
): DlqClass | null {
  if (row.status === 'completed') return 'stale';
  if (row.status === 'error' && row.attemptCount >= MAX_ATTEMPTS) return 'max_attempts';
  if (row.status === 'running' && row.error === null && row.updatedAt.getTime() < nowMs - LEASE_MS) {
    return 'persist_failed_candidate';
  }
  return null;
}

/** The candidate set: every row a DLQ writer could have left behind. A
 *  `completed` row appears only when it crossed the budget on the way
 *  (attemptCount >= MAX_ATTEMPTS) — the shape of run 1's `cmtgib28w…`. */
export function candidateWhere(nowMs: number): Prisma.ModelJudgmentWhereInput {
  return {
    OR: [
      { attemptCount: { gte: MAX_ATTEMPTS } },
      { status: 'running', error: null, updatedAt: { lt: new Date(nowMs - LEASE_MS) } },
    ],
  };
}

/** Open #1's hazard made visible: a replay today runs under the version's
 *  CURRENT `samplingDefaults`, which may not be what the rest of the
 *  calibration executed under. Header (v2k snapshot) and completed judgments
 *  come from `detectSamplingDrift`; "would run under" from the same resolver
 *  the worker uses. */
export function describeSamplingDrift(cal: DlqCalibrationRow): string {
  const wouldRun = canonicalJson(effectiveSamplingParams(cal.judgeModelVersion.samplingDefaults));
  const drift = detectSamplingDrift(
    cal.samplingParams,
    cal.evaluationRuns.flatMap((run) => run.modelJudgments)
  );
  if (drift.kind === 'moved_mid_run') {
    return `calibration ${cal.id}: MOVED MID-RUN (${drift.executedUnder.join(' | ')}); a replay today would run under ${wouldRun}`;
  }
  const ran = drift.executedUnder;
  if (ran === null) return `calibration ${cal.id}: no completed judgment yet — a replay would run under ${wouldRun}`;
  return ran === wouldRun
    ? `calibration ${cal.id}: sampling consistent — a replay would run under ${wouldRun}, same as the run`
    : `calibration ${cal.id}: SAMPLING DRIFT — the run executed under ${ran}; a replay today would run under ${wouldRun} (open #1: a mixed-config calibration is not comparable)`;
}

// ─── Lane resolution (the reaper's pattern, re-implemented) ──────────────────

/** reaper.ts keeps `lanesByJudgmentId`/`reclaimStaleJudgments` module-private,
 *  and importing the reaper would drag @/lib/redis and @/lib/run-finalizer into
 *  this bundle. Same three calls, same null guard as reaper.ts:187-191: a run
 *  with no owner or a judgment with no version has no lane of its own and goes
 *  to the fallback queue, which is consumed forever. `resolveDestinationQueue`
 *  never throws (publish.ts:165-179). */
export async function resolveReplayLane(
  triggeredById: string | null,
  judgeModelVersionId: string | null
): Promise<string> {
  if (!triggeredById || !judgeModelVersionId) return LANE_FALLBACK_QUEUE;
  const lookup = await resolveEndpointsForPairs([{ userId: triggeredById, judgeModelVersionId }]);
  return resolveDestinationQueue(lookup(triggeredById, judgeModelVersionId)?.endpoint ?? null, judgeModelVersionId);
}

// ─── Shared plumbing ─────────────────────────────────────────────────────────

interface Classified {
  row: DlqJudgmentRow;
  klass: DlqClass;
}

interface Context {
  deps: DlqDeps;
  nowMs: number;
  out: (line: string) => void;
}

const DELIVERY_NOTE =
  `Envelope-level truth is known only to --replay/--drop-stale, which consume under --yes. ` +
  `Each such pass costs ONE delivery (quorum delivery_limit 20, then the broker DROPS the message) on every envelope it leaves in ${QUEUE_DLQ}.`;

async function loadCandidates(ctx: Context): Promise<Classified[]> {
  const rows = await ctx.deps.client.modelJudgment.findMany({
    where: candidateWhere(ctx.nowMs),
    select: JUDGMENT_SELECT,
    orderBy: { updatedAt: 'asc' },
  });
  return rows.flatMap((row) => {
    const klass = classifyJudgment(row, ctx.nowMs);
    return klass === null ? [] : [{ row, klass }];
  });
}

function printTable(entries: Classified[], out: Context['out']): void {
  out(`DB-side candidates (ModelJudgment): ${entries.length}`);
  out(
    `  ${'judgmentId'.padEnd(26)} ${'class'.padEnd(25)} ${'attempts'.padEnd(8)} ${'status'.padEnd(10)} ${'run'.padEnd(37)} ${'calibrationRunId'.padEnd(26)} reason`
  );
  for (const { row, klass } of entries) {
    out(
      `  ${row.id.padEnd(26)} ${klass.padEnd(25)} ${String(row.attemptCount).padEnd(8)} ${row.status.padEnd(10)} ${row.runId.padEnd(37)} ${(row.run.calibrationRunId ?? '-').padEnd(26)} ${row.error ?? '-'}`
    );
  }
}

async function printDrift(entries: Classified[], ctx: Context): Promise<void> {
  const calibrationIds = [...new Set(entries.map((e) => e.row.run.calibrationRunId).filter((id): id is string => id !== null))];
  for (const id of calibrationIds) {
    // eslint-disable-next-line no-await-in-loop -- a handful of calibrations, printed in order
    const cal = await ctx.deps.client.calibrationRun.findUnique({ where: { id }, select: CALIBRATION_SELECT });
    ctx.out(cal ? describeSamplingDrift(cal) : `calibration ${id}: row not found`);
  }
}

// ─── Verbs ───────────────────────────────────────────────────────────────────

async function list(ctx: Context): Promise<{ exitCode: number }> {
  const entries = await loadCandidates(ctx);
  printTable(entries, ctx.out);
  await printDrift(entries, ctx);
  ctx.out(DELIVERY_NOTE);
  return { exitCode: 0 };
}

// Task 3
async function replay(args: DlqArgs, ctx: Context): Promise<{ exitCode: number }> {
  const entries = await loadCandidates(ctx);
  printTable(entries, ctx.out);
  ctx.out(`--replay is not implemented yet (${args.replay === 'all' ? 'all' : args.replay.join(',')})`);
  return { exitCode: 1 };
}

// Task 3
async function dropStale(ctx: Context): Promise<{ exitCode: number }> {
  const entries = await loadCandidates(ctx);
  printTable(entries, ctx.out);
  ctx.out('--drop-stale is not implemented yet');
  return { exitCode: 1 };
}

export async function runDlq(args: DlqArgs, deps: DlqDeps): Promise<{ exitCode: number }> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const ctx: Context = { deps, nowMs: (deps.now ?? (() => new Date()))().getTime(), out };

  const depth = await deps.channel.checkQueue(QUEUE_DLQ);
  out(`${QUEUE_DLQ}: ${depth.messageCount} message(s), ${depth.consumerCount} consumer(s) — read with checkQueue; no message was consumed`);

  if (args.verb === 'list') return list(ctx);
  if (args.verb === 'replay') return replay(args, ctx);
  return dropStale(ctx);
}
```

(The two `// Task 3` stubs are deliberately honest: they list and exit 1 with "not implemented yet". They contain no placeholder text the plan forbids — Task 3 replaces both bodies. `batchDeadlineMs` is imported now and used in Task 3; ESLint's `no-unused-vars` does flag unused imports, so until Task 3 lands keep the import OUT — add it in Task 3 Step 3. Same for nothing else: every other import above is used in this task.)

Remove the line `import { batchDeadlineMs } from '@/lib/run-launch';` from the file for THIS task (Task 3 re-adds it).

3d. Create `/root/judge-arena/scripts/admin/dlq-entry.ts`:

```ts
/** Bundle entry for dlq.ts. Separate for the same reason add-judge-entry.ts
 *  is: an `import.meta.url` direct-run guard cannot work under the CJS output
 *  esbuild produces for the runner image. Closes the broker connection as well
 *  as Prisma in `finally`, or the process never exits (connection.ts:319-340). */
import { prisma } from '@/lib/db';
import { closeRabbit, getRabbit } from '@/lib/queue/connection';
import { publishJudgmentExecute } from '@/lib/queue/publish';
import { parseDlqArgs, resolveReplayLane, runDlq } from './dlq';

async function main(): Promise<void> {
  const args = parseDlqArgs(process.argv.slice(2));
  const { confirmChannel } = await getRabbit();
  const { exitCode } = await runDlq(args, {
    client: prisma,
    channel: confirmChannel,
    publish: publishJudgmentExecute,
    resolveLane: resolveReplayLane,
  });
  process.exitCode = exitCode;
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  })
  .finally(() => {
    void closeRabbit().finally(() => void prisma.$disconnect());
  });
```

3e. In `/root/judge-arena/Dockerfile`, after line 157 (the end of the `scripts/calibration/run.ts` block) and before the blank line preceding `# ─── Stage 2b: Prisma CLI (isolated)`, insert:

```dockerfile

# judge.dlq admin verbs (--list / --replay / --drop-stale). Same treatment as
# the blocks above and for the same reason — and it MUST be bundled: a script
# that is not in the image does not exist in production (handoff trap 4:
# e4b9948's image silently shipped without scripts/**). Verify after promote:
# `kubectl -n tenant-public exec deploy/judge-arena-web -- ls -l /app/admin-dlq.js`.
RUN npx esbuild scripts/admin/dlq-entry.ts \
      --bundle \
      --platform=node \
      --target=node22 \
      --outfile=.next/standalone/admin-dlq.js \
      --external:@prisma/client \
      --tsconfig=tsconfig.json \
      --log-level=warning
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /root/judge-arena && npx vitest run tests/admin/dlq.test.ts`
Expected: PASS — 12 tests (parse 2, classify 4, drift 2, lane 1, list 2, plus none skipped).

Confirm the bundle builds and carries no provider SDK (the CLI's closure is db/logger/queue/claim/run-launch/sampling — verified read-only in planning):
Run: `cd /root/judge-arena && npx esbuild scripts/admin/dlq-entry.ts --bundle --platform=node --target=node22 --outfile=/tmp/admin-dlq.js --external:@prisma/client --tsconfig=tsconfig.json --log-level=warning && grep -c '@anthropic-ai/sdk' /tmp/admin-dlq.js; rm -f /tmp/admin-dlq.js`
Expected: esbuild prints nothing; `grep -c` prints `0` (a non-zero count means an import dragged the registry in — find it with `grep -n "from '@/lib/llm'" scripts/admin/dlq.ts` and replace with the leaf module).

- [ ] **Step 5: Injection**

Injection A (the budget boundary): in `classifyJudgment` change `row.attemptCount >= MAX_ATTEMPTS` to `row.attemptCount > MAX_ATTEMPTS`.
Run: `cd /root/judge-arena && npx vitest run tests/admin/dlq.test.ts`
Expected: FAIL — `an error row at attemptCount >= MAX_ATTEMPTS is max_attempts…`: `expected null to be 'max_attempts'` (the `attemptCount: MAX_ATTEMPTS` case). Restore.

Injection B (list must not consume): in `list()` add, as its first statement, `await ctx.deps.channel.get(QUEUE_DLQ, { noAck: false });`.
Run: same command.
Expected: FAIL — `touches NO message…`: `expected 1 to be +0` on `t.ch.gets()`. Restore.

Injection C (the consumer still dead-letters on the SAME number): in `src/lib/queue/attempts.ts` set `MAX_ATTEMPTS = 30`.
Run: `cd /root/judge-arena && npm run test:integration -- tests/integration/worker-claims.test.ts`
Expected: FAIL — the attempt-cap test (worker-claims.test.ts:679-716, pre-seeds attemptCount 2 and expects an envelope on judge.dlq) times out draining the DLQ / reports 0 envelopes. Restore.

- [ ] **Step 6: Gates**

```bash
cd /root/judge-arena && npm run lint && npx tsc --noEmit && npm run test:coverage
grep DATABASE_URL /root/judge-arena/.env.test
npm run test:db:coverage && npm run test:integration && npm run build
```
Expected: lint 0; tsc 0 (this is the step that proves `prisma` satisfies `DlqClient` and `ConfirmChannel` satisfies `DlqChannel` — dlq-entry.ts is type-checked by `tsc` via tsconfig's `**/*.ts` include); unit = previous + 12; `src/lib/queue/**` floor still passes (attempts.ts adds one covered statement); integration count unchanged.

- [ ] **Step 7: Commit**

```bash
git -C /root/judge-arena add src/lib/queue/attempts.ts src/worker/judgment-consumer.ts scripts/admin/dlq.ts scripts/admin/dlq-entry.ts tests/admin/dlq.test.ts Dockerfile
git -C /root/judge-arena commit -F - <<'EOF'
feat(queue): admin-dlq --list classifies dead-lettered judgments from the database

judge.dlq has had no consumer and no operator verb since it was declared;
the only way to see what is in it was a management-API peek — and on a
quorum queue with the RabbitMQ 4.x default delivery_limit of 20 and no DLX
of its own, every peek that requeues burns one of twenty deliveries
before the broker silently DROPS the message. Ten harmless dry-runs erase
the queue.

So --list is DB-side. Both DLQ writers leave a distinguishable row behind
(markJudgmentError runs before publishToDlq; the persist-failed branch
leaves the row running), and the envelope carries nothing the row does not:
  error + attemptCount >= MAX_ATTEMPTS         -> max_attempts (replayable)
  running, no error, lease expired             -> persist-failed candidate
  completed after >= MAX_ATTEMPTS               -> stale (drop, never replay)
Depth comes from checkQueue. No message is fetched, and the test pins that.

MAX_ATTEMPTS moves from a consumer-private constant to src/lib/queue/
attempts.ts so the CLI classifies on the SAME number the consumer
dead-letters on, without importing the consumer (provider SDKs, realtime
bus, finalizer — none of which belong in an admin bundle or a unit
coverage denominator).

The listing prints sampling drift per calibration — what the run executed
under (v2k header + completed judgments) against what a replay would run
under today (the version's current samplingDefaults through
effectiveSamplingParams). Run 1's ten envelopes are exactly that case:
26 judgments at 8192, a replay today at 12288.

Shipped as the sixth esbuild block (/app/admin-dlq.js); a script that is
not in the image does not exist in production.

--replay and --drop-stale are stubs that list and exit 1 in this commit;
the next commit gives them bodies.

Gates: lint 0, tsc 0, <n> unit / <n> db / <n> integration, coverage 0.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_018ACKb44as67Hz9R3sxexc7
EOF
```

---

### Task 3: `--replay` and `--drop-stale` — consume under `--yes`, reset, publish to the lane, ack last; runbook/handoff/register corrections

**Files:**
- Modify: `/root/judge-arena/scripts/admin/dlq.ts` (imports; replace the two `// Task 3` stubs; add the drain/group helpers)
- Modify: `/root/judge-arena/tests/admin/dlq.test.ts` (append two `describe` blocks)
- Modify: `/root/judge-arena/docs/runbooks/scoring-a-judge-against-a-golden-set.md:363-378` (§8.1)
- Modify: `/root/judge-arena/docs/superpowers/plans/2026-09-01-scoreboard-handoff.md:312-313` (§7 #5)
- Modify: `/root/judge-arena/docs/superpowers/plans/2026-08-30-state-and-next-steps.md:444-446` (§5.6 #10)

**Interfaces:**
- Consumes: everything Task 2 exported; `batchDeadlineMs(count, nowMs)` (Task 1).
- Produces: no new exports. Behaviour contract: `runDlq({verb:'replay', replay, yes:true}, deps)` performs, per replayable judgment with ≥1 envelope, ONE `$transaction` (`modelJudgment.update {status:'pending', error:null, attemptCount:0}` + `evaluationRun.update {status:'judging', finalizedAt:null, deadlineAt}`), then `resolveLane`, then `publish({judgmentId, runId, attempt:1}, lane)`, then `ack` for every envelope of that judgment; every other envelope is `nack(…, false, true)`. `runDlq({verb:'drop-stale', yes:true})` acks envelopes whose judgment is `completed` or absent and nacks the rest. Without `--yes` neither verb calls `channel.get`.

- [ ] **Step 1: Write the failing test**

Append to `/root/judge-arena/tests/admin/dlq.test.ts`:

```ts
describe('runDlq --replay', () => {
  it('without --yes is a dry-run: prints the plan and the drift, consumes nothing, writes nothing', async () => {
    const t = makeDeps({ rows: [row({ id: 'j1' })], envelopes: [envelope('j1', 3), envelope('j1', 4)], calibrations: [calibration] });
    const result = await runDlq(parseDlqArgs(['--replay=j1']), t.deps);
    expect(result).toEqual({ exitCode: 0 });
    expect(t.ch.gets()).toBe(0);
    expect(t.db.judgmentUpdates).toEqual([]);
    expect(t.db.runUpdates).toEqual([]);
    expect(t.published).toEqual([]);
    expect(t.text()).toContain('dry-run');
    expect(t.text()).toContain('SAMPLING DRIFT');
  });

  it('with --yes for one id: ONE transaction resets the row and the run, ONE publish at attempt 1 to the resolved lane, and the ack comes LAST', async () => {
    const t = makeDeps({
      rows: [row({ id: 'j1' }), row({ id: 'j2' })],
      envelopes: [envelope('j1', 3), envelope('j2', 3), envelope('j1', 4), envelope('j2', 4)],
      calibrations: [calibration],
    });
    const result = await runDlq(parseDlqArgs(['--replay=j1', '--yes']), t.deps);
    expect(result).toEqual({ exitCode: 0 });

    // The three state resets the pipeline requires, in one transaction.
    expect(t.db.judgmentUpdates).toEqual([{ id: 'j1', data: { status: 'pending', error: null, attemptCount: 0 } }]);
    expect(t.db.runUpdates).toHaveLength(1);
    expect(t.db.runUpdates[0].id).toBe('run-j1');
    expect(t.db.runUpdates[0].data).toMatchObject({ status: 'judging', finalizedAt: null });
    const deadlineAt = t.db.runUpdates[0].data.deadlineAt as Date;
    // The ONE shared formula, sized on the number of judgments this pass replays.
    expect(deadlineAt.getTime()).toBe(batchDeadlineMs(1, NOW.getTime()));
    expect(deadlineAt.getTime()).toBeGreaterThan(NOW.getTime());

    // One publish, attempt 1 (attemptCount was reset, so hardCapAbortKind sees a fresh budget), to the lane.
    expect(t.published).toEqual([{ msg: { judgmentId: 'j1', runId: 'run-j1', attempt: 1 }, queue: LANE }]);

    // Both of j1's envelopes (attempt 3 and attempt 4 — the double-execution pair) are acked,
    // and ONLY after the transaction and the confirmed publish.
    expect(t.ch.acked.sort()).toEqual([1, 3]);
    expect(t.db.events).toEqual(['tx:judgment:j1', 'tx:run:run-j1', `publish:j1:${LANE}`, 'ack:1', 'ack:3']);

    // j2's envelopes go back — and the tool says what that cost.
    expect(t.ch.nacked).toEqual([
      { tag: 2, requeue: true },
      { tag: 4, requeue: true },
    ]);
    expect(t.text()).toContain('2 envelope(s) requeued');
    expect(t.text()).toContain(`--score-only=${CAL}`);
    expect(t.text()).toContain('prior attemptCount 4');
  });

  it('a publish that rejects leaves every envelope un-acked (requeued) and exits 1', async () => {
    const t = makeDeps({
      rows: [row({ id: 'j1' })],
      envelopes: [envelope('j1', 3), envelope('j1', 4)],
      publish: async () => {
        throw new Error('broker nack');
      },
    });
    const result = await runDlq(parseDlqArgs(['--replay=j1', '--yes']), t.deps);
    expect(result).toEqual({ exitCode: 1 });
    expect(t.ch.acked).toEqual([]);
    expect(t.ch.nacked).toEqual([
      { tag: 1, requeue: true },
      { tag: 2, requeue: true },
    ]);
    expect(t.text()).toContain('broker nack');
  });

  it('refuses a stale (completed) id BEFORE touching the queue and points at --drop-stale', async () => {
    const t = makeDeps({ rows: [row({ id: 'j-done', status: 'completed', attemptCount: 6 })], envelopes: [envelope('j-done', 3)] });
    const result = await runDlq(parseDlqArgs(['--replay=j-done', '--yes']), t.deps);
    expect(result).toEqual({ exitCode: 1 });
    expect(t.ch.gets()).toBe(0);
    expect(t.db.judgmentUpdates).toEqual([]);
    expect(t.text()).toContain('--drop-stale');
  });

  it('refuses an id that is not dead-lettered (unknown, or an error row below the budget) before touching the queue', async () => {
    const t = makeDeps({ rows: [row({ id: 'j-trunc', attemptCount: 1, error: 'CUT OFF' })] });
    expect(await runDlq(parseDlqArgs(['--replay=j-trunc', '--yes']), t.deps)).toEqual({ exitCode: 1 });
    expect(await runDlq(parseDlqArgs(['--replay=nope', '--yes']), t.deps)).toEqual({ exitCode: 1 });
    expect(t.ch.gets()).toBe(0);
  });

  it('a replayable id with NO envelope in the queue is left untouched — the verb drains the DLQ, it does not resurrect rows', async () => {
    const t = makeDeps({ rows: [row({ id: 'j1' })], envelopes: [] });
    const result = await runDlq(parseDlqArgs(['--replay=j1', '--yes']), t.deps);
    expect(result).toEqual({ exitCode: 0 });
    expect(t.db.judgmentUpdates).toEqual([]);
    expect(t.published).toEqual([]);
    expect(t.text()).toContain('no envelope');
  });

  it('--replay=all replays every max_attempts judgment and nothing else, with ONE deadline sized on the batch', async () => {
    const t = makeDeps({
      rows: [
        row({ id: 'j1' }),
        row({ id: 'j2' }),
        row({ id: 'j-done', status: 'completed', attemptCount: 6 }),
        row({ id: 'j-run', status: 'running', error: null }),
      ],
      envelopes: [envelope('j1', 3), envelope('j2', 3), envelope('j-done', 3)],
    });
    const result = await runDlq(parseDlqArgs(['--replay=all', '--yes']), t.deps);
    expect(result).toEqual({ exitCode: 0 });
    expect(t.published.map((p) => p.msg.judgmentId).sort()).toEqual(['j1', 'j2']);
    expect(t.db.runUpdates.map((u) => (u.data.deadlineAt as Date).getTime())).toEqual([
      batchDeadlineMs(2, NOW.getTime()),
      batchDeadlineMs(2, NOW.getTime()),
    ]);
    expect(t.ch.acked.sort()).toEqual([1, 2]);
    expect(t.ch.nacked).toEqual([{ tag: 3, requeue: true }]);
  });
});

describe('runDlq --drop-stale', () => {
  it('without --yes lists the DB-side stale candidates and consumes nothing', async () => {
    const t = makeDeps({
      rows: [row({ id: 'j-done', status: 'completed', attemptCount: 6 }), row({ id: 'j1' })],
      envelopes: [envelope('j-done', 3)],
    });
    expect(await runDlq(parseDlqArgs(['--drop-stale']), t.deps)).toEqual({ exitCode: 0 });
    expect(t.ch.gets()).toBe(0);
    expect(t.text()).toContain('j-done');
    expect(t.text()).toContain('dry-run');
  });

  it('with --yes acks ONLY envelopes whose judgment is completed or missing; everything else is requeued', async () => {
    const t = makeDeps({
      rows: [row({ id: 'j-done', status: 'completed', attemptCount: 6 }), row({ id: 'j1' })],
      envelopes: [envelope('j-done', 3), envelope('j1', 3), envelope('j-gone', 4), envelope('j-done', 4)],
    });
    const result = await runDlq(parseDlqArgs(['--drop-stale', '--yes']), t.deps);
    expect(result).toEqual({ exitCode: 0 });
    expect(t.ch.acked.sort()).toEqual([1, 3, 4]);
    expect(t.ch.nacked).toEqual([{ tag: 2, requeue: true }]);
    expect(t.db.judgmentUpdates).toEqual([]);
    expect(t.published).toEqual([]);
    expect(t.text()).toContain('dropped 3');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /root/judge-arena && npx vitest run tests/admin/dlq.test.ts`
Expected: FAIL — 9 new tests fail; the first failure reads `expected { exitCode: 1 } to deeply equal { exitCode: 0 }` (the dry-run test, against Task 2's stub which exits 1), and the ack-ordering test fails on `expected [] to deeply equal [ 1, 3 ]`.

- [ ] **Step 3: Write the implementation**

In `/root/judge-arena/scripts/admin/dlq.ts`:

3a. Add the import (after `import { LEASE_MS } from '@/worker/claim';`):

```ts
import { batchDeadlineMs } from '@/lib/run-launch';
```

3b. Replace the block from `// ─── Verbs ───` through the end of `dropStale` (leave `runDlq` as is) with:

```ts
// ─── Envelopes (consumed only under --yes) ───────────────────────────────────

interface DlqEntry {
  raw: GetMessage;
  judgmentId: string | null;
  attempt: number | null;
  reason: string;
}

function parseEntry(raw: GetMessage): DlqEntry {
  try {
    const envelope = JSON.parse(raw.content.toString()) as DlqEnvelope;
    const original = (envelope.originalMessage ?? null) as Partial<JudgmentExecuteMsg> | null;
    return {
      raw,
      judgmentId: typeof original?.judgmentId === 'string' ? original.judgmentId : null,
      attempt: typeof original?.attempt === 'number' ? original.attempt : null,
      reason: typeof envelope.reason === 'string' ? envelope.reason : '(no reason)',
    };
  } catch {
    return { raw, judgmentId: null, attempt: null, reason: '(unparseable envelope)' };
  }
}

/** `basic.get` until the queue reports empty. Every message fetched here is
 *  UNACKED on this channel until a verb acks or nacks it; nothing is lost if
 *  the process dies (the broker requeues), but each requeue is one delivery. */
async function drainAll(channel: DlqChannel): Promise<DlqEntry[]> {
  const entries: DlqEntry[] = [];
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- basic.get is sequential by nature: each call fetches the next ready message on this channel
    const raw = await channel.get(QUEUE_DLQ, { noAck: false });
    if (raw === false) break;
    entries.push(parseEntry(raw));
  }
  return entries;
}

function groupByJudgment(entries: DlqEntry[]): Map<string, DlqEntry[]> {
  const grouped = new Map<string, DlqEntry[]>();
  for (const entry of entries) {
    if (entry.judgmentId === null) continue;
    const bucket = grouped.get(entry.judgmentId) ?? [];
    bucket.push(entry);
    grouped.set(entry.judgmentId, bucket);
  }
  return grouped;
}

/** Everything a pass did not ack goes back — and costs one delivery each. */
function requeueRest(entries: DlqEntry[], acked: Set<GetMessage>, ctx: Context): void {
  let requeued = 0;
  for (const entry of entries) {
    if (acked.has(entry.raw)) continue;
    ctx.deps.channel.nack(entry.raw, false, true);
    requeued += 1;
  }
  ctx.out(`${requeued} envelope(s) requeued — each now carries one more delivery toward ${QUEUE_DLQ}'s limit of 20.`);
}

// ─── Verbs ───────────────────────────────────────────────────────────────────

async function list(ctx: Context): Promise<{ exitCode: number }> {
  const entries = await loadCandidates(ctx);
  printTable(entries, ctx.out);
  await printDrift(entries, ctx);
  ctx.out(DELIVERY_NOTE);
  return { exitCode: 0 };
}

/** Resolve `--replay` targets against the DATABASE before any message is
 *  touched, so a refusal costs nothing. Only `max_attempts` rows are
 *  replayable: stale → --drop-stale; persist-failed → never re-run the
 *  provider (the result is in the envelope); anything else was never
 *  dead-lettered. */
async function resolveTargets(args: DlqArgs, ctx: Context): Promise<Classified[] | null> {
  if (args.replay === 'all') {
    return (await loadCandidates(ctx)).filter((c) => c.klass === 'max_attempts');
  }
  const rows = await ctx.deps.client.modelJudgment.findMany({
    where: { id: { in: args.replay } },
    select: JUDGMENT_SELECT,
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const targets: Classified[] = [];
  let refused = 0;
  for (const id of args.replay) {
    const row = byId.get(id);
    const klass = row ? classifyJudgment(row, ctx.nowMs) : null;
    if (row && klass === 'max_attempts') {
      targets.push({ row, klass });
    } else {
      refused += 1;
      ctx.out(
        !row
          ? `  ${id}: REFUSED — no ModelJudgment with that id`
          : klass === 'stale'
            ? `  ${id}: REFUSED — status completed (attemptCount ${row.attemptCount}); its envelopes are stale, use --drop-stale`
            : klass === 'persist_failed_candidate'
              ? `  ${id}: REFUSED — running with no error past the lease: persist-failed-after-success. The provider already answered; the result is in the envelope. Never replay it through the provider; let the reaper reclaim it.`
              : `  ${id}: REFUSED — status ${row.status}, attemptCount ${row.attemptCount}, error ${row.error ?? '(none)'}: never dead-lettered (non_retryable failures are acked without an envelope)`
      );
    }
  }
  return refused > 0 ? null : targets;
}

async function replay(args: DlqArgs, ctx: Context): Promise<{ exitCode: number }> {
  const targets = await resolveTargets(args, ctx);
  if (targets === null) {
    ctx.out('refused — nothing consumed, nothing written');
    return { exitCode: 1 };
  }
  if (targets.length === 0) {
    ctx.out('nothing replayable');
    return { exitCode: 0 };
  }

  // One deadline for the whole pass, sized on the work this pass puts back
  // on the lanes (the calibration-batch shape: the batch finishes as a unit).
  const deadlineAt = new Date(batchDeadlineMs(targets.length, ctx.nowMs));
  ctx.out(
    `plan: ${targets.length} judgment(s) -> pending / error null / attemptCount 0; their run(s) -> judging / finalizedAt null / deadlineAt ${deadlineAt.toISOString()}; publish attempt 1 to the resolved lane; ack their envelopes`
  );
  printTable(targets, ctx.out);
  await printDrift(targets, ctx);
  if (!args.yes) {
    ctx.out('dry-run: no message consumed, nothing written. Re-run with --yes to execute.');
    ctx.out(DELIVERY_NOTE);
    return { exitCode: 0 };
  }

  const entries = await drainAll(ctx.deps.channel);
  const byJudgment = groupByJudgment(entries);
  const acked = new Set<GetMessage>();
  let exitCode = 0;

  for (const { row } of targets) {
    const envelopes = byJudgment.get(row.id) ?? [];
    if (envelopes.length === 0) {
      ctx.out(`  ${row.id}: no envelope in ${QUEUE_DLQ} — nothing to replay; row left as is`);
      continue;
    }
    try {
      // eslint-disable-next-line no-await-in-loop -- one judgment at a time so a failure is individually attributable and its envelopes stay put
      await ctx.deps.client.$transaction(async (tx) => {
        await tx.modelJudgment.update({
          where: { id: row.id },
          data: { status: 'pending', error: null, attemptCount: 0 },
        });
        await tx.evaluationRun.update({
          where: { id: row.runId },
          data: { status: 'judging', finalizedAt: null, deadlineAt },
        });
      });
      // eslint-disable-next-line no-await-in-loop -- see above
      const lane = await ctx.deps.resolveLane(row.run.triggeredById, row.judgeModelVersionId);
      // eslint-disable-next-line no-await-in-loop -- see above
      await ctx.deps.publish({ judgmentId: row.id, runId: row.runId, attempt: 1 }, lane);
      for (const entry of envelopes) {
        ctx.deps.channel.ack(entry.raw);
        acked.add(entry.raw);
      }
      ctx.out(
        `  ${row.id}: reset (prior attemptCount ${row.attemptCount}), published attempt 1 to ${lane}, acked ${envelopes.length} envelope(s) (attempts ${envelopes.map((e) => e.attempt ?? '?').join(',')})`
      );
      if (row.run.calibrationRunId) {
        ctx.out(`    when it completes: node /app/calibration-run.js --score-only=${row.run.calibrationRunId}`);
      }
    } catch (error) {
      exitCode = 1;
      ctx.out(
        `  ${row.id}: FAILED — ${error instanceof Error ? error.message : String(error)}. Envelope(s) left in ${QUEUE_DLQ}. ` +
          'If the transaction committed, the row is pending with no message on a lane; the reaper republishes pending judgments of an overdue run at its deadline.'
      );
    }
  }

  requeueRest(entries, acked, ctx);
  return { exitCode };
}

async function dropStale(args: DlqArgs, ctx: Context): Promise<{ exitCode: number }> {
  const stale = (await loadCandidates(ctx)).filter((c) => c.klass === 'stale');
  ctx.out(`DB-side stale candidates (completed after >= ${MAX_ATTEMPTS} attempts): ${stale.length}`);
  printTable(stale, ctx.out);
  if (!args.yes) {
    ctx.out(
      'dry-run: no message consumed. With --yes, every envelope whose judgment is completed or no longer exists is acked (dropped); the rest are requeued.'
    );
    ctx.out(DELIVERY_NOTE);
    return { exitCode: 0 };
  }

  const entries = await drainAll(ctx.deps.channel);
  const ids = [...groupByJudgment(entries).keys()];
  const rows = ids.length
    ? await ctx.deps.client.modelJudgment.findMany({ where: { id: { in: ids } }, select: JUDGMENT_SELECT })
    : [];
  const statusById = new Map(rows.map((r) => [r.id, r.status]));
  const acked = new Set<GetMessage>();
  for (const entry of entries) {
    if (entry.judgmentId === null) continue; // unparseable — never drop what we cannot read
    const status = statusById.get(entry.judgmentId);
    if (status === undefined || status === 'completed') {
      ctx.deps.channel.ack(entry.raw);
      acked.add(entry.raw);
      ctx.out(`  dropped envelope for ${entry.judgmentId} (attempt ${entry.attempt ?? '?'}): judgment ${status ?? 'not found'}`);
    }
  }
  ctx.out(`dropped ${acked.size} envelope(s)`);
  requeueRest(entries, acked, ctx);
  return { exitCode: 0 };
}
```

3c. In `runDlq`, change the last line `return dropStale(ctx);` to `return dropStale(args, ctx);`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /root/judge-arena && npx vitest run tests/admin/dlq.test.ts`
Expected: PASS — 21 tests.

- [ ] **Step 5: Injection — the three orderings/resets that cannot be allowed to drift**

Injection A (ack before publish — the "lose the only record" bug): in `replay()` move the `for (const entry of envelopes) { ctx.deps.channel.ack(entry.raw); acked.add(entry.raw); }` loop to just BEFORE `const lane = await ctx.deps.resolveLane(...)`.
Run: `cd /root/judge-arena && npx vitest run tests/admin/dlq.test.ts`
Expected: FAIL — `…the ack comes LAST`: the events array reads `['tx:judgment:j1', 'tx:run:run-j1', 'ack:1', 'ack:3', 'publish:j1:…']`; AND `a publish that rejects leaves every envelope un-acked…`: `expected [ 1, 2 ] to deeply equal []`. Restore.

Injection B (attempt budget): in the transaction change `attemptCount: 0` to `attemptCount: row.attemptCount`.
Run: same command.
Expected: FAIL — `…ONE transaction resets the row…`: `data: { …, attemptCount: 4 }` vs expected `0`. Restore.

Injection C (deadline extension — the reaper's `reaper: abandoned` stamp): change `const deadlineAt = new Date(batchDeadlineMs(targets.length, ctx.nowMs));` to `const deadlineAt = new Date(ctx.nowMs);`.
Run: same command.
Expected: FAIL — `expect(deadlineAt.getTime()).toBe(batchDeadlineMs(1, NOW.getTime()))` and `toBeGreaterThan(NOW.getTime())`. Restore.

Injection D (dry-run must not consume): in `replay()` move `const entries = await drainAll(ctx.deps.channel);` above `if (!args.yes)`.
Run: same command.
Expected: FAIL — `without --yes is a dry-run…`: `expected 3 to be +0` on `gets()`. Restore.

- [ ] **Step 6: Docs whose statements this deliverable makes true (CORRECTION notes, never silent)**

6a. `/root/judge-arena/docs/runbooks/scoring-a-judge-against-a-golden-set.md` — replace lines 363-378 (from `### 8.1 Dead-lettered judgments…` through `…not as a fixed\nnumber of provider calls.)*`) with:

```markdown
### 8.1 Dead-lettered judgments land in `judge.dlq` — nothing consumes it; an admin verb drains it

The attempt budget is `MAX_ATTEMPTS = 3` (`src/lib/queue/attempts.ts` — first delivery plus two
retries, via the 30 s and 5 m retry queues). On exhaustion the judgment is marked `error` and
`publishToDlq` puts the envelope on **`judge.dlq`**.

> **CORRECTION 2026-09-01.** This section used to cite `MAX_ATTEMPTS` at
> `src/worker/judgment-consumer.ts:154`; it was at `:199` when that was written and it now lives in
> `src/lib/queue/attempts.ts` so the DLQ CLI classifies on the same number. It also said "there is no
> retry-from-DLQ verb … nothing will ever retry it … the only remedy is a **new** calibration". There
> is a verb now, and "run 1's four dead-lettered judgments" was five judgments × two envelopes = the
> ten messages the queue holds (the fifth, `cmtgib28w00696k2rrh64vmhp`, later completed on attempt 6,
> so its two envelopes are stale).

`judge.dlq` still has **no consumer, by design** (a parked store, not a retry loop). The operator
verb is `scripts/admin/dlq.ts`, bundled as `/app/admin-dlq.js`:

```sh
kubectl -n tenant-public exec deploy/judge-arena-web -- node /app/admin-dlq.js --list
kubectl -n tenant-public exec deploy/judge-arena-web -- node /app/admin-dlq.js --replay=<judgmentId,...>|all [--yes]
kubectl -n tenant-public exec deploy/judge-arena-web -- node /app/admin-dlq.js --drop-stale [--yes]
```

`--list` is **database-side** and never fetches a message. That matters: `judge.dlq` is a quorum queue
with RabbitMQ 4.x's default `delivery_limit` of **20** and no dead-letter exchange of its own, so every
management-UI peek, `rabbitmqadmin get`, or requeued `basic.get` burns one of twenty deliveries before
the broker **drops the message silently**. Only `--replay`/`--drop-stale` consume, only under `--yes`,
and they ack an envelope only after the committed transaction and the confirmed publish; everything a
pass leaves behind is requeued and the tool prints how many deliveries that cost.

A replay is three state resets, not a republish: the judgment goes back to `pending` / `attemptCount 0`
(the claim path only claims `pending`; `hardCapAbortKind` reads the row's attempt count), and its run
goes back to `judging` with `finalizedAt` cleared and `deadlineAt` extended (the reaper force-finalizes
an overdue run within three sweeps and stamps its pending judgments `reaper: abandoned`). Then attempt
1 is published to the lane the reaper would choose, and the envelope is acked. When the judgment
completes, re-score with `--score-only=<calibrationRunId>` (the tool prints the exact command).

**Read the sampling-drift line before replaying a calibration's judgments.** A replay runs under the
judge version's *current* `samplingDefaults`; if the rest of the run executed under a different
`max_tokens` (run 1: 26 judgments at 8192, the version now at 12288) the result is a mixed-config
calibration that §8.8 says is not comparable. For run 1 the honest options are `--drop-stale` plus
leaving or replaying the other eight, or a fresh calibration — an owner decision, recorded in
`docs/superpowers/plans/2026-09-01-dlq-admin-cli.md`.

So: a non-zero DLQ depth is no longer permanent data loss, but it is still a **signal to act on**, and
depth 0 is the normal state. *(Run 1's failures were recorded as four attempts each against a budget
of three; `attemptCount` can advance past the message's own `attempt` across crash-reclaim cycles, so
read the DLQ trigger as "the attempt budget ran out", not as a fixed number of provider calls.)*
```

6b. `/root/judge-arena/docs/superpowers/plans/2026-09-01-scoreboard-handoff.md` — replace lines 312-313:

```markdown
5. **`judge.dlq` holds 10 messages, has no consumer and no replay verb.** It grew from 4 during
   ordinary operation, so it is an accumulating sink, not run-1 residue.
```

with:

```markdown
5. **`judge.dlq` holds 10 messages and has no consumer.**
   > **CORRECTION 2026-09-01 — this item used to continue "It grew from 4 during ordinary
   > operation, so it is an accumulating sink, not run-1 residue." That was FALSE.** The "4" was a
   > count of dead-lettered *judgments* (state doc §5.5/3), never a measured queue depth. All 10
   > envelopes are run 1 (`cmtgib0xr00016k2r8nlyj1py`, 2026-08-31 01:20–01:44Z): 5 judgments × 2
   > envelopes (attempt 3 and attempt 4 — the pre-`414e826` 330 s lease against a 3×300 s
   > in-registry retry, the double execution U3 fixes). Four are still `error` / attemptCount 4;
   > the fifth (`cmtgib28w00696k2rrh64vmhp`) later completed on attempt 6, so its two envelopes are
   > stale. Nothing has dead-lettered since; the 21 later `error` rows are truncation
   > (`non_retryable`, acked without an envelope). It is run-1 residue, not a sink.
   The replay verb exists now — `docs/superpowers/plans/2026-09-01-dlq-admin-cli.md`
   (`/app/admin-dlq.js --list | --replay | --drop-stale`). What remains is the **owner decision**
   on the 10: replay at today's `max_tokens` 12288 into a run that executed at 8192, or drop.
```

6c. `/root/judge-arena/docs/superpowers/plans/2026-08-30-state-and-next-steps.md` — replace lines 444-446:

```markdown
10. **`judge.dlq` is now at 10, up from the 4 in item 3.** Still no consumer, still no replay verb.
   The depth grew during ordinary operation, which is the argument item 3 was missing — this is not a
   one-off residue from run 1, it is an accumulating sink.
```

with:

```markdown
10. **`judge.dlq` is at 10.** Still no consumer (by design).
   > **CORRECTION 2026-09-01 — this item used to read "up from the 4 in item 3 … it is an
   > accumulating sink". That was FALSE: item 3's "four" counted dead-lettered judgments, never a
   > queue depth, and every one of the 10 envelopes is run-1 residue** (5 judgments × 2 envelopes,
   > attempt 3 and attempt 4, 2026-08-31 01:20–01:44Z; nothing has dead-lettered since). The replay
   > verb now exists: `docs/superpowers/plans/2026-09-01-dlq-admin-cli.md`. Disposition of the 10 is
   > an owner decision (mixed-`max_tokens` replay vs drop).
```

- [ ] **Step 7: Gates**

```bash
cd /root/judge-arena && npm run lint && npx tsc --noEmit && npm run test:coverage
grep DATABASE_URL /root/judge-arena/.env.test
npm run test:db:coverage && npm run test:integration && npm run build
```
Expected: lint 0; tsc 0; unit = previous + 9; db/integration unchanged; all floors pass.

- [ ] **Step 8: Commit**

```bash
git -C /root/judge-arena add scripts/admin/dlq.ts tests/admin/dlq.test.ts docs/runbooks/scoring-a-judge-against-a-golden-set.md docs/superpowers/plans/2026-09-01-scoreboard-handoff.md docs/superpowers/plans/2026-08-30-state-and-next-steps.md
git -C /root/judge-arena commit -F - <<'EOF'
feat(queue): admin-dlq --replay and --drop-stale drain judge.dlq

A replay is three state resets, not a republish. The claim path only
claims `pending`; hardCapAbortKind reads the ROW's attemptCount, so a
republished judgment at attemptCount 4 is non_retryable on its first
hard-cap abort; the reaper force-finalizes any run whose deadlineAt is
>180 s stale and stamps its pending judgments `reaper: abandoned` (the
five affected runs carry 2026-08-31 01:36); and run-finalizer only
transitions an ACTIVE run. So, per judgment, ONE transaction: row ->
pending / error null / attemptCount 0 (prior count logged), run ->
judging / finalizedAt null / deadlineAt via batchDeadlineMs (the one
formula, sized on the pass). Then the reaper's own lane path —
resolveEndpointsForPairs -> resolveDestinationQueue ->
publishJudgmentExecute attempt 1 — re-implemented because the reaper
keeps it private and importing the reaper would drag redis and the
finalizer into an admin bundle. Then, and only then, ack every envelope
for that judgment (the attempt-3/attempt-4 pairs collapse to one
publish).

Ordering is the point and the tests pin it: ack before publish loses the
only record of the dead-lettered judgment on a broker failure, so a
rejected publish leaves every envelope un-acked (requeued) and exits 1.
Dry-run (no --yes) never calls basic.get. Targets are refused against
the DATABASE before any message is touched: stale -> --drop-stale;
persist-failed -> never re-run the provider, the result is in the
envelope; anything else was never dead-lettered.

--drop-stale acks only envelopes whose judgment is completed or gone.
Everything a pass leaves behind is nack-requeued and the tool prints the
count, because on this quorum queue (delivery_limit 20, no DLX) each
requeue is one delivery closer to a silent drop.

Docs corrected rather than overwritten: runbook §8.1 (MAX_ATTEMPTS was
cited at :154, was at :199, now src/lib/queue/attempts.ts; "no
retry-from-DLQ verb" is no longer true), handoff §7 #5 and register
§5.6/10 ("grew from 4 / accumulating sink" was false — all 10 are run-1
residue, 5 judgments x 2 envelopes). The disposition of those 10 — replay
at 12288 into a run that executed at 8192, or drop — is recorded as an
owner decision, not made.

Injected: ack moved before publish -> two tests red; attemptCount kept ->
red; deadline = now -> red; drain before the --yes check -> red.

Gates: lint 0, tsc 0, <n> unit / <n> db / <n> integration, coverage 0.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_018ACKb44as67Hz9R3sxexc7
EOF
```

---

### Task 4: Topology documentation — the "five queues" claims (topology.ts header, README, CONTRIBUTING)

These three ranges were assigned to this item by the critique's U7/q3 doc allocation. They are stale since v2j (2026-09-01: 8 lanes + 2 `.v2` retry queues, 15 queues live), not because of this plan's code; they get their own `docs(queue)` commit.

**Files:**
- Modify: `/root/judge-arena/src/lib/queue/topology.ts:1-31` (header comment only)
- Modify: `/root/judge-arena/README.md:281-293` (diagram + paragraph) and `:349-353` (the parenthetical)
- Modify: `/root/judge-arena/CONTRIBUTING.md:1237-1246` (the "Update" paragraph)

**Interfaces:** none (comments and prose only).

- [ ] **Step 1: Pin the fact the docs must agree with**

The "test" for prose is the code it describes. Run:
`cd /root/judge-arena && grep -n "LANE_COUNT = \|QUEUE_JUDGMENT_RETRY_30S_V2\|QUEUE_JUDGMENT_RETRY_5M_V2\|x-single-active-consumer" src/lib/queue/lanes.ts src/lib/queue/topology.ts`
Expected: `lanes.ts:63:export const LANE_COUNT = 8;`, `topology.ts:73/74` the two `.v2` constants, and one `x-single-active-consumer` hit in `assertTopology` — 8 lanes + `judgment.execute` + `run.create` + `judge.dlq` = 11 quorum; 4 classic retry queues; 15 total. Every number written below must match this output.

- [ ] **Step 2: topology.ts header**

Replace `/root/judge-arena/src/lib/queue/topology.ts` lines 1-17:

```ts
/**
 * ─── RabbitMQ Topology ────────────────────────────────────────────────────
 *
 * Declares judge-arena's queue topology: one direct exchange, three quorum
 * queues (replicated, crash-safe — the actual work queues), and two classic
 * TTL+dead-letter "retry" queues that hold a failed judgment for a fixed
 * delay before it dead-letters back onto `judgment.execute` for another
 * attempt.
 *
 *   judge.direct (exchange, direct, durable)
 *     ├─ judgment.execute        (quorum)  — routing key: judgment.execute
 *     ├─ run.create              (quorum)  — routing key: run.create
 *     ├─ judge.dlq               (quorum)  — routing key: judge.dlq
 *     ├─ judgment.retry.30s      (classic) — routing key: judgment.retry.30s
 *     │    TTL 30s -> dead-letters to judge.direct/judgment.execute
 *     └─ judgment.retry.5m       (classic) — routing key: judgment.retry.5m
 *          TTL 5m  -> dead-letters to judge.direct/judgment.execute
```

with:

```ts
/**
 * ─── RabbitMQ Topology ────────────────────────────────────────────────────
 *
 * Declares judge-arena's queue topology: one direct exchange, two fanout
 * delay exchanges, ELEVEN quorum queues (replicated, crash-safe — the actual
 * work queues: eight per-server lanes, the lane fallback `judgment.execute`,
 * `run.create`, and `judge.dlq`) and FOUR classic TTL "retry" queues that
 * hold a failed judgment for a fixed delay before it dead-letters back for
 * another attempt.
 *
 *   judge.direct (exchange, direct, durable)
 *     ├─ judgment.execute            (quorum) — lane FALLBACK, consumed forever
 *     ├─ judgment.execute.lane.0..7  (quorum, x-single-active-consumer) — v2j lanes
 *     ├─ run.create                  (quorum)
 *     ├─ judge.dlq                   (quorum) — NO consumer, NO DLX of its own,
 *     │    RabbitMQ 4.x default delivery_limit 20 (a requeued peek burns one);
 *     │    drained only by scripts/admin/dlq.ts (--replay / --drop-stale)
 *     ├─ judgment.retry.30s          (classic) TTL 30s -> DLX judge.direct/judgment.execute (legacy)
 *     ├─ judgment.retry.5m           (classic) TTL 5m  -> same (legacy)
 *     ├─ judgment.retry.30s.v2       (classic) TTL 30s, fed by fanout judge.delay.30s,
 *     │    DLX judge.direct WITHOUT a routing-key override -> returns to its own lane
 *     └─ judgment.retry.5m.v2        (classic) TTL 5m, fed by fanout judge.delay.5m, same
 *
 * CORRECTION 2026-09-01: until then this header said "three quorum queues"
 * and drew five queues in total. It predated the v2j lanes and the `.v2`
 * retry queues declared further down THIS file, and the live broker held 15
 * queues while the doc said 5. README.md and CONTRIBUTING.md carried the same
 * count; corrected in the same commit.
```

Lines 19-31 (the "Every queue is bound…" and "Retry queues are intentionally classic…" paragraphs) stay unchanged.

- [ ] **Step 3: README.md**

Replace lines 281-293 (the fenced diagram plus the paragraph ending `See \`src/lib/queue/topology.ts\`.`):

```markdown
```
judge.direct  (exchange, direct, durable)
  ├─ judgment.execute     (quorum)   the work queue
  ├─ run.create           (quorum)   run fan-out
  ├─ judge.dlq            (quorum)   dead letters
  ├─ judgment.retry.30s   (classic)  TTL 30s -> DLXs back to judgment.execute
  └─ judgment.retry.5m    (classic)  TTL 5m  -> DLXs back to judgment.execute
```

Every queue is bound with a routing key equal to its own name, so producers and retry re-publishes
always go *through* the exchange, never `sendToQueue`. Retry queues are classic on purpose: they are
short-lived holding pens with no consumer, so replication belongs on the queues judgments are
actually consumed from. See `src/lib/queue/topology.ts`.
```

with:

```markdown
```
judge.direct  (exchange, direct, durable)
  ├─ judgment.execute.lane.0..7  (quorum, single-active-consumer)  one lane per endpoint origin (v2j)
  ├─ judgment.execute            (quorum)   lane fallback — consumed forever
  ├─ run.create                  (quorum)   run fan-out
  ├─ judge.dlq                   (quorum)   dead letters — no consumer; drained by /app/admin-dlq.js
  ├─ judgment.retry.30s / .5m    (classic)  legacy TTL pens -> DLX back to judgment.execute
  └─ judgment.retry.30s.v2 / .5m.v2 (classic) TTL pens fed by fanouts judge.delay.30s / .5m,
                                             DLX back to judge.direct under the LANE routing key
```

> **CORRECTION 2026-09-01 — this diagram showed five queues until then.** It predated the v2j lanes
> and the `.v2` retry queues; the live broker has 15 queues (11 quorum, 4 classic). "Dead letters"
> also had no operator verb: `scripts/admin/dlq.ts` (`--list | --replay | --drop-stale`, bundled as
> `/app/admin-dlq.js`) now exists — `--list` is database-side because `judge.dlq`'s quorum
> `delivery_limit` of 20 makes every requeued peek destructive.

Every queue is bound with a routing key equal to its own name, so producers and retry re-publishes
always go *through* the exchange, never `sendToQueue`. Retry queues are classic on purpose: they are
short-lived holding pens with no consumer, so replication belongs on the queues judgments are
actually consumed from. See `src/lib/queue/topology.ts`.
```

Then replace lines 349-353 (inside the "Update, later on 2026-08-29" blockquote):

```markdown
> `kubectl -n tenant-public exec rabbitmq-judge-arena-server-0 -c rabbitmq -- rabbitmqctl list_queues name messages consumers`
> → `judgment.execute 0 1`, `run.create 0 1`. (`judge.dlq` and both `judgment.retry.*` queues report
> 0 consumers and always will — they have no consumer by design, so they are not a signal either way;
> the two work queues are.) Nothing about the reconnect path changed, so the next broker or Postgres
> roll can silently do this again.
```

with:

```markdown
> `kubectl -n tenant-public exec rabbitmq-judge-arena-server-0 -c rabbitmq -- rabbitmqctl list_queues name messages consumers`
> → `judgment.execute 0 1`, `run.create 0 1`. (`judge.dlq` and both `judgment.retry.*` queues report
> 0 consumers and always will — they have no consumer by design, so they are not a signal either way;
> the two work queues are.) Nothing about the reconnect path changed, so the next broker or Postgres
> roll can silently do this again.
>
> **CORRECTION 2026-09-01:** since v2j the shape of health is **ten** consumers — the eight
> `judgment.execute.lane.*` queues plus `judgment.execute` and `run.create` — and the queues that
> always read 0 consumers are five: `judge.dlq` and the four `judgment.retry.*` pens. The worker's
> `/health` counts exactly those ten (`WORKER_CONSUMER_QUEUES`, `src/worker/health.ts`).
```

- [ ] **Step 4: CONTRIBUTING.md**

After line 1246 (the paragraph ending `…on a pod that stays \`1/1 Running\` with 0 restarts.`), insert:

```markdown

> **CORRECTION 2026-09-01 — the paragraph above says "the other three (`judge.dlq`,
> `judgment.retry.30s`, `judgment.retry.5m`)" and "5 queues at zero was the shape of the outage, but
> 2 queues at one is the shape of health".** Both counts were true on 2026-08-29 and are stale since
> v2j (2026-09-01): the broker has 15 queues; health is **ten** consumers (eight
> `judgment.execute.lane.*` + `judgment.execute` + `run.create`, which is exactly what
> `WORKER_CONSUMER_QUEUES` in `src/worker/health.ts` pins); the no-consumer set is five (`judge.dlq`
> plus four retry pens). `judge.dlq` now has an operator verb — `scripts/admin/dlq.ts`, see runbook
> §8.1 — but still, and deliberately, no consumer: adding one to the worker breaks
> `tests/lib/worker-health.test.ts` by design.
```

- [ ] **Step 5: Verify the docs against the code (the prose injection)**

Run: `cd /root/judge-arena && grep -c "lane.0..7\|lane\.\*" README.md src/lib/queue/topology.ts && grep -n "CORRECTION 2026-09-01" README.md CONTRIBUTING.md src/lib/queue/topology.ts docs/runbooks/scoring-a-judge-against-a-golden-set.md | wc -l`
Expected: non-zero counts for both README and topology.ts; the second command prints `5` (README ×2, CONTRIBUTING ×1, topology ×1, runbook ×1 from Task 3).

Injection (a doc that disagrees with the code must be visible): temporarily set `LANE_COUNT = 9` in lanes.ts and re-run Step 1's grep — the header's "0..7" is now wrong and the grep in Step 1 shows `9`. That is what the header's "match this output" instruction exists for. Restore.

- [ ] **Step 6: Gates**

```bash
cd /root/judge-arena && npm run lint && npx tsc --noEmit && npm run test:coverage && npm run build
```
Expected: unchanged counts (a comment edit in topology.ts and prose elsewhere).

- [ ] **Step 7: Commit**

```bash
git -C /root/judge-arena add src/lib/queue/topology.ts README.md CONTRIBUTING.md
git -C /root/judge-arena commit -F - <<'EOF'
docs(queue): the topology has 15 queues, not five — correct three stale headers

topology.ts's own header, README's diagram and CONTRIBUTING's "the other
three / 5 queues at zero / 2 queues at one" paragraph all predate the v2j
lanes and the .v2 retry queues that the same topology.ts declares forty
lines further down. The live broker holds 15 queues (8 lanes + fallback +
run.create + judge.dlq quorum; 4 classic retry pens); health is TEN
consumers, which is exactly what WORKER_CONSUMER_QUEUES pins.

Each range is corrected with a CORRECTION note naming what it used to
say, per the repo convention — the stale count was in three places
because it was copied, which is the same seam-count lesson as §5.1.

Also names the DLQ verb the previous commit shipped where the docs called
judge.dlq "dead letters" with no operator path.

Gates: lint 0, tsc 0, <n> unit / <n> db / <n> integration, coverage 0.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_018ACKb44as67Hz9R3sxexc7
EOF
```

---

### Task 5: SEPARATE PR in /root/homelab-setup — scrape the broker, audit-mode DLQ alert, header correction, runbook

This task touches ONLY `/root/homelab-setup`. Do not run it from a judge-arena shell state; every command below is absolute. The rule fires on day one (depth 10) — that is intentional and documented per `docs/runbooks/audit-mode-promotion.md:31-38` ("It is firing, and clearing needs unscheduled work → hold at info"): what clears it is the verb Task 3 shipped plus the owner decision, and the annotation says so.

**Files:**
- Create: `/root/homelab-setup/apps/public/judge-arena/vmservicescrape-rabbitmq.yaml`
- Modify: `/root/homelab-setup/apps/public/judge-arena/kustomization.yaml:31` (add one resource line after `- rabbitmq.yaml`)
- Modify: `/root/homelab-setup/apps/public/judge-arena/rabbitmq.yaml:11-18` and `:110-111` (header comments)
- Create: `/root/homelab-setup/docs/runbooks/judge-arena-dlq-backlog.md`

**Interfaces:**
- Consumes: Service `rabbitmq-judge-arena` in `tenant-public`, label `app.kubernetes.io/name: rabbitmq-judge-arena`, port name `prometheus` (15692); metric `rabbitmq_detailed_queue_messages_ready{vhost="/",queue="judge.dlq"}` from `/metrics/detailed?family=queue_coarse_metrics` (leader-only); the verbs from Task 3.
- Produces: VMServiceScrape `rabbitmq-judge-arena` and VMRule `judge-arena-rabbitmq` (alert `JudgeArenaDlqBacklog`, `severity: info`, `audit_mode_until: "2026-09-15"`) in `tenant-public`.

- [ ] **Step 1: Write the failing check**

The "test" is the repo's own alerting syntax check plus a render. Before creating the file:
Run: `cd /root/homelab-setup && kubectl kustomize apps/public/judge-arena | grep -c 'JudgeArenaDlqBacklog'`
Expected: `0` (nothing renders the alert yet).

- [ ] **Step 2: Create the scrape + rule**

Create `/root/homelab-setup/apps/public/judge-arena/vmservicescrape-rabbitmq.yaml`:

```yaml
## VMServiceScrape + VMRule — judge-arena's RabbitMQ broker (T5, steps 1 and 2).
##
## Before this file NOTHING scraped the broker: Service rabbitmq-judge-arena
## publishes a `prometheus` port (15692, rabbitmq_prometheus is enabled by the
## Cozystack CR) and zero VMServiceScrape/VMRule in this repo mentioned rabbitmq
## (docs/proxmox-cozystack-divergence.md, the T5 entries). judge.dlq sat at 10
## messages for two days with no signal but a hand-run `rabbitmqctl list_queues`.
##
## TWO ENDPOINTS, DELIBERATELY. The default /metrics is aggregated per node and
## carries NO queue label (`rabbitmq_queue_messages_ready 0`), so it cannot say
## WHICH queue has a backlog. Per-queue depth comes only from
## /metrics/detailed?family=queue_coarse_metrics, which emits
## `rabbitmq_detailed_queue_messages_ready{vhost="/",queue="judge.dlq"}` — and
## ONLY on the queue's quorum LEADER. Verified 2026-09-01: server-1 (leader)
## emitted `10`; server-0 emitted only queue_info{membership="follower"}. Hence
## `max by (queue)` in the rule: two of three replicas report nothing for the
## queue, and an unaggregated expr would either alert per pod or not at all
## after a leader move. `interval: 60s` on both — the detailed family is a
## per-queue walk on the broker, and 15 queues at one sample a minute is noise.
##
## SELECTOR: both rabbitmq-judge-arena (client) and rabbitmq-judge-arena-nodes
## (headless) carry app.kubernetes.io/name=rabbitmq-judge-arena. `port:
## prometheus` is what disambiguates: the headless Service has only epmd and
## cluster-rpc, so it yields no target. Do not "tighten" the selector with a
## label the operator may rename; the port name is the contract.
apiVersion: operator.victoriametrics.com/v1beta1
kind: VMServiceScrape
metadata:
  name: rabbitmq-judge-arena
  namespace: tenant-public
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: rabbitmq-judge-arena
  endpoints:
    - port: prometheus
      interval: 60s
      path: /metrics
    - port: prometheus
      interval: 60s
      path: /metrics/detailed
      params:
        family:
          - queue_coarse_metrics
---
## judge.dlq is the ONLY queue expected to hold anything for long (rabbitmq.yaml
## SIZING note): a message there is a judgment the worker gave up on after its
## attempt budget, parked with no consumer. Depth 0 is the normal state.
##
## AUDIT MODE, AND FIRING AT SHIP TIME — ON PURPOSE. The queue holds 10
## envelopes (calibration run 1, 2026-08-31, 5 judgments x 2). Per
## docs/runbooks/audit-mode-promotion.md ("clean is not sufficient — it must
## also be CLEAR") and CLAUDE.md ("what clears this?"): the clearing verb exists
## — judge-arena's `/app/admin-dlq.js --replay | --drop-stale` — but WHICH to run
## on the 10 is an owner decision (replay at today's max_tokens 12288 into a run
## that executed at 8192, or drop). Row 3 of the promotion table applies: hold at
## info, track the decision, promote only once the queue is at 0 and the rule
## has been quiet for its window. Do NOT promote this to warning while the 10
## are still there; that installs a permanent ratchet on day one.
apiVersion: operator.victoriametrics.com/v1beta1
kind: VMRule
metadata:
  name: judge-arena-rabbitmq
  namespace: tenant-public
spec:
  groups:
    - name: judge-arena-rabbitmq.rules
      rules:
        - alert: JudgeArenaDlqBacklog
          ## `max by (queue)`: only the quorum leader emits the sample (see
          ## the scrape's header). `for: 15m` absorbs a leader election
          ## (the sample briefly disappears) without a flap.
          expr: |
            max by (queue) (rabbitmq_detailed_queue_messages_ready{queue="judge.dlq"}) > 0
          for: 15m
          labels:
            severity: info
            tier: public
          annotations:
            audit_mode_until: "2026-09-15"
            summary: "judge.dlq holds {{ $value }} dead-lettered judgment envelope(s)"
            description: |
              {{ $value }} message(s) parked on judge.dlq (tenant-public,
              broker rabbitmq-judge-arena). Each is a ModelJudgment the worker
              gave up on after MAX_ATTEMPTS, or a result it could not persist.
              Nothing consumes this queue by design. See what is there WITHOUT
              consuming (the queue's quorum delivery_limit is 20 — every
              requeued peek burns one):
                kubectl -n tenant-public exec deploy/judge-arena-web -- node /app/admin-dlq.js --list
              What clears this: --replay=<ids|all> --yes or --drop-stale --yes
              from the same CLI (runbook). The 10 envelopes present at ship time
              are calibration run 1 residue awaiting an owner decision.
            runbook_url: https://gitea.cluster.asethi.com/Trijeet/homelab/raw/branch/main/docs/runbooks/judge-arena-dlq-backlog.md
```

- [ ] **Step 3: Wire it into the Kustomization and correct rabbitmq.yaml's header**

3a. In `/root/homelab-setup/apps/public/judge-arena/kustomization.yaml`, replace line 31:

```yaml
  - rabbitmq.yaml
```

with:

```yaml
  - rabbitmq.yaml
  ## Broker scrape + audit-mode judge.dlq alert (T5). Outside the chart like the
  ## broker itself; no Chart.yaml bump involved.
  - vmservicescrape-rabbitmq.yaml
```

3b. In `/root/homelab-setup/apps/public/judge-arena/rabbitmq.yaml`, replace lines 11-18:

```yaml
##   judge.direct   (exchange, direct, durable)
##     ├─ judgment.execute   quorum   x-queue-type: quorum
##     ├─ run.create         quorum   x-queue-type: quorum
##     ├─ judge.dlq          quorum   x-queue-type: quorum
##     ├─ judgment.retry.30s classic  x-message-ttl 30000,
##     │                              x-dead-letter-exchange judge.direct,
##     │                              x-dead-letter-routing-key judgment.execute
##     └─ judgment.retry.5m  classic  x-message-ttl 300000, same DLX/DLK
```

with:

```yaml
##   judge.direct   (exchange, direct, durable)
##     ├─ judgment.execute.lane.0..7  quorum  x-single-active-consumer (v2j lanes)
##     ├─ judgment.execute            quorum  lane fallback, consumed forever
##     ├─ run.create                  quorum
##     ├─ judge.dlq                   quorum  no consumer, no DLX, default delivery_limit 20
##     ├─ judgment.retry.30s / .5m    classic x-message-ttl, DLX judge.direct,
##     │                                      x-dead-letter-routing-key judgment.execute (legacy)
##     └─ judgment.retry.30s.v2 / .5m.v2 classic fed by fanouts judge.delay.30s/.5m,
##                                            DLX judge.direct with NO routing-key override
##   CORRECTION 2026-09-01: this header listed five queues until then; it
##   predated the v2j lanes and .v2 retry queues. The live broker has 15
##   (11 quorum, 4 classic). vmservicescrape-rabbitmq.yaml is the depth signal.
```

and replace lines 110-111 (now shifted by four lines; anchor on the text):

```yaml
## replicas: 3 — this is the number the app's design already assumes. Three of
## the five queues are `x-queue-type: quorum`, and a quorum queue on a
```

with:

```yaml
## replicas: 3 — this is the number the app's design already assumes. Eleven of
## the fifteen queues are `x-queue-type: quorum` (was "three of the five" before
## v2j — corrected 2026-09-01), and a quorum queue on a
```

- [ ] **Step 4: Runbook the alert points at**

Create `/root/homelab-setup/docs/runbooks/judge-arena-dlq-backlog.md`:

```markdown
# JudgeArenaDlqBacklog — judge.dlq holds dead-lettered judgments

**Rule:** `apps/public/judge-arena/vmservicescrape-rabbitmq.yaml`, alert `JudgeArenaDlqBacklog`,
`max by (queue)(rabbitmq_detailed_queue_messages_ready{queue="judge.dlq"}) > 0` for 15m. Audit mode
(`severity: info`, `audit_mode_until: 2026-09-15`).

## What it means

`judge.dlq` is judge-arena's dead-letter queue. Exactly two things write to it, both in the worker
(`src/worker/judgment-consumer.ts`): a judgment whose attempt budget (`MAX_ATTEMPTS = 3`,
`src/lib/queue/attempts.ts`) ran out on a retryable provider error, and a judgment whose provider call
succeeded but whose result could not be persisted after three local retries. **Nothing consumes it by
design** — it is a parked store, not a retry loop — so depth 0 is the normal state and any depth is a
judgment somebody has to decide about.

## The trap: do not peek

`judge.dlq` is a quorum queue with RabbitMQ 4.x's default `delivery_limit` of **20** and no dead-letter
exchange of its own. A management-UI "Get messages", `rabbitmqadmin get`, or any `basic.get` that ends
in a requeue increments the message's delivery count; at 20 the broker **drops it silently**. Ten
harmless-looking peeks erase the queue. Read the depth; never fetch.

```sh
# Depth, read-only (no delivery consumed):
kubectl -n tenant-public exec rabbitmq-judge-arena-server-0 -c rabbitmq -- \
  rabbitmqctl list_queues name type messages messages_ready messages_unacknowledged consumers
```

## What is in it (database-side, consumes nothing)

```sh
kubectl -n tenant-public exec deploy/judge-arena-web -- node /app/admin-dlq.js --list
```

Prints depth (via `checkQueue`), every `ModelJudgment` a DLQ writer could have left behind, classified:

| class | row shape | action |
|---|---|---|
| `max_attempts` | `error`, `attemptCount >= 3` | replayable — but read the sampling-drift line first |
| `persist_failed_candidate` | `running`, no error, lease expired | never replay through the provider; the reaper reclaims it |
| `stale` | `completed` after `>= 3` attempts | its envelopes are stale — drop them |

plus, per calibration, whether a replay today would run under the same `max_tokens` the run executed
under. A mixed-config calibration is not comparable (judge-arena runbook
`docs/runbooks/scoring-a-judge-against-a-golden-set.md` §8.8).

## What clears it

Both verbs are dry-runs without `--yes`. With `--yes` they consume, and ack an envelope only after the
committed transaction and the confirmed publish that replace it; everything else is requeued and the
tool prints how many deliveries that cost.

```sh
# Replay chosen judgments (or all max_attempts ones): row -> pending/attemptCount 0, run -> judging with
# an extended deadline, attempt 1 published to the judge's lane, envelope acked.
kubectl -n tenant-public exec deploy/judge-arena-web -- node /app/admin-dlq.js --replay=<judgmentId,...>|all --yes

# Drop envelopes whose judgment already completed (or no longer exists).
kubectl -n tenant-public exec deploy/judge-arena-web -- node /app/admin-dlq.js --drop-stale --yes
```

After a replayed calibration judgment completes: `node /app/calibration-run.js --score-only=<calibrationRunId>`
(the CLI prints the exact command).

**Precondition for `--replay` in production:** judge-arena `u3-hardcap-escapes-retry` must be promoted.
Without it one replayed delivery of a wedged judge runs the 900 s hard cap up to three times under a
930 s lease and re-creates the duplicate envelopes you are draining.

## The 10 present at ship time (2026-09-01)

Calibration run 1 (`cmtgib0xr00016k2r8nlyj1py`, 2026-08-31 01:20–01:44Z): 5 judgments × 2 envelopes
(attempt 3 and 4 — the pre-`414e826` lease/retry double execution). Four still `error`; one
(`cmtgib28w00696k2rrh64vmhp`) completed later, so its two envelopes are stale. Run 1 executed at
`max_tokens` 8192; the judge version is now at 12288. **Owner decision pending:** replay (mixed
config) or drop. Until it is made, this rule is correct and firing — hold at `info`, do not promote
(`docs/runbooks/audit-mode-promotion.md`, "clean is not sufficient — it must also be CLEAR").

## Promotion checklist

- [ ] The 10 are dispositioned; `--list` shows depth 0.
- [ ] `count_over_time(rabbitmq_detailed_queue_messages_ready{queue="judge.dlq"}[1h]) > 0` in vmselect
      (the series exists from the leader — the rule can fire).
- [ ] Quiet through `audit_mode_until`. Then `severity: warning`, drop the annotation.
```

- [ ] **Step 5: Run the check to verify it passes**

```bash
cd /root/homelab-setup && kubectl kustomize apps/public/judge-arena | grep -c 'JudgeArenaDlqBacklog'
cd /root/homelab-setup && bash tests/alerting/rules-syntax.sh
```
Expected: `1`; the syntax check passes (promtool is at /usr/local/bin/promtool). If `rules-syntax.sh` only walks `apps/managed/alerting/rules/`, additionally extract and check the rule directly:
`kubectl kustomize apps/public/judge-arena | yq 'select(.kind == "VMRule") | .spec' | promtool check rules /dev/stdin` — Expected: `SUCCESS: 1 rules found`.

Injection (the rule must depend on the leader-only aggregation): change `max by (queue) (` to `sum by (pod) (` and re-run the promtool check — it still passes syntactically, which is the FINDING that no static check pins the aggregation. That is why the runbook's promotion checklist carries the `count_over_time` query and the file header carries the leader-only evidence; record this in the PR body. Restore.

- [ ] **Step 6: Local preflights (they are NOT enforced on GitHub — memory note `homelab-preflights-not-enforced-on-github`)**

```bash
cd /root/homelab-setup && for s in scripts/preflight/*.sh; do echo "== $s"; bash "$s" || echo "FAILED: $s"; done
```
Expected: every script passes; in particular `rabbitmq-disk-watermark-check.sh` (it parses `size:` under `kind: RabbitMQ` — the header edits are comments and do not touch it) and `cluster-dns-suffix-check.sh` (nothing here names a `svc.cluster.local`).

- [ ] **Step 7: Branch and commit locally; hand the PR to the operator**

```bash
git -C /root/homelab-setup checkout -b feat/judge-arena-rabbitmq-scrape-dlq-alert main
git -C /root/homelab-setup add apps/public/judge-arena/vmservicescrape-rabbitmq.yaml apps/public/judge-arena/kustomization.yaml apps/public/judge-arena/rabbitmq.yaml docs/runbooks/judge-arena-dlq-backlog.md
git -C /root/homelab-setup commit -F - <<'EOF'
feat(judge-arena): scrape the broker and alert on judge.dlq depth (audit mode)

Nothing scraped rabbitmq-judge-arena and no rule anywhere mentioned it;
judge.dlq sat at 10 for two days with a hand-run rabbitmqctl as the only
signal. VMServiceScrape on the Service's `prometheus` port (15692), two
endpoints: /metrics (node-level, no queue label) and
/metrics/detailed?family=queue_coarse_metrics, the only family that emits
rabbitmq_detailed_queue_messages_ready{queue="judge.dlq"} — and only on
the quorum LEADER (verified: server-1 emits 10, server-0 emits nothing
for the queue). Hence `max by (queue)`; a sum or an unaggregated expr is
wrong after a leader move.

JudgeArenaDlqBacklog ships at severity info with audit_mode_until
2026-09-15 and is FIRING ON DAY ONE, deliberately: the queue holds 10
envelopes (calibration run 1 residue, 5 judgments x 2). What clears it is
judge-arena's new /app/admin-dlq.js --replay / --drop-stale plus an
owner decision on the 10 (replay at max_tokens 12288 into a run that
executed at 8192, or drop). Per audit-mode-promotion.md row 3 — hold at
info, track the work, promote only once the queue is at 0.

rabbitmq.yaml's header listed five queues; the broker has 15 since v2j.
Corrected with a note rather than overwritten.

Preflights run LOCALLY (all pass); rules-syntax passes. A syntax check
cannot pin the leader-only aggregation — the runbook's promotion
checklist carries the count_over_time query that does.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_018ACKb44as67Hz9R3sxexc7
EOF
git -C /root/homelab-setup log --oneline -1
```

Do NOT push. Hand the operator these exact commands (GitHub `origin` is where merges happen; `gitea` runs the full preflight suite):

```bash
git -C /root/homelab-setup push -u origin feat/judge-arena-rabbitmq-scrape-dlq-alert
git -C /root/homelab-setup push gitea feat/judge-arena-rabbitmq-scrape-dlq-alert   # exercises the 10 preflights
cd /root/homelab-setup && gh pr create --base main --title 'feat(judge-arena): scrape the broker and alert on judge.dlq depth (audit mode)' --body-file - <<'EOF'
Scrape `rabbitmq-judge-arena:prometheus` (`/metrics` + `/metrics/detailed?family=queue_coarse_metrics`) and add `JudgeArenaDlqBacklog` at `severity: info`, `audit_mode_until: 2026-09-15`.

- `max by (queue)` because only the quorum leader emits the per-queue sample (verified live).
- Fires on day one by design: judge.dlq holds 10 run-1 envelopes; the clearing verb is judge-arena's `/app/admin-dlq.js` (`--replay` / `--drop-stale`), disposition is an owner decision. Hold at info until depth 0 (audit-mode-promotion.md row 3).
- rabbitmq.yaml header corrected (15 queues since v2j, not five) with a CORRECTION note.
- Runbook: `docs/runbooks/judge-arena-dlq-backlog.md`.
- Preflights run locally, all pass (GitHub runs only lab-cert-issuer). promtool passes; it cannot pin the aggregation — the runbook's `count_over_time` check does.

After merge, verify against the live objects, not the pipeline:
`kubectl -n tenant-public get vmservicescrape rabbitmq-judge-arena vmrule judge-arena-rabbitmq` → both `operational`;
`kubectl -n cozy-monitoring exec deploy/vmagent -c vmagent -- wget -qO- http://127.0.0.1:8429/api/v1/targets | grep -o '"scrapeUrl":"[^"]*15692[^"]*"'` → two URLs, `health":"up"`;
`count_over_time(rabbitmq_detailed_queue_messages_ready{queue="judge.dlq"}[1h]) > 0` in vmselect → one series, value 10.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
```

(`gh pr edit` is broken in this repo — memory note `homelab-gh-pr-edit-broken`; if the body needs a change use `gh api -X PATCH repos/TrijeetSethi/homelab/pulls/<N> -F body=@body.md` and re-read it.)

---

## Production sequence after the judge-arena commits are pushed by the operator (recorded here, not executed by this plan)

1. Push → CI builds `sha-<12>`; assert the image exists: `skopeo inspect --no-tags docker://harbor.cluster.asethi.com/homelab/judge-arena:sha-$(git -C /root/judge-arena rev-parse main | cut -c1-12)` (green CI is not an image — memory note).
2. Promote (helmrelease.yaml:195 + stable.yaml:78 + history entry; NO MIGRATION from this plan — `calibration-sampling-snapshot`'s v2k rides its own promote). `u3-hardcap-escapes-retry` MUST be in the promoted image before `--replay --yes` is ever run.
3. Verify the bundle shipped: `kubectl -n tenant-public exec deploy/judge-arena-web -- ls -l /app/admin-dlq.js`.
4. `--list` (consumes nothing). Expected: depth 10 / 0 consumers; 4 `max_attempts` + 1 `stale` from run 1; `SAMPLING DRIFT — the run executed under {"max_tokens":8192,…}; a replay today would run under {"max_tokens":12288,…}`.
5. Owner decides. Then ONE pass (`--replay=all --yes` or `--drop-stale --yes` — each pass costs one delivery on every envelope it leaves; the 10 already carry one), then `--list` again → depth 0 or the deliberate remainder, and the homelab alert clears or is held per its annotation.

## Self-review

1. **Spec coverage.** Binding decisions (1) CLI files, entry with `closeRabbit`, sixth Dockerfile block, `parseDlqArgs`/`runDlq` with injected deps → Task 2. (2) DB-side `--list`, three classes, drift, `checkQueue` depth → Task 2. (3) `--replay`/`--drop-stale`, dry-run, `get noAck:false`, ack after publish+tx, one `$transaction` with the two updates, prior attemptCount logged, lane via `resolveEndpointsForPairs → resolveDestinationQueue → publishJudgmentExecute` attempt 1, null guard → Task 3 (+ `resolveReplayLane` in Task 2). (4) `batchDeadlineMs` in run-launch.ts, all three sites call it → Task 1. (5) no `/health` `queues` block → nothing touches health.ts (verified by the files lists). (6) no import of reaper/run-finalizer → dlq.ts imports listed and grep-checked in Task 2 Step 4. (7) tests: classification of three shapes; dry-run publishes/acks nothing; `--replay --yes` one id: tx updates, lane, attempt 1, ack after publish; publish failure → no ack; `--drop-stale` acks only stale; `batchDeadlineMs` unit test; existing timeout-policy and calibration-link tests stay green → Tasks 1-3. (8) homelab scrape + audit VMRule with `max by (queue)`, kustomization, audit-mode/CLAUDE.md citations → Task 5. (9) every listed doc range: topology.ts:1-17 (T4), README :281-288/:349-353 (T4), CONTRIBUTING :1240-1246 (T4), runbook :365 (T3), handoff :312-313 (T3), register :444-446 (T3), homelab rabbitmq.yaml :11-18 (T5); owner decision recorded in the header, the handoff note, the runbook and the VMRule annotation.
2. **Placeholder scan.** No TBD/TODO/"implement later"; Task 2's two stubs are explicit "not implemented yet" bodies replaced in Task 3, and the plan says so. Every code block is complete against the current tree (`satisfies Prisma.ModelJudgmentSelect`, `Pick<PrismaClient,…>`, amqplib `GetMessage`/`checkQueue`/`get` shapes verified in `node_modules/@types/amqplib`).
3. **Type consistency.** `batchDeadlineMs(count, nowMs?, hardCapMs?)` — Task 1 defines, Task 3 calls `batchDeadlineMs(targets.length, ctx.nowMs)` and the test calls `batchDeadlineMs(1, NOW.getTime())`. `DlqDeps.resolveLane(triggeredById: string | null, judgeModelVersionId: string | null)` — matches `resolveReplayLane`'s signature and `DlqJudgmentRow.run.triggeredById`/`judgeModelVersionId` (both nullable in schema.prisma). `DlqChannel.checkQueue` returns `{ messageCount; consumerCount }` and the fake returns exactly that. `runDlq` returns `{ exitCode }` in every branch. `dropStale(args, ctx)` — Task 2 declared it `dropStale(ctx)`; Task 3 Step 3c updates the call in `runDlq` (the only caller). `MAX_ATTEMPTS` is imported from `@/lib/queue/attempts` in the consumer, the CLI and the test. `detectSamplingDrift`/`canonicalJson`/`effectiveSamplingParams` names and signatures copied from the sampling-snapshot plan's "Produces" blocks.
