import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { executeJudgment, executeRespond } from '@/lib/llm';
import { refreshDatasetEvaluationSummaryForEvaluation } from '@/lib/dataset-evaluation-summary';
import { decryptSafe } from '@/lib/crypto';

const RUN_QUEUE_CONCURRENCY = Number(process.env.EVALUATION_RUN_QUEUE_CONCURRENCY ?? '4');
const MODEL_CONCURRENCY_PER_RUN = Number(process.env.EVALUATION_MODEL_CONCURRENCY_PER_RUN ?? '2');
const MODEL_REQUEST_TIMEOUT_MS = Number(process.env.EVALUATION_MODEL_TIMEOUT_MS ?? '120000');

type QueueItem =
  | { type: 'run'; runId: string }
  | { type: 'evaluation'; evaluationId: string; triggeredById: string };

const runDetailInclude = {
  rubric: {
    include: { criteria: { orderBy: { order: 'asc' as const } } },
  },
  triggeredBy: { select: { id: true, name: true, email: true } },
  runModelSelections: {
    include: {
      modelConfig: { select: { id: true, name: true, provider: true, modelId: true } },
    },
    orderBy: { createdAt: 'asc' as const },
  },
  modelJudgments: {
    include: {
      modelConfig: { select: { id: true, name: true, provider: true, modelId: true } },
    },
    orderBy: { createdAt: 'asc' as const },
  },
  humanJudgment: true,
  evaluation: {
    select: {
      id: true,
      title: true,
      inputText: true,
      promptText: true,
      responseText: true,
      project: { select: { id: true, name: true } },
      dataset: { select: { id: true, name: true } },
      datasetSample: { select: { id: true, index: true } },
    },
  },
};

export const evaluationForRunInclude = Prisma.validator<Prisma.EvaluationInclude>()({
  rubric: { include: { criteria: { orderBy: { order: 'asc' } } } },
  modelSelections: {
    include: { modelConfig: true },
    orderBy: { createdAt: 'asc' },
  },
});

export type RunDetailInclude = typeof runDetailInclude;
export const runDetailIncludeConfig = runDetailInclude;

class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const queue: QueueItem[] = [];
let activeWorkers = 0;

function chunkArray<T>(items: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize));
  }
  return chunks;
}

