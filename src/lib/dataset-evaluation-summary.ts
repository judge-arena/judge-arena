import { prisma } from '@/lib/db';
import { publishRealtimeEvent } from '@/lib/realtime/events';

interface DatasetEvaluationSummary {
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
            orderBy: { createdAt: 'desc' },
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

    if (latestRun.humanJudgment?.overallScore !== null && latestRun.humanJudgment?.overallScore !== undefined) {
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

  await publishRealtimeEvent('dataset.summary.updated', {
    datasetId,
    summary,
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
