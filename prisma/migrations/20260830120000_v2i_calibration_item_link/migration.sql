-- v2i — the calibration item link (Roadmap A, phase A2.1)
--
-- Makes a model's verdict attributable to the golden item it was measured
-- against, and makes what the model was given and what it thought recoverable
-- afterwards. Until this, nothing paired a GoldenItem with a model verdict:
-- ModelJudgment hangs off EvaluationRun -> Evaluation, and Evaluation has a
-- datasetSampleId but no goldenItemId, so there was no path from a verdict to
-- the `expected` it should be scored against. CalibrationRun existed but was
-- only ever READ (a count, for the frozen check) and never written.
--
-- NO NEW JOIN TABLE, DELIBERATELY. An EvaluationRun is already 1:1 with a
-- golden item by construction — a pairwise run holds exactly one candidate pair
-- (RunCandidate @@unique([runId, position]), and buildPairwiseUserPrompt
-- requires exactly two) — so the link is two nullable columns, not a table.
-- A join table would also have carried a stored `preference`, which A0 decision
-- #4 forbids: which sample was preferred is DERIVED from (verdict, pairOrder)
-- at read time, and encoding it makes the BA sweep a backfill instead of an
-- insert.
--
-- ZERO HAND EDITS. CONTRIBUTING's "Known migrate-diff pseudo-drift" table stays
-- at EIGHT rows. The unique index below needs no NULLS NOT DISTINCT edit (the
-- way ModelJudgment's did) precisely because the DEFAULT `NULLS DISTINCT` is
-- what we want here: every ordinary run has both columns NULL and they must all
-- coexist, while at most one calibration run may exist per (calibration, item).
--
-- ENTIRELY ADDITIVE AND NON-DESTRUCTIVE: no DROP, no DELETE, no NOT NULL
-- without a default, no column type change. The one NOT NULL added
-- (promptTruncated) carries DEFAULT false. Production holds ModelJudgment = 0
-- and EvaluationRun = 0 at the time of writing, so there is nothing to backfill
-- and no window where migrated schema meets old rows — but the migration is
-- written to be safe even if that stops being true.

-- AlterTable
ALTER TABLE "CalibrationRun" ADD COLUMN     "rubricId" TEXT;

-- AlterTable
ALTER TABLE "EvaluationRun" ADD COLUMN     "calibrationRunId" TEXT,
ADD COLUMN     "goldenItemId" TEXT;

-- AlterTable
ALTER TABLE "ModelJudgment" ADD COLUMN     "promptTruncated" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "reasoningContent" TEXT,
ADD COLUMN     "reasoningSource" TEXT,
ADD COLUMN     "reasoningTokens" INTEGER,
ADD COLUMN     "systemPrompt" TEXT,
ADD COLUMN     "userPrompt" TEXT,
ADD COLUMN     "userPromptSha256" TEXT;

-- CreateIndex
CREATE INDEX "EvaluationRun_goldenItemId_idx" ON "EvaluationRun"("goldenItemId");

-- CreateIndex
CREATE UNIQUE INDEX "EvaluationRun_calibrationRunId_goldenItemId_key" ON "EvaluationRun"("calibrationRunId", "goldenItemId");

-- AddForeignKey
ALTER TABLE "EvaluationRun" ADD CONSTRAINT "EvaluationRun_goldenItemId_fkey" FOREIGN KEY ("goldenItemId") REFERENCES "GoldenItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvaluationRun" ADD CONSTRAINT "EvaluationRun_calibrationRunId_fkey" FOREIGN KEY ("calibrationRunId") REFERENCES "CalibrationRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalibrationRun" ADD CONSTRAINT "CalibrationRun_rubricId_fkey" FOREIGN KEY ("rubricId") REFERENCES "Rubric"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

