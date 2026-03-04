import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { requireAuth, requireScope, isAdmin } from '@/lib/auth-guard';
import {
  createEvaluationRun,
  enqueueEvaluationRunCreation,
  enqueueRunProcessing,
  toHttpError,
} from '@/lib/evaluation-run-manager';

// ── Single-text evaluation ──
const createSingleBaseSchema = z.object({
  projectId: z.string().min(1),
  title: z.string().max(200).optional(),
  inputText: z.string().optional(),
  promptText: z.string().optional(),
  responseText: z.string().optional(),
  rubricId: z.string().optional(),
  modelConfigIds: z.array(z.string()).max(10).optional(),
  runMode: z.enum(['create', 'create_and_run']).optional(),
});

const createSingleSchema = createSingleBaseSchema.refine(
  (data) => {
    const hasSingle = !!data.inputText?.trim();
    const hasPair = !!data.promptText?.trim() && !!data.responseText?.trim();
    const hasResponseOnly = !!data.responseText?.trim();
    return hasSingle || hasPair || hasResponseOnly;
  },
  {
    message:
      'Provide either inputText, or promptText+responseText, or responseText.',
    path: ['inputText'],
  }
);

// ── Dataset batch evaluation ──
const createBatchSchema = z.object({
  projectId: z.string().min(1),
  datasetId: z.string().min(1, 'Dataset is required'),
  rubricId: z.string().optional(),
  modelConfigIds: z.array(z.string()).max(10).optional(),
  runMode: z.enum(['create', 'create_and_run']).optional(),
});

const createEvaluationSchema = z.discriminatedUnion('mode', [
  createSingleBaseSchema.extend({ mode: z.literal('single') }),
  createBatchSchema.extend({ mode: z.literal('dataset') }),
]);

// Accept old-style requests too (no mode field = single)
const createEvaluationLegacySchema = z.object({
  projectId: z.string().min(1),
  title: z.string().max(200).optional(),
  inputText: z.string().optional(),
  promptText: z.string().optional(),
  responseText: z.string().optional(),
  rubricId: z.string().optional(),
  modelConfigIds: z.array(z.string()).max(10).optional(),
  runMode: z.enum(['create', 'create_and_run']).optional(),
  createAndRun: z.boolean().optional(),
}).refine(
  (data) => {
    const hasSingle = !!data.inputText?.trim();
    const hasPair = !!data.promptText?.trim() && !!data.responseText?.trim();
    const hasResponseOnly = !!data.responseText?.trim();
    return hasSingle || hasPair || hasResponseOnly;
  },
  {
    message:
      'Provide either inputText, or promptText+responseText, or responseText.',
    path: ['inputText'],
  }
);

// Shared include for run summaries
const runSummaryInclude = {
  rubric: { select: { id: true, name: true, version: true } },
  triggeredBy: { select: { id: true, name: true, email: true } },
  runModelSelections: {
    include: {
      modelConfig: { select: { id: true, name: true, provider: true, modelId: true } },
    },
    orderBy: { createdAt: 'asc' as const },
  },
  modelJudgments: {
    include: {
      modelConfig: { select: { id: true, name: true, provider: true } },
    },
    orderBy: { createdAt: 'asc' as const },
  },
  humanJudgment: { select: { overallScore: true } },
};

const evaluationInclude = {
  rubric: { select: { id: true, name: true, version: true, parentId: true } },
  project: { select: { id: true, name: true } },
  user: { select: { id: true, name: true, email: true } },
  dataset: { select: { id: true, name: true, sampleCount: true } },
  datasetSample: { select: { id: true, index: true, input: true, expected: true } },
  modelSelections: {
    include: {
      modelConfig: {
        select: { id: true, name: true, provider: true, modelId: true, isActive: true, isVerified: true },
      },
    },
    orderBy: { createdAt: 'asc' as const },
  },
  runs: {
    include: runSummaryInclude,
    orderBy: { createdAt: 'desc' as const },
  },
};

// GET /api/evaluations - List evaluation templates (optionally filtered by project or dataset)
export async function GET(request: Request) {
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;
  const scopeCheck = requireScope(session, 'evaluations:read');
  if (scopeCheck) return scopeCheck;

  try {
    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get('projectId');
    const datasetId = searchParams.get('datasetId');

    const where: any = {};
    if (projectId) where.projectId = projectId;
    if (datasetId) where.datasetId = datasetId;
    if (!isAdmin(session)) where.userId = session.user.id;

    const evaluations = await prisma.evaluation.findMany({
      where,
      include: evaluationInclude,
      orderBy: { createdAt: 'desc' },
    });

    return NextResponse.json(evaluations);
  } catch (error) {
    console.error('Failed to fetch evaluations:', error);
    return NextResponse.json({ error: 'Failed to fetch evaluations' }, { status: 500 });
  }
}

// ── Helper: validate model IDs ──
async function resolveModelIds(modelConfigIds: string[] | undefined): Promise<{ ids: string[]; error?: string }> {
  let selectedModelIds = modelConfigIds ?? [];

  if (modelConfigIds === undefined) {
    const defaults = await prisma.modelConfig.findMany({
      where: { isActive: true, isVerified: true },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
      take: 10,
    });
    selectedModelIds = defaults.map((m: any) => m.id);
  }

  if (selectedModelIds.length > 10) {
    return { ids: [], error: 'You can select up to 10 models per evaluation' };
  }

  if (selectedModelIds.length > 0) {
    const validModels = await prisma.modelConfig.findMany({
      where: { id: { in: selectedModelIds }, isVerified: true },
      select: { id: true },
    });
    if (validModels.length !== new Set(selectedModelIds).size) {
      return { ids: [], error: 'One or more selected models are missing or not verified.' };
    }
  }

  return { ids: selectedModelIds };
}

