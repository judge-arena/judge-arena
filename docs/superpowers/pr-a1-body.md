## A1 + A1.5 — human verification, and the annotation studio

Roadmap A's **A1** (all seven tasks of `plans/2026-08-17-a1-human-verification.md`) and **A1.5**
(all five of `plans/2026-08-17-a1_5-annotation-studio.md`), plus the last two L1 residuals.
Designs: `specs/2026-08-17-a1-human-verification-design.md` and
`specs/2026-08-17-a1_5-annotation-studio-design.md`.

**Follows PR #12** (A0 + L1 + L2 + R1 + R3), which is merged. This branch continues on top of it.

> On the labels: `L1`/`L2` are the dataset-lifecycle plans; `A0…A5` are Roadmap A phases. `(A1)`
> markers in `src/`, `feat(a1):` prefixes from before 2026-08-16, and the `v2f` migration header
> mean **L1** — they predate the rename and one lives in an applied migration Prisma checksums.
> The `feat(a1):` commits in *this* PR are Roadmap A's A1.

### Why this phase exists

**A golden set with no agreement measurement is not ground truth; it is one person's opinion**, and
calibrating a judge against it produces a confidently wrong number.

Before this PR, `GoldenLabel` had **no writer anywhere** — not a route, not a script, not the seeder.
The model, its partial unique index, its tombstone columns and its account-deletion behaviour all
existed; nothing could produce a row. This gives it one, plus the measurement apparatus that makes
the rows mean something.

### What landed

| Commit | What |
|---|---|
| `4ff04f4` | **`v2h`** — `GoldenItemRevision`, `GoldenAssignment`, `GoldenLabel.{round, preference, goldenItemRevisionId}`, `GoldenSet.retestIntervalItems`. Three hand-edited constraints. |
| `98a524b` | **`src/lib/agreement.ts`** — Cohen's / Fleiss's, weighted on value distance. |
| `75562f8` | **Item edits record the before-image** and back-fill the labels they tombstone. |
| `0017870` | **`retest.ts` + `labelling-queue.ts`** — eligibility and blinded selection. |
| `a6c9206` | **The assignment routes** — overlap becomes designed rather than accidental. |
| `a3cdbf5` | **Queue + submit** — server-decided rounds, submit-side re-check. |
| `eef73fb` | **Agreement, disagreements, history** — public iff published. |
| `c440058` | Docs: A1 marked complete, with what the plan got wrong. |
| `6528b32` | **R4 + R5** — the last two L1 residuals, closed. |
| `133cc12`…`05bf29b` | **A1.5** — the annotation studio, all five tasks. |

### The migration: three hand edits, and why each is invisible to tooling

`v2h` takes `CONTRIBUTING.md`'s "Known migrate-diff pseudo-drift" table from **five rows to eight**.

1. **`GoldenLabel_score_xor_preference`** — a `CHECK (num_nonnulls("overallScore","preference") = 1)`.
   A pointwise label is a score, a pairwise label is a preference, exactly one is set. Prisma's DSL
   has no `CHECK` syntax of any kind.
2. **`GoldenLabel_goldenItemId_annotatorId_round_live_key`** — v2e's partial unique, **widened with
   `round`**. Test-retest needs two live readings by one annotator on one item; the two-column
   version permitted one. Note `migrate diff` emits no `DROP` for the old index either, so **both**
   the drop and the recreate are hand-written.
3. **`GoldenAssignment_item_annotator_round_active_key`** — partial unique `WHERE "revokedAt" IS
   NULL`. `DELETE` on an assignment **revokes**; without the predicate one revoked row would block
   reassigning that work forever.

All three are pinned by raw SQL in `tests/db/golden-label-constraints.test.ts` — the typed client
cannot construct a violating row — and **each was verified to fail with the object dropped**.

### The two security properties, which are not conveniences

1. **The server decides the round.** The submit schema has no `round` field at all, so zod's strip
   drops a client-supplied one before any code reads it. Both routes derive it through one shared
   `nextRoundFor`, so "re-derives it exactly as the queue did" is structural rather than a comment.
2. **Eligibility is re-checked on submit**, not merely when the queue handed the item out — both
   that an active assignment covers `(item, round)`, and that a round-2 reading has aged past K.
   A back button, a stale tab, or a crafted POST otherwise writes a reading for an item the
   annotator was never offered, and for a blind retest, knowingly seeing it twice is exactly what
   invalidates the measurement.

### One thing to expect that looks like a bug and is not

**With one account there is one annotator, so every inter-annotator number returns
`insufficient-annotators`** — `value: null` with a reason, never `0`, because `0` reads as total
disagreement, which is the opposite of "not measurable". `testRetest` is the only reliability signal
that produces a value until a second account exists. That is by design; the panel's normal state on
day one is an explanation, not a number.

