# A1 — Human Verification and the Agreement Floor: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `GoldenLabel` its first writer — a labelling surface with designed annotator overlap, blind re-reading for test-retest, per-item provenance that survives edits, and an agreement number reported with the method that produced it.

**Architecture:** One migration (`v2h`) adds a golden-item revision log, an assignment model, and the columns test-retest and preference labelling need. Three pure-ish modules in `src/lib/` carry every rule that can be wrong — the statistics, retest eligibility, and blinded queue selection. Six routes expose them, with two security properties: the **server** decides which round a reading is, and eligibility is **re-checked on submit**, never trusted from the queue.

**Tech Stack:** Next.js 15 (app router, `params` as a Promise), Prisma 6.19.2 + PostgreSQL 16, zod, vitest.

**Spec:** `docs/superpowers/specs/2026-08-17-a1-human-verification-design.md` — read "The layering this phase sits in" and "Decisions" before Task 1.

**Sibling:** A1.5, the annotation studio (`2026-08-17-a1_5-annotation-studio.md`). Independent — A1 owns data and endpoints, A1.5 owns the surface. Either may land first.

**Follows:** A0, L1, L2, and the R1/R3 residual fixes — all on `feat/a0-golden-set-substrate` at `7b1ea56`.

## Global Constraints

- **Anchor edits by SYMBOL, never by line number.** L2's plan was written against a tree that then moved, and its route line references were 115–123 lines stale by execution — the single most expensive defect in that plan. Where this plan cites a line, it is a *hint*; find the symbol.
- **`.env.local` holds a QUOTED `DATABASE_URL`.** `DATABASE_URL="$(grep … | cut -d= -f2-)"` keeps the quotes and fails `P1012`, which reads like schema drift and is not. Use `sh -c 'set -a; . ./.env.local; set +a; npx prisma …'`. Bare `npx prisma …` fails the same way — Prisma loads `.env`, and this tree has none.
- **Migration directory:** `prisma/migrations/20260818120000_v2h_human_verification/`. Authored via `prisma migrate diff` per `CONTRIBUTING.md`, with a prose header naming the phase and **every hand edit**. **Never `prisma db push`.**
- **This migration DOES need hand edits** — three, taking CONTRIBUTING's pseudo-drift table from five rows to **eight**. Say so in the header.
- **Consent id:** `approved-plan-2026-08-17-a1-human-verification`. Confirm it is granted before Task 1's `migrate deploy`.
- **Never lower a coverage floor.** Floors sit 2pp (aggregate) / 3pp (per-glob) below actuals per `vitest.db.config.ts`. If actuals move, update only the "Actuals as of" prose.
- **`src/app/api/**` is outside every coverage `include`; `src/lib/**` is measured by both suites.** That is why every rule that can be wrong lives in `src/lib/`.
- **`requireScope` is mandatory on every route.** `RateLimitedError` is exported from **`@/lib/auth-guard`**, not `@/lib/rate-limit`.
- **Route-driving DB tests need three mocks**: `next-auth`, **`next/headers`** (`requireAuth` awaits `headers()` before any auth work — without it every route call throws before reaching the handler), and `@/lib/rate-limit-redis` (the suite shares a finite 120/min budget across files).
- **Test helpers are `tests/db/helpers.ts`**, exporting `db`, `truncateAll`, `mkUser`, `mkRubric`.
- **Do not assert an absolute suite count in any task.** Each task's contract is **zero failures, and no fewer tests than the previous task left.** Record what you observe.
- **Local Postgres** is the podman container `judge-arena-pg` on `localhost:5432`. **Production is the Kubernetes pod `judge-arena-pg-1` in namespace `tenant-public` and must never be touched.**
- **Demonstrate discrimination, do not assert it.** Break the thing under test, observe the specific failure, restore, confirm byte-identical by `sha256sum -c`, and put the observed message in your report.

---

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `prisma/migrations/20260818120000_v2h_human_verification/migration.sql` | The one migration. Three hand edits. |
| `src/lib/agreement.ts` | The statistics. Pure — no Prisma, no clock. |
| `src/lib/retest.ts` | Retest eligibility and the shortfall. |
| `src/lib/labelling-queue.ts` | Blinded next-item selection. |
| `src/app/api/golden-sets/[id]/queue/route.ts` | `GET` — the next item, blinded. |
| `src/app/api/golden-sets/[id]/items/[itemId]/labels/route.ts` | `POST` — submit a reading. |
| `src/app/api/golden-sets/[id]/agreement/route.ts` | `GET` — the number and its method. |
| `src/app/api/golden-sets/[id]/disagreements/route.ts` | `GET` — items ranked by divergence. |
| `src/app/api/golden-sets/[id]/items/[itemId]/history/route.ts` | `GET` — who saw what, and answered what. |
| `src/app/api/golden-sets/[id]/assignments/route.ts` | `GET`/`POST`/`DELETE` — assignment. |
| `tests/lib/agreement.test.ts` | Statistics, against published worked examples. |
| `tests/db/golden-label-constraints.test.ts` | The three hand-edited constraints, through raw SQL. |
| `tests/db/labelling.test.ts` | Queue, submit, blinding, provenance, agreement routes. |

**Modified**

| File | Change |
|---|---|
| `prisma/schema.prisma` | `GoldenItemRevision`, `GoldenAssignment`, `GoldenLabel` columns, `GoldenSet.retestIntervalItems`. |
| `src/app/api/golden-sets/[id]/items/route.ts` | `PATCH` writes a revision and back-fills the labels it tombstones. |
| `tests/db/config-roundtrip-fidelity.test.ts` | `COVERAGE` gains `GoldenItemRevision` and `GoldenAssignment`. |
| `tests/db/access-matrix.test.ts` | Rows for all six new routes. |
| `CONTRIBUTING.md` | Pseudo-drift table 5 → 8 rows. |

---

## The interface contract

Defined once. No task may rename or re-shape these.

```ts
// src/lib/agreement.ts
export type AgreementMethod = {
  statistic: 'cohen' | 'fleiss';
  weighting: 'linear' | 'quadratic' | 'none';
  annotatorCount: number;
  itemCount: number;        // the OVERLAP — items with >= 2 readings
  categories: string[];     // the ordered category set the number was computed over
};
export type AgreementResult =
  | ({ value: number; reason: null } & AgreementMethod)
  | ({ value: null; reason: 'insufficient-annotators' | 'insufficient-overlap' } & AgreementMethod);

export type Reading = { itemId: string; raterId: string; category: string };

export function agreement(readings: Reading[], opts?: { weighting?: 'linear' | 'quadratic' | 'none' }): AgreementResult;

// src/lib/retest.ts
export type RetestEligibility =
  | { eligible: true }
  | { eligible: false; labelsUntilEligible: number };
export function retestEligibility(args: {
  intervalItems: number;
  labelledSinceRound1: number;
  hasRound1: boolean;
  hasRound2: boolean;
}): RetestEligibility;
```

