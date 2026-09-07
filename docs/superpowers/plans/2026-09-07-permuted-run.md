# PermutedRun Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a calibration be launched in both candidate orders, as 2N `EvaluationRun`s with one `ModelJudgment` each, and report position bias from the pair — without touching the `GoldenSet`.

**Architecture:** The order discriminator moves from `ModelJudgment` up to `EvaluationRun`. A permuted calibration creates N `Evaluation`s and 2N `EvaluationRun`s, each with exactly one judgment — restoring the invariant the timeout model assumes. `RunCandidate` rows are copied verbatim; the swap stays at render time, applied once by `render.ts` and undone once by `readings.ts`.

**Tech Stack:** TypeScript, Next.js, Prisma/PostgreSQL, RabbitMQ, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-07-permuted-run-design.md`

**Branch:** `feat/ba-sweep-position-bias` @ `cb5e6a4`, green (1068 unit / 686 db / 93 integration / tsc clean).

## Global Constraints

- **Coverage floors do not move.** `vitest.db.config.ts:165` `branches: 77` against a measured 77.31% — a 0.31pp margin. `src/worker/**` 114/125 vs floor 87. Every new branch ships with a test.
- **`tests/integration/**` has NO coverage instrumentation.** Logic pinned only there counts as uncovered.
- **Every reviewer and implementer runs `npx tsc --noEmit` AND the FULL `npx vitest run`.** Two blocking CI failures escaped this branch by running a named subset.
- **`npm run test:db` runs ALONE**, never concurrently — one shared `judge_arena_test` DB. Note `npm run test:db -- <file>` **silently ignores the file argument** and runs all 686.
- **`grep -a` always.** `src/lib/calibration/readings.ts` and `scripts/importer/reconcile.ts` carry a deliberate NUL. Never remove it.
- **Never hand-apply a migration to production.** Production migrations run via a Helm pre-upgrade hook.
- **`GoldenItem.expected` is NEVER inverted, and `RunCandidate.position` is NEVER swapped.** Both are the no-symptom sign error (spec §5, build W).
- Stored `rawAgreement`/`kappa`/`verdictCount`/`committedCount`/`selectiveAccuracy` stay **AB-only** (spec D4).

---

### Task 1: Migration `v2p` — the order discriminator on `EvaluationRun`

**Files:**
- Create: `prisma/migrations/20260907170000_v2p_evaluation_run_pair_order/migration.sql`
- Modify: `prisma/schema.prisma` (`EvaluationRun`), `CONTRIBUTING.md:78`
- Test: `tests/db/calibration-link.test.ts`

**Interfaces:**
- Produces: `EvaluationRun.pairOrder String?`; unique index `EvaluationRun_calibrationRunId_goldenItemId_pairOrder_key` (partial, `NULLS NOT DISTINCT`); check constraint `EvaluationRun_calibration_needs_order`.

- [ ] **Step 1: Write the failing db tests**

In `tests/db/calibration-link.test.ts`:

```ts
it('rejects a second run for the same (calibrationRun, goldenItem, pairOrder)', async () => {
  await createCalibrationEvaluationRun({ calibrationRunId, goldenItemId, pairOrder: 'AB' });
  await expect(
    createCalibrationEvaluationRun({ calibrationRunId, goldenItemId, pairOrder: 'AB' })
  ).rejects.toMatchObject({ code: 'P2002' });
});

it('ACCEPTS the same (calibrationRun, goldenItem) at the OTHER pairOrder', async () => {
  await createCalibrationEvaluationRun({ calibrationRunId, goldenItemId, pairOrder: 'AB' });
  await expect(
    createCalibrationEvaluationRun({ calibrationRunId, goldenItemId, pairOrder: 'BA' })
  ).resolves.toBeTruthy();
});

it('still lets two ORDINARY runs coexist — the partial predicate keeps them out of the index', async () => {
  // Without `WHERE "calibrationRunId" IS NOT NULL`, NULLS NOT DISTINCT makes
  // every ordinary run's (NULL, NULL, NULL) equal and THIS fails P2002.
  await prisma.evaluationRun.create({ data: ordinaryRun() });
  await expect(prisma.evaluationRun.create({ data: ordinaryRun() })).resolves.toBeTruthy();
});

it('refuses a calibration run with no pairOrder — the CHECK constraint', async () => {
  await expect(
    prisma.$executeRawUnsafe(
      `insert into "EvaluationRun" (id, "evaluationId", "calibrationRunId", "goldenItemId", status, "createdAt", "updatedAt")
       values ($1,$2,$3,$4,'pending',now(),now())`,
      'er-no-order', evaluationId, calibrationRunId, goldenItemId
    )
  ).rejects.toThrow(/EvaluationRun_calibration_needs_order/);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm run test:db` (ALONE — the file argument is ignored)
Expected: the BA-accepted and CHECK tests fail.

- [ ] **Step 3: Write the migration**

`prisma/migrations/20260907170000_v2p_evaluation_run_pair_order/migration.sql`:

```sql
-- v2p. The order discriminator moves from ModelJudgment up to EvaluationRun,
-- so a permuted calibration is 2N runs with ONE judgment each rather than N
-- runs with two. That restores the invariant timeout-policy.ts:230-258 states
-- outright ("it is always 1 ... queue-depth independence is the entire
-- point"), which the two-judgments-per-run shape had broken.
--
-- Hand-written, not Prisma-generated: the DSL cannot express a partial index,
-- NULLS NOT DISTINCT, or a CHECK. This is the ninth hand-edited migration in
-- the repo (CONTRIBUTING.md).
--
-- BACKFILL IS EXACT: all 4200 production ModelJudgment rows carry
-- pairOrder 'AB' — zero 'BA', zero NULL — so every existing calibration run
-- genuinely presented AB and the CHECK below is satisfiable without guessing.

DROP INDEX "EvaluationRun_calibrationRunId_goldenItemId_key";

ALTER TABLE "EvaluationRun" ADD COLUMN "pairOrder" TEXT;

UPDATE "EvaluationRun" SET "pairOrder" = 'AB' WHERE "calibrationRunId" IS NOT NULL;

-- THREE clauses, all load-bearing. A plain
-- @@unique([calibrationRunId, goldenItemId, pairOrder]) gets all three wrong.
--
-- WHERE: ordinary (non-calibration) runs leave the index entirely. Without it
-- the NULLS NOT DISTINCT below makes every ordinary run's (NULL, NULL, NULL)
-- equal to every other's, and the SECOND ordinary run ever launched fails
-- P2002.
--
-- NULLS NOT DISTINCT: inside the calibration partition, two rows with a NULL
-- order must still collide. Postgres' default NULLS DISTINCT would silently
-- delete the idempotency guard score.ts relies on to know its source rows
-- cannot be double-counted.
CREATE UNIQUE INDEX "EvaluationRun_calibrationRunId_goldenItemId_pairOrder_key"
  ON "EvaluationRun" ("calibrationRunId", "goldenItemId", "pairOrder")
  NULLS NOT DISTINCT
  WHERE "calibrationRunId" IS NOT NULL;

-- Makes "a calibration run always names its order" a database fact rather than
-- a convention, so a later writer cannot produce a row score.ts would silently
-- file into the wrong partition.
ALTER TABLE "EvaluationRun" ADD CONSTRAINT "EvaluationRun_calibration_needs_order"
  CHECK ("calibrationRunId" IS NULL OR "pairOrder" IS NOT NULL);
```

- [ ] **Step 4: Mirror it in the schema**

`prisma/schema.prisma`, in `EvaluationRun`. Replace the old `@@unique([calibrationRunId, goldenItemId])` with a comment pointing at the hand-written index (Prisma cannot express it), and add:

```prisma
  /// v2p. Which candidate order this run PRESENTED. NULL on every ordinary run
  /// and every pointwise run; non-NULL on every calibration run, enforced by
  /// the CHECK constraint EvaluationRun_calibration_needs_order.
  ///
  /// This is the discriminator that lets a permuted calibration hold two runs
  /// per golden item while keeping ONE judgment per run — see
  /// docs/superpowers/specs/2026-09-07-permuted-run-design.md D1.
  ///
  /// Mirrored onto this run's single ModelJudgment.pairOrder in the same
  /// nested create. score.ts THROWS if the two ever disagree (trap T3): the
  /// renderer reads the judgment's copy and the scorer reads this one, so a
  /// divergence files a row into one partition and resolves it as if it were
  /// the other — and the constant floor still reads 0.5419, so nothing looks
  /// wrong.
  pairOrder          String?
```

- [ ] **Step 5: Update the hand-edited-migration count**

`CONTRIBUTING.md:78` — "eight" becomes "nine". Same commit; the count is the index a reader uses to find them.

- [ ] **Step 6: Run the db suite**

Run: `npx prisma generate && npm run test:db` (ALONE)
Expected: 690/690 (686 + the 4 new).

- [ ] **Step 7: Commit**

```bash
git add prisma/ CONTRIBUTING.md tests/db/calibration-link.test.ts
git commit -m "feat(schema): v2p — the pair order discriminator moves to EvaluationRun

Hand-written: a partial unique index with NULLS NOT DISTINCT plus a CHECK,
none of which Prisma's DSL can express. All three clauses are load-bearing —
without the partial predicate the second ordinary run ever launched fails
P2002, and without NULLS NOT DISTINCT the calibration idempotency guard
silently disappears.

Backfill to 'AB' is exact: all 4200 production judgments are already 'AB'."
```

---

### Task 2: Launch — one judgment per run, two runs per `Evaluation`

**Files:**
- Modify: `src/lib/run-launch.ts` (`LaunchSingleRunParams`, the judgment create, the `EvaluationRun` create)
- Modify: `src/lib/calibration/launch.ts` (the item loop, `LaunchCalibrationRunParams`)
- Test: `tests/db/calibration-link.test.ts`

**Interfaces:**
- Consumes: `PairOrder` from `src/lib/pair-order.ts` (already on the branch).
- Produces: `LaunchSingleRunParams.pairOrder?: PairOrder` (replaces `orders?: PairOrder[]`); `LaunchCalibrationRunParams.orders?: PairOrder[]` **stays** — it is the per-launch opt-in of spec D5.

- [ ] **Step 1: Write the failing test**

```ts
it('creates 2N EvaluationRuns with ONE judgment each for a permuted calibration', async () => {
  const res = await launchCalibrationRun({ ...baseParams, orders: ['AB', 'BA'] }, deps);
  const runs = await prisma.evaluationRun.findMany({
    where: { calibrationRunId: res.calibrationRunId },
    include: { _count: { select: { modelJudgments: true } } },
  });
  expect(runs).toHaveLength(itemCount * 2);
  expect(runs.every((r) => r._count.modelJudgments === 1)).toBe(true);
  expect(runs.filter((r) => r.pairOrder === 'AB')).toHaveLength(itemCount);
  expect(runs.filter((r) => r.pairOrder === 'BA')).toHaveLength(itemCount);
});

it('puts both orders of one item on the SAME Evaluation', async () => {
  const res = await launchCalibrationRun({ ...baseParams, orders: ['AB', 'BA'] }, deps);
  const runs = await prisma.evaluationRun.findMany({ where: { calibrationRunId: res.calibrationRunId } });
  const byEvaluation = new Map<string, number>();
  for (const r of runs) byEvaluation.set(r.evaluationId, (byEvaluation.get(r.evaluationId) ?? 0) + 1);
  expect([...byEvaluation.values()].every((n) => n === 2)).toBe(true);
  // Evaluation.count stays N — the leaderboard and the public counts read it.
  expect(byEvaluation.size).toBe(itemCount);
});

it('defaults to a single AB run per item when orders is omitted', async () => {
  const res = await launchCalibrationRun(baseParams, deps);
  const runs = await prisma.evaluationRun.findMany({ where: { calibrationRunId: res.calibrationRunId } });
  expect(runs).toHaveLength(itemCount);
  expect(runs.every((r) => r.pairOrder === 'AB')).toBe(true);
});

it('copies RunCandidate positions VERBATIM into both orders — no materialised swap', async () => {
  // Swapping position here is spec build W: render.ts re-sorts it, reverses it
  // again, and the mirror prompt comes out byte-identical to AB while
  // readings.ts inverts anyway.
  const res = await launchCalibrationRun({ ...baseParams, orders: ['AB', 'BA'] }, deps);
  const runs = await prisma.evaluationRun.findMany({
    where: { calibrationRunId: res.calibrationRunId },
    include: { runCandidates: { orderBy: { position: 'asc' } } },
  });
  const ab = runs.find((r) => r.pairOrder === 'AB')!;
  const ba = runs.find((r) => r.pairOrder === 'BA' && r.goldenItemId === ab.goldenItemId)!;
  expect(ba.runCandidates.map((c) => c.responseText)).toEqual(ab.runCandidates.map((c) => c.responseText));
  expect(ba.runCandidates.map((c) => c.position)).toEqual([0, 1]);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm run test:db` (ALONE). Expected: FAIL — `orders` fans out judgments, not runs.

- [ ] **Step 3: Singularise the judgment create in `run-launch.ts`**

Replace `orders?: PairOrder[]` in `LaunchSingleRunParams` with:

```ts
  /** A2.2: which candidate order THIS run presents. Written to
   * `EvaluationRun.pairOrder` and mirrored onto the run's single
   * `ModelJudgment.pairOrder` from this one variable, so the two cannot
   * disagree at creation (trap T3). Defaults to `'AB'` for pairwise and is
   * ignored for pointwise. A caller wanting both orders launches TWICE
   * against the same `evaluationId` — one judgment per run is the invariant
   * the deadline model assumes (timeout-policy.ts:230-258). */
  pairOrder?: PairOrder;
