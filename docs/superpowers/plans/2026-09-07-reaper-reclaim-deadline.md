# Reaper Reclaim Deadline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the reaper force-finalizing the very judgment it just reclaimed, by clearing the run's execution deadline on the reclaim path as every other requeue path already does.

**Architecture:** One call added to `reclaimStaleJudgments`, after a successful republish. No schema change, no constant change, no new module.

**Tech Stack:** TypeScript, Prisma/PostgreSQL, RabbitMQ, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-07-reaper-reclaim-deadline-design.md`

**Branch:** `feat/ba-sweep-position-bias` @ `c555969`, green (1068 unit / 686 db / 93 integration / tsc clean).

## Global Constraints

- **Coverage floors do not move.** `vitest.db.config.ts:165` `branches: 77` against 77.31% — a 0.31pp margin. Note `src/worker/claim.ts` reads `(empty-report)` in `coverage-db/lcov.info`, so branches there are not counted by the db run; confirm where `reaper.ts` is instrumented before assuming a new branch is free.
- **`npx tsc --noEmit` AND the FULL `npx vitest run` both, every time.** Two blocking CI failures escaped this branch by running a named subset.
- **`npm run test:db` and the integration suite run ALONE.** `npm run test:db -- <file>` silently ignores the file argument.
- **`grep -a` always.** Never remove the NUL byte in `src/lib/calibration/readings.ts`.
- **A NULL `deadlineAt` must keep meaning "the 45-day never-started net applies."** A previous attempt at a different deadline fix was reverted precisely because it wrote a value instead of nulling and turned a safe state into an abandonment.
- **Do not change** `LEASE_MS`, `RUN_DEADLINE_SLACK_MS`, `POST_CALL_SLACK_MS`, `FORCE_FINALIZE_GRACE_MS`, or `NEVER_STARTED_TIMEOUT_MS`.
- **Never run anything against production.**

---

### Task 1: Clear the run deadline when the reaper reclaims a stale judgment

**Files:**
- Modify: `src/worker/reaper.ts` (`reclaimStaleJudgments`, ~lines 315-350)
- Test: `tests/integration/worker-claims.test.ts`

**Interfaces:**
- Consumes: `clearRunDeadlineOnRequeue(runId)` from `src/worker/claim.ts:284` — already exported and already used by `src/worker/judgment-consumer.ts:1346`.
- Produces: no new exports.

- [ ] **Step 1: Write the failing test — the full trace, asserting the outcome**

In `tests/integration/worker-claims.test.ts`. This must assert a judgment's **status**, not a predicate — a prior fix in this area passed a test that only checked its own new field while the behaviour was still wrong.

```ts
it('does NOT abandon a judgment the same sweep just reclaimed', async () => {
  // The production trace, reproduced: cmtluq5t5038x2l0s83p3h1aw, the single
  // `reaper: abandoned` row in 4200, inside calibration cmtluplg5.
  // LEASE_MS (hardCap + 30s) expires 30s BEFORE runStartBudgetMs(1)
  // (hardCap + 60s), so a stale reclaim always lands at or past the run's own
  // deadline — and sweepOverdueRuns runs LATER IN THE SAME SWEEP than
  // reclaimStaleJudgments.
  const { runId, judgmentId } = await seedClaimedJudgment();

  // Lease expired, deadline already passed, past the force-finalize grace.
  await prisma.modelJudgment.update({
    where: { id: judgmentId },
    data: { status: 'running', startedAt: minutesAgo(40) },
  });
  await prisma.evaluationRun.update({
    where: { id: runId },
    data: { deadlineAt: minutesAgo(20) },
  });

  await runReaperSweep();

  const after = await prisma.modelJudgment.findUniqueOrThrow({ where: { id: judgmentId } });
  expect(after.status).toBe('pending');
  expect(after.error).toBeNull();
  // and specifically NOT the corpse we are fixing
  expect(after.error).not.toMatch(/reaper: abandoned/);
});

