import { PrismaClient } from '@prisma/client';

import { seedAll } from './seed-core';

/**
 * Seed entry point.
 *
 * Deliberately thin: it owns the client lifecycle and the process exit code,
 * and nothing else. All of the actual seeding lives in `./seed-core`, which
 * takes a client, so DB tests can drive it against the test database without
 * importing this file and firing the run as a side effect.
 *
 * Runs two ways, and both matter:
 *   - dev:       npx tsx prisma/seed.ts   (also `npm run ctrl:seed`)
 *   - in-image:  node /app/seed.js        (esbuild bundle, see Dockerfile)
 *
 * The in-image path is the one that was missing. `prisma db seed` is NOT the
 * entry: there is no `prisma.seed` key in package.json, the deployed runner
 * has no TypeScript toolchain, and the Prisma CLI lives at an isolated prefix
 * (/opt/prisma-cli) that cannot see the app's modules.
 */
const prisma = new PrismaClient();

seedAll(prisma)
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
