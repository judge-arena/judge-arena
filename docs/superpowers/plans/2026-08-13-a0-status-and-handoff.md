# A0 status and handoff

**Date:** 2026-08-13 · **Branch:** `feat/a0-golden-set-substrate` · **Worktree:** `/root/judge-arena-worktrees/a0`
**Branch base:** `7306c2f` (`gitea/main`) · **Nothing merged, nothing pushed.**

Read this first, then the plan (`2026-08-12-a0-golden-set-substrate.md`) and the design
(`../specs/2026-08-12-a0-golden-set-substrate-design.md`). The session-recovery ledger lives at
`.superpowers/sdd/2026-08-12-a0-golden-set-substrate/progress.md` — it is git-ignored and holds
per-task detail, every deferred minor, and every ruling with its reasoning.

---

## Where it stands

**11 of 22 planned tasks complete**, plus 2 corrective tasks newly added (23–24, below). 21 commits,
40 files, +17,524/−45 against the branch base.

Verified by running the suites directly on 2026-08-12 20:03, not taken from implementer reports:

```
npm test              34 files, 456 tests   green    (branch base: 367)
npm run test:db       33 files, 388 tests   green    (branch base: 299)
npm run test:coverage exit 0
    src/lib/llm       94.50 / 86.60 / 97.56 / 94.50   floor 90 / 80 / 94 / 90
    all files         37.57 / 84.84 / 67.18 / 37.57   floor 33 / 81 / 63 / 33
```

**Production is untouched.** `judge-arena-pg` still reports 13 applied migrations and has no
`GoldenCandidate` table. Every migration in this branch has been applied only to the local dev and
test databases.

### Landed

| Tasks | What |
|---|---|
| 1–4 | Schema + library: the `v2d` migration, `mapSampleToGoldenItem`, `isGoldenSetFrozen`, `forkGoldenSet` |
| 5–9 | The whole HTTP surface: scopes, `shared.ts`, list/create-by-import, detail, items, fork, retire, access-matrix registration |
| 10–11 | Half the pairwise execution path: verdict schema, parser, renderer, provider plumbing, `executePairwise` |

### Remaining, in order

| Task | What | Notes |
|---|---|---|
| 12 | Unhardcode protocol | `run-launch.ts:172,302,468`, `publish.ts:56`, worker consumers |
| 13 | `v1-pairwise` template + pairwise run end to end | |
| 23 | **`datasetId` immutable** | NEW — owner ruling, see below. Do before 14. |
| 24 | **Items tombstoned, never deleted** | NEW — owner ruling. Needs a `v2e` migration. Do before 14. |
| 14–15 | Config export/import + round-trip `COVERAGE` | 15 extends the cherry-picked fidelity test |
| 16–17 | UI: list page + detail page | Manual verification only — there is no UI test harness |
| 18–22 | Tombstone on account deletion + the lifecycle read filters | 24 changes what 21 must cover |

**Resume at Task 12.** BASE for its review package is `4da7646`.

---

## Owner rulings, 2026-08-13

Three rulings were made after Task 11. Two contradict landed code and become Tasks 23 and 24;
the third is a future spec.

### 1. `GoldenSet.datasetId` is immutable, always

> *"I approve of having datasetIds be immutable: a new record becomes a new dataset."*

Not "frozen once calibrated" — **immutable, unconditionally**. A golden set is the annotation layer
over exactly one dataset, so repointing it is never legitimate; you create a new set or fork.

**What is wrong today:** `updateGoldenSetSchema` (`src/app/api/golden-sets/shared.ts:65`) accepts
`datasetId`, and `PATCH /api/golden-sets/[id]` (`src/app/api/golden-sets/[id]/route.ts:95`) treats it
as freeze-guarded *content*, so it is mutable on any set with no `CalibrationRun`. That lets a set
claim to annotate corpus B while its items still carry `sourceDatasetSampleId` values from corpus A.

**→ Task 23.**

### 2. Delete is always a same-transaction tombstone; no data is ever removed

> *"Delete should be same-transaction tombstone tag, no actual data removal."*

Rationale on the record: hard deletion may lose data, and there are no existing users, so nothing
justifies destruction.

**Already compliant:** `DELETE /api/golden-sets/[id]` writes `tombstonedAt` and never calls
`.delete()` (Task 7). Task 18's account-deletion design already tombstones.

**What is wrong today:** `DELETE /api/golden-sets/[id]/items`
(`src/app/api/golden-sets/[id]/items/route.ts:211`) hard-deletes items and then re-indexes the
survivors 0..n-1. `GoldenItem` has **no `tombstonedAt` column**, so this needs a `v2e` migration.

Two consequences worth stating before anyone starts:

- **The re-index becomes wrong, not just unnecessary.** A tombstoned row keeps its `index`, so
  `@@unique([goldenSetId, index])` stays satisfied without re-packing. The loop must be deleted, not
  adapted.
- **The label-drop-on-edit at `items/route.ts:142` also hard-deletes.** It removes `GoldenLabel` rows
  when an item's content changes. Under this ruling that should tombstone instead — and it is the
  most important case, because a human label is the expensive, irreplaceable artifact the whole
  roadmap exists to protect, and preserving the row preserves who said what about which version of
  the text. **This is my reading of the ruling, not something the owner said explicitly. Confirm
  before implementing.**

