import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createImportCtx } from '../../scripts/importer/context';
import { resolveOwners, ARCHIVE_USER_EMAIL } from '../../scripts/importer/owners';
import { db, truncateAll } from '../db/helpers';
import { v1db, truncateAllV1, mkV1User } from './helpers';

// DB-backed: needs BOTH the v1 scratch DB (V1_DATABASE_URL) and the v2 test
// DB (DATABASE_URL/TEST_DATABASE_URL) reachable. Named *.db.test.ts and
// listed in vitest.db.config.ts's include (NOT vitest.config.ts's), so
// plain `npm test` never runs this file — see tests/importer/helpers.ts.
describe('resolveOwners (DB)', () => {
  beforeEach(async () => {
    await truncateAll();
    await truncateAllV1();
  });

  afterAll(async () => {
    await v1db.$disconnect();
    await db.$disconnect();
  });

  it('mapped entry: find-or-creates a v2 User keyed on (oidcIssuer, oidcSubject)', async () => {
    const v1User = await mkV1User({ email: 'alice@v1.example' });
    const ctx = createImportCtx({
      mode: 'apply',
      ownerMap: {
        [v1User.id]: {
          email: 'alice@v2.example',
          oidcIssuer: 'https://idp.test.local',
          oidcSubject: 'sub-alice',
        },
      },
    });

    const owners = await resolveOwners(ctx);
    const v2UserId = owners.get(v1User.id);
    expect(v2UserId).toBeTruthy();

    const v2User = await db.user.findUnique({ where: { id: v2UserId! } });
    expect(v2User).toMatchObject({
      email: 'alice@v2.example',
      oidcIssuer: 'https://idp.test.local',
      oidcSubject: 'sub-alice',
      passwordHash: '!imported-oidc-only',
    });
    expect(ctx.report.counts().User).toMatchObject({ created: 1, skipped: 0 });
  });

  it('is idempotent in apply mode: re-running finds the existing user instead of duplicating', async () => {
    const v1User = await mkV1User();
    const ownerMap = {
      [v1User.id]: {
        email: 'bob@v2.example',
        oidcIssuer: 'https://idp.test.local',
        oidcSubject: 'sub-bob',
      },
    };

    const ctx1 = createImportCtx({ mode: 'apply', ownerMap });
    const owners1 = await resolveOwners(ctx1);

    const ctx2 = createImportCtx({ mode: 'apply', ownerMap });
    const owners2 = await resolveOwners(ctx2);

    expect(owners2.get(v1User.id)).toBe(owners1.get(v1User.id));
    expect(ctx2.report.counts().User).toMatchObject({ created: 0, skipped: 1 });
    expect(await db.user.count()).toBe(1);
  });

  it("'archive' entries all resolve to the same shared archive user, created once", async () => {
    const v1UserA = await mkV1User();
    const v1UserB = await mkV1User();
    const ctx = createImportCtx({
      mode: 'apply',
      ownerMap: { [v1UserA.id]: 'archive', [v1UserB.id]: 'archive' },
    });

    const owners = await resolveOwners(ctx);
    const idA = owners.get(v1UserA.id);
    const idB = owners.get(v1UserB.id);
    expect(idA).toBeTruthy();
    expect(idA).toBe(idB);

    const archiveUser = await db.user.findUnique({ where: { id: idA! } });
    expect(archiveUser).toMatchObject({
      email: ARCHIVE_USER_EMAIL,
      name: 'Archive',
      passwordHash: '!archive-system-user',
    });

    // Two v1 users mapped to 'archive' in a single call -> exactly one User row.
    expect(ctx.report.counts().User).toMatchObject({ created: 1, skipped: 0 });
    expect(await db.user.count()).toBe(1);
  });

  it("re-running with 'archive' entries finds the existing archive user (idempotent)", async () => {
    const v1User = await mkV1User();
    const ownerMap = { [v1User.id]: 'archive' as const };

    const ctx1 = createImportCtx({ mode: 'apply', ownerMap });
    await resolveOwners(ctx1);

    const ctx2 = createImportCtx({ mode: 'apply', ownerMap });
    const owners2 = await resolveOwners(ctx2);

    expect(ctx2.report.counts().User).toMatchObject({ created: 0, skipped: 1 });
    expect(await db.user.count()).toBe(1);
    expect(owners2.get(v1User.id)).toBeTruthy();
  });

  it("'drop' entries are absent from the returned map", async () => {
    const v1UserDropped = await mkV1User();
    const v1UserMapped = await mkV1User();
    const ctx = createImportCtx({
      mode: 'apply',
      ownerMap: {
        [v1UserDropped.id]: 'drop',
        [v1UserMapped.id]: {
          email: 'carol@v2.example',
          oidcIssuer: 'https://idp.test.local',
          oidcSubject: 'sub-carol',
        },
      },
    });

    const owners = await resolveOwners(ctx);
    expect(owners.has(v1UserDropped.id)).toBe(false);
    expect(owners.has(v1UserMapped.id)).toBe(true);
    expect(owners.size).toBe(1);
  });

  it('report mode resolves a full map but writes nothing to v2 (real counts stay 0)', async () => {
    const v1User = await mkV1User();
    const v1ArchiveUser = await mkV1User();
    const ctx = createImportCtx({
      mode: 'report',
      ownerMap: {
        [v1User.id]: {
          email: 'dana@v2.example',
          oidcIssuer: 'https://idp.test.local',
          oidcSubject: 'sub-dana',
        },
        [v1ArchiveUser.id]: 'archive',
      },
    });

    const owners = await resolveOwners(ctx);
    expect(owners.get(v1User.id)).toBeTruthy();
    expect(owners.get(v1ArchiveUser.id)).toBeTruthy();
    expect(ctx.report.counts().User).toMatchObject({ created: 2, skipped: 0 });

    // report mode: tallies show what WOULD happen, but nothing is persisted.
    expect(await db.user.count()).toBe(0);
  });

  it('report mode still finds and reuses an already-imported (real) user', async () => {
    const v1User = await mkV1User();
    const ownerMap = {
      [v1User.id]: {
        email: 'erin@v2.example',
        oidcIssuer: 'https://idp.test.local',
        oidcSubject: 'sub-erin',
      },
    };

    const applyCtx = createImportCtx({ mode: 'apply', ownerMap });
    const applyOwners = await resolveOwners(applyCtx);

    const reportCtx = createImportCtx({ mode: 'report', ownerMap });
    const reportOwners = await resolveOwners(reportCtx);

    expect(reportOwners.get(v1User.id)).toBe(applyOwners.get(v1User.id));
    expect(reportCtx.report.counts().User).toMatchObject({ created: 0, skipped: 1 });
    expect(await db.user.count()).toBe(1);
  });
});
