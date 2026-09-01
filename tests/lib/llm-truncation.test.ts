import { createHash } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A2.1 v2i — THE TRUNCATION + EMPTY-CONTENT GUARD, and the rendered-prompt
 * capture that rides through the same chokepoint.
 *
 * WHAT WENT WRONG WITHOUT IT (both verified against the code this suite
 * replaces, and pinned below so a regression names itself):
 *
 *  - POINTWISE misclassified truncation as RETRYABLE. A response cut off at
 *    `max_tokens` reached `parseJudgmentResponse`, whose JSON.parse guard
 *    throws a PLAIN `Error`. `classify()` (errors.ts) keys only off
 *    structural signals — no `.status`, not an abort, no node `code` — so an
 *    unrecognized plain Error falls through to its `retryable` default. A
 *    deterministic, will-never-succeed failure therefore burned all 3
 *    attempts, DLQ'd, and recorded a breaker failure against a circuit
 *    shared with every healthy call on the same endpoint+model.
 *  - RESPOND mode persisted it as a SUCCESS. `executeRespondCall` returns
 *    `raw.text.trim()`, and `persistRespondSuccess` writes
 *    `status: 'completed'` — so a judgment whose generation was chopped in
 *    half (or was empty entirely) was indistinguishable in the corpus from
 *    one the model actually finished.
 *  - PAIRWISE was the only path that failed loudly, and only by accident:
 *    the truncated text carried no parseable verdict.
 *
 * The guard lives in `execute()` — after the backend call, before any parse
 * — so all three paths get it from one place.
 */
const { openaiCreateMock, anthropicCreateMock, judgmentUpdateMock } = vi.hoisted(() => ({
  openaiCreateMock: vi.fn(),
  anthropicCreateMock: vi.fn(),
  judgmentUpdateMock: vi.fn(),
}));

class FakeSdkError extends Error {}

vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(() => ({
    chat: { completions: { create: openaiCreateMock } },
  })),
  APIConnectionError: FakeSdkError,
  APIUserAbortError: FakeSdkError,
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: anthropicCreateMock },
  })),
  APIConnectionError: FakeSdkError,
  APIUserAbortError: FakeSdkError,
}));

// The consumer's error-persist path writes through this one call. Faked so
// the write is observable without a live DB — the reason a whole evidence
// spread could previously be deleted with the suite still green.
vi.mock('@/lib/db', () => ({ prisma: { modelJudgment: { update: judgmentUpdateMock } } }));

const { execute, getDescriptor, prepareJudgmentCall, executeJudgmentCall, executePairwiseCall, prepareRespondCall, executeRespondCall } =
  await import('@/lib/llm/registry');
const { classify } = await import('@/lib/llm/errors');
const { commonSuccessUpdateData, markJudgmentError } = await import('@/worker/judgment-consumer');

const baseVllmCall = {
  apiKey: 'sk-vllm-test',
  baseUrl: 'http://vllm.internal:8000/v1',
  modelId: 'qwen3-32b',
  systemPrompt: 'system',
  userPrompt: 'user',
  samplingParams: { temperature: 0.3, max_tokens: 300 },
  mode: 'judgment' as const,
};

const judgeVersion = {
  servingBackend: 'vllm' as const,
  samplingDefaults: { temperature: 0.3, max_tokens: 300 },
  judgeModel: { baseModel: 'qwen3-32b', slug: 'qwen-judge' },
};
const endpoint = { apiKeyEnc: 'sk-vllm-test', endpoint: 'http://vllm.internal:8000/v1' };

const pointwiseInput = {
  judgeVersion,
  endpoint,
  template: { body: 'Rubric: ${rubricName}', protocol: 'pointwise' as const },
  rubric: {
    name: 'R',
    description: undefined,
    criteria: [{ id: 'c1', rubricId: 'r1', name: 'Accuracy', description: 'd', maxScore: 10, weight: 1, order: 0 }],
  },
  submission: { inputText: 'q', responseText: 'a' },
};

const pairwiseInput = {
  ...pointwiseInput,
  template: { body: 'Rubric: ${rubricName}', protocol: 'pairwise' as const },
  submission: {
    inputText: 'q',
    candidates: [
      { position: 0, promptText: null, responseText: 'Paris.', label: null },
      { position: 1, promptText: null, responseText: 'Lyon.', label: null },
    ],
  },
};

/** The live-proven truncated shape: content EMPTY, 1164 chars of
 * reasoning_content, finish_reason 'length', at max_tokens 300. */
