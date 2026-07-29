/**
 * ─── Public serializers ──────────────────────────────────────────────────
 *
 * Shapes served on the PUBLIC read path — anonymous callers, and
 * authenticated callers who are neither the resource's owner nor an admin
 * — for the handful of models that can be `visibility: 'public'` (spec §7
 * D3: Rubric, Dataset, Project, GoldenSet) plus the already-public
 * leaderboard aggregate.
 *
 * Every function here is a pure allow-list projection: it names exactly
 * the fields it copies out of the DB row, so a new column added to one of
 * these models later does NOT leak onto the public wire format by
 * default (the opposite of the `{ ...row }` spread pattern used
 * elsewhere in this codebase for the OWNER-only response shapes, which is
 * fine there because that path is already gated to the owner/admin).
 *
 * What is NEVER included, on any of these:
 *   - `user.email` / `owner.email` — the PII leak this task's critique
 *     flagged on the dataset public-read path (T14 disposition table).
 *     The owner is represented as `{ id, name }` only.
 *   - `apiKeyEnc`, `endpoint`, or any other credential/connection field —
 *     N/A on these four models today, but the allow-list shape means a
 *     future column like that can't leak here even accidentally.
 *   - Any OTHER user's data than the resource's own owner (no nested
 *     evaluations/samples/criteria author lists beyond the one owner).
 *
 * Callers: every public GET path (see the access matrix in
 * tests/db/access-matrix.test.ts and src/lib/auth-guard.ts's
 * `resolveResourceAccess`) MUST route its `access: 'public'` branch
 * through one of these — never return the raw Prisma row with a
 * `user: { select: { ..., email: true } }` include on that branch.
 */

export interface PublicOwner {
  id: string;
  name: string | null;
}

/** Strip a `{ id, name, email }`-shaped user/owner join down to the
 * public-safe `{ id, name }` — the one helper every serializer below uses. */
export function toPublicOwner(user: { id: string; name: string | null }): PublicOwner {
  return { id: user.id, name: user.name };
}

// ─── Rubric ─────────────────────────────────────────────────────────────────

export interface PublicRubricCriterion {
  id: string;
  name: string;
  description: string;
  maxScore: number;
  weight: number;
  order: number;
}

export interface PublicRubric {
  id: string;
  name: string;
  slug: string | null;
  description: string | null;
  version: number;
  parentId: string | null;
  visibility: string;
  publishedAt: Date | null;
  retiredAt: Date | null;
  criteria: PublicRubricCriterion[];
  owner: PublicOwner;
  createdAt: Date;
  updatedAt: Date;
}

export interface RubricForPublicSerialize {
  id: string;
  name: string;
  slug: string | null;
  description: string | null;
  version: number;
  parentId: string | null;
  visibility: string;
  publishedAt: Date | null;
  retiredAt: Date | null;
  criteria: PublicRubricCriterion[];
  user: { id: string; name: string | null };
  createdAt: Date;
  updatedAt: Date;
}

export function toPublicRubric(rubric: RubricForPublicSerialize): PublicRubric {
  return {
    id: rubric.id,
    name: rubric.name,
    slug: rubric.slug,
    description: rubric.description,
    version: rubric.version,
    parentId: rubric.parentId,
    visibility: rubric.visibility,
    publishedAt: rubric.publishedAt,
    retiredAt: rubric.retiredAt,
    criteria: rubric.criteria.map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      maxScore: c.maxScore,
      weight: c.weight,
      order: c.order,
    })),
    owner: toPublicOwner(rubric.user),
    createdAt: rubric.createdAt,
    updatedAt: rubric.updatedAt,
  };
}

// ─── Dataset ────────────────────────────────────────────────────────────────
// Dataset.visibility is still a raw String (Task 15 migrates it to the
// `Visibility` enum) — compared against the literal 'public' string
// wherever it gates access, per this task's brief.

