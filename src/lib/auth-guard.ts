import { getServerSession } from 'next-auth';
import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { createHash } from 'crypto';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { trackBackgroundWrite } from '@/lib/background-writes';
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

  // Update lastUsedAt (fire-and-forget, don't block the request).
  // Registered with the background-write registry so a shutdown or a test
  // truncate can wait for it rather than deadlock against it — this update
  // takes a row lock on DeveloperApiKey and an FK check on User, which is
  // exactly the cycle TRUNCATE ... CASCADE closes. Note the `.catch(() => {})`
  // below discards the error, so unlike audit() a deadlock here would leave
  // no trace at all; that is the reason it is tracked and not merely logged.
  trackBackgroundWrite(
    prisma.developerApiKey
      .update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } })
      .catch(() => {}) // Silently ignore update failures
  );

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
 * Resolve API-key or session identity — the credential-checking half of
 * `requireAuth()`, WITHOUT its IP-keyed rate-limit gate. Shared by:
 *
 *   - `requireAuth()`, which applies that gate FIRST (before any DB work),
 *     then delegates here.
 *   - `optionalAuth()`, which needs identity resolved FIRST so it can pick
 *     the RIGHT rate-limit key (the caller's own user id once a session
 *     resolves, vs. client IP when none does) — see that function's doc
 *     comment for why identity has to come before its limiter check.
 *
 * Returns an `AuthSession` on success, or a `NextResponse` (401/403) for
 * every "credentials present but invalid" case: bad/expired/inactive API
 * key, or a session cookie whose user id no longer resolves.
 */
async function resolveIdentity(): Promise<AuthSession | NextResponse> {
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

  return resolveIdentity();
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
 * Thrown by `optionalAuth()` when the resolved caller — anonymous, keyed
 * by client IP, or authenticated, keyed by their own user id — is over
 * the shared `apiLimiter` budget. Every `optionalAuth()` call site MUST
 * wrap the call (and, since `requireScope()` runs right after it off the
 * same session, that check too) in the route's existing try/catch and
 * check `error instanceof RateLimitedError` FIRST, returning
 * `error.response` — an uncaught throw here surfaces as Next.js's generic
 * 500 error page, not the 429 this class carries. See every GET handler
 * in rubrics/datasets/projects (list, `[id]`, `[id]/versions`,
 * `[id]/export`) for the pattern; tests/db/access-matrix.test.ts asserts
 * the 429 actually comes out the other end for both an anonymous and an
 * authenticated over-limit caller.
 */
export class RateLimitedError extends Error {
  constructor(public readonly response: NextResponse) {
    super('Rate limit exceeded');
    this.name = 'RateLimitedError';
  }
}

/**
 * Resolve the current session WITHOUT requiring one — never returns a
 * NextResponse; `null` means "anonymous caller", not an error condition
 * the route needs to branch its error handling on. Used by routes that
 * serve both public (`visibility: 'public'`) and gated content (spec §7
 * D3: public research data defaults to open reads; see
 * src/lib/serializers.ts + the access matrix in
 * tests/db/access-matrix.test.ts).
 *
 * Identity is resolved FIRST (via the same API-key/session logic
 * `requireAuth()` uses, factored out as `resolveIdentity()` — but WITHOUT
 * `requireAuth()`'s own IP-keyed rate gate, which would otherwise throttle
 * an authenticated caller by shared IP before we even know they're
 * authenticated). "No credentials" and "bad/expired/inactive credentials"
 * both still collapse to `null` here — an invalid API key on a
 * public-read route degrades to "read the public view", it doesn't get
 * blocked outright. That part of the original design is unchanged.
 *
 * What IS new: this function now applies its OWN `apiLimiter` check —
 * keyed by the caller's user id once a session resolves, or by client IP
 * when none does — and THROWS `RateLimitedError` (429, same body/header
 * shape `requireAuth()` uses) when that check fails, instead of folding
 * "over limit" into the same `null` bucket as "no/bad credentials". Before
 * this, EVERY failure mode of the old `requireAuth()`-delegating
 * implementation (including rate-limit-exceeded) collapsed to `null`, so
 * an over-limit client was served the anonymous public view — unlimited,
 * unthrottled — instead of a 429. Now rate-limiting is enforced for BOTH
 * anonymous and authenticated callers on every public-read route; only a
 * caller truly within budget (or presenting no/bad credentials, which
 * never bypasses the check) ever reaches the anonymous/public branch.
 */
export async function optionalAuth(): Promise<AuthSession | null> {
  const identity = await resolveIdentity();
  const session = identity instanceof NextResponse ? null : identity;

  const headersList = await headers();
  const rateKey = session ? `user:${session.user.id}` : getClientIp(headersList);
  const rateResult = await apiLimiter.check(rateKey);
  if (!rateResult.ok) {
    throw new RateLimitedError(
      NextResponse.json(
        { error: 'Rate limit exceeded. Please slow down.' },
        { status: 429, headers: rateLimitHeaders(rateResult, API_LIMIT) }
      )
    );
  }

  return session;
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
