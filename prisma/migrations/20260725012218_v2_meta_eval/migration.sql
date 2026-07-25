-- CreateTable
CREATE TABLE "GoldenSet" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "visibility" "Visibility" NOT NULL DEFAULT 'private',
    "ownerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GoldenSet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoldenItem" (
    "id" TEXT NOT NULL,
    "goldenSetId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "inputText" TEXT NOT NULL,
    "promptText" TEXT,
    "responseText" TEXT,
    "protocol" "RunProtocol" NOT NULL DEFAULT 'pointwise',
    "expected" TEXT,

    CONSTRAINT "GoldenItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoldenLabel" (
    "id" TEXT NOT NULL,
    "goldenItemId" TEXT NOT NULL,
    "annotatorId" TEXT,
    "overallScore" DOUBLE PRECISION NOT NULL,
    "criteriaScores" JSONB,
    "reasoning" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GoldenLabel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CalibrationRun" (
    "id" TEXT NOT NULL,
    "judgeModelVersionId" TEXT NOT NULL,
    "goldenSetId" TEXT NOT NULL,
    "kappa" DOUBLE PRECISION,
    "rawAgreement" DOUBLE PRECISION,
    "testRetest" DOUBLE PRECISION,
    "positionBias" DOUBLE PRECISION,
    "biasSensitivityRate" DOUBLE PRECISION,
    "flipRateVsParent" DOUBLE PRECISION,
    "verdictCount" INTEGER NOT NULL DEFAULT 0,
    "passed" BOOLEAN,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "CalibrationRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GoldenItem_goldenSetId_index_key" ON "GoldenItem"("goldenSetId", "index");

-- CreateIndex
CREATE UNIQUE INDEX "GoldenLabel_goldenItemId_annotatorId_key" ON "GoldenLabel"("goldenItemId", "annotatorId");

-- AddForeignKey
ALTER TABLE "GoldenSet" ADD CONSTRAINT "GoldenSet_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoldenItem" ADD CONSTRAINT "GoldenItem_goldenSetId_fkey" FOREIGN KEY ("goldenSetId") REFERENCES "GoldenSet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoldenLabel" ADD CONSTRAINT "GoldenLabel_goldenItemId_fkey" FOREIGN KEY ("goldenItemId") REFERENCES "GoldenItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoldenLabel" ADD CONSTRAINT "GoldenLabel_annotatorId_fkey" FOREIGN KEY ("annotatorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalibrationRun" ADD CONSTRAINT "CalibrationRun_judgeModelVersionId_fkey" FOREIGN KEY ("judgeModelVersionId") REFERENCES "JudgeModelVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalibrationRun" ADD CONSTRAINT "CalibrationRun_goldenSetId_fkey" FOREIGN KEY ("goldenSetId") REFERENCES "GoldenSet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
