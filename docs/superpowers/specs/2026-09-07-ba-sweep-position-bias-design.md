# The BA sweep — disentangling position bias from judge signal — 2026-09-07

## 0. If you read one thing

Every pairwise judgment this product has ever made — **4200 of 4200** — was rendered in one order,
`Response A` = candidate position 0. Nothing has ever measured what happens when the two candidates
are swapped. This design adds the second order.

The number it produces is not an accuracy. It is the answer to *"how much of this judge's verdict is
about the content, and how much is about which slot the content was in?"* On the current corpus that
question is not academic: `smollm2:1.7b` answers `B` on 418 of 617 items (0.6775) against a key that
is 0.5397 `A>B`, and is **statistically content-blind** — `P(A | key=A>B)` vs `P(A | key=B>A)` gives
p = 0.183. Its accuracy, 0.4603, equals an always-`B` stamper's to four decimal places. Either that
judge is reading the slot instead of the text, or it is not reading at all, and no measurement in this
product can currently tell those apart.

**The single most dangerous property of this work:** a sign error in the order mapping has **no
symptom**. `src/lib/calibration/readings.ts:28-32` says it outright — every downstream number stays
in range, the confusion matrix stays square, accuracy lands on a plausible `1 - x`, and the only
effect is that the best judge ranks worst. Exactly one layer may invert. The load-bearing test in
this design is not an accuracy assertion; it is a `userPromptSha256` assertion that the bytes sent to
the model actually changed.

---

## 1. Decisions, recorded

Three decisions were taken deliberately and close off alternatives. They are recorded here so a later
reader does not reopen them by accident.

### D1 — A BA judgment is a SECOND `ModelJudgment` on the SAME `CalibrationRun`

Not a second `CalibrationRun`. `prisma/schema.prisma:432` `@@unique([calibrationRunId, goldenItemId])`
closes the middle option — a second `EvaluationRun` for the same item in the same calibration is
impossible — so there were exactly two shapes, and this is the one the codebase was built for:

- `prisma/schema.prisma:568` `@@unique([runId, judgeModelVersionId, pairOrder])`, hand-edited to
  `NULLS NOT DISTINCT` in `20260728215410_v2b_idempotency_tighten/migration.sql:51-53`;
- `src/lib/run-launch.ts:544-552`, which states the intent verbatim: *"That is what makes A2's BA
  sweep additive: a second judgment per pair, no migration, no backfill, and no ambiguity about what
  the existing rows measured."*
- `src/lib/calibration/readings.ts:36-45`, which describes this exact phase and pre-emptively guards
  it.

**No migration is required for the judgment row itself.** The index already admits the pair.

### D2 — The stored `rawAgreement` / `kappa` / `verdictCount` stay AB-only

They keep their current definitions, computed over the AB partition alone. The disentanglement lands
in **new columns**. Consequences, all of them intended:

- all 22 existing `CalibrationRun` rows stay bit-comparable to every new one;
- `SCORING_RULES_VERSION` **stays 2**. Per `src/lib/calibration/scoring-version.ts:50-57` a new
  all-NULL column is self-describing and needs no bump; the bump would only be mandatory if BA rows
  entered the `rawAgreement`/`kappa` denominator, which D2 forbids;
- `marginOverConstant`, the scoreboard's default sort key, keeps meaning precisely what it means
  today.

The rejected alternative is worth recording because it is superficially attractive. **Pooling both
orders into one `rawAgreement` moves the number without moving the floor.** Measured on the live
`smollm2` run `cmtqi78z000013t9molxqn2pb`: the constant baseline stays **bit-identical** at
0.539708265802269 (every key class doubles, so `best/denominator` is unchanged), while a pure
right-slot stamper's agreement moves 284/617 = 0.4603 → 617/1234 = 0.5000 and the margin moves
−0.0794 → −0.0397. A judge would appear to improve by 0.0397 with nothing in the schema recording
that the denominator changed meaning.

