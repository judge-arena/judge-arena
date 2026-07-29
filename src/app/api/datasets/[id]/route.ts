import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { z } from 'zod';
import { requireAuth, requireScope, optionalAuth, resolveResourceAccess, requireOwnership } from '@/lib/auth-guard';
import { logger, serializeError } from '@/lib/logger';
import { toPublicDataset } from '@/lib/serializers';

const updateDatasetSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(4000).optional(),
  visibility: z.enum(['private', 'public']).optional(),
  inputType: z.enum(['query', 'query-response']).optional(),
  projectId: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
});

// GET /api/datasets/[id] - Get a single dataset with samples. Public if
// visibility: 'public' (PII-stripped — src/lib/serializers.ts), else
// owner/admin only. Access matrix: tests/db/access-matrix.test.ts.
export async function GET(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const session = await optionalAuth();
  if (session) {
    const scopeCheck = requireScope(session, 'datasets:read');
    if (scopeCheck) return scopeCheck;
  }

  try {
    const dataset = await prisma.dataset.findUnique({
      where: { id: params.id },
      include: {
        user: { select: { id: true, name: true, email: true } },
        project: { select: { id: true, name: true } },
        samples: {
          orderBy: { index: 'asc' },
          take: 100,
        },
        versions: {
          select: { id: true, version: true, createdAt: true, sampleCount: true },
          orderBy: { version: 'desc' },
        },
        parent: {
          select: { id: true, version: true },
        },
        _count: { select: { samples: true } },
      },
    });

    if (!dataset) {
      return NextResponse.json(
        { error: 'Dataset not found' },
        { status: 404 }
      );
    }

    const decision = resolveResourceAccess(session, dataset.userId, dataset.visibility === 'public');
    if ('error' in decision) return decision.error;

    if (decision.access === 'owner') {
      return NextResponse.json(dataset);
    }

    // Public view: PII-stripped dataset core + the same samples/versions/
    // parent sub-objects (none of which join user data, so they're already
    // safe to pass through verbatim — see the GET include above).
    return NextResponse.json({
      ...toPublicDataset(dataset),
      samples: dataset.samples,
      versions: dataset.versions,
      parent: dataset.parent,
    });
  } catch (error) {
    logger.error('Failed to fetch dataset', { error: serializeError(error) });
    return NextResponse.json(
      { error: 'Failed to fetch dataset' },
      { status: 500 }
    );
  }
}

// PATCH /api/datasets/[id] - Update a dataset
export async function PATCH(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;
  const scopeCheck = requireScope(session, 'datasets:write');
  if (scopeCheck) return scopeCheck;

  try {
    const ownershipError = await requireOwnership('dataset', params.id, session);
    if (ownershipError) return ownershipError;

    const body = await request.json();
    const data = updateDatasetSchema.parse(body);

    const updateData: any = { ...data };
    if (data.tags) {
      updateData.tags = JSON.stringify(data.tags);
      delete updateData.tags;
      updateData.tags = JSON.stringify(data.tags);
    }

    const dataset = await prisma.dataset.update({
      where: { id: params.id },
      data: updateData,
      include: {
        user: { select: { id: true, name: true, email: true } },
        project: { select: { id: true, name: true } },
        _count: { select: { samples: true } },
      },
    });

    return NextResponse.json(dataset);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Validation failed', details: error.errors },
        { status: 400 }
      );
    }
    logger.error('Failed to update dataset', { error: serializeError(error) });
    return NextResponse.json(
      { error: 'Failed to update dataset' },
      { status: 500 }
    );
  }
}

// DELETE /api/datasets/[id]
export async function DELETE(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;
  const scopeCheck = requireScope(session, 'datasets:write');
  if (scopeCheck) return scopeCheck;

  try {
    const ownershipError = await requireOwnership('dataset', params.id, session);
    if (ownershipError) return ownershipError;

    await prisma.dataset.delete({ where: { id: params.id } });
    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error('Failed to delete dataset', { error: serializeError(error) });
    return NextResponse.json(
      { error: 'Failed to delete dataset' },
      { status: 500 }
    );
  }
}
