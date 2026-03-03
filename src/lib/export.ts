/**
 * ─── Data Export Utilities ─────────────────────────────────────────────────
 *
 * Production-quality export helpers for datasets, evaluations, and runs.
 * Designed for open-source portability — users should be able to take
 * *all* of their data with them in standards-compliant CSV or JSONL.
 *
 * CSV follows RFC 4180: fields containing commas, quotes, or newlines are
 * double-quoted with internal quotes escaped as "".
 *
 * JSONL follows the JSON Lines standard (https://jsonlines.org/) — one
 * valid JSON object per line, newline-delimited.
 */

/* ─── CSV helpers ──────────────────────────────────────────────────────── */

/** Escape a single value for RFC 4180 CSV */
export function escapeCsvField(value: unknown): string {
  if (value === null || value === undefined) return '';
  const str = typeof value === 'object' ? JSON.stringify(value) : String(value);
  // Quote if the field contains commas, quotes, or newlines
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/** Convert an array of flat objects into a CSV string (with header row) */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toCsv(rows: Array<Record<string, any>>): string {
  if (rows.length === 0) return '';

  // Collect all unique keys across rows, preserving insertion order
  const columnSet = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      columnSet.add(key);
    }
  }
  const columns = Array.from(columnSet);

  const header = columns.map(escapeCsvField).join(',');
  const body = rows
    .map((row) => columns.map((col) => escapeCsvField(row[col])).join(','))
    .join('\n');

  return `${header}\n${body}\n`;
}

/* ─── JSONL helpers ────────────────────────────────────────────────────── */

/** Convert an array of objects to JSONL (one JSON object per line) */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toJsonl(rows: Array<Record<string, any>>): string {
  return rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
}

/* ─── Dataset sample export ────────────────────────────────────────────── */

export interface DatasetSampleExportRow {
  sample_index: number;
  input: string;
  expected: string;
  metadata: string;
}

/**
 * Flatten a dataset sample (from Prisma) into a portable export row.
 * Metadata is serialized as a JSON string for CSV and kept as-is for JSONL.
 */
export function flattenDatasetSample(sample: {
  index: number;
  input: string;
  expected: string | null;
  metadata: string | null;
}): DatasetSampleExportRow {
  return {
    sample_index: sample.index,
    input: sample.input,
    expected: sample.expected ?? '',
    metadata: sample.metadata ?? '',
  };
}

/* ─── Evaluation / Run export ──────────────────────────────────────────── */

export interface EvaluationExportRow {
  evaluation_id: string;
  evaluation_title: string;
  project_id: string;
  project_name: string;
  dataset_name: string;
  dataset_sample_index: string;
  input_text: string;
  prompt_text: string;
  response_text: string;
  rubric_name: string;
  rubric_version: string;
  run_id: string;
  run_status: string;
  run_created_at: string;
  triggered_by: string;
  model_name: string;
  model_provider: string;
  model_id: string;
  model_judgment_status: string;
  model_overall_score: string;
  model_reasoning: string;
  model_raw_response: string;
  model_criteria_scores: string;
  model_latency_ms: string;
  model_token_count: string;
  human_overall_score: string;
  human_reasoning: string;
  human_criteria_scores: string;
  human_selected_best_model: string;
}

/**
 * Flatten a fully-loaded evaluation (with nested runs, judgments, etc.)
 * into one row *per model judgment per run*.
 *
 * If a run has no model judgments at all, we still emit one row so the run
 * metadata is captured (e.g. human-only evaluations).
 *
 * This produces a denormalized, wide-format table ideal for CSV analysis.
 */
