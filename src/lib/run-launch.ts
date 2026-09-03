/**
 * ─── Run Launch (web-tier RabbitMQ producer) ────────────────────────────────
 *
 * Replaces `src/lib/evaluation-run-manager.ts`'s in-process run engine
 * (`enqueueRunProcessing`/`enqueueEvaluationRunCreation`/`processRun`,
 * deleted in Task 9) with two publish-then-return functions. The web tier
 * no longer executes judgments itself — it creates rows and hands off to
 * RabbitMQ (`judgment.execute` for a fully-specified single run, `run.create`
 * for a bulk dataset launch that the worker's `run-create-consumer.ts`
 * expands) for `src/worker/*` to actually run.
 *
 * ── Task 12: runtime switches to JudgeModelVersion identity ────────────────
 * Through Task 9/11 this module resolved a `judgeModelVersionId` for each
 * SELECTED `ModelConfig` via `ensureJudgeIdentityForModelConfig`
 * (`src/lib/judge-identity.ts`, a temporary find-or-create bridge) and
 * dual-wrote `modelConfigId` + `judgeModelVersionId` on every created row.
 * Task 12 REVERSES that: `EvaluationModelSelection`/`RunModelSelection` now
 * carry `judgeModelVersionId` directly (selected by the user from their own
 * `ModelEndpoint`s via `/api/models` and `/api/evaluations`), so this module
 * reads that column straight off the evaluation's stored selections (or an
 * explicit `judgeModelVersionIds` override) — no bridge, no ModelConfig
 * lookup, no new `JudgeModel`/`JudgeModelVersion`/`ModelEndpoint` rows are
 * ever created here. `judge-identity.ts` had exactly one caller (this
 * module) and is deleted along with it.
 *
 * `modelConfigId` is left `null` on every row this module creates —
 * "resolve modelConfigId for legacy dual-write via a version->modelConfig
 * back-reference IF one exists, else null" per the task brief; no such
 * back-reference is tracked anywhere in the schema (a `JudgeModelVersion`
 * created via the catalog or a custom-model POST was never derived FROM a
 * `ModelConfig`), so this is unconditionally `null` for new rows. Every
 * downstream reader of `modelConfigId` has been null-guarded since Task 6;
 * readers now prefer the `judgeModelVersion`/`judgeModel` join when present
 * (see e.g. `src/app/api/leaderboard/route.ts`).
 *
 * ── Ownership: no cross-user endpoint borrow at launch time ─────────────────
 * Before publishing anything, both `launchSingleRun` and
 * `launchBulkRunCreates` verify that `triggeredById` (the acting user) has
 * their OWN active, verified `ModelEndpoint` for every selected
 * `JudgeModelVersion` — see `requireOwnedActiveEndpoints` below. This is the
 * web-tier half of the Task 12 "no cross-user endpoint borrow" requirement;
 * the worker-side half (`src/worker/judgment-consumer.ts`'s `resolveEndpoint`)
 * independently enforces the same rule at execution time (defense in depth —
 * a run launched validly could still hit a missing endpoint later if the
 * user deletes their key between launch and execution).
 *
 * ── v2j: this module also decides which LANE each judgment goes to ──────────
 * `requireOwnedActiveEndpoints` returns the endpoint URL it validated for each
 * version, and `judgment.execute` is published with the lane queue for that
 * URL's origin as its routing key (`src/lib/queue/lanes.ts`). Both halves come
 * out of the query that was already running, so routing costs nothing extra —
 * and, crucially, the two tiers now select the SAME `ModelEndpoint` row via
 * `src/lib/endpoint-resolution.ts`, so the lane always names the server the
 * worker will actually call. Failing to resolve a lane never fails a publish:
 * see `resolveDestinationQueue`.
 *
 * ── launchSingleRun ──────────────────────────────────────────────────────
 * Used by both `POST /api/evaluations` (single-text `create_and_run`) and
 * `POST /api/evaluations/[id]/runs`. One `$transaction` creates the
 * `EvaluationRun` + its `RunModelSelection`s + `ModelJudgment` rows (all
 * `pending`, `judgeModelVersionId` set directly from the resolved selection
 * list). The transaction ends BEFORE any queue publish — publishing inside a
 * transaction would hold a DB connection/lock open across N network round
 * trips to RabbitMQ, and a publish failure would roll back rows whose queue
 * messages the broker may already have accepted, desyncing the two systems.
 * Each `judgment.execute` is published individually, awaited one at a time
 * (small N — selection is capped at 10 models); the first failure stops the
 * loop (further publishes to the same broker are highly likely to fail
 * identically) and the already-created run is compensated to `status:
 * 'error'` rather than left stuck `pending` with no worker ever going to see
 * it.
 *
 * ── launchBulkRunCreates ─────────────────────────────────────────────────
 * Used by `POST /api/evaluations`'s dataset-batch and remote-dataset
 * `create_and_run` paths, AFTER the evaluations themselves are already
 * created (transactionally, by the caller — unchanged from before this
 * task). Per evaluation: resolve the rubric + validate the caller's own
 * endpoints for its stored `judgeModelVersionId` selections, publish
 * `run.create`, and record the outcome — a failure for one evaluation
 * (missing rubric, no models, a broker hiccup) does not abort or silently
 * swallow the rest. Returns `{ accepted, failed }` so the route can respond
 * `202` with a per-item status instead of either an all-or-nothing error or
 * a `runsQueued` count that silently under-reports failures.
 *
 * ── A2.1: calibration reuses this module, it does not fork it ──────────────
 * `src/lib/calibration/launch.ts` launches a calibration as N ordinary
 * pairwise runs through `launchSingleRun` — no second execution path, no
 * calibration-specific consumer. It needs exactly two things from a run that
 * an ordinary launch does not set, and both are plain optional params here:
 * `goldenItemId` and `calibrationRunId` (the v2i link columns, NULL on every
 * ordinary run). It deliberately does NOT go through `launchBulkRunCreates`:
 * `src/worker/run-create-consumer.ts` refuses any protocol but `'pointwise'`,
 * because `RunCreateMsg` carries no candidate set to expand a pairwise
 * comparison from.
 *
 * ── 2026-09-03: EvaluationRun.deadlineAt is no longer stamped here ─────────
 * This module used to compute `deadlineAt` at CREATION — `now + (#judgments
 * in this run) × hardCapMs + slack` — and calibration's batch launcher
 * (`src/lib/calibration/launch.ts`) used to override it with the SAME
 * formula over a bigger denominator ("judgments queued ahead of this one"),
 * because sizing a batch's deadline on one run's own model count silently
 * lost the tail of a large batch to `src/worker/reaper.ts` — a
 * queue-position estimate that could be hours, stamped as if the run's OWN
 * work would take minutes. That mechanism is gone: `EvaluationRun.deadlineAt`
 * is now left `null` at creation and is stamped once, at FIRST DEQUEUE, by
 * `src/worker/claim.ts`'s `stampRunStartedAtFirstDequeue` — sized on THIS
 * run's own judgment count, measured from the moment a worker actually
 * claims it, immune to how many other runs are queued ahead of it. See that
 * function's doc for the mechanism and `src/worker/reaper.ts`'s
 * `NEVER_STARTED_TIMEOUT_MS` for the safety net covering a run that is
 * published and never dequeued at all.
 */
