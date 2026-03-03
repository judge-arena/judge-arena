import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { z } from 'zod';
import { requireAuth, isAdmin } from '@/lib/auth-guard';
import {
  createEvaluationRun,
  enqueueRunProcessing,
  runDetailIncludeConfig,
  toHttpError,
} from '@/lib/evaluation-run-manager';

const createRunSchema = z.object({
  rubricId: z.string().optional(),        // override; defaults to evaluation.rubricId
  modelConfigIds: z.array(z.string()).max(10).optional(), // override; defaults to evaluation.modelSelections
});

const runDetailInclude = runDetailIncludeConfig;

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

    const evaluation = await prisma.evaluation.findUnique({
      where: { id: params.id },
      select: { id: true, userId: true },
    });
    if (!evaluation) return NextResponse.json({ error: 'Evaluation not found' }, { status: 404 });
    if (evaluation.userId !== session.user.id && !isAdmin(session)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    const run = await createEvaluationRun({
      evaluationId: params.id,
      triggeredById: session.user.id,
      rubricId: data.rubricId,
      modelConfigIds: data.modelConfigIds,
    });
    enqueueRunProcessing(run.id);

    return NextResponse.json(run, { status: 201 });
  } catch (error) {
    const httpError = toHttpError(error);
    if (httpError) {
      return NextResponse.json({ error: httpError.message }, { status: httpError.status });
    }
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Validation failed', details: error.errors }, { status: 400 });
    }
    console.error('Failed to create run:', error);
    return NextResponse.json({ error: 'Failed to create run' }, { status: 500 });
  }
}
