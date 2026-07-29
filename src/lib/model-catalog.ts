/**
 * ─── Custom judge-model creation (catalog + endpoint) ──────────────────────
 *
 * Shared helper for every write path that needs to create a brand-new
 * `JudgeModel` (+ its ordinal-1 `JudgeModelVersion`) plus a `ModelEndpoint`
 * owned by a specific user, in one shot — as opposed to attaching an
 * endpoint to an EXISTING catalog version (`mode: 'catalog'` in `POST
 * /api/models`, which only creates a `ModelEndpoint` against an existing
 * `JudgeModelVersion.id` and never touches `JudgeModel`/`JudgeModelVersion`).
 *
 * Extracted out of `POST /api/models`'s `mode: 'custom'` branch (Task 12
 * review fix) so `POST /api/config/import` can create catalog entries for
 * imported models through the EXACT same path instead of writing to the
 * retired `ModelConfig` table — see that route's "Models" section for the
 * caller.
 *
 * `JudgeModel`/`JudgeModelVersion` are immutable once created anywhere in
 * this app (see `src/app/api/models/shared.ts`'s module doc) — this
 * function is the ONLY place either gets created outside a migration
 * script; no write path mutates an existing one.
 */
import type { JudgeClass, PrismaClient, ScoringMechanism, ServingBackend } from '@prisma/client';
import { generateSlug } from '@/lib/config';

/** The subset of `PrismaClient` this module needs — satisfied by the global
 * `prisma` singleton (both callers use it directly today; no caller needs
 * transactional wrapping, matching the rest of `POST /api/config/import`'s
 * own sequential, non-transactional create loops). */
export type JudgeModelCatalogClient = Pick<PrismaClient, 'judgeModel' | 'judgeModelVersion' | 'modelEndpoint'>;

/** Collision-suffix scheme shared by every custom-model creator: try `base`
 * verbatim, fall back to a short random suffix only on an actual collision
 * (global slug uniqueness — `JudgeModel.slug` is `@unique`, not scoped per
 * user). */
async function uniqueSlugFromBase(client: JudgeModelCatalogClient, base: string): Promise<string> {
  const existing = await client.judgeModel.findUnique({ where: { slug: base }, select: { id: true } });
  if (!existing) return base;
  return `${base}-${Date.now().toString(36).slice(-4)}`;
}

/** `uniqueSlugFromBase`, deriving `base` from `name` via `generateSlug` —
 * what `POST /api/models` (mode: 'custom') uses, since it has no other
 * slug input to work from. */
export async function uniqueJudgeModelSlug(client: JudgeModelCatalogClient, name: string): Promise<string> {
  return uniqueSlugFromBase(client, generateSlug(name));
}

export interface CreateCustomJudgeModelFields {
  name: string;
  /** Optional caller-supplied slug BASE (still run through the same
   * collision-suffix scheme as the name-derived default — never used
   * verbatim if already taken). `POST /api/models` (mode: 'custom') omits
   * this and gets `generateSlug(name)` as before. `POST /api/config/import`
   * passes the imported model's own `ConfigModel.slug` here — using that
   * instead of re-deriving from `name` is required for import idempotency:
   * config export emits the REAL `JudgeModel.slug` verbatim (not a
   * re-derivation of `name`), so a later re-import's existence check (which
   * matches on `ConfigModel.slug`) only finds this row again if the row's
   * actual slug is the one the config said, not whatever `generateSlug(name)`
   * would independently produce. */
  slug?: string;
  judgeClass: JudgeClass;
  scoringMechanism: ScoringMechanism;
  servingBackend: ServingBackend;
  baseModel: string;
  endpoint?: string | null;
  /** Already-encrypted (see `src/lib/crypto.ts`'s `encryptIfNeeded`) — this
   * module never handles a raw plaintext key, so callers that DO have a
   * plaintext key must encrypt it before calling in. */
  apiKeyEnc?: string | null;
  isActive: boolean;
  /** Passed straight through to `ModelEndpoint.verificationError`. `POST
   * /api/models` seeds this with `'Not tested yet'`; callers that don't
   * want a verification-error placeholder can omit it (defaults to `null`). */
  verificationError?: string | null;
}

export interface CreatedCustomJudgeModel {
  judgeModelId: string;
  judgeModelVersionId: string;
  modelEndpointId: string;
}

/**
 * Creates a brand-new `JudgeModel` (slug deduped from `fields.slug` if
 * given, else auto-derived from `name` — see `CreateCustomJudgeModelFields`)
 * + its ordinal-1 `JudgeModelVersion` + a `ModelEndpoint` owned by `userId`
 * — the one three-way write every "add a custom judge model" path performs.
 * Mirrors `POST /api/models`'s `mode: 'custom'` branch exactly (that route
 * now calls this too).
 */
export async function createCustomJudgeModel(
  client: JudgeModelCatalogClient,
  userId: string,
  fields: CreateCustomJudgeModelFields
): Promise<CreatedCustomJudgeModel> {
  const slug = fields.slug
    ? await uniqueSlugFromBase(client, fields.slug)
    : await uniqueJudgeModelSlug(client, fields.name);

  const judgeModel = await client.judgeModel.create({
    data: {
      name: fields.name,
      slug,
      judgeClass: fields.judgeClass,
      scoringMechanism: fields.scoringMechanism,
      baseModel: fields.baseModel,
    },
  });

  const version = await client.judgeModelVersion.create({
    data: {
      judgeModelId: judgeModel.id,
      ordinal: 1,
      servingBackend: fields.servingBackend,
      protocolSupport: { pointwise: ['score'] },
    },
  });

  const endpoint = await client.modelEndpoint.create({
    data: {
      userId,
      judgeModelVersionId: version.id,
      endpoint: fields.endpoint || null,
      apiKeyEnc: fields.apiKeyEnc || null,
      isActive: fields.isActive,
      verifiedAt: null,
      verificationError: fields.verificationError ?? null,
    },
  });

  return {
    judgeModelId: judgeModel.id,
    judgeModelVersionId: version.id,
    modelEndpointId: endpoint.id,
  };
}
