import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServingBackend } from '@prisma/client';
import { logger } from '@/lib/logger';

/**
 * Task 11: OpenRouter + vLLM backends, structured/guided-decoding output.
 *
 * Mocks the `openai` package's client class itself (not global `fetch`) —
 * the SAME stable interception point `tests/lib/registry.test.ts`/
 * `tests/lib/llm-timeout.test.ts` already use, and for the same reason
 * documented there: Vitest externalizes third-party `node_modules`
 * packages by default, so mocking a package two levels down the real SDK's
 * own dependency graph (e.g. its internal `fetch` call) is unreliable;
 * mocking the SDK's own public client surface is the stable interception
 * point. `callOpenAICompatible`/`execute()`/`registry.ts`'s prepare/execute
 * pipeline all run for REAL against this mock — this proves the actual
 * request-shaping code (headers, structured-output fields) and the actual
 * parse-fallback seam, not a re-implementation of either.
 *
 * `@/lib/llm/breaker-redis` is ALSO mocked (matching
 * `tests/lib/llm-index.test.ts`'s own pattern) purely so the breaker-key
 * granularity test can call the real `executeJudgment` (`@/lib/llm`)
 * without a live Redis — it does not interact with the `openai` mock at
 * all, so both mocks coexist safely for the whole file.
 */
const { openaiCreateMock, OpenAIConstructorMock, getBreakerMock, allowMock, onSuccessMock, onFailureMock } =
  vi.hoisted(() => ({
    openaiCreateMock: vi.fn(),
    OpenAIConstructorMock: vi.fn(),
    getBreakerMock: vi.fn(),
    allowMock: vi.fn(),
    onSuccessMock: vi.fn(),
    onFailureMock: vi.fn(),
  }));

vi.mock('openai', () => ({
  default: OpenAIConstructorMock.mockImplementation(() => ({
    chat: { completions: { create: openaiCreateMock } },
  })),
}));

vi.mock('@/lib/llm/breaker-redis', () => ({ getBreaker: getBreakerMock }));

const { execute, getDescriptor, runProviderJudgment } = await import('@/lib/llm/registry');
const { executeJudgment } = await import('@/lib/llm');
const { JUDGMENT_JSON_SCHEMA, JUDGMENT_JSON_SCHEMA_NAME } = await import('@/lib/llm/judgment-schema');

const ORIGINAL_ENV = { ...process.env };

function okChatResponse(content: string, model = 'served-model') {
  return {
    model,
    choices: [{ message: { content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('OpenRouter descriptor: attribution headers, default base URL, bearer auth', () => {
  const baseCall = {
    apiKey: 'sk-or-test-key',
    modelId: 'openai/gpt-4o',
    systemPrompt: 'system',
    userPrompt: 'user',
    samplingParams: { temperature: 0.3, max_tokens: 100 },
  };

  beforeEach(() => {
    OpenAIConstructorMock.mockClear();
    openaiCreateMock.mockReset();
    openaiCreateMock.mockResolvedValue(okChatResponse('ok', 'openai/gpt-4o'));
    delete process.env.OPENROUTER_SITE_URL;
    delete process.env.NEXTAUTH_URL;
  });

  it('constructs the OpenAI client with the OpenRouter default base URL and the resolved bearer key', async () => {
    await execute(getDescriptor('openrouter'), baseCall);

    expect(OpenAIConstructorMock).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'sk-or-test-key', baseURL: 'https://openrouter.ai/api/v1' })
    );
  });

  it('always sends X-Title, and HTTP-Referer from OPENROUTER_SITE_URL when set', async () => {
    process.env.OPENROUTER_SITE_URL = 'https://judge.example.com';

    await execute(getDescriptor('openrouter'), baseCall);

    const [, options] = openaiCreateMock.mock.calls[0];
    expect(options.headers).toEqual({ 'X-Title': 'Judge Arena', 'HTTP-Referer': 'https://judge.example.com' });
  });

  it('falls back to NEXTAUTH_URL for HTTP-Referer when OPENROUTER_SITE_URL is unset', async () => {
    process.env.NEXTAUTH_URL = 'https://arena.example.com';

    await execute(getDescriptor('openrouter'), baseCall);

    const [, options] = openaiCreateMock.mock.calls[0];
    expect(options.headers['HTTP-Referer']).toBe('https://arena.example.com');
  });

  it('omits HTTP-Referer entirely when neither env var is set (X-Title still sent)', async () => {
    await execute(getDescriptor('openrouter'), baseCall);

    const [, options] = openaiCreateMock.mock.calls[0];
    expect(options.headers).toEqual({ 'X-Title': 'Judge Arena' });
  });

  it('a custom baseUrl on the request overrides the descriptor default', async () => {
    await execute(getDescriptor('openrouter'), { ...baseCall, baseUrl: 'https://custom-proxy.example.com/v1' });

    expect(OpenAIConstructorMock).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: 'https://custom-proxy.example.com/v1' })
    );
  });
});