### D3 — TWO estimators are stored, not one

Because the project's own written commitment and the literature it collected disagree, and they
disagree **exactly on the judges in this corpus**.

| | definition | source | what it misses |
|---|---|---|---|
| `positionBias` | \|P(A wins) − 0.5\| over paired items | `docs/research/2026-07-judge-model-inventory.md:146-149` (threshold 0.10, reported jointly with `testRetest`) | a **symmetric flipper** scores 0.0 |
| `orderFlipRate` | fraction of paired items whose *preference* changes under swap | `/root/research/evaluation-harnesses/07-llm-as-judge-and-rubrics.md:590` (median 41.3% in the literature) | cannot separate "prefers slot 1" from "noisy under swap" |

A judge that answers `A` in AB and `A` in BA on every item — i.e. always the first slot, entirely
position-driven — scores **0.0 marginal and 1.0 flip**. Marginal alone would certify it unbiased.
Storing one number and not the other is how that judge gets onto a leaderboard.

### D4 (approved call) — Forward-only. Historical runs are not retrofitted.

A BA judgment cannot be added to an `EvaluationRun` whose AB half has already drained:
`src/worker/claim.ts:198-202` asserts judgment rows are *"fixed at creation — nothing in this
codebase ever adds one afterwards"*, and `claim.ts:239-241` stamps `deadlineAt` exactly once from
`judgmentCount`. A late insert inherits an expired deadline and is reaped.

Retrofitting therefore means launching a **fresh paired run**, re-paying for the AB half. We are not
doing that. `positionBias` stays NULL on all 22 historical rows permanently, which is the honest
state: those runs did not measure it. This is reinforced by
`docs/superpowers/specs/2026-08-17-a2-calibration-and-reporting-decisions.md:110-113` — a
`CalibrationRun` header *"must be frozen once published or referenced"*, because the leaderboard
computes directly over these rows and a header that moves after publication makes the board silently
non-reproducible.

### D5 (approved call) — `smollm2:1.7b` on the full 620 goes first

9 minutes on idle lane 3. It is chosen to test **the instrument**, not the judge: it is the most
likely symmetric flipper in the corpus, which is the one case that separates D3's two estimators.
`Qwen3.6-35B-A3B v2` follows (8.56 h, idle lane 1, independent of lane 3) as the decision-relevant
measurement — it is the only judge with real content signal (z = +32.3) and the only one whose
leaderboard rank could move. **Lane 0 is not touched** until the in-flight `qwen3.5:9b` run
`cmtluplg5` drains.

---

## 2. The shape

```
CalibrationRun (1)
└── EvaluationRun (N, one per GoldenItem, @@unique[calibrationRunId, goldenItemId])
    ├── ModelJudgment  pairOrder='AB'   ← scored into the stored columns (D2)
    └── ModelJudgment  pairOrder='BA'   ← scored in memory; feeds the estimators only
```

Both judgments are created **in the same transaction** at launch. This is not a preference; see D4
for the deadline-stamping reason it cannot be otherwise.

---

## 3. The work, in dependency order

### Step 1 — `score.ts` partitions by `pairOrder`. Ships alone. Provably inert.

`src/lib/calibration/score.ts:251-256` selects `modelJudgments: { where: { status: 'completed' } }`
with no `pairOrder` filter, and `:299-312` pushes one entry per judgment into one flat pile.
`:315` then calls `groundTruthReadings(rows)`, which throws `duplicate-reading` at
`readings.ts:162-175` the moment two readings share an `(itemId, raterId)` key.

**So the first BA row does not corrupt a score — it makes the run un-scorable.** `scoreCalibrationRun`
aborts before the counting reduce at `:347`, `calibrationRun.update` at `:455` never fires, and the
row silently keeps its stale AB-only `rawAgreement`, `verdictCount`, `finishedAt` and
`scoringVersion` with nothing marking them stale. The CLI's only handler is
`scripts/calibration/run.ts:516`'s `.catch(… process.exitCode = 1)`. A cosmetic wrinkle worth knowing
during implementation: ground truth is emitted first (`readings.ts:243-244`), so the error message
blames rater `"ground-truth"`, not the duplicate order.

