import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { z } from 'zod';
import { requireAuth, requireScope, isAdmin, optionalAuth, resolveResourceAccess, RateLimitedError } from '@/lib/auth-guard';
import { logger, serializeError } from '@/lib/logger';
import { createVersionSchema } from './schema';
import { createDatasetVersion, DatasetVersionConflictError } from '@/lib/dataset-versions';

// POST /api/datasets/[id]/versions — create a new version from the current dataset
export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;
  const scopeCheck = requireScope(session, 'datasets:write');
  if (scopeCheck) return scopeCheck;

  try {
    const existing = await prisma.dataset.findUnique({
      where: { id: params.id },
      include: {
        samples: { orderBy: { index: 'asc' } },
      },
    });

    if (!existing) {
      return NextResponse.json(
        { error: 'Dataset not found' },
        { status: 404 }
      );
    }

    if (existing.userId !== session.user.id && !isAdmin(session)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Find the root dataset (original) for this version chain
    const rootId = existing.parentId ?? existing.id;

    // Optionally accept modified samples with the new version; otherwise
    // fall back to copying the prior version's samples verbatim.
    let newSamples = existing.samples.map((s) => ({
      input: s.input,
      expected: s.expected,
      metadata: s.metadata,
    }));
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      // No body, empty body, or invalid JSON — fall back to copying prior samples.
      body = {};
    }

    // Only validate and use samples if the key is present in a request body
    // that is actually an object (guards against `null`, arrays, strings,
    // numbers, etc. which would throw on the `in` check below).
    if (body && typeof body === 'object' && !Array.isArray(body) && 'samples' in body) {
      const data = createVersionSchema.parse(body);
      if (data.samples) {
        newSamples = data.samples.map((s) => ({
          input: s.input,
          expected: s.expected ?? null,
          metadata: s.metadata ? JSON.stringify(s.metadata) : null,
        }));
      }
    }

    // Transactional version numbering + retry lives in
    // src/lib/dataset-versions.ts — mirrors createRubricVersion's fix for
    // the same unguarded max-version-read-then-create race (1a flag M5).
    const newVersion = await createDatasetVersion(prisma, {
      rootDatasetId: rootId,
      userId: session.user.id,
      name: existing.name,
      description: existing.description,
      source: existing.source,
      visibility: existing.visibility,
      inputType: existing.inputType,
      sourceUrl: existing.sourceUrl,
      huggingFaceId: existing.huggingFaceId,
      remoteMetadata: existing.remoteMetadata,
      format: existing.format,
      localData: existing.localData,
      splits: existing.splits,
      features: existing.features,
      tags: existing.tags,
      projectId: existing.projectId,
      samples: newSamples,
    });

    return NextResponse.json(newVersion, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Validation failed', details: error.errors },
        { status: 400 }
      );
    }
    if (error instanceof DatasetVersionConflictError) {
      logger.error('Dataset version conflict exhausted retries', {
        error: serializeError(error),
      });
      return NextResponse.json(
        {
          error:
            'Failed to create dataset version due to concurrent updates. Please try again.',
        },
        { status: 500 }
      );
    }
    logger.error('Failed to create dataset version', { error: serializeError(error) });
    return NextResponse.json(
      { error: 'Failed to create dataset version' },
      { status: 500 }
    );
  }
}

// GET /api/datasets/[id]/versions — same access rule as GET
// /api/datasets/[id] (public if the dataset is visibility: 'public', else
// owner/admin only) AND the same requireScope('datasets:read') gate the
// sibling [id] route applies — this route previously skipped it, so a
// narrowly-scoped dev key (missing datasets:read) could read a private
// dataset's versions anyway.
export async function GET(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;

  try {
    const session = await optionalAuth();
    if (session) {
      const scopeCheck = requireScope(session, 'datasets:read');
      if (scopeCheck) return scopeCheck;
    }

    const dataset = await prisma.dataset.findUnique({
      where: { id: params.id },
      select: { id: true, parentId: true, userId: true, visibility: true },
    });

    if (!dataset) {
      return NextResponse.json(
        { error: 'Dataset not found' },
        { status: 404 }
      );
    }

    const decision = resolveResourceAccess(session, dataset.userId, dataset.visibility === 'public');
    if ('error' in decision) return decision.error;

    // Find the root
    const rootId = dataset.parentId ?? dataset.id;

    const versions = await prisma.dataset.findMany({
      where: {
        OR: [
          { id: rootId },
          { parentId: rootId },
        ],
      },
      select: {
        id: true,
        version: true,
        sampleCount: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { samples: true } },
      },
      orderBy: { version: 'desc' },
    });

    return NextResponse.json(versions);
  } catch (error) {
    if (error instanceof RateLimitedError) return error.response;
    logger.error('Failed to list dataset versions', { error: serializeError(error) });
    return NextResponse.json(
      { error: 'Failed to list versions' },
      { status: 500 }
    );
  }
}
