/**
 * LLM Provider Registry
 *
 * Central registry for all LLM providers. Resolves the correct provider
 * based on a model configuration's provider field.
 */

import type { ModelProvider } from '@/types';
import type {
  JudgmentProvider,
  JudgmentRequest,
  JudgmentResponse,
  RespondRequest,
  RespondResponse,
  ProviderConfig,
} from './provider';
import { AnthropicProvider } from './anthropic';
import { OpenAICompatibleProvider } from './openai-compatible';
import { withRetry } from './resilience';
import { classify, ProviderError } from './errors';
import { getBreaker } from './breaker-redis';

const providers: Record<string, JudgmentProvider> = {
  anthropic: new AnthropicProvider(),
  openai: new OpenAICompatibleProvider('OpenAI'),
  local: new OpenAICompatibleProvider('Local Model'),
};

/**
 * Get the provider for a given provider name (case-insensitive)
 */
export function getProvider(providerName: ModelProvider | string): JudgmentProvider {
  const provider = providers[providerName.toLowerCase()];
  if (!provider) {
    throw new Error(`Unknown provider: ${providerName}. Available: ${Object.keys(providers).join(', ')}`);
  }
  return provider;
}

/**
 * Build the circuit breaker key. Aggregator granularity: distinct per
 * provider *and* endpoint *and* model — without the endpoint segment, a
 * failing local Ollama instance would open the circuit for all
 * OpenAI-compatible endpoints including the real OpenAI API; without the
 * model segment, one bad model on a shared endpoint would trip every other
 * model routed through it.
 */
function breakerKey(providerName: string, config: ProviderConfig): string {
  return `${providerName}:${config.endpoint ?? 'default'}:${config.modelId}`;
}

/**
 * Gate + run a provider call through the Redis-backed circuit breaker and
 * taxonomy-driven retry.
 *
 * - `allow() === 'open'` fails fast with a `ProviderError` (`kind:
 *   'retryable'`, `breakerOpen: true`) without attempting the call at all
 *   or touching the retry loop — the queue (Task 5+) uses `breakerOpen` to
 *   apply a longer nack-delay than an ordinary retryable failure.
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
 *   breaker failure (or success), same reasoning the old in-process
 *   breaker used ("if all retries fail, it counts as a single circuit
 *   breaker failure").
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
 * Execute a judgment using the appropriate provider.
 * Wraps the call with retry + circuit breaker for resilience.
 */
export async function executeJudgment(
  providerName: string,
  request: JudgmentRequest,
  config: ProviderConfig
): Promise<JudgmentResponse> {
  const provider = getProvider(providerName);
  return callThroughResilience(providerName, breakerKey(providerName, config), () =>
    provider.judge(request, config)
  );
}

/**
 * Execute a respond call using the appropriate provider.
 * Wraps the call with retry + circuit breaker for resilience.
 */
export async function executeRespond(
  providerName: string,
  request: RespondRequest,
  config: ProviderConfig
): Promise<RespondResponse> {
  const provider = getProvider(providerName);
  return callThroughResilience(providerName, breakerKey(providerName, config), () =>
    provider.respond(request, config)
  );
}

/**
 * List available providers
 */
export function listProviders(): Array<{ id: string; name: string }> {
  return Object.entries(providers).map(([id, p]) => ({
    id,
    name: p.name,
  }));
}

export type {
  JudgmentProvider,
  JudgmentRequest,
  JudgmentResponse,
  RespondRequest,
  RespondResponse,
  ProviderConfig,
};
