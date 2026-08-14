import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import type { DatasetSample } from '@prisma/client';
import { z } from 'zod';
import { requireAuth, requireScope, isAdmin } from '@/lib/auth-guard';
import { logger, serializeError } from '@/lib/logger';
import { findGoldenSetsPinningDataset } from '@/lib/golden-sets';
import { liveSamplesOnly, nextSampleIndex, tombstoneSamples } from '@/lib/tombstones';

const addSamplesSchema = z.object({
  samples: z.array(z.object({
    input: z.string().min(1),
    expected: z.string().optional().nullable(),
    metadata: z.record(z.unknown()).optional(),
  })).min(1),
});

const updateSampleSchema = z.object({
  sampleId: z.string(),
  input: z.string().min(1).optional(),
  expected: z.string().optional().nullable(),
  metadata: z.record(z.unknown()).optional().nullable(),
});

const deleteSamplesSchema = z.object({
  sampleIds: z.array(z.string()).min(1),
});

const bulkReplaceSamplesSchema = z.object({
  samples: z.array(z.object({
    input: z.string().min(1),
    expected: z.string().optional().nullable(),
    metadata: z.record(z.unknown()).optional(),
  })),
});

// POST /api/datasets/[id]/samples — add new samples to the dataset
export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;
  const scopeCheck = requireScope(session, 'datasets:write');
  if (scopeCheck) return scopeCheck;

  try {
    const dataset = await prisma.dataset.findUnique({
      where: { id: params.id },
      // `_count.samples` is UNFILTERED and stays that way. Do not spread
      // `liveSamplesOnly()` into it.
      //
      // The instinct this comment exists to stop is "sampleCount became a live
      // count, so filter this too" — and the step straight after that is
      // re-deriving `startIndex` from it, which is the exact formulation that
      // collides: hide sample 0 of 3 and a live count says 2 while index 2 is
      // occupied, so the very first insert P2002s on
      // @@unique([datasetId, index]). A tombstone frees no ordinal.
      //
      // Be clear about what this value is NOT: since A1 it is no longer the
      // ordinal source. `nextSampleIndex` below is, and it does its own
      // unfiltered read inside the insert transaction, which is where the
      // race-free high-water mark has to be read anyway. Nothing in this
      // handler consumes `_count.samples` any more; it is kept as the site
      // this disposition attaches to, and it is deliberately NOT one of the
      // `_count.samples` producers the rest of A1 filters — those all feed a
      // displayed total, and this one feeds nothing.
      select: { userId: true, _count: { select: { samples: true } } },
    });

    if (!dataset) {
      return NextResponse.json({ error: 'Dataset not found' }, { status: 404 });
    }
    if (dataset.userId !== session.user.id && !isAdmin(session)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const body = await request.json();
    const data = addSamplesSchema.parse(body);

    // A1: the high-water read and the inserts it feeds are ONE transaction,
    // and so is the count they leave behind. Before this, the creates were an
    // array-form $transaction and the count update was a separate round trip
    // after it.
    //
    // `nextSampleIndex` is max(index) over ALL rows INCLUDING HIDDEN, + 1. It
    // takes this callback's `tx` for the same reason `nextGoldenItemIndex`
    // does (src/lib/golden-sets.ts): a read-then-insert across a commit
    // boundary races a concurrent append, and the loser gets P2002 on
    // @@unique([datasetId, index]).
    //
    // This replaces `startIndex = dataset._count.samples`. A count is only
    // right while ordinals are dense, and they stop being dense the first time
    // anything is hidden — but the case that actually BITES is not a
    // tombstoned corpus, because `_count` is unfiltered and there
    // count == max + 1 so nothing collides. It bites on a corpus RE-IMPORTED
    // FROM A FILTERED EXPORT: src/lib/config.ts:389 emits `index: s.index`
    // verbatim and the importer writes it back, so the rows arrive with GAPS,
    // count < max + 1, and the first append lands on an occupied ordinal.
    const created = await prisma.$transaction(
      async (tx) => {
        const startIndex = await nextSampleIndex(tx, params.id);

        const rows: DatasetSample[] = [];
        for (let i = 0; i < data.samples.length; i++) {
          const s = data.samples[i];
          rows.push(
            await tx.datasetSample.create({
              data: {
                datasetId: params.id,
                index: startIndex + i,
                input: s.input,
                expected: s.expected ?? undefined,
                metadata: s.metadata ? JSON.stringify(s.metadata) : undefined,
              },
            })
          );
        }

        // `sampleCount` becomes a LIVE count. It was
        // `startIndex + data.samples.length`, which is the row count exactly
        // while ordinals are dense and drifts the moment `startIndex` is a
        // high-water mark: append 2 rows onto a 4-row corpus with a hole and a
        // hidden row and it stores 7 where the live answer is 5. The UI ladder
        // reads the stored value FIRST, so a wrong one shadows the live count
        // beneath it — the import picker advertises 620 and the import yields
        // 610.
        const live = await tx.datasetSample.count({
          where: { datasetId: params.id, ...liveSamplesOnly() },
        });

        await tx.dataset.update({
          where: { id: params.id },
          data: { sampleCount: live },
        });

        return rows;
      },
      // This is an INTERACTIVE transaction doing N sequential round trips, and
      // `addSamplesSchema` above puts no upper bound on N. Prisma's defaults
      // (maxWait 2s, timeout 5s) would therefore cap the endpoint at whatever
      // fits in 5s and fail the rest with P2028 -> a generic 500. The array-
      // form `$transaction([...])` this replaced was batched and NOT governed
      // by these options, so the ceiling is a behaviour change introduced with
      // the callback form and has to be raised deliberately rather than
      // inherited.
      //
      // Same ceiling and same reasoning as the other bulk-write path in this
      // tree, `POST /api/golden-sets` (src/app/api/golden-sets/route.ts:257),
      // whose comment states the rule outright: "an interactive transaction's
      // default 5s timeout will not survive 620 round trips". That route earns
      // its margin with `createMany`; this one CANNOT — the response body
      // returns the created rows and `createMany` returns only a count — so it
      // pays a round trip per row and needs the raised ceiling MORE, not less.
      { maxWait: 10_000, timeout: 60_000 }
    );

    return NextResponse.json({ added: created.length, samples: created }, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Validation failed', details: error.errors },
        { status: 400 }
      );
    }
    logger.error('Failed to add samples', { error: serializeError(error) });
    return NextResponse.json(
      { error: 'Failed to add samples' },
      { status: 500 }
    );
  }
}

