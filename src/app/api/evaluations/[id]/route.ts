import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { z } from 'zod';
import { requireAuth, requireScope, isAdmin } from '@/lib/auth-guard';
import { logger, serializeError } from '@/lib/logger';
import { sampleTombstoneFlagSelect, tombstoneFlagSelect, withLiveCorpusRefs } from '@/lib/tombstones';

const updateEvaluationSchema = z.object({
  rubricId: z.string().nullable().optional(),
  judgeModelVersionIds: z.array(z.string()).max(10).optional(),
});

// Task 12: minimal JudgeModelVersion+JudgeModel select for display fallback
// when modelConfig is null — see src/lib/model-display.ts.
const judgeModelVersionDisplaySelect = {
  id: true,
  ordinal: true,
  servingBackend: true,
  judgeModel: { select: { id: true, name: true, baseModel: true } },
} as const;

const runSummaryInclude = {
  rubric: { select: { id: true, name: true, version: true } },
  triggeredBy: { select: { id: true, name: true, email: true } },
  runModelSelections: {
    include: {
      modelConfig: { select: { id: true, name: true, provider: true, modelId: true } },
      judgeModelVersion: { select: judgeModelVersionDisplaySelect },
    },
    orderBy: { createdAt: 'asc' as const },
  },
  modelJudgments: {
    include: {
      modelConfig: { select: { id: true, name: true, provider: true } },
      judgeModelVersion: { select: judgeModelVersionDisplaySelect },
    },
    orderBy: { createdAt: 'asc' as const },
  },
  humanJudgment: { select: { overallScore: true } },
};

