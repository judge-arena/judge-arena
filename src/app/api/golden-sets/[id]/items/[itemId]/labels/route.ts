import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requireAuth, requireScope } from '@/lib/auth-guard';
import { logger, serializeError } from '@/lib/logger';
import { goldenSetLifecycleWhere } from '@/lib/golden-sets';
import { coversCandidate, deriveReadingStates, nextRoundFor } from '@/lib/labelling-queue';
import { retestEligibility } from '@/lib/retest';

/**
 * A1 — `POST …/golden-sets/[id]/items/[itemId]/labels`. One human reading.
 *
 * ── THE TWO SECURITY PROPERTIES, NEITHER OF THEM A CONVENIENCE ─────────────
 *
 * 1. THE SERVER DECIDES THE ROUND. The schema below simply has no `round`
 *    field, so zod's default strip drops a client-supplied one before any code
 *    reads it — the round is re-derived here from stored labels via
 *    `nextRoundFor`, the SAME function the queue used. Sharing the function
 *    rather than reimplementing it is what makes "re-derives it exactly as the
 *    queue did" a fact instead of a comment. If a client could name the round,
 *    blinding would be client-trusted and a stale tab would defeat the
 *    reliability signal the phase exists to produce.
 *
 * 2. ELIGIBILITY IS RE-CHECKED HERE, not merely when the queue handed the item
 *    out. A back button, a stale tab, or a crafted POST otherwise writes a
 *    reading for an item this annotator was never offered — and for a blind
 *    retest, KNOWINGLY seeing an item twice is exactly what invalidates the
 *    measurement. Both halves are re-checked: that an active assignment covers
 *    (item, round), and that a round-2 reading has actually aged past K.
 *
 * The checks run authorization-first: no assignment is a 403 before any
 * business rule is consulted, so a caller cannot learn an item's retest state
 * by probing an item they were never given.
 *
 * NOT FREEZE-GUARDED, deliberately. `isGoldenSetFrozen`'s contract (see its
 * doc in src/lib/golden-sets.ts) is that item CONTENT freezes — items,
 * candidates, protocol, expected — because those are what a calibration run
 * measured. Labels are not content; design decision 4 has agreement COMPUTED
 * ON READ and merely recorded at freeze, which presumes labels keep arriving.
 * The lifecycle guard below is a different rule and does apply: a retired set
 * is out of circulation for new work.
 */

// No `round`. Its absence is the mechanism, not an omission — see property 1.
const submitLabelSchema = z.object({
  overallScore: z.number().optional(),
  preference: z.string().min(1).max(64).optional(),
  criteriaScores: z.record(z.number()).optional(),
  reasoning: z.string().max(10_000).optional(),
});

