# Finalizer: `error` → `needs_human` on a late completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `maybeFinalizeRun` re-finalize a run the reaper stamped `error` once a late judgment completion lands on it, so the run grain stops lying about a completed judgment (production run `a0983c08` is `error` while its judgment completed on attempt 6).

**Architecture:** `src/lib/run-finalizer.ts` guards its row-locked recompute with `ACTIVE_RUN_STATUSES = ['pending','judging']` and returns `null` for every other status, so `error` is sealed the moment the reaper's `forceFinalizeAbandonedRun` writes it. The fix treats `error` as *re-openable* — it is the reaper's give-up stamp, not a verdict — and lets the existing recompute run for it: `error → needs_human` iff nothing is `pending`/`running` and at least one judgment `completed`; `error → error` writes nothing (no `finalizedAt` re-stamp); `needs_human` and `completed` stay terminal. Every consumer success/failure path already calls `safeFinalizeRun` (judgment-consumer.ts:1115-1347), so no new hook is needed — only the guard changes. Nothing else in the tree treats `error` as a lock: the reaper's overdue sweep selects `pending`/`judging` only (reaper.ts:304), and the leaderboard's `FINALIZED_RUN_STATUSES` (leaderboard/route.ts:46) simply starts counting a run once it becomes `needs_human`.

**Tech Stack:** TypeScript, Prisma (`$transaction` + `$queryRaw ... FOR UPDATE`), vitest integration suite (`vitest.integration.config.ts`, needs the local podman Postgres/Redis/RabbitMQ).

**Spec:** handoff `docs/superpowers/plans/2026-09-01-scoreboard-handoff.md` (§7 has no entry for this item — this plan adds a "Closed since" line there); register `docs/superpowers/plans/2026-08-30-state-and-next-steps.md` §5.5/5 (:408-410) and §7.2 (:602-606); verified map `/tmp/ja-plan-inputs/product-health-facts.json`; critique `/tmp/ja-plan-inputs/critique.json` q1 U2, q3 (`src/lib/run-finalizer.ts` — "U2 before #5 so replay does not need its own run-status logic").

**Priority / wave:** Wave 3 / #9 (XS-S).

**Depends on:** none. Must land BEFORE `dlq-admin-cli` (#5): with this in place, a DLQ replay only resets the judgment and extends `deadlineAt`; without it the replay CLI has to hand-set the run back to `judging`.

**Owner decisions needed:** none for the code. One open (not blocking): whether to run a one-off `UPDATE` on production for the historical row `a0983c08-4548-4663-a40d-0cd56b82f765` (see "Decisions" at the end). This plan does NOT backfill; the fix is forward-only.

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

## Plan-specific facts (verified against HEAD fc9e936 on 2026-09-01)

- `src/lib/run-finalizer.ts` is 191 lines. The guard is `:75` (`ACTIVE_RUN_STATUSES`) and `:115-120`; the recompute is `:122-136`; the write is `:138-142`. Module doc `:16-24`, the constant's comment `:72-74` and `maybeFinalizeRun`'s own JSDoc `:101-106` (its `null` clause says "already terminal (guard)") all state or imply that `error` is terminal — all three become wrong and are rewritten in Task 1.
- There is NO unit test for the finalizer (`ls tests/lib | grep -i final` is empty; the only DIRECT importers of `@/lib/run-finalizer` under `tests/` are `tests/integration/finalization.test.ts:9` and a comment in `tests/integration/worker-claims.test.ts:590`). The integration file is the seam. Do NOT add a unit test — and not for a denominator reason: `run-finalizer.ts` is ALREADY in the unit-coverage denominator, loaded transitively by `tests/lib/judgment-consumer-escalation.test.ts`, `tests/lib/pairwise-execution.test.ts` and `tests/lib/llm-truncation.test.ts` (each imports `@/worker/judgment-consumer`, which imports the finalizer unmocked; `@/lib/realtime/events` is mocked there, so the realtime glob is already handled by that mock pattern). `coverage/lcov.info` on HEAD (2026-09-01 21:21) for the file: `FNF:3 FNH:0 LF:80 LH:5 BRF:0 BRH:0` — its functions never execute in the unit run. A unit test would therefore have to fake `prisma.$transaction` and the `FOR UPDATE` read and would test the mock, not the contract; `maybeFinalizeRun` is a row-locked transaction that is only meaningful against a live Postgres. Coverage effect of Task 1's edit on the unit run: ~8 never-executed lines added (aggregate lines 3847/8119 = 47.38% → ~47.34%, floor 43) and 0 branches (v8 emits no branch records for functions that never execute). Unit count stays 869.
- `tests/integration/finalization.test.ts` has 12 tests today (verified by running it: `12 passed`, 2.19 s). Its `mkEvaluationRun` (`:193-208`) accepts `status`/`deadlineAt`/`finalizedAt` overrides and `mkJudgment` (`:239-259`) accepts `status`/`overallScore`/`attemptCount`/`updatedAt` — everything the new tests need already exists in the file. The `describe('maybeFinalizeRun ...')` block closes at `:388`; `describe('markRunCompleted ...')` opens at `:390`.
- **The db suite and the integration suite share `judge_arena_test`, and other sessions on this box run them too.** Re-verifying the file on 2026-09-01 21:14Z gave `10 failed | 2 passed` on an UNMODIFIED tree because a different session's `npm run test:db:coverage` (`vitest.db.config.ts`, whose `beforeEach` truncates every table) was mid-run against the same database. Rows vanished under the integration tests; nothing was wrong with the code. Before EVERY integration run in this plan, run `ps -eo comm,args | awk '$1=="node" && /vitest/'` and wait until it prints nothing. The filter keys on `comm==node` because the vitest runner and its forked workers are node processes, while the shell wrapper that runs your own command is `bash`/`sh` — a `grep "[v]itest"` over `ps aux` (the bracket trick, handoff trap 6) matches your own wrapper whenever the vitest invocation is in the same tool call (the Bash tool runs `/bin/bash -c "<entire command>"`, so that shell's argv contains the literal `vitest` from the next line), and would never print nothing — verified 2026-09-01 on this box with no vitest running: the bracket-grep printed two `/bin/bash -c ...` rows, the `comm`-based filter printed 0. A failing integration run while another vitest process exists is not evidence of anything.
- Callers of `maybeFinalizeRun`: `src/worker/judgment-consumer.ts:844-852` (`safeFinalizeRun`, 9 call sites `:1115-1347`) and `src/worker/reaper.ts:247` (`forceFinalizeAbandonedRun`, `:241-254`). The reaper's overdue sweep (`:301-322`) queries `status: { in: ['pending', 'judging'] }` — an `error` run is never re-swept, so the ONLY thing that can revisit it is a consumer finishing a judgment on it. That is exactly the case this plan handles.
- Writers of `error` at run grain: the reaper's `forceFinalizeAbandonedRun` (via `maybeFinalizeRun` itself, `:136` — zero completed judgments) AND `src/lib/run-launch.ts:646-649`, the compensating `updateMany` after a failed publish (guarded to `pending`/`judging`, stamps `finalizedAt`). The new rule holds for both without special-casing, and it is WANTED for the second: `run-launch.ts:613-629` stops publishing on the first failure (`break`), so on a multi-judge run every judgment before the failing one was already confirmed-published, and `:633-645` documents the in-doubt publish (the broker durably had the message although `publish()` threw). Earlier/in-doubt judgments CAN therefore complete on a run-launch-stamped run; the new rule moves it to `needs_human` only when nothing is pending/running, which is the honest state. (Unpublished siblings stay `pending`, so a partially-published run stays `error` under this rule — see Open questions.) The doc edits in Task 1 name both writers so the next reader does not find the second one and doubt the analysis.
- Local services are up: `podman ps` shows `judge-arena-pg`, `judge-arena-redis`, `judge-arena-rabbitmq` (all `Up 2 days`). `.env.test:1` → `localhost:5432/judge_arena_test`.
- Doc surfaces that state the defect as live (all get a dated closure note in Task 2; none is *wrong*, so these are closure notes, not CORRECTIONs): register `:408-410` and `:602-606`; handoff §7 (no entry — add "Closed since"); runbook `docs/runbooks/scoring-a-judge-against-a-golden-set.md:454-459` (§8.5); `README.md:492-497`; spec `docs/superpowers/specs/2026-08-31-calibration-baseline-and-footprint.md:167-171`. Each of these line ranges is owned by THIS plan (critique q3: assign each doc range to exactly one item); U7's docs bundle must not touch them.
- Commit shape to copy: `60be6f6` (`fix(worker): ...`, narrative body, `Gates:` line, trailers).

