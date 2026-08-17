# Plan L1 — The Tombstone Overlay Implementation Plan

> **Renamed 2026-08-16 from "Plan A1", after execution.** The lifecycle plans are now `L1`/`L2`,
> leaving `A0…A5` to `specs/2026-08-10-judge-training-engine-roadmap.md`. **This body was not
> swept**, deliberately: most of its "A1" mentions are inside prescribed source text that the
> implementation really does carry — the `MUST NOT BE TOMBSTONE-FILTERED (A1)` markers, the `(A1)`
> comments in `src/`, the `feat(a1):` commit prefixes, and the header of the **applied**
> `20260814120000_v2f_tombstone_overlay` migration, which Prisma checksums and which therefore can
> never be edited. Rewriting the prose here would desynchronise the plan from the code it produced.
> Read "A1" in this document as L1. One string is not a label at all and must stay verbatim: the
> consent id `approved-plan-2026-08-14-a1-tombstone-overlay` at Task 1.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make deleting a dataset or a dataset sample *hide* it rather than destroy it, so an annotated corpus can shed a bad row without breaking the annotations that reference it.

**Architecture:** A single `Tombstone` table carries per-entity foreign keys (`datasetSampleId`, `datasetId`), one row per entity, enforced by `@unique` on each column and a hand-edited `CHECK` guaranteeing exactly one is non-null. Two shared relation-filter helpers compile to `NOT EXISTS` and are spread into every read site; a small set of reads must stay *unfiltered* because filtering them raises `P2002` on a write. Ordinals stop being dense, so appends move to a high-water mark and the re-index loop is deleted.

**Tech Stack:** Next.js 15 (app router, `params` as a Promise), Prisma 6.19.2 + PostgreSQL 16, zod, vitest (unit / db / integration).

**Spec:** `docs/superpowers/specs/2026-08-14-dataset-lifecycle-and-tombstone-overlay-design.md` — read it before Task 1. Every `file:line` in this plan was verified against the tree at `af58c96`.

**Follows:** A0 (`feat/a0-golden-set-substrate`). **Precedes:** Plan L2 (the revision log, `2026-08-14-l2-revision-log.md`) and Plan B (the lifecycle).

## Global Constraints

- **Migration directory:** `prisma/migrations/20260814120000_v2f_tombstone_overlay/`. Authored via `prisma migrate diff` per `CONTRIBUTING.md:407-443`, with a prose header naming the phase and **every hand edit**. **Never `prisma db push`.**
- **The `CHECK` constraint is a hand edit** and Prisma cannot express it, so it is invisible to `migrate diff`/`db pull`/`db push` and **earns a fifth row in `CONTRIBUTING.md`'s pseudo-drift table**. Follow the shape of the four already there.
- **`npm run test:db` runs `prisma migrate reset --force --skip-seed`,** replaying only *committed* migrations. A schema edit without a committed migration runs the whole suite against the old schema and surfaces as a confusing `P2022`.
- **Never lower a coverage floor.** Floors were deliberately re-baselined at `0a17722` to sit 2pp (aggregate) / 3pp (per-glob) below actuals per the policy at `vitest.db.config.ts:42-73`. If actuals move, update only the "Actuals as of" prose. Note the DB suite's coverage jitters ±2 branches run-to-run with no code change — measure more than once if you land near a floor.
- **`src/app/api/**` is outside every coverage `include`; `src/lib/**` is measured by both suites.** That is why the helpers live in `src/lib/tombstones.ts` and routes stay thin.
- **`requireScope` is mandatory on every route**, and `optionalAuth()` throws, so it goes *inside* the `try` with `if (error instanceof RateLimitedError) return error.response;` first in the `catch`.
- **Any new unawaited write must be wrapped in `trackBackgroundWrite`** (`src/lib/background-writes.ts`), or it reintroduces a 40P01 TRUNCATE deadlock that reproduces only on the second CI run.
- **Boolean query flags are strict `=== 'true'`.** `?flag=1` is false everywhere; this trap shipped twice during A0.
- **The DB suite shares a finite 120/min Redis rate-limit budget.** Route-driving tests consume it globally and can intermittently fail *other* files. Use the established `vi.mock('@/lib/rate-limit-redis')` fake at `tests/db/access-matrix.test.ts:94-100`.
- **Test placement:** `tests/db/<topic>.test.ts` — plain `.test.ts`. `.db.test.ts` is reserved for `tests/importer/**`.
- **Suite state you must not regress:** unit **476** (34 files), db **444** (35 files), integration **80** (10 files) — the state *before Task 1*. Each task keeps all three green, and tasks that break an existing test fix it *in the same task*, never in a later one.
- **Do not assert an absolute suite count in any task.** Almost every task adds cases, so a number computed against the pre-Task-1 baseline is wrong for every task after the first, and an implementer reading it sees a false failure. The contract each task verifies is: **zero failures, and no fewer tests than the previous task left.** Record the actual number you observe in your report so the next task has a real baseline.
- **Local Postgres** is the podman container `judge-arena-pg` on `localhost:5432`. **Real production is the Kubernetes pod `judge-arena-pg-1` in namespace `tenant-public` and must never be touched.** The names are confusingly similar; if unsure which database a command hits, stop and ask.
- **Demonstrate discrimination, do not assert it.** For every load-bearing assertion, break the thing under test, observe the specific failure, restore, confirm byte-identical by sha256, and put that evidence in the report.

---

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `prisma/migrations/20260814120000_v2f_tombstone_overlay/migration.sql` | The one migration. Includes the hand-edited `CHECK`. |
| `src/lib/tombstones.ts` | The two read filters and the write helpers. The single definition of "hidden". |
| `tests/lib/tombstones.test.ts` | Unit tests for the filters' returned shape and the writers' payloads. |
| `tests/db/dataset-sample-tombstone.test.ts` | Tasks 3–6: the verbs. Hide, un-hide, converge, ordinals. |
| `tests/db/dataset-read-sweep.test.ts` | Tasks 7–10: the guards and the two read sweeps. |

**One test file per area, not one for the plan.** An earlier draft of this structure named a single DB test file and every task appended to it — which across twelve independent implementers means duplicate `vi.mock` of the same module, duplicate helper names, and duplicate route imports, any one of which stops the file compiling. Tasks 11 and 12 append to the existing files that already own their fixtures (`tests/db/config-golden-sets.test.ts`, `tests/db/golden-set-import.test.ts`) rather than creating a third.

**Modified**

