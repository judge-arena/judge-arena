# Plan L2 — The Revision Log Implementation Plan

> **Renamed 2026-08-16 from "Plan A2".** The lifecycle plans are now `L1`/`L2`, leaving `A0…A5`
> to `specs/2026-08-10-judge-training-engine-roadmap.md`, whose A2 is *the calibration engine* and
> is unrelated work. **Three classes of artifact keep the old label and cannot be changed:** the
> `feat(a1):` commit prefixes already in history; the `MUST NOT BE TOMBSTONE-FILTERED (A1)` markers
> and other `(A1)` comments in `src/`; and the header of
> `prisma/migrations/20260814120000_v2f_tombstone_overlay/migration.sql`, which is **applied** —
> Prisma checksums migration files and errors if one changes after application. Read `(A1)` in code
> as L1. This plan's own body still says "A1"/"A2" in places where it quotes source text that really
> does carry those letters; those quotes are correct as written.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record *every* mutation to a dataset sample — edits as well as deletes — so the text a row held before a change is recoverable, and so "we record all mutations in a developing state" is literally true rather than true only of deletions.

**Architecture:** An append-only `SampleRevision` table, one row per mutation, carrying the sample's values **as they stood before the change**. `Tombstone` (from A1) remains the *current-state* projection that read filters consult; `SampleRevision` is the *log* nobody filters on. They cannot be one table: `Tombstone` needs `@unique` per entity to be a to-one relation and to make `upsert` correct, and a log needs many rows per entity.

**Tech Stack:** Next.js 15 (app router, `params` as a Promise), Prisma 6.19.2 + PostgreSQL 16, zod, vitest.

**Spec:** `docs/superpowers/specs/2026-08-14-dataset-lifecycle-and-tombstone-overlay-design.md` — read the "The overlay and the log" section before Task 1.

**Follows:** Plan L1 (`docs/superpowers/plans/2026-08-14-l1-tombstone-overlay.md`) — **which must be merged first.** **Precedes:** Plan B (the lifecycle).

## What A1 left for this plan

A1 delivered the overlay and hooked four destructive verbs. Three things it left standing are A2's:

- **`PATCH /api/datasets/[id]/samples` is untouched by A1.** It still overwrites `input`/`expected`/`metadata` in place with no history. A2 owns it end to end.
- **`restoreSample(tx, id)` exists in `src/lib/tombstones.ts` with no caller.** A1 implemented and unit-tested it because the filters' `NOT` formulation is only justified by an `isTombstone: false` row being reachable, and because A1's DB tests needed a way to produce one. A2 gives it a route.
- **A1's `DELETE`, `PUT` and config-importer verbs write no revision.** A2 adds that write to each, which is the one place these two plans touch the same transactions. A1's implementers were told to leave those transactions shaped so a second write drops in cleanly.

## Global Constraints

- **Migration directory:** `prisma/migrations/20260815120000_v2g_sample_revisions/`. Authored via `prisma migrate diff` per `CONTRIBUTING.md:407-443`, with a prose header naming the phase and every hand edit. **Never `prisma db push`.** This migration needs **no** hand edit — unlike A1's, it has no `CHECK` — so it adds **no** row to CONTRIBUTING's pseudo-drift table. Say so in the header, so a reader does not go looking.
- **`npm run test:db` runs `prisma migrate reset --force --skip-seed`,** replaying only *committed* migrations. A schema edit without a committed migration surfaces as a confusing `P2022`.
- **Never lower a coverage floor.** Floors sit 2pp (aggregate) / 3pp (per-glob) below actuals per `vitest.db.config.ts:42-73`. If actuals move, update only the "Actuals as of" prose. The DB suite's coverage jitters ±2 branches run-to-run — measure more than once near a floor.
- **`src/app/api/**` is outside every coverage `include`; `src/lib/**` is measured by both suites.**
- **`requireScope` is mandatory on every route**; `optionalAuth()` throws so it goes inside the `try` with `if (error instanceof RateLimitedError) return error.response;` first in the `catch`.
- **Any new unawaited write must be wrapped in `trackBackgroundWrite`** (`src/lib/background-writes.ts`).
- **The DB suite shares a finite 120/min Redis rate-limit budget.** Route-driving tests consume it globally; use the `vi.mock('@/lib/rate-limit-redis')` fake at `tests/db/access-matrix.test.ts:94-100`.
- **Do not assert an absolute suite count in any task.** The contract each task verifies is **zero failures, and no fewer tests than the previous task left.** Record the number you observe in your report.
- **Local Postgres** is the podman container `judge-arena-pg` on `localhost:5432`. **Real production is the Kubernetes pod `judge-arena-pg-1` in namespace `tenant-public` and must never be touched.**
- **Demonstrate discrimination, do not assert it.** Break the thing under test, observe the specific failure, restore, confirm byte-identical by sha256, and put that evidence in the report.

---

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `prisma/migrations/20260815120000_v2g_sample_revisions/migration.sql` | The one migration. No hand edits. |
| `src/lib/sample-revisions.ts` | `recordSampleRevision` and the `SampleChangeType` union. The single definition of "a mutation was recorded". |
| `tests/lib/sample-revisions.test.ts` | Unit tests for the writer's payload shape. |
| `tests/db/sample-revision.test.ts` | The log against a real database: edit, delete, restore, ordering, anonymisation. |
| `src/app/api/datasets/[id]/samples/[sampleId]/revisions/route.ts` | `GET` — the history of one sample. |

**Modified**

| File | Change |
|---|---|
| `prisma/schema.prisma` | `SampleRevision` model; `revisions SampleRevision[]` on `DatasetSample`; `sampleRevisions SampleRevision[]` on `User`. |
| `src/app/api/datasets/[id]/samples/route.ts` | `PATCH` records before updating; `DELETE` and `PUT` record on the rows they hide. |
| `src/app/api/config/import/route.ts` | The sample replace records on the rows it hides. |
| `tests/db/config-roundtrip-fidelity.test.ts` | `COVERAGE` gains `SampleRevision`. |

---

## The interface contract

Defined once, in Task 2. No task may rename or re-shape these.

```ts
// src/lib/sample-revisions.ts

/** Why a revision row exists. */
export type SampleChangeType = 'edit' | 'delete' | 'restore';

/**
 * Append one revision for `datasetSampleId`, carrying the values as they
 * stood BEFORE the change.
 *
 * `before` is omitted for 'delete' and 'restore', which change no content —
 * passing it for those is a type error, not a silent no-op.
 *
 * MUST be called with the same tx as the mutation it records, so a rolled-back
 * mutation leaves no revision claiming it happened.
 */
export function recordSampleRevision(
  tx: Prisma.TransactionClient,
  args: {
    datasetSampleId: string;
    changeType: SampleChangeType;
    actorId: string | null;
    before?: { input: string; expected: string | null; metadata: string | null };
  }
): Promise<void>;

/** Append one revision per id, for the bulk verbs. Same transaction rule. */
export function recordSampleRevisions(
  tx: Prisma.TransactionClient,
  args: {
    datasetSampleIds: string[];
    changeType: Extract<SampleChangeType, 'delete' | 'restore'>;
    actorId: string | null;
  }
): Promise<number>;
```

---

## Task list

| Task | Deliverable |
|---|---|
| 1 | `SampleRevision` model, the `v2g` migration, the `COVERAGE` entry. |
| 2 | `src/lib/sample-revisions.ts` — both writers — with unit tests pinning their payloads. |
| 3 | `PATCH` records the prior values before updating in place. The task that makes "edits get a history" true. |
| 4 | `DELETE`, `PUT` and the config importer record on every row they hide. |
| 5 | `POST /api/datasets/[id]/samples/[sampleId]/restore` — the first caller of A1's `restoreSample`, recording a `restore` revision. |
| 6 | `GET /api/datasets/[id]/samples/[sampleId]/revisions` — the history, newest first, owner-only. |

