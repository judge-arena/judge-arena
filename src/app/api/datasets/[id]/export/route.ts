import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireAuth, isAdmin } from '@/lib/auth-guard';
import {
  flattenDatasetSample,
  toCsv,
  toJsonl,
  csvResponse,
  jsonlResponse,
} from '@/lib/export';

/**
 * GET /api/datasets/[id]/export?format=csv|jsonl
 *
 * Export all samples of a dataset as CSV or JSONL.
 * Includes every column the user entered: index, input, expected, metadata.
 * For local datasets this recreates the original data file.
 */
export async function GET(
  request: Request,
  { params }: { params: { id: string } }
) {
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;

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

    // Access check: owner, admin, or public
    if (
      dataset.userId !== session.user.id &&
      !isAdmin(session) &&
      dataset.visibility !== 'public'
    ) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

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
    console.error('Dataset export failed:', error);
    return NextResponse.json(
      { error: 'Failed to export dataset' },
      { status: 500 }
    );
  }
}
