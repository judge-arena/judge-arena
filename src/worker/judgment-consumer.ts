/**
 * ─── judgment.execute Consumer ─────────────────────────────────────────────
 *
 * Pipeline per message: claim (idempotent — see ./claim.ts) -> load full
 * judgment context (run/evaluation/rubric/judge version/judge model) ->
 * resolve a `ModelEndpoint` to call through -> run the provider call (via
 * the `runProviderJudgment` seam, injectable for tests) -> persist the
 * result -> publish `judgment.completed` on `run:{runId}` (best-effort,
 * never fails the message) -> a placeholder finalization pass -> ack.
 *
 * ── The provider seam ───────────────────────────────────────────────────────
 * `runProviderJudgment` is intentionally narrow: `{ judgment, run, rubric,
 * version, endpoint } -> JudgmentResult`. The default implementation
 * (`defaultRunProviderJudgment`) adapts a `JudgeModelVersion` +
 * `ModelEndpoint` pair into the EXISTING `ProviderConfig`/`executeJudgment`
 * mechanics from `src/lib/llm/index.ts` (Stage C of the 1a/1b provider
 * layer) — it does not introduce new provider-calling logic. Task 10 is
 * expected to replace `defaultRunProviderJudgment`'s internals (a real
 * per-`servingBackend` adapter, `samplingDefaults` actually threaded into
 * the call, `JudgeModel.baseModel` resolution hardened) without touching
 * this consumer's control flow, since every caller only ever sees the seam.
 *
 * Known gap surfaced by wiring this seam for real: NOTHING today populates
 * `JudgeModel.baseModel` (not the 1a importer's `synthesizeJudges`, no seed
 * data) even though it's the only schema field that could hold the literal
 * provider model id (e.g. `"claude-sonnet-4-5-20250514"`) a `ProviderConfig`
 * needs. `defaultRunProviderJudgment` throws a `non_retryable` `ProviderError`
 * when it's unset rather than guessing from `slug`/`name` — a
 * misconfiguration should surface as a judgment error, not a request sent
 * with a garbage model id.
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
import type { ModelEndpoint, Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { logger, serializeError } from '@/lib/logger';
import { decryptSafe } from '@/lib/crypto';
import { publishEvent, runTopic } from '@/lib/realtime/events';
import {
  publishJudgmentRetry30s,
  publishJudgmentRetry5m,
  publishToDlq,
  type JudgmentExecuteMsg,
} from '@/lib/queue/publish';
import { classify, ProviderError } from '@/lib/llm/errors';
import { executeJudgment } from '@/lib/llm';
import type { JudgmentRequest, JudgmentResponse, ProviderConfig } from '@/lib/llm';
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
        },
      },
      judgeModelVersion: { include: { judgeModel: true } },
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

/** What a provider call produces — alias of the existing `JudgmentResponse`
 * shape (see src/lib/llm/provider.ts); named `JudgmentResult` here to match
 * the seam's brief-specified interface. */
export type JudgmentResult = JudgmentResponse;

export type ProviderFn = (input: RunProviderJudgmentInput) => Promise<JudgmentResult>;

/**
 * `JudgeModelVersion.servingBackend` -> the provider registry key
 * `src/lib/llm/index.ts#getProvider` understands today (`anthropic` |
 * `openai` | `local`). `openrouter`/`vllm`/`ollama` are all reached as
 * OpenAI-compatible HTTP endpoints, so they route through the generic
 * `local` provider (custom `endpoint` + bearer key) until Task 10 gives
 * each `servingBackend` its own adapter.
 */
function mapServingBackendToProvider(servingBackend: VersionWithJudgeModel['servingBackend']): string {
  switch (servingBackend) {
    case 'anthropic':
      return 'anthropic';
    case 'openai':
      return 'openai';
    case 'openrouter':
    case 'vllm':
    case 'ollama':
    default:
      return 'local';
  }
}

/** Default `runProviderJudgment` — adapts a `JudgeModelVersion` +
 * `ModelEndpoint` into the existing `ProviderConfig`/`executeJudgment`
 * mechanics. See module doc for the `baseModel` gap this surfaces. */
export const defaultRunProviderJudgment: ProviderFn = async (input) => {
  const { run, rubric, version, endpoint } = input;
  const providerName = mapServingBackendToProvider(version.servingBackend);

  const modelId = version.judgeModel.baseModel;
  if (!modelId) {
    throw new ProviderError(
      `JudgeModel "${version.judgeModel.slug}" has no baseModel configured — cannot resolve a ` +
        `provider model id for JudgeModelVersion ${version.id}`,
      { kind: 'non_retryable', provider: providerName }
    );
  }

  const config: ProviderConfig = {
    modelId,
    endpoint: endpoint.endpoint ?? undefined,
    apiKey: endpoint.apiKeyEnc ? decryptSafe(endpoint.apiKeyEnc) : undefined,
  };

  const request: JudgmentRequest = {
    inputText: run.evaluation.inputText,
    promptText: run.evaluation.promptText ?? undefined,
    responseText: run.evaluation.responseText ?? undefined,
    rubricCriteria: rubric.criteria,
    rubricName: rubric.name,
    rubricDescription: rubric.description ?? undefined,
  };

  return executeJudgment(providerName, request, config);
};

// ─── Endpoint resolution ─────────────────────────────────────────────────────