The fix: group `rows` by `pairOrder` before scoring, and score each partition independently — which
is exactly the contract `readings.ts:170` states in its own error text, *"pass one pairOrder's
judgments per call."*

**Acceptance test for this step is bit-identity.** With 22 AB-only runs in production, re-scoring any
of them after this change must produce byte-identical stored values. This step lands and is verified
*before any BA row can exist*, which is what makes every later step safe.

### Step 2 — The renderer learns order

This is the step the premise of this work got wrong, and it is the largest single piece.

`src/lib/llm/render.ts:585-599` has **no order parameter**:

```
585  export function buildPairwiseUserPrompt(submission: RenderSubmission): string {
586    const candidates = [...(submission.candidates ?? [])].sort((a, b) => a.position - b.position);
598    const responseA = candidateText(candidates[0]);
599    const responseB = candidateText(candidates[1]);
```

and the presented order is fixed in the **worker's query**, not at the call site —
`src/worker/judgment-consumer.ts:221-224`: *"Ordered by `position` here so the presented order ('AB')
is a property of the QUERY, not of whatever order Postgres happened to return."* The full
`ModelJudgment` row, `pairOrder` included, is destructured at `judgment-consumer.ts:486` and **never
consulted**. `grep -arn pairOrder src/worker/ src/lib/llm/` returns only comments.

The prose at `render.ts:575-579` describing the BA sweep as *"a second ORDERING through this same
function"* is **aspirational, not shipped** — the function has no input that could express it.

**Implementation:** widen the signature to `buildPairwiseUserPrompt(submission, order: PairOrder =
'AB')`. The `position` sort stays exactly as it is — position remains candidate identity
(`src/lib/golden-sets.ts:48`, *"position IS the identity (0 = A, 1 = B)"*) — and the new parameter
decides which of the two sorted candidates becomes `Response A`. Default `'AB'` keeps every existing
caller and `tests/lib/render-pairwise.test.ts:78` green.

Thread `judgment.pairOrder` through four signatures:
`judgment-consumer.ts:499` → `RegistryJudgmentInput` → `registry.ts:1104-1109 prepareJudgmentCall` →
`render.ts:636 renderJudgmentPrompt` → `buildPairwiseUserPrompt`.

The comment at `judgment-consumer.ts:221-224` becomes false and is corrected in the same commit.

**Two rejected alternatives, recorded so they are not re-proposed:**

1. **Swapping `RunCandidate.position` at launch** so the existing ascending sort renders BA. This
   makes `position` stop being candidate identity, leaves `GoldenItem.expected` ambiguous against it,
   and requires `preferenceFromVerdict` to *not* invert for those rows — converting a correct,
   100%-branch-covered function into a conditionally-wrong one. This is the no-symptom sign error,
   deliberately introduced.
2. **Reordering the mapped candidate array at `judgment-consumer.ts:499`** without touching the
   renderer. This is a **no-op**: the sort at `render.ts:586` re-sorts it back, and
   `tests/lib/render-pairwise.test.ts:78` pins that behaviour.

### Step 3 — Launch emits both orders

`src/lib/run-launch.ts:553` today writes `pairOrder: protocol === 'pairwise' ? 'AB' : null`. It gains
a second nested `modelJudgments.create` entry for `'BA'`, gated by a new parameter.

- `LaunchSingleRunParams` (`run-launch.ts:324-355`) and `LaunchCalibrationRunParams`
  (`src/lib/calibration/launch.ts:116-125`) gain `orders: PairOrder[]`, **defaulting to `['AB']`**.
  Nothing changes for any existing caller.
- `scripts/calibration/run.ts:162-165` gains `--orders=AB,BA` (default `AB`). The current arg surface
  is only `--golden-set --judge-version --score-only --poll-timeout`.
