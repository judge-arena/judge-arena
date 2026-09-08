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
const {
  openaiCreateMock,
  OpenAIConstructorMock,
  anthropicCreateMock,
  getBreakerMock,
  allowMock,
  onSuccessMock,
  onFailureMock,
} = vi.hoisted(() => ({
  openaiCreateMock: vi.fn(),
  OpenAIConstructorMock: vi.fn(),
  anthropicCreateMock: vi.fn(),
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
// #11: anthropic pairwise is the case that separates "a schema was attached
// to THIS request" (`raw.structuredOutputRequested`) from "this descriptor's
// caps are not 'none'" — its caps are `tool_use`. Same constructor-level
// interception as tests/lib/reasoning-capture.test.ts, so the REAL
// callAnthropic runs.
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: anthropicCreateMock },
  })),
}));
vi.mock('@/lib/llm/breaker-redis', () => ({ getBreaker: getBreakerMock }));

const { execute, getDescriptor, prepareJudgmentCall, executePairwiseCall } = await import('@/lib/llm/registry');
const { executePairwise } = await import('@/lib/llm');
const { commonSuccessUpdateData } = await import('@/worker/judgment-consumer');
const { JUDGMENT_JSON_SCHEMA, JUDGMENT_JSON_SCHEMA_NAME, PAIRWISE_JUDGMENT_JSON_SCHEMA } = await import(
  '@/lib/llm/judgment-schema'
);
import { createHash } from 'crypto';
import type { RunProviderJudgmentInput } from '@/lib/llm';
import { preferenceFromVerdict } from '@/lib/calibration/readings';

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
  anthropicCreateMock.mockReset();
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

/**
 * A2.1 v2i: the rendered prompt is not reconstructible after the fact.
 * `PATCH /api/rubrics/[id]` deleteMany's a rubric's criteria and recreates
 * them on the SAME id with no version bump, and the pairwise system prompt
 * embeds those criteria verbatim — so one rubric edit silently rewrites the
 * "reconstruction" of every historical pairwise judgment, with nothing
 * recording that it moved. It has to be stored at judgment time or it is
 * gone.
 */
