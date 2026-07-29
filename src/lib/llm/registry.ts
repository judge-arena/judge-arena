/**
 * ─── Provider Descriptor Registry ───────────────────────────────────────────
 *
 * Central, `ServingBackend`-keyed registry replacing the old lowercase-
 * string `providers` map in `index.ts` (`{ anthropic, openai, local }`).
 * `ServingBackend` (prisma/schema.prisma) is now the ONE key space every
 * provider-shaped lookup in this codebase should route through:
 * `anthropic | openai | openrouter | vllm | ollama`.
 *
 * `getDescriptor()` returns a `ProviderDescriptor` for all five backends
 * now, even though only `anthropic`/`openai` have a real backend module
 * wired up as of this task — `openrouter`/`vllm` route through the generic
 * `openai_compatible` dispatch in `execute()` below (Task 11 gives them
 * their own request-shaping, e.g. OpenRouter's attribution headers and
 * vLLM's `guided_json`, without changing this registry's shape).
 *
 * This module also owns:
 * - `legacyProviderToBackend()` — the ONE place this mapping lives for LIVE
 *   runtime code: `verify.ts` (legacy `ModelConfig` connection tests) and
 *   `src/lib/judge-identity.ts` (the ModelConfig -> JudgeModelVersion
 *   bridge) both delegate to it now instead of each carrying an independent
 *   copy. `scripts/importer/judges.ts`'s OWN `classifyProvider` (the 1a
 *   one-shot v1->v2 migration script) still has its own literal copy —
 *   deliberately NOT unified with this one (same reasoning
 *   `judge-identity.ts`'s module doc already gives for not touching that
 *   script: it processes a frozen v1 dataset once, not live traffic, and
 *   its mapping is pinned to v1's historical semantics rather than meant to
 *   track future `ServingBackend` changes).
 * - `resolveApiKey()` — the ONE place a `ModelEndpoint`'s credential is
 *   resolved, closing two bugs: (1) the ciphertext-as-key bug (callers used
 *   to pass `apiKeyEnc` straight through as if it were already plaintext —
 *   this always decrypts first), and (2) the `OPENAI_API_KEY`-leaked-to-
 *   arbitrary-endpoint bug (env fallback now requires BOTH a known official
 *   host descriptor AND no custom endpoint override — see its doc below).
 * - `execute()` — the low-level, single-attempt call primitive
 *   (`runProviderJudgment`/`runProviderResponse`'s "registry-driven
 *   execute(descriptor, request)" from the task brief): resolves the
 *   backend module, wires the `EVALUATION_MODEL_TIMEOUT_MS` budget into a
 *   real `AbortController`, and captures response metadata. NOT
 *   retried/breaker-wrapped — `index.ts`'s `executeJudgment`/`executeRespond`
 *   own that (unchanged responsibility, now wrapping this instead of the
 *   old provider classes).
 * - `runProviderJudgment()` / `runProviderResponse()` — the per-brief
 *   `{ judgeVersion, endpoint, template, rubric, submission,
 *   samplingOverrides? } -> JudgmentResult` entry points that
 *   `judgment-consumer.ts`'s `defaultRunProviderJudgment`/
 *   `defaultRunProviderResponse` seams adapt their own (differently-shaped)
 *   inputs into. Each is a thin `prepare*Call` + `execute*Call` composition
 *   (see below) — `index.ts`'s `executeJudgment`/`executeRespond` call
 *   those TWO halves separately instead of this combined function, so only
 *   the network-calling half is breaker/retry-wrapped.
 * - `prepareJudgmentCall()` / `prepareRespondCall()` — validation +
 *   resolution ONLY (descriptor lookup, `scoredRunsAllowed`, `baseModel`/
 *   API-key resolution, DB-templated prompt rendering). No network I/O.
 *   Every failure here is a permanent CONFIGURATION problem, not a
 *   provider-health signal — see `prepareJudgmentCall`'s own doc for why
 *   this must run OUTSIDE the circuit breaker.
 * - `executeJudgmentCall()` / `executeRespondCall()` — the actual network
 *   call (via `execute()`) + response parsing for an already-`prepare`d
 *   call. This is the part `index.ts` wraps with breaker/retry: the only
 *   part that reflects real provider health.
 */

