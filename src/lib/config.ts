/**
 * ─── Config Export / Import Library ────────────────────────────────────────
 *
 * Complementary to the data export system (CSV/JSONL in export.ts).
 *
 * - **Data export** captures evaluation *results* — judgments, scores, runs.
 * - **Config export** captures the evaluation *harness* — projects, rubrics,
 *   models, datasets — so a user can recreate the same setup on another
 *   instance or restore after a reset.
 *
 * Config is serialized as YAML with human-readable slug-based references
 * between entities (e.g. a dataset referencing a project by slug).
 *
 * Secrets (API keys) are NEVER exported.  Slug generation is deterministic
 * and based on entity names.
 */

import yaml from 'js-yaml';
import { z } from 'zod';

/* ─── Slug Generation ──────────────────────────────────────────────────── */

/**
 * Generate a URL-safe slug from a name string.
 * Deterministic: same name always yields the same slug.
 */
export function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')   // strip non-alphanumeric
    .replace(/[\s_]+/g, '-')          // spaces/underscores → hyphens
    .replace(/-+/g, '-')             // collapse consecutive hyphens
    .replace(/^-|-$/g, '')           // trim leading/trailing hyphens
    .slice(0, 80)                    // reasonable max length
    || 'unnamed';
}

/**
 * Generate a unique slug for an entity, appending a numeric suffix if needed.
 * `existingSlugs` should be an array of slugs already claimed in the same scope.
 */
export function generateUniqueSlug(name: string, existingSlugs: string[]): string {
  const base = generateSlug(name);
  if (!existingSlugs.includes(base)) return base;

  let counter = 2;
  while (existingSlugs.includes(`${base}-${counter}`)) {
    counter++;
  }
  return `${base}-${counter}`;
}

/* ─── Config Schema Types ──────────────────────────────────────────────── */

/** Shape of a single criterion within a rubric config block. */
export interface ConfigCriterion {
  name: string;
  description: string;
  maxScore: number;
  weight: number;
  order: number;
}

/** Shape of a rubric in the YAML config. */
export interface ConfigRubric {
  slug: string;
  name: string;
  description?: string;
  version: number;
  criteria: ConfigCriterion[];
}

/** Shape of a model config in the YAML config. Secrets are never included. */
export interface ConfigModel {
  slug: string;
  name: string;
  provider: string;
  modelId: string;
  endpoint?: string;
  isActive: boolean;
}

/** Shape of a dataset sample in the config (when include_data is true). */
export interface ConfigDatasetSample {
  index: number;
  input: string;
  expected?: string;
  metadata?: Record<string, unknown>;
}

/** Shape of a dataset in the YAML config. */
export interface ConfigDataset {
  slug: string;
  name: string;
  description?: string;
  source: string;
  // Dataset.visibility is the `Visibility` enum as of Task 15 (was a raw
  // String) — narrowed here to match, same as `datasetSchema` below.
  visibility: 'private' | 'public';
  sourceUrl?: string;
  huggingFaceId?: string;
  tags?: string[];
  projectSlug?: string;
  samples?: ConfigDatasetSample[];
}

/** Shape of a project in the YAML config. */
export interface ConfigProject {
  slug: string;
  name: string;
  description?: string;
  isDefault: boolean;
}

/**
 * Shape of one item inside a golden set config block.
 *
 * `index` is the item's position within the SET, not the source
 * `DatasetSample.index`. It is unique within the set and monotonic in
 * insertion order, but NOT dense: items are tombstoned rather than deleted
 * and a tombstoned row keeps its ordinal, so a replace appends above the
 * set's high-water mark (see `nextGoldenItemIndex` in src/lib/golden-sets.ts).
 * Only the relative ORDER of these values is portable.
 *
 * There is no `sourceDatasetSampleId` here on purpose: a sample id is a
 * surrogate key with no meaning on another instance. The importer re-resolves
 * the FK from `inputText`, which is `DatasetSample.input` verbatim for all
 * three protocol mappings (src/lib/golden-sets.ts's mapSampleToGoldenItem).
 */
