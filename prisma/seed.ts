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
 * It is idempotent — a second run creates no duplicate rows — but DO NOT read
 * its output as an insert report. This used to claim it "reports zero new
 * rows"; it does not. Only two things it prints are gated on what the
 * database actually did: the prompt-template lines, which say `Created` or
 * `Exists` per row, and JudgeBench's `(N new samples, …)` count. Every other
 * `✓` line — including that same JudgeBench line's `Created dataset:` prefix,
 * and the whole summary block at the end — prints unconditionally and reads
 * identically on a no-op run and a first one. A clean transcript is evidence
 * the seed did not fail, not evidence it created anything. Ask the database
 * if you need to know what is there.
 *
 * A re-seed is also no longer purely additive: the catalog upsert re-asserts
 * `JudgeModel.baseModel`, so running this REPAIRS the three invalid Anthropic
 * model ids the earlier seeder wrote (all three 404'd at call time, which left
 * the default catalog unable to produce a judgment at all). On an
 * already-seeded deployment that repair is the reason to run it.
 *
 * It needs an image built from this commit or later — check /app/seed.js
 * exists before assuming an older pod can do it.
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
