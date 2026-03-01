import { existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const command = process.argv[2];

const helpText = `
Judge Arena controller

Usage:
  npm run ctrl -- <command>

Commands:
  generate          Prisma client generate
  seed              Run prisma seed script
  db                Prisma generate + db push + seed
  full-reset-build  Full reset (db + .next) and production build
`;

function runStep(label, cmd) {
  console.log(`\n[controller] ${label}`);
  const result = spawnSync(cmd, {
    shell: true,
    stdio: 'inherit',
    env: process.env,
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function cleanNextBuild() {
  const nextPath = '.next';
  if (existsSync(nextPath)) {
    console.log(`\n[controller] Removing ${nextPath}/`);
    rmSync(nextPath, { recursive: true, force: true });
  }
}

function runGenerate() {
  runStep('Prisma generate', 'npx prisma generate');
}

function runSeed() {
  runStep('Prisma seed', 'npx tsx prisma/seed.ts');
}

function runDbFlow() {
  runGenerate();
  runStep('Prisma db push', 'npx prisma db push');
  runSeed();
}

function runFullResetBuild() {
  runGenerate();
  runStep('Prisma force reset', 'npx prisma db push --force-reset');
  runSeed();
  cleanNextBuild();
  runStep('Production build', 'next build');
}

switch (command) {
  case 'generate':
    runGenerate();
    break;
  case 'seed':
    runSeed();
    break;
  case 'db':
    runDbFlow();
    break;
  case 'full-reset-build':
    runFullResetBuild();
    break;
  default:
    console.log(helpText.trim());
    break;
}
