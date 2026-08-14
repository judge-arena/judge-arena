import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireAuth, requireScope, isAdmin } from '@/lib/auth-guard';
import {
  flattenEvaluationForExport,
  flattenDatasetSample,
  toCsv,
  toJsonl,
  csvResponse,
  jsonlResponse,
} from '@/lib/export';
import { logger, serializeError } from '@/lib/logger';
import { liveDatasetsOnly, liveSamplesOnly } from '@/lib/tombstones';

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
export async function GET(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;
  const scopeCheck = requireScope(session, 'projects:export');
  if (scopeCheck) return scopeCheck;

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
          // A1, read 1 of 2 in this file.
          //
          // THIS FILTER CHANGES NO OUTPUT TODAY, and saying so is the point.
          // The consumer below is `flatMap(ds => ds.samples.map(…))` — one row
          // per SAMPLE, never a per-dataset row — and a hidden dataset already
          // yields zero live samples through the `dataset:` parent arm of
          // `liveSamplesOnly()`. So it already contributed nothing.
          //
          // It is here because that coverage is INDIRECT: it holds only while
          // `liveSamplesOnly()` keeps a parent arm (decision 16). Narrow that
          // arm — a plausible future change, since it is the one clause in the
          // helper that is about a DIFFERENT table than the filter names — and
          // this read starts exporting a withdrawn corpus silently, with no
          // test failing anywhere near here. Stating the requirement at the
          // level this route is actually about costs one predicate and does
          // not depend on the other helper's shape.
          //
          // Contrast `config/export/route.ts`, where the same filter is NOT
          // redundant: that consumer emits a dataset entry regardless of
          // samples, so an unfiltered read there exports a hidden dataset that
          // re-imports as a fresh live row.
          where: { projectId: params.id, ...liveDatasetsOnly() },
          include: { samples: { where: liveSamplesOnly(), orderBy: { index: 'asc' } } },
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
      // The SECOND of two textually identical reads in this file — this one in
      // the `scope=datasets` branch, the other in the `scope=all` JSONL branch
      // above. Filtering one and not the other is invisible to anything that
      // exercises a single branch, so both carry the filter.
      //
      // BOTH CARRY A TEST FOR THE **SAMPLE** FILTER (the Task 8 block in
      // tests/db/dataset-sample-tombstone.test.ts drives each branch
      // separately). The DATASET filter added beside it has no test on either
      // branch, and cannot easily have one, for the reason spelled out above
      // the first read: it changes no output while `liveSamplesOnly()` keeps
      // its parent arm. It is defence in depth, not a behaviour.
      const datasets = await prisma.dataset.findMany({
        // A1, read 2 of 2 in this file: same rule on the datasets scope, and
        // the same "no output change today" disposition.
        where: { projectId: params.id, ...liveDatasetsOnly() },
        include: { samples: { where: liveSamplesOnly(), orderBy: { index: 'asc' } } },
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
    logger.error('Project export failed', { error: serializeError(error) });
    return NextResponse.json(
      { error: 'Failed to export project data' },
      { status: 500 }
    );
  }
}