- No HTTP route can launch a pairwise run at all (`api/evaluations/route.ts:303-306` and
  `api/evaluations/[id]/runs/route.ts:84-89` both omit `protocol`/`candidates`; the default is
  pointwise at `run-launch.ts:392`). **The web tier is entirely out of blast radius.**

Both judgments are created inside the existing nested `EvaluationRun` create, so they share one
transaction by construction — satisfying D4.

**This step must also close a silent hole.** `tests/integration/finalization.test.ts:628`:

```
const legalWorstCaseMs = MAX_CALIBRATION_ITEMS * 3 * resolveTimeoutBudgets().hardCapMs;
```

There is no orders-per-item factor, so this assertion stays **green while the real bound doubles**.
At `MAX_CALIBRATION_ITEMS = 1000` (`calibration/launch.ts:114`) the two-order bound is
`1000 × 2 × 3 × 900 000 = 5.4e9` ms against a 45-day net of `3.888e9` — it **exceeds** it. At the
current `MAX_HARD_CAP_MS = 1_170_000` the one-order figure is already 3.51e9. The test gains the
factor and the item cap is clamped when `orders.length > 1`. 620 items × 2 orders is within bounds;
1000 × 2 is not.

### Step 4 — The estimators

New pure module `src/lib/calibration/position-bias.ts`, taking paired readings and returning both D3
numbers. Pure and separately testable, in the mould of `readings.ts` — a named function with an
arm-by-arm test, for the same reason that file gives.

**Eligibility.** An item contributes only if **both** orders produced a decisive verdict. `tie` is
order-invariant by construction (`readings.ts:103`) and is this product's sanctioned no-answer
channel, so a tie in either order excludes the item from both estimators.

**`pairedDecisiveCount` is reported alongside both numbers, always.** Without it an abstaining judge
scores a flawless 0.0 position bias on n = 3. This is the scoreboard's standing rule 1 — no rate
without its denominator — and it applies here more sharply than anywhere else, because both
estimators are bounded and a small denominator makes them look confident.

Both numbers carry Wilson 95% intervals, consistent with `selectiveAccuracy`.

**`orderFlipRate` compares preferences, not raw verdict letters.** It applies `preferenceFromVerdict`
to each order first and asks whether the resulting `A>B` / `B>A` changed. Comparing raw letters would
report a *stable* judge as flipping 100% of the time.

### Step 5 — Storage: migration `v2o`

| column | status | holds |
|---|---|---|
| `positionBias` | **already exists**, `schema.prisma:1002`, 0/22 populated | `marginalSkew` (D3) |
| `orderFlipRate` | **new** | the flip rate (D3) |
| `pairedDecisiveCount` | **new** | the denominator both share |

`positionBias` is finally written with the meaning its own source documents intended.

Flip rate gets a **new** column rather than reusing the adjacent dead `biasSensitivityRate`. Those
four columns (`testRetest`, `positionBias`, `biasSensitivityRate`, `flipRateVsParent`,
`schema.prisma:1001-1004`) are the only ones in that block with no `///` doc, and they originate in
`20260725012218_v2_meta_eval/migration.sql:50` — a v2 schema sketch, not a designed metric.
`biasSensitivityRate` does not mean order-flip rate, and a misnamed column is precisely how a number
gets misread a year later. All three columns ship **with** doc comments.

Migration name must match `/^v2[a-z]$/` (`tests/lib/calibration-scoring-version.test.ts:36`); `v2l`
and `v2n` are used, so this is `v2o`.

`SCORING_RULES_VERSION` stays **2** (D2). The NULL is unambiguous: a run with no BA half has NULL in
all three new columns together, and `pairedDecisiveCount IS NULL` is the discriminator.

### Step 6 — Reporting