`Reading.category` is a **string** for both protocols — a score becomes `String(score)`, a preference is already one. That is what lets one implementation serve scores and preferences without a second code path, and why `categories` is `string[]`.

---

## Task list

| Task | Deliverable |
|---|---|
| 1 | The `v2h` migration, the schema, `COVERAGE`, CONTRIBUTING, and raw-SQL tests for all three constraints. |
| 2 | `src/lib/agreement.ts` — statistics tested against published worked examples. |
| 3 | `PATCH` items writes a revision and back-fills labels. Provenance survives an edit. |
| 4 | `src/lib/retest.ts` and `src/lib/labelling-queue.ts`. |
| 5 | The assignment routes. |
| 6 | The queue and submit routes — server-decided rounds, submit-side re-check. |
| 7 | Agreement, disagreements and history routes — public iff published. |

---

## Task bodies

### Task 1: The `v2h` migration

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260818120000_v2h_human_verification/migration.sql`
- Modify: `tests/db/config-roundtrip-fidelity.test.ts` (`COVERAGE`)
- Modify: `CONTRIBUTING.md` (pseudo-drift table)
- Test: `tests/db/golden-label-constraints.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: models `GoldenItemRevision`, `GoldenAssignment`; `GoldenLabel.{overallScore?, preference?, round, goldenItemRevisionId?}`; `GoldenSet.retestIntervalItems`; the `tx.goldenItemRevision` and `tx.goldenAssignment` delegates.

- [ ] **Step 1: Write the failing coverage entries**

The fidelity suite iterates `Object.entries(COVERAGE)` and never the datamodel, so a model absent from the map is unchecked. Add both entries **after** the `SampleRevision` entry L2 added:

```ts
  // Instance-local mutation history, exactly as SampleRevision above: a
  // revision records WHAT HAPPENED HERE. The config document describes a
  // golden set's current content, not its edit history.
  GoldenItemRevision: {
    exported: [],
    excludedByDesign: {
      id: SURROGATE,
      goldenItemId: 'instance-local FK, the same argument as SampleRevision.datasetSampleId',
      inputText: 'the PRE-EDIT text of an item on THIS instance; the document carries current content',
      promptText: 'same as inputText one column up — a before-image, not current content',
      responseText: 'same as inputText two columns up — a before-image, not current content',
      expected: 'the ground truth AS IT STOOD before an edit here, not the document\'s current value',
      actorId: 'a real User FK with no portable representation, exactly as GoldenLabel.annotatorId',
      at: TIMESTAMP,
    },
    knownGaps: {},
  },

  // Workflow state, not content. WHO WAS ASKED to annotate on this instance
  // says nothing about the set as an artifact, and carrying it would assign
  // work to strangers on import.
  GoldenAssignment: {
    exported: [],
    excludedByDesign: {
      id: SURROGATE,
      goldenSetId: 'instance-local FK',
      annotatorId: 'a real User FK with no portable representation',
      goldenItemId: 'instance-local FK; NULL means the whole set',
      round: 'which reading this assignment is for — instance-local workflow state',
      assignedById: 'a real User FK with no portable representation',
      assignedAt: TIMESTAMP,
      completedAt: TIMESTAMP,
      revokedAt: TIMESTAMP,
      revokedReason: 'free-text audit of why an assignment was withdrawn HERE',
    },
    knownGaps: {},
  },
```

`GoldenLabel` and `GoldenSet` already have `COVERAGE` entries — add the new columns to them as `excludedByDesign` too:

```ts
      // on GoldenLabel:
      preference: 'the human verdict for a pairwise item, same register as overallScore beside it',
      round: 'which blind reading this is — instance-local measurement protocol, not content',
      goldenItemRevisionId: 'instance-local FK to an instance-local revision row',
      // on GoldenSet:
      retestIntervalItems: 'the measurement protocol in force on THIS instance, not part of the set as an artifact',
```

- [ ] **Step 2: Run it and watch it fail**

```bash
sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.db.config.ts tests/db/config-roundtrip-fidelity.test.ts'
```

Expected: FAIL with `GoldenItemRevision is not in the Prisma datamodel: expected undefined to be defined`, and `GoldenLabel classifies column(s) that no longer exist` for the not-yet-added columns.

- [ ] **Step 3: Edit the schema**

Add to `GoldenItem`'s relations block: `revisions GoldenItemRevision[]` and `assignments GoldenAssignment[]`.
Add to `GoldenSet`: `assignments GoldenAssignment[]` and `retestIntervalItems Int @default(20)`.
Add to `User`: `goldenItemRevisions GoldenItemRevision[]`, `assignedAnnotations GoldenAssignment[] @relation("AssignedAnnotator")`, `coordinatedAssignments GoldenAssignment[] @relation("AssigningCoordinator")`.

Change `GoldenLabel`:

```prisma
  overallScore         Float?
  preference           String?
  round                Int                 @default(1)
  goldenItemRevisionId String?
  goldenItemRevision   GoldenItemRevision? @relation(fields: [goldenItemRevisionId], references: [id], onDelete: SetNull)
```

Append both new models exactly as the spec's "Data model" section defines them, including the doc comments.

- [ ] **Step 4: Generate the migration**

```bash
sh -c 'set -a; . ./.env.local; set +a; npx prisma migrate diff \
  --from-schema-datasource prisma/schema.prisma \
  --to-schema-datamodel prisma/schema.prisma --script' > /tmp/v2h.sql
cat /tmp/v2h.sql
```

Read it. Expect two `CREATE TABLE`s, the `GoldenLabel`/`GoldenSet` `ALTER`s, indexes and FKs. **`prisma migrate diff` will also emit `DROP INDEX "GoldenLabel_goldenItemId_annotatorId_live_key"` — or nothing at all for it.** It cannot see the partial index (that is why it is in the pseudo-drift table), so **you must hand-write both the drop and the recreate.** If the generated SQL contains anything you cannot explain, stop.

- [ ] **Step 5: Write the migration with its header and three hand edits**