export interface ConfigGoldenItem {
  index: number;
  inputText: string;
  promptText?: string;
  responseText?: string;
  expected?: string;
  candidates: { position: number; promptText?: string; responseText?: string; label?: string }[];
}

/**
 * Shape of a golden set in the YAML config.
 *
 * `items` is REQUIRED and always emitted — deliberately asymmetric with
 * `ConfigDataset.samples`, which sits behind `?includeSamples=true`. A golden
 * set is an annotation layer; exported without its items it round-trips
 * vacuously.
 *
 * Human labels (`GoldenLabel`) are NOT part of this shape and never will be:
 * `annotatorId` is a real `User` FK, and import attributes everything to
 * `session.user.id` — carrying labels would forge attributions, recording an
 * annotator as having scored text they never saw.
 */
export interface ConfigGoldenSet {
  slug: string;
  name: string;
  description?: string;
  visibility: 'private' | 'public';
  protocol: 'pointwise' | 'pairwise' | 'listwise';
  datasetSlug: string;
  version: number;
  items: ConfigGoldenItem[];
}

/** Top-level config document. */
export interface ConfigDocument {
  version: '1.0';
  exportedAt: string;
  projects: ConfigProject[];
  rubrics: ConfigRubric[];
  models: ConfigModel[];
  datasets: ConfigDataset[];
  goldenSets: ConfigGoldenSet[];
}

/* ─── Zod Validation Schemas ───────────────────────────────────────────── */

const criterionSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  maxScore: z.number().int().min(1).max(100).default(10),
  weight: z.number().min(0).max(10).default(1),
  order: z.number().int().min(0).default(0),
});

const rubricSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  version: z.number().int().min(1).default(1),
  criteria: z.array(criterionSchema).min(1),
});

const modelSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  // `'anthropic' | 'openai' | 'local'` are the legacy `ModelConfig.provider`
  // values (still accepted on import for backward-compat with configs
  // exported before Task 12's review fix — see
  // `src/app/api/config/import/route.ts`'s `resolveServingBackend`, which
  // runs those three through `legacyProviderToBackend`). `'openrouter' |
  // 'vllm' | 'ollama'` are real `ServingBackend` values the catalog/endpoint
  // domain added — config export (post-fix) writes the real backend
  // directly, so round-tripping an export needs the wider set here too.
  provider: z.enum(['anthropic', 'openai', 'local', 'openrouter', 'vllm', 'ollama']),
  modelId: z.string().min(1),
  endpoint: z.string().optional(),
  isActive: z.boolean().default(true),
});

const datasetSampleSchema = z.object({
  index: z.number().int().min(0),
  input: z.string().min(1),
  expected: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const datasetSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  source: z.string().default('local'),
  visibility: z.enum(['private', 'public']).default('private'),
  sourceUrl: z.string().optional(),
  huggingFaceId: z.string().optional(),
  tags: z.array(z.string()).optional(),
  projectSlug: z.string().optional(),
  // DUPLICATE INDICES ARE REJECTED, the same refine `createGoldenSetSchema`'s
  // `sampleIndices` has carried since A0.
  //
  // This refine is the FIRST of two defences, and it was the only one when it
  // landed. `dataset.create` (writing `sampleCount: samples.length`) and
  // `datasetSample.createMany` (writing `index: s.index` verbatim) were two
  // round trips outside any transaction, so a duplicate index reached P2002 in
  // the second AFTER the first had committed — a 500 over a dataset row
  // claiming 3 samples with zero sample rows behind it. The REPLACE branch has
  // been immune since this branch re-packed it to `position + offset`; the
  // create branch was left as its twin.
  //
  // THE SECOND DEFENCE NOW EXISTS: that create branch is one `$transaction`
  // (R3, config/import/route.ts). So this refine is no longer load-bearing for
  // atomicity — it is load-bearing for the ERROR, and that is why it stays. A
  // duplicate index is a fault in the DOCUMENT, and refusing it at the schema
  // costs one predicate and answers 400 naming the field, where the
  // transaction alone would answer an opaque 500 and roll back. Keep both:
  // they fail differently on purpose.
  //
  // A1 is what makes this worth closing now rather than never. Exports used to
  // be dense, so hand-renumbering a config document was pointless; a filtered
  // export is GAPPED, which makes renumbering a natural thing to do and a
  // collision a natural mistake. Refusing at the schema costs one predicate
  // and turns a half-applied import into a 400 that names the field.
  samples: z
    .array(datasetSampleSchema)
    .refine((v) => new Set(v.map((s) => s.index)).size === v.length, {
      message: 'samples must not contain duplicate index values',
    })
    .optional(),
});

const projectSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  isDefault: z.boolean().default(false),
});

const goldenCandidateSchema = z.object({
  position: z.number().int().min(0),
  promptText: z.string().optional(),
  responseText: z.string().optional(),
  label: z.string().optional(),
});

const goldenItemSchema = z.object({
  index: z.number().int().min(0),
  inputText: z.string().min(1),
  promptText: z.string().optional(),
  responseText: z.string().optional(),
  expected: z.string().optional(),
  candidates: z.array(goldenCandidateSchema).default([]),
});

const goldenSetSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  visibility: z.enum(['private', 'public']).default('private'),
  // Required, and the set is homogeneous — every item is stamped with it on
  // import. A set whose items disagreed would make one kappa uninterpretable.
  protocol: z.enum(['pointwise', 'pairwise', 'listwise']),
  datasetSlug: z.string().min(1),
  version: z.number().int().min(1).default(1),
  items: z.array(goldenItemSchema).default([]),
});

export const configDocumentSchema = z.object({
  version: z.literal('1.0'),
  exportedAt: z.string(),
  projects: z.array(projectSchema).default([]),
  rubrics: z.array(rubricSchema).default([]),
  models: z.array(modelSchema).default([]),
  datasets: z.array(datasetSchema).default([]),
  // NOTE: this object is NOT `.strict()`. Before this line existed, a
  // document carrying `goldenSets` parsed clean and had the whole section
  // silently stripped — no 400, no warning, every set lost. That is why the
  // export half is worthless without this line, and why the tests for it
  // assert on imported rows rather than on a status code.
  goldenSets: z.array(goldenSetSchema).default([]),
});

/* ─── Serialization ────────────────────────────────────────────────────── */

/**
 * Serialize a ConfigDocument to a YAML string.
 */
export function serializeConfig(config: ConfigDocument): string {
  return yaml.dump(config, {
    indent: 2,
    lineWidth: 120,
    noRefs: true,
    sortKeys: false,
    quotingType: '"',
    forceQuotes: false,
  });
}

/**
 * Parse and validate a YAML config string into a ConfigDocument.
 * Throws a descriptive error if validation fails.
 */
