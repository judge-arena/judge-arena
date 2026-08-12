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
import { parsePaginationParams, buildPrismaPageArgs, paginatedJson } from '@/lib/pagination';
import { logger, serializeError } from '@/lib/logger';
import { isGoldenSetFrozen, GoldenSetFrozenError } from '@/lib/golden-sets';
import { updateGoldenItemsSchema, deleteGoldenItemsSchema } from '../../shared';

// GET /api/golden-sets/[id]/items — this route HAS a GET, which
// datasets/[id]/samples does not. That omission is exactly why a client-side
// import would fall back to the 100-capped detail route (GET
// /api/datasets/[id], `samples: { take: 100 }`) and silently truncate a
// 620-row set. Same visibility rule as GET /api/golden-sets/[id]: public if
// visibility: 'public', else owner/admin only.
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
      select: { id: true, ownerId: true, visibility: true, retiredAt: true, tombstonedAt: true },
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
    const { searchParams } = new URL(request.url);
    const includeRetired = searchParams.get('includeRetired') === 'true';
    if (!includeRetired && (goldenSet.retiredAt || goldenSet.tombstonedAt)) {
      return NextResponse.json({ error: 'Golden set not found' }, { status: 404 });
    }

    const { limit, cursor } = parsePaginationParams(searchParams);
    const pageArgs = buildPrismaPageArgs({ limit, cursor });

    const [items, total] = await Promise.all([
      prisma.goldenItem.findMany({
        where: { goldenSetId: params.id },
        include: { candidates: { orderBy: { position: 'asc' } } },
        orderBy: { index: 'asc' },
        ...pageArgs,
      }),
      prisma.goldenItem.count({ where: { goldenSetId: params.id } }),
    ]);

    // GoldenItem/GoldenCandidate join no user data, so there is no
    // serializer step here — see src/lib/serializers.ts's module doc.
    return paginatedJson(items, limit, total);
  } catch (error) {
    if (error instanceof RateLimitedError) return error.response;
    logger.error('Failed to fetch golden items', { error: serializeError(error) });
    return NextResponse.json({ error: 'Failed to fetch golden items' }, { status: 500 });
  }
}

// PATCH /api/golden-sets/[id]/items — item content is ALWAYS freeze-guarded,
// and the freeze count shares the mutation's transaction (isGoldenSetFrozen
// takes a Prisma.TransactionClient specifically so the two can never
// straddle a commit boundary).
//
// DROPS LABELS ON REAL CONTENT CHANGES. `forkGoldenSet`
// (src/lib/golden-set-versions.ts) copies GoldenLabel rows unconditionally —
// a fork has no edits to compare against, so decision #5's "copy, except on
// edited items" clause cannot fire there. That module's doc names THIS
// handler as the owner of the exception: an item whose inputText,
// promptText, responseText or expected actually changes value loses its
// GoldenLabel rows in the same transaction as the edit, so an annotator's
// score is never left attached to text they did not see. A field present in
// the request but equal to the item's current value is not a change, and
// leaves labels alone — a no-op retry PATCH must not invalidate real
// annotation work.
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
    const data = updateGoldenItemsSchema.parse(body);

    const updated = await prisma.$transaction(async (tx) => {
      if (await isGoldenSetFrozen(tx, params.id)) {
        throw new GoldenSetFrozenError(params.id);
      }

      const current = await tx.goldenItem.findMany({
        where: { id: { in: data.items.map((i) => i.id) }, goldenSetId: params.id },
        select: { id: true, inputText: true, promptText: true, responseText: true, expected: true },
      });
      if (current.length !== data.items.length) {
        throw new ForeignItemError();
      }
      const currentById = new Map(current.map((row) => [row.id, row]));

      for (const item of data.items) {
        const before = currentById.get(item.id)!;
        const contentChanged =
          (item.inputText !== undefined && item.inputText !== before.inputText) ||
          (item.promptText !== undefined && item.promptText !== before.promptText) ||
          (item.responseText !== undefined && item.responseText !== before.responseText) ||
          (item.expected !== undefined && item.expected !== before.expected);

        await tx.goldenItem.update({
          where: { id: item.id },
          data: {
            ...(item.inputText !== undefined && { inputText: item.inputText }),
            ...(item.promptText !== undefined && { promptText: item.promptText }),
            ...(item.responseText !== undefined && { responseText: item.responseText }),
            ...(item.expected !== undefined && { expected: item.expected }),
          },
        });

        if (contentChanged) {
          await tx.goldenLabel.deleteMany({ where: { goldenItemId: item.id } });
        }
      }

      return data.items.length;
    });

    return NextResponse.json({ updated });
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
    if (error instanceof ForeignItemError) {
      return NextResponse.json(
        { error: 'Some items do not belong to this golden set' },
        { status: 400 }
      );
    }
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Validation failed', details: error.errors },
        { status: 400 }
      );
    }
    logger.error('Failed to update golden items', { error: serializeError(error) });
    return NextResponse.json({ error: 'Failed to update golden items' }, { status: 500 });
  }
}

