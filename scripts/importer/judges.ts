/**
 * Importer phase — judge synthesis.
 *
 * Walks every v1 ModelConfig row and groups them by the triple
 * `(provider, modelId, endpoint ?? '')` — v1 has no concept of a judge
 * identity independent of a per-user config row, so this triple is the
 * closest thing to one: two ModelConfigs (even across different users)
 * that share it are, for import purposes, the same judge.
 *
 * Each distinct triple becomes exactly one v2 JudgeModel (stable identity)
 * + one JudgeModelVersion at ordinal 1 (v1 has no version history), plus
 * one ModelEndpoint per DISTINCT v1 user who owned a ModelConfig in that
 * group (resolved through the `owners` map produced by ./owners — a v1
 * user whose owner-map disposition is `'drop'` has no entry in `owners`,
 * so gets NO endpoint; the JudgeModel/Version for their triple is still
 * created if they're its only owner, since Task 9/10's ModelJudgment rows
 * may still need to reference the version).
 *
 * Provider -> v2 mapping (per the task-8 brief):
 *   'anthropic' | 'openai' -> judgeClass prompted_api, servingBackend <same>
 *   'local'                -> judgeClass prompted_open_weight,
 *                             servingBackend openai, endpointClass
 *                             'v1-local-unknown' (v1's "local" provider is
 *                             an unknown OpenAI-compatible server, not any
 *                             specific runtime — do NOT map to vllm/ollama).
 * scoringMechanism is always `critique_generative` (v1 judges only ever
 * produced free-text critiques + a score, never a reward-head scalar or a
 * token-probability readout).
 *
 * Every v2 write is gated on `ctx.mode === 'apply'`, with the same
 * find-or-create + placeholder-id-on-report-mode discipline as ./owners
 * (see its module doc). Idempotent in `apply` mode: JudgeModel by slug,
 * JudgeModelVersion by `(judgeModelId, ordinal)`, ModelEndpoint by
 * `(userId, judgeModelVersionId, endpoint)` — re-running against the same
 * v1 data recomputes the same slugs (see `uniqueSlug`) in the same
 * deterministic order and finds the same rows instead of duplicating them.
 *
 * samplingDefaults literal note: the brief specifies
 * `{ temperature: 0.3, max_tokens: 2048 }`. Checked against the actual v1
 * judge call sites — src/lib/llm/anthropic.ts:48-49 and
 * src/lib/llm/openai-compatible.ts:66/71 — temperature matches (0.3), but
 * both actually use `max_tokens: 4096`, not 2048; `2048` does not appear
 * anywhere in src/lib/llm/**. Used the brief's literal as specified since
 * it's a binding clarification; flagged the discrepancy in the task report
 * rather than silently "fixing" it.
 */
import type { JudgeClass, ServingBackend } from '@prisma/client';
import type { ImportCtx } from './context';

interface ProviderClassification {
  judgeClass: JudgeClass;
  servingBackend: ServingBackend;
  endpointClass: string | null;
}

function classifyProvider(provider: string): ProviderClassification {
  switch (provider) {
    case 'anthropic':
      return { judgeClass: 'prompted_api', servingBackend: 'anthropic', endpointClass: null };
    case 'openai':
      return { judgeClass: 'prompted_api', servingBackend: 'openai', endpointClass: null };
    case 'local':
      return {
        judgeClass: 'prompted_open_weight',
        servingBackend: 'openai',
        endpointClass: 'v1-local-unknown',
      };
    default:
      throw new Error(`synthesizeJudges: unrecognized v1 ModelConfig.provider "${provider}"`);
  }
}

/** lowercase; run of non-alphanumeric chars -> single '-'; trim leading/trailing '-'. */
function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** First occurrence of `base` wins outright; later collisions get -2, -3, ... */
function uniqueSlug(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let n = 2;
  while (used.has(`${base}-${n}`)) n += 1;
  const slug = `${base}-${n}`;
  used.add(slug);
  return slug;
}

function reportPlaceholderId(entity: string, key: string): string {
  return `report:${entity}:${key}`;
}

async function findOrCreateJudgeModel(
  ctx: ImportCtx,
  args: { slug: string; name: string; judgeClass: JudgeClass }
): Promise<string> {
  const existing = await ctx.v2.judgeModel.findUnique({ where: { slug: args.slug } });
  if (existing) {
    ctx.report.add('JudgeModel', 'skipped');
    return existing.id;
  }

  ctx.report.add('JudgeModel', 'created');
  if (ctx.mode !== 'apply') {
    return reportPlaceholderId('JudgeModel', args.slug);
  }

  const created = await ctx.v2.judgeModel.create({
    data: {
      slug: args.slug,
      name: args.name,
      judgeClass: args.judgeClass,
      scoringMechanism: 'critique_generative',
    },
  });
  return created.id;
}

