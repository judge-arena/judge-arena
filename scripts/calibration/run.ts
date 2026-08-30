/**
 * ─── Run a judge against a golden set, and show its work ────────────────────
 *
 * The first thing in this product that scores a MODEL against ground truth.
 * Everything before it measured humans against each other.
 *
 * WHY A SCRIPT AND NOT A ROUTE. The number is the deliverable; the surface is
 * not. A CLI reaches the same `launchCalibrationRun` / `scoreCalibrationRun` a
 * route would, so adding the route later adds a caller rather than a second
 * implementation — and until one exists this is runnable without shipping a
 * half-finished screen.
 *
 * WHAT IT PRINTS, and why each part is here rather than just the accuracy:
 *   - accuracy first, WITH its denominator, because a number over 14 of 30
 *     items and a number over 30 are different claims;
 *   - kappa BESIDE it, labelled with its method, never instead of it: ground
 *     truth is an answer key, not a peer rater, so chance-correcting on its
 *     marginal is a category error, and kappa is not comparable across sets —
 *     which is exactly what a leaderboard wants to do;
 *   - the RAW verdict distribution, because a judge that answers 'A' every
 *     time is the failure a good-looking accuracy on a 17/13 corpus hides;
 *   - every disagreement with the model's own reasoning, because being able to
 *     read WHY it was wrong is the point of capturing the thinking channel.
 *
 * Usage:
 *   npm run calibration:run -- --golden-set=<id> --judge-version=<id>
 *   npm run calibration:run -- --score-only=<calibrationRunId>
 */
import { prisma } from '@/lib/db';
import { launchCalibrationRun } from '@/lib/calibration/launch';
import { scoreCalibrationRun } from '@/lib/calibration/score';

// Use the SHARED singleton, not a second `new PrismaClient()`. launch/score
// default to this one, so a private client would leave the shared pool open
// and the process would print its whole report and then never exit — which is
// exactly what it did before this line changed.

