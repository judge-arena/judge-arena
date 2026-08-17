# A1 — Human verification and a measured agreement floor

**Date:** 2026-08-17 · **Status:** approved in brainstorming, not yet planned
**Phase:** Roadmap A's **A1** — `2026-08-10-judge-training-engine-roadmap.md`.
**Sibling:** **A1.5**, the annotation studio (`2026-08-17-a1_5-annotation-studio-design.md`), split
out of this phase deliberately and buildable in parallel.
**Depends on:** A0 (golden-set substrate), L1 (tombstone overlay), L2 (revision log) — all complete
on `feat/a0-golden-set-substrate`.

> **On the labels `A1` / `A1.5`.** These are **Roadmap A** phases. The dataset-lifecycle plans that
> were once called A1/A2 are now **L1/L2** (renamed 2026-08-16); `A0…A5` belongs to Roadmap A alone.
> Read `(A1)` in `src/` as **L1** — those markers predate the rename and cannot move, because one of
> them lives in an applied migration Prisma checksums. See
> `../plans/2026-08-16-l1-complete-l2-handoff.md` §0.

---

## Why this phase exists

**A golden set with no agreement measurement is not ground truth; it is one person's opinion**, and
calibrating a judge against it produces a confidently wrong number.

Everything below the surface is already built. What is missing is the surface itself, and the
absence is total rather than partial — verified at `4c631b7`:

- **No `GoldenLabel` writer exists anywhere.** Not a route, not a script, not the seeder.
  `grep -rn "goldenLabel\.\(create\|createMany\|upsert\)" src/ scripts/ prisma/` returns nothing. The
  model, its partial unique index, its tombstone columns and its account-deletion behaviour all
  exist; nothing can produce a row.
- **No `CalibrationRun` writer exists either.** Its only use in `src/` is a `count()` in A0's freeze
  guard (`src/lib/golden-sets.ts`). A2 gives it its first writer; this phase gives A2 something to
  calibrate against.
- **`GoldenItem` content edits destroy the text the annotator saw.** The items `PATCH` reads the
  prior `inputText`/`promptText`/`responseText` **only to detect a change**, then updates in place
  and tombstones the labels. The before-values are never persisted. This is the same defect L2 fixed
  for `DatasetSample`, still open one level up — at the level labelling actually happens.
- **There is no assignment concept at all**, so overlap between annotators would be accidental.

That last one is not a missing convenience. **Inter-annotator agreement requires overlap** — the same
items read by more than one annotator. Without assignment, annotators self-select, the overlap is
whatever coincides, and easy items get their second reading first. The resulting kappa is optimistic
in a way nothing in the system can detect.

---

## The layering this phase sits in

Stated explicitly because an earlier draft got it wrong, and the error is the kind that propagates
into schema: **a golden set has no concept of a model.** It is questions, answers and labels. A model
enters at evaluation time.

| Concept | What it is | Where it lives |
|---|---|---|
| **golden set** | questions, candidate answers, human labels | `GoldenSet` / `GoldenItem` / `GoldenCandidate` / `GoldenLabel` — **A1** |
| **model** | which model, who owns it, which compute | `JudgeModel` / `JudgeModelVersion` (identity) + `ModelEndpoint` (compute, BYOK) — exists |
| **evaluation** | one golden set × one model: ground-truth label beside model label | `CalibrationRun` — **A2** |
| **evaluation performance** | that run's seconds, drain rate, confusion, bias, kappa | columns on `CalibrationRun` — **A2** |
| **model performance** | aggregated across runs: throughput, bias, confusion, kappa | does not exist — **A3** |

The product flow this supports: pick a golden set and a model from a menu, request an evaluation,
then view **that run's** performance, confusion, agreements and disagreements.

**A gap this layering exposes, recorded here so A2 does not discover it.** `CalibrationRun` is a
header row with aggregate metrics and **no per-item rows**. `ModelJudgment` hangs off `EvaluationRun`
and reaches a `DatasetSample` only through `Evaluation`; nothing pairs a `GoldenItem` with a model's
verdict. Without that join row there is no confusion matrix, no per-run disagreement list, and no
human-vs-model kappa — which is most of what "view that run's performance" means.

