/**
 * ─── vLLM (`ServingBackend.vllm`) descriptor specialization ─────────────────
 *
 * vLLM is fully OpenAI-compatible on the wire — it routes through the SAME
 * shared `callOpenAICompatible` as openai/openrouter/ollama (see
 * `registry.ts`'s `execute()`). Per the task brief's "descriptor-level
 * specialization, not forked call paths" instruction, this module
 * contributes ONLY the one piece of behavior that's actually vLLM-specific:
 * the `structuredRequestFields()` hook (`ProviderDescriptor
 * .structuredRequestFields`, consulted by `callOpenAICompatible` — see that
 * module's doc) that builds the extra request-body fields needed to invoke
 * vLLM's guided decoding for a judgment call.
 *
 * ── Two mechanisms, sent together ────────────────────────────────────────
 * vLLM's OpenAI-compatible server supports TWO parallel ways to constrain a
 * chat-completion response to a JSON Schema:
 * - The OpenAI-standard `response_format: {type: 'json_schema',
 *   json_schema: {...}}` field (what real OpenAI/OpenRouter also
 *   understand — `openai-compatible.ts`'s `defaultStructuredRequestFields`
 *   is exactly this, and is what every OTHER `caps.structuredOutput !==
 *   'none'` descriptor gets automatically without needing a hook of its
 *   own).
 * - vLLM's own, older/parallel `guided_json` extension: a non-OpenAI-
 *   standard top-level request field, originally the only way to ask
 *   vLLM's `outlines`/`lm-format-enforcer` guided-decoding backends for
 *   schema-constrained output before `response_format` support landed.
 *
 * This hook attaches BOTH, carrying the identical schema — not a runtime
 * feature-probe-then-retry (there is no lightweight way to detect which
 * mechanism a given self-hosted vLLM deployment's version understands
 * without burning an extra round trip against a live judge run), so
 * instead both fields are sent on every judgment call: `response_format`
 * is the preferred, properly-typed, spec-correct field for any
 * `response_format`-aware vLLM version; `guided_json` rides along
 * unconditionally as a compatibility net for older deployments that only
 * understand the extension field. Whichever one a given vLLM version
 * recognizes is honored; the other is simply an extra JSON key vLLM's
 * server does not act on.
 *
 * The REAL "fallback" this task's brief means is downstream, on the PARSE
 * side, not the request side: if a deployment honors neither field and
 * returns non-conforming free text anyway, that's caught by
 * `registry.ts`'s `executeJudgmentCall` (via `provider.ts`'s
 * `tryParseStructuredJudgment` returning `undefined`) and demoted to the
 * ordinary lenient parse + `parseMode: 'fallback'` + a logged warning — see
 * that module's doc.
 *
 * ── Deployment notes (not implemented here) ──────────────────────────────
 * - `defaultBaseUrl` for `vllm` is read from `VLLM_BASE_URL` dynamically by
 *   `registry.ts`'s `getDescriptor()` (self-hosted vLLM has no well-known
 *   default host the way OpenRouter/OpenAI/local Ollama do).
 * - `VLLM_API_KEY` (`.env.example`) is bearer-auth guidance for what to
 *   configure on the `ModelEndpoint` — like `OPENROUTER_API_KEY`, it is
 *   NEVER read as a live env-var credential fallback (`kind:
 *   'openai_compatible'` descriptors never get one — see
 *   `registry.ts`'s `resolveApiKey` doc).
 * - Custom CA trust for a self-hosted vLLM deployment behind an internal/
 *   private CA is a deployment-time concern (the cluster network seam),
 *   deferred to Phase 2 per the brief — not implemented in this task.
 */

import { JUDGMENT_JSON_SCHEMA_NAME } from '../judgment-schema';

/** `ProviderDescriptor.structuredRequestFields` hook for the `vllm`
 * descriptor (`registry.ts`) — see module doc for why both fields carry
 * the identical schema. */
export function vllmStructuredRequestFields(schema: Record<string, unknown>): Record<string, unknown> {
  return {
    response_format: {
      type: 'json_schema',
      json_schema: { name: JUDGMENT_JSON_SCHEMA_NAME, schema },
    },
    guided_json: schema,
  };
}
