import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServingBackend } from '@prisma/client';
import { encrypt } from '@/lib/crypto';

const { callAnthropicMock, callOpenAICompatibleMock } = vi.hoisted(() => ({
  callAnthropicMock: vi.fn(),
  callOpenAICompatibleMock: vi.fn(),
}));

vi.mock('@/lib/llm/anthropic', () => ({ callAnthropic: callAnthropicMock }));
vi.mock('@/lib/llm/openai-compatible', () => ({ callOpenAICompatible: callOpenAICompatibleMock }));

const {
  getDescriptor,
  assertScoredRunsAllowed,
  legacyProviderToBackend,
  resolveApiKey,
  effectiveSamplingParams,
  runProviderJudgment,
  runProviderResponse,
  prepareJudgmentCall,
  executeJudgmentCall,
  NO_AUTH_PLACEHOLDER_KEY,
} = await import('@/lib/llm/registry');

const ALL_BACKENDS: ServingBackend[] = ['anthropic', 'openai', 'openrouter', 'vllm', 'ollama'];

describe('registry: getDescriptor', () => {
  it('returns a descriptor for every ServingBackend', () => {
    for (const backend of ALL_BACKENDS) {
      const descriptor = getDescriptor(backend);
      expect(descriptor.id).toBe(backend);
    }
  });

  it('anthropic and openai are kind "api" (known official hosts)', () => {
    expect(getDescriptor('anthropic').kind).toBe('api');
    expect(getDescriptor('openai').kind).toBe('api');
  });

  it('openrouter, vllm, and ollama are kind "openai_compatible"', () => {
    expect(getDescriptor('openrouter').kind).toBe('openai_compatible');
    expect(getDescriptor('vllm').kind).toBe('openai_compatible');
    expect(getDescriptor('ollama').kind).toBe('openai_compatible');
  });

  it('EVERY backend now allows scored runs — ollama was corrected 2026-08-31', () => {
    // This asserted `ollama === false` until the claim behind it was measured
    // and found wrong: Ollama honours `response_format: {type: 'json_schema'}`
    // (verified live, 0.32.15 — see backends/ollama.ts). The refusal MECHANISM
    // is still tested, against a synthetic descriptor, further down.
    for (const backend of ALL_BACKENDS) {
      expect(getDescriptor(backend).scoredRunsAllowed).toBe(true);
    }
  });

  it('structuredOutput is NOT what gates scored runs — openai and openrouter prove it', () => {
    // Written after asserting the opposite and being wrong, which is the point
    // of recording it. `ollama` was excluded from scored runs on the stated
    // grounds that it "cannot constrain output, so its verdicts are
    // unparseable-by-construction" — while `openai` and `openrouter` declared
    // the SAME `structuredOutput: 'none'` and were allowed the entire time.
    // The rationale never differentiated anything; it was inconsistent from the
    // start, not merely outdated.
    //
    // What actually happens for a 'none' backend is the lenient parse path
    // (parseMode 'fallback'), which is a real, tested design — not a defect.
    // This test pins the inconsistency so nobody re-derives the false invariant
    // "allowed implies constrainable" from the descriptor table.
    expect(getDescriptor('openai').caps.structuredOutput).toBe('none');
    expect(getDescriptor('openai').scoredRunsAllowed).toBe(true);
    expect(getDescriptor('openrouter').caps.structuredOutput).toBe('none');
    expect(getDescriptor('openrouter').scoredRunsAllowed).toBe(true);
  });

  it('throws for an unrecognized backend', () => {
    expect(() => getDescriptor('not-a-backend' as ServingBackend)).toThrow(/unknown ServingBackend/);
  });
});

describe('registry: legacyProviderToBackend', () => {
  it('maps anthropic -> anthropic, openai -> openai', () => {
    expect(legacyProviderToBackend('anthropic')).toBe('anthropic');
    expect(legacyProviderToBackend('openai')).toBe('openai');
  });

  it('maps the legacy "local" provider onto the "openai" ServingBackend', () => {
    expect(legacyProviderToBackend('local')).toBe('openai');
  });

  it('throws for an unrecognized legacy provider string', () => {
    expect(() => legacyProviderToBackend('bogus')).toThrow(/unrecognized legacy provider/);
  });
});

