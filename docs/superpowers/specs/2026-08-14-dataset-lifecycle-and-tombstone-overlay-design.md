# Dataset lifecycle and the mutation record

**Date:** 2026-08-14 · **Status (2026-08-16):** approved and **partly implemented** — plan A1 (the
tombstone overlay) is complete and merged into `feat/a0-golden-set-substrate` locally; plan A2 (the
revision log) is planned in six tasks and **not started**; Plan B (the lifecycle: publish, freeze,
version-on-edit) is not planned.
**Supersedes:** Ruling 9 of `docs/superpowers/plans/2026-08-13-a0-status-and-handoff.md` ("staged datasets").
**Depends on:** A0 (`feat/a0-golden-set-substrate`, PR #12) being merged first. *In practice A1 was
built on top of A0's branch before that merge happened, so both are stacked ahead of `main`.*
**Ships as two plans.** Plan A is the mutation record; Plan B is the lifecycle. B depends on A.
Plan A was itself split during planning: **A1 = the tombstone overlay, A2 = the revision log.**
These labels collide with the `A0…A5` phases of
`2026-08-10-judge-training-engine-roadmap.md`, which mean something different — see
`../plans/2026-08-16-a1-complete-a2-handoff.md` §0.

**Current state, residual findings, and the A2 pickup:
[`../plans/2026-08-16-a1-complete-a2-handoff.md`](../plans/2026-08-16-a1-complete-a2-handoff.md).**

Every `file:line` in this document was opened and verified against the working tree at `af58c96`. Where a claim was found wrong during fact-checking, the corrected version is what appears here.

---

## The model

A user edits a dataset freely while it is **in development**. Every mutation is *recorded* rather than destroying anything: deletes hide rows, edits keep the prior text. When the user publishes, the dataset becomes **immutable** — it is now something other people's annotations depend on. Editing a published dataset does not un-freeze it; it opens a **new version, in development**, to continue working in.

```
draft  ──publish──▶  published (immutable)  ──edit──▶  v2, in development  ──publish──▶  …
                            │
                            └── frozen forever; annotations against it stay valid
```

Two holes after A0 motivate this. **Datasets still destroy data** — `DELETE` samples hard-deletes, `PUT` bulk-replace destroys everything, `PATCH` overwrites in place, and `DELETE /api/datasets/[id]` cascades a corpus away. And **nothing distinguishes a corpus under construction from one people depend on**, so A0's pin guard had to protect every annotated dataset permanently, leaving it unable to shed even a bad row.

---

## Decisions

| # | Decision |
|---|---|
| 1 | Deletion moves to a **tombstone overlay table**, adopted by **both `DatasetSample` and `Dataset`**. A0's `tombstonedAt` columns stay as shipped — not migrated. |
| 2 | The overlay is **one table with per-entity FK columns**, not a polymorphic key. |
| 3 | Filtering is **one shared relation-filter helper per entity**, spread into each read site. Not a view, not a global extension. |
| 4 | `Dataset.publishedAt` is the lifecycle marker: NULL = in development, set = published. |
| 5 | Publication is **explicit and owner-only**. No auto-publish. |
| 6 | Publication freezes **content and identity, not visibility**. |
| 7 | Editing published content **forks to the next version**, which is **born in development**. |
| 8 | A golden set annotating a hidden sample **keeps showing it** — it annotates a snapshot. |
| 9 | The seeded corpora are already published; the migration **backfills** them. |
| 10 | `inputType` is **frozen** on publication — it is content. |
| 11 | `PUT /api/datasets/[id]/samples` **converts to tombstone-and-append**, on drafts too. |
| 12 | Publish **derives and persists a slug** first. |
| 13 | Two plans, A then B. |
| 14 | **All mutations are recorded**, not only deletions: edits write a revision. |
| 15 | A **hidden dataset is closed to writes**. |
| 16 | **Samples inherit their parent dataset's hidden state.** |
| 17 | "Exactly one FK non-null" is a **real CHECK constraint**, hand-edited into the migration. |

---

## Plan seam

Three plans, in order. A1 and A2 together are what this document calls **[A]**; B is **[B]**.

**Plan A1 — the tombstone overlay.** The `Tombstone` model and its migration (including the hand-edited `CHECK`), both filter helpers and their shape tests, every read-site disposition, the ordinal and `sampleCount` rework, and converting the four *destructive* verbs to hide instead of delete. Independently shippable, and delivers the whole "datasets stop destroying data" guarantee on its own.

**Plan A2 — the revision log.** The `SampleRevision` model and its migration, writing a revision on edit, delete and restore, and whatever surface exposes the history. Depends on A1 only for the delete/restore verbs it hooks into; `PATCH`'s in-place edit is untouched by A1, so A2 owns it end to end.

**Plan B — the lifecycle.** `publishedAt` semantics, `POST /api/datasets/[id]/publish`, the freeze guards, fork-on-edit, the config-export backfill skip, retiring the pin-guard call sites, and `account-deletion.ts`'s tombstone-plus-reassign.

**The one cost of splitting A1 from A2**, stated so it is chosen rather than discovered: `DELETE` and `PUT` in `samples/route.ts` are edited twice — once by A1 to tombstone, once by A2 to append a revision. A1's implementer should leave those transactions shaped so a second write drops in cleanly, and A2's brief carries a pointer to what A1 did there.

Sections below are tagged **[A]** where they apply to the overlay work; the revision log is confined to its own section.

---

## The overlay and the log **[A]**

Two tables, because they answer different questions and cannot be one. `Tombstone` is **current state** — one row per entity, `@unique`, which is what makes `upsert` correct and what lets the relation be declared to-one. `SampleRevision` is an **append-only log** — many rows per sample, so it cannot carry that uniqueness.

```prisma
model Tombstone {
  id String @id @default(cuid())

  // Exactly one of these is non-null — enforced by a hand-edited CHECK.
  datasetSampleId String?        @unique
  datasetSample   DatasetSample? @relation(fields: [datasetSampleId], references: [id], onDelete: Cascade)
  datasetId       String?        @unique
  dataset         Dataset?       @relation(fields: [datasetId], references: [id], onDelete: Cascade)

  isTombstone Boolean @default(true)
  reason      String?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}

model SampleRevision {
  id              String        @id @default(cuid())
  datasetSampleId String
  datasetSample   DatasetSample @relation(fields: [datasetSampleId], references: [id], onDelete: Cascade)

  changeType String // 'edit' | 'delete' | 'restore'

  // The values as they stood BEFORE this change. Null on a delete/restore,
  // which change no content.
  input    String?
  expected String?
  metadata String?

  actorId String?
  actor   User?   @relation(fields: [actorId], references: [id], onDelete: SetNull)
  at      DateTime @default(now())

  @@index([datasetSampleId, at])
}
```

`actorId` is `SetNull` to match `GoldenLabel.annotatorId` — account deletion anonymises rather than destroying, and two deleted actors must be able to coexist on one sample's history.

**The CHECK constraint** is hand-edited into the migration:

```sql
ALTER TABLE "Tombstone" ADD CONSTRAINT "Tombstone_exactly_one_entity"
  CHECK (num_nonnulls("datasetSampleId", "datasetId") = 1);
```

Prisma cannot express `CHECK`, so this is invisible to `migrate diff`/`db pull`/`db push` and earns a **fifth row in `CONTRIBUTING.md`'s pseudo-drift table**. Without it the invariant is only a comment: Postgres permits unlimited NULLs in a unique index, so both-null orphans and both-set rows would be accepted.

### Recording a mutation

**Delete** upserts a tombstone and appends a `delete` revision:

```ts
tx.tombstone.upsert({
  where:  { datasetSampleId: id },
  create: { datasetSampleId: id, isTombstone: true, reason },
  update: { isTombstone: true, reason },
})
```

The `update:` arm is **not** empty. An empty arm makes delete → un-delete → delete leave the row *visible* — a delete that silently does nothing. State the property precisely: **a repeated delete never raises `P2002` and always converges on hidden.** It is not a no-op; it writes.

**Un-delete** flips `isTombstone` to `false`, clears `reason`, and appends a `restore` revision.

**Edit** (`PATCH`) writes a revision carrying the values *before* the change, then updates in place. Reads always see current content; the log answers "what did this say before, and who changed it."

This closes a gap A0 recorded and could not fix: a golden label preserves who/what/when but **not the text the annotator actually saw**. With the log, that text is recoverable.

**This diverges from A0's column form deliberately.** `goldenSetLifecycleWhere` pins `tombstonedAt: null` in both arms precisely so there is no way back. Two mechanisms with different capabilities coexist; the plans must not "harmonise" them.

### The filter helpers

```ts
/**
 * Live samples: not hidden themselves, and not owned by a hidden dataset.
 *
 * Returns a `NOT` key rather than the obvious
 * `{ OR: [{ tombstone: { is: null } }, { tombstone: { isTombstone: false } }] }`
 * because an object literal cannot carry two `OR` keys, and FOUR dataset read
 * sites already build their own — `datasets/route.ts:67`, `stats/route.ts:47`,
 * `datasets/[id]/versions/route.ts:155`, `dataset-versions.ts:157`. Spreading an
 * `OR` into those would silently clobber one clause or the other, with no type
 * error and no test failure.
 *
 * `NOT` collides with `NOT` identically; the only `NOT:` in src/ today is
 * `auth.ts:49`. A caller that already has one must merge, not spread. Same for
 * the `dataset:` key below.
 */
export function liveSamplesOnly(): Prisma.DatasetSampleWhereInput {
  return {
    NOT: { tombstone: { is: { isTombstone: true } } },
    dataset: { NOT: { tombstone: { is: { isTombstone: true } } } },
  };
}

export function liveDatasetsOnly(): Prisma.DatasetWhereInput {
  return { NOT: { tombstone: { is: { isTombstone: true } } } };
}
```

**The expression is verified, not assumed.** Against Prisma 6.19.2, an equivalent optional to-one with a `@unique` FK (`EvaluationRun ← HumanJudgment`) generates:

```sql
LEFT JOIN "HumanJudgment" AS "j0" ON ("j0"."runId") = ("EvaluationRun"."id")
WHERE (NOT ("j0"."overallScore" = $1 AND ("j0"."id" IS NOT NULL)))
```

Prisma injects `j0.id IS NOT NULL`, which is what makes the no-tombstone case work: no row → returned; `isTombstone: false` → returned; `true` → excluded. The `@unique` guarantees the join matches at most one tombstone.

**A type-safety warning the plan must carry:** `datasets/route.ts:62` declares `const where: any = {}`, so the helper's return type offers **zero** protection there. That same object is passed to both `findMany` (`:83`) and `count` (`:92`) — filtering one and not the other silently desynchronises the pagination total.

Each helper gets a unit test deep-equalling its returned object, mirroring `tests/lib/golden-sets.test.ts:388-426` (which assert a *returned* where-fragment). Not `:245-277`, which is argument capture on a mocked client — a different shape.

---

## Read-path dispositions **[A]**

Ten sample read rows and the dataset-level set. **Two sample sites stay unfiltered, and a larger class must stay unfiltered because filtering it raises `P2002`.**

### Sample reads

| Site | Disposition |
|---|---|
| `samples/route.ts:121` (PATCH lookup) | **Filter.** A hidden sample must 404, or it stays silently editable while every read hides it. |
| `samples/route.ts:183` (DELETE **membership** lookup) | **UNFILTERED, deliberately.** An already-hidden id still belongs to this dataset, so a retried delete must converge on hidden rather than 400 claiming it is foreign. This is `:183`, not the dataset ownership read at `:167`. |
| `samples/route.ts:46` (POST high-water read) | **UNFILTERED, deliberately.** It must see hidden rows or ordinals collide. |
| `samples/route.ts:343` (PUT response read) | **Filter.** Returned at `:349` as `{ replaced, samples }`. Unfiltered it answers with the rows it just hid — a 4-row replace over a 4-row corpus reports `replaced: 8`. Sits *inside* the verb Plan A rewrites. |
| `datasets/[id]/route.ts:36` (embedded samples) | **Filter.** |
| `config/export/route.ts:196` (nested include) | **Filter.** The document is a portable view. |
| `config/import/route.ts:652` (sample re-resolution) | **Filter.** Unfiltered, an import binds a live golden item to a hidden row while a good live duplicate sits higher. |
| `versions/route.ts:21` (child copy) | **Filter**, or version-create **resurrects** every hidden sample as a live row in the child. |
| `golden-sets/route.ts:141` (golden-set import) | **Filter.** A0's primary flow — unfiltered, a hidden sample becomes a golden item and the `Restrict` FK pins it forever. |
| `evaluations/route.ts:515-519` (batch) | **Filter**, or every batch run scores hidden rows. |
| `datasets/[id]/export/route.ts:43`, `projects/[id]/export/route.ts:111`, `:148` (CSV/JSONL) | **Filter.** The dataset one is `optionalAuth` and serves public datasets anonymously. |

### Dataset reads

**Filter** with `liveDatasetsOnly()`: `datasets/route.ts:82` **and its pagination `count` at `:92`**; `datasets/[id]/route.ts:31`; **both** project reads — `projects/[id]/route.ts:70` (anonymous) *and* `:162` (owner); `config/export/route.ts:193`; `datasets/[id]/versions/route.ts:153`; `stats/route.ts:44`; `projects/[id]/export/route.ts:109`, `:146`.

The golden-set dataset picker is **not** a distinct server read — `golden-sets/page.tsx:194` fetches `/api/datasets?…`, so filtering `datasets/route.ts:82` covers it.

### MUST NOT be filtered — the `P2002` class

Filtering any of these breaks writes rather than leaking reads, which is why it looks safe and is not:

- **Slug-dedup reads.** Filtered, they mint a duplicate slug and violate `@@unique([userId, slug])` (`schema.prisma:595`): `datasets/route.ts:187`, `evaluations/route.ts:379`, `dataset-versions.ts:169`, `config/import/route.ts:453` (upsert-by-slug), `scripts/importer/artifacts.ts:393`.
- **The version high-water read** `dataset-versions.ts:156`. Filtered, a hidden latest version lets the next fork reuse its number and collide on `@@unique([parentId, version])`. This is the spec's own `index` argument applied to `version`.
- **Sample idempotency by ordinal** — `scripts/importer/artifacts.ts:447` (`datasetId_index`).
- **`dataset-evaluation-summary.ts:119`** — `$queryRaw … FOR UPDATE`. Decision 3's "spread the helper" **cannot reach raw SQL**. Stated here so an implementer does not discover it.

Note `config/import/route.ts:618-622` (golden-set dataset resolution by slug) is **not** in this class — filtering it merely means a golden set cannot bind to a hidden dataset, which is correct, and it raises no `P2002`.

### `_count.samples`

Every producer needs the filter, not just one:

| Read | Consumer that breaks unfiltered |
|---|---|
| `datasets/route.ts:87` | `sampleTotal` (`serializers.ts:187`) and the `projects/[id]/page.tsx` ladders |
| `datasets/[id]/route.ts:47` (GET), `:112` (PATCH response) | the dataset-page ladder, before and after a metadata edit |
| `refresh/route.ts:20`, `:60` | `buildRefreshUpdate` → the persisted `sampleCount` at `:52` |
| `versions/route.ts:166` | the version-history panel (`datasets/[id]/page.tsx:735`, `:765`) |
| `config/import/route.ts:455` | the `!== configDataset.samples.length` diff at `:470` — unfiltered, re-importing an unchanged document onto a hidden-row corpus reports a spurious diff and triggers a needless replace |

Also `datasets/[id]/versions/route.ts:153-169`, which selects **both** stored `sampleCount` (`:163`) and `_count.samples` (`:166`), and the nested `versions: { select: { …, sampleCount } }` at `datasets/[id]/route.ts:41`.

`datasets/route.ts:232` (POST-create `_count`) needs nothing — a fresh row cannot carry a tombstone.

Every unfiltered site carries a comment naming *why*.

---

## Ordinals and counts **[A]**

`DatasetSample.index` stops being dense once anything is hidden. `@@unique([datasetId, index])` stays satisfied because nothing is removed.

**The re-index loop is deleted, not adapted**, and both failure modes should be named. *Adapted* (filtered to live rows) it renumbers the first survivor to `0`, collides with the hidden row still holding `0`, and every delete 500s. Kept **verbatim** it is worse in a quieter way: its query has no lifecycle filter, so `remaining` is every row, still dense, each update writes the index the row already holds — a silent no-op whose `remaining.length` becomes a stored *row* count. The `v2e` migration header documents the first mode for golden items.

**New samples append above a high-water mark**: `max(index)` over ALL rows including hidden, `+1`. Never `count()`. The read must happen **inside the same transaction** as the inserts, as `nextGoldenItemIndex` does.

The case that makes this bite is *not* a freshly-appended corpus — Prisma's `_count` is unfiltered by default and `samples/route.ts:46` stays unfiltered, so there `count == max+1` and nothing collides. It bites on a corpus **re-imported from a filtered export**: `config.ts:389` emits `index: s.index` verbatim and `import/route.ts:565` writes it back, so the rows arrive with gaps, `count < max+1`, and the first append collides.

**`sampleCount` — two writes change, seven are already correct.** It is a stored row count, correct today only because nothing is hidden, and the UI ladder reads it *first*, so a stale value shadows the live count beneath. The visible failure: the import picker advertises 620, the import yields 610.

| Site | Disposition |
|---|---|
| `samples/route.ts:77` (POST) | **Change to a live count.** `startIndex + n` drifts once `startIndex` is a high-water mark. |
| `samples/route.ts:245` (DELETE) | **Change to a live count** — and note `:248` reads `remaining.length` for the response body too. |
| `datasets/route.ts:208`, `config/import/route.ts:557` | Correct — nothing hidden on a fresh dataset. |
| `samples/route.ts:340` (PUT), `config/import/route.ts:537` | Correct — after tombstone-and-append the live set **is** the incoming document. |
| `dataset-versions.ts:192` | Correct — the child is fresh. |
| `refresh/route.ts:52` | Fixed for free, **because `refresh/route.ts:20` is on the `_count` list above**. |

**The eleven ladder expressions need no change**, listed only so a reader can confirm that: `datasets/page.tsx:652`; `datasets/[id]/page.tsx:694`, `:735`, `:765`, `:895`; `golden-sets/page.tsx:101`; `projects/[id]/page.tsx:228`, `:1156`, `:1164`, `:1634`, `:1659`. The third rung, `sampleTotal`, is set from `_count.samples` in `toPublicDataset` and is correct once that read is filtered.

Do **not** touch `hfMeta.sampleCount` (`projects/[id]/page.tsx:1241`, `:1243`, `:1360`, `:1368`, `:1379` — a HuggingFace remote count) or `summary.sampleCount` (`:841`, which is `evaluations.length`).

---

## The mutating verbs **[A]**

| Verb | Becomes |
|---|---|
| `PATCH /api/datasets/[id]/samples` | Write a `SampleRevision` with the prior values, then update in place. |
| `DELETE /api/datasets/[id]/samples` | Tombstone the named ids + `delete` revisions; delete the re-index loop; one `$transaction`. |
| `PUT /api/datasets/[id]/samples` (bulk replace, and the revert path) | Tombstone the outgoing, append the incoming above the high-water mark, filter the response read at `:343`. On drafts too. |
| `DELETE /api/datasets/[id]` | Tombstone the dataset. |
| Config importer sample replace (`config/import/route.ts:525`) | Tombstone, then append above the high-water mark. Naively converted this is a guaranteed `P2002` — it re-creates rows at raw index values that collide with retained hidden rows. **The dataset section (≈`:450-600`) has no `$transaction`** (the two that exist, `:895` and `:964`, are in A0's golden-set section), so a failure strands a half-applied import. Correct the now-stale comment at `:483` in the same change. |

**Every mutation handler's dataset guard read filters** (Decision 15) — `samples/route.ts:44`, `:105`, `:167`, `:273`; `golden-sets/route.ts:105`; `refresh/route.ts:17`; `versions/route.ts:18`, `:135`; `datasets/[id]/export/route.ts:40` — so a hidden dataset 404s on write and no golden set can be minted from one.

---

## Consequences

**`judgebench-v1` freezes on day one — but only if the migration backfills.** **[B]** Both seeds stamp `publishedAt` in the **`create` arm only**; the update arms deliberately do not re-assert it, and no migration backfills. So a freshly-seeded instance has both corpora published, while **any instance seeded before the column existed has NULL on both, and re-seeding will not fix it**. The migration backfills the two seeded ids where null, with a header saying why.

**The pin guard is retired from its call sites but NOT deleted.** **[B]** One hard delete survives: `account-deletion.ts:141` runs `tx.dataset.deleteMany({ where: { userId, visibility: 'private' } })` inside the account-deletion transaction, has never called the guard, and trips `GoldenSet.datasetId`'s `Restrict` — rolling back the whole deletion. Currently unreachable (`deleteUserAccount` has no callers outside its test).

**Converting it to a tombstone moves the delete rather than removing it.** `Dataset.userId` is `onDelete: Cascade`, so a tombstoned-but-still-owned dataset is hard-deleted by `tx.user.delete()` at `:361`, hitting the same FK. Ownership must be reassigned to the archive user in the same step, as public datasets already are at `:146-150`. `Dataset.parent` is `onDelete: NoAction` — a second, independent FK that also refuses, and the plan should not assume one fix covers both.

**Four existing tests break and must be updated deliberately.** **[A]** `config-golden-sets.test.ts:852` fails **once**, on its unfiltered row assertion at `:867` (counts 4, expects 2) — *not* on an index collision, since Plan A remaps above the high-water mark. Plus the three unpinned happy-path halves of the guard pairs, all asserting hard deletion by raw row count: `dataset-sample-freeze.test.ts:136` (`replaced`/`rows` expect 1, get 2), `:238` (`{deleted:1, remaining:0}` and `count()` → 0, gets 1), `:275` (`db.dataset.count()` → 0, gets 1). **`config-roundtrip-fidelity.test.ts:265` does *not* break** — the round trip yields `changes.length === 0` → `skip`, and `FULL_CONFIG`'s `gs-alpha` pins `ds-alpha` anyway.

**The fidelity COVERAGE ledger moves in the same change.** **[A]** The suite iterates `Object.entries(COVERAGE)` and never the datamodel, so a model absent from the map is unchecked, and this design adds **no column** to `Dataset` or `DatasetSample` — so neither tripwire fires. Add `Tombstone` and `SampleRevision` deliberately. A `knownGaps` entry on `DatasetSample` is **impossible**: the stale-key guard requires every key to be a real scalar column of that model. And adding a gap entry also fails the ledger assertion at `:568-586`, whose expected object is locked at `:577-585` to exactly `{Rubric, Dataset, GoldenSet}`.

**A published dataset still round-trips as a draft.** **[B]** `publishedAt` is `excludedByDesign` and the importer never writes it. Recorded, not fixed: making publication portable is a separate decision.

**`GET /api/config/export` performs writes.** **[B]** Its slug-backfill loop (`config/export/route.ts:204-212`) `update`s null-slug rows — under frozen identity, mutating a published dataset's `slug` from a read endpoint. It must **skip the write but still derive the slug in memory and still push to the dedup array** (`:211`, `:213`); skipping the row entirely breaks in-document dedup. Harmless for the document because `config.ts:371` already falls back.

**The "first N samples" import control breaks.** **[A]** `golden-sets/page.tsx:236-241` builds `Array.from({length: N}, (_, i) => i)` under a comment asserting contiguity — the premise this design falsifies. Filtered, the request 400s at the first hidden ordinal (`golden-sets/route.ts:152-162`). Both halves are Plan A's: the server accepts a `limit` meaning "the first N *live* samples" alongside the existing explicit `sampleIndices`, and the client sends `limit`.

**`POST /api/datasets/[id]/refresh` straddles the freeze line.** Its `sampleCount` write is Plan A's; its behaviour on a published dataset is Plan B's — metadata only, never samples.

**Retiring the pin guard would delete coverage for an invariant that still matters.** **[B]** `dataset-sample-freeze.test.ts:175` pins "a TOMBSTONED golden item still pins the dataset — the FK does not care that the row is dead," which is why `findGoldenSetsPinningDataset` is deliberately unfiltered. Keep the test.

---

## Out of scope

- Migrating A0's `tombstonedAt` columns. They stay.
- A purge wave.
- Revision history for `Dataset` rows themselves (only samples are logged).
- Making publication portable across instances.
- Widening who may create golden sets.

---

## Testing

Non-vacuity is demonstrated mechanically, per the standard A0 adopted: break the guard, observe the specific failure, restore, confirm byte-identical.

Seven shapes pass vacuously unless the fixture is built deliberately. **All are Plan A's** except the last:

1. **The overlay hides rows.** The fixture must contain a genuinely tombstoned sample.
2. **The un-deleted arm is visible.** Every other shape uses an `isTombstone: true` fixture, so a filter written as the simpler `{ tombstone: { is: null } }` passes all of them. Only an `isTombstone: false` fixture justifies the `NOT` formulation.
3. **The high-water mark.** The fixture must tombstone a **tail** sample — `count()`, `max` over live, and `max` over all agree until the tail is hidden.
4. **Repeated delete of an already-hidden id** returns 200 and stays hidden. This is the *sole* reason `samples/route.ts:183` stays unfiltered, and a delete → un-delete → delete test does **not** cover it: its second call hits the membership lookup against a live row and passes even filtered.
5. **The two `sampleCount` writes** are unobservable unless the fixture contains a tombstone *before* the verb runs — on a clean dataset both formulations equal the live count.
6. **The version-create resurrection guard.** A version test over a tombstone-free parent passes unfiltered.
7. **Publication freezes content** **[B]** — assert the row is unchanged after the refused write, not merely that the response was 409. A handler that 409s *and* writes is the worse bug.

UI verification is manual — all three vitest configs are `environment: 'node'`, no jsdom. A known and accepted limit.
