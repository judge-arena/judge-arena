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

  // THE BUG THIS FIXES: this used to read `response.content[0]` and treat
  // anything that wasn't a `text` block as "no answer". A Messages response
  // with extended thinking enabled puts a `thinking` block FIRST, so
  // content[0] is the deliberation and the real answer sits at [1] — every
  // judgment would have come back with empty text alongside a perfectly
  // healthy `stop_reason: 'end_turn'`, i.e. a silent, undiagnosable failure
  // with nothing in the row explaining it. Latent today only because no
  // `thinking` param is sent yet; `caps.reasoningToggle` is already true for
  // this descriptor, so the first caller to flip it would have hit this.
  const textBlock = response.content.find((block) => block.type === 'text');
  const text = textBlock ? textBlock.text : '';

  // `redacted_thinking` blocks are deliberately NOT captured: their `data`
  // is an encrypted blob, not the model's reasoning, and storing it as
  // `reasoningContent` would put ciphertext in a field a human reads.
  const thinkingBlock = response.content.find((block) => block.type === 'thinking');

  return {
    text,
    servedModelId: response.model,
    finishReason: response.stop_reason ?? undefined,
    inputTokens: response.usage?.input_tokens,
    outputTokens: response.usage?.output_tokens,
    reasoningText: thinkingBlock?.thinking,
    reasoningSource: thinkingBlock ? 'anthropic_thinking' : undefined,
    latencyMs,
  };
}
