## What this PR is now

It opened as **A0 — the golden-set substrate** alone. Two further plans were built on top of that
branch before it merged, so it now carries three stages, in dependency order:

| Stage | What it does | Migration |
|---|---|---|
| **A0** — golden-set substrate | `GoldenSet`/`GoldenItem`/`GoldenLabel` CRUD, import from an existing `Dataset`, all three protocols, export/import round-trip coverage | `v2d`, `v2e` |
| **L1** — the tombstone overlay | Deleting a dataset or sample **hides** it instead of destroying it | `v2f` |
| **L2** — the revision log | Every mutation to a sample is **recorded**, edits included, with the values as they stood before | `v2g` |

L1 and L2 were called "A1" and "A2" while they were being built. They were renamed to **L1/L2** on
2026-08-16 because `A0…A5` already means something else — the phases of
`docs/superpowers/specs/2026-08-10-judge-training-engine-roadmap.md`, whose A1 is *human
verification* and whose A2 is *the calibration engine*. **Commit prefixes (`feat(a1):`), the `(A1)`
markers in `src/`, and the `v2f` migration header keep the old letters permanently** — `v2f` is
already applied and Prisma checksums migration files, so it can never be edited. Read `(A1)` in
code as L1.

---

## A0 — the golden-set substrate

Five schema models existed with zero lines of code behind them. This makes them reachable: CRUD for
golden sets and items, import of golden items from a `Dataset` the user already has, all three
`RunProtocol` values, and the export/import round trip — golden sets are now classified in the
`COVERAGE` map of `tests/db/config-roundtrip-fidelity.test.ts`, so the portability guarantee covers
them rather than silently omitting them.

An owner ruling mid-flight replaced every destructive path with a tombstone, first as `tombstonedAt`
columns on `GoldenItem`/`GoldenLabel` (`v2e`). **That column form is deliberately one-way** and is
not the same mechanism as L1's overlay; `goldenSetLifecycleWhere` pins `tombstonedAt: null` in both
arms precisely so a tombstoned golden set has no way back. The two coexist on purpose and must not
be harmonised.

## L1 — the tombstone overlay

A `Tombstone` table with per-entity nullable `@unique` FK columns, under a hand-edited
`CHECK (num_nonnulls("datasetSampleId", "datasetId") = 1)`. Prisma cannot express a `CHECK`, so this
is invisible to `migrate diff`/`db pull`/`db push` and earns the **fifth** row in CONTRIBUTING's
"Known migrate-diff pseudo-drift" table.

`src/lib/tombstones.ts` is the single definition of "hidden". Three things a reviewer should hold on
to:

1. **`liveSamplesOnly()` sets two keys**, including a parent arm (`dataset:`), because samples
   inherit their parent dataset's hidden state. A caller that already has a `NOT:` or `dataset:` key
   must **merge, not spread**.
2. **The `NOT` formulation is load-bearing.** Prisma compiles it to
   `NOT (isTombstone = $1 AND id IS NOT NULL)`, and that injected `IS NOT NULL` is what makes the
   no-tombstone case work. `tombstone: null` loses every *restored* row; `{ isTombstone: false }`
   loses the entire clean corpus. Both were measured by capturing emitted SQL across 24 query
   shapes. Do not "simplify" it.
3. **Ordinals are never reused.** `@@unique([datasetId, index])` is deliberately not partial, so a
   hidden row keeps its number forever and `index` is not dense. Anything deriving a position from a
   count, a `length`, or a live-filtered max collides — but only once a hidden row exists, so it
   passes every test written against a clean fixture. New rows append above a **high-water mark**.

**Eleven reads deliberately stay unfiltered**, each marked in place:
`grep -rn "MUST NOT BE TOMBSTONE-FILTERED (A1)" src/ scripts/`. Seven of them would compile fine
with a filter spread in and break a **write** at runtime with `P2002` — the slug-dedup reads, the
version high-water read, the sample-ordinal read. Spreading the filter everywhere is wrong as an
absolute, and the markers are why.

## L2 — the revision log

An append-only `SampleRevision` table, one row per mutation, carrying the sample's values **as they
stood before the change**. `Tombstone` stays the *current-state* projection every read filter
consults; `SampleRevision` is the *log* nothing filters. They cannot be one table: `Tombstone` needs
`@unique` per entity to be a to-one relation and to make `upsert` correct, and a log needs many rows
per entity.

- **`PATCH` records the before-image** — the one destructive verb L1 left untouched, because hiding
  a row and editing one are different losses and only the second destroys content. The revision and
  the update share one transaction.
