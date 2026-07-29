/**
 * ─── OpenRouter (`ServingBackend.openrouter`) descriptor specialization ─────
 *
 * OpenRouter is fully OpenAI-compatible on the wire — it routes through the
 * SAME shared `callOpenAICompatible` as openai/vllm/ollama (see
 * `registry.ts`'s `execute()`: only `id === 'anthropic'` gets a dedicated
 * call function). Per the task brief's "descriptor-level specialization,
 * not forked call paths" instruction, this module contributes ONLY the one
 * piece of behavior that's actually OpenRouter-specific: the `headers()`
 * hook (`ProviderDescriptor.headers`, consulted by `callOpenAICompatible`)
 * that attaches OpenRouter's attribution headers.
 *
 * OpenRouter's docs (https://openrouter.ai/docs) ask every caller to send:
 * - `HTTP-Referer` — the calling application's URL, sourced from
 *   `OPENROUTER_SITE_URL` if set, else `NEXTAUTH_URL` (judge-arena's own
 *   deployment URL — a reasonable identifying default when no
 *   OpenRouter-specific override is configured). Omitted entirely if
 *   neither is set (an empty/undefined `HTTP-Referer` is worse than none).
 * - `X-Title` — a human-readable app name, always `'Judge Arena'`.
 * These headers are NOT required for the call to function — they exist for
 * OpenRouter's own model-usage leaderboards / abuse triage, and so anyone
 * debugging a run from OpenRouter's side of the fence can see it came from
 * Judge Arena. `OPENROUTER_SITE_URL`/`NEXTAUTH_URL` are read fresh on every
 * call (not baked in at module load), matching `registry.ts`'s established
 * "read env per-call" convention (see `getTimeoutMs`'s doc) so tests can
 * override them per-test.
 *
 * Everything else about OpenRouter is already covered by the plain
 * `ProviderDescriptor` shape from Task 10 — nothing else to add here:
 * - `auth: 'bearer'` + `resolveApiKey()`: an OpenRouter key is ALWAYS a
 *   per-`ModelEndpoint` key. `kind: 'openai_compatible'` never gets an env
 *   fallback (see `registry.ts`'s `resolveApiKey` doc and
 *   `tests/lib/registry.test.ts`'s explicit regression test for this) —
 *   `OPENROUTER_API_KEY` (documented in `.env.example`) is never read by
 *   this codebase as a credential fallback, only as operator-facing
 *   guidance for what to paste into a `ModelEndpoint`'s key field.
 * - `defaultBaseUrl: 'https://openrouter.ai/api/v1'` (registry.ts).
 * - Breaker key granularity: `llm/index.ts`'s `breakerKey()` is already
 *   `servingBackend:endpoint:modelId` (Task 4). Since OpenRouter serves many
 *   distinct upstream models through the SAME host/endpoint, the `modelId`
 *   segment alone already gives every OpenRouter-routed model its own
 *   independent circuit — e.g. `openrouter:default:openai/gpt-4o` and
 *   `openrouter:default:anthropic/claude-3.5-sonnet` never share a breaker.
 *   Nothing to add here; `tests/lib/backends.test.ts` just confirms it.
 */

/** `ProviderDescriptor.headers` hook for the `openrouter` descriptor
 * (`registry.ts`). Ignores its `cfg` argument entirely (a function
 * accepting fewer parameters than the hook's call signature is a normal,
 * safe TS assignment) — OpenRouter's attribution headers are sourced from
 * environment config, not from the per-call `apiKey`/`endpoint`. */
export function openRouterHeaders(): Record<string, string> {
  const referer = process.env.OPENROUTER_SITE_URL || process.env.NEXTAUTH_URL;
  const headers: Record<string, string> = { 'X-Title': 'Judge Arena' };
  if (referer) {
    headers['HTTP-Referer'] = referer;
  }
  return headers;
}
