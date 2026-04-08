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
import { resilientCall } from './resilience';

const providers: Record<string, JudgmentProvider> = {
  anthropic: new AnthropicProvider(),
  openai: new OpenAICompatibleProvider('OpenAI'),
  local: new OpenAICompatibleProvider('Local Model'),
};

/**
 * Get the provider for a given provider name
 */
export function getProvider(providerName: ModelProvider | string): JudgmentProvider {
  const provider = providers[providerName];
  if (!provider) {
    throw new Error(`Unknown provider: ${providerName}. Available: ${Object.keys(providers).join(', ')}`);
  }
  return provider;
}

/**
 * Build a circuit breaker key that distinguishes different endpoints
 * within the same provider. Without this, a failing local Ollama instance
 * would open the circuit for all OpenAI-compatible endpoints including
 * the real OpenAI API.
 */
function circuitKey(providerName: string, config: ProviderConfig): string {
  return config.endpoint ? `${providerName}:${config.endpoint}` : providerName;
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
  return resilientCall(circuitKey(providerName, config), () => provider.judge(request, config));
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
  return resilientCall(circuitKey(providerName, config), () => provider.respond(request, config));
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
