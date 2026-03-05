import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { z } from 'zod';
import { requireAuth, requireScope, isAdmin } from '@/lib/auth-guard';
import { refreshDatasetEvaluationSummaryForEvaluation } from '@/lib/dataset-evaluation-summary';

const humanJudgmentSchema = z.object({
  overallScore: z.number().min(0).max(10).optional(),
  reasoning: z.string().max(5000).optional(),
  criteriaScores: z
    .array(
      z.object({
        criterionId: z.string(),
        criterionName: z.string(),
        score: z.number().min(0),
        maxScore: z.number(),
        weight: z.number(),
        comment: z.string().optional(),
      })
    )
    .optional(),
  selectedBestModelId: z.string().nullable().optional(),
});

/**
 * POST /api/evaluations/[id]/runs/[runId]/human-judgment
 *
 * Submit or update the human judgment for a specific evaluation run.
 */
export async function POST(
  request: Request,
  { params }: { params: { id: string; runId: string } }
) {
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

    const mode = run.evaluation.responseText?.trim() ? 'judge' : 'respond';
    const completedModelIds = run.modelJudgments
      .filter((judgment) => judgment.status === 'completed')
      .map((judgment) => judgment.modelConfigId);

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

    const normalizedOverallScore =
      typeof data.overallScore === 'number' ? data.overallScore : 0;

    // Upsert human judgment for this run
    const judgment = await prisma.humanJudgment.upsert({
      where: { runId: params.runId },
      update: {
        overallScore: normalizedOverallScore,
        reasoning: data.reasoning,
        criteriaScores: data.criteriaScores ? JSON.stringify(data.criteriaScores) : null,
        selectedBestModelId: mode === 'respond' ? data.selectedBestModelId : null,
      },
      create: {
        runId: params.runId,
        userId: session.user.id,
        overallScore: normalizedOverallScore,
        reasoning: data.reasoning,
        criteriaScores: data.criteriaScores ? JSON.stringify(data.criteriaScores) : null,
        selectedBestModelId: mode === 'respond' ? data.selectedBestModelId : null,
      },
    });

    // Mark run as completed once human judgment is submitted
    // (transitions from needs_human -> completed, or judging -> completed)
    if (run.status !== 'completed') {
      await prisma.evaluationRun.update({
        where: { id: params.runId },
        data: { status: 'completed' },
      });
    }

    await refreshDatasetEvaluationSummaryForEvaluation(run.evaluation.id);

    return NextResponse.json(judgment);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Validation failed', details: error.errors }, { status: 400 });
    }
    console.error('Failed to save human judgment:', error);
    return NextResponse.json({ error: 'Failed to save human judgment' }, { status: 500 });
  }
}
