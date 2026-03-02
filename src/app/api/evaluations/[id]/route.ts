import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { z } from 'zod';
import { requireAuth, isAdmin } from '@/lib/auth-guard';

const updateEvaluationSchema = z.object({
  rubricId: z.string().nullable().optional(),
  modelConfigIds: z.array(z.string()).max(10).optional(),
  clearModelJudgments: z.boolean().optional(),
});

// GET /api/evaluations/[id]
export async function GET(
  _request: Request,
  { params }: { params: { id: string } }
) {
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;

  try {
    const evaluation = await prisma.evaluation.findUnique({
      where: { id: params.id },
      include: {
        rubric: {
          include: { criteria: { orderBy: { order: 'asc' } } },
        },
        project: { select: { id: true, name: true } },
        user: { select: { id: true, name: true, email: true } },
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
    });

    if (!evaluation) {
      return NextResponse.json(
        { error: 'Evaluation not found' },
        { status: 404 }
      );
    }

    if (evaluation.userId !== session.user.id && !isAdmin(session)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
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
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;

  try {
    const existing = await prisma.evaluation.findUnique({ where: { id: params.id }, select: { userId: true } });
    if (!existing) return NextResponse.json({ error: 'Evaluation not found' }, { status: 404 });
    if (existing.userId !== session.user.id && !isAdmin(session)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

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

    if (data.modelConfigIds !== undefined && data.modelConfigIds.length > 0) {
      const validModels = await prisma.modelConfig.findMany({
        where: {
          id: { in: data.modelConfigIds },
          isVerified: true,
        },
        select: { id: true },
      });

      if (validModels.length !== new Set(data.modelConfigIds).size) {
        return NextResponse.json(
          {
            error:
              'One or more selected models are missing or not verified. Re-open model settings and verify connection.',
          },
          { status: 400 }
        );
      }
    }

    const shouldClearModelJudgments = !!data.clearModelJudgments;
    const shouldUpdateModelSelections = data.modelConfigIds !== undefined;

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

      if (shouldUpdateModelSelections) {
        await tx.evaluationModelSelection.deleteMany({
          where: { evaluationId: params.id },
        });

        if (data.modelConfigIds && data.modelConfigIds.length > 0) {
          await tx.evaluationModelSelection.createMany({
            data: [...new Set(data.modelConfigIds)].map((modelConfigId) => ({
              evaluationId: params.id,
              modelConfigId,
            })),
          });
        }
      }

      return tx.evaluation.findUnique({
        where: { id: params.id },
        include: {
          rubric: {
            include: { criteria: { orderBy: { order: 'asc' } } },
          },
          project: { select: { id: true, name: true } },
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
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;

  try {
    const existing = await prisma.evaluation.findUnique({ where: { id: params.id }, select: { userId: true } });
    if (!existing) return NextResponse.json({ error: 'Evaluation not found' }, { status: 404 });
    if (existing.userId !== session.user.id && !isAdmin(session)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

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