export async function POST(
  request: Request,
  props: { params: Promise<{ id: string; itemId: string }> }
) {
  const params = await props.params;
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;
  const scopeCheck = requireScope(session, 'golden-sets:write');
  if (scopeCheck) return scopeCheck;

  try {
    const goldenSet = await prisma.goldenSet.findFirst({
      where: { id: params.id, ...goldenSetLifecycleWhere(false) },
      select: { id: true, retestIntervalItems: true },
    });
    if (!goldenSet) {
      return NextResponse.json({ error: 'Golden set not found' }, { status: 404 });
    }

    const item = await prisma.goldenItem.findFirst({
      where: { id: params.itemId, goldenSetId: params.id, tombstonedAt: null },
      select: { id: true, protocol: true },
    });
    if (!item) {
      return NextResponse.json(
        { error: 'That item does not belong to this golden set, or has been tombstoned' },
        { status: 404 }
      );
    }

    const data = submitLabelSchema.parse(await request.json());

    // The CHECK constraint would refuse a both-set or neither-set row at the
    // database as an opaque 500. This refuses it as a 400 that names the
    // field, and additionally enforces the PROTOCOL — which the CHECK cannot
    // see, since it knows nothing about the item.
    const wantsPreference = item.protocol !== 'pointwise';
    const expectedField = wantsPreference ? 'preference' : 'overallScore';
    const forbiddenField = wantsPreference ? 'overallScore' : 'preference';
    if (data[expectedField] === undefined || data[forbiddenField] !== undefined) {
      return NextResponse.json(
        {
          error: `A ${item.protocol} item takes exactly '${expectedField}'`,
          expected: expectedField,
          forbidden: forbiddenField,
        },
        { status: 400 }
      );
    }

    const [assignments, labels] = await Promise.all([
      prisma.goldenAssignment.findMany({
        where: { goldenSetId: params.id, annotatorId: session.user.id, revokedAt: null },
        select: { id: true, goldenItemId: true, round: true },
      }),
      prisma.goldenLabel.findMany({
        where: {
          annotatorId: session.user.id,
          tombstonedAt: null,
          goldenItem: { goldenSetId: params.id },
        },
        select: { goldenItemId: true, round: true, createdAt: true },
      }),
    ]);

    const [state] = deriveReadingStates([params.itemId], labels);
    const round = nextRoundFor(state);
    if (round === null) {
      return NextResponse.json(
        { error: 'Both readings of this item are already recorded' },
        { status: 409 }
      );
    }

    // AUTHORIZATION FIRST. A 403 here must not depend on retest state, or the
    // response becomes an oracle for items the caller was never given.
    if (!coversCandidate(assignments, { itemId: params.itemId, round })) {
      return NextResponse.json(
        { error: 'You hold no active assignment for this item' },
        { status: 403 }
      );
    }

    if (round === 2) {
      const verdict = retestEligibility({
        intervalItems: goldenSet.retestIntervalItems,
        labelledSinceRound1: state.labelledSinceRound1,
        hasRound1: state.hasRound1,
        hasRound2: state.hasRound2,
      });
      if (!verdict.eligible) {
        return NextResponse.json(
          {
            error: 'This item is not yet eligible for a second reading',
            labelsUntilEligible: verdict.labelsUntilEligible,
          },
          { status: 409 }
        );
      }
    }

    const label = await prisma.$transaction(async (tx) => {
      const created = await tx.goldenLabel.create({
        data: {
          goldenItemId: params.itemId,
          annotatorId: session.user.id,
          round,
          overallScore: data.overallScore ?? null,
          preference: data.preference ?? null,
          criteriaScores: data.criteriaScores ?? undefined,
          reasoning: data.reasoning ?? null,
          // goldenItemRevisionId is deliberately left NULL: null means "saw
          // the item's CURRENT content", which is true at write time. It is
          // the EDIT that back-fills it, because with before-image semantics
          // the revision does not exist until the edit that supersedes it.
        },
        select: { id: true, round: true },
      });

      // An ITEM assignment is complete the moment its named round is read.
      await tx.goldenAssignment.updateMany({
        where: {
          goldenSetId: params.id,
          annotatorId: session.user.id,
          goldenItemId: params.itemId,
          round,
          revokedAt: null,
          completedAt: null,
        },
        data: { completedAt: new Date() },
      });

      // A WHOLE-SET assignment is complete when every live item has a first
      // reading. Round one, not round two: the retest is a sample of the work,
      // not a second pass over all of it, so waiting for round two would leave
      // these rows open forever on any set larger than K.
      const unread = await tx.goldenItem.count({
        where: {
          goldenSetId: params.id,
          tombstonedAt: null,
          labels: { none: { annotatorId: session.user.id, round: 1, tombstonedAt: null } },
        },
      });
      if (unread === 0) {
        await tx.goldenAssignment.updateMany({
          where: {
            goldenSetId: params.id,
            annotatorId: session.user.id,
            goldenItemId: null,
            revokedAt: null,
            completedAt: null,
          },
          data: { completedAt: new Date() },
        });
      }

      return created;
    });

    return NextResponse.json({ labelId: label.id, round: label.round }, { status: 201 });
  } catch (error) {
    // P2002 here is GoldenLabel_goldenItemId_annotatorId_round_live_key, and
    // the only way to reach it is a RACE: two submits for the same item derive
    // the same round from the same stored labels, and the second insert loses.
    // Two tabs, or a double-click on a slow connection.
    //
    // Reported as a 409 rather than a bare 500 for the same reason R1 stopped
    // reporting an ordinal collision as one: a 500 says "this broke", and the
    // annotator retries and produces a THIRD attempt at a reading that already
    // succeeded. 409 says "that reading is already recorded", which is true and
    // is the state they should act on. Not retried server-side, deliberately —
    // unlike the ordinal case there is no different value to retry WITH; the
    // reading exists.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return NextResponse.json(
        { error: 'A reading for this item and round was recorded concurrently' },
        { status: 409 }
      );
    }
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Validation failed', details: error.errors }, { status: 400 });
    }
    logger.error('Failed to record a golden label', { error: serializeError(error) });
    return NextResponse.json({ error: 'Failed to record label' }, { status: 500 });
  }
}