// PATCH /api/datasets/[id]/samples — update a single sample
export async function PATCH(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;
  const scopeCheck = requireScope(session, 'datasets:write');
  if (scopeCheck) return scopeCheck;

  try {
    const dataset = await prisma.dataset.findUnique({
      where: { id: params.id },
      select: { userId: true },
    });

    if (!dataset) {
      return NextResponse.json({ error: 'Dataset not found' }, { status: 404 });
    }
    if (dataset.userId !== session.user.id && !isAdmin(session)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const body = await request.json();
    const data = updateSampleSchema.parse(body);

    // Verify the sample belongs to this dataset
    const sample = await prisma.datasetSample.findUnique({
      where: { id: data.sampleId },
      select: { datasetId: true },
    });

    if (!sample || sample.datasetId !== params.id) {
      return NextResponse.json({ error: 'Sample not found in this dataset' }, { status: 404 });
    }

    const updateData: Record<string, unknown> = {};
    if (data.input !== undefined) updateData.input = data.input;
    if (data.expected !== undefined) updateData.expected = data.expected;
    if (data.metadata !== undefined) {
      updateData.metadata = data.metadata ? JSON.stringify(data.metadata) : null;
    }

    const updated = await prisma.datasetSample.update({
      where: { id: data.sampleId },
      data: updateData,
    });

    return NextResponse.json(updated);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Validation failed', details: error.errors },
        { status: 400 }
      );
    }
    logger.error('Failed to update sample', { error: serializeError(error) });
    return NextResponse.json(
      { error: 'Failed to update sample' },
      { status: 500 }
    );
  }
}

