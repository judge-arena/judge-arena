import { getServerSession } from 'next-auth';
import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { createHash } from 'crypto';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/db';
import type { PermissionScope } from '@/lib/permissions';
import { getClientIp } from '@/lib/client-ip';
import { apiLimiter } from '@/lib/rate-limit-redis';
import { rateLimitHeaders, API_LIMIT } from '@/lib/rate-limit';

export interface AuthSession {
  user: {
    id: string;
    email: string;
    name: string | null;
    role: string; // "user" | "admin"
  };
  /** When authenticated via API key, contains the granted scopes */
  apiKeyScopes?: PermissionScope[];
  /** When authenticated via API key, the key ID for audit logging */
  apiKeyId?: string;
}

/** Hash a raw API key to match against stored keyHash */
function hashApiKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex');
}

/**
 * Try to authenticate via Bearer token (developer API key).
 * Returns AuthSession if valid, null if no bearer token present,
 * or a NextResponse (401/403) if the token is invalid/expired/inactive.
 */
async function authenticateApiKey(): Promise<AuthSession | NextResponse | null> {
  const headersList = await headers();
  const authHeader = headersList.get('authorization');

  if (!authHeader?.startsWith('Bearer vgk_')) {
    return null; // No API key present — fall through to session auth
  }

  const rawKey = authHeader.slice(7); // Remove "Bearer " prefix
  const keyHash = hashApiKey(rawKey);

  const apiKey = await prisma.developerApiKey.findUnique({
    where: { keyHash },
    include: {
      user: {
        select: { id: true, email: true, name: true, role: true },
      },
    },
  });

  if (!apiKey) {
    return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });
  }

  if (!apiKey.isActive) {
    return NextResponse.json({ error: 'API key is inactive' }, { status: 403 });
  }

  if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
    return NextResponse.json({ error: 'API key has expired' }, { status: 403 });
  }

  // Update lastUsedAt (fire-and-forget, don't block the request)
  prisma.developerApiKey
    .update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {}); // Silently ignore update failures

  const scopes: PermissionScope[] = JSON.parse(apiKey.scopes || '[]');

  return {
    user: {
      id: apiKey.user.id,
      email: apiKey.user.email,
      name: apiKey.user.name ?? null,
      role: apiKey.user.role ?? 'user',
    },
    apiKeyScopes: scopes,
    apiKeyId: apiKey.id,
  };
}

/**
 * Get the authenticated session or return a 401 response.
 * Supports both NextAuth session cookies AND developer API keys.
 *
 * Usage in API routes:
 *
 *   const session = await requireAuth();
 *   if (session instanceof NextResponse) return session;
 *   // session is AuthSession
 */