it('clears the run deadline on a successful reclaim', async () => {
  const { runId, judgmentId } = await seedClaimedJudgment();
  await prisma.modelJudgment.update({
    where: { id: judgmentId },
    data: { status: 'running', startedAt: minutesAgo(40) },
  });

  await runReaperSweep();

  const run = await prisma.evaluationRun.findUniqueOrThrow({ where: { id: runId } });
  expect(run.deadlineAt).toBeNull();
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run --config vitest.integration.config.ts tests/integration/worker-claims.test.ts` (ALONE)
Expected: FAIL — the first test finds `status: 'error'` with `reaper: abandoned`; the second finds a non-null `deadlineAt`.

- [ ] **Step 3: Implement**

In `src/worker/reaper.ts`'s `reclaimStaleJudgments`, inside the per-judgment loop, **after** the `publishJudgmentExecute` call succeeds:

```ts
      // The run's execution deadline was sized for a judgment that is no
      // longer executing. Every OTHER running -> pending path clears it —
      // judgment-consumer.ts:1346 on a retryable error — and claim.ts:252-254
      // states the invariant this restores: "deadlineAt is non-null EXACTLY
      // WHILE the run has a claimed judgment in flight."
      //
      // Without it this sweep kills the judgment it just rescued.
      // LEASE_MS is hardCapMs + 30_000 and runStartBudgetMs(1) is
      // hardCapMs + 60_000, so a stale reclaim lands 30s or more PAST the
      // run's own deadline; sweepOverdueRuns then runs later in this SAME
      // runReaperSweep() call, sees deadlineAt < now, and stamps every
      // `pending` judgment on the run `reaper: abandoned` — including this
      // one, which is `pending` because we just made it so. One production
      // judgment (cmtluq5t5038x2l0s83p3h1aw) died exactly this way.
      //
      // AFTER the publish, never before: clearing first and then failing to
      // publish leaves a `pending` judgment with no deadline AND no queue
      // message, reachable only by the 45-day never-started net. Best-effort,
      // like the consumer's call — a failure here must not fail the reclaim.
      try {
        await clearRunDeadlineOnRequeue(judgment.runId);
      } catch (error) {
        logger.error('reaper: failed to clear the run deadline after reclaiming a stale judgment', {
          judgmentId: judgment.id,
          runId: judgment.runId,
          error: serializeError(error),
        });
      }
```

Add `clearRunDeadlineOnRequeue` to the existing import from `./claim`.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run --config vitest.integration.config.ts tests/integration/worker-claims.test.ts` (ALONE)
Expected: PASS.

- [ ] **Step 5: Prove the test DISCRIMINATES**

Revert `src/worker/reaper.ts` alone (keep the tests), re-run, and confirm the first test FAILS with the judgment in `status: 'error'`. Restore the fix. **Record the actual output in the report.** A test that passes on unfixed code is not a regression test — this is the specific failure mode that let a bad fix through earlier on this branch.

- [ ] **Step 6: Full gate suite**

```bash
npx tsc --noEmit
npx vitest run                                    # FULL unit suite
npm run test:db                                   # ALONE
npx vitest run --config vitest.integration.config.ts   # ALONE
npm run lint
```
Expected: all green; no coverage threshold moved.

- [ ] **Step 7: Commit**

```bash
git add src/worker/reaper.ts tests/integration/worker-claims.test.ts
git commit -m "fix(reaper): clear the run deadline when reclaiming a stale judgment

reclaimStaleJudgments was the only running -> pending path that left
EvaluationRun.deadlineAt set. Because LEASE_MS is hardCapMs + 30s while
runStartBudgetMs(1) is hardCapMs + 60s, a stale reclaim always lands at or
past the run's own deadline — and sweepOverdueRuns runs later in the SAME
runReaperSweep() call, so it force-finalized the judgment the reclaim had just
rescued.

One production judgment died this way: cmtluq5t5038x2l0s83p3h1aw, the single
reaper: abandoned row in 4200, inside the qwen3.5:9b calibration. Its
deadlineAt is startedAt + 960_000 to the millisecond and its updatedAt is
deadlineAt + ~196s — the force-finalize grace plus sweep granularity. So one
of that run's 164 'errors' was an infrastructure kill scored as a judge
failure.

Restores the invariant claim.ts:252-254 already states: deadlineAt is non-null
EXACTLY WHILE the run has a claimed judgment in flight. Cleared AFTER the
publish, best-effort, exactly as judgment-consumer.ts:1346 does it."
```

---

### Task 2: Record the corpse where the number is read

The published `noVerdictRate` for calibration `cmtluplg5` is 0.2645 (164/620) — the figure that pushed it past 0.25 and out of the rankings. At least one of those 164 is this bug, not the judge.

**Files:**
- Modify: `docs/calibration-scoreboard-2026-09-06.md`

- [ ] **Step 1: Add the note.** Against the `cmtluplg5` row, record that one of its 164 no-verdicts is `reaper: abandoned` (`cmtluq5t5038x2l0s83p3h1aw`) and was an infrastructure kill of a healthy, queued judgment — not a judge failure. Cite the fix commit.

- [ ] **Step 2: Do NOT re-score the run.** `scoreCalibrationRun` is a full overwrite and the run is terminal and published; the note is the correction, not a recomputation. Re-scoring would also move `finishedAt` and stamp the current `scoringVersion`.

- [ ] **Step 3: Commit.**

---

## What this plan deliberately does NOT do

- **It does not touch the multi-judge sibling-restamp case.** Zero occurrences in 4200 runs, already documented as an accepted limit at `claim.ts:168-177`. Leave the doc; change nothing.
- **It does not re-tune any timeout constant.** The `LEASE_MS` / `RUN_DEADLINE_SLACK_MS` collision is real, but widening the gap moves the collision rather than removing it — a queued judgment's legitimate wait is queue depth, which the design deliberately refuses to measure.
- **It does not move `deadlineAt` to `ModelJudgment`.** That is the structurally correct long-term shape and remains open; it needs a migration and a reaper rewrite touching every run type, and it is not required to stop this bug.

## Sequencing

Land this **before** any permuted sweep on a deep lane. PermutedRun turns N runs into 2N single-judgment runs, each carrying the same 16-minute budget that produced the fatality — a 620-item permuted run is 1240 single-judgment runs on one serial lane, and 11.9% of production judgments already take a second claim.
