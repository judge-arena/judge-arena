import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { seedPromptTemplates } from './seed-prompt-templates';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...');

  await seedPromptTemplates(prisma);

  // Seed passwords are configurable via env vars for production deployments.
  // Defaults are only suitable for local development.
  const adminPw = process.env.SEED_ADMIN_PASSWORD || 'admin123';
  const demoPw = process.env.SEED_DEMO_PASSWORD || 'demo1234';

  // Create admin user. findFirst + create (not upsert): User.email is no
  // longer DB-unique (1b Task 13 — OIDC identity is (oidcIssuer,
  // oidcSubject) only), so `upsert({ where: { email } })` no longer
  // typechecks. Seeding only ever runs against a fresh/dev database, so
  // "first row with this email, if any" is an acceptable find.
  const adminPassword = await bcrypt.hash(adminPw, 12);
  const existingAdmin = await prisma.user.findFirst({
    where: { email: 'admin@judgearena.local' },
  });
  const adminUser =
    existingAdmin ??
    (await prisma.user.create({
      data: {
        email: 'admin@judgearena.local',
        name: 'Admin',
        passwordHash: adminPassword,
        role: 'admin',
      },
    }));
  console.log(`  ✓ Created admin user: ${adminUser.email}`);

  // Create demo user
  const demoPassword = await bcrypt.hash(demoPw, 12);
  const existingDemo = await prisma.user.findFirst({
    where: { email: 'demo@judgearena.local' },
  });
  const demoUser =
    existingDemo ??
    (await prisma.user.create({
      data: {
        email: 'demo@judgearena.local',
        name: 'Demo User',
        passwordHash: demoPassword,
        role: 'user',
      },
    }));
  console.log(`  ✓ Created demo user: ${demoUser.email}`);

  // Create default rubric
  const rubric = await prisma.rubric.create({
    data: {
      name: 'General Quality Assessment',
      description:
        'A comprehensive rubric for evaluating text quality across multiple dimensions.',
      userId: adminUser.id,
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
            weight: 1.2,
            order: 1,
          },
          {
            name: 'Clarity',
            description:
              'How clear and understandable is the writing? Is it well-organized and easy to follow?',
            maxScore: 10,
            weight: 1.0,
            order: 2,
          },
          {
            name: 'Reasoning',
            description:
              'Quality of logical reasoning and argumentation. Are conclusions well-supported?',
            maxScore: 10,
            weight: 1.3,
            order: 3,
          },
          {
            name: 'Relevance',
            description:
              'How relevant is the response to the original prompt or task requirements?',
            maxScore: 10,
            weight: 1.0,
            order: 4,
          },
        ],
      },
    },
  });

  console.log(`  ✓ Created rubric: ${rubric.name}`);

  // ── Catalog: the 3 Anthropic defaults as JudgeModel+Version entries ────────
  // Task 12: ModelConfig is write-retired — the runtime's "default models"
  // are catalog JudgeModel/JudgeModelVersion entries plus a per-user
  // ModelEndpoint (here, the admin's own, active+pre-verified so the sample
  // evaluation/run below can launch immediately). Any user can create their
  // OWN endpoint against the same catalog entries from the Models page.
  const DEFAULT_ANTHROPIC_JUDGES = [
    { name: 'Claude Sonnet 4.5', slug: 'claude-sonnet-4-5', baseModel: 'claude-sonnet-4-5-20250514' },
    { name: 'Claude Sonnet 4.6', slug: 'claude-sonnet-4-6', baseModel: 'claude-sonnet-4-6-20250627' },
    { name: 'Claude Opus 4.5', slug: 'claude-opus-4-5', baseModel: 'claude-opus-4-5-20250630' },
  ] as const;

  const endpoints = [];
  for (const judge of DEFAULT_ANTHROPIC_JUDGES) {
    // eslint-disable-next-line no-await-in-loop -- sequential seed script, small N (3), idempotency (upsert/find-or-create) matters more than parallelism here
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
    const version = await prisma.judgeModelVersion.upsert({
      where: { judgeModelId_ordinal: { judgeModelId: judgeModel.id, ordinal: 1 } },
      update: {},
      create: {
        judgeModelId: judgeModel.id,
        ordinal: 1,
        servingBackend: 'anthropic',
        protocolSupport: { pointwise: ['score'] },
        samplingDefaults: { temperature: 0.3, max_tokens: 4096 },
        trustState: 'trusted',
      },
    });

    // ModelEndpoint has no compound unique constraint (see
    // src/app/api/models/route.ts's doc) — find-or-create keeps this
    // idempotent across re-seeds. No endpoint/apiKeyEnc set: the
    // 'anthropic' descriptor is kind:'api' with no custom endpoint, so a
    // real call falls back to the ANTHROPIC_API_KEY env var (see
    // registry.ts's resolveApiKey).
    // eslint-disable-next-line no-await-in-loop
    let endpoint = await prisma.modelEndpoint.findFirst({
      where: { userId: adminUser.id, judgeModelVersionId: version.id },
    });
    if (!endpoint) {
      // eslint-disable-next-line no-await-in-loop
      endpoint = await prisma.modelEndpoint.create({
        data: {
          userId: adminUser.id,
          judgeModelVersionId: version.id,
          isActive: true,
          verifiedAt: new Date(),
        },
      });
    }

    endpoints.push({ judgeModel, version, endpoint });
  }

  console.log(`  ✓ Created ${endpoints.length} catalog judge models + versions + admin endpoints`);

  // Create the Leaderboard project (default, visible to all)
  const leaderboard = await prisma.project.upsert({
    where: { id: 'leaderboard' },
    update: {},
    create: {
      id: 'leaderboard',
      name: 'Leaderboard',
      description:
        'Public leaderboard for evaluating models against standardized datasets. Compare model performance on well-known benchmarks.',
      isDefault: true,
      userId: adminUser.id,
    },
  });
  console.log(`  ✓ Created Leaderboard project: ${leaderboard.name}`);

  // Create a sample public remote dataset (LiveCodeBench)
  const liveCodeBench = await prisma.dataset.upsert({
    where: { id: 'livecodebench-codegen-lite' },
    update: {},
    create: {
      id: 'livecodebench-codegen-lite',
      name: 'LiveCodeBench Code Generation Lite',
      description:
        'A curated benchmark for evaluating code generation capabilities of LLMs. Contains programming problems with test cases from competitive programming platforms.',
      source: 'remote',
      visibility: 'public',
      sourceUrl: 'https://huggingface.co/datasets/livecodebench/code_generation_lite',
      huggingFaceId: 'livecodebench/code_generation_lite',
      remoteMetadata: JSON.stringify({
        author: 'livecodebench',
        cardData: { license: 'mit', task_categories: ['text-generation'] },
        lastModified: '2024-12-01',
      }),
      tags: JSON.stringify(['code-generation', 'benchmark', 'competitive-programming']),
      projectId: leaderboard.id,
      userId: adminUser.id,
    },
  });
  console.log(`  ✓ Created dataset: ${liveCodeBench.name}`);

  // Create a sample project
  const project = await prisma.project.create({
    data: {
      name: 'Sample Evaluation Project',
      description:
        'A sample project to demonstrate the LLM-as-a-Judge evaluation workflow. Submit text artifacts, have multiple models grade them, and provide your own human judgment.',
      userId: adminUser.id,
    },
  });

  console.log(`  ✓ Created project: ${project.name}`);

  // Create a sample evaluation template
  const evaluation = await prisma.evaluation.create({
    data: {
      projectId: project.id,
      rubricId: rubric.id,
      title: 'Sample Code Review',
      inputText: `## Pull Request: Add User Authentication

### Changes
- Added JWT-based authentication middleware
- Created login and registration endpoints
- Added password hashing with bcrypt
- Implemented refresh token rotation

### Code Sample
\`\`\`typescript
export async function authenticate(req: Request): Promise<User> {
  const token = req.headers.get('Authorization')?.replace('Bearer ', '');
  if (!token) throw new AuthError('No token provided');
  
  const payload = await verifyJWT(token);
  const user = await db.user.findUnique({ where: { id: payload.sub } });
  
  if (!user) throw new AuthError('User not found');
  return user;
}
\`\`\`

### Notes
- All passwords are hashed with bcrypt (12 rounds)
- Tokens expire after 15 minutes
- Refresh tokens are single-use with rotation
`,
      userId: adminUser.id,
      modelSelections: {
        create: endpoints.map((e) => ({ judgeModelVersionId: e.version.id })),
      },
    },
  });

  console.log(`  ✓ Created sample evaluation template: ${evaluation.title}`);

  // Create a sample run for the evaluation (status: pending — no judgments yet)
  const sampleRun = await prisma.evaluationRun.create({
    data: {
      evaluationId: evaluation.id,
      rubricId: rubric.id,
      status: 'pending',
      triggeredById: adminUser.id,
      runModelSelections: {
        create: endpoints.map((e) => ({ judgeModelVersionId: e.version.id })),
      },
    },
  });

  console.log(`  ✓ Created sample run: ${sampleRun.id}`);

  console.log('\n✅ Database seeded successfully!');
  console.log(`\n📋 Summary:`);
  console.log(`   - 2 Users (admin + demo)`);
  console.log(`   - 1 Rubric with 5 criteria`);
  console.log(`   - ${endpoints.length} catalog judge models + versions + admin endpoints`);
  console.log(`   - 1 Leaderboard (default project) + 1 sample project`);
  console.log(`   - 1 Public remote dataset (LiveCodeBench)`);
  console.log(`   - 1 Evaluation template + 1 run`);
  console.log(`   - 1 Prompt template (v1-legacy)`);
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