export async function requireAuth(): Promise<AuthSession | NextResponse> {
  // ── Shared API rate-limit chokepoint (120/min per IP, env-overridable) ──
  // Every authenticated route calls requireAuth(), so gating here covers
  // the whole authenticated API surface without per-route boilerplate.
  // Checked first, before any DB/auth work, so an abusive client doesn't
  // get free DB queries out of a request that's going to be rejected.
  const headersList = await headers();
  const clientIp = getClientIp(headersList);
  const rateResult = await apiLimiter.check(clientIp);
  if (!rateResult.ok) {
    return NextResponse.json(
      { error: 'Rate limit exceeded. Please slow down.' },
      { status: 429, headers: rateLimitHeaders(rateResult, API_LIMIT) }
    );
  }

  // 1. Try API key authentication first
  const apiKeyResult = await authenticateApiKey();
  if (apiKeyResult instanceof NextResponse) return apiKeyResult; // Error response
  if (apiKeyResult) return apiKeyResult; // Valid API key session

  // 2. Fall back to NextAuth session
  const session = await getServerSession(authOptions);
  if (!session?.user || !(session.user as any).id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Session -> User resolution is by the token's user-id claim ONLY (spec
  // §7 non-destructive-v5 condition (c)) — no email fallback. The old
  // fallback silently re-linked a session to whichever User row happened to
  // have a matching email when the id lookup missed, which is exactly the
  // "linking hazard" OIDC's (issuer, sub) identity model closes (see
  // src/lib/oidc-user.ts). A missing id-match now means the caller signs
  // out and back in — never a guess.
  const sessionUserId = (session.user as any).id as string;

  const resolvedUser = await prisma.user.findUnique({
    where: { id: sessionUserId },
    select: { id: true, email: true, name: true, role: true },
  });

  if (!resolvedUser) {
    return NextResponse.json(
      { error: 'User not found for current session. Please sign out and sign in again.' },
      { status: 401 }
    );
  }

  return {
    user: {
      id: resolvedUser.id,
      email: resolvedUser.email,
      name: resolvedUser.name ?? null,
      role: resolvedUser.role ?? 'user',
    },
    // No apiKeyScopes — session auth has full access (governed by role)
  };
}

/**
 * Check if the session has a required permission scope.
 * - Session-authenticated users (no API key): always allowed (permissions governed by role).
 * - API key users: must have the specific scope in their key's scope list.
 *
 * Returns null if authorized, or a 403 NextResponse if insufficient scope.
 *
 * Usage:
 *   const session = await requireAuth();
 *   if (session instanceof NextResponse) return session;
 *   const scopeCheck = requireScope(session, 'projects:read');
 *   if (scopeCheck) return scopeCheck;
 */
export function requireScope(
  session: AuthSession,
  scope: PermissionScope
): NextResponse | null {
  // Session-authenticated users have implicit full access
  if (!session.apiKeyScopes) return null;

  if (session.apiKeyScopes.includes(scope)) return null;

  return NextResponse.json(
    {
      error: 'Insufficient permissions',
      required_scope: scope,
      message: `This API key does not have the '${scope}' permission. Update the key's scopes to include it.`,
    },
    { status: 403 }
  );
}

/**
 * Convenience: require authentication AND a specific scope in one call.
 * Returns AuthSession on success, or an error NextResponse.
 */
export async function requireAuthWithScope(
  scope: PermissionScope
): Promise<AuthSession | NextResponse> {
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;

  const scopeCheck = requireScope(session, scope);
  if (scopeCheck) return scopeCheck;

  return session;
}

/** Check if the session user is an admin */
export function isAdmin(session: AuthSession): boolean {
  return session.user.role === 'admin';
}

/**
 * Resolve the current session WITHOUT requiring one — never throws, never
 * returns a NextResponse. Used by routes that serve both public
 * (`visibility: 'public'`) and gated content (spec §7 D3: public research
 * data defaults to open reads; see src/lib/serializers.ts + the access
 * matrix in tests/db/access-matrix.test.ts): `null` means "anonymous
 * caller", not an error condition the route needs to branch its error
 * handling on.
 *
 * Delegates to `requireAuth()` so anonymous callers on these routes still
 * benefit from its API-key resolution and shared rate-limit chokepoint —
 * with one deliberate tradeoff: EVERY failure mode of `requireAuth()`
 * (missing session, invalid/expired API key, and rate-limit-exceeded)
 * collapses to `null` here, not just "no credentials presented". A
 * request that's actually over the rate limit is therefore served as
 * anonymous rather than getting a 429 on these specific routes. That's an
 * accepted gap for this task (public-read routes were fully auth-gated,
 * and therefore already covered by requireAuth()'s 429, before Task 14 —
 * this only affects the newly-opened anonymous surface) — a caller
 * presenting a BAD key on a public-read route degrades to "read the public
 * view", it doesn't get blocked outright. Revisit if anonymous abuse of
 * public-read routes becomes a real problem.
 */
export async function optionalAuth(): Promise<AuthSession | null> {
  const result = await requireAuth();
  return result instanceof NextResponse ? null : result;
}

/**
 * Require an INTERACTIVE session — a signed-in cookie/OIDC session, never a
 * developer API key — even one holding every scope. Used by the API-key
 * lifecycle routes (POST/PATCH/DELETE, and GET for consistency, on
 * /api/api-keys[/[id]]) to close the privilege-escalation finding from the
 * T14 critique disposition table: those routes previously called bare
 * `requireAuth()` with no `requireScope()` check at all (there is no
 * `apikeys:*` scope in src/lib/permissions.ts), so ANY authenticated
 * caller — including one holding a narrowly-scoped API key like
 * `stats:read` only — could mint a brand-new key with every scope
 * attached to their own account, or revoke/edit the caller's other keys.
 * Requiring an interactive session here means a compromised or narrowly
 * scoped API key can never be used to mint, escalate, or manage keys.
 */
export async function requireInteractiveSession(): Promise<AuthSession | NextResponse> {
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;
  if (session.apiKeyScopes) {
    return NextResponse.json(
      {
        error:
          'API key management requires an interactive session (sign in via the web UI) — a developer API key cannot be used to create, update, or revoke API keys.',
      },
      { status: 403 }
    );
  }
  return session;
}

export type ResourceAccess = 'owner' | 'public';

/**
 * Decide how a GET on a resource that CAN be public (visibility: 'public'
 * rubrics/datasets/projects/golden-sets — spec §7 D3) should be served,
 * given the resource's OWN `ownerId`/`isPublic` (already loaded by the
 * caller — this never touches the DB itself):
 *
 *   - `{ access: 'owner' }`  — caller is the resource's owner or an admin:
 *     serve the FULL (private-shape) representation.
 *   - `{ access: 'public' }` — resource is public and the caller is
 *     anonymous OR authenticated-but-not-the-owner: serve the PII-stripped
 *     public representation (src/lib/serializers.ts). This check runs
 *     AFTER the owner/admin check above, so the actual owner (or an
 *     admin) always gets the full shape even on their own public
 *     resource.
 *   - `{ error }` — resource is private and inaccessible: 401 (no
 *     session — "log in and this might work") or 403 (authenticated,
 *     not the owner/admin — matches every pre-existing inline ownership
 *     check's "Forbidden" convention in this codebase).
 */
export function resolveResourceAccess(
  session: AuthSession | null,
  ownerId: string | null,
  isPublic: boolean
): { access: ResourceAccess } | { error: NextResponse } {
  const isOwnerOrAdmin =
    !!session && (session.user.id === ownerId || isAdmin(session));
  if (isOwnerOrAdmin) return { access: 'owner' };
  if (isPublic) return { access: 'public' };
  if (!session) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }
  return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
}

