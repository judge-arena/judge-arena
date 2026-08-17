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
