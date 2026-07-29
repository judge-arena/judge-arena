/**
 * ─── Judge Identity Resolution (web-tier ModelConfig -> JudgeModelVersion) ──
 *
 * Bridges the 1b runtime's ModelConfig-based UI/routes (unchanged until
 * Task 12) onto the queue-era identity model (`JudgeModel` /
 * `JudgeModelVersion` / `ModelEndpoint` — see schema.prisma's "Judge
 * Identity" section) that the worker (`src/worker/judgment-consumer.ts`)
 * and the queue messages (`src/lib/queue/publish.ts`'s `JudgmentExecuteMsg`/
 * `RunCreateMsg`) require.
 *
 * ── Why this exists (Task 9 plan amendment) ─────────────────────────────────
 * Task 9's write path requires `judgeModelVersionId` on every new
 * `ModelJudgment` row — but the current web routes still only ever collect
 * `modelConfigId` selections (Task 12 is what switches the UI/routes to
 * pick `JudgeModelVersion`s directly). There is no mapping table in the
 * runtime yet, and nothing populates `JudgeModel`/`JudgeModelVersion`/
 * `ModelEndpoint` for a user's live `ModelConfig` rows outside of the
 * one-time v1->v2 IMPORT path (`scripts/importer/judges.ts`, Task 8 of 1a).
 * `ensureJudgeIdentityForModelConfig()` is the live-runtime equivalent:
 * given a `ModelConfig` row, find-or-create the `JudgeModel` +
 * `JudgeModelVersion` + `ModelEndpoint` triple it identifies, so the web
 * tier can resolve a `judgeModelVersionId` to publish with.
 *
 * ── Deliberate, disclosed duplication ───────────────────────────────────────
 * The provider classification (`classifyProvider`) and slugification rules
 * below intentionally MIRROR `scripts/importer/judges.ts`'s `synthesizeJudges`
 * — same provider -> judgeClass/servingBackend/endpointClass mapping, same
 * `scoringMechanism: 'critique_generative'`, same `protocolSupport`/
 * `samplingDefaults` literals for a freshly-created version. The importer's
 * own copy is left untouched (out of scope for this task; it processes a
 * one-shot v1 dataset, not live traffic, and duplicating a ~250-line module
 * for one shared classifier function is not worth the coupling). This is a
 * TEMPORARY duplication: Task 12 retires the `ModelConfig` write path
 * entirely (routes switch to picking `JudgeModelVersion`s directly), at
 * which point this file's only remaining caller disappears and it can be
 * deleted alongside `ModelConfig` itself.
 *
 * ── Where this diverges from the importer (and why) ─────────────────────────
 * 1. `JudgeModel.baseModel` — the importer's target data (v1 `ModelConfig`)
 *    never records which literal provider-side model id a judge should
 *    call with confidence-appropriate provenance, so `synthesizeJudges`
 *    leaves `baseModel` unset (see judgment-consumer.ts's module doc: "the
 *    only schema field that could hold the literal provider model id ...
 *    NOTHING today populates it"). Here, the source IS a live `ModelConfig`
 *    row, which carries exactly that literal id (`ModelConfig.modelId`) —
 *    so this function sets `baseModel` on create. Without this, every
 *    judgment published through this path would deterministically fail at
 *    execution time (`defaultRunProviderJudgment` throws `non_retryable`
 *    when `baseModel` is unset) — Task 9 is about making the queue path
 *    actually run judgments, not just enqueue them.
 * 2. `ModelEndpoint.apiKeyEnc` — the importer explicitly does NOT carry v1
 *    API keys forward (users re-enter them post-migration, per its Phase 2
 *    runbook note). Here there is no migration boundary: `ModelConfig.apiKey`
 *    is the user's live, already-encrypted (`encryptIfNeeded`, same
 *    `enc:v1:` tagged AES-256-GCM format `ModelEndpoint.apiKeyEnc` expects —
 *    see src/lib/crypto.ts) credential, so it is carried through directly.
 *    Not re-encrypting it (it's already ciphertext) avoids a double-encrypt
 *    bug.
 * 3. Identity grouping / slug assignment — the importer processes an entire
 *    v1 dataset in one batch and resolves slug collisions with an
 *    in-memory, insertion-order-dependent `uniqueSlug()` (first (provider,
 *    modelId) triple to be seen keeps the bare slug; later collisions,
 *    including same (provider,modelId) with a DIFFERENT `endpoint`, get
 *    `-2`, `-3`, ...). That scheme requires knowing the whole batch's
 *    processing order up front, which doesn't fit a one-at-a-time,
 *    call-scoped runtime resolver (this can be invoked concurrently, for
 *    unrelated ModelConfigs, from different requests). Instead, the slug
 *    here is fully deterministic per triple: `slugify(provider-modelId)`,
 *    plus a short stable hash of `endpoint` appended whenever `endpoint` is
 *    set (so distinct endpoints for the same (provider, modelId) — exactly
 *    the importer's `-2`/`-3` case — land on distinct, STABLE slugs without
 *    needing to know about each other or their creation order). This means
 *    slugs minted here won't byte-for-byte match what the importer would
 *    have produced for equivalent v1 data — acceptable, since these are two
 *    independent identity spaces (imported-v1-history vs. live-v2-runtime)
 *    that were never guaranteed to line up, and no test/consumer depends on
 *    the exact slug shape.
 *
 * ── Idempotency ──────────────────────────────────────────────────────────
 * Find-or-create at every step (JudgeModel by slug, JudgeModelVersion by
 * `(judgeModelId, ordinal=1)`, ModelEndpoint by `(userId, judgeModelVersionId,
 * endpoint)`) — calling this twice for the same `ModelConfig` (or two
 * different `ModelConfig`s that resolve to the same (provider, modelId,
 * endpoint) triple) returns the same `versionId`.
 *
 * ── Concurrent first-use race (findOrCreateJudgeModel / findOrCreateVersion) ─
 * The find-then-create in each of those two helpers is not atomic: two
 * concurrent callers resolving the SAME brand-new (provider, modelId,
 * endpoint) triple can both see "not found" and both attempt `create`. Both
 * `JudgeModel.slug` and `JudgeModelVersion.(judgeModelId, ordinal)` are real
 * DB unique constraints, so the loser doesn't silently duplicate — it gets a
 * P2002 from Postgres. Both helpers catch that specifically and re-find
 * once, returning the winner's row, so a concurrent first-use race resolves
 * to the SAME identity for both callers instead of one of them surfacing a
 * raw 500 to its caller (`launchSingleRun`/`launchBulkRunCreates`, and
 * ultimately an HTTP request). `findOrCreateEndpoint` has no compound unique
 * constraint (see its own comment) — it can't throw P2002, so this doesn't
 * apply there; a concurrent race there creates two distinct `ModelEndpoint`
 * rows instead, a pre-existing, disclosed, out-of-scope limitation.
 *
 * It does NOT resync an
 * already-created row if the source `ModelConfig` changes later (e.g. the
 * user edits their API key or endpoint after the first run) — the existing
 * `ModelEndpoint` wins. That drift is a known, accepted limitation of this
 * temporary bridge, not something Task 9 attempts to solve; Task 12 removes
 * the whole ModelConfig-keyed path this drift could occur on.
 */
