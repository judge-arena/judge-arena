import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import {
  optionalAuth,
  requireScope,
  resolveResourceAccess,
  type ResourceAccess,
} from '@/lib/auth-guard';
import { goldenSetLifecycleWhere } from '@/lib/golden-sets';

/**
 * A1 — the access rule the three REPORTING routes share: agreement,
 * disagreements, and item history.
 *
 * "PUBLIC IFF PUBLISHED" is two conditions, not one. Anonymous is served only
 * when the set is `visibility: 'public'` AND `publishedAt` is set. A public
 * draft is still a draft: `visibility` says where it MAY go, `publishedAt` says
 * that somebody decided it should. Checking only the first would publish every
 * work-in-progress set the moment its visibility was flipped, which is the
 * opposite of a deliberate act.
 *
 * Internally the data is always viewable, and always recalculable from the
 * stored labels — decision 4's "computed on read" means there is no
 * materialised number that can disagree with the rows.
 *
 * Factored into one function rather than repeated three times because the two
 * halves of the condition are exactly the kind of thing that stays right in
 * two routes and quietly drifts in the third.
 *
 * NOTE `optionalAuth()` THROWS rather than returning an error response — it
 * raises `RateLimitedError`, whose `.response` the caller must return. So every
 * caller has to invoke this inside its own `try`, with that check first in the
 * `catch`. Stated here because getting it wrong turns a 429 into a 500.
 */
export async function resolveReportingAccess(
  goldenSetId: string
): Promise<
  | { access: ResourceAccess; goldenSet: { id: string; ownerId: string | null } }
  | { error: NextResponse }
> {
  const session = await optionalAuth();
  if (session) {
    const scopeCheck = requireScope(session, 'golden-sets:read');
    if (scopeCheck) return { error: scopeCheck };
  }

  const goldenSet = await prisma.goldenSet.findFirst({
    where: { id: goldenSetId, ...goldenSetLifecycleWhere(false) },
    select: { id: true, ownerId: true, visibility: true, publishedAt: true },
  });
  if (!goldenSet) {
    return { error: NextResponse.json({ error: 'Golden set not found' }, { status: 404 }) };
  }

  const decision = resolveResourceAccess(
    session,
    goldenSet.ownerId,
    goldenSet.visibility === 'public' && goldenSet.publishedAt !== null
  );
  if ('error' in decision) return { error: decision.error };

  return { access: decision.access, goldenSet: { id: goldenSet.id, ownerId: goldenSet.ownerId } };
}
