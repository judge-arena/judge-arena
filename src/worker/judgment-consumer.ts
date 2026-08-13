/**
 * ─── judgment.execute Consumer ─────────────────────────────────────────────
 *
 * Pipeline per message: claim (idempotent — see ./claim.ts) -> load full
 * judgment context (run/evaluation/rubric/judge version/judge model, plus
 * A0's `RunCandidate` comparison set) -> resolve a `ModelEndpoint` to call
 * through -> run the provider call (via whichever of the three seams the
 * run's protocol and mode select — `runProviderJudgment`,
 * `runProviderResponse`, `runProviderPairwise`, all injectable for tests)
 * -> persist the result -> publish `judgment.completed` on `run:{runId}`
 * (best-effort, never fails the message) -> finalization pass
 * (`maybeFinalizeRun`, src/lib/run-finalizer.ts) -> ack.
 *
 * ── The provider seam ───────────────────────────────────────────────────────
 * `runProviderJudgment` is intentionally narrow: `{ judgment, run, rubric,
 * version, endpoint } -> JudgmentResult`. The default implementation
 * (`defaultRunProviderJudgment`) adapts a `JudgeModelVersion` +
 * `ModelEndpoint` (+ the judgment's resolved `PromptTemplate`) into
 * `src/lib/llm/index.ts`'s registry-driven `executeJudgment` (Task 10: a
 * real per-`servingBackend` descriptor dispatch — `src/lib/llm/registry.ts`
 * — with `samplingDefaults` actually threaded into the call, DB-templated
 * prompts via `src/lib/llm/render.ts`, and metadata capture) — this
 * consumer's own control flow is unchanged from Task 9, since every caller
 * only ever sees the seam.
 *
 * `JudgeModel.baseModel` (the literal provider model id, e.g.
 * `"claude-sonnet-4-5-20250514"`) is required for a call to resolve at all
 * — `registry.ts`'s `runProviderJudgment`/`runProviderResponse` throw a
 * `non_retryable` `ProviderError` when it's unset rather than guessing from
 * `slug`/`name`, so a misconfiguration surfaces as a judgment error, not a
 * request sent with a garbage model id.
 *
 * ── Respond mode (Task 9b — restored, not new) ──────────────────────────────
 * v1 (`evaluation-run-manager.ts`, deleted by Task 9) supported two run
 * modes: "judge" (score an existing response against a rubric,
 * `executeJudgment`) and "respond" (no response exists yet — each selected
 * model GENERATES one from the prompt, `executeRespond`). Task 9 shipped
 * judge-mode only and 501'd respond-mode at launch time
 * (`src/lib/run-launch.ts`). Task 9b restores respond-mode as a first-class
 * queue path (Trijeet decision 2026-07-29). A0 puts one dispatch step in
 * front of it: `EvaluationRun.protocol` is read FIRST and decides which
 * seam runs, and `deriveRunMode` (`src/lib/run-mode.ts`, v1's exact
 * `responseText?.trim() ? 'judge' : 'respond'` rule, re-derived here off
 * `context.run.evaluation.responseText` — already loaded by
 * `judgmentContextQuery`, no extra query needed) only ever chooses
 * judge-vs-respond WITHIN `'pointwise'`. A pairwise run has no
 * `Evaluation.responseText` by construction (its two responses are
 * `RunCandidate` rows), so deriving the mode unconditionally would route
 * every pairwise judgment to the respond seam and generate text instead of
 * comparing anything. That gives three provider seams:
 *   - pointwise + `'judge'`   -> `runProviderJudgment` (existing, described
 *     above); rubric is REQUIRED (unchanged from Task 9).
 *   - pointwise + `'respond'` -> `runProviderResponse` (default implementation
 *     `defaultRunProviderResponse` wraps `executeRespond`, which goes
 *     through the SAME registry dispatch + `callThroughResilience` —
 *     classify()/breaker/retry — machinery `executeJudgment` uses).
 *     Rubric is NOT required; `promptTemplateId` is `null` on every
 *     respond-mode `ModelJudgment` (set at creation time by
 *     `run-launch.ts`/`run-create-consumer.ts`, not here).
 *   - `'pairwise'` (A0)       -> `runProviderPairwise` (default implementation
 *     `defaultRunProviderPairwise` wraps `executePairwise`, same registry
 *     dispatch and same resilience machinery again). Always judge-mode, so
 *     rubric AND `PromptTemplate` are both REQUIRED, plus exactly 2
 *     `RunCandidate` rows — all three guarded before the call.
 *     `'listwise'` is refused outright: storable and annotatable in A0, not
 *     runnable, and there is no listwise renderer to call.
 * Persistence mirrors this same split: `persistSuccess` (judge) vs.
 * `persistRespondSuccess` (respond) vs. `persistPairwiseSuccess` (pairwise)
 * — see those functions' docs for why the persisted SHAPE differs (v1's
 * respond judgment puts generated text in `reasoning`; a pairwise judgment
 * stores the RAW verdict and leaves `overallScore` null, because a
 * preference is not a score). All three go through the same generic
 * `persistSuccessWithRetry` bounded-retry/DLQ-preservation wrapper, and the
 * classify()-driven retry/DLQ disposition below is entirely seam-agnostic
 * (it never inspects which provider seam produced the error) — Tasks 7/8's
 * retry/DLQ/claim machinery applies identically to all three.
 *
 * ── Disposition scope — provider errors ONLY ────────────────────────────────
 * The `classify()`-driven retry/DLQ disposition below wraps ONLY the
 * `provider()` call. Persistence (`persistSuccess`) and finalization
 * (`maybeFinalizeRun`) run OUTSIDE that catch, each with their own error
 * handling — a persist or finalize failure must never be classified as a
 * provider error. Before this was split out, a persist failure after a
 * SUCCESSFUL (and possibly billed) provider call fell into the same catch
 * as provider failures, got classified `retryable`, reset the judgment back
 * to `pending`, and republished it — causing the provider to be
 * re-executed for a result that had already been produced. See
 * `persistSuccessWithRetry`'s doc for the fix, and `safeFinalizeRun` for why
 * finalization failures are isolated too.
 *
 * ── Error disposition (classify() from src/lib/llm/errors.ts) ──────────────
 * - `non_retryable` -> judgment `error` + ack.
 * - `retryable` / `rate_limited`, attempt budget remains
 *   (`effectiveAttempt < 3`, where `effectiveAttempt =
 *   Math.max(msg.attempt, judgment.attemptCount)` — see below) -> reset the
 *   judgment row to `pending` (see ./claim.ts's docstring for why leaving it
 *   `running` would break the retry — the redelivered message would look
 *   like a duplicate of a still-live claim and get ack-skipped instead of
 *   retried) and publish the message (with `attempt: effectiveAttempt + 1`)
 *   onto `judgment.retry.30s` (1 -> 2) or `judgment.retry.5m` (2 -> 3);
 *   breaker-open failures always prefer the 5m queue regardless of attempt,
 *   since a breaker that's open needs longer than 30s to plausibly recover.
 *   Original message acked either way — the retry queue holds the next
 *   attempt, not a requeue of this one.
 * - Attempt budget exhausted (`effectiveAttempt >= 3`) -> judgment `error`
 *   + `publishToDlq` + ack.
 *
 * `effectiveAttempt`, not the bare `msg.attempt`, drives the cap check.
 * `msg.attempt` only advances when THIS consumer republishes onto a retry
 * queue. A crash-reclaim cycle (claim.ts's `'stale_running'` path — the
 * original claimant died mid-flight and a LATER redelivery of the SAME
 * original message reclaims a lease-expired row) redelivers the identical
 * `judgment.execute` message with `msg.attempt` unchanged, while
 * `judgment.attemptCount` (bumped by every claim/reclaim in claim.ts) keeps
 * climbing. Capping on `msg.attempt` alone would let repeated
 * crash-reclaim-then-fail cycles bypass the 3-attempt budget forever, since
 * that message's `attempt` field never moves.
 */

