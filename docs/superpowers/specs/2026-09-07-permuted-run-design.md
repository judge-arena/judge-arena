# PermutedRun — the permutation as a run-level attribute — 2026-09-07

Supersedes `2026-09-07-ba-sweep-position-bias-design.md`, which put both orders on ONE
`EvaluationRun`. That shape broke the invariant the entire timeout model rests on. This one restores it.

## 0. If you read one thing

**The pooled constant floor does not move, and that is correct — not a hazard to filter around.**

An earlier analysis claimed pooling both orders collapses the floor to exactly 0.5, handing every judge
+0.0419 of free margin. That is true only of a build with **mirror `GoldenItem`s carrying an inverted
`expected`** — which this design forbids. Here the mirror run points at the **same `GoldenItem`**,
`expected` is read once and never inverted (`score.ts` reads `run.goldenItem.expected`), and the
permutation is undone on the *verdict* at `readings.ts:104-107`.

Key counts therefore double uniformly, and the floor is bit-identical:

| build | pooled key (n=1240) | pooled floor | content-perfect oracle | slot-A stamper |
|---|---|---|---|---|
| **V — this spec** | 672 `A>B` / 568 `B>A` | **0.5419355** (= 336/620) | **1.0000** | 0.5000 → margin −0.0419 |
| K — forked/inverted key (forbidden) | 620 / 620 | 0.5000 | 1.0000 | 0.5000 → margin 0.0000 |
| W — swap materialised into `RunCandidate` | 672 / 568 | 0.5419355 | **0.5000** | 0.5000 |

Source: prod `GoldenSet cmt057h5d00097y01ymubpre5`, 620 live items, 336 `A>B` / 284 `B>A`, 0 `tie`.

**Read across, not down. The floor cannot tell V from W** (both 0.5419) **and cannot tell K from a
key-only inversion** (both 0.5000). Only the oracle column separates correct from broken. §5 is the
detector, and it is not the floor.

## 1. The shape

### D1 — the discriminator lives on `EvaluationRun`

A calibration creates **N `Evaluation`s, 2N `EvaluationRun`s, one `ModelJudgment` each.** The
`GoldenSet` is never modified; the freeze rule is never engaged.

```prisma
model EvaluationRun {
  /// A2.2: which candidate order this run PRESENTED. NULL on every ordinary
  /// run and every pointwise run. Mirrored onto this run's single
  /// ModelJudgment.pairOrder in the same nested create; score.ts throws if
  /// the two ever disagree (trap T3).
  pairOrder String?
}
```

**A new migration `v2p`, hand-written. Do NOT amend `v2o`** — it is already applied to the shared
`judge_arena_test` database with a recorded checksum, so editing it in place makes every
`npm run test:db` fail P3006 until someone resets that database.

```sql
DROP INDEX "EvaluationRun_calibrationRunId_goldenItemId_key";
ALTER TABLE "EvaluationRun" ADD COLUMN "pairOrder" TEXT;
UPDATE "EvaluationRun" SET "pairOrder" = 'AB' WHERE "calibrationRunId" IS NOT NULL;
CREATE UNIQUE INDEX "EvaluationRun_calibrationRunId_goldenItemId_pairOrder_key"
  ON "EvaluationRun" ("calibrationRunId", "goldenItemId", "pairOrder")
  NULLS NOT DISTINCT
  WHERE "calibrationRunId" IS NOT NULL;
ALTER TABLE "EvaluationRun" ADD CONSTRAINT "EvaluationRun_calibration_needs_order"
  CHECK ("calibrationRunId" IS NULL OR "pairOrder" IS NOT NULL);
```

All three clauses are load-bearing, and a plain `@@unique([calibrationRunId, goldenItemId, pairOrder])`
gets all three wrong:

- **`WHERE "calibrationRunId" IS NOT NULL`** — ordinary runs leave the index entirely. Without it,
  `NULLS NOT DISTINCT` makes every ordinary run's `(NULL, NULL, NULL)` equal to every other's and **the
  second ordinary run ever launched fails P2002** (the tripwire at
  `tests/db/calibration-link.test.ts:280-281`).
