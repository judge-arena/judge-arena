import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireAuth, isAdmin } from '@/lib/auth-guard';
import {
  flattenEvaluationForExport,
  flattenDatasetSample,
  toCsv,
  toJsonl,
  csvResponse,
  jsonlResponse,
} from '@/lib/export';

/**
 * Full include for evaluation export (same as evaluations/export)
 */
const fullEvaluationInclude = {
  project: { select: { id: true, name: true } },
  rubric: { select: { id: true, name: true, version: true } },
  dataset: { select: { id: true, name: true } },
  datasetSample: { select: { id: true, index: true } },
  runs: {
    include: {
      rubric: { select: { id: true, name: true, version: true } },
      triggeredBy: { select: { id: true, name: true, email: true } },
      modelJudgments: {
        include: {
          modelConfig: {
            select: { id: true, name: true, provider: true, modelId: true },
          },
        },
        orderBy: { createdAt: 'asc' as const },
      },
      humanJudgment: true,
    },
    orderBy: { createdAt: 'desc' as const },
  },
} as const;

/**
 * GET /api/projects/[id]/export?format=csv|jsonl&scope=evaluations|datasets|all
 *
 * Export project data:
 *   scope=evaluations (default) — all evaluations with runs/judgments
 *   scope=datasets               — all dataset samples linked to this project
 *   scope=all                    — ZIP-like concatenated export (evaluations then datasets)
 *
 * In "all" mode for CSV we produce a single file with evaluations data since
 * CSV can only have one table. For JSONL we use a `_type` discriminator field.
 */
export async function GET(
  request: Request,
  { params }: { params: { id: string } }
) {
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;

  const { searchParams } = new URL(request.url);
  const format = (searchParams.get('format') ?? 'csv').toLowerCase();
  const scope = (searchParams.get('scope') ?? 'evaluations').toLowerCase();

  if (format !== 'csv' && format !== 'jsonl') {
    return NextResponse.json(
      { error: 'Unsupported format. Use ?format=csv or ?format=jsonl' },
      { status: 400 }
    );
  }

  try {
    // Verify project access
    const project = await prisma.project.findUnique({
      where: { id: params.id },
      select: { id: true, name: true, userId: true },
    });

    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }
    if (project.userId !== session.user.id && !isAdmin(session)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const safeName = project.name.replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 40);
    const timestamp = new Date().toISOString().slice(0, 10);

    // ── Evaluations scope ──
    if (scope === 'evaluations' || scope === 'all') {
      const evaluations = await prisma.evaluation.findMany({
        where: { projectId: params.id },
        include: fullEvaluationInclude,
        orderBy: { createdAt: 'asc' },
      });

      const evalRows = evaluations.flatMap((evaluation: any) =>
        flattenEvaluationForExport(evaluation)
      );

      if (scope === 'evaluations') {
        const filename = `${safeName}_evaluations_${timestamp}`;
        if (format === 'jsonl') {
          return jsonlResponse(toJsonl(evalRows), `${filename}.jsonl`);
        }
        return csvResponse(toCsv(evalRows), `${filename}.csv`);
      }

      // scope === 'all'
      if (format === 'jsonl') {
        // In JSONL mode, append dataset samples with a _type discriminator
        const datasets = await prisma.dataset.findMany({
          where: { projectId: params.id },
          include: { samples: { orderBy: { index: 'asc' } } },
        });

        const datasetRows = datasets.flatMap((ds) =>
          ds.samples.map((sample) => {
            const row = flattenDatasetSample(sample);
            return {
              _type: 'dataset_sample' as const,
              dataset_id: ds.id,
              dataset_name: ds.name,
              ...row,
            };
          })
        );

        const evalWithType = evalRows.map((r) => ({
          _type: 'evaluation' as const,
          ...r,
        }));

        return jsonlResponse(
          toJsonl([...evalWithType, ...datasetRows]),
          `${safeName}_full_export_${timestamp}.jsonl`
        );
      }

      // CSV all — evaluations only (CSV can't mix schemas cleanly)
      return csvResponse(
        toCsv(evalRows),
        `${safeName}_full_export_${timestamp}.csv`
      );
    }

    // ── Datasets scope ──
    if (scope === 'datasets') {
      const datasets = await prisma.dataset.findMany({
        where: { projectId: params.id },
        include: { samples: { orderBy: { index: 'asc' } } },
      });

      const rows = datasets.flatMap((ds) =>
        ds.samples.map((sample) => ({
          dataset_id: ds.id,
          dataset_name: ds.name,
          ...flattenDatasetSample(sample),
        }))
      );

      const filename = `${safeName}_datasets_${timestamp}`;
      if (format === 'jsonl') {
        return jsonlResponse(toJsonl(rows), `${filename}.jsonl`);
      }
      return csvResponse(toCsv(rows), `${filename}.csv`);
    }

    return NextResponse.json(
      { error: 'Invalid scope. Use evaluations, datasets, or all.' },
      { status: 400 }
    );
  } catch (error) {
    console.error('Project export failed:', error);
    return NextResponse.json(
      { error: 'Failed to export project data' },
      { status: 500 }
    );
  }
}
