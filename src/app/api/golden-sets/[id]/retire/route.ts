import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { z } from 'zod';
import { requireAuth, requireScope, requireOwnership } from '@/lib/auth-guard';
import { logger, serializeError } from '@/lib/logger';
import { retireGoldenSetSchema, goldenSetInclude } from '../../shared';

// POST /api/golden-sets/[id]/retire — the first `retiredAt` writer with a
// product meaning: out of circulation, still valid ground truth (distinct
// from `tombstonedAt`, which is pending purge). NOT freeze-guarded —
// retirement is not something a calibration run measured, and every read path
// already filters it, so this button is visible rather than a no-op.
export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;
  const scopeCheck = requireScope(session, 'golden-sets:write');
  if (scopeCheck) return scopeCheck;

  try {
    const ownershipError = await requireOwnership('goldenSet', params.id, session);
    if (ownershipError) return ownershipError;

    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      raw = {};
    }
    const data = retireGoldenSetSchema.parse(
      raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
    );

    const goldenSet = await prisma.goldenSet.update({
      where: { id: params.id },
      data: { retiredAt: data.retired ? new Date() : null },
      include: goldenSetInclude,
    });

    return NextResponse.json(goldenSet);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Validation failed', details: error.errors },
        { status: 400 }
      );
    }
    logger.error('Failed to retire golden set', { error: serializeError(error) });
    return NextResponse.json({ error: 'Failed to retire golden set' }, { status: 500 });
  }
}
