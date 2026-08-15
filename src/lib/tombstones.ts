/**
 * ─── The tombstone overlay (A1) ────────────────────────────────────────────
 *
 * Deleting a Dataset or a DatasetSample HIDES it. One `Tombstone` row per
 * entity, keyed by whichever FK column applies, with a hand-edited CHECK
 * (`Tombstone_exactly_one_entity`, 20260814120000_v2f_tombstone_overlay)
 * guaranteeing exactly one is non-null.
 *
 * THIS MODULE IS THE SINGLE DEFINITION OF "HIDDEN". Every read site spreads
 * one of the two filters below — nested to-ONE relation arguments included,
 * which take a `where` whenever the relation is OPTIONAL (see the block below
 * the two filters) — EXCEPT for a deliberate, enumerated class that must not
 * be filtered at all. Every destructive verb calls one of the writers.
 * It lives in src/lib/ rather than inside the route handlers because
 * `src/app/api/**` is outside every vitest coverage `include`, and the shape
 * of these predicates is precisely the thing that is cheap to pin in a unit
 * test and expensive to discover in a 620-row corpus.
 *
 * ─── THE READS THAT MUST NOT BE FILTERED — READ THIS BEFORE SWEEPING ────────
 *
 * "Spread the filter into every read" is WRONG as an absolute, and acting on
 * it literally breaks seven write paths with P2002. The exceptions are not a
 * list to maintain here — they are greppable, each one sitting directly above
 * the read it governs with its own reason:
 *
 *     grep -rn "MUST NOT BE TOMBSTONE-FILTERED (A1)" src/ scripts/
 *
 * Eleven sites carry that marker today. The grep prints THIRTEEN hits: this
 * comment names the marker twice more — in the grep line above, and again at
 * `nextSampleIndex` below — and neither is a member. They fall into three
 * kinds:
 *
 *   - SEVEN would compile perfectly well with a filter spread in and break a
 *     WRITE at runtime. Five are slug DEDUP reads (`datasets/route.ts`,
 *     `evaluations/route.ts`, `config/import/route.ts`, `dataset-versions.ts`,
 *     `scripts/importer/artifacts.ts`) — a hidden row still occupies its slug,
 *     so a filtered dedup read reports "free" and the insert takes P2002 on
 *     `(userId, slug)`. One is the version HIGH-WATER read
 *     (`dataset-versions.ts`) and one the sample ORDINAL read
 *     (`scripts/importer/artifacts.ts`), both for the same reason
 *     `nextSampleIndex` below is unfiltered: a hidden row still holds its
 *     number.
 *   - ONE is `dataset-evaluation-summary.ts`'s `$queryRaw … FOR UPDATE`. It is
 *     marked for a different reason from the other ten: not "a filter would
 *     break it" but "no filter can reach it" — see the paragraph below.
 *   - THREE are `GoldenSet.dataset` (`golden-sets/shared.ts` ×2,
 *     `config/export/route.ts`). These break no write. They are a REQUIRED
 *     to-one, so Prisma refuses a `where` there outright, and nulling them
 *     would make `dbGoldenSetToConfig` emit `datasetSlug: "unnamed"` from its
 *     fallback and bind the set to whatever real dataset holds that slug.
 *
 * WHAT THIS MODULE CANNOT REACH, as opposed to must not: exactly one of the
 * eleven. `refreshDatasetEvaluationSummary`'s row lock is a
 * `$queryRaw … FOR UPDATE`, and both helpers below compile to Prisma `where`
 * fragments, which cannot reach raw SQL. The other ten COULD be filtered and
 * must not be.
 *
 * NOT A0's `tombstonedAt` COLUMN FORM, AND THE TWO MUST NOT BE HARMONISED.
 * `goldenSetLifecycleWhere` (src/lib/golden-sets.ts) pins `tombstonedAt: null`
 * in BOTH arms precisely so a tombstoned golden set has no way back. This
 * overlay is reversible by design — see `restoreSample`. Two mechanisms with
 * different capabilities, coexisting on purpose.
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
 * and FOUR dataset read sites already build their own — `datasets/route.ts`
 * (`where.OR = [`), `stats/route.ts`, `datasets/[id]/versions/route.ts` and
 * `dataset-versions.ts` (each an `OR: [` inside a dataset `where`). Spreading
 * an `OR` into any of those would silently clobber one clause or the other,
 * with no type error and no test failure. Grep `OR:` in those four files
 * rather than trusting a line number — this branch has already invalidated
 * these four once.
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

/* ─── The nested to-ONE case ────────────────────────────────────────────────
 *
 * A nested to-ONE relation argument DOES take a `where` — but only when the
 * relation is OPTIONAL. Prisma generates a per-relation args type for an
 * optional to-one and each carries `where?`; a REQUIRED to-one generates the
 * bare `DatasetDefaultArgs`, which does not. Verified against 6.19.2:
 * `Evaluation.dataset` (`Evaluation$datasetArgs`), `Evaluation.datasetSample`
 * and `Dataset.parent` (`Dataset$parentArgs`) all type-check with a `where`
 * and filter correctly; `GoldenSet.dataset` — the one REQUIRED to-one in this
 * overlay's reach — fails with `TS2353: … 'where' does not exist in type
 * 'DatasetDefaultArgs'`.
 *
 * The distinction is not arbitrary. A filtered relation arg yields `null` when
 * the row does not match, and `null` is only a legal value for the relation
 * when the relation is optional to begin with.
 *
 * WHAT A FILTERED ARG DOES, precisely: it nulls the SUB-OBJECT, keeps the
 * parent row (a `findMany` returns the same rows either way), and leaves the
 * scalar FK beside it POPULATED. That last part is deliberate — it is strictly
 * more than `onDelete: SetNull` left behind, and `dataset-run-groups.ts` groups
 * on `datasetId` rather than on `dataset.id`, so grouping survives a delete
 * that used to break it.
 *
 * DECISION 16 COMES FREE HERE, which is the reason this is a filter and not a
 * hand-written projection. `liveSamplesOnly()` carries the parent clause, so a
 * `datasetSample:` arg filtered by it returns `null` for a sample whose DATASET
 * is hidden even when the sample itself has no tombstone row — the only state
 * `DELETE /api/datasets/[id]` actually produces, since it writes ONE tombstone
 * and never one per sample. A parallel predicate has to restate that arm and
 * can drift out of step with this one; a `where` cannot.
 *
 * WHAT THE OVERLAY OWES THESE READS. `Evaluation.datasetId` and
 * `Evaluation.datasetSampleId` are both `onDelete: SetNull`
 * (prisma/schema.prisma), so before A1 deleting a corpus or a row NULLED the
 * reference and every one of these args returned `null` by construction.
 * Every consumer in the tree is already written for that — `evaluation.dataset
 * && …`, `dataset?.name ?? ''`, `datasetSample?.index ?? 0`. A1 kept the row
 * alive and turned all of them back on, which is a regression the overlay
 * introduced and not an inherited gap; `where: liveDatasetsOnly()` /
 * `where: liveSamplesOnly()` on the nested arg turns them back off.
 *
 * NOT AN INVITATION TO FILTER EVERY SUCH ARG. Three `GoldenSet.dataset` sites
 * are deliberately left whole and marked MUST NOT BE TOMBSTONE-FILTERED (A1).
 * They are the REQUIRED to-one above, so Prisma refuses the `where` outright —
 * and they carry a second, independent reason on top of that; see the reasons
 * at those sites.
 */

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
 * reports as `tombstoned` (`samples/route.ts` returns `{ tombstoned, remaining }`
 * — `deleted` was renamed because nothing is deleted here any more).
 * Input duplicates are removed first so that count means
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
 * `samples/route.ts`'s POST guard read stays unfiltered (its
 * `select: { userId: true, _count: { select: { samples: true } } }`).
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
 * reason `nextGoldenItemIndex` is (src/lib/golden-sets.ts) — but NOT for the
 * reason this comment used to give, and the correction matters because the
 * claim it made is the kind someone later relies on.
 *
 * WHAT SHARING THE `tx` DOES NOT BUY: serialisation. The aggregate below is a
 * plain SELECT, it takes no lock of any kind, and Prisma's interactive
 * transactions run at Postgres's default READ COMMITTED. Two concurrent
 * appends can both read the same mark and both try to insert it; the loser
 * gets P2002 on `@@unique([datasetId, index])`, which
 * `POST /api/datasets/[id]/samples` has no retry for and reports as a bare
 * 500. A1 NARROWED that window — the read it replaced
 * (`dataset._count.samples`) happened outside the transaction entirely — but
 * it did not close it. Pinned by 'two concurrent transactions read the SAME
 * high-water mark, and the loser gets P2002 — the read is not serialised' in
 * tests/db/dataset-sample-tombstone.test.ts, which asserts the collision
 * rather than its absence.
 *
 * WHAT IT DOES BUY, and it is worth the argument: the read observes the
 * caller's OWN uncommitted writes. A verb that inserted samples earlier in the
 * same transaction and then called this on `prisma` would read a mark that
 * predates its own rows and collide with them deterministically — not a race,
 * a certainty. No caller does that today; all three call it before their first
 * insert. And it makes the mark and the rows it numbers roll back together, so
 * a failed append leaves nothing half-numbered.
 *
 * CLOSING THE RACE properly needs a retry on P2002 against `datasetId_index`,
 * the shape `createDatasetVersion` and `createRubricVersion` already use for
 * `version`. That is a real improvement and a deliberate follow-on: it changes
 * the write path, and A1 is the read overlay.
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