import type { ServingBackend } from '@prisma/client';
import type { CriteriaScore } from '@/types';
import { decryptSafe } from '@/lib/crypto';
import { ProviderError } from './errors';
import { callAnthropic } from './anthropic';
import { callOpenAICompatible } from './openai-compatible';
import { renderJudgmentPrompt, type RenderRubric, type RenderSubmission, type RenderTemplate } from './render';
import { buildRespondSystemPrompt, buildRespondUserPrompt, parseJudgmentResponse } from './provider';
import type { ProviderCallResult } from './provider';

// ─── Descriptor ──────────────────────────────────────────────────────────────

/** Context handed to a descriptor's optional `headers()` hook — enough to
 * build attribution/auth headers without the hook needing the full request.
 * Unused by any descriptor today (OpenRouter's `HTTP-Referer`/`X-Title`
 * land in Task 11); the hook exists now so `execute()`'s dispatch shape
 * doesn't need to change when Task 11 starts using it. */
export interface ProviderHeaderConfig {
  apiKey?: string;
  endpoint?: string;
}

export interface ProviderDescriptor {
  id: ServingBackend;
  kind: 'api' | 'openai_compatible';
  defaultBaseUrl?: string;
  auth: 'bearer' | 'x-api-key';
  caps: {
    structuredOutput: 'json_schema' | 'tool_use' | 'guided' | 'none';
    samplingParams: boolean;
    reasoningToggle: boolean;
  };
  headers?(cfg: ProviderHeaderConfig): Record<string, string>;
  scoredRunsAllowed: boolean;
}

/**
 * `kind` is a TRUST/AUTH classification, not a wire-protocol one: `'api'`
 * marks the two backends judge-arena ships an official env-var fallback
 * key for (`ANTHROPIC_API_KEY`/`OPENAI_API_KEY`) because their default host
 * is a well-known, first-party endpoint. Every other backend — including
 * OpenRouter, which also has a well-known default host — is
 * `'openai_compatible'`: no env fallback, a `ModelEndpoint` must carry its
 * own key. See `resolveApiKey()`'s doc for exactly how this gates env
 * fallback.
 *
 * `ollama`'s `scoredRunsAllowed: false` (per the task brief, verbatim):
 * local/dev Ollama models are not eligible to produce trusted, scored judge
 * runs — `runProviderJudgment()` refuses immediately (`non_retryable`) for
 * any `JudgeModelVersion` whose `servingBackend` resolves to this
 * descriptor. Respond-mode generation (`runProviderResponse()`) has no such
 * restriction — there is no "trust" concept for plain text generation.
 */
const DESCRIPTORS: Record<ServingBackend, ProviderDescriptor> = {
  anthropic: {
    id: 'anthropic',
    kind: 'api',
    auth: 'x-api-key',
    caps: { structuredOutput: 'tool_use', samplingParams: true, reasoningToggle: true },
    scoredRunsAllowed: true,
  },
  openai: {
    id: 'openai',
    kind: 'api',
    auth: 'bearer',
    caps: { structuredOutput: 'json_schema', samplingParams: true, reasoningToggle: true },
    scoredRunsAllowed: true,
  },
  openrouter: {
    id: 'openrouter',
    kind: 'openai_compatible',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    auth: 'bearer',
    caps: { structuredOutput: 'json_schema', samplingParams: true, reasoningToggle: false },
    scoredRunsAllowed: true,
  },
  vllm: {
    id: 'vllm',
    kind: 'openai_compatible',
    auth: 'bearer',
    caps: { structuredOutput: 'guided', samplingParams: true, reasoningToggle: false },
    scoredRunsAllowed: true,
  },
  ollama: {
    id: 'ollama',
    kind: 'openai_compatible',
    defaultBaseUrl: 'http://localhost:11434/v1',
    auth: 'bearer',
    caps: { structuredOutput: 'none', samplingParams: true, reasoningToggle: false },
    scoredRunsAllowed: false,
  },
};

