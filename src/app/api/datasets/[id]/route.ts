import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { z } from 'zod';
import { requireAuth, requireScope, optionalAuth, resolveResourceAccess, requireOwnership, RateLimitedError } from '@/lib/auth-guard';
import { logger, serializeError } from '@/lib/logger';
import { toPublicDataset } from '@/lib/serializers';
import { findGoldenSetsPinningDataset } from '@/lib/golden-sets';
import {
  liveDatasetsOnly,
  liveSamplesOnly,
  tombstoneDataset,
} from '@/lib/tombstones';

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
 * had already deleted — and now that the list and detail reads ARE filtered
 * (the `GET` below, and `datasets/route.ts`), that rename lands on a row
 * nothing returns.
 *
 * IT ANSWERS 404, NOT 409, unlike its golden-set counterpart, and the
 * difference is not cosmetic. A retired golden set stays visible to its owner
 * under `?includeRetired=true` and has an un-retire verb, so a bare 404 would
 * confuse someone looking straight at it. A hidden dataset has neither: no
 * escape flag, and no un-delete verb anywhere in A1. 404 is also what this
 * branch already answers everywhere else — all nine dataset guard reads Task 7
 * converted return it, and the list and detail reads are now in line with them
 * (`GET` below filters, so a hidden dataset 404s there too).
 * A 409 here would leave one handler in the set saying something different.
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

    const dataset = await prisma.dataset.findFirst({
      // A1: a hidden dataset 404s here, exactly as a deleted one used to.
      //
      // `findFirst`, NOT `findUnique`, and the swap is forced rather than
      // stylistic: spreading a `DatasetWhereInput` into a
      // `DatasetWhereUniqueInput` widens `id` to `string | StringFilter`,
      // which the unique input does not accept, and TypeScript then fails the
      // whole overload — silently dropping every `include` from the inferred
      // result type, so the reported errors land ten lines below on
      // `dataset.samples`. `id` is still the primary key, so this matches at
      // most one row either way. Same call shape as `assertDatasetLive` above
      // and as all nine guard reads Task 7 converted.
      where: { id: params.id, ...liveDatasetsOnly() },
      include: {
        user: { select: { id: true, name: true, email: true } },
        project: { select: { id: true, name: true } },
        samples: {
          where: liveSamplesOnly(),
          orderBy: { index: 'asc' },
          take: 100,
        },
        versions: {
          // MEMBERSHIP FIRST. `Dataset.versions` is
          // `Dataset[] @relation("DatasetVersions")` (schema.prisma) — a list
          // of Dataset ROWS, and the one such list on this branch that was
          // left unfiltered. Unfiltered it served a hidden child version to
          // ANONYMOUS callers: this route is `optionalAuth`, the root only has
          // to be `visibility: 'public'`, and the public branch below passes
          // `versions` through OUTSIDE `toPublicDataset`, so the serializer's
          // allow-list never saw it. `GET /api/datasets/[id]/versions` has
          // filtered its family read since Task 9, so the two endpoints
          // contradicted each other about which versions exist. A
          // `dataset.findMany` grep does not surface this line — it is a
          // nested relation arg, the same blind spot as the `datasets:` select
          // in projects/[id]/route.ts.
          //
          // The COUNT rung is a separate question and its answer has not
          // changed: what is selected here is the STORED `sampleCount`, there
          // is no `_count` to filter, and keeping that number truthful is the
          // write side's job rather than this read's.
          where: liveDatasetsOnly(),
          select: { id: true, version: true, createdAt: true, sampleCount: true },
          orderBy: { version: 'desc' },
        },
        // A hidden PARENT, same class one level up. `Dataset.parent` is an
        // OPTIONAL to-one, so it carries a `where` like any other read (see the
        // nested-to-ONE block in src/lib/tombstones.ts) and a hidden parent
        // comes back `null` — the `parentId` scalar beside it stays populated.
        // Smaller than the `versions` leak because `toPublicDataset` already
        // emits `parentId`, so all this adds is the parent's `version`; nulled
        // for the same reason anyway, because a live child that still names
        // the version it forked from contradicts the 404 that id now answers.
        parent: {
          where: liveDatasetsOnly(),
          select: { id: true, version: true },
        },
        // A1: the LIVE sample count, for both the owner branch (returned
        // verbatim) and the public branch (via toPublicDataset's
        // `sampleTotal`).
        _count: { select: { samples: { where: liveSamplesOnly() } } },
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

    // A hidden parent is already `null` here — the filter is on the read, so
    // the owner arm and the anonymous arm cannot disagree about it. The
    // `versions` leak was exactly a sub-object that reached the public arm
    // without passing through the serializer; filtering at the query is what
    // makes that class unreachable rather than merely handled.
    const body = dataset;

    if (decision.access === 'owner') {
      return NextResponse.json(body);
    }

    // Public view: PII-stripped dataset core + the same samples/versions/
    // parent sub-objects (none of which join user data, so they're already
    // safe to pass through verbatim — see the GET include above).
    return NextResponse.json({
      ...toPublicDataset(body),
      samples: body.samples,
      versions: body.versions,
      parent: body.parent,
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
        // A1: the LIVE sample count. The dataset page re-renders from this
        // response, so an unfiltered count here shows a stale number until
        // the next full reload.
        _count: { select: { samples: { where: liveSamplesOnly() } } },
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
    // A STRAIGHT RETRY ON AN ALREADY-HIDDEN DATASET 404s, for the plain
    // reason: a hidden dataset is closed to writes, and delete is a write.
    //
    // THE SAMPLE-LEVEL CONVERGENCE PROPERTY DOES NOT TRANSFER, and the
    // resulting asymmetry is a stated choice rather than an oversight:
    //
    //   a retried SAMPLE delete is 200 and idempotent,
    //   a retried DATASET delete is 404.
    //
    // `tombstoneSamples` never P2002s and always converges on hidden, and the
    // DELETE samples verb keeps its membership lookup unfiltered precisely so
    // a retry can reach an already-hidden row. But every one of those retries
    // operates on rows inside a corpus that is itself still live and still
    // writable. A retried dataset delete has no such standing — its target IS
    // the hidden row. Same reason PATCH above refuses.
    //
    // `tombstoneDataset`'s own convergence is untouched and still required. It
    // guarantees delete → RESTORE → delete, the sequence that would otherwise
    // leave a deleted-then-restored-then-deleted dataset visible; the restore
    // in the middle is what puts the row back within reach of this check.
    // Both halves are pinned in tests/db/dataset-sample-tombstone.test.ts.
    const hiddenError = await assertDatasetLive(params.id);
    if (hiddenError) return hiddenError;

    // A0 put this guard here because `GoldenSet.datasetId` and
    // `GoldenItem.sourceDatasetSampleId` are both `onDelete: Restrict`
    // (schema.prisma), so `dataset.delete` aborted on any annotated corpus —
    // via the set FK directly, or via the item FK when the samples cascaded —
    // and unguarded that was a raw P2003 in a generic 500.
    //
    // THAT REASON NO LONGER APPLIES HERE. The delete below is
    // `tombstoneDataset`: it writes one `Tombstone` row and touches no foreign
    // key, so there is no P2003 left for this guard to pre-empt on this path.
    //
    // THE GUARD STAYS ANYWAY, deliberately — the same re-justification both
    // sample verbs got when the same thing happened to them
    // (samples/route.ts's DELETE and PUT). Hiding a corpus removes it from
    // every filtered read exactly as deleting it did, so an annotated corpus
    // would still change shape under its annotation. Whether that is allowed
    // is the lifecycle plan's call (Plan B), not the overlay's. It is now a
    // PURE-POLICY 409 on an operation that is physically safe, and that is the
    // honest description of it.
    //
    // WHICH IS WHY THE MESSAGE NAMES NO REMEDY. `DELETE /api/golden-sets/[id]`
    // only stamps `tombstonedAt`, and `findGoldenSetsPinningDataset` is
    // deliberately NOT lifecycle-filtered (correctly — see its doc), so a
    // deleted or retired set still pins. "Delete the golden set first", which
    // this message used to say, sent the user to do something that provably
    // changes nothing and then names a set they can no longer see. There is no
    // in-product escape at all until a purge path exists, so the message says
    // that instead of inventing one.
    const pinningGoldenSets = await findGoldenSetsPinningDataset(prisma, params.id);

    if (pinningGoldenSets.length > 0) {
      return NextResponse.json(
        {
          error:
            'Cannot delete this dataset: it is annotated by golden set(s) ' +
            `${pinningGoldenSets.map((g) => g.name).join(', ')}. ` +
            'A golden set is the annotation layer over exactly one dataset, and its items were ' +
            'imported from these samples. Deleting or retiring that golden set does not release ' +
            'the dataset — the binding survives both — so this corpus cannot be deleted for as ' +
            'long as the set exists.',
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
