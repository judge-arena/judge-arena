import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import type { DatasetSample } from '@prisma/client';
import { z } from 'zod';
import { requireAuth, requireScope, isAdmin } from '@/lib/auth-guard';
import { logger, serializeError } from '@/lib/logger';
import { findGoldenSetsPinningDataset } from '@/lib/golden-sets';
import {
  liveDatasetsOnly,
  liveSamplesOnly,
  nextSampleIndex,
  tombstoneSamples,
} from '@/lib/tombstones';
import { recordSampleRevision, recordSampleRevisions } from '@/lib/sample-revisions';

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

// DECISION 15 — A HIDDEN DATASET IS CLOSED TO WRITES. All four verbs in this
// file open with the same ownership guard read, and all four now spread
// `liveDatasetsOnly()` into it, so a tombstoned dataset 404s on write.
// `findFirst` rather than `findUnique` so the id and the overlay predicate
// travel in one plain `where`.
//
// THE READ SIDE HAS SINCE CAUGHT UP: `datasets/route.ts` (list, and its
// pagination count) and `datasets/[id]/route.ts` (detail) both spread
// `liveDatasetsOnly()` now, so a hidden dataset is neither readable nor
// writable. The two halves landed in that order, three commits apart
// (`431ed3a` and `f530556` fell between them); nothing here had to change
// when the read half arrived.
//
// TWO OF THE FOUR WERE ACTIVELY BROKEN WITHOUT IT, not merely permissive, and
// for the same reason: `liveSamplesOnly()` carries a PARENT arm, so the sample
// reads INSIDE these handlers already saw nothing under a hidden dataset while
// the writes around them still landed.
//   POST  wrote `sampleCount: 0` over a live corpus and returned 201.
//   PUT   answered `replaced: 0` with an empty `samples` array while appending
//         the incoming document AND never tombstoning the outgoing rows — so
//         un-hiding the dataset returned BOTH sets, live, with a `sampleCount`
//         describing only the later one and nothing recording which was which.
// The guard closes both by refusing before the transaction opens. Both are
// pinned in tests/db/dataset-sample-tombstone.test.ts.
//
// POST /api/datasets/[id]/samples — add new samples to the dataset
export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;
  const scopeCheck = requireScope(session, 'datasets:write');
  if (scopeCheck) return scopeCheck;

  try {
    const dataset = await prisma.dataset.findFirst({
      where: { id: params.id, ...liveDatasetsOnly() },
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
    // takes this callback's `tx` so the mark and the rows it numbers commit or
    // roll back together, and so the read can see writes this transaction has
    // already made.
    //
    // IT DOES NOT MAKE THE APPEND SAFE AGAINST A CONCURRENT ONE, and the
    // earlier version of this comment said it did. The aggregate takes no
    // lock and these transactions run at READ COMMITTED, so two callers can
    // read the same mark and the loser still gets P2002 on
    // @@unique([datasetId, index]) — which this handler's catch turns into a
    // bare 500. Being inside a transaction narrows the window (the read this
    // replaced was outside one) without closing it. The fix is a retry loop,
    // the shape `createDatasetVersion` already uses; see `nextSampleIndex`'s
    // own doc in src/lib/tombstones.ts.
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
      // tree, `POST /api/golden-sets` (src/app/api/golden-sets/route.ts:274),
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

    const body = await request.json();
    const data = updateSampleSchema.parse(body);

    // Verify the sample belongs to this dataset AND is still live. A hidden
    // sample must 404 here, or it stays silently editable while every read
    // path hides it — an edit nobody can see and nobody can review.
    // `findFirst`, because the live predicate is a relation filter layered on
    // top of the id.
    //
    // L2 widened the `select` to carry the BEFORE-IMAGE the revision records.
    // Selected here rather than re-read inside the transaction because this
    // lookup already runs, and a second read would be a second round trip for
    // the same row. The `where` is L1's and is not L2's to touch.
    const sample = await prisma.datasetSample.findFirst({
      where: { id: data.sampleId, ...liveSamplesOnly() },
      select: {
        datasetId: true,
        input: true,
        expected: true,
        metadata: true,
      },
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

    // L2: ONE transaction, so a rolled-back update leaves no revision claiming
    // it happened. Before this, PATCH overwrote sample text with no history at
    // all — it is the one verb L1 left untouched, because hiding a row and
    // editing one are different losses and only the second destroys content.
    //
    // The revision carries the FULL before-image, not just the fields the
    // request named: the log answers "what did this row look like before",
    // which a partial image cannot reconstruct.
    const updated = await prisma.$transaction(async (tx) => {
      await recordSampleRevision(tx, {
        datasetSampleId: data.sampleId,
        changeType: 'edit',
        actorId: session.user.id,
        before: {
          input: sample.input,
          expected: sample.expected,
          metadata: sample.metadata,
        },
      });

      return tx.datasetSample.update({
        where: { id: data.sampleId },
        data: updateData,
      });
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
            'Create a new dataset version instead — retiring or deleting the golden set does not ' +
            'release the binding, so it will not lift this refusal.',
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
      // L2: which of the resolved ids are still LIVE — precisely the set about
      // to transition, and precisely what the log must record. Read BEFORE the
      // tombstone write below, or every id looks already-hidden.
      //
      // FILTERED ON PURPOSE, and it is not the membership lookup above. That
      // one is deliberately unfiltered so a retried delete converges on hidden
      // instead of 400ing; this one asks the narrower question "which of these
      // are still live", whose answer is the log's.
      //
      // It cannot be `tombstoneSamples`' return value: that counts DISTINCT
      // IDS NOW HIDDEN, which counts an already-hidden row again. Right for
      // the response body, wrong for a log — a second `delete` revision would
      // record a deletion that did not happen.
      const newlyHidden = await tx.datasetSample.findMany({
        where: { id: { in: samples.map((s) => s.id) }, ...liveSamplesOnly() },
        select: { id: true },
      });

      // `samples` rather than `data.sampleIds`: the lookup above already
      // resolved exactly the ids that belong here, and passing the resolved
      // set is what keeps the P2003 in `tombstoneSamples` unreachable.
      const tombstoned = await tombstoneSamples(
        tx,
        samples.map((s) => s.id),
        'sample deleted'
      );

      await recordSampleRevisions(tx, {
        datasetSampleIds: newlyHidden.map((s) => s.id),
        changeType: 'delete',
        actorId: session.user.id,
      });

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

    // A0 (20260812190000_v2d_golden_substrate): GoldenItem.sourceDatasetSampleId
    // is `onDelete: Restrict`. A1 made this handler tombstone-and-append, so
    // that FK is no longer what would refuse — nothing is deleted here any
    // more. THE GUARD STAYS ANYWAY, and deliberately: a corpus somebody has
    // annotated must not drift under the annotation, and the replace below
    // hides every live row of it. Retiring this guard belongs to the
    // lifecycle work (Plan B), not to the overlay — do not remove it here.
    // The PUT block of tests/db/dataset-sample-freeze.test.ts pins this 409
    // twice, including for a set whose items are themselves tombstoned; its
    // third test asserts the 200 for a set over a DIFFERENT dataset.
    //
    // The predicate — including why it is NOT lifecycle-filtered — lives in
    // `findGoldenSetsPinningDataset` (src/lib/golden-sets.ts), shared with the
    // three other destructive paths that were missing this guard entirely:
    // DELETE above, DELETE /api/datasets/[id], and the config importer's
    // sample replace.
    const pinningGoldenSets = await findGoldenSetsPinningDataset(prisma, params.id);

    if (pinningGoldenSets.length > 0) {
      return NextResponse.json(
        {
          error:
            'Cannot replace this dataset\'s samples: it is annotated by golden set(s) ' +
            `${pinningGoldenSets.map((g) => g.name).join(', ')}. ` +
            'Replacing samples would hide the rows those golden items were imported from. ' +
            'Create a new dataset version instead — retiring or deleting the golden set does not ' +
            'release the binding, so it will not lift this refusal.',
          goldenSets: pinningGoldenSets,
        },
        { status: 409 }
      );
    }

    const body = await request.json();
    const data = bulkReplaceSamplesSchema.parse(body);

    // Atomic: hide the outgoing rows + append the incoming above the
    // high-water mark + update the live count, in one transaction.
    const newSamples = await prisma.$transaction(
      async (tx) => {
        // Read the outgoing set FIRST. After the appends below, a dataset-wide
        // read would sweep the rows we are about to create as well.
        //
        // Filtered, so an already-hidden row is not re-tombstoned: `upsert`'s
        // update arm would overwrite the reason recording why it went away with
        // this replace's reason.
        const outgoing = await tx.datasetSample.findMany({
          where: { datasetId: params.id, ...liveSamplesOnly() },
          select: { id: true },
        });

        if (outgoing.length > 0) {
          await tombstoneSamples(tx, outgoing.map((s) => s.id), 'bulk replace');

          // L2. No "which of these transitioned" read is needed here, unlike
          // DELETE: `outgoing` IS the filtered live set, so every row in it
          // transitions by construction. Inside the guard, so a replace over an
          // empty corpus logs nothing rather than a no-op.
          await recordSampleRevisions(tx, {
            datasetSampleIds: outgoing.map((s) => s.id),
            changeType: 'delete',
            actorId: session.user.id,
          });
        }

        // Ordinals are no longer dense. The outgoing rows still hold 0..n-1, so
        // the incoming document appends ABOVE max(index) over ALL rows —
        // including hidden ones — or the first insert collides on
        // @@unique([datasetId, index]). Never `count()`, and read inside this
        // same tx as the inserts it feeds.
        const startIndex = await nextSampleIndex(tx, params.id);

        for (let i = 0; i < data.samples.length; i++) {
          const s = data.samples[i];
          await tx.datasetSample.create({
            data: {
              datasetId: params.id,
              index: startIndex + i,
              input: s.input,
              expected: s.expected ?? undefined,
              metadata: s.metadata ? JSON.stringify(s.metadata) : undefined,
            },
          });
        }

        // LEAVE THIS AS `data.samples.length`. `sampleCount` is a live row
        // count, and after tombstone-and-append the live set IS the incoming
        // document — every prior row was just hidden and every incoming row was
        // just created. This is not the stale-count bug the other verbs have;
        // "fixing" it to count rows would make it wrong.
        await tx.dataset.update({
          where: { id: params.id },
          data: { sampleCount: data.samples.length },
        });

        // FILTERED. Unfiltered this answers with the rows it just hid — a 4-row
        // replace over a 4-row corpus reports `replaced: 8` at the return below
        // and hands the client four hidden rows.
        return tx.datasetSample.findMany({
          where: { datasetId: params.id, ...liveSamplesOnly() },
          orderBy: { index: 'asc' },
        });
      },
      // Same ceiling, same reasoning, as the POST above and as
      // `POST /api/golden-sets` (src/app/api/golden-sets/route.ts:274). This is
      // an INTERACTIVE transaction doing a round trip PER INCOMING ROW, and
      // `bulkReplaceSamplesSchema` puts no upper bound on N — so Prisma's
      // defaults (maxWait 2s, timeout 5s) would cap the endpoint at whatever
      // fits in 5s and fail the rest with P2028 -> a generic 500.
      //
      // It was already the callback form before A1, so unlike the POST this is
      // not a ceiling introduced by a form change — it is one that was missing
      // all along, on the path a 620-row REVERT goes through
      // (src/app/datasets/[id]/page.tsx:416-435).
      //
      // These options exist ONLY on the callback overload; the array form takes
      // `isolationLevel` alone (generated client, index.d.ts:402 and :404).
      { maxWait: 10_000, timeout: 60_000 }
    );

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
