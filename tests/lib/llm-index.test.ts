import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `errors.ts`, `breaker-redis.ts`, and `resilience.ts` each have their own
// dedicated test coverage (tests/lib/llm-errors.test.ts,
// tests/lib/breaker-redis.test.ts + tests/integration/breaker.test.ts,
// tests/lib/resilience.test.ts). This file covers the glue in
// `llm/index.ts` that wires them together around `executeJudgment`/
// `executeRespond` — breaker key computation, fail-fast on open, exactly
// one breaker outcome per call (not per retry attempt), and the
// half-open-probe single-attempt rule — none of which is exercised by the
// piece-wise tests above.
const { judgeMock, respondMock, allowMock, onSuccessMock, onFailureMock, getBreakerMock } = vi.hoisted(() => ({
  judgeMock: vi.fn(),
  respondMock: vi.fn(),
  allowMock: vi.fn(),
  onSuccessMock: vi.fn(),
  onFailureMock: vi.fn(),
  getBreakerMock: vi.fn(),
}));

vi.mock('@/lib/llm/anthropic', () => ({
  AnthropicProvider: vi.fn().mockImplementation(() => ({
    name: 'Anthropic',
    judge: judgeMock,
    respond: respondMock,
  })),
}));

vi.mock('@/lib/llm/openai-compatible', () => ({
  OpenAICompatibleProvider: vi.fn().mockImplementation((name: string) => ({
    name,
    judge: judgeMock,
    respond: respondMock,
  })),
}));

vi.mock('@/lib/llm/breaker-redis', () => ({
  getBreaker: getBreakerMock,
}));

const { executeJudgment, executeRespond } = await import('@/lib/llm');

const baseRequest = {
  rubricCriteria: [],
  rubricName: 'Test rubric',
  responseText: 'hello',
};

const baseConfig = { modelId: 'claude-3-5-haiku' };

describe('llm/index: executeJudgment/executeRespond breaker + retry wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getBreakerMock.mockImplementation(() => ({
      allow: allowMock,
      onSuccess: onSuccessMock,
      onFailure: onFailureMock,
    }));
    allowMock.mockResolvedValue('closed');
    onSuccessMock.mockResolvedValue(undefined);
    onFailureMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('computes the breaker key as provider:endpoint-or-default:modelId (aggregator granularity)', async () => {
    judgeMock.mockResolvedValue({
      overallScore: 1,
      reasoning: '',
      criteriaScores: [],
      rawResponse: '',
      latencyMs: 1,
    });

    await executeJudgment('anthropic', baseRequest, baseConfig);
    expect(getBreakerMock).toHaveBeenCalledWith('anthropic:default:claude-3-5-haiku');

    getBreakerMock.mockClear();
    await executeJudgment('anthropic', baseRequest, {
      ...baseConfig,
      endpoint: 'https://custom.example.com',
    });
    expect(getBreakerMock).toHaveBeenCalledWith('anthropic:https://custom.example.com:claude-3-5-haiku');
  });

  it('fails fast without calling the provider (or touching onSuccess/onFailure) when the breaker is open', async () => {
    allowMock.mockResolvedValue('open');

    await expect(executeJudgment('anthropic', baseRequest, baseConfig)).rejects.toMatchObject({
      name: 'ProviderError',
      kind: 'retryable',
      breakerOpen: true,
    });
    expect(judgeMock).not.toHaveBeenCalled();
    expect(onSuccessMock).not.toHaveBeenCalled();
    expect(onFailureMock).not.toHaveBeenCalled();
  });

  it('records a success and returns the result when closed', async () => {
    const response = {
      overallScore: 8,
      reasoning: 'great',
      criteriaScores: [],
      rawResponse: '{}',
      latencyMs: 42,
    };
    judgeMock.mockResolvedValue(response);

    await expect(executeJudgment('anthropic', baseRequest, baseConfig)).resolves.toEqual(response);
    expect(onSuccessMock).toHaveBeenCalledTimes(1);
    expect(onFailureMock).not.toHaveBeenCalled();
  });

  it('classifies a raw provider error, retries transient failures, and records exactly one breaker failure for the whole retry sequence', async () => {
    vi.useFakeTimers();
    const err500 = Object.assign(new Error('oops'), { status: 500 });
    judgeMock.mockRejectedValue(err500);

    const promise = executeJudgment('anthropic', baseRequest, baseConfig);
    promise.catch(() => {}); // swallow the eventual rejection before we assert on it below

    await vi.runAllTimersAsync();

    await expect(promise).rejects.toMatchObject({
      name: 'ProviderError',
      kind: 'retryable',
      status: 500,
      provider: 'anthropic',
    });
    expect(judgeMock).toHaveBeenCalledTimes(3); // default maxAttempts
    expect(onFailureMock).toHaveBeenCalledTimes(1); // one breaker failure, not three
  });

  it('does not retry a non_retryable classified error — single attempt, single breaker failure', async () => {
    const err400 = Object.assign(new Error('bad request'), { status: 400 });
    judgeMock.mockRejectedValue(err400);

    await expect(executeJudgment('anthropic', baseRequest, baseConfig)).rejects.toMatchObject({
      kind: 'non_retryable',
    });
    expect(judgeMock).toHaveBeenCalledTimes(1);
    expect(onFailureMock).toHaveBeenCalledTimes(1);
  });

  it('a half-open probe gets exactly one attempt, even for an otherwise-retryable error', async () => {
    allowMock.mockResolvedValue('half_open_probe');
    const err500 = Object.assign(new Error('still down'), { status: 500 });
    judgeMock.mockRejectedValue(err500);

    await expect(executeJudgment('anthropic', baseRequest, baseConfig)).rejects.toMatchObject({
      kind: 'retryable',
    });
    expect(judgeMock).toHaveBeenCalledTimes(1);
    expect(onFailureMock).toHaveBeenCalledTimes(1);
  });

  it('a successful half-open probe closes the breaker', async () => {
    allowMock.mockResolvedValue('half_open_probe');
    const response = { overallScore: 5, reasoning: '', criteriaScores: [], rawResponse: '', latencyMs: 1 };
    judgeMock.mockResolvedValue(response);

    await expect(executeJudgment('anthropic', baseRequest, baseConfig)).resolves.toEqual(response);
    expect(judgeMock).toHaveBeenCalledTimes(1);
    expect(onSuccessMock).toHaveBeenCalledTimes(1);
  });

  it('executeRespond goes through the same breaker + classification wiring', async () => {
    const response = { responseText: 'hi', rawResponse: 'hi', latencyMs: 1 };
    respondMock.mockResolvedValue(response);

    await expect(
      executeRespond('anthropic', { promptText: 'hello' }, baseConfig)
    ).resolves.toEqual(response);
    expect(onSuccessMock).toHaveBeenCalledTimes(1);
  });
});
