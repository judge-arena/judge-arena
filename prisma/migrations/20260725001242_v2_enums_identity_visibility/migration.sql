-- CreateEnum
CREATE TYPE "JudgeClass" AS ENUM ('prompted_api', 'prompted_open_weight', 'finetuned_judge_lm', 'sequence_classifier_rm', 'generative_rm', 'specialized_safety', 'specialized_factuality');

-- CreateEnum
CREATE TYPE "ScoringMechanism" AS ENUM ('reward_head_scalar', 'token_probability', 'critique_generative');

-- CreateEnum
CREATE TYPE "ServingBackend" AS ENUM ('anthropic', 'openai', 'openrouter', 'vllm', 'ollama');

-- CreateEnum
CREATE TYPE "Quantization" AS ENUM ('none', 'fp8', 'int8', 'int4');

-- CreateEnum
CREATE TYPE "ReasoningMode" AS ENUM ('none', 'optional', 'always');

-- CreateEnum
CREATE TYPE "TrustState" AS ENUM ('untrusted', 'calibrating', 'trusted', 'rejected');

-- CreateEnum
CREATE TYPE "RunProtocol" AS ENUM ('pointwise', 'pairwise', 'listwise');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('pending', 'judging', 'needs_human', 'completed', 'error');

-- CreateEnum
CREATE TYPE "JudgmentStatus" AS ENUM ('pending', 'running', 'completed', 'error');

-- CreateEnum
CREATE TYPE "Visibility" AS ENUM ('private', 'public');

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "publishedAt" TIMESTAMP(3),
ADD COLUMN     "visibility" "Visibility" NOT NULL DEFAULT 'private';

-- AlterTable
ALTER TABLE "Rubric" ADD COLUMN     "publishedAt" TIMESTAMP(3),
ADD COLUMN     "retiredAt" TIMESTAMP(3),
ADD COLUMN     "visibility" "Visibility" NOT NULL DEFAULT 'private';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "oidcIssuer" TEXT,
ADD COLUMN     "oidcSubject" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Rubric_parentId_version_key" ON "Rubric"("parentId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "User_oidcIssuer_oidcSubject_key" ON "User"("oidcIssuer", "oidcSubject");
