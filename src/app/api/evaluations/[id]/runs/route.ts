import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { z } from 'zod';
import { requireAuth, requireScope, isAdmin } from '@/lib/auth-guard';
import { launchSingleRun, runDetailInclude, toRunLaunchHttpError } from '@/lib/run-launch';
import { judgeLimiter } from '@/lib/rate-limit-redis';
import { rateLimitHeaders, JUDGE_LIMIT } from '@/lib/rate-limit';
import { getClientIp } from '@/lib/client-ip';
import { logger, serializeError } from '@/lib/logger';

const createRunSchema = z.object({
  rubricId: z.string().optional(),        // override; defaults to evaluation.rubricId
  judgeModelVersionIds: z.array(z.string()).max(10).optional(), // override; defaults to evaluation.modelSelections
});

// GET /api/evaluations/[id]/runs — list all runs for a template
export async function GET(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;
  const scopeCheck = requireScope(session, 'evaluations:read');
  if (scopeCheck) return scopeCheck;

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

    // A1: `runDetailInclude` carries the tombstone filter on its own nested
    // `Evaluation.dataset`/`.datasetSample` args, so these rows arrive already
    // filtered and this route has nothing to remember. That is the whole
    // reason the filter lives in the shared include rather than here.
    return NextResponse.json(runs);
  } catch (error) {
    logger.error('Failed to fetch runs', { error: serializeError(error) });
    return NextResponse.json({ error: 'Failed to fetch runs' }, { status: 500 });
  }
}

// POST /api/evaluations/[id]/runs — create a new run and fire model judgments
export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;
  const scopeCheck = requireScope(session, 'evaluations:run');
  if (scopeCheck) return scopeCheck;

  // Judge runs are expensive (real LLM calls fan out per model/sample) —
  // apply a tighter limiter on top of the general `api` chokepoint already
  // enforced inside requireAuth().
  const clientIp = getClientIp(request.headers);
  const rateResult = await judgeLimiter.check(clientIp);
  if (!rateResult.ok) {
    return NextResponse.json(
      { error: 'Too many evaluation runs. Please slow down.' },
      { status: 429, headers: rateLimitHeaders(rateResult, JUDGE_LIMIT) }
    );
  }

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

    const launch = await launchSingleRun({
      evaluationId: params.id,
      triggeredById: session.user.id,
      rubricId: data.rubricId,
      judgeModelVersionIds: data.judgeModelVersionIds,
    });

    if (launch.publishFailed) {
      return NextResponse.json(
        {
          ...launch.run,
          error: `Run created but failed to queue judgments: ${launch.publishError}`,
        },
        { status: 502 }
      );
    }

    return NextResponse.json(launch.run, { status: 201 });
  } catch (error) {
    const httpError = toRunLaunchHttpError(error);
    if (httpError) {
      return NextResponse.json({ error: httpError.message }, { status: httpError.status });
    }
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Validation failed', details: error.errors }, { status: 400 });
    }
    logger.error('Failed to create run', { error: serializeError(error) });
    return NextResponse.json({ error: 'Failed to create run' }, { status: 500 });
  }
}