- **`DELETE`, `PUT` and the config importer** each record one revision **per row actually hidden**,
  not per id requested — a retried delete must not record a deletion that did not happen. Note the
  two shapes: `DELETE` needs a filtered "which of these are still live" read before its tombstone
  write, while `PUT` and the importer do not, because their `outgoing` **is** the filtered live set.
- **`POST …/samples/[sampleId]/restore`** — the first caller of L1's `restoreSample`. Flips the
  tombstone rather than deleting it, so the record still says the row was hidden once, and the
  sample returns to its original ordinal because nothing ever reused it.
- **`GET …/samples/[sampleId]/revisions`** — owner-only, newest first, the actor projected as
  `{id, name}` only. Owner-only is a **departure from every sibling read** and is deliberate: the
  dataset detail and export routes serve a public dataset to anyone, but an edit history names who
  changed what and carries pre-edit text, which is not public data even on a public dataset.

Both new routes filter the **parent dataset** with `liveDatasetsOnly()` (a hidden dataset is closed)
but deliberately **not** the sample's own tombstone — acting on a hidden row is the point of both.

---

## Verification

Every load-bearing test was proven to discriminate: break the thing under test, run it, quote the
real failure, restore, confirm byte-identical by `sha256sum -c`.

Because none of this stack is on `main`, the three stages were also verified **individually and in
order** — A0 alone, then A0+L1, then A0+L1+L2 — each on its own tree with its own migration set,
using the packaged `npm run test:db` so `prisma migrate reset --force` replays exactly that stage's
migrations.

| Stage | migrations | unit | db | integration |
|---|---|---|---|---|
| **A0** (`8d65198`) | 15, through `v2e` | 476 / 34 files | 444 / 35 files | 80 / 10 files |
| **A0+L1** (`1dcd73c`) | 16, through `v2f` | 493 / 35 | 522 / 37 | 80 / 10 |
| **A0+L1+L2** (`53f33e2`) | 17, through `v2g` | 499 / 36 | 552 / 38 | 80 / 10 |
| **+ R3** (`cb88692`) | 17 | 499 / 36 | 553 / 38 | 80 / 10 |
| **+ R1** (`96b7c12`) | 17 | 508 / 37 | 555 / 39 | 80 / 10 |

`tsc --noEmit` and `npm run lint` exit 0 at every stage, and no stage regresses the one before it.

Incidentally this confirms a comment rather than a claim: the prose inside `vitest.db.config.ts`
records "444 tests, 35 files", which is exactly A0's figure — the comment is not wrong, it is pinned
to A0 and was never updated as L1 and L2 landed on top.

## Things a reviewer should know

- **`Dataset.sampleCount` is a LIVE row count**, not a row count, and every verb that hides or
  appends rewrites it. L2 found and fixed the one that did not: a restore raised the live count and
  left the stored value one short, permanently. The UI ladder reads the stored value first, so a
  stale one shadows the live count beneath it.
- **`GET /api/config/export` performs writes** (a slug backfill). Untouched here; recorded so it is
  not discovered.
- **There is no `restoreDataset`.** A hidden *sample* can be restored through the API; a hidden
  *dataset* cannot, and `DELETE /api/datasets/[id]` stays one-way. Deliberate — un-deleting a
  dataset belongs with publish/unpublish in Plan B — but it is now a visible product asymmetry.
- **Two residuals were closed on top of L2**, and both are worth a look because of what they
  corrected rather than what they fixed:
  - **R1** — `POST …/samples` now retries an ordinal collision (`appendWithRetry`) instead of
    reporting a bare 500. `nextSampleIndex` is still deliberately unserialised; the *caller*
    retries, because a `FOR UPDATE` lock was measured to deadlock the existing concurrency test
    against its own gate. **The handoff's instruction about this was wrong** — it said the test
    pinning the collision would fail once the retry landed. It does not: that test calls the
    function directly, so it describes the function, not the route. The test stayed; its comment
    was corrected. `PUT` and the importer replace share the exposure and are **not** wrapped.
  - **R3** — the importer's dataset CREATE branch is one transaction. It was the last hide-then-write
    pair in the tree that was not, and unwrapped it left a dataset row advertising N samples with
    zero rows behind it.
- **Still open**, tracked in `docs/superpowers/plans/2026-08-16-l1-complete-l2-handoff.md` §5: an
  inert `_count` with no automated guard (R4 — the fix is to delete the select, not guard it), and a
  terminal pin-guard 409 with no purge path (R5 — accepted).

## Docs in this PR

`docs/superpowers/` carries the specs and plans this work was built from, including the corrections
made to each plan before it was executed — the L2 plan alone had eleven defects that would have
regressed L1 if applied verbatim, and they are recorded rather than silently fixed.
