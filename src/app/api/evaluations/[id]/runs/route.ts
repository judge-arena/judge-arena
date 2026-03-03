import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { z } from 'zod';
import { requireAuth, isAdmin } from '@/lib/auth-guard';
import { executeJudgment } from '@/lib/llm';

const createRunSchema = z.object({
  rubricId: z.string().optional(),        // override; defaults to evaluation.rubricId
  modelConfigIds: z.array(z.string()).max(10).optional(), // override; defaults to evaluation.modelSelections
});

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
      project: { select: { id: true, name: true } },
      dataset: { select: { id: true, name: true } },
      datasetSample: { select: { id: true, index: true } },
    },
  },
};

// GET /api/evaluations/[id]/runs — list all runs for a template
export async function GET(
  _request: Request,
  { params }: { params: { id: string } }
) {
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;

  try {
    const evaluation = await prisma.evaluation.findUnique({
      where: { id: params.id },
      select: { userId: true },
    });
    if (!evaluation) return NextResponse.json({ error: 'Evaluation not found' }, { status: 404 });
    if (evaluation.userId !== session.user.id && !isAdmin(session)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const runs = await prisma.evaluationRun.findMany({
      where: { evaluationId: params.id },
      include: runDetailInclude,
      orderBy: { createdAt: 'desc' },
    });

    return NextResponse.json(runs);
  } catch (error) {
    console.error('Failed to fetch runs:', error);
    return NextResponse.json({ error: 'Failed to fetch runs' }, { status: 500 });
  }
}

// POST /api/evaluations/[id]/runs — create a new run and fire model judgments
export async function POST(
  request: Request,
  { params }: { params: { id: string } }
) {
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;

  try {
    const body = await request.json().catch(() => ({}));
    const data = createRunSchema.parse(body);

    // Load the template with its defaults
    const evaluation = await prisma.evaluation.findUnique({
      where: { id: params.id },
      include: {
        rubric: { include: { criteria: { orderBy: { order: 'asc' } } } },
        modelSelections: {
          include: { modelConfig: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!evaluation) return NextResponse.json({ error: 'Evaluation not found' }, { status: 404 });
    if (evaluation.userId !== session.user.id && !isAdmin(session)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Resolve rubric for this run (override > template default)
    const rubricId = data.rubricId ?? evaluation.rubricId ?? null;
    let rubric: any = null;
    if (rubricId) {
      rubric = await prisma.rubric.findUnique({
        where: { id: rubricId },
        include: { criteria: { orderBy: { order: 'asc' } } },
      });
      if (!rubric) return NextResponse.json({ error: 'Rubric not found' }, { status: 404 });
    }

    if (!rubric) {
      return NextResponse.json(
        { error: 'No rubric assigned. Assign a rubric to the evaluation template or pass rubricId.' },
        { status: 400 }
      );
    }

    // Resolve models for this run (override > template default)
    let selectedModelIds: string[];
    if (data.modelConfigIds !== undefined) {
      selectedModelIds = [...new Set(data.modelConfigIds)];
    } else {
      selectedModelIds = evaluation.modelSelections.map((s: any) => s.modelConfigId);
    }

    if (selectedModelIds.length === 0) {
      return NextResponse.json(
        { error: 'No models selected. Add models to the evaluation template or pass modelConfigIds.' },
        { status: 400 }
      );
    }

    // Validate all models are verified
    const modelRecords = await prisma.modelConfig.findMany({
      where: { id: { in: selectedModelIds }, isVerified: true, isActive: true },
    });
    if (modelRecords.length !== new Set(selectedModelIds).size) {
      return NextResponse.json(
        { error: 'One or more selected models are missing, inactive, or not verified.' },
        { status: 400 }
      );
    }

    // Create the run synchronously with pending status
    const run = await prisma.evaluationRun.create({
      data: {
        evaluationId: params.id,
        rubricId: rubric.id,
        status: 'judging',
        triggeredById: session.user.id,
        runModelSelections: {
          create: selectedModelIds.map((modelConfigId) => ({ modelConfigId })),
        },
        modelJudgments: {
          create: modelRecords.map((model: any) => ({
            modelConfigId: model.id,
            status: 'running',
          })),
        },
      },
      include: runDetailInclude,
    });

    // Fire all model judgments in parallel (non-blocking — we return the run immediately)
    const judgmentMap = new Map(
      run.modelJudgments.map((j: any) => [j.modelConfigId, j.id])
    );

    // Run async without awaiting — client polls for updates
    void (async () => {
      const judgmentPromises = modelRecords.map(async (model: any) => {
        const judgmentId = judgmentMap.get(model.id);
        if (!judgmentId) return;

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
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : 'Unknown error';
          await prisma.modelJudgment.update({
            where: { id: judgmentId },
            data: { status: 'error', error: errorMessage },
          });
          return { modelId: model.id, status: 'error' as const, error: errorMessage };
        }
      });

      const results = await Promise.allSettled(judgmentPromises);
      const allErrored = results.every(
        (r) => r.status === 'rejected' || (r.status === 'fulfilled' && r.value?.status === 'error')
      );

      await prisma.evaluationRun.update({
        where: { id: run.id },
        data: { status: allErrored ? 'error' : 'needs_human' },
      });
    })();

    return NextResponse.json(run, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Validation failed', details: error.errors }, { status: 400 });
    }
    console.error('Failed to create run:', error);
    return NextResponse.json({ error: 'Failed to create run' }, { status: 500 });
  }
}
