/**
 * Importer phase — artifact mappers (projects, rubrics+criteria,
 * datasets+samples, evaluations).
 *
 * Produces `IdMaps`: v1 id -> v2 id for every artifact entity later phases
 * (runs.ts, reconcile.ts) need to remap through. Import order matters:
 *
 *   1. rubrics (+ criteria)  — roots (parentId null) before children, so a
 *      child's parentId can be remapped through `ids.rubric` the moment it's
 *      processed. Criteria import with their parent rubric; criterion ids
 *      are recorded in `ids.criterion` for runs.ts's criteriaScores remap.
 *   2. projects              — independent of rubrics/datasets.
 *   3. datasets (+ samples)  — same roots-first treatment as rubrics (v1's
 *      Dataset has the identical version/parentId versioning shape; the
 *      brief's carry-list doesn't call this out explicitly but the schema
 *      does, and dropping it would reproduce the exact dangling-cuid class
 *      of bug the rubric handling exists to fix — so it's carried here too).
 *      References `ids.project` (nullable/SetNull on the live schema).
 *   4. evaluations           — references `ids.project` (required, Cascade
 *      -> a dropped project drops its evaluations with it), `ids.rubric` /
 *      `ids.dataset` / `ids.sample` (all nullable/SetNull -> missing means
 *      null, not a drop).
 *
 * ── Ownership / visibility policy ───────────────────────────────────────
 * Every artifact row has a v1 `userId`. Disposition:
 *   - owner present in `owners` (mapped or already-resolved-archive/drop by
 *     resolveOwners): attribute directly to that v2 user id.
 *   - owner ABSENT from `owners` (i.e. the v1 user's ownerMap disposition
 *     was 'drop', or the v1 user was never mentioned in ownerMap at all —
 *     both cases leave no entry in `owners`, see owners.ts):
 *       - "public" artifact -> attribute to the archive user.
 *       - "private" artifact -> skip entirely (report 'dropped'), and any
 *         rows that require it (criteria, samples, or — via cascade below —
 *         evaluations under a dropped project) are dropped with it.
 * "Public" here is entity-specific, because v1 only has a `visibility`
 * column on Dataset:
 *   - Dataset:  `visibility === 'public'` is the public signal.
 *   - Project:  v1 has NO visibility column. Only `isDefault: true` (the
 *     seeded default/leaderboard project) counts as "public" for this
 *     purpose — every other project with an unmapped owner is private and
 *     dropped. Unlike Dataset's per-row `visibility` column, `isDefault` is
 *     a property of the PROJECT itself, independent of who currently owns
 *     it — so an `isDefault` project is visibility `'public'` no matter
 *     which of the three ownership paths landed it here (kept/mapped
 *     owner, an owner whose ownerMap disposition is literally `'archive'`,
 *     or a dropped/unmentioned owner falling back to archive via the
 *     isDefault escape hatch above). It never becomes `'private'` just
 *     because its owner happens to still be a live mapped user.
 *   - Rubric:   v1 has neither a visibility column NOR an isDefault-style
 *     escape hatch. A rubric with an unmapped owner is ALWAYS dropped —
 *     there is no archive path for rubrics.
 *   - Evaluation: has no visibility concept of its own either. Its fate is
 *     governed by its Project (dropped project -> dropped evaluation, see
 *     above). If the project survives but the evaluation's OWN `userId` is
 *     unmapped, it is attributed to archive rather than dropped — dropping
 *     an individual evaluation out from under a surviving (possibly
 *     multi-user, e.g. the leaderboard) project would silently destroy
 *     otherwise-live data for no structural reason, whereas Project/Rubric/
 *     Dataset drops always correspond to an entire artifact + everything
 *     exclusively under it disappearing together.
 *
 * v2's new `visibility` enum columns (Project, Rubric) aren't populated
 * from any v1 source column — there isn't one — but leaving them all at
 * the schema default ('private') for the one case that IS semantically
 * public (the default/leaderboard project) would silently regress the
 * exact signal the visibility column exists to carry. So: every Project
 * with `isDefault: true` is created with `visibility: 'public'`
 * UNCONDITIONALLY — not just when it happened to fall through to the
 * archive user, but on all three ownership paths above (a project doesn't
 * stop being the public leaderboard just because its owner is a live,
 * still-mapped user). Every non-default Project and every imported Rubric
 * gets the default `'private'`. Dataset's own `visibility` column — a raw
 * `String` on v1, promoted to the `Visibility` enum on v2 by Task 15 — IS
 * carried from v1's source column, normalized (`v1.visibility === 'public'
 * ? 'public' : 'private'`) rather than passed through verbatim, since v1's
 * column is untyped and the v2 column no longer accepts arbitrary strings.
 *
 * ── Idempotency (apply-mode re-run safety) ──────────────────────────────
 * Every entity here lacks a v1-id-shaped natural key (no schema changes are
 * allowed to add one), so each uses the strongest real key available, and
 * falls back to a documented content-match `findFirst` otherwise:
 *   - Rubric (child, parentId set):  real `@@unique([parentId, version])`.
 *   - Rubric (root, parentId null):  content match on
 *     `(userId, parentId: null, version, name)` — Postgres treats NULL !=
 *     NULL, so `(parentId, version)` cannot disambiguate multiple roots by
 *     itself.
 *   - RubricCriterion: no unique constraint at all -> content match on
 *     `(rubricId, name, order)`.
 *   - Project: real `@@unique([userId, slug])` when v1 `slug` is non-null;
 *     content match on `(userId, slug: null, name)` otherwise (same
 *     NULL-distinct reasoning as rubric roots).
 *   - Dataset: `@@unique([userId, slug])` was NOT extended with a
 *     `(parentId, version)` constraint (only Rubric got that in Task 2), so
 *     every Dataset row — root or child — is content-matched on
 *     `(userId, slug ?? null+name, version, parentId)`.
 *   - DatasetSample: real `@@unique([datasetId, index])`.
 *   - Evaluation: no unique constraint -> content match on
 *     `(projectId, userId, createdAt)`. `createdAt` is preserved verbatim
 *     from v1 (see below), so it is a stable, deterministic disambiguator
 *     across re-runs against the same v1 data — the same pattern the task
 *     brief calls for on EvaluationRun in runs.ts.
 *
 * KNOWN LIMITATION — content-match key collisions on the null-slug rows:
 * the Rubric-root, Project (no slug), and Dataset content-match keys above
 * all key on a NULL-safe tuple of `name`/`version`/`parentId` (etc.), never
 * on the v1 row's own id (no v1-id-shaped natural key exists on any of
 * these tables, and adding one would be a schema change outside this
 * task's scope). If two DISTINCT v1 rows of the same entity happen to
 * share an IDENTICAL tuple — e.g. one user creates two root Rubrics both
 * named "Correctness" at version 1, or two slug-less Projects both named
 * "Scratch" — the second row's `findFirst` matches the first row's
 * already-created v2 counterpart and silently MERGES onto it instead of
 * creating a second row; this importer has no way to tell those two v1
 * rows apart after the fact. This is the same collision class
 * ModelJudgment's multiset matching (./runs.ts) exists to rule out for
 * that one entity specifically — it is NOT independently closed here for
 * Rubric/Project/Dataset (doing so would need the same per-parent multiset
 * restructuring, which wasn't in scope for this fix). Net effect: this
 * entity's v1 row count can exceed its v2 row count by the number of such
 * collisions after import; Task 10's row-count reconciliation phase is
 * what is meant to surface that class of gap, not a per-row tally here.
 *
 * ── Timestamps ───────────────────────────────────────────────────────────
 * v1 `createdAt`/`updatedAt` are passed through explicitly on every create.
 * Prisma only applies a field's `@default(now())` / `@updatedAt` behavior
 * when the field is OMITTED from `data`; supplying an explicit value (as
 * done throughout this file) always wins, including on `@updatedAt` fields
 * — verified by a dedicated assertion in artifacts.db.test.ts.
 *
 * Every v2 write is gated on `ctx.mode === 'apply'`, with the same
 * find-then-maybe-create + report-mode placeholder-id discipline used by
 * ./owners and ./judges (see their module docs) — report mode still
 * performs every `findFirst`/`findUnique` read (harmless, and lets a
 * report-mode run correctly find rows a PRIOR apply-mode run already
 * created) but only tallies what an apply run would create instead of
 * writing it.
 */
