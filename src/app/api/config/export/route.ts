import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireAuth, requireScope, isAdmin } from '@/lib/auth-guard';
import {
  type ConfigDocument,
  dbProjectToConfig,
  dbRubricToConfig,
  dbModelToConfig,
  dbDatasetToConfig,
  dbGoldenSetToConfig,
  serializeConfig,
  yamlResponse,
  generateSlug,
} from '@/lib/config';
import {
  goldenItemLifecycleWhere,
  goldenSetLifecycleWhere,
  parseIncludeRetired,
} from '@/lib/golden-sets';
import { logger, serializeError } from '@/lib/logger';
import { liveDatasetsOnly, liveSamplesOnly } from '@/lib/tombstones';

/**
 * GET /api/config/export
 *
 * Exports the evaluation harness configuration as YAML.
 * 
 * Query params:
 *   - include: comma-separated list of sections to export.
 *              Options: projects, rubrics, models, datasets, goldenSets, all (default: all)
 *   - includeSamples: "true" to include dataset sample data in export (default: false)
 *   - includeRetired: "true" to include RETIRED golden sets (default: false).
 *                     `retiredAt`/`tombstonedAt` are excludedByDesign from the
 *                     config format — there is no field to carry them — so a
 *                     retired set exported under this flag re-imports as a
 *                     LIVE set. Turning it on is a deliberate "resurrect these
 *                     on the next import" decision, not a verbosity toggle.
 *                     Tombstoned sets (pending purge, owner deleted) are never
 *                     exported under any flag.
 *   - format: "yaml" (default) or "json"
 *
 * Complements the data export endpoints (CSV/JSONL) which export evaluation
 * results. This endpoint exports the harness *setup* so it can be replicated.
 */
