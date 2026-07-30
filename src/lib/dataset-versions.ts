/**
 * ─── Dataset version creation (1b Task 15, closing 1a flag M5) ────────────
 *
 * `POST /api/datasets/[id]/versions` used to read `MAX(version)` for a
 * dataset family and then `create` the next version as two separate calls,
 * with no transaction between them — the exact same unguarded-race shape
 * `src/lib/rubric-versions.ts`'s module doc describes for Rubric (fixed
 * there in 1a Task 13). Dataset never got the equivalent
 * `@@unique([parentId, version])` constraint until this task (see the
 * schema + `prisma/migrations/20260730120000_v2b_visibility_cleanup`), so
 * until now two concurrent requests for the same dataset family could both
 * read the same max and both create the same next version — a silent
 * duplicate. Now that the constraint exists, that race becomes a P2002
 * crash instead, which this module exists to retry around.
 *
 * This module owns the fix, mirroring `createRubricVersion` exactly: the
 * max-version read, the slug derivation (dataset versions carry a slug —
 * `${baseSlug}-v${nextVersion}` — unlike Rubric versions, which never set
 * one; see the route's prior inline logic this replaces), and the dataset
 * `create` (+ nested sample `create`) all run inside one
 * `prisma.$transaction`, so a concurrent writer either commits before or
 * after this one, never interleaved with it. Slug derivation is inside the
 * transaction (not computed once up front, unlike the route's prior
 * approach) specifically BECAUSE it depends on `nextVersion` — recomputing
 * it fresh on every retry keeps the slug's `-vN` suffix truthful to
 * whichever version number this attempt actually lands on, even after a
 * P2002-triggered retry bumps `nextVersion`. If a transaction still loses
 * the version race (it committed between our read and our create), it
 * fails with P2002 on the `[parentId, version]` constraint specifically; we
 * catch that, recompute both the max and the slug in a fresh transaction,
 * and retry — bounded to MAX_ATTEMPTS total attempts so a persistent
 * conflict fails loudly instead of looping forever.
 */

import { Prisma, PrismaClient, Dataset, DatasetSample, Visibility } from '@prisma/client';
import { generateSlug } from '@/lib/config';

const MAX_ATTEMPTS = 3;

export interface CreateDatasetVersionSampleInput {
  input: string;
  expected: string | null;
  /** Pre-serialized JSON string (matches `DatasetSample.metadata`'s DB shape) — callers own validation/serialization, same division of labor as the route's prior inline logic. */
  metadata: string | null;
}

export interface CreateDatasetVersionInput {
  /** id of the root (v1) dataset of the family — shared `parentId` for every version. */
  rootDatasetId: string;
  userId: string;
  name: string;
  description: string | null;
  source: string;
  visibility: Visibility;
  inputType: string;
  sourceUrl: string | null;
  huggingFaceId: string | null;
  remoteMetadata: string | null;
  format: string | null;
  localData: string | null;
  splits: string | null;
  features: string | null;
  tags: string | null;
  projectId: string | null;
  samples: CreateDatasetVersionSampleInput[];
}

export type DatasetVersionResult = Dataset & {
  samples: DatasetSample[];
  user: { id: string; name: string | null; email: string };
  project: { id: string; name: string } | null;
  _count: { samples: number };
};

/**
 * Thrown when every attempt (MAX_ATTEMPTS) collides on the
 * `@@unique([parentId, version])` constraint — i.e. concurrent version-create
 * requests for the same dataset family kept landing on the same next-version
 * number even after retrying with a freshly recomputed max. Callers (routes)
 * should map this to a 500 with a clear message; it is not a validation
 * error and not expected in normal operation.
 */
export class DatasetVersionConflictError extends Error {
  readonly attempts: number;

  constructor(attempts: number) {
    super(
      `Failed to create dataset version after ${attempts} attempt(s): concurrent version-create requests kept colliding on the same version number`
    );
    this.name = 'DatasetVersionConflictError';
    this.attempts = attempts;
  }
}

