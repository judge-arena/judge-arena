-- v2b: EvaluationModelSelection/RunModelSelection gain judgeModelVersionId;
-- ModelEndpoint gains verificationError; HumanJudgment gains
-- selectedBestJudgeModelVersionId (1b Task 12 — runtime switches to
-- JudgeModel/Version/Endpoint identity, ModelConfig write path retired).
--
-- Generated verbatim by:
--   npx prisma migrate diff --from-url "$DATABASE_URL" \
--     --to-schema-datamodel prisma/schema.prisma --script
-- No hand-editing was needed this time (unlike 20260728215410's NULLS NOT
-- DISTINCT case) — every change here is expressible in schema.prisma's DSL.
--
-- ── What changes, and why old rows are untouched ────────────────────────────
-- `modelConfigId` on both selection tables goes from NOT NULL to nullable —
-- the write path (POST/PATCH /api/evaluations, src/lib/run-launch.ts) stops
-- populating it for NEW rows going forward; existing rows keep whatever
-- value they already have. `judgeModelVersionId` is the new selection
-- identity: nullable so old (pre-this-migration) rows — which have no way
-- to backfill a version id without re-deriving one from a since-possibly-
-- changed ModelConfig — simply leave it NULL rather than requiring a lossy
-- backfill pass. No data migration/backfill UPDATE is included here
-- (deliberate — see src/lib/run-launch.ts's module doc and the Task 12
-- report for the accepted "old evaluation templates lose their default
-- model list until re-selected" limitation this implies).
--
-- Both `@@unique([evaluationId/runId, modelConfigId])` (existing) and the
-- new `@@unique([evaluationId/runId, judgeModelVersionId])` use Postgres's
-- default NULLS DISTINCT semantics (unlike the idempotency-tighten
-- migration's ModelJudgment index, nothing here needs NULLS NOT DISTINCT):
-- old rows have judgeModelVersionId NULL and a real modelConfigId (guarded
-- by the pre-existing modelConfigId unique index); new rows have
-- judgeModelVersionId set and modelConfigId NULL (guarded by the new
-- judgeModelVersionId unique index). The two populations never collide on
-- either index, so plain NULLS DISTINCT is exactly the semantics wanted —
-- multiple legacy NULL-judgeModelVersionId rows for the same evaluation
-- must NOT be treated as duplicates of each other.
ALTER TABLE "EvaluationModelSelection" ADD COLUMN     "judgeModelVersionId" TEXT,
ALTER COLUMN "modelConfigId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "HumanJudgment" ADD COLUMN     "selectedBestJudgeModelVersionId" TEXT;

-- AlterTable
ALTER TABLE "ModelEndpoint" ADD COLUMN     "verificationError" TEXT;

-- AlterTable
ALTER TABLE "RunModelSelection" ADD COLUMN     "judgeModelVersionId" TEXT,
ALTER COLUMN "modelConfigId" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "EvaluationModelSelection_judgeModelVersionId_idx" ON "EvaluationModelSelection"("judgeModelVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "EvaluationModelSelection_evaluationId_judgeModelVersionId_key" ON "EvaluationModelSelection"("evaluationId", "judgeModelVersionId");

-- CreateIndex
CREATE INDEX "HumanJudgment_selectedBestJudgeModelVersionId_idx" ON "HumanJudgment"("selectedBestJudgeModelVersionId");

-- CreateIndex
CREATE INDEX "RunModelSelection_judgeModelVersionId_idx" ON "RunModelSelection"("judgeModelVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "RunModelSelection_runId_judgeModelVersionId_key" ON "RunModelSelection"("runId", "judgeModelVersionId");

-- AddForeignKey
ALTER TABLE "EvaluationModelSelection" ADD CONSTRAINT "EvaluationModelSelection_judgeModelVersionId_fkey" FOREIGN KEY ("judgeModelVersionId") REFERENCES "JudgeModelVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunModelSelection" ADD CONSTRAINT "RunModelSelection_judgeModelVersionId_fkey" FOREIGN KEY ("judgeModelVersionId") REFERENCES "JudgeModelVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HumanJudgment" ADD CONSTRAINT "HumanJudgment_selectedBestJudgeModelVersionId_fkey" FOREIGN KEY ("selectedBestJudgeModelVersionId") REFERENCES "JudgeModelVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