```

Revert the `flatMap` at `run-launch.ts:565-590` to a `map` producing exactly one judgment per selected version, with `pairOrder: protocol === 'pairwise' ? (params.pairOrder ?? 'AB') : null`, and add `pairOrder` to the `evaluationRun.create` data from the SAME variable.

- [ ] **Step 4: Loop the orders in `calibration/launch.ts`**

Keep `LaunchCalibrationRunParams.orders?: PairOrder[]` (spec D5, the per-launch opt-in). Inside the item loop, **hoist the `evaluation.create` above** an inner loop over `orders`, and call `launchSingleRun` once per order against the same `evaluation.id`, passing `pairOrder` instead of `orders`.

- [ ] **Step 5: Re-express the item ceiling in ITEMS, not dispatched runs**

`MAX_CALIBRATION_ITEMS = 1000` (`calibration/launch.ts:118`) must keep counting **golden items**, not
`EvaluationRun`s — otherwise a permuted 620-item set dispatches 1240 runs and is refused for no real reason.
The reaper-net bound is unchanged by the reshape and stays a formula:

```
items x orders x MAX_ATTEMPTS(3) x resolveTimeoutBudgets().hardCapMs  <  NEVER_STARTED_TIMEOUT_MS (3.888e9)
```

620 items x 2 orders x 3 x 900_000 = 3.348e9 < 3.888e9, so the flagship corpus fits. Keep
`MAX_PAIRED_CALIBRATION_ITEMS = 719` and its derivation verbatim — the x2 simply moved from `orders` on the
judgment to `orders` on the run. Add an assertion that the ceiling is compared against `items.length`, not
against `items.length * orders.length`.

- [ ] **Step 6: Run the db suite**

Run: `npm run test:db` (ALONE). Expected: green, including the four new tests.

- [ ] **Step 7: Commit**

```bash
git add src/lib/run-launch.ts src/lib/calibration/launch.ts tests/
git commit -m "feat(launch): a permuted calibration is 2N runs with one judgment each