| File | Change |
|---|---|
| `prisma/schema.prisma` | `Tombstone` model; `tombstone Tombstone?` back-relations on `Dataset` and `DatasetSample`. |
| `CONTRIBUTING.md` | Fifth pseudo-drift row for the `CHECK`; the count sentence. |
| `src/app/api/datasets/[id]/samples/route.ts` | All four verbs: POST high-water, PATCH lookup filter, DELETE tombstone + kill re-index, PUT tombstone-and-append + filtered response. |
| `src/app/api/datasets/[id]/route.ts` | `DELETE` (**`:165`**, not `:143` — `:141-142` is `requireOwnership` and `:144-163` is A0's pin guard) becomes a tombstone; `GET` reads filtered; **PATCH's and DELETE's `requireOwnership('dataset', …)` guards filter** (see below). |
| `tests/db/config-golden-sets.test.ts` | `:867` row assertion updated (Task 11); Task 12's importer cases. |
| `tests/db/golden-set-import.test.ts` | Task 12's two `limit` cases and the rate-limit fake. |
| `tests/lib/golden-set-schemas.test.ts` | Task 12's `limit`/`sampleIndices` mutual-exclusion case. |
| `src/app/api/datasets/route.ts` | List read + pagination `count` filtered; slug-dedup read left unfiltered with a comment. |
| `src/app/api/config/import/route.ts` | Sample replace becomes tombstone-and-append; `_count` read filtered. |
| `src/app/api/config/export/route.ts` | Dataset loop and nested `samples` include filtered. |
| `src/app/api/golden-sets/route.ts` | Sample read filtered; new `limit` param meaning "first N live". |
| `src/app/golden-sets/page.tsx` | Sends `limit` instead of synthesising contiguous `sampleIndices`. |
| `src/app/api/evaluations/route.ts` | Batch sample read filtered; slug-dedup read left unfiltered. |
| `src/app/api/projects/[id]/route.ts` | **Both** dataset reads filtered (`:70` anonymous, `:162` owner). |
| `src/app/api/datasets/[id]/versions/route.ts` | Child-copy read filtered; version list filtered. |
| `src/lib/dataset-versions.ts` | Slug-dedup and version high-water reads left unfiltered, with comments. |
| `src/app/api/datasets/[id]/refresh/route.ts` | `_count` reads filtered. |
| `src/app/api/stats/route.ts`, `src/app/api/datasets/[id]/export/route.ts`, `src/app/api/projects/[id]/export/route.ts` | Reads filtered. |
| `tests/db/dataset-sample-freeze.test.ts` | Three unpinned happy-path halves updated (`:136`, `:238`, `:275`). |
| `tests/db/config-golden-sets.test.ts` | `:867` row assertion updated. |
| `tests/db/config-roundtrip-fidelity.test.ts` | `COVERAGE` gains `Tombstone`; the gap ledger at `:577-585` updated if a gap is recorded. |

---

## The interface contract

Every task below consumes these names. They are defined once, in Task 2, and no task may rename or re-shape them.

```ts
// src/lib/tombstones.ts

/** Live samples: not hidden, and not owned by a hidden dataset. */
export function liveSamplesOnly(): Prisma.DatasetSampleWhereInput;

/** Live datasets: not hidden. */
export function liveDatasetsOnly(): Prisma.DatasetWhereInput;

/** Hide one sample. Idempotent: never P2002, always converges on hidden. */
export function tombstoneSample(
  tx: Prisma.TransactionClient,
  datasetSampleId: string,
  reason?: string
): Promise<void>;

/** Hide many samples in one statement. Same convergence property. */
export function tombstoneSamples(
  tx: Prisma.TransactionClient,
  datasetSampleIds: string[],
  reason?: string
): Promise<number>;

/** Hide one dataset. */
export function tombstoneDataset(
  tx: Prisma.TransactionClient,
  datasetId: string,
  reason?: string
): Promise<void>;

/** Un-hide one sample: flips isTombstone to false and clears reason. */
export function restoreSample(
  tx: Prisma.TransactionClient,
  datasetSampleId: string
): Promise<void>;

/**
 * The high-water mark for a dataset's sample ordinals:
 * max(index) over ALL rows including hidden, + 1. Never count().
 * MUST be called with the same tx as the inserts it feeds.
 */
export function nextSampleIndex(
  tx: Prisma.TransactionClient,
  datasetId: string
): Promise<number>;
```

---

## Task list

| Task | Deliverable |
|---|---|
| 1 | `Tombstone` model, the `v2f` migration with its hand-edited `CHECK`, the `CONTRIBUTING.md` drift row, and the `COVERAGE` map entry. |
| 2 | `src/lib/tombstones.ts` — both filters, both writers, `nextSampleIndex` — with unit tests pinning the returned shapes. |
| 3 | `DELETE /api/datasets/[id]/samples` tombstones, the re-index loop is deleted, `sampleCount` becomes live. Fixes `dataset-sample-freeze.test.ts:238`. |
| 4 | `POST /api/datasets/[id]/samples` appends above the high-water mark inside one transaction; `sampleCount` becomes live. |
| 5 | `PUT /api/datasets/[id]/samples` tombstones-and-appends and filters its response read at `:343`. Fixes `dataset-sample-freeze.test.ts:136`. |
| 6 | `DELETE /api/datasets/[id]` tombstones the dataset. Fixes `dataset-sample-freeze.test.ts:275`. |
| 7 | Every mutation handler's dataset guard read filters, so a hidden dataset is closed to writes — **including the two `requireOwnership('dataset', …)` call sites in `datasets/[id]/route.ts` (PATCH `:93`, DELETE `:141`) and the config importer's post-resolution check.** See "Two Decision-15 holes" below. |
| 8 | The sample read sweep — every filtered site, and the two deliberate exceptions with their comments. |
| 9 | The dataset read sweep, plus the `P2002` must-not-filter class with its comments. |
| 10 | The `_count.samples` sweep across all six producers. |
| 11 | The config importer's sample replace becomes tombstone-and-append. Fixes `config-golden-sets.test.ts:867`. |
| 12 | `POST /api/golden-sets` accepts `limit` meaning "first N *live* samples"; the client sends it instead of synthesising ordinals. |

---

## Two Decision-15 holes the task list would otherwise leave open

Both were found by drafting, not by reading, and both let a **hidden dataset still be written to** — which is exactly what Decision 15 forbids.

**1. `requireOwnership('dataset', …)` reads unfiltered.** It is the shared helper at `src/lib/auth-guard.ts:400-417`, used by `datasets/[id]/route.ts`'s PATCH (`:93`) and DELETE (`:141`). Task 7's enumeration came from the spec's mutating-verbs list, which names the *handlers'* own dataset reads and misses this one. So without a fix, a hidden dataset stays PATCHable — you can rename and re-tag a corpus you have deleted.

**Do not change `requireOwnership` itself** — it is shared with every other resource type and A0's access-matrix tests pin its behaviour across eight of them. Task 7 adds an explicit post-ownership liveness check in the two dataset handlers instead, in the same shape as A0's `assertGoldenSetInCirculation`.

**2. The config importer can reach a hidden dataset by slug.** Its upsert-by-slug lookup at `config/import/route.ts:453` is in the `P2002` must-not-filter class and therefore *must* keep resolving hidden rows — otherwise a re-import mints a duplicate slug. But nothing then stops it updating that row and replacing its samples.

The consequence is worse than it first reads: `liveSamplesOnly()` carries a `dataset:` clause, so on a hidden dataset the filtered `_count.samples` reports **0** while the stored `sampleCount` keeps its old value — so the importer's diff reports `0 → N` and triggers a replace that appends live rows under a hidden parent.

**Ruling:** the importer resolves the row (unfiltered, as it must) and then **skips it with a `changes` entry naming the dataset as deleted**, rather than updating it. Task 11 owns this. A skip is right rather than a 409 because the importer processes many entities and already reports per-entity outcomes; aborting a whole import over one deleted dataset would be disproportionate.

---

### Task 1: The `Tombstone` model, the `v2f` migration with its hand-edited `CHECK`, the `CONTRIBUTING.md` drift row, and the `COVERAGE` entry

**Files:**
- Modify: `prisma/schema.prisma:588-590` (the `Dataset` relations block — `samples` / `evaluations` / `goldenSets`)
- Modify: `prisma/schema.prisma:613-615` (the `DatasetSample` relations block — `evaluations` / `goldenItems` / `createdAt`)
- Modify: `prisma/schema.prisma:817` (append the `Tombstone` model at end of file, after `model CalibrationRun`)
- Create: `prisma/migrations/20260814120000_v2f_tombstone_overlay/migration.sql`
- Modify: `CONTRIBUTING.md:460-468` (the "Currently four cases" sentence and the pseudo-drift table)
- Test: `tests/db/config-roundtrip-fidelity.test.ts:509` (new `Tombstone` entry in the `COVERAGE` map, inserted before its closing `};` at `:510`)

**Interfaces:**
- Consumes: nothing. This is the first task on the branch.
- Produces:
  - Prisma model `Tombstone` — scalar columns `id: String`, `datasetSampleId: String?` (`@unique`), `datasetId: String?` (`@unique`), `isTombstone: Boolean @default(true)`, `reason: String?`, `createdAt: DateTime`, `updatedAt: DateTime`; relation fields `datasetSample: DatasetSample?`, `dataset: Dataset?`
  - Prisma client delegate `tx.tombstone` (`upsert` / `updateMany` / `createMany` / `findUnique`), and the generated types `Prisma.TombstoneWhereInput`, `Prisma.TombstoneWhereUniqueInput`
  - `Dataset.tombstone: Tombstone?` and `DatasetSample.tombstone: Tombstone?` back-relations — these are what make `{ tombstone: { is: { isTombstone: true } } }` a legal `where` fragment on both models
  - Migration directory `prisma/migrations/20260814120000_v2f_tombstone_overlay/`
  - Database constraint `Tombstone_exactly_one_entity`

---

- [ ] **Step 1: Write the failing test — add `Tombstone` to the `COVERAGE` map**

The fidelity suite iterates `Object.entries(COVERAGE)` and never the datamodel, so a model absent from the map is simply unchecked. Adding the entry *first* is what makes this task test-driven at all: the entry names a model that does not exist yet, and the suite says so.

Open `tests/db/config-roundtrip-fidelity.test.ts`. The `COVERAGE` object ends at `:509` with `  },` (closing `GoldenLabel`) followed by `};` at `:510`. Insert this block between them:

```ts
  // Listed with an EMPTY `exported` array, like GoldenLabel above, and for a
  // related reason: a Tombstone records that a Dataset or DatasetSample is
  // HIDDEN on this instance, and the exporter never sees a hidden row in the
  // first place — the dataset loop and the nested `samples` include both
  // filter. The document therefore represents a tombstone by ABSENCE, which
  // is the correct portable form: carrying the row would let a re-import hide
  // rows on another instance that its owner there never deleted.
  //
  // This is deliberately NOT a knownGap. `knownGaps` means "should round-trip
  // and does not yet"; nothing on this model should round-trip. Recording one
  // here would also fail the gap ledger below, whose expected object is
  // locked to exactly {Rubric, Dataset, GoldenSet} — and that lock is
  // correct, so the entry is shaped to leave it alone rather than to edit it.
  Tombstone: {
    exported: [],
    excludedByDesign: {
      id: SURROGATE,
      datasetSampleId:
        'the hidden sample is absent from the document entirely (the nested `samples` include is filtered), so there is nothing on the other side for this FK to point at — and a DatasetSample id is instance-local regardless, the same argument as GoldenItem.sourceDatasetSampleId',
      datasetId:
        'same as datasetSampleId one column up: a hidden dataset is filtered out of the export loop, so the document carries no dataset for this FK to name',
      isTombstone:
        'the hide/un-hide flag itself. Instance-local curation state in the same register as GoldenItem.tombstonedAt: a row hidden HERE must not arrive hidden on another instance, and a re-import must neither resurrect nor re-bury anything. Absence from the document IS the representation.',
      reason:
        'free-text audit of WHY a row was hidden on THIS instance — same argument as GoldenLabel.tombstonedReason. Carrying it would misattribute a deletion that happened here to an import that happened elsewhere.',
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
    },
    knownGaps: {},
  },
```

Note the seven keys are exactly the model's seven scalar columns. The suite's stale-key guard filters `f.kind === 'scalar' || f.kind === 'enum'`, so the two relation fields (`datasetSample`, `dataset`) are correctly absent — listing either would fail that guard.

- [ ] **Step 2: Run it and watch it fail**

Run:

```bash
sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.db.config.ts tests/db/config-roundtrip-fidelity.test.ts -t "Tombstone: every column is classified"'
```

Expected: FAIL with

```
AssertionError: Tombstone is not in the Prisma datamodel: expected undefined not to be undefined
```

That is the `expect(model, `${modelName} is not in the Prisma datamodel`).toBeDefined()` line firing. The failure is real, not a typo: `Prisma.dmmf.datamodel.models` comes from the generated client, and there is no `Tombstone` in it yet.

- [ ] **Step 3: Add the model and the two back-relations to `prisma/schema.prisma`**

First the back-relations. Replace `prisma/schema.prisma:588-590`:

```prisma
  samples     DatasetSample[]
  evaluations Evaluation[]
  goldenSets  GoldenSet[]
```

with:

```prisma
  samples     DatasetSample[]
  evaluations Evaluation[]
  goldenSets  GoldenSet[]
  tombstone   Tombstone?
```

Then replace `prisma/schema.prisma:613-615`:

```prisma
  evaluations Evaluation[]
  goldenItems GoldenItem[]
  createdAt   DateTime     @default(now())
```

with:

```prisma
  evaluations Evaluation[]
  goldenItems GoldenItem[]
  tombstone   Tombstone?
  createdAt   DateTime     @default(now())
```

Then append at the end of the file (after `model CalibrationRun`'s closing brace at `:817`):

```prisma

// ─── The tombstone overlay (A1) ─────────────────────────────────────────────
// One row per HIDDEN entity. "No row" means live, so this table is empty until
// something is deleted. Adopted by both Dataset and DatasetSample; a sample
// inherits its parent dataset's hidden state through the read filter in
// src/lib/tombstones.ts, never through a second row here.
//
// Deliberately NOT A0's `tombstonedAt` column form (GoldenSet, GoldenItem,
// GoldenLabel). Those are one-way on purpose: goldenSetLifecycleWhere pins
// `tombstonedAt: null` in BOTH arms so a tombstoned set has no way back. This
// overlay is REVERSIBLE — un-hiding flips the flag rather than deleting the
// row, so createdAt/updatedAt still record that the entity was once hidden.
// Two mechanisms with different capabilities, coexisting on purpose. Do not
// harmonise them.

model Tombstone {
  id String @id @default(cuid())

  // Exactly one of these is non-null. That is a REAL constraint, not a
  // comment: `Tombstone_exactly_one_entity`, a CHECK hand-edited into
  // 20260814120000_v2f_tombstone_overlay because Prisma's DSL cannot express
  // a CHECK at all. Without it Postgres accepts both-null orphans (a
  // tombstone hiding nothing) and both-set rows (one row claiming to hide a
  // dataset AND a sample), because a unique index permits unlimited NULLs.
  // See CONTRIBUTING.md's "Known migrate-diff pseudo-drift" table.
  //
  // Each FK is @unique so the relation is to-ONE. That is what makes `upsert`
  // correct and what makes `{ tombstone: { is: ... } }` match at most one row
  // per entity. No @@index on either column: @unique already creates one.
  //
  // No @relation("name") on either side. Prisma demands a named relation only
  // when TWO relations connect the SAME PAIR of models; these connect
  // Tombstone↔DatasetSample and Tombstone↔Dataset — different pairs — so the
  // disambiguation is not required and adding it would only add a name to
  // keep in sync. Confirmed with `prisma validate` before landing.
  datasetSampleId String?        @unique
  datasetSample   DatasetSample? @relation(fields: [datasetSampleId], references: [id], onDelete: Cascade)
  datasetId       String?        @unique
  dataset         Dataset?       @relation(fields: [datasetId], references: [id], onDelete: Cascade)

  // Defaults to true because the only code that INSERTs here is a delete; a
  // restore UPDATEs an existing row rather than creating one.
  isTombstone Boolean @default(true)
  reason      String?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}
```

- [ ] **Step 4: Regenerate the Prisma client**

Run:

```bash
DATABASE_URL="postgresql://judge_arena:password@localhost:5432/judge_arena" npx prisma generate
```

Expected: `✔ Generated Prisma Client (v6.19.2) to ./node_modules/@prisma/client`. If it errors with `Error validating: ...` on an ambiguous relation, the model above was mistyped — the two relations connect different model pairs and need no `@relation("name")`.

- [ ] **Step 5: Author the migration**

Generate the body per `CONTRIBUTING.md:407-443`:

```bash
mkdir -p prisma/migrations/20260814120000_v2f_tombstone_overlay
npx prisma migrate diff \
  --from-url "postgresql://judge_arena:password@localhost:5432/judge_arena" \
  --to-schema-datamodel prisma/schema.prisma --script
```

It emits exactly the five statements below. Write `prisma/migrations/20260814120000_v2f_tombstone_overlay/migration.sql` as this file — generated body verbatim, prose header and the sixth `ALTER TABLE` hand-added:

```sql
-- v2f: deletion becomes a TOMBSTONE OVERLAY for Dataset and DatasetSample.
-- Plan A1, first task; design doc docs/superpowers/specs/
-- 2026-08-14-dataset-lifecycle-and-tombstone-overlay-design.md (decisions 1,
-- 2, 16, 17). DELETE on a dataset or a sample must HIDE the row, so an
-- annotated corpus can shed a bad row without breaking the annotations that
-- reference it: GoldenItem.sourceDatasetSampleId is `onDelete: Restrict`, so
-- a hard delete either fails outright or takes the annotation with it.
--
-- Body below generated verbatim by:
--   npx prisma migrate diff \
--     --from-url "$DATABASE_URL" \
--     --to-schema-datamodel prisma/schema.prisma --script
-- ...with ONE hand edit, marked HAND-EDITED at its own block at the bottom of
-- this file: the `Tombstone_exactly_one_entity` CHECK. Nothing else here is
-- hand-written.
--
-- ── ONE TABLE, PER-ENTITY FK COLUMNS, NOT A POLYMORPHIC KEY ────────────────
-- An (entityType, entityId) pair cannot carry a Prisma relation, and without
-- a relation the read filters cannot compile to a join — NOT EXISTS is the
-- entire point of the overlay (src/lib/tombstones.ts). Two nullable FK
-- columns keep it one table AND keep relation filters.
--
-- ── WHY THE CHECK IS NOT OPTIONAL ──────────────────────────────────────────
-- Postgres permits unlimited NULLs in a unique index, so the two @unique
-- columns ALONE accept BOTH-NULL orphans (a tombstone hiding nothing) and
-- BOTH-SET rows (one row hiding a dataset and a sample at once). Prisma's
-- schema DSL has no syntax for a CHECK constraint of any kind — no attribute,
-- no @@check, no escape hatch — so prisma/schema.prisma can only say "both
-- optional, both unique" and THIS FILE IS THE ONLY RECORD of the real
-- invariant. A fifth row is added to CONTRIBUTING.md's "Known migrate-diff
-- pseudo-drift" table in this same commit. Verified before landing:
-- `migrate diff --from-url ... --to-schema-datamodel` against a database with
-- this migration applied reports `-- This is an empty migration.`
--
-- ── isTombstone IS A BOOLEAN, AND THE ROW IS NEVER DELETED ─────────────────
-- This overlay is REVERSIBLE by design (restoreSample), which is exactly how
-- it differs from A0's `tombstonedAt` columns on GoldenSet/GoldenItem/
-- GoldenLabel — goldenSetLifecycleWhere pins `tombstonedAt: null` in BOTH
-- arms precisely so there is no way back. The two mechanisms coexist on
-- purpose and must not be harmonised. Un-hiding flips the flag rather than
-- deleting the row, so createdAt/updatedAt still record that the entity was
-- once hidden, and A2's `restore` revision has a row to point at.
--
-- ── NO BACKFILL ────────────────────────────────────────────────────────────
-- The table is created empty and stays empty until something is deleted:
-- "no Tombstone row" means live, which is what every existing Dataset and
-- DatasetSample already is. A backfill here would hide the entire corpus.
--
-- ── ORDINALS STOP BEING DENSE ──────────────────────────────────────────────
-- @@unique([datasetId, index]) on DatasetSample is UNCHANGED and needs no
-- change: nothing is removed, so no ordinal is ever freed. The consequence,
-- stated so nobody rediscovers it as a bug: `index` is no longer dense, and
-- the next index for a dataset is max(index) over ALL rows INCLUDING HIDDEN,
-- + 1 — a high-water mark, never a count. See nextSampleIndex in
-- src/lib/tombstones.ts, and the identical argument for golden items in
-- 20260813120000_v2e_golden_item_label_tombstones.

-- CreateTable
CREATE TABLE "Tombstone" (
    "id" TEXT NOT NULL,
    "datasetSampleId" TEXT,
    "datasetId" TEXT,
    "isTombstone" BOOLEAN NOT NULL DEFAULT true,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tombstone_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Tombstone_datasetSampleId_key" ON "Tombstone"("datasetSampleId");

-- CreateIndex
CREATE UNIQUE INDEX "Tombstone_datasetId_key" ON "Tombstone"("datasetId");

-- AddForeignKey
ALTER TABLE "Tombstone" ADD CONSTRAINT "Tombstone_datasetSampleId_fkey" FOREIGN KEY ("datasetSampleId") REFERENCES "DatasetSample"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tombstone" ADD CONSTRAINT "Tombstone_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "Dataset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddCheckConstraint — HAND-EDITED: no generated counterpart exists
-- Prisma's schema engine has no internal representation of a CHECK, so
-- `migrate diff` will never produce this statement and `db pull` will never
-- read it back. Unlike the four pseudo-drift cases already in CONTRIBUTING.md
-- this is not an index at all, so nothing is left behind for introspection to
-- notice. If a future migration ever rebuilds this table, it must hand-add
-- this constraint again — nothing in the toolchain will warn.
ALTER TABLE "Tombstone" ADD CONSTRAINT "Tombstone_exactly_one_entity"
  CHECK (num_nonnulls("datasetSampleId", "datasetId") = 1);
```

- [ ] **Step 6: Apply it to the LOCAL dev database**

This is the podman container `judge-arena-pg` on `localhost:5432`. It is **not** the Kubernetes pod `judge-arena-pg-1` in namespace `tenant-public`; the names are confusingly similar and the cluster must never be touched. The URL below is `localhost` and nothing else — do not substitute.

Run:

```bash
DATABASE_URL="postgresql://judge_arena:password@localhost:5432/judge_arena" \
PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION=approved-plan-2026-08-14-a1-tombstone-overlay \
npx prisma migrate deploy
```

Expected: `Applying migration \`20260814120000_v2f_tombstone_overlay\`` then `1 migration found in prisma/migrations` / `All migrations have been successfully applied.`

- [ ] **Step 7: Drift verification — `migrate diff` must now report an empty migration**

The whole pseudo-drift claim in the header is a claim about *this command's output*. Verify it rather than assume it.

Run:

```bash
npx prisma migrate diff \
  --from-url "postgresql://judge_arena:password@localhost:5432/judge_arena" \
  --to-schema-datamodel prisma/schema.prisma --script
```

Expected: exactly one line —

```
-- This is an empty migration.
```

Any other output means `schema.prisma` and the migration disagree; fix the migration, do not fix the schema to match a bad migration, and never `prisma db push`.

- [ ] **Step 8: Prove the `CHECK` actually rejects both-null and both-set rows**

The constraint is the one thing in this task with no Prisma-level test possible — the client cannot construct a violating row through a typed API that does not model the invariant. So probe it directly. Both probes use bogus FK values on purpose: a row-level CHECK is evaluated before the FK triggers fire, so `num_nonnulls = 2` is what rejects the second row, not a missing parent.

Run:

```bash
podman exec -i judge-arena-pg psql -U judge_arena -d judge_arena \
  -c 'INSERT INTO "Tombstone" ("id","isTombstone","updatedAt") VALUES (%27probe-both-null%27, true, now());'
```

Expected: FAIL with

```
ERROR:  new row for relation "Tombstone" violates check constraint "Tombstone_exactly_one_entity"
DETAIL:  Failing row contains (probe-both-null, null, null, t, null, ...).
```

Then the both-set probe:

```bash
podman exec -i judge-arena-pg psql -U judge_arena -d judge_arena \
  -c 'INSERT INTO "Tombstone" ("id","datasetSampleId","datasetId","isTombstone","updatedAt") VALUES (%27probe-both-set%27, %27no-such-sample%27, %27no-such-dataset%27, true, now());'
```

Expected: FAIL with the same `Tombstone_exactly_one_entity` message — **not** a foreign-key error. A `violates foreign key constraint "Tombstone_datasetSampleId_fkey"` here would mean the CHECK is missing and the FK caught the row by accident.

Both statements abort, so nothing is left behind. Confirm with:

```bash
podman exec -i judge-arena-pg psql -U judge_arena -d judge_arena -tAc 'SELECT count(*) FROM "Tombstone";'
```

Expected: `0`.

- [ ] **Step 9: Run the fidelity coverage test and watch it pass**

Run:

```bash
sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.db.config.ts tests/db/config-roundtrip-fidelity.test.ts -t "Tombstone: every column is classified"'
```

Expected: `Tests 1 passed | 11 skipped (12)`.

Then confirm the two locked ledgers are undisturbed — the whole point of classifying everything as `excludedByDesign` was to leave them alone:

```bash
sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.db.config.ts tests/db/config-roundtrip-fidelity.test.ts -t "is exactly what we have"'
```

Expected: `Tests 2 passed`. If "the set of known portability gaps is exactly what we have accepted" fails, a `knownGaps` entry crept into the `Tombstone` block; remove it rather than editing the ledger at `:577-585`.

- [ ] **Step 10: Run the full DB suite**

This is the real test of the migration file rather than the schema edit: `npm run test:db` runs `prisma migrate reset --force --skip-seed` first, replaying the entire chain from scratch **including the hand-edited `CHECK`**.

Run: `npm run test:db`

Expected: `Test Files 35 passed (35)` / `Tests 445 passed (445)` — 444 before this task, plus the one new `Tombstone` coverage case. A `P2022` here means the schema was edited without the migration being committed.

- [ ] **Step 11: Add the fifth pseudo-drift row to `CONTRIBUTING.md`**

Two edits. First the count sentence at `CONTRIBUTING.md:460-461`. Replace:

```
gate would pass clean today. Currently four cases (the count was stale at
"one" while the table already listed two — corrected while landing A0):
```

with:

```
gate would pass clean today. Currently five cases (the count was stale at
"one" while the table already listed two — corrected while landing A0, and
incremented again by A1's CHECK below; keep this number in step with the
rows):
```

Then append this row to the table, after the `20260813120000_v2e_golden_item_label_tombstones` row at `:468`:

```
| `20260814120000_v2f_tombstone_overlay` | `Tombstone_exactly_one_entity`, a table `CHECK` asserting `num_nonnulls("datasetSampleId", "datasetId") = 1` — every tombstone row hides exactly one entity (A1, the tombstone overlay) | Prisma's schema DSL has no syntax for a `CHECK` constraint of any kind — no attribute, no `@@check`, no escape hatch short of raw SQL in the migration. Unlike the four rows above, this one is **not an index**, so `db pull` leaves nothing behind at all: `schema.prisma` can only say that the two FK columns are optional and `@unique`, and Postgres permits unlimited NULLs in a unique index, so without this constraint both-null orphans and both-set rows are both accepted. Re-verified empirically on Prisma 6.19.2 against a database with the migration applied: `migrate diff --from-url ... --to-schema-datamodel` reports an empty migration. The invariant is pinned by direct `INSERT` probes (see that migration's header), not by a Prisma-level test — the client cannot construct a violating row through a typed API that does not model the invariant. |
```

- [ ] **Step 12: Typecheck and lint**

Run: `npx tsc --noEmit && npm run lint`

Expected: both silent. The new client types (`Prisma.TombstoneWhereInput`, `Dataset.tombstone`) are unused so far, so nothing should move here; a failure means step 4's `prisma generate` did not run.

- [ ] **Step 13: Run the unit and integration suites**

Run: `npm test`

Expected: `Test Files 34 passed (34)` / `Tests 476 passed (476)` — unchanged, this task adds no unit test.

Run: `npm run test:integration`

Expected: `Tests 80 passed (80)` — unchanged.

- [ ] **Step 14: Commit**

```bash
git add prisma/schema.prisma \
        prisma/migrations/20260814120000_v2f_tombstone_overlay/migration.sql \
        CONTRIBUTING.md \
        tests/db/config-roundtrip-fidelity.test.ts

git commit -m "feat(a1): add the tombstone overlay table and its hand-edited CHECK" \
  -m "One Tombstone row per hidden entity, with per-entity FK columns rather
than a polymorphic key: an (entityType, entityId) pair cannot carry a
Prisma relation, and without a relation the read filters cannot compile
to a join, which is the entire point of the overlay.

Neither FK needs @relation(\"name\") — Prisma demands a named relation
only when two relations connect the same PAIR of models, and these
connect Tombstone<->DatasetSample and Tombstone<->Dataset.

The 'exactly one FK non-null' invariant is a real CHECK, hand-edited in,
because a unique index permits unlimited NULLs and would accept both
both-null orphans and both-set rows. Prisma's DSL cannot express a CHECK
at all, so the migration file is the only record of it — hence the fifth
row in CONTRIBUTING.md's pseudo-drift table. Verified by direct INSERT
probe rather than through the client, which cannot build a violating row.

The COVERAGE ledger classifies all seven columns as excludedByDesign
with no knownGaps, so the locked {Rubric, Dataset, GoldenSet} gap
assertion is untouched: a hidden row is absent from the export document
entirely, and absence is the correct portable representation." \
  -m "Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `src/lib/tombstones.ts` — both filters, both writers, `nextSampleIndex`

**Files:**
- Create: `src/lib/tombstones.ts`
- Test: `tests/lib/tombstones.test.ts`

**Interfaces:**
- Consumes (all from Task 1, already in the generated client):
  - `Prisma.DatasetSampleWhereInput` with a `tombstone?: XOR<TombstoneNullableScalarRelationFilter, TombstoneWhereInput> | null` key
  - `Prisma.DatasetWhereInput` with the same `tombstone` key
  - `tx.tombstone` delegate — `upsert`, `updateMany`, `createMany`
  - `tx.datasetSample.aggregate`
  - Columns `isTombstone: Boolean`, `reason: String?`, `datasetSampleId: String? @unique`, `datasetId: String? @unique`
  - Database constraint `Tombstone_exactly_one_entity` (why `tombstoneDataset` must never set `datasetSampleId`)
- Produces — the plan's interface contract, verbatim. Tasks 3-12 import these and no other name from this module:
  - `export function liveSamplesOnly(): Prisma.DatasetSampleWhereInput`
  - `export function liveDatasetsOnly(): Prisma.DatasetWhereInput`
  - `export function tombstoneSample(tx: Prisma.TransactionClient, datasetSampleId: string, reason?: string): Promise<void>`
  - `export function tombstoneSamples(tx: Prisma.TransactionClient, datasetSampleIds: string[], reason?: string): Promise<number>`
  - `export function tombstoneDataset(tx: Prisma.TransactionClient, datasetId: string, reason?: string): Promise<void>`
  - `export function restoreSample(tx: Prisma.TransactionClient, datasetSampleId: string): Promise<void>`
  - `export function nextSampleIndex(tx: Prisma.TransactionClient, datasetId: string): Promise<number>`

- [ ] **Step 1: Write the failing test — the two filters' returned shapes**

Create `tests/lib/tombstones.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { liveDatasetsOnly, liveSamplesOnly } from '@/lib/tombstones';

// Pure-shape unit tests — no DB (vitest.config.ts includes `tests/**/*.test.ts`
// and excludes `tests/db/**`). Deliberately mirrors the RETURNED-fragment
// assertions in tests/lib/golden-sets.test.ts:388-426, not the argument-capture
// style at :245-277: these are functions that return a `where` fragment, so the
// fragment itself is the unit and it is pinned verbatim.
//
// WHY THE SHAPE AND NOT THE BEHAVIOUR. The spec names a shape that passes
// vacuously (Testing, shape 2): every DB fixture in this branch tombstones a
// row with `isTombstone: true`, so a filter written as the simpler
// `{ tombstone: { is: null } }` satisfies ALL of them. Only the UN-DELETED arm
// distinguishes the two formulations, and the exact-object assertion below is
// what makes the difference visible without a database. The behavioural half —
// a restored sample is visible again — lives in tests/db/dataset-sample-
// tombstone.test.ts against a real `isTombstone: false` row.

describe('liveSamplesOnly', () => {
  it('returns the NOT formulation on both the sample and its parent dataset', () => {
    // Two clauses, because a sample inherits its parent dataset's hidden state
    // (design decision 16). A one-clause filter leaves every sample of a
    // tombstoned dataset readable while the dataset itself has vanished.
    expect(liveSamplesOnly()).toEqual({
      NOT: { tombstone: { is: { isTombstone: true } } },
      dataset: { NOT: { tombstone: { is: { isTombstone: true } } } },
    });

    // `toEqual` treats an `undefined`-valued key as absent, so it cannot see a
    // stray key sneaking in. Pin the key set separately.
    expect(Object.keys(liveSamplesOnly()).sort()).toEqual(['NOT', 'dataset']);
  });

  it('uses NOT rather than OR, on purpose, at both levels', () => {
    // The obvious spelling is
    //   { OR: [{ tombstone: { is: null } }, { tombstone: { isTombstone: false } }] }
    // and it is wrong for a structural reason nothing else would catch: an
    // object literal cannot carry two `OR` keys, and FOUR dataset read sites
    // already build their own (datasets/route.ts:67, stats/route.ts:47,
    // datasets/[id]/versions/route.ts:155, dataset-versions.ts:157). Spreading
    // an OR into those clobbers one clause or the other with no type error and
    // no test failure — which is exactly why it needs a test here.
    const where = liveSamplesOnly();
    expect(where).not.toHaveProperty('OR');
    expect(JSON.stringify(where)).not.toContain('"OR"');
  });

  it('returns a fresh object per call, so a caller cannot poison the next one', () => {
    // Every read site spreads this into a `where` it then mutates
    // (datasets/route.ts:62 builds `const where: any = {}` and assigns into
    // it). A shared frozen constant would be a cross-request bug with no
    // reproduction; a module-level `const` returned by reference is the exact
    // shape that fails here.
    expect(liveSamplesOnly()).not.toBe(liveSamplesOnly());
    expect(liveSamplesOnly().dataset).not.toBe(liveSamplesOnly().dataset);
  });
});

describe('liveDatasetsOnly', () => {
  it('returns the single NOT clause', () => {
    expect(liveDatasetsOnly()).toEqual({
      NOT: { tombstone: { is: { isTombstone: true } } },
    });
    expect(Object.keys(liveDatasetsOnly())).toEqual(['NOT']);
    expect(liveDatasetsOnly()).not.toHaveProperty('OR');
  });

  it('returns a fresh object per call', () => {
    expect(liveDatasetsOnly()).not.toBe(liveDatasetsOnly());
  });
});

describe('neither filter touches A0’s column form', () => {
  it('mentions no tombstonedAt, retiredAt or publishedAt anywhere', () => {
    // A0's `tombstonedAt` columns on GoldenSet/GoldenItem/GoldenLabel are a
    // DIFFERENT mechanism with a different capability: goldenSetLifecycleWhere
    // pins `tombstonedAt: null` in both arms precisely so there is no way
    // back, while this overlay is reversible. The design says in as many words
    // that the two must not be harmonised, so a filter that started reaching
    // for a lifecycle column would be a silent merge of the two. Neither model
    // this filter targets even HAS those columns, so the leak would surface as
    // a Prisma validation error at runtime, in whichever route drew it first.
    for (const where of [liveSamplesOnly(), liveDatasetsOnly()]) {
      const json = JSON.stringify(where);
      expect(json).not.toContain('tombstonedAt');
      expect(json).not.toContain('retiredAt');
      expect(json).not.toContain('publishedAt');
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run:

```bash
npx vitest run --config vitest.config.ts tests/lib/tombstones.test.ts
```

Expected: FAIL with

```
Error: Failed to resolve import "@/lib/tombstones" from "tests/lib/tombstones.test.ts". Does the file exist?
```

- [ ] **Step 3: Create `src/lib/tombstones.ts` with the module header and the two filters**

```ts
/**
 * ─── The tombstone overlay (A1) ────────────────────────────────────────────
 *
 * Deleting a Dataset or a DatasetSample HIDES it. One `Tombstone` row per
 * entity, keyed by whichever FK column applies, with a hand-edited CHECK
 * (`Tombstone_exactly_one_entity`, 20260814120000_v2f_tombstone_overlay)
 * guaranteeing exactly one is non-null.
 *
 * THIS MODULE IS THE SINGLE DEFINITION OF "HIDDEN". Every read site spreads
 * one of the two filters below; every destructive verb calls one of the
 * writers. It lives in src/lib/ rather than inside the route handlers because
 * `src/app/api/**` is outside every vitest coverage `include`, and the shape
 * of these predicates is precisely the thing that is cheap to pin in a unit
 * test and expensive to discover in a 620-row corpus.
 *
 * NOT A0's `tombstonedAt` COLUMN FORM, AND THE TWO MUST NOT BE HARMONISED.
 * `goldenSetLifecycleWhere` (src/lib/golden-sets.ts) pins `tombstonedAt: null`
 * in BOTH arms precisely so a tombstoned golden set has no way back. This
 * overlay is reversible by design — see `restoreSample`. Two mechanisms with
 * different capabilities, coexisting on purpose.
 *
 * WHAT THIS MODULE CANNOT REACH: `dataset-evaluation-summary.ts:119` is a
 * `$queryRaw ... FOR UPDATE`. "Spread the helper" does not apply to raw SQL,
 * and that read is deliberately left alone.
 */

import type { Prisma } from '@prisma/client';

/**
 * Live samples: not hidden themselves, and not owned by a hidden dataset
 * (design decision 16 — samples inherit their parent's hidden state).
 *
 * WHY A `NOT` KEY AND NOT AN `OR`. The obvious spelling is
 *
 *     { OR: [{ tombstone: { is: null } }, { tombstone: { isTombstone: false } }] }
 *
 * and it cannot be used, because an object literal cannot carry two `OR` keys
 * and FOUR dataset read sites already build their own — `datasets/route.ts:67`,
 * `stats/route.ts:47`, `datasets/[id]/versions/route.ts:155`,
 * `dataset-versions.ts:157`. Spreading an `OR` into any of those would
 * silently clobber one clause or the other, with no type error and no test
 * failure.
 *
 * `NOT` collides with `NOT` identically, so this is a rule rather than an
 * escape: the only `NOT:` in src/ today is `auth.ts:49`, on a different model.
 * A caller that already has a `NOT:` key must MERGE, not spread. Same for the
 * `dataset:` key below.
 *
 * WHY THE `NOT` IS CORRECT, not merely defensive. Prisma compiles an optional
 * to-one with a `@unique` FK to a LEFT JOIN plus an INJECTED `IS NOT NULL` on
 * the joined id — verified against 6.19.2 on the equivalent
 * `EvaluationRun ← HumanJudgment` pair:
 *
 *     LEFT JOIN "HumanJudgment" AS "j0" ON ("j0"."runId") = ("EvaluationRun"."id")
 *     WHERE (NOT ("j0"."overallScore" = $1 AND ("j0"."id" IS NOT NULL)))
 *
 * So: no tombstone row → returned; `isTombstone: false` → returned;
 * `isTombstone: true` → excluded. The `@unique` on each FK is what guarantees
 * the join matches at most one tombstone.
 *
 * TYPE-SAFETY WARNING FOR ONE CALLER. `src/app/api/datasets/route.ts:62`
 * declares `const where: any = {}`, so this return type offers ZERO protection
 * there. That same object is passed to both `findMany` (`:83`) and `count`
 * (`:92`) — filter one and not the other and the pagination total silently
 * desynchronises from the page it is counting.
 */
export function liveSamplesOnly(): Prisma.DatasetSampleWhereInput {
  return {
    NOT: { tombstone: { is: { isTombstone: true } } },
    dataset: { NOT: { tombstone: { is: { isTombstone: true } } } },
  };
}

/**
 * Live datasets: not hidden.
 *
 * Same `NOT`-not-`OR` argument as `liveSamplesOnly` above, and the same
 * merge-don't-spread rule for a caller that already carries a `NOT:` key. One
 * clause rather than two: a dataset has no parent whose hidden state it
 * inherits — `Dataset.parent` is version lineage, not ownership.
 *
 * Returns a fresh object on every call rather than a module constant, because
 * callers spread it into a `where` they then mutate.
 */
export function liveDatasetsOnly(): Prisma.DatasetWhereInput {
  return { NOT: { tombstone: { is: { isTombstone: true } } } };
}
```

- [ ] **Step 4: Run the filter tests and watch them pass**

Run:

```bash
npx vitest run --config vitest.config.ts tests/lib/tombstones.test.ts
```

Expected: `Tests 6 passed (6)`.

- [ ] **Step 5: Append the writer and `nextSampleIndex` tests**

Add to the top of `tests/lib/tombstones.test.ts` — change the import line to:

```ts
import { describe, it, expect, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import {
  liveDatasetsOnly,
  liveSamplesOnly,
  nextSampleIndex,
  restoreSample,
  tombstoneDataset,
  tombstoneSample,
  tombstoneSamples,
} from '@/lib/tombstones';
```

and append at the end of the file:

```ts
/**
 * Argument capture on a stubbed transaction client — the writers have no
 * return value worth asserting, so the payload IS the unit.
 *
 * TWO DELIBERATE OMISSIONS FROM THE STUB, both load-bearing:
 *   - `datasetSample` exposes `aggregate` and NOT `count`. A `nextSampleIndex`
 *     written as a count would fail here with a TypeError rather than quietly
 *     passing on a fixture where count happens to equal max+1.
 *   - `tombstone` exposes `update` even though nothing should call it, so
 *     `restoreSample` using `update` (which throws P2025 on a missing row)
 *     instead of `updateMany` is visible as a call, not as an absence.
 */
function stubTx() {
  const upsert = vi.fn().mockResolvedValue({});
  const update = vi.fn().mockResolvedValue({});
  const updateMany = vi.fn().mockResolvedValue({ count: 0 });
  const createMany = vi.fn().mockResolvedValue({ count: 0 });
  const aggregate = vi.fn().mockResolvedValue({ _max: { index: null } });
  const tx = {
    tombstone: { upsert, update, updateMany, createMany },
    datasetSample: { aggregate },
  } as unknown as Prisma.TransactionClient;
  return { tx, upsert, update, updateMany, createMany, aggregate };
}

describe('tombstoneSample', () => {
  it('upserts with a NON-EMPTY update arm', async () => {
    const { tx, upsert } = stubTx();
    await tombstoneSample(tx, 'smp-1', 'bad row');

    expect(upsert).toHaveBeenCalledWith({
      where: { datasetSampleId: 'smp-1' },
      create: { datasetSampleId: 'smp-1', isTombstone: true, reason: 'bad row' },
      update: { isTombstone: true, reason: 'bad row' },
    });

    // THE POINT OF THIS TEST. An empty `update: {}` arm still satisfies "never
    // P2002" and reads as a harmless idempotency guard, but it makes
    // delete -> un-delete -> delete leave the row VISIBLE: the second delete
    // finds the restored row, writes nothing, and returns 200. The property is
    // not "idempotent no-op", it is: never P2002, always converges on hidden.
    // It writes every time.
    expect(Object.keys(upsert.mock.calls[0][0].update).length).toBeGreaterThan(0);
    expect(upsert.mock.calls[0][0].update.isTombstone).toBe(true);
  });

  it('normalises a missing reason to null rather than leaving it undefined', async () => {
    const { tx, upsert } = stubTx();
    await tombstoneSample(tx, 'smp-1');

    const { update } = upsert.mock.calls[0][0];
    // `toEqual` treats undefined and absent as equal, so it CANNOT see this
    // bug — assert the key set and the null explicitly. `reason: undefined` in
    // a Prisma update means "leave the column alone", so a reasonless
    // re-delete would silently inherit the previous delete's reason and the
    // row would claim a justification nobody gave it.
    expect(Object.keys(update).sort()).toEqual(['isTombstone', 'reason']);
    expect(update.reason).toBeNull();
    expect(upsert.mock.calls[0][0].create.reason).toBeNull();
  });
});

describe('tombstoneSamples', () => {
  it('dedupes, updates the existing rows, creates the rest, and returns the total', async () => {
    const { tx, updateMany, createMany } = stubTx();
    updateMany.mockResolvedValue({ count: 1 });
    createMany.mockResolvedValue({ count: 2 });

    // 'b' twice on purpose: PUT bulk-replace and the config importer both
    // build this list from a document, and a duplicated id must not double
    // count nor collide inside the INSERT.
    expect(await tombstoneSamples(tx, ['a', 'b', 'c', 'b'], 'bulk-replace')).toBe(3);

    expect(updateMany).toHaveBeenCalledWith({
      where: { datasetSampleId: { in: ['a', 'b', 'c'] } },
      data: { isTombstone: true, reason: 'bulk-replace' },
    });
    expect(createMany).toHaveBeenCalledWith({
      data: [
        { datasetSampleId: 'a', isTombstone: true, reason: 'bulk-replace' },
        { datasetSampleId: 'b', isTombstone: true, reason: 'bulk-replace' },
        { datasetSampleId: 'c', isTombstone: true, reason: 'bulk-replace' },
      ],
      skipDuplicates: true,
    });

    // Without skipDuplicates a re-delete of an already-hidden batch raises
    // P2002 on Tombstone_datasetSampleId_key — the exact failure the whole
    // "never P2002, always converges on hidden" property denies. Pinned
    // separately from the toHaveBeenCalledWith above so it cannot be lost in
    // a payload reshuffle.
    expect(createMany.mock.calls[0][0].skipDuplicates).toBe(true);
  });

  it('issues no statement at all for an empty list', async () => {
    const { tx, updateMany, createMany } = stubTx();
    expect(await tombstoneSamples(tx, [])).toBe(0);
    expect(updateMany).not.toHaveBeenCalled();
    expect(createMany).not.toHaveBeenCalled();
  });
});

describe('tombstoneDataset', () => {
  it('upserts on datasetId and never mentions datasetSampleId', async () => {
    const { tx, upsert } = stubTx();
    await tombstoneDataset(tx, 'ds-1', 'owner deleted');

    expect(upsert).toHaveBeenCalledWith({
      where: { datasetId: 'ds-1' },
      create: { datasetId: 'ds-1', isTombstone: true, reason: 'owner deleted' },
      update: { isTombstone: true, reason: 'owner deleted' },
    });

    // Setting both FKs makes num_nonnulls = 2 and the row is refused by
    // Tombstone_exactly_one_entity — a 500 out of DELETE /api/datasets/[id],
    // not a validation error the client could explain.
    expect(JSON.stringify(upsert.mock.calls[0][0])).not.toContain('datasetSampleId');
  });
});

describe('restoreSample', () => {
  it('flips the flag and clears the reason through updateMany, not update', async () => {
    const { tx, update, updateMany } = stubTx();
    await restoreSample(tx, 'smp-1');

    // `update` on a sample that was never hidden raises P2025 — restoring a
    // live row must be a clean no-op, not a 500.
    expect(update).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenCalledWith({
      where: { datasetSampleId: 'smp-1' },
      data: { isTombstone: false, reason: null },
    });

    // Explicit null, not undefined: a stale "removed as a duplicate" left on a
    // row that is live again is a lie the audit trail cannot detect.
    expect(updateMany.mock.calls[0][0].data.reason).toBeNull();
  });
});

describe('nextSampleIndex', () => {
  it('is max(index) + 1 over ALL rows, hidden included', async () => {
    const { tx, aggregate } = stubTx();
    aggregate.mockResolvedValue({ _max: { index: 7 } });

    expect(await nextSampleIndex(tx, 'ds-1')).toBe(8);
    expect(aggregate).toHaveBeenCalledWith({
      where: { datasetId: 'ds-1' },
      _max: { index: true },
    });

    // THE LOAD-BEARING HALF. Filter this read to live rows and the fixture
    // that breaks is a tombstoned TAIL: samples 0..4 with 4 hidden gives a
    // live-max of 3, so the next insert lands on 4 — occupied — and P2002s on
    // @@unique([datasetId, index]). count() has the mirror-image bug: hide
    // sample 0 of 3 and the count is 2 while index 2 is taken. Both are
    // invisible on a tombstone-free corpus, where count, live-max+1 and
    // all-max+1 all agree.
    const arg = JSON.stringify(aggregate.mock.calls[0][0]);
    expect(arg).not.toContain('tombstone');
    expect(arg).not.toContain('NOT');
  });

  it('starts an empty dataset at 0', async () => {
    const { tx, aggregate } = stubTx();
    aggregate.mockResolvedValue({ _max: { index: null } });
    expect(await nextSampleIndex(tx, 'ds-empty')).toBe(0);
  });
});
```

- [ ] **Step 6: Run it and watch the new tests fail**

Run:

```bash
npx vitest run --config vitest.config.ts tests/lib/tombstones.test.ts
```

Expected: FAIL with `Tests 8 failed | 6 passed (14)`. Every failure is a `TypeError: ... is not a function` — Vite's SSR transform resolves a named export the module does not have to `undefined`, so the call site throws rather than the import. The six filter tests from step 4 still pass.

- [ ] **Step 7: Append the four writers to `src/lib/tombstones.ts`**

```ts
/**
 * Hide one sample. Idempotent: never P2002, always converges on hidden.
 *
 * The `update:` arm is deliberately NON-EMPTY. An empty arm still satisfies
 * "never P2002" and reads as a harmless idempotency guard, but it makes
 * delete → un-delete → delete leave the row VISIBLE: the second delete finds
 * the restored row, writes nothing, and returns 200 — a delete that silently
 * does nothing. So state the property precisely: a repeated delete NEVER
 * raises P2002 and ALWAYS converges on hidden. It is not a no-op; it writes.
 *
 * `reason` is normalised to `null` rather than left `undefined`, because
 * `undefined` in a Prisma `update` means "leave this column alone" — which
 * would let a reasonless delete quietly inherit an earlier delete's reason.
 *
 * Takes the caller's transaction client so the hide and everything else the
 * verb does — the response's live count now, A2's `delete` revision later —
 * commit or roll back as one. A1 leaves this shape deliberately open for that
 * second write.
 */
export async function tombstoneSample(
  tx: Prisma.TransactionClient,
  datasetSampleId: string,
  reason?: string
): Promise<void> {
  await tx.tombstone.upsert({
    where: { datasetSampleId },
    create: { datasetSampleId, isTombstone: true, reason: reason ?? null },
    update: { isTombstone: true, reason: reason ?? null },
  });
}

/**
 * Hide many samples: one statement for the rows that already carry a
 * tombstone, one for the rows that do not. Same convergence property as
 * `tombstoneSample` — never P2002, always converges on hidden.
 *
 * WHY TWO STATEMENTS AND NOT ONE. Prisma has no `upsertMany`, and the single-
 * statement alternative (`INSERT ... ON CONFLICT DO UPDATE` through
 * `$executeRaw`) would have to mint the `id` values itself, which means
 * abandoning `@default(cuid())` for this table alone. The two calls run inside
 * the caller's transaction, so the pair is atomic, which is the property that
 * actually matters. `skipDuplicates` is what keeps the insert half from
 * raising P2002 on `Tombstone_datasetSampleId_key` for a re-delete.
 *
 * The two sets are disjoint — `updateMany` matches exactly the ids that have a
 * row, `createMany` inserts exactly the ids that do not — so the returned sum
 * is the number of DISTINCT ids now hidden, which is what the DELETE handler
 * reports as `deleted`. Input duplicates are removed first so that count means
 * what it says.
 *
 * An id that is not a real `DatasetSample` raises P2003 rather than being
 * skipped: `skipDuplicates` skips unique conflicts, not foreign-key ones. That
 * is the correct loud failure — every caller resolves membership first.
 */
export async function tombstoneSamples(
  tx: Prisma.TransactionClient,
  datasetSampleIds: string[],
  reason?: string
): Promise<number> {
  const ids = [...new Set(datasetSampleIds)];
  if (ids.length === 0) return 0;

  const updated = await tx.tombstone.updateMany({
    where: { datasetSampleId: { in: ids } },
    data: { isTombstone: true, reason: reason ?? null },
  });

  const created = await tx.tombstone.createMany({
    data: ids.map((datasetSampleId) => ({
      datasetSampleId,
      isTombstone: true,
      reason: reason ?? null,
    })),
    skipDuplicates: true,
  });

  return updated.count + created.count;
}

/**
 * Hide one dataset. Same non-empty-`update` argument as `tombstoneSample`.
 *
 * Sets `datasetId` and NOTHING ELSE. Setting both FK columns makes
 * `num_nonnulls` 2 and the row is refused by `Tombstone_exactly_one_entity` —
 * a 500 out of `DELETE /api/datasets/[id]`, not something the client could be
 * told about.
 *
 * Samples are NOT tombstoned alongside their dataset, and that is deliberate:
 * `liveSamplesOnly()` carries the parent clause, so every sample of a hidden
 * dataset is already hidden by inheritance (decision 16). Writing a row per
 * sample would be a second source of truth for the same fact, and un-hiding
 * the dataset would then have to un-hide exactly the samples it hid and no
 * others.
 */
export async function tombstoneDataset(
  tx: Prisma.TransactionClient,
  datasetId: string,
  reason?: string
): Promise<void> {
  await tx.tombstone.upsert({
    where: { datasetId },
    create: { datasetId, isTombstone: true, reason: reason ?? null },
    update: { isTombstone: true, reason: reason ?? null },
  });
}

/**
 * Un-hide one sample: flips `isTombstone` to false and clears `reason`.
 *
 * `updateMany`, not `update`, because `update` on a sample that was never
 * hidden raises P2025 — restoring a live row must be a clean no-op, not a 500.
 * There is no `upsert` either: "no row" already means live, so creating a
 * `isTombstone: false` row would only manufacture a record of a deletion that
 * never happened.
 *
 * The row is kept rather than deleted, so `createdAt`/`updatedAt` still record
 * that the sample was once hidden and A2's `restore` revision has something to
 * point at. Clearing `reason` is load-bearing rather than tidy: a stale
 * "removed as a duplicate" left on a row that is live again is a lie nothing
 * downstream can detect.
 */
export async function restoreSample(
  tx: Prisma.TransactionClient,
  datasetSampleId: string
): Promise<void> {
  await tx.tombstone.updateMany({
    where: { datasetSampleId },
    data: { isTombstone: false, reason: null },
  });
}
```

- [ ] **Step 8: Append `nextSampleIndex`**

```ts
/**
 * The next `DatasetSample.index` for a dataset: a HIGH-WATER MARK over every
 * row, hidden included, never a count and never a reused ordinal.
 *
 *     nextIndex = max(index) over ALL rows of the dataset + 1
 *
 * WHY NOT `count()`: hide sample 0 of 3 and the count is 2, but index 2 is
 * occupied — P2002 on `@@unique([datasetId, index])` on the very first insert.
 *
 * WHY NOT `max` over LIVE rows: hide the TAIL (samples 0..4, hide 4) and
 * live-max + 1 is 4, which is occupied by the hidden row. This is why
 * `liveSamplesOnly()` must NOT be spread into the read below, and why
 * `samples/route.ts:46` stays unfiltered.
 *
 * THE CASE THAT ACTUALLY BITES is not a freshly-appended corpus — Prisma's
 * `_count` is unfiltered by default and the POST high-water read stays
 * unfiltered, so there `count == max + 1` and nothing collides. It bites on a
 * corpus RE-IMPORTED FROM A FILTERED EXPORT: `config.ts:389` emits
 * `index: s.index` verbatim and the importer writes it back, so the rows
 * arrive with gaps, `count < max + 1`, and the first append collides.
 *
 * The consequence, stated so nobody rediscovers it as a bug: after the first
 * tombstone `index` is NOT dense. Its only guarantees are uniqueness within
 * the dataset and monotonic insertion order. Any code treating it as a
 * 0-based position into the live sample array is wrong.
 *
 * MUST be called with the same `tx` as the inserts it feeds, for the same
 * reason `nextGoldenItemIndex` is (src/lib/golden-sets.ts): read-then-insert
 * across a commit boundary is a race against a concurrent append.
 */
export async function nextSampleIndex(
  tx: Prisma.TransactionClient,
  datasetId: string
): Promise<number> {
  const highWaterMark = await tx.datasetSample.aggregate({
    where: { datasetId },
    _max: { index: true },
  });
  return (highWaterMark._max.index ?? -1) + 1;
}
```

- [ ] **Step 9: Run the whole file and watch it pass**

Run:

```bash
npx vitest run --config vitest.config.ts tests/lib/tombstones.test.ts
```

Expected: `Test Files 1 passed (1)` / `Tests 14 passed (14)`.

- [ ] **Step 10: Discrimination — break `liveSamplesOnly` to the naive form and watch the shape test catch it**

Record the baseline first:

```bash
sha256sum src/lib/tombstones.ts
```

Now temporarily replace `liveSamplesOnly`'s body with the simpler formulation every `isTombstone: true` fixture would accept:

```ts
  return { tombstone: { is: null } };
```

Run:

```bash
npx vitest run --config vitest.config.ts tests/lib/tombstones.test.ts -t "returns the NOT formulation"
```

Expected: FAIL with

```
AssertionError: expected { tombstone: { is: null } } to deeply equal { NOT: { tombstone: …(1) }, …(1) }
```

Restore the two-clause body, re-run `sha256sum src/lib/tombstones.ts`, and confirm it matches the baseline byte for byte. Put both hashes and the failure text in the task report.

- [ ] **Step 11: Discrimination — empty the `upsert` update arm and watch the non-empty assertion catch it**

Temporarily change `tombstoneSample`'s upsert to `update: {},`.

Run:

```bash
npx vitest run --config vitest.config.ts tests/lib/tombstones.test.ts -t "upserts with a NON-EMPTY update arm"
```

Expected: FAIL with

```
AssertionError: expected 0 to be greater than 0
```

(the `Object.keys(...).length` assertion; the `toHaveBeenCalledWith` above it fails first with `update: {}` against `update: { isTombstone: true, reason: 'bad row' }` — both are the intended catch).

Restore, re-run `sha256sum src/lib/tombstones.ts`, confirm it matches the step 10 baseline, and record it.

- [ ] **Step 12: Typecheck and lint**

Run: `npx tsc --noEmit && npm run lint`

Expected: both silent. If `tsc` reports `Property 'tombstone' does not exist on type ...`, the Prisma client is stale — re-run `DATABASE_URL="postgresql://judge_arena:password@localhost:5432/judge_arena" npx prisma generate`.

- [ ] **Step 13: Run the full unit suite and its coverage gate**

Run: `npm test`

Expected: `Test Files 35 passed (35)` / `Tests 490 passed (490)` — 476 before this task plus the 14 added here, and one new file.

Run: `npm run test:coverage`

Expected: green, with every floor cleared. `src/lib/tombstones.ts` is fully exercised by this unit run, so it moves the aggregate up, not down (baseline all-files 38.22 / 85.19 / 68.14 / 38.22 against floors 35 / 82 / 65 / 35). Do not touch a floor; if actuals moved materially, update only the "Actuals as of" prose per `vitest.config.ts`'s threshold policy.

- [ ] **Step 14: Run the DB suite and its coverage gate**

`src/lib/tombstones.ts` is inside `vitest.db.config.ts`'s coverage `include` too, and nothing in `tests/db/**` imports it yet — that arrives with Task 3. So it lands as an uncovered file in this run, and the floors must still clear.

Run: `npm run test:db`

Expected: `Test Files 35 passed (35)` / `Tests 445 passed (445)` — unchanged from Task 1.

Run: `npm run test:db:coverage`

Expected: green. The baseline is lines 3584/7233 = 49.55% against a floor of 47, and branches 702/882 = 79.59% against a floor of 77. An uncovered file contributes its executable lines to the denominator and (v8 cannot see branches in code that never ran) exactly one branch — measured on the comparable never-imported `src/lib/auth-guard.ts`, which reports `LF:198 LH:0 BRF:1 BRH:0`. For a ~35-executable-line module that is lines 3584/7268 ≈ 49.3% and branches 702/883 ≈ 79.5%, both clear by more than 2pp. Remember this suite's branch column jitters ±2 branches run to run with no code change — if you land within a point of a floor, measure at least three times and take the lowest. **Never lower a floor.**

- [ ] **Step 15: Run the integration suite**

Run: `npm run test:integration`

Expected: `Tests 80 passed (80)` — unchanged.

- [ ] **Step 16: Commit**

```bash
git add src/lib/tombstones.ts tests/lib/tombstones.test.ts

git commit -m "feat(a1): add the tombstone read filters, writers and high-water mark" \
  -m "The single definition of 'hidden'. Both filters return a NOT key rather
than the obvious OR, because an object literal cannot carry two OR keys
and four dataset read sites already build their own — spreading an OR
into those clobbers a clause with no type error and no test failure.
Callers that already have a NOT: must merge, not spread.

The writers upsert with a NON-EMPTY update arm. An empty arm still never
raises P2002 and reads as a harmless idempotency guard, but it makes
delete -> un-delete -> delete leave the row visible. The property is:
never P2002, always converges on hidden. It writes every time. reason is
normalised to null because undefined means 'leave the column alone' in a
Prisma update, so a reasonless re-delete would inherit an earlier one.

nextSampleIndex is max(index) over ALL rows including hidden, +1, taking
the caller's tx — the same shape and the same argument as
nextGoldenItemIndex. count() breaks on a hidden head; max over live rows
breaks on a hidden tail; both are invisible until a corpus is re-imported
from a filtered export, where the indices arrive with gaps.

Unit tests pin the returned fragments verbatim rather than behaviourally:
every DB fixture on this branch hides rows with isTombstone true, so the
simpler { tombstone: { is: null } } would satisfy all of them. Only the
exact-object assertion distinguishes the two without a database." \
  -m "Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `DELETE /api/datasets/[id]/samples` tombstones, the re-index loop is deleted, `sampleCount` becomes live

**Files:**
- Modify: `src/app/api/datasets/[id]/samples/route.ts:6` (widen the import block by one line)
- Modify: `src/app/api/datasets/[id]/samples/route.ts:182-248` (the whole tail of `DELETE`: the membership lookup, the pin-guard comment and its 409 copy, the `deleteMany`, the re-index loop, the `sampleCount` write and the response)
- Create/Test: `tests/db/dataset-sample-tombstone.test.ts`
- Modify/Test: `tests/db/dataset-sample-freeze.test.ts:238-253` (rewrite the `it('DELETE /api/datasets/[id]/samples still deletes when nothing pins the dataset', …)` block in place)

> **Line numbers are against the pre-A1 tree (`f26165c`).** Nothing earlier in this plan edits `samples/route.ts`, so they are exact when you start — but verify the quoted text before you replace anything, and anchor on the quoted code rather than the number.

**Interfaces:**
- Consumes (from `src/lib/tombstones.ts`, defined in Task 2 and imported by name):
  - `liveSamplesOnly(): Prisma.DatasetSampleWhereInput` — returns `{ NOT: { tombstone: { is: { isTombstone: true } } }, dataset: { NOT: { tombstone: { is: { isTombstone: true } } } } }`, a fresh object per call, meant to be **spread** into a `where`
  - `tombstoneSamples(tx: Prisma.TransactionClient, datasetSampleIds: string[], reason?: string): Promise<number>` — two statements inside the caller's transaction (an `updateMany` then a `createMany` with `skipDuplicates`), returning the number of **distinct ids now hidden**; the input list is de-duplicated first. It raises **P2003**, not a skip, for an id that is not a real `DatasetSample`.
- Consumes (already in the tree): `findGoldenSetsPinningDataset(client: Prisma.TransactionClient, datasetId: string): Promise<{ id: string; name: string }[]>` from `@/lib/golden-sets`; `db`, `mkUser`, `truncateAll` from `tests/db/helpers.ts`
- Produces: no new exported names. The behavioural contract later tasks rely on — `DELETE /api/datasets/[id]/samples` answers `200 { tombstoned: number; remaining: number }` where `remaining` is a **live** count, every named row survives on disk carrying a `Tombstone` row with `isTombstone: true` and `reason: 'sample deleted'`, ordinals are **not** renumbered, and `Dataset.sampleCount` is set to the same live count the response reports. Also produces the test file `tests/db/dataset-sample-tombstone.test.ts`, which **Task 4 appends to**.

**Why the membership lookup at `:183` must stay UNFILTERED.** An already-hidden id still *belongs* to this dataset. Filter that lookup and a retried delete gets a 400 saying the sample is foreign, when the honest answer is "already hidden, still hidden". This mirrors the golden-item membership lookup at `src/app/api/golden-sets/[id]/items/route.ts:290-296` — open it and match its reasoning; the comment there reads "NOT lifecycle-filtered, deliberately: an already-tombstoned id still belongs to this set, so a retried DELETE must be an idempotent no-op rather than a 400 claiming the item is foreign." The lookup is also what keeps `tombstoneSamples` usable: that helper raises **P2003** for an id that is not a real `DatasetSample` (`skipDuplicates` skips unique conflicts, not foreign-key ones), so this read is what converts a genuinely foreign id into a clean 400 instead of a 500.

**Note which read that is.** `:183` is the **membership** lookup (`datasetSample.findMany`). It is *not* the dataset ownership read at `:167` (`dataset.findUnique`) — that one is filtered by a later task in this plan (the mutation-guard sweep), and this task must leave it exactly as it is.

**The response key becomes `tombstoned`.** Decided here, with the evidence:
- A0 renamed the same key on the sibling endpoint one migration ago: `src/app/api/golden-sets/[id]/items/route.ts:313` returns `{ tombstoned: tombstoned.count, remaining }`, and `tests/db/golden-sets.test.ts:1066` pins `{ tombstoned: 2, remaining: 3 }`.
- **No client reads the key.** The only caller in the tree is `deleteSample` at `src/app/datasets/[id]/page.tsx:332-357`, which checks `res.ok` and reads `data.error` on failure and nothing else. `grep -rn "\.deleted\b" src tests scripts` finds exactly two hits: the route line itself and the one freeze-test assertion this task rewrites.
- The counter-argument, stated so the choice is made rather than defaulted: this is a token-scoped public API (`datasets:write`) with no versioning, so renaming a response key is a breaking change for an external script. It loses to consistency here — the sibling endpoint already took the identical break, both land in the same release, and `deleted` is the one word that would let a caller conclude the row is gone when it is merely hidden. An external caller gets `undefined`, which is a loud break rather than a quiet lie.
- **The counting rule differs from golden-items on purpose.** `tombstoneSamples` returns ids **now hidden**, so a repeated delete reports `tombstoned: 1`. The golden-items route's `updateMany … tombstonedAt: null` reports `tombstoned: 0` on a retry (`tests/db/golden-sets.test.ts:1123`). Same key name, deliberately different rule; the test below pins it.

---

- [ ] **Step 1: Write the failing tests — create `tests/db/dataset-sample-tombstone.test.ts`**

This is the file the plan's File Structure names "the overlay against a real database: hide, un-hide, converge, ordinals". This task writes the hide / un-hide / converge half; Task 4 appends the ordinals half, so leave the helpers at the top general enough to be reused.

Create `tests/db/dataset-sample-tombstone.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { getServerSession } from 'next-auth';
import { db, truncateAll, mkUser } from './helpers';
import { DELETE as deleteSamples } from '@/app/api/datasets/[id]/samples/route';
import { liveSamplesOnly } from '@/lib/tombstones';

// A1, the tombstone overlay. DELETE /api/datasets/[id]/samples HIDES the named
// rows: the DatasetSample survives on disk with its ordinal, a Tombstone row
// carries the hidden flag, and every filtered read stops returning it. That is
// what lets an annotated corpus shed a bad row —
// GoldenItem.sourceDatasetSampleId is `onDelete: Restrict`, so a hard delete
// either fails outright or takes the annotation with it.
//
// Ordinals stop being dense as a direct consequence, because a tombstone frees
// nothing: @@unique([datasetId, index]) is not partial, so the hidden row keeps
// index 0 forever. The re-index loop this handler used to run is therefore
// deleted rather than adapted — see the route.

vi.mock('next-auth', () => ({ getServerSession: vi.fn() }));
vi.mock('next/headers', () => ({ headers: vi.fn(async () => new Headers()) }));

// Same fake, same reason, as tests/db/dataset-sample-freeze.test.ts:29-35 and
// tests/db/access-matrix.test.ts:94-100: requireAuth() hits a REAL Redis
// sliding window keyed by client IP (always '127.0.0.1' here), and
// `fileParallelism: false` makes that 120/min budget shared by every file in
// one `npm run test:db` run — so a route-driving file can intermittently fail
// OTHER files without this.
vi.mock('@/lib/rate-limit-redis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rate-limit-redis')>();
  return {
    ...actual,
    apiLimiter: { check: vi.fn(async () => ({ ok: true, remaining: 999, resetAt: Date.now() + 60_000 })) },
  };
});

function mockSessionFor(user: { id: string; email: string }) {
  (getServerSession as unknown as Mock).mockResolvedValue({
    user: { id: user.id, email: user.email },
  });
}

function jsonRequest(url: string, method: string, body?: unknown) {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'content-type': 'application/json' };
  }
  return new Request(url, init);
}

let fixtureCounter = 0;

/**
 * A dataset owned by `userId` whose samples sit at exactly `indices` — the
 * literal ordinals, not a count. Every fixture in this file cares about the
 * SHAPE of the ordinal sequence, and a helper that only took a length could
 * not express a corpus with holes in it.
 */
async function mkCorpus(userId: string, indices: number[]) {
  fixtureCounter += 1;
  return db.dataset.create({
    data: {
      name: `tombstone-fixture-dataset-${fixtureCounter}`,
      userId,
      source: 'local',
      visibility: 'public',
      sampleCount: indices.length,
      samples: {
        create: indices.map((index) => ({
          index,
          input: `question-${index}`,
          expected: 'A>B',
        })),
      },
    },
    include: { samples: { orderBy: { index: 'asc' } } },
  });
}

async function callDelete(datasetId: string, sampleIds: string[]) {
  return deleteSamples(
    jsonRequest(`http://localhost/api/datasets/${datasetId}/samples`, 'DELETE', { sampleIds }),
    { params: Promise.resolve({ id: datasetId }) }
  );
}

describe('DELETE /api/datasets/[id]/samples — the overlay (A1 Task 3)', () => {
  beforeEach(async () => {
    await truncateAll();
    (getServerSession as unknown as Mock).mockReset();
  });

  it('HIDES the named rows, leaves them on disk, and reports a LIVE remaining count', async () => {
    const user = await mkUser();
    mockSessionFor(user);
    const dataset = await mkCorpus(user.id, [0, 1, 2, 3]);

    // The corpus carries a hidden row BEFORE the verb runs. Without that, the
    // live count and the row count are the same number and every count
    // assertion below passes vacuously against the unchanged handler — the
    // spec's Testing shapes 1 ("the overlay hides rows") and 5 ("the two
    // sampleCount writes").
    await db.tombstone.create({
      data: {
        datasetSampleId: dataset.samples[3].id,
        isTombstone: true,
        reason: 'deleted by hand',
      },
    });

    const res = await callDelete(dataset.id, [dataset.samples[0].id]);

    expect(res.status).toBe(200);
    // `remaining` counts LIVE rows — indices 1 and 2. There are 4 rows on
    // disk, and the `remaining.length` this replaces reported 3.
    expect(await res.json()).toEqual({ tombstoned: 1, remaining: 2 });

    // Nothing was destroyed. The id a GoldenItem.sourceDatasetSampleId would
    // cite is still there and still addressable — the entire point.
    await expect(db.datasetSample.count({ where: { datasetId: dataset.id } })).resolves.toBe(4);
    await expect(
      db.datasetSample.findUnique({ where: { id: dataset.samples[0].id } })
    ).resolves.not.toBeNull();

    const tomb = await db.tombstone.findUnique({
      where: { datasetSampleId: dataset.samples[0].id },
    });
    expect(tomb?.isTombstone).toBe(true);
    expect(tomb?.reason).toBe('sample deleted');

    // …and hidden, by the one definition of hidden.
    const live = await db.datasetSample.findMany({
      where: { datasetId: dataset.id, ...liveSamplesOnly() },
      orderBy: { index: 'asc' },
    });
    expect(live.map((s) => s.index)).toEqual([1, 2]);

    // The stored count is the live count, not the row count. The UI ladder
    // reads this value FIRST, so a stale one shadows the live count beneath
    // it — the import picker advertises 620 and the import yields 610.
    const after = await db.dataset.findUnique({
      where: { id: dataset.id },
      select: { sampleCount: true },
    });
    expect(after?.sampleCount).toBe(2);

    // The pre-existing tombstone is untouched: this delete never named that
    // id, and re-tombstoning it would overwrite the record of why it went
    // away with this delete's reason.
    const untouched = await db.tombstone.findUnique({
      where: { datasetSampleId: dataset.samples[3].id },
    });
    expect(untouched?.reason).toBe('deleted by hand');
  });

  it('a REPEATED delete of an already-hidden id is 200 and stays hidden — the sole reason the membership lookup is unfiltered', async () => {
    // The spec's Testing shape 4, and it is worth being precise about why it
    // needs its own test: a delete -> un-delete -> delete sequence does NOT
    // cover this. That sequence's second call hits the membership lookup
    // against a LIVE row, so it passes even when the lookup is filtered. Only
    // a straight retry, with the row still hidden, discriminates.
    const user = await mkUser();
    mockSessionFor(user);
    const dataset = await mkCorpus(user.id, [0, 1]);

    const first = await callDelete(dataset.id, [dataset.samples[0].id]);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ tombstoned: 1, remaining: 1 });

    const second = await callDelete(dataset.id, [dataset.samples[0].id]);
    // 200, not the 400 a filtered membership lookup would produce: the row
    // still BELONGS to this dataset, it is merely hidden.
    expect(second.status).toBe(200);
    // `tombstoned` counts ids NOW HIDDEN, not ids newly hidden, so the retry
    // reports 1. That differs on purpose from the golden-items route, whose
    // `updateMany … tombstonedAt: null` reports 0 on a retry
    // (tests/db/golden-sets.test.ts:1123). "Now hidden" is the property this
    // handler converges on, and it is what makes the retry's `remaining`
    // meaningful rather than an accident.
    expect(await second.json()).toEqual({ tombstoned: 1, remaining: 1 });

    // One row per entity, upserted on a @unique FK: never P2002, never a
    // duplicate.
    await expect(
      db.tombstone.count({ where: { datasetSampleId: dataset.samples[0].id } })
    ).resolves.toBe(1);
    const tomb = await db.tombstone.findUnique({
      where: { datasetSampleId: dataset.samples[0].id },
    });
    expect(tomb?.isTombstone).toBe(true);
  });

  it('converges on hidden after an un-delete — the write arm is not empty', async () => {
    const user = await mkUser();
    mockSessionFor(user);
    const dataset = await mkCorpus(user.id, [0, 1]);

    expect((await callDelete(dataset.id, [dataset.samples[0].id])).status).toBe(200);
    const afterFirst = await db.tombstone.findUnique({
      where: { datasetSampleId: dataset.samples[0].id },
    });
    expect(afterFirst?.isTombstone).toBe(true);

    // Un-hide it, exactly as `restoreSample` does: flip the flag, clear the
    // reason, keep the row.
    await db.tombstone.update({
      where: { datasetSampleId: dataset.samples[0].id },
      data: { isTombstone: false, reason: null },
    });
    await expect(
      db.datasetSample.count({ where: { datasetId: dataset.id, ...liveSamplesOnly() } })
    ).resolves.toBe(2);

    const again = await callDelete(dataset.id, [dataset.samples[0].id]);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ tombstoned: 1, remaining: 1 });

    // The restore in the middle is what makes this non-vacuous: without it the
    // second delete writes `isTombstone: true` over `isTombstone: true`, and a
    // writer whose update arm was EMPTY would look correct. With it, an empty
    // arm leaves the row VISIBLE — a delete that returns 200 and silently does
    // nothing. The property is not "idempotent no-op": it is never P2002, and
    // always converges on hidden.
    const tomb = await db.tombstone.findUnique({
      where: { datasetSampleId: dataset.samples[0].id },
    });
    expect(tomb?.isTombstone).toBe(true);
    // The reason is re-asserted too, not left null by an update that only
    // touched the flag.
    expect(tomb?.reason).toBe('sample deleted');
  });

  it('does NOT re-index the survivors — every ordinal keeps its hole, and the hidden row keeps its own', async () => {
    const user = await mkUser();
    mockSessionFor(user);
    const dataset = await mkCorpus(user.id, [0, 1, 2]);

    const res = await callDelete(dataset.id, [dataset.samples[0].id]);
    expect(res.status).toBe(200);

    const rows = await db.datasetSample.findMany({
      where: { datasetId: dataset.id },
      orderBy: { index: 'asc' },
    });
    // Three rows, still at 0, 1, 2. The loop this task deletes renumbered the
    // survivors to 0 and 1; adapted to live rows it renumbers the first
    // survivor to 0 and collides with the hidden row still holding 0 (P2002 on
    // @@unique([datasetId, index]), which is not partial).
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.index)).toEqual([0, 1, 2]);
    expect(rows[0].id).toBe(dataset.samples[0].id);
    expect(rows[0].index).toBe(0);

    const live = await db.datasetSample.findMany({
      where: { datasetId: dataset.id, ...liveSamplesOnly() },
      orderBy: { index: 'asc' },
    });
    expect(live.map((s) => s.index)).toEqual([1, 2]);
  });

  it('an id from ANOTHER dataset is still a clean 400, not a P2003 in a 500', async () => {
    // The membership lookup is UNFILTERED, not absent, and this is the
    // difference. `tombstoneSamples` raises P2003 for an id that is not a real
    // DatasetSample — `skipDuplicates` skips unique conflicts, not foreign-key
    // ones — so without this read a foreign id would surface as a generic 500.
    //
    // Unlike the four cases above, this one is GREEN before the change too. It
    // is a regression guard on a read this task must not remove while it is
    // busy refusing to filter it.
    const user = await mkUser();
    mockSessionFor(user);
    const target = await mkCorpus(user.id, [0]);
    const other = await mkCorpus(user.id, [0]);

    const res = await callDelete(target.id, [other.samples[0].id]);

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Some samples not found in this dataset');
    await expect(db.tombstone.count()).resolves.toBe(0);
    await expect(
      db.dataset.findUnique({ where: { id: target.id }, select: { sampleCount: true } })
    ).resolves.toEqual({ sampleCount: 1 });
  });
});
```

- [ ] **Step 2: Rewrite the happy-path test at `tests/db/dataset-sample-freeze.test.ts:238`**

That test asserts hard deletion by raw row count. It cannot be adjusted — `count()` → 0 is satisfied by exactly the behaviour this task removes — so it is inverted. Replace the whole `it(…)` block, from `it('DELETE /api/datasets/[id]/samples still deletes when nothing pins the dataset', async () => {` through its closing `});`, with:

```ts
  it('DELETE /api/datasets/[id]/samples HIDES the sample when nothing pins the dataset', async () => {
    const user = await mkUser();
    mockSessionFor(user);
    const { dataset, sample } = await mkDatasetWithSample(user.id);

    const res = await deleteSamples(
      jsonRequest(`http://localhost/api/datasets/${dataset.id}/samples`, 'DELETE', {
        sampleIds: [sample.id],
      }),
      { params: Promise.resolve({ id: dataset.id }) }
    );

    expect(res.status).toBe(200);
    // `deleted` became `tombstoned` — nothing is deleted here any more, and a
    // key called `deleted` is the one word that would let a caller conclude
    // the row is gone. Same rename A0 made on the sibling endpoint
    // (src/app/api/golden-sets/[id]/items/route.ts:313).
    expect(await res.json()).toEqual({ tombstoned: 1, remaining: 0 });

    // The old assertion here was `count()` → 0. It is inverted rather than
    // adjusted: the row survives, carrying the id any golden item would cite,
    // and it is the Tombstone row that makes it invisible.
    await expect(db.datasetSample.count({ where: { datasetId: dataset.id } })).resolves.toBe(1);
    const tomb = await db.tombstone.findUnique({ where: { datasetSampleId: sample.id } });
    expect(tomb?.isTombstone).toBe(true);

    // `sampleCount` is a live count, and the response body reads the same
    // value — they move together.
    const after = await db.dataset.findUnique({
      where: { id: dataset.id },
      select: { sampleCount: true },
    });
    expect(after?.sampleCount).toBe(0);
  });
```

Do **not** add an `@/lib/tombstones` import to `dataset-sample-freeze.test.ts`. A later task in this plan adds one to that file, and a second import statement for the same module is a duplicate-identifier error. Everything that needs the filter is asserted in `tests/db/dataset-sample-tombstone.test.ts` instead.

- [ ] **Step 3: Run both files and watch them fail**

Run:

```bash
sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.db.config.ts tests/db/dataset-sample-tombstone.test.ts tests/db/dataset-sample-freeze.test.ts'
```

Expected: **5 failed**, everything else in `dataset-sample-freeze.test.ts` green.

- `HIDES the named rows, leaves them on disk, and reports a LIVE remaining count` — FAIL with
  `AssertionError: expected { deleted: 1, remaining: 3 } to deeply equal { tombstoned: 1, remaining: 2 }`
- `a REPEATED delete of an already-hidden id is 200 and stays hidden …` — FAIL with
  `AssertionError: expected 400 to be 200` (the first call hard-deleted the row, so the second call's membership lookup finds nothing and 400s)
- `converges on hidden after an un-delete — the write arm is not empty` — FAIL with
  `AssertionError: expected undefined to be true` (no `Tombstone` row was ever written, so `findUnique` returns `null`)
- `does NOT re-index the survivors …` — FAIL with
  `AssertionError: expected [ …(2) ] to have a length of 3 but got 2`
- `DELETE /api/datasets/[id]/samples HIDES the sample when nothing pins the dataset` (in the freeze file) — FAIL with
  `AssertionError: expected { deleted: 1, remaining: 0 } to deeply equal { tombstoned: 1, remaining: 0 }`

`an id from ANOTHER dataset is still a clean 400` passes already — it is the regression guard, and it is supposed to be green here.

- [ ] **Step 4: Import the overlay helpers into the route**

In `src/app/api/datasets/[id]/samples/route.ts` the import block ends at line 6 with `import { findGoldenSetsPinningDataset } from '@/lib/golden-sets';`. Add immediately after it:

```ts
import { liveSamplesOnly, tombstoneSamples } from '@/lib/tombstones';
```

Later tasks in this plan need `nextSampleIndex` from the same module. When they do, they **widen this line** — there must never be a second `from '@/lib/tombstones'` statement in this file.

- [ ] **Step 5: Comment the membership lookup as deliberately unfiltered**

Replace the comment at `:182` — the single line `    // Verify all samples belong to this dataset` — leaving the `findMany` beneath it **byte-identical**:

```ts
    // Verify all samples belong to this dataset.
    //
    // UNFILTERED, DELIBERATELY — do not spread `liveSamplesOnly()` in here.
    // An already-hidden id STILL BELONGS to this dataset, so a retried delete
    // must converge on hidden rather than answer 400 claiming the id is
    // foreign. Same rule, same wording, as the golden-item membership lookup
    // at src/app/api/golden-sets/[id]/items/route.ts:290-296.
    //
    // It is also what keeps `tombstoneSamples` usable: that helper raises
    // P2003 for an id that is not a real DatasetSample, because
    // `skipDuplicates` skips unique conflicts and not foreign-key ones. This
    // read is what turns a foreign id into the clean 400 below instead of a
    // generic 500 — deliberately loud in the helper, deliberately handled
    // here.
    //
    // NOTE this is the MEMBERSHIP read. The dataset OWNERSHIP read above is a
    // different site with a different disposition; leave it alone.
```

- [ ] **Step 6: Correct the pin guard's now-false comment and its 409 copy**

The guard itself stays. Two of its sentences stop being true the moment this task lands, and both name mechanisms that no longer exist. Replace the comment block at `:195-204` (it begins `// Same guard as PUT, and it was missing here` and ends `// not partially editable.`) with:

```ts
    // Same guard as PUT, and it was missing here — recorded as a known gap in
    // the migration header and closed in A0. A1 made this handler tombstone
    // the named rows, so GoldenItem.sourceDatasetSampleId's `Restrict` is no
    // longer what would refuse: nothing is deleted below any more, and the
    // re-index loop that used to renumber the survivors is gone too.
    //
    // THE GUARD STAYS ANYWAY, deliberately. Hiding a row removes it from every
    // filtered read exactly as deleting it did, so a corpus somebody has
    // annotated would still change shape under the annotation. Retiring this
    // guard belongs to the lifecycle work (Plan B), not to the overlay.
    //
    // The check stays DATASET-WIDE rather than per-sampleId. Its original
    // reason — "this handler re-indexes every surviving row afterwards" — is
    // now false, and the replacement is narrower but real: a golden item's
    // sourceDatasetSampleId may cite any row of the corpus, and hiding any row
    // changes what every filtered read of that corpus returns, including the
    // sample list an annotator reviews. Narrowing the scope to the named ids
    // is a behaviour change, and it belongs with the guard's retirement rather
    // than with the overlay.
    //
    // The predicate — including why it is NOT lifecycle-filtered — lives in
    // `findGoldenSetsPinningDataset` (src/lib/golden-sets.ts), shared with the
    // three other destructive paths that were missing this guard entirely:
    // PUT below, DELETE /api/datasets/[id], and the config importer's sample
    // replace.
```

Then fix the user-facing copy in the 409 body at `:213`. Replace:

```ts
            'Golden items were imported from these rows, and the surviving samples would be re-indexed. ' +
```

with:

```ts
            'Golden items were imported from these rows. ' +
```

(`tests/db/dataset-sample-freeze.test.ts:231` asserts only that the message contains each set's *name*, so this copy edit is safe.)

- [ ] **Step 7: Replace the delete, the re-index loop and the count update with one transaction**

Replace everything from `    await prisma.datasetSample.deleteMany({` (`:221`) through `    return NextResponse.json({ deleted: data.sampleIds.length, remaining: remaining.length });` (`:248`) with:

```ts
    // A1: hide + live count + persist, in ONE transaction. Before this, the
    // delete, the re-index and the count update were three separate round
    // trips, so a failure between them left a corpus whose stored count
    // disagreed with its rows. Same shape as the golden-items DELETE
    // (src/app/api/golden-sets/[id]/items/route.ts:284).
    //
    // The membership lookup and the pin guard stay OUTSIDE this transaction,
    // unlike their golden-items counterparts. Two reasons: they are reads that
    // gate the write and neither races anything (nothing hard-deletes a
    // DatasetSample on this branch any more), and keeping them out preserves
    // the existing precedence — a foreign id is a 400 even on a pinned
    // dataset. Moving them in would mean throwing typed errors out of the
    // callback, which Next.js 15 forces to be module-local classes because it
    // validates route.ts exports against a known allowlist.
    const result = await prisma.$transaction(async (tx) => {
      // `samples` rather than `data.sampleIds`: the lookup above already
      // resolved exactly the ids that belong here, and passing the resolved
      // set is what keeps the P2003 in `tombstoneSamples` unreachable.
      const tombstoned = await tombstoneSamples(
        tx,
        samples.map((s) => s.id),
        'sample deleted'
      );

      // ── THE RE-INDEX LOOP IS DELETED, NOT ADAPTED ──────────────────────
      // What stood here read every surviving row and renumbered it 0..n-1.
      // Neither form of it survives A1, and both failure modes are worth
      // naming because each looks plausible:
      //
      //   ADAPTED (filtered to live rows) it renumbers the first survivor to
      //   0 — which collides with the hidden row still holding 0, because
      //   @@unique([datasetId, index]) is not partial and a tombstone frees
      //   no ordinal. P2002, the transaction rolls back, and EVERY delete
      //   500s. The 20260813120000_v2e_golden_item_label_tombstones header
      //   documents the identical trap for golden items.
      //
      //   KEPT VERBATIM it is worse in a quieter way: its query has no
      //   lifecycle filter, so `remaining` is every row, still dense, and
      //   each update writes the index the row already holds — a silent
      //   no-op whose `remaining.length` then becomes a stored ROW count in
      //   `sampleCount` and in the response body.
      //
      // Ordinals are simply no longer dense. `index` guarantees only
      // uniqueness within the dataset and monotonic insertion order; the next
      // one is a high-water mark (`nextSampleIndex`, src/lib/tombstones.ts),
      // never a count and never a reused ordinal.

      // `sampleCount` becomes a LIVE count — and the response body reads the
      // same value, so the two move together. Both used to come from
      // `remaining.length`, the length of the re-index read, which is a ROW
      // count: on a corpus carrying any hidden row it over-reports. The UI
      // ladder reads the stored `sampleCount` FIRST, so a stale value shadows
      // the live count beneath it — the import picker advertises 620 and the
      // import yields 610.
      const remaining = await tx.datasetSample.count({
        where: { datasetId: params.id, ...liveSamplesOnly() },
      });

      await tx.dataset.update({
        where: { id: params.id },
        data: { sampleCount: remaining },
      });

      // `deleted` is renamed to `tombstoned`, matching what A0 did to the
      // sibling endpoint (golden-sets/[id]/items/route.ts:313). Nothing is
      // deleted here any more, and `deleted` is the one word that would let a
      // caller conclude the row is gone. No client reads the key — the only
      // caller in the tree, src/app/datasets/[id]/page.tsx:332-357, checks
      // `res.ok` and `data.error` and nothing else — so an external script
      // gets `undefined`, a loud break rather than a quiet lie.
      //
      // The counting rule differs from the golden-items route ON PURPOSE:
      // `tombstoneSamples` returns the number of DISTINCT ids NOW HIDDEN, so a
      // repeated delete reports `tombstoned: 1`, whereas golden-items'
      // `updateMany … tombstonedAt: null` reports 0 on the retry
      // (tests/db/golden-sets.test.ts:1123). "Now hidden" is the property this
      // handler converges on.
      return { tombstoned, remaining };
    });

    return NextResponse.json(result);
```

Leave the `catch` block below untouched: this task adds no new error class, so the existing `z.ZodError` arm and the 500 fallback are still exactly right.

- [ ] **Step 8: Run both files and watch them pass**

Run:

```bash
sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.db.config.ts tests/db/dataset-sample-tombstone.test.ts tests/db/dataset-sample-freeze.test.ts'
```

Expected: `Test Files 2 passed (2)` / `Tests 15 passed (15)` — the 5 new cases plus the 10 in `dataset-sample-freeze.test.ts`, including its three 409 guard tests, which this task did not touch.

- [ ] **Step 9: Demonstrate discrimination — put the re-index loop back, adapted, and watch it P2002**

Record the baseline first:

```bash
sha256sum 'src/app/api/datasets/[id]/samples/route.ts'
```

Now temporarily insert, immediately after the `tombstoneSamples(…)` call inside the transaction, the "adapted" loop this task exists to prevent:

```ts
      const survivors = await tx.datasetSample.findMany({
        where: { datasetId: params.id, ...liveSamplesOnly() },
        orderBy: { index: 'asc' },
        select: { id: true },
      });
      for (let i = 0; i < survivors.length; i++) {
        await tx.datasetSample.update({ where: { id: survivors[i].id }, data: { index: i } });
      }
```

Run:

```bash
sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.db.config.ts tests/db/dataset-sample-tombstone.test.ts -t "does NOT re-index the survivors"'
```

Expected: FAIL with `AssertionError: expected 500 to be 200`. The renumber of the row at index 1 down to 0 collides with the hidden row still holding 0, Postgres raises P2002 on `DatasetSample_datasetId_index_key`, the transaction rolls back and the catch reports a generic 500 — the exact failure mode the comment names, reproduced.

Delete the loop, re-run to green, re-run `sha256sum` and confirm it matches the baseline byte for byte. Put both hashes and the failure text in the task report.

- [ ] **Step 10: Demonstrate discrimination — unfilter the `remaining` count and watch it become a row count**

Temporarily change the count's `where` to `{ datasetId: params.id }` (drop the `...liveSamplesOnly()`).

Run:

```bash
sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.db.config.ts tests/db/dataset-sample-tombstone.test.ts -t "reports a LIVE remaining count"'
```

Expected: FAIL with

```
AssertionError: expected { tombstoned: 1, remaining: 4 } to deeply equal { tombstoned: 1, remaining: 2 }
```

4 is the row count — the pre-existing hidden row and the one just hidden are both counted. Note that on a tombstone-free fixture this edit would be invisible, which is why the fixture carries a hidden row before the verb runs.

Restore the filter, re-run to green, re-run `sha256sum` and confirm it matches the step 9 baseline. Record it.

- [ ] **Step 11: Typecheck and lint**

Run: `npx tsc --noEmit && npm run lint`

Expected: both silent. If `tsc` reports `Property 'tombstone' does not exist on type …`, the Prisma client is stale — re-run `DATABASE_URL="postgresql://judge_arena:password@localhost:5432/judge_arena" npx prisma generate`.

- [ ] **Step 12: Run the full DB suite**

Run: `npm run test:db`

Expected: `Test Files 36 passed (36)` / `Tests 450 passed (450)` — 445 and 35 files entering this task, plus the 5 new cases in the one new file. The freeze-test rewrite is one `it` for one `it`, so it moves nothing.

Then the DB coverage gate. This is the first task on the branch where `src/lib/tombstones.ts` actually executes under the DB run, so the number moves **up**, not down:

Run: `npm run test:db:coverage`

Expected: green, every floor cleared (lines 47, functions 60, branches 77, plus the two per-glob entries). `src/lib/tombstones.ts` entered the previous task's report as an uncovered file contributing its lines to the denominator; it is now exercised. **Never lower a floor.** If actuals moved materially, update only the "Actuals as of" prose per the threshold policy at `vitest.db.config.ts:42-148`, and remember this suite's branch column jitters ±2 branches run to run with no code change — if you land within a point of a floor, measure at least three times and take the lowest.

- [ ] **Step 13: Run the unit and integration suites**

Run: `npm test`

Expected: `Test Files 35 passed (35)` / `Tests 490 passed (490)` — unchanged; this task adds no unit test and `src/app/api/**` is outside every coverage `include`.

Run: `npm run test:integration`

Expected: `Tests 80 passed (80)` — unchanged.

- [ ] **Step 14: Commit**

```bash
git add 'src/app/api/datasets/[id]/samples/route.ts' \
        tests/db/dataset-sample-tombstone.test.ts \
        tests/db/dataset-sample-freeze.test.ts

git commit -m "feat(a1): DELETE samples hides the rows and stops re-indexing them

The handler hard-deleted the named rows and then renumbered every survivor
0..n-1. It now upserts a Tombstone per id inside one transaction, and the
rows stay on disk with their ordinals — which is what lets an annotated
corpus shed a bad row at all, since GoldenItem.sourceDatasetSampleId is
onDelete: Restrict and a hard delete either fails or takes the annotation.

The re-index loop is DELETED, not adapted, and the comment names both
failure modes because each looks plausible. Adapted to live rows it
renumbers the first survivor to 0 and collides with the hidden row still
holding 0 — @@unique([datasetId, index]) is not partial, a tombstone frees
no ordinal — so P2002 and every delete 500s. Kept verbatim it is a silent
no-op whose remaining.length becomes a stored ROW count.

sampleCount becomes a live count, and the response body reads the same
value, so the two move together. The stored count is what the UI ladder
reads first, so a row count there shadows the live count beneath it.

The membership lookup stays UNFILTERED with a comment saying why: an
already-hidden id still belongs to this dataset, so a retried delete
converges on hidden instead of 400ing as though the id were foreign. It is
also what turns a genuinely foreign id into a 400 rather than the P2003
tombstoneSamples raises deliberately. Same rule as the golden-item lookup
at golden-sets/[id]/items/route.ts:290-296.

deleted is renamed to tombstoned, matching what A0 did to that sibling
endpoint. Nothing is deleted here any more and no client reads the key —
datasets/[id]/page.tsx checks res.ok and nothing else — so an external
caller gets a loud undefined rather than a quiet lie. The counting rule
differs on purpose: tombstoneSamples reports ids NOW hidden, so a retry
says 1 where golden-items says 0.

The pin guard stays; only its two now-false sentences and the re-index
clause in its 409 copy are corrected. dataset-sample-freeze.test.ts
asserted count() -> 0, which is satisfied by exactly the behaviour this
removes, so it is inverted rather than adjusted.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `POST /api/datasets/[id]/samples` appends above the high-water mark

**Files:**
- Modify: `src/app/api/datasets/[id]/samples/route.ts:1-7` (one new type-only import; widen the `@/lib/tombstones` line Task 3 added)
- Modify: `src/app/api/datasets/[id]/samples/route.ts:44-47` (comment the guard read's `_count`, leaving the query itself unchanged)
- Modify: `src/app/api/datasets/[id]/samples/route.ts:59-78` (`startIndex`, the create transaction and the `sampleCount` write)
- Modify/Test: `tests/db/dataset-sample-tombstone.test.ts` — widen the route import, then append one `describe` at the end of the file

> **Line numbers are against the pre-A1 tree (`f26165c`) except where noted.** The task before this one edits `DELETE`, which sits *below* everything you touch here, so the POST numbers above are still exact — but the import block gained one line, so `@/lib/golden-sets` is now at `:7`. Verify the quoted text before replacing anything.

**Interfaces:**
- Consumes (from `src/lib/tombstones.ts`, defined in Task 2 and imported by name):
  - `nextSampleIndex(tx: Prisma.TransactionClient, datasetId: string): Promise<number>` — `max(index)` over **all** rows of the dataset including hidden ones, `+ 1`; `0` for an empty dataset. Its own read is deliberately unfiltered. **Must be called with the same `tx` as the inserts it feeds.**
  - `liveSamplesOnly(): Prisma.DatasetSampleWhereInput` — returns `{ NOT: { tombstone: { is: { isTombstone: true } } }, dataset: { NOT: { tombstone: { is: { isTombstone: true } } } } }`, a fresh object per call, meant to be **spread** into a `where`
- Consumes (already in the tree): `db`, `mkUser`, `truncateAll` from `tests/db/helpers.ts`; the `mkCorpus` / `jsonRequest` / `mockSessionFor` helpers at the top of `tests/db/dataset-sample-tombstone.test.ts`, created by the previous task
- Produces: no new exported names. The behavioural contract later tasks rely on — `POST /api/datasets/[id]/samples` answers `201 { added: number; samples: DatasetSample[] }`, the created rows occupy `max(index over ALL rows) + 1 …`, and `Dataset.sampleCount` is a **live** count taken after the inserts.

**Why a count is the wrong `startIndex`, and what actually breaks.** `dataset._count.samples` is only ever right while ordinals are dense, and they stop being dense the first time anything is hidden. But the case that *bites* is not a freshly-appended corpus: `_count` is unfiltered, so there `count == max + 1` and nothing collides — which is exactly why a naive test passes against unchanged code and proves nothing. Gaps arrive from a corpus **re-imported from a filtered export**: `src/lib/config.ts:389` emits `index: s.index` verbatim and the importer writes it back, so the rows land with holes, `count < max + 1`, and the first append collides on `@@unique([datasetId, index])`. The fixture below therefore has holes *and* a hidden tail — the tail because `count()`, `max` over live rows and `max` over all rows all agree until the tail is hidden.

---

- [ ] **Step 1: Write the failing tests — append one `describe` to `tests/db/dataset-sample-tombstone.test.ts`**

First widen that file's route import. It currently reads:

```ts
import { DELETE as deleteSamples } from '@/app/api/datasets/[id]/samples/route';
```

Replace it with:

```ts
import { DELETE as deleteSamples, POST as addSamples } from '@/app/api/datasets/[id]/samples/route';
```

Then append after the file's final `});`:

```ts
// ─── A1 Task 4: POST appends above the high-water mark ──────────────────────
// New samples land at max(index) over ALL rows including hidden, + 1. Never a
// count: a tombstone frees no ordinal, so the count and the high-water mark
// diverge the moment anything is hidden OR the moment the corpus arrives with
// gaps from a filtered re-import.
describe('POST /api/datasets/[id]/samples — the high-water mark (A1 Task 4)', () => {
  beforeEach(async () => {
    await truncateAll();
    (getServerSession as unknown as Mock).mockReset();
  });

  it('appends above max(index) over ALL rows on a GAPPED corpus with a hidden tail', async () => {
    const user = await mkUser();
    mockSessionFor(user);

    // Indices 0, 1, 3, 4 — a HOLE at 2. This is what a corpus re-imported from
    // a filtered export looks like: src/lib/config.ts:389 emits
    // `index: s.index` verbatim and the importer writes it back, so the rows
    // arrive with gaps and count < max + 1. A freshly-appended corpus has
    // count == max + 1 and NOTHING collides, which is why this bug is
    // invisible without this shape and why a test over a dense corpus would
    // pass against the unchanged handler.
    const dataset = await mkCorpus(user.id, [0, 1, 3, 4]);

    // …and the TAIL is hidden, which is what defeats the other two wrong
    // formulations. With the tail live, count(), max over live rows and max
    // over all rows all agree, and only the unfiltered-count bug shows.
    await db.tombstone.create({
      data: {
        datasetSampleId: dataset.samples[3].id,
        isTombstone: true,
        reason: 'deleted by hand',
      },
    });

    // Every wrong formulation lands on an OCCUPIED ordinal here:
    //   unfiltered count()   = 4  -> index 4 is taken   (this is the old code)
    //   live count()         = 3  -> index 3 is taken
    //   max over LIVE  + 1   = 4  -> index 4 is taken
    //   max over ALL   + 1   = 5  -> free. This is the rule.
    const res = await addSamples(
      jsonRequest(`http://localhost/api/datasets/${dataset.id}/samples`, 'POST', {
        samples: [{ input: 'appended one' }, { input: 'appended two' }],
      }),
      { params: Promise.resolve({ id: dataset.id }) }
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.added).toBe(2);
    expect(body.samples.map((s: { index: number }) => s.index)).toEqual([5, 6]);

    const rows = await db.datasetSample.findMany({
      where: { datasetId: dataset.id },
      orderBy: { index: 'asc' },
    });
    // The hole at 2 stays a hole. `index` is not a position into the live
    // array and nothing back-fills it — its only guarantees are uniqueness
    // within the dataset and monotonic insertion order.
    expect(rows.map((r) => r.index)).toEqual([0, 1, 3, 4, 5, 6]);

    // The hidden tail is untouched: still on disk, still hidden, still holding
    // ordinal 4.
    const tail = await db.datasetSample.findUnique({ where: { id: dataset.samples[3].id } });
    expect(tail?.index).toBe(4);
    const tomb = await db.tombstone.findUnique({
      where: { datasetSampleId: dataset.samples[3].id },
    });
    expect(tomb?.isTombstone).toBe(true);
  });

  it('stores a LIVE sampleCount, not startIndex + n and not a row count', async () => {
    const user = await mkUser();
    mockSessionFor(user);

    // A dense corpus with a hidden HEAD this time, so the append itself
    // succeeds even against the unchanged handler. That isolates the count
    // from the ordinal: this test fails on exactly one assertion, and it is
    // the one about sampleCount.
    const dataset = await mkCorpus(user.id, [0, 1, 2]);
    await db.tombstone.create({
      data: {
        datasetSampleId: dataset.samples[0].id,
        isTombstone: true,
        reason: 'deleted by hand',
      },
    });

    const res = await addSamples(
      jsonRequest(`http://localhost/api/datasets/${dataset.id}/samples`, 'POST', {
        samples: [{ input: 'appended one' }, { input: 'appended two' }],
      }),
      { params: Promise.resolve({ id: dataset.id }) }
    );
    expect(res.status).toBe(201);
    expect((await res.json()).samples.map((s: { index: number }) => s.index)).toEqual([3, 4]);

    // Five rows on disk, four of them live. `startIndex + n` is 3 + 2 = 5 —
    // the ROW count, which is what the replaced line stored, and the number
    // the UI ladder would then read FIRST and display over the live count
    // beneath it.
    await expect(db.datasetSample.count({ where: { datasetId: dataset.id } })).resolves.toBe(5);
    await expect(
      db.datasetSample.count({ where: { datasetId: dataset.id, ...liveSamplesOnly() } })
    ).resolves.toBe(4);

    const after = await db.dataset.findUnique({
      where: { id: dataset.id },
      select: { sampleCount: true },
    });
    expect(after?.sampleCount).toBe(4);
  });
});
```

- [ ] **Step 2: Run the two tests and watch them fail**

Run:

```bash
sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.db.config.ts tests/db/dataset-sample-tombstone.test.ts'
```

Expected: **2 failed**, the five cases from the previous task still green.

- `appends above max(index) over ALL rows on a GAPPED corpus with a hidden tail` — FAIL with
  `AssertionError: expected 500 to be 201`.
  That 500 is the real thing: `startIndex = dataset._count.samples` is 4, the first insert lands on the occupied ordinal 4, Postgres raises P2002 on `DatasetSample_datasetId_index_key`, and the catch reports `{ error: 'Failed to add samples' }`.
- `stores a LIVE sampleCount, not startIndex + n and not a row count` — FAIL with
  `AssertionError: expected 5 to be 4`.
  The append succeeds here (this fixture is dense, so count and max + 1 agree at 3); only the stored count is wrong.

- [ ] **Step 3: Widen the route's imports**

In `src/app/api/datasets/[id]/samples/route.ts`, the previous task left an import line reading `import { liveSamplesOnly, tombstoneSamples } from '@/lib/tombstones';`. Widen it in place — do **not** add a second statement for the same module:

```ts
import { liveSamplesOnly, nextSampleIndex, tombstoneSamples } from '@/lib/tombstones';
```

Then add a type-only import for the created rows' element type. Insert it immediately after `import { prisma } from '@/lib/db';` (line 2), matching the placement used in `src/app/api/datasets/route.ts:3`:

```ts
import type { DatasetSample } from '@prisma/client';
```

- [ ] **Step 4: Comment the guard read's `_count` as deliberately unfiltered**

Replace `:44-47` — the guard read — with the same query under a comment. The query itself is **byte-identical**; only the comment is new:

```ts
    const dataset = await prisma.dataset.findUnique({
      where: { id: params.id },
      // `_count.samples` is UNFILTERED and stays that way. Do not spread
      // `liveSamplesOnly()` into it.
      //
      // The instinct this comment exists to stop is "sampleCount became a live
      // count, so filter this too" — and the step straight after that is
      // re-deriving `startIndex` from it, which is the exact formulation that
      // collides: hide sample 0 of 3 and a live count says 2 while index 2 is
      // occupied, so the very first insert P2002s on
      // @@unique([datasetId, index]). A tombstone frees no ordinal.
      //
      // Be clear about what this value is NOT: since A1 it is no longer the
      // ordinal source. `nextSampleIndex` below is, and it does its own
      // unfiltered read inside the insert transaction, which is where the
      // race-free high-water mark has to be read anyway. Nothing in this
      // handler consumes `_count.samples` any more; it is kept as the site
      // this disposition attaches to, and it is deliberately NOT one of the
      // `_count.samples` producers the rest of A1 filters — those all feed a
      // displayed total, and this one feeds nothing.
      select: { userId: true, _count: { select: { samples: true } } },
    });
```

- [ ] **Step 5: Move the ordinal read into the insert transaction and make `sampleCount` live**

Replace `:59-78` — everything from `const startIndex = dataset._count.samples;` through the closing `});` of the `prisma.dataset.update` — with:

```ts
    // A1: the high-water read and the inserts it feeds are ONE transaction,
    // and so is the count they leave behind. Before this, the creates were an
    // array-form $transaction and the count update was a separate round trip
    // after it.
    //
    // `nextSampleIndex` is max(index) over ALL rows INCLUDING HIDDEN, + 1. It
    // takes this callback's `tx` for the same reason `nextGoldenItemIndex`
    // does (src/lib/golden-sets.ts): a read-then-insert across a commit
    // boundary races a concurrent append, and the loser gets P2002 on
    // @@unique([datasetId, index]).
    //
    // This replaces `startIndex = dataset._count.samples`. A count is only
    // right while ordinals are dense, and they stop being dense the first time
    // anything is hidden — but the case that actually BITES is not a
    // tombstoned corpus, because `_count` is unfiltered and there
    // count == max + 1 so nothing collides. It bites on a corpus RE-IMPORTED
    // FROM A FILTERED EXPORT: src/lib/config.ts:389 emits `index: s.index`
    // verbatim and the importer writes it back, so the rows arrive with GAPS,
    // count < max + 1, and the first append lands on an occupied ordinal.
    const created = await prisma.$transaction(async (tx) => {
      const startIndex = await nextSampleIndex(tx, params.id);

      const rows: DatasetSample[] = [];
      for (let i = 0; i < data.samples.length; i++) {
        const s = data.samples[i];
        rows.push(
          await tx.datasetSample.create({
            data: {
              datasetId: params.id,
              index: startIndex + i,
              input: s.input,
              expected: s.expected ?? undefined,
              metadata: s.metadata ? JSON.stringify(s.metadata) : undefined,
            },
          })
        );
      }

      // `sampleCount` becomes a LIVE count. It was
      // `startIndex + data.samples.length`, which is the row count exactly
      // while ordinals are dense and drifts the moment `startIndex` is a
      // high-water mark: append 2 rows onto a 4-row corpus with a hole and a
      // hidden row and it stores 7 where the live answer is 5. The UI ladder
      // reads the stored value FIRST, so a wrong one shadows the live count
      // beneath it — the import picker advertises 620 and the import yields
      // 610.
      const live = await tx.datasetSample.count({
        where: { datasetId: params.id, ...liveSamplesOnly() },
      });

      await tx.dataset.update({
        where: { id: params.id },
        data: { sampleCount: live },
      });

      return rows;
    });
