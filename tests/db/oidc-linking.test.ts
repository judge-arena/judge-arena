import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { compare, hash } from 'bcryptjs';
import { db, truncateAll, mkUser } from './helpers';
import {
  resolveOidcUser,
  OIDC_MANAGED_PASSWORD_HASH,
  type OidcUserClient,
} from '../../src/lib/oidc-user';
import { authOptions } from '../../src/lib/auth';

/**
 * next-auth v4's `CredentialsProvider(options)` factory does NOT expose
 * `options.authorize` as the provider object's own `.authorize` — that
 * field is hardcoded to a `() => null` stub (see
 * node_modules/next-auth/providers/credentials.js). The real callback next-
 * auth's internal route handler actually invokes lives at
 * `provider.options.authorize`. Calling `.authorize` directly (the
 * "obvious" spot) silently authenticates nothing — always null, never an
 * error — which is exactly the kind of footgun worth a named helper+comment
 * rather than a bare `(provider as any).options.authorize` at each call
 * site.
 */
function getCredentialsAuthorize() {
  const provider = authOptions.providers.find((p) => p.id === 'credentials') as unknown as {
    options: { authorize: (credentials: Record<string, string>) => Promise<unknown> };
  };
  if (!provider) throw new Error('credentials provider not found in authOptions.providers');
  return provider.options.authorize;
}

