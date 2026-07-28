/**
 * Importer context — wires together the two independent Prisma clients
 * (frozen v1, live v2), the run mode, the owner map, and a shared report
 * that Tasks 8-10's import phases accumulate into.
 *
 * The v1 client reads `@prisma/v1-client`, generated from the frozen
 * `prisma/v1/schema.v1.prisma` via `npm run db:generate:v1` — it is a
 * read-only view of the legacy Railway database and must never be pointed
 * at anything else. The v2 client is the current `@prisma/client`.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaClient as V1PrismaClient } from '@prisma/v1-client';

/** Run mode: `report` only tallies what would happen; `apply` writes to v2. */
export type ImportMode = 'report' | 'apply';

/**
 * Maps a v1 user identifier (email, in practice) to how it should be
 * resolved against v2's OIDC-based identity model:
 *   - an object: create/attach the v2 User under this email + OIDC identity
 *   - `'archive'`: keep the data but do not attribute it to a live user
 *   - `'drop'`: exclude this user's data from the import entirely
 */
export type OwnerMap = Record<
  string,
  { email: string; oidcIssuer: string; oidcSubject: string } | 'archive' | 'drop'
>;

/** Outcome bucket recorded per entity by each import phase. */
export type ImportAction = 'created' | 'skipped' | 'dropped';

/**
 * Accumulates per-entity, per-action counts across all import phases.
 * `report` mode and `apply` mode both write into the same shape, so the
 * printed summary has an identical structure regardless of mode.
 */
export class ImportReport {
  private readonly tallies: Record<string, Record<ImportAction, number>> = {};

  /** Records `n` (default 1) occurrences of `action` for `entity`. */
  add(entity: string, action: ImportAction, n = 1): void {
    const forEntity = (this.tallies[entity] ??= { created: 0, skipped: 0, dropped: 0 });
    forEntity[action] += n;
  }

  /** Returns a snapshot of the accumulated counts (safe to mutate by callers). */
  counts(): Record<string, Record<string, number>> {
    return Object.fromEntries(
      Object.entries(this.tallies).map(([entity, actions]) => [entity, { ...actions }]),
    );
  }
}

/**
 * One ModelJudgment create that lost the DB-level NULLS NOT DISTINCT unique
 * race (v2b, Task 6 — see ./runs.ts's module doc, "ModelJudgment
 * idempotency" section, "DB-level backstop"). Recorded whenever
 * `ctx.v2.modelJudgment.create` throws P2002 on
 * `(runId, judgeModelVersionId, pairOrder)`: this is the multiset matcher's
 * residual gap (two DISTINCT v1 ModelConfigs that synthesize to the SAME
 * JudgeModelVersion, both referenced by judgments on ONE run) actually
 * firing, not a bug — the row is tallied `dropped` (never silently lost) and
 * every occurrence lands here so `reconcile`'s report can list exactly which
 * v1 judgments merged, not just how many.
 */
export interface ModelJudgmentMergeCollision {
  runId: string;
  judgeModelVersionId: string;
  /** The v1 ModelJudgment id whose v2 row already occupies the unique key
   * (either created earlier in this same import call, or matched via the
   * multiset pool against a row a prior apply created). */
  survivingV1Id: string;
  /** The v1 ModelJudgment id whose create attempt hit P2002 and was dropped. */
  droppedV1Id: string;
}

/** Full importer context passed through every import phase. */
export interface ImportCtx {
  v1: V1PrismaClient;
  v2: PrismaClient;
  mode: ImportMode;
  ownerMap: OwnerMap;
  report: ImportReport;
  /** Accumulates every ModelJudgment merge collision (see
   * ModelJudgmentMergeCollision above) across the whole import call —
   * populated by ./runs.ts, read by ./reconcile.ts to surface the list in
   * the reconciliation report. */
  modelJudgmentMergeCollisions: ModelJudgmentMergeCollision[];
}

export interface CreateImportCtxOptions {
  mode: ImportMode;
  ownerMap: OwnerMap;
}

/**
 * Builds a fresh ImportCtx. Both Prisma clients connect lazily (on first
 * query), so constructing the context does not by itself require either
 * database to be reachable.
 */
export function createImportCtx(options: CreateImportCtxOptions): ImportCtx {
  return {
    v1: new V1PrismaClient(),
    v2: new PrismaClient(),
    mode: options.mode,
    ownerMap: options.ownerMap,
    report: new ImportReport(),
    modelJudgmentMergeCollisions: [],
  };
}