---

## Decisions this plan makes, and why

**The log stores values *before* the change, not after.** The current values are already on the row; storing them again would double every sample's storage and answer a question nobody asks. "What did this say before?" is the question a history exists for, and reconstructing it from after-images requires reading the whole chain.

**`delete` and `restore` rows carry no content.** They change no text, so a before-image would be a copy of the current row with no information in it. The type makes this a compile error rather than a convention.

**`actorId` is `onDelete: SetNull`,** matching `GoldenLabel.annotatorId`. Account deletion anonymises rather than destroying, and two deleted actors must be able to coexist on one sample's history — which is why there is no unique constraint anywhere on this table.

**No revision is written for sample *creation*.** A row's first state is the row itself; a creation revision would carry an empty before-image. The `createdAt` on `DatasetSample` already answers "when did this appear".

**The log is never filtered by the overlay.** `liveSamplesOnly()` has no business here: the history of a hidden sample is exactly what you want to read when deciding whether to restore it. Task 6's route reads revisions for a sample regardless of its tombstone, and says so in a comment — this is the one place in either plan where reading a hidden row is the point.

**A2 does not surface history in the UI.** The `GET` route exists so the log is reachable and testable; a history panel on the dataset page is a UI change with no test harness to verify it and belongs with whoever next works on that page.

---

## Task bodies

### Task 1: The `SampleRevision` model, the `v2g` migration, and the `COVERAGE` entry

**Files:**
- Modify: `prisma/schema.prisma` — `DatasetSample` relations block (add `revisions SampleRevision[]`), `User` relations block (add `sampleRevisions SampleRevision[]`), and append the `SampleRevision` model at end of file
- Create: `prisma/migrations/20260815120000_v2g_sample_revisions/migration.sql`
- Test: `tests/db/config-roundtrip-fidelity.test.ts` — new `SampleRevision` entry in `COVERAGE`

**Interfaces:**
- Consumes: nothing from A2. Assumes A1 is merged, so `Tombstone` exists.
- Produces: Prisma model `SampleRevision` with scalar columns `id: String`, `datasetSampleId: String`, `changeType: String`, `input: String?`, `expected: String?`, `metadata: String?`, `actorId: String?`, `at: DateTime`; relations `datasetSample: DatasetSample`, `actor: User?`; back-relations `DatasetSample.revisions` and `User.sampleRevisions`; the `tx.sampleRevision` delegate.

- [ ] **Step 1: Write the failing test — add `SampleRevision` to `COVERAGE`**

The fidelity suite iterates `Object.entries(COVERAGE)` and never the datamodel, so a model absent from the map is unchecked. Adding the entry first is what makes this task test-driven: it names a model that does not exist yet.

Open `tests/db/config-roundtrip-fidelity.test.ts` and insert this into the `COVERAGE` object, immediately after the `Tombstone` entry A1 added:

```ts
  // Empty `exported`, for the same reason as Tombstone: a revision records
  // WHAT HAPPENED ON THIS INSTANCE. The config document describes a dataset's
  // current content, not its history, and carrying revisions would attribute
  // edits made here to an import made elsewhere — the same forged-attribution
  // argument that keeps GoldenLabel out of the document.
  //
  // Not a knownGap: nothing here should round-trip. Recording one would also
  // fail the gap ledger below, whose expected object is locked to exactly
  // {Rubric, Dataset, GoldenSet}.
  SampleRevision: {
    exported: [],
    excludedByDesign: {
      id: SURROGATE,
      datasetSampleId:
        'instance-local FK to a row whose id is itself instance-local, the same argument as GoldenItem.sourceDatasetSampleId',
      changeType:
        'describes a mutation that happened on THIS instance; an import performs its own mutations and records its own rows',
      input:
        'the PRE-EDIT text of a sample on this instance. The document carries the sample\'s CURRENT text; carrying its history would let an import resurrect text the target instance never had',
      expected: 'same as input one column up — a before-image, not current content',
      metadata: 'same as input two columns up — a before-image, not current content',
      actorId:
        'a real User FK with no portable representation, exactly as GoldenLabel.annotatorId: carrying it across instances would forge an attribution',
      at: TIMESTAMP,
    },
    knownGaps: {},
  },
```

The eight keys are exactly the model's eight scalar columns. The stale-key guard filters `f.kind === 'scalar' || f.kind === 'enum'`, so the two relation fields are correctly absent — listing either fails that guard.

- [ ] **Step 2: Run it and watch it fail**

Run:

```bash
sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.db.config.ts tests/db/config-roundtrip-fidelity.test.ts -t "SampleRevision"'
```

Expected: FAIL with `SampleRevision is not in the Prisma datamodel: expected undefined not to be undefined`. That is the `expect(model, …).toBeDefined()` line firing — `Prisma.dmmf.datamodel.models` comes from the generated client and has no `SampleRevision` yet.

- [ ] **Step 3: Add the model and its two back-relations**

In `prisma/schema.prisma`, add to the `DatasetSample` relations block, beside the `tombstone Tombstone?` line A1 added:

```prisma
  revisions   SampleRevision[]
```

Add to the `User` relations block:

```prisma
  sampleRevisions SampleRevision[]
```

Append at the end of the file:

```prisma

// ─── The revision log (A2) ──────────────────────────────────────────────────
// Append-only. One row per mutation to a DatasetSample, carrying the values as
// they stood BEFORE the change.
//
// Deliberately separate from Tombstone, and the two are not merge-able:
// Tombstone is the CURRENT-STATE projection the read filters consult and needs
// @unique per entity to be a to-one relation and to make upsert correct; a log
// needs MANY rows per entity and therefore cannot carry that uniqueness.
//
// Nothing filters this table by the overlay. The history of a HIDDEN sample is
// exactly what you read when deciding whether to restore it.

model SampleRevision {
  id String @id @default(cuid())

  datasetSampleId String
  datasetSample   DatasetSample @relation(fields: [datasetSampleId], references: [id], onDelete: Cascade)

  // 'edit' | 'delete' | 'restore'. A String rather than an enum, matching
  // GoldenLabel.tombstonedReason and Dataset.source — this schema uses enums
  // only where Prisma already had one (Visibility, RunProtocol).
  changeType String

  // The values BEFORE the change. Null on 'delete' and 'restore', which change
  // no content, so a before-image would be a copy of the live row.
  input    String?
  expected String?
  metadata String?

  // SetNull, matching GoldenLabel.annotatorId: account deletion anonymises
  // rather than destroying. There is deliberately NO unique constraint on this
  // table, so two deleted actors coexist freely on one sample's history.
  actorId String?
  actor   User?   @relation(fields: [actorId], references: [id], onDelete: SetNull)

  at DateTime @default(now())

  // Serves the only query: one sample's history, newest first.
  @@index([datasetSampleId, at])
}
```

- [ ] **Step 4: Generate the migration**

```bash
DATABASE_URL="$(grep -m1 '^DATABASE_URL=' .env.local | cut -d= -f2-)" \
  npx prisma migrate diff \
    --from-schema-datasource prisma/schema.prisma \
    --to-schema-datamodel prisma/schema.prisma \
    --script > /tmp/v2g.sql
cat /tmp/v2g.sql
```

Read the output. It should contain exactly one `CREATE TABLE "SampleRevision"`, one `CREATE INDEX` for `@@index([datasetSampleId, at])`, and two `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY` statements. **If it contains anything else, stop** — the schema has drifted and a later migration will fight this one.