import type { Prisma, RunProtocol } from '@prisma/client';
import { prisma } from '@/lib/db';
import { deriveRunMode } from '@/lib/run-mode';
import { logger } from '@/lib/logger';
import {
  publishJudgmentExecute,
  publishRunCreate,
  resolveDestinationQueue,
  type JudgmentExecuteMsg,
  type RunCreateMsg,
} from '@/lib/queue/publish';
import { LANE_FALLBACK_QUEUE } from '@/lib/queue/lanes';
import { resolveEndpointsForVersions } from '@/lib/endpoint-resolution';
import { liveDatasetsOnly, liveSamplesOnly } from '@/lib/tombstones';

/** UNUSED since 2026-09-03: this module no longer computes a deadline at
 * creation (see the module doc's "EvaluationRun.deadlineAt is no longer
 * stamped here" section), and nothing else in the tree imports this export.
 * Confirmed with a command that cannot miss the multi-line
 * `import {\n  X,\n} from '...'` form this repo actually uses (a per-line
 * `grep "import.*NAME"` walks straight past it):
 * `grep -ran "EVALUATION_MODEL_TIMEOUT_MS" src tests | grep -v "^src/lib/run-launch.ts"`
 * returns only comments and `process.env` / env-schema string keys — no
 * value import, before or after this change. Left in place rather
 * than deleted here — removing it is an unrelated cleanup, not a
 * `deadlineAt` behaviour, and this plan's one-concern-per-commit rule is
 * exactly why it stays for now. */
