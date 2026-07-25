import { describe, it, expect, beforeEach } from 'vitest';
import { db, truncateAll, mkUser, mkRubric } from './helpers';

describe('v2 enums, user OIDC identity, visibility + rubric version constraint', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it('rubric (parentId, version) is unique', async () => {
    const u = await mkUser();
    const root = await mkRubric(u.id, { version: 1 });
    await db.rubric.create({ data: { name: 'v2', version: 2, parentId: root.id, userId: u.id } });
    await expect(
      db.rubric.create({ data: { name: 'dup', version: 2, parentId: root.id, userId: u.id } })
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('user (oidcIssuer, oidcSubject) is unique', async () => {
    await db.user.create({
      data: {
        email: 'oidc-a@test.local',
        passwordHash: 'x',
        oidcIssuer: 'https://idp.test.local',
        oidcSubject: 'sub-1',
      },
    });
    await expect(
      db.user.create({
        data: {
          email: 'oidc-b@test.local',
          passwordHash: 'x',
          oidcIssuer: 'https://idp.test.local',
          oidcSubject: 'sub-1',
        },
      })
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('rows with no OIDC identity (null, null) do not collide', async () => {
    await mkUser();
    await expect(mkUser()).resolves.toMatchObject({ oidcIssuer: null, oidcSubject: null });
  });

  it('rubric visibility defaults to private', async () => {
    const u = await mkUser();
    const rubric = await mkRubric(u.id);
    expect(rubric.visibility).toBe('private');
    expect(rubric.publishedAt).toBeNull();
    expect(rubric.retiredAt).toBeNull();
  });

  it('project visibility defaults to private', async () => {
    const u = await mkUser();
    const project = await db.project.create({ data: { name: 'p1', userId: u.id } });
    expect(project.visibility).toBe('private');
    expect(project.publishedAt).toBeNull();
  });
});
