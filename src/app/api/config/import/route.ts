import { NextResponse } from 'next/server';
import type { JudgeClass, Prisma, ServingBackend } from '@prisma/client';
import { prisma } from '@/lib/db';
import { requireAuth, requireScope } from '@/lib/auth-guard';
import {
  type ConfigDocument,
  type DiffItem,
  type ImportDiffReport,
  deserializeConfig,
} from '@/lib/config';
import { legacyProviderToBackend } from '@/lib/llm';
import {
  isGoldenSetFrozen,
  GoldenSetFrozenError,
  findGoldenSetsPinningDataset,
  goldenItemLifecycleWhere,
  goldenSetLifecycleWhere,
  nextGoldenItemIndex,
  PLATFORM_OWNER_EMAIL,
  GOLDEN_LABEL_TOMBSTONE_REASON_CONFIG_IMPORT_REPLACE,
} from '@/lib/golden-sets';
import { forkGoldenSet } from '@/lib/golden-set-versions';
import { createCustomJudgeModel } from '@/lib/model-catalog';
import { logger, serializeError } from '@/lib/logger';
import { audit, getRequestContext } from '@/lib/audit';
import { liveSamplesOnly } from '@/lib/tombstones';

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

/** The content of one golden item, in the one shape both sides of the
 * create/update/skip comparison are projected into. */
interface GoldenItemContent {
  index: number;
  inputText: string;
  promptText: string | null;
  responseText: string | null;
  expected: string | null;
  candidates: { position: number; promptText: string | null; responseText: string | null; label: string | null }[];
}

/**
 * Content identity of one golden item AT A GIVEN ORDINAL POSITION in the set.
 *
 * `index` is deliberately not in the tuple. Items are tombstoned rather than
 * deleted and a tombstoned row keeps its ordinal, so a replace appends the new
 * items above the set's high-water mark: after one replace the live rows sit
 * at k..k+n-1 while the document still says 0..n-1. Comparing raw `index`
 * values would call that pair "different" forever — re-importing an unchanged
 * document would replace again, and again, growing the table by n rows per
 * run and reporting a spurious `update` in the preview. POSITION is what is
 * portable, and a genuine reorder still changes it.
 *
 * Also excludes `id`, `goldenSetId`, `sourceDatasetSampleId` and timestamps —
 * all instance-local.
 */
function goldenItemFingerprint(item: GoldenItemContent, position: number): string {
  const candidates = [...item.candidates]
    .sort((a, b) => a.position - b.position)
    .map((c) => [c.position, c.promptText ?? '', c.responseText ?? '', c.label ?? '']);
  return JSON.stringify([
    position,
    item.inputText,
    item.promptText ?? '',
    item.responseText ?? '',
    item.expected ?? '',
    candidates,
  ]);
}

/** Content identity of a whole item list. Ordering is imposed (items by
 * `index`, candidates by `position`) so two equal sets never differ on row
 * order alone. */
function goldenItemsFingerprint(items: GoldenItemContent[]): string {
  return [...items]
    .sort((a, b) => a.index - b.index)
    .map((item, position) => goldenItemFingerprint(item, position))
    .join('|');
}

/**
 * Retire everything a config-document replace supersedes on one golden set —
 * its live items AND the human labels attached to them — and return the
 * ordinal its replacements must start at.
 *
 * Both replace paths (unfrozen update, and post-fork) call this, so they
 * cannot drift apart on any of the three things that are easy to get wrong:
 *
 * 1. TOMBSTONE, NEVER DELETE (owner ruling 2026-08-13). Nothing is removed.
 *
 * 2. THE LABELS GO WITH THE ITEMS. A live `GoldenLabel` hanging off a
 *    tombstoned item is a human score still asserting itself about text no
 *    read path serves any more. This is the same invalidation
 *    `PATCH /api/golden-sets/[id]/items` performs, with its own reason string:
 *    an import replaces EVERY live item, including ones the document did not
 *    change, so `'item-content-edit'` would be a false statement about most of
 *    them. One `now` for the whole replace, so the rows it invalidates read as
 *    a single event rather than a scatter of timestamps.
 *
 * 3. THE OFFSET. Retained rows KEEP their ordinals — `@@unique([goldenSetId,
 *    index])` is deliberately not partial — so the replacements cannot land at
 *    0..n-1 without colliding with them (P2002, aborting the whole import).
 *    They are appended above the high-water mark instead.
 */
