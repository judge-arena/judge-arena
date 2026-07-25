/**
 * Importer phase — run + judgment mappers (EvaluationRun, ModelJudgment,
 * HumanJudgment).
 *
 * Consumes the `IdMaps` produced by ./artifacts.ts and the judge-synthesis
 * map produced by ./judges.ts. Writes nothing keyed by an evaluation that
 * isn't in `ids.evaluation` — that evaluation was dropped (privately owned,
 * or its project was dropped) and every run/judgment under it drops with
 * it, mirroring the live schema's required-FK + Cascade relations
 * (EvaluationRun.evaluationId, ModelJudgment.runId, HumanJudgment.runId).
 *
 * ── modelConfigId: the "ensure" resolution ──────────────────────────────
 * `ModelJudgment.modelConfigId` is REQUIRED on the v2 schema (not nullable
 * — `onDelete` was tightened `Cascade` -> `Restrict` in Task 4, but the
 * column itself stays required until 1b retires ModelConfig entirely) and
 * `HumanJudgment.selectedBestModelId` references the same table. v1
 * ModelConfig rows are NOT imported as ModelConfig in v2 — Task 8's
 * `synthesizeJudges` replaces them with JudgeModel/JudgeModelVersion — so
 * there is no v2 ModelConfig row to point `modelConfigId` at unless one is
 * created here.
 *
 * `ensureModelConfig` creates a MINIMAL v2 ModelConfig per distinct v1
 * ModelConfig actually referenced by a surviving ModelJudgment or
 * HumanJudgment.selectedBestModelId — mirroring `name`/`provider`/`modelId`
 * /`endpoint`/`isActive` from the v1 row, never `apiKey` (secrets are never
 * carried across the import, matching ./judges.ts's ModelEndpoint
 * treatment). Owner: the v1 ModelConfig's own `userId` through `owners`
 * when mapped; archive otherwise ("archive for public-referenced" — this
 * config is only being materialized because something we chose to KEEP
 * references it, so an unmapped owner falls back to archive rather than
 * blocking the import). `slug` is deliberately left `null` on every
 * ensured row: ModelConfig has `@@unique([userId, slug])`, and multiple
 * distinct v1 owners can collapse onto the SAME v2 user (every dropped
 * owner maps to the one shared archive user) — carrying v1 slugs across
 * verbatim risks exactly that collision. These rows exist solely to
 * satisfy a not-yet-retired required FK, not as a first-class import
 * target, so dropping `slug` (never read anywhere in judgment display) is
 * the simplest safe choice.
 *
 * Idempotency: no unique constraint identifies "the ModelConfig mirroring
 * v1 config X" by content alone, so `ensureModelConfig` content-matches on
 * `(userId, provider, modelId, endpoint)` — the same triple ./judges.ts
 * groups ModelConfigs by for judge synthesis. A within-call `Map<v1 id, v2
 * id>` cache means N judgments referencing the same v1 config only look
 * this up once per `importRuns` call.
 *
 * ── Idempotency keys (documented per the task's "no schema changes"
 *    constraint) ────────────────────────────────────────────────────────
 *   - EvaluationRun:  no unique constraint -> content match on
 *     `(evaluationId, createdAt)` (createdAt is preserved verbatim from
 *     v1, see below, so it's a stable disambiguator across re-runs).
 *   - ModelJudgment:  the live `@@unique([runId, judgeModelVersionId,
 *     pairOrder])` CANNOT be relied on for idempotency here — every
 *     v1-imported judgment has `pairOrder: null`, and Postgres unique
 *     indexes treat NULL as distinct from NULL, so the DB would happily
 *     insert duplicates AND a naive single-row `findFirst` on `(runId,
 *     judgeModelVersionId, pairOrder: null)` would falsely collapse two
 *     genuinely distinct judgments onto each other (see below). Matched
 *     instead via MULTISET content-matching, scoped per `(runId,
 *     judgeModelVersionId)`:
 *       1. All of a run's v1 ModelJudgments are processed in deterministic
 *          v1-id order (sorted once when `judgmentsByRun` is built).
 *       2. For each distinct `(v2RunId, judgeModelVersionId)` pair actually
 *          needed, ALL existing v2 ModelJudgment rows for that pair are
 *          loaded ONCE into a mutable "pool" (`makeJudgmentPoolLoader`),
 *          cached for the rest of this `importRuns` call.
 *       3. Each incoming v1 judgment is matched against the REMAINING pool
 *          entries by exact `(createdAt.getTime(), overallScore,
 *          latencyMs)` — all three fields are carried straight across from
 *          v1 with no transformation, so an existing v2 row with an
 *          identical triple is, for idempotency purposes, "the same
 *          judgment" a prior apply already created. On a match, that pool
 *          row is CONSUMED (spliced out, so it can't match a second
 *          incoming judgment) and tallied `skipped`; no match creates a
 *          new row and tallies `created`.
 *     Why this matters: two distinct v1 ModelConfigs (even across
 *     different owners, or the same owner) that share `(provider, modelId,
 *     endpoint)` synthesize to the SAME JudgeModelVersion (see
 *     ./judges.ts). If both are referenced by judgments on ONE run, the
 *     old single-row `findFirst` would treat the second judgment as
 *     already-imported and silently drop it on the FIRST apply. The
 *     multiset match instead creates BOTH rows on first apply (the pool is
 *     empty, so neither judgment matches anything) and, on every
 *     subsequent re-run, each incoming judgment matches exactly one of the
 *     two now-existing rows by its own distinct `(createdAt, overallScore,
 *     latencyMs)` — stable, not collapsing, and the DB's NULLS-DISTINCT
 *     `pairOrder` uniqueness never rejects the second insert (no P2002).
 *     Residual limitation (not fully closed, and out of scope beyond what
 *     the two-judgment collision case above requires): if two DISTINCT v1
 *     judgments in the same `(runId, judgeModelVersionId)` pool happen to
 *     share an IDENTICAL `(createdAt, overallScore, latencyMs)` triple,
 *     only one pool row exists to match both, so a re-run would still
 *     create a duplicate for the second — the same content-match-collision
 *     class documented for Rubric/Project/Dataset in ./artifacts.ts.
 *   - HumanJudgment:  real `@@unique` on `runId` — `findUnique` is exact.
 *
 * ── criteriaScores ───────────────────────────────────────────────────────
 * v1 stores this as a JSON STRING (`String?`); v2's column is `Json?`.
 * `remapCriteriaScores` parses the string, then rewrites every entry's
 * `criterionId` through `ids.criterion`. An entry whose v1 `criterionId`
 * has no v2 counterpart (the owning rubric/criterion was itself dropped,
 * or the score references a criterion that no longer exists) is NEVER
 * dropped silently: it's kept with `criterionId: null` and a
 * `_unmappedV1CriterionId` field preserving the original value, and
 * tallied under `<Entity>CriteriaUnmapped`/`skipped` (the ModelJudgment
 * bucket name — `ModelJudgmentCriteriaUnmapped` — is the task brief's
 * literal report key; `HumanJudgmentCriteriaUnmapped` mirrors it for
 * HumanJudgment, which the brief doesn't name explicitly but calls for
 * "same parse+remap treatment").
 *
 * A malformed PAYLOAD (as opposed to a malformed individual entry, handled
 * above) is a separate failure mode: v1 `criteriaScores` that isn't valid
 * JSON at all, or that parses to something other than a JSON array, can't
 * be remapped entry-by-entry — the whole value is unusable. Both cases
 * still create the judgment row (with `criteriaScores` degraded to `[]` or
 * `DbNull` respectively, never throwing the whole import over one bad
 * row), but neither is silent: each is tallied under
 * `<Entity>CriteriaScoresMalformed`/`dropped` (e.g.
 * `ModelJudgmentCriteriaScoresMalformed`) AND logged via `console.warn`
 * with the v1 row's id, so a reconciliation pass can find exactly which
 * v1 judgments/human judgments lost their scores instead of only seeing an
 * aggregate count.
 *
 * ── Stranded runs ────────────────────────────────────────────────────────
 * A v1 EvaluationRun whose `status` is still `pending`/`judging` and whose
 * `updatedAt` is more than 24h before import time never reached a terminal
 * state in v1 and never will (nothing is still processing it) — imported
 * as `status: 'error'`, now terminal so `finalizedAt: updatedAt` applies to
 * it too. Individual ModelJudgments under a stranded run are only
 * force-terminalized (`status: 'error', error: 'v1-import: stranded'`) if
 * THEY are still `pending`/`running` — a judgment that already finished
 * before its sibling got the run stuck keeps its own real status/error
 * untouched.
 *
 * ── Fields with no v1 source ─────────────────────────────────────────────
 * `protocol` is always `'pointwise'` (v1 predates pairwise/listwise).
 * `promptTemplateId` is always the seeded `v1-legacy` v0 PromptTemplate,
 * looked up once — if it's missing, the target v2 database was never
 * seeded (see prisma/seed-prompt-templates.ts) and importing would produce
 * judgments with no provenance, so this throws immediately with a clear
 * message rather than silently proceeding. `samplingParams` is always the
 * literal `{ temperature: 0.3, max_tokens: 4096, source: 'v1-defaults' }`
 * (the actual v1 call-site defaults, see ./judges.ts's module doc) — no
 * stuffing/workaround is needed for `tokenCount`: v2's ModelJudgment KEPT
 * its own `tokenCount Int?` column verbatim (Task 4 only ADDED
 * `inputTokens`/`outputTokens` alongside it, it did not replace it), so
 * v1's combined count is carried straight across; `inputTokens`/
 * `outputTokens` are left `null` (v1 never split them out).
 * `reasoningEnabled`/`pairOrder`/`deadlineAt`/`startedAt`/`servedModelId`/
 * `finishReason`/`parseMode` have no v1 source and are left `null`.
 *
 * ── Timestamps ───────────────────────────────────────────────────────────
 * EvaluationRun and HumanJudgment both have v1 `createdAt` AND `updatedAt`
 * — both preserved explicitly. v1 ModelJudgment has ONLY `createdAt` (no
 * `updatedAt` column existed in v1); v2's `updatedAt` is set equal to that
 * same `createdAt` as the best available proxy, rather than defaulting to
 * import wall-clock time (which would misrepresent when the row last
 * actually changed).
 */
