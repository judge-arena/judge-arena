/**
 * ─── Run Launch (web-tier RabbitMQ producer) ────────────────────────────────
 *
 * Replaces `src/lib/evaluation-run-manager.ts`'s in-process run engine
 * (`enqueueRunProcessing`/`enqueueEvaluationRunCreation`/`processRun`,
 * deleted in this task) with two publish-then-return functions. The web
 * tier no longer executes judgments itself — it creates rows and hands off
 * to RabbitMQ (`judgment.execute` for a fully-specified single run,
 * `run.create` for a bulk dataset launch that the worker's
 * `run-create-consumer.ts` expands) for `src/worker/*` to actually run.
 *
 * ── launchSingleRun ──────────────────────────────────────────────────────
 * Used by both `POST /api/evaluations` (single-text `create_and_run`) and
 * `POST /api/evaluations/[id]/runs`. One `$transaction` creates the
 * `EvaluationRun` + its `RunModelSelection`s + `ModelJudgment` rows (all
 * `pending`, `judgeModelVersionId` resolved up front via
 * `ensureJudgeIdentityForModelConfig` — see judge-identity.ts for why that
 * resolution, and the `modelConfigId` dual-write below, exist). The
 * transaction ends BEFORE any queue publish — publishing inside a
 * transaction would hold a DB connection/lock open across N network round
 * trips to RabbitMQ, and a publish failure would roll back rows whose
 * queue messages the broker may already have accepted, desyncing the two
 * systems. Each `judgment.execute` is published individually, awaited one
 * at a time (small N — selection is capped at 10 models); the first
 * failure stops the loop (further publishes to the same broker are highly
 * likely to fail identically) and the already-created run is compensated
 * to `status: 'error'` rather than left stuck `pending` with no worker ever
 * going to see it.
 *
 * ── launchBulkRunCreates ─────────────────────────────────────────────────
 * Used by `POST /api/evaluations`'s dataset-batch and remote-dataset
 * `create_and_run` paths, AFTER the evaluations themselves are already
 * created (transactionally, by the caller — unchanged from before this
 * task). Per evaluation: resolve rubric + judge identities, publish
 * `run.create`, and record the outcome — a failure for one evaluation
 * (missing rubric, no models, a broker hiccup) does not abort or silently
 * swallow the rest. Returns `{ accepted, failed }` so the route can respond
 * `202` with a per-item status instead of either an all-or-nothing error or
 * a `runsQueued` count that silently under-reports failures (the
 * swallowed-failure gap this task's brief calls out).
 *
 * ── modelConfigId dual-write (temporary — see judge-identity.ts) ───────────
 * `ModelJudgment.modelConfigId` is nullable and the schema's own comment
 * says the write path "stops setting this" — but the CURRENT UI/routes
 * still only select `ModelConfig`s (Task 12 switches to `JudgeModelVersion`
 * selection), and existing consumers (the run detail page, the
 * human-judgment route's `completedModelIds` check, CSV/JSONL export) still
 * read `modelConfigId` off `ModelJudgment`. Setting it to null today would
 * silently break those without Task 9 also migrating every downstream
 * reader to `judgeModelVersionId` — out of this task's file list. So this
 * module dual-writes: `modelConfigId` (legacy, for the UI/exports/human-
 * judgment matching) AND `judgeModelVersionId` (the queue/worker identity).
 * Task 12 deletes the `modelConfigId` side once those readers migrate.
 */
import type { ModelConfig, Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { ensureJudgeIdentityForModelConfig } from '@/lib/judge-identity';
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
 * rubric, `executeRespond`). The 1b queue-based worker
 * (`src/worker/judgment-consumer.ts`) only ever implements the judge path —
 * `RunProtocol` itself only has judging variants (`pointwise` / `pairwise` /
 * `listwise`), and `judgmentContextQuery` unconditionally requires
 * `run.rubric`, erroring every judgment ("EvaluationRun has no rubric") for
 * a respond-mode run. That gap predates this task (Stage B / Tasks 7-8
 * shipped the worker without a respond-mode path) — Task 9 does not add
 * respond-mode support, which is out of scope (no schema/protocol for it).
 * What Task 9 DOES do: fail fast and clearly here, at launch time, instead
 * of silently creating a run/judgments that the worker will later error out
 * one-by-one with a confusing "no rubric" message. The UI still lets a user
 * pick "respond" mode + "Create & Run" together (src/app/projects/[id]/
 * page.tsx), so this is a real, reachable path, not a hypothetical.
 */
const RESPOND_MODE_UNSUPPORTED_MESSAGE =
  'Respond-mode evaluations (model self-response generation, no rubric) are not supported by ' +
  'the queue-based run worker. Use judge mode (a response to evaluate against a rubric) instead.';

// ─── Shared run-detail include (moved verbatim from evaluation-run-manager.ts) ──