describe('vLLM descriptor: guided-decoding structured-output request fields', () => {
  const baseCall = {
    apiKey: 'sk-vllm-test',
    baseUrl: 'http://vllm.internal:8000/v1',
    modelId: 'meta-llama/Llama-3-70B',
    systemPrompt: 'system',
    userPrompt: 'user',
    samplingParams: { temperature: 0.3, max_tokens: 100 },
  };

  beforeEach(() => {
    OpenAIConstructorMock.mockClear();
    openaiCreateMock.mockReset();
    openaiCreateMock.mockResolvedValue(okChatResponse('ok', 'meta-llama/Llama-3-70B'));
  });

  it('a judgment-mode call carries BOTH response_format json_schema and guided_json, matching JUDGMENT_JSON_SCHEMA', async () => {
    await execute(getDescriptor('vllm'), { ...baseCall, mode: 'judgment' });

    const [params] = openaiCreateMock.mock.calls[0];
    expect(params.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: JUDGMENT_JSON_SCHEMA_NAME, schema: JUDGMENT_JSON_SCHEMA },
    });
    expect(params.guided_json).toEqual(JUDGMENT_JSON_SCHEMA);
  });

  it('a respond-mode call does NOT get the structured-output fields attached (free-form text has no schema to guide)', async () => {
    await execute(getDescriptor('vllm'), { ...baseCall, mode: 'respond' });

    const [params] = openaiCreateMock.mock.calls[0];
    expect(params.response_format).toBeUndefined();
    expect(params.guided_json).toBeUndefined();
  });

  it('a call with no mode set at all (pre-Task-11 direct execute() callers) does not get structured fields either', async () => {
    await execute(getDescriptor('vllm'), baseCall);

    const [params] = openaiCreateMock.mock.calls[0];
    expect(params.response_format).toBeUndefined();
    expect(params.guided_json).toBeUndefined();
  });

  it('bearer auth + the explicit baseUrl are honored (vLLM has no built-in default host)', async () => {
    await execute(getDescriptor('vllm'), { ...baseCall, mode: 'judgment' });

    expect(OpenAIConstructorMock).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'sk-vllm-test', baseURL: 'http://vllm.internal:8000/v1' })
    );
  });

  it('getDescriptor("vllm") reads defaultBaseUrl from VLLM_BASE_URL when no explicit request baseUrl is given', async () => {
    process.env.VLLM_BASE_URL = 'http://vllm-from-env:8000/v1';

    await execute(getDescriptor('vllm'), {
      apiKey: 'sk-vllm-test',
      modelId: 'meta-llama/Llama-3-70B',
      systemPrompt: 'system',
      userPrompt: 'user',
      samplingParams: { temperature: 0.3, max_tokens: 100 },
    });

    expect(OpenAIConstructorMock).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: 'http://vllm-from-env:8000/v1' })
    );
  });
});