```sql
-- v2h — human verification (Roadmap A, phase A1)
--
-- THREE HAND EDITS. This migration takes CONTRIBUTING's "Known migrate-diff
-- pseudo-drift" table from five rows to EIGHT. Every one is invisible to
-- `migrate diff` / `db pull` / `db push`:
--
--   1. GoldenLabel_score_xor_preference — a CHECK. Prisma's DSL has no CHECK
--      syntax of any kind (same class as v2f's Tombstone_exactly_one_entity).
--   2. GoldenLabel_goldenItemId_annotatorId_round_live_key — a PARTIAL unique
--      index, REPLACING v2e's two-column version. Prisma cannot express WHERE.
--      Test-retest needs two readings by one annotator on one item; the old
--      index permitted one. The two readings are PEERS, so the second is not
--      modelled as a tombstone of the first.
--   3. GoldenAssignment_item_annotator_round_active_key — a PARTIAL unique
--      index. One ACTIVE assignment per (item, annotator, round); a revoked
--      one must not block a reassignment.
--
-- v2e's migration is applied and immutable, so its pseudo-drift row keeps its
-- text and gains a "superseded by v2h" note rather than being edited.

-- <generated SQL from /tmp/v2h.sql goes here>

-- ── HAND EDIT 1 of 3 ────────────────────────────────────────────────────────
ALTER TABLE "GoldenLabel" ADD CONSTRAINT "GoldenLabel_score_xor_preference"
  CHECK (num_nonnulls("overallScore", "preference") = 1);

-- ── HAND EDIT 2 of 3 ────────────────────────────────────────────────────────
DROP INDEX IF EXISTS "GoldenLabel_goldenItemId_annotatorId_live_key";
CREATE UNIQUE INDEX "GoldenLabel_goldenItemId_annotatorId_round_live_key"
  ON "GoldenLabel"("goldenItemId", "annotatorId", "round") WHERE "tombstonedAt" IS NULL;

-- ── HAND EDIT 3 of 3 ────────────────────────────────────────────────────────
CREATE UNIQUE INDEX "GoldenAssignment_item_annotator_round_active_key"
  ON "GoldenAssignment"("goldenItemId", "annotatorId", "round") WHERE "revokedAt" IS NULL;
```

**The CHECK is added AFTER the column changes and there are no rows yet** — `GoldenLabel` is empty on every instance, because nothing has ever written one. Verify that before relying on it: `SELECT count(*) FROM "GoldenLabel";` must be 0, or the CHECK will refuse to apply against existing rows and you need a backfill first.

- [ ] **Step 6: Apply locally and regenerate**

```bash
sh -c 'set -a; . ./.env.local; set +a; \
  case "$DATABASE_URL" in *@localhost:5432/*) : ;; *) echo "REFUSING - not localhost"; exit 1;; esac; \
  PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION=approved-plan-2026-08-17-a1-human-verification \
  npx prisma migrate deploy'
npx prisma generate
```

- [ ] **Step 7: Verify no drift**

```bash
sh -c 'set -a; . ./.env.local; set +a; npx prisma migrate diff \
  --from-schema-datasource prisma/schema.prisma \
  --to-schema-datamodel prisma/schema.prisma --script'
```

Expected: `-- This is an empty migration.` The three hand-edited objects are invisible to this command **by construction** — that is what makes them pseudo-drift, and why Step 8 exists.

- [ ] **Step 8: Write the constraint tests — raw SQL, because the typed client cannot violate them**

Create `tests/db/golden-label-constraints.test.ts`. The typed client cannot construct a violating row (`overallScore` and `preference` are separate optional inputs; the partial indexes are invisible to it), so every assertion goes through `$executeRawUnsafe` — the same reason `tests/db/tombstone-check-constraint.test.ts` exists.

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { db, truncateAll, mkUser } from './helpers';

async function mkItem(userId: string) {
  const dataset = await db.dataset.create({
    data: { name: 'c', slug: `c-${Date.now()}-${Math.random()}`, userId, visibility: 'private', inputType: 'query-response' },
  });
  const sample = await db.datasetSample.create({
    data: { datasetId: dataset.id, index: 0, input: 'q' },
  });
  const set = await db.goldenSet.create({
    data: { name: 'gs', slug: `gs-${Date.now()}-${Math.random()}`, visibility: 'private', protocol: 'pointwise', version: 1, datasetId: dataset.id, ownerId: userId },
  });
  return db.goldenItem.create({
    data: { goldenSetId: set.id, index: 0, inputText: 'q', protocol: 'pointwise', sourceDatasetSampleId: sample.id },
  });
}

describe('v2h hand-edited constraints', () => {
  beforeEach(async () => { await truncateAll(); });

  it('refuses a label with NEITHER a score nor a preference', async () => {
    const user = await mkUser();
    const item = await mkItem(user.id);
    await expect(
      db.$executeRawUnsafe(
        `INSERT INTO "GoldenLabel" ("id","goldenItemId","annotatorId","round","createdAt","updatedAt")
         VALUES ('lbl_none', $1, $2, 1, now(), now())`,
        item.id, user.id
      )
    ).rejects.toThrow(/GoldenLabel_score_xor_preference/);
  });

  it('refuses a label with BOTH', async () => {
    const user = await mkUser();
    const item = await mkItem(user.id);
    await expect(
      db.$executeRawUnsafe(
        `INSERT INTO "GoldenLabel" ("id","goldenItemId","annotatorId","round","overallScore","preference","createdAt","updatedAt")
         VALUES ('lbl_both', $1, $2, 1, 4, 'A>B', now(), now())`,
        item.id, user.id
      )
    ).rejects.toThrow(/GoldenLabel_score_xor_preference/);
  });

  it('permits TWO ROUNDS by one annotator on one item — the whole point of the widened index', async () => {
    const user = await mkUser();
    const item = await mkItem(user.id);
    for (const round of [1, 2]) {
      await db.goldenLabel.create({
        data: { goldenItemId: item.id, annotatorId: user.id, round, overallScore: 4 },
      });
    }
    expect(await db.goldenLabel.count({ where: { goldenItemId: item.id } })).toBe(2);
  });

  it('still refuses a SECOND live label in the SAME round', async () => {
    const user = await mkUser();
    const item = await mkItem(user.id);
    await db.goldenLabel.create({ data: { goldenItemId: item.id, annotatorId: user.id, round: 1, overallScore: 4 } });
    await expect(
      db.goldenLabel.create({ data: { goldenItemId: item.id, annotatorId: user.id, round: 1, overallScore: 5 } })
    ).rejects.toThrow();
  });

  it('permits a re-read after the first is tombstoned — the partial predicate is load-bearing', async () => {
    const user = await mkUser();
    const item = await mkItem(user.id);
    const first = await db.goldenLabel.create({ data: { goldenItemId: item.id, annotatorId: user.id, round: 1, overallScore: 4 } });
    await db.goldenLabel.update({ where: { id: first.id }, data: { tombstonedAt: new Date(), tombstonedReason: 'item-content-edit' } });
    await expect(
      db.goldenLabel.create({ data: { goldenItemId: item.id, annotatorId: user.id, round: 1, overallScore: 5 } })
    ).resolves.toBeTruthy();
  });

  it('refuses a second ACTIVE assignment for the same (item, annotator, round), and permits one after revocation', async () => {
    const user = await mkUser();
    const item = await mkItem(user.id);
    const set = await db.goldenItem.findUniqueOrThrow({ where: { id: item.id }, select: { goldenSetId: true } });
    const base = { goldenSetId: set.goldenSetId, goldenItemId: item.id, annotatorId: user.id, round: 1 };
    const a = await db.goldenAssignment.create({ data: base });
    await expect(db.goldenAssignment.create({ data: base })).rejects.toThrow();
    await db.goldenAssignment.update({ where: { id: a.id }, data: { revokedAt: new Date(), revokedReason: 'reassigned' } });
    await expect(db.goldenAssignment.create({ data: base })).resolves.toBeTruthy();
  });
});
```

- [ ] **Step 9: Run them, then prove they discriminate**

```bash
sh -c 'set -a; . ./.env.test; set +a; npx prisma migrate deploy && npx vitest run --config vitest.db.config.ts tests/db/golden-label-constraints.test.ts'
```

Expected: PASS. Then, one at a time, drop each constraint against the **test** database, re-run, observe the failure, and re-apply:

```bash
sh -c 'set -a; . ./.env.test; set +a; npx prisma db execute --stdin' <<'SQL'
ALTER TABLE "GoldenLabel" DROP CONSTRAINT "GoldenLabel_score_xor_preference";
SQL
```

Expected without it: the first two tests fail with `expected promise to reject`. Re-apply by re-running `prisma migrate reset --force --skip-seed`. Do the same for each partial index. **Put all three observed failures in your report** — a constraint whose test has never been seen to fail is a constraint nobody has verified exists.

- [ ] **Step 10: Update CONTRIBUTING's pseudo-drift table**

Change the count sentence from five to **eight**, add one row per hand edit above (Migration / What's really there / Why `schema.prisma` can't say it), and append to v2e's existing row: *"**Superseded by v2h**, which drops this index and recreates it with `round` as a third column; the row is kept because v2e is applied and immutable."*

- [ ] **Step 11: Full suites, then commit**

```bash
npx tsc --noEmit && npm run lint && npm test && npm run test:db && npm run test:integration
```

```bash
git add prisma/schema.prisma prisma/migrations/20260818120000_v2h_human_verification \
        tests/db/config-roundtrip-fidelity.test.ts tests/db/golden-label-constraints.test.ts CONTRIBUTING.md
