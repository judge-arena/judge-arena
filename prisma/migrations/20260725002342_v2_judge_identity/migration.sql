-- CreateTable
CREATE TABLE "JudgeModel" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "judgeClass" "JudgeClass" NOT NULL,
    "scoringMechanism" "ScoringMechanism" NOT NULL,
    "baseModel" TEXT,
    "paramsB" DOUBLE PRECISION,
    "contextLength" INTEGER,
    "trainingRecipe" TEXT,
    "license" TEXT,
    "licenseNote" TEXT,
    "modality" TEXT NOT NULL DEFAULT 'text',
    "taxonomyMode" TEXT,
    "streamingCapable" BOOLEAN NOT NULL DEFAULT false,
    "retiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JudgeModel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JudgeModelVersion" (
    "id" TEXT NOT NULL,
    "judgeModelId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "weightsRevision" TEXT,
    "quantization" "Quantization" NOT NULL DEFAULT 'none',
    "quantMethod" TEXT,
    "servingBackend" "ServingBackend" NOT NULL,
    "endpointClass" TEXT,
    "trainingDataVintage" TIMESTAMP(3),
    "parentVersionId" TEXT,
    "reasoningMode" "ReasoningMode" NOT NULL DEFAULT 'none',
    "samplingDefaults" JSONB,
    "protocolSupport" JSONB NOT NULL,
    "supportsRubricAnchored" BOOLEAN NOT NULL DEFAULT true,
    "trustState" "TrustState" NOT NULL DEFAULT 'untrusted',
    "retiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JudgeModelVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModelEndpoint" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "judgeModelVersionId" TEXT NOT NULL,
    "endpoint" TEXT,
    "apiKeyEnc" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "verifiedAt" TIMESTAMP(3),
    "archFingerprint" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModelEndpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromptTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "protocol" "RunProtocol" NOT NULL,
    "version" INTEGER NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromptTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "JudgeModel_slug_key" ON "JudgeModel"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "JudgeModelVersion_judgeModelId_ordinal_key" ON "JudgeModelVersion"("judgeModelId", "ordinal");

-- CreateIndex
CREATE INDEX "ModelEndpoint_userId_idx" ON "ModelEndpoint"("userId");

-- CreateIndex
CREATE INDEX "ModelEndpoint_judgeModelVersionId_idx" ON "ModelEndpoint"("judgeModelVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "PromptTemplate_name_version_key" ON "PromptTemplate"("name", "version");

-- AddForeignKey
ALTER TABLE "JudgeModelVersion" ADD CONSTRAINT "JudgeModelVersion_judgeModelId_fkey" FOREIGN KEY ("judgeModelId") REFERENCES "JudgeModel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JudgeModelVersion" ADD CONSTRAINT "JudgeModelVersion_parentVersionId_fkey" FOREIGN KEY ("parentVersionId") REFERENCES "JudgeModelVersion"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ModelEndpoint" ADD CONSTRAINT "ModelEndpoint_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModelEndpoint" ADD CONSTRAINT "ModelEndpoint_judgeModelVersionId_fkey" FOREIGN KEY ("judgeModelVersionId") REFERENCES "JudgeModelVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