import type { Channel, ConsumeMessage } from 'amqplib';
import type { ModelEndpoint } from '@prisma/client';
import { Prisma } from '@prisma/client';
import type { CriteriaScore } from '@/types';
import { prisma } from '@/lib/db';
import { logger, serializeError } from '@/lib/logger';
import { publishEvent, runTopic } from '@/lib/realtime/events';
import {
  publishJudgmentRetry30s,
  publishJudgmentRetry5m,
  publishToDlq,
  type JudgmentExecuteMsg,
} from '@/lib/queue/publish';
import { classify } from '@/lib/llm/errors';
import { executeJudgment, executeRespond, executePairwise } from '@/lib/llm';
import type {
  RunProviderJudgmentInput as RegistryJudgmentInput,
  JudgmentResult as RegistryJudgmentResult,
  RunProviderResponseInput as RegistryResponseInput,
  RespondResult as RegistryRespondResult,
  PairwiseResult as RegistryPairwiseResult,
  SamplingParams,
} from '@/lib/llm';
import { maybeFinalizeRun } from '@/lib/run-finalizer';
import { deriveRunMode } from '@/lib/run-mode';
import { claimJudgment } from './claim';

/** Attempt budget: 1st delivery (attempt=1) plus up to 2 retries. On the
 * 3rd failed attempt the judgment goes to the DLQ instead of a further
 * retry queue. */
const MAX_ATTEMPTS = 3;

/** Bounded local retry for `persistSuccess` — NOT the queue-level retry
 * path (no provider re-execution, no attempt bump). See
 * `persistSuccessWithRetry`'s doc. */
const PERSIST_MAX_ATTEMPTS = 3;
const PERSIST_RETRY_DELAY_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Judgment context loading ───────────────────────────────────────────────

function judgmentContextQuery(judgmentId: string) {
  return prisma.modelJudgment.findUnique({
    where: { id: judgmentId },
    include: {
      run: {
        include: {
          evaluation: { select: { inputText: true, promptText: true, responseText: true } },
          rubric: { include: { criteria: { orderBy: { order: 'asc' as const } } } },
          // A0: the pairwise comparison set. Ordered by `position` here so
          // the presented order ('AB') is a property of the QUERY, not of
          // whatever order Postgres happened to return.
          runCandidates: { orderBy: { position: 'asc' as const } },
        },
      },
      judgeModelVersion: { include: { judgeModel: true } },
      // Task 10: the judge path renders its system prompt from this DB row
      // (render.ts) instead of the old inline `buildJudgmentSystemPrompt` —
      // see the guard below (`mode === 'judge' && !context.promptTemplate`).
      promptTemplate: true,
    },
  });
}