export function getDescriptor(backend: ServingBackend): ProviderDescriptor {
  const descriptor = DESCRIPTORS[backend];
  if (!descriptor) {
    throw new Error(`getDescriptor: unknown ServingBackend "${backend}"`);
  }
  return descriptor;
}

/**
 * Translate the legacy `ModelConfig.provider` string
 * (`'anthropic' | 'openai' | 'local'`) into a `ServingBackend`. `'local'`
 * maps onto `'openai'` — both a real OpenAI call and a self-hosted
 * "local" endpoint speak the same OpenAI-compatible wire format and always
 * dispatched through the same backend module even before this task (the old
 * `providers` map pointed both `openai` and `local` at
 * `OpenAICompatibleProvider`). This does NOT make a `'local'`-mapped call
 * eligible for the `OPENAI_API_KEY` env fallback: `resolveApiKey()` gates
 * that separately on the `ModelEndpoint` having no custom `endpoint` URL —
 * a `'local'` config always has one, so the guard applies regardless of
 * which descriptor id the backend resolves to.
 *
 * Used by `verify.ts` (legacy `ModelConfig` connection tests) and
 * `src/lib/judge-identity.ts` (`classifyProvider`'s `servingBackend` field)
 * — the two "ModelConfig adapter" call sites the task brief calls out.
 */
export function legacyProviderToBackend(provider: string): ServingBackend {
  switch (provider) {
    case 'anthropic':
      return 'anthropic';
    case 'openai':
      return 'openai';
    case 'local':
      return 'openai';
    default:
      throw new Error(`legacyProviderToBackend: unrecognized legacy provider "${provider}"`);
  }
}

// ─── Key resolution ──────────────────────────────────────────────────────────

/** Provider-class env var fallback — ONLY consulted for `kind: 'api'`
 * descriptors (see `resolveApiKey`'s doc). Not part of `ProviderDescriptor`
 * itself (kept per the brief's verbatim interface). */
const ENV_API_KEY_NAME: Partial<Record<ServingBackend, string>> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
};

/** Minimal shape `resolveApiKey` needs from a `ModelEndpoint` row (or a
 * `ModelEndpoint`-shaped adapter — see `verify.ts`). */
export interface EndpointCredentials {
  apiKeyEnc: string | null;
  endpoint: string | null;
}

/**
 * Resolve the API key to use for a call against `descriptor`.
 *
 * 1. The endpoint's OWN key, decrypted (`decryptSafe` — safe no-op if the
 *    value isn't actually ciphertext, which covers `verify.ts`'s case of an
 *    already-decrypted plaintext key passed through this same slot). This
 *    is the fix for the ciphertext-as-key MAJOR: every prior call site that
 *    read `ModelEndpoint.apiKeyEnc`/`ModelConfig.apiKey` and used it
 *    directly as the bearer/x-api-key value was sending Postgres ciphertext
 *    to the provider instead of the real key.
 * 2. ONLY if there's no per-endpoint key: the provider-class env var
 *    (`ANTHROPIC_API_KEY`/`OPENAI_API_KEY`), and ONLY when BOTH
 *    `descriptor.kind === 'api'` (a known, official host judge-arena ships
 *    a blessed env var for) AND `endpoint.endpoint` is unset (no custom URL
 *    override). This closes the `OPENAI_API_KEY`-to-arbitrary-endpoint leak
 *    MAJOR: the old `openai-compatible.ts` fell back to
 *    `process.env.OPENAI_API_KEY` whenever a per-model key was absent,
 *    REGARDLESS of whether `config.endpoint` pointed at a real OpenAI host
 *    or an arbitrary user-supplied URL (self-hosted proxy, OpenRouter,
 *    anything) — sending the real OpenAI account key to that URL. A custom
 *    `endpoint` now unconditionally disables env fallback, independent of
 *    which descriptor id the call resolves to.
 *
 * Returns `undefined` (never a dummy/placeholder string) when no key is
 * resolvable — callers decide how to treat that (registry.ts's
 * `runProviderJudgment`/`runProviderResponse` throw `non_retryable`).
 */