The overlap model, assignment rows, Fleiss path and disagreement queue are nonetheless **built and
tested now**, against fixtures that create N `User` rows. A DB test does not need the backend to
have three annotators disagree. What waits on API access is only how annotators get provisioned and
routed work.

### Exit gate — all four clauses, each pinned by a named test

- A set reports a number **with a stated method** — statistic, weighting, annotator count, and the
  **overlap** it was computed over (not the set size).
- **A deliberately inconsistent re-read moves `testRetest` down.**
- An item edited after labelling still resolves each label to the text that annotator saw.
- A POST from an unassigned annotator is refused.

### Suites

| Suite | Before | After |
|---|---|---|
| unit | 508 / 37 files | **578 / 42** |
| db | 555 / 39 files | **633 / 42** |
| integration | 80 / 10 files | **80 / 10** |

`npx tsc --noEmit` and `npm run lint` exit 0 with no warnings, and `npm run build` compiles.
`prisma migrate status`: **18 migrations**, up to date. Both coverage configs exit 0 and **no floor
was touched**: db statements/lines rose 49.55 → 54.52 across A1, then settled at **53.55** once
A1.5 added three `src/lib/studio/**` modules that the db suite does not import (they are at 100% on
the UNIT run instead). Still 6.55pp clear of a 47 floor against a 2pp policy. The upward
re-baseline that rise would justify is deliberately deferred to a single end-of-branch pass, per
`vitest.db.config.ts`'s own frozen-floors policy.

### Read this before reusing the plan

`docs/superpowers/plans/2026-08-17-a1-human-verification.md` carries a **"Defects found during
execution"** table. Three of its own snippets were wrong — including a value-vs-rank fixture that
**could not have passed under any implementation** — and two defects in the code were not predicted
(the queue had no visibility gate; a concurrent double-submit was a bare 500). One of its
prescribed injections turned out not to be evidence at all, which is the plan's own "a malformed
break is not evidence" rule catching the plan.

**31 injections were run and observed** across the seven tasks, every file restored byte-identical
by `sha256sum -c`.

### Also here: R4 and R5, the last two L1 residuals

- **R4 — closed by DELETION.** `POST …/samples`' ownership select read `_count.samples` that nothing
  consumed, carried with a comment warning the next reader not to filter it. A comment is the wrong
  guard, and it was the only one available: **no behavioural test can protect a value nobody reads**,
  so the warning could have gone stale with the suite green. The read is gone; its one load-bearing
  fact moved to the `nextSampleIndex` call site, which is the only code that depends on it. **No new
  test** — adding one would mean re-introducing a read to assert against, which is the defect.
- **R5 — closed as ACCEPTED.** The pin-guard 409 is terminal, and that is now documented at
  `findGoldenSetsPinningDataset` with why it follows from two rulings that are each correct on their
  own, and what would change it. Verified rather than assumed: there is no `goldenSet.delete` or
  `deleteMany` anywhere in `src/`, `scripts/` or `prisma/`.

### And A1.5, the annotation studio (`133cc12`…`05bf29b`)

Landed straight after A1 on the same branch. A composable panel shell — prompt, options, reasoning,
output, verdict — each collapsible and re-orderable, with layout persisted to localStorage, plus
A1's labelling view as its first composition.

**The shape of it is the point.** This repo has no jsdom, so nothing in `src/components/` can be
unit-tested at all. Every rule that can be silently wrong therefore lives in `src/lib/studio/**`,
which both coverage configs measure and which sits at **100% statements**: span segmentation and
its normalization contract, the word diff, and layout reconciliation against untrusted persisted
state. `reconcile` never throws for any input — a studio that white-screens on a year-old
localStorage entry is a bug the user cannot diagnose and can only fix by clearing site data.

`docs/runbooks/studio-manual-verification.md` is the substitute for the tests the component layer
cannot have. **All 12 rows were walked in a real browser** against `npm run dev` and local
Postgres, and row 7 caught a defect that no unit test could have: the progression rail reported
"not started" on a set whose only item had just been labelled, directly above the message saying
so. Fixed and re-walked.

Row 12 is the one that matters, and was checked at the network level: six readings driven through a
3-item set with `retestIntervalItems: 0` so every item was served twice, first and second servings
compared — identical key sets, no `round`, no prior score, no `expected`.

Five of the plan's prescribed injections proved nothing until the fixtures behind them were fixed;
each is recorded in that plan's own "Defects found during execution" table.

### Not in this PR
- **A2**, still hard-gated on rebaseline **T5**: RabbitMQ sits at 54.5% of its publisher-blocking
  watermark at idle with zero VMServiceScrapes and zero VMRules covering it.
- The deploy + seed of the built image; `reasoning_content` capture (preflight Stage 5); roadmap
  decisions #4 (perturbation set) and #7 (PPI config).