type JudgmentContext = NonNullable<Awaited<ReturnType<typeof judgmentContextQuery>>>;
type RunWithEvaluation = JudgmentContext['run'];
type RubricWithCriteria = NonNullable<RunWithEvaluation['rubric']>;
type VersionWithJudgeModel = NonNullable<JudgmentContext['judgeModelVersion']>;

// ─── The provider seam ──────────────────────────────────────────────────────

export interface RunProviderJudgmentInput {
  judgment: JudgmentContext;
  run: RunWithEvaluation;
  rubric: RubricWithCriteria;
  version: VersionWithJudgeModel;
  endpoint: ModelEndpoint;
}

/**
 * What a provider call produces. Deliberately a LOOSER local type than
 * `src/lib/llm/registry.ts`'s own `JudgmentResult` (which requires
 * `parseMode`/`samplingParamsUsed`, per the task brief verbatim) — the real
 * default implementation (`defaultRunProviderJudgment`, below) always
 * returns the full registry shape (a strict subtype, freely assignable
 * here), but keeping these two fields optional on the SEAM's own type means
 * every existing fake `ProviderFn` in the integration suites (which predate
 * this task and don't set them) keeps compiling unchanged — "keep the seam
 * signatures stable" per the task brief.
 */
export interface JudgmentResult {
  overallScore: number;
  reasoning: string;
  criteriaScores: CriteriaScore[];
  rawResponse: string;
  latencyMs: number;
  tokenCount?: number;
  servedModelId?: string;
  finishReason?: string;
  inputTokens?: number;
  outputTokens?: number;
  parseMode?: 'structured' | 'fallback';
  samplingParamsUsed?: SamplingParams;
}

export type ProviderFn = (input: RunProviderJudgmentInput) => Promise<JudgmentResult>;

/** Default `runProviderJudgment` — adapts a `JudgeModelVersion` +
 * `ModelEndpoint` + the judgment's resolved `PromptTemplate` into
 * `src/lib/llm/index.ts`'s registry-driven `executeJudgment`. `version`/
 * `endpoint` are passed straight through (structurally compatible with
 * `registry.ts`'s `JudgeVersionForExecution`/`EndpointCredentials` — no
 * adapter object needed); `registry.ts`'s `runProviderJudgment` owns the
 * `baseModel`-unset and key-resolution guards (moved there in Task 10, see
 * module doc). */
export const defaultRunProviderJudgment: ProviderFn = async (input) => {
  const { run, rubric, version, endpoint, judgment } = input;

  const registryInput: RegistryJudgmentInput = {
    judgeVersion: version,
    endpoint,
    // Guarded by the consumer's own `mode === 'judge' && !context.promptTemplate`
    // check before this seam is ever called (see `handle()` below) — the
    // non-null assertion documents that invariant rather than re-checking it.
    template: judgment.promptTemplate!,
    rubric: { name: rubric.name, description: rubric.description, criteria: rubric.criteria },
    submission: {
      inputText: run.evaluation.inputText,
      promptText: run.evaluation.promptText ?? undefined,
      responseText: run.evaluation.responseText ?? undefined,
    },
  };

  const result: RegistryJudgmentResult = await executeJudgment(registryInput);
  return result;
};

// ─── The respond-mode provider seam (Task 9b) ────────────────────────────────

export interface RunProviderResponseInput {
  judgment: JudgmentContext;
  run: RunWithEvaluation;
  version: VersionWithJudgeModel;
  endpoint: ModelEndpoint;
}

/** Respond-mode mirror of `JudgmentResult` above — same "looser local type,
 * strict registry type is a subtype" rationale. */
export interface RespondResult {
  responseText: string;
  rawResponse: string;
  latencyMs: number;
  tokenCount?: number;
  servedModelId?: string;
  finishReason?: string;
  inputTokens?: number;
  outputTokens?: number;
  samplingParamsUsed?: SamplingParams;
}

export type RespondProviderFn = (input: RunProviderResponseInput) => Promise<RespondResult>;

/** Default `runProviderResponse` — the respond-mode mirror of
 * `defaultRunProviderJudgment`: adapts a `JudgeModelVersion` +
 * `ModelEndpoint` pair into `executeRespond` (same registry dispatch, same
 * `callThroughResilience`-wrapped resilience machinery `executeJudgment`
 * uses — see module doc's "Respond mode" section). Prompt resolution
 * mirrors v1's `evaluation-run-manager.ts` respond branch exactly:
 * `promptText` if set, else fall back to `inputText`. */
export const defaultRunProviderResponse: RespondProviderFn = async (input) => {
  const { run, version, endpoint } = input;

  const registryInput: RegistryResponseInput = {
    judgeVersion: version,
    endpoint,
    submission: { promptText: run.evaluation.promptText?.trim() || run.evaluation.inputText },
  };

  const result: RegistryRespondResult = await executeRespond(registryInput);
  return result;
};

// ─── The pairwise provider seam (A0) ─────────────────────────────────────────

export interface RunProviderPairwiseInput {
  judgment: JudgmentContext;
  run: RunWithEvaluation;
  rubric: RubricWithCriteria;
  version: VersionWithJudgeModel;
  endpoint: ModelEndpoint;
}