export const runDetailInclude = {
  rubric: {
    include: { criteria: { orderBy: { order: 'asc' as const } } },
  },
  triggeredBy: { select: { id: true, name: true, email: true } },
  runModelSelections: {
    include: {
      modelConfig: { select: { id: true, name: true, provider: true, modelId: true } },
    },
    orderBy: { createdAt: 'asc' as const },
  },
  modelJudgments: {
    include: {
      modelConfig: { select: { id: true, name: true, provider: true, modelId: true } },
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

async function resolveCurrentPromptTemplate() {
  // "Current" = highest version for the pointwise protocol — same query as
  // src/worker/run-create-consumer.ts's resolveCurrentPromptTemplate, kept
  // as a local duplicate (that file lives under src/worker/, importing a
  // web-tier lib from it — or vice versa — would be the wrong direction of
  // coupling for what is a two-line query).
  return prisma.promptTemplate.findFirst({
    where: { protocol: 'pointwise' },
    orderBy: { version: 'desc' },
  });
}

async function resolveJudgeIdentities(modelConfigs: ModelConfig[]): Promise<Map<string, string>> {
  const versionIdByModelConfigId = new Map<string, string>();
  for (const modelConfig of modelConfigs) {
    // eslint-disable-next-line no-await-in-loop -- sequential find-or-create; selection is capped at 10 models per run, not worth Promise.all's harder-to-reason-about partial-failure semantics for identity creation
    const identity = await ensureJudgeIdentityForModelConfig(prisma, modelConfig);
    versionIdByModelConfigId.set(modelConfig.id, identity.versionId);
  }
  return versionIdByModelConfigId;
}

// ─── launchSingleRun ────────────────────────────────────────────────────────

export interface LaunchSingleRunParams {
  evaluationId: string;
  triggeredById: string;
  rubricId?: string;
  modelConfigIds?: string[];
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
      modelSelections: {
        include: { modelConfig: true },
        orderBy: { createdAt: 'asc' },
      },
    },
  });
  if (!evaluation) throw new RunLaunchError(404, 'Evaluation not found');

  if (!evaluation.responseText?.trim()) {
    throw new RunLaunchError(501, RESPOND_MODE_UNSUPPORTED_MESSAGE);
  }

  const rubricId = params.rubricId ?? evaluation.rubricId ?? null;
  if (!rubricId) {
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

  const selectedModelIds = params.modelConfigIds?.length
    ? [...new Set(params.modelConfigIds)]
    : evaluation.modelSelections.map((selection) => selection.modelConfigId);

  if (selectedModelIds.length === 0) {
    throw new RunLaunchError(
      400,
      'No models selected. Add models to the evaluation template or pass modelConfigIds.'
    );
  }

  const modelRecords = await prisma.modelConfig.findMany({
    where: { id: { in: selectedModelIds }, isVerified: true, isActive: true },
  });
  if (modelRecords.length !== new Set(selectedModelIds).size) {
    throw new RunLaunchError(
      400,
      'One or more selected models are missing, inactive, or not verified.'
    );
  }

  const versionIdByModelConfigId = await resolveJudgeIdentities(modelRecords);

  const promptTemplate = await resolveCurrentPromptTemplate();
  if (!promptTemplate) {
    throw new RunLaunchError(500, 'No PromptTemplate found for protocol "pointwise"');
  }

  const deadlineAt = new Date(
    Date.now() + selectedModelIds.length * EVALUATION_MODEL_TIMEOUT_MS + DEADLINE_SLACK_MS
  );

  const createdRun = await prisma.$transaction(async (tx) => {
    return tx.evaluationRun.create({
      data: {
        evaluationId: params.evaluationId,
        rubricId: rubric?.id ?? null,
        protocol: 'pointwise',
        status: 'pending',
        deadlineAt,
        triggeredById: params.triggeredById,
        runModelSelections: {
          create: selectedModelIds.map((modelConfigId) => ({ modelConfigId })),
        },
        modelJudgments: {
          create: selectedModelIds.map((modelConfigId) => ({
            modelConfigId, // dual-write, legacy — see module doc
            judgeModelVersionId: versionIdByModelConfigId.get(modelConfigId)!,
            promptTemplateId: promptTemplate.id,
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
    await prisma.evaluationRun.update({ where: { id: createdRun.id }, data: { status: 'error' } });
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
        include: { modelSelections: { include: { modelConfig: true } } },
      });
      if (!evaluation) throw new Error('Evaluation not found');

      if (!evaluation.responseText?.trim()) {
        throw new Error(RESPOND_MODE_UNSUPPORTED_MESSAGE);
      }

      const rubricId = evaluation.rubricId ?? null;
      if (!rubricId) {
        throw new Error('No rubric assigned. Assign a rubric to the evaluation template or pass rubricId.');
      }
      // eslint-disable-next-line no-await-in-loop
      const rubric = await prisma.rubric.findUnique({ where: { id: rubricId }, select: { id: true } });
      if (!rubric) throw new Error('Rubric not found');

      const modelConfigs = evaluation.modelSelections.map((selection) => selection.modelConfig);
      if (modelConfigs.length === 0) {
        throw new Error('No models selected for this evaluation.');
      }

      // eslint-disable-next-line no-await-in-loop
      const versionIdByModelConfigId = await resolveJudgeIdentities(modelConfigs);
      const judgeModelVersionIds = [...new Set(versionIdByModelConfigId.values())];

      const msg: RunCreateMsg = {
        evaluationId,
        runSpec: {
          rubricId: rubricId ?? undefined,
          judgeModelVersionIds,
          triggeredById,
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