The fan-out moves from judgments-within-a-run to runs-within-an-Evaluation.
One judgment per EvaluationRun is the invariant timeout-policy.ts states
outright, so the run-scoped deadline and the per-run reaper sweep are correct
by construction rather than patched.

RunCandidate positions are copied VERBATIM. Swapping them is the no-symptom
sign error: render.ts re-sorts and re-reverses, the mirror prompt comes out
byte-identical, and readings.ts inverts anyway."
```

---

### Task 3: `score.ts` — key from the run, and a throw when the two disagree

**Files:**
- Modify: `src/lib/calibration/score.ts:295-360`
- Test: `tests/lib/calibration-score.test.ts`

**Interfaces:**
- Consumes: `EvaluationRun.pairOrder` (Task 1).
- Produces: `CalibrationScoreError` with kind `'pair-order-mismatch'`.

- [ ] **Step 1: Write the failing tests**

```ts
it('partitions on the RUN pairOrder, not the judgment', async () => {
  const client = fakeClient([
    runFixture({ pairOrder: 'AB', judgment: { pairOrder: 'AB', verdict: 'A', status: 'completed' } }),
    runFixture({ pairOrder: 'BA', judgment: { pairOrder: 'BA', verdict: 'B', status: 'completed' } }),
  ]);
  const score = await scoreCalibrationRun('cal1', client);
  expect(score.verdictCount).toBe(1); // AB partition only
});