export async function GET(request: Request) {
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;
  const scopeCheck = requireScope(session, 'config:read');
  if (scopeCheck) return scopeCheck;

  const { searchParams } = new URL(request.url);
  const includeParam = (searchParams.get('include') ?? 'all').toLowerCase();
  const includeSamples = searchParams.get('includeSamples') === 'true';
  const includeRetired = parseIncludeRetired(searchParams);
  const format = (searchParams.get('format') ?? 'yaml').toLowerCase();

  // Lowercase entries ONLY. `includeParam` is lowercased above, so a
  // caller's `?include=goldenSets` arrives here as `goldensets`; a camelCase
  // entry in this array would match `all` but never an explicit include, and
  // an unknown section name is silently ignored rather than rejected — the
  // section would just quietly export nothing.
  const sections = includeParam === 'all'
    ? ['projects', 'rubrics', 'models', 'datasets', 'goldensets']
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
      goldenSets: [],
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
    // Task 12 review fix: sourced from the JudgeModel/JudgeModelVersion/
    // ModelEndpoint catalog+endpoint domain, NOT the retired `ModelConfig`
    // table — exporting from ModelConfig would emit rows the runtime no
    // longer writes/reads and that `POST /api/config/import` no longer
    // creates, breaking the export/import round-trip.
    //
    // `JudgeModel.slug` is globally unique (unlike the old per-user
    // `ModelConfig.slug`) and always set at creation, so — unlike the other
    // sections above — there's no "backfill a missing slug" step here. A
    // slug collision can still happen in the EXPORTED document if this user
    // has more than one ModelEndpoint against the same JudgeModel (e.g. one
    // active, one retired key) — disambiguated the same way the other
    // sections dedupe an auto-generated slug, with the endpoint's own id.
    if (sections.includes('models')) {
      const where = admin ? undefined : { userId };
      const endpoints = await prisma.modelEndpoint.findMany({
        where,
        include: { judgeModelVersion: { include: { judgeModel: true } } },
        orderBy: [{ isActive: 'desc' }, { createdAt: 'asc' }],
      });

      const slugs: string[] = [];
      config.models = endpoints.map((endpoint) => {
        const judgeModel = endpoint.judgeModelVersion.judgeModel;
        const slug = slugs.includes(judgeModel.slug)
          ? `${judgeModel.slug}-${endpoint.id.slice(0, 6)}`
          : judgeModel.slug;
        slugs.push(slug);

        return dbModelToConfig({
          slug,
          name: judgeModel.name,
          // The REAL servingBackend, not collapsed to the legacy 3-value
          // provider string — see `modelSchema`'s doc in src/lib/config.ts
          // for why the config format's `provider` field now accepts the
          // full ServingBackend set.
          provider: endpoint.judgeModelVersion.servingBackend,
          modelId: judgeModel.baseModel ?? '',
          endpoint: endpoint.endpoint,
          isActive: endpoint.isActive,
        });
      });
    }

    // ── Datasets ──
    if (sections.includes('datasets')) {
      // A1: a hidden dataset never enters the portable document — including
      // on the admin branch, which previously passed `undefined`. The
      // importer writes whatever this emits back as a fresh, live row.
      const where = admin ? liveDatasetsOnly() : { userId, ...liveDatasetsOnly() };
      const datasets = await prisma.dataset.findMany({
        where,
        include: includeSamples
          ? // The config document is a portable VIEW of the instance, so it
            // carries what the instance shows, not what its tables still hold.
            // A hidden row emitted here is worse than a leak on a page: the
            // importer writes it back as a fresh, live row on a new id, with no
            // tombstone and nothing recording that it was ever withdrawn.
            { samples: { where: liveSamplesOnly(), orderBy: { index: 'asc' } } }
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

    // ── Golden sets (items ALWAYS embedded) ──
    // Deliberately asymmetric with datasets: a dataset's samples sit behind
    // `?includeSamples=true` (default off), but a golden set IS its
    // annotation layer — exported without items it round-trips vacuously.
    //
    // `GoldenSet` keys ownership on `ownerId`, not the `userId` every other
    // model in this file uses (prisma/schema.prisma).
    //
    // LIFECYCLE FILTER, the same `goldenSetLifecycleWhere` predicate the four
    // /api/golden-sets read paths spread, so this document and the API cannot
    // drift apart about what "exists". It matters more here than anywhere
    // else: `retiredAt`, `tombstonedAt` and `publishedAt` are all
    // excludedByDesign in the round-trip COVERAGE map because the config
    // format has no field for them, so an exported retired set re-imports as
    // a LIVE one — exporting by default would make a round trip silently
    // resurrect everything the user retired.
    //
    // ?includeRetired=true is wired for symmetry with the other three read
    // paths, with that resurrection stated in the route doc above rather than
    // left to be discovered. `tombstonedAt: null` holds in BOTH arms of the
    // predicate, and it is LOAD-BEARING IN BOTH — do not read it as
    // belt-and-braces and delete it.
    //
    // A SET'S `tombstonedAt` HAS TWO WRITERS, and only one of them nulls the
    // owner. `src/lib/account-deletion.ts` tombstones an unpinned private set
    // when its account goes, and `GoldenSet.ownerId` is `onDelete: SetNull`,
    // so that row ends up with `ownerId: null` and falls outside
    // `ownerId: userId` on its own. But `DELETE /api/golden-sets/[id]`
    // tombstones with the OWNER INTACT — that is the ordinary "delete this
    // set" button — so for a plain non-admin export, a set the caller deleted
    // themselves still matches the ownership scope, and this clause is the
    // only thing keeping it out of a portable document that would re-import
    // it as live. The admin arm has no ownership scope at all, so both kinds
    // are in range there.
    if (sections.includes('goldensets')) {
      // Spread AFTER the ownership scope so neither clause can be dropped by
      // a later edit reordering them.
      const ownerScope = admin ? {} : { ownerId: userId };
      const goldenSets = await prisma.goldenSet.findMany({
        where: { ...ownerScope, ...goldenSetLifecycleWhere(includeRetired) },
        include: {
          dataset: { select: { slug: true, name: true } },
          items: {
            // Same reasoning one level down, and the same helper every other
            // item read in src/ routes through: a tombstoned item is one its
            // owner removed HERE, and exporting it would let a re-import
            // resurrect it as live content.
            where: goldenItemLifecycleWhere(false),
            orderBy: { index: 'asc' },
            include: { candidates: { orderBy: { position: 'asc' } } },
          },
        },
        orderBy: [{ name: 'asc' }, { version: 'asc' }],
      });

      // Auto-generate slugs, same shape as the three sections above.
      // `goldenSetSchema.slug` is `z.string().min(1)`, so a null slug here
      // would make the exported document unimportable.
      const slugs: string[] = [];
      for (const goldenSet of goldenSets) {
        if (!goldenSet.slug) {
          const base = generateSlug(goldenSet.name);
          const slug = goldenSet.version > 1 ? `${base}-v${goldenSet.version}` : base;
          const uniqueSlug = slugs.includes(slug) ? `${slug}-${goldenSet.id.slice(0, 6)}` : slug;
          await prisma.goldenSet.update({
            where: { id: goldenSet.id },
            data: { slug: uniqueSlug },
          });
          goldenSet.slug = uniqueSlug;
        }
        slugs.push(goldenSet.slug);
      }

      config.goldenSets = goldenSets.map((gs) => dbGoldenSetToConfig(gs));
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
    logger.error('Config export failed', { error: serializeError(error) });
    return NextResponse.json(
      { error: 'Failed to export configuration' },
      { status: 500 }
    );
  }
}