export const EVALUATION_MODEL_TIMEOUT_MS = Number(process.env.EVALUATION_MODEL_TIMEOUT_MS ?? '300000');

export class RunLaunchError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function toRunLaunchHttpError(error: unknown): { status: number; message: string } | null {
  if (error instanceof RunLaunchError) {
    return { status: error.status, message: error.message };
  }
  return null;
}

/**
 * v1's in-process run engine (the now-deleted `evaluation-run-manager.ts`)
 * supported two modes per run: "judge" (score a response against a rubric,
 * `executeJudgment`) and "respond" (generate a model response with no
 * rubric, `executeRespond`). Task 9b (Trijeet decision 2026-07-29) restores
 * respond-mode as a first-class queue path — both `launchSingleRun` and
 * `launchBulkRunCreates` below derive the mode via `deriveRunMode`
 * (`src/lib/run-mode.ts`, v1's exact `responseText?.trim() ? 'judge' :
 * 'respond'` rule) and only require a rubric / resolve a `PromptTemplate`
 * for judge-mode runs — respond-mode runs get `rubricId: null` and
 * `promptTemplateId: null` on every created `ModelJudgment`, mirroring v1's
 * `createEvaluationRun`.
 */

// ─── Shared run-detail include (moved verbatim from evaluation-run-manager.ts) ──

/** Minimal `JudgeModelVersion`+`JudgeModel` shape every run-detail-shaped
 * include below selects, for display fallback when `modelConfig` is null
 * (new, Task-12-created rows never set it) — see `src/lib/model-display.ts`. */
const judgeModelVersionDisplaySelect = {
  id: true,
  ordinal: true,
  servingBackend: true,
  judgeModel: { select: { id: true, name: true, baseModel: true } },
} as const;

export const runDetailInclude = {
  rubric: {
    include: { criteria: { orderBy: { order: 'asc' as const } } },
  },
  triggeredBy: { select: { id: true, name: true, email: true } },
  runModelSelections: {
    include: {
      modelConfig: { select: { id: true, name: true, provider: true, modelId: true } },
      judgeModelVersion: { select: judgeModelVersionDisplaySelect },
    },
    orderBy: { createdAt: 'asc' as const },
  },
  modelJudgments: {
    include: {
      modelConfig: { select: { id: true, name: true, provider: true, modelId: true } },
      judgeModelVersion: { select: judgeModelVersionDisplaySelect },
    },
    orderBy: { createdAt: 'asc' as const },
  },
  humanJudgment: true,
  evaluation: {
    select: {
      id: true,
      title: true,
      inputText: true,
      promptText: true,
      responseText: true,
      project: { select: { id: true, name: true } },
      // A1: both are OPTIONAL to-ONE args, so both carry a `where` and a hidden
      // reference never leaves this module populated. THIS IS THE SITE NO
      // ROUTE-LEVEL SWEEP COULD FIND — the read is here, in a shared include,
      // and both `GET /api/evaluations/[id]/runs` and `launchSingleRun`'s own
      // re-read reach a corpus through it without naming a dataset anywhere in
      // their file. Filtering it here means every consumer of the include is
      // covered by construction, with nothing to remember at the call site.
      dataset: { where: liveDatasetsOnly(), select: { id: true, name: true } },
      datasetSample: { where: liveSamplesOnly(), select: { id: true, index: true } },
    },
  },
};

export type RunDetail = Prisma.EvaluationRunGetPayload<{ include: typeof runDetailInclude }>;

export async function resolveCurrentPromptTemplate(protocol: RunProtocol) {
  // "Current" = highest version FOR THIS PROTOCOL — same query as
  // src/worker/run-create-consumer.ts's resolveCurrentPromptTemplate (which
  // has taken a protocol argument since Task 9b), kept as a local duplicate
  // (that file lives under src/worker/, importing a web-tier lib from it —
  // or vice versa — would be the wrong direction of coupling for what is a
  // two-line query). A0: the `'pointwise'` literal that used to be hardcoded
  // here is what made the seeded `v1-pairwise` row unreachable from the web
  // tier.
  //
  // A2.1: exported (not a third copy) for `src/lib/calibration/launch.ts`,
  // which PRE-FLIGHTS this before creating a `CalibrationRun` header —
  // see that module's doc for why a per-item 500 discovered after the
  // header exists is unacceptable there.
  return prisma.promptTemplate.findFirst({
    where: { protocol },
    orderBy: { version: 'desc' },
  });
}