import { createHash } from 'crypto';
import { Prisma, type JudgeClass, type ModelConfig, type PrismaClient, type ServingBackend } from '@prisma/client';
import { legacyProviderToBackend } from '@/lib/llm/registry';

/** True iff `error` is a P2002 unique-constraint violation — used below to
 * turn a concurrent find-or-create race into a re-find instead of a raw
 * 500. See `findOrCreateJudgeModel`/`findOrCreateVersion`'s doc comments. */
function isUniqueConstraintViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/** Structural subset of `PrismaClient` this module needs — satisfied by
 * both the top-level `prisma` singleton and a `$transaction` callback's
 * `tx` client, so callers can resolve identities either outside or inside
 * a transaction as their own control flow requires. */
export type JudgeIdentityClient = Pick<PrismaClient, 'judgeModel' | 'judgeModelVersion' | 'modelEndpoint'>;

export interface JudgeIdentity {
  versionId: string;
  endpointId: string;
}

interface ProviderClassification {
  judgeClass: JudgeClass;
  servingBackend: ServingBackend;
  endpointClass: string | null;
}

/** Verbatim mirror of scripts/importer/judges.ts's classifyProvider — see
 * this module's doc for why the duplication is intentional/disclosed.
 * `servingBackend` resolution itself is delegated to `registry.ts`'s
 * `legacyProviderToBackend` (Task 10) — the ONE place the legacy
 * `ModelConfig.provider` string -> `ServingBackend` mapping lives now,
 * instead of a third independent copy of it here. */
