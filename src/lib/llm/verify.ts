/**
 * ─── Model connection verification ──────────────────────────────────────────
 *
 * Folds into the registry-driven dispatch (Task 10): instead of hand-
 * rolling its own `Anthropic`/`OpenAI` SDK client construction (the old
 * shape — a third, ad-hoc reimplementation of provider-calling logic
 * alongside `anthropic.ts`/`openai-compatible.ts`), this goes through
 * `registry.ts`'s `getDescriptor`/`resolveApiKey`/`execute` — the exact
 * same dispatch a real judgment/respond call uses (same timeout wiring,
 * same backend module).
 *
 * Returns an `archFingerprint` (served model id, context length if the
 * backend's response exposes it — neither the Anthropic Messages API nor
 * an OpenAI-compatible chat completion does today) for the caller to
 * persist.
 *
 * Task 12: `VerifyModelInput` now takes a `ServingBackend` directly instead
 * of the legacy `ModelConfig.provider` string ('anthropic'|'openai'|
 * 'local') — the caller is `POST /api/models/[id]/verify`
 * (`src/app/api/models/[id]/verify/route.ts`), which is now `ModelEndpoint`
 * -keyed (its `JudgeModelVersion.servingBackend` IS a `ServingBackend`
 * already; no legacy mapping needed). That route persists the returned
 * `archFingerprint` onto `ModelEndpoint.archFingerprint`, closing the Task
 * 10 carry documented here previously ("no ModelEndpoint/archFingerprint
 * column to write it to yet").
 */

import type { ServingBackend } from '@prisma/client';
import {
  getDescriptor,
  resolveApiKey,
  execute,
  NO_AUTH_PLACEHOLDER_KEY,
  type ProviderDescriptor,
} from './registry';

export interface VerifyModelInput {
  servingBackend: ServingBackend;
  /** The literal provider-side model id to call with (`JudgeModel.baseModel`). */
  modelId: string;
  endpoint?: string;
  apiKey?: string;
}

export interface ArchFingerprint {
  servedModelId: string;
  contextLength?: number;
}

export interface VerifyModelResult {
  archFingerprint: ArchFingerprint;
}

/**
 * Resolve the key to actually send. Mirrors the pre-Task-10 behavior for
 * the no-key case as closely as the fixed leak allows.
 *
 * `input.apiKey` — when present — is used DIRECTLY, not routed through
 * `resolveApiKey`'s `apiKeyEnc` slot: the caller (`POST /api/models/[id]/
 * verify`) already calls `decryptSafe(endpoint.apiKeyEnc)` before invoking
 * `verifyModelConnection` (closing the ciphertext-as-key bug at the call
 * site), so `input.apiKey` here is already plaintext.
 * Routing an already-plaintext value back through `resolveApiKey`'s
 * `decryptSafe` call is a harmless no-op (`decryptSafe` skips anything not
 * tagged as ciphertext) but wastes a redundant check and muddies
 * `resolveApiKey`'s "the ONE place a ModelEndpoint's credential is
 * resolved" contract with a second call site doing its own decrypt first.
 *
 * `resolveApiKey` IS still consulted, but only for the env-var fallback
 * case (no `input.apiKey` at all) — reusing the SAME kind:'api'/no-custom-
 * endpoint gating policy `resolveApiKey` enforces for a real call, rather
 * than re-deriving it here.
 *
 * - Anthropic: no fallback beyond the shared env-var policy — throws
 *   (preserves the pre-Task-10 behavior: a bare Anthropic config with no
 *   key anywhere always fails loudly, never a placeholder).
 * - OpenAI/local: if nothing resolves (no `input.apiKey`, and either a
 *   custom endpoint is set or `OPENAI_API_KEY` is unset), fall back to
 *   `NO_AUTH_PLACEHOLDER_KEY` — the SAME sentinel `registry.ts`'s
 *   `requireApiKey` uses for a real call — rather than refusing outright.
 *   Many self-hosted OpenAI-compatible servers (Ollama, llama.cpp, LM
 *   Studio) need no auth at all, and this placeholder can never leak a
 *   real secret (unlike the old bug, which really did send the live
 *   `OPENAI_API_KEY` to whatever `endpoint` URL was configured). Verify
 *   deliberately stays MORE lenient here than `requireApiKey` (which only
 *   allows this fallback when a reachable host is known) — a manual
 *   "test connection" action should always attempt the call and show the
 *   real provider error, not short-circuit on a local guess.
 */
function resolveVerifyApiKey(descriptor: ProviderDescriptor, input: VerifyModelInput): string {
  if (input.apiKey) return input.apiKey;

  const envFallback = resolveApiKey(descriptor, { apiKeyEnc: null, endpoint: input.endpoint ?? null });
  if (envFallback) return envFallback;

  if (descriptor.id === 'anthropic') {
    throw new Error('Missing Anthropic API key');
  }

  return NO_AUTH_PLACEHOLDER_KEY;
}

export async function verifyModelConnection(input: VerifyModelInput): Promise<VerifyModelResult> {
  const descriptor = getDescriptor(input.servingBackend);
  const apiKey = resolveVerifyApiKey(descriptor, input);

  const raw = await execute(descriptor, {
    apiKey,
    baseUrl: input.endpoint,
    modelId: input.modelId,
    systemPrompt: 'Connection test. Reply with ok.',
    userPrompt: 'ok',
    samplingParams: { temperature: 0, max_tokens: 1 },
  });

  return {
    archFingerprint: {
      servedModelId: raw.servedModelId ?? input.modelId,
      contextLength: undefined,
    },
  };
}
