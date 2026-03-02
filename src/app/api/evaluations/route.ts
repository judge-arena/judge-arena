import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { z } from 'zod';

const createEvaluationSchema = z.object({
  projectId: z.string().min(1),
  title: z.string().max(200).optional(),
  inputText: z.string().min(1, 'Input text is required'),
  rubricId: z.string().optional(), // specific rubric version to pin for this evaluation
  modelConfigIds: z.array(z.string()).max(10).optional(),
});

// GET /api/evaluations - List evaluations (optionally filtered by project)
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get('projectId');

    const evaluations = await prisma.evaluation.findMany({
      where: projectId ? { projectId } : undefined,
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
        modelSelections: {
          include: {
            modelConfig: {
              select: {
                id: true,
                name: true,
                provider: true,
                modelId: true,
                isActive: true,
                isVerified: true,
              },
            },
          },
          orderBy: { createdAt: 'asc' },
        },
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
      orderBy: { createdAt: 'desc' },
    });

    return NextResponse.json(evaluations);
  } catch (error) {
    console.error('Failed to fetch evaluations:', error);
    return NextResponse.json(
      { error: 'Failed to fetch evaluations' },
      { status: 500 }
    );
  }
}

// POST /api/evaluations - Create a new evaluation
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const data = createEvaluationSchema.parse(body);

    // Verify project exists
    const project = await prisma.project.findUnique({
      where: { id: data.projectId },
    });
    if (!project) {
      return NextResponse.json(
        { error: 'Project not found' },
        { status: 404 }
      );
    }

    const requestedModelIds = data.modelConfigIds ?? [];
    let selectedModelIds = requestedModelIds;

    // Backward-compatible default: if model list omitted, use active verified models (up to 10)
    if (data.modelConfigIds === undefined) {
      const defaults = await prisma.modelConfig.findMany({
        where: { isActive: true, isVerified: true },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
        take: 10,
      });
      selectedModelIds = defaults.map((m: any) => m.id);
    }

    if (selectedModelIds.length > 10) {
      return NextResponse.json(
        { error: 'You can select up to 10 models per evaluation' },
        { status: 400 }
      );
    }

    if (selectedModelIds.length > 0) {
      const validModels = await prisma.modelConfig.findMany({
        where: {
          id: { in: selectedModelIds },
          isVerified: true,
        },
        select: { id: true },
      });

      if (validModels.length !== new Set(selectedModelIds).size) {
        return NextResponse.json(
          {
            error:
              'One or more selected models are missing or not verified. Re-open model settings and verify connection.',
          },
          { status: 400 }
        );
      }
    }

    const evaluation = await prisma.evaluation.create({
      data: {
        projectId: data.projectId,
        title: data.title,
        inputText: data.inputText,
        ...(data.rubricId && { rubricId: data.rubricId }),
        modelSelections: {
          create: [...new Set(selectedModelIds)].map((modelConfigId) => ({
            modelConfigId,
          })),
        },
        status: 'pending',
      },
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
        modelSelections: {
          include: {
            modelConfig: {
              select: {
                id: true,
                name: true,
                provider: true,
                modelId: true,
                isActive: true,
                isVerified: true,
              },
            },
          },
          orderBy: { createdAt: 'asc' },
        },
        modelJudgments: {
          include: { modelConfig: true },
        },
        humanJudgment: true,
      },
    });

    return NextResponse.json(evaluation, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Validation failed', details: error.errors },
        { status: 400 }
      );
    }
    console.error('Failed to create evaluation:', error);
    return NextResponse.json(
      { error: 'Failed to create evaluation' },
      { status: 500 }
    );
  }
}