git commit -m "feat(a1): the v2h schema — revisions, assignments, rounds and preferences

Three hand-edited constraints, taking the pseudo-drift table to eight rows:
a score-xor-preference CHECK, the label partial-unique widened with round so
two blind readings can coexist as peers, and an active-assignment partial
unique. Each is pinned by raw SQL, because the typed client cannot construct
a violating row."
```

---

### Task 2: `src/lib/agreement.ts`

**Files:**
- Create: `src/lib/agreement.ts`
- Test: `tests/lib/agreement.test.ts`

**Interfaces:**
- Consumes: nothing. **No Prisma import** — this module must stay pure so it runs in the unit suite.
- Produces: exactly the contract above: `agreement()`, `AgreementResult`, `AgreementMethod`, `Reading`.

**The fixtures are published worked examples with known answers.** A snapshot of our own output proves the implementation is stable, not that it is right, and a wrong kappa is the archetypal confidently-plausible number nobody catches.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { agreement, type Reading } from '@/lib/agreement';

/** A two-rater, two-category fixture with the arithmetic worked out by hand,
 *  so this test is an ORACLE rather than a snapshot of our own output:
 *
 *    n = 50: 20 (yes,yes), 5 (yes,no), 10 (no,yes), 15 (no,no)
 *    p0 = (20 + 15) / 50                     = 0.70
 *    A: yes 25/50 = 0.5, no 25/50 = 0.5
 *    B: yes 30/50 = 0.6, no 20/50 = 0.4
 *    pe = (0.5 x 0.6) + (0.5 x 0.4)          = 0.50
 *    kappa = (0.70 - 0.50) / (1 - 0.50)      = 0.40   <- exactly
 *
 *  Built as explicit readings so the input is the shape production uses. */
function cohenFixture(): Reading[] {
  const out: Reading[] = [];
  const push = (n: number, x: string, y: string) => {
    for (let i = 0; i < n; i++) {
      const itemId = `i${out.length}`;
      out.push({ itemId, raterId: 'A', category: x }, { itemId, raterId: 'B', category: y });
    }
  };
  push(20, 'yes', 'yes'); push(5, 'yes', 'no'); push(10, 'no', 'yes'); push(15, 'no', 'no');
  return out;
}

describe('agreement — Cohen', () => {
  it('reproduces the textbook unweighted kappa to 4dp', () => {
    const r = agreement(cohenFixture(), { weighting: 'none' });
    expect(r.statistic).toBe('cohen');
    expect(r.annotatorCount).toBe(2);
    expect(r.itemCount).toBe(50);
    expect(r.value).toBeCloseTo(0.4, 4);
  });

  it('perfect agreement is 1, and the method still travels with it', () => {
    const readings: Reading[] = [
      { itemId: 'a', raterId: 'A', category: '5' }, { itemId: 'a', raterId: 'B', category: '5' },
      { itemId: 'b', raterId: 'A', category: '1' }, { itemId: 'b', raterId: 'B', category: '1' },
    ];
    const r = agreement(readings, { weighting: 'none' });
    expect(r.value).toBe(1);
    expect(r.categories).toEqual(['1', '5']);
  });

  it('weighted kappa uses VALUE distance, not rank — 1 vs 5 is four steps', () => {
    // Two items, one exact match and one off by four. Linear weights must
    // penalise the 1-vs-5 disagreement more than a 4-vs-5 one would.
    const far = agreement([
      { itemId: 'a', raterId: 'A', category: '1' }, { itemId: 'a', raterId: 'B', category: '5' },
      { itemId: 'b', raterId: 'A', category: '1' }, { itemId: 'b', raterId: 'B', category: '1' },
    ], { weighting: 'linear' });
    const near = agreement([
      { itemId: 'a', raterId: 'A', category: '4' }, { itemId: 'a', raterId: 'B', category: '5' },
      { itemId: 'b', raterId: 'A', category: '4' }, { itemId: 'b', raterId: 'B', category: '4' },
    ], { weighting: 'linear' });
    expect(near.value!).toBeGreaterThan(far.value!);
  });
});

describe('agreement — insufficiency is not a number', () => {
  it('ONE annotator returns null with a reason, never 0', () => {
    // 0 would read as TOTAL DISAGREEMENT, the opposite of "not measurable".
    // This is the normal case at launch: one account means one annotator.
    const r = agreement([{ itemId: 'a', raterId: 'A', category: '3' }]);
    expect(r.value).toBeNull();
    expect(r.reason).toBe('insufficient-annotators');
    expect(r.annotatorCount).toBe(1);
  });

  it('two annotators who never overlap return insufficient-overlap', () => {
    const r = agreement([
      { itemId: 'a', raterId: 'A', category: '3' },
      { itemId: 'b', raterId: 'B', category: '4' },
    ]);
    expect(r.value).toBeNull();
    expect(r.reason).toBe('insufficient-overlap');
    expect(r.itemCount).toBe(0);
  });
});

describe('agreement — Fleiss', () => {
  it('THREE annotators switch to Fleiss and report weighting: none', () => {
    // Fleiss has no standard weighted form. Reporting 'none' is the honest
    // record; silently applying weights would make the number incomparable
    // to a weighted two-annotator figure while looking identical.
    const readings: Reading[] = [];
    for (const itemId of ['a', 'b', 'c']) {
      for (const raterId of ['A', 'B', 'C']) readings.push({ itemId, raterId, category: '4' });
    }
    const r = agreement(readings, { weighting: 'quadratic' });
    expect(r.statistic).toBe('fleiss');
    expect(r.weighting).toBe('none');
    expect(r.value).toBe(1);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
npx vitest run --config vitest.config.ts tests/lib/agreement.test.ts
```

