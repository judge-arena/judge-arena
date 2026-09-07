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
 *   - the CONSTANT FLOOR beside it, over the SAME denominator: what a judge
 *     stamping the key's plurality class on every scored item would score, and
 *     the margin above it. It moves with the denominator (17/30 = 0.5667 on
 *     the full set, 14/25 = 0.5600 on run 9's scored subset), so it is
 *     computed per run and never cached — and only the subset floor is
 *     printed, because two floors on one screen get the wrong one quoted;
 *   - kappa BESIDE it, labelled with its method, never instead of it: ground
 *     truth is an answer key, not a peer rater, so chance-correcting on its
 *     marginal is a category error, and kappa is not comparable across sets —
 *     which is exactly what a leaderboard wants to do;
 *   - the RAW verdict distribution, because a judge that answers 'A' every
 *     time is the failure a good-looking accuracy on a 17/13 corpus hides;
 *   - every disagreement with the model's own reasoning, because being able to
 *     read WHY it was wrong is the point of capturing the thinking channel;
 *   - TIME TO COMPUTE, per (dataset, item, model) tuple, beside the capture
 *     completeness — a leaderboard entry without its cost is half a result,
 *     and on a CPU-hosted judge (measured here: 16.1s to 95.1s per item) the
 *     cost is the difference between a usable judge and an unusable one.
 *
 * ── THE 5-MINUTE ALERT COMES BACK HERE ─────────────────────────────────────
 * The owner asked for an alert "back to running process if it's surpassing
 * 5min". THIS is that running process: the CLI is what a human is watching
 * while a calibration executes on the worker. The poll loop below therefore
 * reports any judgment that has been `running` past the initial budget, with
 * the judge's latency baseline for context when one exists — derived entirely
 * from `ModelJudgment.startedAt`, with NO schema change and NO probe of the
 * inference server (the owner was explicit: "DON'T POLL THE SERVER").
 *
 * Usage:
 *   npm run calibration:run -- --golden-set=<id> --judge-version=<id>
 *   npm run calibration:run -- --score-only=<calibrationRunId>
 */
import { prisma } from '@/lib/db';
import { launchCalibrationRun } from '@/lib/calibration/launch';
import { isPairOrder } from '@/lib/pair-order';
import {
  describeBaseline,
  formatDurationMs,
  judgeLatencyBaseline,
  selectOverdue,
  summarizeLatencies,
  timeToComputeByTuple,
  type LatencyBaseline,
} from '@/lib/calibration/latency';
import { formatReasoningLengthLine, summarizeReasoningLength } from '@/lib/calibration/reasoning-length';
import { formatConstantBaselineLines, formatSelectiveAccuracyLines, formatNoVerdictRateLine } from '@/lib/calibration/baseline';
import { scoreCalibrationRun } from '@/lib/calibration/score';
import { SCORING_RULES_VERSION, describeScoringVersion } from '@/lib/calibration/scoring-version';
import { canonicalJson, describeSamplingSnapshot, detectSamplingDrift } from '@/lib/calibration/sampling-drift';
import { accountTokens, formatTokenAccountingLines } from '@/lib/calibration/token-accounting';
// The alert wording and the budgets it thresholds on live with the timeout
// policy, not here — see `reportOverdue`.
import { buildInitialBudgetAlert, resolveTimeoutBudgets } from '@/lib/llm/timeout-policy';

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

/**
 * Report any judgment of this calibration that has been `running` past the
 * initial budget — once per attempt, not once per poll.
 *
 * THE WORDING IS NOT WRITTEN HERE. `buildInitialBudgetAlert`
 * (src/lib/llm/timeout-policy.ts) is the one implementation of the owner's
 * two-branch message, and the budgets come from `resolveTimeoutBudgets()`
 * rather than a constant of this script's own. Both are deliberate: an alert
 * the worker raises and an alert the CLI raises about the SAME condition,
 * phrased differently or thresholded differently, is two policies wearing one
 * name — and the one an operator reads would be the one that is wrong.
 *
 * `alerted` is keyed on (judgment id + claim timestamp), not on the id alone:
 * a reclaimed or retried judgment gets a fresh `startedAt` (claim.ts:107,138),
 * and that second attempt going long is news again. Keying on the id alone
 * would announce the first attempt and then stay silent through the second.
 *
 * `baselines` caches only the baselines that EXIST. A `null` is re-queried on
 * the next alert on purpose: `null` means "this judge has not completed
 * anything yet", which is precisely the state a calibration in flight is
 * expected to leave — the first item to land turns it into a real baseline,
 * and a cached `null` would keep reporting "no baseline" for the rest of the
 * run.
 */
async function reportOverdue(
  calibrationRunId: string,
  alerted: Set<string>,
  baselines: Map<string, LatencyBaseline>
): Promise<void> {
  const running = await prisma.modelJudgment.findMany({
    where: { run: { calibrationRunId }, status: 'running' },
    select: {
      id: true,
      startedAt: true,
      judgeModelVersionId: true,
      run: { select: { goldenItem: { select: { index: true } } } },
    },
  });

  const budgets = resolveTimeoutBudgets();
  const overdue = selectOverdue(
    running.map((r) => ({
      id: r.id,
      startedAt: r.startedAt,
      judgeModelVersionId: r.judgeModelVersionId,
      goldenItemIndex: r.run.goldenItem?.index ?? null,
    })),
    Date.now(),
    budgets.initialBudgetMs
  );

  for (const j of overdue) {
    const key = `${j.id}@${j.startedAt.toISOString()}`;
    if (alerted.has(key)) continue;
    alerted.add(key);

    let baseline: LatencyBaseline | null = null;
    if (j.judgeModelVersionId) {
      baseline = baselines.get(j.judgeModelVersionId) ?? (await judgeLatencyBaseline(j.judgeModelVersionId));
      if (baseline) baselines.set(j.judgeModelVersionId, baseline);
    }

    const alert = buildInitialBudgetAlert({
      elapsedMs: j.elapsedMs,
      budgets,
      baseline,
      judgeModelVersionId: j.judgeModelVersionId ?? undefined,
    });

    console.log(`  ⚠ ALERT [${alert.kind}]  item ${j.goldenItemIndex ?? '?'}  judgment ${j.id}`);
    console.log(`     ${alert.message}`);
  }
}

async function main(): Promise<void> {
  const goldenSetId = arg('golden-set');
  const judgeModelVersionId = arg('judge-version');
  const scoreOnly = arg('score-only');
  const pollTimeoutSec = Number(arg('poll-timeout') ?? '3600');

  // A2: which candidate orders to launch each item under. Comma-separated,
  // e.g. `--orders=AB,BA` for a paired sweep; the FLAG OMITTED entirely
  // defaults to `['AB']` so every existing invocation is unchanged.
  //
  // F3 (review round 1): `--orders=` (present, empty value) is NOT the same
  // as omitting the flag, and must not be treated as one — `arg()` returns
  // `''` for it, and `'' ? ... : ['AB']` is falsy, so the old `ordersArg ?
  // ordersArg.split(',') : ['AB']` silently fell back to `['AB']` for BOTH
  // cases. Distinguishing `undefined` (omitted) from `''` (typed, empty) up
  // front lets the empty string be rejected: `''.split(',')` yields `['']`,
  // which fails `isPairOrder('')` — the empty string is not a valid pair order.
  const ordersArg = arg('orders');
  const orders = ordersArg === undefined ? ['AB'] : ordersArg.split(',').map((o) => o.trim());
  if (!orders.every(isPairOrder)) {
    throw new Error(`--orders must be a comma-separated list of AB and/or BA; got ${JSON.stringify(ordersArg)}`);
  }

  let calibrationRunId: string;
  // The header's launch-time snapshot (v2k, CalibrationRun.samplingParams).
  // `null` means launched before the column existed — see describeSamplingSnapshot.
  let headerSampling: unknown;

  if (scoreOnly) {
    calibrationRunId = scoreOnly;
    console.log(`Scoring existing calibration run ${calibrationRunId} (no launch).`);
    const header = await prisma.calibrationRun.findUnique({
      where: { id: calibrationRunId },
      select: { samplingParams: true },
    });
    if (!header) throw new Error(`No CalibrationRun ${calibrationRunId}.`);
    headerSampling = header.samplingParams;
    console.log(`  sampling  ${describeSamplingSnapshot(headerSampling)}`);
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
    console.log(
      `  sampling  ${JSON.stringify(version.samplingDefaults)}  ` +
        '(version.samplingDefaults — RAW and MUTABLE; the run\'s resolved snapshot is printed after launch)'
    );
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
      orders,
    });
    calibrationRunId = launched.calibrationRunId;
    console.log(`  calibrationRunId ${calibrationRunId}`);
    headerSampling = launched.samplingParams;
    console.log(`  sampling  ${canonicalJson(launched.samplingParams)}  (snapshot on CalibrationRun.samplingParams — resolved, immutable)`);
    console.log(`  accepted ${launched.accepted.length}   failed ${launched.failed.length}`);
    for (const f of launched.failed) console.log(`    ✗ ${f.goldenItemId}: ${f.reason}`);
    // The stacked-limits warning (runbook §8.6). Printed under the launch
    // line, where the operator is looking: a warning that exists only in the
    // worker log is one nobody reads until the run has already stalled.
    if (launched.budgetWarning) console.log(`  ⚠ BUDGET  ${launched.budgetWarning}`);
    if (launched.accepted.length === 0) throw new Error('Nothing was accepted — stopping before the poll.');
  }

  // Judgments execute on the worker, through RabbitMQ. Poll terminal states
  // rather than sleeping a fixed time: a local reasoning model is slow and
  // variable, and a wrong fixed wait either truncates the run or wastes the
  // difference.
  const deadline = Date.now() + pollTimeoutSec * 1000;
  let lastLine = '';
  // Alert bookkeeping, held across polls — see `reportOverdue`.
  const alerted = new Set<string>();
  const baselines = new Map<string, LatencyBaseline>();
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

    // The owner's "send alert back to running process if it's surpassing
    // 5min". Runs BEFORE the terminal-state break, so an alert cannot be
    // skipped by the poll that happens to observe the last judgment landing.
    // Cheap enough to run every 5s: one indexed read of the `running` rows,
    // and the baseline query only fires when something is actually overdue.
    if (by.running) await reportOverdue(calibrationRunId, alerted, baselines);

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
  // The floor over the SAME denominator as the line above — never the whole
  // set's. Zero lines when nothing was scored. The rendering (including the
  // `<=` that decides the ⚠) is in src/lib/calibration/baseline.ts, where the
  // unit suite pins it: this file is outside every coverage include and has no
  // harness, so a template built here would ship untested.
  for (const line of formatConstantBaselineLines(score)) console.log(line);
  // Coverage and selective accuracy, with the floor over the COMMITTED subset —
  // never the full one. On this corpus that choice flips the margin's SIGN for
  // two of four judges, which is the same class of error v2l exists to prevent.
  // The rendering, including the `<=` that decides the ⚠ and the CHOICE of
  // floor, is in src/lib/calibration/baseline.ts where the unit suite pins it.
  for (const line of formatSelectiveAccuracyLines(score)) console.log(line);
  console.log(`  kappa      ${fmt(score.kappa)}   method ${JSON.stringify(score.method)}`);
  console.log(`  itemCount ${score.itemCount}   missingVerdicts ${score.missingVerdicts}`);
  // The DENOMINATOR those missing verdicts are missing FROM, and their rate.
  // Its own line, under its own label, outside the coverage block on purpose:
  // coverage is what the JUDGE did, this is what the FLEET did, and a reader
  // who sees them under one heading reads a truncation as an abstention.
  for (const line of formatNoVerdictRateLine(score)) console.log(line);
  // WHICH RULES produced every number above. Scoring is ex post and re-runnable,
  // so a stored figure is uninterpretable without its generation — and this is
  // the generation the row was just stamped with, read from the constant rather
  // than written as a literal.
  console.log(`  scoring    ${describeScoringVersion(SCORING_RULES_VERSION)}`);
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
      // What each judgment was EXECUTED under — compared against the header
      // snapshot below (v2k).
      samplingParams: true,
      // The model leg of the (dataset, item, model) tuple. Read here so the
      // time-to-compute block can print a per-judge baseline in --score-only
      // mode too, where no judge id was passed on the command line.
      judgeModelVersionId: true,
      run: { select: { goldenItem: { select: { index: true, expected: true } } } },
    },
    orderBy: { createdAt: 'asc' },
  });

  // ── Sampling drift (v2k) ─────────────────────────────────────────────────
  // Header = what the run was LAUNCHED under; each completed judgment = what
  // it was EXECUTED under. Equal by construction unless the version row was
  // edited while the run drained — runbook §8.8's "mixture of two
  // experiments". The comparison lives in src/lib (JSONB reorders keys).
  const drift = detectSamplingDrift(headerSampling, judgments);
  if (drift.kind === 'moved_mid_run') {
    console.log(`\n  ⚠ sampling config MOVED MID-RUN — completed judgments ran under ${drift.executedUnder.join('  and  ')}.`);
    console.log('    This run is a mixture of two experiments (runbook §8.8): void it and re-run whole under a NEW version ordinal.');
  } else if (drift.kind === 'differs_from_header') {
    console.log(`\n  ⚠ sampling config differs from the launch snapshot — header ${drift.header}, judgments ${drift.executedUnder}.`);
    console.log('    The version row was edited between launch and execution; the header is what was intended, the judgments are what ran.');
  }

  console.log(`\n── Capture completeness (${judgments.length} judgments) ────────────────`);
  const fields: Array<[string, (j: (typeof judgments)[number]) => unknown]> = [
    ['systemPrompt', (j) => j.systemPrompt],
    ['userPrompt', (j) => j.userPrompt],
    ['userPromptSha256', (j) => j.userPromptSha256],
    ['rawResponse', (j) => j.rawResponse],
    ['reasoning', (j) => j.reasoning],
    ['reasoningContent', (j) => j.reasoningContent],
    // #10 (handoff 2026-09-01 §7): usage-reported, and NULL on every backend
    // this fleet runs — llama.cpp and Ollama send no completion_tokens_details,
    // the Anthropic adapter never sets it. Kept as a LABELLED line rather than
    // deleted so a backend that does emit the split (vLLM, OpenAI-shaped)
    // still shows a regression here; 0/n on the self-hosted fleet is expected,
    // not a capture failure. Reasoning LENGTH is printed after this loop.
    ['reasoningTokens (usage-reported; expected 0/n on llama.cpp/Ollama)', (j) => j.reasoningTokens],
    ['inputTokens', (j) => j.inputTokens],
    ['outputTokens', (j) => j.outputTokens],
    ['servedModelId', (j) => j.servedModelId],
    ['finishReason', (j) => j.finishReason],
    // Runtime is a captured field like the others, and its completeness is
    // the one that decides whether the time-to-compute block below describes
    // the run or only the part of it that happened to succeed.
    ['latencyMs', (j) => j.latencyMs],
  ];
  for (const [label, get] of fields) {
    console.log(`  ${label.padEnd(18)} ${judgments.filter((j) => get(j) != null).length}/${judgments.length}`);
  }

  // The signal that IS available on every backend: how much the judge wrote
  // in its thinking channel. SPLIT BY STATUS, because §5.2 of the 2026-09-01
  // handoff read a CONTRAST, not a total — failed n=5 mean 44,287 chars with
  // empty content against completed n=25 mean 13,138. Pooled, that same run
  // prints n=30 mean=18330, which is neither figure and is exactly what a
  // judge that merely writes long also prints. The Failures block below
  // already shows each failing item's chars via cap(); these two lines give
  // the completed-population baseline to read them against, in the report
  // rather than only in a psql session. Template, label and null branch are
  // in the TESTED module, not in this untestable file.
  for (const status of ['completed', 'error'] as const) {
    console.log(
      formatReasoningLengthLine(
        summarizeReasoningLength(judgments.filter((j) => j.status === status).map((j) => j.reasoningContent)),
        status
      )
    );
  }

  // ── Time to compute ───────────────────────────────────────────────────────
  // Beside capture completeness, because it is the same kind of fact: a
  // leaderboard entry without its cost is half a result. Everything here is a
  // PROJECTION over rows that already exist (A2.3) — no column was added to
  // produce it, and re-running this script recomputes rather than accumulates.
  const tuples = await timeToComputeByTuple({ calibrationRunId });
  const measured = judgments.filter((j) => j.latencyMs != null);
  const perJudgment = summarizeLatencies(judgments.map((j) => j.latencyMs));

  console.log('\n── Time to compute — (dataset, item, model) ──────────────────');
  console.log(`  tuples ${tuples.length}   judgments with a recorded runtime ${measured.length}/${judgments.length}`);
  if (perJudgment) {
    console.log(
      `  per judgment  mean ${formatDurationMs(perJudgment.meanMs)}  ` +
        `p50 ${formatDurationMs(perJudgment.p50Ms)}  ` +
        `p90 ${formatDurationMs(perJudgment.p90Ms)}  ` +
        `max ${formatDurationMs(perJudgment.maxMs)}`
    );
    console.log(
      `  attributable compute ${formatDurationMs(tuples.reduce((sum, t) => sum + t.totalMs, 0))} ` +
        `over ${tuples.length} tuple(s)`
    );
  } else {
    // Deliberately NOT "0ms". Nothing was measured; saying zero would read as
    // a run that cost nothing.
    console.log('  no runtime was recorded on any judgment in this run — nothing to report');
  }

  // The FAILURES are the reason this is worth printing separately from the
  // mean: a judgment that burned the whole budget and timed out is the most
  // expensive tuple in the corpus, and it is only visible here because the
  // failure path records a runtime (see markJudgmentError in
  // src/worker/judgment-consumer.ts).
  const slowest = [...tuples].sort((a, b) => b.totalMs - a.totalMs).slice(0, 5);
  if (slowest.length) {
    console.log('  slowest tuples:');
    for (const t of slowest) {
      console.log(
        `    item ${String(t.goldenItemIndex).padEnd(3)} judge ${t.judgeModelVersionId}  ` +
          `${formatDurationMs(t.totalMs)}  (${t.count} judgment(s): ${t.completedCount} completed, ${t.failedCount} failed)`
      );
    }
  }

  // The judge's baseline over ALL its history, not just this run — the same
  // number the timeout policy branches on, printed so this run can be read
  // against what the judge normally does rather than only against itself.
  for (const judgeId of [...new Set(judgments.map((j) => j.judgeModelVersionId).filter((id): id is string => id !== null))]) {
    console.log(`  ${judgeId}: ${describeBaseline(await judgeLatencyBaseline(judgeId))}`);
  }

  const unmeasured = judgments.length - measured.length;
  if (unmeasured > 0) {
    const statuses = [...new Set(judgments.filter((j) => j.latencyMs == null).map((j) => j.status))].join(', ');
    console.log(
      `  ⚠ ${unmeasured} judgment(s) recorded no runtime (status: ${statuses}) — ` +
        'the numbers above are over the rest, not the run.'
    );
  }

  // ── Token accounting (DERIVED) ────────────────────────────────────────────
  // `outputTokens` is `usage.completion_tokens` verbatim, and whether that
  // number includes the reasoning channel varies PER MODEL: granite4.2:3b and
  // qwen3.5:9b are both Ollama, both report `reasoningSource: 'reasoning'`,
  // and they disagree. This block is the only thing in the report that can see
  // a judgment sitting at 82% of its budget while `outputTokens` says 115 —
  // which happened, at `finishReason: 'stop'`, and cost a voided run.
  // The rules live in src/lib and are unit-tested there; this script prints
  // them and owns none of them (CONTRIBUTING.md:247, "put every rule that can
  // be silently wrong into src/lib/** so that it can be unit-tested").
  console.log('\n── Token accounting — DERIVED; outputTokens stays the provider count ──');
  const accountingRows = judgments.map((j) => ({
    goldenItemIndex: j.run.goldenItem?.index ?? null,
    status: j.status,
    outputTokens: j.outputTokens,
    reasoningContent: j.reasoningContent,
    samplingParams: j.samplingParams,
  }));
  for (const line of formatTokenAccountingLines(accountingRows, headerSampling)) console.log(line);

  const first = judgments.find((j) => j.status === 'completed');
  if (first) {
    console.log(`\n── One judgment in full (item ${first.run.goldenItem?.index}) ──────────────`);
    console.log(`  expected ${first.run.goldenItem?.expected}   verdict ${first.verdict}   pairOrder ${first.pairOrder}`);
    console.log(`  servedModelId ${first.servedModelId}   finishReason ${first.finishReason}   parseMode ${first.parseMode}`);
    console.log(`  tokens in=${first.inputTokens} out=${first.outputTokens} reasoning=${first.reasoningTokens} reasoningChars=${first.reasoningContent?.length ?? 'n/a'}   latency ${first.latencyMs}ms`);
    const firstAccounting = accountTokens(first);
    console.log(`  DERIVED  accounting=${firstAccounting.accounting}   estimatedGeneratedTokens=${firstAccounting.estimatedGeneratedTokens ?? 'n/a'}   (out= above is what the provider reported, unchanged)`);
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