import { Prisma } from '@prisma/client';
import type { JudgmentStatus, RunStatus, ModelJudgment as V2ModelJudgment } from '@prisma/client';
import type {
  EvaluationRun as V1EvaluationRun,
  ModelJudgment as V1ModelJudgment,
  HumanJudgment as V1HumanJudgment,
  ModelConfig as V1ModelConfig,
} from '@prisma/v1-client';
import type { ImportCtx } from './context';
import type { IdMaps } from './artifacts';
import { resolveArchiveUser } from './owners';

type JudgeMap = Map<string, { versionId: string; endpointIdByUser: Map<string, string> }>;

const STRANDED_STATUSES: ReadonlySet<string> = new Set(['pending', 'judging']);
const STRANDED_CUTOFF_MS = 24 * 60 * 60 * 1000;
const RUN_STATUSES: readonly RunStatus[] = ['pending', 'judging', 'needs_human', 'completed', 'error'];
const JUDGMENT_STATUSES: readonly JudgmentStatus[] = ['pending', 'running', 'completed', 'error'];

function reportPlaceholderId(entity: string, key: string): string {
  return `report:${entity}:${key}`;
}

function castStatus<T extends string>(value: string, allowed: readonly T[], label: string): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`importRuns: unrecognized v1 ${label} status "${value}"`);
  }
  return value as T;
}