import type {
  Rubric as V1Rubric,
  RubricCriterion as V1RubricCriterion,
  Project as V1Project,
  Dataset as V1Dataset,
  DatasetSample as V1DatasetSample,
  Evaluation as V1Evaluation,
} from '@prisma/v1-client';
import type { ImportCtx } from './context';
import { resolveArchiveUser } from './owners';

export interface IdMaps {
  project: Map<string, string>;
  rubric: Map<string, string>;
  criterion: Map<string, string>;
  dataset: Map<string, string>;
  sample: Map<string, string>;
  evaluation: Map<string, string>;
}

function reportPlaceholderId(entity: string, key: string): string {
  return `report:${entity}:${key}`;
}

/** Roots (parentId null) first, then children — both groups ordered by
 * (createdAt, id) for a stable, deterministic processing order across runs.
 * Sufficient because v1's version chains are single-level: every non-null
 * parentId points directly at a root, never at an intermediate version. */
function sortRootsFirst<T extends { parentId: string | null; createdAt: Date; id: string }>(
  rows: T[]
): T[] {
  const byCreatedThenId = (a: T, b: T) =>
    a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id);
  const roots = rows.filter((r) => r.parentId === null).sort(byCreatedThenId);
  const children = rows.filter((r) => r.parentId !== null).sort(byCreatedThenId);
  return [...roots, ...children];
}

