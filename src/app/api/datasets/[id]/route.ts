import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { z } from 'zod';
import { requireAuth, requireScope, optionalAuth, resolveResourceAccess, requireOwnership, RateLimitedError } from '@/lib/auth-guard';
import { logger, serializeError } from '@/lib/logger';
import { toPublicDataset } from '@/lib/serializers';
import { findGoldenSetsPinningDataset } from '@/lib/golden-sets';
import { liveDatasetsOnly, liveSamplesOnly, tombstoneDataset } from '@/lib/tombstones';

/**
 * DECISION 15 — A HIDDEN DATASET IS CLOSED TO WRITES, at the two sites the
 * shared ownership helper cannot cover.
 *
 * The other seven mutation handlers on this branch spread `liveDatasetsOnly()`
 * straight into their own guard read. PATCH and DELETE here do not have one:
 * they gate on `requireOwnership('dataset', …)` (src/lib/auth-guard.ts), whose
 * read is UNFILTERED and which is shared with eight other resource types whose
 * access-matrix rows pin exactly that behaviour. Pushing the overlay into the
 * helper would silently change what `rubric`, `project`, `evaluation` … mean,
 * so the liveness check is EXPLICIT AND LOCAL instead — the same shape as A0's
 * `assertGoldenSetInCirculation` (src/lib/golden-sets.ts): a named assertion
 * the write handlers run immediately after the ownership gate.
 *
 * Without it a hidden dataset stays PATCHable: you could rename a corpus you
 * had already deleted, and the rename would land on a row no read path
 * returns.
 *
 * IT ANSWERS 404, NOT 409, unlike its golden-set counterpart, and the
 * difference is not cosmetic. A retired golden set is still listed to its
 * owner under `?includeRetired=true` and has an un-retire verb, so a bare 404
 * would confuse someone looking straight at it; a hidden dataset is absent
 * from every read path this branch has, with no escape flag and no un-delete
 * verb, so "not found" is what its owner has already been told everywhere
 * else. It is also the answer the other seven handlers give.
 *
 * Not exported: Next.js 15 validates a `route.ts`'s named exports against a
 * fixed allowlist. Module-local is the same accommodation `resolveJudgeVersionIds`
 * (evaluations/route.ts) and `tombstoneReplacedGoldenItems` (config/import/route.ts)
 * already make.
 */
async function assertDatasetLive(id: string): Promise<NextResponse | null> {
  const live = await prisma.dataset.findFirst({
    where: { id, ...liveDatasetsOnly() },
    select: { id: true },
  });
  if (!live) {
    return NextResponse.json({ error: 'Dataset not found' }, { status: 404 });
  }
  return null;
}

const updateDatasetSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(4000).optional(),
  visibility: z.enum(['private', 'public']).optional(),
  inputType: z.enum(['query', 'query-response']).optional(),
  projectId: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
});

// GET /api/datasets/[id] - Get a single dataset with samples. Public if
// visibility: 'public' (PII-stripped — src/lib/serializers.ts), else
// owner/admin only. Access matrix: tests/db/access-matrix.test.ts.
export async function GET(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;

  try {
    const session = await optionalAuth();
    if (session) {
      const scopeCheck = requireScope(session, 'datasets:read');
      if (scopeCheck) return scopeCheck;
    }

    const dataset = await prisma.dataset.findUnique({
      where: { id: params.id },
      include: {
        user: { select: { id: true, name: true, email: true } },
        project: { select: { id: true, name: true } },
        samples: {
          where: liveSamplesOnly(),
          orderBy: { index: 'asc' },
          take: 100,
        },
        versions: {
          select: { id: true, version: true, createdAt: true, sampleCount: true },
          orderBy: { version: 'desc' },
        },
        parent: {
          select: { id: true, version: true },
        },
        _count: { select: { samples: true } },
      },
    });

    if (!dataset) {
      return NextResponse.json(
        { error: 'Dataset not found' },
        { status: 404 }
      );
    }

    const decision = resolveResourceAccess(session, dataset.userId, dataset.visibility === 'public');
    if ('error' in decision) return decision.error;

    if (decision.access === 'owner') {
      return NextResponse.json(dataset);
    }

    // Public view: PII-stripped dataset core + the same samples/versions/
    // parent sub-objects (none of which join user data, so they're already
    // safe to pass through verbatim — see the GET include above).
    return NextResponse.json({
      ...toPublicDataset(dataset),
      samples: dataset.samples,
      versions: dataset.versions,
      parent: dataset.parent,
    });
  } catch (error) {
    if (error instanceof RateLimitedError) return error.response;
    logger.error('Failed to fetch dataset', { error: serializeError(error) });
    return NextResponse.json(
      { error: 'Failed to fetch dataset' },
      { status: 500 }
    );
  }
}

