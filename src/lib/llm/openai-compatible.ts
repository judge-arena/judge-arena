/**
 * OpenAI-compatible backend — a plain, provider-agnostic call function used
 * for every `openai_compatible`-kind descriptor (real OpenAI, legacy
 * `local` self-hosted endpoints, and — from Task 11 — OpenRouter/vLLM/
 * Ollama). `registry.ts`'s `execute()` is the only caller: it resolves the
 * API key, base URL, effective sampling params, and the timeout
 * `AbortSignal` before invoking this; this module owns nothing but the
 * `openai` SDK call shape itself.
 */

import OpenAI from 'openai';
import type { ProviderCallOptions, ProviderCallResult } from './provider';

export async function callOpenAICompatible(opts: ProviderCallOptions): Promise<ProviderCallResult> {
  const client = new OpenAI({
    apiKey: opts.apiKey,
    baseURL: opts.baseUrl || undefined,
  });

  const startTime = Date.now();

  const response = await client.chat.completions.create(
    {
      model: opts.modelId,
      max_tokens: opts.samplingParams.max_tokens,
      temperature: opts.samplingParams.temperature,
      messages: [
        { role: 'system', content: opts.systemPrompt },
        { role: 'user', content: opts.userPrompt },
      ],
    },
    // Wires EVALUATION_MODEL_TIMEOUT_MS into a real request abort — see
    // registry.ts's execute() module doc (Task 8 review carry). The `openai`
    // SDK forwards this signal into its underlying `fetch()` call.
    { signal: opts.signal }
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
  };
}