- **`NULLS NOT DISTINCT`** — inside the calibration partition two rows with a NULL order must still
  collide. Postgres' default would silently delete the idempotency guard `score.ts` relies on.
- **`CHECK`** — makes "a calibration run always names its order" a database fact rather than a
  convention. Prisma's DSL cannot express it; this repo already carries eight hand-edited migrations
  (`CONTRIBUTING.md:78`) with `Tombstone_exactly_one_entity` as precedent. **Update that count to nine
  in the same commit.**

Backfill to `'AB'` is exact and lossless: all 4200 production `ModelJudgment` rows are `'AB'`, zero
`'BA'`, zero NULL. Lock cost is `ACCESS EXCLUSIVE` on a 4200-row / 2688 kB table.

### D2 — there is NO materialised swap

**`RunCandidate` rows are copied verbatim into both runs. `position` stays candidate identity.** The
swap is a render-time presentation decision and lives in exactly one place:

- `render.ts:595` sorts ascending by `position` — unchanged;
- `render.ts:607` `const [first, second] = order === 'AB' ? candidates : [candidates[1], candidates[0]]`.

Exactly **two** layers touch the permutation and they are a matched pair: `render.ts:607` applies it,
`readings.ts:104-107` undoes it. Net inversions = 2 = identity. `GoldenItem.expected` is never inverted
anywhere.

Swapping `RunCandidate.position` instead is build **W** — the sort at `render.ts:595` re-sorts it, `:607`
reverses it again, the mirror prompt comes out **byte-identical to AB**, and `readings.ts` inverts anyway.
Every mirror verdict is then filed against the wrong candidate with accuracy landing on a plausible
`1 − x`. `golden-sets.ts:48` names this: "position IS the identity (0 = A, 1 = B)".

Cost: `RunCandidate` goes from 2 rows per item to 4 — ~1240 → 2480 rows and ~+1.5 MB per 620-item sweep.
Inherent to the direction, not a reason to reconsider.

### D3 — one `Evaluation`, two runs

`EvaluationRun` has only `@@index([evaluationId])`, no unique, so two runs may share one `Evaluation`.
Hoist the `Evaluation` create out of the order loop and call `launchSingleRun` twice against the same
`evaluationId`. This keeps `Evaluation.count` at N, which the leaderboard and the public counts read.

## 2. What the frontend sees

One record per golden item, carrying a bias attribute — not two rows.

The projection key is `(calibrationRunId, goldenItemId)`; the two runs collapse into one row with an AB
column and a BA column. Surfaces that must project back to N rather than show 2N are enumerated in the
implementation plan. The `GoldenSet` and its item count are untouched, so every golden-set surface still
reads 620.

**Permuted records cannot reach a human annotator, structurally.** The labelling queue reads `GoldenItem`,
not `EvaluationRun`, and no `GoldenItem` is created. See trap T6 for the one write path that still needs a
guard.

## 3. What stays honest in scoring

**The filter is one line.** `score.ts:315` re-sources the partition key from the run instead of the
judgment:

```ts
// was: const askedKeys = new Set(run.modelJudgments.map((j) => partitionKey(j.pairOrder)));
const key = partitionKey(run.pairOrder);
```

`partitionKey` and `primaryKey` are unchanged — **`primaryKey` IS the filter predicate**, and every stored
accumulator is downstream of `primary.rows`. The stored `rawAgreement` / `kappa` / `verdictCount` /
`committedCount` / `selectiveAccuracy` stay AB-only, so all 22 historical rows still score bit-identically.

The accumulator most easily forgotten is **`kappa`**: pooling changes its chance-correction term because
the ground-truth marginal changes, for reasons that have nothing to do with the judge.

**Delete the `judgmentlessRuns` accumulator.** It exists only because the primary key was unknowable
inside the loop when the key lived on the judgment. With the key on the run it is known inline. Leaving it
is trap T4.

