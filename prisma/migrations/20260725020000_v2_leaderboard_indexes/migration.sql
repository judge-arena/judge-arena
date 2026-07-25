-- CreateIndex
CREATE INDEX "EvaluationRun_evaluationId_createdAt_idx" ON "EvaluationRun"("evaluationId", "createdAt");

-- CreateIndex
CREATE INDEX "ModelJudgment_modelConfigId_status_idx" ON "ModelJudgment"("modelConfigId", "status");