/**
 * Verify `userId` owns an active, verified `ModelEndpoint` for EVERY id in
 * `versionIds` — the web-tier half of Task 12's "no cross-user endpoint
 * borrow" requirement (see module doc). Throws `RunLaunchError(400, ...)`
 * naming every version with no eligible endpoint, rather than a generic
 * failure — a caller trying to launch against a judge they never configured
 * (or whose key/endpoint they since deactivated) gets a clear, actionable
 * message instead of a run that publishes fine and then fails per-judgment
 * at execution time.
 *
 * A2.1: exported so `src/lib/calibration/launch.ts` can run this ONCE, before
 * it writes the `CalibrationRun` header that freezes a golden set forever.
 * Left inside `launchSingleRun` too — a calibration's per-item launches still
 * go through it, and every other caller depends on it being unskippable.
 *
 * ── v2j: it also RETURNS the endpoint URLs, at zero extra cost ──────────────
 * `Map<judgeModelVersionId, endpoint URL | null>` (`null` = the judge has no
 * self-hosted server; a hosted API resolves its own base URL later). This
 * function already runs before every publish and already reads exactly the rows
 * a lane needs, so the lane comes out of the query that was happening anyway —
 * no second round trip, and no window in which the row that authorised the
 * launch differs from the row the lane was derived from. Every existing caller
 * ignores the return value and is unaffected.
 */
export async function requireOwnedActiveEndpoints(
  userId: string,
  versionIds: string[]
): Promise<Map<string, string | null>> {
  const endpointUrls = new Map<string, string | null>();
  if (versionIds.length === 0) return endpointUrls;

  // Same single query as before, through the shared resolver — see
  // `src/lib/endpoint-resolution.ts` for why the publisher and the consumer
  // must select the same ROW and not merely agree that some row exists.
  const resolved = await resolveEndpointsForVersions(userId, versionIds);

  const missing: string[] = [];
  for (const id of versionIds) {
    const endpoint = resolved.get(id) ?? null;
    // ADMISSION CONTROL IS UNCHANGED AND STILL STRICT. The resolver ranks
    // every verified row above every unverified one, so "the winner is
    // unverified" is exactly equivalent to "this user owns no verified active
    // endpoint for this version" — the condition the old
    // `verifiedAt: { not: null }` where-clause tested. The difference is that
    // we now also hold the row the WORKER will call, so the lane derived below
    // describes the server the judgment actually hits.
    if (!endpoint || endpoint.verifiedAt === null) {
      missing.push(id);
      continue;
    }
    endpointUrls.set(id, endpoint.endpoint);
  }

  if (missing.length > 0) {
    throw new RunLaunchError(
      400,
      `No active, verified endpoint configured for judge model version(s): ${missing.join(', ')}. ` +
        'Configure your own endpoint for each selected judge on the Models page.'
    );
  }

  return endpointUrls;
}

// ─── launchSingleRun ────────────────────────────────────────────────────────

/** One `RunCandidate` row to create alongside the run — the discrete
 * candidates a pairwise/listwise comparison is over (schema.prisma:417-427,
 * which had zero writers before A0). Mirrors `GoldenCandidate` field for
 * field, so a golden item's candidates map onto a run's with no reshaping. */
export interface LaunchRunCandidateInput {
  position: number;
  promptText?: string | null;
  responseText?: string | null;
  label?: string | null;
}