export function resolveApiKey(descriptor: ProviderDescriptor, endpoint: EndpointCredentials): string | undefined {
  if (endpoint.apiKeyEnc) {
    return decryptSafe(endpoint.apiKeyEnc);
  }

  if (descriptor.kind === 'api' && !endpoint.endpoint) {
    const envName = ENV_API_KEY_NAME[descriptor.id];
    const envValue = envName ? process.env[envName] : undefined;
    if (envValue) return envValue;
  }

  return undefined;
}

// ─── Sampling params ─────────────────────────────────────────────────────────

export interface SamplingParams {
  temperature: number;
  max_tokens: number;
}

/**
 * Registry-level fallback sampling params — the hardcoded literals every
 * backend module used to declare independently (`anthropic.ts`/
 * `openai-compatible.ts` both used `{ temperature: 0.3, max_tokens: 4096 }`
 * for judge calls and `{ temperature: 0.4, max_tokens: 4096 }` for respond
 * calls — a deliberately HIGHER temperature for free-form generation than
 * for scoring). Now defined exactly ONCE per mode, here, and only ever used
 * as the LAST-RESORT fallback beneath a `JudgeModelVersion`'s own
 * `samplingDefaults` (which, being a single JSON field shared by both
 * modes — see `prisma/schema.prisma` — applies identically to judge and
 * respond calls once set; this mode split only matters when a version has
 * no `samplingDefaults` of its own at all).
 */
const JUDGE_DEFAULT_SAMPLING_PARAMS: SamplingParams = { temperature: 0.3, max_tokens: 4096 };
const RESPOND_DEFAULT_SAMPLING_PARAMS: SamplingParams = { temperature: 0.4, max_tokens: 4096 };

function isPartialSamplingParams(value: unknown): value is Partial<SamplingParams> {
  return typeof value === 'object' && value !== null;
}

/**
 * Effective sampling params = per-call override ?? the `JudgeModelVersion`'s
 * own `samplingDefaults` ?? `registryDefault` (mode-specific — see
 * `JUDGE_DEFAULT_SAMPLING_PARAMS`/`RESPOND_DEFAULT_SAMPLING_PARAMS` above) —
 * per-field, so a version that only pins `temperature` still inherits the
 * registry's `max_tokens`. This is the value recorded as
 * `samplingParamsUsed` on every `JudgmentResult`/`RespondResult` (persisted
 * as `ModelJudgment.samplingParams` — the ACTUAL params a call used, not a
 * re-derivation at persist time).
 */
export function effectiveSamplingParams(
  versionDefaults: unknown,
  overrides?: Partial<SamplingParams>,
  registryDefault: SamplingParams = JUDGE_DEFAULT_SAMPLING_PARAMS
): SamplingParams {
  const versionShape = isPartialSamplingParams(versionDefaults) ? versionDefaults : undefined;
  return {
    temperature: overrides?.temperature ?? versionShape?.temperature ?? registryDefault.temperature,
    max_tokens: overrides?.max_tokens ?? versionShape?.max_tokens ?? registryDefault.max_tokens,
  };
}

// ─── execute(): the low-level, single-attempt call primitive ───────────────

export interface ExecuteRequest {
  apiKey: string;
  baseUrl?: string;
  modelId: string;
  systemPrompt: string;
  userPrompt: string;
  samplingParams: SamplingParams;
}

const DEFAULT_TIMEOUT_MS = 120_000;

/** `Number(process.env.EVALUATION_MODEL_TIMEOUT_MS ?? '120000')`, matching
 * `claim.ts`/`run-launch.ts`/`run-create-consumer.ts`'s existing convention
 * — deliberately read as a FUNCTION (not a module-load-time constant like
 * those three) so tests can override `process.env.EVALUATION_MODEL_TIMEOUT_MS`
 * per-test without module-reset gymnastics; the extra `process.env` read
 * per call is negligible.
 *
 * Guarded against a malformed value: `Number('')`/`Number('nope')` is `NaN`,
 * and `setTimeout(fn, NaN)` is clamped by Node to fire on effectively the
 * NEXT TICK (verified directly) — before this guard, a typo'd/malformed env
 * var wouldn't just misconfigure the timeout, it would abort EVERY provider
 * call cluster-wide almost instantly. A non-finite or non-positive value
 * falls back to the same 120s default the schema (`src/lib/env.ts`) ships. */