Expected: FAIL at collection — `Cannot find module '@/lib/agreement'`.

- [ ] **Step 3: Implement**

Write `src/lib/agreement.ts` implementing the contract. Required behaviour, all pinned above:

1. Group readings by item; keep only items with ≥2 readings — that set is `itemCount`.
2. `annotatorCount` is the number of distinct `raterId` across the **input**.
3. `<2` annotators → `insufficient-annotators`; `itemCount === 0` → `insufficient-overlap`. Both return `value: null` and still populate the method fields.
4. Exactly 2 annotators → Cohen; more → Fleiss with `weighting: 'none'` regardless of what was asked.
5. `categories` is the sorted union of observed categories — **numerically when every category parses as a number**, lexicographically otherwise. This is what makes value-distance weighting possible.
6. Weights: `linear` = `1 - |a-b| / range`, `quadratic` = `1 - ((a-b)/range)²`, computed on parsed values; `none` = exact match. `range` is `max - min` of `categories`; when `range` is 0 every pair is an exact match.

Carry the spec's three limitations as a module doc comment: Fleiss has no standard weighted form, `overallScore` has no declared scale so the category set is derived, and preferences default to unweighted.

- [ ] **Step 4: Run and watch it pass**

```bash
npx vitest run --config vitest.config.ts tests/lib/agreement.test.ts
```

Expected: PASS.

- [ ] **Step 5: Prove the tests discriminate**

```bash
sha256sum src/lib/agreement.ts > /tmp/agr.sha
```

1. Return `0` instead of `null` for the one-annotator case → the insufficiency test fails on `expected 0 to be null`.
2. Use rank distance instead of value distance in the weights → the value-distance test fails on `expected … to be greater than …`.
3. Apply the requested weighting to Fleiss → the Fleiss test fails on `expected 'quadratic' to be 'none'`.

Restore after each, then `sha256sum -c /tmp/agr.sha` → `OK`. Put all three observed messages in your report.

- [ ] **Step 6: Full suites and commit**

```bash
npx tsc --noEmit && npm run lint && npm test && npm run test:db
git add src/lib/agreement.ts tests/lib/agreement.test.ts
git commit -m "feat(a1): the agreement statistics

Cohen's for two annotators, Fleiss's for more, weighted on VALUE distance
rather than rank. Tested against published worked examples, not against its
own output. Fewer than two annotators returns null with a reason rather
than 0 — which would read as total disagreement, the opposite of not
measurable, and is the normal case while one account exists."
```

---

### Task 3: `PATCH` items records a revision and back-fills its labels

**Files:**
- Modify: `src/app/api/golden-sets/[id]/items/route.ts` — the `PATCH` handler's edit transaction. **Anchor by symbol:** find `const currentById = new Map(` and the `if (contentChanged) {` block below it.
- Test: `tests/db/labelling.test.ts` (create)

**Interfaces:**
- Consumes: `tx.goldenItemRevision` from Task 1.
- Produces: nothing new. `PATCH`'s response shape is unchanged.

**This is the task that makes "the prompt as the annotator saw it" recoverable.** Today the handler reads the before-image **only to detect a change** and then discards it.

- [ ] **Step 1: Write the failing test**

Create `tests/db/labelling.test.ts` with the three-mock preamble (`next-auth`, `next/headers`, `@/lib/rate-limit-redis` — see Global Constraints), helpers to build a golden set with one item, and:

```ts
it('an item edit records the BEFORE image and stamps the labels that saw it', async () => {
  const owner = await mkUser();
  const { set, item } = await mkGoldenSetWithItem(owner.id, { inputText: 'original question' });
  const label = await db.goldenLabel.create({
    data: { goldenItemId: item.id, annotatorId: owner.id, round: 1, overallScore: 4 },
  });
  sessionFor(owner);

  const res = await PATCH(
    jsonRequest({ items: [{ id: item.id, inputText: 'edited question' }] }),
    { params: Promise.resolve({ id: set.id }) }
  );
  expect(res.status).toBe(200);

  // The revision holds the OLD text...
  const revisions = await db.goldenItemRevision.findMany({ where: { goldenItemId: item.id } });
  expect(revisions).toHaveLength(1);
  expect(revisions[0].inputText).toBe('original question');
  expect(revisions[0].actorId).toBe(owner.id);

  // ...and the label that saw it points AT it, so "what did they see" is a
  // join rather than a timestamp inference.
  const after = await db.goldenLabel.findUniqueOrThrow({ where: { id: label.id } });
  expect(after.goldenItemRevisionId).toBe(revisions[0].id);
  expect(after.tombstonedReason).toBe('item-content-edit');
});

it('a metadata-only PATCH writes NO revision — contentChanged is the gate', async () => {
  const owner = await mkUser();
  const { set, item } = await mkGoldenSetWithItem(owner.id, { inputText: 'unchanged' });
  sessionFor(owner);
  await PATCH(jsonRequest({ items: [{ id: item.id, inputText: 'unchanged' }] }),
    { params: Promise.resolve({ id: set.id }) });
  expect(await db.goldenItemRevision.count()).toBe(0);
});

it('a SECOND edit does not re-stamp labels an earlier edit already stamped', async () => {
  const owner = await mkUser();
  const { set, item } = await mkGoldenSetWithItem(owner.id, { inputText: 'v1' });
  const first = await db.goldenLabel.create({
    data: { goldenItemId: item.id, annotatorId: owner.id, round: 1, overallScore: 4 },
  });
  sessionFor(owner);
  await PATCH(jsonRequest({ items: [{ id: item.id, inputText: 'v2' }] }), { params: Promise.resolve({ id: set.id }) });
  const stampedWith = (await db.goldenLabel.findUniqueOrThrow({ where: { id: first.id } })).goldenItemRevisionId;

  await PATCH(jsonRequest({ items: [{ id: item.id, inputText: 'v3' }] }), { params: Promise.resolve({ id: set.id }) });

  // Still pointing at the v1 before-image: the second edit's updateMany
  // filters on tombstonedAt: null and never reaches an already-tombstoned row.
  const again = await db.goldenLabel.findUniqueOrThrow({ where: { id: first.id } });
  expect(again.goldenItemRevisionId).toBe(stampedWith);
  expect(await db.goldenItemRevision.count()).toBe(2);
});
```