export interface LaunchSingleRunParams {
  evaluationId: string;
  triggeredById: string;
  rubricId?: string;
  /** Explicit override — one entry per selected `JudgeModelVersion`. When
   * omitted, defaults to the evaluation's stored `modelSelections`
   * (`judgeModelVersionId`s only — pre-Task-12 modelConfigId-only rows have
   * no version id to fall back to and are simply skipped; see the Task 12
   * report for that documented, accepted limitation). */
  judgeModelVersionIds?: string[];
  /** A0: the run's protocol. Defaults to `'pointwise'` so every existing
   * caller is unchanged. `'listwise'` is rejected — storable and
   * annotatable, not runnable. */
  protocol?: RunProtocol;
  /** A0: the comparison set for a pairwise run — exactly 2 entries, at
   * distinct `position`s, each carrying `responseText` or `promptText`.
   * Written as `RunCandidate` rows inside the same transaction as the run,
   * because the worker reads the candidate text from there and NOT from the
   * evaluation (a pairwise pair has two responses; `Evaluation` has room
   * for one). */
  candidates?: LaunchRunCandidateInput[];
  /** A2.1: the `GoldenItem` this run measures. NULL on every ordinary run —
   * only `launchCalibrationRun` sets it. Without it there is no path from a
   * model verdict back to the `expected` it should be scored against
   * (`ModelJudgment` -> `EvaluationRun` -> `Evaluation`, and an `Evaluation`
   * has a `datasetSampleId` but no golden item). */
  goldenItemId?: string;
  /** A2.1: which calibration this run belongs to. Paired with `goldenItemId`
   * under `@@unique([calibrationRunId, goldenItemId])`, so one calibration
   * cannot measure the same item twice. */
  calibrationRunId?: string;
}

export interface LaunchSingleRunDeps {
  /** Injectable publish seam — defaults to the real `publishJudgmentExecute`.
   * Tests inject a throwing fake to exercise the publish-failure /
   * compensating-update path deterministically without needing to break a
   * live broker connection.
   *
   * v2j: `destinationQueue` is the LANE this judgment belongs to (see
   * `src/lib/queue/lanes.ts`). It is a required parameter on the seam even
   * though it is optional on `publishJudgmentExecute` itself, so that a fake
   * which wants to observe routing can — TypeScript still accepts a
   * one-parameter fake, so this does NOT force existing fakes to change, and
   * a fake that ignores the argument keeps behaving exactly as before. */
  publish?: (msg: JudgmentExecuteMsg, destinationQueue: string) => Promise<void>;
}

export interface LaunchSingleRunResult {
  run: RunDetail;
  publishFailed: boolean;
  publishError?: string;
}

