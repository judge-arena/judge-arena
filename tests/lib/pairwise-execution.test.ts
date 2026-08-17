import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The pairwise EXECUTION path: the pairwise schema reaching a guided-decoding
 * backend's request body, `executePairwiseCall`'s parse/refusal contract, and
 * `executePairwise`'s breaker wiring.
 *
 * Mocks the `openai` package's client class (the same stable interception
 * point tests/lib/backends.test.ts and tests/lib/registry.test.ts use) so the
 * REAL `callOpenAICompatible` / `execute()` / `prepareJudgmentCall` /
 * `executePairwiseCall` all run — this proves the actual request-shaping and
 * the actual parse seam, not a re-implementation of either.
 * `@/lib/llm/breaker-redis` is mocked too, purely so `executePairwise`
 * (@/lib/llm) can be called without a live Redis.
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

const { execute, getDescriptor, prepareJudgmentCall, executePairwiseCall } = await import('@/lib/llm/registry');
const { executePairwise } = await import('@/lib/llm');
const { JUDGMENT_JSON_SCHEMA, JUDGMENT_JSON_SCHEMA_NAME, PAIRWISE_JUDGMENT_JSON_SCHEMA } = await import(
  '@/lib/llm/judgment-schema'
);
import type { RunProviderJudgmentInput } from '@/lib/llm';

function okChatResponse(content: string, model = 'served-model') {
  return {
    model,
    choices: [{ message: { content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 11, completion_tokens: 7 },
  };
}

const baseVllmCall = {
  apiKey: 'sk-vllm-test',
  baseUrl: 'http://vllm.internal:8000/v1',
  modelId: 'meta-llama/Llama-3-70B',
  systemPrompt: 'system',
  userPrompt: 'user',
  samplingParams: { temperature: 0.3, max_tokens: 100 },
};

const pairwiseInput: RunProviderJudgmentInput = {
  judgeVersion: {
    servingBackend: 'vllm' as const,
    samplingDefaults: null,
    judgeModel: { baseModel: 'meta-llama/Llama-3-70B', slug: 'llama3-judge' },
  },
  endpoint: { apiKeyEnc: 'sk-vllm-test', endpoint: 'http://vllm.internal:8000/v1' },
  template: { body: 'Rubric: ${rubricName}\nCriteria: ${criteriaList}', protocol: 'pairwise' as const },
  rubric: {
    name: 'Pair Rubric',
    description: undefined,
    criteria: [
      { id: 'c1', rubricId: 'r1', name: 'Accuracy', description: 'desc', maxScore: 10, weight: 1, order: 0 },
    ],
  },
  submission: {
    inputText: 'What is the capital of France?',
    candidates: [
      { position: 0, promptText: null, responseText: 'Paris.', label: null },
      { position: 1, promptText: null, responseText: 'Lyon.', label: null },
    ],
  },
};

beforeEach(() => {
  OpenAIConstructorMock.mockClear();
  openaiCreateMock.mockReset();
  getBreakerMock.mockReset();
  allowMock.mockReset();
  onSuccessMock.mockReset();
  onFailureMock.mockReset();
  getBreakerMock.mockImplementation(() => ({
    allow: allowMock,
    onSuccess: onSuccessMock,
    onFailure: onFailureMock,
  }));
  allowMock.mockResolvedValue('closed');
});

describe('structured-output seam: jsonSchema overrides the pointwise default', () => {
  it('a judgment call with an explicit jsonSchema sends THAT schema, not JUDGMENT_JSON_SCHEMA', async () => {
    openaiCreateMock.mockResolvedValue(okChatResponse('{"verdict":"A","reasoning":"r"}'));

    await execute(getDescriptor('vllm'), {
      ...baseVllmCall,
      mode: 'judgment',
      jsonSchema: PAIRWISE_JUDGMENT_JSON_SCHEMA as unknown as Record<string, unknown>,
    });

    const [params] = openaiCreateMock.mock.calls[0];
    expect(params.guided_json).toEqual(PAIRWISE_JUDGMENT_JSON_SCHEMA);
    expect(params.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: JUDGMENT_JSON_SCHEMA_NAME, schema: PAIRWISE_JUDGMENT_JSON_SCHEMA },
    });
  });

  it('REGRESSION: a judgment call with no jsonSchema still sends the pointwise JUDGMENT_JSON_SCHEMA', async () => {
    openaiCreateMock.mockResolvedValue(okChatResponse('{}'));

    await execute(getDescriptor('vllm'), { ...baseVllmCall, mode: 'judgment' });

    const [params] = openaiCreateMock.mock.calls[0];
    expect(params.guided_json).toEqual(JUDGMENT_JSON_SCHEMA);
  });

  it('a jsonSchema on a respond-mode call attaches nothing (no schema guides free-form text)', async () => {
    openaiCreateMock.mockResolvedValue(okChatResponse('free text'));

    await execute(getDescriptor('vllm'), {
      ...baseVllmCall,
      mode: 'respond',
      jsonSchema: PAIRWISE_JUDGMENT_JSON_SCHEMA as unknown as Record<string, unknown>,
    });

    const [params] = openaiCreateMock.mock.calls[0];
    expect(params.response_format).toBeUndefined();
    expect(params.guided_json).toBeUndefined();
  });
});

