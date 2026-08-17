import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireAuth, requireScope, isAdmin } from '@/lib/auth-guard';
import { fetchDatasetMetadata } from '@/lib/huggingface';
import { buildRefreshUpdate } from '@/lib/dataset-refresh-update';
import { logger, serializeError } from '@/lib/logger';
import { liveDatasetsOnly, liveSamplesOnly } from '@/lib/tombstones';

// POST /api/datasets/[id]/refresh - Refresh metadata from remote source
export async function POST(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;
  const scopeCheck = requireScope(session, 'datasets:write');
  if (scopeCheck) return scopeCheck;

  try {
    // Decision 15: refresh persists a new `sampleCount` and new remote
    // metadata, so it is a write and a hidden dataset must 404 before the
    // HuggingFace fetch runs — and before the `Only remote HuggingFace
    // datasets can be refreshed` 400 below, which would otherwise tell the
    // caller a hidden dataset exists.
    const dataset = await prisma.dataset.findFirst({
      where: { id: params.id, ...liveDatasetsOnly() },
      include: {
        // A1: the LIVE sample count. This value is handed to
        // `buildRefreshUpdate` below and its result is PERSISTED into
        // `Dataset.sampleCount` — so the stored row count is fixed for free
        // by filtering here, and only by filtering here. That write needed no
        // change of its own precisely because of this line.
        _count: { select: { samples: { where: liveSamplesOnly() } } },
      },
    });

    if (!dataset) {
      return NextResponse.json(
        { error: 'Dataset not found' },
        { status: 404 }
      );
    }
    if (dataset.userId !== session.user.id && !isAdmin(session)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    if (dataset.source !== 'remote' || !dataset.huggingFaceId) {
      return NextResponse.json(
        { error: 'Only remote HuggingFace datasets can be refreshed' },
        { status: 400 }
      );
    }

    const meta = await fetchDatasetMetadata(dataset.huggingFaceId);
    const refreshUpdate = buildRefreshUpdate(
      dataset.remoteMetadata,
      meta,
      dataset._count.samples
    );

    const updated = await prisma.dataset.update({
      where: { id: params.id },
      data: {
        description: meta.description,
        remoteMetadata: refreshUpdate.remoteMetadata,
        sampleCount: refreshUpdate.sampleCount,
        splits: JSON.stringify(meta.splits),
        features: JSON.stringify(meta.features),
        tags: JSON.stringify(meta.tags),
      },
      include: {
        user: { select: { id: true, name: true, email: true } },
        project: { select: { id: true, name: true } },
        // A1: the LIVE sample count in the response the client re-renders
        // from, matching the value just persisted above.
        _count: { select: { samples: { where: liveSamplesOnly() } } },
      },
    });

    return NextResponse.json(updated);
  } catch (error) {
    logger.error('Failed to refresh dataset metadata', { error: serializeError(error) });
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Failed to refresh metadata',
      },
      { status: 500 }
    );
  }
}
