# Deadline at First Dequeue — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `EvaluationRun.deadlineAt` is currently stamped at CREATION as `now + (judgments queued ahead) × hardCapMs + slack` — a queue-position estimate, not an execution budget. It means "this run was created too long ago," so it is sensitive to queue depth, worker count and concurrency, and `src/worker/reaper.ts` force-finalizes ("`error: 'reaper: abandoned'`") any run whose deadline passes, killing a healthy queued tail indistinguishably from a genuine failure — this already cost 4 of 30 items on a real calibration and is why `MAX_CALIBRATION_ITEMS` is capped at 100, blocking the seeded 620-item "JudgeBench pairwise — full" golden set. This plan moves the stamp to FIRST DEQUEUE — when a worker actually claims the run's first judgment — so the deadline means "this run has been executing too long," sized on the run's own judgment count and immune to how many other runs were queued ahead of THIS run's first claim. (One qualification, stated here and honoured in every doc block below: for a MULTI-judgment run the budget is `judgmentCount × hardCapMs`, which assumes those judgments execute concurrently across their judges' lanes rather than serially behind unrelated work on one lane. It is still strictly looser than the creation-time deadline it replaces, which started the same clock at CREATION rather than at first claim — so this is a qualification on the guarantee, not a regression.) It closes the one hazard that makes this non-trivial (a null deadline is invisible to the reaper's own sweep predicate, so a never-dequeued run would otherwise become immortal), reconciles all THREE independent call sites that used to compute a creation-time deadline, and — as a final, evidence-gated step — raises `MAX_CALIBRATION_ITEMS` to 1000.

