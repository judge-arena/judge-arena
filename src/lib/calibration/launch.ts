/**
 * ─── Calibration launch (A2.1, phase 1) ────────────────────────────────────
 *
 * Turns a golden set into N pairwise `EvaluationRun`s, one per live item, each
 * carrying the `goldenItemId` + `calibrationRunId` that
 * `20260830120000_v2i_calibration_item_link` added. That link is the whole
 * point: before it, a `ModelJudgment` reached an `Evaluation` and stopped —
 * `Evaluation` has a `datasetSampleId` but no golden item — so there was no
 * path from a model verdict to the `expected` it should be scored against, and
 * `CalibrationRun` was a table that only ever got COUNTED (by
 * `isGoldenSetFrozen`) and never written.
 *
 * ── NO PARALLEL EXECUTION PATH ─────────────────────────────────────────────
 * This module creates rows and calls `launchSingleRun` (src/lib/run-launch.ts)
 * N times. It publishes nothing itself, renders nothing, and knows nothing
 * about providers — a calibration run is an ordinary pairwise run with two
 * extra columns set, executed by the same `judgment.execute` consumer as
 * everything else. Deliberately NOT `launchBulkRunCreates`: that publishes
 * `run.create`, and `src/worker/run-create-consumer.ts` REFUSES any protocol
 * but `'pointwise'` up front (`RunCreateMsg` carries no candidate set, so a
 * pairwise expansion would produce judgments with nothing to compare). Every
 * item would come back as a visible errored run.
 *
 * ── ITEM-ATOMIC, NOT ONE BIG TRANSACTION ───────────────────────────────────
 * Each item is created and launched on its own; a failure at item 17 leaves 16
 * launched items and one reported failure, not a 30-way rollback of work that
 * was fine. `src/app/api/evaluations/route.ts:574` is the anti-pattern —
 * a whole dataset mapped into one `$transaction` with no `take`, where one bad
 * row loses every good one (and holds a connection open for the duration). It
 * also could not be done here even if it were desirable: `launchSingleRun`
 * opens its own transaction and then publishes to RabbitMQ, and publishing
 * inside a DB transaction is exactly what run-launch.ts's module doc forbids.
 *
 * ── EVERYTHING KNOWABLE UP FRONT IS CHECKED BEFORE THE FREEZE ──────────────
 * See `launchCalibrationRun`'s doc. The `CalibrationRun` header is written
 * LAST, after every refusal that does not require touching an item, because
 * writing it is irreversible.
 */
