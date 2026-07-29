import type { NextAuthOptions } from 'next-auth';
import type { RequestInternal } from 'next-auth';
import CredentialsProvider from 'next-auth/providers/credentials';
import { compare } from 'bcryptjs';
import { prisma } from '@/lib/db';
import { resolveOidcUser } from '@/lib/oidc-user';
import { audit } from '@/lib/audit';

// Read once at module load, not per-request — matches this file's existing
// `process.env.NEXTAUTH_SECRET` convention (auth.ts is excluded from
// getEnv()'s zod schema surface; see src/lib/env.ts's docstring on why
// auth/db/queue config is read directly rather than centrally validated).
const AUTHENTIK_ISSUER = process.env.AUTHENTIK_ISSUER;

/**
 * NextAuth's `authorize(credentials, req)` hands back a `RequestInternal`
 * (`req.headers?: Record<string, any>`), not a Web `Request` — so
 * `src/lib/audit.ts`'s `getRequestContext(request: Request)` doesn't apply
 * here. This is the same extraction, against the plain-object header shape
 * NextAuth actually gives this callback.
 */
function authRequestContext(req: Pick<RequestInternal, 'headers'> | undefined): {
  ip: string;
  userAgent: string;
} {
  const headers = req?.headers ?? {};
  const forwarded = headers['x-forwarded-for'];
  const ip =
    (typeof forwarded === 'string' ? forwarded.split(',')[0]?.trim() : undefined) ??
    headers['x-real-ip'] ??
    'unknown';
  const userAgent = headers['user-agent'] ?? 'unknown';
  return { ip, userAgent };
}

/**
 * Rows created with one of the app's unusable sentinel passwordHash values
 * (src/lib/oidc-user.ts's OIDC_MANAGED_PASSWORD_HASH, and the importer's
 * '!imported-oidc-only' / '!archive-system-user' — scripts/importer/owners.ts)
 * never had, and can never present, a real bcrypt hash: bcrypt hashes always
 * start with `$2`, these sentinels always start with `!`. Filtering them out
 * here (rather than relying on `compare()` to just fail) disambiguates
 * credentials login now that more than one User row can share an email —
 * see the schema comment on User.email for why that's possible since this
 * task (email is no longer a DB-unique identity key).
 */
async function findCredentialsUserByEmail(email: string) {
  return prisma.user.findFirst({
    where: { email, NOT: { passwordHash: { startsWith: '!' } } },
  });
}

