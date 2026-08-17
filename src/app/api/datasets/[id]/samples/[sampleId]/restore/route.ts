import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireAuth, requireScope, isAdmin, RateLimitedError } from '@/lib/auth-guard';
import { liveDatasetsOnly, liveSamplesOnly, restoreSample } from '@/lib/tombstones';
import { recordSampleRevision } from '@/lib/sample-revisions';
import { logger, serializeError } from '@/lib/logger';

/**
 * Un-hide a sample hidden by DELETE /api/datasets/[id]/samples.
 *
 * The first and only caller of `restoreSample`. L1 shipped hiding with no way
 * back through the API — this closes that, so "we hide rather than destroy" is
 * a promise a user can act on rather than a claim about the database.
 *
 * The tombstone row is FLIPPED, not deleted, so the record still says this
 * sample was hidden once. Its ordinal is unchanged and was never reused, which
 * is exactly why the high-water-mark rule exists: a restored sample lands back
 * in its original position rather than at the end.
 *
 * TWO READS, TWO DIFFERENT DISPOSITIONS, and conflating them breaks the route:
 *
 *   - The DATASET read is FILTERED (`liveDatasetsOnly()`), like every other
 *     mutation guard in samples/route.ts. A hidden dataset is closed to writes
 *     (decision 15) and its samples are hidden by inheritance (decision 16),
 *     so restoring one beneath it would surface nothing — and there is no
 *     `restoreDataset` to lift the parent. Owner decision, 2026-08-16.
 *   - The SAMPLE read is UNFILTERED, deliberately. This route exists to act on
 *     a hidden row; filtering it would make the endpoint unreachable in exactly
 *     the case it was written for.
 */
export async function POST(
  _request: Request,
  props: { params: Promise<{ id: string; sampleId: string }> }
) {
  const params = await props.params;
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;
  const scopeCheck = requireScope(session, 'datasets:write');
  if (scopeCheck) return scopeCheck;

  try {
    const dataset = await prisma.dataset.findFirst({
      where: { id: params.id, ...liveDatasetsOnly() },
      select: { userId: true },
    });
    if (!dataset) {
      return NextResponse.json({ error: 'Dataset not found' }, { status: 404 });
    }
    if (dataset.userId !== session.user.id && !isAdmin(session)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Unfiltered — see the header. It still verifies MEMBERSHIP, which is what
    // turns a foreign id into a 404 rather than a confusing success.
    const sample = await prisma.datasetSample.findUnique({
      where: { id: params.sampleId },
      select: { datasetId: true, tombstone: { select: { isTombstone: true } } },
    });
    if (!sample || sample.datasetId !== params.id) {
      return NextResponse.json({ error: 'Sample not found in this dataset' }, { status: 404 });
    }
    if (!sample.tombstone?.isTombstone) {
      return NextResponse.json(
        { error: 'This sample is not deleted, so there is nothing to restore.' },
        { status: 409 }
      );
    }

    // One transaction, so a rolled-back restore leaves no revision claiming it
    // happened — the same rule every other revision write in L2 follows — and
    // so the stored count cannot disagree with the rows it counts.
    await prisma.$transaction(async (tx) => {
      await restoreSample(tx, params.sampleId);
      await recordSampleRevision(tx, {
        datasetSampleId: params.sampleId,
        changeType: 'restore',
        actorId: session.user.id,
      });

      // `sampleCount` IS A LIVE ROW COUNT since L1, and a restore moves it in
      // the opposite direction from every verb L1 touched. Without this write
      // the stored value under-reports by one for every restored row,
      // permanently — and the UI ladder reads the stored value FIRST, so it
      // shadows the live count beneath it. That is L1's documented "the import
      // picker advertises 620 and the import yields 610" failure, pointing the
      // other way. Counted rather than incremented, for the same reason DELETE
      // counts: a derived +1 is right only if nothing else moved.
      const live = await tx.datasetSample.count({
        where: { datasetId: params.id, ...liveSamplesOnly() },
      });
      await tx.dataset.update({
        where: { id: params.id },
        data: { sampleCount: live },
      });
    });

    return NextResponse.json({ restored: true });
  } catch (error) {
    if (error instanceof RateLimitedError) return error.response;
    logger.error('Failed to restore sample', { error: serializeError(error) });
    return NextResponse.json({ error: 'Failed to restore sample' }, { status: 500 });
  }
}
