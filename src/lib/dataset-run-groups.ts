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
  dataset?: { id: string; name: string } | null;
  datasetSample?: { id: string; index: number } | null;
  responseText?: string | null;
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

// ─── Task 9 (spec §2): the run-detail projection ────────────────────────────
//
// "One record per golden item, carrying a bias attribute — not two rows"
// (owner, 2026-09-07). A permuted calibration launches TWO EvaluationRuns
// per golden item, `pairOrder` `'AB'` and `'BA'`, sharing ONE Evaluation
// (src/lib/calibration/launch.ts's D3). Left alone, any page that lists an
// Evaluation's runs (src/app/evaluate/[id]/page.tsx) renders them as two
// unrelated cards — exactly the "two datasets a user has to reconcile"
// outcome the owner ruled out.
//
// The projection key is `(calibrationRunId, goldenItemId)` (spec §2,
// verbatim). Grouping on `evaluationId` instead would be WRONG: D3 already
// puts both orders on the same Evaluation, so every run in a permuted pair
// already shares one evaluationId — grouping on that alone would also fold
// in any THIRD, genuinely independent run a human later launches by hand on
// that same calibration-origin Evaluation (`POST .../runs` sets no
// calibrationRunId), silently swallowing a real extra run into the pair.

export interface CalibrationRunLike {
  id: string;
  calibrationRunId?: string | null;
  goldenItemId?: string | null;
  pairOrder?: string | null;
}

export interface ProjectedRunRow<T extends CalibrationRunLike> {
  /** Stable React key for this row. */
  key: string;
  /** True only when BOTH orders ('AB' and 'BA') are present for this
   * (calibrationRunId, goldenItemId) pair, and nothing else shares the key —
   * the case Step 2 requires collapsing into one row. */
  isPair: boolean;
  ab: T | null;
  ba: T | null;
  /** Non-null only when `isPair` is false: an ordinary run, OR a calibration
   * run whose sibling order never landed (a partial publish failure —
   * src/lib/calibration/launch.ts's F4 doc — leaves exactly one order
   * launched), OR — defensively — one of an unexpected 3+-member group
   * (which should never happen under the DB's partial unique index, v2p;
   * rendered as singles rather than guessed at if it ever does). */
  single: T | null;
}

/**
 * Collapses a `(calibrationRunId, goldenItemId)`-complete AB/BA pair into
 * ONE row; every other run (ordinary, or an unpaired calibration order)
 * passes through as its own single-run row. Preserves the input order:
 * callers pass runs pre-sorted (`orderBy: { createdAt: 'desc' }`, matching
 * every route this feeds), and a group's row is emitted at the position of
 * its FIRST member.
 */
export function projectCalibrationRunRows<T extends CalibrationRunLike>(
  runs: T[]
): ProjectedRunRow<T>[] {
  const groups = new Map<string, T[]>();
  const groupOrder: string[] = [];

  for (const run of runs) {
    const key =
      run.calibrationRunId && run.goldenItemId
        ? `pair:${run.calibrationRunId}:${run.goldenItemId}`
        : `run:${run.id}`;
    const existing = groups.get(key);
    if (existing) {
      existing.push(run);
    } else {
      groups.set(key, [run]);
      groupOrder.push(key);
    }
  }

  const rows: ProjectedRunRow<T>[] = [];
  for (const key of groupOrder) {
    const members = groups.get(key) as T[];
    const ab = members.find((run) => run.pairOrder === 'AB') ?? null;
    const ba = members.find((run) => run.pairOrder === 'BA') ?? null;
    if (ab && ba && members.length === 2) {
      rows.push({ key, isPair: true, ab, ba, single: null });
    } else {
      for (const run of members) {
        rows.push({ key: `${key}:${run.id}`, isPair: false, ab: null, ba: null, single: run });
      }
    }
  }
  return rows;
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
      const datasetName =
        datasetMap.get(datasetId)?.name ??
        currentBatch[0]?.dataset?.name ??
        `Dataset ${datasetId}`;

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
