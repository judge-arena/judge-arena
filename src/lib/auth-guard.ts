import { getServerSession } from 'next-auth';
import { NextResponse } from 'next/server';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/db';

export interface AuthSession {
  user: {
    id: string;
    email: string;
    name: string | null;
    role: string; // "user" | "admin"
  };
}

/**
 * Get the authenticated session or return a 401 response.
 * Usage in API routes:
 *
 *   const session = await requireAuth();
 *   if (session instanceof NextResponse) return session;
 *   // session is AuthSession
 */
export async function requireAuth(): Promise<AuthSession | NextResponse> {
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
  };
}

/** Check if the session user is an admin */
export function isAdmin(session: AuthSession): boolean {
  return session.user.role === 'admin';
}
