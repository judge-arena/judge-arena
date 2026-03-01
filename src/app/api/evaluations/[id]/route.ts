import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { z } from 'zod';

const updateEvaluationSchema = z.object({
  rubricId: z.string().nullable().optional(),
  clearModelJudgments: z.boolean().optional(),
});

// GET /api/evaluations/[id]
export async function GET(
  _request: Request,
  { params }: { params: { id: string } }
) {
  try {
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

    if (!evaluation) {
      return NextResponse.json(
        { error: 'Evaluation not found' },
        { status: 404 }
      );
    }

    return NextResponse.json(evaluation);
  } catch (error) {
    console.error('Failed to fetch evaluation:', error);
    return NextResponse.json(
      { error: 'Failed to fetch evaluation' },
      { status: 500 }
    );
  }
}

// PATCH /api/evaluations/[id]
export async function PATCH(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const body = await request.json();
    const data = updateEvaluationSchema.parse(body);

    if (data.rubricId) {
      const rubric = await prisma.rubric.findUnique({
        where: { id: data.rubricId },
        select: { id: true },
      });
      if (!rubric) {
        return NextResponse.json({ error: 'Rubric not found' }, { status: 404 });
      }
    }

    const shouldClearModelJudgments = !!data.clearModelJudgments;

    const evaluation = await prisma.$transaction(async (tx: any) => {
      await tx.evaluation.update({
        where: { id: params.id },
        data: {
          ...(data.rubricId !== undefined ? { rubricId: data.rubricId } : {}),
          ...(shouldClearModelJudgments ? { status: 'pending' } : {}),
        },
      });

      if (shouldClearModelJudgments) {
        await tx.modelJudgment.deleteMany({
          where: { evaluationId: params.id },
        });
      }

      return tx.evaluation.findUnique({
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
          modelJudgments: {
            include: {
              modelConfig: {
                select: {
                  id: true,
                  name: true,
                  provider: true,
                  modelId: true,
                },
              },
            },
            orderBy: { createdAt: 'asc' },
          },
          humanJudgment: true,
        },
      });
    });

    if (!evaluation) {
      return NextResponse.json(
        { error: 'Evaluation not found' },
        { status: 404 }
      );
    }

    return NextResponse.json(evaluation);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Validation failed', details: error.errors },
        { status: 400 }
      );
    }

    console.error('Failed to update evaluation:', error);
    return NextResponse.json(
      { error: 'Failed to update evaluation' },
      { status: 500 }
    );
  }
}

// DELETE /api/evaluations/[id]
export async function DELETE(
  _request: Request,
  { params }: { params: { id: string } }
) {
  try {
    await prisma.evaluation.delete({ where: { id: params.id } });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to delete evaluation:', error);
    return NextResponse.json(
      { error: 'Failed to delete evaluation' },
      { status: 500 }
    );
  }
}