- [ ] **Step 5: Write the migration with its prose header**

```bash
mkdir -p prisma/migrations/20260815120000_v2g_sample_revisions
```

Create `prisma/migrations/20260815120000_v2g_sample_revisions/migration.sql` with this header above the generated SQL:

```sql
-- v2g — the sample revision log (Plan A2)
--
-- Append-only history for DatasetSample mutations. One row per edit, delete or
-- restore, carrying the values as they stood BEFORE the change.
--
-- GENERATED VERBATIM by `prisma migrate diff`. There are NO hand edits in this
-- migration — unlike 20260814120000_v2f_tombstone_overlay, which hand-adds a
-- CHECK constraint. Consequently this migration adds NO row to CONTRIBUTING's
-- "Known migrate-diff pseudo-drift" table; if you are here looking for one,
-- there is nothing to find.
--
-- Companion to, not a replacement for, the Tombstone overlay in v2f. Tombstone
-- is current state (one row per entity, @unique, consulted by every read
-- filter); this is the log (many rows per entity, filtered by nothing).
```

Then append `/tmp/v2g.sql` verbatim.

- [ ] **Step 6: Apply to the LOCAL dev database and regenerate the client**

```bash
DATABASE_URL="$(grep -m1 '^DATABASE_URL=' .env.local | cut -d= -f2-)" \
  PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION=approved-plan-2026-08-15-a2-revision-log \
  npx prisma migrate deploy
npx prisma generate
```

This hits `localhost:5432` only. **Never the cluster pod `judge-arena-pg-1`.**

- [ ] **Step 7: Verify the migration produces no drift**

```bash
DATABASE_URL="$(grep -m1 '^DATABASE_URL=' .env.local | cut -d= -f2-)" \
  npx prisma migrate diff \
    --from-schema-datasource prisma/schema.prisma \
    --to-schema-datamodel prisma/schema.prisma \
    --script
```

Expected output: `-- This is an empty migration.`

- [ ] **Step 8: Run the fidelity test and watch it pass**

```bash
sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.db.config.ts tests/db/config-roundtrip-fidelity.test.ts'
```

Expected: PASS, including the gap-ledger assertion — which stays green because this entry records no `knownGaps`.

- [ ] **Step 9: Run the full suites**

```bash
npx tsc --noEmit && npm run lint && npm test && npm run test:db
```

Expected: zero failures. Record the observed counts in your report.

- [ ] **Step 10: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260815120000_v2g_sample_revisions tests/db/config-roundtrip-fidelity.test.ts
git commit -m "feat(a2): add the SampleRevision log

Append-only history for DatasetSample mutations, carrying the values as
they stood before each change. Separate from the Tombstone overlay
because current-state needs @unique per entity and a log cannot have it."
```

---

### Task 2: `src/lib/sample-revisions.ts` — both writers, with unit tests

**Files:**
- Create: `src/lib/sample-revisions.ts`
- Test: `tests/lib/sample-revisions.test.ts`

**Interfaces:**
- Consumes: `Prisma.TransactionClient`; the `tx.sampleRevision` delegate from Task 1.
- Produces: `SampleChangeType`, `recordSampleRevision`, `recordSampleRevisions` — exactly the signatures in this plan's interface contract.

- [ ] **Step 1: Write the failing unit test**

Create `tests/lib/sample-revisions.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { recordSampleRevision, recordSampleRevisions } from '@/lib/sample-revisions';

/**
 * These assert the PAYLOAD the writers hand Prisma, using a stub client, for
 * the same reason tests/lib/golden-sets.test.ts:388-426 asserts a returned
 * where-fragment: the value is the contract, and a DB round trip would hide a
 * wrong field name behind a passing insert.
 */
function stubTx() {
  const createMany = vi.fn(async () => ({ count: 0 }));
  const create = vi.fn(async () => ({}));
  return { sampleRevision: { create, createMany } } as never;
}

describe('recordSampleRevision', () => {
  it('an edit carries the BEFORE values, the actor, and no id of its own', async () => {
    const tx = stubTx();
    await recordSampleRevision(tx, {
      datasetSampleId: 'smp_1',
      changeType: 'edit',
      actorId: 'usr_1',
      before: { input: 'old question', expected: 'old answer', metadata: '{"split":"train"}' },
    });

    expect((tx as never as ReturnType<typeof stubTx>).sampleRevision.create).toHaveBeenCalledWith({
      data: {
        datasetSampleId: 'smp_1',
        changeType: 'edit',
        actorId: 'usr_1',
        input: 'old question',
        expected: 'old answer',
        metadata: '{"split":"train"}',
      },
    });
  });

  it('a delete carries NO content columns — a before-image would duplicate the live row', async () => {
    const tx = stubTx();
    await recordSampleRevision(tx, {
      datasetSampleId: 'smp_1',
      changeType: 'delete',
      actorId: 'usr_1',
    });

    const call = (tx as never as ReturnType<typeof stubTx>).sampleRevision.create.mock.calls[0][0];
    expect(call.data).toEqual({
      datasetSampleId: 'smp_1',
      changeType: 'delete',
      actorId: 'usr_1',
    });
    // Explicit: absent, not null. A null would claim "this row had no input",
    // which is false — it had one, and it still does.
    expect('input' in call.data).toBe(false);
    expect('expected' in call.data).toBe(false);
    expect('metadata' in call.data).toBe(false);
  });

  it('a null actor is written through, not dropped — an anonymised edit is still an edit', async () => {
    const tx = stubTx();
    await recordSampleRevision(tx, {
      datasetSampleId: 'smp_1',
      changeType: 'restore',
      actorId: null,
    });

    const call = (tx as never as ReturnType<typeof stubTx>).sampleRevision.create.mock.calls[0][0];
    expect(call.data.actorId).toBeNull();
  });
});