async function findOrCreateVersion(
  ctx: ImportCtx,
  args: { judgeModelId: string; servingBackend: ServingBackend; endpointClass: string | null }
): Promise<string> {
  // A placeholder judgeModelId (report mode, group not yet real) never
  // matches a real row here, so this consistently falls through to
  // "not found" -> `created` tally, exactly as it should.
  const existing = await ctx.v2.judgeModelVersion.findUnique({
    where: { judgeModelId_ordinal: { judgeModelId: args.judgeModelId, ordinal: 1 } },
  });
  if (existing) {
    ctx.report.add('JudgeModelVersion', 'skipped');
    return existing.id;
  }

  ctx.report.add('JudgeModelVersion', 'created');
  if (ctx.mode !== 'apply') {
    return reportPlaceholderId('JudgeModelVersion', `${args.judgeModelId}:1`);
  }

  const created = await ctx.v2.judgeModelVersion.create({
    data: {
      judgeModelId: args.judgeModelId,
      ordinal: 1,
      weightsRevision: 'v1-unknown',
      quantization: 'none',
      servingBackend: args.servingBackend,
      endpointClass: args.endpointClass,
      protocolSupport: { pointwise: ['score'] },
      samplingDefaults: { temperature: 0.3, max_tokens: 2048 },
    },
  });
  return created.id;
}

async function findOrCreateEndpoint(
  ctx: ImportCtx,
  args: { userId: string; judgeModelVersionId: string; endpoint: string | null; isActive: boolean }
): Promise<string> {
  // No compound unique constraint on ModelEndpoint (see schema.prisma), so
  // this is findFirst + conditional create rather than a true upsert — safe
  // here since the importer runs single-threaded/sequentially.
  const existing = await ctx.v2.modelEndpoint.findFirst({
    where: {
      userId: args.userId,
      judgeModelVersionId: args.judgeModelVersionId,
      endpoint: args.endpoint,
    },
  });
  if (existing) {
    ctx.report.add('ModelEndpoint', 'skipped');
    return existing.id;
  }

  ctx.report.add('ModelEndpoint', 'created');
  if (ctx.mode !== 'apply') {
    return reportPlaceholderId(
      'ModelEndpoint',
      `${args.userId}:${args.judgeModelVersionId}:${args.endpoint ?? ''}`
    );
  }

  const created = await ctx.v2.modelEndpoint.create({
    data: {
      userId: args.userId,
      judgeModelVersionId: args.judgeModelVersionId,
      endpoint: args.endpoint,
      isActive: args.isActive,
      // apiKeyEnc intentionally NOT copied from v1 — keys are re-entered
      // per the Phase 2 runbook, never carried across the import.
      apiKeyEnc: null,
      verifiedAt: null,
    },
  });
  return created.id;
}

interface ConfigGroup {
  provider: string;
  modelId: string;
  endpoint: string | null;
  configs: Array<{ id: string; userId: string; isActive: boolean }>;
}

export async function synthesizeJudges(
  ctx: ImportCtx,
  owners: Map<string, string>
): Promise<Map<string, { versionId: string; endpointIdByUser: Map<string, string> }>> {
  const result = new Map<string, { versionId: string; endpointIdByUser: Map<string, string> }>();

  // Deterministic order (createdAt, then id as a tiebreak over ties/equal
  // timestamps) so the slug-suffix assignment below is stable across
  // repeated runs against the same v1 data — required for the idempotency
  // guarantee (see findOrCreateJudgeModel's module-doc note).
  const configs = await ctx.v1.modelConfig.findMany({
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });

  const groups = new Map<string, ConfigGroup>();
  for (const config of configs) {
    const key = `${config.provider} ${config.modelId} ${config.endpoint ?? ''}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        provider: config.provider,
        modelId: config.modelId,
        endpoint: config.endpoint,
        configs: [],
      };
      groups.set(key, group);
    }
    group.configs.push({ id: config.id, userId: config.userId, isActive: config.isActive });
  }

  const usedSlugs = new Set<string>();

  for (const group of groups.values()) {
    const { judgeClass, servingBackend, endpointClass } = classifyProvider(group.provider);
    const baseSlug = slugify(`${group.provider}-${group.modelId}`);
    const slug = uniqueSlug(baseSlug, usedSlugs);

    const judgeModelId = await findOrCreateJudgeModel(ctx, {
      slug,
      name: `${group.provider} ${group.modelId}`,
      judgeClass,
    });
    const versionId = await findOrCreateVersion(ctx, { judgeModelId, servingBackend, endpointClass });

    // One ModelEndpoint per DISTINCT owning v1 user — collapse duplicate
    // ModelConfigs from the same owner within this group down to a single
    // representative before creating endpoints (keeps report-mode tallies
    // and apply-mode row counts identical regardless of how many duplicate
    // configs a user happened to have for the same triple).
    const configByOwner = new Map<string, { isActive: boolean }>();
    for (const config of group.configs) {
      if (!configByOwner.has(config.userId)) {
        configByOwner.set(config.userId, { isActive: config.isActive });
      }
    }

    const endpointIdByUser = new Map<string, string>();
    for (const [v1UserId, rep] of configByOwner) {
      const v2UserId = owners.get(v1UserId);
      if (!v2UserId) {
        // Dropped owner: no endpoint, but the JudgeModel/Version above
        // still exist for any Task 9/10 rows that reference this triple.
        ctx.report.add('ModelEndpoint', 'skipped');
        continue;
      }

      const endpointId = await findOrCreateEndpoint(ctx, {
        userId: v2UserId,
        judgeModelVersionId: versionId,
        endpoint: group.endpoint,
        isActive: rep.isActive,
      });
      endpointIdByUser.set(v1UserId, endpointId);
    }

    for (const config of group.configs) {
      result.set(config.id, { versionId, endpointIdByUser });
    }
  }

  return result;
}
