import { NextResponse } from 'next/server';
import type { JudgeClass, ServingBackend } from '@prisma/client';
import { prisma } from '@/lib/db';
import { requireAuth, requireScope } from '@/lib/auth-guard';
import {
  type ConfigDocument,
  type DiffItem,
  type ImportDiffReport,
  deserializeConfig,
} from '@/lib/config';
import { legacyProviderToBackend } from '@/lib/llm';
import { createCustomJudgeModel } from '@/lib/model-catalog';
import { logger, serializeError } from '@/lib/logger';
import { audit, getRequestContext } from '@/lib/audit';

/** Old config exports (pre Task 12 review fix) only ever wrote one of the
 * three legacy `ModelConfig.provider` values — translate those the same
 * way the v1->v2 importer does (scripts/importer/judges.ts's
 * classifyProvider). Config exported AFTER this fix writes the real
 * `ServingBackend` value directly (see config/export/route.ts), so this is
 * a passthrough for those — safe because `configDocumentSchema`'s
 * `modelSchema.provider` enum only admits the legacy 3 plus the real 5
 * ServingBackend values (which overlap on 'anthropic'/'openai'). */
const LEGACY_MODEL_PROVIDERS = new Set(['anthropic', 'openai', 'local']);

function resolveServingBackend(provider: string): ServingBackend {
  if (LEGACY_MODEL_PROVIDERS.has(provider)) {
    return legacyProviderToBackend(provider);
  }
  return provider as ServingBackend;
}

/** judgeClass default for an imported model — the config format never
 * carried one. Same split as scripts/importer/judges.ts's classifyProvider
 * (anthropic/openai -> prompted_api, local -> prompted_open_weight),
 * extended to the two other real-backend cases the v1 importer never had
 * to handle (openrouter is a hosted-API aggregator like anthropic/openai;
 * vllm/ollama are self-hosted open-weight runtimes like 'local'). Computed
 * off the RAW config provider string, before `resolveServingBackend`
 * collapses 'local' onto the 'openai' backend — collapsing first would
 * misclassify a self-hosted 'local' model as `prompted_api`.
 */
function judgeClassForImportedProvider(provider: string): JudgeClass {
  switch (provider) {
    case 'anthropic':
    case 'openai':
    case 'openrouter':
      return 'prompted_api';
    default: // 'local' | 'vllm' | 'ollama'
      return 'prompted_open_weight';
  }
}

/**
 * POST /api/config/import
 *
 * Imports a YAML/JSON configuration to recreate the evaluation harness.
 *
 * Query params:
 *   - dryRun: "true" to only preview changes without applying (default: false)
 *
 * Body: raw YAML or JSON string (Content-Type: text/yaml or application/json)
 *
 * Import semantics:
 *   - Match by slug (userId + slug) for projects/rubrics/datasets.
 *   - Models match by `JudgeModel.slug` (globally unique — not scoped by
 *     userId, since the catalog is shared) + this user owning an endpoint
 *     against it; see the "Models" section below for why "update" there is
 *     narrower than the other sections (catalog identity is immutable).
 *   - If slug exists → update if changed, skip if identical.
 *   - If slug doesn't exist → create new entity.
 *   - API keys are NEVER imported (imported models get a keyless
 *     ModelEndpoint, same as every other field in this file).
 *   - Dataset samples are imported if present in the config.
 *   - Projects referenced by datasets are resolved by slug.
 *   - Returns a diff report showing what was/would be created, updated, or skipped.
 */