function truncatedResponse(content = '') {
  return {
    model: 'qwen3-32b',
    choices: [
      {
        message: { role: 'assistant', content, reasoning_content: 'x'.repeat(1164) },
        finish_reason: 'length',
      },
    ],
    usage: { prompt_tokens: 900, completion_tokens: 300, completion_tokens_details: { reasoning_tokens: 300 } },
  };
}

beforeEach(() => {
  openaiCreateMock.mockReset();
  anthropicCreateMock.mockReset();
  judgmentUpdateMock.mockReset();
});

// ─── finish_reason 'length' ─────────────────────────────────────────────────

describe('execute(): finish_reason "length" is a non_retryable failure', () => {
  it('throws a ProviderError naming max_tokens, the completion/reasoning split, and the content length', async () => {
    openaiCreateMock.mockResolvedValue(truncatedResponse());

    const error = await execute(getDescriptor('vllm'), baseVllmCall).catch((e) => e);

    expect(error).toMatchObject({ name: 'ProviderError', kind: 'non_retryable' });
    expect(error.message).toContain('max_tokens 300');
    expect(error.message).toContain('completion_tokens 300');
    expect(error.message).toContain('reasoning_tokens 300');
    expect(error.message).toContain('content length 0');
    // The operator has exactly one lever, and the message must name it.
    expect(error.message).toContain('samplingDefaults.max_tokens');
    expect(error.message).toContain('JudgeModelVersion');
  });

  it('is non_retryable because re-asking is deterministic waste, not a health signal', async () => {
    openaiCreateMock.mockResolvedValue(truncatedResponse());

    const error = await execute(getDescriptor('vllm'), baseVllmCall).catch((e) => e);

    // classify() returns an existing ProviderError untouched, so the
    // consumer's disposition sees `non_retryable` and marks the judgment
    // error immediately instead of burning 3 attempts and DLQ'ing.
    expect(classify(error, 'vllm').kind).toBe('non_retryable');
  });

  it('carries the callResult, so a failure still records what came back', async () => {
    openaiCreateMock.mockResolvedValue(truncatedResponse());

    const error = await execute(getDescriptor('vllm'), baseVllmCall).catch((e) => e);

    expect(error.callResult).toMatchObject({
      text: '',
      finishReason: 'length',
      reasoningSource: 'reasoning_content',
      reasoningTokens: 300,
      outputTokens: 300,
      systemPrompt: 'system',
      userPrompt: 'user',
    });
    expect(error.callResult.reasoningText).toHaveLength(1164);
  });

  it('fails UNCONDITIONALLY on "length", even when the content happens to parse', async () => {
    // A model cut off mid-reasoning is not a completed judgment for a
    // calibration corpus, however lucky the JSON prefix looks.
    openaiCreateMock.mockResolvedValue(truncatedResponse('{"verdict":"A","reasoning":"r"}'));

    await expect(executePairwiseCall(prepareJudgmentCall(pairwiseInput))).rejects.toMatchObject({
      kind: 'non_retryable',
      message: expect.stringContaining('max_tokens'),
    });
  });

  it('covers Anthropic\'s stop_reason "max_tokens" spelling too', async () => {
    anthropicCreateMock.mockResolvedValue({
      model: 'claude-sonnet-4-5',
      content: [{ type: 'text', text: 'half an ans', citations: null }],
      stop_reason: 'max_tokens',
      usage: { input_tokens: 10, output_tokens: 300 },
    });

    await expect(
      execute(getDescriptor('anthropic'), { ...baseVllmCall, baseUrl: undefined, modelId: 'claude-sonnet-4-5' })
    ).rejects.toMatchObject({ kind: 'non_retryable', message: expect.stringContaining('max_tokens 300') });
  });
});

// ─── empty content at finish_reason 'stop' ──────────────────────────────────