/** Shared v1 userId -> v2 userId resolver for "can be public" entities
 * (Dataset, Project). Unmapped owner + `isPublic` -> archive user (via
 * `getArchiveUserId`, resolved/cached lazily by the caller); unmapped owner
 * + not public -> `null` meaning "drop this row". Rubric has no public path
 * at all (see module doc) so it resolves ownership inline instead of
 * through this helper. */
async function resolveOwnerOr(
  v1UserId: string,
  owners: Map<string, string>,
  isPublic: boolean,
  getArchiveUserId: () => Promise<string>
): Promise<string | null> {
  const mapped = owners.get(v1UserId);
  if (mapped) return mapped;
  if (!isPublic) return null;
  return getArchiveUserId();
}

// ─── Rubrics + criteria ─────────────────────────────────────────────────────

async function findOrCreateRubric(
  ctx: ImportCtx,
  v1: V1Rubric,
  v2UserId: string,
  v2ParentId: string | null
): Promise<string> {
  const existing = v2ParentId
    ? await ctx.v2.rubric.findUnique({
        where: { parentId_version: { parentId: v2ParentId, version: v1.version } },
      })
    : await ctx.v2.rubric.findFirst({
        where: { userId: v2UserId, parentId: null, version: v1.version, name: v1.name },
      });

  if (existing) {
    ctx.report.add('Rubric', 'skipped');
    return existing.id;
  }

  ctx.report.add('Rubric', 'created');
  if (ctx.mode !== 'apply') {
    return reportPlaceholderId('Rubric', `${v2UserId}:${v2ParentId ?? 'root'}:${v1.version}:${v1.name}`);
  }

  const created = await ctx.v2.rubric.create({
    data: {
      name: v1.name,
      slug: v1.slug,
      description: v1.description,
      version: v1.version,
      parentId: v2ParentId,
      visibility: 'private',
      userId: v2UserId,
      createdAt: v1.createdAt,
      updatedAt: v1.updatedAt,
    },
  });
  return created.id;
}

async function findOrCreateRubricCriterion(
  ctx: ImportCtx,
  v1: V1RubricCriterion,
  v2RubricId: string
): Promise<string> {
  const existing = await ctx.v2.rubricCriterion.findFirst({
    where: { rubricId: v2RubricId, name: v1.name, order: v1.order },
  });
  if (existing) {
    ctx.report.add('RubricCriterion', 'skipped');
    return existing.id;
  }

  ctx.report.add('RubricCriterion', 'created');
  if (ctx.mode !== 'apply') {
    return reportPlaceholderId('RubricCriterion', `${v2RubricId}:${v1.name}:${v1.order}`);
  }

  const created = await ctx.v2.rubricCriterion.create({
    data: {
      rubricId: v2RubricId,
      name: v1.name,
      description: v1.description,
      maxScore: v1.maxScore,
      weight: v1.weight,
      order: v1.order,
    },
  });
  return created.id;
}

