import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { z } from 'zod';
import {
  requireAuth,
  requireScope,
  optionalAuth,
  resolveResourceAccess,
  requireOwnership,
  RateLimitedError,
} from '@/lib/auth-guard';
import { logger, serializeError } from '@/lib/logger';
import { toPublicGoldenSet } from '@/lib/serializers';
import { isGoldenSetFrozen, GoldenSetFrozenError } from '@/lib/golden-sets';
import { updateGoldenSetSchema, goldenSetInclude, goldenSetDetailInclude } from '../shared';

// GET /api/golden-sets/[id] — public if visibility: 'public' (PII-stripped
// via toPublicGoldenSet), else owner/admin only. Retired/tombstoned sets are
// 404 unless ?includeRetired=true.
export async function GET(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;

  try {
    const session = await optionalAuth();
    if (session) {
      const scopeCheck = requireScope(session, 'golden-sets:read');
      if (scopeCheck) return scopeCheck;
    }

    const goldenSet = await prisma.goldenSet.findUnique({
      where: { id: params.id },
      include: goldenSetDetailInclude,
    });

    if (!goldenSet) {
      return NextResponse.json({ error: 'Golden set not found' }, { status: 404 });
    }

    const decision = resolveResourceAccess(
      session,
      goldenSet.ownerId,
      goldenSet.visibility === 'public'
    );
    if ('error' in decision) return decision.error;

    // Run AFTER the access decision so a private set still 401/403s rather
    // than leaking "this id exists but is retired".
    const includeRetired = new URL(request.url).searchParams.get('includeRetired') === 'true';
    if (!includeRetired && (goldenSet.retiredAt || goldenSet.tombstonedAt)) {
      return NextResponse.json({ error: 'Golden set not found' }, { status: 404 });
    }

    if (decision.access === 'owner') {
      return NextResponse.json(goldenSet);
    }

    // Public view: PII-stripped core + the substrate fields a reader needs to
    // make sense of the items, plus the items themselves (GoldenItem/
    // GoldenCandidate join no user data — see the include above).
    return NextResponse.json({
      ...toPublicGoldenSet(goldenSet),
      datasetId: goldenSet.datasetId,
      protocol: goldenSet.protocol,
      slug: goldenSet.slug,
      version: goldenSet.version,
      parentId: goldenSet.parentId,
      items: goldenSet.items,
    });
  } catch (error) {
    if (error instanceof RateLimitedError) return error.response;
    logger.error('Failed to fetch golden set', { error: serializeError(error) });
    return NextResponse.json({ error: 'Failed to fetch golden set' }, { status: 500 });
  }
}

// PATCH /api/golden-sets/[id] — name/description/visibility are always
// editable; datasetId/protocol are CONTENT and are freeze-guarded. The freeze
// count and the update it guards share ONE transaction: separated, a
// calibration run started between them measures a set that changed underneath
// it, and nothing logs.
export async function PATCH(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;
  const scopeCheck = requireScope(session, 'golden-sets:write');
  if (scopeCheck) return scopeCheck;

  try {
    const ownershipError = await requireOwnership('goldenSet', params.id, session);
    if (ownershipError) return ownershipError;

    const body = await request.json();
    const data = updateGoldenSetSchema.parse(body);

    const touchesContent = data.datasetId !== undefined || data.protocol !== undefined;

    const goldenSet = await prisma.$transaction(async (tx) => {
      if (touchesContent && (await isGoldenSetFrozen(tx, params.id))) {
        throw new GoldenSetFrozenError(params.id);
      }

      return tx.goldenSet.update({
        where: { id: params.id },
        data: {
          ...(data.name !== undefined && { name: data.name }),
          ...(data.description !== undefined && { description: data.description }),
          ...(data.visibility !== undefined && { visibility: data.visibility }),
          ...(data.datasetId !== undefined && { datasetId: data.datasetId }),
          ...(data.protocol !== undefined && { protocol: data.protocol }),
        },
        include: goldenSetInclude,
      });
    });

    return NextResponse.json(goldenSet);
  } catch (error) {
    if (error instanceof GoldenSetFrozenError) {
      return NextResponse.json(
        {
          error: error.message,
          goldenSetId: error.goldenSetId,
          forkUrl: `/api/golden-sets/${error.goldenSetId}/fork`,
        },
        { status: 409 }
      );
    }
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Validation failed', details: error.errors },
        { status: 400 }
      );
    }
    logger.error('Failed to update golden set', { error: serializeError(error) });
    return NextResponse.json({ error: 'Failed to update golden set' }, { status: 500 });
  }
}

// DELETE /api/golden-sets/[id] — TOMBSTONE, not a row delete. `tombstonedAt`
// is the account-lifecycle verb (pending purge); `retiredAt` is the product
// verb (out of circulation, still valid ground truth). Purge is a later wave,
// deliberately: nothing is destroyed, so the Restrict on
// CalibrationRun.goldenSetId can never abort this.
export async function DELETE(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;
  const scopeCheck = requireScope(session, 'golden-sets:write');
  if (scopeCheck) return scopeCheck;

  try {
    const ownershipError = await requireOwnership('goldenSet', params.id, session);
    if (ownershipError) return ownershipError;

    await prisma.goldenSet.update({
      where: { id: params.id },
      data: { tombstonedAt: new Date() },
    });

    return NextResponse.json({ success: true, tombstoned: true });
  } catch (error) {
    logger.error('Failed to tombstone golden set', { error: serializeError(error) });
    return NextResponse.json({ error: 'Failed to delete golden set' }, { status: 500 });
  }
}
