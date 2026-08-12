/**
 * ─── Golden-set forking (A0 Task 4) ────────────────────────────────────────
 *
 * A GoldenSet is frozen the moment a CalibrationRun references it (see
 * `isGoldenSetFrozen` in src/lib/golden-sets.ts). Design decision #6 says the
 * response to "edit a frozen set" is not "refuse" but "fork to a new
 * version", so this module owns that fork.
 *
 * Structurally it mirrors `createDatasetVersion` (src/lib/dataset-versions.ts)
 * exactly, and for the same reason: the max-version read, the slug derivation
 * and the `create` all run inside one `client.$transaction`, so a concurrent
 * fork of the same family either commits before or after this one, never
 * interleaved with it. Slug derivation is INSIDE the transaction because it
 * depends on `nextVersion` and must stay truthful after a retry bumps that
 * number. A transaction that still loses the race fails with P2002 on
 * `[parentId, version]` (or, equivalently, on `[ownerId, slug]` — same race,
 * different index checked first); we recompute in a fresh transaction and
 * retry, bounded to MAX_ATTEMPTS.
 *
 * ── What is specific to golden sets ────────────────────────────────────────
 *
 * 1. The copy is two levels deep. GoldenItem carries GoldenCandidate rows
 *    (`@@unique([goldenItemId, position])`), so the nested write is
 *    goldenSet -> items -> candidates, all in the one create.
 *
 * 2. GoldenLabel rows ride along with their item. GoldenLabel cascades off
 *    GoldenItem, so minting new item ids means every annotation A1 collected
 *    vanishes unless it is explicitly copied — the fork decides this whether
 *    or not it notices. `annotatorId` (nullable, `onDelete: SetNull`),
 *    `overallScore`, `criteriaScores` (a real Json column) and `reasoning`
 *    are all preserved verbatim, so an annotator's judgment stays attributed
 *    to the annotator who made it.
 *
 * 3. THE OTHER HALF OF DECISION #5 IS NOT HERE, DELIBERATELY. Decision #5
 *    reads "copy, except on edited items". `forkGoldenSet` takes no item
 *    overrides and applies no edits, so every copied item is content-
 *    identical to its source by construction and the "except" clause cannot
 *    fire in this call — a content comparison here would be a branch whose
 *    false arm is unreachable. A0's edit path is fork-then-PATCH: PATCH
 *    /api/golden-sets/[id]/items 409s on a frozen set, the caller forks, and
 *    then PATCHes the (unfrozen) fork. THAT handler owns the drop: it must
 *    delete the GoldenLabel rows of any item whose inputText, promptText,
 *    responseText, expected or candidate list it changes, so that no score is
 *    ever re-attributed to text its annotator did not see. If you are adding
 *    fork-with-edits later, the drop rule moves here with it.
 *
 * 4. The fork is always private with publishedAt null. `ownerId` is the
 *    FORKING user; inheriting a platform set's `public` visibility would
 *    republish somebody else's corpus under a new owner. `retiredAt` and
 *    `tombstonedAt` are not copied either.
 *
 * 5. The transaction carries an explicit timeout, unlike its dataset
 *    counterpart. A JudgeBench-sized fork is 620 items and up to 1240
 *    candidates in one nested write; Prisma's 5s interactive default would
 *    turn that into a P2028 on large sets only.
 */

import {
  Prisma,
  PrismaClient,
  GoldenSet,
  GoldenItem,
  GoldenCandidate,
} from '@prisma/client';
import { generateSlug } from '@/lib/config';

export interface ForkGoldenSetInput {
  /** id of the root (v1) golden set of the family — the shared `parentId` for every version. */
  rootGoldenSetId: string;
  /**
   * The set being forked FROM. Items, candidates and labels are copied from
   * here, and `datasetId`/`protocol` are inherited from here. Distinct from
   * `rootGoldenSetId`: forking a v2 parents the new v3 at the root, not at
   * the v2 (callers pass `existing.parentId ?? existing.id` as the root).
   */
  sourceGoldenSetId: string;
  ownerId: string;
  name: string;
  description: string | null;
}

export type GoldenSetVersionResult = GoldenSet & {
  items: (GoldenItem & { candidates: GoldenCandidate[] })[];
  _count: { items: number };
};

/**
 * Forks a golden set to the next version of its family. Wraps the source
 * read, the max-version read, slug derivation, the `create` and its nested
 * item/candidate/label creates in a single transaction.
 */
export async function forkGoldenSet(
  client: PrismaClient,
  input: ForkGoldenSetInput
): Promise<GoldenSetVersionResult> {
  const { rootGoldenSetId, sourceGoldenSetId, ownerId, name, description } = input;

  return client.$transaction(
    async (tx) => {
      const source = await tx.goldenSet.findUniqueOrThrow({
        where: { id: sourceGoldenSetId },
        select: {
          datasetId: true,
          protocol: true,
          items: {
            orderBy: { index: 'asc' },
            select: {
              index: true,
              inputText: true,
              promptText: true,
              responseText: true,
              protocol: true,
              expected: true,
              sourceDatasetSampleId: true,
            },
          },
        },
      });

      const familyVersions = await tx.goldenSet.findMany({
        where: { OR: [{ id: rootGoldenSetId }, { parentId: rootGoldenSetId }] },
        select: { version: true },
        orderBy: { version: 'desc' },
      });
      const nextVersion = (familyVersions[0]?.version ?? 0) + 1;

      // Slug derivation lives here (not passed in) — see module doc: it
      // depends on nextVersion, so it must be recomputed on every retry to
      // stay truthful to whichever version this attempt lands on.
      const baseSlug = generateSlug(name);
      const versionSlug = `${baseSlug}-v${nextVersion}`;
      const existingSlugs = (
        await tx.goldenSet.findMany({ where: { ownerId }, select: { slug: true } })
      )
        .map((g) => g.slug)
        .filter(Boolean) as string[];
      const uniqueSlug = existingSlugs.includes(versionSlug)
        ? `${versionSlug}-${Date.now().toString(36).slice(-4)}`
        : versionSlug;

      return tx.goldenSet.create({
        data: {
          name,
          slug: uniqueSlug,
          description,
          // Never inherited from the source — see module doc note 4.
          visibility: 'private',
          version: nextVersion,
          parentId: rootGoldenSetId,
          ownerId,
          datasetId: source.datasetId,
          protocol: source.protocol,
          items: {
            create: source.items.map((item) => ({
              index: item.index,
              inputText: item.inputText,
              promptText: item.promptText,
              responseText: item.responseText,
              protocol: item.protocol,
              expected: item.expected,
              sourceDatasetSampleId: item.sourceDatasetSampleId,
            })),
          },
        },
        include: {
          items: {
            orderBy: { index: 'asc' },
            include: { candidates: { orderBy: { position: 'asc' } } },
          },
          _count: { select: { items: true } },
        },
      });
    },
    { maxWait: 10_000, timeout: 60_000 }
  );
}
