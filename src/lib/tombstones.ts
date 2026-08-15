/**
 * ─── The tombstone overlay (A1) ────────────────────────────────────────────
 *
 * Deleting a Dataset or a DatasetSample HIDES it. One `Tombstone` row per
 * entity, keyed by whichever FK column applies, with a hand-edited CHECK
 * (`Tombstone_exactly_one_entity`, 20260814120000_v2f_tombstone_overlay)
 * guaranteeing exactly one is non-null.
 *
 * THIS MODULE IS THE SINGLE DEFINITION OF "HIDDEN". Every read site spreads
 * one of the two filters below — or, where the read is a nested to-ONE
 * relation argument and so can carry no `where` at all, projects its result
 * through `liveOrNull` / `withLiveCorpusRefs` (see the block above those two).
 * Every destructive verb calls one of the writers.
 * It lives in src/lib/ rather than inside the route handlers because
 * `src/app/api/**` is outside every vitest coverage `include`, and the shape
 * of these predicates is precisely the thing that is cheap to pin in a unit
 * test and expensive to discover in a 620-row corpus.
 *
 * NOT A0's `tombstonedAt` COLUMN FORM, AND THE TWO MUST NOT BE HARMONISED.
 * `goldenSetLifecycleWhere` (src/lib/golden-sets.ts) pins `tombstonedAt: null`
 * in BOTH arms precisely so a tombstoned golden set has no way back. This
 * overlay is reversible by design — see `restoreSample`. Two mechanisms with
 * different capabilities, coexisting on purpose.
 *
 * WHAT THIS MODULE CANNOT REACH: `dataset-evaluation-summary.ts:119` is a
 * `$queryRaw ... FOR UPDATE`. "Spread the helper" does not apply to raw SQL,
 * and that read is deliberately left alone.
 */

import type { Prisma } from '@prisma/client';

/**
 * Live samples: not hidden themselves, and not owned by a hidden dataset
 * (design decision 16 — samples inherit their parent's hidden state).
 *
 * WHY A `NOT` KEY AND NOT AN `OR`. The obvious spelling is
 *
 *     { OR: [{ tombstone: { is: null } }, { tombstone: { isTombstone: false } }] }
 *
 * and it cannot be used, because an object literal cannot carry two `OR` keys
 * and FOUR dataset read sites already build their own — `datasets/route.ts:67`,
 * `stats/route.ts:47`, `datasets/[id]/versions/route.ts:155`,
 * `dataset-versions.ts:157`. Spreading an `OR` into any of those would
 * silently clobber one clause or the other, with no type error and no test
 * failure.
 *
 * `NOT` collides with `NOT` identically, so this is a rule rather than an
 * escape: the only `NOT:` in src/ today is `auth.ts:49`, on a different model.
 * A caller that already has a `NOT:` key must MERGE, not spread. Same for the
 * `dataset:` key below.
 *
 * WHY THE `NOT` IS CORRECT, not merely defensive. Prisma compiles an optional
 * to-one with a `@unique` FK to a LEFT JOIN plus an INJECTED `IS NOT NULL` on
 * the joined id — verified against 6.19.2 on the equivalent
 * `EvaluationRun ← HumanJudgment` pair:
 *
 *     LEFT JOIN "HumanJudgment" AS "j0" ON ("j0"."runId") = ("EvaluationRun"."id")
 *     WHERE (NOT ("j0"."overallScore" = $1 AND ("j0"."id" IS NOT NULL)))
 *
 * So: no tombstone row → returned; `isTombstone: false` → returned;
 * `isTombstone: true` → excluded. The `@unique` on each FK is what guarantees
 * the join matches at most one tombstone.
 *
 * TYPE-SAFETY WARNING FOR ONE CALLER. `src/app/api/datasets/route.ts` declares
 * its list predicate as `const where: any = {}`, so this return type offers
 * ZERO protection there. That route's `findMany` and its pagination `count`
 * both read ONE derived object, `const liveWhere = { ...where,
 * ...liveDatasetsOnly() }` — deliberately, because filtering one and not the
 * other desynchronises the total from the page it is counting, with no type
 * error to catch it. Do not re-inline either call site's `where`.
 */
export function liveSamplesOnly(): Prisma.DatasetSampleWhereInput {
  return {
    NOT: { tombstone: { is: { isTombstone: true } } },
    dataset: { NOT: { tombstone: { is: { isTombstone: true } } } },
  };
}

/**
 * Live datasets: not hidden.
 *
 * Same `NOT`-not-`OR` argument as `liveSamplesOnly` above, and the same
 * merge-don't-spread rule for a caller that already carries a `NOT:` key. One
 * clause rather than two: a dataset has no parent whose hidden state it
 * inherits — `Dataset.parent` is version lineage, not ownership.
 *
 * Returns a fresh object on every call rather than a module constant, because
 * callers spread it into a `where` they then mutate.
 */
