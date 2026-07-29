import { describe, it, expect, beforeEach } from 'vitest';
import { db, truncateAll, mkUser } from './helpers';
import { authOptions } from '../../src/lib/auth';

// DB-backed (1b Task 13 code-review fix — IMPORTANT #3): session() below
// resolves email/name fresh from the User table via prisma (src/lib/db.ts),
// which points at DATABASE_URL — .env.test sets DATABASE_URL and
// TEST_DATABASE_URL to the same database, so this file's `db` (tests/db/
// helpers.ts, a second PrismaClient instance) and auth.ts's `prisma`
// singleton are reading/writing the same live Postgres test DB.
//
// next-auth v4 pre-populates `token.email`/`token.name`/`token.picture`
// from the signed-in `user` object BEFORE the user-supplied `jwt()`
// callback ever runs (its internal "defaultToken" merge on sign-in/sign-up)
// — the callback used to do nothing about that, so those fields silently
// rode along inside the JWT/session cookie despite the "id claim only"
// intent documented on `token.uid`. jwt() now strips them explicitly;
// session() re-populates session.user.email/name from the DB via
// token.uid so client-side consumers (sidebar, dashboard, both driven by
// next-auth/react's useSession()) keep working unchanged.
describe('JWT/session claim minimization (Task 13 review fix — IMPORTANT #3)', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it('jwt() strips email/name/picture that next-auth pre-populated onto the token, keeping only uid', async () => {
    const jwtCallback = authOptions.callbacks!.jwt!;

    // Simulates the token shape next-auth v4 hands the callback on first
    // sign-in: `sub`/`email`/`name`/`picture` already filled in from the
    // provider's `user` object, before any app-level callback logic runs.
    const tokenBeforeCallback = {
      sub: 'user-id-123',
      email: 'alice@test.local',
      name: 'Alice',
      picture: 'https://example.com/alice.png',
    };

    const result = await jwtCallback({
      token: tokenBeforeCallback,
      user: { id: 'user-id-123', email: 'alice@test.local', name: 'Alice' },
      account: null,
      profile: undefined,
      isNewUser: undefined,
    } as any);

    expect(result.uid).toBe('user-id-123');
    expect(result.email).toBeUndefined();
    expect(result.name).toBeUndefined();
    expect(result.picture).toBeUndefined();
  });

  it('jwt() strips email/name/picture on subsequent (non-sign-in) calls too — idempotent, not just an "if (user)" guard', async () => {
    const jwtCallback = authOptions.callbacks!.jwt!;

    // A subsequent call: no `user` (only present on sign-in), but the
    // decoded token still carries a stale email/name/picture from BEFORE
    // this fix shipped (e.g. an old cookie surviving a deploy).
    const staleToken = {
      uid: 'user-id-123',
      sub: 'user-id-123',
      email: 'stale@test.local',
      name: 'Stale Name',
      picture: 'https://example.com/stale.png',
    };

    const result = await jwtCallback({
      token: staleToken,
      user: undefined,
      account: null,
      profile: undefined,
      isNewUser: undefined,
    } as any);

    expect(result.uid).toBe('user-id-123');
    expect(result.email).toBeUndefined();
    expect(result.name).toBeUndefined();
    expect(result.picture).toBeUndefined();
  });

  it('session() populates session.user.email/name fresh from the DB via token.uid, never from the (now-stripped) token', async () => {
    const user = await mkUser({ email: 'dbsourced@test.local', name: 'DB Sourced Name' });

    const sessionCallback = authOptions.callbacks!.session!;
    const result = await sessionCallback({
      session: { user: {}, expires: new Date(Date.now() + 86400000).toISOString() },
      // No email/name here — exactly what the token looks like after
      // jwt()'s strip above. If session() fell back to reading them off
      // the token, this test would see `undefined`/`null` instead of the
      // DB values.
      token: { uid: user.id, sub: user.id },
      user: undefined,
    } as any);

    expect((result.user as { id?: string })?.id).toBe(user.id);
    expect(result.user?.email).toBe('dbsourced@test.local');
    expect(result.user?.name).toBe('DB Sourced Name');
  });

  it('session() reflects a DB name change made after the token was issued (fresh-from-DB, not token-cached)', async () => {
    const user = await mkUser({ email: 'renamed@test.local', name: 'Original Name' });
    await db.user.update({ where: { id: user.id }, data: { name: 'Renamed Later' } });

    const sessionCallback = authOptions.callbacks!.session!;
    const result = await sessionCallback({
      session: { user: {}, expires: new Date(Date.now() + 86400000).toISOString() },
      token: { uid: user.id, sub: user.id },
      user: undefined,
    } as any);

    expect(result.user?.name).toBe('Renamed Later');
  });
});
