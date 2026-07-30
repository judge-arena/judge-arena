-- v2b: Dataset.visibility String -> Visibility enum, Dataset + GoldenSet
-- publishedAt, GoldenSet retiredAt (soft-delete), Dataset (parentId,
-- version) uniqueness.
--
-- Closes 1a-flags M1 (publishedAt missing on Dataset/GoldenSet), M2
-- (Dataset.visibility is String not Visibility enum), M5 (dataset-version
-- creation race unguarded — the (parentId, version) unique constraint is
-- what turns a lost-update race into a P2002 the new
-- src/lib/dataset-versions.ts retries against, same shape as Rubric's
-- equivalent constraint from Task 2), and 1b-prereq (a)'s GoldenSet
-- retire-before-hard-delete path (src/lib/account-deletion.ts).
--
-- Guard-check (per this task's brief, before authoring the enum cast
-- below): `SELECT DISTINCT visibility FROM "Dataset";` was run against the
-- dev DB and returned zero rows (the table was empty at author time). The
-- app only ever wrote the literals 'private'/'public' to this String
-- column, both of which are valid `Visibility` enum members, so the
-- `USING visibility::"Visibility"` cast is lossless for any populated DB.
-- (The dev DB was reset to the pre-Task-15 migration baseline immediately
-- before this file was authored — see task-15-report.md — so by the time
-- this migration itself runs the table is empty; the guard-check is
-- recorded here per the brief's instruction, not because it changed the
-- SQL that follows.)
--
-- Hand-edited (same pattern as 20260725004838_v2_judgment_run_provenance's
-- EvaluationRun.status / ModelJudgment.status conversions): TYPE ... USING
-- cast instead of `prisma migrate diff`'s proposed DROP COLUMN/ADD COLUMN
-- swap, so any populated "visibility" values convert in place rather than
-- being lost, and the column's existing index ("Dataset_visibility_idx",
-- from v1_baseline) survives untouched instead of needing to be dropped
-- and recreated (Postgres rebuilds it against the new type automatically —
-- no separate CREATE INDEX statement needed here, unlike migrate-diff's
-- raw output). The DEFAULT clause can't be cast automatically (text
-- default -> enum column), so it's dropped and re-applied around the cast.
ALTER TABLE "Dataset" ALTER COLUMN "visibility" DROP DEFAULT;
ALTER TABLE "Dataset" ALTER COLUMN "visibility" TYPE "Visibility" USING "visibility"::"Visibility";
ALTER TABLE "Dataset" ALTER COLUMN "visibility" SET DEFAULT 'private';

-- AlterTable
ALTER TABLE "Dataset" ADD COLUMN "publishedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "GoldenSet" ADD COLUMN "publishedAt" TIMESTAMP(3),
ADD COLUMN "retiredAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "Dataset_parentId_version_key" ON "Dataset"("parentId", "version");
