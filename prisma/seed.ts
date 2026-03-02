import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...');

  // Create admin user
  const adminPassword = await bcrypt.hash('admin123', 12);
  const adminUser = await prisma.user.upsert({
    where: { email: 'admin@judgearena.local' },
    update: {},
    create: {
      email: 'admin@judgearena.local',
      name: 'Admin',
      passwordHash: adminPassword,
      role: 'admin',
    },
  });
  console.log(`  ✓ Created admin user: ${adminUser.email} (password: admin123)`);

  // Create demo user
  const demoPassword = await bcrypt.hash('demo1234', 12);
  const demoUser = await prisma.user.upsert({
    where: { email: 'demo@judgearena.local' },
    update: {},
    create: {
      email: 'demo@judgearena.local',
      name: 'Demo User',
      passwordHash: demoPassword,
      role: 'user',
    },
  });
  console.log(`  ✓ Created demo user: ${demoUser.email} (password: demo1234)`);

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

  // Create default model configs
  const models = await Promise.all([
    prisma.modelConfig.create({
      data: {
        name: 'Claude Sonnet 4.5',
        provider: 'anthropic',
        modelId: 'claude-sonnet-4-5-20250514',
        isActive: true,
        isVerified: true,
        verifiedAt: new Date(),
        userId: adminUser.id,
      },
    }),
    prisma.modelConfig.create({
      data: {
        name: 'Claude Sonnet 4.6',
        provider: 'anthropic',
        modelId: 'claude-sonnet-4-6-20250627',
        isActive: true,
        isVerified: true,
        verifiedAt: new Date(),
        userId: adminUser.id,
      },
    }),
    prisma.modelConfig.create({
      data: {
        name: 'Claude Opus 4.5',
        provider: 'anthropic',
        modelId: 'claude-opus-4-5-20250630',
        isActive: true,
        isVerified: true,
        verifiedAt: new Date(),
        userId: adminUser.id,
      },
    }),
  ]);

  console.log(`  ✓ Created ${models.length} model configurations`);

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
        create: models.map((m) => ({ modelConfigId: m.id })),
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
        create: models.map((m) => ({ modelConfigId: m.id })),
      },
    },
  });

  console.log(`  ✓ Created sample run: ${sampleRun.id}`);

  console.log('\n✅ Database seeded successfully!');
  console.log(`\n📋 Summary:`);
  console.log(`   - 2 Users (admin + demo)`);
  console.log(`   - 1 Rubric with 5 criteria`);
  console.log(`   - ${models.length} Model configurations`);
  console.log(`   - 1 Leaderboard (default project) + 1 sample project`);
  console.log(`   - 1 Public remote dataset (LiveCodeBench)`);
  console.log(`   - 1 Evaluation template + 1 run`);
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
