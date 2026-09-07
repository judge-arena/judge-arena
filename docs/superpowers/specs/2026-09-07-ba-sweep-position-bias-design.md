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
- **`SCORING_RULES_VERSION` bumps to 3**, with a changelog entry in the same commit. An earlier draft
  claimed it could stay at 2 by citing `scoring-version.ts:50-57` as a self-describing exemption. That
  reading is backwards: the exemption is `:47-50`, and **`:50-57` is the `UNLESS` carve-out that
  mandates a bump** — whose condition is met here, because a NULL `positionBias` would otherwise mean
  both "no BA half was ever requested" and "a paired run with no decisive pairs". The repo already
  rejected the escape route at v2n: `committedCount` is a stored non-NULL companion stating the
  identical discriminator (`schema.prisma:976-981`) and generation 2 was bumped anyway
  (`scoring-version.ts:53-54`). Nothing in CI catches a missed bump —
  `tests/lib/calibration-scoring-version.test.ts:20-41` pins only constant↔changelog consistency — so
  this is a judgement the spec must make, not a check that will fail loudly;
- `marginOverConstant`, the scoreboard's default sort key, keeps meaning precisely what it means
  today. **The bump is a provenance stamp, not a definition change** — that is exactly why D2 holds:
  a generation-3 row's `rawAgreement` is computed by the same rules as a generation-2 row's, and the
  two remain directly comparable. What generation 3 records is that *additional* quantities were
  computed, not that the old ones moved.

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
| `positionBias` | \|(verdicts naming **slot A**, both orders) / 2n − 0.5\| — the **first-shown pick rate deviation**, computed on the RAW verdict letter **before** `preferenceFromVerdict` | `docs/research/2026-07-judge-model-inventory.md:146-149` (threshold 0.10, reported jointly with `testRetest`) | a **symmetric flipper** scores 0.0 |
| `orderFlipRate` | fraction of paired items whose *preference* changes under swap | `/root/research/evaluation-harnesses/07-llm-as-judge-and-rubrics.md:590` (median 41.3% in the literature) | cannot separate "prefers slot 1" from "noisy under swap" |

**`positionBias` is the one number in this design computed BEFORE the order mapping.** That is what
makes it immune to the key's 336/284 class imbalance: a correct judge picks slot A on the 336 `A>B`
items in AB and on the 284 `B>A` items in BA, so its pooled slot-A rate is exactly 0.5 regardless of
how lopsided the key is. Computing it from *preferences* instead — which is what an earlier draft of
this spec specified — silently yields `|p_AB − p_BA|/2`, the **difference** of the slot rates. That is
a content-discrimination statistic wearing a position-bias name, and it is **anticorrelated** with the
quantity: measured against this corpus, a pure first-slot stamper scores **0.0000** and a perfect
content judge scores **0.0419**. Every value in range, matrix square, no symptom. This paragraph
exists because that error was made once already.

The four archetypes, which the fixtures in §6 pin:

| judge | `positionBias` | `orderFlipRate` |
|---|---|---|
| always picks the first slot (maximally position-driven) | **0.5** | 1.0 |
| symmetric flipper (names the same slot both times, no net side) | **0.0** | 1.0 |
| perfect content judge | **0.0** | 0.0 |
| uniformly random | 0.0 | 0.5 |

Rows 1 and 2 are why both numbers are stored: the symmetric flipper is entirely position-driven and
`positionBias` alone certifies it unbiased. Rows 2 and 3 are why `orderFlipRate` alone is not enough
either — it cannot say *which* slot. Note that `orderFlipRate`'s no-information point is **0.5**, not
0: any order-independent judge flips at least half the time, which is why the literature's 41.3%
median sits on the correct side of it.

**Consequence on the first scheduled run.** `smollm2` picks slot A on 198 of 617 AB items (0.3214).
If BA matches, the corrected estimator reports `positionBias = 0.1786` against a 0.10 threshold. The
inverted definition would have reported **0.00** and cleared it.

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

The fix has three parts, and the second and third are the ones an implementer will miss.

**(a) Partition the rows.** Group by `pairOrder` before scoring and score each partition
independently — exactly the contract `readings.ts:170` states in its own error text, *"pass one
pairOrder's judgments per call."*

**(b) The partition must carry `context` with it.** `score.ts:264-267` builds `context` explicitly
*"Parallel to `rows`"* and indexes it positionally at `:379-381`. Grouping `rows` alone slides every
disagreement past the first BA row onto another item's `runId`. Either fold `runId`/`itemIndex` into
the row type or group `(row, context)` pairs. The repo already guards this class at
`tests/lib/calibration-score.test.ts:666-722` — but that guard's fixture (`:113-135`) emits one
judgment per run, so it stays **green** under the naive fix and will not catch the regression.

