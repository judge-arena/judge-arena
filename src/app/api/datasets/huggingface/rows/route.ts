import { NextResponse } from 'next/server';
import { requireAuth, requireScope } from '@/lib/auth-guard';
import {
  fetchFirstRows,
  fetchRows,
  parseHuggingFaceUrl,
} from '@/lib/huggingface';
import { logger, serializeError } from '@/lib/logger';

/**
 * GET /api/datasets/huggingface/rows
 *
 * Fetch row data from a HuggingFace dataset split.
 * Query params:
 *   - id: HuggingFace dataset ID (e.g. "livecodebench/code_generation_lite")
 *   - url: HuggingFace dataset URL (alternative to id)
 *   - config: dataset config name (required)
 *   - split: split name (required)
 *   - offset: row offset (default 0)
 *   - length: number of rows (default 10, max 100)
 *   - preview: if "true", uses /first-rows endpoint for column discovery
 */
export async function GET(request: Request) {
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;
  const scopeCheck = requireScope(session, 'datasets:read');
  if (scopeCheck) return scopeCheck;

  const { searchParams } = new URL(request.url);
  const url = searchParams.get('url');
  const idParam = searchParams.get('id');
  const config = searchParams.get('config');
  const split = searchParams.get('split');
  const preview = searchParams.get('preview') === 'true';
  const offset = parseInt(searchParams.get('offset') ?? '0', 10);
  const length = Math.min(parseInt(searchParams.get('length') ?? '10', 10), 100);

  let datasetId = idParam;
  if (!datasetId && url) {
    datasetId = parseHuggingFaceUrl(url);
  }

  if (!datasetId) {
    return NextResponse.json(
      { error: 'Provide a HuggingFace dataset ID or URL' },
      { status: 400 }
    );
  }

  if (!config || !split) {
    return NextResponse.json(
      { error: 'config and split are required' },
      { status: 400 }
    );
  }

  try {
    if (preview) {
      const data = await fetchFirstRows(datasetId, config, split);
      return NextResponse.json({
        features: data.features,
        rows: data.rows.slice(0, 5), // Return just a few rows for preview
        totalPreviewRows: data.rows.length,
      });
    }

    const data = await fetchRows(datasetId, config, split, offset, length);
    return NextResponse.json({
      features: data.features,
      rows: data.rows,
      numRowsTotal: data.num_rows_total,
      numRowsPerPage: data.num_rows_per_page,
      partial: data.partial,
    });
  } catch (error) {
    logger.error('Failed to fetch HF dataset rows', { error: serializeError(error) });
    const message = error instanceof Error ? error.message : 'Failed to fetch dataset rows';
    const normalizedMessage =
      message.includes('404 {"error":"Not found."}')
        ? 'HuggingFace row access is unavailable for this dataset/config/split. This usually means the dataset viewer is disabled or the dataset requires a custom loading script, so remote evaluation cannot read rows from it.'
        : message;
    return NextResponse.json(
      {
        error: normalizedMessage,
      },
      { status: 502 }
    );
  }
}