// GET /api/evaluations/[id]
export async function GET(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;
  const scopeCheck = requireScope(session, 'evaluations:read');
  if (scopeCheck) return scopeCheck;

  try {
    const evaluation = await prisma.evaluation.findUnique({
      where: { id: params.id },
      include: {
        rubric: {
          include: { criteria: { orderBy: { order: 'asc' } } },
        },
        project: { select: { id: true, name: true } },
        user: { select: { id: true, name: true, email: true } },
        // A1: to-ONE args take no `where`; the marker rides along and
        // `withLiveCorpusRefs` nulls the sub-object at the response. See the
        // block above `liveOrNull` in src/lib/tombstones.ts.
        dataset: { select: { id: true, name: true, sampleCount: true, tombstone: tombstoneFlagSelect } },
        datasetSample: {
          select: { id: true, index: true, input: true, expected: true, ...sampleTombstoneFlagSelect },
        },
        modelSelections: {
          include: {
            modelConfig: {
              select: { id: true, name: true, provider: true, modelId: true, isActive: true, isVerified: true },
            },
            judgeModelVersion: { select: judgeModelVersionDisplaySelect },
          },
          orderBy: { createdAt: 'asc' },
        },
        runs: {
          include: runSummaryInclude,
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!evaluation) {
      return NextResponse.json({ error: 'Evaluation not found' }, { status: 404 });
    }
    if (evaluation.userId !== session.user.id && !isAdmin(session)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    return NextResponse.json(withLiveCorpusRefs(evaluation));
  } catch (error) {
    logger.error('Failed to fetch evaluation', { error: serializeError(error) });
    return NextResponse.json({ error: 'Failed to fetch evaluation' }, { status: 500 });
  }
}

// PATCH /api/evaluations/[id] — update template defaults (rubric / model selections)
export async function PATCH(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;
  const scopeCheck = requireScope(session, 'evaluations:write');
  if (scopeCheck) return scopeCheck;

  try {
    const existing = await prisma.evaluation.findUnique({
      where: { id: params.id },
      select: { userId: true },
    });
    if (!existing) return NextResponse.json({ error: 'Evaluation not found' }, { status: 404 });
    if (existing.userId !== session.user.id && !isAdmin(session)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const body = await request.json();
    const data = updateEvaluationSchema.parse(body);

    if (data.rubricId) {
      const rubric = await prisma.rubric.findUnique({ where: { id: data.rubricId }, select: { id: true, userId: true } });
      if (!rubric) return NextResponse.json({ error: 'Rubric not found' }, { status: 404 });
      if (rubric.userId !== session.user.id && !isAdmin(session)) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
    }

    if (data.judgeModelVersionIds !== undefined && data.judgeModelVersionIds.length > 0) {
      // Task 12: every requested judgeModelVersionId must have an active,
      // verified ModelEndpoint OWNED by the caller — no cross-user borrow
      // (same rule as POST /api/evaluations's resolveJudgeVersionIds and
      // src/lib/run-launch.ts's requireOwnedActiveEndpoints).
      const owned = await prisma.modelEndpoint.findMany({
        where: {
          userId: session.user.id,
          judgeModelVersionId: { in: data.judgeModelVersionIds },
          isActive: true,
          verifiedAt: { not: null },
        },
        select: { judgeModelVersionId: true },
      });
      const covered = new Set(owned.map((e) => e.judgeModelVersionId));
      if (data.judgeModelVersionIds.some((id) => !covered.has(id))) {
        return NextResponse.json(
          {
            error:
              'One or more selected judge models have no active, verified endpoint configured for you. ' +
              'Configure your own endpoint on the Models page.',
          },
          { status: 400 }
        );
      }
    }

    const evaluation = await prisma.$transaction(async (tx: any) => {
      await tx.evaluation.update({
        where: { id: params.id },
        data: {
          ...(data.rubricId !== undefined ? { rubricId: data.rubricId } : {}),
        },
      });

      if (data.judgeModelVersionIds !== undefined) {
        await tx.evaluationModelSelection.deleteMany({ where: { evaluationId: params.id } });
        if (data.judgeModelVersionIds.length > 0) {
          await tx.evaluationModelSelection.createMany({
            data: [...new Set(data.judgeModelVersionIds)].map((judgeModelVersionId) => ({
              evaluationId: params.id,
              judgeModelVersionId,
            })),
          });
        }
      }

      return tx.evaluation.findUnique({
        where: { id: params.id },
        include: {
          rubric: { include: { criteria: { orderBy: { order: 'asc' } } } },
          project: { select: { id: true, name: true } },
          // A1, same disposition as the GET above — the PATCH response
          // re-renders the same page.
          dataset: { select: { id: true, name: true, sampleCount: true, tombstone: tombstoneFlagSelect } },
          datasetSample: {
            select: { id: true, index: true, input: true, expected: true, ...sampleTombstoneFlagSelect },
          },
          modelSelections: {
            include: {
              modelConfig: {
                select: { id: true, name: true, provider: true, modelId: true, isActive: true, isVerified: true },
              },
              judgeModelVersion: { select: judgeModelVersionDisplaySelect },
            },
            orderBy: { createdAt: 'asc' },
          },
          runs: { include: runSummaryInclude, orderBy: { createdAt: 'desc' } },
        },
      });
    });

    if (!evaluation) {
      return NextResponse.json({ error: 'Evaluation not found' }, { status: 404 });
    }
    return NextResponse.json(withLiveCorpusRefs(evaluation));
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Validation failed', details: error.errors }, { status: 400 });
    }
    logger.error('Failed to update evaluation', { error: serializeError(error) });
    return NextResponse.json({ error: 'Failed to update evaluation' }, { status: 500 });
  }
}

// DELETE /api/evaluations/[id]
export async function DELETE(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;
  const scopeCheck = requireScope(session, 'evaluations:write');
  if (scopeCheck) return scopeCheck;

  try {
    const existing = await prisma.evaluation.findUnique({
      where: { id: params.id },
      select: { userId: true },
    });
    if (!existing) return NextResponse.json({ error: 'Evaluation not found' }, { status: 404 });
    if (existing.userId !== session.user.id && !isAdmin(session)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    await prisma.evaluation.delete({ where: { id: params.id } });
    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error('Failed to delete evaluation', { error: serializeError(error) });
    return NextResponse.json({ error: 'Failed to delete evaluation' }, { status: 500 });
  }
}