describe('registry: executePairwiseCall', () => {
  it('renders the pairwise prompt pair, attaches the pairwise schema, and returns a fully-populated PairwiseResult', async () => {
    openaiCreateMock.mockResolvedValue(
      okChatResponse('{"verdict":"B","reasoning":"B is better"}', 'meta-llama/Llama-3-70B')
    );

    const prepared = prepareJudgmentCall(pairwiseInput);
    expect(prepared.systemPrompt).toContain('Rubric: Pair Rubric');
    expect(prepared.userPrompt).toContain('## Response A\nParis.');
    expect(prepared.userPrompt).toContain('## Response B\nLyon.');

    const result = await executePairwiseCall(prepared);

    const [params] = openaiCreateMock.mock.calls[0];
    expect(params.guided_json).toEqual(PAIRWISE_JUDGMENT_JSON_SCHEMA);

    expect(result.verdict).toBe('B');
    expect(result.reasoning).toBe('B is better');
    expect(result.rawResponse).toBe('{"verdict":"B","reasoning":"B is better"}');
    expect(result.servedModelId).toBe('meta-llama/Llama-3-70B');
    expect(result.finishReason).toBe('stop');
    expect(result.inputTokens).toBe(11);
    expect(result.outputTokens).toBe(7);
    expect(result.samplingParamsUsed).toEqual({ temperature: 0.3, max_tokens: 4096 });
  });

  it('accepts a markdown-fenced verdict (guided decoding is guidance, not a guarantee)', async () => {
    openaiCreateMock.mockResolvedValue(okChatResponse('```json\n{"verdict":"tie","reasoning":"even"}\n```'));

    const result = await executePairwiseCall(prepareJudgmentCall(pairwiseInput));
    expect(result.verdict).toBe('tie');
  });

  it('CRITICAL: a response with no usable verdict is non_retryable, not a retryable provider failure', async () => {
    openaiCreateMock.mockResolvedValue(okChatResponse('Response A is better, obviously.'));

    await expect(executePairwiseCall(prepareJudgmentCall(pairwiseInput))).rejects.toMatchObject({
      name: 'ProviderError',
      kind: 'non_retryable',
    });
  });

  it('CRITICAL: a POINTWISE-shaped response is also non_retryable (never coerced into a verdict)', async () => {
    openaiCreateMock.mockResolvedValue(
      okChatResponse('{"overallScore":7,"reasoning":"r","criteriaScores":[]}')
    );

    await expect(executePairwiseCall(prepareJudgmentCall(pairwiseInput))).rejects.toMatchObject({
      kind: 'non_retryable',
    });
  });

  it('a malformed pairwise PromptTemplate body fails at prepare time, before any network call', () => {
    expect(() =>
      prepareJudgmentCall({ ...pairwiseInput, template: { body: '${unterminated', protocol: 'pairwise' } })
    ).toThrow(/Failed to render judgment prompt/);
    expect(openaiCreateMock).not.toHaveBeenCalled();
  });

  it('a pairwise call missing its second candidate fails at prepare time too', () => {
    expect(() =>
      prepareJudgmentCall({
        ...pairwiseInput,
        submission: { inputText: 'q', candidates: [pairwiseInput.submission.candidates![0]] },
      })
    ).toThrow(/exactly 2 candidates are required/);
  });
});

describe('llm/index: executePairwise breaker wiring', () => {
  it('records exactly one breaker success for a successful pairwise call', async () => {
    openaiCreateMock.mockResolvedValue(okChatResponse('{"verdict":"A","reasoning":"r"}'));

    const result = await executePairwise(pairwiseInput);

    expect(result.verdict).toBe('A');
    expect(getBreakerMock).toHaveBeenCalledWith(
      'vllm:http://vllm.internal:8000/v1:meta-llama/Llama-3-70B'
    );
    expect(onSuccessMock).toHaveBeenCalledTimes(1);
    expect(onFailureMock).not.toHaveBeenCalled();
  });

  it('fails fast without calling the provider when the breaker is open', async () => {
    allowMock.mockResolvedValue('open');

    await expect(executePairwise(pairwiseInput)).rejects.toMatchObject({
      name: 'ProviderError',
      breakerOpen: true,
    });
    expect(openaiCreateMock).not.toHaveBeenCalled();
  });

  it('a prepare-time config failure throws BEFORE the breaker is ever consulted', async () => {
    await expect(
      executePairwise({ ...pairwiseInput, template: { body: '${unterminated', protocol: 'pairwise' } })
    ).rejects.toMatchObject({ kind: 'non_retryable' });
    expect(getBreakerMock).not.toHaveBeenCalled();
  });
});