function getTimeoutMs(): number {
  const raw = Number(process.env.EVALUATION_MODEL_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

/**
 * Dispatch a single provider call for `descriptor`, with a real
 * `AbortController` wired to the `EVALUATION_MODEL_TIMEOUT_MS` budget
 * (Task 8 review's MANDATORY carry: before this task, that env var was
 * read into `LEASE_MS`/deadline math but never actually bounded a live
 * HTTP/SDK call — a hung provider request could occupy a worker slot
 * indefinitely). NOT retried and NOT breaker-wrapped — see `index.ts`'s
 * `executeJudgment`/`executeRespond` for that layer.
 *
 * On timeout: throws a `ProviderError` with `kind: 'retryable'` and
 * `timeout: true` (distinguishable from an ordinary connection abort) —
 * verified by `tests/lib/llm-timeout.test.ts`'s hung-fetch test.
 */
export async function execute(descriptor: ProviderDescriptor, request: ExecuteRequest): Promise<ProviderCallResult> {
  const timeoutMs = getTimeoutMs();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const call = descriptor.id === 'anthropic' ? callAnthropic : callOpenAICompatible;

  try {
    return await call({
      apiKey: request.apiKey,
      baseUrl: request.baseUrl ?? descriptor.defaultBaseUrl,
      modelId: request.modelId,
      systemPrompt: request.systemPrompt,
      userPrompt: request.userPrompt,
      samplingParams: request.samplingParams,
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new ProviderError(
        `Provider call to "${descriptor.id}" (${request.modelId}) timed out after ${timeoutMs}ms`,
        { kind: 'retryable', provider: descriptor.id, timeout: true, cause: error }
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// ─── runProviderJudgment / runProviderResponse ──────────────────────────────

/** Minimal shape `runProviderJudgment`/`runProviderResponse` need from a
 * `JudgeModelVersion` (+ its `JudgeModel`) — a Prisma
 * `JudgeModelVersion & { judgeModel: JudgeModel }` row satisfies this
 * structurally (extra fields are fine), so `judgment-consumer.ts` passes
 * its own richer type straight through with no adapter object. */
export interface JudgeVersionForExecution {
  servingBackend: ServingBackend;
  samplingDefaults: unknown;
  judgeModel: { baseModel: string | null; slug: string };
}

export interface RunProviderJudgmentInput {
  judgeVersion: JudgeVersionForExecution;
  endpoint: EndpointCredentials;
  template: RenderTemplate;
  rubric: RenderRubric;
  submission: RenderSubmission;
  samplingOverrides?: Partial<SamplingParams>;
}

/** Per the task brief, verbatim field set (plus the pre-existing
 * `tokenCount`-shaped display need handled at the persistence layer in
 * `judgment-consumer.ts`, not here). */
export interface JudgmentResult {
  overallScore: number;
  criteriaScores: CriteriaScore[];
  reasoning: string;
  rawResponse: string;
  servedModelId?: string;
  finishReason?: string;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs: number;
  parseMode: 'structured' | 'fallback';
  samplingParamsUsed: SamplingParams;
}

function requireBaseModel(judgeVersion: JudgeVersionForExecution, descriptorId: ServingBackend): string {
  const modelId = judgeVersion.judgeModel.baseModel;
  if (!modelId) {
    throw new ProviderError(
      `JudgeModel "${judgeVersion.judgeModel.slug}" has no baseModel configured — cannot resolve a provider model id`,
      { kind: 'non_retryable', provider: descriptorId }
    );
  }
  return modelId;
}

/**
 * Placeholder credential for a call against an `openai_compatible` backend
 * with no configured key — exported so `verify.ts`'s connection-test path
 * (`resolveVerifyApiKey`) shares the exact same sentinel as a real judge/
 * respond call, rather than two independently-drifting placeholder strings.
 * Never a real secret — it exists purely so the `openai`/Anthropic SDK
 * clients (which require SOME string) can still be constructed for a
 * server that turns out to need no auth at all.
 */
export const NO_AUTH_PLACEHOLDER_KEY = 'not-needed';

/**
 * `resolveApiKey` plus one more fallback layer specific to a REAL call (not
 * needed by the pure key-resolution matrix `resolveApiKey` itself covers):
 * an `openai_compatible` backend with a reachable host (a custom
 * `ModelEndpoint.endpoint` override, OR the descriptor's own
 * `defaultBaseUrl` — e.g. Ollama's `http://localhost:11434/v1`, which
 * exists precisely so callers don't have to configure a URL) and no
 * configured key falls back to `NO_AUTH_PLACEHOLDER_KEY` rather than
 * refusing outright. Many self-hosted OpenAI-compatible servers (Ollama,
 * llama.cpp, LM Studio) need no auth at all — mirrors the pre-Task-10
 * behavior (`config.endpoint ? 'not-needed' : undefined`) for exactly the
 * same case: a placeholder can never leak a real secret (unlike the bug
 * this task closes, which really did send a live env-var key to an
 * arbitrary endpoint), and a server that DOES require real auth simply
 * rejects it with a normal 401 -> `non_retryable` provider error.
 *
 * `kind: 'api'` descriptors (anthropic, openai) NEVER get this fallback,
 * even behind a custom endpoint override — restores the pre-Task-10
 * invariant that a bare Anthropic call unconditionally requires a real key
 * (the old `AnthropicProvider` never had a placeholder path at all). An
 * `anthropic`-backed `JudgeModelVersion` whose `ModelEndpoint` happens to
 * carry a stray `endpoint` value (e.g. imported/legacy data — see
 * `scripts/importer/judges.ts`, which carries `ModelConfig.endpoint`
 * through regardless of provider) with no key configured should fail
 * loudly with a clear configuration error, not silently attempt a live,
 * unauthenticated HTTP call.
 */
function requireApiKey(descriptor: ProviderDescriptor, endpoint: EndpointCredentials): string {
  const apiKey = resolveApiKey(descriptor, endpoint);
  if (apiKey) return apiKey;

  const hasReachableHost = Boolean(endpoint.endpoint || descriptor.defaultBaseUrl);
  if (descriptor.kind === 'openai_compatible' && hasReachableHost) {
    return NO_AUTH_PLACEHOLDER_KEY;
  }

  throw new ProviderError(
    `No API key available for backend "${descriptor.id}" — configure ModelEndpoint.apiKeyEnc` +
      (descriptor.kind === 'api' ? ' or the provider-class env var (only honored when no custom endpoint is set)' : ''),
    { kind: 'non_retryable', provider: descriptor.id }
  );
}

/**
 * Wraps `renderJudgmentPrompt` (render.ts), converting a malformed
 * `PromptTemplate`/missing-submission-text failure into a `ProviderError`
 * with `kind: 'non_retryable'`. Without this, a broken template throws a
 * plain `Error`, which `classify()` (errors.ts) has no structural signal
 * to key off (no `.status`, not an abort) and defaults to `'retryable'` —
 * a PERMANENT, deterministic failure (every future call against the same
 * template fails identically) would otherwise burn the retry budget,
 * eventually DLQ, and count against the circuit breaker for no reason
 * related to actual provider health.
 */
function renderJudgmentPromptOrThrow(
  descriptorId: ServingBackend,
  template: RenderTemplate,
  rubric: RenderRubric,
  submission: RenderSubmission
): { systemPrompt: string; userPrompt: string } {
  try {
    return renderJudgmentPrompt(template, rubric, submission);
  } catch (error) {
    throw new ProviderError(
      `Failed to render judgment prompt: ${error instanceof Error ? error.message : error}`,
      { kind: 'non_retryable', provider: descriptorId, cause: error }
    );
  }
}

/**
 * Everything a judge call needs, fully resolved — the output of
 * `prepareJudgmentCall`, consumed by `executeJudgmentCall`.
 */
export interface PreparedJudgmentCall {
  descriptor: ProviderDescriptor;
  modelId: string;
  apiKey: string;
  baseUrl?: string;
  systemPrompt: string;
  userPrompt: string;
  samplingParamsUsed: SamplingParams;
  criteria: RenderRubric['criteria'];
}

/**
 * Validate + prepare a judge call: descriptor lookup, the
 * `scoredRunsAllowed` refusal, `baseModel`/API-key resolution, and
 * DB-templated prompt rendering. Deliberately synchronous (no network I/O)
 * and — critically — called OUTSIDE `index.ts`'s breaker/retry wrapper
 * (`callThroughResilience`): every failure here is a permanent
 * CONFIGURATION problem (an unset `baseModel`, a missing key, an
 * Ollama-backed judge, a malformed template), not a provider-health
 * signal. The SAME misconfigured `JudgeModelVersion` fails identically on
 * every future call regardless of whether the underlying endpoint is
 * healthy, so none of it should count against that endpoint's circuit
 * breaker — which is shared, via `breakerKey`, with every OTHER
 * (correctly-configured) call against the same servingBackend+endpoint+
 * model. Before this split, ALL of this ran inside the breaker-wrapped
 * closure, so a single misconfigured judge could trip the breaker for
 * everything else sharing its key (including respond-mode calls, which
 * share the identical breaker key formula).
 *
 * Refuses immediately (`non_retryable`) when the resolved descriptor's
 * `scoredRunsAllowed` is `false` (Ollama, per the brief) — checked BEFORE
 * any rendering/key-resolution work.
 */
export function prepareJudgmentCall(input: RunProviderJudgmentInput): PreparedJudgmentCall {
  const descriptor = getDescriptor(input.judgeVersion.servingBackend);

  if (!descriptor.scoredRunsAllowed) {
    throw new ProviderError(
      `Backend "${descriptor.id}" does not allow scored judge runs (ProviderDescriptor.scoredRunsAllowed is false)`,
      { kind: 'non_retryable', provider: descriptor.id }
    );
  }

  const modelId = requireBaseModel(input.judgeVersion, descriptor.id);
  const apiKey = requireApiKey(descriptor, input.endpoint);
  const { systemPrompt, userPrompt } = renderJudgmentPromptOrThrow(
    descriptor.id,
    input.template,
    input.rubric,
    input.submission
  );
  const samplingParamsUsed = effectiveSamplingParams(input.judgeVersion.samplingDefaults, input.samplingOverrides);

  return {
    descriptor,
    modelId,
    apiKey,
    baseUrl: input.endpoint.endpoint ?? undefined,
    systemPrompt,
    userPrompt,
    samplingParamsUsed,
    criteria: input.rubric.criteria,
  };
}

/**
 * The actual network call + response parsing for an already-`prepare`d
 * judge call — the ONLY part of a judge call that reflects real provider
 * health (a hung/erroring/malformed-JSON-returning provider), and
 * therefore the ONLY part `index.ts`'s `executeJudgment` wraps with
 * breaker/retry.
 */
export async function executeJudgmentCall(prepared: PreparedJudgmentCall): Promise<JudgmentResult> {
  const raw = await execute(prepared.descriptor, {
    apiKey: prepared.apiKey,
    baseUrl: prepared.baseUrl,
    modelId: prepared.modelId,
    systemPrompt: prepared.systemPrompt,
    userPrompt: prepared.userPrompt,
    samplingParams: prepared.samplingParamsUsed,
  });

  const parsed = parseJudgmentResponse(raw.text, prepared.criteria);

  return {
    overallScore: parsed.overallScore,
    criteriaScores: parsed.criteriaScores,
    reasoning: parsed.reasoning,
    rawResponse: raw.text,
    servedModelId: raw.servedModelId,
    finishReason: raw.finishReason,
    inputTokens: raw.inputTokens,
    outputTokens: raw.outputTokens,
    latencyMs: raw.latencyMs,
    parseMode: parsed.parseMode,
    samplingParamsUsed: prepared.samplingParamsUsed,
  };
}

/**
 * `runProviderJudgment` — the brief-specified `{ judgeVersion, endpoint,
 * template, rubric, submission, samplingOverrides? } -> JudgmentResult`
 * entry point, for callers that want prepare+execute in one call with NO
 * resilience wrapping (e.g. tests, or a future direct caller). `index.ts`'s
 * `executeJudgment` does NOT call this — it calls `prepareJudgmentCall` and
 * `executeJudgmentCall` separately so only the network-calling half is
 * breaker/retry-wrapped (see `prepareJudgmentCall`'s doc for why).
 */
export async function runProviderJudgment(input: RunProviderJudgmentInput): Promise<JudgmentResult> {
  return executeJudgmentCall(prepareJudgmentCall(input));
}

export interface RunProviderResponseInput {
  judgeVersion: JudgeVersionForExecution;
  endpoint: EndpointCredentials;
  submission: { promptText: string };
  samplingOverrides?: Partial<SamplingParams>;
}

export interface RespondResult {
  responseText: string;
  rawResponse: string;
  servedModelId?: string;
  finishReason?: string;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs: number;
  samplingParamsUsed: SamplingParams;
}

/** Respond-mode mirror of `PreparedJudgmentCall` — no template/rubric/
 * criteria, since respond mode never scores anything. */
export interface PreparedRespondCall {
  descriptor: ProviderDescriptor;
  modelId: string;
  apiKey: string;
  baseUrl?: string;
  systemPrompt: string;
  userPrompt: string;
  samplingParamsUsed: SamplingParams;
}

/**
 * Respond-mode mirror of `prepareJudgmentCall`: no DB template, no rubric,
 * and no `scoredRunsAllowed` refusal (plain text generation has no
 * "trusted judge" concept) — same "outside the breaker" rationale
 * otherwise.
 */
export function prepareRespondCall(input: RunProviderResponseInput): PreparedRespondCall {
  const descriptor = getDescriptor(input.judgeVersion.servingBackend);

  const modelId = requireBaseModel(input.judgeVersion, descriptor.id);
  const apiKey = requireApiKey(descriptor, input.endpoint);
  const systemPrompt = buildRespondSystemPrompt();
  const userPrompt = buildRespondUserPrompt({ promptText: input.submission.promptText });
  // RESPOND_DEFAULT_SAMPLING_PARAMS (0.4), not the judge default (0.3) —
  // preserves the pre-Task-10 behavior of a higher temperature for
  // free-form generation than for scoring (see effectiveSamplingParams's doc).
  const samplingParamsUsed = effectiveSamplingParams(
    input.judgeVersion.samplingDefaults,
    input.samplingOverrides,
    RESPOND_DEFAULT_SAMPLING_PARAMS
  );

  return {
    descriptor,
    modelId,
    apiKey,
    baseUrl: input.endpoint.endpoint ?? undefined,
    systemPrompt,
    userPrompt,
    samplingParamsUsed,
  };
}

/** Respond-mode mirror of `executeJudgmentCall` — the only part `index.ts`'s
 * `executeRespond` wraps with breaker/retry. */
export async function executeRespondCall(prepared: PreparedRespondCall): Promise<RespondResult> {
  const raw = await execute(prepared.descriptor, {
    apiKey: prepared.apiKey,
    baseUrl: prepared.baseUrl,
    modelId: prepared.modelId,
    systemPrompt: prepared.systemPrompt,
    userPrompt: prepared.userPrompt,
    samplingParams: prepared.samplingParamsUsed,
  });

  return {
    responseText: raw.text.trim(),
    rawResponse: raw.text,
    servedModelId: raw.servedModelId,
    finishReason: raw.finishReason,
    inputTokens: raw.inputTokens,
    outputTokens: raw.outputTokens,
    latencyMs: raw.latencyMs,
    samplingParamsUsed: prepared.samplingParamsUsed,
  };
}

/**
 * `runProviderResponse` — the respond-mode mirror of `runProviderJudgment`:
 * prepare+execute in one call, no resilience wrapping. See
 * `runProviderJudgment`'s doc for why `index.ts` doesn't call this
 * directly.
 */
export async function runProviderResponse(input: RunProviderResponseInput): Promise<RespondResult> {
  return executeRespondCall(prepareRespondCall(input));
}