A2 therefore produces **two artifacts, not one**: `CalibrationRun` as the leaderboard-facing header,
and an **`EvaluationReport`** giving the item-by-item breakdown, computed as a projection over stored
per-item answers. Those decisions and their open questions live in
`2026-08-17-a2-calibration-and-reporting-decisions.md` — recorded rather than specced, because A2's
design takes A1's real label data as an input.

A1 builds none of that. Its entire output is a corpus of human labels and an honest number describing
how much the humans agree.

---

## Decisions

| # | Decision | Why |
|---|---|---|
| 1 | **Test-retest gets a `round` column**, and the partial unique widens to `(goldenItemId, annotatorId, round)` | Two readings by one annotator are **peers**. Tombstoning the first would overload "retracted" and "an earlier valid reading" into one state, and every live-label query — including the agreement maths — would silently drop the first reading. |
| 2 | **`overallScore` becomes nullable; `preference String?` is added**, under a `CHECK` | A pairwise label is a preference, not a score. Encoding it as a float makes the stored number uninterpretable without an out-of-band convention — the exact failure decision #3 rejected for thresholds. `preference` uses `GoldenItem.expected`'s vocabulary so a label and its ground truth compare directly. |
| 3 | **Retest eligibility is intervening-items only** (`K` other items labelled since), stored per set | A time gap alone fails the burst case: an annotator who labels a set in one sitting still remembers the striking items a week later. **Known limitation, accepted:** a set smaller than `K` can never produce a retest, so the queue must say so explicitly rather than appear empty. |
| 4 | **Agreement is computed on read, recorded at freeze** | Reads can never be stale, and the number is persisted at the one moment it becomes historical — when a `CalibrationRun` first references the set and A0's freeze guard fires. No invalidation logic, and no materialised number that can go quietly wrong. |
| 5 | **Provenance is item-level**: `GoldenItemRevision` + `GoldenLabel.goldenItemRevisionId` | "The prompt as the annotator saw it" must survive later edits. The revision log is L2's pattern one level up; the FK makes "what did they see?" a join rather than a timestamp inference. |
| 6 | **Assignment is explicit `GoldenAssignment` rows** | Overlap becomes designed rather than accidental, and a coordinator can hand out work deliberately with an audit trail of who was asked for what. |
| 7 | **No model relation anywhere on `Golden*`** — reversed from an earlier draft | A golden set is questions, answers and labels. A model enters at EVALUATION time, not annotation time. An earlier draft added `GoldenCandidate.responseModel`; that imports a model concept into an artifact that has none. Who produced an imported response is provenance of the SOURCE DATA and stays in `DatasetSample.metadata`. |
| 8 | **Who may HOLD an assignment: owner + admin only** (roadmap decision #5) | Decision 6 is the mechanism; this is the policy over it. With exactly one account the two collapse to "the owner", but they are separate concerns on purpose: when a second account exists the policy widens without redesigning the mechanism. |
| 9 | **The studio UI is A1.5**, not A1 | The panel shell is reusable by A2 and A3. Shipping it separately keeps it reviewable on its own instead of tangled with kappa maths. |

---

## Data model — one migration, `v2h`

### New: `GoldenItemRevision`

`SampleRevision`'s shape one level up. Append-only, one row per content edit, carrying the values as
they stood **before** the change.

```prisma
model GoldenItemRevision {
  id           String     @id @default(cuid())
  goldenItemId String
  goldenItem   GoldenItem @relation(fields: [goldenItemId], references: [id], onDelete: Cascade)

  // The before-image. Exactly the four fields the items PATCH already reads to
  // detect a change and currently throws away.
  inputText    String
  promptText   String?
  responseText String?
  expected     String?

  actorId String?
  actor   User?   @relation(fields: [actorId], references: [id], onDelete: SetNull)
  at      DateTime @default(now())

  labels GoldenLabel[]

  @@index([goldenItemId, at])
}
```

Written by the items `PATCH` **inside the transaction that already tombstones the labels** — not
beside it, so a rolled-back edit leaves no revision claiming it happened.

### Changed: `GoldenLabel`

```prisma
  overallScore         Float?              // was required
  preference           String?             // 'A>B' | 'B>A' | 'tie'
  round                Int      @default(1)
  goldenItemRevisionId String?
  goldenItemRevision   GoldenItemRevision? @relation(fields: [goldenItemRevisionId], references: [id], onDelete: SetNull)
```

**When `goldenItemRevisionId` is set is the subtle part.** With before-image semantics the revision
that captures what an annotator saw does not exist until the edit that supersedes it — so a label
cannot point at it when it is written. Instead **the edit back-fills it**: the same `updateMany` that
tombstones those labels stamps them with the revision just written, because those are exactly the
labels that saw it.

The invariant, stated so nobody re-derives it wrongly:

> **`goldenItemRevisionId IS NULL` means the annotator saw the item's CURRENT content.**
> Non-null means they saw that revision's before-image.

A twice-edited item is correct for free: the second edit's `updateMany` filters on
`tombstonedAt: null`, so it never touches labels an earlier edit already stamped.

### New: `GoldenAssignment`

```prisma
model GoldenAssignment {
  id           String      @id @default(cuid())
  goldenSetId  String
  goldenSet    GoldenSet   @relation(fields: [goldenSetId], references: [id], onDelete: Cascade)
  annotatorId  String?
  annotator    User?       @relation("AssignedAnnotator", fields: [annotatorId], references: [id], onDelete: SetNull)

  // NULL = the whole set. Set = one item, for adjudication or a targeted
  // re-read. Both granularities, because assigning 620 rows individually is
  // the exception and not the normal case.
  goldenItemId String?
  goldenItem   GoldenItem? @relation(fields: [goldenItemId], references: [id], onDelete: Cascade)

  round        Int         @default(1)

  assignedById String?
  assignedBy   User?       @relation("AssigningCoordinator", fields: [assignedById], references: [id], onDelete: SetNull)
  assignedAt   DateTime    @default(now())
  completedAt  DateTime?
  revokedAt    DateTime?
  revokedReason String?

  @@index([goldenSetId, annotatorId])
  @@index([annotatorId, revokedAt])
}
```

`annotatorId` is `SetNull` to match `GoldenLabel.annotatorId` — account deletion anonymises rather
than destroying, and an assignment to a deleted account is a record of what was asked, not something
to be actioned.

### Changed: `GoldenSet`

```prisma
  retestIntervalItems Int @default(20)   // GoldenSet — K, the intervening-items gate
```

`GoldenCandidate` is **unchanged**. An earlier draft added `responseModel` here; see decision 7.

`retestIntervalItems` lives on the set so the interval **in force** travels with it, for the same
reason decision #3 stores a threshold as data: a reliability number is uninterpretable without the
protocol that produced it.

### The hand-edited SQL, counted honestly

`CONTRIBUTING.md`'s pseudo-drift table goes from **five rows to eight**. That is a real cost of these
choices and it is stated here so it is chosen rather than discovered:

| Object | Why Prisma cannot express it |
|---|---|
| `GoldenLabel_score_xor_preference` — `CHECK (num_nonnulls("overallScore","preference") = 1)` | No `CHECK` syntax of any kind. Same class as L1's `Tombstone_exactly_one_entity`. |
| `GoldenLabel_goldenItemId_annotatorId_round_live_key` — partial unique `WHERE "tombstonedAt" IS NULL` | No `WHERE` predicate on an index. **Replaces** v2e's two-column version, whose row gains a "superseded by v2h" note rather than being deleted — v2e is applied and immutable. |
| `GoldenAssignment_item_annotator_round_active_key` — partial unique `WHERE "revokedAt" IS NULL` | Same. One active assignment per (item, annotator, round); a revoked one must not block a reassignment. |

Each needs a raw-SQL test, because the typed client cannot construct a violating row — the same
reason `tests/db/tombstone-check-constraint.test.ts` exists.

---

## The library core

All three modules live in `src/lib/**`, which both coverage configs measure. This is the split that
keeps a large UI phase honest: the logic that can be wrong lives where tests reach it.

### `src/lib/agreement.ts` — pure, no Prisma

Takes readings, returns a number **and the method that produced it**, so the exit gate's "with a
stated method" is data rather than prose:

```ts
type AgreementResult = {
  value: number;
  statistic: 'cohen' | 'fleiss';
  weighting: 'linear' | 'quadratic' | 'none';
  annotatorCount: number;
  itemCount: number;      // items with ≥2 readings — the OVERLAP, not the set size
  categories: string[];   // the ordered category set the number was computed over
};
```

Per decision #3: **Cohen's for two annotators, Fleiss's for more**, weighted for ordinal scores.
Three limitations are recorded rather than papered over:

1. **Fleiss's kappa has no standard weighted form.** With >2 annotators the number is unweighted and
   is *reported* as `weighting: 'none'` — never presented as comparable to a weighted two-annotator
   figure. Krippendorff's alpha is the tool that handles >2 raters *and* ordinal data; decision #3
   named Fleiss, so this follows it and records the gap.
2. **`overallScore` has no declared scale anywhere.** Kappa needs discrete categories, so the
   category set is the sorted union of observed values, with weights computed on the **values**
   (1 vs 5 is four steps, not three ranks). Returned in `categories` so a reader knows what it was
   computed over. If one annotator uses {1,2,3} and another {1,5}, the derived scale is their union —
   a declared scale is a later schema question, deliberately not invented here.
3. **Preferences are unweighted by default.** Calling `'A>B'`-vs-`'tie'` closer than
   `'A>B'`-vs-`'B>A'` is a claim about the domain, not a given.

`itemCount` is the **overlap**, not the set size, and the UI must show it. An agreement number over
three shared items is not a floor; it is an anecdote, and the only thing that makes that visible is
reporting what it was computed over.

**With fewer than two annotators there is no inter-annotator number at all**, and the function returns
an explicit insufficiency rather than a value:

```ts
{ value: null, reason: 'insufficient-annotators' | 'insufficient-overlap', annotatorCount, itemCount }
```

Returning `0` would be read as total disagreement, which is the opposite of "not measurable" and
exactly the kind of confidently wrong number this phase exists to prevent. **This is the normal case
at launch**: with one account there is one annotator, so `testRetest` is the only reliability signal
available until a second annotator exists — which is what the roadmap says the `testRetest` column
was put there for.

### `src/lib/retest.ts`

Eligible when the annotator has a live round-1 label on the item, no round-2 label, and has labelled
**K other items since** that reading — `K` from `GoldenSet.retestIntervalItems`.

Returns eligibility *and* the shortfall, because "not yet" needs a number to be useful:
`{ eligible: false, labelsUntilEligible: 7 }`.

### `src/lib/labelling-queue.ts`

Serves the next item for an annotator. **Its blinding is load-bearing**, and three properties define
it:

- A retest item is **indistinguishable** from a first reading: identical response shape, the prior
  label never included, the round never disclosed.
- Position is a deterministic shuffle seeded by `(annotatorId, goldenSetId)` — reproducible in tests,
  not inferable from ordering.
- When nothing is eligible it returns an explicit state rather than an empty list:
  `{ next: null, reason: 'no-assignment' | 'set-complete' | 'retest-not-yet-eligible', labelsUntilRetest? }`.

---

## Routes

| Route | Method | Access |
|---|---|---|
| `…/golden-sets/[id]/queue` | GET | assigned annotator, owner, admin |
| `…/golden-sets/[id]/items/[itemId]/labels` | POST | assigned annotator, owner, admin |
| `…/golden-sets/[id]/agreement` | GET | public **iff** published; else owner/admin |
| `…/golden-sets/[id]/disagreements` | GET | public **iff** published; else owner/admin |
| `…/golden-sets/[id]/items/[itemId]/history` | GET | public **iff** published; else owner/admin |
| `…/golden-sets/[id]/assignments` | GET, POST, DELETE | owner, admin |
| `…/golden-sets/[id]/items` | PATCH *(modified)* | unchanged — now writes a revision and back-fills labels |

**Two rules that are security properties, not conveniences:**

1. **The server decides the round.** If the client names it, blinding becomes client-trusted and a
   stale tab or a curious annotator defeats the reliability signal the phase exists to produce.
2. **Eligibility is re-checked on submit**, not only when the queue hands the item out. Otherwise a
   back button, a stale tab, or a crafted POST writes a reading for an item that annotator was never
   meant to see — and for a blind retest, knowingly seeing it twice is exactly what invalidates the
   measurement.

**"Public iff published"** means `optionalAuth`: anonymous is served only when `publishedAt` is set
**and** `visibility: 'public'`. Internally the data is always viewable, and always recalculable from
the stored labels.

---

## Provenance and its deliberate ceiling

Three separate questions, three different answers, and the third is a limit rather than a feature:

- **What did the annotator see?** `GoldenLabel.goldenItemRevisionId` → the exact before-image, plus
  `GoldenCandidate` rows, which are immutable — only ever `createMany`'d at set creation, never
  updated or deleted, so pairwise provenance is complete without candidate revisions.
- **Which model produced the imported answer?** Not a golden-set concern, deliberately — see
  decision 7. It remains in `DatasetSample.metadata` (`response_model` for JudgeBench), reachable via
  `GoldenItem.sourceDatasetSampleId`. The model that MATTERS for a verdict is the one under
  evaluation, and it is recorded on the evaluation, not on the item being annotated.
- **Which human answered?** `GoldenLabel.annotatorId` — **until that account is deleted**, at which
  point it becomes NULL by design. This is the anonymise-rather-than-destroy rule, and it is a
  deliberate ceiling on re-verification: after deletion, *that a reading happened* survives and
  *who made it* does not. Stated here so a later reader does not "fix" it.

---

## Testing

**The agreement maths are tested against published worked examples, not against our own output.** A
snapshot of what the implementation happens to return proves it is stable, not that it is right, and
a wrong kappa is precisely the confidently-plausible number nobody catches. Fixtures are textbook
Cohen's and Fleiss' examples with hand-checked answers.

Non-vacuity, per the standard A0 adopted — break it, observe the specific failure, restore, confirm
byte-identical:

1. **Eligibility boundaries** at `K−1` and `K`, not just "eventually eligible".
2. **Blinding**: a retest response is shape-identical to a first reading and leaks no prior label.
   A test that only checks the status code passes against a handler that returns the old label.
3. **Submit-side re-check**: a POST for an item the annotator holds no active assignment for is
   refused, even though the queue never offered it.
4. **Provenance across an edit**: label an item, edit it, assert the label still resolves to the text
   that annotator saw. Without the back-fill this returns the *new* text and looks fine.
5. **The three hand-edited constraints**, each through raw SQL.
6. **Overlap reporting**: agreement over a set where only two items have two readings reports
   `itemCount: 2`, not the set size.

UI is verified manually — all three vitest configs are `environment: 'node'` with no jsdom. A known
and accepted limit, and the reason the logic above lives in `src/lib/**`.

---

## Exit gate

Straight from the roadmap, plus what this design adds:

- A golden set reports an agreement number **with a stated method** — statistic, weighting, annotator
  count, and the overlap it was computed over.
- **A deliberately-inconsistent re-label moves `testRetest` in the expected direction.**
- An item edited after labelling still resolves each label to the text that annotator saw.
- A POST from an unassigned annotator is refused.

---

## Out of scope

- **The studio UI** — A1.5, and buildable in parallel.
- **Capturing `reasoning_content`.** Chain-of-thought is discarded on every model call today
  (preflight Stage 5). Backlogged deliberately: the reasoning panel renders `ModelJudgment.reasoning`
  and `rawResponse`, and is structurally empty of true CoT for reasoning models — and simply empty
  for non-reasoning models, which is correct rather than broken.
- **Krippendorff's alpha**, and a **declared score scale** on `GoldenSet`. Both are real improvements
  over the limitations recorded above; neither is invented mid-phase.
- **Cross-user annotation policy** beyond owner/admin — roadmap decision #5, revisited when a second
  account exists.
- **A2's calibration engine**, which is additionally hard-gated on rebaseline T5: RabbitMQ sits at
  **54.5% of its publisher-blocking watermark at idle** (measured 2026-08-17) with **zero**
  VMServiceScrapes and **zero** VMRules covering it.