export interface PublicDataset {
  id: string;
  name: string;
  slug: string | null;
  description: string | null;
  source: string;
  visibility: string;
  inputType: string;
  version: number;
  parentId: string | null;
  sourceUrl: string | null;
  huggingFaceId: string | null;
  sampleCount: number | null;
  splits: string | null;
  features: string | null;
  tags: string | null;
  owner: PublicOwner;
  project: { id: string; name: string } | null;
  sampleTotal: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface DatasetForPublicSerialize {
  id: string;
  name: string;
  slug: string | null;
  description: string | null;
  source: string;
  visibility: string;
  inputType: string;
  version: number;
  parentId: string | null;
  sourceUrl: string | null;
  huggingFaceId: string | null;
  sampleCount: number | null;
  splits: string | null;
  features: string | null;
  tags: string | null;
  user: { id: string; name: string | null };
  project: { id: string; name: string } | null;
  _count: { samples: number };
  createdAt: Date;
  updatedAt: Date;
}

export function toPublicDataset(dataset: DatasetForPublicSerialize): PublicDataset {
  return {
    id: dataset.id,
    name: dataset.name,
    slug: dataset.slug,
    description: dataset.description,
    source: dataset.source,
    visibility: dataset.visibility,
    inputType: dataset.inputType,
    version: dataset.version,
    parentId: dataset.parentId,
    sourceUrl: dataset.sourceUrl,
    huggingFaceId: dataset.huggingFaceId,
    sampleCount: dataset.sampleCount,
    splits: dataset.splits,
    features: dataset.features,
    tags: dataset.tags,
    owner: toPublicOwner(dataset.user),
    project: dataset.project ? { id: dataset.project.id, name: dataset.project.name } : null,
    sampleTotal: dataset._count.samples,
    createdAt: dataset.createdAt,
    updatedAt: dataset.updatedAt,
  };
}

/** Dataset sample rows carry no owner/PII of their own — safe to pass
 * through verbatim on the public path. Exported mainly so callers don't
 * have to remember "samples are fine as-is" is a deliberate decision. */
export interface PublicDatasetSample {
  id: string;
  index: number;
  input: string;
  expected: string | null;
  metadata: string | null;
}

export function toPublicDatasetSample(sample: PublicDatasetSample): PublicDatasetSample {
  return {
    id: sample.id,
    index: sample.index,
    input: sample.input,
    expected: sample.expected,
    metadata: sample.metadata,
  };
}

// ─── Project ────────────────────────────────────────────────────────────────

export interface PublicProject {
  id: string;
  name: string;
  slug: string | null;
  description: string | null;
  isDefault: boolean;
  visibility: string;
  publishedAt: Date | null;
  owner: PublicOwner;
  evaluationCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProjectForPublicSerialize {
  id: string;
  name: string;
  slug: string | null;
  description: string | null;
  isDefault: boolean;
  visibility: string;
  publishedAt: Date | null;
  user: { id: string; name: string | null };
  _count: { evaluations: number };
  createdAt: Date;
  updatedAt: Date;
}

export function toPublicProject(project: ProjectForPublicSerialize): PublicProject {
  return {
    id: project.id,
    name: project.name,
    slug: project.slug,
    description: project.description,
    isDefault: project.isDefault,
    visibility: project.visibility,
    publishedAt: project.publishedAt,
    owner: toPublicOwner(project.user),
    evaluationCount: project._count.evaluations,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

// ─── GoldenSet ──────────────────────────────────────────────────────────────
// No API route exposes GoldenSet yet (out of this task's route sweep — see
// task-14-report.md) — this serializer exists so the shape is defined and
// tested ahead of whichever future task adds the route, per this task's
// brief ("public serializers for Rubric/Dataset/Project/GoldenSet").

export interface PublicGoldenSet {
  id: string;
  name: string;
  description: string | null;
  visibility: string;
  owner: PublicOwner | null;
  itemCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface GoldenSetForPublicSerialize {
  id: string;
  name: string;
  description: string | null;
  visibility: string;
  owner: { id: string; name: string | null } | null;
  _count: { items: number };
  createdAt: Date;
  updatedAt: Date;
}

export function toPublicGoldenSet(goldenSet: GoldenSetForPublicSerialize): PublicGoldenSet {
  return {
    id: goldenSet.id,
    name: goldenSet.name,
    description: goldenSet.description,
    visibility: goldenSet.visibility,
    owner: goldenSet.owner ? toPublicOwner(goldenSet.owner) : null,
    itemCount: goldenSet._count.items,
    createdAt: goldenSet.createdAt,
    updatedAt: goldenSet.updatedAt,
  };
}

// ─── Leaderboard entry ──────────────────────────────────────────────────────
// GET /api/leaderboard has been public-with-no-auth since before this task
// and already carries no PII (aggregate model stats only) — this
// passthrough exists so the shape is named and covered by the same
// serializer test suite as the other public views, not because the route
// was leaking anything.

export interface PublicLeaderboardEntry {
  modelId: string;
  modelName: string;
  provider: string;
  providerModelId: string;
  avgScore: number;
  medianScore: number;
  minScore: number;
  maxScore: number;
  evaluationCount: number;
  completedRuns: number;
}

export function toPublicLeaderboardEntry(
  entry: PublicLeaderboardEntry
): PublicLeaderboardEntry {
  return {
    modelId: entry.modelId,
    modelName: entry.modelName,
    provider: entry.provider,
    providerModelId: entry.providerModelId,
    avgScore: entry.avgScore,
    medianScore: entry.medianScore,
    minScore: entry.minScore,
    maxScore: entry.maxScore,
    evaluationCount: entry.evaluationCount,
    completedRuns: entry.completedRuns,
  };
}
