import { Prisma, PrismaClient as V1PrismaClient } from '@prisma/v1-client';

// ─── v1-side test helpers ───────────────────────────────────────────────────
// Mirrors tests/db/helpers.ts's `db`/`truncateAll`/`mkUser` shape, but points
// at the disposable v1 scratch database (V1_DATABASE_URL) that
// scripts/importer/** reads from — see prisma/v1/schema.v1.prisma. Used only
// by the *.db.test.ts specs in tests/importer/** (see vitest.db.config.ts);
// plain `npm test` never imports this file.

export const v1db = new V1PrismaClient({
  datasources: { db: { url: process.env.V1_DATABASE_URL } },
});

let v1UserCounter = 0;

export async function mkV1User(overrides: Partial<Prisma.UserUncheckedCreateInput> = {}) {
  v1UserCounter += 1;
  return v1db.user.create({
    data: {
      email: `v1-fixture-user-${v1UserCounter}@test.local`,
      passwordHash: 'v1-fixture-hash',
      ...overrides,
    },
  });
}

let v1ModelConfigCounter = 0;

export async function mkV1ModelConfig(
  userId: string,
  overrides: Partial<Omit<Prisma.ModelConfigUncheckedCreateInput, 'userId'>> = {}
) {
  v1ModelConfigCounter += 1;
  return v1db.modelConfig.create({
    data: {
      name: `v1-fixture-config-${v1ModelConfigCounter}`,
      provider: 'anthropic',
      modelId: 'claude-3-opus',
      userId,
      ...overrides,
    },
  });
}

/**
 * Truncates every table in the v1 scratch database's `public` schema
 * (except Prisma's own migrations bookkeeping table) and restarts identity
 * sequences — the v1 counterpart of tests/db/helpers.ts's `truncateAll`.
 * `npm run test:db`'s `prisma migrate reset` only touches the v2 schema
 * (DATABASE_URL), so this is the only thing that resets the v1 scratch DB
 * between tests.
 */
export async function truncateAllV1(): Promise<void> {
  const tables = await v1db.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename != '_prisma_migrations'
  `;

  if (tables.length === 0) return;

  const tableList = tables.map((t) => `"${t.tablename}"`).join(', ');
  await v1db.$executeRawUnsafe(`TRUNCATE TABLE ${tableList} RESTART IDENTITY CASCADE`);
}
