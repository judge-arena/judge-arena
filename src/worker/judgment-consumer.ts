/**
 * ─── judgment.execute Consumer ─────────────────────────────────────────────
 *
 * Pipeline per message: read the judge id and acquire that judge's permit
 * (./concurrency.ts — BEFORE the claim, see below) -> claim (idempotent —
 * see ./claim.ts) -> load full
 * judgment context (run/evaluation/rubric/judge version/judge model, plus
 * A0's `RunCandidate` comparison set) -> resolve a `ModelEndpoint` to call
 * through -> run the provider call (via whichever of the three seams the
 * run's protocol and mode select — `runProviderJudgment`,
 * `runProviderResponse`, `runProviderPairwise`, all injectable for tests)
 * -> persist the result -> publish `judgment.completed` on `run:{runId}`
 * (best-effort, never fails the message) -> finalization pass
 * (`maybeFinalizeRun`, src/lib/run-finalizer.ts) -> ack.
 *
 * ── One provider call PER JUDGE, not one per worker ─────────────────────────
 * `handle()` takes a permit keyed on `judgeModelVersionId` before it does
 * anything else, and holds it until the message is disposed of — on EVERY
 * delivery, including one that arrived on a lane queue that is already serial
 * at the broker. Skipping the permit for lane deliveries would leave the
 * fallback queue's deliveries excluding nobody; see `gateKeyForDelivery` in
 * ./concurrency.ts. Judges on
 * different servers run in parallel; two deliveries for the SAME judge
 * serialise, because concurrent calls to one inference server queue INSIDE it
 * while their client timeout runs (that dead-lettered 4 of 30 items — see
 * ./concurrency.ts for the whole account, including why the prefetch and the
 * per-judge cap are two different numbers).
 *
 * THE ORDERING IS THE DESIGN. The permit is taken BEFORE `claimJudgment`,
 * which is why `resolveJudgeGateKey` exists as a separate one-column read
 * rather than reusing the post-claim context load: a delivery parked on a busy
 * gate while holding a claim would let its `LEASE_MS` (330s in production)
 * expire underneath it, the reaper would reset the row to `pending` and
 * republish, and the judgment would execute twice. Waiting before claiming
 * costs one indexed SELECT; waiting after claiming costs correctness.
 *
 * The wait is bounded (`GATE_WAIT_TIMEOUT_MS`) and times out into a
 * nack-REQUEUE, because an unacked delivery that outlives RabbitMQ's
 * 30-minute `consumer_timeout` gets the shared confirm channel closed under
 * it — which stops this worker consuming at all.
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
 *   onto a 30s delay (1 -> 2) or a 5m one (2 -> 3); breaker-open failures
 *   always prefer 5m regardless of attempt, since a breaker that's open needs
 *   longer than 30s to plausibly recover. Original message acked either way —
 *   the retry queue holds the next attempt, not a requeue of this one.
 *   WHICH delay queue depends on the delay; which LANE the attempt comes back
 *   to is `raw.fields.routingKey`, echoed rather than recomputed
 *   (`publishJudgmentRetryPreservingLane` below). A retry that changed lanes
 *   would stop being serialized against the server that just failed it.
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
import { getRabbit } from '@/lib/queue/connection';
import { EXCHANGE_DELAY_30S, EXCHANGE_DELAY_5M } from '@/lib/queue/topology';
import { resolveEndpointFor } from '@/lib/endpoint-resolution';
import { classify } from '@/lib/llm/errors';
// Imported from the module that defines it rather than from '@/lib/llm',
// whose public re-export list doesn't carry it — same shape as the
// '@/lib/llm/errors' import directly above.
import type { ProviderCallResult } from '@/lib/llm/provider';
import { executeJudgment, executeRespond, executePairwise } from '@/lib/llm';
import type {
  RunProviderJudgmentInput as RegistryJudgmentInput,
  JudgmentResult as RegistryJudgmentResult,
  RunProviderResponseInput as RegistryResponseInput,
  RespondResult as RegistryRespondResult,
  PairwiseResult as RegistryPairwiseResult,
  SamplingParams,
  TimeoutEscalationContext,
} from '@/lib/llm';
import { maybeFinalizeRun } from '@/lib/run-finalizer';
import { deriveRunMode } from '@/lib/run-mode';
import { claimJudgment } from './claim';
import { judgeLatencyBaseline, type LatencyBaseline } from '@/lib/calibration/latency';
import {
  GATE_WAIT_TIMEOUT_MS,
  JudgeGateTimeoutError,
  gateKeyForDelivery,
  judgeGate,
  laneOfDelivery,
  logGateTimeout,
  type KeyedGate,
} from './concurrency';

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

/**
 * The one extra read this design costs: which judge is this message for,
 * BEFORE anything is claimed.
 *
 * ── WHY IT CANNOT REUSE `judgmentContextQuery` ──────────────────────────────
 * That query runs AFTER `claimJudgment`, and the gate must be acquired
 * BEFORE it. The full context load is also a five-table `include`; this is a
 * primary-key lookup projecting one column.
 *
 * ── WHY THE GATE MUST PRECEDE THE CLAIM (the trap this design is built around)
 * `claim.ts`'s `LEASE_MS` = `EVALUATION_MODEL_TIMEOUT_MS + 30_000` — 330s in
 * production. A message that WAITS on a busy gate while HOLDING a claim has
 * its `ModelJudgment` row sitting in `running` with a frozen `updatedAt` the
 * whole time. Past the lease, `src/worker/reaper.ts`'s stale sweep resets it
 * to `pending` and republishes it, and `claim.ts`'s own `'stale_running'`
 * reclaim path will hand it to another delivery — while the original delivery
 * is still parked, about to wake up and execute. That is DUPLICATE EXECUTION
 * of a provider call, a correctness bug, not a slowdown. Acquiring the gate
 * first makes a parked message hold nothing at all: no claim, no lease, no DB
 * connection.
 *
 * Cost: one indexed SELECT per delivery. `id` is the primary key
 * (`ModelJudgment_pkey`), and `judgeModelVersionId` carries its own btree
 * index (`ModelJudgment_judgeModelVersionId_idx`, created in
 * prisma/migrations/20260725004838_v2_judgment_run_provenance/migration.sql:74
 * and verified present on the live schema) — though this lookup is served by
 * the PK alone.
 */