/** True when a v1 run is stuck in a non-terminal status well past any
 * plausible in-flight processing window. */
function isStranded(run: V1EvaluationRun, now: Date): boolean {
  return STRANDED_STATUSES.has(run.status) && now.getTime() - run.updatedAt.getTime() > STRANDED_CUTOFF_MS;
}

/** Parses a v1 criteriaScores JSON string and remaps every entry's
 * criterionId through `criterionIds`. Never drops an entry: an unmapped
 * criterionId is kept with `criterionId: null` and `_unmappedV1CriterionId`
 * set to the original value, tallied under `${entity}CriteriaUnmapped`. A
 * malformed payload (invalid JSON, or JSON that isn't an array) can't be
 * remapped entry-by-entry at all — tallied under
 * `${entity}CriteriaScoresMalformed`/`dropped` and logged with `v1Id` so a
 * reconciliation pass can find the exact row, never silently swallowed. */
function remapCriteriaScores(
  raw: string | null,
  criterionIds: Map<string, string>,
  ctx: ImportCtx,
  entity: 'ModelJudgment' | 'HumanJudgment',
  v1Id: string
): Prisma.InputJsonValue | typeof Prisma.DbNull {
  if (raw == null) return Prisma.DbNull;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Malformed v1 JSON: preserve nothing to remap against, but never
    // throw the whole import over one bad row — surface it as an empty
    // array rather than fabricating scores.
    ctx.report.add(`${entity}CriteriaScoresMalformed`, 'dropped');
    console.warn(`importRuns: malformed criteriaScores JSON on v1 ${entity} ${v1Id} — dropping to []`);
    return [];
  }
  if (!Array.isArray(parsed)) {
    ctx.report.add(`${entity}CriteriaScoresMalformed`, 'dropped');
    console.warn(
      `importRuns: v1 ${entity} ${v1Id} criteriaScores parsed to a non-array (${typeof parsed}) — dropping to null`
    );
    return Prisma.DbNull;
  }

  return parsed.map((entry) => {
    if (!entry || typeof entry !== 'object' || !('criterionId' in entry)) return entry;
    const record = entry as Record<string, unknown>;
    const v1CriterionId = record.criterionId;
    const v2CriterionId = typeof v1CriterionId === 'string' ? criterionIds.get(v1CriterionId) : undefined;
    if (v2CriterionId) {
      return { ...record, criterionId: v2CriterionId };
    }
    ctx.report.add(`${entity}CriteriaUnmapped`, 'skipped');
    return { ...record, criterionId: null, _unmappedV1CriterionId: v1CriterionId };
  });
}