describe('execute(): an empty content channel is a failure even at finish_reason "stop"', () => {
  it('throws the same non_retryable shape when the model spent everything on reasoning', async () => {
    openaiCreateMock.mockResolvedValue({
      model: 'qwen3-32b',
      choices: [{ message: { role: 'assistant', content: '', reasoning_content: 'y'.repeat(762) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 900, completion_tokens: 762, completion_tokens_details: { reasoning_tokens: 762 } },
    });

    const error = await execute(getDescriptor('vllm'), { ...baseVllmCall, samplingParams: { temperature: 0.3, max_tokens: 2000 } }).catch(
      (e) => e
    );

    expect(error).toMatchObject({ name: 'ProviderError', kind: 'non_retryable' });
    expect(error.message).toContain('max_tokens 2000');
    expect(error.message).toContain('reasoning_tokens 762');
    expect(error.message).toContain('content length 0');
    expect(error.callResult.reasoningText).toHaveLength(762);
  });

  it('treats a whitespace-only content channel as empty', async () => {
    openaiCreateMock.mockResolvedValue({
      model: 'qwen3-32b',
      choices: [{ message: { role: 'assistant', content: '   \n\t ' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 3 },
    });

    await expect(execute(getDescriptor('vllm'), baseVllmCall)).rejects.toMatchObject({ kind: 'non_retryable' });
  });

  it('leaves a healthy call completely alone', async () => {
    openaiCreateMock.mockResolvedValue({
      model: 'qwen3-32b',
      choices: [{ message: { role: 'assistant', content: '{"verdict":"A","reasoning":"r"}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 3 },
    });

    const result = await execute(getDescriptor('vllm'), baseVllmCall);
    expect(result.text).toBe('{"verdict":"A","reasoning":"r"}');
  });

  it('does NOT guard a call with no mode — verify.ts\'s connection test sends max_tokens 1 on purpose', async () => {
    // POST /api/models/[id]/verify asks for exactly one token and reads only
    // `servedModelId`; guarding it would make every "test connection" click
    // fail with a truncation error against a perfectly healthy endpoint.
    openaiCreateMock.mockResolvedValue({
      model: 'qwen3-32b',
      choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'length' }],
      usage: { prompt_tokens: 5, completion_tokens: 1 },
    });

    const result = await execute(getDescriptor('vllm'), {
      apiKey: 'k',
      baseUrl: 'http://vllm.internal:8000/v1',
      modelId: 'qwen3-32b',
      systemPrompt: 'Connection test. Reply with ok.',
      userPrompt: 'ok',
      samplingParams: { temperature: 0, max_tokens: 1 },
    });

    expect(result.servedModelId).toBe('qwen3-32b');
  });
});

// ─── what each protocol did before the guard ────────────────────────────────

describe('the three call paths, before and after', () => {
  it('POINTWISE: the parse failure it used to produce classifies as RETRYABLE — which is why the guard must precede the parse', async () => {
    // Pinning the old disposition, not the old code path: this is the exact
    // Error `parseJudgmentResponse` throws, and `classify` is the exact
    // function the consumer runs on it.
    const parseFailure = new Error(
      'Failed to parse LLM judgment response as JSON: Unexpected end of JSON input. Response preview: {"overallScore": 8, "criter'
    );
    expect(classify(parseFailure, 'vllm').kind).toBe('retryable');

    openaiCreateMock.mockResolvedValue(truncatedResponse('{"overallScore": 8, "criter'));
    await expect(executeJudgmentCall(prepareJudgmentCall(pointwiseInput))).rejects.toMatchObject({
      kind: 'non_retryable',
    });
  });

  it('RESPOND: a truncated generation now throws instead of persisting status "completed"', async () => {
    // What the old path did with the very same response, spelled out: the
    // shared persist helper stamps 'completed' on whatever it is handed.
    expect(
      commonSuccessUpdateData(
        { rawResponse: '', latencyMs: 1 },
        { samplingDefaults: null, reasoningMode: 'none' } as never
      ).status
    ).toBe('completed');

    openaiCreateMock.mockResolvedValue(truncatedResponse());

    await expect(
      executeRespondCall(prepareRespondCall({ judgeVersion, endpoint, submission: { promptText: 'write an essay' } }))
    ).rejects.toMatchObject({ kind: 'non_retryable', message: expect.stringContaining('samplingDefaults.max_tokens') });
  });
});

// ─── the rendered prompt rides through the same chokepoint ──────────────────

describe('execute(): the rendered prompt is captured, hashed, and capped', () => {
  it('carries systemPrompt/userPrompt and a sha256 of the FULL user prompt', async () => {
    openaiCreateMock.mockResolvedValue({
      model: 'qwen3-32b',
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });

    const result = await execute(getDescriptor('vllm'), { ...baseVllmCall, userPrompt: 'the rendered user prompt' });

    expect(result.systemPrompt).toBe('system');
    expect(result.userPrompt).toBe('the rendered user prompt');
    expect(result.userPromptSha256).toBe(
      createHash('sha256').update('the rendered user prompt', 'utf8').digest('hex')
    );
    expect(result.promptTruncated).toBe(false);
  });

  it('caps the STORED user prompt at 32 KiB but hashes the pre-truncation original', async () => {
    openaiCreateMock.mockResolvedValue({
      model: 'qwen3-32b',
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });

    const huge = 'a'.repeat(40_000);
    const result = await execute(getDescriptor('vllm'), { ...baseVllmCall, userPrompt: huge });

    expect(result.userPrompt).toHaveLength(32 * 1024);
    expect(result.promptTruncated).toBe(true);
    // The hash is the whole point: it still identifies the exact prompt the
    // model saw even though the stored copy is clipped.
    expect(result.userPromptSha256).toBe(createHash('sha256').update(huge, 'utf8').digest('hex'));
  });

  it('never cuts a multi-byte character in half at the 32 KiB boundary', async () => {
    openaiCreateMock.mockResolvedValue({
      model: 'qwen3-32b',
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });

    // 3-byte characters do not divide 32768 evenly, so a naive byte slice
    // lands mid-sequence and decodes to U+FFFD.
    const result = await execute(getDescriptor('vllm'), { ...baseVllmCall, userPrompt: '漢'.repeat(20_000) });

    expect(result.promptTruncated).toBe(true);
    expect(result.userPrompt).not.toContain('�');
    expect(Buffer.byteLength(result.userPrompt!, 'utf8')).toBeLessThanOrEqual(32 * 1024);
  });
});

// ─── every seam, not just the one that happened to get a test ───────────────

/**
 * `CallCaptureFields` being `extends`ed by all three result types does NOT
 * make the capture reach all three: every field on it is optional, so
 * deleting `...callCaptureFields(raw)` from a seam type-checks. Proven by
 * injection during review — dropping that spread from the judge seam, and
 * separately from the respond seam, left all 726 tests green because the
 * only assertion on it lived on the pairwise path. These are the two
 * missing halves.
 */
describe('the capture fields reach the judge and respond seams too', () => {
  const reasoningResponse = (content: string) => ({
    model: 'qwen3-32b',
    choices: [
      { message: { role: 'assistant', content, reasoning_content: 'deliberation' }, finish_reason: 'stop' },
    ],
    usage: { prompt_tokens: 900, completion_tokens: 20, completion_tokens_details: { reasoning_tokens: 12 } },
  });

  it('POINTWISE: executeJudgmentCall carries the reasoning channel and the rendered prompt', async () => {
    openaiCreateMock.mockResolvedValue(
      reasoningResponse(
        JSON.stringify({
          overallScore: 8,
          reasoning: 'r',
          criteriaScores: [{ criterionId: 'c1', criterionName: 'Accuracy', score: 8 }],
        })
      )
    );

    const prepared = prepareJudgmentCall(pointwiseInput);
    const result = await executeJudgmentCall(prepared);

    expect(result.reasoningContent).toBe('deliberation');
    expect(result.reasoningSource).toBe('reasoning_content');
    expect(result.reasoningTokens).toBe(12);
    expect(result.systemPrompt).toBe(prepared.systemPrompt);
    expect(result.userPrompt).toBe(prepared.userPrompt);
    expect(result.userPromptSha256).toBe(createHash('sha256').update(prepared.userPrompt, 'utf8').digest('hex'));
    expect(result.promptTruncated).toBe(false);
    // The parsed rationale stays its own field — the thinking channel is
    // never merged into it.
    expect(result.reasoning).toBe('r');
  });

  it('RESPOND: executeRespondCall carries them as well', async () => {
    openaiCreateMock.mockResolvedValue(reasoningResponse('a finished essay'));

    const prepared = prepareRespondCall({ judgeVersion, endpoint, submission: { promptText: 'write an essay' } });
    const result = await executeRespondCall(prepared);

    expect(result.reasoningContent).toBe('deliberation');
    expect(result.reasoningSource).toBe('reasoning_content');
    expect(result.reasoningTokens).toBe(12);
    expect(result.systemPrompt).toBe(prepared.systemPrompt);
    expect(result.userPrompt).toBe(prepared.userPrompt);
    expect(result.userPromptSha256).toBe(createHash('sha256').update(prepared.userPrompt, 'utf8').digest('hex'));
    // Respond mode puts the generated text in `reasoning` downstream, which
    // is exactly why the thinking channel must not be folded into it.
    expect(result.responseText).toBe('a finished essay');
  });
});

// ─── the failure row keeps the evidence ─────────────────────────────────────

describe('markJudgmentError persists what came back, not just the message', () => {
  it('writes the response, the token split, the reasoning channel and the prompt off error.callResult', async () => {
    openaiCreateMock.mockResolvedValue(truncatedResponse());

    const error = await execute(getDescriptor('vllm'), baseVllmCall).catch((e) => e);
    await markJudgmentError('judgment-1', error.message, error.callResult);

    expect(judgmentUpdateMock).toHaveBeenCalledTimes(1);
    const { where, data } = judgmentUpdateMock.mock.calls[0][0];
    expect(where).toEqual({ id: 'judgment-1' });
    expect(data).toMatchObject({
      status: 'error',
      rawResponse: '',
      finishReason: 'length',
      inputTokens: 900,
      outputTokens: 300,
      tokenCount: 1200,
      reasoningContent: 'x'.repeat(1164),
      reasoningSource: 'reasoning_content',
      reasoningTokens: 300,
      systemPrompt: 'system',
      userPrompt: 'user',
      userPromptSha256: createHash('sha256').update('user', 'utf8').digest('hex'),
      promptTruncated: false,
    });
    expect(data.error).toContain('max_tokens 300');
  });

  it('writes ONLY status+error when there was no response to carry, never undefined over an existing column', async () => {
    // Every configuration/transport failure lands here. An `undefined`
    // spread into a Prisma update is a no-op, but a `null` one would blank
    // a column, so the shape matters: nothing else may appear.
    await markJudgmentError('judgment-2', 'No active ModelEndpoint configured');

    expect(judgmentUpdateMock).toHaveBeenCalledWith({
      where: { id: 'judgment-2' },
      data: { status: 'error', error: 'No active ModelEndpoint configured' },
    });
  });
});

// ─── Moved here from tests/lib/calibration-latency.test.ts ─────────────────
// These assert runtime capture on the FAILURE path, which needs
// `markJudgmentError` from @/worker/judgment-consumer. That import pulls the
// consumer's whole graph — including @/lib/realtime/** at 16% — into the unit
// coverage denominator, and it dropped the realtime branch floor below its
// threshold from a file that otherwise imports nothing but pure functions.
// This file ALREADY imports the consumer, so the assertions live here for
// free and calibration-latency.test.ts stays pure. Same reasoning as the
// health.ts extraction: keep the heavy import in one place rather than
// lowering a floor to accommodate a second.
describe('markJudgmentError records the runtime of the attempt that failed', () => {
  beforeEach(() => {
    judgmentUpdateMock.mockReset();
    judgmentUpdateMock.mockResolvedValue({});
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-01T12:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('derives latencyMs from the claim timestamp when the failure carried no response', async () => {
    // THE CASE THAT MATTERS. A timeout throws a ProviderError with NO
    // `callResult` — `execute()`'s `controller.signal.aborted` arm in
    // src/lib/llm/registry.ts has no response to attach — so before this, the
    // row that burned the full budget was the one row in the corpus with no
    // runtime on it. The judgment whose time-to-compute you most want to know
    // is exactly the one that timed out.
    const startedAt = new Date(Date.now() - 900_000);
    await markJudgmentError('j-timeout', 'Provider call timed out after 900000ms', undefined, startedAt);

    expect(judgmentUpdateMock).toHaveBeenCalledTimes(1);
    const { data } = judgmentUpdateMock.mock.calls[0][0];
    expect(data.status).toBe('error');
    expect(data.latencyMs).toBe(900_000);
  });

  it('prefers the provider-measured latency over the derived one when there is a response', async () => {
    // `callResult.latencyMs` is measured around the HTTP call itself
    // (src/lib/llm/openai-compatible.ts:249); the claim-to-now elapsed also
    // contains gate waiting and context loading. The measured one wins.
    const startedAt = new Date(Date.now() - 900_000);
    await markJudgmentError(
      'j-truncated',
      'was CUT OFF at the token budget',
      { text: '', latencyMs: 22_500 } as never,
      startedAt
    );

    expect(judgmentUpdateMock.mock.calls[0][0].data.latencyMs).toBe(22_500);
  });

  it('writes ONLY status+error when no provider call was ever made', async () => {
    // The configuration guards (no rubric, no endpoint, no prompt template)
    // fail before anything is dispatched. Stamping a 3ms "time to compute" on
    // those would put rows in the runtime corpus that measure nothing but how
    // fast Postgres answered — and `undefined` must never be spread over an
    // existing column. Matches the contract
    // tests/lib/llm-truncation.test.ts:445 already pins.
    await markJudgmentError('j-config', 'No active ModelEndpoint configured');

    expect(judgmentUpdateMock).toHaveBeenCalledWith({
      where: { id: 'j-config' },
      data: { status: 'error', error: 'No active ModelEndpoint configured' },
    });
  });

  it('clamps a skewed clock to zero rather than writing a negative runtime', async () => {
    await markJudgmentError('j-skew', 'boom', undefined, new Date(Date.now() + 5_000));
    expect(judgmentUpdateMock.mock.calls[0][0].data.latencyMs).toBe(0);
  });
});