export async function POST(request: Request) {
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;
  const scopeCheck = requireScope(session, 'config:write');
  if (scopeCheck) return scopeCheck;

  const { searchParams } = new URL(request.url);
  const dryRun = searchParams.get('dryRun') === 'true';

  try {
    const body = await request.text();
    if (!body.trim()) {
      return NextResponse.json(
        { error: 'Request body is empty. Provide a YAML or JSON config.' },
        { status: 400 }
      );
    }

    let config: ConfigDocument;
    try {
      config = deserializeConfig(body);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Invalid config format';
      return NextResponse.json({ error: message }, { status: 400 });
    }

    const userId = session.user.id;
    const items: DiffItem[] = [];

    // ── Projects ──
    const projectSlugToId = new Map<string, string>();

    for (const configProject of config.projects) {
      const slug = configProject.slug;
      const existing = await prisma.project.findFirst({
        where: { userId, slug },
      });

      if (existing) {
        projectSlugToId.set(slug, existing.id);
        const changes: string[] = [];
        if (existing.name !== configProject.name) changes.push(`name: "${existing.name}" → "${configProject.name}"`);
        if ((existing.description ?? '') !== (configProject.description ?? '')) changes.push('description updated');
        if (existing.isDefault !== configProject.isDefault) changes.push(`isDefault: ${existing.isDefault} → ${configProject.isDefault}`);

        if (changes.length === 0) {
          items.push({ type: 'project', slug, name: configProject.name, action: 'skip' });
        } else {
          items.push({ type: 'project', slug, name: configProject.name, action: 'update', changes });
          if (!dryRun) {
            await prisma.project.update({
              where: { id: existing.id },
              data: {
                name: configProject.name,
                description: configProject.description ?? null,
                isDefault: configProject.isDefault,
              },
            });
          }
        }
      } else {
        items.push({ type: 'project', slug, name: configProject.name, action: 'create' });
        if (!dryRun) {
          const created = await prisma.project.create({
            data: {
              name: configProject.name,
              slug,
              description: configProject.description ?? null,
              isDefault: configProject.isDefault,
              userId,
            },
          });
          projectSlugToId.set(slug, created.id);
        }
      }
    }

    // Also load existing projects for dataset → project resolution
    const existingProjects = await prisma.project.findMany({
      where: { userId },
      select: { id: true, slug: true, name: true },
    });
    for (const p of existingProjects) {
      if (p.slug && !projectSlugToId.has(p.slug)) {
        projectSlugToId.set(p.slug, p.id);
      }
    }

    // ── Rubrics ──
    for (const configRubric of config.rubrics) {
      const slug = configRubric.slug;
      const existing = await prisma.rubric.findFirst({
        where: { userId, slug },
        include: { criteria: { orderBy: { order: 'asc' } } },
      });

      if (existing) {
        const changes: string[] = [];
        if (existing.name !== configRubric.name) changes.push(`name: "${existing.name}" → "${configRubric.name}"`);
        if ((existing.description ?? '') !== (configRubric.description ?? '')) changes.push('description updated');
        if (existing.version !== configRubric.version) changes.push(`version: ${existing.version} → ${configRubric.version}`);

        // Compare criteria
        const existingCriteria = existing.criteria.map((c) => `${c.name}|${c.maxScore}|${c.weight}`).sort();
        const configCriteria = configRubric.criteria.map((c) => `${c.name}|${c.maxScore}|${c.weight}`).sort();
        if (JSON.stringify(existingCriteria) !== JSON.stringify(configCriteria)) {
          changes.push(`criteria: ${existing.criteria.length} → ${configRubric.criteria.length} items`);
        }

        if (changes.length === 0) {
          items.push({ type: 'rubric', slug, name: configRubric.name, action: 'skip' });
        } else {
          items.push({ type: 'rubric', slug, name: configRubric.name, action: 'update', changes });
          if (!dryRun) {
            // Delete old criteria and recreate
            await prisma.rubricCriterion.deleteMany({ where: { rubricId: existing.id } });
            await prisma.rubric.update({
              where: { id: existing.id },
              data: {
                name: configRubric.name,
                description: configRubric.description ?? null,
                version: configRubric.version,
                criteria: {
                  create: configRubric.criteria.map((c) => ({
                    name: c.name,
                    description: c.description,
                    maxScore: c.maxScore,
                    weight: c.weight,
                    order: c.order,
                  })),
                },
              },
            });
          }
        }
      } else {
        items.push({ type: 'rubric', slug, name: configRubric.name, action: 'create' });
        if (!dryRun) {
          await prisma.rubric.create({
            data: {
              name: configRubric.name,
              slug,
              description: configRubric.description ?? null,
              version: configRubric.version,
              userId,
              criteria: {
                create: configRubric.criteria.map((c) => ({
                  name: c.name,
                  description: c.description,
                  maxScore: c.maxScore,
                  weight: c.weight,
                  order: c.order,
                })),
              },
            },
          });
        }
      }
    }

    // ── Models (never import apiKey) ──
    // Task 12 review fix: migrated off the retired `ModelConfig` write path
    // onto the JudgeModel/JudgeModelVersion/ModelEndpoint catalog+endpoint
    // domain (see src/lib/model-catalog.ts's module doc).
    //
    // `JudgeModel`/`JudgeModelVersion` are immutable once created anywhere
    // in this app — there is no write path that mutates an EXISTING
    // catalog entry's identity fields (name/servingBackend/baseModel). So
    // "update" here can only ever apply to the two fields that actually
    // live on the per-user, mutable `ModelEndpoint` row: `endpoint` (URL)
    // and `isActive`. If an imported model's identity fields differ from
    // what's already on the matched `JudgeModel`, that's still reported as
    // a diff (so the user SEES it in the preview) but is NOT applied — a
    // genuine identity change needs a new catalog entry (a different slug),
    // not a mutation of an existing, possibly-shared judge identity.
    //
    // "Existing" is resolved via `JudgeModel.slug` (globally unique, unlike
    // the old per-user `ModelConfig.slug`) + this user having an endpoint
    // against some version of that JudgeModel — matches what
    // `config/export/route.ts` now emits (the real `JudgeModel.slug`), so a
    // re-import of a previously-exported config finds its own rows. If a
    // JudgeModel with that slug exists but belongs to a DIFFERENT user's
    // import (no endpoint of this user's points at it), this falls to the
    // create branch below — `createCustomJudgeModel`'s own slug-collision
    // suffixing (see src/lib/model-catalog.ts) then gives this user's new
    // JudgeModel a distinct slug rather than colliding on the taken one.
    // Disclosed tradeoff, not a bug: import never tries to detect/share an
    // unrelated user's catalog entry, only this user's own prior import.
    for (const configModel of config.models) {
      const slug = configModel.slug;
      const servingBackend = resolveServingBackend(configModel.provider);
      const judgeClass = judgeClassForImportedProvider(configModel.provider);

      const existingJudgeModel = await prisma.judgeModel.findUnique({ where: { slug } });
      const existingEndpoint = existingJudgeModel
        ? await prisma.modelEndpoint.findFirst({
            where: { userId, judgeModelVersion: { judgeModelId: existingJudgeModel.id } },
            include: { judgeModelVersion: true },
            orderBy: { createdAt: 'asc' },
          })
        : null;

      if (existingJudgeModel && existingEndpoint) {
        const changes: string[] = [];
        if (existingJudgeModel.name !== configModel.name) {
          changes.push(`name: "${existingJudgeModel.name}" → "${configModel.name}" (catalog identity is immutable — not applied)`);
        }
        if (existingEndpoint.judgeModelVersion.servingBackend !== servingBackend) {
          changes.push(`provider: ${existingEndpoint.judgeModelVersion.servingBackend} → ${servingBackend} (catalog identity is immutable — not applied)`);
        }
        if ((existingJudgeModel.baseModel ?? '') !== configModel.modelId) {
          changes.push(`modelId: ${existingJudgeModel.baseModel ?? ''} → ${configModel.modelId} (catalog identity is immutable — not applied)`);
        }
        if ((existingEndpoint.endpoint ?? '') !== (configModel.endpoint ?? '')) changes.push('endpoint updated');
        if (existingEndpoint.isActive !== configModel.isActive) changes.push(`isActive: ${existingEndpoint.isActive} → ${configModel.isActive}`);

        if (changes.length === 0) {
          items.push({ type: 'model', slug, name: configModel.name, action: 'skip' });
        } else {
          items.push({ type: 'model', slug, name: configModel.name, action: 'update', changes });
          if (!dryRun) {
            await prisma.modelEndpoint.update({
              where: { id: existingEndpoint.id },
              data: {
                endpoint: configModel.endpoint ?? null,
                isActive: configModel.isActive,
              },
            });
          }
        }
      } else {
        items.push({ type: 'model', slug, name: configModel.name, action: 'create' });
        if (!dryRun) {
          await createCustomJudgeModel(prisma, userId, {
            name: configModel.name,
            slug,
            judgeClass,
            scoringMechanism: 'critique_generative',
            servingBackend,
            baseModel: configModel.modelId,
            endpoint: configModel.endpoint ?? null,
            apiKeyEnc: null, // API keys are NEVER imported (see module doc above)
            isActive: configModel.isActive,
            verificationError: 'Not tested yet',
          });
        }
      }
    }

    // ── Datasets ──
    for (const configDataset of config.datasets) {
      const slug = configDataset.slug;
      const existing = await prisma.dataset.findFirst({
        where: { userId, slug },
        include: { _count: { select: { samples: true } } },
      });

      // Resolve project reference
      let projectId: string | null = null;
      if (configDataset.projectSlug) {
        projectId = projectSlugToId.get(configDataset.projectSlug) ?? null;
      }

      if (existing) {
        const changes: string[] = [];
        if (existing.name !== configDataset.name) changes.push(`name: "${existing.name}" → "${configDataset.name}"`);
        if ((existing.description ?? '') !== (configDataset.description ?? '')) changes.push('description updated');
        if (existing.source !== configDataset.source) changes.push(`source: ${existing.source} → ${configDataset.source}`);
        if (existing.visibility !== configDataset.visibility) changes.push(`visibility: ${existing.visibility} → ${configDataset.visibility}`);
        if (configDataset.samples && configDataset.samples.length > 0 && existing._count.samples !== configDataset.samples.length) {
          changes.push(`samples: ${existing._count.samples} → ${configDataset.samples.length}`);
        }

        if (changes.length === 0) {
          items.push({ type: 'dataset', slug, name: configDataset.name, action: 'skip' });
        } else {
          items.push({ type: 'dataset', slug, name: configDataset.name, action: 'update', changes });
          if (!dryRun) {
            await prisma.dataset.update({
              where: { id: existing.id },
              data: {
                name: configDataset.name,
                description: configDataset.description ?? null,
                source: configDataset.source,
                visibility: configDataset.visibility,
                sourceUrl: configDataset.sourceUrl ?? null,
                huggingFaceId: configDataset.huggingFaceId ?? null,
                tags: configDataset.tags ? JSON.stringify(configDataset.tags) : null,
                projectId,
              },
            });

            // Replace samples if provided
            if (configDataset.samples && configDataset.samples.length > 0) {
              await prisma.datasetSample.deleteMany({ where: { datasetId: existing.id } });
              await prisma.datasetSample.createMany({
                data: configDataset.samples.map((s) => ({
                  datasetId: existing.id,
                  index: s.index,
                  input: s.input,
                  expected: s.expected ?? null,
                  metadata: s.metadata ? JSON.stringify(s.metadata) : null,
                })),
              });
              await prisma.dataset.update({
                where: { id: existing.id },
                data: { sampleCount: configDataset.samples.length },
              });
            }
          }
        }
      } else {
        items.push({ type: 'dataset', slug, name: configDataset.name, action: 'create' });
        if (!dryRun) {
          const created = await prisma.dataset.create({
            data: {
              name: configDataset.name,
              slug,
              description: configDataset.description ?? null,
              source: configDataset.source,
              visibility: configDataset.visibility,
              sourceUrl: configDataset.sourceUrl ?? null,
              huggingFaceId: configDataset.huggingFaceId ?? null,
              tags: configDataset.tags ? JSON.stringify(configDataset.tags) : null,
              projectId,
              userId,
              sampleCount: configDataset.samples?.length ?? null,
            },
          });

          if (configDataset.samples && configDataset.samples.length > 0) {
            await prisma.datasetSample.createMany({
              data: configDataset.samples.map((s) => ({
                datasetId: created.id,
                index: s.index,
                input: s.input,
                expected: s.expected ?? null,
                metadata: s.metadata ? JSON.stringify(s.metadata) : null,
              })),
            });
          }
        }
      }
    }

    const report: ImportDiffReport = {
      items,
      summary: {
        create: items.filter((i) => i.action === 'create').length,
        update: items.filter((i) => i.action === 'update').length,
        skip: items.filter((i) => i.action === 'skip').length,
      },
    };

    if (!dryRun) {
      const { ip, userAgent } = getRequestContext(request);
      audit({
        userId,
        action: 'config.import',
        resource: 'config',
        metadata: { summary: report.summary },
        ip,
        userAgent,
      });
    }

    return NextResponse.json({
      dryRun,
      ...report,
      message: dryRun
        ? `Preview: ${report.summary.create} to create, ${report.summary.update} to update, ${report.summary.skip} unchanged`
        : `Imported: ${report.summary.create} created, ${report.summary.update} updated, ${report.summary.skip} unchanged`,
    });
  } catch (error) {
    logger.error('Config import failed', { error: serializeError(error) });
    return NextResponse.json(
      { error: 'Failed to import configuration' },
      { status: 500 }
    );
  }
}
