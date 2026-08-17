import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireAuth, requireScope, isAdmin, RateLimitedError } from '@/lib/auth-guard';
import { liveDatasetsOnly } from '@/lib/tombstones';
import { logger, serializeError } from '@/lib/logger';

/**
 * One sample's mutation history, newest first.
 *
 * OWNER-ONLY, and that is a departure from every sibling read in this tree
 * rather than an oversight: `datasets/[id]` and the export routes serve a
 * PUBLIC dataset to anyone, but a sample's edit history names who made each
 * change and carries the text the row held before it. Neither is public data
 * even when the dataset is. Hence `requireAuth` rather than `optionalAuth`,
 * and an ownership check that does not consult `visibility`.
 *
 * NOT filtered on the sample's own tombstone. The history of a hidden sample
 * is exactly what you read when deciding whether to restore it — this is the
 * one read in either lifecycle plan where seeing a hidden row is the point
 * rather than a bug. The PARENT dataset is filtered, for the same reason the
 * restore route filters it: a hidden dataset is closed, and its samples are
 * hidden by inheritance (decisions 15 and 16).
 *
 * The actor is projected as `{ id, name }` and nothing else. A full User would
 * carry the email, and this endpoint would then be the one place a dataset
 * collaborator's address leaks out of a history panel.
 *
 * NOT PAGINATED, deliberately and recorded as a choice: a sample's history is
 * bounded by how many times a human edits one row. Revisit if a bulk verb ever
 * writes per-row edits in a loop.
 */
export async function GET(
  _request: Request,
  props: { params: Promise<{ id: string; sampleId: string }> }
) {
  const params = await props.params;
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;
  const scopeCheck = requireScope(session, 'datasets:read');
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

    // Unfiltered on the sample's own tombstone — see the header.
    const sample = await prisma.datasetSample.findUnique({
      where: { id: params.sampleId },
      select: { datasetId: true },
    });
    if (!sample || sample.datasetId !== params.id) {
      return NextResponse.json({ error: 'Sample not found in this dataset' }, { status: 404 });
    }

    const revisions = await prisma.sampleRevision.findMany({
      where: { datasetSampleId: params.sampleId },
      orderBy: { at: 'desc' },
      select: {
        id: true,
        changeType: true,
        input: true,
        expected: true,
        metadata: true,
        at: true,
        actor: { select: { id: true, name: true } },
      },
    });

    return NextResponse.json({ revisions });
  } catch (error) {
    if (error instanceof RateLimitedError) return error.response;
    logger.error('Failed to load sample revisions', { error: serializeError(error) });
    return NextResponse.json({ error: 'Failed to load sample revisions' }, { status: 500 });
  }
}