// ─── ModelConfig ensure (FK-satisfaction shadow rows) ───────────────────────

function makeModelConfigEnsurer(
  ctx: ImportCtx,
  owners: Map<string, string>,
  getArchiveUserId: () => Promise<string>
) {
  const cache = new Map<string, string>();
  const v1ConfigById = new Map<string, V1ModelConfig>();

  return async function ensureModelConfig(v1ConfigId: string): Promise<string> {
    const cached = cache.get(v1ConfigId);
    if (cached) return cached;

    let v1Config = v1ConfigById.get(v1ConfigId);
    if (!v1Config) {
      const found = await ctx.v1.modelConfig.findUnique({ where: { id: v1ConfigId } });
      if (!found) {
        throw new Error(`importRuns: v1 ModelConfig ${v1ConfigId} referenced by a judgment no longer exists`);
      }
      v1Config = found;
      v1ConfigById.set(v1ConfigId, v1Config);
    }

    const v2UserId = owners.get(v1Config.userId) ?? (await getArchiveUserId());

    const existing = await ctx.v2.modelConfig.findFirst({
      where: {
        userId: v2UserId,
        provider: v1Config.provider,
        modelId: v1Config.modelId,
        endpoint: v1Config.endpoint,
      },
    });
    if (existing) {
      ctx.report.add('ModelConfig', 'skipped');
      cache.set(v1ConfigId, existing.id);
      return existing.id;
    }

    ctx.report.add('ModelConfig', 'created');
    if (ctx.mode !== 'apply') {
      const placeholder = reportPlaceholderId(
        'ModelConfig',
        `${v2UserId}:${v1Config.provider}:${v1Config.modelId}:${v1Config.endpoint ?? ''}`
      );
      cache.set(v1ConfigId, placeholder);
      return placeholder;
    }

    const created = await ctx.v2.modelConfig.create({
      data: {
        name: v1Config.name,
        slug: null,
        provider: v1Config.provider,
        modelId: v1Config.modelId,
        endpoint: v1Config.endpoint,
        apiKey: null,
        isActive: v1Config.isActive,
        isVerified: false,
        verifiedAt: null,
        verificationError: null,
        userId: v2UserId,
        createdAt: v1Config.createdAt,
        updatedAt: v1Config.updatedAt,
      },
    });
    cache.set(v1ConfigId, created.id);
    return created.id;
  };
}

