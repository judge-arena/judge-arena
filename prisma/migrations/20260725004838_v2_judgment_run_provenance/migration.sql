-- DropForeignKey
ALTER TABLE "EvaluationRun" DROP CONSTRAINT "EvaluationRun_rubricId_fkey";

-- DropForeignKey
ALTER TABLE "EvaluationRun" DROP CONSTRAINT "EvaluationRun_triggeredById_fkey";

-- DropForeignKey
ALTER TABLE "ModelJudgment" DROP CONSTRAINT "ModelJudgment_modelConfigId_fkey";

-- AlterTable
ALTER TABLE "EvaluationRun" ADD COLUMN     "deadlineAt" TIMESTAMP(3),
ADD COLUMN     "finalizedAt" TIMESTAMP(3),
ADD COLUMN     "protocol" "RunProtocol" NOT NULL DEFAULT 'pointwise',
ALTER COLUMN "triggeredById" DROP NOT NULL;

-- Hand-edited (spec §3.4): TYPE ... USING cast instead of migrate-diff's
-- DROP COLUMN/ADD COLUMN swap, so a populated "status" column would convert
-- in place rather than losing data. The DEFAULT clause can't be cast
-- automatically (text default -> enum column), so it's dropped and
-- re-applied around the cast.
ALTER TABLE "EvaluationRun" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "EvaluationRun" ALTER COLUMN "status" TYPE "RunStatus" USING "status"::"RunStatus";
ALTER TABLE "EvaluationRun" ALTER COLUMN "status" SET DEFAULT 'pending';

-- Hand-edited (spec §3.4): TYPE ... USING cast instead of DROP/ADD swap.
ALTER TABLE "HumanJudgment" ALTER COLUMN "criteriaScores" TYPE JSONB USING "criteriaScores"::jsonb;

-- AlterTable
ALTER TABLE "ModelJudgment" ADD COLUMN     "attemptCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "finishReason" TEXT,
ADD COLUMN     "inputTokens" INTEGER,
ADD COLUMN     "judgeModelVersionId" TEXT,
ADD COLUMN     "outputTokens" INTEGER,
ADD COLUMN     "pairOrder" TEXT,
ADD COLUMN     "parseMode" TEXT,
ADD COLUMN     "promptTemplateId" TEXT,
ADD COLUMN     "reasoningEnabled" BOOLEAN,
ADD COLUMN     "samplingParams" JSONB,
ADD COLUMN     "servedModelId" TEXT,
ADD COLUMN     "startedAt" TIMESTAMP(3),
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;

-- Hand-edited (spec §3.4): TYPE ... USING casts instead of DROP/ADD swaps.
ALTER TABLE "ModelJudgment" ALTER COLUMN "criteriaScores" TYPE JSONB USING "criteriaScores"::jsonb;
ALTER TABLE "ModelJudgment" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "ModelJudgment" ALTER COLUMN "status" TYPE "JudgmentStatus" USING "status"::"JudgmentStatus";
ALTER TABLE "ModelJudgment" ALTER COLUMN "status" SET DEFAULT 'pending';

-- DropTable
DROP TABLE "ApiKeyStore";

-- CreateTable
CREATE TABLE "RunCandidate" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "promptText" TEXT,
    "responseText" TEXT,
    "label" TEXT,

    CONSTRAINT "RunCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RunCandidate_runId_position_key" ON "RunCandidate"("runId", "position");

-- Note: no CREATE INDEX for EvaluationRun("status") here — migrate-diff's
-- DROP/ADD COLUMN swap would drop and recreate that index (it existed
-- since v1_baseline), but the hand-edited ALTER COLUMN ... TYPE ... USING
-- cast above changes the column in place, so its existing index survives
-- untouched (Postgres rebuilds it against the new type automatically).

-- CreateIndex
CREATE INDEX "ModelJudgment_judgeModelVersionId_idx" ON "ModelJudgment"("judgeModelVersionId");

-- CreateIndex
CREATE INDEX "ModelJudgment_promptTemplateId_idx" ON "ModelJudgment"("promptTemplateId");

-- CreateIndex
CREATE UNIQUE INDEX "ModelJudgment_runId_judgeModelVersionId_pairOrder_key" ON "ModelJudgment"("runId", "judgeModelVersionId", "pairOrder");

-- AddForeignKey
ALTER TABLE "EvaluationRun" ADD CONSTRAINT "EvaluationRun_rubricId_fkey" FOREIGN KEY ("rubricId") REFERENCES "Rubric"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvaluationRun" ADD CONSTRAINT "EvaluationRun_triggeredById_fkey" FOREIGN KEY ("triggeredById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunCandidate" ADD CONSTRAINT "RunCandidate_runId_fkey" FOREIGN KEY ("runId") REFERENCES "EvaluationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModelJudgment" ADD CONSTRAINT "ModelJudgment_modelConfigId_fkey" FOREIGN KEY ("modelConfigId") REFERENCES "ModelConfig"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModelJudgment" ADD CONSTRAINT "ModelJudgment_judgeModelVersionId_fkey" FOREIGN KEY ("judgeModelVersionId") REFERENCES "JudgeModelVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModelJudgment" ADD CONSTRAINT "ModelJudgment_promptTemplateId_fkey" FOREIGN KEY ("promptTemplateId") REFERENCES "PromptTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