it('THROWS when a judgment pairOrder disagrees with its run', async () => {
  // Trap T3: the renderer reads the judgment's copy, the scorer reads the
  // run's. A divergence files the row into one partition and resolves it as
  // the other, and the constant floor STILL reads 0.5419 — nothing looks wrong.
  const client = fakeClient([
    runFixture({ pairOrder: 'AB', judgment: { pairOrder: 'BA', verdict: 'A', status: 'completed' } }),
  ]);
  await expect(scoreCalibrationRun('cal1', client)).rejects.toThrow(/pair-order-mismatch/);
});

it('counts a judgmentless run in its OWN partition, inline', async () => {
  const client = fakeClient([runFixture({ pairOrder: 'BA', judgments: [] })]);
  const score = await scoreCalibrationRun('cal1', client);
  // BA's loss must not be attributed to AB.
  expect(score.dispatchedItemCount).toBe(0);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/lib/calibration-score.test.ts`

- [ ] **Step 3: Re-source the key and delete the accumulator**

In the loop at `score.ts:304`, replace the `askedKeys` derivation with the run's own order, and **delete `judgmentlessRuns` entirely** (declaration at `:302`, increment at `:316-319`, fold-in at `:356-357`) — with the key on the run it is known inline:

```ts
    // The key is the RUN's, not the judgment's. With one judgment per run the
    // two are written from one variable at creation and the guard below makes
    // a later divergence loud rather than silent.
    const key = partitionKey(run.pairOrder);
    const partition = ensure(key);
    partition.dispatchedItemCount += 1;

    const completed = run.modelJudgments.filter((j) => j.status === 'completed');
    if (completed.length === 0) {
      partition.unjudgedItems += 1;
      continue;
    }
    for (const judgment of completed) {
      // Trap T3. Two columns hold the order and two different layers read
      // them; if they diverge the row is filtered into one partition and
      // resolved as if it were the other, and every downstream number stays in
      // range. Loud beats plausible.
      if (partitionKey(judgment.pairOrder) !== key) {
        throw new CalibrationScoreError(
          'pair-order-mismatch',
          `judgment ${JSON.stringify(judgment.pairOrder)} on a run with pairOrder ${JSON.stringify(run.pairOrder)}`
        );
      }
      ...
    }
```

Add `pairOrder: true` to the `evaluationRun.findMany` select.

- [ ] **Step 4: Run tests**

Run: `npx vitest run` (FULL suite). Expected: green; every pre-existing assertion unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/lib/calibration/score.ts tests/lib/calibration-score.test.ts
git commit -m "feat(calibration): partition on the run's pairOrder, and throw on a mismatch

judgmentlessRuns is deleted — it existed only because the primary key was
unknowable inside the loop when the key lived on the judgment. With the key on
the run, a judgmentless run is attributed to its OWN partition inline, so BA's
losses can no longer inflate AB's denominator."
```

---

### Task 4: `position-bias.ts` — pair across runs, and throw on a duplicate

**Files:**
- Modify: `src/lib/calibration/position-bias.ts`
- Test: `tests/lib/calibration-position-bias.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('THROWS on a duplicate (itemId, pairOrder) instead of last-write-wins', () => {
  // Trap T5: last-write-wins made a perfectly-measured run report
  // positionBias: null, pairedDecisiveCount: 0 — "never paired" — with no crash.
  expect(() =>
    positionBiasFromPairs([
      { itemId: 'i1', verdict: 'A', pairOrder: 'AB' },
      { itemId: 'i1', verdict: 'B', pairOrder: 'AB' },
    ])
  ).toThrow(/duplicate/i);
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run tests/lib/calibration-position-bias.test.ts`

- [ ] **Step 3: Implement**

Replace the silent overwrite in the row loop with an explicit throw, and **rewrite the comment at `position-bias.ts:88-96`** — it currently cites `@@unique([calibrationRunId, goldenItemId])` at `schema.prisma:432` *by line number*, and that index no longer exists. Cite the v2p partial index instead, and state that the throw is what protects the module when a future caller queries across judges.

The four archetypes must be unchanged: 0.5/1.0, 0.0/1.0, 0.0/0.0, 0.0/0.5.

- [ ] **Step 4: Run tests** — `npx vitest run`. Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/calibration/position-bias.ts tests/lib/calibration-position-bias.test.ts
git commit -m "fix(calibration): throw on a duplicate (itemId, pairOrder), not last-write-wins

Last-write-wins turned a perfectly-measured permuted run into a plausible
all-null — positionBias null, pairedDecisiveCount 0, reading as 'never paired'
— with no crash and nothing marking it stale."
```

---

### Task 5: Wire the estimators into `scoreCalibrationRun` and report them

**Files:**
- Modify: `src/lib/calibration/score.ts` (compute + store), `src/lib/calibration/baseline.ts` (formatter), `scripts/calibration/run.ts` (ONE call site)
- Test: `tests/lib/calibration-score.test.ts`, `tests/lib/calibration-baseline.test.ts`

**Interfaces:**
- Consumes: `positionBiasFromPairs` (Task 4), the v2o columns (already landed).
- Produces: `formatPositionBiasLines(result): string[]`; `CalibrationScore` gains the position-bias fields.

- [ ] **Step 1: Write the failing tests** — a permuted fixture stores `positionBias`/`orderFlipRate`/`pairedDecisiveCount`; an AB-only fixture stores nulls with `pairedDecisiveCount 0`; the formatter never prints a rate without its denominator and warns below 20.

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Compute in `score.ts`.** Pool the raw verdict letters from BOTH partitions — the one place both orders are read together — and write `positionBias`, `orderFlipRate`, `pairedDecisiveCount` in the existing full overwrite. Also write `ordersRequested` from the launch (v2o).

- [ ] **Step 4: Format in `baseline.ts`, NOT in the CLI.** `scripts/calibration/run.ts` is in no coverage include, so logic there is untested by construction. It gains **exactly one** call site — `tests/lib/calibration-baseline.test.ts:389,400` pin exactly one call each of the neighbouring formatters.

- [ ] **Step 5: Full gate suite.** `npx vitest run`, `npm run test:db` alone, `npm run test:integration`, `npm run lint && npm run build`.

- [ ] **Step 6: Commit.**

---

### Task 6: The three detectors

The spec's §5. These are the tests that distinguish a correct build from the two silent wrong ones — **the floor cannot**, since build V and build W both read 0.5419.

**Files:**
- Test: `tests/lib/calibration-permutation-detectors.test.ts` (new), `tests/integration/pairwise-run.test.ts`

- [ ] **Step 1: Detector A — key doubling.** For a permuted calibration, per `expected` class the AB run count and the BA run count are equal; and `pooledFloor === abFloor` exactly, as a float comparison. Catches an inverted `expected` (build K).

- [ ] **Step 2: Detector B — the prompt bytes changed.** For every golden item, the AB judgment's `userPromptSha256` DIFFERS from the BA judgment's. This is the only assertion that sees a swap materialised into `RunCandidate` (build W), which produces byte-identical prompts. Extend the existing harness at `tests/lib/pairwise-execution.test.ts:275` and `tests/lib/llm-truncation.test.ts:434-449`, which already pin that column.

- [ ] **Step 3: Detector C — the oracle.** A content-perfect judge scores **1.0000** over the pooled 1240, not 0.5000. This is the single assertion that separates V from W. Build the fixture from the real 336/284 key shape.

- [ ] **Step 4: Prove each detector DISCRIMINATES.** For each, make the wrong build locally (invert `expected`; swap `RunCandidate.position`) and confirm the detector fails. A detector that passes on both builds is not a detector. Record the evidence in the report.

- [ ] **Step 5: Run and commit.**

---

### Task 7: Leaderboard and human-judgment guards

**Files:**
- Modify: `src/app/api/leaderboard/route.ts`, `src/app/api/evaluations/[id]/runs/[runId]/human-judgment/route.ts`
- Test: the corresponding db/integration tests

- [ ] **Step 1: Write the failing tests** — a permuted calibration contributes no BA row to the leaderboard; a human judgment on a calibration run returns 409.

- [ ] **Step 2: Leaderboard (spec D6).** Add an explicit `pairOrder IS DISTINCT FROM 'BA'` to the `DISTINCT ON (er."evaluationId")` subquery, so the surviving row per `Evaluation` is always the original order rather than whichever run was created later. Today the route is safe only by coincidence — pairwise judgments carry `overallScore: null` and it filters on that, an accident that breaks the moment a pointwise permuted protocol exists.

- [ ] **Step 3: Human judgment (trap T6).** Return 409 when `run.calibrationRunId !== null`. `HumanJudgment.runId` is `@unique`, so 2N runs means two slots per item where there was one — and the route checks only run existence, evaluation match and ownership. This also closes a pre-existing hole: a human judgment on a calibration run is meaningless today too.

- [ ] **Step 4: Run and commit.**

---

### Task 8: The scoreboard SQL and its disarmed tripwire

**Files:**
- Modify: `docs/calibration-scoreboard-2026-09-06.md` (currently **untracked** — track it)

- [ ] **Step 1: Track the file.** It is the artifact of record for the published board and its citations dangle on a clean checkout.

- [ ] **Step 2: Add the order filter.** It hardcodes the AB identity mapping behind a comment saying it is silently wrong if `pairOrder` stops being uniformly `'AB'`. Add `and er."pairOrder" = 'AB'` to the join.

- [ ] **Step 3: Re-key the disarmed tripwire.** Its manual assertion `group by "runId" having count(*) > 1` returns 0 under one judgment per run — disarmed by this very change. Re-key it to `(calibrationRunId, goldenItemId, pairOrder)`.

- [ ] **Step 4: Correct the stale header.** Its SQL header claims v2m/v2n are not applied; they landed 2026-09-06 21:43:08, minutes after the file was written.

- [ ] **Step 5: Commit.**

---

### Task 9: The frontend projection — one record, a bias attribute

Spec §2. A permuted calibration has 2N `EvaluationRun`s for N golden items; every surface that reads runs
must project back to N or legitimately want 2N. The self-review found this enumerated nowhere, so it is a
task rather than a footnote.

**Files:**
- Modify: the run-detail page and its serializer; any `_count` on `evaluationRuns`; the calibration progress display
- Test: the corresponding route/component tests

- [ ] **Step 1: Enumerate the surfaces.** `grep -arn` over `src/app/` for `evaluationRun`, `EvaluationRun`,
  `_count` on runs, and calibration progress. Produce a table in the report: file:line, what it renders,
  and whether it must show N or 2N. **Do not skip this step** — the projection cannot be designed from
  memory, and a surface that silently starts showing 1240 is exactly the "two datasets" outcome the owner
  ruled out.

- [ ] **Step 2: Project the run-detail view.** The key is `(calibrationRunId, goldenItemId)`; the two runs
  collapse into ONE row with an AB column and a BA column, labelled by bias rather than presented as two
  records. `GoldenSet` and its item count are untouched, so every golden-set surface still reads 620 and
  needs no change — verify that rather than assuming it.

- [ ] **Step 3: Progress and counts.** A permuted run's progress denominator is 2N judgments over N items.
  Decide per surface which is meant, and say so in the code comment — an operator watching "620/1240" needs
  to know which number is the work and which is the corpus.

- [ ] **Step 4: Run the full suite and commit.**

---

## Execution order after the code lands

| # | action | lane | cost |
|---|---|---|---|
| 1 | Full gate suite green; promote (migrations run via the Helm pre-upgrade hook — never hand-apply) | — | — |
| 2 | `smollm2:1.7b` × 620 permuted | 3 (idle) | ~18 min |
| 3 | `granite4.2:3b` v2 (new ordinal, repetition penalty set) × 30 permuted | 0 (now free) | ~4 min |
| 4 | `granite4.2:3b` v2 × 620 permuted | 0 | measure from step 3 |
| 5 | `Qwen3.6-35B-A3B v2` × 620 permuted | 1 (idle) | ~17.1 h |

Warm the target model immediately before each run — on `192.168.1.9`, `qwen3.5:9b` and `granite4.2:3b` evict each other and a reload costs ~153 s.

**The 30-item sample is a weak check for granite specifically**: v1 failed 15/30 and 5/30 on the same config, a 3× swing. Treat it as a harness smoke test, not evidence about the judge.