// DELETE /api/datasets/[id]/samples — delete samples by ID
export async function DELETE(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;
  const scopeCheck = requireScope(session, 'datasets:write');
  if (scopeCheck) return scopeCheck;

  try {
    const dataset = await prisma.dataset.findUnique({
      where: { id: params.id },
      select: { userId: true },
    });

    if (!dataset) {
      return NextResponse.json({ error: 'Dataset not found' }, { status: 404 });
    }
    if (dataset.userId !== session.user.id && !isAdmin(session)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const body = await request.json();
    const data = deleteSamplesSchema.parse(body);

    // Verify all samples belong to this dataset.
    //
    // UNFILTERED, DELIBERATELY — do not spread `liveSamplesOnly()` in here.
    // An already-hidden id STILL BELONGS to this dataset, so a retried delete
    // must converge on hidden rather than answer 400 claiming the id is
    // foreign. Same rule, same wording, as the golden-item membership lookup
    // at src/app/api/golden-sets/[id]/items/route.ts:290-296.
    //
    // It is also what keeps `tombstoneSamples` usable: that helper raises
    // P2003 for an id that is not a real DatasetSample, because
    // `skipDuplicates` skips unique conflicts and not foreign-key ones. This
    // read is what turns a foreign id into the clean 400 below instead of a
    // generic 500 — deliberately loud in the helper, deliberately handled
    // here.
    //
    // NOTE this is the MEMBERSHIP read. The dataset OWNERSHIP read above is a
    // different site with a different disposition; leave it alone.
    const samples = await prisma.datasetSample.findMany({
      where: { id: { in: data.sampleIds }, datasetId: params.id },
      select: { id: true },
    });

    if (samples.length !== data.sampleIds.length) {
      return NextResponse.json(
        { error: 'Some samples not found in this dataset' },
        { status: 400 }
      );
    }

    // Same guard as PUT, and it was missing here — recorded as a known gap in
    // the migration header and closed in A0. A1 made this handler tombstone
    // the named rows, so GoldenItem.sourceDatasetSampleId's `Restrict` is no
    // longer what would refuse: nothing is deleted below any more, and the
    // re-index loop that used to renumber the survivors is gone too.
    //
    // THE GUARD STAYS ANYWAY, deliberately. Hiding a row removes it from every
    // filtered read exactly as deleting it did, so a corpus somebody has
    // annotated would still change shape under the annotation. Retiring this
    // guard belongs to the lifecycle work (Plan B), not to the overlay.
    //
    // The check stays DATASET-WIDE rather than per-sampleId. Its original
    // reason — "this handler re-indexes every surviving row afterwards" — is
    // now false, and the replacement is narrower but real: a golden item's
    // sourceDatasetSampleId may cite any row of the corpus, and hiding any row
    // changes what every filtered read of that corpus returns, including the
    // sample list an annotator reviews. Narrowing the scope to the named ids
    // is a behaviour change, and it belongs with the guard's retirement rather
    // than with the overlay.
    //
    // The predicate — including why it is NOT lifecycle-filtered — lives in
    // `findGoldenSetsPinningDataset` (src/lib/golden-sets.ts), shared with the
    // three other destructive paths that were missing this guard entirely:
    // PUT below, DELETE /api/datasets/[id], and the config importer's sample
    // replace.
    const pinningGoldenSets = await findGoldenSetsPinningDataset(prisma, params.id);

    if (pinningGoldenSets.length > 0) {
      return NextResponse.json(
        {
          error:
            'Cannot delete samples from this dataset: it is annotated by golden set(s) ' +
            `${pinningGoldenSets.map((g) => g.name).join(', ')}. ` +
            'Golden items were imported from these rows. ' +
            'Retire the golden set, or create a new dataset version instead.',
          goldenSets: pinningGoldenSets,
        },
        { status: 409 }
      );
    }

    // A1: hide + live count + persist, in ONE transaction. Before this, the
    // delete, the re-index and the count update were three separate round
    // trips, so a failure between them left a corpus whose stored count
    // disagreed with its rows. Same shape as the golden-items DELETE
    // (src/app/api/golden-sets/[id]/items/route.ts:284).
    //
    // The membership lookup and the pin guard stay OUTSIDE this transaction,
    // unlike their golden-items counterparts. Two reasons: they are reads that
    // gate the write and neither races anything (nothing hard-deletes a
    // DatasetSample on this branch any more), and keeping them out preserves
    // the existing precedence — a foreign id is a 400 even on a pinned
    // dataset. Moving them in would mean throwing typed errors out of the
    // callback, which Next.js 15 forces to be module-local classes because it
    // validates route.ts exports against a known allowlist.
    const result = await prisma.$transaction(async (tx) => {
      // `samples` rather than `data.sampleIds`: the lookup above already
      // resolved exactly the ids that belong here, and passing the resolved
      // set is what keeps the P2003 in `tombstoneSamples` unreachable.
      const tombstoned = await tombstoneSamples(
        tx,
        samples.map((s) => s.id),
        'sample deleted'
      );

      // ── THE RE-INDEX LOOP IS DELETED, NOT ADAPTED ──────────────────────
      // What stood here read every surviving row and renumbered it 0..n-1.
      // Neither form of it survives A1, and both failure modes are worth
      // naming because each looks plausible:
      //
      //   ADAPTED (filtered to live rows) it renumbers the first survivor to
      //   0 — which collides with the hidden row still holding 0, because
      //   @@unique([datasetId, index]) is not partial and a tombstone frees
      //   no ordinal. P2002, the transaction rolls back, and EVERY delete
      //   500s. The 20260813120000_v2e_golden_item_label_tombstones header
      //   documents the identical trap for golden items.
      //
      //   KEPT VERBATIM it is worse in a quieter way: its query has no
      //   lifecycle filter, so `remaining` is every row, still dense, and
      //   each update writes the index the row already holds — a silent
      //   no-op whose `remaining.length` then becomes a stored ROW count in
      //   `sampleCount` and in the response body.
      //
      // Ordinals are simply no longer dense. `index` guarantees only
      // uniqueness within the dataset and monotonic insertion order; the next
      // one is a high-water mark (`nextSampleIndex`, src/lib/tombstones.ts),
      // never a count and never a reused ordinal.

      // `sampleCount` becomes a LIVE count — and the response body reads the
      // same value, so the two move together. Both used to come from
      // `remaining.length`, the length of the re-index read, which is a ROW
      // count: on a corpus carrying any hidden row it over-reports. The UI
      // ladder reads the stored `sampleCount` FIRST, so a stale value shadows
      // the live count beneath it — the import picker advertises 620 and the
      // import yields 610.
      const remaining = await tx.datasetSample.count({
        where: { datasetId: params.id, ...liveSamplesOnly() },
      });

      await tx.dataset.update({
        where: { id: params.id },
        data: { sampleCount: remaining },
      });

      // `deleted` is renamed to `tombstoned`, matching what A0 did to the
      // sibling endpoint (golden-sets/[id]/items/route.ts:313). Nothing is
      // deleted here any more, and `deleted` is the one word that would let a
      // caller conclude the row is gone. No client reads the key — the only
      // caller in the tree, src/app/datasets/[id]/page.tsx:332-357, checks
      // `res.ok` and `data.error` and nothing else — so an external script
      // gets `undefined`, a loud break rather than a quiet lie.
      //
      // The counting rule differs from the golden-items route ON PURPOSE:
      // `tombstoneSamples` returns the number of DISTINCT ids NOW HIDDEN, so a
      // repeated delete reports `tombstoned: 1`, whereas golden-items'
      // `updateMany … tombstonedAt: null` reports 0 on the retry
      // (tests/db/golden-sets.test.ts:1123). "Now hidden" is the property this
      // handler converges on.
      return { tombstoned, remaining };
    });

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Validation failed', details: error.errors },
        { status: 400 }
      );
    }
    logger.error('Failed to delete samples', { error: serializeError(error) });
    return NextResponse.json(
      { error: 'Failed to delete samples' },
      { status: 500 }
    );
  }
}