---

### Task 1: Re-open `error` in `maybeFinalizeRun` (tests, implementation, injection)

**Files:**
- Modify: `/root/judge-arena/src/lib/run-finalizer.ts:16-24` (module doc), `:72-75` (constant + comment), `:103-105` (`maybeFinalizeRun` JSDoc `null` clause), `:115-145` (guard + recompute + write, replaced as one block)
- Modify: `/root/judge-arena/src/worker/reaper.ts:56-59` (header: the stamp is not a seal)
- Test: `/root/judge-arena/tests/integration/finalization.test.ts` (insert a new `describe` between `:388` and `:390`)

**Interfaces:**
- Consumes: `maybeFinalizeRun(runId: string): Promise<RunStatus | null>` (run-finalizer.ts:107, unchanged signature); fixture helpers `createBaseFixture()`, `mkEvaluation()`, `mkEvaluationRun()`, `mkJudgment()` from finalization.test.ts:146-277.
- Produces: the new behaviour contract that `dlq-admin-cli` (#5) relies on — after a replayed judgment completes on an `error` run, `maybeFinalizeRun(runId)` returns `'needs_human'` and persists it; an `error` run with zero completed judgments returns `null` with `finalizedAt` untouched. No new exports. `ACTIVE_RUN_STATUSES` stays `['pending','judging']`; a new module-private `REOPENABLE_RUN_STATUSES: RunStatus[] = ['error']` is added.

- [ ] **Step 1: Write the failing tests**

Open `/root/judge-arena/tests/integration/finalization.test.ts`. Find the end of the first `describe` block — these exact lines (currently `:384-390`):

```ts
    const persisted = await prisma.evaluationRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(persisted.status).toBe('needs_human');
    expect(persisted.finalizedAt?.getTime()).toBe(finalizedAt.getTime()); // untouched, not re-stamped
  });
});

describe('markRunCompleted (src/lib/run-finalizer.ts)', () => {
```

Replace them with (the original seven lines, plus the new block in between):

```ts
    const persisted = await prisma.evaluationRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(persisted.status).toBe('needs_human');
    expect(persisted.finalizedAt?.getTime()).toBe(finalizedAt.getTime()); // untouched, not re-stamped
  });
});

describe('maybeFinalizeRun (src/lib/run-finalizer.ts): error is the reaper\'s stamp, not a verdict', () => {
  // Production shape (2026-08-30 register §7.2): the reaper force-finalized
  // run a0983c08 to `error`; its one judgment then completed on attempt 6
  // and every consumer success path called safeFinalizeRun — but the guard
  // treated `error` as terminal, so the run grain never reflected it.
  // `error` is the reaper's give-up stamp, not a verdict, so it is
  // re-openable. `needs_human` and `completed` are verdicts and stay sealed.

  it('a run stamped error whose judgment later completed (nothing pending/running) is re-finalized to needs_human', async () => {
    const base = await createBaseFixture();
    const evaluation = await mkEvaluation(base.project.id, base.user.id);
    const reaperStamp = new Date('2026-01-01T00:00:00.000Z');
    const run = await mkEvaluationRun(evaluation.id, base.user.id, base.rubric.id, {
      status: 'error',
      finalizedAt: reaperStamp,
    });
    await mkJudgment(run.id, base.version.id, base.promptTemplateId, {
      status: 'completed',
      overallScore: 7,
      attemptCount: 6,
    });

    const result = await maybeFinalizeRun(run.id);
    expect(result).toBe('needs_human');

    const persisted = await prisma.evaluationRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(persisted.status).toBe('needs_human');
    // Re-stamped: the run's verdict changed, so finalizedAt is the moment it
    // left `error`, not the moment the reaper gave up on it.
    expect(persisted.finalizedAt?.getTime()).toBeGreaterThan(reaperStamp.getTime());
  });

  it('a run stamped error with zero completed judgments stays error — returns null, finalizedAt untouched', async () => {
    const base = await createBaseFixture();
    const evaluation = await mkEvaluation(base.project.id, base.user.id);
    const reaperStamp = new Date('2026-01-01T00:00:00.000Z');
    const run = await mkEvaluationRun(evaluation.id, base.user.id, base.rubric.id, {
      status: 'error',
      finalizedAt: reaperStamp,
    });
    await mkJudgment(run.id, base.version.id, base.promptTemplateId, { status: 'error' });

    const result = await maybeFinalizeRun(run.id);
    expect(result).toBeNull();

    const persisted = await prisma.evaluationRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(persisted.status).toBe('error');
    expect(persisted.finalizedAt?.getTime()).toBe(reaperStamp.getTime()); // the reaper's stamp survives
  });

  it('a run stamped error with a completed judgment AND one still pending is not re-finalized yet (returns null)', async () => {
    const base = await createBaseFixture();
    const evaluation = await mkEvaluation(base.project.id, base.user.id);
    const run = await mkEvaluationRun(evaluation.id, base.user.id, base.rubric.id, { status: 'error' });
    await mkJudgment(run.id, base.version.id, base.promptTemplateId, { status: 'completed', overallScore: 7 });
    const { version: version2 } = await mkJudgeModelVersion();
    // The reaper's stale-reclaim path resets a running judgment to pending
    // and republishes it — this is the in-between state on an error run.
    await mkJudgment(run.id, version2.id, base.promptTemplateId, { status: 'pending' });

    const result = await maybeFinalizeRun(run.id);
    expect(result).toBeNull();

    const persisted = await prisma.evaluationRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(persisted.status).toBe('error');
  });

  it('a completed run is never touched, even with a completed judgment and nothing in flight', async () => {
    const base = await createBaseFixture();
    const evaluation = await mkEvaluation(base.project.id, base.user.id);
    const finalizedAt = new Date('2026-01-01T00:00:00.000Z');
    const run = await mkEvaluationRun(evaluation.id, base.user.id, base.rubric.id, {
      status: 'completed',
      finalizedAt,
    });
    await mkJudgment(run.id, base.version.id, base.promptTemplateId, { status: 'completed', overallScore: 7 });

    const result = await maybeFinalizeRun(run.id);
    expect(result).toBeNull();

    const persisted = await prisma.evaluationRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(persisted.status).toBe('completed');
    expect(persisted.finalizedAt?.getTime()).toBe(finalizedAt.getTime()); // untouched
  });
});

describe('markRunCompleted (src/lib/run-finalizer.ts)', () => {
```

`mkJudgeModelVersion` is already defined at `:210-233` and used the same way at `:320` and `:347`.

- [ ] **Step 2: Run the file to verify exactly one test fails**

Run (the first line must print nothing — see "Plan-specific facts": another session's db/integration run on the shared test database makes this file fail for reasons unrelated to the code):

```bash
ps -eo comm,args | awk '$1=="node" && /vitest/'
(cd /root/judge-arena && sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.integration.config.ts tests/integration/finalization.test.ts 2>&1 | tail -40')
```

Expected: `Tests  1 failed | 15 passed (16)`. The failing test is `a run stamped error whose judgment later completed ...` with

```
AssertionError: expected null to be 'needs_human' // Object.is equality
```

The other three new tests are green BEFORE the implementation — that is expected and correct: they pin what must NOT change (an `error` run with nothing completed, a still-in-flight judgment, a `completed` run). Their discriminating power is proven by their own injections in Step 5, not by Step 2.

- [ ] **Step 3: Write the implementation**

Open `/root/judge-arena/src/lib/run-finalizer.ts`.

Edit 1 — module doc. Replace `:16-24`:

```ts
 *   2. Guard: if the row's status is already terminal (not `pending` or
 *      `judging`), return `null` — this is what makes the dual-completion
 *      race safe. Two judgments finishing at nearly the same instant both
 *      call `maybeFinalizeRun(runId)`; both transactions queue on the row
 *      lock; whichever acquires it first sees `judging`/`pending`, recomputes,
 *      and (if nothing remains pending/running) transitions the row off
 *      pending/judging and commits. The second then acquires the lock,
 *      re-reads the row (now terminal), and the guard above returns `null`
 *      — it never re-transitions an already-finalized run.
```

with:

```ts
 *   2. Guard: if the row's status is a VERDICT (`needs_human` or
 *      `completed`), return `null` — this is what makes the dual-completion
 *      race safe. Two judgments finishing at nearly the same instant both
 *      call `maybeFinalizeRun(runId)`; both transactions queue on the row
 *      lock; whichever acquires it first sees `judging`/`pending`, recomputes,
 *      and (if nothing remains pending/running) transitions the row off
 *      pending/judging and commits. The second then acquires the lock,
 *      re-reads the row (now a verdict), and the guard above returns `null`
 *      — it never re-transitions an already-finalized run.
 *
 *      `error` is NOT a verdict and is NOT sealed by this guard (2026-09-01,
 *      register §5.5/5). It is a give-up stamp — the reaper's, mainly:
 *      `forceFinalizeAbandonedRun` (src/worker/reaper.ts) marks stranded
 *      `pending` judgments `error` and finalizes the run, while the reaper's
 *      stale-reclaim path can still republish a judgment on that same run
 *      for another attempt. (run-launch.ts's compensating update after a
 *      failed publish writes `error` too; the same rule below covers it.)
 *      When that late attempt completes, the consumer calls
 *      `maybeFinalizeRun` again — and a guard that treated `error` as
 *      terminal left the run stamped `error` over a completed judgment
 *      (production run a0983c08, completed on attempt 6, never reflected).
 *      So an `error` run is recomputed exactly like an active one:
 *        - it becomes `needs_human` iff nothing is pending/running and at
 *          least one judgment completed (`finalizedAt` is re-stamped: the
 *          verdict changed);
 *        - if the recompute still says `error`, NOTHING is written — the
 *          reaper's stamp and its `finalizedAt` survive, and the call
 *          returns `null` like any other no-op.
 *      Nothing ever reopens `needs_human` or `completed`.
```

Edit 2 — the constant and its comment. Replace `:72-75`:

```ts
/** Statuses `maybeFinalizeRun` is willing to transition OUT of. Anything
 * else (`needs_human`, `completed`, `error`) is already terminal from the
 * finalizer's point of view — see the guard in the transaction below. */
const ACTIVE_RUN_STATUSES: RunStatus[] = ['pending', 'judging'];
```

with:

```ts
/** Statuses `maybeFinalizeRun` transitions OUT of on any recompute. */
const ACTIVE_RUN_STATUSES: RunStatus[] = ['pending', 'judging'];

/** Statuses that are a STAMP rather than a verdict and may therefore be
 * revisited: `error` is written by the reaper when it gives up on an overdue
 * run, and a judgment on that run can still complete afterwards. The
 * recompute is allowed, but only an improvement (`-> needs_human`) is ever
 * written — see module doc item 2. `run-launch.ts`'s compensating update
 * after a failed publish also writes `error`, and the same rule is WANTED
 * there: its publish loop stops on the first failure, so earlier judgments
 * may already be with the broker, and an in-doubt publish (see
 * run-launch.ts's own comment on the guarded updateMany) may have been
 * delivered too. If one of those later completes with nothing left
 * pending/running, the run moves to `needs_human` instead of staying
 * stamped `error` over a real result. (Unpublished siblings stay `pending`,
 * so a partially-published run stays `error` — out of scope here.)
 * `needs_human` and `completed` are verdicts and are in NEITHER list: the
 * guard below seals them. */
const REOPENABLE_RUN_STATUSES: RunStatus[] = ['error'];
```

Edit 3 — the guard and the write. Replace `:115-145` (from `if (!ACTIVE_RUN_STATUSES.includes(run.status)) {` through `return result;`):

```ts
    if (!ACTIVE_RUN_STATUSES.includes(run.status)) {
      // Already finalized (or errored) by this call or a concurrent one
      // that won the row lock first — this is the dual-completion race
      // guard. Nothing to do.
      return null;
    }

    const counts = await tx.modelJudgment.groupBy({
      by: ['status'],
      where: { runId },
      _count: { _all: true },
    });
    const countOf = (status: JudgmentStatus): number =>
      counts.find((c) => c.status === status)?._count._all ?? 0;

    const stillActive = countOf('pending') + countOf('running');
    if (stillActive > 0) {
      // Not yet finalizable — some other judgment is still in flight.
      return null;
    }

    const newStatus: RunStatus = countOf('completed') > 0 ? 'needs_human' : 'error';

    const updated = await tx.evaluationRun.update({
      where: { id: runId },
      data: { status: newStatus, finalizedAt: new Date() },
      select: { evaluationId: true },
    });

    const result: FinalizeCommitResult = { newStatus, evaluationId: updated.evaluationId };
    return result;
```

with:

```ts
    const reopening = REOPENABLE_RUN_STATUSES.includes(run.status);
    if (!ACTIVE_RUN_STATUSES.includes(run.status) && !reopening) {
      // A verdict (`needs_human`/`completed`) written by this call or a
      // concurrent one that won the row lock first — this is the
      // dual-completion race guard. Nothing to do.
      return null;
    }

    const counts = await tx.modelJudgment.groupBy({
      by: ['status'],
      where: { runId },
      _count: { _all: true },
    });
    const countOf = (status: JudgmentStatus): number =>
      counts.find((c) => c.status === status)?._count._all ?? 0;

    const stillActive = countOf('pending') + countOf('running');
    if (stillActive > 0) {
      // Not yet finalizable — some other judgment is still in flight.
      return null;
    }

    const newStatus: RunStatus = countOf('completed') > 0 ? 'needs_human' : 'error';

    if (reopening && newStatus === run.status) {
      // Revisiting the reaper's `error` stamp and the recompute agrees with
      // it: nothing changed, so write nothing — in particular do not
      // re-stamp `finalizedAt`, which records when the reaper gave up.
      return null;
    }

    const updated = await tx.evaluationRun.update({
      where: { id: runId },
      data: { status: newStatus, finalizedAt: new Date() },
      select: { evaluationId: true },
    });

    const result: FinalizeCommitResult = { newStatus, evaluationId: updated.evaluationId };
    return result;
```

Edit 4 — `/root/judge-arena/src/worker/reaper.ts`. Replace `:56-59`:

```ts
 *     in-flight provider call, not yet stale per (a)'s own lease check),
 *     `maybeFinalizeRun` correctly no-ops for now — this run gets another
 *     chance on a later sweep, once those either complete or go stale
 *     themselves.
```

with:

```ts
 *     in-flight provider call, not yet stale per (a)'s own lease check),
 *     `maybeFinalizeRun` correctly no-ops for now — this run gets another
 *     chance on a later sweep, once those either complete or go stale
 *     themselves.
 *     A run that DID get stamped `error` here is not sealed by it: `error`
 *     is this reaper's give-up stamp, not a verdict, and `maybeFinalizeRun`
 *     moves it to `needs_human` if a judgment on it later completes (a
 *     reclaimed-and-republished attempt landing after the deadline). This
 *     sweep never re-selects such a run (it queries pending/judging only);
 *     the consumer's own post-completion finalize call is what revisits it.
 *     See the `error` paragraph in run-finalizer.ts's module doc.
```

Edit 5 — back in `/root/judge-arena/src/lib/run-finalizer.ts`, the `maybeFinalizeRun` JSDoc. Its `null` clause is the last sentence in the file that still calls `error` terminal by implication. Replace `:103-105` (line numbers as of HEAD, before Edits 1-2 — match on text):

```ts
 * See module doc for the full protocol. Returns the new status once this
 * call actually performed the transition, or `null` if the run was already
 * terminal (guard) or still has pending/running judgments.
```

with:

```ts
 * See module doc for the full protocol. Returns the new status once this
 * call actually performed the transition, or `null` if the run is a verdict
 * (`needs_human`/`completed` — the guard), still has pending/running
 * judgments, or is an `error` run whose recompute still says `error`
 * (nothing written — see module doc item 2).
```

- [ ] **Step 4: Run the file to verify all 16 pass**

Run (first line must print nothing):

```bash
ps -eo comm,args | awk '$1=="node" && /vitest/'
(cd /root/judge-arena && sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.integration.config.ts tests/integration/finalization.test.ts 2>&1 | tail -25')
```

Expected: `Test Files  1 passed (1)` / `Tests  16 passed (16)`. The 12 pre-existing tests are unaffected — in particular `:372-387` (a `needs_human` run is a guarded no-op; unchanged position, it sits above the insertion) and the reaper test `an overdue run past the force-finalize grace period marks stranded pending judgments error and finalizes the run` (HEAD `:569-606`, ~`:655-692` after Step 1's 86 inserted lines).

- [ ] **Step 5: Injection — one per new test, each must go RED on its own**

Run the same command after each edit; restore the original line before the next injection. Use `-t` to run only the new block (first line must print nothing, as in Steps 2 and 4):

```bash
ps -eo comm,args | awk '$1=="node" && /vitest/'
(cd /root/judge-arena && sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.integration.config.ts tests/integration/finalization.test.ts -t "reaper.s stamp" 2>&1 | tail -25')
```

(The `12 skipped` in every summary below is the 12 pre-existing tests outside the `-t` filter — vitest 3.2.4 reports filtered-out tests as skipped; expected, not a problem.)

  - **5a — revert the guard** (the shipped defect's signature). In `run-finalizer.ts` change
    `if (!ACTIVE_RUN_STATUSES.includes(run.status) && !reopening) {` to
    `if (!ACTIVE_RUN_STATUSES.includes(run.status)) {`.
    Expected: `Tests  1 failed | 3 passed | 12 skipped (16)` — `... is re-finalized to needs_human` fails with `expected null to be 'needs_human'`. Restore.
  - **5b — remove the no-write branch.** Delete the six-line block from `if (reopening && newStatus === run.status) {` through its closing `}` (the `if` line, the three comment lines, `return null;`, `}`).
    Expected: `Tests  1 failed | 3 passed | 12 skipped (16)` — `... stays error — returns null, finalizedAt untouched` fails with `expected 'error' to be null`. Restore.
  - **5c — ignore in-flight judgments when reopening.** Change
    `const stillActive = countOf('pending') + countOf('running');` to
    `const stillActive = reopening ? 0 : countOf('pending') + countOf('running');`.
    Expected: `Tests  1 failed | 3 passed | 12 skipped (16)` — `... AND one still pending is not re-finalized yet` fails with `expected 'needs_human' to be null`. Restore.
  - **5d — reopen a verdict.** Change `const REOPENABLE_RUN_STATUSES: RunStatus[] = ['error'];` to `const REOPENABLE_RUN_STATUSES: RunStatus[] = ['error', 'completed'];`.
    Expected: `Tests  1 failed | 3 passed | 12 skipped (16)` — `a completed run is never touched ...` fails with `expected 'needs_human' to be null`. Restore.
  - **5e — keep the reaper's stamp on reopen** (the binding `finalizedAt` re-stamp decision). In `run-finalizer.ts` change
    `data: { status: newStatus, finalizedAt: new Date() },` to
    `data: { status: newStatus, ...(reopening ? {} : { finalizedAt: new Date() }) },`.
    Expected: `Tests  1 failed | 3 passed | 12 skipped (16)` — `... is re-finalized to needs_human` fails on its second assertion with `expected 1767225600000 to be greater than 1767225600000` (the reaper's 2026-01-01 stamp survived). Restore.

After restoring, confirm `git -C /root/judge-arena diff --stat` shows exactly `src/lib/run-finalizer.ts`, `src/worker/reaper.ts`, `tests/integration/finalization.test.ts`, and re-run Step 4 (16 passed). If any injection leaves the block green, STOP: that is a finding (CONTRIBUTING.md:210-234), not a formality — work out which of the test or the code is decoration before continuing.

- [ ] **Step 6: Fast gates for this task**

```bash
(cd /root/judge-arena && npm run lint)          # 0 problems, 0 warnings
(cd /root/judge-arena && npx tsc --noEmit)      # no output
```

Expected: both clean. (The full gate ladder including the DB reset and `build` runs once, in Task 2 Step 3, immediately before the single commit.)

- [ ] **Step 7: Stage, do not commit**

```bash
git -C /root/judge-arena add src/lib/run-finalizer.ts src/worker/reaper.ts tests/integration/finalization.test.ts
git -C /root/judge-arena status --short
```

Expected: three `M ` entries staged. The only other lines are `??` entries for the untracked sibling plan files under `docs/superpowers/plans/2026-09-01-*.md` (this plan and the other wave plans are not committed yet; the count varies as other wave plans are written — the tree is otherwise clean); leave those alone. This item ships as ONE `fix(worker)` commit (binding decision); the docs that this change makes true are folded into that commit in Task 2, so the commit itself happens there. Task 2 is the second half of this same task and MUST run in the same worktree immediately after; do not dispatch anything else in between.

---

### Task 2: Closure notes in the docs, full gates, the single commit

**Files:**
- Modify: `/root/judge-arena/docs/superpowers/plans/2026-08-30-state-and-next-steps.md:408-410` (§5.5/5) and `:602-606` (§7.2)
- Modify: `/root/judge-arena/docs/superpowers/plans/2026-09-01-scoreboard-handoff.md:327-332` (§7 → add "Closed since")
- Modify: `/root/judge-arena/docs/runbooks/scoring-a-judge-against-a-golden-set.md:454-459` (§8.5; `:454` is the heading, the note is appended after the paragraph at `:456-459`)
- Modify: `/root/judge-arena/README.md:492-497`
- Modify: `/root/judge-arena/docs/superpowers/specs/2026-08-31-calibration-baseline-and-footprint.md:167-171` (§2.3 paragraph; the note is appended to its last two lines, `:170-171`)
- Test: none (docs); the gate ladder is the verification

**Interfaces:**
- Consumes: the Task 1 behaviour (`error → needs_human` on a late completion; `error → error` writes nothing).
- Produces: the commit `fix(worker): a late completion re-finalizes a run the reaper stamped error`.

Every note below is a *closure* note, not a CORRECTION: each sentence it annotates was true when written and describes a defect that is now fixed. All notes say the same two things — (1) the guard now reopens `error`, (2) the fix is forward-only, so the historical production row is still `error` and "count judgments, not runs" remains the right instruction for any run finalized before this ships.

- [ ] **Step 1: Register §5.5/5 and §7.2**

In `/root/judge-arena/docs/superpowers/plans/2026-08-30-state-and-next-steps.md` replace `:408-410`:

```markdown
5. **Run-grain `status` can be stale.** Five `EvaluationRun` rows read `error` on run 1 while only
   four `ModelJudgment` rows did (§7.2). Scoring reads the judgment and is right; any ad-hoc SQL that
   counts runs will disagree by one. Small, and it will mislead someone.
```

with:

```markdown
5. **Run-grain `status` can be stale.** Five `EvaluationRun` rows read `error` on run 1 while only
   four `ModelJudgment` rows did (§7.2). Scoring reads the judgment and is right; any ad-hoc SQL that
   counts runs will disagree by one. Small, and it will mislead someone.
   > **Closed 2026-09-01** (`fix(worker)`, plan `2026-09-01-finalizer-error-to-needs-human.md`). The
   > cause was `maybeFinalizeRun`'s guard treating `error` as terminal: the reaper stamps `error` on an
   > overdue run, a reclaimed judgment on it completes later, the consumer's own finalize call runs,
   > and the guard returns `null`. `error` is now re-openable — it is the reaper's stamp, not a
   > verdict — and moves to `needs_human` once nothing is pending/running and one judgment completed.
   > **Forward-only.** Run `a0983c08` stays `error` in production (no backfill was run; whether to
   > `UPDATE` that one row is an owner decision), so "count judgments, not runs" still holds for
   > every run finalized before this shipped. Pinned by four tests in
   > `tests/integration/finalization.test.ts`.
```

Then replace `:602-606` (the paragraph will be at the same numbers plus 9 after the edit above — match on text, not on line numbers):

```markdown
**A discrepancy anyone re-querying this will hit.** Five `EvaluationRun` rows carry `status='error'`
but only **four** `ModelJudgment` rows do. Run `a0983c08-4548-4663-a40d-0cd56b82f765` is stamped
`error` at run grain while its judgment **completed** on attempt 6 (`verdict=B`,
`latencyMs=108646`). Scoring reads the *judgment*, so that item is inside the 26. **Count judgments,
not runs** — and the stale run-grain status is worth its own small work item.
```

with:

```markdown
**A discrepancy anyone re-querying this will hit.** Five `EvaluationRun` rows carry `status='error'`
but only **four** `ModelJudgment` rows do. Run `a0983c08-4548-4663-a40d-0cd56b82f765` is stamped
`error` at run grain while its judgment **completed** on attempt 6 (`verdict=B`,
`latencyMs=108646`). Scoring reads the *judgment*, so that item is inside the 26. **Count judgments,
not runs** — and the stale run-grain status is worth its own small work item.

> **Closed 2026-09-01** — the work item is §5.5/5; see the closure note there. The row above is
> still `error` in production (the fix is forward-only), so this discrepancy will keep reproducing
> on run 1 and the instruction stands for it.
```

- [ ] **Step 2: Handoff §7, runbook §8.5, README, 2026-08-31 spec**

In `/root/judge-arena/docs/superpowers/plans/2026-09-01-scoreboard-handoff.md` replace `:327-332`:

```markdown
11. **`parseMode` is NULL on pairwise.** One fence-tolerant parse path, so no strict→lenient
    demotion to record. Document as pointwise-only or give it a pairwise meaning.

---

## 8. Starting the next session
```

with:

```markdown
11. **`parseMode` is NULL on pairwise.** One fence-tolerant parse path, so no strict→lenient
    demotion to record. Document as pointwise-only or give it a pairwise meaning.

### Closed since

- **2026-09-01 — run-grain `status` stale after a late completion** (register §5.5/5, §7.2; not
  in the list above because it was filed on 2026-08-30). `maybeFinalizeRun` sealed `error`; it now
  reopens it to `needs_human` when a reclaimed judgment completes after the reaper gave up.
  Forward-only — run `a0983c08` stays `error` in production. Plan:
  [`2026-09-01-finalizer-error-to-needs-human.md`](./2026-09-01-finalizer-error-to-needs-human.md).

---

## 8. Starting the next session
```

In `/root/judge-arena/docs/runbooks/scoring-a-judge-against-a-golden-set.md` replace `:456-459`:

```markdown
On run 1, five `EvaluationRun` rows carried `status='error'` while only four `ModelJudgment` rows
did: one run stayed stamped `error` while its judgment completed on a later attempt. **Scoring reads
the judgment**, so that item was correctly inside the denominator. Any ad-hoc SQL you write to
double-check a calibration must do the same, or it will disagree with the report by one.
```

with:

```markdown
On run 1, five `EvaluationRun` rows carried `status='error'` while only four `ModelJudgment` rows
did: one run stayed stamped `error` while its judgment completed on a later attempt. **Scoring reads
the judgment**, so that item was correctly inside the denominator. Any ad-hoc SQL you write to
double-check a calibration must do the same, or it will disagree with the report by one.

> **Fixed 2026-09-01 for runs finalized from that image on**: `maybeFinalizeRun` now moves an
> `error` run to `needs_human` when a judgment on it completes later (it used to treat `error` as
> terminal). Historical rows — including run 1's — were not backfilled, so the rule above still
> applies to any calibration launched before the fix was promoted. Check the running image (§1 of
> the 2026-09-01 handoff) before assuming which side of the fix a run is on.
```

In `/root/judge-arena/README.md` replace `:492-497`:

```markdown
**One inconsistency worth knowing before you query this yourself.** Five `EvaluationRun` rows carry
`status = 'error'` while only **four** `ModelJudgment` rows do. Run
`a0983c08-4548-4663-a40d-0cd56b82f765` is stamped `error` at run grain, but its judgment
**completed** on attempt 6 with `verdict = B` and `latencyMs = 108646`. Scoring reads the *judgment*
status, so that item is inside the 26 — the run-grain status is what is stale. Count judgments, not
runs.
```

with:

```markdown
**One inconsistency worth knowing before you query this yourself.** Five `EvaluationRun` rows carry
`status = 'error'` while only **four** `ModelJudgment` rows do. Run
`a0983c08-4548-4663-a40d-0cd56b82f765` is stamped `error` at run grain, but its judgment
**completed** on attempt 6 with `verdict = B` and `latencyMs = 108646`. Scoring reads the *judgment*
status, so that item is inside the 26 — the run-grain status is what is stale. Count judgments, not
runs. *(Fixed forward from 2026-09-01: the finalizer now reopens an `error` run to `needs_human`
when a judgment on it completes later. This row was not backfilled, so the sentence above stays
true for run 1.)*
```

In `/root/judge-arena/docs/superpowers/specs/2026-08-31-calibration-baseline-and-footprint.md` replace `:170-171`:

```markdown
so that item is inside the 26. **Count judgments, not runs.** The stale run-grain status is a real
defect and is listed as an open follow-up in the plan.
```

with:

```markdown
so that item is inside the 26. **Count judgments, not runs.** The stale run-grain status is a real
defect and is listed as an open follow-up in the plan. *(Closed 2026-09-01, forward-only — see the
2026-08-30 plan §5.5/5; this row remains `error`.)*
```

Verify nothing else still describes the defect as open without a note:

```bash
grep -a -rn "a0983c08\|run-grain \`status\`\|Run-grain \`status\`" /root/judge-arena/docs /root/judge-arena/README.md | cut -c1-160
```

Expected: hits only in the five files edited above plus this plan file; no other file matches. (The 2026-08-10 roadmap and the two 2026-08-17 A2 docs under `docs/superpowers/specs/` also say "run-grain", but only about the unrelated `startedAt` gap — `run-grain \`startedAt\`` — and the pattern above deliberately does not match them; verified zero hits on HEAD.)

- [ ] **Step 3: Full gate ladder**

```bash
grep DATABASE_URL /root/judge-arena/.env.test
# MUST print localhost:5432/judge_arena_test on line 1. If it prints anything else, STOP.
ps -eo comm,args | awk '$1=="node" && /vitest/'
# MUST print nothing: test:db:coverage RESETS and truncates the same database test:integration
# reads, so a concurrent run from any session (yours or another) corrupts both. Run the ladder
# strictly serially, one command at a time, never two suites in parallel.
(cd /root/judge-arena && npm run lint)
(cd /root/judge-arena && npx tsc --noEmit)
(cd /root/judge-arena && npm run test:coverage 2>&1 | tail -40)
ps -eo comm,args | awk '$1=="node" && /vitest/'   # MUST print nothing (re-check: lint/tsc/unit took minutes, another session may have started since)
(cd /root/judge-arena && npm run test:db:coverage 2>&1 | tail -40)
ps -eo comm,args | awk '$1=="node" && /vitest/'   # MUST print nothing
(cd /root/judge-arena && npm run test:integration 2>&1 | tail -15)
(cd /root/judge-arena && npm run build 2>&1 | tail -15)
```

Expected: lint `0 problems`; tsc silent; unit `Tests  869 passed` across `55` files with every per-glob floor met (`run-finalizer.ts` is already in the unit denominator via the consumer imports — see Plan-specific facts bullet 2 — so the edit moves aggregate lines by ~0.04pp, 47.38 → ~47.34 against floor 43, and branches by 0; no per-glob floor moves because the file is not under any glob); db `670 passed`; integration `Tests  84 passed (84)` (80 + the 4 new); build exits 0. If unit or db counts differ from 869/670, something outside this plan moved — do not commit until you know what.

- [ ] **Step 4: Commit (the only commit for this item)**

The `Gates:` line follows the shared Global Constraints format (`... coverage 0.`, as `60be6f6` does); `build` ran in Step 3 and must have exited 0, it is just not recorded on the line.

```bash
git -C /root/judge-arena add \
  src/lib/run-finalizer.ts \
  src/worker/reaper.ts \
  tests/integration/finalization.test.ts \
  docs/superpowers/plans/2026-08-30-state-and-next-steps.md \
  docs/superpowers/plans/2026-09-01-scoreboard-handoff.md \
  docs/runbooks/scoring-a-judge-against-a-golden-set.md \
  README.md \
  docs/superpowers/specs/2026-08-31-calibration-baseline-and-footprint.md \
  docs/superpowers/plans/2026-09-01-finalizer-error-to-needs-human.md
git -C /root/judge-arena status --short   # eight `M ` + one `A ` (this plan file is untracked today, so it is ADDED, not modified); plus `??` for the sibling plans — do NOT add those
git -C /root/judge-arena commit -F - <<'EOF'
fix(worker): a late completion re-finalizes a run the reaper stamped error

`maybeFinalizeRun` guarded its recompute with ACTIVE_RUN_STATUSES =
['pending', 'judging'] and returned null for everything else, so the
moment the reaper's forceFinalizeAbandonedRun wrote `error` the run was
sealed. But `error` is the reaper's give-up stamp, not a verdict: the
same reaper reclaims a stale running judgment on that run and
republishes it, and when the late attempt completes the consumer calls
safeFinalizeRun as it always does — into a guard that refused it.

FOUND IN PRODUCTION on calibration run 1 (register 2026-08-30 §7.2):
EvaluationRun a0983c08 is `error` at run grain while its ModelJudgment
completed on attempt 6 (verdict B, 108,646 ms). Scoring reads the
judgment, so the score was right; every run-grain count was off by one.

The change is confined to the guard. `error` is now REOPENABLE: an
`error` run is recomputed under the same row lock as an active one and
moves to `needs_human` iff nothing is pending/running and at least one
judgment completed (finalizedAt re-stamped — the verdict changed). If
the recompute still says `error`, nothing is written: the reaper's
stamp and its finalizedAt survive, and the call returns null.
`needs_human` and `completed` are verdicts and remain sealed; the
dual-completion race guard is unchanged for them.

Nothing else treated `error` as a lock. The reaper's overdue sweep only
selects pending/judging, so it never re-touches an `error` run; the
consumer's own post-completion finalize call is the one path that
revisits it, and it already existed at all nine success/failure sites.

Forward-only. No backfill of a0983c08 — whether to UPDATE that one
production row is an owner decision, and until then "count judgments,
not runs" still holds for run 1. The register (§5.5/5, §7.2), handoff
§7, runbook §8.5, README and the 2026-08-31 spec carry dated closure
notes saying exactly that; none of their sentences was wrong.

Four integration tests pin it (tests/integration/finalization.test.ts):
error + completed → needs_human; error + zero completed → null,
finalizedAt untouched; error + completed + one pending → null;
completed → never touched. Each verified red by its own injection
(revert the guard; delete the no-write branch; zero stillActive when
reopening; add `completed` to the reopenable list; keep the reaper's
finalizedAt on reopen) and green again.
No unit test on purpose: maybeFinalizeRun is a row-locked $transaction
(SELECT ... FOR UPDATE), only meaningful against a live Postgres; a
unit test would have to fake the transaction and test the mock.

Unblocks the DLQ replay CLI: a replay now resets the judgment and
extends deadlineAt, and the finalizer does the rest.

Gates: lint 0, tsc 0, 869 unit / 670 db / 84 integration, coverage 0.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_018ACKb44as67Hz9R3sxexc7
EOF
git -C /root/judge-arena log --oneline -1
git -C /root/judge-arena status --short   # only `??` lines for the other 2026-09-01-*.md plan files; no `M`, no `A`
git -C /root/judge-arena show --stat --format='%h %s' HEAD   # 9 files changed; committing plan docs alongside a fix is the repo's shape (60be6f6 carried 4 docs with its fix)
```

Do NOT push. The operator pushes (CI builds `sha-<12>`) and promotes via a separate homelab-setup PR; after promotion, the handoff §8 step 4 `skopeo inspect` is the check that an image exists.

---

## Self-review

1. **Spec coverage.** Binding decisions: guard extended for `error` with `stillActive === 0 && completed > 0` (Task 1 Edit 3); `completed`/`needs_human` stay terminal (Edit 2, test 4, injection 5d); the `:136` rule kept for the new status (Edit 3 reuses `newStatus`); the "why `error` is re-openable" rationale documented (Edit 1, Edit 2, reaper header Edit 4); tests: error+completed → `needs_human`, error+zero completed → stays `error`, `completed` never touched (tests 1, 2, 4) plus the in-flight case (test 3); injection "revert the guard → red" (5a) plus one injection per remaining assertion the tests pin (5b-5d) and one for the binding `finalizedAt` re-stamp decision (5e); register §5.5/5 and §7.2 notes (Task 2 Step 1); handoff §7 "Closed since" (Task 2 Step 2); one `fix(worker)` commit (Task 2 Step 4). Unit test: checked, none exists, integration file is the seam, and the reason for not adding one (the file is already in the unit denominator with FNH 0; a unit test would mock `$transaction`) is recorded with the lcov numbers. Doc surfaces that call `error` terminal: module doc (Edit 1), constant comment (Edit 2), `maybeFinalizeRun` JSDoc (Edit 5), reaper header (Edit 4) — all four rewritten; both writers of `error` (reaper, run-launch.ts:646-649) are named, and the run-launch case is described the way run-launch.ts:613-645 actually behaves (stop-on-first-failure loop, in-doubt publish) — a judgment CAN complete on a run-launch-stamped run and the rule is wanted there, not vacuous.
2. **Placeholder scan (re-run after the second 2026-09-01 revision).** No TBD/TODO/"similar to"; every edit shows the exact old and new text (Edit 5's old text re-checked byte-for-byte against run-finalizer.ts:103-105 on HEAD; Edit 2's new comment re-wrapped to 80 columns like the rest of the file — no lint rule enforces it); every command is exact; every expected output is quoted in the form vitest 3.2.4 actually prints (including `| 12 skipped (16)` under `-t` and `expected <n> to be greater than <n>` for 5e); the vitest-running guard is the `comm==node` filter in Steps 2, 4, 5 and three times in Task 2 Step 3 (once at the top, once immediately before each DB-touching suite) and was verified to print nothing on an idle box from inside a Bash tool call; the Files headers of both tasks match the line ranges their steps quote (`:115-145`, `:103-105`, handoff `:327-332`) and Task 2's runbook/spec ranges match Plan-specific facts bullet 8 (`:454-459`, `:167-171`, with the narrower replaced lines called out); the Global Constraints block is byte-identical to the seven sibling 2026-09-01 plans (the earlier `build 0.` divergence was removed; the `Gates:` line in Task 2 Step 4 follows the shared format).
3. **Type consistency.** `REOPENABLE_RUN_STATUSES: RunStatus[]`, `reopening: boolean`, `newStatus: RunStatus`, `run.status: RunStatus` — all from the existing `RunStatus` import at run-finalizer.ts:66; `maybeFinalizeRun`'s signature (`(runId: string): Promise<RunStatus | null>`) is unchanged — Edit 5 touches only its JSDoc — and is what Task 1's tests and the DLQ plan consume.

## Decisions

- `error → error` writes nothing (no `finalizedAt` re-stamp), so the reaper's stamp keeps meaning "when it gave up". `error → needs_human` DOES re-stamp: the verdict changed.
- No unit test: `run-finalizer.ts` is already in the unit denominator (FNH 0) and `maybeFinalizeRun` is a row-locked `$transaction` that only a live Postgres can exercise; the integration file is the seam and integration count moves 80 → 84.
- Docs get dated *closure* notes rather than CORRECTIONs: the annotated sentences were true and the row they cite is still `error` in production.
- Forward-only; no production `UPDATE`. Production access in this plan would be read-only anyway (global constraints).

## Open questions (none block execution)

- Whether the owner wants a one-off `UPDATE "EvaluationRun" SET status='needs_human' WHERE id='a0983c08-4548-4663-a40d-0cd56b82f765'` on production after promotion. Until decided, run 1's run-grain count stays off by one and the docs say so.
- The handoff's "Closed since" subsection is a new anchor that later plans (#5 dlq-admin-cli, U7 docs bundle) will also append to; land this plan first so they append below its line rather than conflict on the `## 8.` boundary.
- A run stamped `error` by run-launch after a PARTIAL publish (`run-launch.ts:613-629` breaks on the first failure) keeps its unpublished judgments `pending`; the reaper sweep never re-selects `error` runs (reaper.ts:304 queries pending/judging only), so `stillActive > 0` holds forever and the run stays `error` even after the published judgments complete. Not this item; candidate follow-up for #5 dlq-admin-cli or the reaper.
