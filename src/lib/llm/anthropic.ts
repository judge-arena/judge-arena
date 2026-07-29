/**
 * Anthropic backend (Claude models) — a plain, provider-agnostic call
 * function. `registry.ts`'s `execute()` is the only caller: it resolves the
 * API key, the effective sampling params, and the timeout `AbortSignal`
 * before invoking this; this module owns nothing but the Anthropic SDK
 * call shape itself.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { ProviderCallOptions, ProviderCallResult } from './provider';

export async function callAnthropic(opts: ProviderCallOptions): Promise<ProviderCallResult> {
  const client = new Anthropic({ apiKey: opts.apiKey, baseURL: opts.baseUrl || undefined });

  const startTime = Date.now();

  const response = await client.messages.create(
    {
      model: opts.modelId,
      max_tokens: opts.samplingParams.max_tokens,
      temperature: opts.samplingParams.temperature,
      system: opts.systemPrompt,
      messages: [{ role: 'user', content: opts.userPrompt }],
    },
    // Wires EVALUATION_MODEL_TIMEOUT_MS into a real request abort — see
    // registry.ts's execute() module doc (Task 8 review carry).
    { signal: opts.signal }
  );

  const latencyMs = Date.now() - startTime;

  const firstBlock = response.content[0];
  const text = firstBlock && firstBlock.type === 'text' ? firstBlock.text : '';

  return {
    text,
    servedModelId: response.model,
    finishReason: response.stop_reason ?? undefined,
    inputTokens: response.usage?.input_tokens,
    outputTokens: response.usage?.output_tokens,
    latencyMs,
  };
}
