# Dataset lifecycle and the tombstone overlay

**Date:** 2026-08-14 · **Status:** approved design, ready to plan
**Supersedes:** Ruling 9 of `docs/superpowers/plans/2026-08-13-a0-status-and-handoff.md` ("staged datasets"), which recorded the want and deferred the design to its own spec. This is that spec.
**Depends on:** A0 (`feat/a0-golden-set-substrate`, PR #12) being merged first.
**Ships as two plans.** See "Plan seam" — Plan A is the overlay, Plan B is the lifecycle, and B depends on A.

---

## Why

Two holes remain after A0, and they are the same hole seen from two sides.

**Datasets still destroy data.** A0 made golden sets tombstone rather than delete, on the owner's ruling that "hard deletion may lose data, and there are no existing users, so nothing justifies destruction." The dataset side never got that treatment: `DELETE /api/datasets/[id]/samples` hard-deletes, `PUT` bulk-replace hard-deletes everything, `PATCH` edits samples in place, and `DELETE /api/datasets/[id]` cascades a corpus away entirely.

**Nothing distinguishes a corpus under construction from one people depend on.** A0's answer was a pin guard: once any golden set annotates a dataset, its samples cannot be replaced. That is correct but blunt — it makes an annotated corpus *permanently* unable to shed a bad row, with no remedy short of a purge wave that does not exist.

The insight this design turns on: **a dataset still in development needs no protection, and a published one needs a different kind.** Draft corpora are free. Published corpora become immutable, and deletion becomes hiding rather than removal — so a bad row can leave the view without leaving the record, and without breaking the annotations that reference it.

---

## Decisions

Thirteen decisions were made by the owner during design. They are the authority the plans argue from.

| # | Decision |
|---|---|
| 1 | Deletion moves to a **tombstone overlay table**, adopted by **both `DatasetSample` and `Dataset`** at full parity. A0's `tombstonedAt` **columns stay exactly as shipped** — they are not migrated. |
| 2 | The overlay is **one table with per-entity foreign-key columns**, not a polymorphic `(entityType, entityId)` key. |
| 3 | Filtering is **one shared Prisma relation-filter helper per entity**, spread into each read site. Not a database view, not a global client extension. |
| 4 | `Dataset.publishedAt` becomes the lifecycle marker: NULL = **in development**, set = **published**. |
| 5 | Publication is **explicit and owner-only**. There is no auto-publish. |
| 6 | Publication freezes **content and identity, but not visibility**. |
| 7 | Editing a published dataset's content **forks to the next version**, using the versioning machinery that already exists. |
| 8 | A golden set annotating a now-hidden sample **keeps showing it**. The golden set annotates a snapshot. |
| 9 | The seeded platform corpora are **already published**, and freezing them is intended. The migration **backfills** them (see the caveat under Decision 9 below). |
| 10 | `inputType` is **frozen** on publication — it is content, not metadata. |
| 11 | `PUT /api/datasets/[id]/samples` **converts to tombstone-and-append**, on drafts as well as published. |
| 12 | Publish **derives and persists a slug** before stamping `publishedAt`. |
| 13 | This ships as **two plans**, A then B. |

---

## Plan seam

**Plan A — the tombstone overlay.** The `Tombstone` model and its migration, the two `liveOnly` helpers and their shape tests, every read-site disposition, the ordinal rework (including the two `sampleCount` writes that drift, which sit inside verbs it is already rewriting), and converting all four destructive verbs. Independently shippable; delivers the whole "datasets stop destroying data" half.

**Plan B — the dataset lifecycle.** `publishedAt` semantics, `POST /api/datasets/[id]/publish`, the freeze guards, fork-on-edit, the config-export backfill skip, retiring the pin-guard call sites, and the `account-deletion.ts` tombstone-plus-reassign.

B depends on A only through "delete is a tombstone." A does not depend on B. Sections below are tagged **[A]** or **[B]**.

---

## The tombstone overlay **[A]**

### Schema

```prisma
model Tombstone {
  id String @id @default(cuid())

  // ── Per-entity foreign keys. Exactly one is non-null. ──
  datasetSampleId String?        @unique
  datasetSample   DatasetSample? @relation(fields: [datasetSampleId], references: [id], onDelete: Cascade)

  datasetId String?  @unique
  dataset   Dataset? @relation(fields: [datasetId], references: [id], onDelete: Cascade)

  isTombstone Boolean @default(true)
  reason      String?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}
```

`DatasetSample` and `Dataset` each gain a back-relation: `tombstone Tombstone?`.

No index on `isTombstone`: nearly every row is `true`, so its selectivity is near zero, and the generated SQL joins on the FK column (already indexed by its `@unique`) rather than seeking on the flag.

### Why not polymorphic

The original sketch was `(dataset_id, record_id, is_tombstone)`. It does not work: **Prisma relation filters require a declared `@relation` backed by a real foreign key**, and a polymorphic key has none — so such a table cannot appear in a `where` clause as a relation filter and cannot compile to `NOT EXISTS`. Decisions 2 and 3 were in direct tension; per-entity FK columns resolve it while keeping one table to audit.

The cost is honest: adopting a new entity needs a nullable FK column and a migration, not just a new string. That buys referential integrity on the overlay and a filter the planner understands.

### Deleting, and un-deleting

Deleting **upserts** a tombstone:

```ts
tx.tombstone.upsert({
  where:  { datasetSampleId: id },
  create: { datasetSampleId: id, isTombstone: true, reason },
  update: { isTombstone: true, reason },
})
```

The `update:` arm is **not** empty. An empty arm would make delete → un-delete → delete leave the row *visible* — a delete that silently does nothing. The property to state precisely is: **a repeated delete never raises `P2002` and always converges on hidden.** It is not a no-op; it writes, and it bumps `updatedAt`.

Un-deleting flips `isTombstone` to `false` and clears `reason`, rather than deleting the tombstone row. The row then records that this entity was once deleted and when its state last changed. It is **not** a full audit trail — a second delete→restore cycle overwrites `updatedAt` and the earlier history is gone. An events table would be a new decision and is out of scope.

**This is a deliberate divergence from A0's column form**, which has no un-delete at all — `goldenSetLifecycleWhere` pins `tombstonedAt: null` in both arms precisely so there is no way back. Two mechanisms with different capabilities will coexist. The plans must not "harmonise" them; A0's irreversibility is a property, not an oversight.

### The filter helpers

One per entity, because the return types differ:

```ts
/**
 * Live rows only: no tombstone row, or one that has been un-deleted.
 *
 * Returns a single `NOT` key. The obvious formulation —
 * `{ OR: [{ tombstone: { is: null } }, { tombstone: { isTombstone: false } }] }`
 * — is a trap: an object literal cannot carry two `OR` keys, so spreading this
 * into a `where` that already builds its own `OR` would silently clobber one or
 * the other, with no type error and no test failure.
 *
 * No CURRENT dataset or sample read site builds a `where.OR`, so this hazard is
 * prospective rather than live — but it is exactly the shape that has bitten
 * this repo before, and the helper is meant to be spread everywhere.
 *
 * The same caveat applies to `NOT` itself: two `NOT` keys collide identically.
 * A caller that already has a `NOT` must merge, not spread.
 */
export function liveSamplesOnly(): Prisma.DatasetSampleWhereInput {
  return { NOT: { tombstone: { is: { isTombstone: true } } } };
}

export function liveDatasetsOnly(): Prisma.DatasetWhereInput {
  return { NOT: { tombstone: { is: { isTombstone: true } } } };
}
```

**This expression is verified, not assumed.** Against Prisma 6.19.2 with no preview features, an equivalent optional to-one relation with a `@unique` FK (`EvaluationRun ← HumanJudgment`) generates:

```sql
FROM "EvaluationRun" LEFT JOIN "HumanJudgment" AS "j0" ON ("j0"."runId") = ("EvaluationRun"."id")
WHERE (NOT ("j0"."overallScore" = $1 AND ("j0"."id" IS NOT NULL)))
```

Prisma injects the `j0.id IS NOT NULL` conjunct, which is what makes the no-tombstone case work: no row → `NULL AND FALSE` → `FALSE` → `NOT FALSE` → returned; `isTombstone: false` → returned; `isTombstone: true` → excluded.

The `@unique` on each FK column is **load-bearing for correctness, not only for `upsert`** — it is what stops the LEFT JOIN fanning out and duplicating parent rows.

Each helper gets a unit test deep-equalling its returned object, mirroring the guards at `tests/lib/golden-sets.test.ts:388-426` (`goldenSetLifecycleWhere` / `goldenItemLifecycleWhere`), which are the tests that assert a returned where-fragment. Note this is *not* the `findGoldenSetsPinningDataset` test at `:245-277` — that one captures arguments to a mocked client, a different shape.

---

## The dataset lifecycle **[B]**

### States

**In development** (`publishedAt` NULL). Freely mutable.

**Published** (`publishedAt` set). Derived from `updateDatasetSchema` (`src/app/api/datasets/[id]/route.ts:9-16`), which accepts exactly `name`, `description`, `visibility`, `inputType`, `projectId`, `tags`:

| Field | Draft | Published |
|---|---|---|
| samples (content) | mutable | **frozen** — edits fork to v2 |
| `name` | mutable | **frozen** |
| `slug` | not settable via PATCH | **frozen** |
| `inputType` | mutable | **frozen** |
| `description` | mutable | mutable |
| `tags` | mutable | mutable |
| `projectId` | mutable | mutable |
| `visibility` | mutable | mutable |

`inputType` is frozen because it is content: it selects the golden-item mapping (`query` vs `query-response`), so flipping it on a published, annotated corpus changes what every derived golden item *means* without changing a row — drift that is invisible by construction.

`visibility` stays mutable deliberately. A published dataset must remain able to become private; refusing that would make publication a trap rather than a promise, and no annotation depends on a corpus being public.

`description`, `tags` and `projectId` stay mutable for A0's stated reason: refusing a typo fix is hostile and buys nothing.

**Identity has two enforcement points, not one.** `name` needs a new guard in `PATCH /api/datasets/[id]`. `slug` needs **no** PATCH guard at all — it is not in `updateDatasetSchema`, and no route mutates a dataset slug today. Its only writes are the two create paths and the export backfill, so freezing `slug` is entirely satisfied by the export-backfill skip described below. An implementer looking for a `slug` field to reject in PATCH will not find one; that is correct.

### Publishing

`POST /api/datasets/[id]/publish` — owner-only, requires `datasets:write`.

It **derives and persists a slug first** if the dataset has none, then stamps `publishedAt`. `Dataset.slug` is nullable and pre-existing rows can hold null; publishing a null-slug dataset and then freezing identity would lock in a permanently-unset portable identifier, and the one mechanism that would have fixed it — the export backfill — is what this design turns off.

One-way: there is no un-publish, because publication grants an immutable identity and revoking it would break the promise the state exists to make. A dataset that should not have been published is superseded by a new version.

**There is no auto-publish.** It was designed and then removed: `POST /api/golden-sets` refuses any dataset not owned by the platform user (`golden-sets/route.ts:127-136`), and the platform user carries `passwordHash: '!platform-system-user'` (`seed-core.ts:73`) which credentials login excludes via `NOT: { passwordHash: { startsWith: '!' } }` (`src/lib/auth.ts:49`), has no OIDC identity, and can mint no API key. So `dataset.userId === session.user.id` is unreachable at that hook point. The only path reaching a draft dataset is the config importer — the last place an implicit state transition belongs.

### Editing published content

Content edits on a published dataset **fork to the next version** via `createDatasetVersion` (`src/lib/dataset-versions.ts`).

**The dataset fork already exists.** It is 228 lines, transactional, with a bounded `MAX_ATTEMPTS = 3` `P2002` retry, wired to a "New version" button and a version-history panel, and covered by `tests/db/dataset-version-race.test.ts` and `tests/db/dataset-version-samples.test.ts`. `forkGoldenSet`'s own header states "Structurally it mirrors `createDatasetVersion`" (`src/lib/golden-set-versions.ts:9`) — not the other way round. The work is bringing `createDatasetVersion` up to the newer standard (an explicit transaction timeout), **not** building a fork.

`createDatasetVersion` takes its samples as an argument and never queries them; the read that must be filtered is the route's, at `datasets/[id]/versions/route.ts:21`. Unfiltered, a version-create silently **resurrects** every hidden sample as a live row in the child, because the overlay is keyed on row id and child rows are born untombstoned.

**The version-history panel's "Revert to this" button does not go through `createDatasetVersion`.** `revertToVersion` (`src/app/datasets/[id]/page.tsx:416-435`) calls `PUT /api/datasets/[id]/samples` — the bulk-replace handler, which hard-deletes and recreates at `index: 0..n-1`. That is the same guaranteed-`P2002` shape diagnosed for the config importer, and Decision 11 converts it.

`v1` stays frozen, so every golden set annotating it stays valid. Annotations are **not** migrated to `v2` — a golden set is the annotation layer over exactly one dataset, and that dataset is `v1`.

---

## Ordinals **[A]**

`DatasetSample.index` stops being dense the moment anything is tombstoned. `@@unique([datasetId, index])` remains satisfied because nothing is removed — every ordinal is still occupied, by a mix of live and hidden rows.

**The re-index loop is deleted, not adapted.** `DELETE /api/datasets/[id]/samples` currently renumbers survivors `0..n-1`. Kept on top of tombstoning it is not redundant but *guaranteed to abort*: renumbering the first survivor to `0` collides with the hidden row still holding `0`, `P2002`, transaction rolled back, every delete 500s. The `v2e` migration header documents this failure verbatim for the golden-item case.

**New samples append above a high-water mark.** `nextIndex = max(index) over ALL rows including tombstoned, + 1`. Never `count()`, never `max` over live rows. `POST /api/datasets/[id]/samples` currently uses `dataset._count.samples` as `startIndex` (`samples/route.ts:46,59`), which is the `count()` failure exactly: tombstone sample 0 of 3, live count is 2, index 2 is occupied, first append collides. The high-water read must happen **inside the same transaction** as the inserts, as `nextGoldenItemIndex` does.

### The count diverges from the ordinal source

`Dataset.sampleCount` is a denormalised **stored row count**. Today rows and visible samples are the same thing, so it is correct by accident. Tombstoning breaks that equality, and the UI reads it through a ladder — `sampleCount ?? sampleTotal ?? _count.samples ?? 0` (`golden-sets/page.tsx:101`) — whose **first** rung is the stored column. So a stale `sampleCount` shadows the live relation count beneath it.

The concrete failure: the golden-set import picker advertises 620 samples, the import yields 610, and the user cannot see why. This is the same bug A0 fixed for `_count.items`; the read-path table above catches the `_count` half, and this catches the half that shadows it.

**Only two write sites actually change**, and both are inside verbs this plan is already rewriting:

| Site | Computes | Disposition |
|---|---|---|
| `samples/route.ts:77` (POST append) | `startIndex + n` | **Change to a live count.** `startIndex` becomes the high-water mark, so this drifts the moment anything is hidden. |
| `samples/route.ts:245` (DELETE) | `remaining.length` from the re-index query | **Change to a live count**, as part of deleting the re-index loop. |

Every other writer is already correct and must be left alone — verified individually rather than inferred from the fact that it touches the column:

- `datasets/route.ts:208` (create) and `config/import/route.ts:557` (import create) — nothing is tombstoned on a fresh dataset.
- `samples/route.ts:340` (PUT bulk replace) and `config/import/route.ts:537` (import replace) — after tombstone-and-append the live set **is** the incoming document, so the document's length is the live count.
- `dataset-versions.ts:192` — the child is fresh and all its rows are live.
- `refresh/route.ts:52` — it passes `_count.samples` through `buildRefreshUpdate` (`dataset-refresh-update.ts:43`), so filtering that read fixes this site for free.

**The eleven ladder expressions need no change at all.** With `sampleCount` correct and `_count.samples` filtered, they read correct values as written. They are listed here only so a reader can confirm that, not as work: `datasets/page.tsx:652`; `datasets/[id]/page.tsx:694`, `:735`, `:765`, `:895`; `golden-sets/page.tsx:101`; `projects/[id]/page.tsx:228`, `:1156`, `:1164`, `:1634`, `:1659`.

Do **not** touch `hfMeta.sampleCount` (`projects/[id]/page.tsx:1241`, `:1243`, `:1360`, `:1368`, `:1379` — a HuggingFace remote row count) or `summary.sampleCount` (`projects/[id]/page.tsx:841`, which is `evaluations.length`). Different quantities sharing a name.

A third name exists for the live quantity: `sampleTotal`, set from `_count.samples` in `toPublicDataset` (`serializers.ts:187`) for the anonymous view. It is the ladder's middle rung and is correct once `_count.samples` is filtered.

---

## Read-path dispositions **[A]**

Nine sample read sites and the dataset-level set. Three must stay **unfiltered**, and all three are load-bearing.

| Site | Disposition |
|---|---|
| `PATCH /api/datasets/[id]/samples` lookup (`samples/route.ts:121`) | **Filter.** A hidden sample must 404, or it stays silently editable while every read path hides it. |
| `DELETE /api/datasets/[id]/samples` **membership** lookup (`samples/route.ts:183`) | **UNFILTERED, deliberately.** An already-hidden id still belongs to this dataset, so a retried delete must converge on hidden rather than 400 claiming the sample is foreign. Note this is the membership lookup at `:183`, not the dataset ownership lookup at `:167`. |
| `POST /api/datasets/[id]/samples` high-water read (`samples/route.ts:46`) | **UNFILTERED, deliberately.** It must see hidden rows or the ordinal collides. |
| `GET /api/datasets/[id]` embedded samples | **Filter**, with `_count.samples`. |
| `GET /api/config/export` nested `samples` include (`config/export/route.ts:196`) | **Filter.** The document is a portable view. |
| Config importer sample re-resolution (`config/import/route.ts:652`) | **Filter.** It resolves `GoldenItem.sourceDatasetSampleId` by `inputText`, keeping the lowest-index match; unfiltered, an import binds a live golden item to a hidden row while a good live duplicate sits higher. |
| `POST /api/datasets/[id]/versions` child copy (`versions/route.ts:21`) | **Filter**, or version-create resurrects every hidden sample. |
| `POST /api/golden-sets` sample read (`golden-sets/route.ts:141`) | **Filter.** A0's primary flow — unfiltered, a hidden sample becomes a golden item, and the `Restrict` FK then pins that row forever. |
| `POST /api/evaluations` batch read (`evaluations/route.ts:515-519`) | **Filter.** Unfiltered, every batch run scores hidden rows. |
| CSV/JSONL data export (`datasets/[id]/export/route.ts:43`, `projects/[id]/export/route.ts:111`, `:148`) | **Filter.** The dataset one is `optionalAuth` and serves public datasets anonymously, so unfiltered leaves deleted samples downloadable by anyone. |
| Dataset-level reads: `GET /api/datasets`, `GET /api/datasets/[id]`, `GET /api/projects/[id]`, the golden-set dataset picker, config export's dataset loop | **Filter** with `liveDatasetsOnly()`. |

`src/lib/export.ts` needs no change — it imports no Prisma client and `flattenDatasetSample` is a pure row formatter over an already-fetched object.

Every unfiltered site carries a comment naming *why*. A0's evidence is that the exceptions are the part that needs to be visible.

---

## The four destructive verbs **[A]**

| Verb | Becomes |
|---|---|
| `DELETE /api/datasets/[id]/samples` | Tombstone the named ids; delete the re-index loop; wrap the handler in one `$transaction`. |
| `PUT /api/datasets/[id]/samples` (bulk replace, and the revert path) | Tombstone the outgoing rows, append the incoming above the high-water mark. On drafts as well as published — otherwise the design's premise is false for the verb that destroys the most. |
| `DELETE /api/datasets/[id]` | Tombstone the dataset. |
| Config importer sample replace (`config/import/route.ts:525`) | Tombstone, then append above the high-water mark. Naively converted this is a guaranteed `P2002`: it re-creates the document's rows at their raw index values, which collide with the retained hidden rows. The route has no `$transaction`, so a failure strands a half-applied import. |

---

## Consequences accepted, with their reasons

**`judgebench-v1` freezes on day one — but only if the migration backfills.** **[B]** Both seeded corpora stamp `publishedAt` in the **`create` arm only** (`seed-core.ts:230`, `seed-judgebench.ts:153`); the update arms deliberately do not re-assert it, and no migration backfills it. So a freshly-seeded instance has both corpora published, while **any instance seeded before `publishedAt` existed has NULL on both, and re-seeding will not fix it** — JudgeBench would be a freely-mutable draft, the exact opposite of Decision 9. The migration therefore backfills `publishedAt` on the two seeded ids where it is null, and carries a header saying why. Freezing them is the intended outcome: it is the shared substrate, and curation continues by creating `v2`.

**The pin guard is retired from its call sites but NOT deleted.** **[B]** Its FK justification evaporates where deletes become tombstones. But **one hard delete survives**: `src/lib/account-deletion.ts:141` runs `tx.dataset.deleteMany({ where: { userId, visibility: 'private' } })` inside the account-deletion transaction, has never called the guard, and trips `GoldenSet.datasetId`'s `Restrict` directly — rolling back the entire account deletion. It is currently unreachable (`deleteUserAccount` has no callers outside its own test), which makes it debt with a deadline rather than a live bug.

**Converting that call to a tombstone does not fix it — it moves it.** `Dataset.userId` is `onDelete: Cascade`, so a tombstoned-but-still-owned dataset is hard-deleted by the `tx.user.delete()` at `account-deletion.ts:361`, hitting the same FK. Ownership must be reassigned to the archive user in the same step, exactly as public datasets already are at `:146-150`. The helper and its tests stay; the plan retires its *call sites*.

**`Dataset.parent` is `onDelete: NoAction`**, a second, independent reason a hard delete can fail today: Postgres refuses to delete a root dataset with version children. It disappears for the same reason `Restrict` does, but it is a distinct FK and the plan should not assume one fix covers both.

**A published dataset still round-trips as a draft.** **[B]** `publishedAt` is `excludedByDesign` in the fidelity COVERAGE map and the importer never writes it, so export → import onto a fresh instance produces a mutable copy of published content. Left as-is and recorded: making publication portable is a separate decision about what a config document means across instances.

**`GET /api/config/export` performs writes.** **[B]** Its slug-backfill loop (`config/export/route.ts:204-212`) `update`s rows with a null slug — which, under frozen identity, mutates a published dataset's `slug` from a read endpoint. The loop must **skip the write but still derive the slug in memory and still push it to the dedup array** (`:211`, `:213`), so a later dataset cannot claim the same slug. Skipping the row entirely would break in-document dedup. This is harmless for the document itself because `src/lib/config.ts:371` already falls back to `dataset.slug || generateSlug(dataset.name)`.

**The "first N samples" import control breaks.** **[A]** `src/app/golden-sets/page.tsx:236-241` builds `sampleIndices: Array.from({ length: N }, (_, i) => i)` under a comment asserting sample indices are contiguous — the premise this design falsifies. Filtered, the request 400s at the first hidden ordinal (`golden-sets/route.ts:152-162`). **Both halves of the fix are Plan A's**: the server accepts a `limit` meaning "the first N live samples" alongside the existing explicit `sampleIndices`, and the client sends `limit` instead of synthesising ordinals.

**`POST /api/datasets/[id]/refresh` straddles the freeze line.** **[B]** It writes `description` and `tags` (mutable when published) *and* `sampleCount` (`refresh/route.ts:48-56`), and reads `_count.samples` into `buildRefreshUpdate`. Its `sampleCount` write is Plan A's (live count); its behaviour on a published dataset is Plan B's — it must not refresh samples on a published dataset, only metadata.

**The fidelity COVERAGE map will not warn us.** **[A]** The suite iterates `Object.entries(COVERAGE)` and never the datamodel, so a model absent from the map is never checked — adding `Tombstone` trips nothing automatically. And because this design adds **no column** to `Dataset` or `DatasetSample`, the map's unclassified-column tripwire cannot fire either. The plan must add `Tombstone` to the map deliberately and record that sample deletion is not portable. A `knownGaps` entry on `DatasetSample` is **impossible** — the stale-key guard requires every key to be a real scalar column of that model, and there is no tombstone column. The note belongs on `Tombstone` itself.

**Two existing tests break and must be updated deliberately.** **[A]** `tests/db/config-golden-sets.test.ts:852` ("an UNPINNED dataset still has its samples replaced wholesale") fails twice — its document indices collide with retained rows, and its unfiltered assertion counts 4 where it expects 2. `tests/db/config-roundtrip-fidelity.test.ts:265` ("importing an export twice is idempotent") is the second.

**Retiring the pin guard would delete coverage for an invariant that still matters.** **[B]** `tests/db/dataset-sample-freeze.test.ts:175` pins "a TOMBSTONED golden item still pins the dataset — the FK does not care that the row is dead," which is why `findGoldenSetsPinningDataset` is deliberately not lifecycle-filtered. That fact stays true and stays load-bearing for the eventual purge wave. Keep the test.

---

## Out of scope

- Migrating A0's `tombstonedAt` columns to the overlay. They stay.
- A purge wave. Nothing here removes data; the eventual purge is a separate decision with its own authorisation story.
- A full delete/restore audit trail (an events table).
- Making publication portable across instances.
- Widening who may create golden sets.
- `PATCH /api/datasets/[id]/samples`'s in-place edit on **draft** datasets — a draft is meant to be mutable.

---

## Testing

Every behavioural claim gets a test that would fail without it. Four have shapes that pass vacuously and need naming:

- **The overlay hides rows.** The fixture must contain a genuinely tombstoned sample; a test over a clean dataset passes whether the filter is applied or not.
- **The high-water mark.** The fixture must tombstone a **tail** sample. `count()`, `max` over live rows, and `max` over all rows agree until the tail is hidden.
- **Un-delete converges.** delete → un-delete → delete must end hidden. A test that only does delete → un-delete passes with an empty `update:` arm.
- **Publication freezes content.** Assert the row is unchanged after the refused write, not merely that the response was 409 — a handler that 409s *and* writes is the worse bug.

Non-vacuity is demonstrated mechanically, per the standard this repo adopted during A0: break the guard, observe the specific failure, restore, confirm byte-identical.

UI verification is manual — all three vitest configs are `environment: 'node'` and there is no jsdom. A known and accepted limit.