**(c) The no-verdict accounting must move inside the partition. THIS IS THE SUBTLE ONE.**
`unjudgedItems` and `dispatchedItemCount` are accumulated per-`EvaluationRun` at `score.ts:285-297`,
*upstream* of the `rows` array, and `unjudgedItems` keys on `run.modelJudgments.length === 0`. With
two judgments per run and `where: { status: 'completed' }` at `score.ts:254`, **a run whose AB
judgment errored while its BA judgment completed arrives with `length === 1`**: it escapes
`unjudgedItems`, contributes no AB row, and is invisible to `projection.missingVerdicts`. The AB
partition then reports `missingVerdicts 0` and `noVerdictRate 0` over a silently shortened
denominator — the exact failure `score.ts:276-280` memorialises (*"reported `missingVerdicts 0` while
FOUR of thirty items had dead-lettered"*), in the direction that **hides loss**.

This is not hypothetical: production holds 737 errored judgments, and `cmtqi78z…` alone has 3 of 620.
The accounting must ask "no COMPLETED judgment **at this pairOrder**", which requires either pushing
a `pairOrder` filter into the query at `score.ts:251-256` or selecting `status` unfiltered so a
launched-but-undrained order stays visible.

**Acceptance test for this step is inertness ON FIXTURES, not on production.** Every pinned
expectation in `tests/lib/calibration-score.test.ts` is unchanged, and equality holds on all stored
fields **except `finishedAt`**. It cannot be stated as production byte-identity: `score.ts:494` writes
`finishedAt: new Date()` and `:479` writes `scoringVersion` unconditionally, and prod currently reads
20 of 22 rows with `scoringVersion` NULL — a real `--score-only` would flip those to the current
generation and backfill the v2l/v2m/v2n columns. **No production row is re-scored to prove this step
inert.** This step lands and is verified *before any BA row can exist*, which is what makes every
later step safe.

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
consulted**. `grep -arn pairOrder src/worker/ src/lib/llm/` returns nine comments plus exactly one
executable line — `src/worker/run-create-consumer.ts:285`, an unconditional `pairOrder: null` on the
pointwise expansion path (double-guarded: `run-launch.ts:745` hardcodes `protocol: 'pointwise'` and
`run-create-consumer.ts:201` throws on anything else). **No READ of `pairOrder` exists anywhere in
`src/`.**

The prose at `render.ts:575-579` describing the BA sweep as *"a second ORDERING through this same
function"* is **aspirational, not shipped** — the function has no input that could express it.

**Implementation:** widen the signature to `buildPairwiseUserPrompt(submission, order: PairOrder =
'AB')`. The `position` sort stays exactly as it is — position remains candidate identity
(`src/lib/golden-sets.ts:48`, *"position IS the identity (0 = A, 1 = B)"*) — and the new parameter
decides which of the two sorted candidates becomes `Response A`. Default `'AB'` keeps every existing
caller and `tests/lib/render-pairwise.test.ts:78` green.

Thread `judgment.pairOrder` through **five** hops:

```
judgment-consumer.ts:488-506   the `registryInput` object literal  (NOT the candidates map at :499 —
                               that is the rejected no-op below)
  -> registry.ts:1098          prepareJudgmentCall
  -> registry.ts:1019          renderJudgmentPromptOrThrow   (the sole caller of the next hop)
  -> render.ts:626             renderJudgmentPrompt          (:635 is the pairwise arm, :636 pointwise)
  -> render.ts:585             buildPairwiseUserPrompt
```

The `renderJudgmentPromptOrThrow` wrapper is **widened, not bypassed** — `registry.ts:1009-1017`
explains that bypassing it reclassifies a deterministic render failure as retryable.

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
- **No web route can WRITE a BA judgment** (`api/evaluations/route.ts:303-306` and
  `api/evaluations/[id]/runs/route.ts:84-89` both omit `protocol`/`candidates`; the default is
  pointwise at `run-launch.ts:392`). Scope the claim to writes — the web tier does READ judgments, see
  §5.

Both judgments are created inside the existing nested `EvaluationRun` create, so they share one
transaction by construction — satisfying D4.

**This step must also close a silent hole.** `tests/integration/finalization.test.ts:628`:

```
const legalWorstCaseMs = MAX_CALIBRATION_ITEMS * 3 * resolveTimeoutBudgets().hardCapMs;
```

There is no orders-per-item factor, so this assertion stays **green while the real bound doubles**.
State it as a formula rather than a verdict:

```
items × orders × 3 × resolveTimeoutBudgets().hardCapMs  <  NEVER_STARTED_TIMEOUT_MS (3.888e9, 45 d)
```

At the resolved default cap of 900 000 ms (production sets no override) this admits **≤ 719 items at
two orders**; `1000 × 2 × 3 × 900 000 = 5.4e9` exceeds the net. The clamp is therefore a named
constant — `MAX_PAIRED_CALIBRATION_ITEMS = 719` — and **`MAX_CALIBRATION_ITEMS` itself stays 1000**
(`tests/db/calibration-link.test.ts:488` pins it).

**A live caveat the amended test must encode:** 620 × 2 is inside the net only while
`EVALUATION_MODEL_HARD_CAP_MS` is at or below 1 045 161 ms. At the legal ceiling
`MAX_HARD_CAP_MS = 1_170_000` (`timeout-policy.ts:94`) the same 620-item paired run is 4.352e9 and the
amended assertion goes **red**. The test must resolve the cap rather than assume the default.

### Step 4 — The estimators

New pure module `src/lib/calibration/position-bias.ts`, taking **`CalibrationVerdictRow`-shaped rows**
— `{ verdict, pairOrder, itemId }` — and returning both D3 numbers.

**It must NOT take `Reading[]`.** `Reading` (`src/lib/agreement.ts:78`) carries only
`{ itemId, raterId, category }`, and `readings.ts:242-244` has already collapsed the raw letter and
the order into a preference. `positionBias` is not computable from that input. The two estimators
legitimately read different fields of the same row — `positionBias` the raw letter, `orderFlipRate`
the mapped preference — and an implementer who unifies them reintroduces B1. Pure and separately testable, in the mould of `readings.ts` — a named function with an
arm-by-arm test, for the same reason that file gives.

**Eligibility.** An item contributes only if **both** orders produced a decisive verdict. `tie` is
order-invariant by construction (`readings.ts:103`) and is this product's sanctioned no-answer
channel, so a tie in either order excludes the item from both estimators.

**`pairedDecisiveCount` is reported alongside both numbers, always.** Without it an abstaining judge
scores a flawless 0.0 position bias on n = 3. This is the scoreboard's standing rule 1 — no rate
without its denominator — and it applies here more sharply than anywhere else, because both
estimators are bounded and a small denominator makes them look confident.

**Intervals are their own sub-step with their own test budget — the machinery does not exist.**
`grep -arli wilson src/ scripts/ tests/ prisma/` returns nothing; the only source of the Wilson and
`⚠n<20` conventions is `docs/calibration-scoreboard-2026-09-06.md`, which is **untracked at HEAD**.

The two estimators do **not** take the same interval:

- `orderFlipRate` — Wilson on `pairedDecisiveCount` is correct. One Bernoulli draw per item.
- `positionBias` — Wilson is **wrong**. Each item contributes two clustered draws and `|·|` folds the
  scale at 0.5, so a shifted Wilson can exclude its own point estimate. Use a paired interval: the
  per-item slot-A contribution is in `{0, 1, 2}` and the variance is taken *between* items.

**`orderFlipRate` compares preferences, not raw verdict letters.** It applies `preferenceFromVerdict`
to each order first and asks whether the resulting `A>B` / `B>A` changed. Comparing raw letters would
report a *stable* judge as flipping 100% of the time.

### Step 5 — Storage: migration `v2o`

| column | status | holds |
|---|---|---|
| `positionBias` | **already exists**, `schema.prisma:1002`, 0/22 populated | `marginalSkew` (D3) |
| `orderFlipRate` | **new** | the flip rate (D3) |
| `pairedDecisiveCount` | **new** | the denominator both share |
| `ordersRequested` | **new** | which orders the run ASKED for, e.g. `'AB'` or `'AB,BA'` |

`ordersRequested` exists because `pairedDecisiveCount IS NULL` is **not** a sound discriminator on its
own: `score.ts:254` filters `status: 'completed'`, and no column records which orders were
*requested*, so a BA half that launched and never drained would store identically to a run that never
had one. With `ordersRequested` the three states separate cleanly — `'AB'` = never paired;
`'AB,BA'` with a NULL estimator = paired but no decisive pairs; `'AB,BA'` with a value = measured.

`positionBias` is finally written with the meaning its own source documents intended.

Flip rate gets a **new** column rather than reusing the adjacent dead `biasSensitivityRate`. Those
four columns (`testRetest`, `positionBias`, `biasSensitivityRate`, `flipRateVsParent`,
`schema.prisma:1001-1004`) are the only ones in that block with no `///` doc, and they originate in
`20260725012218_v2_meta_eval/migration.sql:50` — a v2 schema sketch, not a designed metric.
`biasSensitivityRate` does not mean order-flip rate, and a misnamed column is precisely how a number
gets misread a year later. All three columns ship **with** doc comments.

The next free migration letter is `v2o` — read from `ls prisma/migrations/`, where `v2b`…`v2m`…`v2n`
are all taken. (The `/^v2[a-z]$/` assertion at `tests/lib/calibration-scoring-version.test.ts:36`
applies to `SCORING_RULES_CHANGELOG[].migration`, not to directory names; it is satisfied by `v2o` but
is not what determines the letter.)

`SCORING_RULES_VERSION` stays **2** (D2). The NULL is unambiguous: a run with no BA half has NULL in
all three new columns together, and `pairedDecisiveCount IS NULL` is the discriminator.

### Step 6 — Reporting

Both estimators print with their shared denominator, their intervals, and the tie-exclusion count,
under the board's "never displayed without its companion" rule. A guard fires at
`pairedDecisiveCount < 20`.

**The rendering lives in `src/lib/calibration/baseline.ts`, beside `formatSelectiveAccuracyLines` —
NOT in `scripts/calibration/run.ts`.** That file is in no coverage include, so logic placed there is
untested by construction. `scripts/calibration/run.ts` gains call sites only; note
`tests/lib/calibration-baseline.test.ts:389,400` pin *exactly one* call site each of
`formatSelectiveAccuracyLines(` and `formatNoVerdictRateLine(` in that file, so adding a second call
to either would go red.

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

**4.6 `dispatchedItemCount == verdictCount + missingVerdicts` BREAKS, and nothing stored records the
shortfall.** `dispatchedItemCount` (`score.ts:294`) is per-run and does not double; `verdictCount`
(`:359`) is per-row and does. An earlier draft claimed "the identity survives for stored fields" —
**it does not.** It breaks whenever *either* order half-drains: a run whose AB errored and BA
completed is counted as neither judged nor unjudged (see Step 1(c)), so the AB partition's
`missingVerdicts` under-reports and `rawAgreement` is computed over a short denominator. `score.ts:476-496`
stores `verdictCount` but neither `dispatchedItemCount` nor `missingVerdicts`, so the discrepancy is
unrecoverable after the fact. Step 1(c) is the fix; this trap is the reason it is not optional.

**4.7 Coverage gates are the binding constraint, and one is already in regression.**
`vitest.db.config.ts:165` (block `162-169`) sets `branches: 77` against a measured 1004/1297 =
**77.4094%** — six entirely-uncovered new branches of budget, against a config whose own policy
(`:56-57`) mandates a 2pp buffer. Both files this design touches most, `run-launch.ts` (51/70) and
`calibration/launch.ts` (25/33), sit **below** that aggregate, so branches added there cost double.

`src/worker/**` at 114/125 against floor 87 is **also 6 uncovered branches** — the same budget, not a
looser one. `src/lib/llm/**` at 527/586 vs 83 is the only roomy glob.

**`tests/integration/**` carries no coverage instrumentation.** Step 2's five-hop threading must
therefore be covered by a *unit* test — `tests/lib/judgment-consumer-escalation.test.ts` is the only
file that drives `defaultRunProviderPairwise` — or it contributes uncovered branches with nothing
offsetting them.

**The floor does not move.** New code ships with its tests.

---

## 5. What does NOT change

- The web tier's **write** path. No route can launch a pairwise run.
  **It is not out of blast radius for reads**, and this is a named accepted risk: `src/lib/export.ts:129`
  emits one row *per model judgment per run* into an `EvaluationExportRow` that has **no order column**,
  and the run-detail page renders one card per judgment labelled only by model name — so a paired run
  exports and displays as two indistinguishable rows for one item. Either add `model_pair_order` (both
  export routes' `include` already loads it) or accept it explicitly. `/api/leaderboard/route.ts:88-92`
  is genuinely safe for a specific reason worth stating rather than assuming: it filters
  `overallScore: { not: null }`, which pairwise judgments never carry.
- The queue message schema. `{judgmentId, runId, attempt}` (`publish.ts:30-34`) already addresses a
  judgment by primary key; two judgments on one run need no change.
- Claim and idempotency. `claim.ts:105-108` keys on the judgment PK.
- Run finalization. `run-finalizer.ts:122-136` groups by status; `stillActive = pending + running`
  is already correct for N judgments.
- `runModelSelections`, `@@unique([runId, judgeModelVersionId])` (`schema.prisma:468`) — stays
  one row per version regardless of order count.
- All 22 historical `CalibrationRun` rows.

---

## 6. Testing

TDD throughout, per the project's standing workflow.

1. **Step 1 inertness** — re-score existing production-shaped **fixtures** (never a production row),
   asserting equality on every stored field except `finishedAt`, with every pinned expectation in
   `tests/lib/calibration-score.test.ts` unchanged. This gates everything downstream.
2. **Prompt bytes** (trap 4.1) — the load-bearing test. `userPromptSha256` differs between orders;
   position 1's text precedes position 0's in the BA prompt.
3. **Single inversion** (trap 4.2) — arm-by-arm, in the style of
   `tests/lib/calibration-readings.test.ts:25-64`.
4. **Three archetype fixtures, not one.** This is the set that pins D3 and catches the inversion
   described there; the single fixture an earlier draft specified would have *enforced* the defect.
   - pure first-slot stamper → `(positionBias 0.5, orderFlipRate 1.0)`
   - symmetric flipper → `(0.0, 1.0)`
   - **perfect content judge, run against the real 336/284 key → `(0.0, 0.0)`**

   The third arm is the load-bearing one: it is the only fixture that catches the key-imbalance
   confound, and under the inverted definition it reads **0.0419** instead of 0.0.
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

**The resolution, computed with the PAIRED formula.** An earlier draft quoted 0.052-0.056 as the
half-width — that is the *unpaired* two-independent-proportions SE (`1.96·sqrt(2·0.25/620) = 0.05566`)
on the δ scale, while `positionBias` is `|δ|/2`. It overstates the interval by roughly 2× and led to
the wrong conclusion. The paired half-width is:

```
HW = 1.96 · sqrt( f / (4n) )        f = orderFlipRate,  n = pairedDecisiveCount
```

| f | HW at n = 620 |
|---|---|
| 0.10 | 0.0125 |
| 0.413 (literature median) | 0.0253 |
| 1.00 (worst case) | **0.0394** |

**So at n = 620 the maximum half-width is 0.0394, and a `positionBias` of 0.04 IS distinguishable from
zero.** The earlier text instructed the team to discard a real effect as noise. Note the denominator
falls below 620 under tie exclusion, which is what makes reporting `pairedDecisiveCount` load-bearing
rather than decorative. The right significance test for `orderFlipRate` between two judges is
**McNemar's**, on the paired flip/no-flip table.

The scoreboard's 0.0586 least-significant-difference is a separate quantity and remains an **n ≈ 30**
figure — all five repeat runs behind it are on `judgebenchsample-30-random`, and no judge has a repeat
run on the 620 set. It is not the yardstick for these estimators.

**Sampling drift is DETECTED, not silent — but it is detected per-run, not per-order.** An earlier
draft claimed `samplingParams` is not snapshotted per judgment and that a mid-run edit would be
silently attributed to position. That is false, and the source it cited says the opposite:
`2026-09-01-judge-scoreboard-and-model-envelopes.md:422-425` reads *"`ModelJudgment.samplingParams` is
written per call and never revised."* It is written at `judgment-consumer.ts:762`, and production
carries it on **3336 of 3336** completed judgments. A mid-run edit surfaces as `moved_mid_run`
(`sampling-drift.ts:68`, printed at `scripts/calibration/run.ts:350-353`).

The genuine residual: `detectSamplingDrift` groups per **run**, not per **order**. If a version's
`samplingDefaults` moves mid-run, the drift report will flag it but will not say which orders ran
under which config — and that breakdown is exactly what a position-bias reader needs. The drift report
gains a per-order split.

**The `NULLS NOT DISTINCT` half of the unique index carries no production load.** There are zero
pointwise `EvaluationRun`s in production, so the `missing-pair-order` guard at `readings.ts:225-239`
has never fired against real data. It is covered by tests only.

**`testRetest` remains NULL.** The project's own failure-mode rule is a *conjunction* —
`testRetest > 0.95 AND positionBias > 0.10` (`docs/research/2026-07-judge-model-inventory.md:148-149`)
— and this design fills only one of the two columns. The rule cannot be evaluated until repeat runs
exist. That is a separate piece of work and is not in scope here.
