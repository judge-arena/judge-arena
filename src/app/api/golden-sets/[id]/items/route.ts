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
import {
  isGoldenSetFrozen,
  GoldenSetFrozenError,
  GoldenSetNotInCirculationError,
  assertGoldenSetInCirculation,
  goldenItemLifecycleWhere,
  goldenSetLifecycleWhere,
  parseIncludeRetired,
  parseIncludeTombstoned,
  GOLDEN_LABEL_TOMBSTONE_REASON_CONTENT_EDIT,
} from '@/lib/golden-sets';
import {
  updateGoldenItemsSchema,
  deleteGoldenItemsSchema,
  notInCirculationResponse,
} from '../../shared';

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

    const { searchParams } = new URL(request.url);

    // Same predicate as the detail route, in the same place (the `where`, not
    // a post-fetch check), and for the same reason: if this route kept
    // serving a retired set's 620 rows, the detail route's 404 would be
    // decoration — anything wanting the content would just ask here instead.
    const includeRetired = parseIncludeRetired(searchParams);

    const goldenSet = await prisma.goldenSet.findFirst({
      where: { id: params.id, ...goldenSetLifecycleWhere(includeRetired) },
      select: { id: true, ownerId: true, visibility: true },
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

    const { limit, cursor } = parsePaginationParams(searchParams);
    const pageArgs = buildPrismaPageArgs({ limit, cursor });

    // The escape is OWNER/ADMIN ONLY. An item tombstone is a product verb —
    // the owner curating their own set — so the owner has to be able to see
    // what they removed. A public reader of a public set has no such claim,
    // and passing the flag is ignored rather than refused: a 403 here would
    // leak that the set has tombstoned items at all.
    const includeTombstoned =
      decision.access === 'owner' && parseIncludeTombstoned(searchParams);
    const where = {
      goldenSetId: params.id,
      ...goldenItemLifecycleWhere(includeTombstoned),
    };

    const [items, total] = await Promise.all([
      prisma.goldenItem.findMany({
        where,
        include: { candidates: { orderBy: { position: 'asc' } } },
        orderBy: { index: 'asc' },
        ...pageArgs,
      }),
      // Identical `where`, or the pagination total contradicts the page.
      prisma.goldenItem.count({ where }),
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
// TOMBSTONES LABELS ON REAL CONTENT CHANGES — it does not delete them.
// `forkGoldenSet` (src/lib/golden-set-versions.ts) copies GoldenLabel rows
// unconditionally: a fork has no edits to compare against, so decision #5's
// "copy, except on edited items" clause cannot fire there, and that module's
// doc names THIS handler as the owner of the exception. An item whose
// inputText, promptText, responseText or expected actually changes value has
// its GoldenLabel rows tombstoned in the same transaction as the edit, so an
// annotator's score is never left APPLYING to text they did not see. A field
// present in the request but equal to the item's current value is not a
// change and leaves labels alone — a no-op retry PATCH must not invalidate
// real annotation work.
//
// WHY TOMBSTONE RATHER THAN DELETE (owner ruling 2026-08-13, extended to
// labels — flagged for confirmation in the task that landed it): a human
// label is the expensive, irreplaceable artifact this roadmap exists to
// protect. An LLM verdict re-runs for pennies; an annotator's score cannot be
// re-obtained once that person moves on. Retaining the row preserves WHO
// scored WHAT, and `tombstonedAt` — stamped once per request, shared by every
// label the request invalidates — pins it to a specific edit event.
//
// KNOWN GAP, NOT PAPERED OVER: this does not preserve the TEXT the annotator
// saw. The update below overwrites the item's content in place and there is
// no item-content history, so "which version of the text" is recoverable only
// as "whatever it was immediately before the edit at tombstonedAt". Closing
// that means versioning item content, which belongs with the staged/published
// dataset identity work, not here.
//
// ALSO LIFECYCLE-GUARDED, closing the gap recorded when this handler landed:
// GET filtered `retiredAt`/`tombstonedAt` from the start and these verbs did
// not, so a retired set's items were unreadable through the API and still
// freely editable through it. See assertGoldenSetInCirculation in
// src/lib/golden-sets.ts — it moved out of this file once PATCH
// /api/golden-sets/[id] and the fork route needed the same rule.
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
      await assertGoldenSetInCirculation(tx, params.id);

      const current = await tx.goldenItem.findMany({
        where: {
          id: { in: data.items.map((i) => i.id) },
          goldenSetId: params.id,
          ...goldenItemLifecycleWhere(false),
        },
        select: { id: true, inputText: true, promptText: true, responseText: true, expected: true },
      });
      if (current.length !== data.items.length) {
        throw new ForeignItemError();
      }
      const currentById = new Map(current.map((row) => [row.id, row]));
      const editedAt = new Date();

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
          // One instant for the whole request, so every label invalidated by
          // this edit carries the same timestamp and reads as one event.
          await tx.goldenLabel.updateMany({
            where: { goldenItemId: item.id, tombstonedAt: null },
            data: {
              tombstonedAt: editedAt,
              tombstonedReason: GOLDEN_LABEL_TOMBSTONE_REASON_CONTENT_EDIT,
            },
          });
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
    if (error instanceof GoldenSetNotInCirculationError) {
      return notInCirculationResponse(error);
    }
    if (error instanceof ForeignItemError) {
      return NextResponse.json(
        { error: 'Some items do not belong to this golden set, or have been tombstoned' },
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

// DELETE /api/golden-sets/[id]/items — TOMBSTONE, never a row delete (owner
// ruling 2026-08-13: no actual data removal, anywhere). `tombstonedAt` is
// stamped in the SAME transaction as the freeze check, so a calibration run
// that starts mid-request cannot straddle the two.
//
// THERE IS NO RE-INDEX ANY MORE, AND THAT IS THE POINT. The old handler
// deleted the rows and then renumbered the survivors 0..n-1, because
// @@unique([goldenSetId, index]) makes a gap a constraint problem on the next
// insert rather than a cosmetic one. A tombstone removes nothing, so no gap
// ever opens: every ordinal is still occupied, by a mix of live and
// tombstoned rows. Re-packing on top of that is not merely unnecessary, it is
// guaranteed to abort — renumbering the first survivor to 0 collides with the
// tombstoned row still holding 0 (P2002) and rolls the transaction back. It
// would also destroy the one thing the retained row is FOR: a stable ordinal
// recording where in the set the removed item sat.
//
// The next index for a set is therefore a HIGH-WATER MARK, not a count — see
// `nextGoldenItemIndex` in src/lib/golden-sets.ts.
//
// GoldenLabel/GoldenCandidate cascade off GoldenItem (onDelete: Cascade), and
// those FKs now never fire from this path. They are kept as the mechanism the
// purge wave will use if destruction is ever authorised. Neither child gets a
// flag of its own: both are reachable only through their item, so the item
// filter is the complete filter. (GoldenLabel DOES carry `tombstonedAt`, but
// for the other reason — PATCH can invalidate a label while its item stays
// live. See that handler.)
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
      await assertGoldenSetInCirculation(tx, params.id);

      // NOT lifecycle-filtered, deliberately: an already-tombstoned id still
      // belongs to this set, so a retried DELETE must be an idempotent no-op
      // rather than a 400 claiming the item is foreign.
      const owned = await tx.goldenItem.findMany({
        where: { id: { in: data.itemIds }, goldenSetId: params.id },
        select: { id: true },
      });
      if (owned.length !== data.itemIds.length) {
        throw new ForeignItemError();
      }

      const tombstoned = await tx.goldenItem.updateMany({
        where: { id: { in: data.itemIds }, goldenSetId: params.id, tombstonedAt: null },
        data: { tombstonedAt: new Date() },
      });

      const remaining = await tx.goldenItem.count({
        where: { goldenSetId: params.id, ...goldenItemLifecycleWhere(false) },
      });

      // `deleted` is renamed to `tombstoned` on purpose. A caller still
      // reading `deleted` gets `undefined` and breaks loudly, rather than
      // silently reporting 0 removals for an operation that did happen.
      return { tombstoned: tombstoned.count, remaining };
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
    if (error instanceof GoldenSetNotInCirculationError) {
      return notInCirculationResponse(error);
    }
    if (error instanceof ForeignItemError) {
      return NextResponse.json(
        { error: 'Some items do not belong to this golden set, or have been tombstoned' },
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
    super('Some items do not belong to this golden set, or have been tombstoned');
    this.name = 'ForeignItemError';
  }
}

/* `GoldenSetNotInCirculationError`, `assertGoldenSetInCirculation` and
 * `notInCirculationResponse` used to live here, module-local. They moved to
 * src/lib/golden-sets.ts and ../../shared.ts respectively once PATCH
 * /api/golden-sets/[id] and the fork route needed the same rule: a tombstoned
 * set's METADATA stayed owner-editable while its ITEMS were frozen here, which
 * is the same asymmetry this guard closes, one level up. One definition of "in
 * circulation", three callers. */
