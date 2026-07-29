import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireScope, optionalAuth, resolveResourceAccess } from '@/lib/auth-guard';
import {
  flattenDatasetSample,
  toCsv,
  toJsonl,
  csvResponse,
  jsonlResponse,
} from '@/lib/export';
import { logger, serializeError } from '@/lib/logger';

/**
 * GET /api/datasets/[id]/export?format=csv|jsonl
 *
 * Export all samples of a dataset as CSV or JSONL.
 * Includes every column the user entered: index, input, expected, metadata.
 * For local datasets this recreates the original data file.
 */
export async function GET(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const session = await optionalAuth();
  if (session) {
    const scopeCheck = requireScope(session, 'datasets:export');
    if (scopeCheck) return scopeCheck;
  }

  const { searchParams } = new URL(request.url);
  const format = (searchParams.get('format') ?? 'csv').toLowerCase();

  if (format !== 'csv' && format !== 'jsonl') {
    return NextResponse.json(
      { error: 'Unsupported format. Use ?format=csv or ?format=jsonl' },
      { status: 400 }
    );
  }

  try {
    const dataset = await prisma.dataset.findUnique({
      where: { id: params.id },
      include: {
        samples: { orderBy: { index: 'asc' } },
      },
    });

    if (!dataset) {
      return NextResponse.json({ error: 'Dataset not found' }, { status: 404 });
    }

    // Sample rows carry no owner PII of their own — the export itself
    // needs no separate serializer, just the same visibility gate as
    // GET /api/datasets/[id].
    const decision = resolveResourceAccess(session, dataset.userId, dataset.visibility === 'public');
    if ('error' in decision) return decision.error;

    const rows = dataset.samples.map(flattenDatasetSample);
    const safeName = dataset.name.replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 60);
    const timestamp = new Date().toISOString().slice(0, 10);

    if (format === 'jsonl') {
      // For JSONL, expand metadata back into the record for richer output
      const jsonlRows = dataset.samples.map((sample) => {
        const base: Record<string, unknown> = {
          sample_index: sample.index,
          input: sample.input,
          expected: sample.expected ?? '',
        };
        if (sample.metadata) {
          try {
            const meta = JSON.parse(sample.metadata);
            if (meta && typeof meta === 'object') {
              base.metadata = meta;
            }
          } catch {
            base.metadata = sample.metadata;
          }
        }
        return base;
      });
      return jsonlResponse(
        toJsonl(jsonlRows),
        `${safeName}_samples_${timestamp}.jsonl`
      );
    }

    return csvResponse(toCsv(rows), `${safeName}_samples_${timestamp}.csv`);
  } catch (error) {
    logger.error('Dataset export failed', { error: serializeError(error) });
    return NextResponse.json(
      { error: 'Failed to export dataset' },
      { status: 500 }
    );
  }
}