- [ ] **Step 2: Run and watch it fail**

Expected: FAIL with `expected [] to have a length of 1` — nothing writes a revision yet.

- [ ] **Step 3: Implement inside the existing `if (contentChanged)` block**

```ts
        if (contentChanged) {
          // A1: the before-image, written BEFORE the labels that saw it are
          // tombstoned, so the update below has a revision id to stamp them
          // with. Same transaction as the edit, so a rolled-back edit leaves
          // no revision claiming it happened.
          const revision = await tx.goldenItemRevision.create({
            data: {
              goldenItemId: item.id,
              inputText: before.inputText,
              promptText: before.promptText,
              responseText: before.responseText,
              expected: before.expected,
              actorId: session.user.id,
            },
          });

          // One instant for the whole request, so every label invalidated by
          // this edit carries the same timestamp and reads as one event.
          await tx.goldenLabel.updateMany({
            where: { goldenItemId: item.id, tombstonedAt: null },
            data: {
              tombstonedAt: editedAt,
              tombstonedReason: GOLDEN_LABEL_TOMBSTONE_REASON_CONTENT_EDIT,
              // THE BACK-FILL. These are exactly the labels that saw the
              // before-image, which is why the stamp happens here rather than
              // at label-write time: with before-image semantics the revision
              // does not exist until the edit that supersedes it.
              goldenItemRevisionId: revision.id,
            },
          });
        }
```

`session` is already in scope in this handler; if the symbol differs, use whatever the handler already uses for the acting user rather than re-deriving it.

- [ ] **Step 4: Run and watch it pass** — expected: PASS, 3 tests.

- [ ] **Step 5: Prove it discriminates**

```bash
sha256sum "src/app/api/golden-sets/[id]/items/route.ts" > /tmp/items.sha
```

Remove `goldenItemRevisionId: revision.id` from the `updateMany`. Re-run.
Expected: FAIL with `expected null to be 'clx…'` on the first test — the revision exists but nothing connects the label to it, which is the silent half of this defect.
Restore, `sha256sum -c /tmp/items.sha` → `OK`.

- [ ] **Step 6: Full suites and commit**

```bash
git add "src/app/api/golden-sets/[id]/items/route.ts" tests/db/labelling.test.ts
git commit -m "feat(a1): item edits record the before-image and stamp the labels that saw it

The handler already read the prior text to detect a change and then threw
it away, so 'the prompt as the annotator saw it' was unrecoverable for any
edited item. The same transaction now writes a GoldenItemRevision and
back-fills goldenItemRevisionId onto exactly the labels it tombstones."
```

---

### Task 4: `src/lib/retest.ts` and `src/lib/labelling-queue.ts`

**Files:**
- Create: `src/lib/retest.ts`, `src/lib/labelling-queue.ts`
- Test: `tests/lib/retest.test.ts` (create), `tests/db/labelling.test.ts` (append)

**Interfaces:**
- Consumes: `retestEligibility` per the contract above.
- Produces:
  ```ts
  // src/lib/labelling-queue.ts
  export type QueueResult =
    | { next: { itemId: string; round: number }; reason: null }
    | { next: null; reason: 'no-assignment' | 'set-complete' | 'retest-not-yet-eligible'; labelsUntilRetest?: number };
  export function selectNext(candidates: QueueCandidate[], seed: string): QueueResult;
  export type QueueCandidate = { itemId: string; round: number; eligible: boolean; labelsUntilEligible?: number };
  ```

- [ ] **Step 1: Write the failing eligibility tests**

```ts
import { describe, expect, it } from 'vitest';
import { retestEligibility } from '@/lib/retest';

describe('retestEligibility', () => {
  it('is not eligible at K-1 and IS at K — the boundary, not "eventually"', () => {
    const at = (n: number) => retestEligibility({ intervalItems: 20, labelledSinceRound1: n, hasRound1: true, hasRound2: false });
    expect(at(19)).toEqual({ eligible: false, labelsUntilEligible: 1 });
    expect(at(20)).toEqual({ eligible: true });
  });

  it('is never eligible without a first reading', () => {
    expect(retestEligibility({ intervalItems: 0, labelledSinceRound1: 99, hasRound1: false, hasRound2: false }))
      .toEqual({ eligible: false, labelsUntilEligible: 0 });
  });

  it('is never eligible once a second reading exists', () => {
    expect(retestEligibility({ intervalItems: 0, labelledSinceRound1: 99, hasRound1: true, hasRound2: true }))
      .toEqual({ eligible: false, labelsUntilEligible: 0 });
  });
});
```

- [ ] **Step 2: Run and watch it fail** — `Cannot find module '@/lib/retest'`.

- [ ] **Step 3: Implement `retest.ts`**, returning `labelsUntilEligible: Math.max(0, intervalItems - labelledSinceRound1)` when not eligible, and `{eligible:false, labelsUntilEligible: 0}` for the two structural cases (no round 1, or round 2 already present) — a shortfall of 0 that is still not eligible is deliberate: the blocker is not a count.

- [ ] **Step 4: Write the failing queue tests**