/**
 * True iff `error` is a P2002 violation of a constraint this function's
 * retry loop can actually fix by recomputing and trying again: either the
 * `[parentId, version]` unique (the core race this module exists to guard —
 * see module doc) or `[userId, slug]` (a SECOND symptom of the exact same
 * race, not a different one: two concurrent calls for the same dataset
 * family with the same source name can both read `existingSlugs` before
 * either commits, both derive the identical `${baseSlug}-v${nextVersion}`
 * slug — since neither yet sees the other's still-uncommitted row — and
 * both attempt the identical INSERT; Postgres reports whichever unique
 * index it checks first, which in practice is not always `version`. Either
 * shape gets the identical fix: recompute both the version AND the slug
 * fresh in a new transaction, which naturally picks a different value once
 * the losing side's rollback lets the winning side's commit become visible).
 * A P2002 on any OTHER constraint is not retryable here and surfaces as-is.
 */
function isRetryableVersionConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }
  const target = (error.meta as { target?: unknown } | undefined)?.target;
  return Array.isArray(target) && (target.includes('version') || target.includes('slug'));
}

/**
 * Creates the next version of a dataset family. Wraps the max-version read,
 * slug derivation, the dataset `create`, and its nested sample `create` in a
 * single transaction, retrying (bounded to MAX_ATTEMPTS total attempts) on a
 * `[parentId, version]` OR `[userId, slug]` unique-constraint conflict (see
 * `isRetryableVersionConflict` — both are symptoms of the same race) by
 * recomputing the max (and slug) inside a fresh transaction.
 */
export async function createDatasetVersion(
  client: PrismaClient,
  input: CreateDatasetVersionInput
): Promise<DatasetVersionResult> {
  const {
    rootDatasetId,
    userId,
    name,
    description,
    source,
    visibility,
    inputType,
    sourceUrl,
    huggingFaceId,
    remoteMetadata,
    format,
    localData,
    splits,
    features,
    tags,
    projectId,
    samples,
  } = input;

  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await client.$transaction(async (tx) => {
        const familyVersions = await tx.dataset.findMany({
          where: { OR: [{ id: rootDatasetId }, { parentId: rootDatasetId }] },
          select: { version: true },
          orderBy: { version: 'desc' },
        });
        const nextVersion = (familyVersions[0]?.version ?? 0) + 1;

        // Slug derivation lives here (not passed in) — see module doc: it
        // depends on nextVersion, so it must be recomputed on every retry
        // to stay truthful to whichever version this attempt lands on.
        const baseSlug = generateSlug(name);
        const versionSlug = `${baseSlug}-v${nextVersion}`;
        const existingSlugs = (
          await tx.dataset.findMany({ where: { userId }, select: { slug: true } })
        )
          .map((d) => d.slug)
          .filter(Boolean) as string[];
        const uniqueSlug = existingSlugs.includes(versionSlug)
          ? `${versionSlug}-${Date.now().toString(36).slice(-4)}`
          : versionSlug;

        return tx.dataset.create({
          data: {
            name,
            slug: uniqueSlug,
            description,
            source,
            visibility,
            inputType,
            version: nextVersion,
            parentId: rootDatasetId,
            sourceUrl,
            huggingFaceId,
            remoteMetadata,
            format,
            localData,
            sampleCount: samples.length,
            splits,
            features,
            tags,
            projectId,
            userId,
            samples: {
              create: samples.map((s, i) => ({
                index: i,
                input: s.input,
                expected: s.expected,
                metadata: s.metadata,
              })),
            },
          },
          include: {
            user: { select: { id: true, name: true, email: true } },
            project: { select: { id: true, name: true } },
            samples: { orderBy: { index: 'asc' } },
            _count: { select: { samples: true } },
          },
        });
      });
    } catch (error) {
      lastError = error;
      if (isRetryableVersionConflict(error)) {
        if (attempt < MAX_ATTEMPTS) continue;
        throw new DatasetVersionConflictError(MAX_ATTEMPTS);
      }
      throw error;
    }
  }

  // Unreachable — the loop above always returns or throws — but keeps the
  // function's control flow explicit for TypeScript.
  throw lastError instanceof Error ? lastError : new DatasetVersionConflictError(MAX_ATTEMPTS);
}