The CLI (`scripts/calibration/run.ts`) and the scoreboard print both estimators with their shared
denominator, their intervals, and the tie-exclusion count, under the board's existing "never
displayed without its companion" rule. A guard fires at `pairedDecisiveCount < 20`, mirroring
`⚠n<20`.

---

## 4. Traps

**4.1 The sign error with no symptom.** Stated at `readings.ts:28-32`. Mitigated by asserting on
`ModelJudgment.userPromptSha256` — the stored prompt hash (`schema.prisma:555-558`, written at
`judgment-consumer.ts:675-677`) — that the BA prompt differs from the AB prompt for the same item,
*and* that position 1's text appears before position 0's in the BA `userPrompt`. An accuracy
assertion cannot catch this; a byte assertion can.

**4.2 Double inversion.** Exactly one layer inverts. The renderer swaps what the model is *shown*;
`preferenceFromVerdict` (`readings.ts:102-105`) swaps what the verdict *means*. Both together return
to AB with no symptom. Neither leaves AB rows labelled BA. A test asserts a BA judgment whose verdict
letter is `A` maps to preference `B>A`.

**4.3 `pairOrder` is not an enum anywhere.** `schema.prisma:490` is `String?`; production
`information_schema` reports `text|YES`. The schema has 9 real Prisma enums; this is not one. The
only typed form is `readings.ts:57 export type PairOrder = 'AB' | 'BA'`, in the **read** layer,
imported by no writer, and `score.ts:362` casts `row.pairOrder as PairOrder`. Nothing stops a writer
emitting `'ba'`, and the only defence fires at score time — after the inference is paid for. This
design promotes `PairOrder` to a shared type imported by writer and reader alike.

**4.4 `latency.ts:566` pools both orders silently.** `key = ${datasetId}|${item.id}|${judgeModelVersionId}`
has no order component, so per-tuple latency means will average AB and BA without complaint. It does
not throw. Either the key gains `pairOrder` or the pooling is documented; it must not be left
unstated.

**4.5 `noVerdictRate` is the first thing to break under pooling.** `score.ts:422` divides a per-row
numerator by a per-item denominator, so pooled scoring can push it above 1.0. `score.ts:158-163` says
this field was carried separately precisely *"so a future BA sweep breaking that identity is VISIBLE
rather than assumed away."* Under D2 it is computed on the AB partition only — verify this explicitly
rather than assuming the partition handles it.

**4.6 `dispatchedItemCount == verdictCount + missingVerdicts` stops holding.** `dispatchedItemCount`
(`score.ts:294`) is per-run and does not double; `verdictCount` (`:359`) is per-row and does. Under
D2 the stored `verdictCount` remains AB-only so the identity survives for stored fields, but any new
code reading both must not assume it.

**4.7 Coverage gates are the binding constraint, and one is already in regression.**
`vitest.db.config.ts:157-162` sets `branches: 77` against a measured 1004/1297 = **77.4094%** — six
entirely-uncovered new branches of budget, against a config whose own policy (`:74-77`) mandates a 2pp
buffer. Both files this design touches most, `run-launch.ts` (51/70) and `calibration/launch.ts`
(25/33), sit **below** that aggregate, so branches added there cost double. Unit per-glob budgets are
looser: `src/worker/**` 114/125 vs floor 87; `src/lib/llm/**` 527/586 vs 83.

**The floor does not move.** New code ships with its tests.

---

## 5. What does NOT change

- The web tier. No route can launch a pairwise run.
- The queue message schema. `{judgmentId, runId, attempt}` (`publish.ts:30-34`) already addresses a
  judgment by primary key; two judgments on one run need no change.
- Claim and idempotency. `claim.ts:105-108` keys on the judgment PK.
- Run finalization. `run-finalizer.ts:122-136` groups by status; `stillActive = pending + running`
  is already correct for N judgments.
- `runModelSelections`, `@@unique([runId, judgeModelVersionId])` (`schema.prisma:468`) — stays
  one row per version regardless of order count.
- `SCORING_RULES_VERSION`, which stays 2.
- All 22 historical `CalibrationRun` rows.

