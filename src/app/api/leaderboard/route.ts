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
import { resolveModelDisplay } from '@/lib/model-display';
import { toPublicLeaderboardEntry } from '@/lib/serializers';

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
//     maybeFinalizeRun in src/lib/run-finalizer.ts, which sets this once no
//     judgments remain pending/running and at least one completed) — the
//     run may still be awaiting a human judgment, but its ModelJudgment
//     rows are already final and won't change.
//   - 'completed': the same, plus a human judgment has since been recorded
//     on top (needs_human -> completed transition in the human-judgment
//     route) — ModelJudgment rows are unchanged by that transition.
//   - 'pending' / 'judging' are pre-finalization (no judgments yet, or the
//     automatic pass is still in flight) — correctly excluded.
//   - 'error' is set by maybeFinalizeRun (src/lib/run-finalizer.ts) when no
//     judgments remain pending/running and none completed (all errored, or
//     zero judgments at all). Excluded here as a deliberate conservative
//     choice — an all-error run has no usable scores to aggregate anyway.
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
            // Task 12: every judgment the current write path creates has
            // modelConfig === null — this join is the identity source for
            // those rows. See src/lib/model-display.ts's resolveModelDisplay.
            judgeModelVersion: {
              select: {
                id: true,
                ordinal: true,
                servingBackend: true,
                judgeModel: { select: { id: true, name: true, baseModel: true } },
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
      // Task 12: modelConfig is null on every judgment the current write
      // path creates — judgeModelVersion/judgeModel is the identity source
      // for those. A judgment with NEITHER join (data integrity issue, not
      // a normal runtime condition) is excluded rather than crashing the
      // route — resolveModelDisplay's 'unknown' sentinel.
      if (j.modelConfig === null && j.judgeModelVersion === null) continue;

      const display = resolveModelDisplay(j);
      const key = display.id;
      let entry = modelMap.get(key);
      if (!entry) {
        entry = {
          modelName: display.name,
          provider: display.provider,
          providerModelId: display.modelId,
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

    // Route through the shared public serializer (src/lib/serializers.ts)
    // — a no-op allow-list today (this response already carries no PII),
    // but it names the public shape and keeps this route covered by the
    // same serializer test suite as the visibility-gated public reads.
    const publicModels = models.map(toPublicLeaderboardEntry);

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
      models: publicModels,
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