export async function launchSingleRun(
  params: LaunchSingleRunParams,
  deps: LaunchSingleRunDeps = {}
): Promise<LaunchSingleRunResult> {
  const publish = deps.publish ?? publishJudgmentExecute;

  const evaluation = await prisma.evaluation.findUnique({
    where: { id: params.evaluationId },
    include: {
      modelSelections: { orderBy: { createdAt: 'asc' } },
    },
  });
  if (!evaluation) throw new RunLaunchError(404, 'Evaluation not found');

  const protocol: RunProtocol = params.protocol ?? 'pointwise';
  if (protocol === 'listwise') {
    throw new RunLaunchError(
      400,
      'Listwise runs are not executable. A listwise golden set is storable and annotatable in A0, not runnable — there is no listwise renderer.'
    );
  }

  const candidates = params.candidates ?? [];
  if (protocol === 'pairwise' && candidates.length !== 2) {
    throw new RunLaunchError(
      400,
      `A pairwise run requires exactly 2 candidates, got ${candidates.length}.`
    );
  }
  if (protocol === 'pointwise' && candidates.length > 0) {
    throw new RunLaunchError(400, 'A pointwise run takes no candidates.');
  }
  if (protocol === 'pairwise') {
    // Both of these are caught HERE, at the launch layer, because both
    // otherwise surface as something that describes the symptom instead of
    // the cause — the same reason the count check above exists.
    //
    // Duplicate positions would hit `RunCandidate`'s
    // @@unique([runId, position]) (schema.prisma:426) as a raw Prisma P2002
    // escaping the create transaction, which the routes turn into a 500
    // rather than a 400 about the candidates the caller actually sent.
    const positions = candidates.map((candidate) => candidate.position);
    if (new Set(positions).size !== positions.length) {
      throw new RunLaunchError(
        400,
        `A pairwise run requires distinct candidate positions, got [${positions.join(', ')}].`
      );
    }
    // Text-less candidates would pass every check up to and including the
    // worker's own RunCandidate count guard, then throw inside
    // `buildPairwiseUserPrompt` (src/lib/llm/render.ts) as a `non_retryable`
    // "Failed to render judgment prompt" — a rendering failure standing in
    // for "this run was launched with an empty candidate". The
    // `responseText ?? promptText` precedence (and `??`, not `||`) mirrors
    // render.ts's `candidateText` exactly, so this check and the renderer
    // can never disagree about which candidates are empty.
    const blank = candidates
      .filter((candidate) => !(candidate.responseText ?? candidate.promptText ?? '').trim())
      .map((candidate) => candidate.position);
    if (blank.length > 0) {
      throw new RunLaunchError(
        400,
        `Every pairwise candidate must carry responseText or promptText — position(s) [${blank.join(', ')}] are empty.`
      );
    }
  }

  // A pairwise run is ALWAYS judge-mode. `deriveRunMode` keys on
  // `Evaluation.responseText`, which is empty for a pairwise run BY
  // CONSTRUCTION — the two responses live on `RunCandidate`, not on the
  // evaluation — so deriving unconditionally would classify every pairwise
  // run as 'respond', skip both the rubric requirement AND the
  // PromptTemplate resolution, and publish judgments the worker cannot
  // render.
  const mode = protocol === 'pointwise' ? deriveRunMode(evaluation.responseText) : 'judge';

  const rubricId = params.rubricId ?? evaluation.rubricId ?? null;
  if (mode === 'judge' && !rubricId) {
    throw new RunLaunchError(
      400,
      'No rubric assigned. Assign a rubric to the evaluation template or pass rubricId.'
    );
  }

  let rubric: { id: string } | null = null;
  if (rubricId) {
    rubric = await prisma.rubric.findUnique({ where: { id: rubricId }, select: { id: true } });
    if (!rubric) throw new RunLaunchError(404, 'Rubric not found');
  }

  const selectedVersionIds = params.judgeModelVersionIds?.length
    ? [...new Set(params.judgeModelVersionIds)]
    : [
        ...new Set(
          evaluation.modelSelections
            .map((selection) => selection.judgeModelVersionId)
            .filter((id): id is string => !!id)
        ),
      ];

  if (selectedVersionIds.length === 0) {
    throw new RunLaunchError(
      400,
      'No models selected. Add models to the evaluation template or pass judgeModelVersionIds.'
    );
  }

  // Also the source of this run's lane routing — see the function's own doc
  // for why the endpoint URLs come back from the check that was already
  // running rather than from a second query.
  const endpointUrls = await requireOwnedActiveEndpoints(params.triggeredById, selectedVersionIds);

  // promptTemplateId is null on respond judgments (no rubric template to
  // render against — the model generates a response, it isn't judging
  // one) — only judge-mode runs resolve+require a PromptTemplate row.
  let promptTemplateId: string | null = null;
  if (mode === 'judge') {
    const promptTemplate = await resolveCurrentPromptTemplate(protocol);
    if (!promptTemplate) {
      throw new RunLaunchError(500, `No PromptTemplate found for protocol "${protocol}"`);
    }
    promptTemplateId = promptTemplate.id;
  }

  const createdRun = await prisma.$transaction(async (tx) => {
    return tx.evaluationRun.create({
      data: {
        evaluationId: params.evaluationId,
        rubricId: rubric?.id ?? null,
        protocol,
        status: 'pending',
        // deadlineAt is deliberately OMITTED — it defaults to null and
        // stays null until src/worker/claim.ts's
        // stampRunStartedAtFirstDequeue sets it at FIRST DEQUEUE. See the
        // module doc's "EvaluationRun.deadlineAt is no longer stamped here"
        // section for why.
        triggeredById: params.triggeredById,
        // A2.1: both NULL on every ordinary run. Written INSIDE the create, in
        // the same statement as the run itself, so a calibration run never
        // exists for even one statement without the item it is measuring —
        // a second write would leave a window in which the scorer sees a run
        // it cannot attribute to any `expected`.
        goldenItemId: params.goldenItemId ?? null,
        calibrationRunId: params.calibrationRunId ?? null,
        // RunCandidate rows are created in the SAME transaction as the run.
        // A pairwise run whose candidates land in a second write can be
        // observed — and claimed by a worker — with a complete-looking run
        // and no comparison set.
        runCandidates:
          candidates.length > 0
            ? {
                create: candidates.map((candidate) => ({
                  position: candidate.position,
                  promptText: candidate.promptText ?? null,
                  responseText: candidate.responseText ?? null,
                  label: candidate.label ?? null,
                })),
              }
            : undefined,
        runModelSelections: {
          create: selectedVersionIds.map((judgeModelVersionId) => ({ judgeModelVersionId })),
        },
        modelJudgments: {
          create: selectedVersionIds.map((judgeModelVersionId) => ({
            judgeModelVersionId, // modelConfigId intentionally left null — see module doc
            promptTemplateId,
            // pairOrder is written EXPLICITLY on every judgment, never left
            // to a default: 'AB' for the single order A0 emits, NULL for
            // pointwise, which is what the existing
            // @@unique([runId, judgeModelVersionId, pairOrder]) —
            // hand-edited NULLS NOT DISTINCT in
            // 20260728215410_v2b_idempotency_tighten — assumes. That is
            // what makes A2's BA sweep additive: a second judgment per pair,
            // no migration, no backfill, and no ambiguity about what the
            // existing rows measured.
            pairOrder: protocol === 'pairwise' ? 'AB' : null,
            status: 'pending' as const,
          })),
        },
      } satisfies Prisma.EvaluationRunUncheckedCreateInput,
      // judgeModelVersionId comes back too (v2j): it is the key the lane is
      // resolved per, and reading it here costs nothing — the rows are being
      // returned either way.
      include: { modelJudgments: { select: { id: true, judgeModelVersionId: true } } },
    });
  });

  // Lanes are resolved BEFORE the publish loop, one per distinct judge version
  // rather than one per judgment, and concurrently — `laneIndexFor`'s
  // INSERT .. ON CONFLICT DO NOTHING is built for exactly this race, and doing
  // it up front keeps the publish loop's "one confirmed publish at a time, stop
  // on first failure" shape intact instead of interleaving a DB round trip into
  // it. `resolveDestinationQueue` cannot throw, so a lane lookup can never be
  // the reason a run fails to publish.
  // Keyed `string | null` because `ModelJudgment.judgeModelVersionId` is
  // nullable in the schema — a null-version judgment simply misses every key
  // and takes the fallback queue below, rather than needing a sentinel.
  const laneByVersion = new Map<string | null, string>(
    await Promise.all(
      selectedVersionIds.map(
        async (versionId) =>
          [versionId, await resolveDestinationQueue(endpointUrls.get(versionId), versionId)] as const
      )
    )
  );

  let publishFailed = false;
  let publishError: string | undefined;
  for (const judgment of createdRun.modelJudgments) {
    try {
      // eslint-disable-next-line no-await-in-loop -- sequential confirmed publishes, one row at a time so a mid-loop broker failure is attributable and stops further doomed publishes; capped at 10 models per run
      await publish(
        { judgmentId: judgment.id, runId: createdRun.id, attempt: 1 },
        // `?? LANE_FALLBACK_QUEUE` is unreachable in practice (every judgment
        // is created from `selectedVersionIds`), and it is here because the
        // alternative to an unreachable fallback is an unhandled `undefined`
        // routing key, i.e. a message published to the empty routing key and
        // silently dropped by the direct exchange.
        laneByVersion.get(judgment.judgeModelVersionId) ?? LANE_FALLBACK_QUEUE
      );
    } catch (error) {
      publishFailed = true;
      publishError = error instanceof Error ? error.message : String(error);
      break;
    }
  }

  if (publishFailed) {
    // Guarded, not unconditional — an unconditional `update({ data: {
    // status: 'error' } })` here can clobber a legitimate terminal status.
    // `publish()` throwing does not guarantee the broker never got the
    // message: a confirm-ack that times out, or a socket error raised
    // AFTER the broker already durably accepted the publish, looks
    // identical from here to a real delivery failure ("in-doubt" publish).
    // If a worker has ALREADY claimed this judgment and the finalizer has
    // ALREADY moved the run off pending/judging by the time we get here,
    // that only happens because the broker really did have the message —
    // stomping the run back to 'error' would destroy a real
    // completed/needs_human/error transition. Mirrors run-finalizer.ts's
    // `markRunCompleted` guard: a conditional `updateMany`, never an
    // unconditional `update`.
    const guarded = await prisma.evaluationRun.updateMany({
      where: { id: createdRun.id, status: { in: ['pending', 'judging'] } },
      data: { status: 'error', finalizedAt: new Date() },
    });
    if (guarded.count === 0) {
      // count === 0 means the run had already progressed for real — the
      // broker had the message despite publish() throwing on our side.
      // Treat this as accepted, not failed: callers (the `runs`/
      // `evaluations` routes) branch on `publishFailed` to choose between a
      // 502-with-error response and a normal success response, and a 502
      // here would be actively misleading (nothing is actually broken).
      // Logged (not surfaced back to the HTTP caller as a field) so the
      // in-doubt condition is still discoverable, without widening this
      // function's return contract or every route's response shape for a
      // rare, self-healed race.
      logger.warn(
        'launchSingleRun: publish() threw but the run had already progressed off pending/judging — ' +
          'treating as accepted (broker had the message), not failed',
        { runId: createdRun.id, publishError }
      );
      publishFailed = false;
      publishError = undefined;
    }
  }

  const run = await prisma.evaluationRun.findUniqueOrThrow({
    where: { id: createdRun.id },
    include: runDetailInclude,
  });

  return { run, publishFailed, publishError };
}

