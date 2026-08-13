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
 *    to the annotator who made it. Only LIVE labels ride along — a tombstoned
 *    label is one an edit invalidated, and `tombstonedAt` is not among the
 *    copied fields, so copying one would resurrect it.
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
import { goldenItemLifecycleWhere } from '@/lib/golden-sets';

const MAX_ATTEMPTS = 3;

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
 * Thrown when every attempt (MAX_ATTEMPTS) collides on the
 * `@@unique([parentId, version])` constraint — i.e. concurrent fork requests
 * for the same golden-set family kept landing on the same next-version number
 * even after retrying with a freshly recomputed max. Callers (routes) should
 * map this to a 500 with a clear message; it is not a validation error and
 * not expected in normal operation.
 */
export class GoldenSetVersionConflictError extends Error {
  readonly attempts: number;

  constructor(attempts: number) {
    super(
      `Failed to fork golden set after ${attempts} attempt(s): concurrent fork requests kept colliding on the same version number`
    );
    this.name = 'GoldenSetVersionConflictError';
    this.attempts = attempts;
  }
}

/**
 * True iff `error` is a P2002 this retry loop can actually fix by recomputing
 * and trying again: either `[parentId, version]` (the core race) or
 * `[ownerId, slug]` (a SECOND symptom of the same race, not a different one —
 * two concurrent forks of the same family with the same name both read
 * `existingSlugs` before either commits, both derive the identical
 * `${baseSlug}-v${nextVersion}`, and Postgres reports whichever unique index
 * it checks first). Both get the identical fix: recompute the version AND the
 * slug in a fresh transaction. A P2002 on any OTHER constraint is not
 * retryable here and surfaces as-is.
 */
function isRetryableVersionConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }
  const target = (error.meta as { target?: unknown } | undefined)?.target;
  return Array.isArray(target) && (target.includes('version') || target.includes('slug'));
}

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

  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await client.$transaction(
        async (tx) => {
          // ── unchanged transaction body: source read, max-version read,
          //    slug derivation, create with nested items/candidates/labels ──
          const source = await tx.goldenSet.findUniqueOrThrow({
            where: { id: sourceGoldenSetId },
            select: {
              datasetId: true,
              protocol: true,
              items: {
                // Tombstoned rows are NOT copied. `tombstonedAt` is not among
                // the fields copied below, so an unfiltered read would mint
                // them as LIVE items on the child.
                where: goldenItemLifecycleWhere(false),
                orderBy: { index: 'asc' },
                select: {
                  index: true,
                  inputText: true,
                  promptText: true,
                  responseText: true,
                  protocol: true,
                  expected: true,
                  sourceDatasetSampleId: true,
                  candidates: {
                    orderBy: { position: 'asc' },
                    select: {
                      position: true,
                      promptText: true,
                      responseText: true,
                      label: true,
                    },
                  },
                  labels: {
                    // Same hazard, worse consequence: a copied tombstoned
                    // label lands LIVE on the fork, re-attaching a score to
                    // text its annotator never saw. Written as a literal
                    // rather than a helper because this is the only
                    // GoldenLabel read path in the codebase.
                    where: { tombstonedAt: null },
                    select: {
                      annotatorId: true,
                      overallScore: true,
                      criteriaScores: true,
                      reasoning: true,
                    },
                  },
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
                  candidates: {
                    create: item.candidates.map((candidate) => ({
                      position: candidate.position,
                      promptText: candidate.promptText,
                      responseText: candidate.responseText,
                      label: candidate.label,
                    })),
                  },
                  labels: {
                    create: item.labels.map((label) => ({
                      annotatorId: label.annotatorId,
                      overallScore: label.overallScore,
                      criteriaScores:
                        label.criteriaScores === null
                          ? Prisma.DbNull
                          : (label.criteriaScores as Prisma.InputJsonValue),
                      reasoning: label.reasoning,
                    })),
                  },
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
    } catch (error) {
      lastError = error;
      if (isRetryableVersionConflict(error)) {
        if (attempt < MAX_ATTEMPTS) continue;
        throw new GoldenSetVersionConflictError(MAX_ATTEMPTS);
      }
      throw error;
    }
  }

  // Unreachable — the loop above always returns or throws — but keeps the
  // function's control flow explicit for TypeScript.
  throw lastError instanceof Error ? lastError : new GoldenSetVersionConflictError(MAX_ATTEMPTS);
}