function classifyProvider(provider: string): ProviderClassification {
  const servingBackend = legacyProviderToBackend(provider);
  switch (provider) {
    case 'anthropic':
      return { judgeClass: 'prompted_api', servingBackend, endpointClass: null };
    case 'openai':
      return { judgeClass: 'prompted_api', servingBackend, endpointClass: null };
    case 'local':
      return {
        judgeClass: 'prompted_open_weight',
        servingBackend,
        endpointClass: 'v1-local-unknown',
      };
    default:
      // Unreachable in practice — `legacyProviderToBackend` above already
      // throws for anything outside {anthropic, openai, local}, so this
      // never executes. Kept only because TS can't infer that guarantee
      // from a function call (removing it would require restructuring
      // this switch to satisfy exhaustiveness some other way).
      throw new Error(`ensureJudgeIdentityForModelConfig: unrecognized ModelConfig.provider "${provider}"`);
  }
}

/** lowercase; run of non-alphanumeric chars -> single '-'; trim leading/trailing '-'.
 * Mirrors scripts/importer/judges.ts's slugify. */
function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Deterministic identity slug for the (provider, modelId, endpoint) triple
 * — see module doc §3 for why this differs from the importer's batch-order
 * `uniqueSlug()`. */
function judgeIdentitySlug(provider: string, modelId: string, endpoint: string | null): string {
  const base = slugify(`${provider}-${modelId}`);
  if (!endpoint) return base;
  const endpointTag = createHash('sha1').update(endpoint).digest('hex').slice(0, 8);
  return `${base}-${endpointTag}`;
}

async function findOrCreateJudgeModel(
  client: JudgeIdentityClient,
  args: { slug: string; name: string; judgeClass: JudgeClass; baseModel: string }
): Promise<string> {
  const existing = await client.judgeModel.findUnique({ where: { slug: args.slug } });
  if (existing) return existing.id;

  try {
    const created = await client.judgeModel.create({
      data: {
        slug: args.slug,
        name: args.name,
        judgeClass: args.judgeClass,
        scoringMechanism: 'critique_generative',
        // Diverges from the importer — see module doc §1: this IS the
        // literal provider model id here, unlike the importer's v1 data.
        baseModel: args.baseModel,
      },
    });
    return created.id;
  } catch (error) {
    // Concurrent first-use race on `slug` (see module doc) — another
    // caller's create for the same triple won between our findUnique and
    // our create. Re-find once and return the winner's row rather than
    // surfacing the raw P2002 as a 500; this is a find-or-create, not a
    // create-or-fail, so losing the race is not an error condition here.
    if (isUniqueConstraintViolation(error)) {
      const winner = await client.judgeModel.findUnique({ where: { slug: args.slug } });
      if (winner) return winner.id;
    }
    throw error;
  }
}