/**
 * Resolve a `ModelEndpoint` to call through for `judgeModelVersionId`.
 * Preferred: an active endpoint owned by the run's `triggeredBy` user
 * (their own configured key/endpoint for this judge version). Fallback: any
 * active endpoint for the version, regardless of owner — documented gap,
 * not a real multi-tenant authorization model. Acceptable for the worker's
 * current single-process, pre-Task-9/12 scope: the only per-user secret at
 * stake is `apiKeyEnc`, and Task 9 (web tier) / Task 12 (auth hardening) own
 * the real ownership story for judge execution.
 */
async function resolveEndpoint(
  judgeModelVersionId: string,
  triggeredById: string | null
): Promise<ModelEndpoint | null> {
  if (triggeredById) {
    const owned = await prisma.modelEndpoint.findFirst({
      where: { judgeModelVersionId, userId: triggeredById, isActive: true },
      orderBy: { createdAt: 'asc' },
    });
    if (owned) return owned;
  }

  return prisma.modelEndpoint.findFirst({
    where: { judgeModelVersionId, isActive: true },
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

async function persistSuccess(
  judgmentId: string,
  result: JudgmentResult,
  version: VersionWithJudgeModel
): Promise<void> {
  await prisma.modelJudgment.update({
    where: { id: judgmentId },
    data: {
      status: 'completed',
      error: null,
      overallScore: result.overallScore,
      reasoning: result.reasoning,
      rawResponse: result.rawResponse,
      criteriaScores: result.criteriaScores as unknown as Prisma.InputJsonValue,
      latencyMs: result.latencyMs,
      tokenCount: result.tokenCount,
      // Provenance capture only — not yet threaded into the actual provider
      // call (see defaultRunProviderJudgment's doc / Task 10).
      samplingParams: (version.samplingDefaults ?? undefined) as Prisma.InputJsonValue | undefined,
      reasoningEnabled:
        version.reasoningMode === 'always' ? true : version.reasoningMode === 'none' ? false : null,
    },
  });
}

/**
 * TASK 8 replaces: minimal placeholder finalization. Counts remaining
 * `pending`/`running` judgments for the run; if none remain, flips the run
 * to `needs_human` + stamps `finalizedAt`. No `SELECT ... FOR UPDATE` row
 * lock — two judgments on the same run finishing at nearly the same instant
 * could both observe `remaining === 0` and both reach the `updateMany`
 * below, but its own `status: { in: [...] }` guard makes that harmless (the
 * second call just updates 0 rows once the first has already moved the run
 * off `pending`/`judging`). Task 8 replaces this with a real
 * concurrency-safe finalization pass.
 */
async function maybeFinalizeRun(runId: string): Promise<void> {
  const remaining = await prisma.modelJudgment.count({
    where: { runId, status: { in: ['pending', 'running'] } },
  });
  if (remaining > 0) return;

  await prisma.evaluationRun.updateMany({
    where: { id: runId, status: { in: ['pending', 'judging'] } },
    data: { status: 'needs_human', finalizedAt: new Date() },
  });
}

/**
 * `maybeFinalizeRun`, isolated in its own try/catch. A finalization failure
 * must never propagate into the disposition catch below (where it would get
 * misclassified as a provider error, resetting an already-`completed` — or,
 * for the error-path callers, already-`error` — judgment back to `pending`
 * and triggering a bogus provider retry) and must never affect the
 * judgment row itself. Log and continue either way.
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
 */
async function persistSuccessWithRetry(
  msg: JudgmentExecuteMsg,
  result: JudgmentResult,
  version: VersionWithJudgeModel,
  persist: PersistFn
): Promise<boolean> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= PERSIST_MAX_ATTEMPTS; attempt += 1) {
    try {
      await persist(msg.judgmentId, result, version);
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

export interface JudgmentConsumerOptions {
  /** Constructor-injected provider seam — defaults to
   * `defaultRunProviderJudgment`. Tests inject a fake to assert exactly-once
   * provider-call semantics without a live LLM/Redis-breaker dependency. */
  provider?: ProviderFn;
  /** Constructor-injected persist seam — defaults to `persistSuccess`.
   * Tests inject a fake that throws to exercise `persistSuccessWithRetry`'s
   * bounded-retry / DLQ-preservation path deterministically, without
   * needing to break the real DB connection to simulate a persist failure. */
  persist?: PersistFn;
}

export interface JudgmentConsumer {
  handle(msg: ConsumeMessage, ch: Channel): Promise<void>;
}

export function createJudgmentConsumer(options: JudgmentConsumerOptions = {}): JudgmentConsumer {
  const provider = options.provider ?? defaultRunProviderJudgment;
  const persist = options.persist ?? persistSuccess;

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
    const rubric = context?.run.rubric ?? null;

    if (!context || !judgeModelVersion || !rubric) {
      await markJudgmentError(
        msg.judgmentId,
        !context
          ? 'Judgment row disappeared between claim and load'
          : !judgeModelVersion
            ? 'ModelJudgment has no judgeModelVersionId set — the worker path requires one'
            : 'EvaluationRun has no rubric — cannot build a pointwise judgment prompt'
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
    // for why persistence and finalization must not share this catch.
    let result: JudgmentResult;
    try {
      result = await provider({
        judgment: context,
        run: context.run,
        rubric,
        version: judgeModelVersion,
        endpoint,
      });
    } catch (rawError) {
      const providerError = classify(rawError, mapServingBackendToProvider(judgeModelVersion.servingBackend));

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
    const persisted = await persistSuccessWithRetry(msg, result, judgeModelVersion, persist);
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