/** Pairwise mirror of `JudgmentResult`/`RespondResult` — same "looser local
 * type, strict registry type is a subtype" rationale. A pairwise judge
 * emits a preference, so there is no `overallScore` and no
 * `criteriaScores`. */
export interface PairwiseJudgmentResult {
  verdict: 'A' | 'B' | 'tie';
  reasoning: string;
  rawResponse: string;
  latencyMs: number;
  tokenCount?: number;
  servedModelId?: string;
  finishReason?: string;
  inputTokens?: number;
  outputTokens?: number;
  samplingParamsUsed?: SamplingParams;
}

export type PairwiseProviderFn = (input: RunProviderPairwiseInput) => Promise<PairwiseJudgmentResult>;

/** Default `runProviderPairwise` — the pairwise mirror of
 * `defaultRunProviderJudgment`. The two candidate texts come from
 * `run.runCandidates` (NOT from the evaluation: a pair has two responses
 * and `Evaluation` has room for one), and the judgment's pinned
 * `PromptTemplate` is the seeded `v1-pairwise` row, whose `protocol` is
 * what drives `render.ts`'s branch into the A-vs-B user prompt. */
export const defaultRunProviderPairwise: PairwiseProviderFn = async (input) => {
  const { run, rubric, version, endpoint, judgment } = input;

  const registryInput: RegistryJudgmentInput = {
    judgeVersion: version,
    endpoint,
    // Guarded by the consumer's own promptTemplate check before this seam
    // is ever called (see `handle()` below).
    template: judgment.promptTemplate!,
    rubric: { name: rubric.name, description: rubric.description, criteria: rubric.criteria },
    submission: {
      inputText: run.evaluation.inputText,
      promptText: run.evaluation.promptText ?? undefined,
      candidates: run.runCandidates.map((candidate) => ({
        position: candidate.position,
        promptText: candidate.promptText,
        responseText: candidate.responseText,
        label: candidate.label,
      })),
    },
  };

  const result: RegistryPairwiseResult = await executePairwise(registryInput);
  return result;
};

// ─── Endpoint resolution ─────────────────────────────────────────────────────

/**
 * Resolve the `ModelEndpoint` to call through for `judgeModelVersionId` —
 * ALWAYS the run's `triggeredBy` user's own active endpoint for that
 * version, never anyone else's.
 *
 * Task 12 removes the pre-Task-12 cross-user fallback ("any active endpoint
 * for the version, regardless of owner") that lived here from Task 7
 * through Task 11 as a documented, disclosed gap. `src/lib/run-launch.ts`
 * (web tier) now validates the SAME ownership rule at launch time
 * (`requireOwnedActiveEndpoints`) before a run is even created, so in
 * practice this should already always find a row — this function's `null`
 * return remains the defense-in-depth path for the case a user deactivates
 * or deletes their endpoint between launch and execution (or a run created
 * before Task 12 has no owner-scoped endpoint at all). `triggeredById` is
 * nullable on `EvaluationRun` (no owner) — with none, there is by
 * definition no "their own" endpoint to resolve, so this returns `null`
 * immediately rather than guessing.
 */
async function resolveEndpoint(
  judgeModelVersionId: string,
  triggeredById: string | null
): Promise<ModelEndpoint | null> {
  if (!triggeredById) return null;

  return prisma.modelEndpoint.findFirst({
    where: { judgeModelVersionId, userId: triggeredById, isActive: true },
    orderBy: { createdAt: 'asc' },
  });
}

// ─── Persistence helpers ─────────────────────────────────────────────────────

async function markJudgmentError(judgmentId: string, message: string): Promise<void> {
  await prisma.modelJudgment.update({
    where: { id: judgmentId },
    data: { status: 'error', error: message },
  });
}

/**
 * `tokenCount` back-compat: prefer the real call's `inputTokens`+
 * `outputTokens` split (Task 10 metadata capture) when either is present;
 * fall back to a fake provider's own `tokenCount` (pre-Task-10 test fixture
 * shape, still valid — see `JudgmentResult`'s doc) otherwise. The
 * run-detail UI (`model-judgment-card.tsx`) only ever reads the combined
 * `tokenCount`, never the split.
 */
function combinedTokenCount(result: { tokenCount?: number; inputTokens?: number; outputTokens?: number }): number | undefined {
  if (result.inputTokens !== undefined || result.outputTokens !== undefined) {
    return (result.inputTokens ?? 0) + (result.outputTokens ?? 0);
  }
  return result.tokenCount;
}

/** Fields shared by `persistSuccess` (judge), `persistRespondSuccess`
 * (respond) and `persistPairwiseSuccess` (pairwise, A0) — every metadata
 * field that doesn't depend on which seam produced the result. Extracted so
 * the persist paths can't silently drift on a shared field (Task 10 review
 * simplification). */
interface CommonResultFields {
  rawResponse: string;
  latencyMs: number;
  tokenCount?: number;
  inputTokens?: number;
  outputTokens?: number;
  servedModelId?: string;
  finishReason?: string;
  samplingParamsUsed?: SamplingParams;
}

