import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { z } from 'zod';

const createEvaluationSchema = z.object({
  projectId: z.string().min(1),
  title: z.string().max(200).optional(),
  inputText: z.string().min(1, 'Input text is required'),
});

// GET /api/evaluations - List evaluations (optionally filtered by project)
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get('projectId');

    const evaluations = await prisma.evaluation.findMany({
      where: projectId ? { projectId } : undefined,
      include: {
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

    const evaluation = await prisma.evaluation.create({
      data: {
        projectId: data.projectId,
        title: data.title,
        inputText: data.inputText,
        status: 'pending',
      },
      include: {
        project: { select: { id: true, name: true, rubricId: true } },
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
