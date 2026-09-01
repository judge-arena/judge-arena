/**
 * ─── LLM Provider Entry Point ────────────────────────────────────────────────
 *
 * `executeJudgment`/`executeRespond` are the resilience-wrapped entry
 * points: registry-driven (`./registry.ts`) provider calls run through the
 * Redis-backed circuit breaker + taxonomy-driven retry (unchanged
 * responsibility from before Task 10 — only what they wrap changed, from
 * the old lowercase-string `providers` map of provider classes to the
 * `ServingBackend`-keyed registry).
 *
 * Each of `executeJudgment`/`executeRespond` calls registry.ts's
 * `prepare*Call` step FIRST, OUTSIDE `callThroughResilience` — a
 * deliberate split (Task 10 review fix), not an oversight: `prepare*Call`
 * only ever fails on a permanent CONFIGURATION problem (unset `baseModel`,
 * no resolvable API key, an Ollama-backed judge, a malformed
 * `PromptTemplate`), never on provider health. Only the resolved
 * `execute*Call` step — the actual network call — runs inside the
 * breaker/retry wrapper. Before this split, a single misconfigured
 * `JudgeModelVersion` could trip the circuit breaker for its
 * servingBackend+endpoint+model key purely from a config error with zero
 * real requests sent, degrading every OTHER (correctly-configured) call
 * sharing that same breaker key — including the other mode (judge vs.
 * respond share the identical key formula).
 */

import type {
  RunProviderJudgmentInput,
  JudgmentResult,
  RunProviderResponseInput,
  RespondResult,
  PairwiseResult,
} from './registry';
import {
  prepareJudgmentCall,
  executeJudgmentCall,
  executePairwiseCall,
  prepareRespondCall,
  executeRespondCall,
} from './registry';
import { withRetry } from './resilience';
import { classify, ProviderError } from './errors';
import { getBreaker } from './breaker-redis';

/**
 * Build the circuit breaker key. Aggregator granularity: distinct per
 * serving backend *and* endpoint *and* model — without the endpoint
 * segment, a failing local Ollama instance would open the circuit for all
 * OpenAI-compatible endpoints including the real OpenAI API; without the
 * model segment, one bad model on a shared endpoint would trip every other
 * model routed through it. `modelId` is the ALREADY-RESOLVED, guaranteed-
 * non-null model id from a successful `prepare*Call` (never the raw,
 * possibly-null `JudgeModel.baseModel`) — by the time this is called,
 * `requireBaseModel` has already thrown for any judge where it was unset.
 */
function breakerKey(servingBackend: string, endpoint: string | null, modelId: string): string {
  return `${servingBackend}:${endpoint ?? 'default'}:${modelId}`;
}

/**
 * Gate + run a provider call through the Redis-backed circuit breaker and
 * taxonomy-driven retry.
 *
 * - `allow() === 'open'` fails fast with a `ProviderError` (`kind:
 *   'retryable'`, `breakerOpen: true`) without attempting the call at all
 *   or touching the retry loop — the queue uses `breakerOpen` to apply a
 *   longer nack-delay than an ordinary retryable failure.
 * - `allow() === 'half_open_probe'` gets exactly one attempt
 *   (`maxAttempts: 1`): retrying internally here would send several
 *   requests to a service we're not yet sure has recovered, defeating the
 *   point of a single probe.
 * - Every error crossing the provider boundary is classified immediately
 *   (with the real provider name) before `withRetry` ever sees it, so
 *   `withRetry`'s default taxonomy check and the error that ultimately
 *   propagates to the caller are both properly-typed `ProviderError`s.
 * - The breaker only ever records ONE outcome per call to `executeJudgment`/
 *   `executeRespond` — the whole retry sequence counts as a single
 *   breaker failure (or success).
 */
async function callThroughResilience<T>(
  providerName: string,
  key: string,
  fn: () => Promise<T>
): Promise<T> {
  const breaker = getBreaker(key);
  const state = await breaker.allow();

  if (state === 'open') {
    throw new ProviderError(
      `Circuit breaker open for "${key}" — this provider/model has failed repeatedly and is being backed off`,
      { kind: 'retryable', provider: providerName, breakerOpen: true }
    );
  }

  const retryOpts = state === 'half_open_probe' ? { maxAttempts: 1 } : {};

  try {
    const result = await withRetry(async () => {
      try {
        return await fn();
      } catch (error) {
        throw classify(error, providerName);
      }
    }, retryOpts);

    await breaker.onSuccess();
    return result;
  } catch (error) {
    await breaker.onFailure();
    throw error;
  }
}

/**
 * Execute a judgment through the registry, wrapped with retry + circuit
 * breaker for resilience. `prepareJudgmentCall` runs first and UNWRAPPED —
 * see module doc — so a configuration error (bad template, missing key,
 * unset baseModel, Ollama scoredRunsAllowed refusal) throws immediately
 * without touching the breaker or the retry loop.
 */
export async function executeJudgment(input: RunProviderJudgmentInput): Promise<JudgmentResult> {
  const prepared = prepareJudgmentCall(input);
  const key = breakerKey(input.judgeVersion.servingBackend, input.endpoint.endpoint, prepared.modelId);
  return callThroughResilience(input.judgeVersion.servingBackend, key, () => executeJudgmentCall(prepared));
}

/**
 * Execute a respond-mode generation through the registry, wrapped with
 * retry + circuit breaker for resilience. Same `prepare` split as
 * `executeJudgment` above.
 */
export async function executeRespond(input: RunProviderResponseInput): Promise<RespondResult> {
  const prepared = prepareRespondCall(input);
  const key = breakerKey(input.judgeVersion.servingBackend, input.endpoint.endpoint, prepared.modelId);
  return callThroughResilience(input.judgeVersion.servingBackend, key, () => executeRespondCall(prepared));
}

/**
 * Execute a PAIRWISE judgment through the registry, wrapped with retry +
 * circuit breaker. Same `prepare` split as `executeJudgment` — and the same
 * `prepareJudgmentCall`, because the branch that makes a call pairwise
 * lives in `render.ts` and is driven by `input.template.protocol`, not by
 * a separate preparation path.
 */
export async function executePairwise(input: RunProviderJudgmentInput): Promise<PairwiseResult> {
  const prepared = prepareJudgmentCall(input);
  const key = breakerKey(input.judgeVersion.servingBackend, input.endpoint.endpoint, prepared.modelId);
  return callThroughResilience(input.judgeVersion.servingBackend, key, () => executePairwiseCall(prepared));
}

export type {
  RunProviderJudgmentInput,
  JudgmentResult,
  RunProviderResponseInput,
  RespondResult,
  PairwiseResult,
};
export {
  getDescriptor,
  legacyProviderToBackend,
  resolveApiKey,
  effectiveSamplingParams,
  execute,
  runProviderJudgment,
  runProviderResponse,
} from './registry';
export type { ProviderDescriptor, SamplingParams, EndpointCredentials, JudgeVersionForExecution } from './registry';
// Re-exported so the worker's provider seams can name the context they must
// build. It is deliberately part of the barrel rather than a deep import: the
// seams are the only correct place to construct one, and a type they cannot
// reach through the same entry point as `executeJudgment`/`executePairwise` is
// a type they will quietly omit — which is exactly what happened on the
// pairwise and respond paths in sha-414e826a3ba3.
export type { TimeoutEscalationContext } from './registry';