**→ Task 24.**

### 3. Staged datasets, with an immutable identity on publication

> *"I would like the idea of a 'staged' or work in progress dataset, but once it gets published it
> receives an immutable identity."*

A want, not a task. It is a draft → published lifecycle for `Dataset`, and it is **out of A0's
scope** — but note the substrate is partly there already: `Dataset.publishedAt` exists and has zero
writers, as do `Project.publishedAt`, `Rubric.publishedAt` and `GoldenSet.publishedAt`. There is no
publish endpoint anywhere in the codebase, so whoever designs this invents the verb for all four.

It interacts with A0 directly: if a dataset can be edited while staged and freezes on publication,
then A0's `PUT /api/datasets/[id]/samples` 409 guard (which currently fires whenever *any* golden set
annotates the dataset) becomes a special case of a more general rule.

**→ Needs its own spec.** Recorded in the follow-on list below.

---

## Follow-on documents this phase owes

1. **A UI/UX roadmap** — human judging surfaces, entering more data, running custom rubrics and
   prompt variations. Requested 2026-08-12. Not started.
2. **A staged-dataset spec** — ruling 3 above.
3. **The `BA` permutation sweep and its side-by-side report** — an A2 dependency. Needs no migration
   and no backfill, because `pairOrder` is written explicitly on every judgment (`'AB'` for pairwise,
   `null` for pointwise) rather than left NULL.

---

## Standing decisions that bind the remaining work

**Coverage floors are frozen for the rest of A0.** The plan's Global Constraints say "re-baseline
upward"; Tasks 10 and 11 instead moved only the "Actuals as of" comments. That is now the branch-wide
rule. Per-task ratcheting in a 22-task chain turns a regression backstop into a moving target that a
later task trips through no fault of its own, and the usual fix for that is someone editing the number
to go green — which destroys the gate the policy exists to protect.

**A one-time deliberate re-baseline of all floors, with every glob visible at once, is owed at the end
of the branch.** Do not drop it.

**A0 emits one pair order.** `pairOrder` is `'AB'` for pairwise and `null` for pointwise — the unique
index is `NULLS NOT DISTINCT`, so that null is load-bearing. The `BA` sweep is A2's.

**Verdicts are stored raw.** Whatever the model said (`'A' | 'B' | 'tie'`), against the order it was
shown. Nothing normalises or un-permutes at the storage layer, because position bias is computed later
by comparing the two orders.

---

## Repo quirks that cost time to rediscover

- **`npm run test:db -- <file>` does not scope the run.** `test:db` is an `sh -c '...'` wrapper, so
  args after `--` become positional parameters to `sh` and are silently dropped — every invocation
  runs the full suite. Use `npx vitest run --config vitest.db.config.ts <file> -t <pattern>`.
- **`npm run test:db` runs `prisma migrate reset --force --skip-seed` first**, replaying only
  *committed* migrations. A schema edit without a committed migration runs the whole suite against the
  old schema and surfaces as a confusing P2022.
- **A fresh worktree needs the v1 Prisma client generated separately**:
  `npx prisma generate --schema prisma/v1/schema.v1.prisma`. Without it four test files fail to *load*
  with "Cannot find package '@prisma/v1-client'", which reads like a broken test rather than a missing
  build step.
- **`src/app/api/**` is outside every coverage `include`.** Logic placed in a route is invisible to the
  gate; logic in `src/lib/**` is measured by both suites.
- **`requireScope` short-circuits under session auth** (`src/lib/auth-guard.ts:201`) because
  `session.apiKeyScopes` is undefined. A scope check tested only through a mocked session proves
  nothing — it needs a developer API key whose owner is also the resource owner, so ownership would
  otherwise pass and only the scope can refuse.

---

## Findings about code outside A0

Recorded because they were found by working carefully, and they will not be found again by accident.

- **`PUT /api/datasets/[id]/samples` re-indexes non-atomically.** It deletes outside any transaction
  and re-indexes in a separate one, so an interrupted request can leave a dataset's samples with a
  gapped index sequence. A0's golden-items route does both in one transaction; the pattern it was
  copied from does not.
- **No `:write` scope is API-key-tested anywhere** in `tests/db/access-matrix.test.ts` —
  `rubrics:write`, `datasets:write`, `projects:write`, `models:write`, `evaluations:write` and
  `config:write` all share the gap that Task 9 closed for `golden-sets:write`.
- **No referenced-by write guard exists for rubrics.** `PATCH /api/rubrics/[id]` deletes and recreates
  criteria behind an ownership check only, so a rubric pinned by a finished run can be rewritten. A0
  wrote the codebase's first such guard; the rubric surface still carries the defect.

---

## Prerequisite that is still outstanding

`tests/db/config-roundtrip-fidelity.test.ts` was **cherry-picked** onto this branch as `76d7d4a`,
because the plan's step 0 ("land `d2c3f3b` as its own PR first") is a merge, and merging was ruled out
for that session. Task 15 extends that file and cannot run without it.

When the prerequisite PR does land on `main`, git will recognise the duplicate patch and drop it on
rebase, so the cherry-pick costs nothing. **But the PR has not been opened.** Either open it, or accept
that the fidelity test reaches `main` as part of the A0 branch rather than ahead of it.
