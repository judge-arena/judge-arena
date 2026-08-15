import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireAuth, requireScope, isAdmin } from '@/lib/auth-guard';
import { logger, serializeError } from '@/lib/logger';
import { sampleTombstoneFlagSelect, tombstoneFlagSelect, withLiveCorpusRefs } from '@/lib/tombstones';

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
      // A1: to-ONE args take no `where`; the marker rides along and
      // `withLiveCorpusRefs` nulls the sub-object at the response. The run
      // detail page renders `{dataset.name} #{datasetSample.index + 1}`, so
      // unfiltered this named a withdrawn row by its ordinal — and this select
      // carries `input`/`expected` as well.
      dataset: { select: { id: true, name: true, sampleCount: true, tombstone: tombstoneFlagSelect } },
      datasetSample: {
        select: { id: true, index: true, input: true, expected: true, ...sampleTombstoneFlagSelect },
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

    return NextResponse.json({ ...run, evaluation: withLiveCorpusRefs(run.evaluation) });
  } catch (error) {
    logger.error('Failed to fetch run', { error: serializeError(error) });
    return NextResponse.json({ error: 'Failed to fetch run' }, { status: 500 });
  }
}