async function tombstoneReplacedGoldenItems(
  tx: Prisma.TransactionClient,
  goldenSetId: string
): Promise<number> {
  const now = new Date();

  // Not filtered on the ITEM's lifecycle, so this is order-independent with
  // respect to the item tombstone below.
  await tx.goldenLabel.updateMany({
    where: { goldenItem: { goldenSetId }, tombstonedAt: null },
    data: {
      tombstonedAt: now,
      tombstonedReason: GOLDEN_LABEL_TOMBSTONE_REASON_CONFIG_IMPORT_REPLACE,
    },
  });

  await tx.goldenItem.updateMany({
    where: { goldenSetId, tombstonedAt: null },
    data: { tombstonedAt: now },
  });

  return nextGoldenItemIndex(tx, goldenSetId);
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
 *   - Dataset samples are imported if present in the config — EXCEPT onto a
 *     dataset a golden set has annotated, where the wholesale replace is
 *     skipped and reported rather than raising a P2003 mid-document.
 *   - Projects referenced by datasets are resolved by slug.
 *   - Golden sets match by (ownerId, slug) and are ordered after datasets;
 *     their items are ALWAYS embedded, and each item's source DatasetSample
 *     is re-resolved by `inputText`. A frozen set forks instead of mutating,
 *     reported as a `create`. `GoldenSet.datasetId` is immutable, so a
 *     document that would repoint an existing set is refused. Replaced items
 *     are tombstoned, never deleted. Human labels are never imported.
 *   - A set's corpus resolves to THIS user's dataset or a PLATFORM-OWNED
 *     public one, never a stranger's — the pin an imported item puts on a
 *     DatasetSample is unreleasable, so binding one cross-tenant is not
 *     undoable by the victim.
 *   - RETIRED and TOMBSTONED sets are never written to: both are skipped with
 *     a reason, mirroring `assertGoldenSetInCirculation` on the items routes.
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
      // MUST NOT BE TOMBSTONE-FILTERED (A1). This is the upsert-by-slug read
      // for @@unique([userId, slug]) (schema.prisma:596). Filtered, a hidden
      // dataset's slug reads as free, the create branch runs, and Postgres
      // raises P2002 mid-import — on a route whose dataset section has no
      // `$transaction`, so the document lands half-applied.
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
          // ── The sample replace is the SECOND destructive path onto dataset
          // samples, and it carried none of the guard PUT /api/datasets/[id]/
          // samples has. Two things make it worse than that PUT:
          //
          //   1. It is gated on `changes.length > 0`, NOT on a sample diff.
          //      Merely RENAMING an annotated dataset reaches the deleteMany.
          //   2. This route has no `$transaction`. Projects, rubrics, models
          //      and the dataset row above are already committed when a P2003
          //      lands, and the golden-set section — ordered after this loop —
          //      never runs. The user gets a 500 saying nothing useful over a
          //      half-applied document.
          //
          // So this SKIPS the replace and reports it, rather than throwing:
          // a refusal that strands the import half-applied is not an
          // improvement on the P2003. Checked before `items.push` so the
          // dryRun preview says the same thing the real import will do.
          const wantsSampleReplace = !!configDataset.samples && configDataset.samples.length > 0;
          const pinningGoldenSets = wantsSampleReplace
            ? await findGoldenSetsPinningDataset(prisma, existing.id)
            : [];
          if (pinningGoldenSets.length > 0) {
            changes.push(
              `samples: NOT replaced — this dataset is annotated by golden set(s) ` +
                `${pinningGoldenSets.map((g) => g.name).join(', ')}, whose items were imported from ` +
                'these rows. Every other field on the dataset was applied. Retire the golden set, or ' +
                'import this corpus under a different slug.'
            );
          }
          const replaceSamples = wantsSampleReplace && pinningGoldenSets.length === 0;

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

            // Replace samples if provided, and if no golden set pins them.
            if (replaceSamples && configDataset.samples) {
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

    // ── Golden sets ──
    // Ordered AFTER datasets on purpose: a set's items resolve their source
    // DatasetSample out of the dataset the loop above just created.
    //
    // The one owner a golden set's corpus may belong to besides this session,
    // resolved ONCE for the document rather than per set. findFirst, not
    // findUnique: User.email is deliberately NOT db-unique — identity is
    // (oidcIssuer, oidcSubject) — and only prisma/seed-core.ts's
    // resolvePlatformUser ever writes a row with this address. Same lookup,
    // same reason, as POST /api/golden-sets:124-127.
    const platformUser =
      config.goldenSets.length > 0
        ? await prisma.user.findFirst({
            where: { email: PLATFORM_OWNER_EMAIL },
            select: { id: true },
          })
        : null;

    for (const configGoldenSet of config.goldenSets) {
      const slug = configGoldenSet.slug;
      const name = configGoldenSet.name;

      // Dataset resolution is WIDER than `POST /api/golden-sets` in exactly one
      // respect — it admits a private, user-owned corpus — and NO wider. Both
      // arms are load-bearing:
      //   (a) fresh self-hosted instance — the dataset came in this same
      //       document and is now owned by the importing user;
      //   (b) re-import into the SAME instance — the set is over
      //       judgebench-v1, owned by platform@judgearena.local, which the
      //       exporter never emitted (datasets are scoped `{ userId }`).
      // Drop (b) and every real golden set fails to resolve on re-import.
      //
      // ARM (b) IS OWNER-SCOPED, and that predicate is the whole guard. It was
      // `{ slug, visibility: 'public' }` — no owner — so any
      // session-authenticated caller could post a document binding their golden
      // items to a STRANGER's `DatasetSample` rows. The resulting pin is
      // unreleasable by design (a tombstoned item still holds the `Restrict`
      // FK, and purge is a later wave), so the victim permanently lost bulk
      // sample replace and dataset delete on their own resource with no
      // in-product remedy. `POST /api/golden-sets` refuses this exact widening
      // at :128-136 — "Widening this is a dropped check, not a migration."
      const dataset =
        (await prisma.dataset.findFirst({
          where: { userId, slug: configGoldenSet.datasetSlug },
        })) ??
        (platformUser
          ? await prisma.dataset.findFirst({
              where: {
                slug: configGoldenSet.datasetSlug,
                visibility: 'public',
                userId: platformUser.id,
              },
              orderBy: { createdAt: 'asc' },
            })
          : null);

      if (!dataset) {
        items.push({
          type: 'goldenSet',
          slug,
          name,
          action: 'skip',
          changes: [
            `dataset "${configGoldenSet.datasetSlug}" not found on this instance — import it in this ` +
              'document, or seed the platform-owned corpus first. Only your own datasets and ' +
              'platform-curated public ones can be annotated.',
          ],
        });
        continue;
      }

      // `GoldenItem.sourceDatasetSampleId` is required and `onDelete:
      // Restrict`, and a sample id is instance-local, so it is re-resolved
      // from content: `inputText` is `DatasetSample.input` verbatim for all
      // three mappings. Duplicate inputs collapse onto the lowest-index
      // sample — recorded in the COVERAGE map.
      //
      // LIVE ROWS ONLY, and the interaction with that collapse is the whole
      // point: the map keeps the FIRST hit per input, so an unfiltered read
      // lets a hidden row at a low index shadow a perfectly good live
      // duplicate at a higher one. The import then binds a live golden item to
      // a dead row, through a Restrict FK, permanently.
      const samples = await prisma.datasetSample.findMany({
        where: { datasetId: dataset.id, ...liveSamplesOnly() },
        select: { id: true, input: true },
        orderBy: { index: 'asc' },
      });
      const sampleIdByInput = new Map<string, string>();
      for (const sample of samples) {
        if (!sampleIdByInput.has(sample.input)) sampleIdByInput.set(sample.input, sample.id);
      }

      const unresolved = configGoldenSet.items.filter((i) => !sampleIdByInput.has(i.inputText));
      if (unresolved.length > 0) {
        items.push({
          type: 'goldenSet',
          slug,
          name,
          action: 'skip',
          changes: [
            `${unresolved.length} of ${configGoldenSet.items.length} items have no matching sample in dataset "${configGoldenSet.datasetSlug}" — re-export with ?includeSamples=true, or seed the corpus on this instance first`,
          ],
        });
        continue;
      }

      // Sorted by the document's own `index`, so this array's ORDINAL
      // POSITIONS are the set's intended order — which is what the replace
      // paths below write, and what the fingerprint comparison keys on. The
      // two must agree, or a replace would report a change it did not make.
      const itemData = [...configGoldenSet.items]
        .sort((a, b) => a.index - b.index)
        .map((item) => ({
          sourceDatasetSampleId: sampleIdByInput.get(item.inputText) as string,
          index: item.index,
          inputText: item.inputText,
          promptText: item.promptText ?? null,
          responseText: item.responseText ?? null,
          // The set is homogeneous: GoldenSet.protocol is the single source of
          // truth and every item is stamped with it.
          protocol: configGoldenSet.protocol,
          expected: item.expected ?? null,
          candidates: {
            create: item.candidates.map((c) => ({
              position: c.position,
              promptText: c.promptText ?? null,
              responseText: c.responseText ?? null,
              label: c.label ?? null,
            })),
          },
        }));

      // Match on (ownerId, slug), then compare against the NEWEST member of
      // that version family. Comparing against the slug-matched root instead
      // would re-fork a frozen set on every re-import of the same document,
      // growing versions without bound.
      //
      // THIS LOOKUP IS DELIBERATELY UNFILTERED ON LIFECYCLE, and the
      // classification immediately below is why. `@@unique([ownerId, slug])`
      // is not partial, so a TOMBSTONED set still holds this slug; filtering it
      // out here would send the document down the create branch and into a
      // P2002 the catch reports as a generic 500. It is classified instead.
      const matched = await prisma.goldenSet.findFirst({
        where: { ownerId: userId, slug },
        select: { id: true, name: true, parentId: true, tombstonedAt: true },
      });

      // A TOMBSTONED set is pending purge: every read path hides it
      // (`goldenSetLifecycleWhere` pins `tombstonedAt: null` in BOTH arms) and
      // nothing may hand one back. Writing the document into it would resurrect
      // content into a row nobody can see, and tombstone its labels on the way.
      //
      // SKIP, RATHER THAN SUFFIX THE SLUG the way POST /api/golden-sets:189-191
      // does on collision. That route is a one-shot interactive create where a
      // derived slug is a cosmetic detail. This one is an idempotent document
      // sync keyed on (ownerId, slug): a suffixed set no longer matches the
      // slug in the document, so the NEXT import of the same file would not
      // find it and would mint another one, and another — unbounded growth from
      // re-running an unchanged import, which is exactly the failure mode the
      // fingerprint comparison exists to prevent. A named skip is idempotent,
      // writes nothing, and tells the user the one thing they can act on.
      if (matched?.tombstonedAt) {
        items.push({
          type: 'goldenSet',
          slug,
          name,
          action: 'skip',
          changes: [
            `slug "${slug}" is held by golden set "${matched.name}", which is tombstoned and pending ` +
              'purge. A tombstoned set is never written to and never handed back. Import this set ' +
              'under a different slug.',
          ],
        });
        continue;
      }

      const rootId = matched ? matched.parentId ?? matched.id : null;
      const existing = rootId
        ? await prisma.goldenSet.findFirst({
            // `ownerId` is NOT redundant with the slug match above. A version
            // family can legitimately span owners: `requireOwnership` admits
            // admins, so an admin forking another user's set produces a v2 the
            // ADMIN owns under a root that user owns. Without this filter, the
            // original owner importing a document that matches their own slug
            // resolves `existing` to the admin's fork and — if it is unfrozen
            // and the content differs — rewrites another user's golden set and
            // replaces all of its items. An import may only ever write sets
            // this session owns.
            //
            // LIFECYCLE-FILTERED, the same predicate the four read paths and
            // the config export spread. `true` is the tombstone-only arm:
            // retired sets ARE fetched, on purpose, so the check below can
            // refuse one BY NAME instead of silently resolving to an older
            // live version of the family and rewriting that instead. A
            // tombstoned family member is skipped over entirely — it is
            // pending purge, so the newest LIVE version is the right target.
            where: {
              ownerId: userId,
              OR: [{ id: rootId }, { parentId: rootId }],
              ...goldenSetLifecycleWhere(true),
            },
            orderBy: { version: 'desc' },
            include: {
              items: {
                // Tombstoned items are removed content: comparing against
                // them would report a difference the user cannot resolve,
                // and they are not what a fresh export would emit either.
                where: goldenItemLifecycleWhere(false),
                orderBy: { index: 'asc' },
                include: { candidates: { orderBy: { position: 'asc' } } },
              },
            },
          })
        : null;

      if (!existing) {
        items.push({ type: 'goldenSet', slug, name, action: 'create' });
        if (!dryRun) {
          await prisma.goldenSet.create({
            data: {
              name,
              slug,
              description: configGoldenSet.description ?? null,
              visibility: configGoldenSet.visibility,
              protocol: configGoldenSet.protocol,
              version: configGoldenSet.version,
              datasetId: dataset.id,
              ownerId: userId,
              // No offset here: the set is being created, so no ordinal is
              // taken and the document's own indices stand.
              items: { create: itemData },
            },
          });
        }
        continue;
      }

      // A RETIRED set is the case that made this whole filter urgent. It is
      // live ground truth with live items and live human labels; the items
      // routes 409 on it via `assertGoldenSetInCirculation`; and the config
      // export DELIBERATELY emits it under `?includeRetired=true`. So
      // `export?includeRetired=true` -> edit -> import took the update branch,
      // called `tombstoneReplacedGoldenItems`, stamped `tombstonedReason:
      // 'config-import-replace'` on EVERY live GoldenLabel of the set, did not
      // clear `retiredAt`, and reported `update: 1` — a silent, un-undoable
      // wholesale invalidation of the one artifact this feature exists to
      // protect, through a documented round trip, reported as success.
      //
      // Checked BEFORE the datasetId guard below: the set's lifecycle decides
      // whether ANYTHING can be written to it, which is the more fundamental
      // refusal. The route out is the same pair the items routes offer —
      // un-retire, or fork — and neither is something an import may do on the
      // user's behalf.
      if (existing.retiredAt) {
        items.push({
          type: 'goldenSet',
          slug,
          name,
          action: 'skip',
          changes: [
            `golden set "${existing.name}" is retired: out of circulation, but still valid ground ` +
              'truth with live human labels. An import will not rewrite it. Un-retire it (POST ' +
              `/api/golden-sets/${existing.id}/retire with { "retired": false }), or fork it to a new ` +
              'version, then re-import.',
          ],
        });
        continue;
      }

      // `GoldenSet.datasetId` is IMMUTABLE — "a new record becomes a new
      // dataset" (owner ruling 2026-08-13); PATCH /api/golden-sets/[id] 400s
      // on its mere presence. Repointing here would be worse than the PATCH
      // it mirrors: the items below were resolved against the OTHER dataset's
      // samples, so applying them while leaving `datasetId` alone would leave
      // the set claiming one corpus and its items citing another. Refused
      // outright rather than partially applied.
      if (existing.datasetId !== dataset.id) {
        items.push({
          type: 'goldenSet',
          slug,
          name,
          action: 'skip',
          changes: [
            `dataset: → "${configGoldenSet.datasetSlug}" refused — datasetId is immutable, a golden set is the annotation layer over exactly one dataset. Import this set under a different slug, or fork it.`,
          ],
        });
        continue;
      }

      const changes: string[] = [];
      if (existing.name !== name) changes.push(`name: "${existing.name}" → "${name}"`);
      if ((existing.description ?? '') !== (configGoldenSet.description ?? '')) changes.push('description updated');
      if (existing.visibility !== configGoldenSet.visibility) changes.push(`visibility: ${existing.visibility} → ${configGoldenSet.visibility}`);
      if (existing.protocol !== configGoldenSet.protocol) changes.push(`protocol: ${existing.protocol} → ${configGoldenSet.protocol}`);

      const existingFingerprint = goldenItemsFingerprint(existing.items);
      const configFingerprint = goldenItemsFingerprint(
        configGoldenSet.items.map((item) => ({
          index: item.index,
          inputText: item.inputText,
          promptText: item.promptText ?? null,
          responseText: item.responseText ?? null,
          expected: item.expected ?? null,
          candidates: item.candidates.map((c) => ({
            position: c.position,
            promptText: c.promptText ?? null,
            responseText: c.responseText ?? null,
            label: c.label ?? null,
          })),
        }))
      );
      if (existingFingerprint !== configFingerprint) {
        changes.push(`items: ${existing.items.length} → ${configGoldenSet.items.length}`);
      }

      if (changes.length === 0) {
        items.push({ type: 'goldenSet', slug, name, action: 'skip' });
        continue;
      }

      const frozen = await isGoldenSetFrozen(prisma, existing.id);

      if (!frozen) {
        items.push({ type: 'goldenSet', slug, name, action: 'update', changes });
        if (!dryRun) {
          await prisma.$transaction(async (tx) => {
            // Re-checked INSIDE the write transaction. Separated, a
            // CalibrationRun started between the read above and this write
            // measures a set that changed underneath it — retention silently
            // broken, and nothing logs.
            if (await isGoldenSetFrozen(tx, existing.id)) {
              throw new GoldenSetFrozenError(existing.id);
            }
            const offset = await tombstoneReplacedGoldenItems(tx, existing.id);
            await tx.goldenSet.update({
              where: { id: existing.id },
              data: {
                name,
                description: configGoldenSet.description ?? null,
                visibility: configGoldenSet.visibility,
                protocol: configGoldenSet.protocol,
                version: configGoldenSet.version,
                // `datasetId` is NOT written: it is immutable, and the guard
                // above has already proved it equal to `dataset.id`.
                items: {
                  // POSITION + offset, not the document's raw `index` +
                  // offset. A fresh export emits the indices this replace
                  // writes, so adding the offset to a raw index compounds it
                  // on every export→edit→import cycle — 2, 6, 14, 30, … and
                  // an `Int` column overflows after ~31 of them. Only
                  // relative order is portable anyway (see ConfigGoldenItem),
                  // so packing to positions loses nothing and keeps the
                  // high-water mark growing linearly.
                  create: itemData.map((item, position) => ({ ...item, index: position + offset })),
                },
              },
            });
          });
        }
        continue;
      }

      // Frozen + changed → fork rather than mutate (design decision #6),
      // reported as a `create` and NOT a new DiffAction: adding a value to
      // DiffAction changes ImportDiffReport.summary's three-key shape, the
      // settings page's actionVariant, and every existing
      // `expect(body.summary).toEqual({ create, update, skip })`.
      if (dryRun) {
        items.push({
          type: 'goldenSet',
          slug,
          name,
          action: 'create',
          changes: [...changes, 'frozen by a calibration run — a real import would fork to a new version rather than mutate it'],
        });
        continue;
      }

      const fork = await forkGoldenSet(prisma, {
        rootGoldenSetId: existing.parentId ?? existing.id,
        sourceGoldenSetId: existing.id,
        ownerId: userId,
        name,
        description: configGoldenSet.description ?? null,
      });
      // forkGoldenSet copies the SOURCE's items (and the labels that follow
      // unedited items). The document's items are what the user asked for,
      // so they replace them — legal because a just-created fork has no
      // CalibrationRun and is therefore not frozen. `protocol` is rewritten
      // with them because the set is homogeneous: the items below are stamped
      // with the document's protocol, and leaving the fork on the source's
      // would make the set disagree with its own items. `datasetId` is not
      // rewritten — it is immutable, and the fork inherits the source's,
      // which the guard above proved equal to `dataset.id`.
      await prisma.$transaction(async (tx) => {
        // Same replace step as the unfrozen path above, for the same reasons:
        // the items forkGoldenSet just copied hold ordinals 0..n-1 and keep
        // them, and the labels it copied with them are annotations of text
        // this document is superseding.
        const offset = await tombstoneReplacedGoldenItems(tx, fork.id);
        await tx.goldenSet.update({
          where: { id: fork.id },
          data: {
            visibility: configGoldenSet.visibility,
            protocol: configGoldenSet.protocol,
            items: {
              create: itemData.map((item, position) => ({ ...item, index: position + offset })),
            },
          },
        });
      });
      items.push({
        type: 'goldenSet',
        slug: fork.slug ?? slug,
        name,
        action: 'create',
        changes: [...changes, `frozen by a calibration run — forked to version ${fork.version}`],
      });
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
    // A set that froze between the advisory read and the guarded write. The
    // write already rolled back; a re-run takes the fork path instead.
    if (error instanceof GoldenSetFrozenError) {
      return NextResponse.json(
        {
          error: `Golden set ${error.goldenSetId} was frozen by a calibration run while this import was running. Re-run the import — it will fork instead of mutating.`,
        },
        { status: 409 }
      );
    }
    logger.error('Config import failed', { error: serializeError(error) });
    return NextResponse.json(
      { error: 'Failed to import configuration' },
      { status: 500 }
    );
  }
}
