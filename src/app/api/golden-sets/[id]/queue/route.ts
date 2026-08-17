import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireAuth, requireScope, isAdmin } from '@/lib/auth-guard';
import { logger, serializeError } from '@/lib/logger';
import { goldenSetLifecycleWhere, goldenItemLifecycleWhere } from '@/lib/golden-sets';
import {
  buildCandidates,
  coversCandidate,
  deriveReadingStates,
  selectNext,
} from '@/lib/labelling-queue';

/**
 * A1 — `GET …/golden-sets/[id]/queue`. The next item for THIS annotator.
 *
 * ── WHAT THIS RESPONSE MUST NOT CONTAIN, AND WHY ───────────────────────────
 *
 * THE ROUND. `selectNext` decides it and it stays server-side. An annotator
 * who can see that this is reading two is no longer being measured for
 * consistency; they are being asked whether they remember, which is a
 * different and much easier question. This is why the body is assembled field
 * by field below rather than spread from the row — a spread would put every
 * future column on the wire by default, and the first one that leaks the round
 * or the answer would do so silently.
 *
 * THE PRIOR LABEL. Including "you said 4 last time" as a convenience would
 * destroy the same signal more directly.
 *
 * `GoldenItem.expected` — THE GROUND TRUTH. Not a blinding subtlety, just the
 * answer. `GoldenCandidate.label` IS included, because it is the candidate's
 * identifier ('A'/'B'), not the verdict; `expected` is where the verdict
 * lives. Anything added to this select later has to clear the same bar.
 *
 * ── AND WHAT IT MUST SAY WHEN THERE IS NOTHING ─────────────────────────────
 *
 * Three different empty states, never an empty list:
 *   no-assignment            nothing was ever asked of you
 *   set-complete             you have done everything asked of you
 *   retest-not-yet-eligible  come back after N more items (with the N)
 *
 * The last one is the accepted limitation of intervening-items-only made
 * visible: a set smaller than K can never produce a retest, and an empty queue
 * would look finished rather than blocked.
 */
export async function GET(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;
  const scopeCheck = requireScope(session, 'golden-sets:read');
  if (scopeCheck) return scopeCheck;

  try {
    // Lifecycle-filtered: a retired or tombstoned set is out of circulation,
    // and handing out work on one is the mutation that guard exists to stop.
    const goldenSet = await prisma.goldenSet.findFirst({
      where: { id: params.id, ...goldenSetLifecycleWhere(false) },
      select: { id: true, ownerId: true, retestIntervalItems: true },
    });
    if (!goldenSet) {
      return NextResponse.json({ error: 'Golden set not found' }, { status: 404 });
    }

    const assignments = await prisma.goldenAssignment.findMany({
      where: { goldenSetId: params.id, annotatorId: session.user.id, revokedAt: null },
      select: { goldenItemId: true, round: true },
    });

    // Access is assigned-annotator, owner, or admin — NOT "anyone signed in".
    // `resolveResourceAccess` is deliberately not used: this route has no
    // public branch even for a published public set, because a queue is
    // personal work rather than a published artifact.
    //
    // The order matters. Without this, a stranger holding no assignment would
    // get a 200 `no-assignment` on a PRIVATE set, which confirms the set
    // exists — an existence oracle over any id, from an endpoint whose whole
    // job is to hand out work.
    const isCoordinator = goldenSet.ownerId === session.user.id || isAdmin(session);
    if (!isCoordinator && assignments.length === 0) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    if (assignments.length === 0) {
      return NextResponse.json({ next: null, reason: 'no-assignment' });
    }

    const [liveItems, labels] = await Promise.all([
      prisma.goldenItem.findMany({
        where: { goldenSetId: params.id, ...goldenItemLifecycleWhere(false) },
        select: { id: true },
        orderBy: { index: 'asc' },
      }),
      // EVERY live label of this annotator IN THE SET, not just on assigned
      // items — the retest gate counts other items labelled since, and "other"
      // ranges over the set. See deriveReadingStates.
      prisma.goldenLabel.findMany({
        where: {
          annotatorId: session.user.id,
          tombstonedAt: null,
          goldenItem: { goldenSetId: params.id },
        },
        select: { goldenItemId: true, round: true, createdAt: true },
      }),
    ]);

    const states = deriveReadingStates(
      liveItems.map((i) => i.id),
      labels
    );
    const candidates = buildCandidates(states, goldenSet.retestIntervalItems).filter((c) =>
      coversCandidate(assignments, c)
    );

    const result = selectNext(candidates, `${session.user.id}:${params.id}`);
    if (result.next === null) return NextResponse.json(result);

    const item = await prisma.goldenItem.findUniqueOrThrow({
      where: { id: result.next.itemId },
      select: {
        id: true,
        inputText: true,
        promptText: true,
        responseText: true,
        protocol: true,
        candidates: {
          select: { position: true, promptText: true, responseText: true, label: true },
          orderBy: { position: 'asc' },
        },
      },
    });

    // Named field by field, and `result.next.round` deliberately not among
    // them. A retest and a first reading are the same shape on the wire.
    return NextResponse.json({
      next: {
        itemId: item.id,
        inputText: item.inputText,
        promptText: item.promptText,
        responseText: item.responseText,
        protocol: item.protocol,
        candidates: item.candidates,
      },
      reason: null,
    });
  } catch (error) {
    logger.error('Failed to serve the labelling queue', { error: serializeError(error) });
    return NextResponse.json({ error: 'Failed to serve the labelling queue' }, { status: 500 });
  }
}