export function deserializeConfig(yamlString: string): ConfigDocument {
  const raw = yaml.load(yamlString);
  const result = configDocumentSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid config document:\n${issues}`);
  }
  return result.data;
}

/* ─── DB → Config Converters ───────────────────────────────────────────── */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function dbProjectToConfig(project: any): ConfigProject {
  return {
    slug: project.slug || generateSlug(project.name),
    name: project.name,
    ...(project.description && { description: project.description }),
    isDefault: project.isDefault ?? false,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function dbRubricToConfig(rubric: any): ConfigRubric {
  return {
    slug: rubric.slug || generateSlug(rubric.name),
    name: rubric.name,
    ...(rubric.description && { description: rubric.description }),
    version: rubric.version ?? 1,
    criteria: (rubric.criteria ?? []).map((c: any) => ({
      name: c.name,
      description: c.description,
      maxScore: c.maxScore ?? 10,
      weight: c.weight ?? 1,
      order: c.order ?? 0,
    })),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function dbModelToConfig(model: any): ConfigModel {
  return {
    slug: model.slug || generateSlug(model.name),
    name: model.name,
    provider: model.provider,
    modelId: model.modelId,
    ...(model.endpoint && { endpoint: model.endpoint }),
    isActive: model.isActive ?? true,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function dbDatasetToConfig(
  dataset: any,
  options: { includeSamples?: boolean; projectSlugMap?: Map<string, string> } = {}
): ConfigDataset {
  const { includeSamples = false, projectSlugMap } = options;

  let tags: string[] | undefined;
  if (dataset.tags) {
    try {
      tags = JSON.parse(dataset.tags);
    } catch {
      // ignore
    }
  }

  const result: ConfigDataset = {
    slug: dataset.slug || generateSlug(dataset.name),
    name: dataset.name,
    ...(dataset.description && { description: dataset.description }),
    source: dataset.source ?? 'local',
    visibility: dataset.visibility ?? 'private',
    ...(dataset.sourceUrl && { sourceUrl: dataset.sourceUrl }),
    ...(dataset.huggingFaceId && { huggingFaceId: dataset.huggingFaceId }),
    ...(tags && tags.length > 0 && { tags }),
  };

  if (dataset.projectId && projectSlugMap) {
    const pSlug = projectSlugMap.get(dataset.projectId);
    if (pSlug) result.projectSlug = pSlug;
  }

  if (includeSamples && dataset.samples && dataset.samples.length > 0) {
    result.samples = dataset.samples.map((s: any) => {
      const sample: ConfigDatasetSample = {
        index: s.index,
        input: s.input,
      };
      if (s.expected) sample.expected = s.expected;
      if (s.metadata) {
        try {
          sample.metadata = JSON.parse(s.metadata);
        } catch {
          // skip unparseable metadata
        }
      }
      return sample;
    });
  }

  return result;
}

/**
 * DB `GoldenSet` (with `dataset`, `items` and their `candidates` included) →
 * portable config block. Items are always embedded; see `ConfigGoldenSet`.
 *
 * The caller is responsible for filtering tombstoned items out of
 * `goldenSet.items` (`goldenItemLifecycleWhere(false)`) — this function is a
 * pure projection and cannot see lifecycle state it was not handed.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function dbGoldenSetToConfig(goldenSet: any): ConfigGoldenSet {
  return {
    slug: goldenSet.slug || generateSlug(goldenSet.name),
    name: goldenSet.name,
    ...(goldenSet.description && { description: goldenSet.description }),
    visibility: goldenSet.visibility ?? 'private',
    protocol: goldenSet.protocol,
    // Read off the relation rather than a projectSlugMap-style lookup: the
    // dataset may be the platform corpus, which the datasets section (scoped
    // `{ userId }`) never emits, so no map built there would contain it.
    datasetSlug:
      goldenSet.dataset?.slug || generateSlug(goldenSet.dataset?.name ?? 'unnamed'),
    version: goldenSet.version ?? 1,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    items: (goldenSet.items ?? []).map((item: any) => {
      const configItem: ConfigGoldenItem = {
        index: item.index,
        inputText: item.inputText,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        candidates: (item.candidates ?? []).map((c: any) => ({
          position: c.position,
          ...(c.promptText && { promptText: c.promptText }),
          ...(c.responseText && { responseText: c.responseText }),
          ...(c.label && { label: c.label }),
        })),
      };
      if (item.promptText) configItem.promptText = item.promptText;
      if (item.responseText) configItem.responseText = item.responseText;
      if (item.expected) configItem.expected = item.expected;
      return configItem;
    }),
  };
}

/* ─── YAML HTTP Response Helper ────────────────────────────────────────── */

export function yamlResponse(yamlString: string, filename: string): Response {
  return new Response(yamlString, {
    status: 200,
    headers: {
      'Content-Type': 'application/x-yaml; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200)}"`,
      'Cache-Control': 'no-store',
    },
  });
}

/* ─── Import Diff Reporting ────────────────────────────────────────────── */

export type DiffAction = 'create' | 'update' | 'skip';

export interface DiffItem {
  // 'goldenSet' matches the config document key, not the `/api/golden-sets`
  // route segment. `src/app/settings/page.tsx` re-declares this union
  // locally and maps it to an icon — both must be widened with it or the
  // diff row renders with no icon.
  type: 'project' | 'rubric' | 'model' | 'dataset' | 'goldenSet';
  slug: string;
  name: string;
  action: DiffAction;
  changes?: string[];   // human-readable list of what would change on update
}

export interface ImportDiffReport {
  items: DiffItem[];
  summary: {
    create: number;
    update: number;
    skip: number;
  };
}