describe('registry: resolveApiKey — key-resolution matrix (user endpoint never sees the env key)', () => {
  const anthropic = getDescriptor('anthropic');
  const openai = getDescriptor('openai');
  const openrouter = getDescriptor('openrouter');

  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'env-anthropic-key';
    process.env.OPENAI_API_KEY = 'env-openai-key';
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('an endpoint with its own key always wins, decrypted', () => {
    const ciphertext = encrypt('per-endpoint-secret');
    const key = resolveApiKey(anthropic, { apiKeyEnc: ciphertext, endpoint: null });
    expect(key).toBe('per-endpoint-secret');
  });

  it('a plaintext (not actually encrypted) apiKeyEnc value passes through unchanged (decryptSafe no-op)', () => {
    const key = resolveApiKey(openai, { apiKeyEnc: 'sk-plaintext-already', endpoint: null });
    expect(key).toBe('sk-plaintext-already');
  });

  it('kind "api" + no custom endpoint + no per-endpoint key -> falls back to the provider env var', () => {
    expect(resolveApiKey(anthropic, { apiKeyEnc: null, endpoint: null })).toBe('env-anthropic-key');
    expect(resolveApiKey(openai, { apiKeyEnc: null, endpoint: null })).toBe('env-openai-key');
  });

  it('CRITICAL: kind "api" + a CUSTOM endpoint URL + no per-endpoint key -> NEVER falls back to the env var (closes the OPENAI_API_KEY-leak-to-arbitrary-endpoint bug)', () => {
    const key = resolveApiKey(openai, { apiKeyEnc: null, endpoint: 'https://attacker.example.com/v1' });
    expect(key).toBeUndefined();
  });

  it('kind "openai_compatible" (openrouter/vllm/ollama) never falls back to any env var, even with no custom endpoint', () => {
    process.env.OPENROUTER_API_KEY = 'should-never-be-used-yet';
    const key = resolveApiKey(openrouter, { apiKeyEnc: null, endpoint: null });
    expect(key).toBeUndefined();
  });

  it('no per-endpoint key, no env var set -> undefined (never a placeholder)', () => {
    delete process.env.ANTHROPIC_API_KEY;
    const key = resolveApiKey(anthropic, { apiKeyEnc: null, endpoint: null });
    expect(key).toBeUndefined();
  });
});

describe('registry: effectiveSamplingParams', () => {
  it('falls back to registry defaults when the version has none', () => {
    expect(effectiveSamplingParams(null)).toEqual({ temperature: 0.3, max_tokens: 4096 });
  });

  it('prefers the version defaults, per-field, over the registry default', () => {
    expect(effectiveSamplingParams({ temperature: 0.7 })).toEqual({ temperature: 0.7, max_tokens: 4096 });
  });

  it('a per-call override wins over both the version default and the registry default', () => {
    expect(effectiveSamplingParams({ temperature: 0.7, max_tokens: 2048 }, { temperature: 0.9 })).toEqual({
      temperature: 0.9,
      max_tokens: 2048,
    });
  });

  it('ignores a malformed (non-object) samplingDefaults value and falls back to registry defaults', () => {
    expect(effectiveSamplingParams('not-an-object')).toEqual({ temperature: 0.3, max_tokens: 4096 });
  });
});

