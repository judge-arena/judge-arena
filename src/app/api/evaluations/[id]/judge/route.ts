import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { executeJudgment } from '@/lib/llm';

/**
 * POST /api/evaluations/[id]/judge
 *
 * Trigger model evaluations for this evaluation.
 * Runs all active models in parallel against the rubric.
 */
export async function POST(
  _request: Request,
  { params }: { params: { id: string } }
) {
  try {
    // Load evaluation with its own rubric (fallback to project rubric for legacy data)
    const evaluation = await prisma.evaluation.findUnique({
      where: { id: params.id },
      include: {
        rubric: {
          include: { criteria: { orderBy: { order: 'asc' } } },
        },
        project: {
          include: {
            rubric: {
              include: { criteria: { orderBy: { order: 'asc' } } },
            },
          },
        },
      },
    });

    if (!evaluation) {
      return NextResponse.json(
        { error: 'Evaluation not found' },
        { status: 404 }
      );
    }

    const rubric = evaluation.rubric ?? evaluation.project.rubric;
    if (!rubric) {
      return NextResponse.json(
        {
          error:
            'No rubric assigned to this evaluation. Please assign a rubric first.',
        },
        { status: 400 }
      );
    }

    // Get all active model configs
    const models = await prisma.modelConfig.findMany({
      where: { isActive: true },
    });

    if (models.length === 0) {
      return NextResponse.json(
        { error: 'No active models configured. Add models in the Models page.' },
        { status: 400 }
      );
    }

    // Update evaluation status
    await prisma.evaluation.update({
      where: { id: params.id },
      data: { status: 'judging' },
    });

    // Delete any existing judgments for this evaluation (re-run case)
    await prisma.modelJudgment.deleteMany({
      where: { evaluationId: params.id },
    });

    // Create pending judgments for each model
    const pendingJudgments = await Promise.all(
      models.map((model: any) =>
        prisma.modelJudgment.create({
          data: {
            evaluationId: params.id,
            modelConfigId: model.id,
            status: 'running',
          },
        })
      )
    );

    // Run all model evaluations in parallel
    const judgmentPromises = models.map(async (model: any, index: number) => {
      const judgmentId = pendingJudgments[index].id;

      try {
        const result = await executeJudgment(
          model.provider,
          {
            inputText: evaluation.inputText,
            rubricCriteria: rubric.criteria,
            rubricName: rubric.name,
            rubricDescription: rubric.description || undefined,
          },
          {
            modelId: model.modelId,
            apiKey: model.apiKey || undefined,
            endpoint: model.endpoint || undefined,
          }
        );

        // Update judgment with results
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

        return { modelId: model.id, status: 'completed' as const };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';

        await prisma.modelJudgment.update({
          where: { id: judgmentId },
          data: {
            status: 'error',
            error: errorMessage,
          },
        });

        return {
          modelId: model.id,
          status: 'error' as const,
          error: errorMessage,
        };
      }
    });

    const results = await Promise.allSettled(judgmentPromises);

    // Check if all completed or some errored
    const hasErrors = results.some(
      (r) => r.status === 'rejected' || (r.status === 'fulfilled' && r.value.status === 'error')
    );

    const allErrored = results.every(
      (r) => r.status === 'rejected' || (r.status === 'fulfilled' && r.value.status === 'error')
    );

    await prisma.evaluation.update({
      where: { id: params.id },
      data: {
        status: allErrored ? 'error' : 'completed',
      },
    });

    // Fetch updated evaluation
    const updated = await prisma.evaluation.findUnique({
      where: { id: params.id },
      include: {
        rubric: {
          select: {
            id: true,
            name: true,
            version: true,
            parentId: true,
          },
        },
        project: { select: { id: true, name: true, rubricId: true } },
        modelJudgments: {
          include: {
            modelConfig: {
              select: { id: true, name: true, provider: true, modelId: true },
            },
          },
          orderBy: { createdAt: 'asc' },
        },
        humanJudgment: true,
      },
    });

    return NextResponse.json({
      evaluation: updated,
      summary: {
        total: models.length,
        completed: results.filter(
          (r) => r.status === 'fulfilled' && r.value.status === 'completed'
        ).length,
        errors: results.filter(
          (r) => r.status === 'rejected' || (r.status === 'fulfilled' && r.value.status === 'error')
        ).length,
        hasErrors,
      },
    });
  } catch (error) {
    console.error('Failed to run evaluation:', error);

    // Try to update status back on failure
    try {
      await prisma.evaluation.update({
        where: { id: params.id },
        data: { status: 'error' },
      });
    } catch {
      // ignore
    }

    return NextResponse.json(
      { error: 'Failed to run evaluation' },
      { status: 500 }
    );
  }
}
