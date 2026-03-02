import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth-guard';
import {
  fetchDatasetMetadata,
  parseHuggingFaceUrl,
} from '@/lib/huggingface';

// GET /api/datasets/huggingface/preview?url=...&id=...
// Preview metadata for a HuggingFace dataset before creating it
export async function GET(request: Request) {
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;

  const { searchParams } = new URL(request.url);
  const url = searchParams.get('url');
  const id = searchParams.get('id');

  let datasetId = id;

  if (!datasetId && url) {
    datasetId = parseHuggingFaceUrl(url);
  }

  if (!datasetId) {
    return NextResponse.json(
      {
        error:
          'Provide a HuggingFace dataset ID (org/name) or a huggingface.co/datasets/... URL',
      },
      { status: 400 }
    );
  }

  try {
    const metadata = await fetchDatasetMetadata(datasetId);
    return NextResponse.json(metadata);
  } catch (error) {
    console.error('Failed to fetch HF dataset preview:', error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Failed to fetch dataset metadata',
      },
      { status: 404 }
    );
  }
}