describe('registry: runProviderJudgment', () => {
  const baseInput = {
    judgeVersion: {
      servingBackend: 'anthropic' as ServingBackend,
      samplingDefaults: null,
      judgeModel: { baseModel: 'claude-3-5-haiku', slug: 'claude-3-5-haiku-judge' },
    },
    endpoint: { apiKeyEnc: 'sk-test-key', endpoint: null },
    template: { body: 'Rubric: ${rubricName}\nCriteria: ${criteriaList}', protocol: 'pointwise' as const },
    rubric: {
      name: 'Test Rubric',
      description: undefined,
      criteria: [
        { id: 'c1', rubricId: 'r1', name: 'Accuracy', description: 'desc', maxScore: 10, weight: 1, order: 0 },
      ],
    },
    submission: { responseText: 'the answer' },
  };

  beforeEach(() => {
    callAnthropicMock.mockReset();
    callOpenAICompatibleMock.mockReset();
  });

  it('CRITICAL: still refuses a scored judge run for a scoredRunsAllowed: false descriptor', () => {
    // NO SHIPPED BACKEND SETS THIS FALSE any more (ollama was the only one, and
    // the claim behind it was wrong — see backends/ollama.ts). The guard is
    // kept, and kept TESTED, because the concept remains the right shape for a
    // backend that genuinely cannot constrain output. Deleting this test along
    // with the last backend that tripped it would leave the refusal path live
    // and unexercised, so it is driven against a synthetic descriptor via the
    // extracted `assertScoredRunsAllowed` — ESM live bindings make stubbing
    // `getDescriptor` from outside the module impossible.
    const refused = { ...getDescriptor('ollama'), scoredRunsAllowed: false };
    expect(() => assertScoredRunsAllowed(refused)).toThrow(/does not allow scored judge runs/);
    try {
      assertScoredRunsAllowed(refused);
    } catch (e) {
      expect(e).toMatchObject({ name: 'ProviderError', kind: 'non_retryable' });
    }
    // And the happy path stays silent for every backend that ships.
    for (const backend of ALL_BACKENDS) {
      expect(() => assertScoredRunsAllowed(getDescriptor(backend))).not.toThrow();
    }
  });

  it('ollama now DISPATCHES a scored judge run instead of refusing it', async () => {
    // The behaviour change, pinned directly: what used to throw must now reach
    // the provider, and through the openai-compatible path.
    callOpenAICompatibleMock.mockResolvedValue({
      text: JSON.stringify({
        overallScore: 7,
        reasoning: 'ok',
        criteriaScores: [{ criterionId: 'c1', criterionName: 'Accuracy', score: 7 }],
      }),
      latencyMs: 5,
    });
    await runProviderJudgment({
      ...baseInput,
      judgeVersion: { ...baseInput.judgeVersion, servingBackend: 'ollama' },
    });
    expect(callOpenAICompatibleMock).toHaveBeenCalled();
    expect(callAnthropicMock).not.toHaveBeenCalled();
  });

  it('throws non_retryable when JudgeModel.baseModel is unset', async () => {
    await expect(
      runProviderJudgment({
        ...baseInput,
        judgeVersion: { ...baseInput.judgeVersion, judgeModel: { baseModel: null, slug: 'x' } },
      })
    ).rejects.toMatchObject({ kind: 'non_retryable' });
  });

  it('throws non_retryable when no API key resolves and there is no custom endpoint to fall back for', async () => {
    const original = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      await expect(
        runProviderJudgment({ ...baseInput, endpoint: { apiKeyEnc: null, endpoint: null } })
      ).rejects.toMatchObject({ kind: 'non_retryable' });
    } finally {
      if (original !== undefined) process.env.ANTHROPIC_API_KEY = original;
    }
  });

  it('a custom endpoint with no configured key falls back to a harmless placeholder rather than refusing (self-hosted, possibly auth-less servers)', async () => {
    callOpenAICompatibleMock.mockResolvedValue({
      // Carries a real criterion score because the rubric above has one. An
      // empty criteriaScores here used to survive only because the parser
      // fabricated 0 for every unscored criterion; this test is about
      // dispatch/key-resolution, so it supplies a valid response rather than
      // depending on that leniency.
      text: JSON.stringify({
        overallScore: 5,
        reasoning: '',
        criteriaScores: [{ criterionId: 'c1', criterionName: 'Accuracy', score: 5 }],
      }),
      latencyMs: 1,
    });

    await runProviderJudgment({
      ...baseInput,
      judgeVersion: { ...baseInput.judgeVersion, servingBackend: 'vllm' },
      endpoint: { apiKeyEnc: null, endpoint: 'http://localhost:8000/v1' },
    });

    expect(callOpenAICompatibleMock).toHaveBeenCalledTimes(1);
    expect(callOpenAICompatibleMock.mock.calls[0][0].apiKey).toBe('not-needed');
  });

  it('dispatches to callAnthropic for the anthropic descriptor, renders the template, and returns a fully-populated JudgmentResult', async () => {
    callAnthropicMock.mockResolvedValue({
      text: JSON.stringify({ overallScore: 7, reasoning: 'ok', criteriaScores: [{ criterionId: 'c1', criterionName: 'Accuracy', score: 8 }] }),
      servedModelId: 'claude-3-5-haiku-20241022',
      finishReason: 'end_turn',
      inputTokens: 100,
      outputTokens: 50,
      latencyMs: 12,
    });

    const result = await runProviderJudgment(baseInput);

    expect(callAnthropicMock).toHaveBeenCalledTimes(1);
    const call = callAnthropicMock.mock.calls[0][0];
    expect(call.apiKey).toBe('sk-test-key');
    expect(call.systemPrompt).toContain('Rubric: Test Rubric');

    expect(result.servedModelId).toBe('claude-3-5-haiku-20241022');
    expect(result.finishReason).toBe('end_turn');
    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(50);
    expect(result.parseMode).toBe('fallback');
    expect(result.samplingParamsUsed).toEqual({ temperature: 0.3, max_tokens: 4096 });
    expect(result.overallScore).toBe(7);
  });

  it('dispatches openrouter/vllm/ollama-shaped backends through callOpenAICompatible, not callAnthropic', async () => {
    callOpenAICompatibleMock.mockResolvedValue({
      // Carries a real criterion score because the rubric above has one. An
      // empty criteriaScores here used to survive only because the parser
      // fabricated 0 for every unscored criterion; this test is about
      // dispatch/key-resolution, so it supplies a valid response rather than
      // depending on that leniency.
      text: JSON.stringify({
        overallScore: 5,
        reasoning: '',
        criteriaScores: [{ criterionId: 'c1', criterionName: 'Accuracy', score: 5 }],
      }),
      latencyMs: 1,
    });

    await runProviderJudgment({
      ...baseInput,
      judgeVersion: { ...baseInput.judgeVersion, servingBackend: 'openrouter' },
    });

    expect(callOpenAICompatibleMock).toHaveBeenCalledTimes(1);
    expect(callAnthropicMock).not.toHaveBeenCalled();
  });

  it('CRITICAL: anthropic (kind:"api") NEVER gets the no-auth placeholder fallback, even behind a custom endpoint override — throws instead of silently attempting an unauthenticated call', async () => {
    await expect(
      runProviderJudgment({
        ...baseInput,
        endpoint: { apiKeyEnc: null, endpoint: 'https://some-proxy.example.com' },
      })
    ).rejects.toMatchObject({ name: 'ProviderError', kind: 'non_retryable' });

    expect(callAnthropicMock).not.toHaveBeenCalled();
  });

  it('CRITICAL: a malformed PromptTemplate body is classified non_retryable (fails fast), not a generic retryable error', async () => {
    await expect(
      runProviderJudgment({
        ...baseInput,
        template: { body: '${unterminated', protocol: 'pointwise' },
      })
    ).rejects.toMatchObject({ name: 'ProviderError', kind: 'non_retryable' });

    expect(callAnthropicMock).not.toHaveBeenCalled();
  });

  it('prepareJudgmentCall + executeJudgmentCall composition matches runProviderJudgment (the split runProviderJudgment is built from)', async () => {
    callAnthropicMock.mockResolvedValue({
      text: JSON.stringify({
        overallScore: 6,
        reasoning: 'ok',
        criteriaScores: [{ criterionId: 'c1', criterionName: 'Accuracy', score: 6 }],
      }),
      latencyMs: 1,
    });

    const prepared = prepareJudgmentCall(baseInput);
    expect(prepared.modelId).toBe('claude-3-5-haiku');
    expect(prepared.apiKey).toBe('sk-test-key');
    expect(prepared.samplingParamsUsed).toEqual({ temperature: 0.3, max_tokens: 4096 });

    const result = await executeJudgmentCall(prepared);
    expect(result.overallScore).toBe(6);
  });
});