/** Models `requireOwnership` can check — every one keyed by `userId`
 * except `goldenSet`, which uses `ownerId` (see prisma/schema.prisma). */
const OWNERSHIP_MODELS = {
  project: { model: 'project', field: 'userId' },
  rubric: { model: 'rubric', field: 'userId' },
  dataset: { model: 'dataset', field: 'userId' },
  evaluation: { model: 'evaluation', field: 'userId' },
  modelEndpoint: { model: 'modelEndpoint', field: 'userId' },
  developerApiKey: { model: 'developerApiKey', field: 'userId' },
  goldenSet: { model: 'goldenSet', field: 'ownerId' },
} as const;

export type OwnableEntity = keyof typeof OWNERSHIP_MODELS;

/**
 * Load an entity by id and verify `session` owns it (or is an admin) —
 * the single DRY-up of the `findUnique` + `userId !== session.user.id &&
 * !isAdmin(session)` pattern repeated across every mutation route
 * (rubrics/datasets/projects/evaluations/models `[id]` PATCH/DELETE).
 * Every CREATE path sets `userId: session.user.id` directly (never a
 * client-supplied owner) — this helper is for the id-in-the-URL mutation
 * case, closing the "ownerless-create" IDOR shape by construction: there
 * is no code path here that lets a caller assert ownership of a row they
 * don't already own.
 *
 * Returns `null` when the caller may proceed, or a 404 (no such row) /
 * 403 (row exists, caller doesn't own it and isn't admin) NextResponse.
 */
export async function requireOwnership(
  entity: OwnableEntity,
  id: string,
  session: AuthSession
): Promise<NextResponse | null> {
  const { model, field } = OWNERSHIP_MODELS[entity];
  const delegate = (prisma as any)[model];
  const row = await delegate.findUnique({ where: { id }, select: { [field]: true } });

  if (!row) {
    return NextResponse.json({ error: `${entity} not found` }, { status: 404 });
  }
  const ownerId = row[field] as string | null;
  if (ownerId !== session.user.id && !isAdmin(session)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  return null;
}
