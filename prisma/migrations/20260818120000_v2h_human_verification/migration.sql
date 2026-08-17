-- v2h — human verification (Roadmap A, phase A1)
--
-- Gives GoldenLabel its first writer's schema: an item-level revision log so
-- "the prompt as the annotator saw it" survives a later edit, explicit
-- assignment rows so inter-annotator OVERLAP is designed rather than
-- accidental, and the columns test-retest and preference labelling need.
--
-- THREE HAND EDITS. This migration takes CONTRIBUTING's "Known migrate-diff
-- pseudo-drift" table from five rows to EIGHT. Every one is invisible to
-- `migrate diff` / `db pull` / `db push` — verified here, not assumed: the
-- generated diff for this schema change emitted NO statement for any of the
-- three, including no DROP for the index edit 2 replaces.
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
--
-- THE CHECK IS ADDED AFTER THE COLUMN CHANGES AND THERE ARE NO ROWS YET.
-- `overallScore` was NOT NULL before this migration, so every pre-existing row
-- would satisfy num_nonnulls(...) = 1 anyway; and GoldenLabel is empty on every
-- instance regardless, because nothing has ever written one (verified on local
-- before authoring: SELECT count(*) = 0). No backfill is needed.
--
-- Each of the three is pinned by raw SQL in
-- tests/db/golden-label-constraints.test.ts — the typed client cannot construct
-- a violating row, the same reason tests/db/tombstone-check-constraint.test.ts
-- exists. That file is the only thing in this repo that notices if one goes
-- missing.

-- AlterTable
ALTER TABLE "GoldenLabel" ADD COLUMN     "goldenItemRevisionId" TEXT,
ADD COLUMN     "preference" TEXT,
ADD COLUMN     "round" INTEGER NOT NULL DEFAULT 1,
ALTER COLUMN "overallScore" DROP NOT NULL;

-- AlterTable
ALTER TABLE "GoldenSet" ADD COLUMN     "retestIntervalItems" INTEGER NOT NULL DEFAULT 20;

-- CreateTable
CREATE TABLE "GoldenItemRevision" (
    "id" TEXT NOT NULL,
    "goldenItemId" TEXT NOT NULL,
    "inputText" TEXT NOT NULL,
    "promptText" TEXT,
    "responseText" TEXT,
    "expected" TEXT,
    "actorId" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GoldenItemRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoldenAssignment" (
    "id" TEXT NOT NULL,
    "goldenSetId" TEXT NOT NULL,
    "annotatorId" TEXT,
    "goldenItemId" TEXT,
    "round" INTEGER NOT NULL DEFAULT 1,
    "assignedById" TEXT,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,

    CONSTRAINT "GoldenAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GoldenItemRevision_goldenItemId_at_idx" ON "GoldenItemRevision"("goldenItemId", "at");

-- CreateIndex
CREATE INDEX "GoldenAssignment_goldenSetId_annotatorId_idx" ON "GoldenAssignment"("goldenSetId", "annotatorId");

-- CreateIndex
CREATE INDEX "GoldenAssignment_annotatorId_revokedAt_idx" ON "GoldenAssignment"("annotatorId", "revokedAt");

-- AddForeignKey
ALTER TABLE "GoldenLabel" ADD CONSTRAINT "GoldenLabel_goldenItemRevisionId_fkey" FOREIGN KEY ("goldenItemRevisionId") REFERENCES "GoldenItemRevision"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoldenItemRevision" ADD CONSTRAINT "GoldenItemRevision_goldenItemId_fkey" FOREIGN KEY ("goldenItemId") REFERENCES "GoldenItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoldenItemRevision" ADD CONSTRAINT "GoldenItemRevision_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoldenAssignment" ADD CONSTRAINT "GoldenAssignment_goldenSetId_fkey" FOREIGN KEY ("goldenSetId") REFERENCES "GoldenSet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoldenAssignment" ADD CONSTRAINT "GoldenAssignment_annotatorId_fkey" FOREIGN KEY ("annotatorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoldenAssignment" ADD CONSTRAINT "GoldenAssignment_goldenItemId_fkey" FOREIGN KEY ("goldenItemId") REFERENCES "GoldenItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoldenAssignment" ADD CONSTRAINT "GoldenAssignment_assignedById_fkey" FOREIGN KEY ("assignedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── HAND EDIT 1 of 3 ────────────────────────────────────────────────────────
-- Exactly one of the two verdict columns is set. A pointwise label carries a
-- score; a pairwise label carries a preference. Without this, both-null
-- orphans and both-set rows are equally acceptable to Postgres, and the
-- typed client cannot express the rule either — `overallScore` and
-- `preference` are separate optional inputs.
ALTER TABLE "GoldenLabel" ADD CONSTRAINT "GoldenLabel_score_xor_preference"
  CHECK (num_nonnulls("overallScore", "preference") = 1);

-- ── HAND EDIT 2 of 3 ────────────────────────────────────────────────────────
-- v2e's index, one column wider. `round` joins it so an annotator can hold
-- TWO live readings on one item — the whole point of test-retest — while
-- still being unable to write two labels in the SAME round. The partial
-- predicate is carried forward unchanged and is still load-bearing: without
-- it a tombstoned label would occupy its annotator's slot forever and block
-- re-annotation after a content edit.
DROP INDEX IF EXISTS "GoldenLabel_goldenItemId_annotatorId_live_key";
CREATE UNIQUE INDEX "GoldenLabel_goldenItemId_annotatorId_round_live_key"
  ON "GoldenLabel"("goldenItemId", "annotatorId", "round") WHERE "tombstonedAt" IS NULL;

-- ── HAND EDIT 3 of 3 ────────────────────────────────────────────────────────
-- One ACTIVE assignment per (item, annotator, round). DELETE on the
-- assignments route revokes rather than removing the row, so without the
-- partial predicate a revoked assignment would permanently block reassigning
-- that work to the same annotator.
CREATE UNIQUE INDEX "GoldenAssignment_item_annotator_round_active_key"
  ON "GoldenAssignment"("goldenItemId", "annotatorId", "round") WHERE "revokedAt" IS NULL;
