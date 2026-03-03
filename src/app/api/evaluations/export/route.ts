import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireAuth, isAdmin } from '@/lib/auth-guard';
import {
  flattenEvaluationForExport,
  toCsv,
  toJsonl,
  csvResponse,
  jsonlResponse,
} from '@/lib/export';

/**
 * Shared Prisma include for full evaluation + run + judgment data.
 * This mirrors the shape expected by `flattenEvaluationForExport`.
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
 * GET /api/evaluations/export?format=csv|jsonl&projectId=...&datasetId=...
 *
 * Export all evaluations the caller has access to (optionally filtered)
 * as a denormalized CSV or JSONL.
 *
 * Each row = one model judgment per run. Human-only runs still get a row.
 * Evaluations with zero runs still get a row so no data is lost.
 *
 * Columns: evaluation_id, evaluation_title, project_name, dataset_name,
 * dataset_sample_index, input_text, prompt_text, response_text,
 * rubric_name, rubric_version, run_id, run_status, run_created_at,
 * triggered_by, model_name, model_provider, model_id,
 * model_judgment_status, model_overall_score, model_reasoning,
 * model_raw_response, model_criteria_scores, model_latency_ms,
 * model_token_count, human_overall_score, human_reasoning,
 * human_criteria_scores, human_selected_best_model
 */
export async function GET(request: Request) {
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;

  const { searchParams } = new URL(request.url);
  const format = (searchParams.get('format') ?? 'csv').toLowerCase();
  const projectId = searchParams.get('projectId');
  const datasetId = searchParams.get('datasetId');

  if (format !== 'csv' && format !== 'jsonl') {
    return NextResponse.json(
      { error: 'Unsupported format. Use ?format=csv or ?format=jsonl' },
      { status: 400 }
    );
  }

  try {
    const where: Record<string, unknown> = {};
    if (projectId) where.projectId = projectId;
    if (datasetId) where.datasetId = datasetId;
    if (!isAdmin(session)) where.userId = session.user.id;

    const evaluations = await prisma.evaluation.findMany({
      where,
      include: fullEvaluationInclude,
      orderBy: { createdAt: 'asc' },
    });

    const rows = evaluations.flatMap((evaluation: any) =>
      flattenEvaluationForExport(evaluation)
    );

    const timestamp = new Date().toISOString().slice(0, 10);
    let filename = `evaluations_export_${timestamp}`;
    if (projectId) filename = `project_evaluations_${timestamp}`;
    if (datasetId) filename = `dataset_evaluations_${timestamp}`;

    if (format === 'jsonl') {
      return jsonlResponse(toJsonl(rows), `${filename}.jsonl`);
    }
    return csvResponse(toCsv(rows), `${filename}.csv`);
  } catch (error) {
    console.error('Evaluation export failed:', error);
    return NextResponse.json(
      { error: 'Failed to export evaluations' },
      { status: 500 }
    );
  }
}