// POST /api/evaluations - Create evaluation(s) from text or dataset
export async function POST(request: Request) {
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;
  const scopeCheck = requireScope(session, 'evaluations:write');
  if (scopeCheck) return scopeCheck;

  try {
    const body = await request.json();
    const shouldRunImmediately =
      body.runMode === 'create_and_run' || body.createAndRun === true;

    // Detect mode: explicit 'mode' field, or infer from presence of datasetId vs inputText
    const mode = body.mode ?? (body.datasetId ? 'dataset' : 'single');

    // ── Verify project ownership ──
    const projectId = body.projectId;
    if (!projectId) return NextResponse.json({ error: 'projectId is required' }, { status: 400 });

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, userId: true },
    });
    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    if (project.userId !== session.user.id && !isAdmin(session)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // ── Validate models ──
    const { ids: selectedModelIds, error: modelError } = await resolveModelIds(body.modelConfigIds);
    if (modelError) return NextResponse.json({ error: modelError }, { status: 400 });

    // ══════════════════════════════════════════════════════════════════════
    // SINGLE-TEXT MODE
    // ══════════════════════════════════════════════════════════════════════
    if (mode === 'single') {
      const data = createEvaluationLegacySchema.parse(body);

      const evaluation = await prisma.evaluation.create({
        data: {
          projectId: data.projectId,
          title: data.title,
          inputText:
            data.inputText?.trim() ||
            data.responseText?.trim() ||
            data.promptText?.trim() ||
            '',
          promptText: data.promptText?.trim() || undefined,
          responseText: data.responseText?.trim() || undefined,
          userId: session.user.id,
          ...(data.rubricId && { rubricId: data.rubricId }),
          modelSelections: {
            create: [...new Set(selectedModelIds)].map((modelConfigId) => ({ modelConfigId })),
          },
        } satisfies Prisma.EvaluationUncheckedCreateInput,
        include: evaluationInclude,
      });

      if (shouldRunImmediately) {
        const run = await createEvaluationRun({
          evaluationId: evaluation.id,
          triggeredById: session.user.id,
        });
        enqueueRunProcessing(run.id);
        return NextResponse.json(
          {
            ...evaluation,
            runMode: 'create_and_run',
            runQueued: true,
            runId: run.id,
          },
          { status: 201 }
        );
      }

      return NextResponse.json(evaluation, { status: 201 });
    }

    // ══════════════════════════════════════════════════════════════════════
    // DATASET MODE — create one evaluation per dataset sample
    // ══════════════════════════════════════════════════════════════════════
    const batchData = createBatchSchema.parse(body);

    // Load dataset + samples
    const dataset = await prisma.dataset.findUnique({
      where: { id: batchData.datasetId },
      include: {
        samples: { orderBy: { index: 'asc' } },
      },
    });
    if (!dataset) return NextResponse.json({ error: 'Dataset not found' }, { status: 404 });
    if (dataset.samples.length === 0) {
      return NextResponse.json({ error: 'Dataset has no samples' }, { status: 400 });
    }

    // Create evaluations in a transaction for consistency
    const evaluations = await prisma.$transaction(
      dataset.samples.map((sample: any) =>
        prisma.evaluation.create({
          data: {
            projectId: batchData.projectId,
            title: `${dataset.name} #${sample.index + 1}`,
            inputText: sample.expected || sample.input,
            promptText: sample.input,
            responseText: sample.expected || undefined,
            userId: session.user.id,
            datasetId: dataset.id,
            datasetSampleId: sample.id,
            ...(batchData.rubricId && { rubricId: batchData.rubricId }),
            modelSelections: {
              create: [...new Set(selectedModelIds)].map((modelConfigId) => ({ modelConfigId })),
            },
          } satisfies Prisma.EvaluationUncheckedCreateInput,
        })
      )
    );

    if (shouldRunImmediately) {
      for (const evaluation of evaluations) {
        enqueueEvaluationRunCreation(evaluation.id, session.user.id);
      }
    }

    // Return summary — don't load full includes for potentially thousands of evaluations
    return NextResponse.json(
      shouldRunImmediately
        ? {
            mode: 'dataset',
            runMode: 'create_and_run',
            datasetId: dataset.id,
            datasetName: dataset.name,
            evaluationsCreated: evaluations.length,
            evaluationIds: evaluations.map((e: any) => e.id),
            runsQueued: evaluations.length,
          }
        : {
        mode: 'dataset',
        datasetId: dataset.id,
        datasetName: dataset.name,
        evaluationsCreated: evaluations.length,
        evaluationIds: evaluations.map((e: any) => e.id),
          },
      { status: 201 }
    );
  } catch (error) {
    const httpError = toHttpError(error);
    if (httpError) {
      return NextResponse.json({ error: httpError.message }, { status: httpError.status });
    }
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Validation failed', details: error.errors }, { status: 400 });
    }
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2003'
    ) {
      return NextResponse.json(
        {
          error:
            'Foreign key constraint failed. Invalid relation reference while creating evaluation.',
        },
        { status: 400 }
      );
    }
    console.error('Failed to create evaluation:', error);
    return NextResponse.json({ error: 'Failed to create evaluation' }, { status: 500 });
  }
}
