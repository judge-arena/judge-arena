import { PrismaClient } from '@prisma/client';

export const db = new PrismaClient({
  datasources: { db: { url: process.env.TEST_DATABASE_URL } },
});

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
