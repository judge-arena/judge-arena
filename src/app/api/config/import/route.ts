import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireAuth, requireScope } from '@/lib/auth-guard';
import {
  type ConfigDocument,
  type DiffItem,
  type ImportDiffReport,
  deserializeConfig,
} from '@/lib/config';

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
 *   - Match by slug (userId + slug).
 *   - If slug exists → update if changed, skip if identical.
 *   - If slug doesn't exist → create new entity.
 *   - API keys are NEVER imported (model configs are created without keys).
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
    for (const configModel of config.models) {
      const slug = configModel.slug;
      const existing = await prisma.modelConfig.findFirst({
        where: { userId, slug },
      });

      if (existing) {
        const changes: string[] = [];
        if (existing.name !== configModel.name) changes.push(`name: "${existing.name}" → "${configModel.name}"`);
        if (existing.provider !== configModel.provider) changes.push(`provider: ${existing.provider} → ${configModel.provider}`);
        if (existing.modelId !== configModel.modelId) changes.push(`modelId: ${existing.modelId} → ${configModel.modelId}`);
        if ((existing.endpoint ?? '') !== (configModel.endpoint ?? '')) changes.push('endpoint updated');
        if (existing.isActive !== configModel.isActive) changes.push(`isActive: ${existing.isActive} → ${configModel.isActive}`);

        if (changes.length === 0) {
          items.push({ type: 'model', slug, name: configModel.name, action: 'skip' });
        } else {
          items.push({ type: 'model', slug, name: configModel.name, action: 'update', changes });
          if (!dryRun) {
            await prisma.modelConfig.update({
              where: { id: existing.id },
              data: {
                name: configModel.name,
                provider: configModel.provider,
                modelId: configModel.modelId,
                endpoint: configModel.endpoint ?? null,
                isActive: configModel.isActive,
              },
            });
          }
        }
      } else {
        items.push({ type: 'model', slug, name: configModel.name, action: 'create' });
        if (!dryRun) {
          await prisma.modelConfig.create({
            data: {
              name: configModel.name,
              slug,
              provider: configModel.provider,
              modelId: configModel.modelId,
              endpoint: configModel.endpoint ?? null,
              isActive: configModel.isActive,
              userId,
            },
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

    return NextResponse.json({
      dryRun,
      ...report,
      message: dryRun
        ? `Preview: ${report.summary.create} to create, ${report.summary.update} to update, ${report.summary.skip} unchanged`
        : `Imported: ${report.summary.create} created, ${report.summary.update} updated, ${report.summary.skip} unchanged`,
    });
  } catch (error) {
    console.error('Config import failed:', error);
    return NextResponse.json(
      { error: 'Failed to import configuration' },
      { status: 500 }
    );
  }
}