describe('Structured-output parse seam: parseMode "structured" vs "fallback"', () => {
  const criteria = [{ id: 'c1', rubricId: 'r1', name: 'Accuracy', description: 'desc', maxScore: 10, weight: 1, order: 0 }];

  const baseInput = {
    judgeVersion: {
      servingBackend: 'vllm' as ServingBackend,
      samplingDefaults: null,
      judgeModel: { baseModel: 'meta-llama/Llama-3-70B', slug: 'llama3-vllm-judge' },
    },
    endpoint: { apiKeyEnc: 'sk-vllm-test', endpoint: 'http://vllm.internal:8000/v1' },
    template: { body: 'Rubric: ${rubricName}\nCriteria: ${criteriaList}', protocol: 'pointwise' as const },
    rubric: { name: 'Test Rubric', description: undefined, criteria },
    submission: { responseText: 'the answer' },
  };

  beforeEach(() => {
    openaiCreateMock.mockReset();
  });

  it('a well-formed, unwrapped-JSON response (guidance honored) parses via the strict path — parseMode "structured"', async () => {
    openaiCreateMock.mockResolvedValue(
      okChatResponse(
        JSON.stringify({
          overallScore: 8,
          reasoning: 'solid',
          criteriaScores: [{ criterionId: 'c1', criterionName: 'Accuracy', score: 9, maxScore: 10 }],
        }),
        'meta-llama/Llama-3-70B'
      )
    );

    const result = await runProviderJudgment(baseInput);

    expect(result.parseMode).toBe('structured');
    expect(result.overallScore).toBe(8);
    expect(result.criteriaScores[0].score).toBe(9);
  });

  it('CRITICAL: a non-conforming response (markdown-wrapped, guidance ignored) demotes to the lenient parse — parseMode "fallback", and logs a warning', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    openaiCreateMock.mockResolvedValue(
      okChatResponse(
        '```json\n' + JSON.stringify({ overallScore: 6, reasoning: 'ok', criteriaScores: [] }) + '\n```',
        'meta-llama/Llama-3-70B'
      )
    );

    const result = await runProviderJudgment(baseInput);

    expect(result.parseMode).toBe('fallback');
    expect(result.overallScore).toBe(6);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('did not conform'),
      expect.objectContaining({ provider: 'vllm', modelId: 'meta-llama/Llama-3-70B' })
    );

    warnSpy.mockRestore();
  });

  it('a genuinely unparseable response also demotes to fallback (which throws its own clear parse error, unchanged pre-Task-11 behavior)', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    openaiCreateMock.mockResolvedValue(okChatResponse('not json at all', 'meta-llama/Llama-3-70B'));

    await expect(runProviderJudgment(baseInput)).rejects.toThrow(/Failed to parse LLM judgment response/);
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it('a conforming response from an openrouter (json_schema cap, no custom hook) descriptor also parses as "structured"', async () => {
    openaiCreateMock.mockResolvedValue(
      okChatResponse(JSON.stringify({ overallScore: 7, reasoning: 'ok', criteriaScores: [] }), 'openai/gpt-4o')
    );

    const result = await runProviderJudgment({
      ...baseInput,
      judgeVersion: {
        servingBackend: 'openrouter' as ServingBackend,
        samplingDefaults: null,
        judgeModel: { baseModel: 'openai/gpt-4o', slug: 'gpt4o-openrouter-judge' },
      },
    });

    expect(result.parseMode).toBe('structured');
  });
});

describe('Breaker key granularity (Task 4 formula, confirmed for OpenRouter): distinct models get independent circuits', () => {
  const judgeVersion = {
    servingBackend: 'openrouter' as ServingBackend,
    samplingDefaults: null,
    judgeModel: { baseModel: 'openai/gpt-4o', slug: 'gpt4o-openrouter-judge' },
  };

  const baseInput = {
    judgeVersion,
    endpoint: { apiKeyEnc: 'sk-or-test', endpoint: null },
    template: { body: 'Rubric: ${rubricName}\nCriteria: ${criteriaList}', protocol: 'pointwise' as const },
    rubric: { name: 'Test Rubric', description: undefined, criteria: [] },
    submission: { responseText: 'the answer' },
  };

  beforeEach(() => {
    openaiCreateMock.mockReset();
    openaiCreateMock.mockResolvedValue(
      okChatResponse(JSON.stringify({ overallScore: 5, reasoning: '', criteriaScores: [] }))
    );

    getBreakerMock.mockReset();
    getBreakerMock.mockImplementation(() => ({ allow: allowMock, onSuccess: onSuccessMock, onFailure: onFailureMock }));
    allowMock.mockResolvedValue('closed');
    onSuccessMock.mockResolvedValue(undefined);
    onFailureMock.mockResolvedValue(undefined);
  });

  it('two different OpenRouter-routed models produce two different breaker keys', async () => {
    await executeJudgment(baseInput);
    expect(getBreakerMock).toHaveBeenCalledWith('openrouter:default:openai/gpt-4o');

    getBreakerMock.mockClear();

    await executeJudgment({
      ...baseInput,
      judgeVersion: {
        ...judgeVersion,
        judgeModel: { baseModel: 'anthropic/claude-3.5-sonnet', slug: 'claude-openrouter-judge' },
      },
    });
    expect(getBreakerMock).toHaveBeenCalledWith('openrouter:default:anthropic/claude-3.5-sonnet');
  });
});
