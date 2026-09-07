/**
 * OpenAI-compatible backend — a plain, provider-agnostic call function used
 * for every `openai_compatible`-kind descriptor (real OpenAI, legacy
 * `local` self-hosted endpoints, and — from Task 11 — OpenRouter/vLLM/
 * Ollama). `registry.ts`'s `execute()` is the only caller: it resolves the
 * API key, base URL, effective sampling params, and the timeout
 * `AbortSignal` before invoking this; this module owns nothing but the
 * `openai` SDK call shape itself — PLUS base-URL normalization
 * (`normalizeOpenAIBaseUrl` below, which every `openai_compatible` call
 * funnels through here — see its doc for why this is the right home for it)
 * and (Task 11) the descriptor-hook
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
 * with no hook of its own gets the plain OpenAI-standard `response_format`
 * shape below by default.
 *
 * 1b Task 11 review IMPORTANT fix: this seam now only fires for vLLM
 * (guided decoding — server-enforced, model-agnostic, inherently safe).
 * Both plain `openai` and `openrouter` descriptors now declare
 * `caps.structuredOutput: 'none'` to degrade gracefully:
 *   - Real OpenAI's Structured Outputs is MODEL-GATED — sending
 *     `response_format: {type:'json_schema',...}` to gpt-3.5-turbo/gpt-4/
 *     gpt-4-turbo hard-400s instead of degrading. Per-model gating (checking
 *     baseModel against Structured-Outputs-capable snapshots) deferred to
 *     future task.
 *   - OpenRouter gates `response_format` per-routed-MODEL — it passes the
 *     param to the underlying model, which hard-400s if that model doesn't
 *     support Structured Outputs. Per-model gating (allowed-models list per
 *     backend) also deferred to future task.
 */

import OpenAI from 'openai';
import type { ProviderCallOptions, ProviderCallResult, ReasoningSource } from './provider';
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

/** Matches a URL that is nothing but `scheme://authority` — no path, no
 * query, no fragment. `[^/?#]` is what keeps `http://h?x=1` out (see the
 * query-string carve-out in `normalizeOpenAIBaseUrl`). */
const SCHEME_AND_AUTHORITY_ONLY = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]+$/i;

/**
 * Normalize a user-supplied OpenAI-compatible base URL into the shape the
 * SDK actually wants: the root that `/chat/completions` hangs off.
 *
 * THE FAILURE THIS PREVENTS. The `openai` SDK appends `/chat/completions` to
 * `baseURL` verbatim. A local-model server prints `http://192.168.1.164:8001`
 * on startup and its curl example says `http://192.168.1.164:8001/v1/chat/completions`,
 * so both are what people paste — and both produce a bare `404 Not Found`
 * from the far end that names neither the URL nor the missing/extra `/v1`.
 * It is the most common way a first local-model setup fails, and nothing in
 * the stack diagnoses it.
 *
 * THE RULE, stated exactly, because the conservative half matters more than
 * the helpful half:
 *   1. Unset/blank -> `undefined`, so the descriptor's `defaultBaseUrl`
 *      (or, for real OpenAI, the SDK's own host) still applies.
 *   2. A `?` or `#` anywhere -> returned untouched. Some gateways carry auth
 *      in a query param; a rewrite that drops or reorders it is worse than
 *      the 404.
 *   3. Trailing slashes stripped; ONE trailing `/chat/completions` stripped.
 *   4. `/v1` is APPENDED only when what remains is a bare `scheme://authority`
 *      with no path at all. It is NEVER INJECTED into an existing path.
 *   5. Anything else is returned as-is (including a string that isn't a URL —
 *      the SDK raises its own, clearer error for that).
 *
 * Rule 4 is the whole design. Real deployments are routinely mounted under a
 * path prefix — `https://openrouter.ai/api/v1` (this repo's own openrouter
 * `defaultBaseUrl`), a gateway at `/openai/v1`, a reverse proxy at `/llm/v1`
 * — and a proxy at `/llm` that serves `/llm/chat/completions` directly is
 * equally real. Guessing `/llm/v1` for that one would break a WORKING config
 * to fix a hypothetical one, so a non-empty path is treated as deliberate
 * and left exactly alone. `tests/lib/openai-base-url.test.ts` pins every
 * `defaultBaseUrl` this repo ships against that promise.
 *
 * WHY IT LIVES HERE, not in `registry.ts` or a shared util: this function is
 * the single chokepoint every `openai_compatible` call already funnels
 * through. `registry.ts`'s `execute()` resolves `request.baseUrl ??
 * descriptor.defaultBaseUrl` and hands the winner straight to this module,
 * so descriptor defaults, `ModelEndpoint.endpoint` overrides, and
 * `verify.ts`'s connection test are all covered by this one call site with
 * no coordination between them. It is deliberately NOT shared with
 * `anthropic.ts`: the Anthropic SDK appends `/v1/messages` to its own
 * baseURL, so `/v1` there means something different and appending it would
 * produce `/v1/v1/messages`.
 */