function commonSuccessUpdateData(result: CommonResultFields, version: VersionWithJudgeModel) {
  return {
    status: 'completed' as const,
    error: null,
    rawResponse: result.rawResponse,
    latencyMs: result.latencyMs,
    tokenCount: combinedTokenCount(result),
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    servedModelId: result.servedModelId,
    finishReason: result.finishReason,
    // Task 10: the EFFECTIVE sampling params a real call used
    // (`result.samplingParamsUsed` — version defaults ?? registry defaults
    // ?? per-call override, see registry.ts's `effectiveSamplingParams`)
    // when present; falls back to `version.samplingDefaults` for
    // pre-Task-10 test fixtures that don't set `samplingParamsUsed`.
    samplingParams: (result.samplingParamsUsed ?? version.samplingDefaults ?? undefined) as Prisma.InputJsonValue | undefined,
    reasoningEnabled:
      version.reasoningMode === 'always' ? true : version.reasoningMode === 'none' ? false : null,
  };
}

async function persistSuccess(
  judgmentId: string,
  result: JudgmentResult,
  version: VersionWithJudgeModel
): Promise<void> {
  await prisma.modelJudgment.update({
    where: { id: judgmentId },
    data: {
      ...commonSuccessUpdateData(result, version),
      overallScore: result.overallScore,
      reasoning: result.reasoning,
      criteriaScores: result.criteriaScores as unknown as Prisma.InputJsonValue,
      parseMode: result.parseMode,
    },
  });
}

/**
 * Respond-mode mirror of `persistSuccess` — persists v1's EXACT respond
 * judgment shape (`evaluation-run-manager.ts`'s respond branch, inspected
 * via `git show 2610871:src/lib/evaluation-run-manager.ts`): the generated
 * text lands in `reasoning` (NOT a new field — the run-detail UI's
 * `ModelJudgmentCard` already reads `judgment.reasoning` for both modes,
 * see src/app/evaluate/[id]/runs/[runId]/page.tsx), `overallScore` stays
 * `null` (no scoring concept in respond mode — `resolveHumanJudgmentScore`'s
 * 'respond' branch never reads it either), `criteriaScores` stays `null`
 * (`Prisma.DbNull`, matching v1's `Prisma.DbNull` exactly), and `status`
 * becomes `'completed'`.
 */
async function persistRespondSuccess(
  judgmentId: string,
  result: RespondResult,
  version: VersionWithJudgeModel
): Promise<void> {
  await prisma.modelJudgment.update({
    where: { id: judgmentId },
    data: {
      ...commonSuccessUpdateData(result, version),
      overallScore: null,
      reasoning: result.responseText,
      criteriaScores: Prisma.DbNull,
    },
  });
}

/**
 * Pairwise mirror of `persistSuccess`. `verdict` is stored RAW, as the
 * model said it, against the `pairOrder` the model was SHOWN — which
 * `run-launch.ts`/`run-create-consumer.ts` already wrote at creation time
 * and which this function deliberately does not touch. Which sample was
 * preferred is derived from (verdict, pairOrder) at read time; encoding it
 * here would make A2's BA sweep a backfill instead of an insert (A0 design
 * doc, decision #4).
 *
 * `overallScore` stays NULL and `criteriaScores` stays `Prisma.DbNull`:
 * a preference is not a score, and a fabricated 0 would be consumed by
 * every downstream average as though it were one.
 */
async function persistPairwiseSuccess(
  judgmentId: string,
  result: PairwiseJudgmentResult,
  version: VersionWithJudgeModel
): Promise<void> {
  await prisma.modelJudgment.update({
    where: { id: judgmentId },
    data: {
      ...commonSuccessUpdateData(result, version),
      overallScore: null,
      reasoning: result.reasoning,
      criteriaScores: Prisma.DbNull,
      verdict: result.verdict,
    },
  });
}

/**
 * `maybeFinalizeRun` (src/lib/run-finalizer.ts — the real, `SELECT ... FOR
 * UPDATE`-locked, concurrency-safe finalization pass), isolated in its own
 * try/catch. A finalization failure must never propagate into the
 * disposition catch below (where it would get misclassified as a provider
 * error, resetting an already-`completed` — or, for the error-path callers,
 * already-`error` — judgment back to `pending` and triggering a bogus
 * provider retry) and must never affect the judgment row itself. Log and
 * continue either way.
 */
async function safeFinalizeRun(runId: string): Promise<void> {
  try {
    await maybeFinalizeRun(runId);
  } catch (error) {
    logger.error('maybeFinalizeRun failed — continuing (run finalization only, no effect on the judgment row)', {
      runId,
      error: serializeError(error),
    });
  }
}

