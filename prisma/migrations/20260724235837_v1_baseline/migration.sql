-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "passwordHash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'user',
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "verificationToken" TEXT,
    "resetToken" TEXT,
    "resetTokenExpiry" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT,
    "description" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Rubric" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT,
    "description" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "parentId" TEXT,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Rubric_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RubricCriterion" (
    "id" TEXT NOT NULL,
    "rubricId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "maxScore" INTEGER NOT NULL DEFAULT 10,
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "RubricCriterion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModelConfig" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT,
    "provider" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "endpoint" TEXT,
    "apiKey" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "verifiedAt" TIMESTAMP(3),
    "verificationError" TEXT,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModelConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Evaluation" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "rubricId" TEXT,
    "inputText" TEXT NOT NULL,
    "promptText" TEXT,
    "responseText" TEXT,
    "title" TEXT,
    "userId" TEXT NOT NULL,
    "datasetId" TEXT,
    "datasetSampleId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Evaluation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvaluationModelSelection" (
    "id" TEXT NOT NULL,
    "evaluationId" TEXT NOT NULL,
    "modelConfigId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvaluationModelSelection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvaluationRun" (
    "id" TEXT NOT NULL,
    "evaluationId" TEXT NOT NULL,
    "rubricId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "triggeredById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EvaluationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RunModelSelection" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "modelConfigId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RunModelSelection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModelJudgment" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "modelConfigId" TEXT NOT NULL,
    "overallScore" DOUBLE PRECISION,
    "reasoning" TEXT,
    "rawResponse" TEXT,
    "criteriaScores" TEXT,
    "latencyMs" INTEGER,
    "tokenCount" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModelJudgment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HumanJudgment" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "overallScore" DOUBLE PRECISION NOT NULL,
    "reasoning" TEXT,
    "criteriaScores" TEXT,
    "selectedBestModelId" TEXT,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HumanJudgment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiKeyStore" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "apiKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApiKeyStore_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeveloperApiKey" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "scopes" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "expiresAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeveloperApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Dataset" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT,
    "description" TEXT,
    "source" TEXT NOT NULL DEFAULT 'local',
    "visibility" TEXT NOT NULL DEFAULT 'private',
    "inputType" TEXT NOT NULL DEFAULT 'query-response',
    "version" INTEGER NOT NULL DEFAULT 1,
    "parentId" TEXT,
    "sourceUrl" TEXT,
    "huggingFaceId" TEXT,
    "remoteMetadata" TEXT,
    "format" TEXT,
    "localData" TEXT,
    "filePath" TEXT,
    "sampleCount" INTEGER,
    "splits" TEXT,
    "features" TEXT,
    "tags" TEXT,
    "projectId" TEXT,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Dataset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DatasetSample" (
    "id" TEXT NOT NULL,
    "datasetId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "input" TEXT NOT NULL,
    "expected" TEXT,
    "metadata" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DatasetSample_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "resource" TEXT,
    "resourceId" TEXT,
    "metadata" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_verificationToken_key" ON "User"("verificationToken");

-- CreateIndex
CREATE UNIQUE INDEX "User_resetToken_key" ON "User"("resetToken");

-- CreateIndex
CREATE INDEX "Project_userId_idx" ON "Project"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Project_userId_slug_key" ON "Project"("userId", "slug");

-- CreateIndex
CREATE INDEX "Rubric_parentId_idx" ON "Rubric"("parentId");

-- CreateIndex
CREATE INDEX "Rubric_userId_idx" ON "Rubric"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Rubric_userId_slug_key" ON "Rubric"("userId", "slug");

-- CreateIndex
CREATE INDEX "RubricCriterion_rubricId_idx" ON "RubricCriterion"("rubricId");

-- CreateIndex
CREATE INDEX "ModelConfig_userId_idx" ON "ModelConfig"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ModelConfig_userId_slug_key" ON "ModelConfig"("userId", "slug");

-- CreateIndex
CREATE INDEX "Evaluation_projectId_idx" ON "Evaluation"("projectId");

-- CreateIndex
CREATE INDEX "Evaluation_rubricId_idx" ON "Evaluation"("rubricId");

-- CreateIndex
CREATE INDEX "Evaluation_userId_idx" ON "Evaluation"("userId");

-- CreateIndex
CREATE INDEX "Evaluation_datasetId_idx" ON "Evaluation"("datasetId");

-- CreateIndex
CREATE INDEX "Evaluation_datasetSampleId_idx" ON "Evaluation"("datasetSampleId");

-- CreateIndex
CREATE INDEX "EvaluationModelSelection_evaluationId_idx" ON "EvaluationModelSelection"("evaluationId");

-- CreateIndex
CREATE INDEX "EvaluationModelSelection_modelConfigId_idx" ON "EvaluationModelSelection"("modelConfigId");

-- CreateIndex
CREATE UNIQUE INDEX "EvaluationModelSelection_evaluationId_modelConfigId_key" ON "EvaluationModelSelection"("evaluationId", "modelConfigId");

-- CreateIndex
CREATE INDEX "EvaluationRun_evaluationId_idx" ON "EvaluationRun"("evaluationId");

-- CreateIndex
CREATE INDEX "EvaluationRun_rubricId_idx" ON "EvaluationRun"("rubricId");

-- CreateIndex
CREATE INDEX "EvaluationRun_triggeredById_idx" ON "EvaluationRun"("triggeredById");

-- CreateIndex
CREATE INDEX "EvaluationRun_status_idx" ON "EvaluationRun"("status");

-- CreateIndex
CREATE INDEX "RunModelSelection_runId_idx" ON "RunModelSelection"("runId");

-- CreateIndex
CREATE INDEX "RunModelSelection_modelConfigId_idx" ON "RunModelSelection"("modelConfigId");

-- CreateIndex
CREATE UNIQUE INDEX "RunModelSelection_runId_modelConfigId_key" ON "RunModelSelection"("runId", "modelConfigId");

-- CreateIndex
CREATE INDEX "ModelJudgment_runId_idx" ON "ModelJudgment"("runId");

-- CreateIndex
CREATE INDEX "ModelJudgment_modelConfigId_idx" ON "ModelJudgment"("modelConfigId");

-- CreateIndex
CREATE UNIQUE INDEX "HumanJudgment_runId_key" ON "HumanJudgment"("runId");

-- CreateIndex
CREATE INDEX "HumanJudgment_userId_idx" ON "HumanJudgment"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKeyStore_provider_key" ON "ApiKeyStore"("provider");

-- CreateIndex
CREATE UNIQUE INDEX "DeveloperApiKey_keyHash_key" ON "DeveloperApiKey"("keyHash");

-- CreateIndex
CREATE INDEX "DeveloperApiKey_userId_idx" ON "DeveloperApiKey"("userId");

-- CreateIndex
CREATE INDEX "DeveloperApiKey_keyHash_idx" ON "DeveloperApiKey"("keyHash");

-- CreateIndex
CREATE INDEX "DeveloperApiKey_prefix_idx" ON "DeveloperApiKey"("prefix");

-- CreateIndex
CREATE INDEX "Dataset_userId_idx" ON "Dataset"("userId");

-- CreateIndex
CREATE INDEX "Dataset_projectId_idx" ON "Dataset"("projectId");

-- CreateIndex
CREATE INDEX "Dataset_parentId_idx" ON "Dataset"("parentId");

-- CreateIndex
CREATE INDEX "Dataset_visibility_idx" ON "Dataset"("visibility");

-- CreateIndex
CREATE INDEX "Dataset_source_idx" ON "Dataset"("source");

-- CreateIndex
CREATE UNIQUE INDEX "Dataset_userId_slug_key" ON "Dataset"("userId", "slug");

-- CreateIndex
CREATE INDEX "DatasetSample_datasetId_idx" ON "DatasetSample"("datasetId");

-- CreateIndex
CREATE UNIQUE INDEX "DatasetSample_datasetId_index_key" ON "DatasetSample"("datasetId", "index");

-- CreateIndex
CREATE INDEX "AuditLog_userId_idx" ON "AuditLog"("userId");

-- CreateIndex
CREATE INDEX "AuditLog_action_idx" ON "AuditLog"("action");

-- CreateIndex
CREATE INDEX "AuditLog_resource_resourceId_idx" ON "AuditLog"("resource", "resourceId");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Rubric" ADD CONSTRAINT "Rubric_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Rubric"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Rubric" ADD CONSTRAINT "Rubric_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RubricCriterion" ADD CONSTRAINT "RubricCriterion_rubricId_fkey" FOREIGN KEY ("rubricId") REFERENCES "Rubric"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModelConfig" ADD CONSTRAINT "ModelConfig_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Evaluation" ADD CONSTRAINT "Evaluation_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Evaluation" ADD CONSTRAINT "Evaluation_rubricId_fkey" FOREIGN KEY ("rubricId") REFERENCES "Rubric"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Evaluation" ADD CONSTRAINT "Evaluation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Evaluation" ADD CONSTRAINT "Evaluation_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "Dataset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Evaluation" ADD CONSTRAINT "Evaluation_datasetSampleId_fkey" FOREIGN KEY ("datasetSampleId") REFERENCES "DatasetSample"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvaluationModelSelection" ADD CONSTRAINT "EvaluationModelSelection_evaluationId_fkey" FOREIGN KEY ("evaluationId") REFERENCES "Evaluation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvaluationModelSelection" ADD CONSTRAINT "EvaluationModelSelection_modelConfigId_fkey" FOREIGN KEY ("modelConfigId") REFERENCES "ModelConfig"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvaluationRun" ADD CONSTRAINT "EvaluationRun_evaluationId_fkey" FOREIGN KEY ("evaluationId") REFERENCES "Evaluation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvaluationRun" ADD CONSTRAINT "EvaluationRun_rubricId_fkey" FOREIGN KEY ("rubricId") REFERENCES "Rubric"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvaluationRun" ADD CONSTRAINT "EvaluationRun_triggeredById_fkey" FOREIGN KEY ("triggeredById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunModelSelection" ADD CONSTRAINT "RunModelSelection_runId_fkey" FOREIGN KEY ("runId") REFERENCES "EvaluationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunModelSelection" ADD CONSTRAINT "RunModelSelection_modelConfigId_fkey" FOREIGN KEY ("modelConfigId") REFERENCES "ModelConfig"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModelJudgment" ADD CONSTRAINT "ModelJudgment_runId_fkey" FOREIGN KEY ("runId") REFERENCES "EvaluationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModelJudgment" ADD CONSTRAINT "ModelJudgment_modelConfigId_fkey" FOREIGN KEY ("modelConfigId") REFERENCES "ModelConfig"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HumanJudgment" ADD CONSTRAINT "HumanJudgment_runId_fkey" FOREIGN KEY ("runId") REFERENCES "EvaluationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HumanJudgment" ADD CONSTRAINT "HumanJudgment_selectedBestModelId_fkey" FOREIGN KEY ("selectedBestModelId") REFERENCES "ModelConfig"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HumanJudgment" ADD CONSTRAINT "HumanJudgment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeveloperApiKey" ADD CONSTRAINT "DeveloperApiKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dataset" ADD CONSTRAINT "Dataset_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Dataset"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Dataset" ADD CONSTRAINT "Dataset_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dataset" ADD CONSTRAINT "Dataset_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DatasetSample" ADD CONSTRAINT "DatasetSample_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "Dataset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