**Architecture:** One new pure function (`runStartBudgetMs`, `src/lib/llm/timeout-policy.ts`, unit-tested, mirrors the existing `leaseMsFor`) computes the run-level budget from a judgment count and the two-budget `TimeoutBudgets` the module already resolves. Two new functions in `src/worker/claim.ts` carry one invariant — **`deadlineAt` is non-null exactly while the run has a claimed judgment in flight**: `stampRunStartedAtFirstDequeue` uses the budget in a single guarded `updateMany` (`WHERE id = $1 AND "deadlineAt" IS NULL`) from one site, `judgment-consumer.ts`'s `executeClaimed` immediately after a successful claim; `clearRunDeadlineOnRequeue` releases it from one site, the same file's retryable-error disposition, because a judgment reset to `pending` and republished onto the back of its lane is queued work again, not executing work (without that half, a retried calibration judgment keeps a ~16-minute budget while waiting out a queue measured in hours, and the reaper kills it — the same defect, relocated to the retry path). `src/worker/reaper.ts` gains a second, much looser detector (`NEVER_STARTED_TIMEOUT_MS`, 45 days, sized on the LEGAL per-batch bound) for a run that is never dequeued at all, reusing its existing two-phase republish-then-abandon disposition. The three launch-time formulas (`src/lib/run-launch.ts`'s default, `src/lib/calibration/launch.ts`'s batch override, `src/worker/run-create-consumer.ts`'s independent copy) are deleted — `EvaluationRun.deadlineAt` is now `null` at creation, always, for every launch path. No schema migration: `deadlineAt` (`prisma/schema.prisma:405`) is already `DateTime?`, and `createdAt` already exists — see Task 0's decision record for why a `startedAt` column was considered and rejected.

**Tech Stack:** TypeScript, Prisma on Postgres, vitest 3.2.4 (unit / db / integration — this plan reaches all three tiers), amqplib. Node >= 22. Always use `git -C /root/judge-arena`.

**Spec:**
- `src/lib/run-launch.ts`'s `deadlineAt` JSDoc (`LaunchSingleRunParams`, lines ~340-372 on HEAD `ceb2d0a`) names this exact fix as "the correct long-term fix" and states why it was deferred: *"It needs a `startedAt`-driven deadline write in the claim path plus a reaper that understands never-started runs, which is a worker-side change out of scope for phase 1."* This plan is that change.
- `src/lib/calibration/launch.ts`'s "THE REAPER FIX" comment (lines ~253-324) explains the batch formula it is deleting, which budget it multiplies (the HARD CAP, not the initial budget — `EVALUATION_MODEL_HARD_CAP_MS`, because a call may legally run to the cap under the escalating-timeout policy) and states the same deferral.
- `src/lib/calibration/launch.ts:71`, `MAX_CALIBRATION_ITEMS = 100`, and its refusal at `:220-233`.
- `src/worker/claim.ts` (146 lines) — `claimJudgment`, `LEASE_MS`, the guarded-`updateMany` idiom this plan reuses.
- `src/worker/reaper.ts` (367 lines) — `sweepOverdueRuns` (~:301-323), `forceFinalizeAbandonedRun`, `republishPendingForRun`, `FORCE_FINALIZE_GRACE_MS`.
- `src/lib/run-finalizer.ts` — `maybeFinalizeRun`'s `SELECT ... FOR UPDATE` pattern (referenced, not modified).
- `src/worker/run-create-consumer.ts` — the third, independently-computed deadline formula.
- `src/worker/judgment-consumer.ts` — `executeClaimed`'s `claimJudgment()` call site (~line 1076), where the new stamp is wired in.
- Format template: `docs/superpowers/plans/2026-09-02-token-accounting-and-truncation-proximity.md`.

**Priority / wave:** New. Strictly sequential — see **Depends on**.

**Depends on:** Nothing unlanded. **HEAD is `ceb2d0a`** (`docs: the session handoff, the qwen3.5:9b result, and what is NOT deployed`), confirmed to match production `sha-ceb2d0ad9181` (22 applied migrations, both measured 2026-09-03 read-only against `judge-arena-pg-1`). The tree is clean apart from this untracked plan document (see Measurements). **Tasks 1→2→3→4→5→6 must land in exactly this order** — not a style preference, a correctness requirement, argued in full in Task 0 and restated at each task boundary:
- Task 1 (pure arithmetic) has no runtime effect on its own — safe to land first.
- Task 2 (the claim-time stamp and its requeue-time clear) must exist and be wired in **before** anything stops stamping `deadlineAt` at creation: a tree left at Task 4 or 5 without Task 2 gives every new run no deadline and nothing to give it one. **Its two halves are not equally dormant once landed.** The STAMP is dormant until Task 4/5 land (every `updateMany` in Task 2's stamp finds `deadlineAt` already non-null, so `count: 0`, always). The CLEAR (`clearRunDeadlineOnRequeue`) is **not** dormant: it fires on the very first retryable provider error against any run this stamp has touched, unconditionally NULLing that run's `deadlineAt` — and until Task 3 also lands, the pre-Task-3 sweep predicate (`deadlineAt: { lt: now }`) can never match `NULL`, so that run is stranded `pending`/`judging` permanently. **The tree is therefore UNSAFE at any prefix that includes Task 2 without also including Task 3.** See the last bullet for the corrected statement of what this ordering buys.
- Task 3 (the never-started safety net) must exist **before** Tasks 4/5 stop always-stamping — this is "build the net before removing the guardrail," the same ordering logic as Task 2, for the opposite failure mode (immortality instead of no-deadline-at-all-until-claimed). **It is also the only thing that can recover a run left null-`deadlineAt` by Task 2's own CLEAR (see the Task 2 bullet above), so in practice it must follow Task 2 immediately, not merely precede Task 4/5.** Its dormancy claim is about PRODUCTION DATA, not about the other tasks: production has zero `pending`/`judging` rows with a null `deadlineAt` (read-only check, re-run at Task 3 Step 0), so the query's new `OR` arm (`deadlineAt: null AND createdAt < ...`) matches nothing today.
- Tasks 4 and 5 (the three creation-time formulas) can land in either order relative to each other but only after 2 and 3. Task 4 groups `run-launch.ts` + `calibration/launch.ts` in one commit because the latter's deleted code exists **only** to override the former's `deadlineAt` param — removing one without the other in the same commit leaves an intermediate state where `calibration/launch.ts` imports a symbol `run-launch.ts` no longer exports. Task 5 (`run-create-consumer.ts`) is independent of both and could land anywhere after 2/3, but is sequenced last of the three because it shares no symbols with the other two and there is no reason to interleave it.
- Task 6 (raise `MAX_CALIBRATION_ITEMS`) is explicitly gated on Tasks 1-5 all landing — its own safety argument (the never-started net must be sized against the NEW cap) is meaningless before Task 3 exists.
- **What the ordering actually buys, stated precisely so it is not over-claimed.** All six commits ship in ONE image (`judge-arena-web` and `judge-arena-worker` run the same tag — verified 2026-09-03: both on `harbor.cluster.asethi.com/homelab/judge-arena:sha-ceb2d0ad9181`), so no production process ever observes the intermediate tree and "a run created in the gap between two commits" cannot happen at deploy time. What the order protects is an ABANDONED EXECUTION of this plan: the tree is safe to leave at Task 1 alone, or at Task 1+2+3 together (both new mechanisms exist — the STAMP is dormant, and Task 3 is what makes the CLEAR safe to have landed — see the Task 2/3 bullets above). It is **UNSAFE at Task 2 alone** (the CLEAR is live and Task 3's net does not yet exist to recover what it NULLs) and UNSAFE at any prefix containing Task 4 or 5 without 2 and 3 (every new run gets no deadline, no stamp and no net). The gap that IS real at deploy time is between the two DEPLOYMENTS, not between commits — see **Promotion preconditions** below.

**Owner decisions needed:** None. Every decision the brief calls out is made and argued in-task, not deferred:
1. **"Not started" marker** — `deadlineAt IS NULL` (already-nullable column, zero migration), not a new `startedAt` column. Argued in Task 0.
2. **The leak / second safety net** — `src/worker/reaper.ts`'s `NEVER_STARTED_TIMEOUT_MS = 45 days`, argued from the LEGAL per-batch bound (`items × MAX_ATTEMPTS × hardCapMs`), not from measured throughput. Task 3.
3. **Atomicity** — a single guarded `updateMany` (`WHERE id = $1 AND "deadlineAt" IS NULL`), proven safe under concurrent claims of different judgments in the same run. Task 2.
4. **The three launch call sites** — all three stop computing/passing a creation-time deadline; none keeps a "fallback" override. Tasks 4 and 5.
5. **`MAX_CALIBRATION_ITEMS`** — raised to 1000, with the arithmetic for why and what still bounds it. Task 6, gated on 1-5.

---

## Measurements — re-verified 2026-09-03

```sh
git -C /root/judge-arena log -1 --format='%h %s'   # ceb2d0a docs: the session handoff, the qwen3.5:9b result, and what is NOT deployed
git -C /root/judge-arena status --porcelain          # ?? docs/superpowers/plans/2026-09-03-deadline-at-first-dequeue.md
#   (this plan document, untracked — nothing else. Task 1 Step 7's `git add` folds it into commit A, deliberately;
#    later tasks do not re-add it, so checkbox ticks after commit A stay in the working tree.)
```

Read-only, against `judge-arena-pg-1` (production):

```sh
kubectl -n tenant-public exec judge-arena-pg-1 -c postgres -- psql -U postgres -d judge_arena -tAc \
  "select id, name, protocol from \"GoldenSet\";"
# cmt057h5d00097y01ymubpre5|JudgeBench pairwise — full|pairwise
# cmt057hd001g17y01lhjzgfuj|JudgeBenchSample — 30 random|pairwise

kubectl -n tenant-public exec judge-arena-pg-1 -c postgres -- psql -U postgres -d judge_arena -tAc \
  "select \"goldenSetId\", count(*) from \"GoldenItem\" group by 1;"
# cmt057h5d00097y01ymubpre5|620
# cmt057hd001g17y01lhjzgfuj|30

kubectl -n tenant-public exec judge-arena-pg-1 -c postgres -- psql -U postgres -d judge_arena -tAc \
  "select count(*) from _prisma_migrations;"
# 22

kubectl -n tenant-public exec judge-arena-pg-1 -c postgres -- psql -U postgres -d judge_arena -tAc \
  "select migration_name from _prisma_migrations order by started_at desc limit 2;"
# 20260901190000_v2l_calibration_constant_baseline
# 20260901180000_v2k_calibration_sampling_snapshot

kubectl -n tenant-public exec judge-arena-pg-1 -c postgres -- psql -U postgres -d judge_arena -tAc \
  "select status, count(*) from \"EvaluationRun\" where status in ('pending','judging') group by 1;"
# (no rows — nothing is currently running; safe to author this plan)
```

**v2k and v2l are both applied in production** (22 migrations total). The next free migration letter is **v2m** — but this plan claims none, per Task 0's decision.

**Throughput, cited from the brief and corroborated in-tree** (`src/lib/calibration/launch.ts`'s now-deleted "cost of the other direction" paragraph; `tests/db/lane-publishing.test.ts:220` independently references "the exact over-subscription that dead-lettered 4 of 30 items on 2026-08-31" as the same real incident): a 30-item calibration ran **151 minutes wall clock**, serialized through one judge's lane — **5.03 min/item**. Extrapolated:

| batch size | worst-case wait for the LAST item (`N × 5.03 min`) |
|---|---|
| 30 (measured) | 151 min = 2.5 h |
| 620 ("JudgeBench pairwise — full") | 3118.6 min ≈ 52.0 h ≈ **52 h** |
| 1000 (this plan's new `MAX_CALIBRATION_ITEMS`) | 5030.0 min ≈ 83.8 h ≈ **3.49 days** |

Those are EXPECTATIONS, not bounds. The bound the never-started net has to survive is the LEGAL one, on the same
hard-cap-not-initial-budget discipline every other number in this plan uses: a calibration serialises through ONE
judge's gate (`src/worker/judgment-consumer.ts`'s per-judge permit), each item may legally run to `hardCapMs`
(900_000 ms, `src/lib/llm/timeout-policy.ts`) and may be delivered up to `MAX_ATTEMPTS = 3` times
(`src/worker/judgment-consumer.ts:199`):

| batch size | LEGAL worst case (`N × 3 × hardCapMs`) |
|---|---|
| 620 | 465 h ≈ **19.4 days** |
| 1000 (this plan's new `MAX_CALIBRATION_ITEMS`) | 750 h ≈ **31.25 days** |

`NEVER_STARTED_TIMEOUT_MS = 45 days` (Task 3) is sized on the 1000-item LEGAL worst case, not on the measured 3.49
days — sizing a force-finalize threshold on an expectation is exactly what killed 4 of 30 items in the first place.
It is not immune to queue depth either: the net measures wall clock from `createdAt`, so N max-size batches on one
judge's lane SUM. The invariant it assumes, stated so it can be checked: **at most one calibration anywhere near
`MAX_CALIBRATION_ITEMS` in flight per judge lane at a time.** Task 3 pins the relationship (not the literal) in a
test, so raising `MAX_CALIBRATION_ITEMS` again without revisiting the net goes red rather than silently re-arming
the bug.

**Unit baseline, re-measured 2026-09-03 on `ceb2d0a`:**

```sh
cd /root/judge-arena && npx tsc --noEmit && npx vitest run 2>&1 | tail -5
```
`tsc`: clean. `Test Files 61 passed (61)` / `Tests 1002 passed (1002)` — **matches the operator-supplied baseline exactly.**

```sh
npx vitest run tests/lib/timeout-policy.test.ts 2>&1 | tail -5
```
`Test Files 1 passed (1)` / `Tests 25 passed (25)` — the file Task 1 extends.

**db / integration baselines are cited from the operator's measurement (679 db / 46 files, 82 integration / 11 files) and were NOT independently re-run by this plan's author** — see the read-only-tooling note below.

**A note on how this plan was authored, stated once, binding throughout:** the author operated under an explicit read-only constraint (no source edits, no `npm run test:db`, no `prisma migrate`, no `tests/db/**` file execution — only `npx tsc --noEmit`, `npx vitest run <specific unit file>`, `grep -a`, `git log/show`, and read-only `psql`). Every code block below was composed against the files as read (verbatim excerpts, quoted in full where they are being deleted or replaced) and cross-checked for consistency, but **this plan has not been dry-run end-to-end** the way the token-accounting template plan was. Expected-FAIL text for db/integration steps is a prediction grounded in this exact codebase's own repeatedly-confirmed vite-node/vitest failure idiom (cited inline per step, with the specific prior plan that dry-run-verified the same idiom), not an observation. **The executor is the first to actually run every step in this plan and must treat a mismatch between predicted and actual output as a signal to stop and diagnose, not as evidence the plan is wrong.**

---

## Global Constraints

- Repo: `/root/judge-arena` (Next.js 15.5.22, TypeScript, Prisma on Postgres, amqplib, vitest 3.2.4). Node >= 22. Always use `git -C /root/judge-arena`.
- Gates, in this order, clean before every commit: `npm run lint` (0 warnings) → `npx tsc --noEmit` → `npm run test:coverage` (unit; per-glob floors in `vitest.config.ts:187-220` — **NEVER lower a floor**) → `npm run test:db:coverage` → `npm run test:integration` → `npm run build`. **Per-task carve-out, stated at each task:** a task that touches only `src/lib/llm/timeout-policy.ts` (Task 1) needs only lint/tsc/unit; a task that touches only `src/worker/**` and its integration tests (Tasks 2, 3, 5) needs lint/tsc/unit/integration (its unit-coverage impact on `src/worker/**`'s floor is the thing to watch — see Task 2's own note); a task that touches `src/lib/run-launch.ts` / `src/lib/calibration/launch.ts` and a `tests/db/**` file (Task 4, Task 6) needs lint/tsc/unit/db. **Run the FULL chain (all six gates) once after Task 6, the final task, before considering the plan done** — the tasks are interdependent enough (Task 3's tests only pass once Task 4/5 exist to make null-deadline rows reachable in practice; Task 6 depends on all five) that a full-chain pass at the end is the only real end-to-end confirmation.
- Before the first `npm run test:db:coverage` or `npm run test:integration`, confirm `.env.test`'s `DATABASE_URL` is `localhost:5432` (the local podman `judge-arena-pg`), never `judge-arena-pg-1` (k8s, PRODUCTION) — one character apart. **Any production access in this plan is read-only `psql SELECT` and nothing else. Never push, never promote, never mutate the cluster — those are the operator's.**
- **`npm run test:db -- <file>` and `npm run test:integration -- <file>` DO NOT SCOPE THE RUN.** Both scripts are
  `sh -c '<string>'` wrappers (`package.json:18,20`) whose command string never references `"$@"`, so an argument
  after `--` becomes a positional parameter to `sh` and is silently dropped — the FULL suite runs, and `test:db`
  additionally does a `prisma migrate reset --force` first. This repo already recorded the trap
  (`docs/superpowers/plans/2026-08-13-a0-status-and-handoff.md:166-168`) and it was re-verified 2026-09-03. Every
  single-file run below therefore uses the wrapper-free form the repo's own prior plans use
  (`2026-09-01-dlq-admin-cli.md:303`, `2026-09-01-capture-field-gaps.md:1010`):
  `sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config <config> <file>'`.
  The scoped db form skips `prisma migrate reset` — safe here because this plan adds no migration, but it means the
  test DB must already be migrated (any earlier `npm run test:db*` in this session has done that).
  Before EVERY db or integration run, confirm no other vitest is live — `ps -eo comm,args | awk '$1=="node" && /[v]itest/'`
  must print nothing (see the next bullet for why).
- The db suite (`tests/db/**`) shares one Postgres (`judge_arena_test`) and is **not concurrency-safe** — never run two `test:db*` invocations at once; if a file fails, re-run that file alone before calling it a regression.
- TDD with a REAL injection per behaviour (CONTRIBUTING.md:210-234): write the failing test, watch it fail for the stated reason, implement, watch it pass, then break the implementation on purpose and confirm the SAME test goes red for a reason that describes the defect — then restore. **An injection that leaves the suite green is a finding, not a formality** — if that happens, stop and diagnose before moving to the next step.
- Never lower a coverage floor (`vitest.config.ts:187-220`). If a task's new code (particularly in `src/worker/**`, which is integration-only by this repo's own convention — see `vitest.config.ts`'s comment at its `src/worker/**` threshold entry) pushes the unit `test:coverage` run under a floor, the fix is to make the new code THINNER (delegate arithmetic to an already-unit-tested pure module, which is exactly why Task 1 exists as its own task) — never to edit the threshold number.
- One concern per commit. Commit subject: `type(scope): lowercase summary` (feat/fix/docs; scopes used below: `llm`, `worker`, `run-launch`, `calibration`). Body: narrative, then a `Gates: lint 0, tsc 0, <n> unit / <n> db / <n> integration, coverage 0.` line — a slot not measured by that task reads `n/a (not touched by this task)` — then exactly these trailers:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01WT7bB4SAZpJtRDEGhpGyRv
  ```
- **Migration naming is INERT for this plan — it adds ZERO migrations and does not touch `prisma/schema.prisma`.** `EvaluationRun.deadlineAt` (`prisma/schema.prisma:405`) is already `DateTime?`; `EvaluationRun.createdAt` (`:413`) already exists and is a plain `@default(now())` field (not `@updatedAt`), so it is directly settable in a Prisma `create()` call without the raw-SQL backdating trick `ModelJudgment.updatedAt` (which IS `@updatedAt`-managed) needs. For the record, since a later reader may want it: next free migration letter is **v2m** (`v2k`/`v2l` both applied in production, confirmed above); narrative `-- v2x — …` header in the v2k/v2l style; content exactly what `prisma migrate diff` emits; `npx prisma generate` after.
- Commit **LOCALLY only. Never push, never promote, never mutate the cluster.**
- **GREP TRAP, live in HEAD:** `src/lib/calibration/readings.ts` and `scripts/importer/reconcile.ts` contain a deliberate NUL byte; plain `grep` silently returns nothing for those two files. **Use `grep -a`. NEVER remove the NUL.** (Neither file is touched by this plan, but a repo-wide `grep` while executing it will hit this.)
- **CI never runs for an unmerged branch** (Gitea has no CLI; push-to-main is what fires it) — irrelevant here since this plan never pushes, but stated so the executor does not wait for a CI signal that cannot arrive.

---

## Commit shape (binding)

Exactly **six** commits land from this plan, one per task, strictly in order:

| commit | task | subject |
|---|---|---|
| A | Task 1 | `feat(llm): runStartBudgetMs — the pure arithmetic for a run's own execution deadline` |
| B | Task 2 | `feat(worker): stamp EvaluationRun.deadlineAt at first dequeue, not at creation` (and clear it on requeue — the same invariant, one concern) |
| C | Task 3 | `fix(worker): reaper — close the null-deadlineAt leak with a never-started safety net` |
| D | Task 4 | `fix(run-launch): stop stamping deadlineAt at creation in launchSingleRun and launchCalibrationRun` |
| E | Task 5 | `fix(worker): run-create-consumer stops computing its own creation-time deadline` |
| F | Task 6 | `feat(calibration): raise MAX_CALIBRATION_ITEMS to 1000, gated on the deadline-at-first-dequeue fix` |

---

## Task 0: the decision record — why `deadlineAt IS NULL`, not a `startedAt` column

No code in this task. The decision, and why it is not a coin flip — the rest of the plan assumes it.

**`deadlineAt IS NULL` is the "not started" marker. No `EvaluationRun.startedAt` column is added.**

*For a column:* it would carry an explicit, unambiguous "when did this run first get dequeued" fact, independent of whatever `deadlineAt` happens to mean at read time — useful for a future latency dashboard ("time from creation to first execution"), and it would not require the reaper's own predicate to interpret `null` specially.

*Against, and this is what decides it:*

1. **`deadlineAt` is ALREADY nullable, and no LAUNCH path ever left it null.** `prisma/schema.prisma:405` reads `deadlineAt DateTime?` — this was true before this plan and needs zero migration to exploit. Every launch path (`run-launch.ts`, `calibration/launch.ts`, `run-create-consumer.ts`) always computed a value. **It is NOT an entirely unused state, and this correction is load-bearing for Task 3:** two non-launch writers already produce it. `scripts/importer/runs.ts:384` writes `deadlineAt: null` EXPLICITLY, paired with a v1-preserved `createdAt` (`:387`) and a `status` (`:369`) that is `castStatus(v1.status, …)` — i.e. `'pending'` or `'judging'` whenever the v1 run was touched within `STRANDED_CUTOFF_MS` (24 h, `:204`) and so was not force-terminalized. `src/worker/run-create-consumer.ts:154` omits it on the expansion-failure record, but that row is `status: 'error'` and is therefore never swept. The importer population is inert under today's reaper and becomes REACHABLE the moment Task 3's second `OR` arm lands — see Task 3 Step 0's mandatory read-only gate. A `startedAt` column would not remove the need to ALSO decide what `deadlineAt` means before it is stamped — it would still need to be `null` at creation (or the reaper's sweep predicate needs rewriting to join through `startedAt` arithmetic instead of reading a precomputed threshold column, which is strictly more code for no correctness gain).
2. **The reaper ALREADY, ACCIDENTALLY, treats a null deadline as "not started."** `src/worker/reaper.ts`'s `sweepOverdueRuns` query (before this plan) is `deadlineAt: { lt: now }`. Under SQL's three-valued logic, `NULL < now` evaluates to `NULL`, which a `WHERE` clause treats as "no match" — so a null-deadline row is **already invisible to this query**, and the very next line inside the loop, `run.deadlineAt !== null && run.deadlineAt.getTime() < now - FORCE_FINALIZE_GRACE_MS`, is **dead code today**: it can never observe a null `deadlineAt`, because the query that fed it already filtered every such row out. Choosing `deadlineAt IS NULL` as the marker activates a dormant, already-correct SQL semantic that this exact function already anticipated (defensively, for a state its author could not create) rather than inventing a new one. This is a genuine finding, not a rhetorical flourish — see the final report for where it is called out explicitly.
3. **A `startedAt` column solves a problem this task does not have.** The only two things "not started" needs to answer are (a) "should the claim-time stamp fire" (Task 2 — answered by a guarded `UPDATE ... WHERE deadlineAt IS NULL`) and (b) "how long has this run sat with zero progress" (Task 3's safety net — answered by `createdAt`, which already exists and already means exactly that). A `startedAt` column would answer (b) with a NEW timestamp that says the same thing `createdAt` already says for every row this task cares about (a run that has not started has `startedAt` identically absent whether or not the column exists), and would need writing at exactly the same claim-time seam `deadlineAt` is already being written at — i.e., it is not a cheaper or safer write, only a second column carrying redundant information for this task's purposes. To keep this record accurate about what already exists: a PER-JUDGMENT `ModelJudgment.startedAt` is already there and is already stamped by `claimJudgment` at that exact seam (`src/worker/claim.ts:107` and `:138`), so "when was this run first dequeued" is already recoverable as `MIN(ModelJudgment.startedAt) WHERE runId = …`. What is missing is not the FACT but a RUN-level precomputed threshold the reaper's sweep can compare against in one indexed `WHERE`, without a join and an aggregate on every 60 s sweep. `deadlineAt` is that threshold, already nullable, already the column the sweep reads — which is why it, and not a redundant run-level `startedAt`, carries the marker.
4. **Additive-and-nullable is not a mandate to add a column** — it is a constraint on what to do IF one is added. The absence of a migration in this plan is itself the more conservative, more reviewable choice: zero schema drift, zero new column for every future reader of `prisma/schema.prisma` to explain, and `CONTRIBUTING`'s own pseudo-drift table (referenced by the v2k/v2l migration headers) stays untouched.

*Consequence to state once and honour everywhere:* **`EvaluationRun.deadlineAt === null` means "not yet claimed" for the ENTIRE lifetime of a run before its first judgment is dequeued — for every run, calibration or ordinary, forever, starting with Task 4.** This is a semantic overload (the same column later means "the execution deadline") and every place that reads it must know the difference. It is documented at the schema field is not edited (no migration), so the documentation lives in three places instead: `src/worker/claim.ts`'s `stampRunStartedAtFirstDequeue` (Task 2), `src/worker/reaper.ts`'s `NEVER_STARTED_TIMEOUT_MS` (Task 3), and the module docs of the three launch files that stop writing it (Tasks 4-5).

---

## Task 1: `runStartBudgetMs` — the pure arithmetic, unit-tested

**Files:**
- Modify: `/root/judge-arena/src/lib/llm/timeout-policy.ts` (insert after `leaseMsFor`, currently ending at line 203)
- Modify (Test): `/root/judge-arena/tests/lib/timeout-policy.test.ts` (append after line 328, the file's current end)

**Interfaces:**
- Consumes: `TimeoutBudgets` (already exported, `{ initialBudgetMs: number; hardCapMs: number }`).
- Produces:
  - `export const RUN_DEADLINE_SLACK_MS = 60_000;`
  - `export function runStartBudgetMs(judgmentCount: number, budgets: TimeoutBudgets, slackMs: number = RUN_DEADLINE_SLACK_MS): number` — returns a millisecond DURATION (not an absolute `Date`), mirroring `leaseMsFor`'s own shape exactly so the caller (Task 2) combines it with `Date.now()` itself, keeping this function trivially testable without fake timers.

- [ ] **Step 0: confirm the anchor**

```bash
cd /root/judge-arena && sed -n '201,207p' src/lib/llm/timeout-policy.ts
```

Expected output (the end of `leaseMsFor` and the start of the next doc comment):
```
export function leaseMsFor(budgets: TimeoutBudgets, slackMs: number = POST_CALL_SLACK_MS): number {
  return budgets.hardCapMs + slackMs;
}

/**
 * The latency baseline for one judge — THE contract, re-exported under a
 * judge-scoped name rather than redeclared: this is
```
(Re-verified 2026-09-03 on `ceb2d0a`: `leaseMsFor` is lines 201-203, its closing brace 203, and 205-207 are the first three lines of the next doc comment.) If this does not match exactly, the file has moved since this plan was authored — re-locate `leaseMsFor`'s closing brace before proceeding.

- [ ] **Step 1: write the failing test**

Append to `/root/judge-arena/tests/lib/timeout-policy.test.ts` (the file currently ends at line 328 with the closing `});` of `describe('timeout-policy: the LEASE must cover the hard cap ...')`; add this as a new top-level `describe` after it):

```ts

describe('timeout-policy: runStartBudgetMs — the run-level deadline is sized on THIS run\'s own work, not queue depth', () => {
  it('one judgment (the calibration shape): budget is exactly one hard cap plus slack', () => {
    const budgets = { initialBudgetMs: 5 * MINUTE, hardCapMs: 15 * MINUTE };
    expect(runStartBudgetMs(1, budgets)).toBe(15 * MINUTE + RUN_DEADLINE_SLACK_MS);
  });

  it('N judgments (an ordinary multi-model run): budget scales with THIS run\'s own count', () => {
    const budgets = { initialBudgetMs: 5 * MINUTE, hardCapMs: 15 * MINUTE };
    expect(runStartBudgetMs(4, budgets)).toBe(4 * 15 * MINUTE + RUN_DEADLINE_SLACK_MS);
  });

  it('CRITICAL: derived from the HARD CAP, not the initial budget — same asymmetry as leaseMsFor', () => {
    // A budget sized on the shorter initial-alert window would let the
    // reaper force-finalize a judgment that is still legitimately executing
    // to the hard cap — the exact failure this task exists to fix,
    // reintroduced through the wrong budget instead of through queue depth.
    const budgets = { initialBudgetMs: 5 * MINUTE, hardCapMs: 15 * MINUTE };
    expect(runStartBudgetMs(1, budgets)).toBeGreaterThan(budgets.initialBudgetMs);
    expect(runStartBudgetMs(1, budgets)).not.toBe(budgets.initialBudgetMs + RUN_DEADLINE_SLACK_MS);
  });

  it('a custom slack overrides the default, mirroring leaseMsFor\'s own optional parameter', () => {
    const budgets = { initialBudgetMs: 5 * MINUTE, hardCapMs: 15 * MINUTE };
    expect(runStartBudgetMs(2, budgets, 10_000)).toBe(2 * 15 * MINUTE + 10_000);
  });

  it('RUN_DEADLINE_SLACK_MS is 60 seconds, matching the three now-deleted creation-time copies it replaces', () => {
    expect(RUN_DEADLINE_SLACK_MS).toBe(60_000);
  });
});
```

Add the two new names to the existing top-of-file import from `@/lib/llm/timeout-policy`:

```ts
import {
  DEFAULT_HARD_CAP_MS,
  DEFAULT_INITIAL_BUDGET_MS,
  HARD_CAP_MAX_ATTEMPTS,
  MAX_HARD_CAP_MS,
  POST_CALL_SLACK_MS,
  RUN_DEADLINE_SLACK_MS,
  armEscalatingTimeout,
  buildInitialBudgetAlert,
  budgetOrderingError,
  hardCapAbortKind,
  leaseMsFor,
  resolveTimeoutBudgets,
  runStartBudgetMs,
  type JudgeLatencyBaseline,
} from '@/lib/llm/timeout-policy';
```

- [ ] **Step 2: run it, confirm the exact FAIL**

```bash
cd /root/judge-arena && npx vitest run tests/lib/timeout-policy.test.ts
```

**Exact expected FAIL:** vite-node's SSR transform resolves a named export the module does not have to `undefined` rather than a load-time error (confirmed for this exact codebase/vitest version by `2026-08-14-l1-tombstone-overlay.md:1062` and `2026-09-01-calibration-budget-warning.md:339`, both dry-run-verified). So the file still loads, the pre-existing 25 tests still pass, and every new test in the new `describe` block fails as `TypeError: runStartBudgetMs is not a function` — except the last one (`RUN_DEADLINE_SLACK_MS is 60 seconds...`), which is a plain value comparison, not a function call, and fails as `expected undefined to be 60000`. Overall: `Tests 5 failed | 25 passed (30)`. If instead the whole file fails to load with `does not provide an export named 'runStartBudgetMs'` and 0 tests run, that is the same underlying failure (Rollup-style wording vs. vite-node's runtime `undefined` resolution) — not a wrong red, per the same two prior plans' own caveat.

- [ ] **Step 3: minimal implementation**

Insert into `/root/judge-arena/src/lib/llm/timeout-policy.ts`, immediately after `leaseMsFor`'s closing `}` (after the current line 203, before the `/** The latency baseline for one judge ...` comment):

```ts

/**
 * Slack added on top of `judgmentCount * hardCapMs` to get the run-level
 * deadline `src/worker/claim.ts` stamps on `EvaluationRun.deadlineAt` at
 * FIRST DEQUEUE (see that module's `stampRunStartedAtFirstDequeue`). Same
 * PURPOSE as `leaseMsFor`'s `POST_CALL_SLACK_MS` a few lines above — DB
 * round trips, queue publish latency, finalization overhead — but a
 * SEPARATE constant, not a reuse of `POST_CALL_SLACK_MS`: the lease covers
 * ONE provider call's post-call work, this covers the WHOLE run's (every
 * judgment's persist plus the run's own finalization pass), and the two are
 * free to diverge in size without a shared constant forcing them to move
 * together for an unrelated reason.
 *
 * THE ONLY REMAINING HOME FOR THIS LITERAL. Before this task, THREE
 * independent copies existed, one per launch call site: `src/lib/run-launch.ts`'s
 * exported `DEADLINE_SLACK_MS`, `src/worker/run-create-consumer.ts`'s own
 * local copy, and `src/lib/calibration/launch.ts` importing run-launch.ts's.
 * All three sized `EvaluationRun.deadlineAt` AT CREATION, on queue position
 * rather than the run's own work — the defect this whole plan fixes. Once
 * none of them stamp a deadline at creation any more (see
 * `docs/superpowers/plans/2026-09-03-deadline-at-first-dequeue.md`'s Tasks
 * 4-5), `claim.ts`'s first-dequeue stamp is the ONLY remaining place that
 * needs this constant — so it gets ONE definition, here, next to the budget
 * arithmetic it is added to, rather than a fourth independent copy.
 */
export const RUN_DEADLINE_SLACK_MS = 60_000;

/**
 * The run-level budget stamped onto `EvaluationRun.deadlineAt` at FIRST
 * DEQUEUE — see `src/worker/claim.ts`'s `stampRunStartedAtFirstDequeue`, the
 * only caller. Returns a DURATION (milliseconds), not an absolute `Date`,
 * mirroring `leaseMsFor` exactly: the caller combines it with `Date.now()`,
 * which keeps this function pure and testable without faking the clock.
 *
 * `judgmentCount` is the TOTAL number of `ModelJudgment` rows the run was
 * created with — fixed forever once the run exists (nothing in this
 * codebase adds a judgment to a run after creation), so it is safe for the
 * caller to read once, outside any lock, and combine with `Date.now()` at
 * claim time without racing itself. For an ordinary run this is the model
 * count `launchSingleRun` created it with; for a calibration run (A2.1) it
 * is always 1 — one judge, one item, one judgment per `EvaluationRun` — so
 * the deadline this produces is `now + 1 * hardCapMs + slackMs`, roughly 16
 * minutes at the defaults, REGARDLESS of how many OTHER calibration runs
 * are queued ahead of or behind it. That queue-depth independence is the
 * entire point: the OLD formula (deleted from `run-launch.ts` and
 * `calibration/launch.ts`) multiplied this same `hardCapMs` by "judgments
 * queued ahead of this one" — a property of the WHOLE SYSTEM's queue depth
 * at LAUNCH time — instead of by this run's own judgment count, a property
 * of the run itself, fixed at creation and measured from CLAIM time.
 *
 * `hardCapMs`, not `initialBudgetMs` — same reasoning as the deleted
 * creation-time formulas: since the escalating timeout landed
 * (`src/lib/llm/timeout-policy.ts`'s own module doc), a call may
 * legitimately run to the hard cap before anything aborts it, so sizing the
 * deadline on the shorter initial-alert budget would let the reaper
 * force-finalize a judgment that is still legitimately executing.
 */
export function runStartBudgetMs(
  judgmentCount: number,
  budgets: TimeoutBudgets,
  slackMs: number = RUN_DEADLINE_SLACK_MS
): number {
  return judgmentCount * budgets.hardCapMs + slackMs;
}
```

- [ ] **Step 4: run it, confirm green**

```bash
cd /root/judge-arena && npx vitest run tests/lib/timeout-policy.test.ts
```

Expected: `Test Files 1 passed (1)` / `Tests 30 passed (30)` (25 pre-existing + 5 new).

- [ ] **Step 5: INJECTION — prove the hard-cap-not-initial-budget assertion actually discriminates**

Edit `runStartBudgetMs`'s body to read the wrong budget:

```ts
export function runStartBudgetMs(
  judgmentCount: number,
  budgets: TimeoutBudgets,
  slackMs: number = RUN_DEADLINE_SLACK_MS
): number {
  return judgmentCount * budgets.initialBudgetMs + slackMs;
}
```

Run:
```bash
cd /root/judge-arena && npx vitest run tests/lib/timeout-policy.test.ts
```

**Exact expected RED:** the `'CRITICAL: derived from the HARD CAP, not the initial budget...'` test fails both its assertions — `runStartBudgetMs(1, budgets)` now equals `budgets.initialBudgetMs + RUN_DEADLINE_SLACK_MS` exactly (`300000 + 60000 = 360000`, not greater than `initialBudgetMs`), so `toBeGreaterThan(budgets.initialBudgetMs)` fails (`expected 360000 to be greater than 300000` is FALSE the other way — actually `360000 > 300000` is true, so re-check: the SECOND assertion `not.toBe(budgets.initialBudgetMs + RUN_DEADLINE_SLACK_MS)` is the one that fails, since under the injection `runStartBudgetMs(1, budgets)` now EQUALS exactly `budgets.initialBudgetMs + RUN_DEADLINE_SLACK_MS = 360000`). The other 4 new tests also go red because they compute their expected value against `hardCapMs` while the injected code now uses `initialBudgetMs`: `'one judgment...'` expects `15*MINUTE + 60000` but gets `5*MINUTE + 60000`; `'N judgments...'` and `'a custom slack...'` similarly mismatch. Expect `Tests 4 failed | 26 passed (30)` (the `RUN_DEADLINE_SLACK_MS is 60 seconds` test is untouched by this injection and stays green). Restore the file to Step 3's content and re-run Step 4 to confirm green again.

- [ ] **Step 6: gates**

```bash
cd /root/judge-arena && npm run lint && npx tsc --noEmit && npm run test:coverage 2>&1 | tail -20
```
Confirm 0 lint warnings, tsc clean, and `src/lib/llm/**`'s coverage floor (statements 91 / functions 94 / branches 83 / lines 91) is not breached — this new module is fully unit-tested and should raise, not lower, that glob's ratio.

- [ ] **Step 7: commit**

```bash
cd /root/judge-arena && git add src/lib/llm/timeout-policy.ts tests/lib/timeout-policy.test.ts docs/superpowers/plans/2026-09-03-deadline-at-first-dequeue.md
git commit -m "$(cat <<'EOF'
feat(llm): runStartBudgetMs — the pure arithmetic for a run's own execution deadline

Extracts the run-level deadline arithmetic (judgmentCount * hardCapMs +
slack) into a pure, unit-tested function alongside leaseMsFor, so
src/worker/claim.ts's upcoming first-dequeue stamp (Task 2) can stay thin —
src/worker/** is integration-only by this repo's own coverage convention,
so keeping the arithmetic here instead of inline in claim.ts is what keeps
the unit test suite able to actually exercise it. No runtime behaviour
changes yet: nothing calls this function until Task 2.

Gates: lint 0, tsc 0, 1007 unit / n/a (not touched by this task) db / n/a (not touched by this task) integration, coverage 0.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WT7bB4SAZpJtRDEGhpGyRv
EOF
)"
```
(`1007` = the measured `1002` baseline + 5 new tests. If `npx vitest run` prints a different total at Step 4 time, use THAT number — it is the truth, not this plan's arithmetic.)

---

## Task 2: `stampRunStartedAtFirstDequeue` + `clearRunDeadlineOnRequeue` — one invariant, both halves

**Files:**
- Modify: `/root/judge-arena/src/worker/claim.ts` (append new exported function; add one import name)
- Modify: `/root/judge-arena/src/worker/judgment-consumer.ts` (wire the stamp into `executeClaimed`; CLEAR the stamp in the retryable-error disposition; add one import name)
- Modify (Test): `/root/judge-arena/tests/integration/worker-claims.test.ts` (append a new `describe` block after the file's current end, line 830)

**Interfaces:**
- Consumes: `resolveTimeoutBudgets()`, `runStartBudgetMs()` (Task 1, `@/lib/llm/timeout-policy`); `prisma.modelJudgment.count`; `prisma.evaluationRun.updateMany`.
- Produces: `export async function stampRunStartedAtFirstDequeue(runId: string): Promise<void>` — best-effort, idempotent, side-effect only (no return value consumers need). Called from `judgment-consumer.ts`'s `executeClaimed`, wrapped in try/catch (a failure here must never fail the judgment this delivery is about to execute).
- Produces: `export async function clearRunDeadlineOnRequeue(runId: string): Promise<void>` — the other half of the same invariant, called from `judgment-consumer.ts`'s retryable-error disposition. **Both halves are ONE concern and ship in ONE commit:** `deadlineAt` is non-null exactly while the run has a judgment IN FLIGHT. Without the clear, a judgment that fails retryably is reset to `pending` and republished onto the BACK of its lane while the run keeps a deadline sized on ONE hard cap — `src/worker/reaper.ts` then force-finalizes a healthy queued retry as `error: 'reaper: abandoned'`, which is bit-for-bit the defect this plan exists to remove, relocated from the launch path to the retry path. See Step 3's own note for the measured before/after.

- [ ] **Step 0: confirm the anchors**

```bash
cd /root/judge-arena && sed -n '100,110p' src/worker/claim.ts
sed -n '1106,1118p' src/worker/judgment-consumer.ts
```
Also record the coverage denominator BEFORE any edit, because this task adds an uncovered function to a glob with a hard floor:

```bash
cd /root/judge-arena && npm run test:coverage 2>&1 | grep -E 'File|src/worker'
```

Write down `src/worker/**`'s **functions** numerator/denominator. The floor is 53 (`vitest.config.ts:200`) against a
last-measured 56.25, and `claim.ts` IS in this run's denominator (`tests/lib/judgment-consumer-escalation.test.ts`,
`pairwise-execution.test.ts` and `llm-truncation.test.ts` all import `@/worker/judgment-consumer`, which imports
`./claim` at `:184`). 56.25% is exactly 9/16 — if the denominator really is 16, TWO more uncovered functions land at
9/18 = 50%, under the floor. **If that happens: do NOT lower the floor, and do NOT try to thin the functions
further — Task 1 already extracted everything extractable and what remains is Prisma calls, for which this repo has
no unit-test mocking precedent (`grep -ra "vi.mock('@/lib/db')" tests` returns nothing).** The move is to put both
functions in a NEW file `src/lib/run-deadline.ts`, import them into `judgment-consumer.ts` from there, and re-export
them from `src/worker/claim.ts` so the test imports in Step 1 are unchanged: `src/lib/**` outside the
`queue`/`llm`/`realtime`/`auth-guard` globs has no per-glob floor at all and is governed only by the aggregate
functions floor (63 against a measured 65.32), where two functions are noise. Update this task's Files list and its
`git add` line if that branch is taken.

First should show `claimJudgment`'s conditional-update body (`export async function claimJudgment(judgmentId: string): Promise<ClaimResult> {` through `const claim = await prisma.modelJudgment.updateMany(...)`). Second should show the `if (claim === 'retry_claim') { ... nack-requeueing ... }` block ending in `ch.nack(raw, false, true); return; }` followed by `// claim === 'claimed' | 'stale_running' — this delivery owns the row now.` and `const context = await judgmentContextQuery(msg.judgmentId);`. If line numbers differ, re-locate by searching for the `'retry_claim' persisted after one retry` log message.

- [ ] **Step 1: write the failing tests**

Append to `/root/judge-arena/tests/integration/worker-claims.test.ts`, after its current final line 830 (`});`, the closing brace of `describe('worker claim idempotency ...')`):

```ts

describe('claim.ts: stampRunStartedAtFirstDequeue — the run deadline is set at FIRST DEQUEUE, not at creation (2026-09-03 fix)', () => {
  it('the run is created with deadlineAt null, and the FIRST claim stamps it to roughly now + judgmentCount * hardCapMs + slack', async () => {
    const fixture = await createFixture();
    const bystander = await createFixture(); // never claimed
    const judgment = await mkJudgment(fixture.run.id, fixture.version.id, fixture.promptTemplateId);

    const beforeClaim = await prisma.evaluationRun.findUniqueOrThrow({ where: { id: fixture.run.id } });
    // This fixture's run comes from mkEvaluationRun (this file, :201-207),
    // which has NEVER set deadlineAt — so this assertion is green today,
    // before any change, and stays green even if all three launch paths
    // keep stamping at creation. It is the PRECONDITION for the stamp
    // below, not evidence about launchSingleRun; Task 4's
    // tests/db/calibration-link.test.ts and Task 5's run.create test are
    // what pin the launch-time claim, because they drive real launch paths.
    expect(beforeClaim.deadlineAt).toBeNull();

    const claimedAt = Date.now();
    const calls: RunProviderJudgmentInput[] = [];
    const consumer = createJudgmentConsumer({ provider: fakeProvider(calls) });
    const msg: JudgmentExecuteMsg = { judgmentId: judgment.id, runId: fixture.run.id, attempt: 1 };
    await consumer.handle(fakeMessage(msg), fakeChannel());

    const afterClaim = await prisma.evaluationRun.findUniqueOrThrow({ where: { id: fixture.run.id } });
    expect(afterClaim.deadlineAt).not.toBeNull();

    // This run has exactly ONE judgment (the calibration shape) — the
    // budget is 1 hard cap + slack, roughly 16 minutes at the defaults,
    // measured from CLAIM time, not from whenever the run was created.
    const budgets = resolveTimeoutBudgets();
    const expectedMs = runStartBudgetMs(1, budgets);
    const actualMs = afterClaim.deadlineAt!.getTime() - claimedAt;
    expect(actualMs).toBeGreaterThan(expectedMs - 5_000);
    expect(actualMs).toBeLessThan(expectedMs + 5_000);

    // The stamp's guard must be scoped to THIS run's id — a
    // `where: { deadlineAt: null }` with the `id` filter dropped would
    // stamp EVERY never-started run in the system, including this
    // bystander's, and would pass every other assertion above.
    const bystanderAfter = await prisma.evaluationRun.findUniqueOrThrow({ where: { id: bystander.run.id } });
    expect(bystanderAfter.deadlineAt).toBeNull(); // the stamp is scoped to runId
  });

  it('two judgments of the SAME run claimed one after another stamp ONE deadline, sized on BOTH judgments — the second claim does not clobber it', async () => {
    const fixture = await createFixture();
    const judgmentA = await mkJudgment(fixture.run.id, fixture.version.id, fixture.promptTemplateId);
    // A SECOND judge version, not a second judgment on the same one.
    // ModelJudgment's unique index is (runId, judgeModelVersionId, pairOrder)
    // NULLS NOT DISTINCT (hand-edited in
    // prisma/migrations/20260728215410_v2b_idempotency_tighten/migration.sql,
    // verified live), and mkJudgment (this file, :256) leaves pairOrder null —
    // so two judgments on ONE run must differ in judge version or the second
    // create raises P2002 before any assertion in this test ever runs.
    const { version: versionB } = await mkJudgeModelVersion();
    await mkEndpoint(fixture.user.id, versionB.id);
    const judgmentB = await mkJudgment(fixture.run.id, versionB.id, fixture.promptTemplateId);

    const calls: RunProviderJudgmentInput[] = [];
    const consumer = createJudgmentConsumer({ provider: fakeProvider(calls) });

    const claimedAt = Date.now();
    await consumer.handle(
      fakeMessage({ judgmentId: judgmentA.id, runId: fixture.run.id, attempt: 1 } satisfies JudgmentExecuteMsg),
      fakeChannel()
    );
    const afterFirst = await prisma.evaluationRun.findUniqueOrThrow({ where: { id: fixture.run.id } });
    expect(afterFirst.deadlineAt).not.toBeNull();
    const stampedAt = afterFirst.deadlineAt!.getTime();

    // Sized on THIS run's OWN judgment count — TWO, not one. Without this
    // assertion the entire reason runStartBudgetMs takes a judgmentCount is
    // unguarded: a hardcoded `runStartBudgetMs(1, budgets)`, or a count
    // filtered on `status: 'pending'` (which under-counts the moment the
    // first judgment goes 'running' — the natural typo, since every other
    // query in claim.ts filters on status), passes every other assertion in
    // this block.
    const budgets = resolveTimeoutBudgets();
    const expectedMs = runStartBudgetMs(2, budgets);
    const actualMs = stampedAt - claimedAt;
    expect(actualMs).toBeGreaterThan(expectedMs - 10_000);
    expect(actualMs).toBeLessThan(expectedMs + 10_000);

    await consumer.handle(
      fakeMessage({ judgmentId: judgmentB.id, runId: fixture.run.id, attempt: 1 } satisfies JudgmentExecuteMsg),
      fakeChannel()
    );
    const afterSecond = await prisma.evaluationRun.findUniqueOrThrow({ where: { id: fixture.run.id } });

    // Unchanged, to the millisecond — a wrong implementation that stamps
    // unconditionally on every claim (no `deadlineAt: null` guard) would
    // move this forward on the second claim; this proves it does not.
    expect(afterSecond.deadlineAt!.getTime()).toBe(stampedAt);
  });

  it('reclaiming a STALE judgment on a run that has already started does not re-stamp the deadline', async () => {
    const fixture = await createFixture();
    const judgment = await mkJudgment(fixture.run.id, fixture.version.id, fixture.promptTemplateId);

    // claimJudgment() alone does NOT stamp the run — see claim.ts's own doc
    // ("CALLED FROM EXACTLY ONE PLACE"): the stamp is a separate call
    // judgment-consumer.ts's executeClaimed makes. Drive both directly here
    // rather than through handle(), which would also run a fake provider
    // call this test does not need.
    const first = await claimJudgment(judgment.id);
    expect(first).toBe('claimed');
    await stampRunStartedAtFirstDequeue(fixture.run.id);
    const afterFirst = await prisma.evaluationRun.findUniqueOrThrow({ where: { id: fixture.run.id } });
    const stampedAt = afterFirst.deadlineAt!.getTime();

    // Force the row stale (past LEASE_MS) and reclaim the SAME judgment —
    // claim.ts's own 'stale_running' path.
    await prisma.$executeRaw`UPDATE "ModelJudgment" SET "updatedAt" = ${new Date(Date.now() - LEASE_MS - 5_000)} WHERE id = ${judgment.id}`;
    const reclaimed = await claimJudgment(judgment.id);
    expect(reclaimed).toBe('stale_running');
    await stampRunStartedAtFirstDequeue(fixture.run.id);

    const afterReclaim = await prisma.evaluationRun.findUniqueOrThrow({ where: { id: fixture.run.id } });
    expect(afterReclaim.deadlineAt!.getTime()).toBe(stampedAt); // unchanged
  });

  it('a retryable provider failure CLEARS the run deadline — a requeued judgment is queued work, not executing work', async () => {
    const fixture = await createFixture();
    const judgment = await mkJudgment(fixture.run.id, fixture.version.id, fixture.promptTemplateId);

    const { confirmChannel } = await getRabbit();
    await assertTopology(confirmChannel);
    await confirmChannel.purgeQueue(QUEUE_JUDGMENT_RETRY_30S);

    const consumer = createJudgmentConsumer({
      provider: async () => {
        throw new ProviderError('temporary provider hiccup', { kind: 'retryable', provider: 'openai', status: 503 });
      },
    });
    const msg: JudgmentExecuteMsg = { judgmentId: judgment.id, runId: fixture.run.id, attempt: 1 };

    // A SECOND, unrelated run that HAS started — the clear must be scoped to
    // msg.runId. `where: {}` (id filter dropped) nulls every run in the DB
    // and passes every other assertion in this file.
    const bystander = await createFixture();
    const bystanderJudgment = await mkJudgment(bystander.run.id, bystander.version.id, bystander.promptTemplateId);
    await claimJudgment(bystanderJudgment.id);
    await stampRunStartedAtFirstDequeue(bystander.run.id);

    await consumer.handle(fakeMessage(msg), fakeChannel());

    // The claim inside handle() DID stamp a deadline — the run started
    // executing. The retry disposition then reset the judgment to 'pending'
    // and republished it onto the BACK of its own lane (pinned by the
    // pre-existing test at :647 of this file). It is queued again, so the
    // run is not executing any more and must not keep a one-hard-cap budget
    // while its retry waits out the whole queue: src/worker/reaper.ts
    // force-finalizes a still-'pending' judgment 3 sweeps past the deadline
    // and stamps it `error: 'reaper: abandoned'`, which is exactly the
    // healthy-queued-tail kill this plan exists to remove.
    //
    // deadlineAt null here is DISCRIMINATING, not trivially true: mkJudgment
    // + handle() go through the stamp first, so an implementation that
    // stamps and never clears leaves a non-null value.
    const afterRetry = await prisma.evaluationRun.findUniqueOrThrow({ where: { id: fixture.run.id } });
    expect(afterRetry.deadlineAt).toBeNull();

    // The clear must be scoped to msg.runId — a `where: {}` (id filter
    // dropped) would null this bystander's deadline too, and every other
    // assertion in this file would still pass.
    const bystanderAfter = await prisma.evaluationRun.findUniqueOrThrow({ where: { id: bystander.run.id } });
    expect(bystanderAfter.deadlineAt).not.toBeNull();

    // Drain so the republished message does not leak into a later test's
    // queue assertions in this same persistent-DB suite.
    await drainQueue(confirmChannel, QUEUE_JUDGMENT_RETRY_30S);
  });
});
```

(`getRabbit`, `assertTopology`, `QUEUE_JUDGMENT_RETRY_30S`, `drainQueue` and `ProviderError` are all already imported by this file — they are used by the pre-existing retry test at `:647-677`. No new imports beyond the two below.)

Update the file's existing imports (near the top):
```ts
import {
  claimJudgment,
  LEASE_MS,
  stampRunStartedAtFirstDequeue,
} from '@/worker/claim';
```
(`clearRunDeadlineOnRequeue` is exercised only through `consumer.handle()` in test 4 — the retry disposition is the one production caller — and through `stampRunStartedAtFirstDequeue`'s own bystander setup in tests 1 and 4, never by name. It is not imported here.)
and add a new import line:
```ts
import { resolveTimeoutBudgets, runStartBudgetMs } from '@/lib/llm/timeout-policy';
```

- [ ] **Step 2: run it, confirm the exact FAIL**

```bash
cd /root/judge-arena && sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.integration.config.ts tests/integration/worker-claims.test.ts'
```

**Exact expected FAIL:** the file loads (`stampRunStartedAtFirstDequeue` resolves to `undefined` per vite-node's SSR transform, same idiom as Task 1 Step 2 — confirmed by `2026-09-01-consumer-loss-fail-fast.md:319` for a worker-tier file specifically). Test 1 (`'the run is created with deadlineAt null, and the FIRST claim stamps it...'`) fails its SECOND assertion, `expect(afterClaim.deadlineAt).not.toBeNull()` — the run has not been touched by anything new, so it is still null. Test 2 fails identically on its `expect(afterFirst.deadlineAt).not.toBeNull()`. Test 3 throws `TypeError: stampRunStartedAtFirstDequeue is not a function` on its first direct call. Test 4 PASSES for the wrong reason (nothing has ever stamped a deadline on this fixture's run, so `toBeNull()` is trivially true) — that is expected and is why Step 5's third injection, not this step, is what proves test 4 discriminates. Three of the four new tests are red; the pre-existing tests in this file are unaffected. **This step is predicted, not observed by this plan's author — the author's operating constraints exclude running the integration suite.**

- [ ] **Step 3: minimal implementation**

Append to `/root/judge-arena/src/worker/claim.ts`, after `claimJudgment`'s closing `}` (the current final line, 146):

```ts

/**
 * ─── Stamp `EvaluationRun.deadlineAt` at FIRST DEQUEUE ─────────────────────
 *
 * THE FIX documented (and deliberately deferred) in `src/lib/run-launch.ts`'s
 * now-deleted `deadlineAt` JSDoc: every launch path used to stamp
 * `EvaluationRun.deadlineAt` at CREATION, sized on "judgments queued ahead of
 * this one" — a property of the WHOLE SYSTEM's queue depth at launch time,
 * not of this run's own work. `src/worker/reaper.ts` sweeps
 * `deadlineAt < now` and force-finalizes 3 sweeps later; a run created late
 * in a large batch could have its still-healthy, still-queued judgments
 * stamped `error: 'reaper: abandoned'` before a worker ever looked at them —
 * this cost 4 of 30 items on a real calibration and is the reason
 * `MAX_CALIBRATION_ITEMS` was capped at 100 (`src/lib/calibration/launch.ts`).
 *
 * This function stamps the deadline instead at the moment a worker actually
 * claims the run's FIRST judgment — `runStartBudgetMs(judgmentCount, budgets)`
 * milliseconds from THAT moment, not from creation. The deadline is now
 * about THIS run's own work and is immune to how many other runs, batches
 * or users were queued ahead of THIS run's FIRST claim.
 *
 * The limit of that guarantee, stated so it is not over-read: a
 * MULTI-judgment run's budget is `judgmentCount * hardCapMs`, which assumes
 * its judgments execute CONCURRENTLY across their judges' lanes. A run whose
 * judgments span a fast lane and a congested one still has its clock started
 * by the fast one while the slow one waits (lanes are keyed on server
 * ORIGIN, not model — `src/lib/queue/lanes.ts`). That is not a regression:
 * the creation-time deadline it replaces started the same clock strictly
 * EARLIER, at creation. It is the reason `clearRunDeadlineOnRequeue` below
 * exists, and the reason the never-started net in `src/worker/reaper.ts` is
 * sized loosely rather than tightly.
 *
 * ── CALLED FROM EXACTLY ONE PLACE ────────────────────────────────────────
 * `src/worker/judgment-consumer.ts`'s `executeClaimed`, immediately after
 * `claimJudgment()` resolves to `'claimed'` or `'stale_running'` — i.e.
 * every time THIS delivery actually owns the judgment row and is about to
 * execute it. Not folded into `claimJudgment()` itself: that function's
 * contract (`ClaimResult`, its five-way return) is unrelated to which RUN
 * the judgment belongs to and is exercised by its own well-established
 * tests; this is an independent, separately-testable concern that happens
 * to be triggered by the same event. Any FUTURE caller of `claimJudgment()`
 * must also call this on a `'claimed'`/`'stale_running'` result — there is
 * exactly one caller today, so that obligation costs nothing to satisfy,
 * but it is not enforced by the type system and is recorded here so it
 * isn't missed.
 *
 * ── ATOMICITY: WHY A CONCURRENT CLAIM CANNOT RE-STAMP OR CLOBBER ───────────
 * A single conditional `updateMany` — `WHERE id = $1 AND "deadlineAt" IS
 * NULL` — is the entire guard, the same idiom `claimJudgment`'s own
 * `pending -> running` transition uses a few lines above it, and the same
 * idiom `run-finalizer.ts`'s `markRunCompleted` uses for its
 * `needs_human -> completed` guard. Two judgments of the SAME run claimed
 * concurrently by two different workers both call this function; both read
 * the SAME `judgmentCount` (an `EvaluationRun`'s judgment rows are fixed at
 * creation — nothing in this codebase ever adds one afterwards — so the
 * value cannot itself be racing), and both issue the UPDATE. Postgres locks
 * the row for whichever UPDATE reaches it first; the SECOND UPDATE blocks
 * on that lock, and once it acquires it, re-evaluates its OWN `WHERE`
 * clause against the row AS IT NOW STANDS — already committed, already
 * non-null — and therefore matches ZERO rows. `updateMany` returns
 * `{ count: 0 }` and this function returns without touching anything.
 * Exactly one caller's write survives; the other is a correctly-recognized
 * no-op, not a lost update masked by a last-writer-wins race — there is no
 * window in which both writes are "in flight" against the same row,
 * because the second one's WHERE clause is evaluated AFTER the lock, not
 * against a stale snapshot taken before it. (`default_transaction_isolation`
 * on the production database is `read committed`, measured 2026-09-03;
 * Postgres's EvalPlanQual re-check is what makes the post-lock re-evaluation
 * true rather than hopeful.)
 *
 * HONESTY ABOUT WHAT IS TESTED: the tests in
 * `tests/integration/worker-claims.test.ts` drive two claims SEQUENTIALLY,
 * so they prove idempotence, not the concurrent case. The concurrent claim
 * above is Postgres semantics plus the same idiom `claimJudgment` already
 * ships, not something this plan's tests demonstrate. A deliberately
 * non-discriminating test was NOT added for it: the observable difference
 * between this guarded UPDATE and a read-then-write under a real race is a
 * few milliseconds of `deadlineAt`, which no assertion can separate from
 * scheduling noise.
 *
 * Best-effort by design: the caller wraps this in a try/catch and logs
 * rather than fails the judgment on error (see judgment-consumer.ts's
 * `executeClaimed`). A run whose deadline never gets stamped (this call
 * throws, or is never reached because the process dies between claim and
 * this line) is covered — but SLOWLY: `src/worker/reaper.ts`'s
 * `NEVER_STARTED_TIMEOUT_MS` treats a null-deadline row as "never started"
 * and sweeps it at 45 DAYS, where the creation-time deadline this replaces
 * would have republished it in ~16 minutes. A crash between the claim and
 * this line is the better-covered case: the judgment is `running`, so
 * `reclaimStaleJudgments` picks it up at `LEASE_MS`, not at the net.
 */
export async function stampRunStartedAtFirstDequeue(runId: string): Promise<void> {
  const judgmentCount = await prisma.modelJudgment.count({ where: { runId } });
  const budgets = resolveTimeoutBudgets();
  const deadlineAt = new Date(Date.now() + runStartBudgetMs(judgmentCount, budgets));

  await prisma.evaluationRun.updateMany({
    where: { id: runId, deadlineAt: null },
    data: { deadlineAt },
  });
}

/**
 * ─── The other half of the same invariant ─────────────────────────────────
 *
 * `deadlineAt` is non-null EXACTLY WHILE the run has a claimed judgment in
 * flight. `stampRunStartedAtFirstDequeue` sets it when execution starts;
 * this clears it when execution stops without the run finishing.
 *
 * ── WHY THIS IS NOT OPTIONAL ──────────────────────────────────────────────
 * `src/worker/judgment-consumer.ts`'s retryable-error disposition resets a
 * failed judgment to `status: 'pending'` and republishes it through the
 * 30s/5m delay exchange, which delivers it to the BACK of the same
 * single-consumer judge lane. That judgment is queued work again, not
 * executing work. Leave the run's deadline in place and it still says "one
 * hard cap from the FIRST claim" (~16 minutes for a calibration run's single
 * judgment) while the retry waits out every item ahead of it — hours for a
 * 30-item batch, DAYS at `MAX_CALIBRATION_ITEMS = 1000`. `src/worker/reaper.ts`
 * force-finalizes 3 sweeps past the deadline by stamping every still-`pending`
 * judgment `error: 'reaper: abandoned'`, so the healthy queued retry is
 * killed and recorded as an abandonment: bit-for-bit the 4-of-30 failure this
 * whole change exists to remove, relocated from the launch path to the retry
 * path. It would have been a REGRESSION, not a pre-existing hole — the
 * creation-time formula this plan deletes gave a 30-item calibration batch
 * `launch + 30 x hardCapMs`, i.e. 7.5 hours, which covered the requeue.
 *
 * Clearing restores the "not started" state the stamp's own guard tests for,
 * so the NEXT claim re-stamps a FRESH budget measured from when the work
 * actually resumes. Between the clear and that next claim the run is bounded
 * by `src/worker/reaper.ts`'s `NEVER_STARTED_TIMEOUT_MS`, and any SIBLING
 * judgment still genuinely `running` is bounded by `reclaimStaleJudgments`
 * at `LEASE_MS` — so clearing does not make a run immortal.
 *
 * Unconditional, not guarded: the run is being put back in the queue whatever
 * its current deadline says. Best-effort, exactly like the stamp — a failure
 * here must never fail the disposition it is part of.
 */
export async function clearRunDeadlineOnRequeue(runId: string): Promise<void> {
  await prisma.evaluationRun.updateMany({
    where: { id: runId },
    data: { deadlineAt: null },
  });
}
```

Update `claim.ts`'s existing import line:
```ts
import { leaseMsFor, resolveTimeoutBudgets, runStartBudgetMs } from '@/lib/llm/timeout-policy';
```

In `/root/judge-arena/src/worker/judgment-consumer.ts`, change the import at line 184:
```ts
import { claimJudgment } from './claim';
```
to:
```ts
import { claimJudgment, clearRunDeadlineOnRequeue, stampRunStartedAtFirstDequeue } from './claim';
```

And in `executeClaimed`, replace:
```ts
    if (claim === 'retry_claim') {
      // Still unresolved after one retry — nack-requeue rather than loop
      // claim attempts inline or ack-drop a possibly-still-claimable row.
      logger.warn('claimJudgment: retry_claim persisted after one retry — nack-requeueing', {
        judgmentId: msg.judgmentId,
      });
      ch.nack(raw, false, true);
      return;
    }
    // claim === 'claimed' | 'stale_running' — this delivery owns the row now.

    const context = await judgmentContextQuery(msg.judgmentId);
```
with:
```ts
    if (claim === 'retry_claim') {
      // Still unresolved after one retry — nack-requeue rather than loop
      // claim attempts inline or ack-drop a possibly-still-claimable row.
      logger.warn('claimJudgment: retry_claim persisted after one retry — nack-requeueing', {
        judgmentId: msg.judgmentId,
      });
      ch.nack(raw, false, true);
      return;
    }
    // claim === 'claimed' | 'stale_running' — this delivery owns the row now.

    // THE REAPER FIX (see claim.ts's own doc): stamp the run's execution
    // deadline at FIRST DEQUEUE, not at creation. Best-effort and isolated
    // — a failure here must never fail the judgment this delivery is about
    // to execute; src/worker/reaper.ts's NEVER_STARTED_TIMEOUT_MS is the
    // safety net covering a run whose deadline never gets stamped at all.
    try {
      await stampRunStartedAtFirstDequeue(msg.runId);
    } catch (error) {
      logger.error(
        'stampRunStartedAtFirstDequeue failed — continuing (the never-started safety net covers this run instead)',
        { runId: msg.runId, judgmentId: msg.judgmentId, error: serializeError(error) }
      );
    }

    const context = await judgmentContextQuery(msg.judgmentId);
```

**Second edit in the same file — the retryable-error disposition.** In the same
`executeClaimed`, replace (current lines 1296-1301):

```ts
      await prisma.modelJudgment.update({
        where: { id: msg.judgmentId },
        data: { status: 'pending', error: providerError.message },
      });

      const nextMsg: JudgmentExecuteMsg = { ...msg, attempt: effectiveAttempt + 1 };
```
with:
```ts
      await prisma.modelJudgment.update({
        where: { id: msg.judgmentId },
        data: { status: 'pending', error: providerError.message },
      });

      // The judgment is going back on the lane BEHIND everything already
      // queued — it is not executing any more, so neither is the run. See
      // claim.ts's clearRunDeadlineOnRequeue doc: without this the run keeps
      // a one-hard-cap budget while its retry waits out the whole queue, and
      // src/worker/reaper.ts force-finalizes healthy queued work as
      // 'reaper: abandoned'. Best-effort, same as the stamp above.
      try {
        await clearRunDeadlineOnRequeue(msg.runId);
      } catch (error) {
        logger.error('clearRunDeadlineOnRequeue failed — the run keeps a stale execution deadline', {
          runId: msg.runId,
          judgmentId: msg.judgmentId,
          error: serializeError(error),
        });
      }

      const nextMsg: JudgmentExecuteMsg = { ...msg, attempt: effectiveAttempt + 1 };
```
(`logger` and `serializeError` are already imported at `:156`; `prisma` at `:155`.
The `markJudgmentError` + DLQ branch a few lines above is deliberately NOT
touched: that path is terminal and calls `safeFinalizeRun`, so the run stops
being `pending`/`judging` and leaves the sweep's candidate set on its own.)

- [ ] **Step 4: run it, confirm green**

```bash
cd /root/judge-arena && sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.integration.config.ts tests/integration/worker-claims.test.ts'
```
Expected: all four new tests pass; every pre-existing test in the file is unaffected (both new `try`/`catch` blocks wrap calls that touch only `EvaluationRun.deadlineAt`, a column no pre-existing test in this file reads — the stamp runs before `judgmentContextQuery`, the clear runs inside the retryable-error disposition after the row is already reset to `pending`).

- [ ] **Step 5: INJECTION — the atomicity guard**

Edit `stampRunStartedAtFirstDequeue`'s `updateMany` to drop the guard:
```ts
  await prisma.evaluationRun.updateMany({
    where: { id: runId },
    data: { deadlineAt },
  });
```

Run:
```bash
cd /root/judge-arena && sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.integration.config.ts tests/integration/worker-claims.test.ts'
```

**Exact expected RED:** the `'two judgments of the SAME run claimed one after another stamp ONE deadline...'` test fails — `afterSecond.deadlineAt!.getTime()` is now LATER than `stampedAt` (the second claim unconditionally overwrites it), so `expect(afterSecond.deadlineAt!.getTime()).toBe(stampedAt)` fails with `expected <later-timestamp> to be <stampedAt>`. The `'reclaiming a STALE judgment...'` test fails the same way (`afterReclaim.deadlineAt` moves forward on the reclaim's stamp call). Tests 1 and 4 stay green — the bug only manifests on a SECOND stamp attempt. Restore Step 3's guarded `where: { id: runId, deadlineAt: null }` and re-run Step 4 to confirm green again.

- [ ] **Step 5b: INJECTION — the judgmentCount really is THIS run's count**

Replace the count with a constant:
```ts
  const judgmentCount = 1;
```

**Exact expected RED:** test 2 ONLY. Its `expect(actualMs).toBeGreaterThan(expectedMs - 10_000)` now compares one budget against two — at the defaults, `~960_000` against `>1_850_000`, so it fails as `expected 960xxx to be greater than 1850000`. Tests 1, 3 and 4 stay green: their runs really do have exactly one judgment. Restore `await prisma.modelJudgment.count({ where: { runId } })` and re-run Step 4.

(A second, equally likely mis-implementation to try if you want the belt: `count({ where: { runId, status: 'pending' } })`. It reddens test 2 the same way, because the first judgment is `'running'` by the time the stamp reads the count.)

- [ ] **Step 5c: INJECTION — the requeue really does clear the deadline**

Delete the `try { await clearRunDeadlineOnRequeue(msg.runId); } catch { ... }` block from `judgment-consumer.ts`'s retryable-error disposition.

**Exact expected RED:** the `'a retryable provider failure CLEARS the run deadline...'` test fails as `expected 2026-...T...Z to be null` — the stamp from the claim survives the requeue. Every other test in this file stays green, including the pre-existing `'a retryable provider failure on attempt 1 resets the judgment to pending...'` test at `:647`, which does not read `deadlineAt`. **If it stays GREEN, stop and diagnose** — that would mean the stamp never fired, which makes test 4 non-discriminating and is a finding, not a formality (Global Constraints). Restore the block and re-run Step 4.

- [ ] **Step 5d: INJECTION — both writes are scoped to THIS run, not to every run**

Edit `clearRunDeadlineOnRequeue`'s `updateMany` to drop the row filter entirely:
```ts
export async function clearRunDeadlineOnRequeue(runId: string): Promise<void> {
  await prisma.evaluationRun.updateMany({
    where: {},
    data: { deadlineAt: null },
  });
}
```

Run:
```bash
cd /root/judge-arena && sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.integration.config.ts tests/integration/worker-claims.test.ts'
```

**Exact expected RED:** test 4 only (`'a retryable provider failure CLEARS the run deadline...'`) — `bystanderAfter.deadlineAt` is now `null` too (every row in the table was nulled), so `expect(bystanderAfter.deadlineAt).not.toBeNull()` fails as `expected null to not be null`. Every other test in this file stays green. Restore `where: { id: runId }` and re-run Step 4 to confirm green again.

Then edit `stampRunStartedAtFirstDequeue`'s `updateMany` to drop the `id` filter, keeping only the null guard:
```ts
  await prisma.evaluationRun.updateMany({
    where: { deadlineAt: null },
    data: { deadlineAt },
  });
```

Run the same command again.

**Exact expected RED:** test 1 only (`'the run is created with deadlineAt null, and the FIRST claim stamps it...'`) — the stamp now matches every never-started run in the table, including the bystander, so `expect(bystanderAfter.deadlineAt).toBeNull()` fails as `expected 2026-...T...Z to be null`. Every other test stays green. Restore `where: { id: runId, deadlineAt: null }` and re-run Step 4 to confirm green again.

- [ ] **Step 6: gates**

```bash
cd /root/judge-arena && npm run lint && npx tsc --noEmit && npm run test:coverage 2>&1 | tail -25
```
Confirm `src/worker/**`'s floor (statements 14 / functions 53 / branches 87 / lines 14) is not breached by the two new, unit-uncovered functions and the two new try/catch blocks in `judgment-consumer.ts` (the arithmetic itself lives in the already-unit-tested `timeout-policy.ts`, per Task 1's own rationale). **Compare against the numerator/denominator recorded in Step 0.** If the `functions` floor IS breached, do not lower it and do not thin further — take Step 0's stated escape hatch (move both functions to `src/lib/run-deadline.ts` and re-export from `claim.ts`). Record the printed unit total too: this task adds no unit tests, but it re-measures the glob, so the commit's Gates line must state the number, not `n/a`.

```bash
cd /root/judge-arena && npm run test:integration
```
Confirm the full integration suite is green, not just the one file. Predicted total: 82 + 4 = **86** (files unchanged). *(A prediction to check against, not the assertion — if the run prints a different total, use THAT number and treat an unexplained delta as a finding.)*

- [ ] **Step 7: commit**

```bash
cd /root/judge-arena && git add src/worker/claim.ts src/worker/judgment-consumer.ts tests/integration/worker-claims.test.ts
git commit -m "$(cat <<'EOF'
feat(worker): stamp EvaluationRun.deadlineAt at first dequeue, not at creation

Adds claim.ts's stampRunStartedAtFirstDequeue, called from
judgment-consumer.ts's executeClaimed immediately after a successful
claim. A single guarded updateMany (WHERE id = $1 AND deadlineAt IS NULL)
makes the stamp idempotent — proven by injection (dropping the guard lets
a second claim clobber the first stamp). A second injection pins that the
budget is sized on THIS run's own judgment count, not a hardcoded 1.

Adds the other half of the same invariant, clearRunDeadlineOnRequeue,
called from the retryable-error disposition: a judgment reset to pending
and republished onto the back of its lane is queued work, not executing
work, so the run's execution deadline is cleared and re-stamped fresh on
the next claim. Without it a retried calibration judgment would carry a
~16-minute budget while waiting out a queue measured in hours or days,
and the reaper would force-finalize it as 'reaper: abandoned' — the exact
healthy-queued-tail kill this change removes from the launch path.

The STAMP is dormant on its own: every launch path still stamps deadlineAt
at creation (Tasks 4-5 remove that), so its WHERE clause never matches
today — count: 0, always, until then. The CLEAR is NOT dormant: it fires
on the first retryable provider error against any run the stamp has
touched, unconditionally NULLing that run's deadlineAt. Landed before
Tasks 4-5 deliberately, but this commit alone leaves the tree safe only if
Task 3 (the never-started safety net) follows immediately — without it, a
run cleared by this commit is invisible to the pre-Task-3 sweep predicate
(`deadlineAt: { lt: now }` never matches NULL) and is stranded
`pending`/`judging` permanently. See this plan's Depends-on section for
the exact safe/unsafe prefixes.

Gates: lint 0, tsc 0, 1007 unit (no new unit tests; src/worker/** re-measured) / n/a (not touched by this task) db / 86 integration, coverage 0.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WT7bB4SAZpJtRDEGhpGyRv
EOF
)"
```

---

## Task 3: `NEVER_STARTED_TIMEOUT_MS` — close the null-deadline leak

**Files:**
- Modify: `/root/judge-arena/src/worker/reaper.ts` (new exported constant; rewrite `sweepOverdueRuns`; module-doc addendum)
- Modify (Test): `/root/judge-arena/tests/integration/finalization.test.ts` (extend `mkEvaluationRun`'s overrides type; append a new `describe` block)

**Interfaces:**
- Consumes: `prisma.evaluationRun.findMany` (query gains an `OR` arm); nothing new from outside the file.
- Produces: `export const NEVER_STARTED_TIMEOUT_MS = 45 * 24 * 60 * 60 * 1000;` (45 days — sized on the LEGAL per-batch bound, see Step 3). `sweepOverdueRuns` (not exported, unchanged signature) now catches two disjoint populations under one disposition. The two `OR` arms cannot both match one row: arm 1 needs `deadlineAt < now`, which is UNKNOWN (no match) for NULL; arm 2 needs `deadlineAt IS NULL`. Disjoint by construction.

- [ ] **Step 0: confirm the anchors**

```bash
cd /root/judge-arena && sed -n '99,104p' src/worker/reaper.ts
sed -n '301,323p' src/worker/reaper.ts
sed -n '193,209p' tests/integration/finalization.test.ts
```
First: the `FORCE_FINALIZE_GRACE_MS` const. Second: `sweepOverdueRuns`'s current body (query + loop, ending `}`). Third: `mkEvaluationRun`'s current `overrides` type (`status`, `deadlineAt`, `finalizedAt`). If these don't match, re-locate before proceeding.

**Then a MANDATORY read-only gate against production, because this task makes an existing, currently-inert row
population reachable for the first time.** `scripts/importer/runs.ts:384` writes `deadlineAt: null` explicitly, on a
row whose `status` (`:369`) may be `'pending'`/`'judging'` and whose `createdAt` (`:387`) is preserved verbatim from
the v1 run (see Task 0's corrected point 1). Those rows are invisible to today's reaper. The moment this task's
second `OR` arm lands, any of them older than `NEVER_STARTED_TIMEOUT_MS` is republished onto a LIVE judge lane —
real, billed provider calls for imported v1 judgments that were never meant to execute — and force-finalized 180 s
later. Run:

```bash
kubectl -n tenant-public exec judge-arena-pg-1 -c postgres -- psql -U postgres -d judge_arena -tAc \
  "select count(*) from \"EvaluationRun\" where status in ('pending','judging') and \"deadlineAt\" is null;"
```

**Expect `0`** (measured 2026-09-03: `0`). A non-zero count is that imported-v1 population — **STOP and decide
explicitly what to do with those rows before landing this task.** This is read-only; the decision and any write are
the operator's, never this plan's.

- [ ] **Step 1: write the failing tests**

Edit `mkEvaluationRun` in `/root/judge-arena/tests/integration/finalization.test.ts`:
```ts
async function mkEvaluationRun(
  evaluationId: string,
  triggeredById: string,
  rubricId: string,
  overrides: Partial<{
    status: 'pending' | 'judging' | 'needs_human' | 'completed' | 'error';
    deadlineAt: Date | null;
    finalizedAt: Date | null;
    createdAt: Date;
  }> = {}
) {
  const run = await prisma.evaluationRun.create({
    data: { evaluationId, triggeredById, rubricId, ...overrides },
  });
  createdRunIds.push(run.id);
  return run;
}
```
(Only the `createdAt: Date;` line is new — `createdAt` is a plain `@default(now())` column, directly settable in `create()`, unlike `ModelJudgment.updatedAt`'s `@updatedAt` special-casing.)

Update the file's existing `import { runReaperSweep, REAPER_LOCK_KEY } from '@/worker/reaper';` to:
```ts
import { runReaperSweep, REAPER_LOCK_KEY, NEVER_STARTED_TIMEOUT_MS } from '@/worker/reaper';
```
and add two imports for the relationship guard:
```ts
import { MAX_CALIBRATION_ITEMS } from '@/lib/calibration/launch';
import { resolveTimeoutBudgets } from '@/lib/llm/timeout-policy';
```
(`@/lib/calibration/launch`'s import graph is `@prisma/client`, `@/lib/db`, `@/lib/logger`, `@/lib/golden-sets`, `@/lib/calibration/latency`, `@/lib/llm/timeout-policy`, `@/lib/llm/sampling`, `@/lib/run-launch` — all already loadable in the integration tier, which already imports `@/lib/run-finalizer` and `@/lib/db`. If it nonetheless fails to load, that is a finding: stop and diagnose rather than deleting the guard.)

Append a new `describe` block after the file's existing `describe('reaper (src/worker/reaper.ts): overdue-run handling', ...)` block closes. **On HEAD `ceb2d0a` that describe spans lines 518-607 and its final `});` is line 607; `describe('dataset summary recompute race ...')` follows at 609 and the file ends at 657 — so append BETWEEN them (at line 608), not at the file's absolute end.** If the numbers have moved, locate the matching closing brace for that describe rather than trusting them:

```ts

describe('reaper (src/worker/reaper.ts): the never-started safety net (deadlineAt IS NULL)', () => {
  it('NEVER_STARTED_TIMEOUT_MS is 45 days', () => {
    expect(NEVER_STARTED_TIMEOUT_MS).toBe(45 * 24 * 60 * 60 * 1000);
  });

  it('the never-started net outlasts the LEGAL drain time of a full-cap calibration batch', () => {
    // The RELATIONSHIP, not a second literal — this repo's own idiom (cf.
    // tests/lib/timeout-policy.test.ts:320, `LEASE_MS > hardCapMs`). A
    // calibration serialises through ONE judge's gate; each item may legally
    // run to hardCapMs and be delivered MAX_ATTEMPTS (3) times. If someone
    // raises MAX_CALIBRATION_ITEMS again without revisiting this net, this
    // goes red instead of silently re-arming the bug the net exists to
    // prevent — a batch force-finalized while still healthily queued.
    // The 3 mirrors judgment-consumer.ts:199's MAX_ATTEMPTS (not exported).
    // Raising that number invalidates NEVER_STARTED_TIMEOUT_MS and must
    // move this literal too.
    const legalWorstCaseMs = MAX_CALIBRATION_ITEMS * 3 * resolveTimeoutBudgets().hardCapMs;
    expect(NEVER_STARTED_TIMEOUT_MS).toBeGreaterThan(legalWorstCaseMs);
  });

  it('a run created long before NEVER_STARTED_TIMEOUT_MS, never dequeued, past the grace period is force-finalized', async () => {
    const base = await createBaseFixture();
    const evaluation = await mkEvaluation(base.project.id, base.user.id);
    // Never started: deadlineAt stays null (nothing has claimed a
    // judgment), createdAt is far enough in the past that even
    // NEVER_STARTED_TIMEOUT_MS + the 180s grace has elapsed.
    const createdAt = new Date(Date.now() - NEVER_STARTED_TIMEOUT_MS - 200_000);
    const run = await mkEvaluationRun(evaluation.id, base.user.id, base.rubric.id, {
      status: 'pending',
      deadlineAt: null,
      createdAt,
    });
    const judgment = await mkJudgment(run.id, base.version.id, base.promptTemplateId, { status: 'pending' });

    const { confirmChannel } = await getRabbit();
    await assertTopology(confirmChannel);
    await purgeExecuteQueues(confirmChannel);

    await runReaperSweep();

    const afterSweep = await prisma.modelJudgment.findUniqueOrThrow({ where: { id: judgment.id } });
    expect(afterSweep.status).toBe('error');
    expect(afterSweep.error).toBe('reaper: abandoned');

    const persistedRun = await prisma.evaluationRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(persistedRun.status).toBe('error');
    expect(persistedRun.finalizedAt).not.toBeNull();
  });

  it('a run created recently, never dequeued, is left alone — this is the queued-but-healthy case the whole task exists to protect', async () => {
    const base = await createBaseFixture();
    const evaluation = await mkEvaluation(base.project.id, base.user.id);
    const run = await mkEvaluationRun(evaluation.id, base.user.id, base.rubric.id, {
      status: 'pending',
      deadlineAt: null,
      // createdAt defaults to now() — well inside NEVER_STARTED_TIMEOUT_MS.
    });
    const judgment = await mkJudgment(run.id, base.version.id, base.promptTemplateId, { status: 'pending' });

    const { confirmChannel } = await getRabbit();
    await assertTopology(confirmChannel);
    await purgeExecuteQueues(confirmChannel);

    await runReaperSweep();

    const afterSweep = await prisma.modelJudgment.findUniqueOrThrow({ where: { id: judgment.id } });
    expect(afterSweep.status).toBe('pending'); // untouched — not even swept

    const persistedRun = await prisma.evaluationRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(persistedRun.status).toBe('pending'); // untouched

    // Not even a republish — this row was never in the sweep's candidate
    // set at all (the query's OR excludes it).
    const published = await drainExecuteQueues(confirmChannel, 200);
    const relevant = published.filter(
      (m) => (JSON.parse(m.content.toString()) as JudgmentExecuteMsg).judgmentId === judgment.id
    );
    expect(relevant).toHaveLength(0);
  });

  it('a STARTED run (deadlineAt set, in the future) with an ancient createdAt is governed by its execution deadline, not the never-started net', async () => {
    const base = await createBaseFixture();
    const evaluation = await mkEvaluation(base.project.id, base.user.id);
    // deadlineAt is set and comfortably in the FUTURE — this run has begun
    // executing and is well within its own budget — even though createdAt
    // is older than NEVER_STARTED_TIMEOUT_MS. A wrong implementation that
    // ORs on createdAt unconditionally (forgetting the `deadlineAt: null`
    // guard on the second arm) would catch and republish for this run;
    // the real one must not touch it at all.
    const run = await mkEvaluationRun(evaluation.id, base.user.id, base.rubric.id, {
      status: 'judging',
      deadlineAt: new Date(Date.now() + 10 * 60_000),
      createdAt: new Date(Date.now() - NEVER_STARTED_TIMEOUT_MS - 200_000),
    });
    const judgment = await mkJudgment(run.id, base.version.id, base.promptTemplateId, { status: 'pending' });

    const { confirmChannel } = await getRabbit();
    await assertTopology(confirmChannel);
    await purgeExecuteQueues(confirmChannel);

    await runReaperSweep();

    const afterSweep = await prisma.modelJudgment.findUniqueOrThrow({ where: { id: judgment.id } });
    expect(afterSweep.status).toBe('pending'); // not force-errored

    const persistedRun = await prisma.evaluationRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(persistedRun.status).toBe('judging'); // untouched — deadlineAt is in the future

    const published = await drainExecuteQueues(confirmChannel, 200);
    const relevant = published.filter(
      (m) => (JSON.parse(m.content.toString()) as JudgmentExecuteMsg).judgmentId === judgment.id
    );
    expect(relevant).toHaveLength(0); // not even a republish — outside the sweep's candidate set
  });

  it('a never-started run just PAST the net but inside the grace period is REPUBLISHED, not force-finalized', async () => {
    const base = await createBaseFixture();
    const evaluation = await mkEvaluation(base.project.id, base.user.id);
    // Past NEVER_STARTED_TIMEOUT_MS by 30s — so the second arm matches — but
    // well inside FORCE_FINALIZE_GRACE_MS (180s), so the gentler branch must
    // run. This is the ONLY test that pins WHICH branch the substituted
    // threshold selects: `run.deadlineAt ?? new Date(0)` (force-finalize
    // everything the second arm catches, never republish) passes every other
    // test in this block and the whole pre-existing suite.
    const createdAt = new Date(Date.now() - NEVER_STARTED_TIMEOUT_MS - 30_000);
    const run = await mkEvaluationRun(evaluation.id, base.user.id, base.rubric.id, {
      status: 'pending',
      deadlineAt: null,
      createdAt,
    });
    const judgment = await mkJudgment(run.id, base.version.id, base.promptTemplateId, { status: 'pending' });

    const { confirmChannel } = await getRabbit();
    await assertTopology(confirmChannel);
    await purgeExecuteQueues(confirmChannel);

    await runReaperSweep();

    const afterSweep = await prisma.modelJudgment.findUniqueOrThrow({ where: { id: judgment.id } });
    expect(afterSweep.status).toBe('pending'); // NOT 'reaper: abandoned'
    expect(afterSweep.error).toBeNull();

    const persistedRun = await prisma.evaluationRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(persistedRun.status).toBe('pending');
    expect(persistedRun.finalizedAt).toBeNull();

    const published = await drainExecuteQueues(confirmChannel, 200);
    const relevant = published.filter(
      (m) => (JSON.parse(m.content.toString()) as JudgmentExecuteMsg).judgmentId === judgment.id
    );
    expect(relevant).toHaveLength(1); // republished exactly once
  });
});
```

**Honesty note on test 2 ('a run created recently, never dequeued, is left alone'):** it does NOT discriminate old code from new — a recent-`createdAt`, null-`deadlineAt` row was already excluded by the original `deadlineAt: { lt: now }` predicate. But it IS the only guard against the most likely mis-implementation of THIS task: writing the second arm as a bare `{ deadlineAt: null }` with the `createdAt` clause forgotten, i.e. a net that fires on every never-started run immediately. Step 5b injects exactly that. (Step 5 targets the pair of tests that discriminate the null guard; Step 5c targets the threshold branch.)

- [ ] **Step 2: run it, confirm the exact FAIL**

```bash
cd /root/judge-arena && sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.integration.config.ts tests/integration/finalization.test.ts'
```

**Exact expected FAIL:** `NEVER_STARTED_TIMEOUT_MS` resolves to `undefined` (missing named export, same vite-node idiom as Tasks 1-2), so `'NEVER_STARTED_TIMEOUT_MS is 45 days'` fails as `expected undefined to be 3888000000`, the relationship guard fails as `expected undefined to be greater than 270000000` (`100 x 3 x 900_000` — `MAX_CALIBRATION_ITEMS` is still 100 at this point; Task 6 is what makes this guard load-bearing), and every test that computes `Date.now() - NEVER_STARTED_TIMEOUT_MS - 200_000` produces `Date.now() - NaN - 200_000 = NaN`, so `new Date(NaN)` is an Invalid Date passed to Prisma — expect a Prisma validation error (`Argument createdAt: Invalid value provided...` or similar) rather than a clean assertion failure for the remaining tests. **This step is predicted, not observed** (see the plan-wide note on read-only authoring constraints).

- [ ] **Step 3: minimal implementation**

In `/root/judge-arena/src/worker/reaper.ts`, insert after `FORCE_FINALIZE_GRACE_MS`'s declaration (current lines 99-103):

```ts

/**
 * How long an `EvaluationRun` may sit `pending`/`judging` with ZERO
 * judgments ever dequeued before the reaper treats it as abandoned, even
 * though `deadlineAt` is still `null`.
 *
 * ── THE LEAK THIS CLOSES ─────────────────────────────────────────────────
 * `sweepOverdueRuns`'s query used to be `deadlineAt: { lt: now }` alone.
 * Under SQL's three-valued logic, `NULL < now` evaluates to `NULL`, which a
 * `WHERE` clause treats as "no match" — so a row with `deadlineAt: null`
 * was ALREADY, silently, invisible to this query, and the
 * `run.deadlineAt !== null` guard that used to sit inside the loop below it
 * was dead code protecting against a state that could never occur, because
 * every launch path always stamped a deadline at creation. Once
 * `src/lib/run-launch.ts`, `src/lib/calibration/launch.ts` and
 * `src/worker/run-create-consumer.ts` stop doing that and leave
 * `deadlineAt` null until `src/worker/claim.ts`'s
 * `stampRunStartedAtFirstDequeue` sets it at FIRST DEQUEUE, that dormant
 * state becomes reachable on every single run: a `judgment.execute`
 * message that is published and then never claimed — a dead consumer at
 * publish time, a message lost between the broker and a worker, a purged
 * queue — leaves its `EvaluationRun` with `deadlineAt: null` FOREVER.
 * Nothing would ever sweep it. It would sit `pending` indefinitely — for a
 * calibration, permanently blocking that item from ever being scored, with
 * no error, no alert, and no operator-visible signal that anything is
 * wrong.
 *
 * ── WHY A SEPARATE, MUCH LARGER CONSTANT THAN THE EXECUTION DEADLINE ───────
 * The execution deadline (`deadlineAt`, once stamped) bounds "how long has
 * THIS run been executing since ITS OWN first dequeue" — a TIGHT bound,
 * sized on the run's own judgment count (`runStartBudgetMs`, ~16 minutes
 * for a calibration's one judgment). This constant bounds something
 * categorically different: "how long has this run sat with ZERO progress
 * since it was CREATED" — and unlike the execution deadline, it has NO way
 * to size itself against the run's own work, because the run hasn't
 * started any work yet. The only information available is queue depth — of
 * every OTHER run competing for the same judge, launched by every other
 * user — which is exactly the thing this whole task exists to stop
 * depending on for the execution deadline. So this net is deliberately
 * loose rather than tight: it must outlast the longest LEGITIMATE queue
 * wait in the system, or it reintroduces the exact bug this task fixes,
 * just relocated from "queue position" to "batch size".
 *
 * ── THE NUMBER, AND THE ARITHMETIC BEHIND IT ────────────────────────────
 * Sized on what a batch may LEGALLY take, NOT on measured throughput — the
 * same hard-cap-not-initial-budget discipline `runStartBudgetMs` uses. A
 * calibration serialises through ONE judge's gate
 * (`src/worker/judgment-consumer.ts`'s per-judge permit); each item may
 * legally run to `hardCapMs` (900_000 ms) and may be delivered up to
 * `MAX_ATTEMPTS` (3) times:
 *
 *   MAX_CALIBRATION_ITEMS (1000) x 3 x 900_000 ms = 750 h = 31.25 days.
 *
 * 45 days rounds that up. Measured throughput (5.03 min/item, so 3.49 days
 * for 1000 items — see the plan's Measurements table) is the EXPECTATION,
 * and sizing a force-finalize threshold on an expectation is exactly what
 * killed 4 of 30 items in the first place. The relationship, not the
 * literal, is pinned by a test in
 * `tests/integration/finalization.test.ts`, so raising
 * `MAX_CALIBRATION_ITEMS` again without revisiting this constant goes red.
 *
 * ── WHAT THIS NUMBER IS NOT ───────────────────────────────────────────────
 * It is NOT immune to queue depth. Unlike the execution deadline, this net
 * measures wall clock from `createdAt`, so N batches queued on the SAME
 * judge lane SUM: two back-to-back 1000-item batches are 62.5 days of legal
 * worst case against this 45-day bound. THE INVARIANT THIS CONSTANT
 * ASSUMES, stated so it can be checked: at most ONE calibration anywhere
 * near `MAX_CALIBRATION_ITEMS` in flight per judge lane at a time. If that
 * stops holding, raise THIS constant, not `MAX_CALIBRATION_ITEMS`.
 *
 * ── THE COST, STATED RATHER THAN HIDDEN ───────────────────────────────────
 * This net is the ONLY thing that republishes a never-dequeued run, and it
 * does so at 45 days. Before this change, a lost `judgment.execute` message
 * on an ordinary run was republished within `N x hardCapMs + slack` of
 * CREATION — ~16 minutes — and abandoned ~3 minutes later. That self-heal
 * is gone: a lost message now costs 45 days of silence, during which
 * `src/worker/run-create-consumer.ts:182` dedupes away every subsequent
 * `run.create` for that evaluation ("active run already exists — deduping"),
 * so the evaluation is silently un-runnable through the bulk path for the
 * whole period. This is an ACCEPTED trade, not an oversight: a tight net
 * cannot tell a lost message from a healthy queued batch, and killing the
 * healthy batch is the failure this whole change exists to remove. The
 * operator's real detector is unchanged — `scripts/calibration/run.ts`'s
 * `--poll-timeout` notices a stuck run in minutes, long before this fires.
 *
 * ── A SECOND, NON-LAUNCH SOURCE OF NULL-DEADLINE ROWS ─────────────────────
 * `scripts/importer/runs.ts:384` writes `deadlineAt: null` explicitly, with
 * the v1 run's own `createdAt` (`:387`) and a `status` (`:369`) that is
 * `'pending'`/`'judging'` unless the v1 row was stranded (24 h,
 * `runs.ts:204`). Such a row is older than this net on the day it is
 * imported, so this arm republishes its judgments onto a live judge lane and
 * then force-finalizes them. Production had ZERO such rows when this landed
 * (read-only check, 2026-09-03); re-run that check before any future import.
 */
export const NEVER_STARTED_TIMEOUT_MS = 45 * 24 * 60 * 60 * 1000;
```

Then replace `sweepOverdueRuns` (current lines ~301-323):

Old:
```ts
async function sweepOverdueRuns(): Promise<void> {
  const now = Date.now();

  const overdueRuns = await prisma.evaluationRun.findMany({
    where: { status: { in: ['pending', 'judging'] }, deadlineAt: { lt: new Date(now) } },
    // v2j: triggeredById is the owner half of the endpoint identity a lane is
    // resolved from. Selected here, on a query that was already reading these
    // rows, so `republishPendingForRun` needs no extra round trip for it.
    select: { id: true, deadlineAt: true, triggeredById: true },
  });

  for (const run of overdueRuns) {
    const abandoned = run.deadlineAt !== null && run.deadlineAt.getTime() < now - FORCE_FINALIZE_GRACE_MS;

    if (abandoned) {
      // eslint-disable-next-line no-await-in-loop -- sequential per-run handling; overdue runs are expected to be rare
      await forceFinalizeAbandonedRun(run.id);
    } else {
      // eslint-disable-next-line no-await-in-loop -- see above
      await republishPendingForRun(run.id, run.triggeredById);
    }
  }
}
```

New:
```ts
async function sweepOverdueRuns(): Promise<void> {
  const now = Date.now();
  const neverStartedBefore = new Date(now - NEVER_STARTED_TIMEOUT_MS);

  const overdueRuns = await prisma.evaluationRun.findMany({
    where: {
      status: { in: ['pending', 'judging'] },
      OR: [
        { deadlineAt: { lt: new Date(now) } },
        // THE LEAK, closed: a null deadline is invisible to the first arm
        // (SQL's `NULL < now` is `NULL`, not true — see
        // NEVER_STARTED_TIMEOUT_MS's own doc). This second arm is the ONLY
        // thing that can ever catch a run that was published and never
        // dequeued.
        { deadlineAt: null, createdAt: { lt: neverStartedBefore } },
      ],
    },
    // v2j: triggeredById is the owner half of the endpoint identity a lane is
    // resolved from. Selected here, on a query that was already reading these
    // rows, so `republishPendingForRun` needs no extra round trip for it.
    select: { id: true, deadlineAt: true, createdAt: true, triggeredById: true },
  });

  for (const run of overdueRuns) {
    // `run.deadlineAt` is set for every row that matched the query's FIRST
    // arm (a run that has begun executing — see claim.ts's
    // `stampRunStartedAtFirstDequeue`): the EXECUTION deadline governs,
    // exactly as before this task. `run.deadlineAt === null` means this
    // row only matched the SECOND arm — never dequeued, sitting since
    // `createdAt` past NEVER_STARTED_TIMEOUT_MS — so the never-started
    // net's own threshold stands in for the execution deadline this run
    // never got.
    const threshold = run.deadlineAt ?? new Date(run.createdAt.getTime() + NEVER_STARTED_TIMEOUT_MS);
    const abandoned = threshold.getTime() < now - FORCE_FINALIZE_GRACE_MS;

    if (abandoned) {
      // eslint-disable-next-line no-await-in-loop -- sequential per-run handling; overdue runs are expected to be rare
      await forceFinalizeAbandonedRun(run.id);
    } else {
      // eslint-disable-next-line no-await-in-loop -- see above
      await republishPendingForRun(run.id, run.triggeredById);
    }
  }
}
```

Finally, add a short addendum to the module doc's "(b) Overdue-run sweep" section — insert immediately before the paragraph beginning `* Every per-item failure ...`:
```ts
 *
 * ── 2026-09-03: a THIRD condition feeds the same two-case disposition ──────
 * `deadlineAt` is `null` from creation until `src/worker/claim.ts`'s
 * `stampRunStartedAtFirstDequeue` sets it at FIRST DEQUEUE (see that
 * function's doc). Under SQL's three-valued logic `NULL < now` is `NULL`,
 * not true, so a null-deadline row was ALREADY invisible to the query
 * above — harmlessly, back when every launch path always stamped a
 * deadline at creation, but a run published and never claimed at all (dead
 * consumer, lost message, purged queue) would otherwise be IMMORTAL:
 * nothing would ever sweep it. `NEVER_STARTED_TIMEOUT_MS` is the safety
 * net — the query now ALSO matches `deadlineAt: null AND createdAt < now -
 * NEVER_STARTED_TIMEOUT_MS`, and the same two-case grace/abandon logic
 * above applies, substituting `createdAt + NEVER_STARTED_TIMEOUT_MS` for
 * `deadlineAt` as the threshold. See that constant's own doc for why it is
 * orders of magnitude looser than the execution deadline it stands in for,
 * what invariant that looseness assumes (one max-size batch per judge lane),
 * and what it costs (a lost message is no longer republished in minutes).
```

- [ ] **Step 4: run it, confirm green**

```bash
cd /root/judge-arena && sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.integration.config.ts tests/integration/finalization.test.ts'
```
Expected: all 6 new tests pass; every pre-existing test in the file (including the `'reaper (src/worker/reaper.ts): overdue-run handling'` describe block, whose rows all carry non-null `deadlineAt` and therefore only ever match the query's FIRST arm, unchanged) is unaffected.

- [ ] **Step 5: INJECTION — the `deadlineAt: null` guard on the second OR arm**

Edit the second arm to drop the null guard:
```ts
        { createdAt: { lt: neverStartedBefore } },
```

Run:
```bash
cd /root/judge-arena && sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.integration.config.ts tests/integration/finalization.test.ts'
```

**Exact expected RED:** the `'a STARTED run (deadlineAt set, in the future)...'` test fails. The started-but-ancient-`createdAt` run now matches the (buggy) second arm unconditionally; inside the loop, `run.deadlineAt ?? ...` is NOT null (it's set, in the future), so `threshold = run.deadlineAt` (future) and `abandoned` evaluates false — the row falls into `republishPendingForRun`, which publishes a `judgment.execute` for the still-pending judgment even though the run is comfortably within its real execution deadline. `expect(relevant).toHaveLength(0)` fails with `expected [ {...} ] to have length 0` (or similar — one message was published). The other new tests stay green (their `createdAt` values don't interact with this specific bug: the never-started tests all have `deadlineAt: null`, so the arm's now-missing null guard doesn't change whether they match). Restore the guarded arm and re-run Step 4 to confirm green again.

- [ ] **Step 5b: INJECTION — the `createdAt` clause on the second OR arm**

Now drop the OTHER half of the same arm instead:
```ts
        { deadlineAt: null },
```

**Exact expected RED:** the `'a run created recently, never dequeued, is left alone...'` test fails — and it is the ONLY thing guarding this. Every young never-started run is now in the candidate set; `threshold = createdAt + NEVER_STARTED_TIMEOUT_MS` is in the future so `abandoned` is false, and `republishPendingForRun` publishes a `judgment.execute` for a perfectly healthy queued judgment. `expect(relevant).toHaveLength(0)` fails as `expected [ {...} ] to have length 1... to have length 0`. Tests 1 and 3 stay green. Restore both halves of the arm and re-run Step 4.

- [ ] **Step 5c: INJECTION — the substituted threshold really does pick the gentle branch first**

Replace the threshold line with the plausible-but-wrong shortcut:
```ts
    const threshold = run.deadlineAt ?? new Date(0);
```

**Exact expected RED:** the `'a never-started run just PAST the net but inside the grace period is REPUBLISHED, not force-finalized'` test fails, and ONLY that one. `new Date(0)` is always past `now - FORCE_FINALIZE_GRACE_MS`, so `abandoned` is true for every row the second arm catches: the judgment is stamped `error: 'reaper: abandoned'` and the run is finalized, so `expect(afterSweep.status).toBe('pending')` fails as `expected 'error' to be 'pending'`. **If it stays green, stop and diagnose** — the two-phase disposition the module doc claims to reuse would then be untested. Restore `new Date(run.createdAt.getTime() + NEVER_STARTED_TIMEOUT_MS)` and re-run Step 4.

- [ ] **Step 6: gates**

```bash
cd /root/judge-arena && npm run lint && npx tsc --noEmit && npm run test:coverage 2>&1 | tail -25
```
Confirm `src/worker/**`'s floor is not breached (same watch as Task 2 Step 6). **Record the `branches` figure specifically** — floor 87, last measured 90.38 — because the new `run.deadlineAt ?? new Date(...)` is one uncovered branch in a denominator this run barely exercises. If it lands under 87 the fix is to hoist the threshold choice into an already-unit-tested pure helper alongside `runStartBudgetMs`, never to edit the floor. Record the printed unit total for the commit's Gates line rather than writing `n/a`: this task edits `src/worker/**`, which IS in the unit coverage denominator (`vitest.config.ts:37`).

```bash
cd /root/judge-arena && npm run test:integration
```
Confirm the full integration suite is green. Predicted total: 86 + 6 = **92**. *(A prediction to check against, not the assertion — use whatever the run prints, and treat an unexplained delta as a finding.)*

- [ ] **Step 7: commit**

```bash
cd /root/judge-arena && git add src/worker/reaper.ts tests/integration/finalization.test.ts
git commit -m "$(cat <<'EOF'
fix(worker): reaper — close the null-deadlineAt leak with a never-started safety net

sweepOverdueRuns's query used to be `deadlineAt: { lt: now }` alone; under
SQL's three-valued logic NULL < now is NULL, not true, so a null-deadline
row was already invisible to it — harmless while every launch path always
stamped a deadline at creation, but immortal the moment Tasks 4-5 stop
doing that. Adds NEVER_STARTED_TIMEOUT_MS as a second OR arm keyed on
createdAt instead of deadlineAt, reusing the existing two-phase
republish-then-abandon disposition (pinned by its own injection, since the
plausible shortcut `?? new Date(0)` force-finalizes everything the arm
catches and passes every other test).

45 days, not 7: sized on the LEGAL bound a full-cap batch may occupy
(MAX_CALIBRATION_ITEMS x MAX_ATTEMPTS x hardCapMs = 31.25 days at the
coming cap of 1000), not on measured throughput — sizing a force-finalize
threshold on an expectation is the original defect. A test pins the
relationship rather than a second literal, so raising the item cap again
without revisiting the net goes red. The cost is stated in the constant's
own doc: a lost judgment.execute message is no longer republished in ~16
minutes but in 45 days, and run-create-consumer.ts dedupes that
evaluation's run.create for the duration. Accepted: a tight net cannot
tell a lost message from a healthy queued batch.

Dormant on its own today: production has zero pending/judging rows with a
null deadlineAt (read-only check, re-run at Step 0).

Gates: lint 0, tsc 0, 1007 unit (no new unit tests; src/worker/** re-measured) / n/a (not touched by this task) db / 92 integration, coverage 0.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WT7bB4SAZpJtRDEGhpGyRv
EOF
)"
```

---

## Task 4: `run-launch.ts` + `calibration/launch.ts` — stop stamping at creation

**Why one commit, two files:** `calibration/launch.ts`'s batch-deadline override exists SOLELY to override `run-launch.ts`'s `LaunchSingleRunParams.deadlineAt` param. Removing the param from `run-launch.ts` without also removing `calibration/launch.ts`'s only caller of it in the same commit leaves an intermediate state where `calibration/launch.ts` passes an object property TypeScript no longer recognizes on `LaunchSingleRunParams` — a compile error between commits. They land together.

**Files:**
- Modify: `/root/judge-arena/src/lib/run-launch.ts`
- Modify: `/root/judge-arena/src/lib/calibration/launch.ts`
- Modify (Test): `/root/judge-arena/tests/db/calibration-link.test.ts`

**Interfaces:**
- `LaunchSingleRunParams` loses the `deadlineAt?: Date` field entirely.
- `launchSingleRun`'s created `EvaluationRun` omits `deadlineAt` from its `create()` data (defaults to `null`).
- `run-launch.ts` loses the `DEADLINE_SLACK_MS` export (its only importer, `calibration/launch.ts`, stops needing it in this same commit).
- `launchCalibrationRun` no longer computes or passes a `deadlineAt` override.

- [ ] **Step 0: confirm the anchors**

```bash
cd /root/judge-arena && sed -n '113,126p' src/lib/run-launch.ts
sed -n '336,373p' src/lib/run-launch.ts
sed -n '517,542p' src/lib/run-launch.ts
sed -n '52,61p' src/lib/calibration/launch.ts
sed -n '249,325p' src/lib/calibration/launch.ts
sed -n '467,484p' src/lib/calibration/launch.ts
sed -n '1,12p' tests/db/calibration-link.test.ts
sed -n '365,405p' tests/db/calibration-link.test.ts
```
Compare each against the exact text quoted in Step 1/3 below before editing — if any block has moved or been reworded since this plan was authored, re-locate by searching for a distinctive phrase from the quoted text (e.g. `"THE REAPER FIX"` or `"stamps a BATCH-aware deadline"`).

- [ ] **Step 1: write the failing test**

Replace the existing test in `/root/judge-arena/tests/db/calibration-link.test.ts` (currently lines 367-404):

Old:
```ts
  it('stamps a BATCH-aware deadline, far beyond the naive single-model one the reaper would abandon', async () => {
    const world = await mkWorld({ items: 3 });
    const launchedAt = Date.now();

    const result = await launchCalibrationRun(launchParamsFrom(world), { publish: noopPublish });

    const runs = await db.evaluationRun.findMany({ where: { calibrationRunId: result.calibrationRunId } });
    expect(runs).toHaveLength(3);

    // THE REAPER FIX. `launchSingleRun`'s own formula is
    // now + (#models × timeout) + slack, which for one model is ~180s — but a
    // 3-item batch is 3 judgments deep in ONE queue, and the runs at the back
    // do not start executing for as long as the ones ahead of them take.
    // src/worker/reaper.ts force-finalizes a run 180s past its deadline by
    // stamping every still-pending judgment `error: 'reaper: abandoned'`, so
    // the naive deadline silently scores only the head of the batch.
    // Both bounds are computed from the HARD CAP, not the initial budget, and
    // that is the point rather than an implementation detail. Since the
    // escalating timeout landed, reaching EVALUATION_MODEL_TIMEOUT_MS only
    // raises an alert — the call keeps running to the cap. A deadline sized on
    // the initial budget would therefore let the reaper abandon judgments that
    // are still legitimately executing, which is the same failure this test was
    // written to prevent, reintroduced through the timeout rather than through
    // the batch size.
    const perCallCeilingMs = resolveTimeoutBudgets().hardCapMs;
    const naiveSingleModelDeadline = launchedAt + perCallCeilingMs + DEADLINE_SLACK_MS;
    const batchAwareDeadline = launchedAt + 3 * perCallCeilingMs + DEADLINE_SLACK_MS;
    for (const run of runs) {
      expect(run.deadlineAt).not.toBeNull();
      expect(run.deadlineAt!.getTime()).toBeGreaterThan(naiveSingleModelDeadline);
      // Widened from "models in this run" to "judgments queued ahead of this
      // one" — the same formula, not a bigger fudge factor. Every run in the
      // batch carries the SAME deadline (the batch finishes as a unit), so the
      // bound holds for all of them, ±the wall clock spent launching.
      expect(run.deadlineAt!.getTime()).toBeGreaterThanOrEqual(batchAwareDeadline);
      expect(run.deadlineAt!.getTime()).toBeLessThan(batchAwareDeadline + 60_000);
    }
  });
```

New:
```ts
  it('creates every run in the batch with deadlineAt NULL — the execution deadline is stamped later, at first dequeue', async () => {
    const world = await mkWorld({ items: 3 });

    const result = await launchCalibrationRun(launchParamsFrom(world), { publish: noopPublish });

    const runs = await db.evaluationRun.findMany({ where: { calibrationRunId: result.calibrationRunId } });
    expect(runs).toHaveLength(3);

    // 2026-09-03: launchCalibrationRun no longer computes a batch-aware
    // deadline override, and launchSingleRun no longer computes a
    // creation-time default either — see run-launch.ts's and this
    // module's own "no batch deadline computed here anymore" doc. Every
    // run this function creates carries deadlineAt: null until a worker
    // actually claims its judgment (src/worker/claim.ts's
    // stampRunStartedAtFirstDequeue) — exercised end-to-end in
    // tests/integration/worker-claims.test.ts, not here: this suite never
    // touches a broker or a real judgment-consumer (see noopPublish above).
    for (const run of runs) {
      expect(run.deadlineAt).toBeNull();
    }
  });
```

Also update the file's own header comment (`tests/db/calibration-link.test.ts:29-32`), which still advertises the batch-aware deadline as one of the three things this file pins — after this edit it pins the opposite:

Old:
```
//   (2) THE LAUNCH PATH THAT WRITES THAT LINK — `launchCalibrationRun`
//       (src/lib/calibration/launch.ts), including the batch-aware deadline
//       that keeps `src/worker/reaper.ts` from force-finalizing the tail of a
//       long batch as `'reaper: abandoned'`.
```
New:
```
//   (2) THE LAUNCH PATH THAT WRITES THAT LINK — `launchCalibrationRun`
//       (src/lib/calibration/launch.ts), including that since 2026-09-03 it
//       creates every run with `deadlineAt` NULL: the execution deadline is
//       stamped at first dequeue by `src/worker/claim.ts` instead, which is
//       what keeps `src/worker/reaper.ts` from force-finalizing the tail of
//       a long batch as `'reaper: abandoned'`.
```

Remove the now-unused imports from the top of the file (lines 8 and 10):
```ts
import { resolveTimeoutBudgets } from '@/lib/llm/timeout-policy';
```
and
```ts
import { DEADLINE_SLACK_MS } from '@/lib/run-launch';
```
(Confirm first that neither name is used elsewhere in the file — `grep -n "resolveTimeoutBudgets\|DEADLINE_SLACK_MS" tests/db/calibration-link.test.ts` should, after this edit, show zero remaining code usages; a stray mention inside a comment at the original line 749 is prose, not a compiled reference, and needs no change.)

- [ ] **Step 2: run it, confirm the exact FAIL**

```bash
cd /root/judge-arena && sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.db.config.ts tests/db/calibration-link.test.ts'
```

**Exact expected FAIL:** the implementation has not changed yet — `launchCalibrationRun` still computes and passes a real batch deadline, and `launchSingleRun` still writes it. So `expect(run.deadlineAt).toBeNull()` fails three times (once per run in the batch) with `expected 2026-...T...Z to be null`. **Predicted, not observed** (author's constraints exclude `npm run test:db`).

- [ ] **Step 3: minimal implementation**

**`src/lib/run-launch.ts`, edit 1** — module doc (current lines 85-97):

Old:
```
 * ── A2.1: calibration reuses this module, it does not fork it ──────────────
 * `src/lib/calibration/launch.ts` launches a calibration as N ordinary
 * pairwise runs through `launchSingleRun` — no second execution path, no
 * calibration-specific consumer. It needs exactly three things from a run
 * that an ordinary launch does not set, and all three are plain optional
 * params here: `goldenItemId` and `calibrationRunId` (the v2i link columns,
 * NULL on every ordinary run) and `deadlineAt` (a batch-aware override of the
 * per-run deadline formula — read that param's doc, the default silently
 * loses the tail of a batch to `src/worker/reaper.ts`). It deliberately does
 * NOT go through `launchBulkRunCreates`: `src/worker/run-create-consumer.ts`
 * refuses any protocol but `'pointwise'`, because `RunCreateMsg` carries no
 * candidate set to expand a pairwise comparison from.
 */
```

New:
```
 * ── A2.1: calibration reuses this module, it does not fork it ──────────────
 * `src/lib/calibration/launch.ts` launches a calibration as N ordinary
 * pairwise runs through `launchSingleRun` — no second execution path, no
 * calibration-specific consumer. It needs exactly two things from a run that
 * an ordinary launch does not set, and both are plain optional params here:
 * `goldenItemId` and `calibrationRunId` (the v2i link columns, NULL on every
 * ordinary run). It deliberately does NOT go through `launchBulkRunCreates`:
 * `src/worker/run-create-consumer.ts` refuses any protocol but `'pointwise'`,
 * because `RunCreateMsg` carries no candidate set to expand a pairwise
 * comparison from.
 *
 * ── 2026-09-03: EvaluationRun.deadlineAt is no longer stamped here ─────────
 * This module used to compute `deadlineAt` at CREATION — `now + (#judgments
 * in this run) × hardCapMs + slack` — and calibration's batch launcher
 * (`src/lib/calibration/launch.ts`) used to override it with the SAME
 * formula over a bigger denominator ("judgments queued ahead of this one"),
 * because sizing a batch's deadline on one run's own model count silently
 * lost the tail of a large batch to `src/worker/reaper.ts` — a
 * queue-position estimate that could be hours, stamped as if the run's OWN
 * work would take minutes. That mechanism is gone: `EvaluationRun.deadlineAt`
 * is now left `null` at creation and is stamped once, at FIRST DEQUEUE, by
 * `src/worker/claim.ts`'s `stampRunStartedAtFirstDequeue` — sized on THIS
 * run's own judgment count, measured from the moment a worker actually
 * claims it, immune to how many other runs are queued ahead of it. See that
 * function's doc for the mechanism and `src/worker/reaper.ts`'s
 * `NEVER_STARTED_TIMEOUT_MS` for the safety net covering a run that is
 * published and never dequeued at all.
 */
```

**Edit 2** — the `DEADLINE_SLACK_MS` export (current lines 121-125):

Old:
```
/** Same slack literal as src/worker/run-create-consumer.ts's
 * `DEADLINE_SLACK_MS` — covers DB round trips, queue publish latency, and
 * finalization overhead on top of the per-model provider timeout budget.
 * Exported for the same reason as `EVALUATION_MODEL_TIMEOUT_MS` above. */
export const DEADLINE_SLACK_MS = 60_000;
```

New: delete these 5 lines entirely (nothing replaces them).

Also update the doc comment immediately above `EVALUATION_MODEL_TIMEOUT_MS` (current lines 114-120), which references the now-deleted machinery:

Old:
```
/** Exported for `src/lib/calibration/launch.ts`, which computes the SAME
 * deadline formula over a different denominator (see `deadlineAt` on
 * `LaunchSingleRunParams`). Exported rather than re-declared there so a batch
 * launcher and the run it launches cannot disagree about the per-model budget
 * — a third copy of this literal is a third thing to keep in step with
 * `EVALUATION_MODEL_TIMEOUT_MS`'s env override. */
export const EVALUATION_MODEL_TIMEOUT_MS = Number(process.env.EVALUATION_MODEL_TIMEOUT_MS ?? '300000');
```

New:
```
/** UNUSED since 2026-09-03: this module no longer computes a deadline at
 * creation (see the module doc's "EvaluationRun.deadlineAt is no longer
 * stamped here" section), and nothing else in the tree imports this export.
 * Confirmed with a command that cannot miss the multi-line
 * `import {\n  X,\n} from '...'` form this repo actually uses (a per-line
 * `grep "import.*NAME"` walks straight past it):
 * `grep -ran "EVALUATION_MODEL_TIMEOUT_MS" src tests | grep -v "^src/lib/run-launch.ts"`
 * returns only comments and `process.env` / env-schema string keys — no
 * value import, before or after this change. Left in place rather
 * than deleted here — removing it is an unrelated cleanup, not a
 * `deadlineAt` behaviour, and this plan's one-concern-per-commit rule is
 * exactly why it stays for now. */
export const EVALUATION_MODEL_TIMEOUT_MS = Number(process.env.EVALUATION_MODEL_TIMEOUT_MS ?? '300000');
```

**Edit 3** — remove the `resolveTimeoutBudgets` import (it has no remaining call site in this file after Edit 4):
```ts
import { resolveTimeoutBudgets } from '@/lib/llm/timeout-policy';
```
Delete this line from the import block.

**Edit 4** — `LaunchSingleRunParams`, delete the `deadlineAt` field and its JSDoc (current lines 340-372):

Old (spanning from the `calibrationRunId` field's own doc through `deadlineAt`'s declaration and the interface's closing brace):
```
  /** A2.1: which calibration this run belongs to. Paired with `goldenItemId`
   * under `@@unique([calibrationRunId, goldenItemId])`, so one calibration
   * cannot measure the same item twice. */
  calibrationRunId?: string;
  /**
   * A2.1 — THE REAPER FIX. Overrides the default deadline below.
   *
   * The default is `now + (#models in THIS run) × EVALUATION_MODEL_TIMEOUT_MS
   * + DEADLINE_SLACK_MS`, which is correct for a run whose judgments start
   * executing more or less immediately — one model, ~180s. It is WRONG for a
   * run launched as part of a batch: 30 calibration runs are created within
   * seconds of each other, all carrying ~the same deadline, but they execute
   * through one queue against a server with a handful of slots, so the batch
   * takes minutes. `src/worker/reaper.ts` sweeps `status IN
   * ('pending','judging') AND deadlineAt < now`, and 3 sweep intervals
   * (~180s) past the deadline it force-finalizes: every still-`pending`
   * judgment on the run is stamped `error: 'reaper: abandoned'` and the run is
   * finalized. The tail of a batch is therefore scored as errors while it is
   * still sitting in the queue, waiting its turn — silently, because a
   * force-finalized run looks exactly like a run that genuinely failed.
   *
   * A batch launcher passes `now + (#judgments queued ahead of this one) ×
   * EVALUATION_MODEL_TIMEOUT_MS + DEADLINE_SLACK_MS` — the SAME formula, with
   * "models in this run" widened to "work that must drain before this run
   * can finish", which is what the deadline was always trying to express.
   *
   * DELIBERATELY NOT ATTEMPTED HERE: stamping `deadlineAt` at FIRST DEQUEUE
   * (when a worker actually claims the run's first judgment) instead of at
   * creation. That is the correct long-term fix — it makes the deadline mean
   * "this run has been executing too long" rather than "this run was created
   * too long ago", and it is immune to queue depth, worker count and
   * concurrency entirely. It needs a `startedAt`-driven deadline write in the
   * claim path plus a reaper that understands never-started runs, which is a
   * worker-side change out of scope for phase 1.
   */
  deadlineAt?: Date;
}
```

New:
```
  /** A2.1: which calibration this run belongs to. Paired with `goldenItemId`
   * under `@@unique([calibrationRunId, goldenItemId])`, so one calibration
   * cannot measure the same item twice. */
  calibrationRunId?: string;
}
```

**Edit 5** — the default-formula computation and its use in the `create()` call (current lines 519-541):

Old:
```
  // The default is unchanged for every existing caller: this run's own model
  // count is the only thing a single launch knows about. `params.deadlineAt`
  // is the batch-aware override — see its doc on LaunchSingleRunParams for
  // what the reaper does to a batch stamped with the default.
  const deadlineAt =
    params.deadlineAt ??
    // The HARD CAP, not the initial budget. A call may now legally run to the
    // hard cap while the initial budget only triggers an alert, so sizing the
    // deadline on the initial budget would let the reaper force-finalize a run
    // whose judgments are still legitimately executing — the same failure that
    // silently scored 4 of 30 items once already, reintroduced by a timeout
    // change rather than by a concurrency one.
    new Date(Date.now() + selectedVersionIds.length * resolveTimeoutBudgets().hardCapMs + DEADLINE_SLACK_MS);

  const createdRun = await prisma.$transaction(async (tx) => {
    return tx.evaluationRun.create({
      data: {
        evaluationId: params.evaluationId,
        rubricId: rubric?.id ?? null,
        protocol,
        status: 'pending',
        deadlineAt,
        triggeredById: params.triggeredById,
```

New:
```
  const createdRun = await prisma.$transaction(async (tx) => {
    return tx.evaluationRun.create({
      data: {
        evaluationId: params.evaluationId,
        rubricId: rubric?.id ?? null,
        protocol,
        status: 'pending',
        // deadlineAt is deliberately OMITTED — it defaults to null and
        // stays null until src/worker/claim.ts's
        // stampRunStartedAtFirstDequeue sets it at FIRST DEQUEUE. See the
        // module doc's "EvaluationRun.deadlineAt is no longer stamped here"
        // section for why.
        triggeredById: params.triggeredById,
```

**`src/lib/calibration/launch.ts`, edit 1** — the import block (current lines 52-60):

Old:
```ts
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

New:
```ts
import {
  launchSingleRun,
  requireOwnedActiveEndpoints,
  resolveCurrentPromptTemplate,
  RunLaunchError,
  type LaunchRunCandidateInput,
  type LaunchSingleRunDeps,
} from '@/lib/run-launch';
```

**Edit 2** — the entire "THE REAPER FIX" batch-deadline block (current lines 253-324, spanning from the section header through the `const deadlineAt = new Date(...)` statement's closing `);`):

Old (reproduced in full, byte-for-byte, from the read tree):
```
  // ── THE REAPER FIX ───────────────────────────────────────────────────────
  // ONE deadline, computed once, stamped on every run in the batch.
  //
  // `launchSingleRun`'s own formula is `now + (#models in this run) ×
  // EVALUATION_MODEL_TIMEOUT_MS + DEADLINE_SLACK_MS` — for the one judge model
  // a calibration uses, ~180s. All N runs here are created within seconds of
  // each other, so under that formula they would all carry ~the same 180s
  // deadline while the batch itself takes N × (a provider call) to drain
  // through a queue with a couple of slots. `src/worker/reaper.ts` sweeps
  // `pending`/`judging` runs whose `deadlineAt` has passed and, three sweep
  // intervals (~180s) later, FORCE-FINALIZES them: every still-`pending`
  // judgment is stamped `error: 'reaper: abandoned'`. The tail of the batch
  // would be scored as errors while it was still queued and healthy — and a
  // force-finalized run is indistinguishable from one that really failed, so
  // the resulting kappa would be computed over the head of the set with no
  // sign that anything went wrong.
  //
  // The fix is the SAME formula with the denominator widened from "models in
  // this run" to "judgments queued ahead of this one" — which is what the
  // deadline was always trying to express. It is generous for the first item
  // and exact for the last; a too-late deadline only delays the reaper's
  // safety net, while a too-early one destroys results.
  //
  // NOT ATTEMPTED HERE, AND IT IS THE RIGHT LONG-TERM FIX: stamp `deadlineAt`
  // at FIRST DEQUEUE, when a worker actually claims the run's first judgment.
  // That makes the deadline mean "this run has been executing too long"
  // instead of "this run was created too long ago", and is immune to queue
  // depth, worker count and concurrency. It is a change to the claim path plus
  // a reaper that understands never-started runs — worker-side, out of scope
  // for phase 1. Until then this widened formula is a bound, not a guarantee:
  // a batch queued behind ANOTHER batch can still outlive it.
  //
  // ── WHICH BUDGET: THE HARD CAP, NOT THE INITIAL BUDGET ───────────────────
  // With the escalating timeout (`src/lib/llm/timeout-policy.ts`),
  // `EVALUATION_MODEL_TIMEOUT_MS` is no longer the longest a provider call may
  // legitimately run — it is only where the 5-minute alert fires. The longest
  // legitimate call is `EVALUATION_MODEL_HARD_CAP_MS`, so that is the term this
  // per-item ceiling has to multiply.
  //
  // Keying off the initial budget instead would make the batch deadline
  // SMALLER THAN THE TIME ONE ITEM MAY LEGITIMATELY TAKE, times N. What the
  // reaper does to an overdue run is stamp its still-`pending` judgments
  // `error: 'reaper: abandoned'` (reaper.ts:243-246, three sweeps past the
  // deadline) — i.e. it kills the QUEUED TAIL, not the in-flight call. The
  // queued tail is precisely what a longer per-call ceiling makes wait longer:
  // one item allowed 15 minutes instead of 5 pushes everything behind it out
  // by the same amount. Before that, from the moment the deadline passes, the
  // gentler branch (`republishPendingForRun`) re-publishes every pending
  // judgment of the run once a MINUTE, piling duplicate deliveries onto a lane
  // that runs one call at a time.
  //
  // That is not hypothetical: killing the healthy queued tail is the bug that
  // cost 4 of 30 items on a real calibration and that the comment above was
  // written to fix. Keying this off the initial budget would re-arm it from a
  // new direction.
  //
  // The cost of the other direction is bounded and small. 30 items × 15
  // minutes is a 7.5-hour ceiling, but a ceiling is not an expectation: at the
  // measured Qwen average of 42.6s (max 95.1s) those 30 items drain in ~21
  // minutes, and the deadline only matters at all once something is genuinely
  // stuck. Nor does it delay the OPERATOR noticing — `scripts/calibration/run.ts`
  // has its own `--poll-timeout` (default 3600s) and, with the sibling change,
  // reports any judgment running past the initial budget on every 5s poll. So
  // the human-facing detection bound is unchanged by this; only the database's
  // last-resort safety net is later.
  //
  // Asymmetry, stated plainly: too tight destroys real results and produces a
  // kappa that lies. Too loose delays a safety net that is already the
  // slowest of three detectors. Pick loose.
  const deadlineAt = new Date(
    Date.now() + items.length * resolveTimeoutBudgets().hardCapMs + DEADLINE_SLACK_MS
  );
```

New:
```
  // ── 2026-09-03: no batch deadline computed here anymore ───────────────────
  // This block used to stamp ONE deadline, computed once, on every run in
  // the batch — `now + (#judgments queued ahead of this one) × hardCapMs +
  // slack` — because `launchSingleRun`'s OWN creation-time formula only knew
  // about ONE run's model count, and a 30-item batch created within seconds
  // of itself would otherwise carry ~30 nearly-identical deadlines while the
  // batch itself took 30x as long to drain through one judge's queue.
  // `src/worker/reaper.ts` would then force-finalize the still-healthy tail
  // as `error: 'reaper: abandoned'` — the bug that cost 4 of 30 items on a
  // real calibration.
  //
  // The fix is no longer "widen the formula's denominator" — it's that
  // `EvaluationRun.deadlineAt` is not computed at creation AT ALL any more.
  // `src/worker/claim.ts`'s `stampRunStartedAtFirstDequeue` stamps it once,
  // at FIRST DEQUEUE, sized on THIS run's own judgment count (always 1 for a
  // calibration run) and measured from the moment a worker actually claims
  // it — immune to how many other runs, from this batch or any other, are
  // queued ahead of it. `launchSingleRun` below is called with no
  // `deadlineAt` override; every run this function launches is created with
  // `deadlineAt: null` and stays that way until claimed.
```

**Edit 2b** — the comment Edit 2 orphans (current lines 338-341). It names a
"first" `resolveTimeoutBudgets()` call that Edit 2 just deleted, points at
line numbers that are already wrong on HEAD (the const is at `:322-324`, not
`:312-314`), and refers to a "THE REAPER FIX" block that no longer exists:

Old:
```
  // `resolveTimeoutBudgets()` is called a second time here (the batch deadline
  // at :312-314 is the first). Deliberate and cheap: it reads `env` and does
  // arithmetic, and hoisting one shared const across the deadline comment
  // block would put an unrelated edit in the middle of THE REAPER FIX.
  //
```

New:
```
  // `resolveTimeoutBudgets()` reads `env` and does arithmetic — cheap, and
  // this is now its only call in this module (the batch-deadline call it
  // used to share the file with was deleted 2026-09-03; see the "no batch
  // deadline computed here anymore" block above).
  //
```

**Edit 3** — remove `deadlineAt` from the `launchSingleRun(...)` call (current lines 470-483):

Old:
```
      const launch = await launchSingleRun(
        {
          evaluationId: evaluation.id,
          triggeredById,
          rubricId,
          judgeModelVersionIds: [judgeModelVersionId],
          protocol: 'pairwise',
          candidates: toRunCandidates(item.candidates),
          goldenItemId: item.id,
          calibrationRunId: calibrationRun.id,
          deadlineAt,
        },
        deps
      );
```

New:
```
      const launch = await launchSingleRun(
        {
          evaluationId: evaluation.id,
          triggeredById,
          rubricId,
          judgeModelVersionIds: [judgeModelVersionId],
          protocol: 'pairwise',
          candidates: toRunCandidates(item.candidates),
          goldenItemId: item.id,
          calibrationRunId: calibrationRun.id,
        },
        deps
      );
```

**Note, deliberately deferred to Task 6:** `MAX_CALIBRATION_ITEMS`'s own doc comment (`calibration/launch.ts:62-70`) says *"the way to lift this is the deadline fix named in `LaunchSingleRunParams.deadlineAt` (stamp at first dequeue), not a bigger number here"* — a reference to a symbol this task just deleted. This is deliberately left stale through Task 5 and rewritten in Task 6, which is precisely the task that resolves the premise ("lift this" → the actual new number and its own arithmetic). It is prose, not code — it does not affect compilation or test behaviour — and one-concern-per-commit is why it is not touched here.

- [ ] **Step 4: run it, confirm green**

```bash
cd /root/judge-arena && sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.db.config.ts tests/db/calibration-link.test.ts'
```
Expected: the rewritten test passes; every other test in the file (rubric snapshot, freeze semantics, item-atomic launch, budget warning, the `MAX_CALIBRATION_ITEMS` refusal test, etc.) is unaffected — none of them reads `deadlineAt`.

- [ ] **Step 5: INJECTION**

Re-add a hardcoded, unconditional deadline to `launchSingleRun`'s create data in `run-launch.ts`:
```ts
        deadlineAt: new Date(Date.now() + 999_999_999),
```
(insert it back where Edit 5 removed the `deadlineAt,` line, right after `status: 'pending',`).

Run:
```bash
cd /root/judge-arena && sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.db.config.ts tests/db/calibration-link.test.ts'
```

**Exact expected RED:** `'creates every run in the batch with deadlineAt NULL...'` fails three times, `expected 2026-...T...Z to be null`. Restore Edit 5's version (the omitted-field comment, no `deadlineAt` key) and re-run Step 4 to confirm green again.

- [ ] **Step 6: gates**

```bash
cd /root/judge-arena && npm run lint && npx tsc --noEmit
```
Confirm clean — this is the step most likely to surface a missed import (`DEADLINE_SLACK_MS` or `resolveTimeoutBudgets` still referenced somewhere not checked above) as a `tsc` error naming the exact file and line.

```bash
cd /root/judge-arena && npm run test:coverage 2>&1 | tail -20
```
This task touches `src/lib/run-launch.ts` and `src/lib/calibration/launch.ts`, both in the unit-coverage denominator (`vitest.config.ts:37`'s `include`), and Edit 5 deletes a `??` branch plus a `resolveTimeoutBudgets()` call from that glob — per Global Constraints, a task touching these files needs the unit tier too. Confirm the aggregate floors (lines 43 / functions 63 / branches 87 / statements 43) are not breached; no per-glob floor covers either file specifically. Record the printed unit total for the commit's Gates line — predicted **1007** (this task adds no new unit tests; the glob is re-measured, same convention as Tasks 2/3/5's `src/worker/**` re-measurement).

```bash
cd /root/judge-arena && npm run test:db:coverage 2>&1 | tail -25
```
Confirm **679** db tests pass (this task replaces one test with one test, so the count is net-unchanged from the baseline) and no floor is breached. *(A prediction to check against — use whatever the run prints.)*

- [ ] **Step 7: commit**

```bash
cd /root/judge-arena && git add src/lib/run-launch.ts src/lib/calibration/launch.ts tests/db/calibration-link.test.ts
git commit -m "$(cat <<'EOF'
fix(run-launch): stop stamping deadlineAt at creation in launchSingleRun and launchCalibrationRun

Both used to compute EvaluationRun.deadlineAt at creation — launchSingleRun
via a default formula (now + this run's own model count * hardCapMs +
slack), launchCalibrationRun via a batch-aware override of the same
formula over a wider denominator (judgments queued ahead of this one).
Both are deleted: deadlineAt is left null at creation for every run either
function launches, and stamped once, at first dequeue, by
src/worker/claim.ts's stampRunStartedAtFirstDequeue (Task 2) — which is
why this task could not land before that one. calibration/launch.ts's
batch override existed only to work around launchSingleRun's own formula,
so both go in one commit: removing one without the other leaves an
intermediate state that does not compile.

Landed after Tasks 2-3 (the claim-time stamp and the never-started safety
net) so no run is ever created with a null deadlineAt before something is
in place to eventually give it one.

Gates: lint 0, tsc 0, 1007 unit (no new unit tests; src/lib/** re-measured) / 679 db / n/a (not touched by this task) integration, coverage 0.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WT7bB4SAZpJtRDEGhpGyRv
EOF
)"
```

---

## Task 5: `run-create-consumer.ts` — the third call site

**Files:**
- Modify: `/root/judge-arena/src/worker/run-create-consumer.ts`
- Modify (Test): `/root/judge-arena/tests/integration/worker-claims.test.ts`

**Interfaces:**
- `handle()`'s created `EvaluationRun` omits `deadlineAt` from its `create()` data.
- The file's local `DEADLINE_SLACK_MS` const is deleted.

- [ ] **Step 0: confirm the anchors**

```bash
cd /root/judge-arena && sed -n '100,110p' src/worker/run-create-consumer.ts
sed -n '246,265p' src/worker/run-create-consumer.ts
sed -n '456,458p' tests/integration/worker-claims.test.ts
```

**Count the seams before declaring this the third and last one** (this repo has shipped a feature into 1 of 3 sibling
call sites and had it look live in production for an hour):

```bash
cd /root/judge-arena && grep -ran "evaluationRun\\.create" src scripts
```

Expect exactly **four** hits, verified 2026-09-03 on `ceb2d0a`:
- `src/lib/run-launch.ts:534` — de-stamped by Task 4. (`src/lib/calibration/launch.ts` creates no `EvaluationRun` of
  its own; it goes through `launchSingleRun`, which is why it is not a fifth site.)
- `src/worker/run-create-consumer.ts:256` — de-stamped by THIS task.
- `src/worker/run-create-consumer.ts:154` — the expansion-failure recorder. **Deliberately untouched:** it writes
  `status: 'error'`, a terminal state the reaper's sweep never selects, so a run that will never execute needs no
  deadline.
- `scripts/importer/runs.ts:378` — the v1 import, which already writes `deadlineAt: null` explicitly at `:384` (see
  Task 0's corrected point 1 and Task 3 Step 0's read-only gate).

A FIFTH hit is a missed seam — stop.

- [ ] **Step 1: write the failing test**

Append a new `it` to `/root/judge-arena/tests/integration/worker-claims.test.ts`, immediately BEFORE the existing `it('run.create expansion failure (no modelSelections to expand)...')` test (i.e., right after the `'run.create redelivery is idempotent...'` test's closing `});`, which is the file's current line 538):

```ts

  it('run.create expansion creates the run with deadlineAt NULL — the execution deadline is stamped later, at first dequeue', async () => {
    const fixture = await createEvaluationOnlyFixture();
    const modelConfig = await mkModelConfig(fixture.user.id);

    const { confirmChannel } = await getRabbit();
    await assertTopology(confirmChannel);
    await purgeExecuteQueues(confirmChannel);

    const runCreateConsumer = createRunCreateConsumer();
    const msg: RunCreateMsg = {
      evaluationId: fixture.evaluation.id,
      runSpec: {
        rubricId: fixture.rubric.id,
        modelSelections: [{ judgeModelVersionId: fixture.version.id, modelConfigId: modelConfig.id }],
        triggeredById: fixture.user.id,
        protocol: 'pointwise',
      },
    };

    await runCreateConsumer.handle(fakeMessage(msg), fakeChannel());

    const run = await prisma.evaluationRun.findFirstOrThrow({ where: { evaluationId: fixture.evaluation.id } });
    createdRunIds.push(run.id);

    // 2026-09-03: this consumer used to compute its own creation-time
    // deadline, independently of run-launch.ts's (also now-deleted)
    // formula — the third of three call sites. It no longer computes one
    // at all; see the (now-deleted) DEADLINE_SLACK_MS const's former
    // location in run-create-consumer.ts.
    expect(run.deadlineAt).toBeNull();

    // Drain what this run published so it doesn't leak into a later
    // test's queue assertions in this same persistent-DB suite.
    const lane = await laneQueueFor(null, fixture.version.id);
    await drainQueue(confirmChannel, lane);
  });
```

- [ ] **Step 2: run it, confirm the exact FAIL**

```bash
cd /root/judge-arena && sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.integration.config.ts tests/integration/worker-claims.test.ts'
```

**Exact expected FAIL:** the implementation has not changed — `handle()` still computes and writes a real deadline. `expect(run.deadlineAt).toBeNull()` fails: `expected 2026-...T...Z to be null`. **Predicted, not observed.**

- [ ] **Step 3: minimal implementation**

In `/root/judge-arena/src/worker/run-create-consumer.ts`, delete the `DEADLINE_SLACK_MS` const and its doc comment (current lines 103-107):

Old:
```
/** Slack added on top of `judgmentCount * EVALUATION_MODEL_TIMEOUT_MS` when
 * computing `EvaluationRun.deadlineAt` — covers DB round trips, queue
 * publish latency, and finalization overhead that isn't part of any single
 * provider call's own timeout budget. */
const DEADLINE_SLACK_MS = 60_000;
```
New: delete these 5 lines entirely.

Remove the now-unused import:
```ts
import { resolveTimeoutBudgets } from '@/lib/llm/timeout-policy';
```
Delete this line (confirmed its only call site in this file is the block being deleted next).

Replace the deadline computation and its use in the transaction (current lines 248-264):

Old:
```
      const deadlineAt = new Date(
        // Hard cap, mirroring run-launch.ts: a judgment may legally run to the
        // cap, so a deadline sized on the initial budget would let the reaper
        // abandon work that is still executing.
        Date.now() + modelSelections.length * resolveTimeoutBudgets().hardCapMs + DEADLINE_SLACK_MS
      );

      const run = await prisma.$transaction(async (tx) => {
        const createdRun = await tx.evaluationRun.create({
          data: {
            evaluationId: msg.evaluationId,
            rubricId: msg.runSpec.rubricId ?? null,
            protocol: msg.runSpec.protocol,
            status: 'pending',
            deadlineAt,
            triggeredById: msg.runSpec.triggeredById,
          },
        });
```

New:
```
      // 2026-09-03: deadlineAt is deliberately OMITTED here — it defaults
      // to null and stays null until src/worker/claim.ts's
      // stampRunStartedAtFirstDequeue sets it at FIRST DEQUEUE, sized on
      // THIS run's own judgment count and measured from the moment a
      // worker actually claims it. This consumer used to compute its own
      // creation-time deadline here, independently of run-launch.ts's
      // (now-also-deleted) formula — the THIRD of three call sites that
      // all had to agree, and the one most likely to be missed exactly
      // because it lived in a different file from the other two.
      const run = await prisma.$transaction(async (tx) => {
        const createdRun = await tx.evaluationRun.create({
          data: {
            evaluationId: msg.evaluationId,
            rubricId: msg.runSpec.rubricId ?? null,
            protocol: msg.runSpec.protocol,
            status: 'pending',
            triggeredById: msg.runSpec.triggeredById,
          },
        });
```

- [ ] **Step 4: run it, confirm green**

```bash
cd /root/judge-arena && sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.integration.config.ts tests/integration/worker-claims.test.ts'
```
Expected: the new test passes; the pre-existing `'run.create redelivery is idempotent...'` and `'run.create expansion failure...'` tests are unaffected (neither reads `deadlineAt`).

- [ ] **Step 5: INJECTION**

Re-add a hardcoded, unconditional deadline:
```ts
            deadlineAt: new Date(Date.now() + 999_999_999),
```
(insert back after `status: 'pending',` in the `tx.evaluationRun.create` data object).

Run:
```bash
cd /root/judge-arena && sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.integration.config.ts tests/integration/worker-claims.test.ts'
```

**Exact expected RED:** the new test fails, `expected 2026-...T...Z to be null`. Restore Step 3's version and re-run Step 4 to confirm green again.

- [ ] **Step 6: gates**

```bash
cd /root/judge-arena && npm run lint && npx tsc --noEmit && npm run test:integration
```
Confirm 0 lint warnings, tsc clean, and the full integration suite is green. Predicted total: 92 + 1 = **93**. *(A prediction to check against — use whatever the run prints.)*

- [ ] **Step 7: commit**

```bash
cd /root/judge-arena && git add src/worker/run-create-consumer.ts tests/integration/worker-claims.test.ts
git commit -m "$(cat <<'EOF'
fix(worker): run-create-consumer stops computing its own creation-time deadline

The third of three independent call sites that used to stamp
EvaluationRun.deadlineAt at creation (run-launch.ts and calibration/
launch.ts were the other two, removed in the prior commit) — this one
computed its own copy of the formula, in a different file, and was the
one most likely to be missed in a partial fix. deadlineAt is now omitted
from the create() call and defaults to null, stamped later at first
dequeue by src/worker/claim.ts's stampRunStartedAtFirstDequeue.

All three call sites now agree: EvaluationRun.deadlineAt is null at
creation, always, for every launch path.

Gates: lint 0, tsc 0, 1007 unit (no new unit tests; src/worker/** re-measured) / n/a (not touched by this task) db / 93 integration, coverage 0.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WT7bB4SAZpJtRDEGhpGyRv
EOF
)"
```

---

## Task 6: raise `MAX_CALIBRATION_ITEMS` to 1000 (gated on Tasks 1-5)

**Files:**
- Modify: `/root/judge-arena/src/lib/calibration/launch.ts`
- Modify: `/root/judge-arena/docs/runbooks/scoring-a-judge-against-a-golden-set.md` (no code change)
- Modify (Test): `/root/judge-arena/tests/db/calibration-link.test.ts`

**Interfaces:**
- `MAX_CALIBRATION_ITEMS` changes from `100` to `1000`. No signature change — `launchCalibrationRun`'s refusal at items.length > `MAX_CALIBRATION_ITEMS` already reads the symbol, not a literal, so the existing `refuses more than ${MAX_CALIBRATION_ITEMS} items` test needs no edit.

- [ ] **Step 0: confirm this is the LAST task, and confirm the anchor**

```bash
cd /root/judge-arena && git log --oneline -5
```
Confirm Tasks 1-5's five commits are all present (subjects matching this plan's Commit shape table, entries A-E) before proceeding — this task's own safety argument (the never-started net sized against the raised cap) is meaningless if Task 3 has not landed.

```bash
cd /root/judge-arena && sed -n '62,71p' src/lib/calibration/launch.ts
```

- [ ] **Step 1: write the failing test**

Add a new `it` to `/root/judge-arena/tests/db/calibration-link.test.ts`, immediately before the existing `it('refuses more than ${MAX_CALIBRATION_ITEMS} items rather than silently truncating', ...)` test:

```ts
  it('MAX_CALIBRATION_ITEMS is 1000 — raised from 100, gated on the deadline-at-first-dequeue fix landing (see reaper.ts NEVER_STARTED_TIMEOUT_MS)', () => {
    expect(MAX_CALIBRATION_ITEMS).toBe(1000);
  });

```

(This is a plain synchronous assertion — no `async`, no DB access needed; it can sit inside the same `describe` block as the existing cap test without any fixture setup.)

**What this pin does and does not guard, stated rather than assumed.** It pins the deliberate value against an
accidental revert, and nothing more — its Step 5 injection is the change itself, so it cannot discriminate any wrong
implementation except a different literal. The two guards that actually carry this task are elsewhere and are
already in the tree by the time it runs: (a) the pre-existing `refuses more than ${MAX_CALIBRATION_ITEMS} items`
test, which reads the SYMBOL and therefore now exercises the 1000/1001 boundary for real; and (b) Task 3's
relationship guard, `NEVER_STARTED_TIMEOUT_MS > MAX_CALIBRATION_ITEMS * 3 * hardCapMs`, which is what makes raising
the cap safe rather than merely permitted, and which goes red if a future raise outgrows the net.

A behavioural test ("a 101-item set, refused under the old cap, now launches all 101 runs") was CONSIDERED and NOT
added: `mkWorld({ items: N })` creates each `GoldenItem` in a sequential `await` loop and `launchCalibrationRun`
then launches N runs in another, so its runtime at N=101 is unmeasured and would need a guessed timeout — a test
whose flakiness reads as an environment failure is worse than no test. If it is wanted later, measure `mkWorld`'s
per-item cost first and set the timeout from the measurement, not from a guess.

- [ ] **Step 2: run it, confirm the exact FAIL**

```bash
cd /root/judge-arena && sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.db.config.ts tests/db/calibration-link.test.ts'
```

**Exact expected FAIL:** `MAX_CALIBRATION_ITEMS` is still `100`. `expect(MAX_CALIBRATION_ITEMS).toBe(1000)` fails: `expected 100 to be 1000`. **Predicted, not observed.**

- [ ] **Step 3: minimal implementation**

In `/root/judge-arena/src/lib/calibration/launch.ts`, replace `MAX_CALIBRATION_ITEMS`'s declaration and doc (current lines 62-71):

Old:
```
/**
 * Phase-1 cap on items per calibration. A STATED LIMIT THAT REFUSES, never a
 * silent `take: 100` — a truncated calibration produces a kappa over a subset
 * nobody chose, reported as if it measured the whole set, and there is nothing
 * in the numbers afterwards that says so. 100 items × one judge is already
 * ~3.5 hours of queue against a 2-slot local server; the way to lift this is
 * the deadline fix named in `LaunchSingleRunParams.deadlineAt` (stamp at first
 * dequeue), not a bigger number here.
 */
export const MAX_CALIBRATION_ITEMS = 100;
```

New:
```
/**
 * Cap on items per calibration. A STATED LIMIT THAT REFUSES, never a silent
 * `take: N` — a truncated calibration produces a kappa over a subset nobody
 * chose, reported as if it measured the whole set, and there is nothing in
 * the numbers afterwards that says so.
 *
 * ── RAISED FROM 100 TO 1000, 2026-09-03, GATED ON THE DEADLINE FIX ─────────
 * The 100 cap existed because `EvaluationRun.deadlineAt` used to be stamped
 * at CREATION, sized on queue position — a large batch's tail could be
 * force-finalized by `src/worker/reaper.ts` while still healthily queued
 * (the bug that cost 4 of 30 items on a real calibration). That mechanism
 * is gone: `src/worker/claim.ts`'s `stampRunStartedAtFirstDequeue` now
 * stamps the deadline at FIRST DEQUEUE, sized on THIS run's own judgment
 * count (always 1 here) — immune to how long this item waited in queue.
 * See `docs/superpowers/plans/2026-09-03-deadline-at-first-dequeue.md` for
 * the fix and this constant's own raise.
 *
 * 1000 is not "as high as possible" — it is sized against
 * `src/worker/reaper.ts`'s `NEVER_STARTED_TIMEOUT_MS` (45 days), the ONE
 * remaining bound on a never-dequeued run once the execution deadline
 * stops depending on queue position, and it is sized on the LEGAL bound
 * rather than on measured throughput. A calibration serialises through ONE
 * judge's gate; each item may legally run to `hardCapMs` (900_000 ms) and
 * be delivered up to `MAX_ATTEMPTS` (3) times, so 1000 items is
 * 1000 x 3 x 900_000 ms = 750 h = 31.25 days of legal occupancy — inside
 * the 45-day net. (Measured throughput is far kinder: at 5.03 min/item a
 * 30-item calibration ran 151 minutes, which extrapolates to ~3.49 days
 * for 1000 items. That is the EXPECTATION; the net is sized on the bound,
 * because sizing a force-finalize threshold on an expectation is the
 * original defect.) The named target — "JudgeBench pairwise — full", 620
 * items, seeded but previously unrunnable under the 100 cap — is 19.4 days
 * of legal occupancy and ~52 hours expected, inside both.
 *
 * `tests/integration/finalization.test.ts` pins the RELATIONSHIP
 * (`NEVER_STARTED_TIMEOUT_MS > MAX_CALIBRATION_ITEMS x 3 x hardCapMs`), not
 * a second literal, so raising this number again without revisiting the net
 * goes red rather than silently re-arming the bug.
 *
 * WHAT STILL BOUNDS THIS NUMBER, so it is not "raise it again next time
 * someone wants more": (1) `NEVER_STARTED_TIMEOUT_MS` — raising the item
 * cap further without ALSO reconsidering that timeout reopens the exact
 * race this constant's previous form existed to prevent, just relocated
 * from "queue position at creation" to "never-started safety net fires
 * before the batch finishes draining"; (2) ONE max-size batch per judge
 * lane at a time — the net measures wall clock from `createdAt`, so
 * concurrent batches on the same lane SUM and two of these would exceed
 * it; (3) wall-clock reality — 1000 items at the measured throughput is
 * ~3.5 days for ONE judge against a single-slot server, an operational
 * cost this constant does not make disappear, only survivable;
 * (4) `scripts/calibration/run.ts`'s own `--poll-timeout` (default 3600s)
 * must be raised by the operator to watch a run this size to completion —
 * unrelated to correctness, but worth knowing before launching one.
 */
export const MAX_CALIBRATION_ITEMS = 1000;
```

In `/root/judge-arena/docs/runbooks/scoring-a-judge-against-a-golden-set.md`, two edits:

Old (line 39):
```
> tombstoned, pairwise, ≥1 live item and ≤ `MAX_CALIBRATION_ITEMS` (100), project + rubric exist, a
```
New:
```
> tombstoned, pairwise, ≥1 live item and ≤ `MAX_CALIBRATION_ITEMS` (1000), project + rubric exist, a
```

Old (line 166):
```
# How many live items it has (the runner caps at MAX_CALIBRATION_ITEMS = 100)
```
New:
```
# How many live items it has (the runner caps at MAX_CALIBRATION_ITEMS = 1000)
```

`README.md:549` names `MAX_CALIBRATION_ITEMS` without a literal number (`"no more than \`MAX_CALIBRATION_ITEMS\`"`) — no edit needed there.

- [ ] **Step 4: run it, confirm green**

```bash
cd /root/judge-arena && sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.db.config.ts tests/db/calibration-link.test.ts'
```
Expected: the new pinning test passes; the existing `refuses more than ${MAX_CALIBRATION_ITEMS} items` test also still passes, now creating and refusing **1001** items instead of 101 (it reads the symbol, not a literal, so this is automatic).

**Do not hope it fits in the default timeout — give it one.** Neither `vitest.db.config.ts` nor `vitest.config.ts` sets `testTimeout`, so that test runs under vitest's default 5000 ms, and this change takes it from 101 to 1001 `DatasetSample` rows plus 1001 `GoldenItem` rows plus a `findMany` over them. A borderline pass here is indistinguishable from this repo's shared-DB / stopped-container timeout signature, which would read as an environment failure rather than a slow test. Add an explicit per-test timeout as part of this task, in the same edit:

```ts
  it(`refuses more than ${MAX_CALIBRATION_ITEMS} items rather than silently truncating`, async () => {
    // ... body unchanged ...
  }, 30_000); // 2026-09-03: row count went 101 -> 1001 with the cap raise
```

- [ ] **Step 5: INJECTION**

Revert the constant to `100`:
```ts
export const MAX_CALIBRATION_ITEMS = 100;
```
(leave the doc comment as-is for this injection — only the value matters).

Run:
```bash
cd /root/judge-arena && sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.db.config.ts tests/db/calibration-link.test.ts'
```

**Exact expected RED:** the new pinning test fails, `expected 100 to be 1000`. Restore `MAX_CALIBRATION_ITEMS = 1000` and re-run Step 4 to confirm green again.

- [ ] **Step 6: gates — the FULL chain, once, for the whole plan**

```bash
cd /root/judge-arena && npm run lint && npx tsc --noEmit
npm run test:coverage 2>&1 | tail -25
npm run test:db:coverage 2>&1 | tail -25
npm run test:integration 2>&1 | tail -15
npm run build
```
Confirm every gate is clean, no coverage floor is breached anywhere (per-glob or aggregate), and the final counts are the running totals this plan predicts: **1007 unit / 680 db / 93 integration** (`1002+5`; `679+1`; `82+4+6+1` — Task 2 adds 4, Task 3 adds 6, Task 5 adds 1, Task 4 is 1-for-1 in the db tier). The true numbers are whatever each task's own gate step actually printed; treat this plan's arithmetic as a prediction to check against, never as the assertion itself, per the Measurements section's own framing.

- [ ] **Step 7: commit**

```bash
cd /root/judge-arena && git add src/lib/calibration/launch.ts docs/runbooks/scoring-a-judge-against-a-golden-set.md tests/db/calibration-link.test.ts
git commit -m "$(cat <<'EOF'
feat(calibration): raise MAX_CALIBRATION_ITEMS to 1000, gated on the deadline-at-first-dequeue fix

The 100 cap existed because a large batch's tail could be force-finalized
by the reaper while still healthily queued — the bug that cost 4 of 30
items on a real calibration. That mechanism is gone as of the prior five
commits: EvaluationRun.deadlineAt is stamped at first dequeue, sized on
each run's own judgment count, immune to queue position.

1000 is sized against reaper.ts's NEVER_STARTED_TIMEOUT_MS (45 days) on
the LEGAL bound, not on measured throughput: 1000 items x MAX_ATTEMPTS (3)
x hardCapMs (900s) = 31.25 days of legal occupancy, inside the net. At the
measured 5.03 min/item it is ~3.49 days, but that is an expectation, and
sizing a force-finalize threshold on an expectation is the original
defect. The relationship is pinned by a test rather than restated as a
second literal. The named target, the seeded 620-item "JudgeBench pairwise
— full" golden set, is 19.4 days legal / ~52 hours expected and was
previously unrunnable under the 100 cap. Also raises the refusal test's
per-test timeout to 30s, since its row count goes 101 -> 1001. Updates the
two runbook mentions of the old literal; README.md names the symbol
without a literal and needs no change.

Gates: lint 0, tsc 0, 1007 unit / 680 db / 93 integration, coverage 0.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WT7bB4SAZpJtRDEGhpGyRv
EOF
)"
```

---

## Promotion preconditions and rollback (the OPERATOR's, not this plan's)

**This plan never pushes, never promotes and never mutates the cluster.** Everything in this section is an operator
action, recorded here because the plan's own analysis is what makes it necessary — not as a step for the executor to run.
The only commands given as runnable blocks are READ-ONLY.

### Before promoting

1. **Re-run the row check at promotion time, not from this document.** The "zero pending/judging rows" note in
   Measurements is an authoring-day snapshot (2026-09-03), not a property of the future:

   ```bash
   kubectl -n tenant-public exec judge-arena-pg-1 -c postgres -- psql -U postgres -d judge_arena -tAc \
     "select status, count(*) from \"EvaluationRun\" where status in ('pending','judging') group by 1;"
   ```

   Any rows here are governed by the OLD creation-time deadline and are **not** re-stamped by the new code — the stamp's
   guard is `deadlineAt IS NULL` and these rows are non-null — so they keep the old queue-position semantics, and the old
   bug, until they drain. The two reaper arms cannot both match one row (arm 1 needs `deadlineAt < now`, UNKNOWN for
   NULL; arm 2 needs `deadlineAt IS NULL`), so there is no double-regime hazard; the population simply ages out.

2. **Roll `judge-arena-worker` to the new SHA and confirm it Ready BEFORE `judge-arena-web`.** Verified 2026-09-03: these
   are two separate Deployments on the same image tag (`node worker.js` and `node server.js`), which roll independently.
   `judge-arena-web` is what CREATES runs (`launchSingleRun`, `launchCalibrationRun`, and the runbook's
   `kubectl exec deploy/judge-arena-web -- node /app/calibration-run.js`); `judge-arena-worker` is what OWNS
   `stampRunStartedAtFirstDequeue`, `clearRunDeadlineOnRequeue` and `NEVER_STARTED_TIMEOUT_MS`. **Rolling web first opens
   a real window** — a run created by the new web and claimed by an old worker gets no stamp, and until a new worker pod
   exists nothing can sweep it either. This is a DEPLOY-order property; it is not what the commit order protects
   (all six commits ship in one image — see **Depends on**).

3. **Do not launch a calibration until BOTH deployments report the new SHA:**

   ```bash
   kubectl -n tenant-public get pods -o custom-columns=NAME:.metadata.name,IMAGE:.spec.containers[*].image | grep judge-arena
   ```

### If this image is rolled back

**Named outcome: silent permanent stranding.** The old `sweepOverdueRuns` predicate is `deadlineAt: { lt: new Date(now) }`
(`src/worker/reaper.ts:305` before this change), and `NULL < now` is UNKNOWN, so every run created while the new image was
live — all of which have `deadlineAt IS NULL` until claimed — matches nothing, forever. Such a run sits `pending`/`judging`
for the life of the database: its judgments are never republished and never abandoned, `maybeFinalizeRun` is never called
for it, `src/app/api/stats/route.ts` counts it as active permanently, and `src/worker/run-create-consumer.ts:182` dedupes
away every future `run.create` for its evaluation. For a calibration it also leaves the golden set frozen
(irreversible, `src/lib/golden-sets.ts`) against a calibration that can never complete.

Read-only check to run BEFORE deciding to revert:

```bash
kubectl -n tenant-public exec judge-arena-pg-1 -c postgres -- psql -U postgres -d judge_arena -tAc \
  "select count(*) from \"EvaluationRun\" where status in ('pending','judging') and \"deadlineAt\" is null;"
```

If that count is non-zero, the revert is not free. The remediation is an operator-run `UPDATE` setting `deadlineAt` to
`now()` on exactly those rows, which hands them back to the old reaper's republish-then-abandon path — and that path will
force-finalize any of them whose work is still healthily queued. **That trade-off is the decision, and it is the
operator's; this plan neither runs nor schedules it.**

---

## Post-landing notes (not this plan's to act on)

- **Production had zero applicable rows on 2026-09-03.** The read-only `psql` check in Measurements found no `pending`/`judging` `EvaluationRun` in production that day, so there was nothing to backfill then. **That is a snapshot, not a promotion-time guarantee** — see Promotion preconditions above for the check to re-run, and for what happens to any rows that DO exist (they keep the old creation-time semantics until they drain; they are never re-stamped).
- **`scripts/calibration/run.ts --poll-timeout`** defaults to 3600s (1 hour). An operator launching a calibration anywhere near the new 1000-item cap must raise it explicitly (e.g. to cover several days at the measured ~5 min/item, and it is the operator's own detector long before `NEVER_STARTED_TIMEOUT_MS` fires) or the script will stop polling and "score what landed" long before the batch drains — not a correctness bug, but worth knowing before using the raised cap for real.
- **`EVALUATION_MODEL_TIMEOUT_MS`** (`src/lib/run-launch.ts`) is confirmed dead code (no importer anywhere in `src/` or `tests/`) both before and after this plan, and its doc comment was corrected in Task 4 rather than left claiming a relationship that no longer holds. Deleting the export entirely is an unrelated cleanup, deliberately out of scope here — see the finding in the final report.
- **`RunStatus.judging` is defined in the schema and read in several places (`src/app/api/stats/route.ts`, `src/lib/run-finalizer.ts`'s `ACTIVE_RUN_STATUSES`, multiple frontend pages) but is never WRITTEN by any backend code** — confirmed by exhaustive grep. This plan does not touch it: `stampRunStartedAtFirstDequeue` (Task 2) was deliberately scoped to `deadlineAt` only. See the final report for this as a standalone finding, not something this plan fixes.