/**
 * Persist a successful provider result with bounded local retry (3
 * attempts, 250ms backoff) — a DB hiccup, not a queue-level retry: never
 * re-executes the provider, never bumps `attempt`.
 *
 * This exists because a persist failure after a successful (and possibly
 * BILLED) provider call must never be treated like a provider failure. Left
 * unhandled (or caught by the same catch as the provider call), it would
 * get `classify()`d as `retryable`, reset the judgment to `pending`, and
 * republish it onto `judgment.execute` — re-running the provider a second
 * time purely because writing the first result to Postgres failed.
 *
 * On exhaustion: logs loudly (`fatal`) and DLQs an envelope carrying the
 * FULL `JudgmentResult` (reason `'persist-failed-after-success'`) so the
 * result is never silently lost — an operator can inspect the DLQ and
 * manually replay the persist. The judgment row is deliberately left
 * `'running'` rather than flipped to `'error'` (the provider call DID
 * succeed) — Task 8's reaper will eventually reclaim a stale `'running'`
 * row once its lease expires. A subsequent reclaim would re-run the
 * provider a second time, which is a real but BOUNDED double-execution
 * risk (disclosed here, not hidden) — preferable to silently discarding a
 * real result or fabricating a false `'error'` status for a judgment that
 * actually succeeded.
 *
 * Returns `true` once persisted, `false` if the retry budget was
 * exhausted (DLQ envelope already published in that case).
 *
 * Generic over the result type (Task 9b): identical for judge
 * (`JudgmentResult`) and respond (`RespondResult`) — the retry/backoff/DLQ-
 * preservation CONTRACT doesn't care which shape it's persisting, only the
 * caller-supplied `doPersist` thunk (built from `persist`/`persistRespond`
 * closing over `result`/`version`) differs. This is the "same machinery"
 * requirement from Tasks 7/8: respond-mode gets IDENTICAL persist-retry/DLQ
 * semantics, not a parallel reimplementation.
 */
async function persistSuccessWithRetry<TResult>(
  msg: JudgmentExecuteMsg,
  result: TResult,
  doPersist: () => Promise<void>
): Promise<boolean> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= PERSIST_MAX_ATTEMPTS; attempt += 1) {
    try {
      await doPersist();
      return true;
    } catch (error) {
      lastError = error;
      logger.error('persistSuccess failed — retrying locally (provider already succeeded, not re-executing it)', {
        judgmentId: msg.judgmentId,
        runId: msg.runId,
        attempt,
        maxAttempts: PERSIST_MAX_ATTEMPTS,
        error: serializeError(error),
      });
      if (attempt < PERSIST_MAX_ATTEMPTS) {
        // eslint-disable-next-line no-await-in-loop -- bounded backoff between local retries of the SAME persist call, not something to parallelize
        await sleep(PERSIST_RETRY_DELAY_MS);
      }
    }
  }

  logger.fatal(
    'persistSuccess exhausted its local retry budget after a successful provider call — ' +
      'routing the result to the DLQ and leaving the judgment row "running" for a future reaper reclaim',
    {
      judgmentId: msg.judgmentId,
      runId: msg.runId,
      error: serializeError(lastError),
    }
  );

  await publishToDlq({ ...msg, result }, 'persist-failed-after-success');
  return false;
}

// ─── Consumer ────────────────────────────────────────────────────────────────

/** `persistSuccess`'s signature, as a named type so it can be constructor-
 * injected the same way `ProviderFn` is. */
export type PersistFn = (
  judgmentId: string,
  result: JudgmentResult,
  version: VersionWithJudgeModel
) => Promise<void>;

/** `persistRespondSuccess`'s signature — the respond-mode mirror of
 * `PersistFn`, constructor-injectable the same way. */
export type PersistRespondFn = (
  judgmentId: string,
  result: RespondResult,
  version: VersionWithJudgeModel
) => Promise<void>;

/** `persistPairwiseSuccess`'s signature — the pairwise mirror of
 * `PersistFn`, constructor-injectable the same way. */
export type PersistPairwiseFn = (
  judgmentId: string,
  result: PairwiseJudgmentResult,
  version: VersionWithJudgeModel
) => Promise<void>;

export interface JudgmentConsumerOptions {
  /** Constructor-injected judge-mode provider seam — defaults to
   * `defaultRunProviderJudgment`. Tests inject a fake to assert exactly-once
   * provider-call semantics without a live LLM/Redis-breaker dependency. */
  provider?: ProviderFn;
  /** Constructor-injected respond-mode provider seam (Task 9b) — defaults
   * to `defaultRunProviderResponse`. Same rationale as `provider`. */
  providerResponse?: RespondProviderFn;
  /** Constructor-injected judge-mode persist seam — defaults to
   * `persistSuccess`. Tests inject a fake that throws to exercise
   * `persistSuccessWithRetry`'s bounded-retry / DLQ-preservation path
   * deterministically, without needing to break the real DB connection to
   * simulate a persist failure. */
  persist?: PersistFn;
  /** Constructor-injected respond-mode persist seam (Task 9b) — defaults to
   * `persistRespondSuccess`. Same rationale as `persist`. */
  persistRespond?: PersistRespondFn;
  /** Constructor-injected pairwise provider seam (A0) — defaults to
   * `defaultRunProviderPairwise`. Same rationale as `provider`. */
  providerPairwise?: PairwiseProviderFn;
  /** Constructor-injected pairwise persist seam (A0) — defaults to
   * `persistPairwiseSuccess`. Same rationale as `persist`. */
  persistPairwise?: PersistPairwiseFn;
}

export interface JudgmentConsumer {
  handle(msg: ConsumeMessage, ch: Channel): Promise<void>;
}

