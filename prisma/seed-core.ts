import type { PrismaClient } from '@prisma/client';

import { seedJudgeBench } from './seed-judgebench';
import { seedPromptTemplates } from './seed-prompt-templates';

/**
 * Seed the catalog this deployment needs in order to be usable at all.
 *
 * The blocker this exists to clear is not "PromptTemplate is empty" — it is
 * that the whole catalog is empty (`JudgeModel = JudgeModelVersion =
 * ModelEndpoint = Rubric = Project = Dataset = 0`), so the UI has nothing to
 * select and nothing can run.
 *
 * ── WHAT THIS SEEDER DELIBERATELY DOES NOT CREATE ─────────────────────────
 *
 * 1. NO CREDENTIALS ACCOUNTS. The previous version created
 *    admin@judgearena.local / demo@judgearena.local with default passwords
 *    (`admin123` / `demo1234`). Self-service registration is retired and
 *    access is Authentik OIDC; shipping two password accounts into a
 *    public-tier deployment re-opens exactly the door that was closed. Use
 *    `admin-create-user.js` for the break-glass path instead.
 *
 *    Dropping them also removed the `bcryptjs` import, which was one of the
 *    three reasons this file could not run inside the deployed image.
 *
 * 2. NO MODELENDPOINTS. The previous version created three keyless anthropic
 *    endpoints marked `verifiedAt` so they satisfied
 *    `requireOwnedActiveEndpoints`. Keyless means they resolve through the
 *    operator's ANTHROPIC_API_KEY — i.e. the operator silently funds every
 *    run made through them. The product is BYOK: a user supplies their own
 *    key against the shared catalog below. Endpoints are per-user by
 *    construction and are not seeded for anyone.
 *
 * 3. NO SAMPLE PROJECT / EVALUATION / RUN. The old seeder created an
 *    EvaluationRun at status `pending`, which made `EvaluationRun > 0` stop
 *    being evidence that the product had ever actually run something. Demo
 *    rows that look like history are worse than an empty table.
 *
 * Everything here is idempotent: re-running against a seeded database makes
 * no new rows. That matters because this ships inside the image and may be
 * invoked more than once.
 */

/**
 * Owner for public, curated platform content.
 *
 * `Dataset.userId` / `Project.userId` / `Rubric.userId` are all non-nullable,
 * so shared content still needs an owner even though it belongs to no one in
 * particular. This is a system row, not a login: the `!` prefix makes
 * `passwordHash` structurally invalid as a bcrypt hash, so no password can
 * ever compare true against it, and it has no OIDC identity so no SSO login
 * can bind to it either. Same idiom as the importer's
 * `archive@judgearena.local` (scripts/importer/owners.ts).
 *
 * Kept DISTINCT from that archive user on purpose: "owner of curated platform
 * content" and "tombstone for the public artifacts of deleted accounts" are
 * different roles, and collapsing them would make it impossible to tell
 * seeded content from inherited orphans in a query or an audit.
 */
export const PLATFORM_USER_EMAIL = 'platform@judgearena.local';

export async function resolvePlatformUser(client: PrismaClient): Promise<string> {
  // findFirst, not findUnique: User.email is deliberately not DB-unique —
  // identity is (oidcIssuer, oidcSubject) only (1b Task 13). Only this
  // function ever writes a row with this email, so first match is correct.
  const existing = await client.user.findFirst({ where: { email: PLATFORM_USER_EMAIL } });
  if (existing) return existing.id;

  const created = await client.user.create({
    data: {
      email: PLATFORM_USER_EMAIL,
      name: 'Judge Arena',
      passwordHash: '!platform-system-user',
    },
  });
  return created.id;
}

// The shared judge catalog. Shared, not per-user, because a leaderboard is
// only comparable if two users running "Claude Sonnet 4.5" are running the
// same catalog identity — `JudgeModel.slug` is globally unique and a
// collision mints a NEW model, so per-user scoping would produce N
// leaderboard identities with no merge path.
const CATALOG_JUDGES = [
  { name: 'Claude Sonnet 4.5', slug: 'claude-sonnet-4-5', baseModel: 'claude-sonnet-4-5-20250514' },
  { name: 'Claude Sonnet 4.6', slug: 'claude-sonnet-4-6', baseModel: 'claude-sonnet-4-6-20250627' },
  { name: 'Claude Opus 4.5', slug: 'claude-opus-4-5', baseModel: 'claude-opus-4-5-20250630' },
] as const;

/**
 * Runs the whole seed against a caller-supplied client.
 *
 * Split out from the `prisma/seed.ts` entry point so DB tests can invoke it
 * against the test database without the entry's `main()` firing on import —
 * the same reason `seedPromptTemplates` was extracted in 1a.
 */
