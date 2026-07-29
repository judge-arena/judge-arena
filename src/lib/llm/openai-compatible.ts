/**
 * OpenAI-compatible backend — a plain, provider-agnostic call function used
 * for every `openai_compatible`-kind descriptor (real OpenAI, legacy
 * `local` self-hosted endpoints, and — from Task 11 — OpenRouter/vLLM/
 * Ollama). `registry.ts`'s `execute()` is the only caller: it resolves the
 * API key, base URL, effective sampling params, and the timeout
 * `AbortSignal` before invoking this; this module owns nothing but the
 * `openai` SDK call shape itself — PLUS (Task 11) the descriptor-hook
 * consultation seam described below, which is what makes OpenRouter's
 * attribution headers and vLLM's guided-decoding request fields
 * "descriptor-level specialization, not forked call paths" per the task
 * brief: this ONE function drives every `openai_compatible` backend,
 * branching only on what `opts.descriptor` (a `DescriptorCallHints`,
 * `./provider.ts`) declares — never on a hardcoded backend id.
 *
 * ── Structured/guided-decoding seam ──────────────────────────────────────
 * When `opts.mode === 'judgment'` (never `'respond'` — free-form
 * generation has no schema to guide) AND the resolved descriptor declares
 * `caps.structuredOutput !== 'none'`, this attaches the judgment JSON
 * schema (`JUDGMENT_JSON_SCHEMA`, `./judgment-schema.ts`) to the outgoing
 * request and reports `structuredOutputRequested: true` on the result —
 * `registry.ts`'s `executeJudgmentCall` uses that flag to decide whether to
 * attempt the strict structured parse. A descriptor with its own
 * `structuredRequestFields()` hook (vLLM — `backends/vllm.ts`) gets exactly
 * what that hook builds; every other structured-output-capable descriptor
 * (openai's/openrouter's `caps.structuredOutput: 'json_schema'`) gets the
 * plain OpenAI-standard `response_format` shape below by default — this
 * seam applying to real OpenAI too (not just OpenRouter/vLLM) is a
 * deliberate, natural consequence of finally CONSUMING the
 * `caps.structuredOutput` flag Task 10 already declared on that descriptor,
 * not scope creep.
 */

import OpenAI from 'openai';
import type { ProviderCallOptions, ProviderCallResult } from './provider';
import { JUDGMENT_JSON_SCHEMA, JUDGMENT_JSON_SCHEMA_NAME } from './judgment-schema';

/** Default structured-output request shape for a descriptor with no
 * `structuredRequestFields` hook of its own: the plain, OpenAI-standard
 * `response_format: {type: 'json_schema', ...}` field. Not `strict: true`
 * — see `judgment-schema.ts`'s doc for why. */
function defaultStructuredRequestFields(schema: Record<string, unknown>): Record<string, unknown> {
  return {
    response_format: {
      type: 'json_schema',
      json_schema: { name: JUDGMENT_JSON_SCHEMA_NAME, schema },
    },
  };
}

export async function callOpenAICompatible(opts: ProviderCallOptions): Promise<ProviderCallResult> {
  const client = new OpenAI({
    apiKey: opts.apiKey,
    baseURL: opts.baseUrl || undefined,
  });

  const params: Record<string, unknown> = {
    model: opts.modelId,
    max_tokens: opts.samplingParams.max_tokens,
    temperature: opts.samplingParams.temperature,
    messages: [
      { role: 'system', content: opts.systemPrompt },
      { role: 'user', content: opts.userPrompt },
    ],
  };

  const structuredOutputRequested = Boolean(
    opts.mode === 'judgment' && opts.descriptor && opts.descriptor.caps.structuredOutput !== 'none'
  );

  if (structuredOutputRequested && opts.descriptor) {
    const extraFields = opts.descriptor.structuredRequestFields
      ? opts.descriptor.structuredRequestFields(JUDGMENT_JSON_SCHEMA)
      : defaultStructuredRequestFields(JUDGMENT_JSON_SCHEMA);
    Object.assign(params, extraFields);
  }

  // Descriptor-level attribution/auth headers (e.g. OpenRouter's
  // `HTTP-Referer`/`X-Title` — `backends/openrouter.ts`) — merged into this
  // call's own request headers via the SDK's per-call `RequestOptions`,
  // never baked into the client instance (so a shared `descriptor` never
  // leaks one call's headers into another's).
  const extraHeaders = opts.descriptor?.headers?.({ apiKey: opts.apiKey, endpoint: opts.baseUrl });

  const startTime = Date.now();

  const response = await client.chat.completions.create(
    // `params` carries extra, non-SDK-typed fields when structured output
    // is requested (vLLM's `guided_json` — see structuredRequestFields
    // above), so it's built as a plain Record and cast through `unknown`
    // here rather than typed as ChatCompletionCreateParamsNonStreaming
    // from the start; the SDK just JSON-serializes whatever object it's
    // given, unknown keys included.
    params as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
    // Wires EVALUATION_MODEL_TIMEOUT_MS into a real request abort — see
    // registry.ts's execute() module doc (Task 8 review carry). The `openai`
    // SDK forwards this signal into its underlying `fetch()` call.
    { signal: opts.signal, ...(extraHeaders ? { headers: extraHeaders } : {}) }
  );

  const latencyMs = Date.now() - startTime;

  const choice = response.choices[0];
  const text = choice?.message?.content || '';

  return {
    text,
    servedModelId: response.model,
    finishReason: choice?.finish_reason ?? undefined,
    inputTokens: response.usage?.prompt_tokens,
    outputTokens: response.usage?.completion_tokens,
    latencyMs,
    structuredOutputRequested,
  };
}
