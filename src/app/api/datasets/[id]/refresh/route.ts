import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireAuth, requireScope, isAdmin } from '@/lib/auth-guard';
import { fetchDatasetMetadata } from '@/lib/huggingface';
import { buildRefreshUpdate } from '@/lib/dataset-refresh-update';
import { logger, serializeError } from '@/lib/logger';

// POST /api/datasets/[id]/refresh - Refresh metadata from remote source
export async function POST(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;
  const scopeCheck = requireScope(session, 'datasets:write');
  if (scopeCheck) return scopeCheck;

  try {
    const dataset = await prisma.dataset.findUnique({
      where: { id: params.id },
      include: {
        _count: { select: { samples: true } },
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
        _count: { select: { samples: true } },
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