export async function seedAll(prisma: PrismaClient) {
  console.log('🌱 Seeding database...');

  await seedPromptTemplates(prisma);

  const platformUserId = await resolvePlatformUser(prisma);
  console.log(`  ✓ Platform system user: ${PLATFORM_USER_EMAIL}`);

  // Default rubric, owned by the platform user. Upsert on the (userId, slug)
  // unique so a re-seed does not mint a second copy — the previous version
  // used a bare `create` and duplicated its rubric on every run.
  const rubric = await prisma.rubric.upsert({
    where: { userId_slug: { userId: platformUserId, slug: 'general-quality-assessment' } },
    update: {},
    create: {
      name: 'General Quality Assessment',
      slug: 'general-quality-assessment',
      description:
        'A comprehensive rubric for evaluating text quality across multiple dimensions.',
      userId: platformUserId,
      criteria: {
        create: [
          {
            name: 'Accuracy',
            description:
              'Factual correctness and precision of the content. Are claims well-supported and verifiable?',
            maxScore: 10,
            weight: 1.5,
            order: 0,
          },
          {
            name: 'Completeness',
            description:
              'Coverage of the topic. Does the response address all aspects of the prompt or task?',
            maxScore: 10,
            weight: 1.25,
            order: 1,
          },
          {
            name: 'Clarity',
            description:
              'Readability and structure. Is the response well-organised and easy to follow?',
            maxScore: 10,
            weight: 1.0,
            order: 2,
          },
          {
            name: 'Relevance',
            description:
              'Focus on the task. Does the response stay on topic without unnecessary digression?',
            maxScore: 10,
            weight: 1.0,
            order: 3,
          },
          {
            name: 'Depth',
            description:
              'Substance of the analysis. Does the response go beyond surface-level treatment?',
            maxScore: 10,
            weight: 1.25,
            order: 4,
          },
        ],
      },
    },
  });
  console.log(`  ✓ Rubric: ${rubric.name}`);

  let catalogCount = 0;
  for (const judge of CATALOG_JUDGES) {
    // eslint-disable-next-line no-await-in-loop -- sequential seed, N=3; idempotency matters more than parallelism
    const judgeModel = await prisma.judgeModel.upsert({
      where: { slug: judge.slug },
      update: {},
      create: {
        name: judge.name,
        slug: judge.slug,
        judgeClass: 'prompted_api',
        scoringMechanism: 'critique_generative',
        baseModel: judge.baseModel,
      },
    });

    // eslint-disable-next-line no-await-in-loop
    await prisma.judgeModelVersion.upsert({
      where: { judgeModelId_ordinal: { judgeModelId: judgeModel.id, ordinal: 1 } },
      update: {},
      create: {
        judgeModelId: judgeModel.id,
        ordinal: 1,
        servingBackend: 'anthropic',
        protocolSupport: { pointwise: ['score'] },
        samplingDefaults: { temperature: 0.3, max_tokens: 4096 },
        // `trusted` is a claim about the catalog entry, not about any
        // calibration that has happened — no CalibrationRun exists yet.
        trustState: 'trusted',
      },
    });
    catalogCount += 1;
  }
  console.log(`  ✓ Catalog: ${catalogCount} judge models + versions (no endpoints — BYOK)`);

  // The Leaderboard project. `visibility: 'public'` explicitly, not just
  // `isDefault`, and re-asserted on update so a row created before that field
  // existed is corrected on the next seed.
  const leaderboard = await prisma.project.upsert({
    where: { id: 'leaderboard' },
    update: { visibility: 'public' },
    create: {
      id: 'leaderboard',
      name: 'Leaderboard',
      description:
        'Public leaderboard for evaluating models against standardized datasets. Compare model performance on well-known benchmarks.',
      isDefault: true,
      visibility: 'public',
      userId: platformUserId,
    },
  });
  console.log(`  ✓ Project: ${leaderboard.name}`);

  // Metadata-only pointer at LiveCodeBench: no samples ship for it, so it is
  // a catalogue entry rather than something runnable. Kept as-is.
  const liveCodeBench = await prisma.dataset.upsert({
    where: { id: 'livecodebench-codegen-lite' },
    update: { visibility: 'public' },
    create: {
      id: 'livecodebench-codegen-lite',
      name: 'LiveCodeBench Code Generation Lite',
      slug: 'livecodebench-codegen-lite',
      description:
        'A curated benchmark for evaluating code generation capabilities of LLMs. Contains programming problems with test cases from competitive programming platforms.',
      source: 'remote',
      visibility: 'public',
      publishedAt: new Date(),
      sourceUrl: 'https://huggingface.co/datasets/livecodebench/code_generation_lite',
      huggingFaceId: 'livecodebench/code_generation_lite',
      remoteMetadata: JSON.stringify({
        author: 'livecodebench',
        cardData: { license: 'mit', task_categories: ['text-generation'] },
        lastModified: '2024-12-01',
      }),
      tags: JSON.stringify(['code-generation', 'benchmark', 'competitive-programming']),
      projectId: leaderboard.id,
      userId: platformUserId,
    },
  });
  console.log(`  ✓ Dataset: ${liveCodeBench.name} (metadata only)`);

  // JudgeBench — public, with its 620 rows shipped inline. See
  // seed-judgebench.ts for why the rows are vendored and what the runtime can
  // and cannot do with a pairwise item today.
  await seedJudgeBench(prisma, { ownerId: platformUserId, projectId: leaderboard.id });

  console.log('\n✅ Database seeded successfully!');
  console.log('\n📋 Summary:');
  console.log(`   - 1 platform system user (${PLATFORM_USER_EMAIL}, cannot log in)`);
  console.log('   - 1 Rubric with 5 criteria');
  console.log(`   - ${catalogCount} catalog judge models + versions`);
  console.log('   - 1 Leaderboard project (public)');
  console.log('   - 2 public datasets: LiveCodeBench (metadata), JudgeBench (620 samples)');
  console.log('   - 1 Prompt template (v1-legacy)');
  console.log('\n   No credentials accounts, no ModelEndpoints, no sample runs — by design.');
  console.log('   Sign in via Authentik OIDC, or use admin-create-user.js for break-glass.');
}