// DELETE /api/golden-sets/[id]/items — deletes then re-indexes the survivors
// 0..n-1 in the SAME transaction, because @@unique([goldenSetId, index])
// makes a gap a constraint problem on the next insert, not a cosmetic one.
// GoldenLabel/GoldenCandidate cascade off GoldenItem (onDelete: Cascade), so
// no explicit label cleanup is needed here — only PATCH can leave an item's
// id alive with different content underneath a stale label.
export async function DELETE(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;
  const scopeCheck = requireScope(session, 'golden-sets:write');
  if (scopeCheck) return scopeCheck;

  try {
    const ownershipError = await requireOwnership('goldenSet', params.id, session);
    if (ownershipError) return ownershipError;

    const body = await request.json();
    const data = deleteGoldenItemsSchema.parse(body);

    const result = await prisma.$transaction(async (tx) => {
      if (await isGoldenSetFrozen(tx, params.id)) {
        throw new GoldenSetFrozenError(params.id);
      }

      const owned = await tx.goldenItem.findMany({
        where: { id: { in: data.itemIds }, goldenSetId: params.id },
        select: { id: true },
      });
      if (owned.length !== data.itemIds.length) {
        throw new ForeignItemError();
      }

      await tx.goldenItem.deleteMany({
        where: { id: { in: data.itemIds }, goldenSetId: params.id },
      });

      const remaining = await tx.goldenItem.findMany({
        where: { goldenSetId: params.id },
        orderBy: { index: 'asc' },
        select: { id: true, index: true },
      });

      // Ascending order is load-bearing: survivors keep their relative order,
      // so every new index is <= its old one and no update can collide with a
      // row that has not been renumbered yet.
      for (const [newIndex, row] of remaining.entries()) {
        if (row.index !== newIndex) {
          await tx.goldenItem.update({ where: { id: row.id }, data: { index: newIndex } });
        }
      }

      return { deleted: data.itemIds.length, remaining: remaining.length };
    });

    return NextResponse.json(result);
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
    if (error instanceof ForeignItemError) {
      return NextResponse.json(
        { error: 'Some items do not belong to this golden set' },
        { status: 400 }
      );
    }
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Validation failed', details: error.errors },
        { status: 400 }
      );
    }
    logger.error('Failed to delete golden items', { error: serializeError(error) });
    return NextResponse.json({ error: 'Failed to delete golden items' }, { status: 500 });
  }
}

/** Thrown inside a transaction so a cross-set item id aborts the whole
 * mutation rather than silently updating/deleting a subset. Not exported —
 * Next.js 15 validates route.ts exports against a known allowlist
 * (GET/POST/PATCH/DELETE/.../config) and rejects arbitrary named exports. */
class ForeignItemError extends Error {
  constructor() {
    super('Some items do not belong to this golden set');
    this.name = 'ForeignItemError';
  }
}
