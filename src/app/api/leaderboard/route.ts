/**
 * ─── Public Leaderboard API ──────────────────────────────────────────────
 *
 * Aggregates model scores from the default (leaderboard) project.
 * This endpoint is intentionally public — no authentication required.
 * It only exposes aggregate statistics, never raw evaluation content.
 */

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

interface ModelLeaderboardEntry {
  modelId: string;
  modelName: string;
  provider: string;
  providerModelId: string;
  avgScore: number;
  medianScore: number;
  minScore: number;
  maxScore: number;
  evaluationCount: number;
  completedRuns: number;
}

export async function GET() {
  try {
    // Find the default (leaderboard) project
    const leaderboardProject = await prisma.project.findFirst({
      where: { isDefault: true },
      select: { id: true, name: true, description: true },
    });

    if (!leaderboardProject) {
      return NextResponse.json({
        project: null,
        models: [],
        lastUpdated: null,
        message: 'No leaderboard project configured. An admin must create a project with isDefault=true.',
      });
    }

    // Fetch all completed model judgments from this project's evaluations
    const judgments = await prisma.modelJudgment.findMany({
      where: {
        status: 'completed',
        overallScore: { not: null },
        run: {
          evaluation: {
            projectId: leaderboardProject.id,
          },
        },
      },
      select: {
        overallScore: true,
        latencyMs: true,
        modelConfig: {
          select: {
            id: true,
            name: true,
            provider: true,
            modelId: true,
          },
        },
      },
    });

    // Aggregate by model
    const modelMap = new Map<string, {
      modelName: string;
      provider: string;
      providerModelId: string;
      scores: number[];
      latencies: number[];
    }>();

    for (const j of judgments) {
      if (j.overallScore === null) continue;

      const key = j.modelConfig.id;
      let entry = modelMap.get(key);
      if (!entry) {
        entry = {
          modelName: j.modelConfig.name,
          provider: j.modelConfig.provider,
          providerModelId: j.modelConfig.modelId,
          scores: [],
          latencies: [],
        };
        modelMap.set(key, entry);
      }
      entry.scores.push(j.overallScore);
      if (j.latencyMs !== null) {
        entry.latencies.push(j.latencyMs);
      }
    }

    // Build sorted leaderboard entries
    const models: ModelLeaderboardEntry[] = [];
    for (const [modelId, data] of modelMap) {
      const sorted = [...data.scores].sort((a, b) => a - b);
      const avg = sorted.reduce((sum, s) => sum + s, 0) / sorted.length;
      const mid = Math.floor(sorted.length / 2);
      const median = sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[mid];

      models.push({
        modelId,
        modelName: data.modelName,
        provider: data.provider,
        providerModelId: data.providerModelId,
        avgScore: Math.round(avg * 100) / 100,
        medianScore: Math.round(median * 100) / 100,
        minScore: sorted[0],
        maxScore: sorted[sorted.length - 1],
        evaluationCount: sorted.length,
        completedRuns: sorted.length,
      });
    }

    // Sort by avg score descending
    models.sort((a, b) => b.avgScore - a.avgScore);

    // Get the most recent judgment timestamp for "last updated"
    const lastJudgment = judgments.length > 0
      ? await prisma.modelJudgment.findFirst({
          where: {
            status: 'completed',
            run: { evaluation: { projectId: leaderboardProject.id } },
          },
          orderBy: { createdAt: 'desc' },
          select: { createdAt: true },
        })
      : null;

    // Count total evaluations in the leaderboard project
    const totalEvaluations = await prisma.evaluation.count({
      where: { projectId: leaderboardProject.id },
    });

    return NextResponse.json({
      project: {
        id: leaderboardProject.id,
        name: leaderboardProject.name,
        description: leaderboardProject.description,
      },
      models,
      totalEvaluations,
      totalJudgments: judgments.length,
      lastUpdated: lastJudgment?.createdAt ?? null,
    });
  } catch (error) {
    console.error('Leaderboard API error:', error);
    return NextResponse.json(
      { error: 'Failed to load leaderboard data' },
      { status: 500 }
    );
  }
}