// ─── EvaluationRun ──────────────────────────────────────────────────────────

async function findOrCreateRun(
  ctx: ImportCtx,
  v1: V1EvaluationRun,
  v2EvaluationId: string,
  v2RubricId: string | null,
  v2TriggeredById: string | null,
  stranded: boolean
): Promise<string> {
  const existing = await ctx.v2.evaluationRun.findFirst({
    where: { evaluationId: v2EvaluationId, createdAt: v1.createdAt },
  });
  if (existing) {
    ctx.report.add('EvaluationRun', 'skipped');
    return existing.id;
  }

  ctx.report.add('EvaluationRun', 'created');
  if (ctx.mode !== 'apply') {
    return reportPlaceholderId('EvaluationRun', `${v2EvaluationId}:${v1.createdAt.toISOString()}`);
  }

  const status: RunStatus = stranded ? 'error' : castStatus(v1.status, RUN_STATUSES, 'EvaluationRun');
  const terminal = status === 'completed' || status === 'error';

  const created = await ctx.v2.evaluationRun.create({
    data: {
      evaluationId: v2EvaluationId,
      rubricId: v2RubricId,
      protocol: 'pointwise',
      status,
      deadlineAt: null,
      finalizedAt: terminal ? v1.updatedAt : null,
      triggeredById: v2TriggeredById,
      createdAt: v1.createdAt,
      updatedAt: v1.updatedAt,
    },
  });
  return created.id;
}

// ─── ModelJudgment ──────────────────────────────────────────────────────────

/** Loads (once per distinct `(runId, judgeModelVersionId)` pair, per
 * `importRuns` call) the full set of existing v2 ModelJudgment rows for
 * that pair into a mutable "pool" array that `consumeMatchingJudgment`
 * splices entries out of as they're matched — see the module doc's
 * ModelJudgment idempotency section for why a per-pair multiset, not a
 * single `findFirst`, is required here. */
function makeJudgmentPoolLoader(ctx: ImportCtx) {
  const cache = new Map<string, V2ModelJudgment[]>();

  return async function loadJudgmentPool(runId: string, judgeModelVersionId: string): Promise<V2ModelJudgment[]> {
    const key = `${runId}:${judgeModelVersionId}`;
    let pool = cache.get(key);
    if (!pool) {
      pool = await ctx.v2.modelJudgment.findMany({ where: { runId, judgeModelVersionId } });
      cache.set(key, pool);
    }
    return pool;
  };
}

/** Finds the first `pool` entry whose `(createdAt, overallScore,
 * latencyMs)` exactly matches `v1` and, if found, CONSUMES it (splices it
 * out of `pool` so it can't match a second incoming judgment) and returns
 * true. All three fields are carried straight across from v1 with no
 * transformation, so an identical triple on an existing v2 row is, for
 * idempotency purposes, "the same judgment" a prior apply already
 * created. */
