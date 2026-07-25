/**
 * ─── Public Leaderboard API ──────────────────────────────────────────────
 *
 * Aggregates model scores from the default (leaderboard) project.
 * This endpoint is intentionally public — no authentication required.
 * It only exposes aggregate statistics, never raw evaluation content.
 */

import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { logger, serializeError } from '@/lib/logger';

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

// Run statuses whose ModelJudgment rows are eligible to count toward the
// leaderboard aggregate. A run's judgments only become "final" once its
// automatic judging pass has finished:
//   - 'needs_human': every model judgment has been attempted (see
//     processRun in evaluation-run-manager.ts, which sets this once the
//     per-model loop completes with at least one 'completed' judgment) —
//     the run may still be awaiting a human judgment, but its ModelJudgment
//     rows are already final and won't change.
//   - 'completed': the same, plus a human judgment has since been recorded
//     on top (needs_human -> completed transition in the human-judgment
//     route) — ModelJudgment rows are unchanged by that transition.
//   - 'pending' / 'judging' are pre-finalization (no judgments yet, or the
//     automatic pass is still in flight) — correctly excluded.
//   - 'error' is set via two paths in processRun (evaluation-run-manager.ts):
//     Primary: `completedCount === 0 && errorCount > 0` (no judgments attempted
//     successfully). Secondary (crash window): outer catch after completed
//     judgments already persisted — if the final status update fails, we retry
//     with 'error' while judgments remain. This is excluded here as a deliberate
//     conservative choice — 1b's reaper/finalization rework closes the crash
//     window. The primary-path invariant (mixed results → needs_human, pure error
//     → error) is what we rely on; excluding 'error' avoids accidentally counting
//     crash-window runs with partial results.
const FINALIZED_RUN_STATUSES = ['completed', 'needs_human'] as const;

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

    // Per evaluation, only the LATEST finalized run's judgments count — a
    // re-run must not double-count the earlier run's judgments alongside
    // the new one (same rule the importer's reconciliation spot-check
    // documents). "Latest" = max(createdAt) per evaluationId; "finalized"
    // = FINALIZED_RUN_STATUSES above. Raw SQL for DISTINCT ON: there's no
    // direct Prisma query-builder equivalent for "latest row per group".
    // `status` is a Postgres enum column — cast to text before comparing
    // against string literals to avoid any literal/enum inference surprises.
    const latestFinalizedRuns = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT DISTINCT ON (er."evaluationId") er.id
      FROM "EvaluationRun" er
      JOIN "Evaluation" e ON e.id = er."evaluationId"
      WHERE e."projectId" = ${leaderboardProject.id}
        AND er.status::text IN (${Prisma.join(FINALIZED_RUN_STATUSES)})
      ORDER BY er."evaluationId", er."createdAt" DESC, er."id" DESC
    `;
    const finalizedRunIds = latestFinalizedRuns.map((run) => run.id);

    // Fetch all completed model judgments, scoped to only those
    // latest-finalized runs (population change — same shape as before).
    const judgments = finalizedRunIds.length === 0
      ? []
      : await prisma.modelJudgment.findMany({
          where: {
            status: 'completed',
            overallScore: { not: null },
            runId: { in: finalizedRunIds },
          },
          select: {
            overallScore: true,
            latencyMs: true,
            createdAt: true,
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

    // Get the most recent judgment timestamp for "last updated" — derived
    // from the exact same population already fetched above (the latest
    // finalized run per evaluation), never a separately-scoped query that
    // could disagree with what's actually being aggregated.
    let lastUpdated: Date | null = null;
    for (const j of judgments) {
      if (!lastUpdated || j.createdAt > lastUpdated) lastUpdated = j.createdAt;
    }

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
      lastUpdated,
    });
  } catch (error) {
    logger.error('Leaderboard API error', { error: serializeError(error) });
    return NextResponse.json(
      { error: 'Failed to load leaderboard data' },
      { status: 500 }
    );
  }
}
