import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { z } from 'zod';
import { requireAuth, requireScope, isAdmin } from '@/lib/auth-guard';
import { refreshDatasetEvaluationSummaryForEvaluation } from '@/lib/dataset-evaluation-summary';
import { markRunCompleted } from '@/lib/run-finalizer';
import { logger, serializeError } from '@/lib/logger';
import { resolveHumanJudgmentScore } from '@/lib/utils';
import { deriveRunMode } from '@/lib/run-mode';
import { judgmentIdentityKey } from '@/lib/model-display';
import { humanJudgmentSchema } from './schema';

/**
 * POST /api/evaluations/[id]/runs/[runId]/human-judgment
 *
 * Submit or update the human judgment for a specific evaluation run.
 */
export async function POST(
  request: Request,
  props: { params: Promise<{ id: string; runId: string }> }
) {
  const params = await props.params;
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;
  const scopeCheck = requireScope(session, 'evaluations:judge');
  if (scopeCheck) return scopeCheck;

  try {
    const body = await request.json();
    const data = humanJudgmentSchema.parse(body);

    // Verify run exists and belongs to specified evaluation
    const run = await prisma.evaluationRun.findUnique({
      where: { id: params.runId },
      include: {
        evaluation: {
          select: {
            id: true,
            userId: true,
            promptText: true,
            responseText: true,
          },
        },
        modelJudgments: {
          select: {
            modelConfigId: true,
            judgeModelVersionId: true,
            status: true,
          },
        },
      },
    });

    if (!run) return NextResponse.json({ error: 'Run not found' }, { status: 404 });
    if (run.evaluationId !== params.id) {
      return NextResponse.json({ error: 'Run not found' }, { status: 404 });
    }
    if (run.evaluation.userId !== session.user.id && !isAdmin(session)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    // trap T6: a calibration run measures a judge against a frozen
    // golden-item answer key — it is not something a human reviewer
    // annotates through this route, and `HumanJudgment.runId` is @unique,
    // so a human judgment here would occupy the run's ONE slot with a
    // value nothing downstream (score.ts, the scoreboard) ever reads. This
    // was ALREADY a hole before permutation: `calibration/launch.ts` sets
    // `EvaluationRun.triggeredById` to the launching operator, and that
    // operator also owns the Evaluation, so they pass every check above
    // (existence, evaluationId match, ownership). Permutation only widens
    // it — a permuted calibration now has TWO EvaluationRuns per golden
    // item (pairOrder 'AB' and 'BA') where there was one, i.e. two
    // meaningless slots instead of one. Refuse both, unconditionally.
    if (run.calibrationRunId !== null) {
      return NextResponse.json(
        { error: 'Cannot record a human judgment on a calibration run.' },
        { status: 409 }
      );
    }

    const mode = deriveRunMode(run.evaluation.responseText);
    const completedJudgments = run.modelJudgments.filter((judgment) => judgment.status === 'completed');
    // Task 12: identity key is judgeModelVersionId when set (every judgment
    // created by the current write path), falling back to the legacy
    // modelConfigId for rows that predate it — see src/lib/model-display.ts.
    const completedModelIds = completedJudgments
      .map((judgment) => judgmentIdentityKey(judgment))
      .filter((id): id is string => id !== null);

    if (mode === 'respond') {
      if (!data.selectedBestModelId) {
        return NextResponse.json(
          { error: 'Respond mode requires selecting the best model response.' },
          { status: 400 }
        );
      }
      if (!completedModelIds.includes(data.selectedBestModelId)) {
        return NextResponse.json(
          { error: 'Selected best model must be one of the completed run responses.' },
          { status: 400 }
        );
      }
    }

    if (mode === 'judge' && data.selectedBestModelId) {
      return NextResponse.json(
        { error: 'Judge mode does not use best-model selection.' },
        { status: 400 }
      );
    }

    // Resolve overallScore per mode: judge mode uses explicit value, computes
    // from criteria, or rejects if both missing; respond mode has no scoring
    // concept and always resolves to the 0 placeholder (see resolveHumanJudgmentScore).
    let normalizedOverallScore: number;
    try {
      normalizedOverallScore = resolveHumanJudgmentScore({
        mode,
        overallScore: data.overallScore,
        criteriaScores: data.criteriaScores,
      });
    } catch {
      return NextResponse.json(
        { error: 'overallScore or criteriaScores required' },
        { status: 400 }
      );
    }

    // Task 12: `data.selectedBestModelId` (wire field name unchanged for
    // backward compat) carries EITHER identity kind now — a
    // judgeModelVersionId (every judgment the current write path creates)
    // or a legacy modelConfigId (rows that predate Task 12). Route the
    // posted value to whichever FK column it actually matches among this
    // run's completed judgments, nulling the other — never both, never
    // guessed.
    const isVersionSelection =
      mode === 'respond' &&
      !!data.selectedBestModelId &&
      completedJudgments.some((j) => j.judgeModelVersionId === data.selectedBestModelId);
    const selectedBestModelId =
      mode === 'respond' && !isVersionSelection ? data.selectedBestModelId ?? null : null;
    const selectedBestJudgeModelVersionId =
      mode === 'respond' && isVersionSelection ? data.selectedBestModelId ?? null : null;

    // Upsert human judgment for this run
    const judgment = await prisma.humanJudgment.upsert({
      where: { runId: params.runId },
      update: {
        overallScore: normalizedOverallScore,
        reasoning: data.reasoning,
        criteriaScores: data.criteriaScores ?? Prisma.DbNull,
        selectedBestModelId,
        selectedBestJudgeModelVersionId,
      },
      create: {
        runId: params.runId,
        userId: session.user.id,
        overallScore: normalizedOverallScore,
        reasoning: data.reasoning,
        criteriaScores: data.criteriaScores ?? Prisma.DbNull,
        selectedBestModelId,
        selectedBestJudgeModelVersionId,
      },
    });

    // Mark run as completed once human judgment is submitted — guarded
    // transition (needs_human -> completed ONLY; see run-finalizer.ts's
    // markRunCompleted doc). A run still pending/judging (automated judging
    // not finished yet) or already completed is a safe no-op here.
    await markRunCompleted(params.runId);

    await refreshDatasetEvaluationSummaryForEvaluation(run.evaluation.id);

    return NextResponse.json(judgment);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Validation failed', details: error.errors }, { status: 400 });
    }
    logger.error('Failed to save human judgment', { error: serializeError(error) });
    return NextResponse.json({ error: 'Failed to save human judgment' }, { status: 500 });
  }
}