```

The `return NextResponse.json({ added: created.length, samples: created }, { status: 201 });` below is unchanged — `created` is still the array of created rows, in insertion order, and `addSamplesSchema` still requires at least one sample so the loop always runs at least once.

- [ ] **Step 6: Run the file and watch it pass**

Run:

```bash
sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.db.config.ts tests/db/dataset-sample-tombstone.test.ts'
```

Expected: `Test Files 1 passed (1)` / `Tests 7 passed (7)` — the five DELETE cases plus the two added here.

- [ ] **Step 7: Demonstrate discrimination — put the count back as `startIndex` and watch the gapped corpus collide**

Record the baseline first:

```bash
sha256sum 'src/app/api/datasets/[id]/samples/route.ts'
```

Temporarily replace `const startIndex = await nextSampleIndex(tx, params.id);` with `const startIndex = dataset._count.samples;`.

Run:

```bash
sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.db.config.ts tests/db/dataset-sample-tombstone.test.ts -t "appends above max"'
```

Expected: FAIL with `AssertionError: expected 500 to be 201` — the count is 4, index 4 is occupied by the hidden tail, P2002 rolls the transaction back and the catch reports a generic 500.

Now, still in the broken state, confirm the *other* half of the argument — that a live count is no better. Change it to:

```ts
      const startIndex = await tx.datasetSample.count({
        where: { datasetId: params.id, ...liveSamplesOnly() },
      });
