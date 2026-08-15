import { prisma } from '@/lib/db';
import { publishEvent, userTopic } from '@/lib/realtime/events';
import { deriveRunMode } from '@/lib/run-mode';

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

interface EvaluationForSummary {
  responseText: string | null;
  runs: Array<{
    modelJudgments: Array<{ status: string; overallScore: number | null }>;
    humanJudgment: { overallScore: number } | null;
  }>;
}

function computeSummary(evaluations: EvaluationForSummary[]): DatasetEvaluationSummary {
  const modelAveragesBySample: number[] = [];
  const humanScoresBySample: number[] = [];

  evaluations.forEach((evaluation) => {
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
    // query above) via the shared `deriveRunMode` (src/lib/run-mode.ts) —
    // same single source of truth the worker and human-judgment route use.
    // Respond mode has no scoring concept — its HumanJudgment.overallScore
    // is always the 0 placeholder (see resolveHumanJudgmentScore in
    // src/lib/utils.ts) and must be excluded here so it doesn't drag
    // averageHumanScore toward 0. (selectedBestModelId — respond mode's
    // actual signal — lives on the same row; this only affects the score
    // average, not any best-model count, since no such aggregation exists
    // in this module.)
    const isJudgeMode = deriveRunMode(evaluation.responseText) === 'judge';
    if (
      isJudgeMode &&
      latestRun.humanJudgment?.overallScore !== null &&
      latestRun.humanJudgment?.overallScore !== undefined
    ) {
      humanScoresBySample.push(latestRun.humanJudgment.overallScore);
    }
  });

  return {
    updatedAt: new Date().toISOString(),
    sampleCount: evaluations.length,
    samplesWithModelScores: modelAveragesBySample.length,
    samplesWithHumanScores: humanScoresBySample.length,
    averageModelScore: average(modelAveragesBySample),
    averageHumanScore: average(humanScoresBySample),
  };
}

/**
 * Recompute a dataset's `evaluationSummary` and write it back, race-free.
 *
 * Pre-Task-8, this did a plain read-modify-write: `dataset.findUnique()`
 * (including everything needed to compute the summary), compute in memory,
 * then `dataset.update()` with `{ ...oldMetadata, evaluationSummary }` — two
 * unsynchronized round trips. Two calls racing for the same dataset (e.g.
 * two runs on two different evaluations of the same dataset finalizing
 * within milliseconds of each other, both triggering a refresh) could both
 * read the same pre-race `remoteMetadata`, both compute a summary from
 * their own snapshot of the DB, and then write back-to-back — the SECOND
 * writer's `{ ...oldMetadata, ... }` spread is built from a snapshot that
 * doesn't include whatever the FIRST writer had already committed to
 * `remoteMetadata`'s other fields, silently discarding it (a lost update).
 *
 * Fix: a single `$transaction` that opens with
 * `SELECT ... FROM "Dataset" WHERE id = $1 FOR UPDATE` (`$queryRaw` — no
 * query-builder equivalent), serializing every concurrent call for the same
 * dataset on Postgres's own row lock. The evaluations/runs/judgments read
 * used to COMPUTE the summary, and the `remoteMetadata` read used to
 * PRESERVE non-summary fields, both happen INSIDE this same transaction
 * (after the lock is held) — under READ COMMITTED, each statement sees the
 * latest committed data, so the second caller to acquire the lock reads
 * whatever the first caller just committed, rather than a stale pre-lock
 * snapshot. The write is a single `UPDATE` merging the freshly-recomputed
 * summary into that freshly-read metadata. (`buildRefreshUpdate` in
 * dataset-refresh-update.ts, used by the separate HF-refresh route, is
 * untouched — it has its own preserve-evaluationSummary contract and isn't
 * part of this race.)
 *
 * MUST NOT BE TOMBSTONE-FILTERED (A1) — and, uniquely in that class, CANNOT
 * BE, and it is the only member of the class with that property. The eight
 * original members are Prisma reads that would compile perfectly well with the
 * filter spread in and break a WRITE at runtime with P2002; the three added in
 * wave 1 (`GoldenSet.dataset`, in golden-sets/shared.ts and
 * config/export/route.ts) are REQUIRED to-one relation args, which Prisma
 * refuses a `where` on anyway — and must not be nulled by any other means
 * either, because the pin guard makes a hidden bound corpus unreachable and
 * nulling one would export a fabricated slug. This one cannot be filtered at
 * all: it is raw SQL, so there is no arg to refuse and no result to null.
 *
 * TOMBSTONE OVERLAY (A1): the row lock below is `$queryRaw`, and the only
 * shape src/lib/tombstones.ts offers is unavailable to it. Both filter helpers
 * compile to Prisma `where` fragments — spread into a top-level `where` or
 * into a nested relation arg, it makes no difference — and a `where` fragment
 * cannot reach raw SQL. So A1's rule does not apply to this statement, and
 * nobody should try to make it. It selects one Dataset by primary key for an
 * UPDATE it is about to make; hiding the dataset does not change which row
 * that is.
 */