describe('registry: ollama defaultBaseUrl (no explicit ModelEndpoint.endpoint configured)', () => {
  const ollamaVersion = {
    servingBackend: 'ollama' as ServingBackend,
    samplingDefaults: null,
    judgeModel: { baseModel: 'llama3', slug: 'llama3-local' },
  };

  beforeEach(() => {
    callOpenAICompatibleMock.mockReset();
  });

  it('CRITICAL: a respond call with NO endpoint.endpoint configured still succeeds via the descriptor\'s own defaultBaseUrl, using the no-auth placeholder (the whole point of Ollama shipping a default base URL is that callers do not have to configure one)', async () => {
    callOpenAICompatibleMock.mockResolvedValue({ text: 'generated', latencyMs: 1 });

    const result = await runProviderResponse({
      judgeVersion: ollamaVersion,
      endpoint: { apiKeyEnc: null, endpoint: null },
      submission: { promptText: 'hi' },
    });

    expect(result.responseText).toBe('generated');
    expect(callOpenAICompatibleMock).toHaveBeenCalledTimes(1);
    expect(callOpenAICompatibleMock.mock.calls[0][0].apiKey).toBe(NO_AUTH_PLACEHOLDER_KEY);
    expect(callOpenAICompatibleMock.mock.calls[0][0].baseUrl).toBe('http://localhost:11434/v1');
  });
});

describe('registry: runProviderResponse', () => {
  const baseInput = {
    judgeVersion: {
      servingBackend: 'ollama' as ServingBackend,
      samplingDefaults: null,
      judgeModel: { baseModel: 'llama3', slug: 'llama3-local' },
    },
    endpoint: { apiKeyEnc: null, endpoint: 'http://localhost:11434/v1' },
    submission: { promptText: 'hello' },
  };

  beforeEach(() => {
    callOpenAICompatibleMock.mockReset();
  });

  it('does NOT refuse ollama (scoredRunsAllowed only gates judge runs, not respond mode)', async () => {
    callOpenAICompatibleMock.mockResolvedValue({ text: 'a generated response', latencyMs: 5 });

    const result = await runProviderResponse(baseInput);
    expect(result.responseText).toBe('a generated response');
    expect(callOpenAICompatibleMock).toHaveBeenCalledTimes(1);
  });
});
