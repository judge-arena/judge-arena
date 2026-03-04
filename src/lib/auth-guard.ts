import { getServerSession } from 'next-auth';
import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { createHash } from 'crypto';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/db';
import type { PermissionScope } from '@/lib/permissions';

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
  // 1. Try API key authentication first
  const apiKeyResult = await authenticateApiKey();
  if (apiKeyResult instanceof NextResponse) return apiKeyResult; // Error response
  if (apiKeyResult) return apiKeyResult; // Valid API key session

  // 2. Fall back to NextAuth session
  const session = await getServerSession(authOptions);
  if (!session?.user || !(session.user as any).id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const sessionUserId = (session.user as any).id as string;
  const sessionEmail = session.user.email ?? null;

  const dbUserById = await prisma.user.findUnique({
    where: { id: sessionUserId },
    select: { id: true, email: true, name: true, role: true },
  });

  let resolvedUser = dbUserById;

  if (!resolvedUser && sessionEmail) {
    const dbUserByEmail = await prisma.user.findUnique({
      where: { email: sessionEmail },
      select: { id: true, email: true, name: true, role: true },
    });
    resolvedUser = dbUserByEmail;
  }

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
      role: resolvedUser.role ?? (session.user as any).role ?? 'user',
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