describe('recordSampleRevisions', () => {
  it('writes one row per id in a single createMany and returns the count', async () => {
    const tx = stubTx();
    const n = await recordSampleRevisions(tx, {
      datasetSampleIds: ['smp_1', 'smp_2'],
      changeType: 'delete',
      actorId: 'usr_1',
    });

    expect((tx as never as ReturnType<typeof stubTx>).sampleRevision.createMany).toHaveBeenCalledWith({
      data: [
        { datasetSampleId: 'smp_1', changeType: 'delete', actorId: 'usr_1' },
        { datasetSampleId: 'smp_2', changeType: 'delete', actorId: 'usr_1' },
      ],
    });
    expect(n).toBe(2);
  });

  it('de-duplicates ids, so a repeated id in one request logs one revision', async () => {
    const tx = stubTx();
    const n = await recordSampleRevisions(tx, {
      datasetSampleIds: ['smp_1', 'smp_1', 'smp_2'],
      changeType: 'delete',
      actorId: null,
    });
    expect(n).toBe(2);
    expect(
      (tx as never as ReturnType<typeof stubTx>).sampleRevision.createMany.mock.calls[0][0].data
    ).toHaveLength(2);
  });

  it('an empty id list is a no-op that writes nothing and returns 0', async () => {
    const tx = stubTx();
    const n = await recordSampleRevisions(tx, {
      datasetSampleIds: [],
      changeType: 'delete',
      actorId: 'usr_1',
    });
    expect(n).toBe(0);
    expect((tx as never as ReturnType<typeof stubTx>).sampleRevision.createMany).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run --config vitest.config.ts tests/lib/sample-revisions.test.ts
```

Expected: FAIL at collection with `Failed to resolve import "@/lib/sample-revisions"`. The module does not exist yet.

- [ ] **Step 3: Implement `src/lib/sample-revisions.ts`**

```ts
import type { Prisma } from '@prisma/client';

/**
 * Why a revision row exists.
 *
 * A String column rather than a Prisma enum, matching
 * GoldenLabel.tombstonedReason and Dataset.source — this schema uses enums
 * only where one already existed (Visibility, RunProtocol).
 */
export type SampleChangeType = 'edit' | 'delete' | 'restore';

type BeforeImage = {
  input: string;
  expected: string | null;
  metadata: string | null;
};

/**
 * Append one revision for `datasetSampleId`, carrying the values as they stood
 * BEFORE the change.
 *
 * The log stores before-images rather than after-images because the current
 * values are already on the row: "what did this say before?" is the only
 * question a history answers, and reconstructing it from after-images means
 * reading the whole chain.
 *
 * `before` is omitted for 'delete' and 'restore', which change no content — the
 * signature makes passing it a type error rather than a silent no-op, and the
 * columns are left ABSENT rather than null, because a null would claim the row
 * had no input when in fact it had one and still does.
 *
 * MUST be called with the same tx as the mutation it records, so a rolled-back
 * mutation leaves behind no revision claiming it happened.
 */
export async function recordSampleRevision(
  tx: Prisma.TransactionClient,
  args:
    | {
        datasetSampleId: string;
        changeType: 'edit';
        actorId: string | null;
        before: BeforeImage;
      }
    | {
        datasetSampleId: string;
        changeType: Extract<SampleChangeType, 'delete' | 'restore'>;
        actorId: string | null;
        before?: undefined;
      }
): Promise<void> {
  await tx.sampleRevision.create({
    data: {
      datasetSampleId: args.datasetSampleId,
      changeType: args.changeType,
      actorId: args.actorId,
      ...(args.before ? args.before : {}),
    },
  });
}

/**
 * Append one revision per id, for the bulk verbs (DELETE, PUT, the config
 * importer's replace).
 *
 * Ids are de-duplicated first, so a request naming the same sample twice logs
 * one revision rather than two — matching `tombstoneSamples` in
 * src/lib/tombstones.ts, which de-duplicates for the same reason.
 *
 * Only 'delete' and 'restore' are bulk operations; a bulk edit would need a
 * distinct before-image per id, which no caller has.
 *
 * Same transaction rule as `recordSampleRevision`.
 */
export async function recordSampleRevisions(
  tx: Prisma.TransactionClient,
  args: {
    datasetSampleIds: string[];
    changeType: Extract<SampleChangeType, 'delete' | 'restore'>;
    actorId: string | null;
  }
): Promise<number> {
  const ids = [...new Set(args.datasetSampleIds)];
  if (ids.length === 0) return 0;

  await tx.sampleRevision.createMany({
    data: ids.map((datasetSampleId) => ({
      datasetSampleId,
      changeType: args.changeType,
      actorId: args.actorId,
    })),
  });

  return ids.length;
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
npx vitest run --config vitest.config.ts tests/lib/sample-revisions.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Prove the tests discriminate**

Break each of the three properties in turn, observe the named failure, restore, and confirm byte-identical:

```bash
sha256sum src/lib/sample-revisions.ts > /tmp/rev.sha
```

1. Change `...(args.before ? args.before : {})` to `...{ input: null, expected: null, metadata: null }`.
   Expected: the delete test fails on `expect('input' in call.data).toBe(false)`.
2. Remove the `[...new Set(...)]` de-duplication.
   Expected: the de-duplication test fails with `expected 3 to be 2`.
3. Change `if (ids.length === 0) return 0;` to fall through.
   Expected: the empty-list test fails on `not.toHaveBeenCalled()`.

Restore after each, then:

```bash
sha256sum -c /tmp/rev.sha
```

Expected: `src/lib/sample-revisions.ts: OK`. Put all three observed failure messages in your report.

- [ ] **Step 6: Run the full suites**

```bash
npx tsc --noEmit && npm run lint && npm test && npm run test:db
```

Expected: zero failures. Note `src/lib/sample-revisions.ts` lands in both coverage `include` sets while only the unit suite exercises it, so the DB-suite aggregate dips slightly. Margins hold (floors are 2pp/3pp below actuals) and Task 3 recovers it. **Do not touch a floor.**

- [ ] **Step 7: Commit**

```bash
git add src/lib/sample-revisions.ts tests/lib/sample-revisions.test.ts
git commit -m "feat(a2): the revision writers

recordSampleRevision and recordSampleRevisions, storing before-images and
taking the caller's transaction so a rolled-back mutation leaves no
revision claiming it happened."
```

---

### Task 3: `PATCH` records the prior values before updating

**Files:**
- Modify: `src/app/api/datasets/[id]/samples/route.ts` — the `PATCH` handler (`export async function PATCH` at `:97`; the sample lookup at `:120-127`; the update at `:133-146`)
- Test: `tests/db/sample-revision.test.ts` (create)

**Interfaces:**
- Consumes: `recordSampleRevision(tx, { datasetSampleId, changeType: 'edit', actorId, before })` from Task 2.
- Produces: nothing new. `PATCH`'s response shape is unchanged.

**This is the task that makes "edits get a history" true.** Everything else in A2 logs events that A1 already made non-destructive; this one recovers information that was previously overwritten and lost.

- [ ] **Step 1: Write the failing DB test**

Create `tests/db/sample-revision.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { db, truncateAll } from './helpers/db';
import { mkUser } from './helpers/factories';
import { PATCH } from '@/app/api/datasets/[id]/samples/route';

// The DB suite shares a 120/min Redis budget across FILES, so route-driving
// tests here use the established fake rather than the real limiter — see
// tests/db/access-matrix.test.ts:94-100.
vi.mock('@/lib/rate-limit-redis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rate-limit-redis')>();
  return {
    ...actual,
    apiLimiter: { check: vi.fn(async () => ({ ok: true, remaining: 999, resetAt: Date.now() + 60_000 })) },
  };
});

vi.mock('next-auth', () => ({ getServerSession: vi.fn() }));
const { getServerSession } = await import('next-auth');

function sessionFor(user: { id: string; email: string }) {
  (getServerSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    user: { id: user.id, email: user.email, name: 'Rev Tester' },
  });
}

function jsonRequest(body: unknown) {
  return new Request('http://localhost/api/datasets/x/samples', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function mkDatasetWithSample(userId: string) {
  const dataset = await db.dataset.create({
    data: {
      name: 'Revision Fixture',
      slug: `rev-fixture-${Date.now()}`,
      userId,
      visibility: 'private',
      inputType: 'query-response',
      sampleCount: 1,
    },
  });
  const sample = await db.datasetSample.create({
    data: {
      datasetId: dataset.id,
      index: 0,
      input: 'original question',
      expected: 'original answer',
      metadata: JSON.stringify({ split: 'train' }),
    },
  });
  return { dataset, sample };
}

describe('PATCH /api/datasets/[id]/samples — the revision log', () => {
  beforeEach(async () => {
    await truncateAll();
    vi.clearAllMocks();
  });

  it('an edit records the values as they stood BEFORE it, not after', async () => {
    const owner = await mkUser();
    const { dataset, sample } = await mkDatasetWithSample(owner.id);
    sessionFor(owner);

    const res = await PATCH(
      jsonRequest({ sampleId: sample.id, input: 'edited question', expected: 'edited answer' }),
      { params: Promise.resolve({ id: dataset.id }) }
    );
    expect(res.status).toBe(200);

    // The row now holds the NEW text...
    const after = await db.datasetSample.findUnique({ where: { id: sample.id } });
    expect(after?.input).toBe('edited question');

    // ...and the log holds the OLD text. This is the whole point of the task:
    // before A2, 'original question' was gone the moment the update committed.
    const revisions = await db.sampleRevision.findMany({
      where: { datasetSampleId: sample.id },
    });
    expect(revisions).toHaveLength(1);
    expect(revisions[0].changeType).toBe('edit');
    expect(revisions[0].input).toBe('original question');
    expect(revisions[0].expected).toBe('original answer');
    expect(revisions[0].metadata).toBe(JSON.stringify({ split: 'train' }));
    expect(revisions[0].actorId).toBe(owner.id);
  });

  it('records the full before-image even when the request changes only one field', async () => {
    const owner = await mkUser();
    const { dataset, sample } = await mkDatasetWithSample(owner.id);
    sessionFor(owner);

    await PATCH(jsonRequest({ sampleId: sample.id, input: 'only input changed' }), {
      params: Promise.resolve({ id: dataset.id }),
    });

    // `expected` and `metadata` were not in the request, but the revision still
    // carries them: the log answers "what did this row look like before", not
    // "which keys were in the payload". A partial before-image would be
    // unusable for reconstruction.
    const rev = await db.sampleRevision.findFirst({ where: { datasetSampleId: sample.id } });
    expect(rev?.input).toBe('original question');
    expect(rev?.expected).toBe('original answer');
    expect(rev?.metadata).toBe(JSON.stringify({ split: 'train' }));
  });

  it('two edits leave two revisions, oldest first by `at`', async () => {
    const owner = await mkUser();
    const { dataset, sample } = await mkDatasetWithSample(owner.id);
    sessionFor(owner);

    await PATCH(jsonRequest({ sampleId: sample.id, input: 'second' }), {
      params: Promise.resolve({ id: dataset.id }),
    });
    await PATCH(jsonRequest({ sampleId: sample.id, input: 'third' }), {
      params: Promise.resolve({ id: dataset.id }),
    });

    const revisions = await db.sampleRevision.findMany({
      where: { datasetSampleId: sample.id },
      orderBy: { at: 'asc' },
    });
    expect(revisions.map((r) => r.input)).toEqual(['original question', 'second']);
  });

  it('a rolled-back edit leaves NO revision claiming it happened', async () => {
    const owner = await mkUser();
    const { dataset, sample } = await mkDatasetWithSample(owner.id);
    sessionFor(owner);

    // A sample id belonging to no dataset: the handler refuses before writing.
    const res = await PATCH(jsonRequest({ sampleId: 'smp_does_not_exist', input: 'x' }), {
      params: Promise.resolve({ id: dataset.id }),
    });
    expect(res.status).toBe(404);
    expect(await db.sampleRevision.count()).toBe(0);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.db.config.ts tests/db/sample-revision.test.ts'
```

Expected: FAIL on the first test with `expected [] to have a length of 1 but got +0` — `PATCH` writes no revision yet.

- [ ] **Step 3: Widen the sample lookup to fetch the before-image**

In `src/app/api/datasets/[id]/samples/route.ts`'s `PATCH`, the membership lookup currently selects only `datasetId`:

```ts
    const sample = await prisma.datasetSample.findUnique({
      where: { id: data.sampleId },
      select: { datasetId: true },
    });
```

Replace it with a lookup that also carries the values the revision needs. Note this read is **filtered** — A1's Task 8 added `...liveSamplesOnly()` here so a hidden sample 404s; keep that spread exactly as A1 left it:

```ts
    // The before-image the revision will carry. Selected here rather than
    // re-read inside the transaction because this lookup already runs, and a
    // second read would be a second round trip for the same row.
    //
    // `...liveSamplesOnly()` is A1's — a hidden sample must 404 rather than
    // stay silently editable. Do not drop it.
    const sample = await prisma.datasetSample.findFirst({
      where: { id: data.sampleId, ...liveSamplesOnly() },
      select: {
        datasetId: true,
        input: true,
        expected: true,
        metadata: true,
      },
    });
```

Add the import beside the existing `@/lib/tombstones` import A1 created:

```ts
import { liveSamplesOnly, nextSampleIndex, tombstoneSamples } from '@/lib/tombstones';
import { recordSampleRevision } from '@/lib/sample-revisions';
```

- [ ] **Step 4: Record the revision inside the same transaction as the update**

Replace the bare `prisma.datasetSample.update(...)` with a transaction that writes both:

```ts
    // One transaction, so a rolled-back update leaves no revision claiming it
    // happened — the property the "rolled-back edit" test pins.
    const updated = await prisma.$transaction(async (tx) => {
      await recordSampleRevision(tx, {
        datasetSampleId: data.sampleId,
        changeType: 'edit',
        actorId: session.user.id,
        before: {
          input: sample.input,
          expected: sample.expected,
          metadata: sample.metadata,
        },
      });

      return tx.datasetSample.update({
        where: { id: data.sampleId },
        data: updateData,
      });
    });
```

Keep whatever the handler already returns; only the write path changes.

- [ ] **Step 5: Run it and watch it pass**

```bash
sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.db.config.ts tests/db/sample-revision.test.ts'
```

Expected: PASS, 4 tests.

- [ ] **Step 6: Prove the before-image test discriminates**

The load-bearing claim is that the log holds the OLD text. A revision written with the NEW values would still produce one row of the right `changeType`, so the assertion must be on the content:

```bash
sha256sum src/app/api/datasets/[id]/samples/route.ts > /tmp/patch.sha
```

Change the `before:` block to read from `updateData` instead of `sample`, i.e. record the after-image. Re-run.

Expected: FAIL with `expected 'edited question' to be 'original question'`.

Restore, then `sha256sum -c /tmp/patch.sha` → `OK`. Put the observed message in your report.

- [ ] **Step 7: Run the full suites**

```bash
npx tsc --noEmit && npm run lint && npm test && npm run test:db && npm run test:integration
```

Expected: zero failures.

- [ ] **Step 8: Commit**

```bash
git add src/app/api/datasets/[id]/samples/route.ts tests/db/sample-revision.test.ts
git commit -m "feat(a2): PATCH records the prior values before updating

An edit previously overwrote sample text with no history. It now writes a
revision carrying the full before-image in the same transaction, so a
rolled-back edit leaves no revision claiming it happened."
```

---

### Task 4: `DELETE`, `PUT` and the config importer record on every row they hide

**Files:**
- Modify: `src/app/api/datasets/[id]/samples/route.ts` — the `DELETE` handler's transaction (beside its `tombstoneSamples` call) and the `PUT` handler's transaction (beside its `tombstoneSamples` call)
- Modify: `src/app/api/config/import/route.ts` — the dataset section's sample replace, beside its `tombstoneSamples` call
- Test: `tests/db/sample-revision.test.ts` (append)

**Interfaces:**
- Consumes: `recordSampleRevisions(tx, { datasetSampleIds, changeType: 'delete', actorId })` from Task 2; A1's `tombstoneSamples`, whose return value is the count of distinct ids now hidden.
- Produces: nothing new.

**These are the three places A1 and A2 touch the same transaction.** A1's implementers were asked to leave them shaped so a second write drops in. In each case the revision write goes **immediately before or after the `tombstoneSamples` call, inside the same `tx`** — never outside it.

- [ ] **Step 1: Write the failing tests**

Append to `tests/db/sample-revision.test.ts`. These need `DELETE` and `PUT` imported — extend the existing import at the top of the file:

```ts
import { DELETE, PATCH, PUT } from '@/app/api/datasets/[id]/samples/route';
```

Then append:

```ts
describe('the bulk verbs record a revision per hidden row', () => {
  beforeEach(async () => {
    await truncateAll();
    vi.clearAllMocks();
  });

  it('DELETE records one `delete` revision per sample it hides', async () => {
    const owner = await mkUser();
    const dataset = await db.dataset.create({
      data: {
        name: 'Bulk Fixture',
        slug: `bulk-${Date.now()}`,
        userId: owner.id,
        visibility: 'private',
        inputType: 'query-response',
        sampleCount: 2,
      },
    });
    const a = await db.datasetSample.create({
      data: { datasetId: dataset.id, index: 0, input: 'first', expected: null, metadata: null },
    });
    const b = await db.datasetSample.create({
      data: { datasetId: dataset.id, index: 1, input: 'second', expected: null, metadata: null },
    });
    sessionFor(owner);

    const res = await DELETE(
      new Request('http://localhost/api/datasets/x/samples', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sampleIds: [a.id, b.id] }),
      }),
      { params: Promise.resolve({ id: dataset.id }) }
    );
    expect(res.status).toBe(200);

    const revisions = await db.sampleRevision.findMany({ orderBy: { at: 'asc' } });
    expect(revisions).toHaveLength(2);
    expect(revisions.every((r) => r.changeType === 'delete')).toBe(true);
    expect(revisions.every((r) => r.actorId === owner.id)).toBe(true);
    // A delete changes no content, so the before-image columns stay NULL.
    expect(revisions.every((r) => r.input === null)).toBe(true);
  });

  it('a retried DELETE of an already-hidden id records NO second revision', async () => {
    const owner = await mkUser();
    const dataset = await db.dataset.create({
      data: {
        name: 'Retry Fixture',
        slug: `retry-${Date.now()}`,
        userId: owner.id,
        visibility: 'private',
        inputType: 'query-response',
        sampleCount: 1,
      },
    });
    const a = await db.datasetSample.create({
      data: { datasetId: dataset.id, index: 0, input: 'only', expected: null, metadata: null },
    });
    sessionFor(owner);

    const body = JSON.stringify({ sampleIds: [a.id] });
    const mk = () =>
      new Request('http://localhost/api/datasets/x/samples', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body,
      });

    await DELETE(mk(), { params: Promise.resolve({ id: dataset.id }) });
    const second = await DELETE(mk(), { params: Promise.resolve({ id: dataset.id }) });
    expect(second.status).toBe(200);

    // A1 made the retry converge on hidden rather than error. The log must
    // agree: the row was deleted ONCE. A second revision would claim a
    // deletion that did not happen, which is exactly the kind of false
    // history that makes a log worse than none.
    expect(await db.sampleRevision.count()).toBe(1);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

```bash
sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.db.config.ts tests/db/sample-revision.test.ts -t "bulk verbs"'
```

Expected: FAIL on the first with `expected [] to have a length of 2 but got +0`.

- [ ] **Step 3: Record in `DELETE`**

In the `DELETE` handler's transaction, beside the existing `tombstoneSamples` call:

```ts
      const hidden = await tombstoneSamples(tx, sampleIds);

      // One revision per row ACTUALLY hidden, not per id requested. A retried
      // delete converges on hidden without re-hiding anything, and the log
      // must agree — a second revision would record a deletion that did not
      // happen. `tombstoneSamples` returns exactly the ids it transitioned.
      await recordSampleRevisions(tx, {
        datasetSampleIds: newlyHiddenIds,
        changeType: 'delete',
        actorId: session.user.id,
      });
```

**Note for the implementer:** A1's `tombstoneSamples` returns a *count*, not the ids. To record only newly-hidden rows you need the ids, so read them inside the transaction before the tombstone write:

```ts
      const newlyHiddenIds = (
        await tx.datasetSample.findMany({
          where: { id: { in: sampleIds }, ...liveSamplesOnly() },
          select: { id: true },
        })
      ).map((s) => s.id);
```

This read is **filtered on purpose** — it is asking "which of these are still live", which is precisely the set that is about to transition. It is not the membership lookup A1 deliberately left unfiltered; that one stays as A1 wrote it.

Add the import:

```ts
import { recordSampleRevision, recordSampleRevisions } from '@/lib/sample-revisions';
```

- [ ] **Step 4: Run the DELETE tests and watch them pass**

```bash
sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.db.config.ts tests/db/sample-revision.test.ts -t "bulk verbs"'
```

Expected: PASS, 2 tests.

- [ ] **Step 5: Record in `PUT`, the same way**

In the `PUT` handler's transaction, using the same newly-hidden-ids read beside its `tombstoneSamples` call:

```ts
      const outgoingIds = (
        await tx.datasetSample.findMany({
          where: { datasetId: params.id, ...liveSamplesOnly() },
          select: { id: true },
        })
      ).map((s) => s.id);

      await tombstoneSamples(tx, outgoingIds);
      await recordSampleRevisions(tx, {
        datasetSampleIds: outgoingIds,
        changeType: 'delete',
        actorId: session.user.id,
      });
```

If A1's `PUT` already computes that id list for its own tombstone call, reuse it rather than reading twice.

- [ ] **Step 6: Record in the config importer**

In `src/app/api/config/import/route.ts`'s dataset-section sample replace, beside its `tombstoneSamples` call, with the same shape. The actor is the importing session:

```ts
              await recordSampleRevisions(tx, {
                datasetSampleIds: outgoingIds,
                changeType: 'delete',
                actorId: userId,
              });
```

- [ ] **Step 7: Add a test for the importer's revisions**

Append to `tests/db/config-golden-sets.test.ts`, beside the replace tests A1 updated there — that file already owns the importer fixtures:

```ts
  it('a config-import sample replace records a delete revision per hidden row', async () => {
    // The importer is the third place that hides samples in bulk. Without this,
    // a corpus refreshed from a config document would lose its history at
    // exactly the moment the history becomes most useful.
    const owner = await mkUser();
    mockSessionFor(owner);
    const { dataset } = await mkAnnotatedDataset(owner.id, { slug: 'rev-import', visibility: 'public' });

    const before = await db.datasetSample.count({ where: { datasetId: dataset.id } });
    expect(before).toBeGreaterThan(0);

    await importDoc({
      version: 1,
      datasets: [
        {
          slug: 'rev-import',
          name: 'Rev Import',
          inputType: 'query-response',
          samples: [{ index: 0, input: 'replacement row', expected: null }],
        },
      ],
    });

    const revisions = await db.sampleRevision.findMany({ where: { changeType: 'delete' } });
    expect(revisions).toHaveLength(before);
    expect(revisions.every((r) => r.actorId === owner.id)).toBe(true);
  });
```

- [ ] **Step 8: Run the full suites**

```bash
npx tsc --noEmit && npm run lint && npm test && npm run test:db && npm run test:integration
```

Expected: zero failures.

- [ ] **Step 9: Prove the retry test discriminates**

```bash
sha256sum src/app/api/datasets/[id]/samples/route.ts > /tmp/del.sha
```

Change `datasetSampleIds: newlyHiddenIds` to `datasetSampleIds: sampleIds` in `DELETE` — i.e. record per id requested rather than per row hidden. Re-run the bulk tests.

Expected: FAIL with `expected 2 to be 1` on the retried-DELETE test.

Restore, `sha256sum -c /tmp/del.sha` → `OK`.

- [ ] **Step 10: Commit**

```bash
git add src/app/api/datasets/[id]/samples/route.ts src/app/api/config/import/route.ts tests/db/sample-revision.test.ts tests/db/config-golden-sets.test.ts
git commit -m "feat(a2): the bulk verbs record a revision per row they hide

DELETE, PUT and the config importer each write one delete revision per
row ACTUALLY hidden — not per id requested, so a retried delete does not
record a deletion that did not happen."
```

---

### Task 5: `POST /api/datasets/[id]/samples/[sampleId]/restore`

**Files:**
- Create: `src/app/api/datasets/[id]/samples/[sampleId]/restore/route.ts`
- Test: `tests/db/sample-revision.test.ts` (append)

**Interfaces:**
- Consumes: `restoreSample(tx, datasetSampleId)` from A1's `src/lib/tombstones.ts` — **this route is its first and only caller**; `recordSampleRevision(tx, { changeType: 'restore', … })` from Task 2.
- Produces: `POST /api/datasets/[id]/samples/[sampleId]/restore` → `200 { restored: true }`, or `404` if the sample does not belong to this dataset, or `409` if it is not hidden.

**Why this route exists at all.** A1 shipped hiding with no way back through the API: `restoreSample` was implemented and unit-tested but had no caller, because A1's read filters only needed an `isTombstone: false` row to be *reachable*. Until this task, "delete" is one-way in the product, which makes the whole "hide, don't destroy" promise hard to justify to a user.

- [ ] **Step 1: Write the failing test**

Append to `tests/db/sample-revision.test.ts`:

```ts
describe('POST /api/datasets/[id]/samples/[sampleId]/restore', () => {
  beforeEach(async () => {
    await truncateAll();
    vi.clearAllMocks();
  });

  it('un-hides a hidden sample and records a `restore` revision', async () => {
    const owner = await mkUser();
    const dataset = await db.dataset.create({
      data: {
        name: 'Restore Fixture',
        slug: `restore-${Date.now()}`,
        userId: owner.id,
        visibility: 'private',
        inputType: 'query-response',
        sampleCount: 1,
      },
    });
    const sample = await db.datasetSample.create({
      data: { datasetId: dataset.id, index: 0, input: 'hidden then back', expected: null, metadata: null },
    });
    await db.tombstone.create({ data: { datasetSampleId: sample.id, isTombstone: true } });
    sessionFor(owner);

    const res = await POST_RESTORE(
      new Request('http://localhost/x', { method: 'POST' }),
      { params: Promise.resolve({ id: dataset.id, sampleId: sample.id }) }
    );
    expect(res.status).toBe(200);

    // The tombstone row SURVIVES with the flag flipped — it is not deleted.
    // That is what preserves "this was hidden once", and it is why the read
    // filter is written as a NOT rather than an is-null check.
    const tomb = await db.tombstone.findUnique({ where: { datasetSampleId: sample.id } });
    expect(tomb).not.toBeNull();
    expect(tomb?.isTombstone).toBe(false);

    const revisions = await db.sampleRevision.findMany({ where: { datasetSampleId: sample.id } });
    expect(revisions).toHaveLength(1);
    expect(revisions[0].changeType).toBe('restore');
    expect(revisions[0].input).toBeNull();
  });

  it('409s a sample that is not hidden, and records nothing', async () => {
    const owner = await mkUser();
    const dataset = await db.dataset.create({
      data: {
        name: 'Live Fixture',
        slug: `live-${Date.now()}`,
        userId: owner.id,
        visibility: 'private',
        inputType: 'query-response',
        sampleCount: 1,
      },
    });
    const sample = await db.datasetSample.create({
      data: { datasetId: dataset.id, index: 0, input: 'never hidden', expected: null, metadata: null },
    });
    sessionFor(owner);

    const res = await POST_RESTORE(new Request('http://localhost/x', { method: 'POST' }), {
      params: Promise.resolve({ id: dataset.id, sampleId: sample.id }),
    });
    expect(res.status).toBe(409);
    expect(await db.sampleRevision.count()).toBe(0);
  });
});
```

Add the import at the top of the file:

```ts
import { POST as POST_RESTORE } from '@/app/api/datasets/[id]/samples/[sampleId]/restore/route';
```

- [ ] **Step 2: Run it and watch it fail**

```bash
sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.db.config.ts tests/db/sample-revision.test.ts -t "restore"'
```

Expected: FAIL at collection with `Failed to resolve import "@/app/api/datasets/[id]/samples/[sampleId]/restore/route"`.

- [ ] **Step 3: Create the route**

Create `src/app/api/datasets/[id]/samples/[sampleId]/restore/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireAuth, requireScope, isAdmin } from '@/lib/auth-guard';
import { RateLimitedError } from '@/lib/rate-limit';
import { restoreSample } from '@/lib/tombstones';
import { recordSampleRevision } from '@/lib/sample-revisions';

/**
 * Un-hide a sample hidden by DELETE /api/datasets/[id]/samples.
 *
 * The first and only caller of `restoreSample`. A1 shipped hiding with no way
 * back through the API — this closes that, so "we hide rather than destroy" is
 * a promise a user can act on rather than a claim about the database.
 *
 * The tombstone row is FLIPPED, not deleted, so the record still says this
 * sample was hidden once. Its ordinal is unchanged and was never reused, which
 * is exactly why the high-water-mark rule exists: a restored sample lands back
 * in its original position rather than at the end.
 */
export async function POST(
  _request: Request,
  props: { params: Promise<{ id: string; sampleId: string }> }
) {
  const params = await props.params;
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;
  const scopeCheck = requireScope(session, 'datasets:write');
  if (scopeCheck) return scopeCheck;

  try {
    const dataset = await prisma.dataset.findUnique({
      where: { id: params.id },
      select: { userId: true },
    });
    if (!dataset) {
      return NextResponse.json({ error: 'Dataset not found' }, { status: 404 });
    }
    if (dataset.userId !== session.user.id && !isAdmin(session)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Deliberately UNFILTERED: this route exists to act on a hidden row, so
    // filtering it out would make the endpoint unreachable. It still verifies
    // membership, which is what turns a foreign id into a 404 rather than a
    // confusing success.
    const sample = await prisma.datasetSample.findUnique({
      where: { id: params.sampleId },
      select: { datasetId: true, tombstone: { select: { isTombstone: true } } },
    });
    if (!sample || sample.datasetId !== params.id) {
      return NextResponse.json({ error: 'Sample not found in this dataset' }, { status: 404 });
    }
    if (!sample.tombstone?.isTombstone) {
      return NextResponse.json(
        { error: 'This sample is not deleted, so there is nothing to restore.' },
        { status: 409 }
      );
    }

    await prisma.$transaction(async (tx) => {
      await restoreSample(tx, params.sampleId);
      await recordSampleRevision(tx, {
        datasetSampleId: params.sampleId,
        changeType: 'restore',
        actorId: session.user.id,
      });
    });

    return NextResponse.json({ restored: true });
  } catch (error) {
    if (error instanceof RateLimitedError) return error.response;
    console.error('Failed to restore sample:', error);
    return NextResponse.json({ error: 'Failed to restore sample' }, { status: 500 });
  }
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.db.config.ts tests/db/sample-revision.test.ts -t "restore"'
```

Expected: PASS, 2 tests.

- [ ] **Step 5: Register the route in the access matrix**

`tests/db/access-matrix.test.ts` enumerates every route × caller combination. Add rows for this one, following the `dataset` registry entry's existing shape: anonymous → 401, stranger → 403, owner → 200/409, admin → 200/409.

- [ ] **Step 6: Run the full suites**

```bash
npx tsc --noEmit && npm run lint && npm test && npm run test:db && npm run test:integration
```

Expected: zero failures.

- [ ] **Step 7: Commit**

```bash
git add src/app/api/datasets/[id]/samples/[sampleId]/restore tests/db/sample-revision.test.ts tests/db/access-matrix.test.ts
git commit -m "feat(a2): restore a hidden sample

The first caller of A1's restoreSample. Flips the tombstone rather than
deleting it, so the record still says the sample was hidden once, and the
sample returns to its original ordinal because nothing ever reused it."
```

---

### Task 6: `GET /api/datasets/[id]/samples/[sampleId]/revisions`

**Files:**
- Create: `src/app/api/datasets/[id]/samples/[sampleId]/revisions/route.ts`
- Test: `tests/db/sample-revision.test.ts` (append)

**Interfaces:**
- Consumes: the `SampleRevision` model from Task 1.
- Produces: `GET /api/datasets/[id]/samples/[sampleId]/revisions` → `200 { revisions: Array<{ id, changeType, input, expected, metadata, at, actor: { id, name } | null }> }`, newest first.

**A log nobody can read is hard to justify.** This is the minimum surface that makes the log reachable and testable. A history panel on the dataset page is a UI change with no test harness and belongs with whoever next works on that page.

- [ ] **Step 1: Write the failing test**

Append to `tests/db/sample-revision.test.ts`:

```ts
describe('GET /api/datasets/[id]/samples/[sampleId]/revisions', () => {
  beforeEach(async () => {
    await truncateAll();
    vi.clearAllMocks();
  });

  it('returns the history newest first, including for a HIDDEN sample', async () => {
    const owner = await mkUser();
    const dataset = await db.dataset.create({
      data: {
        name: 'History Fixture',
        slug: `hist-${Date.now()}`,
        userId: owner.id,
        visibility: 'private',
        inputType: 'query-response',
        sampleCount: 1,
      },
    });
    const sample = await db.datasetSample.create({
      data: { datasetId: dataset.id, index: 0, input: 'v3', expected: null, metadata: null },
    });
    await db.sampleRevision.createMany({
      data: [
        { datasetSampleId: sample.id, changeType: 'edit', input: 'v1', actorId: owner.id },
        { datasetSampleId: sample.id, changeType: 'edit', input: 'v2', actorId: owner.id },
      ],
    });
    // Hidden. The history of a hidden sample is exactly what you read when
    // deciding whether to restore it, so this route does NOT filter.
    await db.tombstone.create({ data: { datasetSampleId: sample.id, isTombstone: true } });
    sessionFor(owner);

    const res = await GET_REVISIONS(new Request('http://localhost/x'), {
      params: Promise.resolve({ id: dataset.id, sampleId: sample.id }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.revisions.map((r: { input: string }) => r.input)).toEqual(['v2', 'v1']);
    expect(body.revisions[0].actor.id).toBe(owner.id);
  });

  it('403s a stranger', async () => {
    const owner = await mkUser();
    const stranger = await mkUser();
    const dataset = await db.dataset.create({
      data: {
        name: 'Private History',
        slug: `priv-${Date.now()}`,
        userId: owner.id,
        visibility: 'private',
        inputType: 'query-response',
        sampleCount: 1,
      },
    });
    const sample = await db.datasetSample.create({
      data: { datasetId: dataset.id, index: 0, input: 'x', expected: null, metadata: null },
    });
    sessionFor(stranger);

    const res = await GET_REVISIONS(new Request('http://localhost/x'), {
      params: Promise.resolve({ id: dataset.id, sampleId: sample.id }),
    });
    expect(res.status).toBe(403);
  });
});
```

Add the import:

```ts
import { GET as GET_REVISIONS } from '@/app/api/datasets/[id]/samples/[sampleId]/revisions/route';
```

- [ ] **Step 2: Run it and watch it fail**

```bash
sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.db.config.ts tests/db/sample-revision.test.ts -t "revisions"'
```

Expected: FAIL at collection with `Failed to resolve import`.

- [ ] **Step 3: Create the route**

Create `src/app/api/datasets/[id]/samples/[sampleId]/revisions/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireAuth, requireScope, isAdmin } from '@/lib/auth-guard';
import { RateLimitedError } from '@/lib/rate-limit';

/**
 * One sample's mutation history, newest first.
 *
 * Owner-only, and NOT lifecycle-filtered: the history of a hidden sample is
 * exactly what you read when deciding whether to restore it. This is the one
 * read in either plan where seeing a hidden row is the point rather than a bug.
 *
 * `requireAuth` rather than `optionalAuth` — a sample's edit history names who
 * made each change, which is not public data even on a public dataset.
 */
export async function GET(
  _request: Request,
  props: { params: Promise<{ id: string; sampleId: string }> }
) {
  const params = await props.params;
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;
  const scopeCheck = requireScope(session, 'datasets:read');
  if (scopeCheck) return scopeCheck;

  try {
    const dataset = await prisma.dataset.findUnique({
      where: { id: params.id },
      select: { userId: true },
    });
    if (!dataset) {
      return NextResponse.json({ error: 'Dataset not found' }, { status: 404 });
    }
    if (dataset.userId !== session.user.id && !isAdmin(session)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const sample = await prisma.datasetSample.findUnique({
      where: { id: params.sampleId },
      select: { datasetId: true },
    });
    if (!sample || sample.datasetId !== params.id) {
      return NextResponse.json({ error: 'Sample not found in this dataset' }, { status: 404 });
    }

    const revisions = await prisma.sampleRevision.findMany({
      where: { datasetSampleId: params.sampleId },
      orderBy: { at: 'desc' },
      select: {
        id: true,
        changeType: true,
        input: true,
        expected: true,
        metadata: true,
        at: true,
        actor: { select: { id: true, name: true } },
      },
    });

    return NextResponse.json({ revisions });
  } catch (error) {
    if (error instanceof RateLimitedError) return error.response;
    console.error('Failed to load sample revisions:', error);
    return NextResponse.json({ error: 'Failed to load sample revisions' }, { status: 500 });
  }
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.db.config.ts tests/db/sample-revision.test.ts -t "revisions"'
```

Expected: PASS, 2 tests.

- [ ] **Step 5: Prove the hidden-sample case discriminates**

The load-bearing claim is that this route does **not** filter. Add `...liveSamplesOnly()` to the `datasetSample.findUnique` where-clause and re-run.

Expected: FAIL with `expected 404 to be 200` on the hidden-sample test — the route would refuse to show the history of exactly the sample whose history you need.

Restore and confirm byte-identical by sha256.

- [ ] **Step 6: Register in the access matrix and run the full suites**

Add the route's rows to `tests/db/access-matrix.test.ts`, then:

```bash
npx tsc --noEmit && npm run lint && npm test && npm run test:db && npm run test:integration
```

Expected: zero failures.

- [ ] **Step 7: Commit**

```bash
git add src/app/api/datasets/[id]/samples/[sampleId]/revisions tests/db/sample-revision.test.ts tests/db/access-matrix.test.ts
git commit -m "feat(a2): read one sample's mutation history

Owner-only, newest first, and deliberately unfiltered — the history of a
hidden sample is what you read when deciding whether to restore it."
```

---

## Self-review notes

**Spec coverage.** A2 implements the spec's "Recording a mutation" section in full: edits (Task 3), deletes (Task 4), restores (Task 5), the two-table justification (Task 1), and the closing of the gap A0 recorded — that a golden label preserves who/what/when but not the text the annotator saw (Task 3's before-image is that text).

**Deliberately not covered, and why.** Revision history for `Dataset` rows themselves is out of scope per the spec. A history UI is out of scope per the decision above. `restoreDataset` does not exist: A1's `DELETE /api/datasets/[id]` remains one-way, which is a real asymmetry — a hidden *sample* can be restored, a hidden *dataset* cannot. Left for Plan B, which owns the dataset lifecycle and is where an un-delete belongs alongside publish/unpublish semantics. **Flag this to the owner rather than letting it be discovered.**
