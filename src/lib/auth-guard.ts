import { getServerSession } from 'next-auth';
import { NextResponse } from 'next/server';
import { authOptions } from '@/lib/auth';

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
  return {
    user: {
      id: (session.user as any).id,
      email: session.user.email!,
      name: session.user.name ?? null,
      role: (session.user as any).role ?? 'user',
    },
  };
}

/** Check if the session user is an admin */
export function isAdmin(session: AuthSession): boolean {
  return session.user.role === 'admin';
}