import type { GoldenCandidate, Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';
import { goldenItemLifecycleWhere, isGoldenSetFrozen } from '@/lib/golden-sets';
import { budgetWarningFor, judgeThroughputEstimate } from '@/lib/calibration/latency';
import { resolveTimeoutBudgets } from '@/lib/llm/timeout-policy';
// The LEAF module, deliberately — not registry.ts and not the `@/lib/llm`
// barrel. This file is bundled into the image's calibration-run.js by esbuild
// (Dockerfile, only @prisma/client external); importing registry.ts would
// ship every provider SDK, and the barrel would add the redis client on top,
// into a CLI that never calls a provider. tests/lib/sampling.test.ts keeps
// sampling.ts a leaf.
import { effectiveSamplingParams, type SamplingParams } from '@/lib/llm/sampling';
import {
  launchSingleRun,
  requireOwnedActiveEndpoints,
  resolveCurrentPromptTemplate,
  RunLaunchError,
  type LaunchRunCandidateInput,
  type LaunchSingleRunDeps,
} from '@/lib/run-launch';

/**
 * Cap on items per calibration. A STATED LIMIT THAT REFUSES, never a silent
 * `take: N` — a truncated calibration produces a kappa over a subset nobody
 * chose, reported as if it measured the whole set, and there is nothing in
 * the numbers afterwards that says so.
 *
 * ── RAISED FROM 100 TO 1000, 2026-09-03, GATED ON THE DEADLINE FIX ─────────
 * The 100 cap existed because `EvaluationRun.deadlineAt` used to be stamped
 * at CREATION, sized on queue position — a large batch's tail could be
 * force-finalized by `src/worker/reaper.ts` while still healthily queued
 * (the bug that cost 4 of 30 items on a real calibration). That mechanism
 * is gone: `src/worker/claim.ts`'s `stampRunStartedAtFirstDequeue` now
 * stamps the deadline at FIRST DEQUEUE, sized on THIS run's own judgment
 * count (always 1 here) — immune to how long this item waited in queue.
 * See `docs/superpowers/plans/2026-09-03-deadline-at-first-dequeue.md` for
 * the fix and this constant's own raise.
 *
 * 1000 is not "as high as possible" — it is sized against
 * `src/worker/reaper.ts`'s `NEVER_STARTED_TIMEOUT_MS` (45 days), the ONE
 * remaining bound on a never-dequeued run once the execution deadline
 * stops depending on queue position, and it is sized on the LEGAL bound
 * rather than on measured throughput. A calibration serialises through ONE
 * judge's gate; each item may legally run to `hardCapMs` (900_000 ms) and
 * be delivered up to `MAX_ATTEMPTS` (3) times, so 1000 items is
 * 1000 x 3 x 900_000 ms = 750 h = 31.25 days of legal occupancy — inside
 * the 45-day net. (Measured throughput is far kinder: at 5.03 min/item a
 * 30-item calibration ran 151 minutes, which extrapolates to ~3.49 days
 * for 1000 items. That is the EXPECTATION; the net is sized on the bound,
 * because sizing a force-finalize threshold on an expectation is the
 * original defect.) The named target — "JudgeBench pairwise — full", 620
 * items, seeded but previously unrunnable under the 100 cap — is 19.4 days
 * of legal occupancy and ~52 hours expected, inside both.
 *
 * `tests/integration/finalization.test.ts` pins the RELATIONSHIP
 * (`NEVER_STARTED_TIMEOUT_MS > MAX_CALIBRATION_ITEMS x 3 x hardCapMs`), not
 * a second literal, so raising this number again without revisiting the net
 * goes red rather than silently re-arming the bug.
 *
 * WHAT STILL BOUNDS THIS NUMBER, so it is not "raise it again next time
 * someone wants more": (1) `NEVER_STARTED_TIMEOUT_MS` — raising the item
 * cap further without ALSO reconsidering that timeout reopens the exact
 * race this constant's previous form existed to prevent, just relocated
 * from "queue position at creation" to "never-started safety net fires
 * before the batch finishes draining"; (2) ONE max-size batch per judge
 * lane at a time — the net measures wall clock from `createdAt`, so
 * concurrent batches on the same lane SUM and two of these would exceed
 * it; (3) wall-clock reality — 1000 items at the measured throughput is
 * ~3.5 days for ONE judge against a single-slot server, an operational
 * cost this constant does not make disappear, only survivable;
 * (4) `scripts/calibration/run.ts`'s own `--poll-timeout` (default 3600s)
 * must be raised by the operator to watch a run this size to completion —
 * unrelated to correctness, but worth knowing before launching one.
 */
export const MAX_CALIBRATION_ITEMS = 1000;

export interface LaunchCalibrationRunParams {
  goldenSetId: string;
  judgeModelVersionId: string;
  rubricId: string;
  /** Project the per-item `Evaluation` rows are created under. */
  projectId: string;
  /** The acting user: owns the endpoint the judge is reached through, and is
   * recorded as `EvaluationRun.triggeredById` on every run. */
  triggeredById: string;
}

export interface CalibrationItemFailure {
  goldenItemId: string;
  reason: string;
}

export interface CalibrationLaunchResult {
  calibrationRunId: string;
  /** GoldenItem ids that produced a run — NOT run ids, mirroring
   * `launchBulkRunCreates`' contract, where `accepted` and `failed[].` carry
   * the same identifier so the two lists can be read against one input set. */
  accepted: string[];
  failed: CalibrationItemFailure[];
  /**
   * TRUE when THIS launch is the one that froze the golden set (no
   * `CalibrationRun` referenced it before). There is no unfreeze, so a caller
   * that can warn a human should warn on exactly this — after the fact is the
   * only moment the answer is known for certain, and "it was already frozen"
   * is not worth a warning.
   */
  frozeGoldenSet: boolean;
  /**
   * The EFFECTIVE `{ temperature, max_tokens }` snapshotted on the header
   * (`CalibrationRun.samplingParams`, v2k) — resolved, never the version's raw
   * `samplingDefaults`. Returned so a caller can print what the run was
   * launched under without re-reading the row.
   */
  samplingParams: SamplingParams;
  /**
   * The stacked-limits warning (runbook §8.6), or `null` when the effective
   * `max_tokens` fits under the hard cap at this judge's measured throughput
   * — OR when the judge has no completed judgment to measure. A WARNING,
   * never a refusal: the run has launched either way. Callers fronting a
   * human should print it; the launch has already logged it. The figure in
   * it is a LOWER bound on duration (throughput decays with output length).
   */
  budgetWarning: string | null;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A golden item's candidates map onto a run's field for field — `RunCandidate`
 * and `GoldenCandidate` were defined as the same shape with different parents
 * precisely so this needs no reshaping. */
function toRunCandidates(candidates: GoldenCandidate[]): LaunchRunCandidateInput[] {
  return candidates.map((candidate) => ({
    position: candidate.position,
    promptText: candidate.promptText,
    responseText: candidate.responseText,
    label: candidate.label,
  }));
}

/**
 * ╔════════════════════════════════════════════════════════════════════════╗
 * ║  THIS FUNCTION FREEZES THE GOLDEN SET, IRREVERSIBLY, AND THERE IS NO   ║
 * ║  UNFREEZE ANYWHERE IN THE PRODUCT.                                     ║
 * ╚════════════════════════════════════════════════════════════════════════╝
 *
 * `isGoldenSetFrozen` (src/lib/golden-sets.ts) is defined as
 * `calibrationRun.count({ where: { goldenSetId } }) > 0`. The moment the
 * `CalibrationRun` header below is committed, that count is 1 and the set's
 * items, candidates, `protocol` and `expected` are read-only FOREVER: no
 * verb un-freezes it, deleting the calibration is not a thing anyone can do
 * (and `EvaluationRun.calibrationRunId` is `onDelete: Restrict` anyway), and
 * `retiredAt`/`tombstonedAt` do not release it either. The only way to change
 * a frozen set's content is `POST /api/golden-sets/[id]/fork`, which makes a
 * NEW set at version+1. Callers that front a human MUST confirm before calling
 * this; `result.frozeGoldenSet` says whether this call was the one that did it.
 *
 * BECAUSE THAT WRITE IS IRREVERSIBLE, EVERYTHING KNOWABLE WITHOUT TOUCHING AN
 * ITEM IS CHECKED FIRST — the set exists, is not tombstoned, is pairwise, has
 * at least one live item and not more than `MAX_CALIBRATION_ITEMS`; the
 * project and rubric exist; a pairwise `PromptTemplate` exists; and the caller
 * owns an active, verified `ModelEndpoint` for the judge version. Every one of
 * those would otherwise surface as a per-item failure DISCOVERED AFTER THE
 * FREEZE — i.e. a golden set pinned forever by a calibration in which all 30
 * items failed for one reason that was knowable before any of them ran.
 * (Per-item failures that genuinely depend on the item — a pair with the wrong
 * number of candidates, say — stay per-item; those are the ones the
 * `failed` list is for.)
 */
export async function launchCalibrationRun(
  params: LaunchCalibrationRunParams,
  deps: LaunchSingleRunDeps = {}
): Promise<CalibrationLaunchResult> {
  const { goldenSetId, judgeModelVersionId, rubricId, projectId, triggeredById } = params;

  // ── Pre-flight (see the doc block: all of this precedes the freeze) ──────

  const goldenSet = await prisma.goldenSet.findUnique({
    where: { id: goldenSetId },
    select: { id: true, name: true, protocol: true, tombstonedAt: true },
  });
  if (!goldenSet) throw new RunLaunchError(404, 'Golden set not found');
  if (goldenSet.tombstonedAt) {
    // A tombstoned set is pending purge and hidden from every read path
    // (`goldenSetLifecycleWhere` pins `tombstonedAt: null` in BOTH arms).
    // Calibrating one would pin it in place forever and publish numbers for a
    // set nobody can look at. A RETIRED set is deliberately still calibratable:
    // A0 defines retirement as "out of circulation, still valid ground truth",
    // and it is reversible.
    throw new RunLaunchError(
      409,
      `Golden set ${goldenSetId} is tombstoned and pending purge; it cannot be calibrated.`
    );
  }
  if (goldenSet.protocol !== 'pairwise') {
    // Phase 1 is pairwise only, and this is a refusal rather than a
    // best-effort: a pointwise import of a preference corpus has NO ground
    // truth at all (`mapSampleToGoldenItem` sets `expected: null` for every
    // pointwise item), so a "calibration" over it would score verdicts against
    // nothing and report an agreement number computed over zero comparisons.
    throw new RunLaunchError(
      400,
      `Calibration runs pairwise golden sets only — golden set ${goldenSetId} is ` +
        `"${goldenSet.protocol}".`
    );
  }

  const items = await prisma.goldenItem.findMany({
    where: { goldenSetId, ...goldenItemLifecycleWhere(false) },
    orderBy: { index: 'asc' },
    include: { candidates: { orderBy: { position: 'asc' } } },
  });

  if (items.length === 0) {
    // Without this the header is written, the set is frozen forever, and the
    // calibration measures nothing. `index` is a high-water mark, not a count,
    // so "every item tombstoned" is a perfectly reachable state.
    throw new RunLaunchError(
      400,
      `Golden set ${goldenSetId} has no live items to calibrate against.`
    );
  }
  if (items.length > MAX_CALIBRATION_ITEMS) {
    // LOGGED, not truncated — see MAX_CALIBRATION_ITEMS' own doc.
    logger.warn('launchCalibrationRun: refused a golden set over the phase-1 item cap', {
      goldenSetId,
      liveItems: items.length,
      cap: MAX_CALIBRATION_ITEMS,
    });
    throw new RunLaunchError(
      400,
      `Golden set ${goldenSetId} has ${items.length} live items, over the phase-1 cap of ` +
        `${MAX_CALIBRATION_ITEMS}. Fork a smaller set rather than calibrating part of this one — ` +
        'a kappa over a silently truncated subset is indistinguishable from one over the whole set.'
    );
  }

  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true } });
  if (!project) throw new RunLaunchError(404, 'Project not found');

  const rubric = await prisma.rubric.findUnique({ where: { id: rubricId }, select: { id: true } });
  if (!rubric) throw new RunLaunchError(404, 'Rubric not found');

  // `launchSingleRun` resolves this per run and throws a 500 if it is missing;
  // reaching that 500 thirty times, after the freeze, for a row the seed is
  // supposed to have created, is the failure this pre-flight exists to avoid.
  const promptTemplate = await resolveCurrentPromptTemplate('pairwise');
  if (!promptTemplate) {
    throw new RunLaunchError(500, 'No PromptTemplate found for protocol "pairwise"');
  }

  // Throws RunLaunchError(400) naming the version — the one pre-flight that
  // fails for a reason the caller can actually fix from the Models page.
  await requireOwnedActiveEndpoints(triggeredById, [judgeModelVersionId]);

  // ── 2026-09-03: no batch deadline computed here anymore ───────────────────
  // This block used to stamp ONE deadline, computed once, on every run in
  // the batch — `now + (#judgments queued ahead of this one) × hardCapMs +
  // slack` — because `launchSingleRun`'s OWN creation-time formula only knew
  // about ONE run's model count, and a 30-item batch created within seconds
  // of itself would otherwise carry ~30 nearly-identical deadlines while the
  // batch itself took 30x as long to drain through one judge's queue.
  // `src/worker/reaper.ts` would then force-finalize the still-healthy tail
  // as `error: 'reaper: abandoned'` — the bug that cost 4 of 30 items on a
  // real calibration.
  //
  // The fix is no longer "widen the formula's denominator" — it's that
  // `EvaluationRun.deadlineAt` is not computed at creation AT ALL any more.
  // `src/worker/claim.ts`'s `stampRunStartedAtFirstDequeue` stamps it once,
  // at FIRST DEQUEUE, sized on THIS run's own judgment count (always 1 for a
  // calibration run) and measured from the moment a worker actually claims
  // it — immune to how many other runs, from this batch or any other, are
  // queued ahead of it. `launchSingleRun` below is called with no
  // `deadlineAt` override; every run this function launches is created with
  // `deadlineAt: null` and stays that way until claimed.

  // ── The stacked-limits check, part 1 of 2: the measurement ────────────────
  // BEFORE the header write, and the placement is load-bearing. This module's
  // rule is stated at :33-37 — "EVERYTHING KNOWABLE UP FRONT IS CHECKED BEFORE
  // THE FREEZE … writing it is irreversible". Every `await` between the header
  // commit and the item loop is a new way for the function to throw with the
  // golden set frozen, the CalibrationRun header committed and ZERO items
  // launched; a purely ADVISORY warning must never be able to do that. This
  // query needs nothing from the transaction (only `judgeModelVersionId`), so
  // it belongs here, where a connection blip fails the launch exactly the way
  // the `$transaction` a few lines below would have failed it anyway — before
  // anything irreversible exists.
  //
  // `resolveTimeoutBudgets()` reads `env` and does arithmetic — cheap, and
  // this is now its only call in this module (the batch-deadline call it
  // used to share the file with was deleted 2026-09-03; see the "no batch
  // deadline computed here anymore" block above).
  //
  // The rate cannot come from the endpoint verify probe (verify.ts sends
  // max_tokens 1, and one token is not a rate) — only from this judge's own
  // completed history.
  const throughput = await judgeThroughputEstimate(judgeModelVersionId);
  const hardCapMs = resolveTimeoutBudgets().hardCapMs;

  // ── The irreversible write ───────────────────────────────────────────────
  // The count and the create share one transaction because that is the shape
  // `isGoldenSetFrozen` requires: it takes a transaction client so a freeze
  // check and the write it guards can never straddle a commit boundary.
  //
  // IT DOES NOT SERIALIZE TWO CONCURRENT LAUNCHES, and nothing here should
  // claim it does. Prisma runs an interactive transaction at the database
  // default isolation level, which on Postgres is READ COMMITTED, so two
  // launches of the same set can both read a count of 0 and both insert a
  // header — and both then report `frozeGoldenSet: true` for a single freeze.
  // That is an extra warning, not lost data (the set is frozen either way, and
  // a second CalibrationRun on one set is legitimate: a different judge), so it
  // is left as it stands rather than paying for a `SELECT ... FOR UPDATE` on
  // the set to sharpen a flag whose only consumer is a human-facing prompt.
  const { calibrationRun, wasAlreadyFrozen, samplingParams } = await prisma.$transaction(async (tx) => {
    const alreadyFrozen = await isGoldenSetFrozen(tx, goldenSetId);
    // Read in the SAME transaction as the header write so the snapshot and
    // the irreversible header commit together. `requireOwnedActiveEndpoints`
    // above already refused (400) any version the caller cannot reach, so
    // this null arm guards against a concurrent delete; it is not a refusal
    // an operator will see.
    const version = await tx.judgeModelVersion.findUnique({
      where: { id: judgeModelVersionId },
      select: { samplingDefaults: true },
    });
    if (!version) throw new RunLaunchError(404, 'Judge model version not found');
    // RESOLVED, NOT RAW: the same `effectiveSamplingParams` the worker's
    // pairwise seam resolves per call (registry.ts prepareJudgmentCall; the
    // consumer's pairwise seam passes no overrides), so this equals every
    // ModelJudgment.samplingParams of the run unless the version row moves
    // mid-run — header ≠ judgment is the detector. (One latent third case:
    // judgment-consumer.ts's `result.samplingParamsUsed ?? version
    // .samplingDefaults` fallback persists the RAW field, which can never
    // equal a resolved header. It exists for pre-Task-10 fixtures and no
    // in-tree caller reaches it.) The raw field would store NULL for a
    // version without defaults, and NULL must mean only "pre-v2k".
    const resolved = effectiveSamplingParams(version.samplingDefaults);
    const created = await tx.calibrationRun.create({
      data: {
        goldenSetId,
        judgeModelVersionId,
        // The pairwise SYSTEM prompt renders this rubric's criteria, so a
        // kappa produced under rubric X is not comparable to one under
        // rubric Y. Recorded on the header so the number is interpretable
        // without joining through a run.
        rubricId,
        // Pinned for the same reason as rubricId: `samplingDefaults` is
        // mutable, and a join through the version reports today's config for
        // a historical run (scoreboard spec §4.1; seed-core.ts:223-229 states
        // the invariant the production SQL edits broke).
        samplingParams: resolved as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    return { calibrationRun: created, wasAlreadyFrozen: alreadyFrozen, samplingParams: resolved };
  });

  logger.info('launchCalibrationRun: golden set is now frozen (irreversible)', {
    goldenSetId,
    calibrationRunId: calibrationRun.id,
    items: items.length,
    frozeGoldenSet: !wasAlreadyFrozen,
    samplingParams,
  });

  // ── The stacked-limits check, part 2 of 2: the rule (runbook §8.6) ────────
  // Pure, so it adds no failure point past the freeze. It reads the RESOLVED
  // `samplingParams` the transaction just snapshotted — the effective
  // max_tokens every judgment of this run will execute under — not the raw,
  // nullable samplingDefaults. A warning and never a refusal: a first-ever
  // judge has no completed judgment to measure, and refusing would make the
  // first calibration of every judge impossible.
  const budgetWarning = budgetWarningFor({ maxTokens: samplingParams.max_tokens, throughput, hardCapMs });
  if (budgetWarning !== null) {
    logger.warn("launchCalibrationRun: max_tokens cannot be produced inside the hard cap at this judge's measured throughput", {
      goldenSetId,
      calibrationRunId: calibrationRun.id,
      judgeModelVersionId,
      maxTokens: samplingParams.max_tokens,
      // The WHOLE estimate as one key, NOT `tokPerSec: throughput?.tokPerSec`
      // / `n: throughput?.n`. `budgetWarning !== null` already implies
      // `throughput !== null` — `budgetWarningFor` returns null on its first
      // line when the throughput is null — so each `?.` would contribute a
      // branch arm that NO test can ever make the deciding clause. launch.ts
      // is in the db coverage denominator (BRF:31 today), so those two dead
      // arms would be permanently-uncovered branches in the one task whose
      // coverage gate is knife-edge, and they are exactly the "unreachable
      // guard" class this plan invokes in Task 1 to justify its NaN row.
      throughput,
      hardCapMs,
      warning: budgetWarning,
    });
  }

  // ── One item, one launch ─────────────────────────────────────────────────

  const accepted: string[] = [];
  const failed: CalibrationItemFailure[] = [];

  for (const item of items) {
    try {
      // A pairwise `Evaluation` carries NO `responseText` by construction: the
      // two responses are the candidates, and `Evaluation` has room for one.
      // `launchSingleRun` knows this — it forces judge mode for pairwise
      // rather than letting `deriveRunMode` read the empty column and classify
      // the run as respond-mode.
      // eslint-disable-next-line no-await-in-loop -- item-atomic by design: each item's create+launch must be individually attributable and individually survivable (see module doc)
      const evaluation = await prisma.evaluation.create({
        data: {
          projectId,
          userId: triggeredById,
          rubricId,
          inputText: item.inputText,
          // Otherwise a calibration's N evaluations are indistinguishable from
          // each other in every list view that shows a title.
          title: `Calibration: ${goldenSet.name} #${item.index}`,
        },
        select: { id: true },
      });

      // eslint-disable-next-line no-await-in-loop -- see above
      const launch = await launchSingleRun(
        {
          evaluationId: evaluation.id,
          triggeredById,
          rubricId,
          judgeModelVersionIds: [judgeModelVersionId],
          protocol: 'pairwise',
          candidates: toRunCandidates(item.candidates),
          goldenItemId: item.id,
          calibrationRunId: calibrationRun.id,
        },
        deps
      );

      if (launch.publishFailed) {
        // The run exists and `launchSingleRun` has already compensated it to
        // `status: 'error'`; nothing will ever execute it. Reported as a
        // failure rather than silently counted as accepted — a caller that
        // treated it as launched would wait forever for a verdict.
        failed.push({
          goldenItemId: item.id,
          reason: launch.publishError ?? 'judgment.execute publish failed',
        });
        continue;
      }

      accepted.push(item.id);
    } catch (error) {
      // Per-item, never fatal to the batch. The `Evaluation` row may survive
      // with no run attached when `launchSingleRun` is what threw; that is
      // deliberate — deleting it here is a second write on an already-failing
      // path, and an orphan evaluation is inert (no runs, no judgments, no
      // effect on any calibration number) where a failed cleanup is not.
      failed.push({ goldenItemId: item.id, reason: reasonOf(error) });
    }
  }

  if (failed.length > 0) {
    logger.warn('launchCalibrationRun: some items did not launch', {
      goldenSetId,
      calibrationRunId: calibrationRun.id,
      accepted: accepted.length,
      failed: failed.length,
    });
  }

  return {
    calibrationRunId: calibrationRun.id,
    accepted,
    failed,
    frozeGoldenSet: !wasAlreadyFrozen,
    samplingParams,
    budgetWarning,
  };
}