function consumeMatchingJudgment(pool: V2ModelJudgment[], v1: V1ModelJudgment): boolean {
  const idx = pool.findIndex(
    (row) =>
      row.createdAt.getTime() === v1.createdAt.getTime() &&
      row.overallScore === v1.overallScore &&
      row.latencyMs === v1.latencyMs
  );
  if (idx === -1) return false;
  pool.splice(idx, 1);
  return true;
}

async function findOrCreateModelJudgment(
  ctx: ImportCtx,
  v1: V1ModelJudgment,
  v2RunId: string,
  judgeModelVersionId: string,
  promptTemplateId: string,
  v2ModelConfigId: string,
  criterionIds: Map<string, string>,
  runIsStranded: boolean,
  pool: V2ModelJudgment[]
): Promise<void> {
  if (consumeMatchingJudgment(pool, v1)) {
    ctx.report.add('ModelJudgment', 'skipped');
    return;
  }

  ctx.report.add('ModelJudgment', 'created');
  if (ctx.mode !== 'apply') return;

  const stuck = runIsStranded && (v1.status === 'pending' || v1.status === 'running');
  const status: JudgmentStatus = stuck ? 'error' : castStatus(v1.status, JUDGMENT_STATUSES, 'ModelJudgment');
  const error = stuck ? 'v1-import: stranded' : v1.error;

  await ctx.v2.modelJudgment.create({
    data: {
      runId: v2RunId,
      modelConfigId: v2ModelConfigId,
      judgeModelVersionId,
      promptTemplateId,
      samplingParams: { temperature: 0.3, max_tokens: 4096, source: 'v1-defaults' },
      reasoningEnabled: null,
      pairOrder: null,
      overallScore: v1.overallScore,
      reasoning: v1.reasoning,
      rawResponse: v1.rawResponse,
      criteriaScores: remapCriteriaScores(v1.criteriaScores, criterionIds, ctx, 'ModelJudgment', v1.id),
      latencyMs: v1.latencyMs,
      tokenCount: v1.tokenCount,
      inputTokens: null,
      outputTokens: null,
      servedModelId: null,
      finishReason: null,
      parseMode: null,
      status,
      error,
      startedAt: null,
      createdAt: v1.createdAt,
      updatedAt: v1.createdAt, // v1 ModelJudgment has no updatedAt of its own.
    },
  });
}

// ─── HumanJudgment ──────────────────────────────────────────────────────────

async function findOrCreateHumanJudgment(
  ctx: ImportCtx,
  v1: V1HumanJudgment,
  v2RunId: string,
  v2UserId: string,
  v2SelectedBestModelId: string | null,
  criterionIds: Map<string, string>
): Promise<void> {
  const existing = await ctx.v2.humanJudgment.findUnique({ where: { runId: v2RunId } });
  if (existing) {
    ctx.report.add('HumanJudgment', 'skipped');
    return;
  }

  ctx.report.add('HumanJudgment', 'created');
  if (ctx.mode !== 'apply') return;

  await ctx.v2.humanJudgment.create({
    data: {
      runId: v2RunId,
      overallScore: v1.overallScore,
      reasoning: v1.reasoning,
      criteriaScores: remapCriteriaScores(v1.criteriaScores, criterionIds, ctx, 'HumanJudgment', v1.id),
      selectedBestModelId: v2SelectedBestModelId,
      userId: v2UserId,
      createdAt: v1.createdAt,
      updatedAt: v1.updatedAt,
    },
  });
}

// ─── Entry point ────────────────────────────────────────────────────────────