export function flattenEvaluationForExport(evaluation: {
  id: string;
  title: string | null;
  inputText: string;
  promptText?: string | null;
  responseText?: string | null;
  project?: { id: string; name: string } | null;
  rubric?: { id: string; name: string; version?: number } | null;
  dataset?: { id: string; name: string } | null;
  datasetSample?: { id: string; index: number } | null;
  runs: Array<{
    id: string;
    status: string;
    createdAt: string | Date;
    triggeredBy?: { name: string | null; email: string } | null;
    rubric?: { name: string; version?: number } | null;
    modelJudgments: Array<{
      status: string;
      overallScore: number | null;
      reasoning: string | null;
      rawResponse: string | null;
      criteriaScores: string | null;
      latencyMs: number | null;
      tokenCount: number | null;
      modelConfig: { name: string; provider: string; modelId?: string };
    }>;
    humanJudgment?: {
      overallScore: number;
      reasoning?: string | null;
      criteriaScores?: string | null;
      selectedBestModelId?: string | null;
    } | null;
  }>;
}): EvaluationExportRow[] {
  const rows: EvaluationExportRow[] = [];

  for (const run of evaluation.runs) {
    const runRubric = run.rubric ?? evaluation.rubric;
    const human = run.humanJudgment;
    const triggeredBy =
      run.triggeredBy?.name || run.triggeredBy?.email || '';

    const baseRow: Omit<
      EvaluationExportRow,
      | 'model_name'
      | 'model_provider'
      | 'model_id'
      | 'model_judgment_status'
      | 'model_overall_score'
      | 'model_reasoning'
      | 'model_raw_response'
      | 'model_criteria_scores'
      | 'model_latency_ms'
      | 'model_token_count'
    > = {
      evaluation_id: evaluation.id,
      evaluation_title: evaluation.title ?? '',
      project_id: evaluation.project?.id ?? '',
      project_name: evaluation.project?.name ?? '',
      dataset_name: evaluation.dataset?.name ?? '',
      dataset_sample_index:
        evaluation.datasetSample != null
          ? String(evaluation.datasetSample.index + 1)
          : '',
      input_text: evaluation.inputText ?? '',
      prompt_text: evaluation.promptText ?? '',
      response_text: evaluation.responseText ?? '',
      rubric_name: runRubric?.name ?? '',
      rubric_version: runRubric?.version != null ? String(runRubric.version) : '',
      run_id: run.id,
      run_status: run.status,
      run_created_at:
        typeof run.createdAt === 'string'
          ? run.createdAt
          : run.createdAt.toISOString(),
      triggered_by: triggeredBy,
      human_overall_score: human?.overallScore != null ? String(human.overallScore) : '',
      human_reasoning: human?.reasoning ?? '',
      human_criteria_scores: human?.criteriaScores ?? '',
      human_selected_best_model: human?.selectedBestModelId ?? '',
    };

    if (run.modelJudgments.length === 0) {
      // Human-only run — emit one row with empty model columns
      rows.push({
        ...baseRow,
        model_name: '',
        model_provider: '',
        model_id: '',
        model_judgment_status: '',
        model_overall_score: '',
        model_reasoning: '',
        model_raw_response: '',
        model_criteria_scores: '',
        model_latency_ms: '',
        model_token_count: '',
      });
    } else {
      for (const judgment of run.modelJudgments) {
        rows.push({
          ...baseRow,
          model_name: judgment.modelConfig.name,
          model_provider: judgment.modelConfig.provider,
          model_id: judgment.modelConfig.modelId ?? '',
          model_judgment_status: judgment.status,
          model_overall_score:
            judgment.overallScore != null ? String(judgment.overallScore) : '',
          model_reasoning: judgment.reasoning ?? '',
          model_raw_response: judgment.rawResponse ?? '',
          model_criteria_scores: judgment.criteriaScores ?? '',
          model_latency_ms:
            judgment.latencyMs != null ? String(judgment.latencyMs) : '',
          model_token_count:
            judgment.tokenCount != null ? String(judgment.tokenCount) : '',
        });
      }
    }
  }

  // If evaluation has zero runs, still emit one row so the template data is exported
  if (evaluation.runs.length === 0) {
    rows.push({
      evaluation_id: evaluation.id,
      evaluation_title: evaluation.title ?? '',
      project_id: evaluation.project?.id ?? '',
      project_name: evaluation.project?.name ?? '',
      dataset_name: evaluation.dataset?.name ?? '',
      dataset_sample_index:
        evaluation.datasetSample != null
          ? String(evaluation.datasetSample.index + 1)
          : '',
      input_text: evaluation.inputText ?? '',
      prompt_text: evaluation.promptText ?? '',
      response_text: evaluation.responseText ?? '',
      rubric_name: evaluation.rubric?.name ?? '',
      rubric_version:
        evaluation.rubric?.version != null
          ? String(evaluation.rubric.version)
          : '',
      run_id: '',
      run_status: '',
      run_created_at: '',
      triggered_by: '',
      model_name: '',
      model_provider: '',
      model_id: '',
      model_judgment_status: '',
      model_overall_score: '',
      model_reasoning: '',
      model_raw_response: '',
      model_criteria_scores: '',
      model_latency_ms: '',
      model_token_count: '',
      human_overall_score: '',
      human_reasoning: '',
      human_criteria_scores: '',
      human_selected_best_model: '',
    });
  }

  return rows;
}

/* ─── HTTP response helpers ────────────────────────────────────────────── */

/** Build a Response object for a CSV file download */
export function csvResponse(csv: string, filename: string): Response {
  // Prepend UTF-8 BOM so Excel detects encoding correctly
  const bom = '\uFEFF';
  return new Response(bom + csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${sanitizeFilename(filename)}"`,
      'Cache-Control': 'no-store',
    },
  });
}

/** Build a Response object for a JSONL file download */
export function jsonlResponse(jsonl: string, filename: string): Response {
  return new Response(jsonl, {
    status: 200,
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Content-Disposition': `attachment; filename="${sanitizeFilename(filename)}"`,
      'Cache-Control': 'no-store',
    },
  });
}

/** Sanitize a string for safe use in Content-Disposition filenames */
function sanitizeFilename(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 200);
}
