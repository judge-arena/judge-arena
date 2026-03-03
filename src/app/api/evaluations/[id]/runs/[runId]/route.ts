import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireAuth, isAdmin } from '@/lib/auth-guard';

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
  humanJudgment: {
    include: { user: { select: { id: true, name: true, email: true } } },
  },
  evaluation: {
    select: {
      id: true,
      title: true,
      inputText: true,
      userId: true,
      project: { select: { id: true, name: true } },
      dataset: { select: { id: true, name: true, sampleCount: true } },
      datasetSample: { select: { id: true, index: true, input: true, expected: true } },
    },
  },
};

// GET /api/evaluations/[id]/runs/[runId]
export async function GET(
  _request: Request,
  { params }: { params: { id: string; runId: string } }
) {
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;

  try {
    const run = await prisma.evaluationRun.findUnique({
      where: { id: params.runId },
      include: runDetailInclude,
    });

    if (!run) return NextResponse.json({ error: 'Run not found' }, { status: 404 });

    // Verify the run belongs to the specified evaluation
    if (run.evaluationId !== params.id) {
      return NextResponse.json({ error: 'Run not found' }, { status: 404 });
    }

    // Access control: owner or admin
    if (run.evaluation.userId !== session.user.id && !isAdmin(session)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    return NextResponse.json(run);
  } catch (error) {
    console.error('Failed to fetch run:', error);
    return NextResponse.json({ error: 'Failed to fetch run' }, { status: 500 });
  }
}