```

Re-run the same command. Expected: FAIL with the same `expected 500 to be 201` — the live count is 3 and index 3 is occupied too. This is why the helper is a high-water mark and not either count.

Restore `nextSampleIndex`, re-run to green, re-run `sha256sum` and confirm it matches the baseline byte for byte. Put both hashes and both failure texts in the task report.

- [ ] **Step 8: Demonstrate discrimination — put `startIndex + n` back and watch the stored count drift**

Temporarily replace `data: { sampleCount: live },` with `data: { sampleCount: startIndex + data.samples.length },`.

Run:

```bash
sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.db.config.ts tests/db/dataset-sample-tombstone.test.ts -t "stores a LIVE sampleCount"'
```

Expected: FAIL with `AssertionError: expected 5 to be 4`. Note that the first test in the describe still passes under this edit — the ordinal and the count are independent bugs, which is why they get independent fixtures.

Restore, re-run to green, re-run `sha256sum` and confirm it matches the step 7 baseline. Record it.

- [ ] **Step 9: Typecheck and lint**

Run: `npx tsc --noEmit && npm run lint`

Expected: both silent. If `tsc` reports `Type 'any[]' is not assignable` or an implicit-any on `rows`, the `import type { DatasetSample } from '@prisma/client';` line from step 3 is missing.

- [ ] **Step 10: Run the full DB suite**

Run: `npm run test:db`

Expected: `Test Files 36 passed (36)` / `Tests 452 passed (452)` — 450 entering this task plus the 2 added here, in the same 36 files.

No other DB test drives `POST /api/datasets/[id]/samples`: `grep -rn "datasets/\[id\]/samples" tests/` returns three files, and the other two import only `PUT` (`tests/db/config-golden-sets.test.ts:7`) or merely mention the path in a test name (`tests/db/golden-sets.test.ts:744`).

Run: `npm run test:db:coverage`

Expected: green, every floor cleared. **Never lower a floor**; this suite's branch column jitters ±2 branches run to run with no code change, so if you land within a point of a floor, measure at least three times and take the lowest.

- [ ] **Step 11: Run the unit and integration suites**

Run: `npm test`

Expected: `Test Files 35 passed (35)` / `Tests 490 passed (490)` — unchanged.

Run: `npm run test:integration`

Expected: `Tests 80 passed (80)` — unchanged.

- [ ] **Step 12: Commit**

```bash
git add 'src/app/api/datasets/[id]/samples/route.ts' tests/db/dataset-sample-tombstone.test.ts

git commit -m "feat(a1): POST appends samples above the high-water mark, in one transaction

startIndex was dataset._count.samples. A count is only right while ordinals
are dense, and a tombstone frees no ordinal — @@unique([datasetId, index])
is not partial — so the count and the next free index diverge. It is now
nextSampleIndex(tx, id): max(index) over ALL rows including hidden, + 1,
read INSIDE the same transaction as the inserts it feeds, for the same
reason nextGoldenItemIndex takes the caller's tx. A read-then-insert across
a commit boundary races a concurrent append and the loser gets P2002.

The case that actually bites is not a tombstoned corpus. Prisma's _count is
unfiltered, so there count == max + 1 and nothing collides — which is why a
test over a freshly-appended corpus passes against the unchanged handler and
proves nothing. It bites on a corpus re-imported from a filtered export:
config.ts:389 emits index: s.index verbatim and the importer writes it back,
so the rows arrive with gaps. The fixture is therefore a GAPPED corpus with
a hidden TAIL, which is the one shape where an unfiltered count, a live
count and max-over-live all land on an occupied ordinal and only
max-over-all is free.

sampleCount becomes a live count taken after the inserts. startIndex + n was
the row count exactly while ordinals were dense and drifts the moment
startIndex is a high-water mark, and the UI ladder reads the stored value
first, so a wrong one shadows the live count beneath it.

The guard read's _count.samples stays UNFILTERED and gains a comment saying
so. It is no longer the ordinal source, but filtering it is the first step
of a change whose second step is re-deriving startIndex from it, which is
precisely the collision this commit removes.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

---

### Task 5: `PUT /api/datasets/[id]/samples` becomes tombstone-and-append, and its response read is filtered

**Files:**
- Modify: `src/app/api/datasets/[id]/samples/route.ts:1-6` (the import block) and `:285-349` (the PUT pin-guard comment and the whole `$transaction` callback)
- Modify/Test: `tests/db/dataset-sample-freeze.test.ts:136-156` (rewrite in place) and the end of the file (append one new `describe`)

> **Line numbers are against the pre-A1 tree (`f26165c`).** Earlier tasks in this plan edit `samples/route.ts` *above* the PUT handler, so the numbers drift downward. Anchor on the quoted code in each step, never on the number.

**Why this verb matters more than the others.** `PUT` is the destroying-est verb in the product: today it hard-deletes *every* sample of the dataset (`:319`) and recreates the incoming document at indices `0..n-1` (`:336`). Decision 11 converts it to tombstone-and-append **on drafts as well as published datasets** — deliberately, because otherwise "datasets stop destroying data" is false for exactly the verb that destroys the most.

**Blast radius — this is also the revert path.** `src/app/datasets/[id]/page.tsx:416-435` (`revertToVersion`) fetches a version's samples and `PUT`s them at this handler. So after this task, "revert to version N" hides the current rows and appends N's content above the high-water mark, rather than deleting the current rows. That is the intended behaviour; the ids the client sees after a revert are new ids either way, so the page needs no change.

**Interfaces:**
- Consumes (from `src/lib/tombstones.ts`):
  - `liveSamplesOnly(): Prisma.DatasetSampleWhereInput`
  - `tombstoneSamples(tx: Prisma.TransactionClient, datasetSampleIds: string[], reason?: string): Promise<number>`
  - `nextSampleIndex(tx: Prisma.TransactionClient, datasetId: string): Promise<number>`
- Consumes (already in the tree): `findGoldenSetsPinningDataset(client: Prisma.TransactionClient, datasetId: string): Promise<{ id: string; name: string }[]>` from `src/lib/golden-sets.ts`; `db`, `mkUser`, `truncateAll` from `tests/db/helpers.ts`
- Produces: no new exported names. The behavioural contract later tasks rely on — `PUT /api/datasets/[id]/samples` answers `200 { replaced: number; samples: DatasetSample[] }` where **`samples` is the LIVE set only** and `replaced === samples.length === data.samples.length`; `Dataset.sampleCount` is left equal to `data.samples.length`.

**Do NOT remove the golden-set pin guard.** Now that nothing is deleted, `GoldenItem.sourceDatasetSampleId`'s `Restrict` FK is no longer what refuses — so the guard looks vestigial and it is not. Retiring it belongs to Plan B (the lifecycle), and `tests/db/dataset-sample-freeze.test.ts` pins the 409 in three separate tests, one of which uses a golden set whose items are themselves tombstoned. This task only corrects the guard's now-false comment.

---

- [ ] **Step 1: Rewrite the happy-path test at `tests/db/dataset-sample-freeze.test.ts:136`**

This test currently asserts hard deletion by raw row count (`rows` expects 1, will get 2) and `body.replaced` expects 1. Replace the whole `it(...)` block — from `it('still replaces samples when no golden set pins the dataset', async () => {` through its closing `});` — with:

```ts
  it('still replaces samples when no golden set pins the dataset — by HIDING the outgoing row, not destroying it', async () => {
    const user = await mkUser();
    mockSessionFor(user);
    const { dataset, sample } = await mkDatasetWithSample(user.id);

    const res = await PUT(
      jsonRequest(`http://localhost/api/datasets/${dataset.id}/samples`, 'PUT', {
        samples: [{ input: 'replacement' }],
      }),
      { params: Promise.resolve({ id: dataset.id }) }
    );

    expect(res.status).toBe(200);
    const body = await res.json();

    // The response read is FILTERED. Unfiltered it answers with the row it
    // just hid: `replaced: 2` over a one-row corpus, and a hidden row handed
    // back to the client as though it were live.
    expect(body.replaced).toBe(1);
    expect(body.samples).toHaveLength(1);
    expect(body.samples[0].input).toBe('replacement');
    expect(body.samples[0].id).not.toBe(sample.id);

    // …and nothing was destroyed. The old assertion here was
    // `expect(rows).toHaveLength(1)`, which passes under a hard delete — the
    // exact behaviour this task removes — so it is inverted rather than
    // adjusted: 2 rows on disk, one of them the ORIGINAL id, which is the id
    // any golden item would cite.
    const rows = await db.datasetSample.findMany({
      where: { datasetId: dataset.id },
      orderBy: { index: 'asc' },
    });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.id)).toContain(sample.id);
    // Appended ABOVE the high-water mark: index 1, not 0. Recreating at 0
    // collides with the hidden row that still holds 0 (@@unique([datasetId,
    // index]), prisma/schema.prisma).
    expect(rows.map((r) => r.index)).toEqual([0, 1]);
    expect(rows[1].input).toBe('replacement');

    const tomb = await db.tombstone.findUnique({ where: { datasetSampleId: sample.id } });
    expect(tomb?.isTombstone).toBe(true);

    // `sampleCount` is a LIVE count and is already correct here: after
    // tombstone-and-append the live set IS the incoming document.
    const after = await db.dataset.findUnique({
      where: { id: dataset.id },
      select: { sampleCount: true },
    });
    expect(after?.sampleCount).toBe(1);
  });
