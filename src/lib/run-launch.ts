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
 */
import type { Prisma, RunProtocol } from '@prisma/client';
import { prisma } from '@/lib/db';
import { deriveRunMode } from '@/lib/run-mode';
import { logger } from '@/lib/logger';
import { publishJudgmentExecute, publishRunCreate, type JudgmentExecuteMsg, type RunCreateMsg } from '@/lib/queue/publish';

const EVALUATION_MODEL_TIMEOUT_MS = Number(process.env.EVALUATION_MODEL_TIMEOUT_MS ?? '120000');
/** Same slack literal as src/worker/run-create-consumer.ts's
 * `DEADLINE_SLACK_MS` — covers DB round trips, queue publish latency, and
 * finalization overhead on top of the per-model provider timeout budget. */
const DEADLINE_SLACK_MS = 60_000;

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
      dataset: { select: { id: true, name: true } },
      datasetSample: { select: { id: true, index: true } },
    },
  },
};

export type RunDetail = Prisma.EvaluationRunGetPayload<{ include: typeof runDetailInclude }>;

async function resolveCurrentPromptTemplate(protocol: RunProtocol) {
  // "Current" = highest version FOR THIS PROTOCOL — same query as
  // src/worker/run-create-consumer.ts's resolveCurrentPromptTemplate (which
  // has taken a protocol argument since Task 9b), kept as a local duplicate
  // (that file lives under src/worker/, importing a web-tier lib from it —
  // or vice versa — would be the wrong direction of coupling for what is a
  // two-line query). A0: the `'pointwise'` literal that used to be hardcoded
  // here is what made the seeded `v1-pairwise` row unreachable from the web
  // tier.
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
 */
async function requireOwnedActiveEndpoints(userId: string, versionIds: string[]): Promise<void> {
  if (versionIds.length === 0) return;
  const endpoints = await prisma.modelEndpoint.findMany({
    where: { userId, judgeModelVersionId: { in: versionIds }, isActive: true, verifiedAt: { not: null } },
    select: { judgeModelVersionId: true },
  });
  const covered = new Set(endpoints.map((e) => e.judgeModelVersionId));
  const missing = versionIds.filter((id) => !covered.has(id));
  if (missing.length > 0) {
    throw new RunLaunchError(
      400,
      `No active, verified endpoint configured for judge model version(s): ${missing.join(', ')}. ` +
        'Configure your own endpoint for each selected judge on the Models page.'
    );
  }
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
  /** A0: the comparison set for a pairwise run — exactly 2 entries.
   * Written as `RunCandidate` rows inside the same transaction as the run,
   * because the worker reads the candidate text from there and NOT from the
   * evaluation (a pairwise pair has two responses; `Evaluation` has room
   * for one). */
  candidates?: LaunchRunCandidateInput[];
}

export interface LaunchSingleRunDeps {
  /** Injectable publish seam — defaults to the real `publishJudgmentExecute`.
   * Tests inject a throwing fake to exercise the publish-failure /
   * compensating-update path deterministically without needing to break a
   * live broker connection. */
  publish?: (msg: JudgmentExecuteMsg) => Promise<void>;
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

  await requireOwnedActiveEndpoints(params.triggeredById, selectedVersionIds);

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

  const deadlineAt = new Date(
    Date.now() + selectedVersionIds.length * EVALUATION_MODEL_TIMEOUT_MS + DEADLINE_SLACK_MS
  );

  const createdRun = await prisma.$transaction(async (tx) => {
    return tx.evaluationRun.create({
      data: {
        evaluationId: params.evaluationId,
        rubricId: rubric?.id ?? null,
        protocol,
        status: 'pending',
        deadlineAt,
        triggeredById: params.triggeredById,
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
      include: { modelJudgments: { select: { id: true } } },
    });
  });

  let publishFailed = false;
  let publishError: string | undefined;
  for (const judgment of createdRun.modelJudgments) {
    try {
      // eslint-disable-next-line no-await-in-loop -- sequential confirmed publishes, one row at a time so a mid-loop broker failure is attributable and stops further doomed publishes; capped at 10 models per run
      await publish({ judgmentId: judgment.id, runId: createdRun.id, attempt: 1 });
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
