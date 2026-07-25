import { describe, it, expect } from 'vitest';
import { db, truncateAll } from './helpers';

describe('v1 baseline migration', () => {
  it('creates v1 tables', async () => {
    await truncateAll();
    const u = await db.user.create({ data: { email: 'a@b.c', passwordHash: 'x' } });
    expect(u.id).toBeTruthy();
  });
});