export const authOptions: NextAuthOptions = {
  // 24h JWT, rolling — refreshed on any activity within the last hour of
  // its life (updateAge). No `adapter` is configured: sessions are JWT-only,
  // there are no session rows in the DB to migrate/expire separately (spec
  // §7 non-destructive-v5 condition (b)).
  session: { strategy: 'jwt', maxAge: 24 * 60 * 60, updateAge: 60 * 60 },
  pages: {
    signIn: '/login',
  },
  providers: [
    CredentialsProvider({
      name: 'credentials',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials, req) {
        if (!credentials?.email || !credentials?.password) return null;

        const normalizedEmail = credentials.email.toLowerCase().trim();
        const { ip, userAgent } = authRequestContext(req);

        const user = await findCredentialsUserByEmail(normalizedEmail);
        if (!user) {
          audit({ action: 'user.login.failed', metadata: { email: normalizedEmail, reason: 'no_match' }, ip, userAgent });
          return null;
        }

        const valid = await compare(credentials.password, user.passwordHash);
        if (!valid) {
          audit({ userId: user.id, action: 'user.login.failed', metadata: { reason: 'bad_password' }, ip, userAgent });
          return null;
        }

        audit({ userId: user.id, action: 'user.login', metadata: { method: 'credentials' }, ip, userAgent });

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
        };
      },
    }),
    {
      id: 'authentik',
      name: 'Authentik',
      type: 'oauth',
      wellKnown: AUTHENTIK_ISSUER
        ? `${AUTHENTIK_ISSUER}/.well-known/openid-configuration`
        : undefined,
      clientId: process.env.AUTHENTIK_CLIENT_ID,
      clientSecret: process.env.AUTHENTIK_CLIENT_SECRET,
      authorization: { params: { scope: 'openid email profile' } },
      // Read the profile straight off the validated id_token rather than
      // making a separate userinfo request.
      idToken: true,
      profile(profile) {
        return {
          id: profile.sub,
          email: profile.email,
          name: profile.name ?? profile.preferred_username ?? null,
        };
      },
    },
  ],
  callbacks: {
    async signIn({ user, account }) {
      // Credentials sign-in: authorize() above already vetted the
      // password: nothing more to check.
      if (account?.provider !== 'authentik') return true;

      // account.providerAccountId === the `id` our profile() returned
      // above, i.e. the OIDC `sub` — next-auth's standard "no adapter"
      // convention for OAuth providers.
      if (!AUTHENTIK_ISSUER || !account.providerAccountId || !user.email) {
        return false;
      }

      const resolution = await resolveOidcUser(prisma, {
        issuer: AUTHENTIK_ISSUER,
        sub: account.providerAccountId,
        email: user.email,
        name: user.name,
      });

      if (resolution.status === 'denied') {
        // No `req` on next-auth v4's typed `signIn` callback params (unlike
        // `authorize`'s second arg) — ip/userAgent are omitted here rather
        // than reached for via an untyped/internal escape hatch.
        audit({
          action: 'user.login.failed',
          metadata: { method: 'oidc', reason: resolution.reason, email: user.email },
        });
        return false;
      }

      // signIn() runs before jwt() on this same sign-in pass — stash OUR
      // resolved User.id on `user` so jwt() below puts it (never the raw
      // OIDC sub) in the token.
      (user as { id: string }).id = resolution.userId;

      audit({
        userId: resolution.userId,
        action: resolution.created
          ? 'user.register'
          : resolution.claimedInvite
            ? 'user.invite_claimed'
            : 'user.login',
        metadata: { method: 'oidc' },
      });

      return true;
    },
    async jwt({ token, user }) {
      if (user) {
        // Token carries the internal user id claim ONLY (spec §7
        // non-destructive-v5 condition (c)) — auth-guard resolves
        // role/email/name fresh from the User table on every request, so
        // this claim never goes stale and app code stays uncoupled from
        // next-auth's internal token shape.
        token.uid = (user as { id: string }).id;
      }
      // next-auth v4 pre-populates `token.email`/`token.name`/`token.picture`
      // straight from the signed-in `user` object BEFORE this callback ever
      // runs (its internal "defaultToken" merge on `trigger: "signIn" |
      // "signUp"`) — the `if (user)` branch above doesn't put them there,
      // and simply not re-adding them isn't enough to keep them out. Strip
      // them explicitly on every call (idempotent on subsequent calls,
      // where they're already gone) so the JWT/session cookie never carries
      // PII beyond the opaque id claim. `token.sub` (next-auth's own OIDC
      // `sub` claim convention) is left alone — nothing here depends on it,
      // but next-auth's internals may.
      delete token.email;
      delete token.name;
      delete token.picture;
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        const userId = token.uid as string | undefined;
        (session.user as any).id = userId;

        // email/name are no longer on the token (stripped in jwt() above),
        // so they have to be resolved fresh from the User table here —
        // same "never trust a value that could go stale inside a 24h
        // token" posture as auth-guard's requireAuth(). This keeps
        // client-side consumers of `useSession()` (sidebar, dashboard)
        // working exactly as before: they still see session.user.email/
        // name, just DB-sourced instead of token-cached.
        const dbUser = userId
          ? await prisma.user.findUnique({
              where: { id: userId },
              select: { email: true, name: true },
            })
          : null;
        session.user.email = dbUser?.email ?? null;
        session.user.name = dbUser?.name ?? null;
      }
      return session;
    },
  },
  secret: process.env.NEXTAUTH_SECRET,
};
