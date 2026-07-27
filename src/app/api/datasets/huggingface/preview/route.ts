import { NextResponse } from 'next/server';
import { requireAuth, requireScope } from '@/lib/auth-guard';
import {
  fetchDatasetMetadata,
  parseHuggingFaceUrl,
} from '@/lib/huggingface';
import { huggingfaceLimiter } from '@/lib/rate-limit-redis';
import { rateLimitHeaders, HUGGINGFACE_LIMIT } from '@/lib/rate-limit';
import { getClientIp } from '@/lib/client-ip';
import { logger, serializeError } from '@/lib/logger';

// GET /api/datasets/huggingface/preview?url=...&id=...
// Preview metadata for a HuggingFace dataset before creating it
export async function GET(request: Request) {
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;
  const scopeCheck = requireScope(session, 'datasets:read');
  if (scopeCheck) return scopeCheck;

  // Proxies an upstream HuggingFace API that has its own rate limits —
  // apply a tighter limiter on top of the general `api` chokepoint already
  // enforced inside requireAuth().
  const clientIp = getClientIp(request.headers);
  const rateResult = await huggingfaceLimiter.check(clientIp);
  if (!rateResult.ok) {
    return NextResponse.json(
      { error: 'Too many HuggingFace requests. Please slow down.' },
      { status: 429, headers: rateLimitHeaders(rateResult, HUGGINGFACE_LIMIT) }
    );
  }

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
    logger.error('Failed to fetch HF dataset preview', { error: serializeError(error) });
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