// ─── launchBulkRunCreates ───────────────────────────────────────────────────

export interface BulkLaunchFailure {
  evaluationId: string;
  reason: string;
}

export interface BulkLaunchResult {
  accepted: string[];
  failed: BulkLaunchFailure[];
}

export interface LaunchBulkRunCreatesDeps {
  /** Injectable publish seam — see `LaunchSingleRunDeps.publish`'s doc. */
  publish?: (msg: RunCreateMsg) => Promise<void>;
}

function errorReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Publish one `run.create` per evaluation in `evaluationIds`, in order,
 * each awaited individually. Returns which ids were accepted (message
 * durably published) vs. failed (with a human-readable reason) — never
 * throws for a per-evaluation failure, so one bad evaluation in a batch
 * never prevents the rest from launching.
 */
export async function launchBulkRunCreates(
  evaluationIds: string[],
  triggeredById: string,
  deps: LaunchBulkRunCreatesDeps = {}
): Promise<BulkLaunchResult> {
  const publish = deps.publish ?? publishRunCreate;

  const accepted: string[] = [];
  const failed: BulkLaunchFailure[] = [];

  for (const evaluationId of evaluationIds) {
    try {
      // eslint-disable-next-line no-await-in-loop -- each evaluation's resolve+publish must be individually attributable (which one failed and why) — see module doc's launchBulkRunCreates section
      const evaluation = await prisma.evaluation.findUnique({
        where: { id: evaluationId },
        include: { modelSelections: true },
      });
      if (!evaluation) throw new Error('Evaluation not found');

      const mode = deriveRunMode(evaluation.responseText);

      const rubricId = evaluation.rubricId ?? null;
      if (mode === 'judge' && !rubricId) {
        throw new Error('No rubric assigned. Assign a rubric to the evaluation template or pass rubricId.');
      }
      let rubric: { id: string } | null = null;
      if (rubricId) {
        // eslint-disable-next-line no-await-in-loop
        rubric = await prisma.rubric.findUnique({ where: { id: rubricId }, select: { id: true } });
        if (!rubric) throw new Error('Rubric not found');
      }

      const versionIds = [
        ...new Set(
          evaluation.modelSelections
            .map((selection) => selection.judgeModelVersionId)
            .filter((id): id is string => !!id)
        ),
      ];
      if (versionIds.length === 0) {
        throw new Error('No models selected for this evaluation.');
      }

      // eslint-disable-next-line no-await-in-loop
      await requireOwnedActiveEndpoints(triggeredById, versionIds);

      // modelConfigId intentionally left null on every entry — see module
      // doc's "Task 12: runtime switches to JudgeModelVersion identity".
      const modelSelections = versionIds.map((judgeModelVersionId) => ({
        judgeModelVersionId,
        modelConfigId: null,
      }));

      const msg: RunCreateMsg = {
        evaluationId,
        runSpec: {
          rubricId: rubricId ?? undefined,
          modelSelections,
          triggeredById,
          // Explicitly pointwise, now against a `RunProtocol`-typed field
          // rather than a literal one. The bulk path stays pointwise in A0
          // ON PURPOSE: `RunCreateMsg` carries no candidate set, so a
          // pairwise bulk launch would expand into judgments with no
          // comparison to make. Pairwise runs go through `launchSingleRun`,
          // which writes RunCandidate rows transactionally with the run.
          protocol: 'pointwise',
        },
      };

      // eslint-disable-next-line no-await-in-loop
      await publish(msg);
      accepted.push(evaluationId);
    } catch (error) {
      failed.push({ evaluationId, reason: errorReason(error) });
    }
  }

  return { accepted, failed };
}
