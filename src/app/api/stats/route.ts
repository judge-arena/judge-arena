import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireAuth, isAdmin } from '@/lib/auth-guard';

// GET /api/stats - Dashboard statistics
export async function GET() {
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;

  try {
    const userFilter = isAdmin(session) ? {} : { userId: session.user.id };

    const [
      totalProjects,
      totalEvaluations,
      completedEvaluations,
      pendingEvaluations,
      activeModels,
      totalRubrics,
    ] = await Promise.all([
      prisma.project.count({ where: userFilter }),
      prisma.evaluation.count({ where: userFilter }),
      prisma.evaluation.count({ where: { ...userFilter, status: 'completed' } }),
      prisma.evaluation.count({
        where: { ...userFilter, status: { in: ['pending', 'judging'] } },
      }),
      prisma.modelConfig.count({ where: { ...userFilter, isActive: true } }),
      prisma.rubric.count({ where: userFilter }),
    ]);

    return NextResponse.json({
      totalProjects,
      totalEvaluations,
      completedEvaluations,
      pendingEvaluations,
      activeModels,
      totalRubrics,
    });
  } catch (error) {
    console.error('Failed to fetch stats:', error);
    return NextResponse.json(
      { error: 'Failed to fetch stats' },
      { status: 500 }
    );
  }
}