async function importRubrics(
  ctx: ImportCtx,
  owners: Map<string, string>,
  rubricIds: Map<string, string>,
  criterionIds: Map<string, string>
): Promise<void> {
  const [rows, criteriaByRubric] = await Promise.all([
    ctx.v1.rubric.findMany(),
    ctx.v1.rubricCriterion.findMany().then((rows) => {
      const byRubric = new Map<string, V1RubricCriterion[]>();
      for (const row of rows) {
        const list = byRubric.get(row.rubricId) ?? [];
        list.push(row);
        byRubric.set(row.rubricId, list);
      }
      return byRubric;
    }),
  ]);

  for (const rubric of sortRootsFirst(rows)) {
    // Rubric never has a public/archive path (see module doc): an unmapped
    // owner always drops the row outright.
    const v2UserId = owners.get(rubric.userId) ?? null;
    if (!v2UserId) {
      ctx.report.add('Rubric', 'dropped');
      const criteria = criteriaByRubric.get(rubric.id) ?? [];
      if (criteria.length > 0) ctx.report.add('RubricCriterion', 'dropped', criteria.length);
      continue;
    }

    // v1's parentId always points directly at a root (never a chained
    // intermediate version — see module doc), and roots are processed
    // before children, so this lookup always has a chance to have already
    // populated `rubricIds` by the time a child is reached.
    const v2ParentId = rubric.parentId ? (rubricIds.get(rubric.parentId) ?? null) : null;
    const v2RubricId = await findOrCreateRubric(ctx, rubric, v2UserId, v2ParentId);
    rubricIds.set(rubric.id, v2RubricId);

    for (const criterion of criteriaByRubric.get(rubric.id) ?? []) {
      const v2CriterionId = await findOrCreateRubricCriterion(ctx, criterion, v2RubricId);
      criterionIds.set(criterion.id, v2CriterionId);
    }
  }
}

// ─── Projects ───────────────────────────────────────────────────────────────

async function findOrCreateProject(
  ctx: ImportCtx,
  v1: V1Project,
  v2UserId: string,
  visibility: 'private' | 'public'
): Promise<string> {
  const existing = v1.slug
    ? await ctx.v2.project.findUnique({ where: { userId_slug: { userId: v2UserId, slug: v1.slug } } })
    : await ctx.v2.project.findFirst({ where: { userId: v2UserId, slug: null, name: v1.name } });

  if (existing) {
    ctx.report.add('Project', 'skipped');
    return existing.id;
  }

  ctx.report.add('Project', 'created');
  if (ctx.mode !== 'apply') {
    return reportPlaceholderId('Project', `${v2UserId}:${v1.slug ?? v1.name}`);
  }

  const created = await ctx.v2.project.create({
    data: {
      name: v1.name,
      slug: v1.slug,
      description: v1.description,
      isDefault: v1.isDefault,
      visibility,
      userId: v2UserId,
      createdAt: v1.createdAt,
      updatedAt: v1.updatedAt,
    },
  });
  return created.id;
}

async function importProjects(
  ctx: ImportCtx,
  owners: Map<string, string>,
  getArchiveUserId: () => Promise<string>,
  projectIds: Map<string, string>
): Promise<void> {
  const rows = await ctx.v1.project.findMany();

  for (const project of rows) {
    const isDefault = project.isDefault;
    const mapped = owners.get(project.userId);
    const v2UserId = mapped ?? (isDefault ? await getArchiveUserId() : null);
    if (!v2UserId) {
      ctx.report.add('Project', 'dropped');
      continue;
    }

    // isDefault (the seeded default/leaderboard project) is ALWAYS public,
    // regardless of which of the three ownership paths got it here (a
    // still-mapped/kept owner, an owner whose ownerMap disposition is
    // literally 'archive', or a dropped/unmentioned owner falling back to
    // archive just above) — it doesn't stop being the public leaderboard
    // project just because its owner happens to still be a live user. See
    // module doc.
    const visibility = isDefault ? 'public' : 'private';
    const v2ProjectId = await findOrCreateProject(ctx, project, v2UserId, visibility);
    projectIds.set(project.id, v2ProjectId);
  }
}

// ─── Datasets + samples ─────────────────────────────────────────────────────