function arg(name: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

function fmt(n: number | null, digits = 4): string {
  return n === null ? 'n/a' : n.toFixed(digits);
}

function cap(v: string | null | undefined): string {
  return v == null ? 'NULL' : `${v.length} chars`;
}

async function main(): Promise<void> {
  const goldenSetId = arg('golden-set');
  const judgeModelVersionId = arg('judge-version');
  const scoreOnly = arg('score-only');
  const pollTimeoutSec = Number(arg('poll-timeout') ?? '3600');

  let calibrationRunId: string;

  if (scoreOnly) {
    calibrationRunId = scoreOnly;
    console.log(`Scoring existing calibration run ${calibrationRunId} (no launch).`);
  } else {
    if (!goldenSetId || !judgeModelVersionId) {
      throw new Error('Need --golden-set=<id> and --judge-version=<id>, or --score-only=<id>.');
    }

    // Resolve the surrounding rows rather than making the caller paste four
    // ids. A calibration needs a rubric (the pairwise SYSTEM prompt renders
    // its criteria), a project to hang the Evaluations off, and a user to
    // attribute the runs to.
    const rubric = await prisma.rubric.findFirst({
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true, criteria: { select: { id: true } } },
    });
    if (!rubric) throw new Error('No Rubric exists — a pairwise judgment renders its criteria into the system prompt.');

    const project = await prisma.project.findFirst({ orderBy: { createdAt: 'asc' }, select: { id: true, name: true } });
    if (!project) throw new Error('No Project exists to attach the Evaluations to.');

    const owner = await prisma.user.findFirst({
      where: { role: 'admin' },
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true },
    });
    if (!owner) throw new Error('No admin User exists to attribute the runs to.');

    const version = await prisma.judgeModelVersion.findUnique({
      where: { id: judgeModelVersionId },
      select: {
        id: true,
        servingBackend: true,
        samplingDefaults: true,
        judgeModel: { select: { name: true, baseModel: true } },
      },
    });
    if (!version) throw new Error(`No JudgeModelVersion ${judgeModelVersionId}.`);

    console.log('── Launching ──────────────────────────────────────────────');
    console.log(`  judge     ${version.judgeModel.name}  (${version.servingBackend}, baseModel=${version.judgeModel.baseModel})`);
    console.log(`  sampling  ${JSON.stringify(version.samplingDefaults)}`);
    console.log(`  rubric    ${rubric.name} (${rubric.criteria.length} criteria)`);
    console.log(`  project   ${project.name}`);
    console.log(`  as        ${owner.name}`);
    console.log('  NOTE: creating the calibration header FREEZES this golden set irreversibly.');

    const launched = await launchCalibrationRun({
      goldenSetId,
      judgeModelVersionId,
      rubricId: rubric.id,
      projectId: project.id,
      triggeredById: owner.id,
    });
    calibrationRunId = launched.calibrationRunId;
    console.log(`  calibrationRunId ${calibrationRunId}`);
    console.log(`  accepted ${launched.accepted.length}   failed ${launched.failed.length}`);
    for (const f of launched.failed) console.log(`    ✗ ${f.goldenItemId}: ${f.reason}`);
    if (launched.accepted.length === 0) throw new Error('Nothing was accepted — stopping before the poll.');
  }

  // Judgments execute on the worker, through RabbitMQ. Poll terminal states
  // rather than sleeping a fixed time: a local reasoning model is slow and
  // variable, and a wrong fixed wait either truncates the run or wastes the
  // difference.
  const deadline = Date.now() + pollTimeoutSec * 1000;
  let lastLine = '';
  for (;;) {
    const rows = await prisma.modelJudgment.groupBy({
      by: ['status'],
      where: { run: { calibrationRunId } },
      _count: { _all: true },
    });
    const by: Record<string, number> = Object.fromEntries(rows.map((r) => [r.status, r._count._all]));
    const done = (by.completed ?? 0) + (by.error ?? 0);
    const total = Object.values(by).reduce((a, b) => a + b, 0);
    const line = `  completed ${by.completed ?? 0}  error ${by.error ?? 0}  running ${by.running ?? 0}  pending ${by.pending ?? 0}   (${done}/${total})`;
    if (line !== lastLine) {
      console.log(line);
      lastLine = line;
    }
    if (total > 0 && done === total) break;
    if (Date.now() > deadline) {
      console.log(`  ⏱ poll timeout after ${pollTimeoutSec}s — scoring what landed.`);
      break;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }

  const score = await scoreCalibrationRun(calibrationRunId);

  console.log('\n── Result ─────────────────────────────────────────────────');
  console.log(`  ACCURACY   ${fmt(score.accuracy)}   (${score.correctCount}/${score.verdictCount} items with a verdict)`);
  console.log(`  kappa      ${fmt(score.kappa)}   method ${JSON.stringify(score.method)}`);
  console.log(`  itemCount ${score.itemCount}   missingVerdicts ${score.missingVerdicts}`);
  if (score.missingVerdicts > 0) {
    console.log(`  ⚠ ${score.missingVerdicts} item(s) produced no verdict — the accuracy above is over the rest, not the set.`);
  }
  console.log('\n  raw verdict distribution (position bias lives here, not in derived preferences):');
  for (const [v, n] of Object.entries(score.verdictDistribution)) console.log(`    ${v.padEnd(6)} ${n}`);
  console.log('\n  confusion [expected][judged]:');
  for (const [exp, row] of Object.entries(score.confusion)) {
    console.log(`    ${exp.padEnd(5)} -> ${Object.entries(row).map(([k, v]) => `${k}:${v}`).join('  ')}`);
  }

  const judgments = await prisma.modelJudgment.findMany({
    where: { run: { calibrationRunId } },
    select: {
      status: true, verdict: true, pairOrder: true, error: true,
      reasoning: true, reasoningContent: true, reasoningSource: true, reasoningTokens: true,
      rawResponse: true, systemPrompt: true, userPrompt: true, userPromptSha256: true, promptTruncated: true,
      inputTokens: true, outputTokens: true, latencyMs: true, servedModelId: true, finishReason: true, parseMode: true,
      run: { select: { goldenItem: { select: { index: true, expected: true } } } },
    },
    orderBy: { createdAt: 'asc' },
  });

  console.log(`\n── Capture completeness (${judgments.length} judgments) ────────────────`);
  const fields: Array<[string, (j: (typeof judgments)[number]) => unknown]> = [
    ['systemPrompt', (j) => j.systemPrompt],
    ['userPrompt', (j) => j.userPrompt],
    ['userPromptSha256', (j) => j.userPromptSha256],
    ['rawResponse', (j) => j.rawResponse],
    ['reasoning', (j) => j.reasoning],
    ['reasoningContent', (j) => j.reasoningContent],
    ['reasoningTokens', (j) => j.reasoningTokens],
    ['inputTokens', (j) => j.inputTokens],
    ['outputTokens', (j) => j.outputTokens],
    ['servedModelId', (j) => j.servedModelId],
    ['finishReason', (j) => j.finishReason],
  ];
  for (const [label, get] of fields) {
    console.log(`  ${label.padEnd(18)} ${judgments.filter((j) => get(j) != null).length}/${judgments.length}`);
  }

  const first = judgments.find((j) => j.status === 'completed');
  if (first) {
    console.log(`\n── One judgment in full (item ${first.run.goldenItem?.index}) ──────────────`);
    console.log(`  expected ${first.run.goldenItem?.expected}   verdict ${first.verdict}   pairOrder ${first.pairOrder}`);
    console.log(`  servedModelId ${first.servedModelId}   finishReason ${first.finishReason}   parseMode ${first.parseMode}`);
    console.log(`  tokens in=${first.inputTokens} out=${first.outputTokens} reasoning=${first.reasoningTokens}   latency ${first.latencyMs}ms`);
    console.log(`  systemPrompt ${cap(first.systemPrompt)}   userPrompt ${cap(first.userPrompt)} (truncated=${first.promptTruncated}, sha256=${first.userPromptSha256?.slice(0, 12)}…)`);
    console.log(`  rawResponse ${cap(first.rawResponse)}   reasoningContent ${cap(first.reasoningContent)} [source=${first.reasoningSource}]`);
    console.log(`\n  --- reasoningContent (first 700 chars) ---\n${(first.reasoningContent ?? '(none)').slice(0, 700)}`);
    console.log(`\n  --- rawResponse (first 400 chars) ---\n${(first.rawResponse ?? '(none)').slice(0, 400)}`);
  }

  const failed = judgments.filter((j) => j.status === 'error');
  if (failed.length) {
    console.log(`\n── Failures (${failed.length}) ──────────────────────────────────────`);
    for (const f of failed.slice(0, 10)) {
      console.log(`  item ${f.run.goldenItem?.index}: ${f.error}`);
      console.log(`     finishReason=${f.finishReason} out=${f.outputTokens} reasoning=${cap(f.reasoningContent)}`);
    }
  }

  if (score.disagreements.length) {
    console.log(`\n── Disagreements (${score.disagreements.length}) ─────────────────────────`);
    for (const d of score.disagreements.slice(0, 10)) console.log(`  ${JSON.stringify(d)}`);
  }
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