// PUT /api/datasets/[id]/samples — bulk replace all samples (used by revert)
export async function PUT(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;
  const scopeCheck = requireScope(session, 'datasets:write');
  if (scopeCheck) return scopeCheck;

  try {
    const dataset = await prisma.dataset.findUnique({
      where: { id: params.id },
      select: { userId: true },
    });

    if (!dataset) {
      return NextResponse.json({ error: 'Dataset not found' }, { status: 404 });
    }
    if (dataset.userId !== session.user.id && !isAdmin(session)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // A0 (20260812190000_v2d_golden_substrate): GoldenItem.sourceDatasetSampleId
    // is `onDelete: Restrict`. This handler deletes every sample and recreates
    // them with new ids, so once a golden set has annotated this dataset the
    // replace MUST fail — a corpus somebody has annotated must not drift under
    // the annotation. Refuse deliberately, naming the sets that pinned it,
    // rather than letting Postgres raise a P2003 the catch below reports as a
    // generic 500. Checked BEFORE the transaction so nothing is deleted.
    //
    // The predicate — including why it is NOT lifecycle-filtered — now lives in
    // `findGoldenSetsPinningDataset` (src/lib/golden-sets.ts), shared with the
    // three other destructive paths that were missing this guard entirely:
    // DELETE below, DELETE /api/datasets/[id], and the config importer's
    // sample replace.
    const pinningGoldenSets = await findGoldenSetsPinningDataset(prisma, params.id);

    if (pinningGoldenSets.length > 0) {
      return NextResponse.json(
        {
          error:
            'Cannot replace this dataset\'s samples: it is annotated by golden set(s) ' +
            `${pinningGoldenSets.map((g) => g.name).join(', ')}. ` +
            'Replacing samples would delete the rows those golden items were imported from. ' +
            'Retire the golden set, or create a new dataset version instead.',
          goldenSets: pinningGoldenSets,
        },
        { status: 409 }
      );
    }

    const body = await request.json();
    const data = bulkReplaceSamplesSchema.parse(body);

    // Atomic: delete old + create new + update count in one transaction
    const newSamples = await prisma.$transaction(async (tx) => {
      await tx.datasetSample.deleteMany({
        where: { datasetId: params.id },
      });

      if (data.samples.length > 0) {
        for (let i = 0; i < data.samples.length; i++) {
          const s = data.samples[i];
          await tx.datasetSample.create({
            data: {
              datasetId: params.id,
              index: i,
              input: s.input,
              expected: s.expected ?? undefined,
              metadata: s.metadata ? JSON.stringify(s.metadata) : undefined,
            },
          });
        }
      }

      await tx.dataset.update({
        where: { id: params.id },
        data: { sampleCount: data.samples.length },
      });

      return tx.datasetSample.findMany({
        where: { datasetId: params.id },
        orderBy: { index: 'asc' },
      });
    });

    return NextResponse.json({ replaced: newSamples.length, samples: newSamples });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Validation failed', details: error.errors },
        { status: 400 }
      );
    }
    logger.error('Failed to replace samples', { error: serializeError(error) });
    return NextResponse.json(
      { error: 'Failed to replace samples' },
      { status: 500 }
    );
  }
}