## 4. The queue and the deadline

**One judgment per `EvaluationRun` restores the invariant the timeout model states outright.**
`timeout-policy.ts:230-258`: `judgmentCount` is "fixed forever once the run exists"; for a calibration run
"it is always 1 — one judge, one item, one judgment per `EvaluationRun`"; and "queue-depth independence is
the entire point."

So the run-scoped deadline and the per-run reaper sweep are correct **by construction**, and the
sibling-restamp defect is unreachable for calibration rather than patched. The unconditional null in
`clearRunDeadlineOnRequeue` (restored at `3fdb714`) is right and stays.

**The item ceiling is a formula, not a number:**
`items × orders × MAX_ATTEMPTS(3) × resolveTimeoutBudgets().hardCapMs < NEVER_STARTED_TIMEOUT_MS`.
Dispatching 1240 single-judgment runs and 620 two-judgment runs give the **identical** bound, so the
existing 719-item derivation carries over unchanged. `MAX_CALIBRATION_ITEMS` stays 1000 and must be
counted in ITEMS, not dispatched runs, or a permuted 620-set is refused for no real reason.

Lanes are unaffected — they key on endpoint origin, not item — so the 2N still serialise on one lane.

## 5. The backwards sign detector

**The floor is not the detector.** Asserting "the floor moved to 0.5" fires on every *correct* run;
asserting "the floor stayed 0.5419" passes the two silent wrong builds. Three assertions, all required:

**A — key doubling** (catches an inverted `expected`). Per `expected` class, the AB count and the BA count
must be equal. In code, one line: `pooledFloor === abFloor` exactly.

**B — the prompt bytes changed** (catches the silent builds). For every golden item in a permuted
calibration, the AB judgment's `userPromptSha256` must DIFFER from the BA judgment's. A swap that
materialised into `RunCandidate` produces byte-identical prompts and this is the only thing that sees it.

**C — the oracle** (the discriminator). A content-perfect judge must score **1.0000** over the pooled 1240,
not 0.5000. This is the single assertion that separates V from W.

## 6. Migration of the landed branch

| commit | verdict |
|---|---|
| `e7ff18c` SamplingParams penalties | **KEEP** verbatim — orthogonal |
| `6b03fda` + `4fa2c5c` shared `PairOrder` type | **KEEP** — it is the vocabulary for the run column too |
| `026a592` score.ts partition | **MODIFY** ~1 line (re-source the key); ~95% survives |
| `dc62892` judgmentless-run inertness | **MODIFY** — delete `judgmentlessRuns`; keep the doc fixes |
| `e3b6ab6` renderer `PairOrder` | **KEEP verbatim** — the single place the swap happens; D2 depends on it |
| `d654d33` `positionBiasFromPairs` | **KEEP** the code; **MODIFY** the uniqueness comment (trap T5) |
| `4710212` n=1 interval | **KEEP** verbatim |
| `a46ffa5` v2o + `SCORING_RULES_VERSION = 3` | **KEEP as landed**; add `v2p`. Generation stays 3 |
| `0a58ef6` launch `orders` fan-out | **REVERT the fan-out** (~51 src lines); **KEEP** the ceiling and the finalization test |
| `7311eca` review-1 fixes | **KEEP** F2 and F3; **MODIFY** F4's comment. F1 already gone |
| `3fdb714` revert F1 | **KEEP** — correct under one judgment per run |
| `5af2c5c` two minors | **KEEP** verbatim |

The renderer change survives. An earlier assessment said it would become harmful; that was reasoning
about build W, which this design forbids.

## 7. Traps

- **T1 — the nullable-discriminator disarm.** See D1. All three index clauses or none.
- **T2 — the double swap.** Materialising into `RunCandidate` gives a byte-identical mirror prompt while
  `readings.ts` still inverts. Detector B and C catch it; the floor does not.
