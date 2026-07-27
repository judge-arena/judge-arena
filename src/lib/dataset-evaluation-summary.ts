import { prisma } from '@/lib/db';
import { publishEvent, userTopic } from '@/lib/realtime/events';

export interface DatasetEvaluationSummary {
  updatedAt: string;
  sampleCount: number;
  samplesWithModelScores: number;
  samplesWithHumanScores: number;
  averageModelScore: number | null;
  averageHumanScore: number | null;
}

function parseMetadata(metadata: string | null): Record<string, unknown> {
  if (!metadata) return {};
  try {
    const parsed = JSON.parse(metadata);
    if (parsed && typeof parsed === 'object') {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore malformed metadata and rebuild with fresh summary
  }
  return {};
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export async function refreshDatasetEvaluationSummary(datasetId: string): Promise<void> {
  const dataset = await prisma.dataset.findUnique({
    where: { id: datasetId },
    include: {
      evaluations: {
        include: {
          runs: {
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: 1,
            include: {
              modelJudgments: {
                select: {
                  status: true,
                  overallScore: true,
                },
              },
              humanJudgment: {
                select: {
                  overallScore: true,
                },
              },
            },
          },
        },
      },
    },
  });

  if (!dataset) return;

  const modelAveragesBySample: number[] = [];
  const humanScoresBySample: number[] = [];

  dataset.evaluations.forEach((evaluation) => {
    const latestRun = evaluation.runs[0];
    if (!latestRun) return;

    const modelScores = (latestRun.modelJudgments ?? [])
      .filter((judgment) => judgment.status === 'completed' && judgment.overallScore !== null)
      .map((judgment) => judgment.overallScore as number);

    const modelAverage = average(modelScores);
    if (modelAverage !== null) {
      modelAveragesBySample.push(modelAverage);
    }

    // Mode is derived from the evaluation itself (already joined in via the
    // query above), matching the server derivation in
    // src/app/api/evaluations/[id]/runs/[runId]/human-judgment/route.ts:
    // `responseText?.trim() ? 'judge' : 'respond'`. Respond mode has no
    // scoring concept — its HumanJudgment.overallScore is always the 0
    // placeholder (see resolveHumanJudgmentScore in src/lib/utils.ts) and
    // must be excluded here so it doesn't drag averageHumanScore toward 0.
    // (selectedBestModelId — respond mode's actual signal — lives on the
    // same row; this only affects the score average, not any best-model
    // count, since no such aggregation exists in this module.)
    const isJudgeMode = Boolean(evaluation.responseText?.trim());
    if (
      isJudgeMode &&
      latestRun.humanJudgment?.overallScore !== null &&
      latestRun.humanJudgment?.overallScore !== undefined
    ) {
      humanScoresBySample.push(latestRun.humanJudgment.overallScore);
    }
  });

  const summary: DatasetEvaluationSummary = {
    updatedAt: new Date().toISOString(),
    sampleCount: dataset.evaluations.length,
    samplesWithModelScores: modelAveragesBySample.length,
    samplesWithHumanScores: humanScoresBySample.length,
    averageModelScore: average(modelAveragesBySample),
    averageHumanScore: average(humanScoresBySample),
  };

  const metadata = parseMetadata(dataset.remoteMetadata);

  await prisma.dataset.update({
    where: { id: datasetId },
    data: {
      remoteMetadata: JSON.stringify({
        ...metadata,
        evaluationSummary: summary,
      }),
    },
  });

  // Route to the dataset owner's topic — dataset.summary.updated is only
  // meaningful (and only visible) to whoever owns the dataset. `dataset`
  // above was fetched without a `select`, so `userId` is present.
  await publishEvent(userTopic(dataset.userId), {
    type: 'dataset.summary.updated',
    payload: { datasetId, summary },
  });
}

export async function refreshDatasetEvaluationSummaryForEvaluation(
  evaluationId: string
): Promise<void> {
  const evaluation = await prisma.evaluation.findUnique({
    where: { id: evaluationId },
    select: { datasetId: true },
  });

  if (!evaluation?.datasetId) return;
  await refreshDatasetEvaluationSummary(evaluation.datasetId);
}