describe('pairwise: the rendered prompt reaches the persist path', () => {
  it('carries systemPrompt/userPrompt/userPromptSha256 out of executePairwiseCall', async () => {
    openaiCreateMock.mockResolvedValue(okChatResponse('{"verdict":"A","reasoning":"r"}'));

    const prepared = prepareJudgmentCall(pairwiseInput);
    const result = await executePairwiseCall(prepared);

    expect(result.systemPrompt).toBe(prepared.systemPrompt);
    expect(result.userPrompt).toBe(prepared.userPrompt);
    expect(result.userPromptSha256).toBe(createHash('sha256').update(prepared.userPrompt, 'utf8').digest('hex'));
    expect(result.promptTruncated).toBe(false);
    // The criteria the system prompt embeds are exactly what a rubric edit
    // would silently rewrite underneath a reconstruction.
    expect(result.systemPrompt).toContain('Accuracy');
  });

  it('and those fields survive the shared persist mapping into the ModelJudgment row', async () => {
    openaiCreateMock.mockResolvedValue({
      model: 'served-model',
      choices: [
        {
          message: { content: '{"verdict":"A","reasoning":"r"}', reasoning_content: 'deliberation' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 11, completion_tokens: 7, completion_tokens_details: { reasoning_tokens: 4 } },
    });

    const prepared = prepareJudgmentCall(pairwiseInput);
    const result = await executePairwiseCall(prepared);

    // The ONE shared mapping all three persist paths (judge/respond/pairwise)
    // funnel through — asserted here so a new field can't reach one path and
    // silently miss the other two.
    const data = commonSuccessUpdateData(result, { samplingDefaults: null, reasoningMode: 'none' } as never);

    expect(data.systemPrompt).toBe(prepared.systemPrompt);
    expect(data.userPrompt).toBe(prepared.userPrompt);
    expect(data.userPromptSha256).toBe(createHash('sha256').update(prepared.userPrompt, 'utf8').digest('hex'));
    expect(data.promptTruncated).toBe(false);
    // The thinking channel is persisted SEPARATELY from `reasoning`, which
    // for a pairwise judgment already holds the parsed rationale.
    expect(data.reasoningContent).toBe('deliberation');
    expect(data.reasoningSource).toBe('reasoning_content');
    expect(data.reasoningTokens).toBe(4);
    expect(result.reasoning).toBe('r');
    // #11: vllm (caps 'guided') requested a schema and the bare JSON needed no
    // repair — the registry result carries 'structured' into the seam. The
    // column write itself is pinned by tests/integration/pairwise-run.test.ts,
    // because persistPairwiseSuccess (not commonSuccessUpdateData) writes it.
    expect(result.parseMode).toBe('structured');
  });
});

/**
 * #11 (handoff 2026-09-01 §7): pairwise `parseMode`, mirroring the pointwise
 * rule pinned in tests/lib/backends.test.ts (describe 'Structured-output
 * parse seam: parseMode "structured" vs "fallback"') — 'structured' is only
 * possible when a schema was ATTACHED TO THE REQUEST, i.e. when
 * `raw.structuredOutputRequested` is true, which only `callOpenAICompatible`
 * ever sets (for `mode: 'judgment'` on a descriptor whose caps are not
 * 'none'), and then only when the text needed no repair (no fence stripped,
 * no verdict normalisation). Everything else is 'fallback'. Runs the REAL
 * callOpenAICompatible / execute / prepareJudgmentCall / executePairwiseCall
 * against the mocked SDK client, so the request-shaping and the parse seam
 * are both the production code.
 *
 * The anthropic case below is the one that DISCRIMINATES the rule. Its
 * descriptor caps are `tool_use`, NOT 'none', so an implementation keyed on
 * `descriptor.caps.structuredOutput !== 'none'` rather than on
 * `raw.structuredOutputRequested` is indistinguishable from the correct one
 * on llamacpp ('json_schema') and on openai ('none') — every other case in
 * this file stays green on it — while writing 'structured' for a request
 * that never carried a schema. Anthropic never reaches
 * callOpenAICompatible: registry's `execute` sends
 * `descriptor.id === 'anthropic'` to callAnthropic, whose result omits
 * `structuredOutputRequested`, so the correct rule lands on 'fallback'
 * through the `undefined && …` arm. Its SDK client is mocked at the same
 * constructor level as `openai` (tests/lib/reasoning-capture.test.ts mocks
 * both packages this way).
 */
describe('pairwise parseMode: "structured" only when a schema was requested AND the text needed no repair', () => {
  const llamacppInput: RunProviderJudgmentInput = {
    ...pairwiseInput,
    judgeVersion: {
      servingBackend: 'llamacpp' as const,
      samplingDefaults: null,
      judgeModel: { baseModel: 'Qwen3.6-35B-A3B', slug: 'qwen-llamacpp-judge' },
    },
    // An explicit endpoint URL, so LLAMACPP_BASE_URL is not consulted.
    endpoint: { apiKeyEnc: 'sk-llamacpp-test', endpoint: 'http://llamacpp.internal:8001/v1' },
  };

  const openaiInput: RunProviderJudgmentInput = {
    ...pairwiseInput,
    judgeVersion: {
      servingBackend: 'openai' as const,
      samplingDefaults: null,
      judgeModel: { baseModel: 'gpt-4o', slug: 'gpt4o-openai-judge' },
    },
    endpoint: { apiKeyEnc: 'sk-openai-test', endpoint: null },
  };

  const anthropicInput: RunProviderJudgmentInput = {
    ...pairwiseInput,
    judgeVersion: {
      servingBackend: 'anthropic' as const,
      samplingDefaults: null,
      judgeModel: { baseModel: 'claude-3-5-sonnet-20241022', slug: 'claude-anthropic-judge' },
    },
    // apiKeyEnc set, endpoint null: the anthropic descriptor is `kind: 'api'`
    // with no defaultBaseUrl, so callAnthropic gets `baseURL: undefined`.
    endpoint: { apiKeyEnc: 'sk-anthropic-test', endpoint: null },
  };

  it('llamacpp (caps json_schema) + bare canonical JSON -> "structured", and the schema was really on the request', async () => {
    openaiCreateMock.mockResolvedValue(okChatResponse('{"verdict":"A","reasoning":"r"}'));

    const result = await executePairwiseCall(prepareJudgmentCall(llamacppInput));

    const [params] = openaiCreateMock.mock.calls[0];
    expect(params.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: JUDGMENT_JSON_SCHEMA_NAME, schema: PAIRWISE_JUDGMENT_JSON_SCHEMA, strict: true },
    });
    expect(result.verdict).toBe('A');
    expect(result.parseMode).toBe('structured');
  });

  it('llamacpp + ```json-fenced JSON -> "fallback": the verdict is still accepted, but a fence had to be stripped', async () => {
    openaiCreateMock.mockResolvedValue(okChatResponse('```json\n{"verdict":"A","reasoning":"r"}\n```'));

    const result = await executePairwiseCall(prepareJudgmentCall(llamacppInput));

    expect(result.verdict).toBe('A');
    expect(result.parseMode).toBe('fallback');
  });

  it('llamacpp + lower-case verdict -> "fallback": the verdict was repaired, not read', async () => {
    openaiCreateMock.mockResolvedValue(okChatResponse('{"verdict":"a","reasoning":"r"}'));

    const result = await executePairwiseCall(prepareJudgmentCall(llamacppInput));

    expect(result.verdict).toBe('A');
    expect(result.parseMode).toBe('fallback');
  });

  it('openai (caps none) + bare canonical JSON -> "fallback": no schema was requested, so nothing was "structured" (the pointwise rule, backends.test.ts "Structured-output parse seam" describe)', async () => {
    openaiCreateMock.mockResolvedValue(okChatResponse('{"verdict":"B","reasoning":"r"}', 'gpt-4o'));

    const result = await executePairwiseCall(prepareJudgmentCall(openaiInput));

    const [params] = openaiCreateMock.mock.calls[0];
    expect(params.response_format).toBeUndefined();
    expect(params.guided_json).toBeUndefined();
    expect(result.verdict).toBe('B');
    expect(result.parseMode).toBe('fallback');
  });

  it('anthropic (caps tool_use — NOT "none") + bare canonical JSON -> "fallback": an ATTACHED schema is the rule, descriptor caps are not', async () => {
    anthropicCreateMock.mockResolvedValue({
      model: 'claude-3-5-sonnet-20241022',
      content: [{ type: 'text', text: '{"verdict":"A","reasoning":"r"}' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 11, output_tokens: 7 },
    });

    const result = await executePairwiseCall(prepareJudgmentCall(anthropicInput));

    // callAnthropic ran and callOpenAICompatible did not — which is exactly
    // why no request carried a schema and `structuredOutputRequested` is
    // undefined on the raw result.
    expect(anthropicCreateMock).toHaveBeenCalledTimes(1);
    expect(openaiCreateMock).not.toHaveBeenCalled();
    expect(result.verdict).toBe('A');
    // THE discriminating assertion: caps here are `tool_use`, so a rule
    // written as `caps.structuredOutput !== 'none'` says 'structured' and a
    // rule written as `raw.structuredOutputRequested` says 'fallback'.
    expect(result.parseMode).toBe('fallback');
  });
});

/**
 * Task 4: `buildPairwiseUserPrompt` now takes a `PairOrder`, threaded through
 * `prepareJudgmentCall`'s `input.pairOrder`. Spec trap 4.1: a sign error in
 * this threading has NO SYMPTOM downstream (readings.ts:26-33) — an accuracy
 * assertion cannot catch it, only the persisted bytes can. Runs the real
 * `prepareJudgmentCall` -> `executePairwiseCall` path against the mocked
 * OpenAI client, same harness as the `userPromptSha256` assertions above.
 */
describe('pairwise: pairOrder controls what is rendered and persisted (Task 4)', () => {
  const orderedInput: RunProviderJudgmentInput = {
    ...pairwiseInput,
    submission: {
      inputText: 'Q',
      candidates: [
        { position: 0, promptText: null, responseText: 'CANDIDATE_AT_POSITION_ZERO', label: null },
        { position: 1, promptText: null, responseText: 'CANDIDATE_AT_POSITION_ONE', label: null },
      ],
    },
  };

  it('persists a DIFFERENT userPrompt and sha256 for BA than for AB', async () => {
    openaiCreateMock.mockResolvedValue(okChatResponse('{"verdict":"A","reasoning":"r"}'));

    const abPrepared = prepareJudgmentCall({ ...orderedInput, pairOrder: 'AB' });
    const ab = await executePairwiseCall(abPrepared);

    const baPrepared = prepareJudgmentCall({ ...orderedInput, pairOrder: 'BA' });
    const ba = await executePairwiseCall(baPrepared);

    // The bytes actually changed. If this passes while the two are equal, the
    // swap silently did nothing and every BA row would be mislabelled.
    expect(ba.userPrompt).not.toBe(ab.userPrompt);
    expect(ba.userPromptSha256).not.toBe(ab.userPromptSha256);

    // And it changed in the RIGHT direction: position 1's text is presented
    // first under BA. Asserted against `prepared.userPrompt` (a plain
    // `string`, not the optional `CallCaptureFields.userPrompt`) — already
    // proven equal to `result.userPrompt` by the describe block above.
    const zero = 'CANDIDATE_AT_POSITION_ZERO';
    const one = 'CANDIDATE_AT_POSITION_ONE';
    expect(abPrepared.userPrompt.indexOf(zero)).toBeLessThan(abPrepared.userPrompt.indexOf(one));
    expect(baPrepared.userPrompt.indexOf(one)).toBeLessThan(baPrepared.userPrompt.indexOf(zero));
  });

  it('defaults to AB when pairOrder is omitted, matching every pre-BA caller', async () => {
    openaiCreateMock.mockResolvedValue(okChatResponse('{"verdict":"A","reasoning":"r"}'));

    const withoutOrder = await executePairwiseCall(prepareJudgmentCall(orderedInput));
    const withAb = await executePairwiseCall(prepareJudgmentCall({ ...orderedInput, pairOrder: 'AB' }));

    expect(withoutOrder.userPrompt).toBe(withAb.userPrompt);
    expect(withoutOrder.userPromptSha256).toBe(withAb.userPromptSha256);
  });

  it('inverts in exactly ONE layer — a BA verdict of A means B>A', () => {
    // Guards the double-inversion trap: the renderer (this file's tests
    // above) swaps what is SHOWN; `preferenceFromVerdict`
    // (calibration/readings.ts, unmodified by this task and already pinned
    // arm-by-arm in tests/lib/calibration-readings.test.ts) swaps what the
    // verdict letter MEANS. Both together would silently return to AB.
    expect(preferenceFromVerdict('A', 'BA')).toBe('B>A');
    expect(preferenceFromVerdict('A', 'AB')).toBe('A>B');
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
