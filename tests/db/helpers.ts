import { Prisma, PrismaClient } from '@prisma/client';

export const db = new PrismaClient({
  datasources: { db: { url: process.env.TEST_DATABASE_URL } },
});

// ─── Fixture helpers ────────────────────────────────────────────────────────
// Plain db.create wrappers used across tests/db/**. Each keeps its own
// counter so repeated calls within a single test (or across tests sharing a
// truncated DB) never collide on a unique column (User.email, Rubric slug).

let userCounter = 0;

export async function mkUser(overrides: Partial<Prisma.UserUncheckedCreateInput> = {}) {
  userCounter += 1;
  return db.user.create({
    data: {
      email: `fixture-user-${userCounter}@test.local`,
      passwordHash: 'fixture-hash',
      ...overrides,
    },
  });
}

let rubricCounter = 0;

export async function mkRubric(
  userId: string,
  overrides: Partial<Omit<Prisma.RubricUncheckedCreateInput, 'userId'>> = {}
) {
  rubricCounter += 1;
  return db.rubric.create({
    data: {
      name: `fixture-rubric-${rubricCounter}`,
      userId,
      ...overrides,
    },
  });
}

/**
 * Truncates every table in the `public` schema (except Prisma's own
 * migrations bookkeeping table) and restarts identity sequences, so each
 * DB test starts from a known-empty state without needing a full
 * `prisma migrate reset` between tests.
 */
export async function truncateAll(): Promise<void> {
  const tables = await db.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename != '_prisma_migrations'
  `;

  if (tables.length === 0) return;

  const tableList = tables.map((t) => `"${t.tablename}"`).join(', ');
  await db.$executeRawUnsafe(`TRUNCATE TABLE ${tableList} RESTART IDENTITY CASCADE`);
}
