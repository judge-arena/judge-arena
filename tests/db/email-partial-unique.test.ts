import { describe, it, expect, beforeEach } from 'vitest';
import { db, truncateAll } from './helpers';
import { OIDC_MANAGED_PASSWORD_HASH } from '../../src/lib/oidc-user';

// DB-backed (1b Task 13 code-review fix — IMPORTANT #2): exercises the
// partial unique index added in
// prisma/migrations/20260729180000_v2b_email_partial_unique/migration.sql —
// "at most one real-credentials row per email", DB-enforced on top of the
// plain (non-unique) User_email_idx from 20260729170000_v2b_oidc_identity_schema.
// A real bcrypt hash always starts with `$2`; the fixture hashes below use
// that shape without actually calling bcryptjs (this suite only cares that
// they're NOT `!`-prefixed sentinels, which is all the partial index's
// WHERE clause checks).
describe('User.email partial unique index (real-credentials rows only)', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it('two credentials users (real bcrypt-shaped passwordHash) sharing an email: the second create is rejected P2002', async () => {
    await db.user.create({
      data: { email: 'dup@test.local', passwordHash: '$2a$12$fixturehashonefixturehashonefixturehashone' },
    });

    await expect(
      db.user.create({
        data: { email: 'dup@test.local', passwordHash: '$2a$12$fixturehashtwofixturehashtwofixturehashtwo' },
      })
    ).rejects.toMatchObject({ code: 'P2002' });

    expect(await db.user.count({ where: { email: 'dup@test.local' } })).toBe(1);
  });

  it('a credentials user and an OIDC (`!`-prefixed sentinel passwordHash) user sharing the same email are BOTH allowed', async () => {
    const creds = await db.user.create({
      data: { email: 'twin@test.local', passwordHash: '$2a$12$fixturehashfixturehashfixturehashfixture12' },
    });
    const oidc = await db.user.create({
      data: {
        email: 'twin@test.local',
        passwordHash: OIDC_MANAGED_PASSWORD_HASH,
        oidcIssuer: 'https://authentik.lab.example/application/o/judge-arena/',
        oidcSubject: 'sub-twin',
      },
    });

    expect(creds.id).not.toBe(oidc.id);
    expect(await db.user.count({ where: { email: 'twin@test.local' } })).toBe(2);
  });

  it('two OIDC/invite (sentinel passwordHash) rows sharing an email are BOTH allowed — the partial index only ever covers real credentials rows', async () => {
    const first = await db.user.create({
      data: {
        email: 'oidc-siblings@test.local',
        passwordHash: OIDC_MANAGED_PASSWORD_HASH,
        oidcIssuer: 'https://authentik.lab.example/application/o/judge-arena/',
        oidcSubject: 'sub-sibling-one',
      },
    });
    const second = await db.user.create({
      data: {
        email: 'oidc-siblings@test.local',
        passwordHash: OIDC_MANAGED_PASSWORD_HASH,
        oidcIssuer: 'https://authentik.lab.example/application/o/judge-arena/',
        oidcSubject: 'sub-sibling-two',
      },
    });

    expect(first.id).not.toBe(second.id);
    expect(await db.user.count({ where: { email: 'oidc-siblings@test.local' } })).toBe(2);
  });
});