async function resolveJudgeGateKey(judgmentId: string, queueName: string | undefined): Promise<string> {
  const row = await prisma.modelJudgment.findUnique({
    where: { id: judgmentId },
    select: { judgeModelVersionId: true },
  });
  // `queueName` is passed and deliberately not branched on — see
  // `gateKeyForDelivery` (concurrency.ts) for why a lane delivery must take the
  // same permit a fallback delivery would.
  return gateKeyForDelivery(queueName, judgmentId, row?.judgeModelVersionId);
}

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
export interface JudgmentResult extends CommonResultFields {
  overallScore: number;
  reasoning: string;
  criteriaScores: CriteriaScore[];
  parseMode?: 'structured' | 'fallback';
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
/**
 * The escalating timeout's inputs, for ONE provider call.
 *
 * ── WHY THIS IS A FUNCTION AND NOT THREE INLINE BLOCKS ──────────────────────
 *
 * It was three inline blocks, and only one of them existed. Shipped
 * 2026-09-01 in `sha-414e826a3ba3`, the escalation was wired into
 * `defaultRunProviderJudgment` (pointwise) and into NEITHER
 * `defaultRunProviderPairwise` NOR `defaultRunProviderResponse` — so the
 * calibration path, which is pairwise and is the entire reason the feature
 * was requested, ran without it.
 *
 * The failure was silent in the worst way: `execute()` arms its own timers
 * from `resolveTimeoutBudgets()` unconditionally, so **the hard cap still
 * aborted and the 5-minute alert still fired.** The feature looked live. What
 * was missing was the *context*, and each omission degrades quietly:
 *
 *   - `attempt` fell back to 1, so `hardCapAbortKind(1)` returned `retryable`
 *     FOREVER. The owner asked for "two 15-minute attempts, then give up";
 *     what shipped could burn the full 3-attempt budget at 15 minutes each.
 *     This is the consequential one.
 *   - `latencyBaseline` was absent, so the alert claimed "this is the first
 *     judgment for this judge" against a judge with 26 completed judgments —
 *     stating the opposite of the truth, in an alert whose entire job is to
 *     tell an operator whether to worry.
 *   - `onInitialBudgetElapsed` never fired, so the "alert back to the running
 *     process" half of the request did not happen at all on this path.
 *
 * So the seams take a shared constructor rather than each remembering. A
 * fourth protocol added later gets it by calling one function, and
 * `judgment-consumer-escalation.test.ts` asserts every default seam does.
 *
 * `attempt` is the ROW's counter, not the message's. claim.ts increments
 * `attemptCount` on every claim AND every reclaim (:107, :138), so it survives
 * a redelivery carrying a stale message attempt — and under-counting here
 * would grant a third 15-minute try after the policy said stop.
 *
 * The baseline read is one indexed aggregate per judgment and deliberately
 * NOT fatal: a judge with no history is exactly the "first record" case the
 * owner asked to be forgiving about, so a failure to LOAD history must not
 * fail the judgment that would have CREATED the first data point.
 */
async function buildTimeoutEscalation(
  judgment: JudgmentContext,
  version: VersionWithJudgeModel
): Promise<TimeoutEscalationContext> {
  let latencyBaseline: LatencyBaseline | null = null;
  try {
    latencyBaseline = await judgeLatencyBaseline(version.id);
  } catch (error) {
    logger.warn('judgeLatencyBaseline failed — treating this call as unbaselined', {
      judgeModelVersionId: version.id,
      error: serializeError(error),
    });
  }

  return {
    attempt: judgment.attemptCount ?? 1,
    judgeModelVersionId: version.id,
    latencyBaseline,
    onInitialBudgetElapsed: (alert) => {
      logger.warn('judgment passed the initial timeout budget', {
        judgmentId: judgment.id,
        judgeModelVersionId: version.id,
        ...alert,
      });
    },
  };
}

export const defaultRunProviderJudgment: ProviderFn = async (input) => {
  const { run, rubric, version, endpoint, judgment } = input;

  const registryInput: RegistryJudgmentInput = {
    judgeVersion: version,
    endpoint,
    escalation: await buildTimeoutEscalation(judgment, version),
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
export interface RespondResult extends CommonResultFields {
  responseText: string;
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
  const { run, version, endpoint, judgment } = input;

  const registryInput: RegistryResponseInput = {
    judgeVersion: version,
    endpoint,
    escalation: await buildTimeoutEscalation(judgment, version),
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
 * `criteriaScores`. `parseMode` is OPTIONAL here for SYMMETRY with
 * `JudgmentResult` above (judgment-consumer.ts:305), which is optional for a
 * reason that does NOT apply on this seam: there is exactly one
 * `PairwiseProviderFn` fake in the tree (tests/integration/pairwise-run.test.ts:113,
 * the only `providerPairwise:` call site) and it is updated in the same commit,
 * so nothing here is kept compiling by the `?`. The registry's `PairwiseResult`
 * always carries the field. The cost of optional is that forgetting the write in
 * `persistPairwiseSuccess` type-checks green — tests/integration/pairwise-run.test.ts
 * pins it. */
export interface PairwiseJudgmentResult extends CommonResultFields {
  verdict: 'A' | 'B' | 'tie';
  reasoning: string;
  parseMode?: 'structured' | 'fallback';
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
    escalation: await buildTimeoutEscalation(judgment, version),
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
//
// This module used to own a private `resolveEndpoint` here. It is gone, and it
// had to go: the web tier's `requireOwnedActiveEndpoints` (run-launch.ts) and
// this consumer selected from the SAME set of legal `ModelEndpoint` rows with
// different rules — the publisher required `verifiedAt`, this one did not and
// took the OLDEST row — so a launch could be validated against one endpoint and
// executed against another. Under lanes that stops being latent: the publisher
// derives the lane from the row IT resolved, so a consumer that calls a
// different server is serialized against the wrong box while the queue depth
// says everything is fine. `resolveEndpointFor` (src/lib/endpoint-resolution.ts)
// is the single answer both sides now ask for. Nothing else belongs here.

// ─── Lane-preserving retries ─────────────────────────────────────────────────

/**
 * Publish a retry so that it comes back to the lane it left.
 *
 * ── WHY THIS CANNOT JUST CALL `publishJudgmentRetry30s` ─────────────────────
 * The original retry queues pin `x-dead-letter-routing-key` to
 * `judgment.execute` (topology.ts), so everything they release lands on the
 * FALLBACK queue no matter where it came from. A judgment that failed once
 * would silently stop being serialized against its own server — the failure
 * mode lanes exist to prevent, entered through the retry path.
 *
 * ── WHY A FANOUT AND NOT THE DIRECT EXCHANGE ────────────────────────────────
 * RabbitMQ preserves a message's routing key when dead-lettering only if
 * `x-dead-letter-routing-key` is absent, which is why the `.v2` retry queues
 * omit it. But publishing INTO a retry queue through `judge.direct` (whose
 * invariant is routing key == destination queue name) would make the retry
 * queue its own routing key, and the dead-letter would then deliver it straight
 * back to itself — an infinite TTL loop. A fanout ignores the routing key for
 * ROUTING while still carrying it on the message, so the lane survives the hop.
 * See topology.ts's `EXCHANGE_DELAY_30S` doc; proven on a live broker.
 *
 * `lane === null` means the delivery did not arrive on a lane (the fallback
 * queue, or a message with no usable routing key). Those take the original
 * path, unchanged — the legacy retry queues are still declared, still bound,
 * and still dead-letter onto the fallback, which is still consumed.
 *
 * LIVES HERE, NOT IN `src/lib/queue/publish.ts`, only because of how this
 * change was split across two concurrent workstreams. It is a producer and it
 * belongs with the other producers; moving it is a mechanical follow-up.
 */
export async function publishJudgmentRetryPreservingLane(
  msg: JudgmentExecuteMsg,
  delay: '30s' | '5m',
  lane: string | null
): Promise<void> {
  if (!lane) {
    await (delay === '5m' ? publishJudgmentRetry5m(msg) : publishJudgmentRetry30s(msg));
    return;
  }

  const { confirmChannel } = await getRabbit();
  const exchange = delay === '5m' ? EXCHANGE_DELAY_5M : EXCHANGE_DELAY_30S;
  const content = Buffer.from(JSON.stringify(msg));

  // Publisher-confirmed, like every other publish in this codebase: a retry
  // that is written to a socket buffer and lost leaves its judgment `pending`
  // with nothing scheduled to pick it up until the reaper's stale sweep.
  await new Promise<void>((resolve, reject) => {
    confirmChannel.publish(
      exchange,
      lane,
      content,
      { persistent: true, contentType: 'application/json' },
      (err) => {
        if (err) reject(err instanceof Error ? err : new Error(String(err)));
        else resolve();
      }
    );
  });
}

// ─── Persistence helpers ─────────────────────────────────────────────────────

/**
 * Mark a judgment failed — and, when the failure came WITH a provider
 * response (`ProviderError.callResult`, set by registry.ts's
 * `assertUsableContent`), persist that response alongside the message.
 *
 * THE FAILURE THIS FIXES: a failed judgment used to store a message string
 * and nothing else. Everything that explains the failure — the reasoning
 * channel the model filled instead of answering, the completion/reasoning
 * token split that shows WHERE the budget went, the rendered prompt that is
 * no longer reconstructible after a rubric edit — was discarded at exactly
 * the moment it was most diagnostic. That is the opposite of what a
 * calibration corpus needs from its failures.
 *
 * `callResult` is absent for every configuration/transport failure (there
 * was no response to carry), and the spread below writes nothing in that
 * case — an existing column is never overwritten with `undefined`.
 *
 * ── `claimedAt`: THE RUNTIME OF A FAILURE THAT RETURNED NOTHING ─────────────
 *
 * A TIMEOUT CARRIES NO `callResult`. `execute()`'s abort branch in
 * registry.ts (the `controller.signal.aborted` arm, ~registry.ts:836-855)
 * throws its `ProviderError` where there is no response to attach — and the
 * hard-cap abort on the final attempt is stamped `non_retryable`, so it lands
 * in exactly the branch below that passes `claimedAt`. Before this parameter,
 * the one judgment in the corpus with no
 * `latencyMs` was the one that had burned the ENTIRE budget. That is exactly
 * backwards: a judgment that ran fifteen minutes and died is the runtime you
 * most want recorded, and src/lib/calibration/latency.ts's (dataset, item,
 * model) projection would have silently excluded every slow failure while
 * looking complete. A runtime dataset that omits its expensive rows is worse
 * than none, because it reads as if the expensive rows do not exist.
 *
 * `claimedAt` is `ModelJudgment.startedAt` as loaded at claim time
 * (claim.ts:107/138 stamps it on every claim AND reclaim, so it is THIS attempt's
 * start). Elapsed-since-claim is a superset of the provider call — it also
 * covers the gate wait and the context load — which is why
 * `callResult.latencyMs`, measured around the HTTP call itself
 * (openai-compatible.ts:249), WINS when there is one.
 *
 * PASSED ONLY BY THE CALL SITES WHERE A PROVIDER CALL ACTUALLY RAN, and that
 * omission elsewhere is deliberate, not an oversight to be tidied up: the
 * configuration guards (no rubric, no endpoint, no prompt template, listwise,
 * row vanished) fail before anything is dispatched. Stamping their ~2ms of
 * Postgres round-trip into `latencyMs` would file rows in the runtime corpus
 * that measure nothing that was computed.
 *
 * Exported for the same reason `commonSuccessUpdateData` below is, and the
 * review that found it necessary: deleting this entire evidence spread left
 * all 726 tests green, because the only other way to observe this write is
 * a live DB. tests/lib/llm-truncation.test.ts now asserts it directly, and
 * tests/lib/calibration-latency.test.ts asserts the `claimedAt` arm.
 */
export async function markJudgmentError(
  judgmentId: string,
  message: string,
  callResult?: ProviderCallResult,
  claimedAt?: Date | null
): Promise<void> {
  // `Math.max(0, ...)` rather than a raw subtraction: a clock that stepped
  // backwards between the claim and the failure would otherwise write a
  // NEGATIVE latency, which every consumer of this column (mean, p90, the
  // per-tuple sum) would happily fold in and none would flag.
  const elapsedMs = claimedAt ? Math.max(0, Date.now() - claimedAt.getTime()) : undefined;

  await prisma.modelJudgment.update({
    where: { id: judgmentId },
    data: {
      status: 'error',
      error: message,
      // Written OUTSIDE the `callResult` spread so a timeout — which has no
      // callResult at all — still records what it cost. `undefined` when
      // there was no provider call, and an `undefined` in a Prisma update is
      // a no-op, so an existing column is never blanked.
      ...(elapsedMs !== undefined ? { latencyMs: elapsedMs } : {}),
      ...(callResult
        ? {
            rawResponse: callResult.text,
            latencyMs: callResult.latencyMs,
            servedModelId: callResult.servedModelId,
            finishReason: callResult.finishReason,
            inputTokens: callResult.inputTokens,
            outputTokens: callResult.outputTokens,
            tokenCount: combinedTokenCount(callResult),
            reasoningContent: callResult.reasoningText,
            reasoningTokens: callResult.reasoningTokens,
            reasoningSource: callResult.reasoningSource,
            systemPrompt: callResult.systemPrompt,
            userPrompt: callResult.userPrompt,
            userPromptSha256: callResult.userPromptSha256,
            promptTruncated: callResult.promptTruncated ?? false,
          }
        : {}),
    },
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
export interface CommonResultFields {
  rawResponse: string;
  latencyMs: number;
  tokenCount?: number;
  inputTokens?: number;
  outputTokens?: number;
  servedModelId?: string;
  finishReason?: string;
  samplingParamsUsed?: SamplingParams;
  // ── A2.1 v2i: what the model was given, and what it actually thought ──
  // Added HERE rather than on the three persist functions precisely so all
  // three get them in one edit and cannot drift. Typed loosely (`string`
  // for `reasoningSource`) for the same reason the seam result types above
  // are looser than registry.ts's: the registry's `ReasoningSource` union
  // is a strict subtype, and every pre-existing fake in the integration
  // suites keeps compiling.
  reasoningContent?: string;
  reasoningTokens?: number;
  reasoningSource?: string;
  systemPrompt?: string;
  userPrompt?: string;
  userPromptSha256?: string;
  promptTruncated?: boolean;
}

/** Exported ONLY so a unit test can assert that a field added for one
 * protocol reaches all three persist paths (tests/lib/pairwise-execution.test.ts)
 * — the anti-drift guarantee this extraction exists for is otherwise
 * unobservable without a live DB. */
export function commonSuccessUpdateData(result: CommonResultFields, version: VersionWithJudgeModel) {
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
    // NOT merged into `reasoning`: that column is already triple-booked
    // (parsed pointwise rationale, parsed pairwise rationale, and — in
    // persistRespondSuccess below — the ENTIRE generated answer), and the
    // thinking channel carries different content from all three. Merging is
    // unrecoverable once written.
    reasoningContent: result.reasoningContent,
    reasoningTokens: result.reasoningTokens,
    reasoningSource: result.reasoningSource,
    systemPrompt: result.systemPrompt,
    userPrompt: result.userPrompt,
    userPromptSha256: result.userPromptSha256,
    promptTruncated: result.promptTruncated ?? false,
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
      // #11 (2026-09-01): 'structured' = schema attached AND no fence/verdict
      // repair; 'fallback' otherwise. Rows written before this line are NULL.
      parseMode: result.parseMode,
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
  /** Constructor-injected per-judge gate — defaults to the process-wide
   * `judgeGate` singleton (src/worker/concurrency.ts). Injectable so a test
   * can hand in a fresh `createKeyedGate()` and not inherit permits from
   * another test file's consumer. */
  gate?: KeyedGate;
  /** Bounded wait for that gate — defaults to `GATE_WAIT_TIMEOUT_MS`. A test
   * lowers it to assert the requeue disposition without waiting ten minutes. */
  gateWaitMs?: number;
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
  const gate = options.gate ?? judgeGate;
  const gateWaitMs = options.gateWaitMs ?? GATE_WAIT_TIMEOUT_MS;

  /**
   * Gate first, then everything else.
   *
   * The permit is held across the ENTIRE claim+execute span — claim, context
   * load, provider call, persist, finalize, ack — because the thing being
   * protected is "at most one in-flight provider call per judge", and the
   * claim is what makes this delivery the one that will make that call.
   * Releasing any earlier would let a second delivery for the same judge claim
   * and dial out while this one is still talking to the server.
   *
   * `runExclusive` owns the `finally` (see concurrency.ts): a throw escaping
   * `executeClaimed` — a DB outage mid-persist, a bug in context loading —
   * must not leak the permit, or that judge is wedged for the life of the
   * process while its server sits idle.
   */
  async function handle(raw: ConsumeMessage, ch: Channel): Promise<void> {
    const msg = JSON.parse(raw.content.toString()) as JudgmentExecuteMsg;
    const gateKey = await resolveJudgeGateKey(msg.judgmentId, raw.fields.routingKey);

    try {
      await gate.runExclusive(gateKey, () => executeClaimed(raw, ch, msg), gateWaitMs);
    } catch (error) {
      if (!(error instanceof JudgeGateTimeoutError)) throw error;
      // NACK-REQUEUE, never ack and never drop: this delivery has done
      // nothing — it holds no claim, wrote nothing, and called no provider —
      // so putting it back on `judgment.execute` unchanged is exactly right,
      // and `attempt` deliberately does not advance (waiting for a busy judge
      // is not a failed attempt and must not burn the 3-attempt budget).
      // The alternative — keep waiting — walks into RabbitMQ's 30-minute
      // `consumer_timeout`, which closes the shared confirm channel and stops
      // this worker consuming entirely.
      logGateTimeout(error, msg.judgmentId, msg.runId);
      ch.nack(raw, false, true);
    }
  }

  async function executeClaimed(
    raw: ConsumeMessage,
    ch: Channel,
    msg: JudgmentExecuteMsg
  ): Promise<void> {
    /**
     * The lane this delivery arrived on, ECHOED rather than recomputed.
     *
     * Every retry below republishes to `lane`, and reading it off the delivery
     * is not merely cheaper than resolving the endpoint and calling
     * `laneQueueFor` again — it is more correct. A recomputed lane is a fresh
     * answer to "where should this go", and it can differ from the old one: the
     * user may have edited or deactivated the endpoint since the publish, and
     * `laneQueueFor` falls back to `judgment.execute` whenever it cannot
     * resolve. Either way the retry would leave the lane its predecessor is
     * still being serialized on, and the two attempts would then be free to hit
     * the same server at once — a retry storm against a box that is already
     * failing. The routing key is what the broker actually used, so echoing it
     * pins the retry to the lane the work is really on.
     *
     * `null` for a fallback/legacy delivery, which keeps today's behaviour.
     */
    const lane = laneOfDelivery(raw.fields.routingKey);

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
      // Back onto its OWN lane: the delivery this one is waiting behind is
      // being processed by that lane's single active consumer, so a re-check
      // that landed on the fallback would race it against exactly the claim it
      // is waiting for.
      await publishJudgmentRetryPreservingLane(msg, '30s', lane);
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

    // The SAME resolver the publisher used to pick the endpoint it derived this
    // judgment's lane from (src/lib/endpoint-resolution.ts). When the two
    // disagree, the judgment is serialized against a server it never calls.
    const endpoint = await resolveEndpointFor(context.run.triggeredById, judgeModelVersion.id);
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

      // `context.startedAt` is this attempt's claim timestamp
      // (claim.ts:107/138, loaded by `judgmentContextQuery` — an `include`, so
      // every scalar column comes back and this costs no extra query). It is
      // what gives a TIMEOUT a recorded runtime: a timed-out call throws with
      // no `callResult`, and without this the judgment that burned the whole
      // budget would be the only one in the corpus with no `latencyMs`. See
      // `markJudgmentError`'s doc.
      if (providerError.kind === 'non_retryable') {
        await markJudgmentError(msg.judgmentId, providerError.message, providerError.callResult, context.startedAt);
        await safeFinalizeRun(msg.runId);
        ch.ack(raw);
        return;
      }

      // effectiveAttempt, not the bare msg.attempt, drives the cap — see
      // module doc: msg.attempt doesn't advance across crash-reclaim
      // cycles, judgment.attemptCount does.
      const effectiveAttempt = Math.max(msg.attempt, context.attemptCount);

      if (effectiveAttempt >= MAX_ATTEMPTS) {
        // The give-up path, and the one whose runtime matters most: this is
        // where a judge that timed out on every attempt lands terminally.
        await markJudgmentError(msg.judgmentId, providerError.message, providerError.callResult, context.startedAt);
        await publishToDlq({ ...msg, attempt: effectiveAttempt }, providerError.message);
        await safeFinalizeRun(msg.runId);
        ch.ack(raw);
        return;
      }

      // Retryable/rate_limited, attempt budget remains — reset to 'pending'
      // so the redelivered message claims fresh (see claim.ts's docstring:
      // leaving it 'running' would make the redelivery look like a
      // duplicate of a still-live claim and get ack-skipped, never retried).
      //
      // NO RUNTIME IS RECORDED HERE, and that is a KNOWN, BOUNDED GAP rather
      // than an omission. This attempt's elapsed time is real spend, but the
      // row is not terminal: the next attempt overwrites `latencyMs` whether
      // it succeeds (`persistSuccess`) or fails (`markJudgmentError` above),
      // so writing it now would be erased rather than kept. Preserving EVERY
      // attempt's runtime needs a per-attempt row, which is a schema change
      // A2.3 explicitly rules out for this work ("the report is a PROJECTION,
      // not stored"). Consequence to know when reading
      // src/lib/calibration/latency.ts: a tuple's `totalMs` is the runtime of
      // its FINAL attempt, so a judgment that timed out once and then
      // succeeded under-reports by the abandoned attempt.
      await prisma.modelJudgment.update({
        where: { id: msg.judgmentId },
        data: { status: 'pending', error: providerError.message },
      });

      const nextMsg: JudgmentExecuteMsg = { ...msg, attempt: effectiveAttempt + 1 };
      await publishJudgmentRetryPreservingLane(
        nextMsg,
        providerError.breakerOpen || effectiveAttempt >= 2 ? '5m' : '30s',
        lane
      );
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
