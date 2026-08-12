import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { z } from 'zod';
import { requireAuth, requireScope, requireOwnership } from '@/lib/auth-guard';
import { logger, serializeError } from '@/lib/logger';
import { forkGoldenSet, GoldenSetVersionConflictError } from '@/lib/golden-set-versions';
import { forkGoldenSetSchema } from '../../shared';

// POST /api/golden-sets/[id]/fork — the escape hatch a frozen set offers.
// Version numbering, slug derivation and the nested item/candidate create all
// live in src/lib/golden-set-versions.ts, structurally identical to
// src/lib/dataset-versions.ts:127-228 (one transaction, bounded P2002 retry).
export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;
  const scopeCheck = requireScope(session, 'golden-sets:write');
  if (scopeCheck) return scopeCheck;

  try {
    const ownershipError = await requireOwnership('goldenSet', params.id, session);
    if (ownershipError) return ownershipError;

    const existing = await prisma.goldenSet.findUnique({
      where: { id: params.id },
      select: { id: true, parentId: true, name: true, description: true },
    });
    if (!existing) {
      return NextResponse.json({ error: 'Golden set not found' }, { status: 404 });
    }

    // Body is optional — same tolerance as POST /api/datasets/[id]/versions
    // (datasets/[id]/versions/route.ts:46-52): no body, empty body, or
    // invalid JSON all fall back to the source set's name/description.
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      raw = {};
    }
    const data = forkGoldenSetSchema.parse(
      raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
    );

    const forked = await forkGoldenSet(prisma, {
      // The whole family shares ONE parentId — the root — so version numbers
      // stay comparable instead of chaining v3 off v2.
      rootGoldenSetId: existing.parentId ?? existing.id,
      sourceGoldenSetId: existing.id,
      ownerId: session.user.id,
      name: data.name ?? existing.name,
      description: data.description !== undefined ? data.description : existing.description,
    });

    return NextResponse.json(forked, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Validation failed', details: error.errors },
        { status: 400 }
      );
    }
    if (error instanceof GoldenSetVersionConflictError) {
      logger.error('Golden set version conflict exhausted retries', {
        error: serializeError(error),
      });
      return NextResponse.json(
        {
          error:
            'Failed to fork golden set due to concurrent updates. Please try again.',
        },
        { status: 500 }
      );
    }
    logger.error('Failed to fork golden set', { error: serializeError(error) });
    return NextResponse.json({ error: 'Failed to fork golden set' }, { status: 500 });
  }
}