export function createJudgmentConsumer(options: JudgmentConsumerOptions = {}): JudgmentConsumer {
  const provider = options.provider ?? defaultRunProviderJudgment;
  const providerResponse = options.providerResponse ?? defaultRunProviderResponse;
  const persist = options.persist ?? persistSuccess;
  const persistRespond = options.persistRespond ?? persistRespondSuccess;
  const providerPairwise = options.providerPairwise ?? defaultRunProviderPairwise;
  const persistPairwise = options.persistPairwise ?? persistPairwiseSuccess;

  async function handle(raw: ConsumeMessage, ch: Channel): Promise<void> {
    const msg = JSON.parse(raw.content.toString()) as JudgmentExecuteMsg;

    let claim = await claimJudgment(msg.judgmentId);
    if (claim === 'retry_claim') {
      // Inspection-race artifact (see claim.ts's docstring) — retry the
      // whole claim attempt once before giving up.
      claim = await claimJudgment(msg.judgmentId);
    }

    if (claim === 'not_found' || claim === 'already_done') {
      ch.ack(raw);
      return;
    }

    if (claim === 'in_progress') {
      // Redelivery landed on a still-live claim (within lease). Rather than
      // stranding this message until the lease expires — Task 8's
      // reclaim-sweeping reaper doesn't exist yet, so nothing would ever
      // re-check it — republish the SAME message (attempt unchanged) onto
      // the 30s retry queue as a delayed re-check: once its TTL elapses it
      // lands back on judgment.execute and this same decision runs again.
      // Bounded: LEASE_MS (~150s) / 30s cycles => ~5 cycles before the
      // lease itself expires and claim.ts's stale-reclaim path takes over.
      await publishJudgmentRetry30s(msg);
      ch.ack(raw);
      return;
    }

    if (claim === 'retry_claim') {
      // Still unresolved after one retry — nack-requeue rather than loop
      // claim attempts inline or ack-drop a possibly-still-claimable row.
      logger.warn('claimJudgment: retry_claim persisted after one retry — nack-requeueing', {
        judgmentId: msg.judgmentId,
      });
      ch.nack(raw, false, true);
      return;
    }
    // claim === 'claimed' | 'stale_running' — this delivery owns the row now.

    const context = await judgmentContextQuery(msg.judgmentId);
    const judgeModelVersion = context?.judgeModelVersion ?? null;

    if (!context || !judgeModelVersion) {
      await markJudgmentError(
        msg.judgmentId,
        !context
          ? 'Judgment row disappeared between claim and load'
          : 'ModelJudgment has no judgeModelVersionId set — the worker path requires one'
      );
      await safeFinalizeRun(msg.runId);
      ch.ack(raw);
      return;
    }

    // A0: protocol first, mode second. `EvaluationRun.protocol` decides
    // WHICH seam runs; `deriveRunMode` only ever decides judge-vs-respond
    // WITHIN pointwise. A pairwise run has no `Evaluation.responseText` by
    // construction (its two responses live on RunCandidate), so deriving
    // unconditionally would route every pairwise judgment to the respond
    // seam and generate text instead of comparing anything.
    const protocol = context.run.protocol;

    if (protocol === 'listwise') {
      await markJudgmentError(
        msg.judgmentId,
        'Listwise runs are not executable — a listwise set is storable and annotatable, not runnable'
      );
      await safeFinalizeRun(msg.runId);
      ch.ack(raw);
      return;
    }

    const mode = protocol === 'pointwise' ? deriveRunMode(context.run.evaluation.responseText) : 'judge';
    const rubric = context.run.rubric ?? null;

    if (mode === 'judge' && !rubric) {
      await markJudgmentError(
        msg.judgmentId,
        `EvaluationRun has no rubric — cannot build a ${protocol} judgment prompt`
      );
      await safeFinalizeRun(msg.runId);
      ch.ack(raw);
      return;
    }

    // Task 10: the judge path renders its system prompt from the
    // judgment's resolved `PromptTemplate` row (render.ts), loaded above by
    // `judgmentContextQuery`. `run-launch.ts`/`run-create-consumer.ts`
    // always resolve+require one for judge-mode runs at creation time (see
    // module doc), so a missing one here means the row is corrupt/stale
    // rather than a normal runtime condition — surfaced the same way the
    // missing-rubric case above is.
    if (mode === 'judge' && !context.promptTemplate) {
      await markJudgmentError(
        msg.judgmentId,
        'ModelJudgment has no promptTemplateId set — cannot render a judgment prompt'
      );
      await safeFinalizeRun(msg.runId);
      ch.ack(raw);
      return;
    }

    // A0: the comparison set is a hard precondition for a pairwise call.
    // Without it, `buildPairwiseUserPrompt` would throw inside
    // `prepareJudgmentCall` and surface as a rendering failure, which is a
    // far worse description of "this run was created without candidates".
    if (protocol === 'pairwise' && context.run.runCandidates.length !== 2) {
      await markJudgmentError(
        msg.judgmentId,
        `Pairwise run has ${context.run.runCandidates.length} RunCandidate rows — exactly 2 are required`
      );
      await safeFinalizeRun(msg.runId);
      ch.ack(raw);
      return;
    }

    const endpoint = await resolveEndpoint(judgeModelVersion.id, context.run.triggeredById);
    if (!endpoint) {
      await markJudgmentError(
        msg.judgmentId,
        `No active ModelEndpoint configured for JudgeModelVersion ${judgeModelVersion.id}`
      );
      await safeFinalizeRun(msg.runId);
      ch.ack(raw);
      return;
    }

    // The classify()-driven retry/DLQ disposition below wraps ONLY this
    // provider() call — see the module doc's "Disposition scope" section
    // for why persistence and finalization must not share this catch. Seam-
    // agnostic: it never inspects which of the three seams (judge/respond/
    // pairwise) produced the error — Tasks 7/8's retry/DLQ/claim machinery
    // applies identically to all three (see module doc's "Respond mode"
    // section).
    let judgeResult: JudgmentResult | null = null;
    let respondResult: RespondResult | null = null;
    let pairwiseResult: PairwiseJudgmentResult | null = null;
    try {
      if (protocol === 'pairwise') {
        pairwiseResult = await providerPairwise({
          judgment: context,
          run: context.run,
          rubric: rubric!, // non-null — pairwise is always mode 'judge', guarded above
          version: judgeModelVersion,
          endpoint,
        });
      } else if (mode === 'judge') {
        judgeResult = await provider({
          judgment: context,
          run: context.run,
          rubric: rubric!, // non-null — guarded above when mode === 'judge'
          version: judgeModelVersion,
          endpoint,
        });
      } else {
        respondResult = await providerResponse({
          judgment: context,
          run: context.run,
          version: judgeModelVersion,
          endpoint,
        });
      }
    } catch (rawError) {
      // `judgeModelVersion.servingBackend` (a real `ServingBackend` enum
      // value) doubles as the descriptive provider label classify() wants —
      // no legacy-string mapping needed now that registry.ts dispatches on
      // ServingBackend directly (Task 10 removed the old
      // `mapServingBackendToProvider` indirection).
      const providerError = classify(rawError, judgeModelVersion.servingBackend);

      if (providerError.kind === 'non_retryable') {
        await markJudgmentError(msg.judgmentId, providerError.message);
        await safeFinalizeRun(msg.runId);
        ch.ack(raw);
        return;
      }

      // effectiveAttempt, not the bare msg.attempt, drives the cap — see
      // module doc: msg.attempt doesn't advance across crash-reclaim
      // cycles, judgment.attemptCount does.
      const effectiveAttempt = Math.max(msg.attempt, context.attemptCount);

      if (effectiveAttempt >= MAX_ATTEMPTS) {
        await markJudgmentError(msg.judgmentId, providerError.message);
        await publishToDlq({ ...msg, attempt: effectiveAttempt }, providerError.message);
        await safeFinalizeRun(msg.runId);
        ch.ack(raw);
        return;
      }

      // Retryable/rate_limited, attempt budget remains — reset to 'pending'
      // so the redelivered message claims fresh (see claim.ts's docstring:
      // leaving it 'running' would make the redelivery look like a
      // duplicate of a still-live claim and get ack-skipped, never retried).
      await prisma.modelJudgment.update({
        where: { id: msg.judgmentId },
        data: { status: 'pending', error: providerError.message },
      });

      const nextMsg: JudgmentExecuteMsg = { ...msg, attempt: effectiveAttempt + 1 };
      if (providerError.breakerOpen || effectiveAttempt >= 2) {
        await publishJudgmentRetry5m(nextMsg);
      } else {
        await publishJudgmentRetry30s(nextMsg);
      }
      ch.ack(raw);
      return;
    }

    // Provider call succeeded — from here on, nothing re-enters the
    // provider-error disposition above. A persist failure gets its own
    // bounded local retry + DLQ preservation (persistSuccessWithRetry);
    // it must never reset the judgment to 'pending' and trigger a
    // re-execution of a provider call that already succeeded.
    const persisted =
      protocol === 'pairwise'
        ? await persistSuccessWithRetry(msg, pairwiseResult!, () =>
            persistPairwise(msg.judgmentId, pairwiseResult!, judgeModelVersion)
          )
        : mode === 'judge'
          ? await persistSuccessWithRetry(msg, judgeResult!, () =>
              persist(msg.judgmentId, judgeResult!, judgeModelVersion)
            )
          : await persistSuccessWithRetry(msg, respondResult!, () =>
              persistRespond(msg.judgmentId, respondResult!, judgeModelVersion)
            );
    if (!persisted) {
      // Retry budget exhausted — already logged fatally and DLQ'd (with
      // the full result) inside persistSuccessWithRetry. Row intentionally
      // left 'running'; ack so this message doesn't get redelivered and
      // re-attempt the same doomed persist (or worse, re-run the provider).
      ch.ack(raw);
      return;
    }

    try {
      await publishEvent(runTopic(msg.runId), {
        type: 'judgment.completed',
        payload: {
          runId: msg.runId,
          judgmentId: msg.judgmentId,
          judgeModelVersionId: judgeModelVersion.id,
          status: 'completed',
        },
      });
    } catch (publishError) {
      // Realtime publish failure is retryable-nonfatal by contract (see
      // src/lib/realtime/events.ts's docstring) — the judgment itself is
      // already durably persisted, log and continue rather than treat this
      // as a processing failure.
      logger.error('judgment.completed publish failed — continuing (non-fatal)', {
        runId: msg.runId,
        judgmentId: msg.judgmentId,
        error: serializeError(publishError),
      });
    }

    await safeFinalizeRun(msg.runId);
    ch.ack(raw);
  }

  return { handle };
}
