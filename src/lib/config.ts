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
  visibility: string;
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

/** Top-level config document. */
export interface ConfigDocument {
  version: '1.0';
  exportedAt: string;
  projects: ConfigProject[];
  rubrics: ConfigRubric[];
  models: ConfigModel[];
  datasets: ConfigDataset[];
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
  provider: z.enum(['anthropic', 'openai', 'local']),
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
  visibility: z.string().default('private'),
  sourceUrl: z.string().optional(),
  huggingFaceId: z.string().optional(),
  tags: z.array(z.string()).optional(),
  projectSlug: z.string().optional(),
  samples: z.array(datasetSampleSchema).optional(),
});

const projectSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  isDefault: z.boolean().default(false),
});

export const configDocumentSchema = z.object({
  version: z.literal('1.0'),
  exportedAt: z.string(),
  projects: z.array(projectSchema).default([]),
  rubrics: z.array(rubricSchema).default([]),
  models: z.array(modelSchema).default([]),
  datasets: z.array(datasetSchema).default([]),
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
  type: 'project' | 'rubric' | 'model' | 'dataset';
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
