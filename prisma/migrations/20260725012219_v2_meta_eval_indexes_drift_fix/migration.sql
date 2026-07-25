-- CreateIndex
CREATE INDEX "CalibrationRun_judgeModelVersionId_idx" ON "CalibrationRun"("judgeModelVersionId");

-- CreateIndex
CREATE INDEX "CalibrationRun_goldenSetId_idx" ON "CalibrationRun"("goldenSetId");

-- CreateIndex
CREATE INDEX "GoldenLabel_annotatorId_idx" ON "GoldenLabel"("annotatorId");

-- CreateIndex
CREATE INDEX "GoldenSet_ownerId_idx" ON "GoldenSet"("ownerId");