export async function importRuns(
  ctx: ImportCtx,
  owners: Map<string, string>,
  ids: IdMaps,
  judges: JudgeMap
): Promise<void> {
  const legacyTemplate = await ctx.v2.promptTemplate.findUnique({
    where: { name_version: { name: 'v1-legacy', version: 0 } },
  });
  if (!legacyTemplate) {
    throw new Error(
      "importRuns: seeded PromptTemplate 'v1-legacy' v0 not found in the target v2 database — " +
        'run prisma/seed-prompt-templates.ts (or the full seed) before importing.'
    );
  }

  let archiveUserId: string | undefined;
  const getArchiveUserId = async (): Promise<string> => {
    if (!archiveUserId) archiveUserId = await resolveArchiveUser(ctx);
    return archiveUserId;
  };
  const ensureModelConfig = makeModelConfigEnsurer(ctx, owners, getArchiveUserId);
  const loadJudgmentPool = makeJudgmentPoolLoader(ctx);

  const now = new Date();

  const [runs, judgmentsByRun, humanJudgmentsByRun] = await Promise.all([
    ctx.v1.evaluationRun.findMany(),
    ctx.v1.modelJudgment.findMany().then((rows) => {
      const byRun = new Map<string, V1ModelJudgment[]>();
      for (const row of rows) {
        const list = byRun.get(row.runId) ?? [];
        list.push(row);
        byRun.set(row.runId, list);
      }
      // Deterministic per-run processing order (v1 id) so the multiset
      // ModelJudgment match below consumes pool entries consistently
      // across repeated runs against the same v1 data.
      for (const list of byRun.values()) {
        list.sort((a, b) => a.id.localeCompare(b.id));
      }
      return byRun;
    }),
    ctx.v1.humanJudgment.findMany().then((rows) => new Map(rows.map((row) => [row.runId, row]))),
  ]);

  for (const run of runs) {
    // Required, Cascade-backed FK: an evaluation not in `ids.evaluation`
    // was dropped (privately owned, or its project was dropped), and every
    // run/judgment under it drops with it.
    const v2EvaluationId = ids.evaluation.get(run.evaluationId);
    if (!v2EvaluationId) {
      ctx.report.add('EvaluationRun', 'dropped');
      const judgments = judgmentsByRun.get(run.id) ?? [];
      if (judgments.length > 0) ctx.report.add('ModelJudgment', 'dropped', judgments.length);
      if (humanJudgmentsByRun.has(run.id)) ctx.report.add('HumanJudgment', 'dropped');
      continue;
    }

    const v2RubricId = run.rubricId ? (ids.rubric.get(run.rubricId) ?? null) : null;
    // Nullable, SetNull-backed FK on the live schema: an unmapped triggering
    // user degrades to `null` rather than dropping the (surviving) run.
    const v2TriggeredById = owners.get(run.triggeredById) ?? null;

    const runIsStranded = isStranded(run, now);
    const v2RunId = await findOrCreateRun(ctx, run, v2EvaluationId, v2RubricId, v2TriggeredById, runIsStranded);

    for (const judgment of judgmentsByRun.get(run.id) ?? []) {
      const judge = judges.get(judgment.modelConfigId);
      if (!judge) {
        throw new Error(
          `importRuns: no synthesized judge found for v1 ModelConfig ${judgment.modelConfigId} ` +
            '(was synthesizeJudges run before importRuns?)'
        );
      }
      const v2ModelConfigId = await ensureModelConfig(judgment.modelConfigId);
      const pool = await loadJudgmentPool(v2RunId, judge.versionId);
      await findOrCreateModelJudgment(
        ctx,
        judgment,
        v2RunId,
        judge.versionId,
        legacyTemplate.id,
        v2ModelConfigId,
        ids.criterion,
        runIsStranded,
        pool
      );
    }

    const humanJudgment = humanJudgmentsByRun.get(run.id);
    if (humanJudgment) {
      // Dropped author on a surviving run -> archive (never null: userId
      // is required on HumanJudgment, unlike EvaluationRun.triggeredById).
      const v2UserId = owners.get(humanJudgment.userId) ?? (await getArchiveUserId());
      const v2SelectedBestModelId = humanJudgment.selectedBestModelId
        ? await ensureModelConfig(humanJudgment.selectedBestModelId)
        : null;
      await findOrCreateHumanJudgment(
        ctx,
        humanJudgment,
        v2RunId,
        v2UserId,
        v2SelectedBestModelId,
        ids.criterion
      );
    }
  }
}
