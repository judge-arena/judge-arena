export interface ProjectDataset {
  id: string;
  name: string;
  source?: string;
  visibility?: string;
  sampleCount?: number | null;
}

export interface ProjectEvaluation {
  id: string;
  title?: string | null;
  createdAt: string;
  datasetId?: string | null;
  datasetSample?: { id: string; index: number } | null;
  runs?: Array<{
    id: string;
    status: string;
    createdAt: string;
    modelJudgments?: Array<{ status: string; overallScore: number | null }>;
    humanJudgment?: { overallScore: number } | null;
  }>;
  _count?: { runs?: number };
  rubric?: { id: string; name: string; version?: number | null; parentId?: string | null } | null;
  inputText?: string | null;
}

export interface DatasetRunGroup {
  key: string;
  datasetId: string;
  datasetName: string;
  startedAt: string;
  endedAt: string;
  evaluations: ProjectEvaluation[];
}

const BATCH_GAP_MS = 60_000;

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function getLatestRun(evaluation: ProjectEvaluation) {
  return evaluation.runs?.[0] ?? null;
}

export function getLatestModelAverage(evaluation: ProjectEvaluation): number | null {
  const latestRun = getLatestRun(evaluation);
  if (!latestRun) return null;

  const completedScores = (latestRun.modelJudgments ?? [])
    .filter((judgment) => judgment.status === 'completed' && judgment.overallScore !== null)
    .map((judgment) => judgment.overallScore as number);

  return average(completedScores);
}

export function getLatestHumanScore(evaluation: ProjectEvaluation): number | null {
  const latestRun = getLatestRun(evaluation);
  return latestRun?.humanJudgment?.overallScore ?? null;
}

export function getEvaluationRunCount(evaluation: ProjectEvaluation): number {
  return evaluation._count?.runs ?? evaluation.runs?.length ?? 0;
}

export function buildDatasetRunGroups(
  evaluations: ProjectEvaluation[],
  datasets: ProjectDataset[]
): DatasetRunGroup[] {
  const datasetMap = new Map(datasets.map((dataset) => [dataset.id, dataset]));
  const byDataset = new Map<string, ProjectEvaluation[]>();

  evaluations
    .filter((evaluation) => !!evaluation.datasetId)
    .forEach((evaluation) => {
      const datasetId = evaluation.datasetId as string;
      const list = byDataset.get(datasetId) ?? [];
      list.push(evaluation);
      byDataset.set(datasetId, list);
    });

  const groups: DatasetRunGroup[] = [];

  byDataset.forEach((datasetEvaluations, datasetId) => {
    const sorted = [...datasetEvaluations].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );

    let currentBatch: ProjectEvaluation[] = [];
    let batchStart = 0;
    let previousTime = 0;

    const flushBatch = () => {
      if (currentBatch.length === 0) return;
      const ordered = [...currentBatch].sort(
        (a, b) => (a.datasetSample?.index ?? 0) - (b.datasetSample?.index ?? 0)
      );
      const startedAt = new Date(batchStart).toISOString();
      const endedAt = new Date(previousTime).toISOString();
      const key = `${datasetId}__${batchStart}`;
      const datasetName = datasetMap.get(datasetId)?.name ?? `Dataset ${datasetId}`;

      groups.push({
        key,
        datasetId,
        datasetName,
        startedAt,
        endedAt,
        evaluations: ordered,
      });
      currentBatch = [];
    };

    sorted.forEach((evaluation) => {
      const createdMs = new Date(evaluation.createdAt).getTime();
      if (currentBatch.length === 0) {
        currentBatch.push(evaluation);
        batchStart = createdMs;
        previousTime = createdMs;
        return;
      }

      if (createdMs - previousTime <= BATCH_GAP_MS) {
        currentBatch.push(evaluation);
        previousTime = createdMs;
      } else {
        flushBatch();
        currentBatch.push(evaluation);
        batchStart = createdMs;
        previousTime = createdMs;
      }
    });

    flushBatch();
  });

  return groups.sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
  );
}

export function summarizeDatasetRunGroup(group: DatasetRunGroup) {
  const latestStatuses = group.evaluations
    .map((evaluation) => getLatestRun(evaluation)?.status)
    .filter(Boolean) as string[];

  const statusPriority: Record<string, number> = {
    error: 5,
    judging: 4,
    needs_human: 3,
    pending: 2,
    completed: 1,
  };

  const aggregateStatus =
    latestStatuses.sort(
      (left, right) => (statusPriority[right] ?? 0) - (statusPriority[left] ?? 0)
    )[0] ?? 'pending';

  const modelAverages = group.evaluations
    .map(getLatestModelAverage)
    .filter((value): value is number => value !== null);

  const humanAverages = group.evaluations
    .map(getLatestHumanScore)
    .filter((value): value is number => value !== null);

  return {
    aggregateStatus,
    sampleCount: group.evaluations.length,
    modelAverageAcrossSamples: average(modelAverages),
    humanAverageAcrossSamples: average(humanAverages),
    samplesWithModelScores: modelAverages.length,
    samplesWithHumanScores: humanAverages.length,
  };
}
