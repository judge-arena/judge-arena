import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireAuth, requireScope, isAdmin } from '@/lib/auth-guard';
import { rabbitHealthy } from '@/lib/queue/connection';
import { logger, serializeError } from '@/lib/logger';

// GET /api/stats - Dashboard statistics
export async function GET() {
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;
  const scopeCheck = requireScope(session, 'stats:read');
  if (scopeCheck) return scopeCheck;

  try {
    const userFilter = isAdmin(session) ? {} : { userId: session.user.id };
    const runFilter = isAdmin(session) ? {} : { triggeredById: session.user.id };
    // ModelJudgment has no owning-user column of its own — it inherits
    // ownership from its parent EvaluationRun's triggeredById, same as
    // every other run-scoped count below.
    const judgmentRunFilter = isAdmin(session) ? {} : { run: { triggeredById: session.user.id } };

    const [
      totalProjects,
      totalEvaluations,
      completedRuns,
      pendingRuns,
      activeModels,
      totalRubrics,
      totalDatasets,
      judgingRuns,
      pendingJudgments,
      runningJudgments,
      queueHealthy,
    ] = await Promise.all([
      prisma.project.count({ where: userFilter }),
      prisma.evaluation.count({ where: userFilter }),
      // Runs (not templates) are what have a status
      prisma.evaluationRun.count({ where: { status: 'completed', ...runFilter } }),
      prisma.evaluationRun.count({ where: { status: { in: ['pending', 'judging'] }, ...runFilter } }),
      // Task 12: ModelConfig is write-retired — ModelEndpoint is the live
      // per-user "configured model" count now.
      prisma.modelEndpoint.count({ where: { ...userFilter, isActive: true } }),
      prisma.rubric.count({ where: userFilter }),
      prisma.dataset.count({
        where: isAdmin(session)
          ? {}
          : { OR: [{ userId: session.user.id }, { visibility: 'public' }] },
      }),
      // ── Queue-backed counts (replaces the retired in-process
      // getQueueStats() — src/lib/evaluation-run-manager.ts's module-level
      // queue/activeIds were deleted in Task 9; these are now real DB state,
      // not process-local, so they're accurate across multiple web/worker
      // replicas. ──
      prisma.evaluationRun.count({ where: { status: 'judging', ...runFilter } }),
      prisma.modelJudgment.count({ where: { status: 'pending', ...judgmentRunFilter } }),
      prisma.modelJudgment.count({ where: { status: 'running', ...judgmentRunFilter } }),
      rabbitHealthy(),
    ]);

    return NextResponse.json({
      totalProjects,
      totalEvaluations,
      completedEvaluations: completedRuns,
      pendingEvaluations: pendingRuns,
      activeModels,
      totalRubrics,
      totalDatasets,
      queue: {
        pendingRuns,
        judgingRuns,
        pendingJudgments,
        runningJudgments,
        rabbitHealthy: queueHealthy,
      },
    });
  } catch (error) {
    logger.error('Failed to fetch stats', { error: serializeError(error) });
    return NextResponse.json(
      { error: 'Failed to fetch stats' },
      { status: 500 }
    );
  }
}
