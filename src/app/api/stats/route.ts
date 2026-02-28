import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

// GET /api/stats - Dashboard statistics
export async function GET() {
  try {
    const [
      totalProjects,
      totalEvaluations,
      completedEvaluations,
      pendingEvaluations,
      activeModels,
      totalRubrics,
    ] = await Promise.all([
      prisma.project.count(),
      prisma.evaluation.count(),
      prisma.evaluation.count({ where: { status: 'completed' } }),
      prisma.evaluation.count({
        where: { status: { in: ['pending', 'judging'] } },
      }),
      prisma.modelConfig.count({ where: { isActive: true } }),
      prisma.rubric.count(),
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