---

## 6. Testing

TDD throughout, per the project's standing workflow.

1. **Step 1 inertness** — re-score existing production-shaped fixtures, assert byte-identical stored
   values. This gates everything downstream.
2. **Prompt bytes** (trap 4.1) — the load-bearing test. `userPromptSha256` differs between orders;
   position 1's text precedes position 0's in the BA prompt.
3. **Single inversion** (trap 4.2) — arm-by-arm, in the style of
   `tests/lib/calibration-readings.test.ts:25-64`.
4. **The symmetric flipper** — a fixture that answers the first slot every time must score
   `positionBias = 0.0` and `orderFlipRate = 1.0`. This is the fixture that justifies D3; without it
   the design's central claim is untested.
5. **Tie exclusion** — an all-tie judge yields `pairedDecisiveCount = 0` and NULL estimators, not
   `0.0`.
6. **`finalization.test.ts:628`** gains the orders factor (step 3).
7. **Tests that must be re-scoped, not deleted** — `tests/db/calibration-link.test.ts:354-355`
   (`toHaveLength(1)`, `.toBe('AB')`) becomes order-parameterised;
   `tests/integration/pairwise-run.test.ts:297,302,329` uses `findFirstOrThrow`, which becomes
   nondeterministic with two judgments — it must be made order-explicit, or it goes flaky rather than
   red, which is worse. Both suites run on Gitea only; `.github/workflows/ci.yml` self-skips.

---

## 7. Execution order

| # | action | lane | cost | gate |
|---|---|---|---|---|
| 1 | Ship steps 1-6 behind `orders` defaulting to `['AB']` | — | — | full gate suite green; step-1 inertness proven |
| 2 | `smollm2:1.7b` × 620, `--orders=AB,BA` | 3 (idle) | ~18 min | first `positionBias` / `orderFlipRate` in the product |
| 3 | `Qwen3.6-35B-A3B v2` × 620, `--orders=AB,BA` | 1 (idle) | ~17.1 h | the decision-relevant number |
| — | anything on lane 0 | 0 | — | **blocked** until `cmtluplg5` drains |

---

## 8. Accepted risks and open questions

**The resolution this gets reported against is not yet established.** The scoreboard quotes an
empirical least-significant-difference of 0.0586
(`docs/calibration-scoreboard-2026-09-06.md:27,139`), but that is an **n ≈ 30 quantity** — all five
repeat runs behind it are on `judgebenchsample-30-random`, and **no judge has a repeat run on the 620
set**. Scaled it is ≈ 0.0129 at n = 620. At n = 620 the 95% CI half-width on a paired order-effect
estimate is 0.052-0.056 and the 80%-power MDE is 0.074-0.080. A first `positionBias` of, say, 0.04 is
therefore **not** distinguishable from zero, and must not be reported as if it were.

**Nothing enforces that the two orders share sampling parameters.** They do here, because both
judgments are created in one transaction from one `JudgeModelVersion` — but `samplingDefaults` is
mutable on the version row and is not snapshotted per judgment
(`docs/superpowers/specs/2026-09-01-judge-scoreboard-and-model-envelopes.md` §4.1). Editing it
mid-run would give the two halves different budgets and the difference would be attributed to
position. Do not edit a version's `samplingDefaults` while a paired run is in flight.

**The `NULLS NOT DISTINCT` half of the unique index carries no production load.** There are zero
pointwise `EvaluationRun`s in production, so the `missing-pair-order` guard at `readings.ts:225-239`
has never fired against real data. It is covered by tests only.

**`testRetest` remains NULL.** The project's own failure-mode rule is a *conjunction* —
`testRetest > 0.95 AND positionBias > 0.10` (`docs/research/2026-07-judge-model-inventory.md:148-149`)
— and this design fills only one of the two columns. The rule cannot be evaluated until repeat runs
exist. That is a separate piece of work and is not in scope here.
