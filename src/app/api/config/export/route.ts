import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireAuth, isAdmin } from '@/lib/auth-guard';
import {
  type ConfigDocument,
  dbProjectToConfig,
  dbRubricToConfig,
  dbModelToConfig,
  dbDatasetToConfig,
  serializeConfig,
  yamlResponse,
  generateSlug,
} from '@/lib/config';

/**
 * GET /api/config/export
 *
 * Exports the evaluation harness configuration as YAML.
 * 
 * Query params:
 *   - include: comma-separated list of sections to export.
 *              Options: projects, rubrics, models, datasets, all (default: all)
 *   - includeSamples: "true" to include dataset sample data in export (default: false)
 *   - format: "yaml" (default) or "json"
 *
 * Complements the data export endpoints (CSV/JSONL) which export evaluation
 * results. This endpoint exports the harness *setup* so it can be replicated.
 */
export async function GET(request: Request) {
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;

  const { searchParams } = new URL(request.url);
  const includeParam = (searchParams.get('include') ?? 'all').toLowerCase();
  const includeSamples = searchParams.get('includeSamples') === 'true';
  const format = (searchParams.get('format') ?? 'yaml').toLowerCase();

  const sections = includeParam === 'all'
    ? ['projects', 'rubrics', 'models', 'datasets']
    : includeParam.split(',').map((s) => s.trim());

  try {
    const userId = session.user.id;
    const admin = isAdmin(session);

    const config: ConfigDocument = {
      version: '1.0',
      exportedAt: new Date().toISOString(),
      projects: [],
      rubrics: [],
      models: [],
      datasets: [],
    };

    // ── Projects ──
    if (sections.includes('projects')) {
      const where = admin ? undefined : { userId };
      const projects = await prisma.project.findMany({
        where,
        orderBy: { name: 'asc' },
      });

      // Auto-generate slugs for any projects that don't have one
      const slugs: string[] = [];
      for (const project of projects) {
        if (!project.slug) {
          const slug = generateSlug(project.name);
          const uniqueSlug = slugs.includes(slug) ? `${slug}-${project.id.slice(0, 6)}` : slug;
          await prisma.project.update({
            where: { id: project.id },
            data: { slug: uniqueSlug },
          });
          project.slug = uniqueSlug;
        }
        slugs.push(project.slug);
      }

      config.projects = projects.map(dbProjectToConfig);
    }

    // ── Build project ID → slug map for dataset references ──
    const projectSlugMap = new Map<string, string>();
    if (sections.includes('datasets') || sections.includes('projects')) {
      const allProjects = await prisma.project.findMany({
        where: admin ? undefined : { userId },
        select: { id: true, slug: true, name: true },
      });
      for (const p of allProjects) {
        projectSlugMap.set(p.id, p.slug || generateSlug(p.name));
      }
    }

    // ── Rubrics ──
    if (sections.includes('rubrics')) {
      const where = admin ? undefined : { userId };
      const rubrics = await prisma.rubric.findMany({
        where,
        include: { criteria: { orderBy: { order: 'asc' } } },
        orderBy: [{ name: 'asc' }, { version: 'asc' }],
      });

      // Auto-generate slugs
      const slugs: string[] = [];
      for (const rubric of rubrics) {
        if (!rubric.slug) {
          const base = generateSlug(rubric.name);
          const slug = rubric.version > 1 ? `${base}-v${rubric.version}` : base;
          const uniqueSlug = slugs.includes(slug) ? `${slug}-${rubric.id.slice(0, 6)}` : slug;
          await prisma.rubric.update({
            where: { id: rubric.id },
            data: { slug: uniqueSlug },
          });
          rubric.slug = uniqueSlug;
        }
        slugs.push(rubric.slug);
      }

      config.rubrics = rubrics.map(dbRubricToConfig);
    }

    // ── Models (no secrets) ──
    if (sections.includes('models')) {
      const where = admin ? undefined : { userId };
      const models = await prisma.modelConfig.findMany({
        where,
        orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
      });

      // Auto-generate slugs
      const slugs: string[] = [];
      for (const model of models) {
        if (!model.slug) {
          const slug = generateSlug(model.name);
          const uniqueSlug = slugs.includes(slug) ? `${slug}-${model.id.slice(0, 6)}` : slug;
          await prisma.modelConfig.update({
            where: { id: model.id },
            data: { slug: uniqueSlug },
          });
          model.slug = uniqueSlug;
        }
        slugs.push(model.slug);
      }

      config.models = models.map(dbModelToConfig);
    }

    // ── Datasets ──
    if (sections.includes('datasets')) {
      const where = admin ? undefined : { userId };
      const datasets = await prisma.dataset.findMany({
        where,
        include: includeSamples
          ? { samples: { orderBy: { index: 'asc' } } }
          : undefined,
        orderBy: { name: 'asc' },
      });

      // Auto-generate slugs
      const slugs: string[] = [];
      for (const dataset of datasets) {
        if (!dataset.slug) {
          const slug = generateSlug(dataset.name);
          const uniqueSlug = slugs.includes(slug) ? `${slug}-${dataset.id.slice(0, 6)}` : slug;
          await prisma.dataset.update({
            where: { id: dataset.id },
            data: { slug: uniqueSlug },
          });
          dataset.slug = uniqueSlug;
        }
        slugs.push(dataset.slug);
      }

      config.datasets = datasets.map((ds) =>
        dbDatasetToConfig(ds, { includeSamples, projectSlugMap })
      );
    }

    const timestamp = new Date().toISOString().slice(0, 10);
    const filename = `judge-arena-config_${timestamp}`;

    if (format === 'json') {
      return NextResponse.json(config, {
        headers: {
          'Content-Disposition': `attachment; filename="${filename}.json"`,
          'Cache-Control': 'no-store',
        },
      });
    }

    return yamlResponse(serializeConfig(config), `${filename}.yaml`);
  } catch (error) {
    console.error('Config export failed:', error);
    return NextResponse.json(
      { error: 'Failed to export configuration' },
      { status: 500 }
    );
  }
}