async function findOrCreateDataset(
  ctx: ImportCtx,
  v1: V1Dataset,
  v2UserId: string,
  v2ProjectId: string | null,
  v2ParentId: string | null
): Promise<string> {
  // No `(parentId, version)` constraint exists for Dataset (unlike Rubric),
  // so every row — root or child — is content-matched the same way.
  const where = v1.slug
    ? { userId: v2UserId, slug: v1.slug }
    : { userId: v2UserId, slug: null, name: v1.name, version: v1.version, parentId: v2ParentId };
  const existing = await ctx.v2.dataset.findFirst({ where });

  if (existing) {
    ctx.report.add('Dataset', 'skipped');
    return existing.id;
  }

  ctx.report.add('Dataset', 'created');
  if (ctx.mode !== 'apply') {
    return reportPlaceholderId(
      'Dataset',
      `${v2UserId}:${v1.slug ?? v1.name}:${v1.version}:${v2ParentId ?? 'root'}`
    );
  }

  const created = await ctx.v2.dataset.create({
    data: {
      name: v1.name,
      slug: v1.slug,
      description: v1.description,
      source: v1.source,
      // v1's `visibility` column is an untyped `String`; the v2 column is
      // the `Visibility` enum (Task 15) — normalize rather than pass
      // through verbatim (matches the `isPublic` check importDatasets
      // already computes from this same column, just re-derived here since
      // this function only receives the row, not that boolean).
      visibility: v1.visibility === 'public' ? 'public' : 'private',
      inputType: v1.inputType,
      version: v1.version,
      parentId: v2ParentId,
      sourceUrl: v1.sourceUrl,
      huggingFaceId: v1.huggingFaceId,
      remoteMetadata: v1.remoteMetadata,
      format: v1.format,
      localData: v1.localData,
      filePath: v1.filePath,
      sampleCount: v1.sampleCount,
      splits: v1.splits,
      features: v1.features,
      tags: v1.tags,
      projectId: v2ProjectId,
      userId: v2UserId,
      createdAt: v1.createdAt,
      updatedAt: v1.updatedAt,
    },
  });
  return created.id;
}

async function findOrCreateDatasetSample(
  ctx: ImportCtx,
  v1: V1DatasetSample,
  v2DatasetId: string
): Promise<string> {
  const existing = await ctx.v2.datasetSample.findUnique({
    where: { datasetId_index: { datasetId: v2DatasetId, index: v1.index } },
  });
  if (existing) {
    ctx.report.add('DatasetSample', 'skipped');
    return existing.id;
  }

  ctx.report.add('DatasetSample', 'created');
  if (ctx.mode !== 'apply') {
    return reportPlaceholderId('DatasetSample', `${v2DatasetId}:${v1.index}`);
  }

  const created = await ctx.v2.datasetSample.create({
    data: {
      datasetId: v2DatasetId,
      index: v1.index,
      input: v1.input,
      expected: v1.expected,
      metadata: v1.metadata,
      createdAt: v1.createdAt,
    },
  });
  return created.id;
}

async function importDatasets(
  ctx: ImportCtx,
  owners: Map<string, string>,
  getArchiveUserId: () => Promise<string>,
  projectIds: Map<string, string>,
  datasetIds: Map<string, string>,
  sampleIds: Map<string, string>
): Promise<void> {
  const [rows, samplesByDataset] = await Promise.all([
    ctx.v1.dataset.findMany(),
    ctx.v1.datasetSample.findMany().then((rows) => {
      const byDataset = new Map<string, V1DatasetSample[]>();
      for (const row of rows) {
        const list = byDataset.get(row.datasetId) ?? [];
        list.push(row);
        byDataset.set(row.datasetId, list);
      }
      return byDataset;
    }),
  ]);

  for (const dataset of sortRootsFirst(rows)) {
    const isPublic = dataset.visibility === 'public';
    const v2UserId = await resolveOwnerOr(dataset.userId, owners, isPublic, getArchiveUserId);
    if (!v2UserId) {
      ctx.report.add('Dataset', 'dropped');
      const samples = samplesByDataset.get(dataset.id) ?? [];
      if (samples.length > 0) ctx.report.add('DatasetSample', 'dropped', samples.length);
      continue;
    }

    // Dataset.parentId's onDelete is NoAction (not Cascade) on the live
    // schema, and the column is nullable — so a parent that didn't survive
    // (dropped, or simply not yet processed) degrades to `null`, matching
    // that relation's own semantics, rather than dropping this child.
    const v2ParentId = dataset.parentId ? (datasetIds.get(dataset.parentId) ?? null) : null;
    const v2ProjectId = dataset.projectId ? (projectIds.get(dataset.projectId) ?? null) : null;
    const v2DatasetId = await findOrCreateDataset(ctx, dataset, v2UserId, v2ProjectId, v2ParentId);
    datasetIds.set(dataset.id, v2DatasetId);

    for (const sample of samplesByDataset.get(dataset.id) ?? []) {
      const v2SampleId = await findOrCreateDatasetSample(ctx, sample, v2DatasetId);
      sampleIds.set(sample.id, v2SampleId);
    }
  }
}

