-- v2d: the golden-set substrate — a golden set becomes an annotated,
-- platform-provided Dataset (A0 step 1; design doc
-- docs/superpowers/specs/2026-08-12-a0-golden-set-substrate-design.md).
--
-- Body below generated verbatim by:
--   npx prisma migrate diff \
--     --from-url "$DATABASE_URL" \
--     --to-schema-datamodel prisma/schema.prisma --script
-- ...with ONE hand edit, marked HAND-EDITED at its own block below.
--
-- ── Why NOT NULL with no default is safe here ───────────────────────────────
-- `GoldenSet.datasetId`, `GoldenSet.protocol`, `GoldenItem.sourceDatasetSampleId`
-- and `GoldenItem.updatedAt` all land NOT NULL with NO default. That is only
-- legal on an empty table, and it is: GoldenSet, GoldenItem, GoldenLabel and
-- CalibrationRun all held ZERO rows in dev, in judge_arena_test and in
-- production (judge-arena-pg) when this was written — verified by direct
-- `SELECT count(*)`, not assumed. There is deliberately no backfill and no
-- placeholder default: a default would silently manufacture provenance for
-- rows that have none. If a future environment turns out to have rows, this
-- migration MUST fail loudly rather than invent a datasetId.
--
-- ── Two Restrict FKs, and what they deliberately break ──────────────────────
-- `GoldenSet.datasetId` and `GoldenItem.sourceDatasetSampleId` are both
-- `onDelete: Restrict`. So: a Dataset with golden sets cannot be deleted, and
-- a DatasetSample a golden item annotates cannot be deleted. This is the
-- intended behaviour — a corpus somebody has annotated must not drift under
-- the annotation — but it changes two live paths:
--
--   1. PUT /api/datasets/[id]/samples deletes every sample and recreates them,
--      minting new ids. Once a golden set exists over a dataset, that PUT must
--      fail. It is given an explicit 409 naming the pinning sets in the same
--      commit as this migration (src/app/api/datasets/[id]/samples/route.ts),
--      so the behaviour change never surfaces as a raw P2003.
--      NOT covered in A0: DELETE on the same route can still raise a bare
--      P2003 for a pinned sampleId. Recorded, not fixed here.
--   2. src/lib/account-deletion.ts hard-deletes a departing user's PRIVATE
--      datasets. A golden set may only be built over a PUBLIC platform-owned
--      dataset, and account deletion REASSIGNS public datasets to the archive
--      user rather than deleting them, so the two cannot collide today. If
--      golden sets are ever widened to user-owned datasets, that step needs a
--      pinned-by-a-golden-set check first.
--
-- prisma/seed-judgebench.ts is unaffected: it `upsert`s the dataset and
-- `createMany`s samples, and never deletes.
-- AlterTable
ALTER TABLE "CalibrationRun" ADD COLUMN     "kappaVariant" TEXT,
ADD COLUMN     "kappaWeighting" TEXT,
ADD COLUMN     "passThreshold" DOUBLE PRECISION,
ADD COLUMN     "thresholdMetric" TEXT;

-- AlterTable
ALTER TABLE "GoldenItem" ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "sourceDatasetSampleId" TEXT NOT NULL,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;

-- AlterTable
ALTER TABLE "GoldenSet" ADD COLUMN     "datasetId" TEXT NOT NULL,
ADD COLUMN     "parentId" TEXT,
ADD COLUMN     "protocol" "RunProtocol" NOT NULL,
ADD COLUMN     "slug" TEXT,
ADD COLUMN     "tombstonedAt" TIMESTAMP(3),
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "ModelJudgment" ADD COLUMN     "verdict" TEXT;

-- CreateTable
CREATE TABLE "GoldenCandidate" (
    "id" TEXT NOT NULL,
    "goldenItemId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "promptText" TEXT,
    "responseText" TEXT,
    "label" TEXT,

    CONSTRAINT "GoldenCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GoldenCandidate_goldenItemId_position_key" ON "GoldenCandidate"("goldenItemId", "position");

-- CreateIndex
CREATE INDEX "GoldenItem_sourceDatasetSampleId_idx" ON "GoldenItem"("sourceDatasetSampleId");

-- CreateIndex
CREATE INDEX "GoldenSet_parentId_idx" ON "GoldenSet"("parentId");

-- CreateIndex
CREATE INDEX "GoldenSet_visibility_idx" ON "GoldenSet"("visibility");

-- CreateIndex
CREATE INDEX "GoldenSet_datasetId_idx" ON "GoldenSet"("datasetId");

-- CreateIndex
CREATE UNIQUE INDEX "GoldenSet_parentId_version_key" ON "GoldenSet"("parentId", "version");

-- CreateIndex — HAND-EDITED: NULLS NOT DISTINCT
-- Prisma cannot express NULLS NOT DISTINCT (PG15+) in the schema DSL, so
-- `@@unique([ownerId, slug])` in prisma/schema.prisma is left UNCHANGED and
-- the generated `CREATE UNIQUE INDEX ... ("ownerId", "slug");` line is
-- replaced by the statement below. Same trick, same reason, as
-- 20260728215410_v2b_idempotency_tighten's ModelJudgment index — see that
-- file's block and CONTRIBUTING.md's "Known migrate-diff pseudo-drift".
--
-- Every OTHER slug constraint in this schema keys on a non-null userId.
-- GoldenSet.ownerId is nullable — `onDelete: SetNull`, so a set survives its
-- owner's deletion — and under Postgres's default NULLS DISTINCT two
-- ownerless sets could hold the SAME slug, which breaks (owner, slug)
-- resolution in the config importer. NULLS NOT DISTINCT makes
-- (NULL, 'judgebench-pairwise-v1') collide with itself, as intended.
--
-- TWO CONSEQUENCES, both accepted deliberately:
--   (a) At most ONE slug-NULL GoldenSet per owner (and one globally with
--       ownerId NULL). Every A0 write path assigns a slug — generateSlug()
--       falls back to 'unnamed' and never returns empty — so this binds only
--       hand-written fixtures. tests/db/meta-eval.test.ts and
--       tests/db/account-deletion.test.ts are updated in this same commit to
--       give their golden fixtures slugs.
--   (b) If two users each own a set with the SAME slug and BOTH accounts are
--       deleted, the second user.delete()'s SetNull collides here. Rare, and
--       the alternative (a partial index `WHERE "slug" IS NOT NULL`) was
--       rejected: verified empirically against Prisma 6.19.2 that a partial
--       unique index does NOT satisfy `@@unique` — `prisma migrate diff`
--       reports REAL drift and proposes recreating the index without the
--       predicate. The plain form below reports an empty diff. Real drift is
--       strictly worse than this edge case.
CREATE UNIQUE INDEX "GoldenSet_ownerId_slug_key"
  ON "GoldenSet"("ownerId", "slug") NULLS NOT DISTINCT;

-- AddForeignKey
ALTER TABLE "GoldenSet" ADD CONSTRAINT "GoldenSet_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "Dataset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoldenSet" ADD CONSTRAINT "GoldenSet_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "GoldenSet"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "GoldenItem" ADD CONSTRAINT "GoldenItem_sourceDatasetSampleId_fkey" FOREIGN KEY ("sourceDatasetSampleId") REFERENCES "DatasetSample"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoldenCandidate" ADD CONSTRAINT "GoldenCandidate_goldenItemId_fkey" FOREIGN KEY ("goldenItemId") REFERENCES "GoldenItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