```ts
import { describe, expect, it } from 'vitest';
import { selectNext } from '@/lib/labelling-queue';

describe('selectNext', () => {
  it('is deterministic for a given seed — reproducible in tests, not inferable from order', () => {
    const cands = Array.from({ length: 10 }, (_, i) => ({ itemId: `i${i}`, round: 1, eligible: true }));
    expect(selectNext(cands, 'annA:setA')).toEqual(selectNext(cands, 'annA:setA'));
  });

  it('different annotators get different orders over the same set', () => {
    const cands = Array.from({ length: 10 }, (_, i) => ({ itemId: `i${i}`, round: 1, eligible: true }));
    const a = selectNext(cands, 'annA:setA'), b = selectNext(cands, 'annB:setA');
    expect(a.next!.itemId).not.toBe(b.next!.itemId);
  });

  it('reports set-complete when there is nothing left at all', () => {
    expect(selectNext([], 'x')).toEqual({ next: null, reason: 'set-complete' });
  });

  it('reports the retest shortfall when the ONLY candidates are not yet eligible', () => {
    // The small-set case: intervening-items-only can leave a set with nothing
    // servable, and an empty queue would look broken instead of "label more".
    const r = selectNext([{ itemId: 'i1', round: 2, eligible: false, labelsUntilEligible: 7 }], 'x');
    expect(r).toEqual({ next: null, reason: 'retest-not-yet-eligible', labelsUntilRetest: 7 });
  });

  it('prefers an eligible candidate over an ineligible one', () => {
    const r = selectNext([
      { itemId: 'i1', round: 2, eligible: false, labelsUntilEligible: 3 },
      { itemId: 'i2', round: 1, eligible: true },
    ], 'x');
    expect(r.next!.itemId).toBe('i2');
  });
});
```

- [ ] **Step 5: Run, watch fail, implement `labelling-queue.ts`.**

`selectNext` filters to eligible candidates, orders them by a deterministic hash of `seed + itemId` (a small FNV-1a is enough — **do not use `Math.random()`**, which makes the queue untestable and the order irreproducible), and returns the first. With no eligible candidates it returns the smallest `labelsUntilEligible` among ineligible ones as `retest-not-yet-eligible`, or `set-complete` when there are none at all.

**The round is part of the result and is decided here, from data — never from a request.**

- [ ] **Step 6: Run and watch pass. Then prove determinism discriminates:** replace the hash with `Math.random()` and re-run — expected FAIL on the determinism test with two different item ids. Restore and verify by sha256.

- [ ] **Step 7: Full suites and commit**

```bash
git add src/lib/retest.ts src/lib/labelling-queue.ts tests/lib/retest.test.ts
git commit -m "feat(a1): retest eligibility and blinded queue selection

Eligibility is intervening-items only, pinned at the K-1/K boundary rather
than 'eventually'. Queue order is a deterministic hash of (annotator, set)
so it is reproducible in tests and not inferable from position, and the
round is decided from data here rather than accepted from a request."
```

---

### Task 5: The assignment routes

**Files:**
- Create: `src/app/api/golden-sets/[id]/assignments/route.ts`
- Test: `tests/db/labelling.test.ts` (append), `tests/db/access-matrix.test.ts` (append)

**Interfaces:**
- Consumes: `tx.goldenAssignment` from Task 1.
- Produces: `GET → 200 {assignments: […]}`, `POST → 201 {assignment}`, `DELETE → 200 {revoked: true}`.

- [ ] **Step 1: Write the failing tests** — owner assigns a whole set (`goldenItemId: null`), assigns a single item, revocation sets `revokedAt` rather than deleting the row, and a re-assignment after revocation succeeds (the partial index permits it).

- [ ] **Step 2: Run and watch fail** (`Cannot find module`).

- [ ] **Step 3: Implement the route.** `requireAuth` + `requireScope(session, 'golden-sets:write')`, owner-or-admin on the set (`findFirst` + `goldenSetLifecycleWhere`, matching the sibling handlers in this directory — **do not** invent a new ownership read). `DELETE` **revokes**, never deletes: an assignment is a record of what was asked.

- [ ] **Step 4: Run and watch pass.**

- [ ] **Step 5: Register in the access matrix.** Follow the **golden-set sub-routes block** (`describe('Access matrix — golden-set sub-routes (/fork, /retire) and list')`) — a `for (const actor of ['anonymous','stranger','owner','admin'])` loop with a per-actor expected status. **Do not attempt a `registry` entry**: `ResourceHandlers` is `{createTarget, get, patch, del}` over a single `id` and the registry is typed to six fixed resource keys, so a two-parameter sub-resource does not fit.

- [ ] **Step 6: Full suites and commit.**

---

### Task 6: The queue and submit routes

**Files:**
- Create: `src/app/api/golden-sets/[id]/queue/route.ts`, `src/app/api/golden-sets/[id]/items/[itemId]/labels/route.ts`
- Test: `tests/db/labelling.test.ts` (append), `tests/db/access-matrix.test.ts` (append)

**Interfaces:**
- Consumes: `selectNext`, `retestEligibility`.
- Produces: `GET queue → 200 QueueResult`-shaped body with the item's content; `POST labels → 201 {labelId, round}`.

**Two security properties, not conveniences. Both are tested below.**

- [ ] **Step 1: Write the failing tests**

```ts
it('the queue never reveals that an item is a RE-READ', async () => {
  // Blinding is the whole reliability signal. A response that differs in
  // shape — or that helpfully includes the previous answer — defeats it.
  const owner = await mkUser();
  const { set, items } = await mkAssignedSet(owner.id, { itemCount: 3, retestIntervalItems: 1 });
  sessionFor(owner);
  await submitLabel(set.id, items[0].id, { overallScore: 4 });
  await submitLabel(set.id, items[1].id, { overallScore: 2 });

  const body = await (await GET_QUEUE(req(), { params: Promise.resolve({ id: set.id }) })).json();
  expect(body.next).not.toBeNull();
  expect(Object.keys(body.next).sort()).toEqual(['candidates', 'inputText', 'itemId', 'promptText', 'protocol', 'responseText']);
  expect(JSON.stringify(body)).not.toContain('round');
  expect(JSON.stringify(body)).not.toContain('overallScore');
});

it('the SERVER decides the round — a client-supplied round is ignored', async () => {
  const owner = await mkUser();
  const { set, items } = await mkAssignedSet(owner.id, { itemCount: 1, retestIntervalItems: 0 });
  sessionFor(owner);
  await submitLabel(set.id, items[0].id, { overallScore: 4 });
  const res = await submitLabel(set.id, items[0].id, { overallScore: 5, round: 1 });  // asks for round 1 again
  expect(res.status).toBe(201);
  expect((await res.json()).round).toBe(2);   // server said 2
});

it('refuses a submit for an item the annotator holds no active assignment for', async () => {
  // The queue never offered it; a back button, a stale tab or a crafted POST
  // must not be able to write a reading anyway.
  const owner = await mkUser();
  const stranger = await mkUser();
  const { set, items } = await mkAssignedSet(owner.id, { itemCount: 1 });
  sessionFor(stranger);
  const res = await submitLabel(set.id, items[0].id, { overallScore: 4 });
  expect(res.status).toBe(403);
  expect(await db.goldenLabel.count()).toBe(0);
});

it('refuses a score on a PAIRWISE item and a preference on a POINTWISE one', async () => {
  // The CHECK would refuse it at the database as a 500; the route refuses it
  // as a 400 that names the field.
  const owner = await mkUser();
  const { set, items } = await mkAssignedSet(owner.id, { itemCount: 1, protocol: 'pairwise' });
  sessionFor(owner);
  expect((await submitLabel(set.id, items[0].id, { overallScore: 4 })).status).toBe(400);
  expect((await submitLabel(set.id, items[0].id, { preference: 'A>B' })).status).toBe(201);
});
```