async function withTimeout<T>(operation: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | null = null;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`Model request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([operation(), timeoutPromise]);
    return result as T;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

async function processRun(runId: string) {
  const run = await prisma.evaluationRun.findUnique({
    where: { id: runId },
    include: {
      rubric: { include: { criteria: { orderBy: { order: 'asc' } } } },
      evaluation: {
        select: {
          id: true,
          inputText: true,
          promptText: true,
          responseText: true,
        },
      },
      modelJudgments: true,
      runModelSelections: {
        include: { modelConfig: true },
      },
    },
  });

  if (!run) return;
  const isJudgeMode = Boolean(run.evaluation.responseText?.trim());

  if (isJudgeMode && !run.rubric) {
    await prisma.evaluationRun.update({
      where: { id: run.id },
      data: { status: 'error' },
    });
    return;
  }

  await prisma.evaluationRun.update({
    where: { id: run.id },
    data: { status: 'judging' },
  });

  try {
    const judgmentsByModelId = new Map(
      run.modelJudgments.map((judgment) => [judgment.modelConfigId, judgment.id])
    );

    let completedCount = 0;
    let errorCount = 0;

    const modelChunks = chunkArray(run.runModelSelections, Math.max(1, MODEL_CONCURRENCY_PER_RUN));

    for (const modelChunk of modelChunks) {
      await Promise.all(
        modelChunk.map(async (selection) => {
          const model = selection.modelConfig;
          const judgmentId = judgmentsByModelId.get(model.id);
          if (!judgmentId) {
            errorCount += 1;
            return;
          }

          try {
            await prisma.modelJudgment.update({
              where: { id: judgmentId },
              data: {
                status: 'running',
                error: null,
              },
            });

            if (isJudgeMode) {
              const result = await withTimeout(
                () =>
                  executeJudgment(
                    model.provider,
                    {
                      inputText: run.evaluation.inputText,
                      promptText: run.evaluation.promptText ?? undefined,
                      responseText: run.evaluation.responseText ?? undefined,
                      rubricCriteria: run.rubric!.criteria,
                      rubricName: run.rubric!.name,
                      rubricDescription: run.rubric!.description || undefined,
                    },
                    {
                      modelId: model.modelId,
                      apiKey: model.apiKey ? decryptSafe(model.apiKey) : undefined,
                      endpoint: model.endpoint || undefined,
                    }
                  ),
                MODEL_REQUEST_TIMEOUT_MS
              );

              await prisma.modelJudgment.update({
                where: { id: judgmentId },
                data: {
                  overallScore: result.overallScore,
                  reasoning: result.reasoning,
                  rawResponse: result.rawResponse,
                  criteriaScores: JSON.stringify(result.criteriaScores),
                  latencyMs: result.latencyMs,
                  tokenCount: result.tokenCount,
                  status: 'completed',
                },
              });
            } else {
              const result = await withTimeout(
                () =>
                  executeRespond(
                    model.provider,
                    {
                      promptText:
                        run.evaluation.promptText?.trim() ||
                        run.evaluation.inputText,
                    },
                    {
                      modelId: model.modelId,
                      apiKey: model.apiKey ? decryptSafe(model.apiKey) : undefined,
                      endpoint: model.endpoint || undefined,
                    }
                  ),
                MODEL_REQUEST_TIMEOUT_MS
              );

              await prisma.modelJudgment.update({
                where: { id: judgmentId },
                data: {
                  overallScore: null,
                  reasoning: result.responseText,
                  rawResponse: result.rawResponse,
                  criteriaScores: null,
                  latencyMs: result.latencyMs,
                  tokenCount: result.tokenCount,
                  status: 'completed',
                },
              });
            }

            completedCount += 1;
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            await prisma.modelJudgment.update({
              where: { id: judgmentId },
              data: {
                status: 'error',
                error: errorMessage,
              },
            });
            errorCount += 1;
          }
        })
      );
    }

    const finalStatus =
      completedCount === 0 && errorCount > 0
        ? 'error'
        : 'needs_human';

    await prisma.evaluationRun.update({
      where: { id: run.id },
      data: { status: finalStatus },
    });
  } catch (unexpectedError) {
    // Catch-all: ensure the run never stays stuck in 'judging' status
    console.error(`[processRun] Unexpected error for run ${runId}:`, unexpectedError);
    await prisma.evaluationRun.update({
      where: { id: run.id },
      data: { status: 'error' },
    }).catch((dbError) => {
      console.error(`[processRun] Failed to set error status for run ${runId}:`, dbError);
    });
  }

  await refreshDatasetEvaluationSummaryForEvaluation(run.evaluationId);
}

async function processQueueItem(item: QueueItem) {
  if (item.type === 'run') {
    await processRun(item.runId);
    return;
  }

  const run = await createEvaluationRun({
    evaluationId: item.evaluationId,
    triggeredById: item.triggeredById,
  });

  await processRun(run.id);
}

function pumpQueue() {
  while (activeWorkers < Math.max(1, RUN_QUEUE_CONCURRENCY) && queue.length > 0) {
    const next = queue.shift();
    if (!next) return;

    activeWorkers += 1;
    void processQueueItem(next)
      .catch((error) => {
        console.error('Failed queue item processing:', error);
      })
      .finally(() => {
        activeWorkers -= 1;
        pumpQueue();
      });
  }
}

export function enqueueRunProcessing(runId: string) {
  queue.push({ type: 'run', runId });
  pumpQueue();
}

export function enqueueEvaluationRunCreation(evaluationId: string, triggeredById: string) {
  queue.push({ type: 'evaluation', evaluationId, triggeredById });
  pumpQueue();
}

export function getQueueStats() {
  return {
    pending: queue.length,
    activeWorkers,
    concurrency: Math.max(1, RUN_QUEUE_CONCURRENCY),
  };
}

export async function createEvaluationRun(params: {
  evaluationId: string;
  triggeredById: string;
  rubricId?: string;
  modelConfigIds?: string[];
}) {
  const evaluation = await prisma.evaluation.findUnique({
    where: { id: params.evaluationId },
    include: evaluationForRunInclude,
  });

  if (!evaluation) throw new HttpError(404, 'Evaluation not found');

  const isJudgeMode = Boolean(evaluation.responseText?.trim());

  const rubricId = params.rubricId ?? evaluation.rubricId ?? null;
  if (isJudgeMode && !rubricId) {
    throw new HttpError(
      400,
      'No rubric assigned. Assign a rubric to the evaluation template or pass rubricId.'
    );
  }

  let rubric: { id: string } | null = null;
  if (rubricId) {
    rubric = await prisma.rubric.findUnique({
      where: { id: rubricId },
      select: { id: true },
    });
    if (!rubric) throw new HttpError(404, 'Rubric not found');
  }

  const selectedModelIds = params.modelConfigIds?.length
    ? [...new Set(params.modelConfigIds)]
    : evaluation.modelSelections.map((selection) => selection.modelConfigId);

  if (selectedModelIds.length === 0) {
    throw new HttpError(
      400,
      'No models selected. Add models to the evaluation template or pass modelConfigIds.'
    );
  }

  const modelRecords = await prisma.modelConfig.findMany({
    where: { id: { in: selectedModelIds }, isVerified: true, isActive: true },
  });

  if (modelRecords.length !== new Set(selectedModelIds).size) {
    throw new HttpError(
      400,
      'One or more selected models are missing, inactive, or not verified.'
    );
  }

  return prisma.evaluationRun.create({
    data: {
      evaluationId: params.evaluationId,
      rubricId: rubric?.id ?? null,
      status: 'pending',
      triggeredById: params.triggeredById,
      runModelSelections: {
        create: selectedModelIds.map((modelConfigId) => ({ modelConfigId })),
      },
      modelJudgments: {
        create: modelRecords.map((model) => ({
          modelConfigId: model.id,
          status: 'pending',
        })),
      },
    },
    include: runDetailInclude,
  });
}

export function toHttpError(error: unknown): { status: number; message: string } | null {
  if (error instanceof HttpError) {
    return { status: error.status, message: error.message };
  }
  return null;
}
