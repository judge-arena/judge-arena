import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { RateLimitedError } from '@/lib/auth-guard';
import { logger, serializeError } from '@/lib/logger';
import { agreement } from '@/lib/agreement';
import { interAnnotatorReadings, testRetestReadings } from '@/lib/label-readings';
import { resolveReportingAccess } from '../reporting-access';

/**
 * A1 — `GET …/golden-sets/[id]/agreement`. The number, and the method that
 * produced it.
 *
 * Computed on read (decision 4), never materialised: a stored number can go
 * quietly wrong when labels change underneath it, and there is no invalidation
 * logic that can be forgotten if there is nothing to invalidate.
 *
 * ── TWO NUMBERS, NOT ONE, AND THE SECOND IS THE ONE THAT WORKS TODAY ───────
 *
 * `value` and its method fields are INTER-annotator: do different people
 * agree. With exactly one account there is one annotator, so this is
 * `insufficient-annotators` — null with a reason, never 0, because 0 reads as
 * total disagreement, which is the opposite of "not measurable". THAT IS THE
 * NORMAL STATE AT LAUNCH and the UI must render it as an explanation rather
 * than as a broken number.
 *
 * `testRetest` is INTRA-annotator: does one person reach the same judgment
 * twice, blind. It is the only reliability signal that produces a value while
 * one account exists, which is what the roadmap put the column there for.
 *
 * `excludedAnonymisedReadings` reports how many readings were dropped because
 * account deletion had nulled their annotator. Zero in every ordinary case;
 * carried anyway, because a statistic computed over silently fewer readings
 * than the caller thinks is exactly the failure mode this phase exists to
 * prevent.
 *
 * TOMBSTONED LABELS ARE EXCLUDED at the query. A retired reading applied to
 * text that no longer exists, so counting it would compute agreement over
 * content nobody read.
 */
export async function GET(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;

  try {
    const resolved = await resolveReportingAccess(params.id);
    if ('error' in resolved) return resolved.error;

    const labels = await prisma.goldenLabel.findMany({
      where: { tombstonedAt: null, goldenItem: { goldenSetId: params.id, tombstonedAt: null } },
      select: {
        goldenItemId: true,
        annotatorId: true,
        round: true,
        overallScore: true,
        preference: true,
      },
    });

    const { readings, excludedAnonymised } = interAnnotatorReadings(labels);
    const inter = agreement(readings);

    const retest = testRetestReadings(labels);
    const retestResult = agreement(retest.readings);

    return NextResponse.json({
      ...inter,
      excludedAnonymisedReadings: excludedAnonymised,
      testRetest: {
        ...retestResult,
        // OVERRIDDEN, and not cosmetically. agreement() derives this from the
        // rater ids, which for the retest pooling are 'round-1' and 'round-2'
        // — reporting 2 there would assert that two people produced a number
        // one person produced.
        annotatorCount: retest.annotatorCount,
      },
    });
  } catch (error) {
    if (error instanceof RateLimitedError) return error.response;
    logger.error('Failed to compute golden-set agreement', { error: serializeError(error) });
    return NextResponse.json({ error: 'Failed to compute agreement' }, { status: 500 });
  }
}
