/**
 * Importer phase — owner resolution.
 *
 * Resolves each v1 user id referenced in `ctx.ownerMap` to a v2 `User.id`,
 * per the OwnerMap policy (see scripts/importer/context.ts):
 *
 *   - a mapped entry (`{ email, oidcIssuer, oidcSubject }`): find-or-create
 *     a v2 User keyed on the `(oidcIssuer, oidcSubject)` unique pair.
 *     `email` is set from the map; `passwordHash` is the literal
 *     `'!imported-oidc-only'` — these accounts authenticate via OIDC only
 *     and never had (and never get) a local password.
 *   - `'archive'`: every v1 user mapped to `'archive'` resolves to the SAME
 *     shared system user, find-or-created by email
 *     `'archive@judgearena.local'` (name `'Archive'`, passwordHash
 *     `'!archive-system-user'`). Used downstream to anonymize public
 *     artifacts whose original owner shouldn't be attributed to a live
 *     account.
 *   - `'drop'`: the v1 user id is left out of the returned map entirely.
 *     Downstream import phases treat a missing key as "drop this user's
 *     private data / archive their public data" — which one is an
 *     entity-specific policy that lives in those phases, not here.
 *
 * Every v2 write is gated on `ctx.mode === 'apply'`. `report` mode still
 * performs the "find" half of find-or-create (so data that's already been
 * imported for real comes back with its real id and a `skipped` tally) but
 * returns a placeholder id — never persisted, valid only as a same-call map
 * key — when the row doesn't exist yet, tallying that outcome as `created`
 * (what an `apply` run WOULD do). Both mapped-user and archive-user
 * resolution are idempotent in `apply` mode: re-running against the same
 * v1 data finds the previously-created row instead of duplicating it.
 */
import type { ImportCtx, OwnerMap } from './context';

export const ARCHIVE_USER_EMAIL = 'archive@judgearena.local';

type MappedOwner = Extract<OwnerMap[string], { email: string }>;

/** Deterministic, never-persisted stand-in id for report-mode "would create". */
function reportPlaceholderId(key: string): string {
  return `report:User:${key}`;
}

async function resolveMappedUser(ctx: ImportCtx, mapping: MappedOwner): Promise<string> {
  const existing = await ctx.v2.user.findUnique({
    where: {
      oidcIssuer_oidcSubject: {
        oidcIssuer: mapping.oidcIssuer,
        oidcSubject: mapping.oidcSubject,
      },
    },
  });
  if (existing) {
    ctx.report.add('User', 'skipped');
    return existing.id;
  }

  ctx.report.add('User', 'created');
  if (ctx.mode !== 'apply') {
    return reportPlaceholderId(`${mapping.oidcIssuer}|${mapping.oidcSubject}`);
  }

  const created = await ctx.v2.user.create({
    data: {
      email: mapping.email,
      oidcIssuer: mapping.oidcIssuer,
      oidcSubject: mapping.oidcSubject,
      passwordHash: '!imported-oidc-only',
    },
  });
  return created.id;
}

/**
 * Find-or-creates the shared archive user (see module doc above). Exported
 * so later import phases (artifacts.ts, runs.ts) can attribute a public
 * artifact or an ensured-ModelConfig to the archive account without
 * duplicating this find-or-create logic — every caller converges on the
 * SAME row (by the `email` unique constraint), so calling this from
 * multiple phases within one importer run is safe and still creates at
 * most one archive User.
 */
export async function resolveArchiveUser(ctx: ImportCtx): Promise<string> {
  const existing = await ctx.v2.user.findUnique({ where: { email: ARCHIVE_USER_EMAIL } });
  if (existing) {
    ctx.report.add('User', 'skipped');
    return existing.id;
  }

  ctx.report.add('User', 'created');
  if (ctx.mode !== 'apply') {
    return reportPlaceholderId(ARCHIVE_USER_EMAIL);
  }

  const created = await ctx.v2.user.create({
    data: {
      email: ARCHIVE_USER_EMAIL,
      name: 'Archive',
      passwordHash: '!archive-system-user',
    },
  });
  return created.id;
}

export async function resolveOwners(ctx: ImportCtx): Promise<Map<string, string>> {
  const owners = new Map<string, string>();
  // Caches this call's resolutions so N v1 users mapped to 'archive' (or to
  // the same (issuer, subject) pair) resolve/create exactly once instead of
  // each re-running find-or-create from scratch.
  const resolvedByOidcKey = new Map<string, string>();
  let archiveUserId: string | undefined;

  for (const [v1UserId, mapping] of Object.entries(ctx.ownerMap)) {
    if (mapping === 'drop') {
      ctx.report.add('User', 'dropped');
      continue;
    }

    if (mapping === 'archive') {
      if (!archiveUserId) {
        archiveUserId = await resolveArchiveUser(ctx);
      }
      owners.set(v1UserId, archiveUserId);
      continue;
    }

    const cacheKey = `${mapping.oidcIssuer}|${mapping.oidcSubject}`;
    let v2UserId = resolvedByOidcKey.get(cacheKey);
    if (!v2UserId) {
      v2UserId = await resolveMappedUser(ctx, mapping);
      resolvedByOidcKey.set(cacheKey, v2UserId);
    }
    owners.set(v1UserId, v2UserId);
  }

  return owners;
}
