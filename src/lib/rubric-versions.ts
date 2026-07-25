/**
 * ─── Rubric version creation (1a Task 13) ──────────────────────────────────
 *
 * `POST /api/rubrics/[id]/versions` used to read `MAX(version)` for a rubric
 * family and then `create` the next version as two separate calls, with no
 * transaction between them. Two concurrent requests for the same family
 * could both read the same max and both try to create the same next
 * version — the `@@unique([parentId, version])` constraint added in Task 2
 * turns that race from "silent duplicate version" into a P2002 crash.
 *
 * This module owns the fix: the max-version read, the rubric `create`, and
 * its nested criteria `create` all run inside one `prisma.$transaction`, so
 * a concurrent writer either commits before or after this one, never
 * interleaved with it. If a transaction still loses the race (it committed
 * between our read and our create), it fails with P2002 on the
 * `[parentId, version]` constraint specifically; we catch that, recompute
 * the max in a fresh transaction, and retry — bounded to MAX_ATTEMPTS total
 * attempts so a persistent conflict fails loudly instead of looping forever.
 */

import { Prisma, PrismaClient, Rubric, RubricCriterion } from '@prisma/client';

const MAX_ATTEMPTS = 3;

export interface CreateRubricVersionCriterionInput {
  name: string;
  description: string;
  maxScore?: number;
  weight?: number;
  order?: number;
}

export interface CreateRubricVersionInput {
  /** id of the root (v1) rubric of the family — shared `parentId` for every version. */
  rootRubricId: string;
  userId: string;
  /**
   * Optional; callers that already resolved a fallback (e.g. from the
   * specific version being replied from) should pass the resolved value.
   * If omitted, falls back to the root rubric's name/description.
   */
  name?: string;
  description?: string | null;
  criteria: CreateRubricVersionCriterionInput[];
}

export type RubricVersionResult = Rubric & { criteria: RubricCriterion[] };

/**
 * Thrown when every attempt (MAX_ATTEMPTS) collides on the
 * `@@unique([parentId, version])` constraint — i.e. concurrent version-create
 * requests for the same rubric family kept landing on the same next-version
 * number even after retrying with a freshly recomputed max. Callers (routes)
 * should map this to a 500 with a clear message; it is not a validation
 * error and not expected in normal operation.
 */
export class RubricVersionConflictError extends Error {
  readonly attempts: number;

  constructor(attempts: number) {
    super(
      `Failed to create rubric version after ${attempts} attempt(s): concurrent version-create requests kept colliding on the same version number`
    );
    this.name = 'RubricVersionConflictError';
    this.attempts = attempts;
  }
}

/** True iff `error` is a P2002 violation of the `[parentId, version]` unique constraint. */
function isVersionUniqueConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }
  const target = (error.meta as { target?: unknown } | undefined)?.target;
  // Narrow to the version constraint specifically — a different P2002 (e.g.
  // the [userId, slug] unique) should surface as-is, not be swallowed into a
  // version-conflict retry loop.
  return Array.isArray(target) && target.includes('version');
}

/**
 * Creates the next version of a rubric family. Wraps the max-version read,
 * the rubric `create`, and its nested criteria `create` in a single
 * transaction, retrying (bounded to MAX_ATTEMPTS total attempts) on a
 * `[parentId, version]` unique-constraint conflict by recomputing the max
 * inside a fresh transaction.
 */
export async function createRubricVersion(
  client: PrismaClient,
  input: CreateRubricVersionInput
): Promise<RubricVersionResult> {
  const { rootRubricId, userId, name, description, criteria } = input;

  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await client.$transaction(async (tx) => {
        const familyVersions = await tx.rubric.findMany({
          where: { OR: [{ id: rootRubricId }, { parentId: rootRubricId }] },
          select: { version: true },
          orderBy: { version: 'desc' },
        });
        const nextVersion = (familyVersions[0]?.version ?? 0) + 1;

        let resolvedName = name;
        let resolvedDescription = description;
        if (resolvedName === undefined || resolvedDescription === undefined) {
          const root = await tx.rubric.findUniqueOrThrow({
            where: { id: rootRubricId },
            select: { name: true, description: true },
          });
          if (resolvedName === undefined) resolvedName = root.name;
          if (resolvedDescription === undefined) resolvedDescription = root.description;
        }

        return tx.rubric.create({
          data: {
            name: resolvedName,
            description: resolvedDescription ?? null,
            version: nextVersion,
            parentId: rootRubricId,
            userId,
            criteria: {
              create: criteria.map((c, i) => ({
                name: c.name,
                description: c.description,
                maxScore: c.maxScore ?? 10,
                weight: c.weight ?? 1,
                order: c.order ?? i,
              })),
            },
          },
          include: { criteria: { orderBy: { order: 'asc' } } },
        });
      });
    } catch (error) {
      lastError = error;
      if (isVersionUniqueConflict(error)) {
        if (attempt < MAX_ATTEMPTS) continue;
        throw new RubricVersionConflictError(MAX_ATTEMPTS);
      }
      throw error;
    }
  }

  // Unreachable — the loop above always returns or throws — but keeps the
  // function's control flow explicit for TypeScript.
  throw lastError instanceof Error ? lastError : new RubricVersionConflictError(MAX_ATTEMPTS);
}