export function liveDatasetsOnly(): Prisma.DatasetWhereInput {
  return { NOT: { tombstone: { is: { isTombstone: true } } } };
}

/* ─── The nested to-ONE case, which neither filter above can reach ──────────
 *
 * `liveSamplesOnly()` and `liveDatasetsOnly()` are `where` fragments, and a
 * `where` is the one thing Prisma does NOT accept on a nested to-ONE relation
 * argument. `Evaluation.dataset`, `Evaluation.datasetSample`, `Dataset.parent`
 * and `GoldenSet.dataset` all take `select`/`include` and nothing else, so
 * "spread the helper into every read site" — the rule the rest of this module
 * states — has no spelling here at all. That is why the sweeps missed the
 * class rather than a site: every grep they ran was for a read that could
 * carry a filter.
 *
 * WHAT THE OVERLAY OWES THESE READS. `Evaluation.datasetId` and
 * `Evaluation.datasetSampleId` are both `onDelete: SetNull`
 * (prisma/schema.prisma), so before A1 deleting a corpus or a row NULLED the
 * reference and every one of these args returned `null` by construction.
 * Every consumer in the tree is already written for that — `evaluation.dataset
 * && …`, `dataset?.name ?? ''`, `datasetSample?.index ?? 0`. A1 kept the row
 * alive and turned all of them back on, which is a regression the overlay
 * introduced and not an inherited gap.
 *
 * SO THE FILTER IS A PROJECTION, not a predicate: select the hidden flag
 * alongside the columns the caller wanted, and null the whole sub-object
 * afterwards. The FK column beside it is deliberately left populated — that is
 * strictly more than `SetNull` left behind, and `dataset-run-groups.ts` groups
 * on `datasetId` rather than on `dataset.id`, so grouping survives a delete
 * that used to break it.
 *
 * NOT AN INVITATION TO NULL EVERY SUCH ARG. Three `GoldenSet.dataset` sites
 * are deliberately left whole and marked MUST NOT BE TOMBSTONE-FILTERED (A1);
 * see the reasons at those sites.
 */

/** The marker to select beside the caller's own columns on a to-one
 * `dataset:` / `datasetSample:` / `parent:` argument, so `liveOrNull` below
 * has something to test. Written as the whole nested arg
 * (`tombstone: tombstoneFlagSelect`) so no call site has to restate the shape. */
export const tombstoneFlagSelect = { select: { isTombstone: true } } as const;

/**
 * The sample's marker PAIR, spread into a to-one `datasetSample:` select.
 *
 * TWO markers, for the same reason `liveSamplesOnly()` has two clauses:
 * decision 16, a sample inherits its parent's hidden state. Selecting only the
 * sample's own tombstone makes hiding a whole CORPUS leave its rows visible
 * through every evaluation that cites one — the exact asymmetry
 * `DELETE /api/datasets/[id]` relies on not existing, since it deliberately
 * writes ONE tombstone and never a row per sample.
 *
 * The `dataset:` key it adds is stripped again by `liveSampleOrNull`, so the
 * shape that reaches a response is the one the call site asked for.
 */
export const sampleTombstoneFlagSelect = {
  tombstone: tombstoneFlagSelect,
  dataset: { select: { tombstone: tombstoneFlagSelect } },
} as const;

interface MaybeHidden {
  tombstone?: { isTombstone: boolean } | null;
}

interface MaybeHiddenSample extends MaybeHidden {
  dataset?: { tombstone?: { isTombstone: boolean } | null } | null;
}

/**
 * A to-one relation's value if it is live, `null` if it is hidden — and with
 * the marker stripped either way, so `tombstone: { isTombstone: false }` never
 * reaches a response body.
 *
 * The test is `=== true` rather than truthiness for the same reason the `NOT`
 * formulation above is what it is: `undefined` (no marker selected) and `null`
 * (no tombstone row) and `false` (hidden then restored) all mean LIVE, and
 * only `true` means hidden.
 */
export function liveOrNull<T extends MaybeHidden>(
  related: T | null | undefined
): Omit<T, 'tombstone'> | null {
  if (!related) return null;
  const { tombstone, ...rest } = related;
  return tombstone?.isTombstone === true ? null : (rest as Omit<T, 'tombstone'>);
}

/**
 * `liveOrNull` for a to-one `datasetSample:`, carrying decision 16's parent
 * arm — see `sampleTombstoneFlagSelect` above. Strips BOTH markers, so the
 * `dataset:` key this needs never reaches a response body.
 */