async function findOrCreateVersion(
  client: JudgeIdentityClient,
  args: { judgeModelId: string; servingBackend: ServingBackend; endpointClass: string | null }
): Promise<string> {
  const existing = await client.judgeModelVersion.findUnique({
    where: { judgeModelId_ordinal: { judgeModelId: args.judgeModelId, ordinal: 1 } },
  });
  if (existing) return existing.id;

  try {
    const created = await client.judgeModelVersion.create({
      data: {
        judgeModelId: args.judgeModelId,
        ordinal: 1,
        quantization: 'none',
        servingBackend: args.servingBackend,
        endpointClass: args.endpointClass,
        protocolSupport: { pointwise: ['score'] },
        // Same literal defaults as the importer — both v1 call sites
        // (src/lib/llm/anthropic.ts, src/lib/llm/openai-compatible.ts) use
        // this exact { temperature, max_tokens } pair.
        samplingDefaults: { temperature: 0.3, max_tokens: 4096 },
      },
    });
    return created.id;
  } catch (error) {
    // Concurrent first-use race on `(judgeModelId, ordinal)` (see module
    // doc) — same re-find-once treatment as findOrCreateJudgeModel above.
    if (isUniqueConstraintViolation(error)) {
      const winner = await client.judgeModelVersion.findUnique({
        where: { judgeModelId_ordinal: { judgeModelId: args.judgeModelId, ordinal: 1 } },
      });
      if (winner) return winner.id;
    }
    throw error;
  }
}

async function findOrCreateEndpoint(
  client: JudgeIdentityClient,
  args: { userId: string; judgeModelVersionId: string; endpoint: string | null; isActive: boolean; apiKeyEnc: string | null }
): Promise<string> {
  // No compound unique constraint on ModelEndpoint (same as the importer's
  // note) — findFirst + conditional create, safe here since a single
  // ensureJudgeIdentityForModelConfig call is one sequential await chain.
  const existing = await client.modelEndpoint.findFirst({
    where: { userId: args.userId, judgeModelVersionId: args.judgeModelVersionId, endpoint: args.endpoint },
  });
  if (existing) return existing.id;

  const created = await client.modelEndpoint.create({
    data: {
      userId: args.userId,
      judgeModelVersionId: args.judgeModelVersionId,
      endpoint: args.endpoint,
      isActive: args.isActive,
      // Diverges from the importer — see module doc §2: this IS a live
      // credential (already encrypted), not a v1-import boundary.
      apiKeyEnc: args.apiKeyEnc,
      verifiedAt: null,
    },
  });
  return created.id;
}

/**
 * Find-or-create the `JudgeModel` + `JudgeModelVersion` + `ModelEndpoint`
 * identity for a live `ModelConfig` row, returning the ids the queue write
 * path (`src/lib/run-launch.ts`) needs. See module doc for the full
 * rationale, divergences from the importer, and idempotency contract.
 */
export async function ensureJudgeIdentityForModelConfig(
  client: JudgeIdentityClient,
  modelConfig: ModelConfig
): Promise<JudgeIdentity> {
  const { judgeClass, servingBackend, endpointClass } = classifyProvider(modelConfig.provider);
  const slug = judgeIdentitySlug(modelConfig.provider, modelConfig.modelId, modelConfig.endpoint);

  const judgeModelId = await findOrCreateJudgeModel(client, {
    slug,
    name: `${modelConfig.provider} ${modelConfig.modelId}`,
    judgeClass,
    baseModel: modelConfig.modelId,
  });

  const versionId = await findOrCreateVersion(client, {
    judgeModelId,
    servingBackend,
    endpointClass,
  });

  const endpointId = await findOrCreateEndpoint(client, {
    userId: modelConfig.userId,
    judgeModelVersionId: versionId,
    endpoint: modelConfig.endpoint,
    isActive: modelConfig.isActive,
    apiKeyEnc: modelConfig.apiKey,
  });

  return { versionId, endpointId };
}
