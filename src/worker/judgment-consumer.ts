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
 * ── Error disposition (classify() from src/lib/llm/errors.ts) ──────────────
 * - `non_retryable` -> judgment `error` + ack.
 * - `retryable` / `rate_limited`, attempt budget remains (`msg.attempt <
 *   3`) -> reset the judgment row to `pending` (see ./claim.ts's docstring
 *   for why leaving it `running` would break the retry — the redelivered
 *   message would look like a duplicate of a still-live claim and get
 *   ack-skipped instead of retried) and publish the message (with
 *   `attempt + 1`) onto `judgment.retry.30s` (1 -> 2) or `judgment.retry.5m`
 *   (2 -> 3); breaker-open failures always prefer the 5m queue regardless of
 *   attempt, since a breaker that's open needs longer than 30s to plausibly
 *   recover. Original message acked either way — the retry queue holds the
 *   next attempt, not a requeue of this one.
 * - Attempt budget exhausted (`msg.attempt >= 3`) -> judgment `error` +
 *   `publishToDlq` + ack.
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

// ─── Consumer ────────────────────────────────────────────────────────────────

export interface JudgmentConsumerOptions {
  /** Constructor-injected provider seam — defaults to
   * `defaultRunProviderJudgment`. Tests inject a fake to assert exactly-once
   * provider-call semantics without a live LLM/Redis-breaker dependency. */
  provider?: ProviderFn;
}

export interface JudgmentConsumer {
  handle(msg: ConsumeMessage, ch: Channel): Promise<void>;
}

export function createJudgmentConsumer(options: JudgmentConsumerOptions = {}): JudgmentConsumer {
  const provider = options.provider ?? defaultRunProviderJudgment;

  async function handle(raw: ConsumeMessage, ch: Channel): Promise<void> {
    const msg = JSON.parse(raw.content.toString()) as JudgmentExecuteMsg;

    const claim = await claimJudgment(msg.judgmentId);
    if (claim === 'not_found' || claim === 'already_done') {
      ch.ack(raw);
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
      await maybeFinalizeRun(msg.runId);
      ch.ack(raw);
      return;
    }

    const endpoint = await resolveEndpoint(judgeModelVersion.id, context.run.triggeredById);
    if (!endpoint) {
      await markJudgmentError(
        msg.judgmentId,
        `No active ModelEndpoint configured for JudgeModelVersion ${judgeModelVersion.id}`
      );
      await maybeFinalizeRun(msg.runId);
      ch.ack(raw);
      return;
    }

    try {
      const result = await provider({
        judgment: context,
        run: context.run,
        rubric,
        version: judgeModelVersion,
        endpoint,
      });

      await persistSuccess(msg.judgmentId, result, judgeModelVersion);

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

      await maybeFinalizeRun(msg.runId);
      ch.ack(raw);
    } catch (rawError) {
      const providerError = classify(rawError, mapServingBackendToProvider(judgeModelVersion.servingBackend));

      if (providerError.kind === 'non_retryable') {
        await markJudgmentError(msg.judgmentId, providerError.message);
        await maybeFinalizeRun(msg.runId);
        ch.ack(raw);
        return;
      }

      if (msg.attempt >= MAX_ATTEMPTS) {
        await markJudgmentError(msg.judgmentId, providerError.message);
        await publishToDlq(msg, providerError.message);
        await maybeFinalizeRun(msg.runId);
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

      const nextMsg: JudgmentExecuteMsg = { ...msg, attempt: msg.attempt + 1 };
      if (providerError.breakerOpen || msg.attempt >= 2) {
        await publishJudgmentRetry5m(nextMsg);
      } else {
        await publishJudgmentRetry30s(nextMsg);
      }
      ch.ack(raw);
    }
  }

  return { handle };
}