- **T3 — two columns that can disagree.** `EvaluationRun.pairOrder` and `ModelJudgment.pairOrder` both
  exist and both are read — the renderer reads the judgment's, the partition reads the run's. If they
  diverge, a row is filtered into one partition and resolved as if it were the other, and the floor still
  reads 0.5419. Three mitigations, all required: written from one variable in one nested create; the
  `CHECK` guarantees non-null; and **`score.ts` throws** if any loaded judgment's `pairOrder` differs from
  its run's. Do not skip the third — the first two do not cover a later writer.
- **T4 — `judgmentlessRuns` misattribution.** It adds every judgmentless run to the *primary* partition,
  silently inflating AB's counts with BA's losses. Existing tests stay green because both sides inflate
  together. Delete it.
- **T5 — `positionBiasFromPairs` returns a plausible all-null.** Its safety comment cites the unique index
  being changed, by line number. On a duplicate `(itemId, pairOrder)` it takes last-write-wins and returns
  `positionBias: null, pairedDecisiveCount: 0` — "never paired" for a run that measured perfectly. Rewrite
  the comment and make the duplicate throw.
- **T6 — human judgments double.** `HumanJudgment.runId` is `@unique`, so there is one slot per run and now
  two runs per item. The write path checks only run existence, evaluation match and ownership. **Add a 409
  when `run.calibrationRunId !== null`** — this also closes a pre-existing hole, since a human judgment on
  a calibration run is meaningless today.
- **T7 — the leaderboard keeps one order.** Its `DISTINCT ON (er."evaluationId") … ORDER BY … createdAt
  DESC` keeps only the later run. Harmless today only by coincidence (pairwise judgments carry
  `overallScore: null` and the route filters on it). Add `AND er."pairOrder" IS DISTINCT FROM 'BA'`, or
  exclude calibration runs outright.
- **T8 — the scoreboard SQL has no order filter and disarms its own tripwire.**
  `docs/calibration-scoreboard-2026-09-06.md` is untracked, hardcodes the AB identity mapping, and its
  manual assertion `group by "runId" having count(*)>1` returns 0 under one judgment per run. Track the
  file, add the order filter, re-key that check to `(calibrationRunId, goldenItemId, pairOrder)`.

## 8. Decisions (owner, 2026-09-07)

### D4 — the stored `rawAgreement` stays AB-only

`rawAgreement`, `kappa`, `verdictCount`, `committedCount` and `selectiveAccuracy` are computed over the
`'AB'` partition alone, exactly as today. All 22 historical rows stay bit-comparable to every new one, and
`marginOverConstant` — the scoreboard's default sort key — keeps meaning precisely what it means now.

Pooling was defensible once the floor was shown stable, and is REJECTED anyway: it would silently change
what a stored number covers, and no column records which half it came from. The permutation's value lands
in `positionBias` / `orderFlipRate` / `pairedDecisiveCount`, not in the accuracy.

### D5 — a permuted run is OPT-IN PER LAUNCH

Never the default. Permuting doubles a run's dispatched work — on the 620-item corpus that is ~18 min for
smollm2 and ~17.1 h for Qwen3.6 — and most calibrations do not need a position-bias number.

The flag is per launch, not per golden set and not per judge version: the same set and the same judge must
be runnable both ways without a second artifact. `CalibrationRun.ordersRequested` (v2o, already landed)
records what was asked for, so a stored row says whether it was permuted without inferring it from the
`EvaluationRun` rows.

### D6 — the leaderboard excludes permutation runs entirely

The leaderboard reports golden-item results only. A permuted (`pairOrder = 'BA'`) `EvaluationRun` is an
instrument reading, not a result, and must never reach it.

This closes T7 by construction rather than by coincidence. Today the route is safe only because pairwise
judgments carry `overallScore: null` and it filters on that — an accident that would break the moment a
pointwise permuted protocol existed. The filter is explicit: exclude `pairOrder = 'BA'` from the
`DISTINCT ON (er."evaluationId")` subquery, so the surviving row per `Evaluation` is always the original
order rather than whichever run happened to be created later.