export function liveSampleOrNull<T extends MaybeHiddenSample>(
  sample: T | null | undefined
): Omit<T, 'tombstone' | 'dataset'> | null {
  if (!sample) return null;
  const { tombstone, dataset, ...rest } = sample;
  if (tombstone?.isTombstone === true) return null;
  if (dataset?.tombstone?.isTombstone === true) return null;
  return rest as Omit<T, 'tombstone' | 'dataset'>;
}

/**
 * The pair, applied to one evaluation-shaped row. Every site that joins
 * `Evaluation.dataset` also joins `Evaluation.datasetSample` — the two are
 * always selected together, in all eight files — so one function keeps them
 * from being dispositioned differently by accident.
 */
export function withLiveCorpusRefs<
  E extends { dataset: MaybeHidden | null; datasetSample: MaybeHiddenSample | null },
>(
  evaluation: E
): Omit<E, 'dataset' | 'datasetSample'> & {
  dataset: Omit<NonNullable<E['dataset']>, 'tombstone'> | null;
  datasetSample: Omit<NonNullable<E['datasetSample']>, 'tombstone' | 'dataset'> | null;
} {
  // The two projections are written through INDEXED ACCESS on `E` rather than
  // through their own type parameters. Separate parameters infer as the bare
  // `MaybeHidden` constraint — the concrete columns are lost and every caller
  // that hands the result to a typed consumer (the export flatteners) fails on
  // a missing `id`/`name`.
  return {
    ...evaluation,
    dataset: liveOrNull(evaluation.dataset),
    datasetSample: liveSampleOrNull(evaluation.datasetSample),
  } as Omit<E, 'dataset' | 'datasetSample'> & {
    dataset: Omit<NonNullable<E['dataset']>, 'tombstone'> | null;
    datasetSample: Omit<NonNullable<E['datasetSample']>, 'tombstone' | 'dataset'> | null;
  };
}

/**
 * Hide one sample. Idempotent: never P2002, always converges on hidden.
 *
 * The `update:` arm is deliberately NON-EMPTY. An empty arm still satisfies
 * "never P2002" and reads as a harmless idempotency guard, but it makes
 * delete → un-delete → delete leave the row VISIBLE: the second delete finds
 * the restored row, writes nothing, and returns 200 — a delete that silently
 * does nothing. So state the property precisely: a repeated delete NEVER
 * raises P2002 and ALWAYS converges on hidden. It is not a no-op; it writes.
 *
 * `reason` is normalised to `null` rather than left `undefined`, because
 * `undefined` in a Prisma `update` means "leave this column alone" — which
 * would let a reasonless delete quietly inherit an earlier delete's reason.
 *
 * Takes the caller's transaction client so the hide and everything else the
 * verb does — the response's live count now, A2's `delete` revision later —
 * commit or roll back as one. A1 leaves this shape deliberately open for that
 * second write.
 */
export async function tombstoneSample(
  tx: Prisma.TransactionClient,
  datasetSampleId: string,
  reason?: string
): Promise<void> {
  await tx.tombstone.upsert({
    where: { datasetSampleId },
    create: { datasetSampleId, isTombstone: true, reason: reason ?? null },
    update: { isTombstone: true, reason: reason ?? null },
  });
}

/**
 * Hide many samples: one statement for the rows that already carry a
 * tombstone, one for the rows that do not. Same convergence property as
 * `tombstoneSample` — never P2002, always converges on hidden.
 *
 * WHY TWO STATEMENTS AND NOT ONE. Prisma has no `upsertMany`, and the single-
 * statement alternative (`INSERT ... ON CONFLICT DO UPDATE` through
 * `$executeRaw`) would have to mint the `id` values itself, which means
 * abandoning `@default(cuid())` for this table alone. The two calls run inside
 * the caller's transaction, so the pair is atomic, which is the property that
 * actually matters. `skipDuplicates` is what keeps the insert half from
 * raising P2002 on `Tombstone_datasetSampleId_key` for a re-delete.
 *
 * The two sets are disjoint — `updateMany` matches exactly the ids that have a
 * row, `createMany` inserts exactly the ids that do not — so the returned sum
 * is the number of DISTINCT ids now hidden, which is what the DELETE handler
 * reports as `deleted`. Input duplicates are removed first so that count means
 * what it says.
 *
 * An id that is not a real `DatasetSample` raises P2003 rather than being
 * skipped: `skipDuplicates` skips unique conflicts, not foreign-key ones. That
 * is the correct loud failure — every caller resolves membership first.
 */