- [ ] **Step 2: Run and watch them fail.**

- [ ] **Step 3: Implement both routes.**

The queue resolves the annotator's active assignments, builds `QueueCandidate[]` (round 1 for unread items; round 2 for items whose `retestEligibility` passes, using `GoldenSet.retestIntervalItems` and a count of that annotator's labels created since their round-1 reading), calls `selectNext(candidates, `${session.user.id}:${params.id}`)`, and returns the item's **content only** — never the round, never a prior label.

The submit route: zod-validates `{overallScore?, preference?, criteriaScores?, reasoning?}` and rejects the wrong one for the item's protocol with a 400; **re-derives** the round exactly as the queue did, ignoring anything in the body; verifies an active assignment covering `(item, annotator, round)`; writes the label in one transaction; marks the assignment `completedAt` when its last item is read.

- [ ] **Step 4: Run and watch pass.**

- [ ] **Step 5: Prove blinding discriminates.** Add the round to the queue's response body. Re-run.
Expected: FAIL on `expect(JSON.stringify(body)).not.toContain('round')`. Restore, verify by sha256.

- [ ] **Step 6: Access matrix rows, full suites, commit.**

---

### Task 7: Agreement, disagreements and history

**Files:**
- Create: `src/app/api/golden-sets/[id]/agreement/route.ts`, `…/disagreements/route.ts`, `…/items/[itemId]/history/route.ts`
- Test: `tests/db/labelling.test.ts` (append), `tests/db/access-matrix.test.ts` (append)

**Interfaces:**
- Consumes: `agreement()` from Task 2.
- Produces: `GET agreement → 200 AgreementResult`; `GET disagreements → 200 {items: [{itemId, spread, readings}]}`; `GET history → 200 {readings: [{round, annotator:{id,name}|null, value, sawRevisionId, sawText}]}`.

- [ ] **Step 1: Write the failing tests**

```ts
it('reports the method and the OVERLAP, not the set size', async () => {
  // An agreement number over 2 shared items in a 50-item set is an anecdote.
  // The only thing that makes that visible is reporting what it was over.
  const { set } = await mkTwoAnnotatorSet({ items: 50, overlapping: 2 });
  const body = await (await GET_AGREEMENT(req(), { params: Promise.resolve({ id: set.id }) })).json();
  expect(body.itemCount).toBe(2);
  expect(body.annotatorCount).toBe(2);
  expect(body.statistic).toBe('cohen');
});

it('a set with ONE annotator reports insufficient-annotators, not a number', async () => {
  const { set } = await mkSingleAnnotatorSet();
  const body = await (await GET_AGREEMENT(req(), { params: Promise.resolve({ id: set.id }) })).json();
  expect(body.value).toBeNull();
  expect(body.reason).toBe('insufficient-annotators');
});

it('history resolves each reading to the text THAT annotator saw, after an edit', async () => {
  const owner = await mkUser();
  const { set, item } = await mkGoldenSetWithItem(owner.id, { inputText: 'as first seen' });
  await db.goldenLabel.create({ data: { goldenItemId: item.id, annotatorId: owner.id, round: 1, overallScore: 4 } });
  sessionFor(owner);
  await PATCH(jsonRequest({ items: [{ id: item.id, inputText: 'edited later' }] }), { params: Promise.resolve({ id: set.id }) });

  const body = await (await GET_HISTORY(req(), { params: Promise.resolve({ id: set.id, itemId: item.id }) })).json();
  // NOT 'edited later'. Without the revision join this returns the current
  // text and looks perfectly fine.
  expect(body.readings[0].sawText.inputText).toBe('as first seen');
});

it('anonymous gets agreement for a PUBLISHED public set, and 401 for an unpublished one', async () => {
  const pub = await mkPublishedPublicSet();
  const draft = await mkPublicButUnpublishedSet();
  setAnonymous();
  expect((await GET_AGREEMENT(req(), { params: Promise.resolve({ id: pub.id }) })).status).toBe(200);
  expect((await GET_AGREEMENT(req(), { params: Promise.resolve({ id: draft.id }) })).status).toBe(401);
});
```

- [ ] **Step 2: Run, watch fail, implement.**

All three use `optionalAuth()` — which **throws**, so it goes inside the `try` with `if (error instanceof RateLimitedError) return error.response;` first in the `catch`. Anonymous is served only when `publishedAt !== null` **and** `visibility === 'public'`; otherwise owner/admin. `history` joins `goldenItemRevision` and falls back to the item's current content when `goldenItemRevisionId` is null — which means *they saw the current content*, per the spec's invariant.

`disagreements` ranks items by spread: for scores, `max - min` across live readings; for preferences, the count of distinct values. Ranked descending, because this list is also A3's highest-information input to the next labelling round.

- [ ] **Step 3: Run and watch pass.**

- [ ] **Step 4: Prove the history join discriminates.** Return the item's current content unconditionally, ignoring `goldenItemRevisionId`. Re-run.
Expected: FAIL with `expected 'edited later' to be 'as first seen'`. Restore, verify by sha256.

- [ ] **Step 5: Access matrix rows for all three, full suites, commit.**

---

## Self-review notes

**Spec coverage.** Data model → Task 1. Agreement library → Task 2. Provenance → Task 3. Retest and queue → Task 4. Assignment → Task 5. Queue/submit routes and both security properties → Task 6. Agreement/disagreements/history and the published-vs-internal rule → Task 7. The exit gate's four clauses are pinned in Tasks 7 (method + overlap), 6 (unassigned refusal), 3 (provenance across an edit) and — the one to watch — **`testRetest` moving on an inconsistent re-read, which Task 7's agreement route must expose and which is only exercisable once Task 6 can produce two rounds.** Do not close Task 7 without it.

**Deliberately not covered.** The studio UI (A1.5). Capturing `reasoning_content` (backlogged). Krippendorff's alpha and a declared score scale — both recorded in the spec as known limitations rather than invented here. Cross-user annotation policy beyond owner/admin: roadmap decision #5, revisited when a second account exists.

**One thing to raise rather than discover.** With one account there is exactly one annotator, so **every inter-annotator number in this phase returns `insufficient-annotators` until a second account exists.** `testRetest` is the only reliability signal that actually produces a value at launch. That is by design and is what the roadmap says the column is for — but it means the agreement panel's normal state on day one is an explanation, not a number, and the UI must read as informative rather than broken.
