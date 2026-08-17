import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { RateLimitedError } from '@/lib/auth-guard';
import { logger, serializeError } from '@/lib/logger';
import { labelCategory, readingSpread } from '@/lib/label-readings';
import { resolveReportingAccess } from '../reporting-access';

/**
 * A1 — `GET …/golden-sets/[id]/disagreements`. Items ranked by divergence.
 *
 * Ranked DESCENDING because this list is not only a report: it is A3's
 * highest-information input to the next labelling round. The items people
 * disagree about are the items where another reading buys the most, and
 * sorting them to the top is the difference between a queue that improves the
 * set and one that grinds through it in index order.
 *
 * ROUND-1 READINGS ONLY, and only items with at least two of them. Mixing an
 * annotator's own re-read in would blend intra-annotator inconsistency into a
 * number labelled "disagreement", and an item one person read has nothing to
 * diverge from — listing it at spread 0 beside a genuine consensus would show
 * "nobody checked" and "everybody agreed" as the same fact.
 *
 * WHO said what is NOT returned on the public branch. Every other public read
 * path in this codebase strips user data to the owner's `{ id, name }` and
 * nothing else (src/lib/serializers.ts); a published set's artifact is the
 * labels and the number, not an attributable record of which person scored
 * what.
 */
export async function GET(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;

  try {
    const resolved = await resolveReportingAccess(params.id);
    if ('error' in resolved) return resolved.error;
    const isOwnerView = resolved.access === 'owner';

    const labels = await prisma.goldenLabel.findMany({
      where: {
        round: 1,
        tombstonedAt: null,
        goldenItem: { goldenSetId: params.id, tombstonedAt: null },
      },
      select: {
        goldenItemId: true,
        annotatorId: true,
        round: true,
        overallScore: true,
        preference: true,
      },
    });

    const byItem = new Map<string, typeof labels>();
    for (const label of labels) {
      const bucket = byItem.get(label.goldenItemId);
      if (bucket) bucket.push(label);
      else byItem.set(label.goldenItemId, [label]);
    }

    const items = [...byItem.entries()]
      .filter(([, rows]) => rows.length >= 2)
      .map(([itemId, rows]) => {
        const categories = rows
          .map(labelCategory)
          .filter((c): c is string => c !== null);
        return {
          itemId,
          spread: readingSpread(categories),
          readings: rows.map((row) => ({
            round: row.round,
            value: labelCategory(row),
            annotatorId: isOwnerView ? row.annotatorId : null,
          })),
        };
      })
      // Tie-broken by itemId so the order is stable across requests rather
      // than dependent on however Postgres returned the rows.
      .sort((a, b) => (b.spread === a.spread ? (a.itemId < b.itemId ? -1 : 1) : b.spread - a.spread));

    return NextResponse.json({ items });
  } catch (error) {
    if (error instanceof RateLimitedError) return error.response;
    logger.error('Failed to rank golden-set disagreements', { error: serializeError(error) });
    return NextResponse.json({ error: 'Failed to rank disagreements' }, { status: 500 });
  }
}
