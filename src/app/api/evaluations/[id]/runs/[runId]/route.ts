import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireAuth, requireScope, isAdmin } from '@/lib/auth-guard';
import { logger, serializeError } from '@/lib/logger';
import { liveDatasetsOnly, liveSamplesOnly } from '@/lib/tombstones';

// Task 12: minimal JudgeModelVersion+JudgeModel select for display fallback
// when modelConfig is null — see src/lib/model-display.ts.
const judgeModelVersionDisplaySelect = {
  id: true,
  ordinal: true,
  servingBackend: true,
  judgeModel: { select: { id: true, name: true, baseModel: true } },
} as const;

const runDetailInclude = {
  rubric: {
    include: { criteria: { orderBy: { order: 'asc' as const } } },
  },
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
      modelConfig: { select: { id: true, name: true, provider: true, modelId: true } },
      judgeModelVersion: { select: judgeModelVersionDisplaySelect },
    },
    orderBy: { createdAt: 'asc' as const },
  },
  humanJudgment: {
    include: { user: { select: { id: true, name: true, email: true } } },
  },
  evaluation: {
    select: {
      id: true,
      title: true,
      inputText: true,
      promptText: true,
      responseText: true,
      userId: true,
      project: { select: { id: true, name: true } },
      // A1: both are OPTIONAL to-ONE args and carry a `where`, so a hidden
      // reference comes back `null`. The run detail page renders
      // `{dataset.name} #{datasetSample.index + 1}`, so unfiltered this named a
      // withdrawn row by its ordinal — and this select carries
      // `input`/`expected` as well.
      dataset: { where: liveDatasetsOnly(), select: { id: true, name: true, sampleCount: true } },
      datasetSample: {
        where: liveSamplesOnly(),
        select: { id: true, index: true, input: true, expected: true },
      },
    },
  },
};

// GET /api/evaluations/[id]/runs/[runId]
export async function GET(
  _request: Request,
  props: { params: Promise<{ id: string; runId: string }> }
) {
  const params = await props.params;
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;
  const scopeCheck = requireScope(session, 'evaluations:read');
  if (scopeCheck) return scopeCheck;

  try {
    const run = await prisma.evaluationRun.findUnique({
      where: { id: params.runId },
      include: runDetailInclude,
    });

    if (!run) return NextResponse.json({ error: 'Run not found' }, { status: 404 });

    // Verify the run belongs to the specified evaluation
    if (run.evaluationId !== params.id) {
      return NextResponse.json({ error: 'Run not found' }, { status: 404 });
    }

    // Access control: owner or admin
    if (run.evaluation.userId !== session.user.id && !isAdmin(session)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Task 9 (spec §2): a permuted calibration run has exactly one sibling —
    // the other pairOrder at the same (calibrationRunId, goldenItemId), per
    // the DB's partial unique index (v2p). The list page
    // (src/app/evaluate/[id]/page.tsx) already collapses a full pair into
    // one AB/BA row, but a caller can still land directly on ONE run here
    // (a bookmarked link, a shared URL) — attach the sibling's minimal
    // display shape so this page doesn't look like a self-contained run when
    // it's actually half of a position-bias pair. `null` for every ordinary
    // run and for an unpaired calibration order (sibling not yet launched,
    // or its publish failed — see launch.ts's F4 doc).
    let pairedRun: {
      id: string;
      pairOrder: string | null;
      status: string;
      modelJudgments: Array<{ verdict: string | null; status: string }>;
    } | null = null;
    if (run.calibrationRunId && run.goldenItemId) {
      pairedRun = await prisma.evaluationRun.findFirst({
        where: {
          calibrationRunId: run.calibrationRunId,
          goldenItemId: run.goldenItemId,
          id: { not: run.id },
        },
        select: {
          id: true,
          pairOrder: true,
          status: true,
          modelJudgments: { select: { verdict: true, status: true }, orderBy: { createdAt: 'asc' } },
        },
      });
    }

    return NextResponse.json({ ...run, pairedRun });
  } catch (error) {
    logger.error('Failed to fetch run', { error: serializeError(error) });
    return NextResponse.json({ error: 'Failed to fetch run' }, { status: 500 });
  }
}