export function normalizeOpenAIBaseUrl(raw: string | undefined | null): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;

  if (/[?#]/.test(trimmed)) return trimmed;

  const withoutSuffix = trimmed.replace(/\/+$/, '').replace(/\/chat\/completions$/, '');

  return SCHEME_AND_AUTHORITY_ONLY.test(withoutSuffix) ? `${withoutSuffix}/v1` : withoutSuffix;
}

/**
 * An in-band `<think>...</think>` block. The closing tag is OPTIONAL (`|$`)
 * on purpose: a model cut off at `max_tokens` mid-thought emits an opening
 * tag and never closes it, and that half-thought is exactly the evidence
 * that explains the truncation — requiring `</think>` would discard the
 * reasoning precisely in the case someone is trying to diagnose.
 */
const THINK_TAG = /<think>([\s\S]*?)(?:<\/think>|$)/;

/** A wire value only counts as a reasoning channel if it is a non-blank
 * STRING. A blank/absent/mistyped key falls through to the next candidate
 * rather than winning: recording `reasoningSource: 'reasoning_content'`
 * alongside an empty `reasoningContent` would assert that the model
 * deliberated on that key when it did not, and would mask a real
 * `<think>` block sitting in `content`. */
function nonBlankString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * Pull the model's thinking out of a chat-completion message, in ONE place
 * with a FIXED, documented key order:
 *
 *   1. `reasoning_content` — vLLM/SGLang/Qwen/DeepSeek's sibling of
 *      `content`. Verified live against the target judge: the message keys
 *      on the wire were exactly `['role', 'content', 'reasoning_content']`.
 *   2. `reasoning` — the OpenRouter-normalized spelling.
 *   3. a `<think>...</think>` block inside `content` — models that have no
 *      separate channel at all and emit their thinking in band.
 *   4. none.
 *
 * WHY A CAST AND NOT `any`: neither key is declared on the SDK's
 * `ChatCompletionMessage` type, but the object is `JSON.parse`d straight off
 * the wire, so the keys are really there at runtime. A narrow
 * `Record<string, unknown>` view keeps every read type-checked (each value
 * is `unknown` until `nonBlankString` proves it a string); `any` would
 * silently accept `message.reasoning_content.trim()` on a number and throw
 * at runtime instead.
 *
 * WHY IT DOESN'T STRIP THE `<think>` BLOCK FROM `content`: `text` is
 * persisted verbatim as `ModelJudgment.rawResponse`, which the schema
 * documents as "full LLM response, never truncated". Extraction here is
 * additive and lossless — nothing is moved out of the answer channel.
 */
export function extractReasoningChannel(
  message: unknown
): { text: string; source: ReasoningSource } | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  const record = message as Record<string, unknown>;

  const reasoningContent = nonBlankString(record.reasoning_content);
  if (reasoningContent) return { text: reasoningContent, source: 'reasoning_content' };

  const reasoning = nonBlankString(record.reasoning);
  if (reasoning) return { text: reasoning, source: 'reasoning' };

  const content = nonBlankString(record.content);
  const tagged = content ? THINK_TAG.exec(content) : null;
  const thought = tagged ? nonBlankString(tagged[1].trim()) : undefined;
  if (thought) return { text: thought, source: 'think_tag' };

  return undefined;
}

export async function callOpenAICompatible(opts: ProviderCallOptions): Promise<ProviderCallResult> {
  // Resolved ONCE and reused for the descriptor's `headers()` hook below, so
  // a hook that ever keys off the endpoint sees the URL this call actually
  // goes to rather than the raw pasted string.
  const baseURL = normalizeOpenAIBaseUrl(opts.baseUrl);

  const client = new OpenAI({
    apiKey: opts.apiKey,
    baseURL,
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

  // Ollama maps `repeat_penalty` through its OpenAI-compatible shim;
  // `frequency_penalty` is the native OpenAI dialect. Both are omitted unless
  // set, so an unconfigured judge sends a byte-identical request to today's.
  if (opts.samplingParams.repeat_penalty !== undefined) {
    params.repeat_penalty = opts.samplingParams.repeat_penalty;
  }
  if (opts.samplingParams.frequency_penalty !== undefined) {
    params.frequency_penalty = opts.samplingParams.frequency_penalty;
  }

  const structuredOutputRequested = Boolean(
    opts.mode === 'judgment' && opts.descriptor && opts.descriptor.caps.structuredOutput !== 'none'
  );

  if (structuredOutputRequested && opts.descriptor) {
    // A0: the schema is now caller-selected (pointwise vs. pairwise), with
    // the pointwise one as the default so every pre-A0 call site keeps its
    // exact prior behavior. The schema NAME stays `JUDGMENT_JSON_SCHEMA_NAME`
    // in both cases — it is a response-format label, not a discriminator.
    const schema = opts.jsonSchema ?? JUDGMENT_JSON_SCHEMA;
    const extraFields = opts.descriptor.structuredRequestFields
      ? opts.descriptor.structuredRequestFields(schema)
      : defaultStructuredRequestFields(schema);
    Object.assign(params, extraFields);
  }

  // Descriptor-level attribution/auth headers (e.g. OpenRouter's
  // `HTTP-Referer`/`X-Title` — `backends/openrouter.ts`) — merged into this
  // call's own request headers via the SDK's per-call `RequestOptions`,
  // never baked into the client instance (so a shared `descriptor` never
  // leaks one call's headers into another's).
  const extraHeaders = opts.descriptor?.headers?.({ apiKey: opts.apiKey, endpoint: baseURL });

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
  const reasoning = extractReasoningChannel(choice?.message);

  return {
    text,
    servedModelId: response.model,
    finishReason: choice?.finish_reason ?? undefined,
    inputTokens: response.usage?.prompt_tokens,
    outputTokens: response.usage?.completion_tokens,
    // Already typed by the installed SDK (`CompletionUsage.CompletionTokensDetails`)
    // — no cast needed, unlike the message keys above.
    reasoningTokens: response.usage?.completion_tokens_details?.reasoning_tokens,
    reasoningText: reasoning?.text,
    reasoningSource: reasoning?.source,
    latencyMs,
    structuredOutputRequested,
  };
}