```

- [ ] **Step 2: Append the two discriminating cases at the END of `tests/db/dataset-sample-freeze.test.ts`**

Append after the file's final `});` (do not insert them earlier — other tasks in this plan anchor on the existing blocks above):

```ts
// ─── A1 Task 5: PUT is tombstone-and-append ─────────────────────────────────
// Decision 11. Bulk replace hides the outgoing rows and appends the incoming
// document above the high-water mark — on drafts as well as published corpora,
// because otherwise the verb that destroys the most is the one still doing it.
// This handler is also the revert path: src/app/datasets/[id]/page.tsx:416-435
// PUTs a target version's samples here.
describe('PUT /api/datasets/[id]/samples — tombstone-and-append (A1 Task 5)', () => {
  beforeEach(async () => {
    await truncateAll();
    (getServerSession as unknown as Mock).mockReset();
  });

  it('counts only the LIVE set when the corpus already carries a hidden row, and leaves that row alone', async () => {
    const user = await mkUser();
    mockSessionFor(user);
    const { dataset, sample: live } = await mkDatasetWithSample(user.id);

    // The fixture carries a tombstone BEFORE the verb runs. Without that, the
    // filtered and the unfiltered formulations return the same number and
    // every assertion below passes vacuously — the spec's Testing shapes 1
    // ("the overlay hides rows") and 5 ("the sampleCount writes"). It is also
    // a TAIL row (index 1, the max), which is what makes the high-water
    // assertion bite: with the tail live, count(), max over live and max over
    // all agree.
    const alreadyHidden = await db.datasetSample.create({
      data: { datasetId: dataset.id, index: 1, input: 'an earlier question', expected: 'B>A' },
    });
    await db.tombstone.create({
      data: { datasetSampleId: alreadyHidden.id, isTombstone: true, reason: 'deleted by hand' },
    });

    const res = await PUT(
      jsonRequest(`http://localhost/api/datasets/${dataset.id}/samples`, 'PUT', {
        samples: [{ input: 'first replacement' }, { input: 'second replacement' }],
      }),
      { params: Promise.resolve({ id: dataset.id }) }
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    // Four rows will exist; exactly two are live. An unfiltered response read
    // reports `replaced: 4` and hands back two hidden rows.
    expect(body.replaced).toBe(2);
    expect(body.samples.map((s: { input: string }) => s.input)).toEqual([
      'first replacement',
      'second replacement',
    ]);

    const rows = await db.datasetSample.findMany({
      where: { datasetId: dataset.id },
      orderBy: { index: 'asc' },
    });
    expect(rows).toHaveLength(4);
    // The high-water mark is max(index) over ALL rows — including the hidden
    // one at 1 — so the incoming pair lands at 2 and 3. Derived from a live
    // count() it would be 1, and the first insert would collide.
    expect(rows.map((r) => r.index)).toEqual([0, 1, 2, 3]);

    // The outgoing read is filtered, so the already-hidden row is not
    // re-tombstoned. Re-tombstoning it would overwrite the record of why it
    // went away with this replace's reason.
    const untouched = await db.tombstone.findUnique({
      where: { datasetSampleId: alreadyHidden.id },
    });
    expect(untouched?.reason).toBe('deleted by hand');

    // The row that WAS live is now hidden.
    const hidden = await db.tombstone.findUnique({ where: { datasetSampleId: live.id } });
    expect(hidden?.isTombstone).toBe(true);

    // Live count, not row count: 2, not 4.
    const after = await db.dataset.findUnique({
      where: { id: dataset.id },
      select: { sampleCount: true },
    });
    expect(after?.sampleCount).toBe(2);
  });

  it('hides an UN-DELETED row too — a tombstone row with isTombstone: false is live', async () => {
    // Every other fixture in this file hides rows with `isTombstone: true`, so
    // an outgoing read written as the simpler `{ tombstone: { is: null } }`
    // passes all of them (spec, Testing shape 2). Here that filter skips this
    // row: it is never tombstoned, so it stays LIVE underneath the
    // replacement and the corpus quietly keeps a row the user replaced away —
    // while the response, filtered the same wrong way, does not show it.
    const user = await mkUser();
    mockSessionFor(user);
    const { dataset, sample } = await mkDatasetWithSample(user.id);
    await db.tombstone.create({
      data: { datasetSampleId: sample.id, isTombstone: false },
    });

    const res = await PUT(
      jsonRequest(`http://localhost/api/datasets/${dataset.id}/samples`, 'PUT', {
        samples: [{ input: 'replacement' }],
      }),
      { params: Promise.resolve({ id: dataset.id }) }
    );

    expect(res.status).toBe(200);
    expect((await res.json()).replaced).toBe(1);

    const tomb = await db.tombstone.findUnique({ where: { datasetSampleId: sample.id } });
    expect(tomb?.isTombstone).toBe(true);
    // Converged rather than duplicated: one row per entity, upserted on a
    // @unique FK, never P2002.
    expect(await db.tombstone.count({ where: { datasetSampleId: sample.id } })).toBe(1);
  });
});
```

- [ ] **Step 3: Run the three tests and watch them fail**

Run: `sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.db.config.ts tests/db/dataset-sample-freeze.test.ts'`

Expected: 3 failed, the rest of the file green.
- `still replaces samples when no golden set pins the dataset — by HIDING the outgoing row, not destroying it` — FAIL with `AssertionError: expected [ { …(7) } ] to have a length of 2 but got 1` (the handler deleted the outgoing row instead of hiding it).
- `counts only the LIVE set when the corpus already carries a hidden row, and leaves that row alone` — FAIL with `AssertionError: expected [ { …(7) }, { …(7) } ] to have a length of 4 but got 2` (the `deleteMany` removed both originals, and `Tombstone.datasetSampleId` is `onDelete: Cascade`, so the hidden row's tombstone went with it).
- `hides an UN-DELETED row too — a tombstone row with isTombstone: false is live` — FAIL with `AssertionError: expected undefined to be true` (the tombstone row cascaded away with the sample, so `findUnique` returns `null`).

- [ ] **Step 4: Import the overlay helpers into the route**

In `src/app/api/datasets/[id]/samples/route.ts`, the import block currently ends at line 6 with `import { findGoldenSetsPinningDataset } from '@/lib/golden-sets';`. The file may already import from `@/lib/tombstones` (earlier tasks in this plan add helpers to the same file) — do not add a second import statement. Ensure exactly one such line exists and that it reads:

```ts
import { liveSamplesOnly, nextSampleIndex, tombstoneSamples } from '@/lib/tombstones';
```

placed immediately after the `@/lib/golden-sets` import.

- [ ] **Step 5: Correct the pin guard's now-false comment (the guard itself stays)**

Replace the comment block above `const pinningGoldenSets = await findGoldenSetsPinningDataset(prisma, params.id);` inside `PUT` — it begins `// A0 (20260812190000_v2d_golden_substrate): GoldenItem.sourceDatasetSampleId` at `:285` and ends `// sample replace.` at `:297` — with:

```ts
    // A0 (20260812190000_v2d_golden_substrate): GoldenItem.sourceDatasetSampleId
    // is `onDelete: Restrict`. A1 made this handler tombstone-and-append, so
    // that FK is no longer what would refuse — nothing is deleted here any
    // more. THE GUARD STAYS ANYWAY, and deliberately: a corpus somebody has
    // annotated must not drift under the annotation, and the replace below
    // hides every live row of it. Retiring this guard belongs to the
    // lifecycle work (Plan B), not to the overlay — do not remove it here.
    // tests/db/dataset-sample-freeze.test.ts pins the 409 three times over,
    // including for a set whose items are themselves tombstoned.
    //
    // The predicate — including why it is NOT lifecycle-filtered — lives in
    // `findGoldenSetsPinningDataset` (src/lib/golden-sets.ts), shared with the
    // three other destructive paths that were missing this guard entirely:
    // DELETE above, DELETE /api/datasets/[id], and the config importer's
    // sample replace.
```

- [ ] **Step 6: Rewrite the transaction as tombstone-and-append with a filtered response read**

Replace the whole block from `    // Atomic: delete old + create new + update count in one transaction` (`:317`) through the closing `    });` of the `$transaction` call (`:347`) with:

```ts
    // Atomic: hide the outgoing rows + append the incoming above the
    // high-water mark + update the live count, in one transaction.
    const newSamples = await prisma.$transaction(async (tx) => {
      // Read the outgoing set FIRST. After the appends below, a dataset-wide
      // read would sweep the rows we are about to create as well.
      //
      // Filtered, so an already-hidden row is not re-tombstoned: `upsert`'s
      // update arm would overwrite the reason recording why it went away with
      // this replace's reason.
      const outgoing = await tx.datasetSample.findMany({
        where: { datasetId: params.id, ...liveSamplesOnly() },
        select: { id: true },
      });

      if (outgoing.length > 0) {
        await tombstoneSamples(tx, outgoing.map((s) => s.id), 'bulk replace');
      }

      // Ordinals are no longer dense. The outgoing rows still hold 0..n-1, so
      // the incoming document appends ABOVE max(index) over ALL rows —
      // including hidden ones — or the first insert collides on
      // @@unique([datasetId, index]). Never `count()`, and read inside this
      // same tx as the inserts it feeds.
      const startIndex = await nextSampleIndex(tx, params.id);

      for (let i = 0; i < data.samples.length; i++) {
        const s = data.samples[i];
        await tx.datasetSample.create({
          data: {
            datasetId: params.id,
            index: startIndex + i,
            input: s.input,
            expected: s.expected ?? undefined,
            metadata: s.metadata ? JSON.stringify(s.metadata) : undefined,
          },
        });
      }

      // LEAVE THIS AS `data.samples.length`. `sampleCount` is a live row
      // count, and after tombstone-and-append the live set IS the incoming
      // document — every prior row was just hidden and every incoming row was
      // just created. This is not the stale-count bug the other verbs have;
      // "fixing" it to count rows would make it wrong.
      await tx.dataset.update({
        where: { id: params.id },
        data: { sampleCount: data.samples.length },
      });

      // FILTERED. Unfiltered this answers with the rows it just hid — a 4-row
      // replace over a 4-row corpus reports `replaced: 8` at the return below
      // and hands the client four hidden rows.
      return tx.datasetSample.findMany({
        where: { datasetId: params.id, ...liveSamplesOnly() },
        orderBy: { index: 'asc' },
      });
    });
```

Note the `if (data.samples.length > 0)` wrapper around the create loop is gone: a zero-iteration `for` is already a no-op, and `samples: []` is a legitimate request meaning "hide everything, append nothing".

- [ ] **Step 7: Run the three tests and watch them pass**

Run: `sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.db.config.ts tests/db/dataset-sample-freeze.test.ts'`
Expected: PASS — every test in the file green, including the three 409 guard tests, which this task did not touch.

- [ ] **Step 8: Run the two other DB files that drive this handler, plus typecheck and lint**

`tests/db/config-golden-sets.test.ts:944` drives `PUT` on an unpinned corpus and asserts only `status === 200`, so it must stay green without edits. Run each and confirm:

Run: `sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.db.config.ts tests/db/config-golden-sets.test.ts'`
Run: `sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.db.config.ts tests/db/dataset-version-samples.test.ts'`
Run: `npx tsc --noEmit`
Run: `npm run lint`

Expected: all four clean. If `config-golden-sets.test.ts` fails at `:867` (`M1: an UNPINNED dataset still has its samples replaced wholesale`), that is the **config importer's** replace, not this handler — a different task owns it; leave it.

- [ ] **Step 9: Demonstrate discrimination on the response filter**

Temporarily delete `...liveSamplesOnly()` from the `return tx.datasetSample.findMany({...})` at the end of the transaction (leaving `where: { datasetId: params.id }`).

Run: `sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.db.config.ts tests/db/dataset-sample-freeze.test.ts'`
Expected: FAIL with `AssertionError: expected 2 to be 1` on `still replaces samples when no golden set pins the dataset` and `AssertionError: expected 4 to be 2` on `counts only the LIVE set…`.

Restore the line, re-run to green, and record the sha256 of the file before and after to confirm it is byte-identical:

Run: `sha256sum 'src/app/api/datasets/[id]/samples/route.ts'`

- [ ] **Step 10: Commit**

```bash
git add 'src/app/api/datasets/[id]/samples/route.ts' tests/db/dataset-sample-freeze.test.ts
git commit -m "feat(a1): PUT bulk replace hides the outgoing rows instead of deleting them

Decision 11. This is the verb that destroyed the most — every sample of the
dataset, on every call — and it is now tombstone-and-append on drafts as
well as published corpora. The outgoing live rows are hidden, the incoming
document is appended above max(index) over ALL rows, and nothing loses the
id a golden item cites. This is the revert path too
(src/app/datasets/[id]/page.tsx:416-435 PUTs here).

The response read at the end of the transaction is filtered, which is not
cosmetic: unfiltered it answers with the rows it just hid, so a 4-row
replace over a 4-row corpus reports replaced: 8 and hands the client four
hidden rows.

sampleCount is deliberately left as data.samples.length and carries a
comment saying so — after tombstone-and-append the live set IS the incoming
document, so it is already the live count and 'fixing' it would break it.

The golden-set pin guard stays. The Restrict FK is no longer what would
refuse, but an annotated corpus must not drift under the annotation and
retiring the guard belongs to the lifecycle work, not the overlay.

dataset-sample-freeze.test.ts:136 asserted hard deletion by raw row count;
it is inverted rather than adjusted, and joined by two fixtures that defeat
vacuity: a corpus already carrying a hidden TAIL row (without which the
filtered and unfiltered counts agree), and an un-deleted row, which is the
only shape that rules out the simpler { tombstone: { is: null } } filter.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: `DELETE /api/datasets/[id]` tombstones the dataset

**Files:**
- Modify: `src/app/api/datasets/[id]/route.ts:1-7` (the import block) and `:165` (the bare `prisma.dataset.delete`)
- Modify/Test: `tests/db/dataset-sample-freeze.test.ts` — rewrite the `it('DELETE /api/datasets/[id] still deletes an unpinned dataset', …)` block (at `:275` in the pre-A1 tree) and add one case after it

> Anchor on the quoted test name, not the line number: an earlier task in this plan rewrites another `it` block higher in the same file.

**What this replaces.** `src/app/api/datasets/[id]/route.ts:165` is a bare `await prisma.dataset.delete({ where: { id: params.id } });`. `Dataset → DatasetSample` is `onDelete: Cascade`, so that one statement takes an entire corpus with it. It becomes a `tombstoneDataset` call.

**The samples: read this before you write a loop.** The prevailing mental model in this file is `onDelete: Cascade` — "deleting the dataset removes the samples" — and it does not apply here, because **nothing is deleted**. Per Decision 16 the samples **inherit** the parent's hidden state through `liveSamplesOnly()`, whose second clause is `dataset: { NOT: { tombstone: { is: { isTombstone: true } } } }`. So every sample of a hidden dataset is already excluded from every filtered read, and **no per-sample tombstone is written**. Writing N sample tombstones here would say what one row already says, and would turn un-hiding the dataset into a second N-row job that can half-succeed. The test below pins **both** halves of this — zero sample tombstones *and* an empty live read — because asserting only "the samples are invisible" passes under a per-sample loop too.

**Interfaces:**
- Consumes (from `src/lib/tombstones.ts`):
  - `tombstoneDataset(tx: Prisma.TransactionClient, datasetId: string, reason?: string): Promise<void>`
  - `liveDatasetsOnly(): Prisma.DatasetWhereInput`
  - `liveSamplesOnly(): Prisma.DatasetSampleWhereInput`
- Consumes (already in the tree): `requireOwnership('dataset', id, session)` and `findGoldenSetsPinningDataset(prisma, id)`; `db`, `mkUser`, `truncateAll` from `tests/db/helpers.ts`
- Produces: no new exported names. The behavioural contract: `DELETE /api/datasets/[id]` answers `200 { success: true }`, the `Dataset` row and all its `DatasetSample` rows **survive on disk**, and exactly one `Tombstone` row exists with `datasetId` set and `isTombstone: true`.

---

- [ ] **Step 1: Add the two test imports**

In `tests/db/dataset-sample-freeze.test.ts`, after `import { DELETE as deleteDataset } from '@/app/api/datasets/[id]/route';` (line 5), add:

```ts
import { liveDatasetsOnly, liveSamplesOnly } from '@/lib/tombstones';
```

- [ ] **Step 2: Rewrite the happy-path test that asserts `db.dataset.count()` → 0**

Replace the whole `it(...)` block beginning `it('DELETE /api/datasets/[id] still deletes an unpinned dataset', async () => {` through its closing `});` with:

```ts
  it('DELETE /api/datasets/[id] HIDES an unpinned dataset instead of destroying it', async () => {
    const user = await mkUser();
    mockSessionFor(user);
    const { dataset, sample } = await mkDatasetWithSample(user.id);

    const res = await deleteDataset(
      new Request(`http://localhost/api/datasets/${dataset.id}`, { method: 'DELETE' }),
      { params: Promise.resolve({ id: dataset.id }) }
    );

    expect(res.status).toBe(200);

    // The old assertion here was `count()` → 0. A tombstone can never satisfy
    // it, and it passed for the wrong reason anyway: it is equally satisfied
    // by cascading an annotated corpus away.
    await expect(db.dataset.count({ where: { id: dataset.id } })).resolves.toBe(1);
    const tomb = await db.tombstone.findUnique({ where: { datasetId: dataset.id } });
    expect(tomb?.isTombstone).toBe(true);

    // …and it is hidden, by the one definition of hidden.
    await expect(
      db.dataset.findMany({ where: { id: dataset.id, ...liveDatasetsOnly() } })
    ).resolves.toEqual([]);

    // Decision 16: the samples are NOT tombstoned one by one. They survive on
    // disk untouched — no cascade, because nothing was deleted — and they are
    // hidden by INHERITANCE, through liveSamplesOnly()'s `dataset:` clause.
    // Asserting only the empty live read would pass under a per-sample loop
    // too, so the zero-sample-tombstones half is pinned as well.
    await expect(db.datasetSample.count({ where: { datasetId: dataset.id } })).resolves.toBe(1);
    await expect(
      db.tombstone.count({ where: { datasetSampleId: { not: null } } })
    ).resolves.toBe(0);
    await expect(
      db.datasetSample.findMany({ where: { datasetId: dataset.id, ...liveSamplesOnly() } })
    ).resolves.toEqual([]);

    // The row a golden item's `Restrict` FK would cite is still there and
    // still addressable by id. That is the whole point of the overlay.
    await expect(
      db.datasetSample.findUnique({ where: { id: sample.id } })
    ).resolves.not.toBeNull();
  });
```

- [ ] **Step 3: Add the convergence case immediately after it**

Insert directly below the block you just wrote, still inside the same `describe`:

```ts
  it('DELETE /api/datasets/[id] converges on hidden when repeated — never P2002, never a silent no-op', async () => {
    // `Tombstone.datasetId` is @unique, so a second delete that `create`d
    // rather than `upsert`ed raises P2002 and surfaces as a generic 500. And
    // an upsert whose `update:` arm is EMPTY leaves a dataset that was
    // deleted, restored, then deleted again VISIBLE — a delete that silently
    // does nothing. Both are pinned here, and the restore in the middle is
    // what makes the second half non-vacuous: without it the second delete
    // writes `isTombstone: true` over `isTombstone: true` and an empty update
    // arm looks correct.
    const user = await mkUser();
    mockSessionFor(user);
    const { dataset } = await mkDatasetWithSample(user.id);

    const first = await deleteDataset(
      new Request(`http://localhost/api/datasets/${dataset.id}`, { method: 'DELETE' }),
      { params: Promise.resolve({ id: dataset.id }) }
    );
    expect(first.status).toBe(200);
    expect(await db.tombstone.count({ where: { datasetId: dataset.id } })).toBe(1);

    await db.tombstone.update({
      where: { datasetId: dataset.id },
      data: { isTombstone: false, reason: null },
    });

    const second = await deleteDataset(
      new Request(`http://localhost/api/datasets/${dataset.id}`, { method: 'DELETE' }),
      { params: Promise.resolve({ id: dataset.id }) }
    );
    expect(second.status).toBe(200);

    expect(await db.tombstone.count({ where: { datasetId: dataset.id } })).toBe(1);
    const tomb = await db.tombstone.findUnique({ where: { datasetId: dataset.id } });
    expect(tomb?.isTombstone).toBe(true);
  });
```

> The `GET /api/datasets` list assertion — that a hidden dataset stops appearing in the collection — is **not** here on purpose: that read is swept in a later task of this plan, and asserting it now would fail for a reason this task cannot fix. This task pins the row state and the overlay row; the route sweep pins the route.

- [ ] **Step 4: Run the two tests and watch them fail**

Run: `sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.db.config.ts tests/db/dataset-sample-freeze.test.ts'`

Expected: 2 failed.
- `DELETE /api/datasets/[id] HIDES an unpinned dataset instead of destroying it` — FAIL with `AssertionError: expected +0 to be 1` (the handler hard-deleted the row).
- `DELETE /api/datasets/[id] converges on hidden when repeated — never P2002, never a silent no-op` — FAIL with `AssertionError: expected +0 to be 1` on `db.tombstone.count(...)` after the first delete.

- [ ] **Step 5: Import `tombstoneDataset` into the route**

In `src/app/api/datasets/[id]/route.ts`, after `import { findGoldenSetsPinningDataset } from '@/lib/golden-sets';` (line 7), add:

```ts
import { tombstoneDataset } from '@/lib/tombstones';
```

- [ ] **Step 6: Replace the hard delete with a tombstone**

Replace the single line `    await prisma.dataset.delete({ where: { id: params.id } });` with:

```ts
    // A1 Decision 1: deleting a dataset HIDES it. `Dataset → DatasetSample` is
    // `onDelete: Cascade`, so the one statement this replaces took an entire
    // corpus with it — and with it every row a `GoldenItem.sourceDatasetSampleId`
    // still points at.
    //
    // The dataset's samples are deliberately NOT tombstoned one by one.
    // Decision 16: a sample inherits its parent's hidden state through
    // `liveSamplesOnly()`, whose `dataset: { NOT: { tombstone: … } }` clause
    // excludes every row of a hidden corpus from every filtered read. Looping
    // here would write N rows to say what this one row already says, and would
    // make un-hiding the dataset a second N-row job that can half-succeed. The
    // instinct to loop comes from the `Cascade` above; it does not apply,
    // because nothing is deleted.
    //
    // `prisma` satisfies `Prisma.TransactionClient` structurally — the same
    // call shape as `findGoldenSetsPinningDataset(prisma, …)` above — and a
    // single upsert is already atomic, so this needs no `$transaction`.
    await tombstoneDataset(prisma, params.id, 'dataset deleted');
```

- [ ] **Step 7: Run the two tests and watch them pass**

Run: `sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.db.config.ts tests/db/dataset-sample-freeze.test.ts'`
Expected: PASS — every test in the file green, including the three `DELETE /api/datasets/[id]` 409 guard tests, which this task did not touch.

- [ ] **Step 8: Run the access matrix, which drives this handler across all four actors**

`tests/db/access-matrix.test.ts` has eight `dataset` × `DELETE` rows expecting 401/403/200; it builds a fresh target per row and asserts only the status, so a 200 that tombstones satisfies it exactly as a 200 that deleted did.

Run: `sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.db.config.ts tests/db/access-matrix.test.ts'`
Run: `sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.db.config.ts tests/db/account-deletion.test.ts'`
Run: `npx tsc --noEmit`
Run: `npm run lint`

Expected: all four clean.

- [ ] **Step 9: Demonstrate discrimination on the "no per-sample tombstone" assertion**

Temporarily add, immediately after the `tombstoneDataset` call, the loop this task exists to prevent:

```ts
    const doomed = await prisma.datasetSample.findMany({
      where: { datasetId: params.id },
      select: { id: true },
    });
    await tombstoneSamples(prisma, doomed.map((s) => s.id), 'parent deleted');
```

(add `tombstoneSamples` to the `@/lib/tombstones` import for the duration of the check).

Run: `sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.db.config.ts tests/db/dataset-sample-freeze.test.ts'`
Expected: FAIL with `AssertionError: expected 1 to be +0` on the `db.tombstone.count({ where: { datasetSampleId: { not: null } } })` assertion — and note the *empty live read* assertion still passes, which is exactly why both halves are pinned.

Revert both edits, re-run to green, and confirm the file is byte-identical:

Run: `sha256sum 'src/app/api/datasets/[id]/route.ts'`

- [ ] **Step 10: Commit**

```bash
git add 'src/app/api/datasets/[id]/route.ts' tests/db/dataset-sample-freeze.test.ts
git commit -m "feat(a1): DELETE /api/datasets/[id] tombstones the dataset

The handler ended in a bare prisma.dataset.delete. Dataset -> DatasetSample
is onDelete: Cascade, so that one statement took an entire corpus with it,
including every row a GoldenItem.sourceDatasetSampleId still points at. It
is now a tombstoneDataset upsert: the row stays, the samples stay, and the
200 means hidden rather than gone.

The samples are deliberately NOT tombstoned one by one. Decision 16: they
inherit the parent's hidden state through liveSamplesOnly()'s dataset:
clause, so one row says what N rows would, and un-hiding stays a one-row
job. The comment says this at the call site because the prevailing mental
model in this file is the Cascade, which no longer applies now that nothing
is deleted.

dataset-sample-freeze.test.ts asserted db.dataset.count() -> 0. Inverted,
and joined by a repeated-delete case: the tombstone FK is @unique, so a
create rather than an upsert is a P2002 in a 500, and an empty update arm
makes delete -> restore -> delete leave the dataset visible. The restore in
the middle is what stops that half passing vacuously.

The list-route assertion (a hidden dataset stops appearing in GET
/api/datasets) waits for the dataset read sweep, which owns that read.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: A hidden dataset is closed to writes (Decision 15)

**Files:**
- Modify: `src/app/api/datasets/[id]/samples/route.ts:35-36` (doc comment above `POST`) and the four guard reads at `:44-45`, `:105-106`, `:167-168`, `:273-274`
- Modify: `src/app/api/golden-sets/route.ts:105-106`
- Modify: `src/app/api/datasets/[id]/refresh/route.ts:17-18`
- Modify: `src/app/api/datasets/[id]/versions/route.ts:18-19` and `:135-136`
- Modify: `src/app/api/datasets/[id]/export/route.ts:40-41`
- Test: `tests/db/dataset-sample-tombstone.test.ts` (append one `describe` block; the file already exists)

**Interfaces:**
- Consumes: `liveDatasetsOnly(): Prisma.DatasetWhereInput` from `@/lib/tombstones`
- Consumes: the `Tombstone` model — `datasetSampleId String? @unique`, `datasetId String? @unique`, `isTombstone Boolean @default(true)`, `reason String?`
- Consumes: `PLATFORM_OWNER_EMAIL` from `@/lib/golden-sets` (value `'platform@judgearena.local'`)
- Produces: no new exported names. The contract later tasks rely on is behavioural — **every dataset guard read in a mutation handler is `prisma.dataset.findFirst({ where: { id: <id>, ...liveDatasetsOnly() }, … })`**, at these nine sites: `samples/route.ts` POST/PATCH/DELETE/PUT, `golden-sets/route.ts` POST, `refresh/route.ts` POST, `versions/route.ts` POST and GET, `datasets/[id]/export/route.ts` GET.

**Why this task exists.** Every mutation handler reads its dataset first, as an ownership guard, and *none* of those reads filters today. So the moment Task 6 lands, a tombstoned dataset disappears from every list and detail page while staying completely writable through the API. The golden-sets one is the sharpest: unfiltered, a golden set can still be minted from a hidden corpus, and `GoldenItem.sourceDatasetSampleId` is `onDelete: Restrict`, so that pin holds forever with no in-product remedy.

---

- [ ] **Step 1: Read the test file's header and confirm the shared imports**

Run: `sed -n '1,45p' tests/db/dataset-sample-tombstone.test.ts`

The block you append in Step 2 uses `describe, it, expect, beforeEach, vi, type Mock` from `vitest`, `db, truncateAll, mkUser` from `./helpers`, and `getServerSession` from `next-auth`. Every earlier block in this file drives route handlers against the test DB, so all of those are already imported. **If any one of them is missing, add it to the existing import statement for that module — do not add a second import statement for the same module.**

Also confirm the file carries the three module mocks (`next-auth`, `next/headers`, and the `@/lib/rate-limit-redis` fake copied from `tests/db/access-matrix.test.ts:94-100`). If the rate-limit fake is absent, add it — this task drives nine route handlers and the 120/min Redis budget is shared across the whole `npm run test:db` run, so without it this file can fail *other* files.

Then add these route imports as **new** lines at the end of the file's import block. Every name is aliased, so none can collide with what Tasks 3-6 already imported:

```ts
import {
  POST as t7AddSamples,
  PATCH as t7PatchSample,
  DELETE as t7DeleteSamples,
  PUT as t7ReplaceSamples,
} from '@/app/api/datasets/[id]/samples/route';
import { POST as t7CreateGoldenSet } from '@/app/api/golden-sets/route';
import { POST as t7CreateVersion } from '@/app/api/datasets/[id]/versions/route';
import { GET as t7ExportDataset } from '@/app/api/datasets/[id]/export/route';
import { PLATFORM_OWNER_EMAIL } from '@/lib/golden-sets';
```

- [ ] **Step 2: Write the failing test**

Append this `describe` block to the **end** of `tests/db/dataset-sample-tombstone.test.ts`:

```ts
// ─── Task 7: a hidden dataset is closed to writes (Decision 15) ─────────────
// Every mutation handler opens with an ownership guard read of its dataset,
// and none of them filtered. So after Task 6 a tombstoned dataset vanishes
// from every list and detail read while staying fully writable through the
// API — and a golden set minted from one pins it through
// GoldenItem.sourceDatasetSampleId (`onDelete: Restrict`) permanently.
//
// NON-VACUITY. Every fixture here carries a REAL Tombstone row (shape 1 of
// the spec's seven), and the last two carry `isTombstone: false` rows
// (shape 2): without those, a filter written as the simpler
// `{ tombstone: { is: null } }` passes this entire block while silently
// keeping an UN-deleted dataset closed to writes forever.
describe('Task 7 — a hidden dataset is closed to writes (Decision 15)', () => {
  let t7Counter = 0;

  beforeEach(async () => {
    await truncateAll();
    (getServerSession as unknown as Mock).mockReset();
  });

  function t7Session(user: { id: string; email: string }) {
    (getServerSession as unknown as Mock).mockResolvedValue({
      user: { id: user.id, email: user.email },
    });
  }

  function t7Request(url: string, method: string, body?: unknown) {
    const init: RequestInit = { method };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers = { 'content-type': 'application/json' };
    }
    return new Request(url, init);
  }

  /** A public dataset with two pairwise-shaped samples, owned by `userId`. */
  async function t7Corpus(userId: string) {
    t7Counter += 1;
    const dataset = await db.dataset.create({
      data: {
        name: `t7-corpus-${t7Counter}`,
        userId,
        source: 'local',
        visibility: 'public',
        inputType: 'query-response',
        sampleCount: 2,
      },
    });
    const a = await db.datasetSample.create({
      data: {
        datasetId: dataset.id,
        index: 0,
        input: 'who wrote hamlet',
        expected: 'A>B',
        metadata: JSON.stringify({ response_A: 'shakespeare', response_B: 'bacon' }),
      },
    });
    const b = await db.datasetSample.create({
      data: {
        datasetId: dataset.id,
        index: 1,
        input: 'what is 2 + 2',
        expected: 'B>A',
        metadata: JSON.stringify({ response_A: 'five', response_B: 'four' }),
      },
    });
    return { dataset, a, b };
  }

  async function t7Hide(datasetId: string) {
    await db.tombstone.create({
      data: { datasetId, isTombstone: true, reason: 'hidden by the Task 7 fixture' },
    });
  }

  it('POST /api/datasets/[id]/samples 404s on a hidden dataset and appends nothing', async () => {
    const user = await mkUser();
    t7Session(user);
    const { dataset } = await t7Corpus(user.id);
    await t7Hide(dataset.id);

    const res = await t7AddSamples(
      t7Request(`http://localhost/api/datasets/${dataset.id}/samples`, 'POST', {
        samples: [{ input: 'a third question' }],
      }),
      { params: Promise.resolve({ id: dataset.id }) }
    );

    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('Dataset not found');
    // A handler that 404s AND writes is the worse bug, so assert the corpus,
    // not just the status.
    await expect(
      db.datasetSample.count({ where: { datasetId: dataset.id } })
    ).resolves.toBe(2);
  });

  it('PATCH /api/datasets/[id]/samples 404s on a hidden dataset and edits nothing', async () => {
    const user = await mkUser();
    t7Session(user);
    const { dataset, a } = await t7Corpus(user.id);
    await t7Hide(dataset.id);

    const res = await t7PatchSample(
      t7Request(`http://localhost/api/datasets/${dataset.id}/samples`, 'PATCH', {
        sampleId: a.id,
        input: 'edited under a tombstone',
      }),
      { params: Promise.resolve({ id: dataset.id }) }
    );

    expect(res.status).toBe(404);
    await expect(
      db.datasetSample.findUniqueOrThrow({ where: { id: a.id } })
    ).resolves.toMatchObject({ input: 'who wrote hamlet' });
  });

  it('DELETE /api/datasets/[id]/samples 404s on a hidden dataset and hides nothing', async () => {
    const user = await mkUser();
    t7Session(user);
    const { dataset, a, b } = await t7Corpus(user.id);
    await t7Hide(dataset.id);

    const res = await t7DeleteSamples(
      t7Request(`http://localhost/api/datasets/${dataset.id}/samples`, 'DELETE', {
        sampleIds: [a.id],
      }),
      { params: Promise.resolve({ id: dataset.id }) }
    );

    expect(res.status).toBe(404);
    // A surviving ROW COUNT proves nothing here: after Task 3 this verb hides
    // rather than removes, so the rows survive either way. Assert on the
    // OVERLAY — no sample tombstone was written.
    await expect(
      db.tombstone.count({ where: { datasetSampleId: { in: [a.id, b.id] } } })
    ).resolves.toBe(0);
  });

  it('PUT /api/datasets/[id]/samples 404s on a hidden dataset and replaces nothing', async () => {
    const user = await mkUser();
    t7Session(user);
    const { dataset } = await t7Corpus(user.id);
    await t7Hide(dataset.id);

    const res = await t7ReplaceSamples(
      t7Request(`http://localhost/api/datasets/${dataset.id}/samples`, 'PUT', {
        samples: [{ input: 'a wholly different corpus' }],
      }),
      { params: Promise.resolve({ id: dataset.id }) }
    );

    expect(res.status).toBe(404);
    const rows = await db.datasetSample.findMany({
      where: { datasetId: dataset.id },
      orderBy: { index: 'asc' },
    });
    expect(rows.map((s) => s.input)).toEqual(['who wrote hamlet', 'what is 2 + 2']);
  });

  it('POST /api/golden-sets 404s over a hidden corpus — nothing is minted onto rows Restrict then pins forever', async () => {
    // The corpus is PLATFORM-OWNED and public, so every OTHER check in the
    // route passes. Unfiltered, this request returns 201 and writes two
    // GoldenItems whose `sourceDatasetSampleId` is `onDelete: Restrict` — an
    // unreleasable pin on a corpus its owner has already hidden.
    const platform = await db.user.create({
      data: { email: PLATFORM_OWNER_EMAIL, passwordHash: 'fixture-hash' },
    });
    const { dataset } = await t7Corpus(platform.id);
    await t7Hide(dataset.id);

    const importer = await mkUser();
    t7Session(importer);

    const res = await t7CreateGoldenSet(
      t7Request('http://localhost/api/golden-sets', 'POST', {
        datasetId: dataset.id,
        protocol: 'pairwise',
        name: 'Minted from a hidden corpus',
      })
    );

    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('Dataset not found');
    await expect(db.goldenSet.count()).resolves.toBe(0);
    await expect(db.goldenItem.count()).resolves.toBe(0);
  });

  it('POST /api/datasets/[id]/versions 404s on a hidden parent and forks nothing', async () => {
    const user = await mkUser();
    t7Session(user);
    const { dataset } = await t7Corpus(user.id);
    await t7Hide(dataset.id);

    const res = await t7CreateVersion(
      t7Request(`http://localhost/api/datasets/${dataset.id}/versions`, 'POST', {}),
      { params: Promise.resolve({ id: dataset.id }) }
    );

    expect(res.status).toBe(404);
    // Unfiltered this mints a CHILD dataset carrying a live copy of the corpus,
    // which is a hidden dataset walking back into circulation under a new id.
    await expect(db.dataset.count()).resolves.toBe(1);
  });

  it('GET /api/datasets/[id]/export 404s on a hidden dataset', async () => {
    // No session is mocked: this route is `optionalAuth` and serves public
    // datasets to anonymous callers, which is exactly why it must stop serving
    // a corpus its owner has hidden.
    const user = await mkUser();
    const { dataset } = await t7Corpus(user.id);
    await t7Hide(dataset.id);

    const res = await t7ExportDataset(
      new Request(`http://localhost/api/datasets/${dataset.id}/export?format=csv`),
      { params: Promise.resolve({ id: dataset.id }) }
    );

    expect(res.status).toBe(404);
  });

  it('an isTombstone: false row leaves the dataset OPEN to writes — the filter is `NOT`, not `{ tombstone: { is: null } }`', async () => {
    // Vacuity shape 2. Every other test in this block uses an
    // `isTombstone: true` fixture, so a filter written as the simpler
    // `{ tombstone: { is: null } }` passes all of them — and leaves an
    // un-deleted dataset closed to writes forever, with no way back. Only a
    // Tombstone row that EXISTS and says `false` separates the two.
    const user = await mkUser();
    t7Session(user);
    const { dataset } = await t7Corpus(user.id);
    await db.tombstone.create({
      data: { datasetId: dataset.id, isTombstone: false },
    });

    const res = await t7AddSamples(
      t7Request(`http://localhost/api/datasets/${dataset.id}/samples`, 'POST', {
        samples: [{ input: 'a third question' }],
      }),
      { params: Promise.resolve({ id: dataset.id }) }
    );

    expect(res.status).toBe(201);
    await expect(
      db.datasetSample.count({ where: { datasetId: dataset.id } })
    ).resolves.toBe(3);
  });

  it('an un-hidden platform corpus can still be imported into a golden set', async () => {
    // The other half of shape 2, on the path that matters most: restoring the
    // dataset must restore the import, not merely stop 404ing the list page.
    const platform = await db.user.create({
      data: { email: PLATFORM_OWNER_EMAIL, passwordHash: 'fixture-hash' },
    });
    const { dataset } = await t7Corpus(platform.id);
    await db.tombstone.create({
      data: { datasetId: dataset.id, isTombstone: false },
    });

    const importer = await mkUser();
    t7Session(importer);

    const res = await t7CreateGoldenSet(
      t7Request('http://localhost/api/golden-sets', 'POST', {
        datasetId: dataset.id,
        protocol: 'pairwise',
        name: 'Restored corpus import',
      })
    );

    expect(res.status).toBe(201);
    await expect(db.goldenItem.count()).resolves.toBe(2);
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.db.config.ts tests/db/dataset-sample-tombstone.test.ts -t "closed to writes"'`

Expected: **FAIL — 7 failed, 2 passed.** The first failure is the POST test with `AssertionError: expected 201 to be 404 // Object.is equality`. The two that pass are the last two (`isTombstone: false`) tests — they are the vacuity guards for shape 2 and must pass *both* before and after this task; if either goes red after Step 4, the filter was written as `{ tombstone: { is: null } }` instead of the `NOT` form.

- [ ] **Step 4: Filter all four guard reads in `samples/route.ts`**

First confirm the four guard reads are still byte-identical (Tasks 3-5 rewrote the bodies of these verbs, not their guards):

Run: `grep -c "const dataset = await prisma.dataset.findUnique({" "src/app/api/datasets/[id]/samples/route.ts"`
Expected: `4`. If it is not 4, stop — an earlier task reshaped a guard read and the replace below would silently under-apply.

Add the import. The file's import block ends at line 6 with `import { findGoldenSetsPinningDataset } from '@/lib/golden-sets';`. **If Tasks 3-5 already added an `from '@/lib/tombstones'` import, add `liveDatasetsOnly` to that existing list.** Otherwise add this line after line 6:

```ts
import { liveDatasetsOnly } from '@/lib/tombstones';
```

Then one edit with **replace_all** (it hits all four verbs at `:44-45`, `:105-106`, `:167-168`, `:273-274`, which are identical):

Old:
```ts
const dataset = await prisma.dataset.findUnique({
      where: { id: params.id },
```
New:
```ts
const dataset = await prisma.dataset.findFirst({
      where: { id: params.id, ...liveDatasetsOnly() },
```

Leave the `select:` / `include:` block under each one **byte-identical** — Task 4 may have changed POST's, and Task 10 still has to reach into it.

Finally, record why, once, above the first verb. Replace the comment at `:35`:

Old:
```ts
// POST /api/datasets/[id]/samples — add new samples to the dataset
```
New:
```ts
// DECISION 15 — A HIDDEN DATASET IS CLOSED TO WRITES. All four verbs in this
// file open with the same ownership guard read, and all four now spread
// `liveDatasetsOnly()` into it, so a tombstoned dataset 404s on write exactly
// as it already 404s on every list and detail read. `findFirst` rather than
// `findUnique` so the id and the overlay predicate travel in one plain
// `where`.
//
// POST /api/datasets/[id]/samples — add new samples to the dataset
```

- [ ] **Step 5: Filter the golden-sets POST guard read**

In `src/app/api/golden-sets/route.ts`, add after line 22 (`} from '@/lib/golden-sets';`):

```ts
import { liveDatasetsOnly } from '@/lib/tombstones';
```

Then replace `:105-108`:

Old:
```ts
    const dataset = await prisma.dataset.findUnique({
      where: { id: data.datasetId },
      select: { id: true, userId: true, visibility: true },
    });
```
New:
```ts
    // Decision 15. This is the guard whose absence costs the most: unfiltered,
    // a golden set can still be minted from a hidden corpus, and
    // `GoldenItem.sourceDatasetSampleId` is `onDelete: Restrict` — so the pin
    // survives the hide, survives retirement, and has no in-product remedy.
    const dataset = await prisma.dataset.findFirst({
      where: { id: data.datasetId, ...liveDatasetsOnly() },
      select: { id: true, userId: true, visibility: true },
    });
```

- [ ] **Step 6: Filter the refresh guard read**

In `src/app/api/datasets/[id]/refresh/route.ts`, add after line 6 (`import { logger, serializeError } from '@/lib/logger';`):

```ts
import { liveDatasetsOnly } from '@/lib/tombstones';
```

Then replace `:17-22`:

Old:
```ts
    const dataset = await prisma.dataset.findUnique({
      where: { id: params.id },
      include: {
        _count: { select: { samples: true } },
      },
    });
```
New:
```ts
    // Decision 15: refresh persists a new `sampleCount` and new remote
    // metadata, so it is a write and a hidden dataset must 404 before the
    // HuggingFace fetch runs. The `_count` below is filtered by Task 10.
    const dataset = await prisma.dataset.findFirst({
      where: { id: params.id, ...liveDatasetsOnly() },
      include: {
        _count: { select: { samples: true } },
      },
    });
```

- [ ] **Step 7: Filter both guard reads in `versions/route.ts`**

In `src/app/api/datasets/[id]/versions/route.ts`, add after line 7 (`import { createDatasetVersion, DatasetVersionConflictError } from '@/lib/dataset-versions';`):

```ts
import { liveDatasetsOnly } from '@/lib/tombstones';
```

Replace `:18-19` (POST):

Old:
```ts
    const existing = await prisma.dataset.findUnique({
      where: { id: params.id },
```
New:
```ts
    // Decision 15: forking a hidden parent would mint a live child carrying a
    // copy of the whole corpus — a hidden dataset walking back into
    // circulation under a new id.
    const existing = await prisma.dataset.findFirst({
      where: { id: params.id, ...liveDatasetsOnly() },
```

Replace `:135-138` (GET):

Old:
```ts
    const dataset = await prisma.dataset.findUnique({
      where: { id: params.id },
      select: { id: true, parentId: true, userId: true, visibility: true },
    });
```
New:
```ts
    const dataset = await prisma.dataset.findFirst({
      where: { id: params.id, ...liveDatasetsOnly() },
      select: { id: true, parentId: true, userId: true, visibility: true },
    });
```

- [ ] **Step 8: Filter the dataset export guard read**

In `src/app/api/datasets/[id]/export/route.ts`, add after line 11 (`import { logger, serializeError } from '@/lib/logger';`):

```ts
import { liveDatasetsOnly } from '@/lib/tombstones';
```

Then replace `:40-41`:

Old:
```ts
    const dataset = await prisma.dataset.findUnique({
      where: { id: params.id },
```
New:
```ts
    // Decision 15. This route is `optionalAuth` and serves public datasets to
    // anonymous callers, so an unfiltered read here keeps handing out a corpus
    // its owner has hidden — to people with no session at all.
    const dataset = await prisma.dataset.findFirst({
      where: { id: params.id, ...liveDatasetsOnly() },
```

Leave the `include: { samples: … }` block below untouched — Task 8 owns `:43`.

- [ ] **Step 9: Run the new tests and watch them pass**

Run: `sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.db.config.ts tests/db/dataset-sample-tombstone.test.ts -t "closed to writes"'`

Expected: **PASS — 9 passed.**

- [ ] **Step 10: Confirm all nine guard reads converted**

Run: `grep -rn "liveDatasetsOnly()" src/app/api/ | sort`

Expected exactly nine lines, in these files with these counts:

```
src/app/api/datasets/[id]/export/route.ts    1
src/app/api/datasets/[id]/refresh/route.ts   1
src/app/api/datasets/[id]/samples/route.ts   4
src/app/api/datasets/[id]/versions/route.ts  2
src/app/api/golden-sets/route.ts             1
```

Then confirm no guard read was left behind:

Run: `grep -rn "prisma.dataset.findUnique" "src/app/api/datasets/[id]/samples/route.ts" "src/app/api/datasets/[id]/refresh/route.ts" "src/app/api/datasets/[id]/versions/route.ts" "src/app/api/datasets/[id]/export/route.ts" "src/app/api/golden-sets/route.ts"`

Expected: no output (exit status 1).

- [ ] **Step 11: Typecheck and lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: both clean, no output beyond the lint summary.

- [ ] **Step 12: Run all three suites**

Run: `npm run test:db`
Expected: PASS, 453 tests (444 before this task + the 9 added), 35 files.

Run: `npx vitest run --config vitest.config.ts`
Expected: PASS, 476 tests, 34 files — unchanged.

Run: `npm run test:integration`
Expected: PASS, 80 tests, 10 files — unchanged.

- [ ] **Step 13: Commit**

```
git add "src/app/api/datasets/[id]/samples/route.ts" \
        "src/app/api/datasets/[id]/refresh/route.ts" \
        "src/app/api/datasets/[id]/versions/route.ts" \
        "src/app/api/datasets/[id]/export/route.ts" \
        src/app/api/golden-sets/route.ts \
        tests/db/dataset-sample-tombstone.test.ts
```

```
git commit -m "$(cat <<'EOF'
feat(datasets): close a hidden dataset to writes (Decision 15)

Every mutation handler opens with an ownership guard read of its dataset
and not one of them filtered, so after the dataset tombstone landed a
hidden corpus disappeared from every list and detail read while staying
completely writable through the API.

All nine guard reads now spread liveDatasetsOnly(): samples POST, PATCH,
DELETE and PUT; golden-sets POST; refresh POST; versions POST and GET;
and the dataset CSV/JSONL export, which is optionalAuth and was still
serving a hidden corpus to callers with no session at all.

The golden-sets one is the sharpest. Unfiltered, a golden set could still
be minted from a hidden dataset, and GoldenItem.sourceDatasetSampleId is
onDelete: Restrict — so the pin outlives the hide, with no in-product way
to release it.

findUnique becomes findFirst at every site so the id and the overlay
predicate travel in one plain where clause.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: The sample read sweep

**Files:**
- Modify: `src/app/api/datasets/[id]/samples/route.ts:120-124` (PATCH lookup)
- Modify: `src/app/api/datasets/[id]/route.ts:36-39` (embedded samples)
- Modify: `src/app/api/datasets/[id]/versions/route.ts:20-22` (child copy)
- Modify: `src/app/api/golden-sets/route.ts:141-145` (golden-set import)
- Modify: `src/app/api/config/export/route.ts:195-197` (nested include)
- Modify: `src/app/api/config/import/route.ts:647-656` (sample re-resolution by `inputText`)
- Modify: `src/app/api/evaluations/route.ts:515-520` (batch)
- Modify: `src/app/api/datasets/[id]/export/route.ts:42-44`
- Modify: `src/app/api/projects/[id]/export/route.ts:109-112` and `:146-149`
- Test: `tests/db/dataset-sample-tombstone.test.ts` (append one `describe` block; the file already exists)

**Interfaces:**
- Consumes: `liveSamplesOnly(): Prisma.DatasetSampleWhereInput` from `@/lib/tombstones`
- Consumes: the `Tombstone` model — `datasetSampleId String? @unique`, `datasetId String? @unique`, `isTombstone Boolean @default(true)`, `reason String?`
- Consumes: `PLATFORM_OWNER_EMAIL` from `@/lib/golden-sets`
- Consumes: `createDatasetVersion` (`src/lib/dataset-versions.ts:177-213`) — it re-packs the child's sample `index` to `0..n-1` and stores `sampleCount: samples.length`, so a filtered parent copy yields a dense child
- Produces: no new exported names. The contract is behavioural — **every filtered sample read spreads `liveSamplesOnly()`**, at the ten sites listed above.

**Two of these carry consequences worth stating before you touch them.**

`versions/route.ts:21` is not a leak, it is a **resurrection**. The overlay is keyed on row id, and the child version's rows are `create`d fresh — so they are born untombstoned. An unfiltered child copy does not merely show a hidden sample in the new version; it promotes it back to a permanently live row, and the only record that it was ever hidden stays behind on the parent.

`config/import/route.ts:652` builds `sampleIdByInput` in `index` order and keeps the **first** hit per `inputText`. Unfiltered, a hidden row at a low index shadows a perfectly good live duplicate at a higher one, and the imported golden item binds to the dead row — through `GoldenItem.sourceDatasetSampleId`, which is `onDelete: Restrict`, so that binding is permanent.

**Two sample reads in this file stay UNFILTERED, deliberately, and are not yours to change.** `samples/route.ts:46` is the POST high-water read — it must see hidden rows or new appends collide with a hidden row's `index`; Task 4 owns it. `samples/route.ts:183` is the DELETE **membership** lookup — an already-hidden id still belongs to this dataset, so a retried delete must converge on hidden rather than 400 claiming the id is foreign; Task 3 owns it. (That is `:183`, the membership read, not the dataset ownership read at `:167`.) Step 15 verifies both carry their comment, so the sweep reads as complete.

One more read is deliberately out of scope: `evaluations/route.ts:430`/`:440` is the `include` on a `dataset.create` in the HuggingFace path. Those rows are created in the same statement and cannot carry a tombstone — same reasoning as `datasets/route.ts:232`.

---

- [ ] **Step 1: Read the test file's header and confirm the shared imports**

Run: `sed -n '1,45p' tests/db/dataset-sample-tombstone.test.ts`

The block you append uses `describe, it, expect, beforeEach, vi, type Mock` from `vitest`, `db, truncateAll, mkUser` from `./helpers`, and `getServerSession` from `next-auth`. All are already imported by earlier blocks in this file. **If any is missing, add it to the existing import statement for that module — never a second import statement for the same module.** Confirm the `@/lib/rate-limit-redis` fake (the one copied from `tests/db/access-matrix.test.ts:94-100`) is present; this block drives six more route handlers against a Redis budget shared by the whole `npm run test:db` run.

Add these route imports as **new** lines at the end of the import block. Every name is aliased — including `PLATFORM_OWNER_EMAIL`, which Task 7's block already imports unaliased into this same file:

```ts
import { PATCH as t8PatchSample } from '@/app/api/datasets/[id]/samples/route';
import { GET as t8GetDataset } from '@/app/api/datasets/[id]/route';
import { POST as t8CreateVersion } from '@/app/api/datasets/[id]/versions/route';
import { POST as t8CreateGoldenSet } from '@/app/api/golden-sets/route';
import { GET as t8ExportDataset } from '@/app/api/datasets/[id]/export/route';
import { POST as t8ImportConfig } from '@/app/api/config/import/route';
import { PLATFORM_OWNER_EMAIL as T8_PLATFORM_EMAIL } from '@/lib/golden-sets';
```

- [ ] **Step 2: Write the failing test**

Append this `describe` block to the **end** of `tests/db/dataset-sample-tombstone.test.ts`:

```ts
// ─── Task 8: the sample read sweep ──────────────────────────────────────────
// Ten filtered sample reads. The fixture below hides the MIDDLE row of three,
// not the tail, so a read that merely truncates (a stray `take`, a wrong
// `orderBy`) can never be mistaken for a read that filters.
describe('Task 8 — the sample read sweep: a hidden sample is invisible to every filtered read', () => {
  let t8Counter = 0;

  beforeEach(async () => {
    await truncateAll();
    (getServerSession as unknown as Mock).mockReset();
  });

  function t8Session(user: { id: string; email: string }) {
    (getServerSession as unknown as Mock).mockResolvedValue({
      user: { id: user.id, email: user.email },
    });
  }

  function t8Request(url: string, method: string, body?: unknown) {
    const init: RequestInit = { method };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers = { 'content-type': 'application/json' };
    }
    return new Request(url, init);
  }

  /** Three pairwise-shaped samples, the MIDDLE one tombstoned. */
  async function t8CorpusWithHiddenMiddle(userId: string) {
    t8Counter += 1;
    const dataset = await db.dataset.create({
      data: {
        name: `t8-corpus-${t8Counter}`,
        userId,
        source: 'local',
        visibility: 'public',
        inputType: 'query-response',
        sampleCount: 3,
      },
    });
    const mk = (index: number, input: string) =>
      db.datasetSample.create({
        data: {
          datasetId: dataset.id,
          index,
          input,
          expected: index % 2 === 0 ? 'A>B' : 'B>A',
          metadata: JSON.stringify({ response_A: `A-${index}`, response_B: `B-${index}` }),
        },
      });
    const live0 = await mk(0, 't8-live-0');
    const hidden1 = await mk(1, 't8-hidden-1');
    const live2 = await mk(2, 't8-live-2');
    await db.tombstone.create({
      data: { datasetSampleId: hidden1.id, isTombstone: true, reason: 'a bad row' },
    });
    return { dataset, live0, hidden1, live2 };
  }

  it('version-create copies only the LIVE rows — unfiltered it silently RESURRECTS every hidden sample', async () => {
    // Vacuity shape 6: a version test over a tombstone-free parent passes
    // unfiltered and proves nothing, which is why this fixture tombstones a
    // parent row BEFORE the fork.
    //
    // And the harm is worse than a leak. The overlay is keyed on ROW ID, and
    // the child's rows are created fresh — so they are born untombstoned. An
    // unfiltered copy promotes the hidden row back to permanently live in the
    // new version, leaving the only record of the hide behind on the parent.
    const user = await mkUser();
    t8Session(user);
    const { dataset } = await t8CorpusWithHiddenMiddle(user.id);

    const res = await t8CreateVersion(
      t8Request(`http://localhost/api/datasets/${dataset.id}/versions`, 'POST', {}),
      { params: Promise.resolve({ id: dataset.id }) }
    );
    expect(res.status).toBe(201);
    const child = await res.json();

    expect(child.samples.map((s: { input: string }) => s.input)).toEqual([
      't8-live-0',
      't8-live-2',
    ]);
    // createDatasetVersion re-packs to 0..n-1 and stores the same length, so a
    // filtered copy leaves the child dense and its stored count truthful.
    expect(child.samples.map((s: { index: number }) => s.index)).toEqual([0, 1]);
    expect(child.sampleCount).toBe(2);
    // Nothing in the child is tombstoned — which is precisely why the PARENT's
    // filter is the only thing between a hidden row and a live one.
    await expect(
      db.tombstone.count({ where: { datasetSample: { is: { datasetId: child.id } } } })
    ).resolves.toBe(0);
  });

  it('PATCH /api/datasets/[id]/samples 404s on a hidden sample instead of silently editing it', async () => {
    const user = await mkUser();
    t8Session(user);
    const { dataset, hidden1 } = await t8CorpusWithHiddenMiddle(user.id);

    const res = await t8PatchSample(
      t8Request(`http://localhost/api/datasets/${dataset.id}/samples`, 'PATCH', {
        sampleId: hidden1.id,
        input: 'edited a hidden row',
      }),
      { params: Promise.resolve({ id: dataset.id }) }
    );

    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('Sample not found in this dataset');
    // 404-and-write is the worse bug: assert the row, not just the status.
    await expect(
      db.datasetSample.findUniqueOrThrow({ where: { id: hidden1.id } })
    ).resolves.toMatchObject({ input: 't8-hidden-1' });
  });

  it('GET /api/datasets/[id] embeds the live samples only — and an UN-hidden row comes back', async () => {
    // Vacuity shape 2. With only `isTombstone: true` fixtures, a filter written
    // as `{ tombstone: { is: null } }` passes every other test in this block
    // while permanently hiding restored rows. The row carrying an
    // `isTombstone: false` tombstone is the only fixture that separates the two
    // formulations — and it must be VISIBLE.
    const user = await mkUser();
    t8Session(user);
    const { dataset, live2 } = await t8CorpusWithHiddenMiddle(user.id);
    await db.tombstone.create({
      data: { datasetSampleId: live2.id, isTombstone: false },
    });

    const res = await t8GetDataset(
      new Request(`http://localhost/api/datasets/${dataset.id}`),
      { params: Promise.resolve({ id: dataset.id }) }
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.samples.map((s: { input: string }) => s.input)).toEqual([
      't8-live-0',
      't8-live-2',
    ]);
  });

  it('POST /api/golden-sets imports the live rows only — a hidden row must not become a golden item', async () => {
    const platform = await db.user.create({
      data: { email: T8_PLATFORM_EMAIL, passwordHash: 'fixture-hash' },
    });
    const { dataset, hidden1 } = await t8CorpusWithHiddenMiddle(platform.id);
    const importer = await mkUser();
    t8Session(importer);

    const res = await t8CreateGoldenSet(
      t8Request('http://localhost/api/golden-sets', 'POST', {
        datasetId: dataset.id,
        protocol: 'pairwise',
        name: 'Live rows only',
      })
    );
    expect(res.status).toBe(201);
    const body = await res.json();

    expect(body._count.items).toBe(2);
    const items = await db.goldenItem.findMany({
      where: { goldenSetId: body.id },
      orderBy: { index: 'asc' },
    });
    expect(items.map((i) => i.inputText)).toEqual(['t8-live-0', 't8-live-2']);
    // The pin is the harm, not the row count: sourceDatasetSampleId is
    // `onDelete: Restrict`, so a single item on the hidden row holds it forever.
    expect(items.map((i) => i.sourceDatasetSampleId)).not.toContain(hidden1.id);
  });

  it('GET /api/datasets/[id]/export leaves the hidden row out of the CSV', async () => {
    // Anonymous, on a public dataset: this route serves the document to callers
    // with no session, so a hidden row leaking here leaks furthest.
    const user = await mkUser();
    const { dataset } = await t8CorpusWithHiddenMiddle(user.id);

    const res = await t8ExportDataset(
      new Request(`http://localhost/api/datasets/${dataset.id}/export?format=csv`),
      { params: Promise.resolve({ id: dataset.id }) }
    );
    expect(res.status).toBe(200);
    const csv = await res.text();

    expect(csv).toContain('t8-live-0');
    expect(csv).toContain('t8-live-2');
    expect(csv).not.toContain('t8-hidden-1');
  });

  it('a config import binds its golden item to the LIVE duplicate, never to the hidden row at the lower index', async () => {
    // The importer builds `sampleIdByInput` in `index` order and keeps the
    // FIRST hit per inputText. This fixture puts the hidden row at index 0 and
    // its live twin at index 1, so unfiltered the item binds to the DEAD row —
    // through `onDelete: Restrict`, permanently. A fixture with the duplicate
    // at a LOWER index than the hidden row passes unfiltered and proves nothing.
    const user = await mkUser();
    t8Session(user);
    const dataset = await db.dataset.create({
      data: {
        name: 't8-duplicate-corpus',
        slug: 't8-dup-corpus',
        userId: user.id,
        source: 'local',
        visibility: 'private',
        inputType: 'query-response',
        sampleCount: 2,
      },
    });
    const dead = await db.datasetSample.create({
      data: { datasetId: dataset.id, index: 0, input: 'who wrote hamlet', expected: 'A>B' },
    });
    const alive = await db.datasetSample.create({
      data: { datasetId: dataset.id, index: 1, input: 'who wrote hamlet', expected: 'A>B' },
    });
    await db.tombstone.create({
      data: { datasetSampleId: dead.id, isTombstone: true, reason: 'a bad row' },
    });

    const doc = {
      version: '1.0',
      exportedAt: '2026-08-14T00:00:00.000Z',
      goldenSets: [
        {
          slug: 't8-gs-dup',
          name: 'Duplicate resolution',
          visibility: 'private',
          protocol: 'pairwise',
          datasetSlug: 't8-dup-corpus',
          version: 1,
          items: [
            {
              index: 0,
              inputText: 'who wrote hamlet',
              expected: 'A>B',
              candidates: [
                { position: 0, responseText: 'shakespeare' },
                { position: 1, responseText: 'bacon' },
              ],
            },
          ],
        },
      ],
    };

    const res = await t8ImportConfig(
      new Request('http://localhost/api/config/import?dryRun=false', {
        method: 'POST',
        body: JSON.stringify(doc),
        headers: { 'content-type': 'application/json' },
      })
    );
    expect(res.status).toBe(200);
    // Asserted so a resolution failure reads as "skipped" rather than as a
    // silent zero-row query further down.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const diff = (await res.json()).items.find((i: any) => i.type === 'goldenSet');
    expect(diff.action).toBe('create');

    const item = await db.goldenItem.findFirstOrThrow({
      where: { goldenSet: { slug: 't8-gs-dup' } },
    });
    expect(item.sourceDatasetSampleId).toBe(alive.id);
    expect(item.sourceDatasetSampleId).not.toBe(dead.id);
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.db.config.ts tests/db/dataset-sample-tombstone.test.ts -t "the sample read sweep"'`

Expected: **FAIL — 6 failed.** The first is the resurrection guard, with `AssertionError: expected [ 't8-live-0', 't8-hidden-1', 't8-live-2' ] to deeply equal [ 't8-live-0', 't8-live-2' ]` (vitest may elide the third element in the printed diff — the load-bearing part is that `'t8-hidden-1'` is present on the actual side).

- [ ] **Step 4: Filter the PATCH sample lookup**

In `src/app/api/datasets/[id]/samples/route.ts`, add `liveSamplesOnly` to the existing `from '@/lib/tombstones'` import (Tasks 3-5 and 7 have added one). If for any reason there is none, add this line after line 6:

```ts
import { liveSamplesOnly } from '@/lib/tombstones';
```

Then replace `:120-124`:

Old:
```ts
    // Verify the sample belongs to this dataset
    const sample = await prisma.datasetSample.findUnique({
      where: { id: data.sampleId },
      select: { datasetId: true },
    });
```
New:
```ts
    // Verify the sample belongs to this dataset AND is still live. A hidden
    // sample must 404 here, or it stays silently editable while every read
    // path hides it — an edit nobody can see and nobody can review.
    // `findFirst`, because the live predicate is a relation filter layered on
    // top of the id.
    const sample = await prisma.datasetSample.findFirst({
      where: { id: data.sampleId, ...liveSamplesOnly() },
      select: { datasetId: true },
    });
```

- [ ] **Step 5: Filter the embedded samples on the dataset detail read**

In `src/app/api/datasets/[id]/route.ts`, add after line 7 (`import { findGoldenSetsPinningDataset } from '@/lib/golden-sets';`):

```ts
import { liveSamplesOnly } from '@/lib/tombstones';
```

Then replace `:36-39`:

Old:
```ts
        samples: {
          orderBy: { index: 'asc' },
          take: 100,
        },
```
New:
```ts
        samples: {
          where: liveSamplesOnly(),
          orderBy: { index: 'asc' },
          take: 100,
        },
```

- [ ] **Step 6: Filter the version child copy**

In `src/app/api/datasets/[id]/versions/route.ts`, add `liveSamplesOnly` to the existing `from '@/lib/tombstones'` import that Task 7 added (it currently imports `liveDatasetsOnly`), so the line reads:

```ts
import { liveDatasetsOnly, liveSamplesOnly } from '@/lib/tombstones';
```

Then replace `:20-22`:

Old:
```ts
      include: {
        samples: { orderBy: { index: 'asc' } },
      },
```
New:
```ts
      include: {
        // NOT a leak — a RESURRECTION. The overlay is keyed on row id and the
        // child's rows are `create`d fresh, so they are born untombstoned.
        // Unfiltered, this copy does not merely show a hidden sample in the new
        // version; it promotes it back to a permanently live row, and the only
        // record that it was ever hidden stays behind on the parent.
        samples: { where: liveSamplesOnly(), orderBy: { index: 'asc' } },
      },
```

The enclosing call is `prisma.dataset.findFirst` with `...liveDatasetsOnly()` in its `where` — that is Task 7's edit and it stays as it is. If you find `findUnique` here instead, Task 7 has not landed; stop.

- [ ] **Step 7: Filter the golden-set import's sample read**

In `src/app/api/golden-sets/route.ts`, add `liveSamplesOnly` to the `from '@/lib/tombstones'` import Task 7 added:

```ts
import { liveDatasetsOnly, liveSamplesOnly } from '@/lib/tombstones';
```

Then replace `:141-145`:

Old:
```ts
    const samples = await prisma.datasetSample.findMany({
      where: {
        datasetId: dataset.id,
        ...(data.sampleIndices ? { index: { in: data.sampleIndices } } : {}),
      },
```
New:
```ts
    const samples = await prisma.datasetSample.findMany({
      where: {
        datasetId: dataset.id,
        // A0's primary flow. Unfiltered, a hidden sample becomes a golden item
        // and `GoldenItem.sourceDatasetSampleId` — `onDelete: Restrict` — pins
        // the row forever, with no in-product way to release it.
        ...liveSamplesOnly(),
        ...(data.sampleIndices ? { index: { in: data.sampleIndices } } : {}),
      },
```

`liveSamplesOnly()` contributes only `NOT` and `dataset` keys, so it collides with neither `datasetId` nor the `index` spread.

- [ ] **Step 8: Filter the config export's nested samples include**

In `src/app/api/config/export/route.ts`, add after line 20 (`import { logger, serializeError } from '@/lib/logger';`):

```ts
import { liveSamplesOnly } from '@/lib/tombstones';
```

Then replace `:195-197`:

Old:
```ts
        include: includeSamples
          ? { samples: { orderBy: { index: 'asc' } } }
          : undefined,
```
New:
```ts
        include: includeSamples
          // The config document is a portable VIEW of the instance, so it
          // carries what the instance shows, not what its tables still hold.
          ? { samples: { where: liveSamplesOnly(), orderBy: { index: 'asc' } } }
          : undefined,
```

- [ ] **Step 9: Filter the config importer's sample re-resolution**

In `src/app/api/config/import/route.ts`, add after line 24 (`import { audit, getRequestContext } from '@/lib/audit';`):

```ts
import { liveSamplesOnly } from '@/lib/tombstones';
```

Then replace `:647-656`:

Old:
```ts
      // `GoldenItem.sourceDatasetSampleId` is required and `onDelete:
      // Restrict`, and a sample id is instance-local, so it is re-resolved
      // from content: `inputText` is `DatasetSample.input` verbatim for all
      // three mappings. Duplicate inputs collapse onto the lowest-index
      // sample — recorded in the COVERAGE map.
      const samples = await prisma.datasetSample.findMany({
        where: { datasetId: dataset.id },
        select: { id: true, input: true },
        orderBy: { index: 'asc' },
      });
```
New:
```ts
      // `GoldenItem.sourceDatasetSampleId` is required and `onDelete:
      // Restrict`, and a sample id is instance-local, so it is re-resolved
      // from content: `inputText` is `DatasetSample.input` verbatim for all
      // three mappings. Duplicate inputs collapse onto the lowest-index
      // sample — recorded in the COVERAGE map.
      //
      // LIVE ROWS ONLY, and the interaction with that collapse is the whole
      // point: the map keeps the FIRST hit per input, so an unfiltered read
      // lets a hidden row at a low index shadow a perfectly good live
      // duplicate at a higher one. The import then binds a live golden item to
      // a dead row, through a Restrict FK, permanently.
      const samples = await prisma.datasetSample.findMany({
        where: { datasetId: dataset.id, ...liveSamplesOnly() },
        select: { id: true, input: true },
        orderBy: { index: 'asc' },
      });
```

- [ ] **Step 10: Filter the batch evaluation's sample read**

In `src/app/api/evaluations/route.ts`, add after line 10 (`import { generateSlug } from '@/lib/config';`):

```ts
import { liveSamplesOnly } from '@/lib/tombstones';
```

Then replace `:517-519`:

Old:
```ts
      include: {
        samples: { orderBy: { index: 'asc' } },
      },
```
New:
```ts
      include: {
        // One evaluation per LIVE sample. Unfiltered, every batch run scores
        // rows the owner has already withdrawn, and the results look like
        // ordinary judgments.
        samples: { where: liveSamplesOnly(), orderBy: { index: 'asc' } },
      },
```

This is the batch read at `:515-520`. Do **not** touch the `include` at `:439-441` — that one belongs to a `dataset.create` in the HuggingFace path, whose rows are made in the same statement and cannot carry a tombstone.

- [ ] **Step 11: Filter the dataset export's samples**

In `src/app/api/datasets/[id]/export/route.ts`, add `liveSamplesOnly` to the `from '@/lib/tombstones'` import Task 7 added:

```ts
import { liveDatasetsOnly, liveSamplesOnly } from '@/lib/tombstones';
```

Then replace `:42-44`:

Old:
```ts
      include: {
        samples: { orderBy: { index: 'asc' } },
      },
```
New:
```ts
      include: {
        // `optionalAuth`: this route serves public datasets to callers with no
        // session at all, so a hidden row leaking here leaks furthest.
        samples: { where: liveSamplesOnly(), orderBy: { index: 'asc' } },
      },
```

Both `dataset.samples` consumers below (the CSV flatten at `:57` and the JSONL expansion at `:63`) read the same filtered array, so both are fixed by this one edit.

- [ ] **Step 12: Filter both project-export sample reads**

In `src/app/api/projects/[id]/export/route.ts`, add after line 12 (`import { logger, serializeError } from '@/lib/logger';`):

```ts
import { liveSamplesOnly } from '@/lib/tombstones';
```

There are **two** reads and their bodies are textually identical apart from indentation — `:109-112` sits inside the `scope === 'all'` JSONL branch at 8 spaces, `:146-149` inside the `scope === 'datasets'` branch at 6. Make both edits, matching the indentation exactly.

At `:109-112` (8 spaces):

Old:
```ts
        const datasets = await prisma.dataset.findMany({
          where: { projectId: params.id },
          include: { samples: { orderBy: { index: 'asc' } } },
        });
```
New:
```ts
        const datasets = await prisma.dataset.findMany({
          where: { projectId: params.id },
          include: { samples: { where: liveSamplesOnly(), orderBy: { index: 'asc' } } },
        });
```

At `:146-149` (6 spaces):

Old:
```ts
      const datasets = await prisma.dataset.findMany({
        where: { projectId: params.id },
        include: { samples: { orderBy: { index: 'asc' } } },
      });
```
New:
```ts
      const datasets = await prisma.dataset.findMany({
        where: { projectId: params.id },
        include: { samples: { where: liveSamplesOnly(), orderBy: { index: 'asc' } } },
      });
```

- [ ] **Step 13: Run the new tests and watch them pass**

Run: `sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.db.config.ts tests/db/dataset-sample-tombstone.test.ts -t "the sample read sweep"'`

Expected: **PASS — 6 passed.**

- [ ] **Step 14: Confirm the two deliberate exceptions still carry their comment**

Run: `grep -n "UNFILTERED, deliberately" "src/app/api/datasets/[id]/samples/route.ts"`

Expected: **2 lines** — one above the POST high-water read (near `:46`) and one above the DELETE membership lookup (near `:183`).

If either is missing, add it now — the sweep is not complete until every unfiltered sample read names why it is unfiltered. Use exactly these, and change nothing else about those two reads:

Above the POST high-water read:
```ts
    // UNFILTERED, deliberately: the high-water mark must see HIDDEN rows too,
    // or a new append reuses an index a hidden row still holds and violates
    // @@unique([datasetId, index]).
```

Above the DELETE membership lookup (the read at `:183`, not the dataset ownership read at `:167`):
```ts
    // UNFILTERED, deliberately: an already-hidden id still belongs to this
    // dataset, so a retried delete converges on hidden instead of 400ing that
    // the id is foreign to the corpus it plainly came from.
```

- [ ] **Step 15: Confirm all ten filtered sites landed**

Run: `grep -rn "liveSamplesOnly()" src/app/api/ | sort`

Expected, at minimum, these files and counts:

```
src/app/api/config/export/route.ts             1
src/app/api/config/import/route.ts             1
src/app/api/datasets/[id]/export/route.ts      1
src/app/api/datasets/[id]/route.ts             1
src/app/api/datasets/[id]/samples/route.ts     1 or more
src/app/api/datasets/[id]/versions/route.ts    1
src/app/api/evaluations/route.ts               1
src/app/api/golden-sets/route.ts               1
src/app/api/projects/[id]/export/route.ts      2
```

`samples/route.ts` may show more than one: Task 5 filters the PUT response read at `:343` with the same helper. Every other file must show exactly the count above.

- [ ] **Step 16: Typecheck and lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: both clean, no output beyond the lint summary.

- [ ] **Step 17: Run all three suites**

Run: `npm run test:db`
Expected: PASS, 459 tests (453 after Task 7 + the 6 added), 35 files.

Run: `npx vitest run --config vitest.config.ts`
Expected: PASS, 476 tests, 34 files — unchanged.

Run: `npm run test:integration`
Expected: PASS, 80 tests, 10 files — unchanged.

- [ ] **Step 18: Commit**

```
git add "src/app/api/datasets/[id]/samples/route.ts" \
        "src/app/api/datasets/[id]/route.ts" \
        "src/app/api/datasets/[id]/versions/route.ts" \
        "src/app/api/datasets/[id]/export/route.ts" \
        "src/app/api/projects/[id]/export/route.ts" \
        src/app/api/golden-sets/route.ts \
        src/app/api/config/export/route.ts \
        src/app/api/config/import/route.ts \
        src/app/api/evaluations/route.ts \
        tests/db/dataset-sample-tombstone.test.ts
```

```
git commit -m "$(cat <<'EOF'
feat(datasets): sweep liveSamplesOnly() through every filtered sample read

Ten sites: the PATCH lookup, the dataset detail embed, the version child
copy, the golden-set import, the config export include and the config
importer's re-resolution, the batch evaluation read, and the three CSV or
JSONL export reads.

Two of them are not leaks. versions/route.ts copies the parent's rows into
a child whose rows are created fresh — and the overlay is keyed on row id,
so those rows are born untombstoned. Unfiltered, a version-create does not
show a hidden sample, it RESURRECTS it as a permanently live row and
leaves the only record of the hide on the parent. And the config importer
builds its inputText map in index order keeping the first hit, so a hidden
row at a low index shadows a good live duplicate at a higher one, binding
the imported golden item to a dead row through a Restrict FK.

Two sample reads stay unfiltered and now say why in place: the POST
high-water read must see hidden rows or appends collide on
@@unique([datasetId, index]), and the DELETE membership lookup must accept
an already-hidden id so a retried delete converges on hidden instead of
calling the id foreign.

The version test tombstones a parent row before the fork; a version test
over a tombstone-free parent passes unfiltered and proves nothing.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: The dataset read sweep, and the `P2002` must-not-filter class

**Files:**
- Modify: `src/app/api/datasets/route.ts:81-93` (the `Promise.all([findMany, count])`) and `:186-190` (the slug-dedup read)
- Modify: `src/app/api/datasets/[id]/route.ts:31-32` (`GET`'s `findUnique`)
- Modify: `src/app/api/projects/[id]/route.ts:70-71` (anonymous) and `:162-172` (owner, nested `datasets:` select)
- Modify: `src/app/api/config/export/route.ts:192` (the `where` ternary)
- Modify: `src/app/api/datasets/[id]/versions/route.ts:153-159` (the version-family `where`)
- Modify: `src/app/api/stats/route.ts:44-48` (`totalDatasets`)
- Modify: `src/app/api/projects/[id]/export/route.ts:109-110` and `:146-147`
- Modify: `src/app/api/evaluations/route.ts:376-385` (comment only — must NOT filter)
- Modify: `src/app/api/config/import/route.ts:452-456` (comment only — must NOT filter)
- Modify: `src/lib/dataset-versions.ts:156-160` and `:168-172` (comments only — must NOT filter)
- Modify: `scripts/importer/artifacts.ts:388-393` and `:446-449` (comments only — must NOT filter)
- Modify: `src/lib/dataset-evaluation-summary.ts:100-116` (module-doc paragraph — the helper cannot reach raw SQL)
- Test: `tests/db/dataset-sample-tombstone.test.ts` (append one `describe` block)

> Line numbers are from the tree this plan was written against. Earlier tasks in this plan have already edited `datasets/route.ts`, `datasets/[id]/route.ts`, `versions/route.ts` and `config/import/route.ts`, so numbers may have drifted by a few lines. **The quoted anchor text in each step is authoritative, not the number.**

**Interfaces:**
- Consumes: `liveDatasetsOnly(): Prisma.DatasetWhereInput` from `@/lib/tombstones` (Task 2); `tombstoneDataset(tx: Prisma.TransactionClient, datasetId: string, reason?: string): Promise<void>` from `@/lib/tombstones` (Task 2); the `Tombstone` model with columns `datasetSampleId`, `datasetId`, `isTombstone`, `reason` (Task 1); `db`, `truncateAll`, `mkUser` from `tests/db/helpers.ts`; the file `tests/db/dataset-sample-tombstone.test.ts` (created by an earlier task in this plan).
- Produces: no new exported symbols. It produces (a) the local `const liveWhere` in `src/app/api/datasets/route.ts` — the single `where` object both the list `findMany` and the pagination `count` read, which Task 10 must not undo; (b) the greppable comment marker `MUST NOT BE TOMBSTONE-FILTERED (A1)` at eight sites; (c) the `describe` block `the dataset read sweep — a hidden dataset leaves every list (Task 9)` and the test-local helpers `mkSweepDataset` / `sweepSessionFor` in `tests/db/dataset-sample-tombstone.test.ts`.

---

- [ ] **Step 1: Give the test file the header these tests need**

`tests/db/dataset-sample-tombstone.test.ts` already exists (an earlier task in this plan created it) and already carries most of this header. Open it and make its top match the block below, **adding only the lines that are missing**. Each `vi.mock(...)` call is hoisted and module-level: if one is already there, do not add a second copy.

```ts
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { getServerSession } from 'next-auth';
import { db, truncateAll, mkUser } from './helpers';
import { tombstoneDataset } from '@/lib/tombstones';
import { GET as listDatasets, POST as createDataset } from '@/app/api/datasets/route';
import { GET as getDataset } from '@/app/api/datasets/[id]/route';

vi.mock('next-auth', () => ({ getServerSession: vi.fn() }));
vi.mock('next/headers', () => ({ headers: vi.fn(async () => new Headers()) }));

// The DB suite shares one finite 120/min Redis sliding window across every
// file in a run (fileParallelism: false). This file drives route handlers,
// so it uses the established fake — tests/db/access-matrix.test.ts:94-100.
vi.mock('@/lib/rate-limit-redis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rate-limit-redis')>();
  return {
    ...actual,
    apiLimiter: { check: vi.fn(async () => ({ ok: true, remaining: 999, resetAt: Date.now() + 60_000 })) },
  };
});
```

If the file already imports something else from `@/lib/tombstones` (e.g. `tombstoneSample`), extend that import rather than adding a second line from the same module:

```ts
import { tombstoneSample, tombstoneDataset } from '@/lib/tombstones';
```

- [ ] **Step 2: Write the failing read-sweep tests**

Append this `describe` block to the END of `tests/db/dataset-sample-tombstone.test.ts`. The helpers are deliberately prefixed `sweep…` so they cannot collide with helpers earlier tasks put in this same file.

```ts
// ─── Task 9: the dataset read sweep ─────────────────────────────────────────
// Ten dataset reads take `liveDatasetsOnly()`. These two tests pin the two
// that a whole class of consumers sits behind: the paginated list (which is
// ALSO the golden-set dataset picker — golden-sets/page.tsx fetches
// /api/datasets, it is not a distinct server read) and the single-dataset GET.

let sweepCounter = 0;

/** A private dataset owned by `userId`, with a caller-chosen name. */
async function mkSweepDataset(userId: string, name: string) {
  sweepCounter += 1;
  return db.dataset.create({
    data: { name, slug: `${name}-${sweepCounter}`, userId, source: 'local', visibility: 'private' },
  });
}

function sweepSessionFor(user: { id: string; email: string }) {
  (getServerSession as unknown as Mock).mockResolvedValue({
    user: { id: user.id, email: user.email },
  });
}

describe('the dataset read sweep — a hidden dataset leaves every list (Task 9)', () => {
  beforeEach(async () => {
    await truncateAll();
    (getServerSession as unknown as Mock).mockReset();
  });

  it('GET /api/datasets drops the hidden one, keeps the un-hidden one, and the total agrees with the page', async () => {
    const user = await mkUser();
    sweepSessionFor(user);

    // THREE datasets, deliberately — two of the spec's seven vacuous shapes
    // bite on this exact assertion:
    //
    //   * `sweep-hidden` (isTombstone: true) is the only row that can show
    //     the filter doing anything at all. Without it, a route with NO
    //     filter passes every line below.
    //   * `sweep-restored` carries a Tombstone row with isTombstone: FALSE.
    //     It is the only fixture that separates the required
    //     `NOT: { tombstone: { is: { isTombstone: true } } }` from the
    //     simpler `{ tombstone: { is: null } }`, which would wrongly hide a
    //     restored dataset and still satisfy every other assertion here.
    const live = await mkSweepDataset(user.id, 'sweep-live');
    const hidden = await mkSweepDataset(user.id, 'sweep-hidden');
    const restored = await mkSweepDataset(user.id, 'sweep-restored');
    expect(live.id).toBeTruthy();
    await tombstoneDataset(db, hidden.id, 'read-sweep fixture');
    await db.tombstone.create({ data: { datasetId: restored.id, isTombstone: false } });

    const res = await listDatasets(new Request('http://localhost/api/datasets'));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.data).toHaveLength(2);
    expect(body.data.map((d: { name: string }) => d.name).sort()).toEqual([
      'sweep-live',
      'sweep-restored',
    ]);

    // `pagination.total` comes from a SECOND query — `prisma.dataset.count`
    // over the same `where`. Filter the findMany and not the count and this
    // reads 3 against a page of 2: a silent desync, no type error, and the
    // `where` is declared `any` so nothing catches it but this line.
    expect(body.pagination.total).toBe(2);
  });

  it('GET /api/datasets/[id] 404s on a hidden dataset and still serves a restored one', async () => {
    const user = await mkUser();
    sweepSessionFor(user);
    const hidden = await mkSweepDataset(user.id, 'sweep-single-hidden');
    const restored = await mkSweepDataset(user.id, 'sweep-single-restored');
    await tombstoneDataset(db, hidden.id, 'read-sweep fixture');
    // Same isTombstone: false arm as above, for the same reason.
    await db.tombstone.create({ data: { datasetId: restored.id, isTombstone: false } });

    const gone = await getDataset(new Request(`http://localhost/api/datasets/${hidden.id}`), {
      params: Promise.resolve({ id: hidden.id }),
    });
    expect(gone.status).toBe(404);
    expect((await gone.json()).error).toBe('Dataset not found');

    const stillThere = await getDataset(new Request(`http://localhost/api/datasets/${restored.id}`), {
      params: Promise.resolve({ id: restored.id }),
    });
    expect(stillThere.status).toBe(200);
  });
});
```

- [ ] **Step 3: Run them and watch them fail**

Run:

```
sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.db.config.ts tests/db/dataset-sample-tombstone.test.ts -t "the dataset read sweep"'
```

Expected: 2 failed.
- The first fails on the length assertion: `AssertionError: ... to have a length of 2 but got 3` — the hidden dataset is still in the page.
- The second fails on `AssertionError: expected 200 to be 404` — the hidden dataset still serves.

- [ ] **Step 4: Filter the list read AND its pagination count, through one shared `where`**

In `src/app/api/datasets/route.ts`, add the import below `import { toPublicDataset } from '@/lib/serializers';`:

```ts
import { liveDatasetsOnly } from '@/lib/tombstones';
```

(If an earlier task already added an import from `@/lib/tombstones` to this file, extend it instead — e.g. `import { liveDatasetsOnly, nextSampleIndex } from '@/lib/tombstones';`.)

Then replace the `Promise.all` block:

```ts
    if (projectId) where.projectId = projectId;

    // A1 (tombstone overlay): a hidden dataset is invisible to every dataset
    // read. Built ONCE, here, because `findMany` and `count` below both take
    // this object — filter one and not the other and `pagination.total`
    // silently disagrees with the page it describes. `where` is declared
    // `any` at :62, so `liveDatasetsOnly()`'s return type gives ZERO
    // protection on this line; this single shared const is the only guard.
    // `liveDatasetsOnly()` sets exactly one key, `NOT`, and nothing above
    // sets `NOT`, so the spread cannot clobber the visibility clauses.
    //
    // This also covers the golden-set dataset picker: golden-sets/page.tsx
    // fetches `/api/datasets?visibility=public&limit=100`, it is not a
    // separate server read.
    const liveWhere = { ...where, ...liveDatasetsOnly() };

    const [datasets, total] = await Promise.all([
      prisma.dataset.findMany({
        where: liveWhere,
        include: {
          user: { select: { id: true, name: true, email: true } },
          project: { select: { id: true, name: true } },
          _count: { select: { samples: true } },
        },
        orderBy: { updatedAt: 'desc' },
        ...pageArgs,
      }),
      prisma.dataset.count({ where: liveWhere }),
    ]);
```

- [ ] **Step 5: Filter the single-dataset GET**

In `src/app/api/datasets/[id]/route.ts`, add the import after `import { findGoldenSetsPinningDataset } from '@/lib/golden-sets';`:

```ts
import { liveDatasetsOnly } from '@/lib/tombstones';
```

If Task 6 already added `import { tombstoneDataset } from '@/lib/tombstones';` to this file, make it one line instead:

```ts
import { liveDatasetsOnly, tombstoneDataset } from '@/lib/tombstones';
```

Then change the `GET` read:

```ts
    const dataset = await prisma.dataset.findUnique({
      // A1: a hidden dataset 404s here, exactly as a deleted one used to.
      // Legal on `findUnique` because Prisma 5+ admits non-unique filters
      // alongside the unique key — the generated `DatasetWhereUniqueInput`
      // carries `NOT`, which is the only key `liveDatasetsOnly()` sets.
      where: { id: params.id, ...liveDatasetsOnly() },
      include: {
```

- [ ] **Step 6: Run the two tests and watch them pass**

Run:

```
sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.db.config.ts tests/db/dataset-sample-tombstone.test.ts -t "the dataset read sweep"'
```

Expected: 2 passed.

- [ ] **Step 7: Filter BOTH project dataset reads**

`src/app/api/projects/[id]/route.ts` reads datasets **twice** — once on the anonymous/public branch and once nested inside the owner's heavy query. Filtering only the one you happen to find leaves hidden datasets visible **to the owner**, which is the person who hid them.

Add the import after `import { toPublicProject } from '@/lib/serializers';`:

```ts
import { liveDatasetsOnly } from '@/lib/tombstones';
```

Read 1 of 2 — the anonymous branch:

```ts
      const publicDatasets = await prisma.dataset.findMany({
        // A1, read 1 of 2 IN THIS FILE. Its twin is the owner's nested
        // `datasets:` select in the heavy query below. Both filter or
        // neither does — a hidden dataset that still shows on the owner's
        // own project page is the failure this pairing exists to prevent.
        where: { projectId: projectMeta.id, visibility: 'public', ...liveDatasetsOnly() },
        select: {
```

Read 2 of 2 — the owner branch, the nested relation at the bottom of the heavy `include`:

```ts
        _count: { select: { evaluations: true } },
        datasets: {
          // A1, read 2 of 2 IN THIS FILE — the OWNER's copy of the same
          // list. A `dataset.findMany` grep does NOT surface this line; it
          // is a nested relation arg. See the anonymous read above.
          where: liveDatasetsOnly(),
          select: {
            id: true,
            name: true,
            source: true,
            visibility: true,
            sampleCount: true,
            huggingFaceId: true,
          },
          orderBy: { updatedAt: 'desc' },
        },
```

- [ ] **Step 8: Filter the config export, the version list, and stats**

`src/app/api/config/export/route.ts` — add the import after `import { logger, serializeError } from '@/lib/logger';`, then rewrite the ternary. Note the admin branch had no `where` at all:

```ts
import { liveDatasetsOnly } from '@/lib/tombstones';
```

```ts
    // ── Datasets ──
    if (sections.includes('datasets')) {
      // A1: a hidden dataset never enters the portable document — including
      // on the admin branch, which previously passed `undefined`.
      const where = admin ? liveDatasetsOnly() : { userId, ...liveDatasetsOnly() };
      const datasets = await prisma.dataset.findMany({
        where,
```

`src/app/api/datasets/[id]/versions/route.ts` — add the import after `import { createDatasetVersion, DatasetVersionConflictError } from '@/lib/dataset-versions';` (or extend an existing `@/lib/tombstones` import Task 7 may have added), then filter the family read:

```ts
    const versions = await prisma.dataset.findMany({
      where: {
        OR: [
          { id: rootId },
          { parentId: rootId },
        ],
        // A1: a hidden version drops out of the history panel. SPREAD, not
        // merged: this `where` already owns `OR`, and `liveDatasetsOnly()`
        // sets only `NOT`, so the two coexist. An `OR`-shaped helper would
        // have silently clobbered the family predicate above with no type
        // error — which is why the helper returns `NOT`.
        ...liveDatasetsOnly(),
      },
      select: {
```

`src/app/api/stats/route.ts` — add the import after `import { logger, serializeError } from '@/lib/logger';`, then:

```ts
      // A1: hidden datasets do not count. The non-admin arm already owns
      // `OR`; `liveDatasetsOnly()` sets only `NOT`, so this is additive.
      prisma.dataset.count({
        where: isAdmin(session)
          ? liveDatasetsOnly()
          : {
              OR: [{ userId: session.user.id }, { visibility: 'public' }],
              ...liveDatasetsOnly(),
            },
      }),
```

- [ ] **Step 9: Filter both project-export dataset reads**

`src/app/api/projects/[id]/export/route.ts` reads datasets twice — once under `scope=all&format=jsonl` and once under `scope=datasets`. Add the import after `import { logger, serializeError } from '@/lib/logger';`:

```ts
import { liveDatasetsOnly } from '@/lib/tombstones';
```

First read (inside the `format === 'jsonl'` branch, 8-space indent):

```ts
        const datasets = await prisma.dataset.findMany({
          // A1, read 1 of 2 in this file: a hidden dataset exports nothing.
          where: { projectId: params.id, ...liveDatasetsOnly() },
          include: { samples: { orderBy: { index: 'asc' } } },
        });
```

Second read (the `scope === 'datasets'` branch, 6-space indent):

```ts
      const datasets = await prisma.dataset.findMany({
        // A1, read 2 of 2 in this file: same rule on the datasets scope.
        where: { projectId: params.id, ...liveDatasetsOnly() },
        include: { samples: { orderBy: { index: 'asc' } } },
      });
```

Leave the nested `samples: { orderBy: ... }` includes in both alone — the sample-level filter is a different task's edit on these same two statements.

- [ ] **Step 10: Walk the dataset-read ledger and prove nothing was missed**

Run:

```
grep -rn "dataset\.\(findMany\|findUnique\|findFirst\|count\|aggregate\)" src/ scripts/ | grep -v "\.test\."
```

Expected: every hit falls in exactly one row below. **This grep does NOT surface `projects/[id]/route.ts`'s nested `datasets:` select** (a relation arg, not a `dataset.findX` call) — that is precisely why Step 7 handles both project reads by hand, and why this ledger is keyed on file+role rather than on grep output alone.

| File · role | Disposition |
|---|---|
| `datasets/route.ts` list `findMany` + pagination `count` | **Filtered** (Step 4, one shared `liveWhere`) |
| `datasets/route.ts` slug-dedup `findMany` | **UNFILTERED — P2002 class** (Step 15) |
| `datasets/[id]/route.ts` `GET` `findUnique` | **Filtered** (Step 5) |
| `projects/[id]/route.ts` anonymous `findMany` + owner nested `datasets:` select | **Both filtered** (Step 7) |
| `config/export/route.ts` dataset loop | **Filtered** (Step 8) |
| `datasets/[id]/versions/route.ts` version-family `findMany` (`:153`) | **Filtered** (Step 8) |
| `stats/route.ts` `totalDatasets` | **Filtered** (Step 8) |
| `projects/[id]/export/route.ts` ×2 | **Filtered** (Step 9) |
| `config/import/route.ts` upsert-by-slug `findFirst` | **UNFILTERED — P2002 class** (Step 15) |
| `evaluations/route.ts` slug-dedup `findMany` | **UNFILTERED — P2002 class** (Step 15) |
| `dataset-versions.ts` family-version read + slug-dedup read | **UNFILTERED — P2002 class** (Steps 15, 16) |
| `scripts/importer/artifacts.ts` `dataset.findFirst` (v2 content match) | **UNFILTERED — P2002 class** (Step 15) |
| `scripts/importer/artifacts.ts` `ctx.v1.dataset.findMany()` | Out of scope — reads the **v1** database, which has no `Tombstone` table |
| `config/import/route.ts` golden-set dataset resolution by slug (two `findFirst`s) | Untouched by this plan. NOT in the P2002 class (filtering it would merely stop a golden set binding to a hidden dataset, which is correct) but nothing requires it here |
| `evaluations/route.ts` batch `dataset.findUnique` | Untouched here. The nested `samples` include is another task's filter; once filtered, a hidden dataset yields zero live samples and the route already answers `400 'Dataset has no samples'` |
| `samples/route.ts` ×4, `versions/route.ts:18`/`:135`, `refresh/route.ts`, `datasets/[id]/export/route.ts`, `golden-sets/route.ts` | Mutation-handler guard reads — another task in this plan owns them |
| `dataset-evaluation-summary.ts:90` | A prose line inside a comment, not a call |

- [ ] **Step 11: Write the must-not-filter guard test**

Append this `it` to the END of the `describe` block you added in Step 2 (inside it, after the second test):

```ts
  it('creating a dataset whose name collides with a HIDDEN one still gets a unique slug', async () => {
    // THE P2002 CLASS. `datasets/route.ts`'s slug-dedup read must stay
    // UNFILTERED: a hidden dataset still occupies its row in
    // @@unique([userId, slug]) (schema.prisma:595). This test fails the day
    // somebody sweeps `liveDatasetsOnly()` through that read "for
    // consistency" — the hidden row vanishes from `existingSlugs`, the
    // `-xxxx` suffix is never appended, and `prisma.dataset.create` raises
    // P2002, which this route's catch does not handle. The caller gets a
    // bare 500.
    //
    // NON-VACUITY: the first dataset is HIDDEN before the second create.
    // Without the tombstone the dedup read sees the row whether or not it is
    // filtered, and this test proves nothing.
    const user = await mkUser();
    sweepSessionFor(user);

    const firstRes = await createDataset(
      new Request('http://localhost/api/datasets', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Slug Dedup Probe',
          source: 'local',
          visibility: 'private',
        }),
      })
    );
    expect(firstRes.status).toBe(201);
    const first = await firstRes.json();
    expect(first.slug).toBe('slug-dedup-probe');

    await tombstoneDataset(db, first.id, 'slug-dedup guard fixture');

    const secondRes = await createDataset(
      new Request('http://localhost/api/datasets', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Slug Dedup Probe',
          source: 'local',
          visibility: 'private',
        }),
      })
    );
    expect(secondRes.status).toBe(201);
    const second = await secondRes.json();
    expect(second.slug).not.toBe(first.slug);
    expect(second.slug.startsWith('slug-dedup-probe-')).toBe(true);

    // Both rows exist and both hold a slug — the constraint was never tested
    // by luck.
    await expect(db.dataset.count({ where: { userId: user.id } })).resolves.toBe(2);
  });
```

- [ ] **Step 12: Run it and watch it PASS**

Run:

```
sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.db.config.ts tests/db/dataset-sample-tombstone.test.ts -t "collides with a HIDDEN one"'
```

Expected: 1 passed. This one is a guard, not a red-to-green: it pins behaviour that is already correct. Steps 13-14 are what make it non-vacuous.

- [ ] **Step 13: Break the slug-dedup read on purpose and watch the guard fail**

Record the baseline first:

```
sha256sum src/app/api/datasets/route.ts
```

Now temporarily change the slug-dedup read's `where` in `src/app/api/datasets/route.ts` to `where: { userId: session.user.id, ...liveDatasetsOnly() },` and re-run:

```
sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.db.config.ts tests/db/dataset-sample-tombstone.test.ts -t "collides with a HIDDEN one"'
```

Expected: FAIL with `AssertionError: expected 500 to be 201` on `expect(secondRes.status).toBe(201)` — the second create collided on `@@unique([userId, slug])` and fell through to `'Failed to create dataset'`. Copy that line into the task report.

- [ ] **Step 14: Restore, confirm byte-identical, re-run green**

Revert the `where` to `where: { userId: session.user.id },`, then:

```
sha256sum src/app/api/datasets/route.ts
```

Expected: the same digest as Step 13's baseline. Then re-run the test from Step 12 and expect 1 passed.

- [ ] **Step 15: Comment the five slug-dedup reads — the P2002 class**

None of these five gets a filter. Each gets a comment naming what breaks. Use the marker `MUST NOT BE TOMBSTONE-FILTERED (A1)` verbatim at every site so the class is greppable.

`src/app/api/datasets/route.ts`, above the slug-dedup read:

```ts
    // Auto-generate slug for config portability
    const dsSlug = generateSlug(data.name);
    // MUST NOT BE TOMBSTONE-FILTERED (A1). This is slug DEDUP, not a
    // visibility read: a hidden dataset still holds its row in
    // @@unique([userId, slug]) (schema.prisma:595). Sweep `liveDatasetsOnly()`
    // through here and the hidden row drops out of `existingSlugs`, the
    // suffix is never appended, and the `create` below dies on P2002 — which
    // this route's catch does not handle, so the caller gets a bare 500.
    // Pinned by 'creating a dataset whose name collides with a HIDDEN one'
    // in tests/db/dataset-sample-tombstone.test.ts.
    const existingSlugs = (await prisma.dataset.findMany({
      where: { userId: session.user.id },
      select: { slug: true },
    })).map((d) => d.slug).filter(Boolean) as string[];
```

`src/app/api/evaluations/route.ts`, above the HF-import slug read:

```ts
      // Generate a unique slug for the dataset
      const dsSlug = generateSlug(`hf-${meta.name}`);
      // MUST NOT BE TOMBSTONE-FILTERED (A1). Slug DEDUP against
      // @@unique([userId, slug]) (schema.prisma:595) — same shape as
      // datasets/route.ts's. A hidden dataset still owns its slug; filtered,
      // this mints a duplicate and the create below raises P2002.
      const existingSlugs = (
        await prisma.dataset.findMany({
          where: { userId: session.user.id },
          select: { slug: true },
        })
      )
```

`src/lib/dataset-versions.ts`, above the in-transaction slug read:

```ts
        // MUST NOT BE TOMBSTONE-FILTERED (A1). Slug DEDUP against
        // @@unique([userId, slug]) (schema.prisma:595). A hidden dataset
        // still owns its slug; filtered, this derives a colliding
        // `${baseSlug}-v${nextVersion}`, and `isRetryableVersionConflict`
        // would then retry the same doomed value MAX_ATTEMPTS times before
        // surfacing a DatasetVersionConflictError that names the wrong race.
        const existingSlugs = (
          await tx.dataset.findMany({ where: { userId }, select: { slug: true } })
        )
```

`src/app/api/config/import/route.ts`, above the upsert-by-slug read:

```ts
    // ── Datasets ──
    for (const configDataset of config.datasets) {
      const slug = configDataset.slug;
      // MUST NOT BE TOMBSTONE-FILTERED (A1). This is the upsert-by-slug read
      // for @@unique([userId, slug]) (schema.prisma:595). Filtered, a hidden
      // dataset's slug reads as free, the create branch runs, and Postgres
      // raises P2002 mid-import — on a route whose dataset section has no
      // `$transaction`, so the document lands half-applied.
      const existing = await prisma.dataset.findFirst({
        where: { userId, slug },
        include: { _count: { select: { samples: true } } },
      });
```

`scripts/importer/artifacts.ts`, above the v1→v2 dataset content match:

```ts
  // No `(parentId, version)` constraint exists for Dataset (unlike Rubric),
  // so every row — root or child — is content-matched the same way.
  //
  // MUST NOT BE TOMBSTONE-FILTERED (A1). This is idempotency/dedup against
  // @@unique([userId, slug]) (schema.prisma:595), and the v1→v2 importer is
  // re-runnable. A hidden dataset still owns its slug; filtered, a re-run
  // stops recognising the row it created last time and tries to create it
  // again — a P2002 mid-migration, not a harmless duplicate.
  const where = v1.slug
```

- [ ] **Step 16: Comment the version high-water read and the ordinal idempotency read**

`src/lib/dataset-versions.ts`, above the family-version read:

```ts
        // MUST NOT BE TOMBSTONE-FILTERED (A1). This is the version
        // HIGH-WATER read — the spec's own ordinal argument applied to
        // `version`. A hidden version keeps its number in
        // @@unique([parentId, version]) (schema.prisma:596), so filtering
        // here lets the next fork read a lower max, reuse a taken number and
        // collide. The retry loop cannot rescue that: it would recompute the
        // same filtered max and land on the same taken number every attempt.
        const familyVersions = await tx.dataset.findMany({
          where: { OR: [{ id: rootDatasetId }, { parentId: rootDatasetId }] },
```

`scripts/importer/artifacts.ts`, above the sample-by-ordinal read:

```ts
  // MUST NOT BE TOMBSTONE-FILTERED (A1). Sample idempotency by ORDINAL:
  // `datasetId_index` is @@unique([datasetId, index]) and a hidden sample
  // keeps its ordinal. Filtered, a re-run treats the hidden row as absent
  // and re-creates one at the same index — an immediate P2002.
  const existing = await ctx.v2.datasetSample.findUnique({
    where: { datasetId_index: { datasetId: v2DatasetId, index: v1.index } },
  });
```

- [ ] **Step 17: Record that the raw-SQL lock cannot be reached by the helper**

`src/lib/dataset-evaluation-summary.ts` — append this paragraph to the end of the existing module/function doc block, immediately before its closing ` */`:

```ts
 *
 * TOMBSTONE OVERLAY (A1): the row lock below is `$queryRaw`, and both filter
 * helpers in src/lib/tombstones.ts compile to Prisma `where` fragments — they
 * CANNOT reach raw SQL. Decision 3's "spread the helper into every read site"
 * therefore does not apply to this statement, and nobody should try to make
 * it. It selects one Dataset by primary key for an UPDATE it is about to
 * make; hiding the dataset does not change which row that is.
 */
```

- [ ] **Step 18: Typecheck and lint**

Run:

```
npx tsc --noEmit && npm run lint
```

Expected: no errors, no new warnings.

- [ ] **Step 19: Run the whole DB suite**

Run:

```
sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.db.config.ts'
```

Expected: all files pass, with three more tests than before this task. Nothing here changes the coverage floors — every file this task edits is either under `src/app/api/**` (outside every coverage `include`) or a comment-only change to `src/lib/**` / `scripts/importer/**`.

- [ ] **Step 20: Commit**

Run:

```
git add src/app/api/datasets/route.ts "src/app/api/datasets/[id]/route.ts" "src/app/api/datasets/[id]/versions/route.ts" "src/app/api/projects/[id]/route.ts" "src/app/api/projects/[id]/export/route.ts" src/app/api/config/export/route.ts src/app/api/config/import/route.ts src/app/api/stats/route.ts src/app/api/evaluations/route.ts src/lib/dataset-versions.ts src/lib/dataset-evaluation-summary.ts scripts/importer/artifacts.ts tests/db/dataset-sample-tombstone.test.ts
git commit -m "feat(a1): filter every dataset read, and name the eight that must not be"
```

---

### Task 10: The `_count.samples` sweep

**Files:**
- Modify: `src/app/api/datasets/route.ts:84-88` (list include `_count`)
- Modify: `src/app/api/datasets/[id]/route.ts:40-47` (`GET`: the nested `versions` select note + the `_count`) and `:109-113` (`PATCH` response `_count`)
- Modify: `src/app/api/datasets/[id]/refresh/route.ts:17-22` (the read that feeds `buildRefreshUpdate`) and `:57-61` (the response include)
- Modify: `src/app/api/datasets/[id]/versions/route.ts:160-167` (the `select` carrying BOTH stored `sampleCount` and `_count.samples`)
- Modify: `src/app/api/config/import/route.ts:453-456` (the `_count` that feeds the sample diff)
- Test: `tests/db/dataset-sample-tombstone.test.ts` (append one `describe` block)

> Line numbers are from the tree this plan was written against; earlier tasks have edited four of these files. **The quoted anchor text in each step is authoritative, not the number.** In particular `datasets/route.ts`'s list query now reads `where: liveWhere` — an earlier task in this plan made that one shared object serve both the `findMany` and the pagination `count`. Do not revert it.

**Interfaces:**
- Consumes: `liveSamplesOnly(): Prisma.DatasetSampleWhereInput` from `@/lib/tombstones` (Task 2); `tombstoneSample(tx: Prisma.TransactionClient, datasetSampleId: string, reason?: string): Promise<void>` from `@/lib/tombstones` (Task 2); the `Tombstone` model with columns `datasetSampleId`, `datasetId`, `isTombstone`, `reason` (Task 1); `db`, `truncateAll`, `mkUser` from `tests/db/helpers.ts`; the file `tests/db/dataset-sample-tombstone.test.ts` (created by an earlier task in this plan); the local `const liveWhere` in `src/app/api/datasets/route.ts` (Task 9).
- Produces: no new exported symbols. It produces the `describe` block `the _count.samples sweep — a hidden sample stops being counted (Task 10)` and the test-local helpers `mkCountDataset` / `countSessionFor` in `tests/db/dataset-sample-tombstone.test.ts`.

Why every producer and not just one: the UI ladder is `sampleCount ?? sampleTotal ?? _count.samples` (eleven expressions across four pages), and `sampleTotal` is set from `_count.samples` in `toPublicDataset` (`src/lib/serializers.ts:187`). A single unfiltered producer feeds a stale number into whichever rung the caller happens to reach.

---

- [ ] **Step 1: Give the test file the header these tests need**

`tests/db/dataset-sample-tombstone.test.ts` already exists and already carries most of this. Add only what is missing; each `vi.mock(...)` must appear exactly once.

```ts
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { getServerSession } from 'next-auth';
import { db, truncateAll, mkUser } from './helpers';
import { tombstoneSample } from '@/lib/tombstones';
import { GET as listDatasets } from '@/app/api/datasets/route';
import { GET as getDataset } from '@/app/api/datasets/[id]/route';
import { GET as listVersions } from '@/app/api/datasets/[id]/versions/route';

vi.mock('next-auth', () => ({ getServerSession: vi.fn() }));
vi.mock('next/headers', () => ({ headers: vi.fn(async () => new Headers()) }));

vi.mock('@/lib/rate-limit-redis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rate-limit-redis')>();
  return {
    ...actual,
    apiLimiter: { check: vi.fn(async () => ({ ok: true, remaining: 999, resetAt: Date.now() + 60_000 })) },
  };
});
```

If the file already imports from `@/lib/tombstones` or from `@/app/api/datasets/route`, extend the existing line rather than adding a second — e.g. `import { tombstoneDataset, tombstoneSample } from '@/lib/tombstones';` and `import { GET as listDatasets, POST as createDataset } from '@/app/api/datasets/route';`.

- [ ] **Step 2: Write the failing `_count` tests**

Append this `describe` block to the END of `tests/db/dataset-sample-tombstone.test.ts`. The helpers are prefixed `count…` so they cannot collide with helpers earlier tasks put in this same file.

```ts
// ─── Task 10: the _count.samples sweep ──────────────────────────────────────
// Seven `_count: { select: { samples: true } }` producers take
// `liveSamplesOnly()`. The UI ladder is `sampleCount ?? sampleTotal ??
// _count.samples` and `sampleTotal` IS `_count.samples` (serializers.ts's
// toPublicDataset), so one unfiltered producer feeds a stale number to
// whichever rung the caller reaches first.
//
// THE ELEVEN LADDER EXPRESSIONS THEMSELVES NEED NO CHANGE and this task must
// not touch them: datasets/page.tsx:652; datasets/[id]/page.tsx:694, :735,
// :765, :895; golden-sets/page.tsx:101; projects/[id]/page.tsx:228, :1156,
// :1164, :1634, :1659. Nor `hfMeta.sampleCount` (a HuggingFace remote count)
// or `summary.sampleCount` (which is `evaluations.length`).

let countCounter = 0;

/** A dataset with `n` dense samples and a STORED sampleCount of `n`. */
async function mkCountDataset(userId: string, name: string, n: number) {
  countCounter += 1;
  return db.dataset.create({
    data: {
      name,
      slug: `${name}-${countCounter}`,
      userId,
      source: 'local',
      visibility: 'private',
      sampleCount: n,
      samples: {
        create: Array.from({ length: n }, (_, i) => ({
          index: i,
          input: `question-${i}`,
          expected: 'A>B',
        })),
      },
    },
    include: { samples: { orderBy: { index: 'asc' } } },
  });
}

function countSessionFor(user: { id: string; email: string }) {
  (getServerSession as unknown as Mock).mockResolvedValue({
    user: { id: user.id, email: user.email },
  });
}

describe('the _count.samples sweep — a hidden sample stops being counted (Task 10)', () => {
  beforeEach(async () => {
    await truncateAll();
    (getServerSession as unknown as Mock).mockReset();
  });

  it('GET /api/datasets and GET /api/datasets/[id] both report the LIVE sample count', async () => {
    const user = await mkUser();
    countSessionFor(user);
    const ds = await mkCountDataset(user.id, 'count-sweep', 4);

    // NON-VACUITY, two of the spec's seven shapes on one fixture:
    //   * sample 3 is genuinely hidden — without it `_count` is 4 whether or
    //     not the producer is filtered, and every assertion below passes on
    //     unchanged code.
    //   * sample 1 carries a Tombstone row with isTombstone: FALSE. It is
    //     the only fixture that separates the required `NOT` formulation from
    //     the simpler `{ tombstone: { is: null } }` — that one counts 2 here
    //     and would sail through a fixture built only from hidden rows.
    await tombstoneSample(db, ds.samples[3].id, 'count-sweep fixture');
    await db.tombstone.create({ data: { datasetSampleId: ds.samples[1].id, isTombstone: false } });

    const listRes = await listDatasets(new Request('http://localhost/api/datasets'));
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json();
    expect(listBody.data).toHaveLength(1);
    expect(listBody.data[0]._count.samples).toBe(3);

    const oneRes = await getDataset(new Request(`http://localhost/api/datasets/${ds.id}`), {
      params: Promise.resolve({ id: ds.id }),
    });
    expect(oneRes.status).toBe(200);
    const oneBody = await oneRes.json();
    expect(oneBody._count.samples).toBe(3);

    // The STORED rung is deliberately untouched by this task. Keeping
    // `sampleCount` truthful is the write side's job (the POST/DELETE/PUT
    // sampleCount writes); this task only fixes the read that feeds the
    // ladder's second and third rungs.
    expect(oneBody.sampleCount).toBe(4);
  });

  it('GET /api/datasets/[id]/versions reports the live _count beside the untouched stored sampleCount', async () => {
    const user = await mkUser();
    countSessionFor(user);
    const ds = await mkCountDataset(user.id, 'count-sweep-versions', 3);
    await tombstoneSample(db, ds.samples[2].id, 'count-sweep fixture');

    const res = await listVersions(
      new Request(`http://localhost/api/datasets/${ds.id}/versions`),
      { params: Promise.resolve({ id: ds.id }) }
    );
    expect(res.status).toBe(200);
    const rows = await res.json();
    expect(rows).toHaveLength(1);

    // This one `select` carries BOTH rungs, which is exactly why it is easy
    // to filter neither: the panel reads `v.sampleCount ?? v._count?.samples`
    // and the first rung hides the second.
    expect(rows[0]._count.samples).toBe(2);
    expect(rows[0].sampleCount).toBe(3);
  });
});
```

- [ ] **Step 3: Run them and watch them fail**

Run:

```
sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.db.config.ts tests/db/dataset-sample-tombstone.test.ts -t "_count.samples sweep"'
```

Expected: 2 failed.
- The first fails on `AssertionError: expected 4 to be 3` at `expect(listBody.data[0]._count.samples).toBe(3)`.
- The second fails on `AssertionError: expected 3 to be 2` at `expect(rows[0]._count.samples).toBe(2)`.

- [ ] **Step 4: Filter the list `_count`**

In `src/app/api/datasets/route.ts`, extend the existing `@/lib/tombstones` import (an earlier task added `liveDatasetsOnly` here):

```ts
import { liveDatasetsOnly, liveSamplesOnly } from '@/lib/tombstones';
```

Then filter the relation count inside the list include. Do **not** touch the `where: liveWhere` line above it — that is the shared object the pagination `count` also reads:

```ts
        include: {
          user: { select: { id: true, name: true, email: true } },
          project: { select: { id: true, name: true } },
          // A1: the LIVE sample count. `toPublicDataset` publishes this as
          // `sampleTotal` (serializers.ts:187), which is the second rung of
          // the `sampleCount ?? sampleTotal ?? _count.samples` ladder every
          // dataset card reads. Unfiltered it advertises rows the import
          // will not deliver.
          _count: { select: { samples: { where: liveSamplesOnly() } } },
        },
        orderBy: { updatedAt: 'desc' },
```

- [ ] **Step 5: Filter both `_count`s in `datasets/[id]/route.ts`, and record why the nested `versions` select has nothing to filter**

Extend that file's `@/lib/tombstones` import:

```ts
import { liveDatasetsOnly, liveSamplesOnly } from '@/lib/tombstones';
```

(If earlier tasks left it as `import { liveDatasetsOnly, tombstoneDataset } from '@/lib/tombstones';`, make it `import { liveDatasetsOnly, liveSamplesOnly, tombstoneDataset } from '@/lib/tombstones';`.)

`GET` — the nested `versions` select gets a comment only, the `_count` gets the filter:

```ts
        versions: {
          // The stored `sampleCount` only — there is no `_count` here to
          // filter. The version-history panel does not read this: it fetches
          // GET /api/datasets/[id]/versions (datasets/[id]/page.tsx:203),
          // whose `_count` IS filtered. Keeping this rung truthful is the
          // write side's job, not this read's.
          select: { id: true, version: true, createdAt: true, sampleCount: true },
          orderBy: { version: 'desc' },
        },
        parent: {
          select: { id: true, version: true },
        },
        // A1: the LIVE sample count, for both the owner branch (returned
        // verbatim) and the public branch (via toPublicDataset's
        // `sampleTotal`).
        _count: { select: { samples: { where: liveSamplesOnly() } } },
```

`PATCH` — the response include, so the ladder is right immediately after a metadata edit:

```ts
        project: { select: { id: true, name: true } },
        // A1: the LIVE sample count. The dataset page re-renders from this
        // response, so an unfiltered count here shows a stale number until
        // the next full reload.
        _count: { select: { samples: { where: liveSamplesOnly() } } },
      },
    });

    return NextResponse.json(dataset);
```

- [ ] **Step 6: Run the first test and watch it pass**

Run:

```
sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.db.config.ts tests/db/dataset-sample-tombstone.test.ts -t "both report the LIVE sample count"'
```

Expected: 1 passed.

- [ ] **Step 7: Filter the version-list `_count`, leaving the stored `sampleCount` alone**

In `src/app/api/datasets/[id]/versions/route.ts`, extend the `@/lib/tombstones` import (an earlier task added `liveDatasetsOnly` here):

```ts
import { liveDatasetsOnly, liveSamplesOnly } from '@/lib/tombstones';
```

Then, in the `GET` version list, filter the relation count. Do not touch the `where` above it:

```ts
      select: {
        id: true,
        version: true,
        // The stored rung, deliberately left as it stands — the panel reads
        // `v.sampleCount ?? v._count?.samples`, so this value shadows the one
        // below and the write side is what keeps it honest.
        sampleCount: true,
        createdAt: true,
        updatedAt: true,
        // A1: the LIVE sample count — the panel's fallback rung, and the
        // only one this task can fix from the read side.
        _count: { select: { samples: { where: liveSamplesOnly() } } },
      },
      orderBy: { version: 'desc' },
```

- [ ] **Step 8: Run the second test and watch it pass**

Run:

```
sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.db.config.ts tests/db/dataset-sample-tombstone.test.ts -t "reports the live _count beside"'
```

Expected: 1 passed.

- [ ] **Step 9: Filter both refresh `_count`s**

In `src/app/api/datasets/[id]/refresh/route.ts`, add the import after `import { logger, serializeError } from '@/lib/logger';` (or extend an existing `@/lib/tombstones` import an earlier task added for the guard read):

```ts
import { liveSamplesOnly } from '@/lib/tombstones';
```

The first read is the one that matters most — its `_count.samples` is passed to `buildRefreshUpdate`, whose result is **persisted** as `sampleCount`:

```ts
    const dataset = await prisma.dataset.findUnique({
      where: { id: params.id },
      include: {
        // A1: the LIVE sample count. This value is handed to
        // `buildRefreshUpdate` below and its result is PERSISTED into
        // `Dataset.sampleCount` — so the stored row count is fixed for free
        // by filtering here, and only by filtering here. That write needed
        // no change of its own precisely because of this line.
        _count: { select: { samples: { where: liveSamplesOnly() } } },
      },
    });
```

The second is the response include:

```ts
      include: {
        user: { select: { id: true, name: true, email: true } },
        project: { select: { id: true, name: true } },
        // A1: the LIVE sample count in the response the client re-renders
        // from, matching the value just persisted above.
        _count: { select: { samples: { where: liveSamplesOnly() } } },
      },
```

- [ ] **Step 10: Filter the importer's `_count`**

In `src/app/api/config/import/route.ts`, add the import (or extend the existing `@/lib/tombstones` import an earlier task added):

```ts
import { liveSamplesOnly } from '@/lib/tombstones';
```

Then filter the relation count on the upsert-by-slug read. **Leave the `where` and the `MUST NOT BE TOMBSTONE-FILTERED (A1)` comment above it exactly as they are** — an earlier task put them there, and they are about the slug constraint, not the count:

```ts
      const existing = await prisma.dataset.findFirst({
        where: { userId, slug },
        // A1: the LIVE sample count. This feeds the
        // `existing._count.samples !== configDataset.samples.length` diff
        // below. Unfiltered, re-importing an UNCHANGED document onto a
        // corpus that has any hidden row reports a spurious `samples: N → M`
        // change, which flips the action from `skip` to a full — and
        // entirely needless — sample replace.
        include: { _count: { select: { samples: { where: liveSamplesOnly() } } } },
      });
```

- [ ] **Step 11: Walk the `_count` ledger — the sites that stay unfiltered**

Run:

```
grep -rn "_count: { select: { samples" src/
```

Expected: every remaining **unfiltered** hit is on this allowlist, and there are no others.

| Site | Why it needs nothing |
|---|---|
| `src/app/api/datasets/route.ts` — the `POST` create include | A dataset created microseconds ago cannot carry a tombstone, and neither can the samples created with it in the same statement |
| `src/lib/dataset-versions.ts` — the child-create include in `createDatasetVersion` | Same reason: the child dataset and every one of its samples are created by this very `create` |
| `src/app/api/datasets/[id]/samples/route.ts` — the `POST` high-water read, **if an earlier task left it in place** | Deliberately unfiltered: it must see hidden rows or appended ordinals collide with retained ones |

Every other hit must now read `samples: { where: liveSamplesOnly() }`. If one does not, it was missed — go back and filter it.

- [ ] **Step 12: Prove no UI file was touched**

The eleven ladder expressions need no change, and this task must not have edited one. Run:

```
git status --porcelain | grep "page.tsx"
```

Expected: no output.

- [ ] **Step 13: Typecheck and lint**

Run:

```
npx tsc --noEmit && npm run lint
```

Expected: no errors, no new warnings.

- [ ] **Step 14: Run the whole DB suite**

Run:

```
sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.db.config.ts'
```

Expected: all files pass, with two more tests than before this task. No coverage floor moves: every file edited here is under `src/app/api/**`, which is outside every coverage `include`.

- [ ] **Step 15: Commit**

Run:

```
git add src/app/api/datasets/route.ts "src/app/api/datasets/[id]/route.ts" "src/app/api/datasets/[id]/refresh/route.ts" "src/app/api/datasets/[id]/versions/route.ts" src/app/api/config/import/route.ts tests/db/dataset-sample-tombstone.test.ts
git commit -m "feat(a1): make every _count.samples producer count live rows only"
```

---

### Task 11: The config importer's sample replace becomes tombstone-and-append

**Files:**
- Modify: `src/app/api/config/import/route.ts:1-25` (the import block), `:183-185` (module doc bullet), `:477-539` (the long branch comment and the replace block)
- Test: `tests/db/config-golden-sets.test.ts:852-872` (rewritten) and one new case after it

> **Line numbers are as of the pre-A1 tree.** Two earlier tasks edit this same file *above* line 500 (the `_count.samples` filter at `:455` and the sample re-resolution filter at `:652`), so every number here has drifted by a few lines. Anchor on the quoted text, never on the number.

**Interfaces:**
- Consumes: `liveSamplesOnly(): Prisma.DatasetSampleWhereInput`, `tombstoneSamples(tx: Prisma.TransactionClient, datasetSampleIds: string[], reason?: string): Promise<number>`, `nextSampleIndex(tx: Prisma.TransactionClient, datasetId: string): Promise<number>` — all from `@/lib/tombstones`
- Consumes: the `Tombstone` model (`datasetSampleId String? @unique`, `isTombstone Boolean @default(true)`, `reason String?`) and the `tombstone Tombstone?` back-relation on `DatasetSample`
- Consumes: `existing._count.samples` at `config/import/route.ts:455` is already a **live** count (the `_count.samples` sweep). Task 11's second test fails loudly if it is not.
- Produces: no new exported names. The observable contract: a config-document sample replace **tombstones** the live rows with `reason: 'config-import-replace'`, **appends** the document rows at `nextSampleIndex(tx, datasetId) + position`, writes `sampleCount = <document length>`, and does all of it in one `prisma.$transaction`.

**Do not** touch `tests/db/config-roundtrip-fidelity.test.ts:265`. It does not break: that round trip yields `changes.length === 0` → `skip` (so the replace never runs), and `FULL_CONFIG`'s `gs-alpha` pins `ds-alpha` anyway, which takes the skip branch regardless. A "fix" there is a regression.

**Do not** remove the pin-skip guard (`findGoldenSetsPinningDataset` at `:494-505`). Tombstone-and-append can no longer raise the `P2003` that guard was written for, but retiring it is Plan B's decision, and `config-golden-sets.test.ts:809` pins it.

- [ ] **Step 1: Rewrite the failing test at `tests/db/config-golden-sets.test.ts:852`**

Add the helper import at the top of the file, next to the existing `import { PUT as replaceSamples } from '@/app/api/datasets/[id]/samples/route';` (line 7):

```ts
import { liveSamplesOnly } from '@/lib/tombstones';
```

Then replace the whole `it('M1: an UNPINNED dataset still has its samples replaced wholesale', ...)` block (lines 852-872) with:

```ts
  it('M1: an UNPINNED dataset still has its samples replaced — tombstone-and-append, never delete-and-recreate', async () => {
    // The other half of the guard: skipping every replace would also make the
    // test above pass, and would silently break config-driven corpus updates.
    const user = await mkUser();
    mockSessionFor(user);
    const dataset = await mkAnnotatedDataset(user.id, { slug: 'ds-unpinned' });

    const doc = await exportDoc();
    doc.datasets[0].name = 'Renamed Corpus';
    doc.datasets[0].samples[0].input = 'a wholly different question';

    expect((await importConfig(importRequest(JSON.stringify(doc)))).status).toBe(200);

    // NON-VACUITY: the fixture holds the sample ids from BEFORE the import, so
    // "nothing was destroyed" is a claim this test can actually falsify. The
    // delete-and-recreate shape returns ZERO rows here; a shape that hid the
    // rows but forgot the `reason` returns two rows with a null reason.
    const outgoing = await db.datasetSample.findMany({
      where: { id: { in: dataset.samples.map((s) => s.id) } },
      include: { tombstone: true },
      orderBy: { index: 'asc' },
    });
    expect(outgoing).toHaveLength(2);
    expect(outgoing.map((s) => s.index)).toEqual([0, 1]);
    expect(outgoing.map((s) => s.tombstone?.isTombstone)).toEqual([true, true]);
    expect(outgoing.map((s) => s.tombstone?.reason)).toEqual([
      'config-import-replace',
      'config-import-replace',
    ]);

    // …and the LIVE set is exactly the document, appended ABOVE the retained
    // ordinals. Written at the document's raw 0..n-1 this createMany would
    // have collided with the two rows above on @@unique([datasetId, index]).
    const live = await db.datasetSample.findMany({
      where: { datasetId: dataset.id, ...liveSamplesOnly() },
      orderBy: { index: 'asc' },
    });
    expect(live.map((s) => s.input)).toEqual(['a wholly different question', 'what is 2 + 2']);
    expect(live.map((s) => s.index)).toEqual([2, 3]);
    // New rows, not edits in place — proof the replace ran at all.
    expect(live.map((s) => s.id)).not.toEqual(dataset.samples.map((s) => s.id));

    // The stored count follows the LIVE set, not the row count.
    const after = await db.dataset.findUniqueOrThrow({ where: { id: dataset.id } });
    expect(after.sampleCount).toBe(2);
    expect(await db.datasetSample.count({ where: { datasetId: dataset.id } })).toBe(4);
  });
```

- [ ] **Step 2: Run it and watch it fail**

Run: `sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.db.config.ts tests/db/config-golden-sets.test.ts -t "UNPINNED"'`

Expected: FAIL with `expected [] to have a length of 2 but got +0` — the replace still hard-deletes, so the two original rows are gone.

(If it instead errors with a Prisma `P2021`/`P2022` naming `Tombstone`, the test database has not replayed the overlay migration. Run `npm run test:db` once — it does `prisma migrate reset --force --skip-seed` first — then re-run the scoped command.)

- [ ] **Step 3: Add the re-import test that the hidden rows must not inflate**

Insert this immediately after the test from Step 1, still inside the same `describe`:

```ts
  it('M1: re-importing the SAME document is a skip, not a second replace — hidden rows must not inflate the diff', async () => {
    // NON-VACUITY: this shape only bites AFTER something is hidden. On a clean
    // corpus the diff reads count == document length both times and skips, so
    // a fixture that imports once proves nothing. The FIRST import here is the
    // fixture — it is what creates the hidden rows — and the second is the
    // assertion. Unfiltered, the diff sees 4 != 2, replaces again, and the
    // table grows by n rows per run forever.
    const user = await mkUser();
    mockSessionFor(user);
    const dataset = await mkAnnotatedDataset(user.id, { slug: 'ds-reimport' });

    const doc = await exportDoc();
    doc.datasets[0].name = 'Renamed Corpus';
    doc.datasets[0].samples[0].input = 'a wholly different question';

    expect((await importConfig(importRequest(JSON.stringify(doc)))).status).toBe(200);
    // 2 hidden + 2 appended. A 2 here means the replace still deletes.
    expect(await db.datasetSample.count({ where: { datasetId: dataset.id } })).toBe(4);

    const second = await importConfig(importRequest(JSON.stringify(doc)));
    expect(second.status).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const secondDiff = (await second.json()).items.find((i: any) => i.type === 'dataset');
    expect(secondDiff.action).toBe('skip');
    // Unchanged: no third generation of rows, no re-tombstoning of the second.
    expect(await db.datasetSample.count({ where: { datasetId: dataset.id } })).toBe(4);
    const live = await db.datasetSample.findMany({
      where: { datasetId: dataset.id, ...liveSamplesOnly() },
      orderBy: { index: 'asc' },
    });
    expect(live.map((s) => s.index)).toEqual([2, 3]);
  });
```

- [ ] **Step 4: Run it and watch it fail**

Run: `sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.db.config.ts tests/db/config-golden-sets.test.ts -t "re-importing the SAME document"'`

Expected: FAIL with `expected 2 to be 4 // Object.is equality` — the first import deleted the two originals instead of hiding them.

- [ ] **Step 5: Import the overlay helpers into the importer**

In `src/app/api/config/import/route.ts`, make the `@/lib/tombstones` import line read **exactly** this. The read sweeps already touch this file, so the line may exist with only `liveSamplesOnly` in it — extend the named list in that case rather than adding a second import:

```ts
import { liveSamplesOnly, nextSampleIndex, tombstoneSamples } from '@/lib/tombstones';
```

Place it after `import { audit, getRequestContext } from '@/lib/audit';` (line 25) if it is absent.

- [ ] **Step 6: Convert the replace to tombstone-and-append, inside one transaction**

Replace lines 523-539 — the block that begins `// Replace samples if provided, and if no golden set pins them.` and ends with the `sampleCount` update — with:

```ts
            // Replace samples if provided, and if no golden set pins them.
            if (replaceSamples && configDataset.samples) {
              // Sorted by the document's own `index`, so this array's ORDINAL
              // POSITIONS are the corpus's intended order — the same
              // discipline the golden-item replace applies to `itemData`.
              const incoming = [...configDataset.samples].sort((a, b) => a.index - b.index);

              // ONE transaction — this section never had one, so a failure
              // between the two writes below used to leave a corpus with every
              // row hidden and nothing to show. Everything BEFORE this in the
              // document (projects, rubrics, models, the dataset row) is still
              // committed independently, which is why the pinned case above is
              // a reported skip and not a throw. The `{ maxWait, timeout }`
              // ceiling is the one the other bulk-write paths use
              // (golden-sets/route.ts's POST, golden-set-versions.ts's
              // forkGoldenSet): a document may carry a 620-row corpus today
              // and an order of magnitude more later, and 5s is thin for that.
              await prisma.$transaction(
                async (tx) => {
                  // Filtered on lifecycle, exactly as
                  // tombstoneReplacedGoldenItems filters `tombstonedAt: null`:
                  // a row hidden by an earlier delete keeps the reason it was
                  // hidden with, rather than having this one written over it.
                  const outgoing = await tx.datasetSample.findMany({
                    where: { datasetId: existing.id, ...liveSamplesOnly() },
                    select: { id: true },
                  });
                  if (outgoing.length > 0) {
                    await tombstoneSamples(
                      tx,
                      outgoing.map((s) => s.id),
                      'config-import-replace'
                    );
                  }

                  // Retained rows KEEP their ordinals — `@@unique([datasetId,
                  // index])` is deliberately not partial — so the replacements
                  // cannot land at the document's raw index values without
                  // colliding with the rows just hidden (P2002, aborting the
                  // whole import). POSITION + high-water mark, not raw index +
                  // mark, for the reason the golden-item replace gives: a
                  // fresh export emits the indices this replace wrote, so
                  // adding the mark to a raw index compounds it on every
                  // export→edit→import cycle and an `Int` overflows after ~31
                  // of them. Packing to positions also closes the gaps a
                  // filtered export leaves behind.
                  const offset = await nextSampleIndex(tx, existing.id);
                  await tx.datasetSample.createMany({
                    data: incoming.map((s, position) => ({
                      datasetId: existing.id,
                      index: position + offset,
                      input: s.input,
                      expected: s.expected ?? null,
                      metadata: s.metadata ? JSON.stringify(s.metadata) : null,
                    })),
                  });

                  // Still the document's length, and still correct: after
                  // tombstone-and-append the LIVE set IS the incoming rows.
                  await tx.dataset.update({
                    where: { id: existing.id },
                    data: { sampleCount: incoming.length },
                  });
                },
                { maxWait: 10_000, timeout: 60_000 }
              );
            }
```

- [ ] **Step 7: Correct the now-stale branch comment at `:477-492`**

Replace the comment block that begins `// ── The sample replace is the SECOND destructive path onto dataset` and ends `// dryRun preview says the same thing the real import will do.` with:

```ts
          // ── The sample replace is the second bulk-write path onto dataset
          // samples, and it carried none of the guard PUT /api/datasets/[id]/
          // samples has. Two things made it worse than that PUT:
          //
          //   1. It is gated on `changes.length > 0`, NOT on a sample diff.
          //      Merely RENAMING an annotated dataset reaches the replace.
          //   2. It ran outside any transaction. Projects, rubrics, models and
          //      the dataset row above are already committed, so a failure
          //      mid-replace stranded a half-applied document with a 500 that
          //      said nothing useful. The replace below now runs in one.
          //
          // The replace no longer DELETES — it tombstones the live rows and
          // appends the document's above the high-water mark — so it can no
          // longer raise the P2003 that `GoldenItem.sourceDatasetSampleId`
          // (`onDelete: Restrict`) used to raise here. THE SKIP STAYS ANYWAY,
          // and is now conservative rather than defensive: replacing under a
          // golden set would hide every row that set's items cite, and whether
          // an annotated corpus may be swapped out from under its annotations
          // is the lifecycle plan's call, not this route's. Checked before
          // `items.push` so the dryRun preview says the same thing the real
          // import will do.
```

- [ ] **Step 8: Correct the module-doc bullet at `:183-185`**

Replace:

```ts
 *   - Dataset samples are imported if present in the config — EXCEPT onto a
 *     dataset a golden set has annotated, where the wholesale replace is
 *     skipped and reported rather than raising a P2003 mid-document.
```

with:

```ts
 *   - Dataset samples are imported if present in the config. A replace
 *     TOMBSTONES the live rows and appends the document's above the corpus
 *     high-water mark — nothing is deleted, so nothing collides with the
 *     ordinals the hidden rows keep. It is still skipped and reported onto a
 *     dataset a golden set has annotated; see the note on that branch.
```

- [ ] **Step 9: Run both tests and watch them pass**

Run: `sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.db.config.ts tests/db/config-golden-sets.test.ts -t "M1"'`

Expected: 3 passed (the RENAMING skip test, the UNPINNED replace test, the re-import test).

- [ ] **Step 10: Run the whole file, then the two neighbouring config files**

Run: `sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.db.config.ts tests/db/config-golden-sets.test.ts tests/db/config-roundtrip-fidelity.test.ts tests/db/config-import-export.test.ts'`

Expected: all green. `config-roundtrip-fidelity.test.ts`'s "importing an export twice is idempotent" case must still report `samples: 2` — its second import is a `skip`, so this task's replace never runs there. If it reports 4, the diff at `:470` is reading an unfiltered `_count.samples`; fix that read, not this test.

- [ ] **Step 11: Typecheck and lint**

Run: `npx tsc --noEmit && npm run lint`

Expected: no errors.

- [ ] **Step 12: Commit**

```bash
git add src/app/api/config/import/route.ts tests/db/config-golden-sets.test.ts
git commit -m 'feat(a1): the importer replace tombstones and appends, in one transaction' -m 'The dataset section deleted every sample and re-created the document rows at their raw index values. With rows now retained, that is a guaranteed P2002 against the (datasetId, index) unique — so the replace hides the live rows with reason config-import-replace and appends the incoming above the high-water mark, packed to positions so repeated cycles cannot compound the offset. The section had no transaction of its own, so a failure mid-replace stranded a half-applied import; it has one now, with the same maxWait/timeout ceiling the other bulk-write paths use. The pin-skip guard stays: it can no longer raise P2003, but retiring it is the lifecycle plan. config-golden-sets.test.ts:852 asserted hard deletion by raw row count and is rewritten, plus a re-import case pinning that hidden rows do not inflate the diff.'
```

---

### Task 12: `POST /api/golden-sets` accepts `limit` — "the first N *live* samples"

**Files:**
- Modify: `src/app/api/golden-sets/shared.ts:86-104` (the `createGoldenSetSchema` doc block and the schema)
- Modify: `src/app/api/golden-sets/route.ts:141-148` (the server-side sample read)
- Modify: `src/app/golden-sets/page.tsx:228-244` (the create request body)
- Test: `tests/lib/golden-set-schemas.test.ts` (one new case after line 45)
- Test: `tests/db/golden-set-import.test.ts` (two new cases after line 201, plus the rate-limit fake)

**Interfaces:**
- Consumes: `liveSamplesOnly(): Prisma.DatasetSampleWhereInput` from `@/lib/tombstones` — **already spread into the `findMany` at `golden-sets/route.ts:141`** by the sample read sweep. This task adds `take`, not the filter. If the spread is missing when you open the file, the sweep did not land; stop and say so rather than adding it here.
- Consumes: the `Tombstone` model (`datasetSampleId String? @unique`, `isTombstone Boolean @default(true)`, `reason String?`).
- Produces: `createGoldenSetSchema` gains `limit?: number` (positive int, no upper bound) and refuses `sampleIndices` + `limit` together. The POST body is now `{ datasetId, protocol, name, description?, sampleIndices?, limit? }`.
- Produces: `limit: N` selects the first N rows of `DatasetSample` ordered by `index` **after** the live filter — N live items, not N-1, and never a 400.

- [ ] **Step 1: Write the failing schema test**

In `tests/lib/golden-set-schemas.test.ts`, insert after the `rejects duplicate sampleIndices` case (line 45):

```ts
  it('createGoldenSetSchema refuses sampleIndices and limit together — two different selections, not a precedence rule', () => {
    expect(() =>
      createGoldenSetSchema.parse({
        datasetId: 'd1',
        protocol: 'pairwise',
        name: 'Both',
        sampleIndices: [0, 1],
        limit: 5,
      })
    ).toThrow(/not both/);

    // Each ALONE still parses. A refusal that rejected both would satisfy the
    // assertion above while deleting the feature.
    expect(
      createGoldenSetSchema.parse({ datasetId: 'd1', protocol: 'pairwise', name: 'L', limit: 5 }).limit
    ).toBe(5);
    expect(
      createGoldenSetSchema.parse({ datasetId: 'd1', protocol: 'pairwise', name: 'S', sampleIndices: [3] })
        .sampleIndices
    ).toEqual([3]);
    // And omitting both is still "every live sample".
    expect(
      createGoldenSetSchema.parse({ datasetId: 'd1', protocol: 'pairwise', name: 'All' }).limit
    ).toBeUndefined();
  });
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run --config vitest.config.ts tests/lib/golden-set-schemas.test.ts -t "sampleIndices and limit"`

Expected: FAIL with `expected [Function] to throw an error` — `createGoldenSetSchema` is a plain `z.object` with no `.strict()`, so `limit` is silently stripped today and nothing throws.

- [ ] **Step 3: Add `limit` to the schema and make the two mutually exclusive**

In `src/app/api/golden-sets/shared.ts`, replace the doc block and schema at lines 86-104 with:

```ts
/**
 * `POST /api/golden-sets` — creation IS import (A0 design, "Creation is
 * import"). Two ways to select a subset, and they are MUTUALLY EXCLUSIVE:
 *
 *   - `sampleIndices` names `DatasetSample.index` values, IN THE ORDER GIVEN.
 *     Duplicates are rejected rather than silently minting two golden items
 *     from one source sample.
 *   - `limit` means "the first N LIVE samples, in index order". It exists
 *     because the caller cannot synthesise that list: `index` is a high-water
 *     ordinal, not a dense 0..n-1 sequence, the moment a sample is hidden — so
 *     `Array.from({ length: N }, (_, i) => i)` names hidden rows and the route
 *     400s on the first one it cannot resolve. Only the server knows which
 *     rows are live.
 *
 * Neither present = every live sample.
 *
 * Sending BOTH is a 400 rather than a precedence rule: they are two different
 * selections, and honouring one silently would import rows the caller did not
 * ask for.
 */
export const createGoldenSetSchema = z
  .object({
    datasetId: z.string().min(1),
    protocol: z.enum(['pointwise', 'pairwise', 'listwise']),
    name: z.string().min(1, 'Name is required').max(200),
    description: z.string().max(4000).optional(),
    sampleIndices: z
      .array(z.number().int().min(0))
      .min(1)
      .refine((v) => new Set(v).size === v.length, {
        message: 'sampleIndices must not contain duplicates',
      })
      .optional(),
    limit: z.number().int().min(1).optional(),
  })
  .refine((v) => v.sampleIndices === undefined || v.limit === undefined, {
    message: 'Send either sampleIndices or limit, not both — they select different rows.',
    path: ['limit'],
  });
```

- [ ] **Step 4: Run the unit file and watch it pass**

Run: `npx vitest run --config vitest.config.ts tests/lib/golden-set-schemas.test.ts`

Expected: all cases in the file pass, including the pre-existing ones (`.refine` wraps the object in a `ZodEffects`; `.parse` is unchanged, and nothing in the repo reads `createGoldenSetSchema.shape`).

- [ ] **Step 5: Write the failing DB tests**

In `tests/db/golden-set-import.test.ts`, first add the rate-limit fake directly under the two existing `vi.mock` calls (lines 8-9) — this file drives `requireAuth()` once per case against a REAL Redis sliding window keyed by client IP, and that 120/min budget is shared by every file in one `npm run test:db` run, so adding cases here without the fake can fail unrelated files:

```ts
vi.mock('@/lib/rate-limit-redis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rate-limit-redis')>();
  return {
    ...actual,
    apiLimiter: { check: vi.fn(async () => ({ ok: true, remaining: 999, resetAt: Date.now() + 60_000 })) },
  };
});
```

Then append these two cases inside the existing `describe`, after the `400s on a sampleIndices value that does not exist` case (line 201):

```ts
  it('limit: N imports the first N LIVE samples — a hidden row inside the window is skipped, not 400ed and not returned short', async () => {
    const user = await mkUser();
    mockSessionFor(user);

    // NON-VACUITY, two ways:
    //
    //  (a) The tombstone sits INSIDE the first N. At the tail, `limit: 5`
    //      returns the same five rows whether or not the read filters and
    //      whether or not `take` runs after the filter — the test would pass
    //      against exactly the code it exists to fail against.
    //  (b) The SECOND fixture row is an `isTombstone: false` tombstone, which
    //      is a LIVE row. Every other shape in this wave uses `true`, so a
    //      filter written as the simpler `{ tombstone: { is: null } }` passes
    //      all of them; here it would drop index 4 and shift the window.
    const hidden = await db.datasetSample.findFirstOrThrow({
      where: { datasetId: JUDGEBENCH_DATASET_ID, index: 2 },
    });
    await db.tombstone.create({
      data: { datasetSampleId: hidden.id, isTombstone: true, reason: 'fixture' },
    });
    const unhidden = await db.datasetSample.findFirstOrThrow({
      where: { datasetId: JUDGEBENCH_DATASET_ID, index: 4 },
    });
    await db.tombstone.create({ data: { datasetSampleId: unhidden.id, isTombstone: false } });

    const res = await POST(
      jsonRequest('http://localhost/api/golden-sets', 'POST', {
        datasetId: JUDGEBENCH_DATASET_ID,
        protocol: 'pairwise',
        name: 'JudgeBench first five live',
        limit: 5,
      })
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body._count.items).toBe(5);

    const items = await db.goldenItem.findMany({
      where: { goldenSetId: body.id },
      orderBy: { index: 'asc' },
      include: { sourceSample: { select: { index: true } } },
    });
    // 2 is hidden, so 5 is pulled up to fill the window; 4 carries a tombstone
    // row that says isTombstone: false, so it is live and stays put.
    expect(items.map((i) => i.sourceSample.index)).toEqual([0, 1, 3, 4, 5]);
    // GoldenItem.index is 0..n-1 over the SELECTION, never the sample's own.
    expect(items.map((i) => i.index)).toEqual([0, 1, 2, 3, 4]);
  });

  it('sending both limit and sampleIndices is a 400, creating nothing', async () => {
    const user = await mkUser();
    mockSessionFor(user);
    const before = await db.goldenSet.count();

    const res = await POST(
      jsonRequest('http://localhost/api/golden-sets', 'POST', {
        datasetId: JUDGEBENCH_DATASET_ID,
        protocol: 'pairwise',
        name: 'Both selections',
        sampleIndices: [0, 1],
        limit: 5,
      })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    // The route's standard zod envelope; the specific sentence rides in
    // `details`, which is what tells the caller which two keys collided.
    expect(JSON.stringify(body.details)).toContain('not both');
    await expect(db.goldenSet.count()).resolves.toBe(before);
  });
```

- [ ] **Step 6: Run them and watch them fail**

Run: `sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.db.config.ts tests/db/golden-set-import.test.ts -t "limit"'`

Expected: 2 failed. The first fails with `expected 619 to be 5 // Object.is equality` — the route does not know the key, so the whole live corpus is imported (620 if the read sweep's live filter is missing; either count fails on this same line). The second fails with `expected 201 to be 400`.

(If it instead errors with a Prisma `P2021`/`P2022` naming `Tombstone`, the test database has not replayed the overlay migration. Run `npm run test:db` once — it does `prisma migrate reset --force --skip-seed` first — then re-run the scoped command.)

- [ ] **Step 7: Cut the window in SQL, after the live filter**

In `src/app/api/golden-sets/route.ts`, the sample read at lines 141-148 already carries the live filter. Add the `take` so the block reads:

```ts
    // Samples are read SERVER-SIDE. Never through GET /api/datasets/[id],
    // which takes `samples: { take: 100 }` — that path imports 100 of 620,
    // errors nothing, and looks like it worked.
    const samples = await prisma.datasetSample.findMany({
      where: {
        datasetId: dataset.id,
        ...liveSamplesOnly(),
        ...(data.sampleIndices ? { index: { in: data.sampleIndices } } : {}),
      },
      orderBy: { index: 'asc' },
      select: { id: true, index: true, input: true, expected: true, metadata: true },
      // `limit` is "the first N LIVE samples", so the cut happens in SQL AFTER
      // the lifecycle filter and after the `index` ordering — never over a
      // window the caller guessed. Mutually exclusive with `sampleIndices`,
      // refused in the schema, so the two spreads above cannot both apply.
      ...(data.limit !== undefined ? { take: data.limit } : {}),
    });
```

Everything below is unchanged: `ordered` stays `samples` unless `sampleIndices` was given, and the `ordered.length === 0` → 400 `'Dataset has no samples'` guard still catches a corpus whose rows are all hidden.

- [ ] **Step 8: Run the DB tests and watch them pass**

Run: `sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.db.config.ts tests/db/golden-set-import.test.ts'`

Expected: all 8 cases pass (the 6 that were there, plus the 2 new ones).

- [ ] **Step 9: Send `limit` from the client instead of synthesising ordinals**

In `src/app/golden-sets/page.tsx`, replace the `sampleIndices` property and its comment (lines 236-242) inside the `JSON.stringify({ ... })` body with:

```ts
          // "The first N" is resolved SERVER-SIDE, because only the server
          // knows which rows are live. DatasetSample.index is a high-water
          // ordinal, not a dense 0..n-1 sequence, the moment a sample is
          // hidden — so the `Array.from({ length: N }, (_, i) => i)` this
          // replaced named hidden rows, and the route 400s on the first one it
          // cannot resolve. Omitted entirely = import every live sample;
          // GoldenItem.index is assigned 0..n-1 over the SELECTION, server-side.
          limit: limitSamples ? parsedLimit : undefined,
```

The `parsedLimit` guard above it (`!Number.isFinite(parsedLimit) || parsedLimit < 1` → toast) stays exactly as it is — it is what keeps a non-positive `limit` from reaching the schema's `.min(1)`.

- [ ] **Step 10: Read the rendered copy and confirm it makes no contiguity promise**

Read `src/app/golden-sets/page.tsx:530-553` — the bordered block holding the control. The two strings a user actually sees are the checkbox label `Import only the first N samples` (line 538) and the input hint `Subsetting is how a labelling session is made finite.` (line 546). Neither says "0..N-1", "consecutive", or "contiguous": "the first N samples" is now literally true of the live set. **Leave both strings unchanged** — the only contiguity claim in this file was the code comment deleted in Step 9.

- [ ] **Step 11: Typecheck and lint**

Run: `npx tsc --noEmit && npm run lint`

Expected: no errors. In particular `data.limit` must type-check off the `ZodEffects` — `.refine` preserves the inferred output type.

- [ ] **Step 12: Run the unit suite and the golden-set DB files**

Run: `npx vitest run --config vitest.config.ts && sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.db.config.ts tests/db/golden-sets.test.ts tests/db/golden-set-import.test.ts tests/db/access-matrix.test.ts'`

Expected: all green. `access-matrix.test.ts` drives `POST /api/golden-sets` among its probes and is the one that would notice if the schema change altered the 400/403 ordering.

- [ ] **Step 13: Commit**

```bash
git add src/app/api/golden-sets/shared.ts src/app/api/golden-sets/route.ts src/app/golden-sets/page.tsx tests/lib/golden-set-schemas.test.ts tests/db/golden-set-import.test.ts
git commit -m 'feat(a1): golden-set import takes limit, meaning the first N live samples' -m 'The create dialog built sampleIndices as Array.from({length: N}, (_, i) => i) under a comment asserting DatasetSample.index is 0-based and contiguous — the premise the tombstone overlay falsifies. Against a corpus with anything hidden that list names dead ordinals and the route 400s on the first one. The server now takes a limit param and cuts the window in SQL after the live filter and the index ordering, so N means N live rows; the client sends it. limit and sampleIndices are mutually exclusive in the schema, with a 400 that names both keys, because honouring one silently would import rows nobody asked for.'
```
