import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Task 12: verifyModelConnection now takes a ServingBackend directly (no
// legacy ModelConfig.provider mapping) — same mock-the-backend-modules
// pattern as tests/lib/registry.test.ts, which this module's execute()
// dispatch delegates to.
const { callAnthropicMock, callOpenAICompatibleMock } = vi.hoisted(() => ({
  callAnthropicMock: vi.fn(),
  callOpenAICompatibleMock: vi.fn(),
}));

vi.mock('@/lib/llm/anthropic', () => ({ callAnthropic: callAnthropicMock }));
vi.mock('@/lib/llm/openai-compatible', () => ({ callOpenAICompatible: callOpenAICompatibleMock }));

const { verifyModelConnection } = await import('@/lib/llm/verify');

describe('verifyModelConnection (src/lib/llm/verify.ts, Task 12: ServingBackend-keyed)', () => {
  const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
  const originalOpenAiKey = process.env.OPENAI_API_KEY;

  beforeEach(() => {
    callAnthropicMock.mockReset();
    callOpenAICompatibleMock.mockReset();
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    if (originalAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
    if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAiKey;
  });

  it('dispatches to callAnthropic for servingBackend "anthropic" and returns an archFingerprint from the served model id', async () => {
    callAnthropicMock.mockResolvedValue({
      text: 'ok',
      servedModelId: 'claude-sonnet-4-5-20250514',
      latencyMs: 5,
    });

    const result = await verifyModelConnection({
      servingBackend: 'anthropic',
      modelId: 'claude-sonnet-4-5-20250514',
      apiKey: 'sk-test-key',
    });

    expect(callAnthropicMock).toHaveBeenCalledTimes(1);
    expect(callOpenAICompatibleMock).not.toHaveBeenCalled();
    const call = callAnthropicMock.mock.calls[0][0];
    expect(call.apiKey).toBe('sk-test-key');
    expect(call.modelId).toBe('claude-sonnet-4-5-20250514');
    expect(result.archFingerprint).toEqual({ servedModelId: 'claude-sonnet-4-5-20250514', contextLength: undefined });
  });

  it('dispatches to callOpenAICompatible for servingBackend "openai"/"vllm"/"openrouter"', async () => {
    callOpenAICompatibleMock.mockResolvedValue({ text: 'ok', servedModelId: 'gpt-4o', latencyMs: 5 });

    await verifyModelConnection({ servingBackend: 'openai', modelId: 'gpt-4o', apiKey: 'sk-test' });
    await verifyModelConnection({ servingBackend: 'vllm', modelId: 'llama-3', endpoint: 'http://localhost:8000/v1' });
    await verifyModelConnection({ servingBackend: 'openrouter', modelId: 'some/model', apiKey: 'or-test' });

    expect(callOpenAICompatibleMock).toHaveBeenCalledTimes(3);
    expect(callAnthropicMock).not.toHaveBeenCalled();
  });

  it('falls back to the ANTHROPIC_API_KEY env var when no input.apiKey is given (no custom endpoint)', async () => {
    process.env.ANTHROPIC_API_KEY = 'env-anthropic-key';
    callAnthropicMock.mockResolvedValue({ text: 'ok', servedModelId: 'claude-x', latencyMs: 1 });

    await verifyModelConnection({ servingBackend: 'anthropic', modelId: 'claude-x' });

    expect(callAnthropicMock.mock.calls[0][0].apiKey).toBe('env-anthropic-key');
  });

  it('throws a clear error for anthropic with no key anywhere (no placeholder fallback)', async () => {
    await expect(
      verifyModelConnection({ servingBackend: 'anthropic', modelId: 'claude-x' })
    ).rejects.toThrow(/Missing Anthropic API key/);
    expect(callAnthropicMock).not.toHaveBeenCalled();
  });

  it('an openai_compatible backend with a reachable host and no key falls back to the NO_AUTH_PLACEHOLDER_KEY sentinel rather than refusing', async () => {
    callOpenAICompatibleMock.mockResolvedValue({ text: 'ok', servedModelId: 'llama-3', latencyMs: 1 });

    await verifyModelConnection({ servingBackend: 'vllm', modelId: 'llama-3', endpoint: 'http://localhost:8000/v1' });

    expect(callOpenAICompatibleMock.mock.calls[0][0].apiKey).toBe('not-needed');
  });
});
