import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

// GET /api/evaluations/[id]
export async function GET(
  _request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const evaluation = await prisma.evaluation.findUnique({
      where: { id: params.id },
      include: {
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
