-- v2e: golden items and golden labels are TOMBSTONED, never deleted.
-- Phase A0, follow-up to 20260812190000_v2d_golden_substrate. Implements the
-- product-owner ruling of 2026-08-13: "delete is always a same-transaction
-- tombstone tag; no actual data removal, anywhere" — hard deletion may lose
-- data, and there are no existing users, so nothing is urgent enough to
-- justify destruction. GoldenSet already worked this way (tombstonedAt, added
-- by v2d); this extends it down the tree.
--
-- Body below generated verbatim by:
--   npx prisma migrate diff \
--     --from-url "$DATABASE_URL" \
--     --to-schema-datamodel prisma/schema.prisma --script
-- ...with ONE hand edit, marked HAND-EDITED at its own block below. The DROP
-- INDEX on GoldenLabel_goldenItemId_annotatorId_key IS generated, because
-- `@@unique([goldenItemId, annotatorId])` is removed from schema.prisma in
-- this same commit; the partial index that REPLACES it is the hand edit,
-- because Prisma's DSL cannot express a WHERE predicate at all.
--
-- ── Both columns nullable, no default, no backfill ─────────────────────────
-- NULL means "live", which is what every existing row already is. There is
-- deliberately no `DEFAULT now()` and no UPDATE: a default would tombstone
-- every row in the table.
--
-- ── Why GoldenItem's @@unique([goldenSetId, index]) is UNCHANGED ───────────
-- A tombstoned item keeps its ordinal, so no gap ever opens and the
-- survivors must NOT be re-packed. The re-index loop in
-- src/app/api/golden-sets/[id]/items/route.ts is deleted in this commit: run
-- on top of a tombstone it would renumber the first survivor to 0 and
-- collide with the tombstoned row still holding 0 (P2002), aborting every
-- DELETE. Consequence, accepted: `index` stops being dense, and the next
-- index for a set is max(index) over ALL rows + 1 — a high-water mark, never
-- a count. See nextGoldenItemIndex in src/lib/golden-sets.ts.
--
-- ── Why GoldenLabel's unique CANNOT stay whole-table ───────────────────────
-- PATCH /api/golden-sets/[id]/items tombstones the labels of an item whose
-- content changed. Under the whole-table unique, that tombstoned row would
-- occupy (goldenItemId, annotatorId) forever, and the annotator could never
-- score that item again — re-annotation after an edit is the core A1
-- workflow, so this is not an edge case.
--
-- ── Why NOT @@unique([goldenItemId, annotatorId, tombstonedAt]) ────────────
-- That spelling is expressible in the DSL and would need only the
-- NULLS NOT DISTINCT hand edit this repo already uses twice
-- (20260728215410_v2b_idempotency_tighten, 20260812190000_v2d_golden_substrate).
-- REJECTED: NULLS NOT DISTINCT treats EVERY null in the index as equal,
-- including annotatorId's. annotatorId is nullable via `onDelete: SetNull`,
-- so two deleted annotators who had both labelled the same item would
-- collapse onto (item, NULL, NULL) and the second user.delete() would P2002
-- inside src/lib/account-deletion.ts. The partial index below keeps the
-- DEFAULT nulls-distinct behaviour, so anonymised labels coexist freely —
-- pinned by 'the partial index keeps the DEFAULT nulls-distinct behaviour'
-- in tests/db/meta-eval.test.ts.
--
-- ── What the partial index costs ───────────────────────────────────────────
-- schema.prisma can no longer declare this constraint, so the Prisma client
-- loses the `goldenItemId_annotatorId` compound where-input. Verified before
-- landing that NOTHING uses it: `grep -rn goldenItemId_annotatorId src/ tests/
-- scripts/ prisma/` returns only 20260725012218_v2_meta_eval's CREATE. P2002
-- raised by this index reports meta.target as the index NAME string, not a
-- field array — tests/db/meta-eval.test.ts is updated accordingly, matching
-- what tests/db/email-partial-unique.test.ts already does for
-- User_email_credentials_key. A fourth row is added to CONTRIBUTING.md's
-- "Known migrate-diff pseudo-drift" table in this same commit.

-- DropIndex
DROP INDEX "GoldenLabel_goldenItemId_annotatorId_key";

-- AlterTable
ALTER TABLE "GoldenItem" ADD COLUMN     "tombstonedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "GoldenLabel" ADD COLUMN     "tombstonedAt" TIMESTAMP(3),
ADD COLUMN     "tombstonedReason" TEXT;

-- CreateIndex
CREATE INDEX "GoldenItem_goldenSetId_tombstonedAt_idx" ON "GoldenItem"("goldenSetId", "tombstonedAt");

-- CreateIndex
CREATE INDEX "GoldenLabel_goldenItemId_idx" ON "GoldenLabel"("goldenItemId");

-- CreateIndex — HAND-EDITED: PARTIAL unique index, no generated counterpart
-- Same category as 20260729180000_v2b_email_partial_unique's
-- User_email_credentials_key: a unique index Prisma's schema engine cannot
-- see at all, so `schema.prisma` declares nothing and `migrate diff` reports
-- an empty migration. "One LIVE label per (item, annotator)"; any number of
-- tombstoned ones.
CREATE UNIQUE INDEX "GoldenLabel_goldenItemId_annotatorId_live_key"
  ON "GoldenLabel"("goldenItemId", "annotatorId") WHERE "tombstonedAt" IS NULL;
