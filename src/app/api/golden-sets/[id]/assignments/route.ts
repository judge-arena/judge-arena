import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requireAuth, requireScope, isAdmin, type AuthSession } from '@/lib/auth-guard';
import { logger, serializeError } from '@/lib/logger';
import { goldenSetLifecycleWhere } from '@/lib/golden-sets';
import { mayHoldAssignment } from '@/lib/assignment-policy';

/**
 * A1 — `…/golden-sets/[id]/assignments`. WHO WAS ASKED to annotate WHAT.
 *
 * Overlap between annotators is what makes an inter-annotator number mean
 * anything, and without explicit assignment it is whatever coincides:
 * annotators self-select, easy items get their second reading first, and the
 * resulting kappa is optimistic in a way nothing in the system can detect.
 * These rows are how the overlap becomes designed instead.
 *
 * `DELETE` REVOKES. It never removes the row, because an assignment is a
 * record of what was asked — the same argument that makes an item DELETE a
 * tombstone and a label edit a revision, one layer up in the same phase. The
 * active-assignment unique index is partial (`WHERE "revokedAt" IS NULL`)
 * precisely so a revoked row cannot block reassigning that work.
 *
 * Access is owner-or-admin on the SET for every verb. Note that is a different
 * question from who may HOLD a row, which is `mayHoldAssignment` in
 * src/lib/assignment-policy.ts.
 */

const createAssignmentSchema = z.object({
  annotatorId: z.string().min(1),
  /** NULL / absent = the whole set. */
  goldenItemId: z.string().min(1).nullable().optional(),
  round: z.number().int().min(1).max(2).default(1),
});

const revokeAssignmentSchema = z.object({
  assignmentId: z.string().min(1),
  reason: z.string().max(500).optional(),
});

/** The one shape every verb here returns a row in. */
const assignmentSelect = {
  id: true,
  goldenSetId: true,
  goldenItemId: true,
  annotatorId: true,
  round: true,
  assignedById: true,
  assignedAt: true,
  completedAt: true,
  revokedAt: true,
  revokedReason: true,
} as const;

/**
 * Load the set and confirm the caller may coordinate it.
 *
 * `findFirst` + `goldenSetLifecycleWhere` rather than `requireOwnership`,
 * matching the sibling read in this directory: a retired or tombstoned set is
 * out of circulation, and handing out fresh annotation work on one is exactly
 * the mutation that guard exists to stop. `requireOwnership` does a bare
 * `findUnique` and would happily let it through.
 */