export async function refreshDatasetEvaluationSummary(datasetId: string): Promise<void> {
  const commit = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string; userId: string; remoteMetadata: string | null }>>`
      SELECT id, "userId", "remoteMetadata" FROM "Dataset" WHERE id = ${datasetId} FOR UPDATE
    `;
    const dataset = rows[0];
    if (!dataset) return null;

    // THE SUMMARY DESCRIBES THE EVALUATIONS, NOT THE LIVE CORPUS, and that is
    // a decision rather than an oversight (A1 wave 1 asked for it either way).
    //
    // This read is deliberately NOT narrowed to evaluations of live samples.
    // Four reasons, in order of weight:
    //
    //   0. NOT EVERY EVALUATION HERE HAS A SAMPLE. `Evaluation.datasetId` and
    //      `.datasetSampleId` are independent nullable columns, and the
    //      summary fixtures in tests/db/leaderboard.test.ts set the first
    //      without the second — a real shape. Any `datasetSample: { is: … }`
    //      narrowing drops those rows outright: measured, it took three
    //      pre-existing summary tests from 1 to 0 before it touched a hidden
    //      row at all.
    //   1. Its population is `Evaluation`, which A1 never hides. Those rows
    //      stay listed on GET /api/evaluations and on the project page after a
    //      sample is withdrawn — an evaluation carries its own copy of the
    //      text it judged. A summary that excluded them would disagree with
    //      the very lists the instance still shows.
    //   2. A judgment that was performed was performed. Hiding the source row
    //      afterwards withdraws the row from the corpus; it does not retract
    //      the measurement, and averaging as if it had never happened would
    //      silently rewrite history that `Dataset.remoteMetadata` PERSISTS.
    //   3. `liveSamplesOnly()` carries decision 16's parent arm, so spreading
    //      it here would make hiding a DATASET zero this summary — destroying
    //      a persisted aggregate on a delete the overlay calls reversible, with
    //      nothing to recompute it from if the dataset ever comes back.
    //
    // THE COST, stated so nobody rediscovers it as a bug:
    // `evaluationSummary.samplesWithModelScores` can exceed the dataset's live
    // `sampleCount`, because they count different things — judgments made
    // versus rows still in the corpus. Pinned by 'a HIDDEN sample's judgments
    // still count' in tests/db/leaderboard.test.ts, beside the other summary
    // tests.
    const evaluations = await tx.evaluation.findMany({
      where: { datasetId },
      select: {
        responseText: true,
        runs: {
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 1,
          select: {
            modelJudgments: { select: { status: true, overallScore: true } },
            humanJudgment: { select: { overallScore: true } },
          },
        },
      },
    });

    const summary = computeSummary(evaluations);

    // Freshly-read remoteMetadata (this transaction's OWN post-lock SELECT
    // above) — never a snapshot read before the lock was acquired. This is
    // what kills the lost-update race described above.
    const metadata = parseMetadata(dataset.remoteMetadata);

    await tx.dataset.update({
      where: { id: datasetId },
      data: { remoteMetadata: JSON.stringify({ ...metadata, evaluationSummary: summary }) },
    });

    return { summary, userId: dataset.userId };
  });

  if (!commit) return;

  // Route to the dataset owner's topic — dataset.summary.updated is only
  // meaningful (and only visible) to whoever owns the dataset. Unlike
  // run-finalizer.ts's post-finalization call into this function (which
  // treats the whole refresh as a best-effort, non-fatal side effect), a
  // publish failure HERE propagates — same contract as before this task
  // (see realtime/events.ts's docstring: this module lets `publishEvent`
  // failures propagate to its own callers, who each decide what that means).
  await publishEvent(userTopic(commit.userId), {
    type: 'dataset.summary.updated',
    payload: { datasetId, summary: commit.summary },
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
