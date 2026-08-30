/** Bundle entry for add-judge.ts. Separate for the same reason
 *  create-user-entry.ts is: an `import.meta.url` direct-run guard cannot work
 *  under the CJS output esbuild produces for the runner image. */
import { prisma } from '@/lib/db';
import { parseAddJudgeArgs, runAddJudge } from './add-judge';

async function main(): Promise<void> {
  await runAddJudge(parseAddJudgeArgs(process.argv.slice(2)));
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