// PATCH /api/datasets/[id] - Update a dataset
export async function PATCH(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;
  const scopeCheck = requireScope(session, 'datasets:write');
  if (scopeCheck) return scopeCheck;

  try {
    const ownershipError = await requireOwnership('dataset', params.id, session);
    if (ownershipError) return ownershipError;
    const hiddenError = await assertDatasetLive(params.id);
    if (hiddenError) return hiddenError;

    const body = await request.json();
    const data = updateDatasetSchema.parse(body);

    const updateData: any = { ...data };
    if (data.tags) {
      updateData.tags = JSON.stringify(data.tags);
      delete updateData.tags;
      updateData.tags = JSON.stringify(data.tags);
    }

    const dataset = await prisma.dataset.update({
      where: { id: params.id },
      data: updateData,
      include: {
        user: { select: { id: true, name: true, email: true } },
        project: { select: { id: true, name: true } },
        _count: { select: { samples: true } },
      },
    });

    return NextResponse.json(dataset);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Validation failed', details: error.errors },
        { status: 400 }
      );
    }
    logger.error('Failed to update dataset', { error: serializeError(error) });
    return NextResponse.json(
      { error: 'Failed to update dataset' },
      { status: 500 }
    );
  }
}

// DELETE /api/datasets/[id]
export async function DELETE(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;
  const scopeCheck = requireScope(session, 'datasets:write');
  if (scopeCheck) return scopeCheck;

  try {
    const ownershipError = await requireOwnership('dataset', params.id, session);
    if (ownershipError) return ownershipError;
    // A STRAIGHT RETRY ON AN ALREADY-HIDDEN DATASET 404s, and that is not in
    // tension with the convergence property the tombstone writers guarantee.
    // `tombstoneDataset` converges on hidden for delete → RESTORE → delete,
    // which is the sequence that would otherwise leave a deleted dataset
    // visible; the restore in the middle makes this check pass. A retry with
    // the row still hidden is a write onto a hidden row like any other, and
    // letting it through would overwrite the first delete's `reason` with this
    // one's — losing the only record of why the corpus went away.
    const hiddenError = await assertDatasetLive(params.id);
    if (hiddenError) return hiddenError;

    // A0: `GoldenSet.datasetId` and `GoldenItem.sourceDatasetSampleId` are both
    // `onDelete: Restrict` (schema.prisma:671, :717), so this delete aborts on
    // any annotated corpus — via the set FK directly, or via the item FK when
    // the samples cascade. Unguarded that was a raw P2003 in a generic 500.
    // Same predicate, same 409 shape, as PUT /api/datasets/[id]/samples.
    const pinningGoldenSets = await findGoldenSetsPinningDataset(prisma, params.id);

    if (pinningGoldenSets.length > 0) {
      return NextResponse.json(
        {
          error:
            'Cannot delete this dataset: it is annotated by golden set(s) ' +
            `${pinningGoldenSets.map((g) => g.name).join(', ')}. ` +
            'A golden set is the annotation layer over exactly one dataset, and its items were ' +
            'imported from these samples. Delete the golden set first.',
          goldenSets: pinningGoldenSets,
        },
        { status: 409 }
      );
    }

    // A1 Decision 1: deleting a dataset HIDES it. `Dataset → DatasetSample` is
    // `onDelete: Cascade`, so the one statement this replaces took an entire
    // corpus with it — and with it every row a `GoldenItem.sourceDatasetSampleId`
    // still points at.
    //
    // The dataset's samples are deliberately NOT tombstoned one by one.
    // Decision 16: a sample inherits its parent's hidden state through
    // `liveSamplesOnly()`, whose `dataset: { NOT: { tombstone: … } }` clause
    // excludes every row of a hidden corpus from every filtered read. Looping
    // here would write N rows to say what this one row already says, and would
    // make un-hiding the dataset a second N-row job that can half-succeed. The
    // instinct to loop comes from the `Cascade` above; it does not apply,
    // because nothing is deleted.
    //
    // `prisma` satisfies `Prisma.TransactionClient` structurally — the same
    // call shape as `findGoldenSetsPinningDataset(prisma, …)` above — and a
    // single upsert is already atomic, so this needs no `$transaction`.
    await tombstoneDataset(prisma, params.id, 'dataset deleted');
    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error('Failed to delete dataset', { error: serializeError(error) });
    return NextResponse.json(
      { error: 'Failed to delete dataset' },
      { status: 500 }
    );
  }
}
