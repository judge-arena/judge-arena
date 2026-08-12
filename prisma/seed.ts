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
 *
 * ── RUNNING IT AGAINST THE DEPLOYED CLUSTER ───────────────────────────────
 * Nothing invokes this automatically. The chart runs `migrate deploy` from a
 * pre-install/pre-upgrade Helm hook, but there is no seed hook, so seeding is
 * an explicit operator action:
 *
 *     kubectl -n tenant-public exec deploy/judge-arena-web -- node /app/seed.js
 *
 * It is idempotent, so a second run is safe and reports zero new rows. It
 * needs an image built from this commit or later — check /app/seed.js exists
 * before assuming an older pod can do it.
 *
 * Deliberately manual for now. A post-install/post-upgrade hook would seed on
 * every chart upgrade, which is safe given idempotency but means a catalog
 * change ships silently with an unrelated deploy. That is a decision worth
 * making explicitly rather than inheriting from this file.
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