// DB-backed: tests/db/** (see vitest.db.config.ts) — real Postgres, not
// mocked. resolveOidcUser is exported specifically so this find-or-create
// logic is directly testable without driving the full NextAuth signIn
// flow (see src/lib/oidc-user.ts's module doc).
describe('OIDC user resolution (issuer, sub) — spec §7 non-destructive-v5 condition', () => {
  const ISSUER = 'https://authentik.lab.example/application/o/judge-arena/';
  const originalAutoprovision = process.env.ALLOW_OIDC_AUTOPROVISION;

  beforeEach(async () => {
    await truncateAll();
    delete process.env.ALLOW_OIDC_AUTOPROVISION; // default: deny-unless-invited
  });

  afterEach(() => {
    if (originalAutoprovision === undefined) delete process.env.ALLOW_OIDC_AUTOPROVISION;
    else process.env.ALLOW_OIDC_AUTOPROVISION = originalAutoprovision;
  });

  it('known (issuer, sub) resolves to the SAME user across repeated sign-ins', async () => {
    process.env.ALLOW_OIDC_AUTOPROVISION = 'true'; // first call provisions

    const first = await resolveOidcUser(db, {
      issuer: ISSUER,
      sub: 'sub-alice',
      email: 'alice@test.local',
      name: 'Alice',
    });
    expect(first).toMatchObject({ status: 'ok', created: true, claimedInvite: false });

    const second = await resolveOidcUser(db, {
      issuer: ISSUER,
      sub: 'sub-alice',
      email: 'alice@test.local',
      name: 'Alice',
    });
    expect(second).toMatchObject({ status: 'ok', created: false, claimedInvite: false });

    expect((second as { userId: string }).userId).toBe((first as { userId: string }).userId);
    expect(await db.user.count()).toBe(1);
  });

  it('a DIFFERENT sub presenting the SAME email resolves to a DISTINCT user — never linked to the existing one (linking hazard closed)', async () => {
    process.env.ALLOW_OIDC_AUTOPROVISION = 'true';

    const first = await resolveOidcUser(db, {
      issuer: ISSUER,
      sub: 'sub-bob-corp-idp',
      email: 'shared@test.local',
      name: 'Bob (corp IdP)',
    });
    expect(first.status).toBe('ok');
    const firstId = (first as { userId: string }).userId;

    // A second, unrelated OIDC identity claiming the exact same email but a
    // different `sub`. The old email-fallback bug would have resolved this
    // to `firstId`; resolveOidcUser must not.
    const second = await resolveOidcUser(db, {
      issuer: ISSUER,
      sub: 'sub-mallory-other-idp',
      email: 'shared@test.local',
      name: 'Mallory',
    });
    expect(second).toMatchObject({ status: 'ok', created: true, claimedInvite: false });
    const secondId = (second as { userId: string }).userId;

    expect(secondId).not.toBe(firstId);
    expect(await db.user.count()).toBe(2);

    const rows = await db.user.findMany({ where: { email: 'shared@test.local' } });
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.oidcSubject))).toEqual(
      new Set(['sub-bob-corp-idp', 'sub-mallory-other-idp'])
    );
  });

  it('an invitePending row with a matching email is CLAIMED (issuer/sub stamped, invitePending cleared) rather than linked-by-email', async () => {
    const invite = await db.user.create({
      data: {
        email: 'invitee@test.local',
        name: null,
        passwordHash: OIDC_MANAGED_PASSWORD_HASH,
        invitePending: true,
        role: 'user',
      },
    });

    const resolution = await resolveOidcUser(db, {
      issuer: ISSUER,
      sub: 'sub-invitee',
      email: 'invitee@test.local',
      name: 'Invitee Name',
    });

    expect(resolution).toMatchObject({ status: 'ok', created: false, claimedInvite: true });
    expect((resolution as { userId: string }).userId).toBe(invite.id);

    const claimed = await db.user.findUnique({ where: { id: invite.id } });
    expect(claimed).toMatchObject({
      oidcIssuer: ISSUER,
      oidcSubject: 'sub-invitee',
      invitePending: false,
      name: 'Invitee Name', // filled in from the IdP since the invite had none
    });
    expect(await db.user.count()).toBe(1);
  });

  it('claiming an invite does not overwrite a name the admin already set on it', async () => {
    const invite = await db.user.create({
      data: {
        email: 'named-invitee@test.local',
        name: 'Admin-Assigned Name',
        passwordHash: OIDC_MANAGED_PASSWORD_HASH,
        invitePending: true,
        role: 'admin',
      },
    });

    await resolveOidcUser(db, {
      issuer: ISSUER,
      sub: 'sub-named-invitee',
      email: 'named-invitee@test.local',
      name: 'Whatever The IdP Calls Them',
    });

    const claimed = await db.user.findUnique({ where: { id: invite.id } });
    expect(claimed?.name).toBe('Admin-Assigned Name');
    expect(claimed?.role).toBe('admin'); // untouched by the claim
  });

  // ─── Invite-claim TOCTOU guard ──────────────────────────────────────────
  //
  // A previous version of this file asserted the TOCTOU fix via
  // `Promise.all([resolveOidcUser(...), resolveOidcUser(...)])` against a
  // live Postgres connection pool. That looked like a race test but wasn't
  // one in practice: Node's event loop + Prisma's connection acquisition
  // serialize the two calls' query round-trips closely enough that the
  // second call's `findFirst` almost always runs *after* the first call's
  // write has already landed — so the second call never even sees the row
  // as claimable, and the test passes for a reason that has nothing to do
  // with the `updateMany` WHERE-clause guard. Proof: reverting
  // `resolveOidcUser`'s claim step to the pre-fix `findFirst` + unconditional
  // `update({where:{id}})` still passed that test — the bug it was meant to
  // catch was invisible to it.
  //
  // The two tests below replace it with deterministic reproductions of the
  // race OUTCOME instead of hoping to schedule the race itself:
  //   1. A sequential-call test — establishes that a second, different sub
  //      is denied and can never displace a claim that has already fully
  //      landed. (This exercises the same "never re-claimable" behavior as
  //      the WHERE-clause's `invitePending: true` matching nothing once
  //      that's false — but, being fully sequential, does NOT exercise the
  //      atomic guard itself, since the first call's write is complete
  //      before the second call ever reads. Note this alone would still
  //      pass against the buggy pre-fix code, for the same reason the old
  //      Promise.all test did — see the guard test below for the one that
  //      actually distinguishes them.)
  //   2. The atomic-claim GUARD test — manufactures the exact TOCTOU
  //      window deterministically: a second caller's `findFirst` is rigged
  //      to return a STALE pre-claim snapshot of the invite row (exactly
  //      what a real second racer's read would return had it landed before
  //      the first racer's write), while every other call
  //      (`findUnique`/`update`/`updateMany`) hits the real, already-updated
  //      database. This proves the atomicity comes from the WRITE's WHERE
  //      clause re-evaluating current row state — not from anything the
  //      read observed — which is precisely the property the fix depends
  //      on and the property a revert to unconditional `update({where:{id}})`
  //      would violate.

  it('a second, different sub can never displace a claim that has already landed (sequential, non-racing)', async () => {
    const invite = await db.user.create({
      data: {
        email: 'sequential-claim@test.local',
        passwordHash: OIDC_MANAGED_PASSWORD_HASH,
        invitePending: true,
        role: 'user',
      },
    });

    // Step 2: the first sign-in claims it — happy path, same shape as the
    // dedicated "is CLAIMED" test above.
    const winner = await resolveOidcUser(db, {
      issuer: ISSUER,
      sub: 'sub-seq-s1',
      email: 'sequential-claim@test.local',
      name: 'Racer S1',
    });
    expect(winner).toMatchObject({ status: 'ok', created: false, claimedInvite: true });
    expect((winner as { userId: string }).userId).toBe(invite.id);

    // Step 3: a second, different sub presenting the same email, called
    // strictly after the first has fully committed. Must NOT return the
    // claimed row's userId — with autoprovision off (default, see
    // beforeEach), it must be denied outright.
    const loser = await resolveOidcUser(db, {
      issuer: ISSUER,
      sub: 'sub-seq-s2',
      email: 'sequential-claim@test.local',
      name: 'Racer S2',
    });
    expect(loser).toEqual({ status: 'denied', reason: 'no_match_autoprovision_disabled' });

    const row = await db.user.findUniqueOrThrow({ where: { id: invite.id } });
    expect(row.oidcSubject).toBe('sub-seq-s1'); // never overwritten to the second sub
    expect(row.invitePending).toBe(false);
    expect(await db.user.count()).toBe(1);
  });

  it('ATOMIC-CLAIM GUARD: a stale claimable read racing a real committed write must not let a second sub overwrite the winner (reverting to unconditional update fails this test — see report)', async () => {
    const invite = await db.user.create({
      data: {
        email: 'atomic-guard@test.local',
        passwordHash: OIDC_MANAGED_PASSWORD_HASH,
        invitePending: true,
        role: 'user',
      },
    });

    // Snapshot the row exactly as a second racer's `findFirst` would have
    // seen it — BEFORE the first racer's write lands. This is the "read"
    // half of the TOCTOU window, captured deterministically instead of
    // relying on real scheduling to land two round-trips inside it.
    const staleSnapshot = { ...invite };

    // The first racer really claims it — a genuine, uncontested write
    // against live Postgres.
    const winner = await resolveOidcUser(db, {
      issuer: ISSUER,
      sub: 'sub-guard-winner',
      email: 'atomic-guard@test.local',
      name: 'Winner',
    });
    expect(winner).toMatchObject({
      status: 'ok',
      created: false,
      claimedInvite: true,
      userId: invite.id,
    });

    // The second racer's resolveOidcUser call, but with `findFirst` rigged
    // to return the STALE pre-claim snapshot — reproducing exactly what a
    // second racer would have read had its query landed inside the TOCTOU
    // window, before the winner's write. `findUnique`/`update`/`updateMany`
    // are the real bound Prisma delegate methods and hit the REAL,
    // already-updated database — only the read is stale.
    const staleReadClient: OidcUserClient = {
      user: {
        findUnique: db.user.findUnique.bind(db.user),
        findFirst: async () => staleSnapshot,
        update: db.user.update.bind(db.user),
        updateMany: db.user.updateMany.bind(db.user),
        create: db.user.create.bind(db.user),
      },
    } as unknown as OidcUserClient;

    const loser = await resolveOidcUser(staleReadClient, {
      issuer: ISSUER,
      sub: 'sub-guard-loser',
      email: 'atomic-guard@test.local',
      name: 'Loser',
    });

    // THE INVARIANT: the second racer must never be told it claimed
    // `invite.id`, no matter what its (stale) read observed. The fixed
    // code's `updateMany({where:{id, invitePending:true, oidcSubject:null},
    // ...})` re-evaluates that WHERE against the REAL current row — which
    // the winner already flipped to invitePending:false — so it matches
    // ZERO rows, count is 0, and resolveOidcUser falls through to
    // re-resolve-by-identity-or-deny. Never bound to invite.id, never
    // "ok".
    expect(loser).toEqual({ status: 'denied', reason: 'no_match_autoprovision_disabled' });

    const row = await db.user.findUniqueOrThrow({ where: { id: invite.id } });
    expect(row.oidcSubject).toBe('sub-guard-winner'); // NOT overwritten to the loser's sub
    expect(row.invitePending).toBe(false);
    expect(await db.user.count()).toBe(1);
  });

  it('normalizes the OIDC profile email (lowercase+trim) before invite-claim matching, so IdP casing differences never miss the invite', async () => {
    // Invite stored lowercase+trimmed — the CLI's own normalization
    // (scripts/admin/create-user.ts's parseArgs: `email.toLowerCase().trim()`)
    // means real invites are always stored this way. Authentik's `email`
    // claim casing is not guaranteed to match; resolveOidcUser must
    // normalize its own side the same way the CLI and credentials login
    // (src/lib/auth.ts's authorize()) already do, or a same-person sign-in
    // can silently miss its own invite over a casing/whitespace mismatch.
    const invite = await db.user.create({
      data: {
        email: 'user@x.com',
        passwordHash: OIDC_MANAGED_PASSWORD_HASH,
        invitePending: true,
        role: 'user',
      },
    });

    const resolution = await resolveOidcUser(db, {
      issuer: ISSUER,
      sub: 'sub-casing',
      email: '  User@X.com  ',
      name: 'Cased User',
    });

    expect(resolution).toMatchObject({ status: 'ok', created: false, claimedInvite: true });
    expect((resolution as { userId: string }).userId).toBe(invite.id);

    const claimed = await db.user.findUniqueOrThrow({ where: { id: invite.id } });
    expect(claimed).toMatchObject({ oidcSubject: 'sub-casing', invitePending: false });
  });

  it('a claimed invite is never claimable again by a second, different sub', async () => {
    const invite = await db.user.create({
      data: {
        email: 'once-only@test.local',
        passwordHash: OIDC_MANAGED_PASSWORD_HASH,
        invitePending: true,
        role: 'user',
      },
    });
    await resolveOidcUser(db, {
      issuer: ISSUER,
      sub: 'sub-first-claim',
      email: 'once-only@test.local',
      name: null,
    });

    // autoprovision off (default) — a second identity presenting the same
    // email now has no (issuer,sub) match and no claimable invite left.
    const secondAttempt = await resolveOidcUser(db, {
      issuer: ISSUER,
      sub: 'sub-second-claim',
      email: 'once-only@test.local',
      name: null,
    });

    expect(secondAttempt).toEqual({ status: 'denied', reason: 'no_match_autoprovision_disabled' });
    expect(await db.user.count()).toBe(1);
    const row = await db.user.findUnique({ where: { id: invite.id } });
    expect(row?.oidcSubject).toBe('sub-first-claim'); // unchanged by the denied attempt
  });

  it('an unrecognized identity is DENIED by default (ALLOW_OIDC_AUTOPROVISION unset) — no user created', async () => {
    const resolution = await resolveOidcUser(db, {
      issuer: ISSUER,
      sub: 'sub-nobody-invited-this-person',
      email: 'stranger@test.local',
      name: 'Stranger',
    });

    expect(resolution).toEqual({ status: 'denied', reason: 'no_match_autoprovision_disabled' });
    expect(await db.user.count()).toBe(0);
  });

  it('ALLOW_OIDC_AUTOPROVISION=true creates a fresh user for an otherwise-unrecognized identity', async () => {
    process.env.ALLOW_OIDC_AUTOPROVISION = 'true';

    const resolution = await resolveOidcUser(db, {
      issuer: ISSUER,
      sub: 'sub-self-service',
      email: 'selfservice@test.local',
      name: 'Self Service',
    });

    expect(resolution).toMatchObject({ status: 'ok', created: true, claimedInvite: false });
    const created = await db.user.findUnique({
      where: { id: (resolution as { userId: string }).userId },
    });
    expect(created).toMatchObject({
      email: 'selfservice@test.local',
      oidcIssuer: ISSUER,
      oidcSubject: 'sub-self-service',
      passwordHash: OIDC_MANAGED_PASSWORD_HASH,
      invitePending: false,
    });
  });

  it("an invitePending row is only claimable while oidcSubject is still null — never re-matched by email once it isn't", async () => {
    // Same email, but this row is a NORMAL (non-invite) user — invitePending
    // false. resolveOidcUser must not touch it via email under any path.
    const normalUser = await mkUser({ email: 'regular@test.local', oidcIssuer: null, oidcSubject: null });

    process.env.ALLOW_OIDC_AUTOPROVISION = 'true';
    const resolution = await resolveOidcUser(db, {
      issuer: ISSUER,
      sub: 'sub-unrelated',
      email: 'regular@test.local',
      name: null,
    });

    expect(resolution.status).toBe('ok');
    expect((resolution as { userId: string }).userId).not.toBe(normalUser.id);
    const untouched = await db.user.findUnique({ where: { id: normalUser.id } });
    expect(untouched).toMatchObject({ oidcIssuer: null, oidcSubject: null });
  });

  it('credentials login is unaffected: a real password account authenticates normally via authOptions', async () => {
    const passwordHash = await hash('correct-horse-battery', 12);
    await db.user.create({
      data: {
        email: 'creds-user@test.local',
        name: 'Creds User',
        passwordHash,
        role: 'user',
      },
    });

    const authorize = getCredentialsAuthorize();

    const authorized = await authorize({
      email: 'creds-user@test.local',
      password: 'correct-horse-battery',
    });
    expect(authorized).toMatchObject({ email: 'creds-user@test.local', role: 'user' });

    const wrongPassword = await authorize({
      email: 'creds-user@test.local',
      password: 'nope',
    });
    expect(wrongPassword).toBeNull();
  });

  it('credentials login never matches an OIDC-only row sharing the same email (sentinel passwordHash excluded)', async () => {
    // Same email as a real credentials account below, but this row is
    // OIDC-only: unusable sentinel passwordHash, no real password ever set.
    process.env.ALLOW_OIDC_AUTOPROVISION = 'true';
    await resolveOidcUser(db, {
      issuer: ISSUER,
      sub: 'sub-oidc-twin',
      email: 'twin@test.local',
      name: 'OIDC Twin',
    });

    const credsHash = await compare('irrelevant', OIDC_MANAGED_PASSWORD_HASH).catch(() => false);
    expect(credsHash).toBe(false); // sanity: sentinel never compares true

    const realPasswordHash = await hash('real-password-123', 12);
    await db.user.create({
      data: {
        email: 'twin@test.local',
        name: 'Real Creds Twin',
        passwordHash: realPasswordHash,
        role: 'user',
      },
    });
    expect(await db.user.count({ where: { email: 'twin@test.local' } })).toBe(2);

    const authorized = await getCredentialsAuthorize()({
      email: 'twin@test.local',
      password: 'real-password-123',
    });
    // Must resolve to the REAL credentials row, never the OIDC-sentinel one.
    expect(authorized).toMatchObject({ email: 'twin@test.local', name: 'Real Creds Twin' });
  });

  it('the self-service registration route is removed from the source tree', () => {
    const routePath = join(__dirname, '../../src/app/api/auth/register/route.ts');
    expect(existsSync(routePath)).toBe(false);
  });
});