async function resolveCoordinatedSet(
  goldenSetId: string,
  session: AuthSession
): Promise<{ ownerId: string | null } | NextResponse> {
  const goldenSet = await prisma.goldenSet.findFirst({
    where: { id: goldenSetId, ...goldenSetLifecycleWhere(false) },
    select: { id: true, ownerId: true },
  });
  if (!goldenSet) {
    return NextResponse.json({ error: 'Golden set not found' }, { status: 404 });
  }
  if (goldenSet.ownerId !== session.user.id && !isAdmin(session)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  return { ownerId: goldenSet.ownerId };
}

// GET — the set's assignments. ACTIVE only by default; `?includeRevoked=true`
// widens it, the same strict `=== 'true'` spelling as every other lifecycle
// escape hatch in this codebase (see parseIncludeRetired / parseIncludeTombstoned).
export async function GET(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;
  const scopeCheck = requireScope(session, 'golden-sets:read');
  if (scopeCheck) return scopeCheck;

  try {
    const resolved = await resolveCoordinatedSet(params.id, session);
    if (resolved instanceof NextResponse) return resolved;

    const includeRevoked =
      new URL(request.url).searchParams.get('includeRevoked') === 'true';

    const assignments = await prisma.goldenAssignment.findMany({
      where: { goldenSetId: params.id, ...(includeRevoked ? {} : { revokedAt: null }) },
      select: assignmentSelect,
      orderBy: { assignedAt: 'desc' },
    });

    return NextResponse.json({ assignments });
  } catch (error) {
    logger.error('Failed to list golden-set assignments', { error: serializeError(error) });
    return NextResponse.json({ error: 'Failed to list assignments' }, { status: 500 });
  }
}

// POST — assign work.
export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;
  const scopeCheck = requireScope(session, 'golden-sets:write');
  if (scopeCheck) return scopeCheck;

  try {
    const resolved = await resolveCoordinatedSet(params.id, session);
    if (resolved instanceof NextResponse) return resolved;

    const data = createAssignmentSchema.parse(await request.json());

    // The POLICY check, distinct from the access check above: who may HOLD
    // this row. See src/lib/assignment-policy.ts.
    const annotator = await prisma.user.findUnique({
      where: { id: data.annotatorId },
      select: { id: true, role: true },
    });
    if (!annotator) {
      return NextResponse.json({ error: 'Annotator not found' }, { status: 404 });
    }
    if (!mayHoldAssignment(annotator, resolved.ownerId)) {
      return NextResponse.json(
        {
          error: 'That user may not hold an assignment on this golden set',
          annotatorId: data.annotatorId,
        },
        { status: 403 }
      );
    }

    // An item from ANOTHER set would make the id in the URL decoration, and
    // every downstream queue query — all of which scope by goldenSetId — would
    // silently never see this row.
    if (data.goldenItemId) {
      const item = await prisma.goldenItem.findFirst({
        where: { id: data.goldenItemId, goldenSetId: params.id, tombstonedAt: null },
        select: { id: true },
      });
      if (!item) {
        return NextResponse.json(
          { error: 'That item does not belong to this golden set, or has been tombstoned' },
          { status: 400 }
        );
      }
    }

    const assignment = await prisma.goldenAssignment.create({
      data: {
        goldenSetId: params.id,
        annotatorId: data.annotatorId,
        goldenItemId: data.goldenItemId ?? null,
        round: data.round,
        assignedById: session.user.id,
      },
      select: assignmentSelect,
    });

    return NextResponse.json({ assignment }, { status: 201 });
  } catch (error) {
    // P2002 here is the partial active-assignment unique, and it means the
    // annotator ALREADY holds this work — a 409 rather than a 500, because the
    // caller's next move is to look at the existing row, not to retry.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return NextResponse.json(
        { error: 'That annotator already holds an active assignment for this item and round' },
        { status: 409 }
      );
    }
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Validation failed', details: error.errors }, { status: 400 });
    }
    logger.error('Failed to create golden-set assignment', { error: serializeError(error) });
    return NextResponse.json({ error: 'Failed to create assignment' }, { status: 500 });
  }
}

// DELETE — REVOKE. The row stays.
export async function DELETE(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;
  const scopeCheck = requireScope(session, 'golden-sets:write');
  if (scopeCheck) return scopeCheck;

  try {
    const resolved = await resolveCoordinatedSet(params.id, session);
    if (resolved instanceof NextResponse) return resolved;

    const data = revokeAssignmentSchema.parse(await request.json());

    // `updateMany` scoped by goldenSetId, so an assignment id from another set
    // cannot be revoked through this URL. A zero count is a 404 rather than a
    // silent success — "revoked: true" for a row that was never touched is the
    // kind of lie a coordinator acts on.
    const { count } = await prisma.goldenAssignment.updateMany({
      where: { id: data.assignmentId, goldenSetId: params.id, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: data.reason ?? null },
    });
    if (count === 0) {
      return NextResponse.json(
        { error: 'No active assignment with that id on this golden set' },
        { status: 404 }
      );
    }

    return NextResponse.json({ revoked: true });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Validation failed', details: error.errors }, { status: 400 });
    }
    logger.error('Failed to revoke golden-set assignment', { error: serializeError(error) });
    return NextResponse.json({ error: 'Failed to revoke assignment' }, { status: 500 });
  }
}
