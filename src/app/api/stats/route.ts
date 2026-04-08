import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireAuth, requireScope, isAdmin } from '@/lib/auth-guard';
import { logger, serializeError } from '@/lib/logger';

// GET /api/stats - Dashboard statistics
export async function GET() {
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;
  const scopeCheck = requireScope(session, 'stats:read');
  if (scopeCheck) return scopeCheck;

  try {
    const userFilter = isAdmin(session) ? {} : { userId: session.user.id };

    const [
      totalProjects,
      totalEvaluations,
      completedRuns,
      pendingRuns,
      activeModels,
      totalRubrics,
      totalDatasets,
    ] = await Promise.all([
      prisma.project.count({ where: userFilter }),
      prisma.evaluation.count({ where: userFilter }),
      // Runs (not templates) are what have a status
      prisma.evaluationRun.count({
        where: {
          status: 'completed',
          ...(isAdmin(session) ? {} : { triggeredById: session.user.id }),
        },
      }),
      prisma.evaluationRun.count({
        where: {
          status: { in: ['pending', 'judging'] },
          ...(isAdmin(session) ? {} : { triggeredById: session.user.id }),
        },
      }),
      prisma.modelConfig.count({ where: { ...userFilter, isActive: true } }),
      prisma.rubric.count({ where: userFilter }),
      prisma.dataset.count({
        where: isAdmin(session)
          ? {}
          : { OR: [{ userId: session.user.id }, { visibility: 'public' }] },
      }),
    ]);

    return NextResponse.json({
      totalProjects,
      totalEvaluations,
      completedEvaluations: completedRuns,
      pendingEvaluations: pendingRuns,
      activeModels,
      totalRubrics,
      totalDatasets,
    });
  } catch (error) {
    logger.error('Failed to fetch stats', { error: serializeError(error) });
    return NextResponse.json(
      { error: 'Failed to fetch stats' },
      { status: 500 }
    );
  }
}