// ─── Evaluations ────────────────────────────────────────────────────────────

async function findOrCreateEvaluation(
  ctx: ImportCtx,
  v1: V1Evaluation,
  v2UserId: string,
  v2ProjectId: string,
  v2RubricId: string | null,
  v2DatasetId: string | null,
  v2SampleId: string | null
): Promise<string> {
  const existing = await ctx.v2.evaluation.findFirst({
    where: { projectId: v2ProjectId, userId: v2UserId, createdAt: v1.createdAt },
  });
  if (existing) {
    ctx.report.add('Evaluation', 'skipped');
    return existing.id;
  }

  ctx.report.add('Evaluation', 'created');
  if (ctx.mode !== 'apply') {
    return reportPlaceholderId('Evaluation', `${v2ProjectId}:${v2UserId}:${v1.createdAt.toISOString()}`);
  }

  const created = await ctx.v2.evaluation.create({
    data: {
      projectId: v2ProjectId,
      rubricId: v2RubricId,
      inputText: v1.inputText,
      promptText: v1.promptText,
      responseText: v1.responseText,
      title: v1.title,
      userId: v2UserId,
      datasetId: v2DatasetId,
      datasetSampleId: v2SampleId,
      createdAt: v1.createdAt,
      updatedAt: v1.updatedAt,
    },
  });
  return created.id;
}

async function importEvaluations(
  ctx: ImportCtx,
  owners: Map<string, string>,
  getArchiveUserId: () => Promise<string>,
  projectIds: Map<string, string>,
  rubricIds: Map<string, string>,
  datasetIds: Map<string, string>,
  sampleIds: Map<string, string>,
  evaluationIds: Map<string, string>
): Promise<void> {
  const rows = await ctx.v1.evaluation.findMany();

  for (const evaluation of rows) {
    // Required, Cascade-backed FK on the live schema: a project that isn't
    // in `projectIds` (dropped) takes every evaluation under it down too.
    const v2ProjectId = projectIds.get(evaluation.projectId);
    if (!v2ProjectId) {
      ctx.report.add('Evaluation', 'dropped');
      continue;
    }

    // The project survived, so this evaluation survives too; an unmapped
    // author (rather than an unmapped project) falls back to archive
    // instead of being dropped — see module doc.
    const v2UserId = owners.get(evaluation.userId) ?? (await getArchiveUserId());

    const v2RubricId = evaluation.rubricId ? (rubricIds.get(evaluation.rubricId) ?? null) : null;
    const v2DatasetId = evaluation.datasetId ? (datasetIds.get(evaluation.datasetId) ?? null) : null;
    const v2SampleId = evaluation.datasetSampleId
      ? (sampleIds.get(evaluation.datasetSampleId) ?? null)
      : null;

    const v2EvaluationId = await findOrCreateEvaluation(
      ctx,
      evaluation,
      v2UserId,
      v2ProjectId,
      v2RubricId,
      v2DatasetId,
      v2SampleId
    );
    evaluationIds.set(evaluation.id, v2EvaluationId);
  }
}

// ─── Entry point ────────────────────────────────────────────────────────────

export async function importArtifacts(ctx: ImportCtx, owners: Map<string, string>): Promise<IdMaps> {
  const ids: IdMaps = {
    project: new Map(),
    rubric: new Map(),
    criterion: new Map(),
    dataset: new Map(),
    sample: new Map(),
    evaluation: new Map(),
  };

  // Resolved at most once per importArtifacts call, however many entities
  // end up needing the archive user (resolveArchiveUser is itself
  // find-or-create idempotent, but caching here avoids redundant queries
  // and keeps every "public" artifact in this run pointed at the exact
  // same id, even across `report` mode's placeholder ids).
  let archiveUserId: string | undefined;
  const getArchiveUserId = async (): Promise<string> => {
    if (!archiveUserId) archiveUserId = await resolveArchiveUser(ctx);
    return archiveUserId;
  };

  await importRubrics(ctx, owners, ids.rubric, ids.criterion);
  await importProjects(ctx, owners, getArchiveUserId, ids.project);
  await importDatasets(ctx, owners, getArchiveUserId, ids.project, ids.dataset, ids.sample);
  await importEvaluations(
    ctx,
    owners,
    getArchiveUserId,
    ids.project,
    ids.rubric,
    ids.dataset,
    ids.sample,
    ids.evaluation
  );

  return ids;
}