export async function tombstoneSamples(
  tx: Prisma.TransactionClient,
  datasetSampleIds: string[],
  reason?: string
): Promise<number> {
  const ids = [...new Set(datasetSampleIds)];
  if (ids.length === 0) return 0;

  const updated = await tx.tombstone.updateMany({
    where: { datasetSampleId: { in: ids } },
    data: { isTombstone: true, reason: reason ?? null },
  });

  const created = await tx.tombstone.createMany({
    data: ids.map((datasetSampleId) => ({
      datasetSampleId,
      isTombstone: true,
      reason: reason ?? null,
    })),
    skipDuplicates: true,
  });

  return updated.count + created.count;
}

/**
 * Hide one dataset. Same non-empty-`update` argument as `tombstoneSample`.
 *
 * Sets `datasetId` and NOTHING ELSE. Setting both FK columns makes
 * `num_nonnulls` 2 and the row is refused by `Tombstone_exactly_one_entity` —
 * a 500 out of `DELETE /api/datasets/[id]`, not something the client could be
 * told about.
 *
 * Samples are NOT tombstoned alongside their dataset, and that is deliberate:
 * `liveSamplesOnly()` carries the parent clause, so every sample of a hidden
 * dataset is already hidden by inheritance (decision 16). Writing a row per
 * sample would be a second source of truth for the same fact, and un-hiding
 * the dataset would then have to un-hide exactly the samples it hid and no
 * others.
 */
export async function tombstoneDataset(
  tx: Prisma.TransactionClient,
  datasetId: string,
  reason?: string
): Promise<void> {
  await tx.tombstone.upsert({
    where: { datasetId },
    create: { datasetId, isTombstone: true, reason: reason ?? null },
    update: { isTombstone: true, reason: reason ?? null },
  });
}

/**
 * Un-hide one sample: flips `isTombstone` to false and clears `reason`.
 *
 * `updateMany`, not `update`, because `update` on a sample that was never
 * hidden raises P2025 — restoring a live row must be a clean no-op, not a 500.
 * There is no `upsert` either: "no row" already means live, so creating a
 * `isTombstone: false` row would only manufacture a record of a deletion that
 * never happened.
 *
 * The row is kept rather than deleted, so `createdAt`/`updatedAt` still record
 * that the sample was once hidden and A2's `restore` revision has something to
 * point at. Clearing `reason` is load-bearing rather than tidy: a stale
 * "removed as a duplicate" left on a row that is live again is a lie nothing
 * downstream can detect.
 */
export async function restoreSample(
  tx: Prisma.TransactionClient,
  datasetSampleId: string
): Promise<void> {
  await tx.tombstone.updateMany({
    where: { datasetSampleId },
    data: { isTombstone: false, reason: null },
  });
}

/**
 * The next `DatasetSample.index` for a dataset: a HIGH-WATER MARK over every
 * row, hidden included, never a count and never a reused ordinal.
 *
 *     nextIndex = max(index) over ALL rows of the dataset + 1
 *
 * WHY NOT `count()`: hide sample 0 of 3 and the count is 2, but index 2 is
 * occupied — P2002 on `@@unique([datasetId, index])` on the very first insert.
 *
 * WHY NOT `max` over LIVE rows: hide the TAIL (samples 0..4, hide 4) and
 * live-max + 1 is 4, which is occupied by the hidden row. This is why
 * `liveSamplesOnly()` must NOT be spread into the read below, and why
 * `samples/route.ts:46` stays unfiltered.
 *
 * THE CASE THAT ACTUALLY BITES is not a freshly-appended corpus — Prisma's
 * `_count` is unfiltered by default and the POST high-water read stays
 * unfiltered, so there `count == max + 1` and nothing collides. It bites on a
 * corpus RE-IMPORTED FROM A FILTERED EXPORT: `config.ts:389` emits
 * `index: s.index` verbatim and the importer writes it back, so the rows
 * arrive with gaps, `count < max + 1`, and the first append collides.
 *
 * The consequence, stated so nobody rediscovers it as a bug: after the first
 * tombstone `index` is NOT dense. Its only guarantees are uniqueness within
 * the dataset and monotonic insertion order. Any code treating it as a
 * 0-based position into the live sample array is wrong.
 *
 * MUST be called with the same `tx` as the inserts it feeds, for the same
 * reason `nextGoldenItemIndex` is (src/lib/golden-sets.ts): read-then-insert
 * across a commit boundary is a race against a concurrent append.
 */
export async function nextSampleIndex(
  tx: Prisma.TransactionClient,
  datasetId: string
): Promise<number> {
  const highWaterMark = await tx.datasetSample.aggregate({
    where: { datasetId },
    _max: { index: true },
  });
  return (highWaterMark._max.index ?? -1) + 1;
}
