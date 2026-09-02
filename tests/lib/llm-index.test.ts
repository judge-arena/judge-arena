import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `errors.ts`, `breaker-redis.ts`, and `resilience.ts` each have their own
// dedicated test coverage (tests/lib/llm-errors.test.ts,
// tests/lib/breaker-redis.test.ts + tests/integration/breaker.test.ts,
// tests/lib/resilience.test.ts). `registry.ts`'s own dispatch logic
// (descriptor lookups, key resolution, rendering, timeout, and the
// prepare/execute split itself) has its own coverage too
// (tests/lib/registry.test.ts, tests/lib/render.test.ts,
// tests/lib/llm-timeout.test.ts, tests/lib/llm-parse.test.ts). This file
// covers ONLY the glue in `llm/index.ts` that wires registry.ts's
// `executeJudgmentCall`/`executeRespondCall` (the NETWORK half — the only
// half `index.ts` wraps with resilience; `prepareJudgmentCall`/
// `prepareRespondCall` run for real, unmocked, deliberately OUTSIDE the
// breaker — see index.ts's module doc) to the breaker + retry: breaker key
// computation, fail-fast on open, exactly one breaker outcome per call
// (not per retry attempt), the half-open-probe single-attempt rule, and —
// the Task 10 review fix this file specifically regression-tests — that a
// `prepare*Call` config failure (no API key resolvable) throws BEFORE ever
// touching the breaker at all.
const { executeJudgmentCallMock, executeRespondCallMock, allowMock, onSuccessMock, onFailureMock, getBreakerMock } =
  vi.hoisted(() => ({
    executeJudgmentCallMock: vi.fn(),
    executeRespondCallMock: vi.fn(),
    allowMock: vi.fn(),
    onSuccessMock: vi.fn(),
    onFailureMock: vi.fn(),
    getBreakerMock: vi.fn(),
  }));

vi.mock('@/lib/llm/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/llm/registry')>();
  return {
    ...actual,
    executeJudgmentCall: executeJudgmentCallMock,
    executeRespondCall: executeRespondCallMock,
  };
});

vi.mock('@/lib/llm/breaker-redis', () => ({
  getBreaker: getBreakerMock,
}));

const { executeJudgment, executeRespond } = await import('@/lib/llm');
import type { RunProviderJudgmentInput, RunProviderResponseInput } from '@/lib/llm';
// The real class, not a mock: `classify()` passes a ProviderError through by
// identity (errors.ts:146) and `withRetry` rethrows the same object, so the
// U3 tests below can assert `rejects.toBe(theErrorWeThrew)`.
import { ProviderError } from '@/lib/llm/errors';

const baseJudgeVersion = {
  servingBackend: 'anthropic' as const,
  samplingDefaults: null,
  judgeModel: { baseModel: 'claude-3-5-haiku', slug: 'claude-3-5-haiku-judge' },
};

// A per-endpoint key is required for `prepareJudgmentCall`/`prepareRespondCall`
// (which run for REAL in this file, unmocked) to succeed — without one,
// `requireApiKey` throws before `executeJudgment`/`executeRespond` ever
// reach the breaker at all, which is exactly what the dedicated test below
// asserts on for the no-key case.
const baseEndpoint = { endpoint: null, apiKeyEnc: 'sk-test-key' };

const baseJudgmentInput: RunProviderJudgmentInput = {
  judgeVersion: baseJudgeVersion,
  endpoint: baseEndpoint,
  template: { body: 'system prompt', protocol: 'pointwise' as const },
  rubric: { name: 'Test rubric', description: undefined, criteria: [] },
  submission: { responseText: 'hello' },
};

const baseRespondInput: RunProviderResponseInput = {
  judgeVersion: baseJudgeVersion,
  endpoint: baseEndpoint,
  submission: { promptText: 'hello' },
};

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

  it('computes the breaker key as servingBackend:endpoint-or-default:baseModel (aggregator granularity)', async () => {
    executeJudgmentCallMock.mockResolvedValue({
      overallScore: 1,
      reasoning: '',
      criteriaScores: [],
      rawResponse: '',
      latencyMs: 1,
      parseMode: 'fallback',
      samplingParamsUsed: { temperature: 0.3, max_tokens: 4096 },
    });

    await executeJudgment(baseJudgmentInput);
    expect(getBreakerMock).toHaveBeenCalledWith('anthropic:default:claude-3-5-haiku');

    getBreakerMock.mockClear();
    await executeJudgment({
      ...baseJudgmentInput,
      endpoint: { ...baseEndpoint, endpoint: 'https://custom.example.com' },
    });
    expect(getBreakerMock).toHaveBeenCalledWith('anthropic:https://custom.example.com:claude-3-5-haiku');
  });

  it('CRITICAL (Task 10 review fix): a prepare-phase config error (no resolvable API key) throws BEFORE the breaker is ever touched — not classified as a provider failure', async () => {
    await expect(
      executeJudgment({ ...baseJudgmentInput, endpoint: { endpoint: null, apiKeyEnc: null } })
    ).rejects.toMatchObject({
      name: 'ProviderError',
      kind: 'non_retryable',
    });

    expect(getBreakerMock).not.toHaveBeenCalled();
    expect(executeJudgmentCallMock).not.toHaveBeenCalled();
    expect(onFailureMock).not.toHaveBeenCalled();
  });

  it('fails fast without calling the provider (or touching onSuccess/onFailure) when the breaker is open', async () => {
    allowMock.mockResolvedValue('open');

    await expect(executeJudgment(baseJudgmentInput)).rejects.toMatchObject({
      name: 'ProviderError',
      kind: 'retryable',
      breakerOpen: true,
    });
    expect(executeJudgmentCallMock).not.toHaveBeenCalled();
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
      parseMode: 'fallback' as const,
      samplingParamsUsed: { temperature: 0.3, max_tokens: 4096 },
    };
    executeJudgmentCallMock.mockResolvedValue(response);

    await expect(executeJudgment(baseJudgmentInput)).resolves.toEqual(response);
    expect(onSuccessMock).toHaveBeenCalledTimes(1);
    expect(onFailureMock).not.toHaveBeenCalled();
  });

  it('classifies a raw provider error, retries transient failures, and records exactly one breaker failure for the whole retry sequence', async () => {
    vi.useFakeTimers();
    const err500 = Object.assign(new Error('oops'), { status: 500 });
    executeJudgmentCallMock.mockRejectedValue(err500);

    const promise = executeJudgment(baseJudgmentInput);
    promise.catch(() => {}); // swallow the eventual rejection before we assert on it below

    await vi.runAllTimersAsync();

    await expect(promise).rejects.toMatchObject({
      name: 'ProviderError',
      kind: 'retryable',
      status: 500,
      provider: 'anthropic',
    });
    expect(executeJudgmentCallMock).toHaveBeenCalledTimes(3); // default maxAttempts
    expect(onFailureMock).toHaveBeenCalledTimes(1); // one breaker failure, not three
  });

  it('does not retry a non_retryable classified error — single attempt, single breaker failure', async () => {
    const err400 = Object.assign(new Error('bad request'), { status: 400 });
    executeJudgmentCallMock.mockRejectedValue(err400);

    await expect(executeJudgment(baseJudgmentInput)).rejects.toMatchObject({
      kind: 'non_retryable',
    });
    expect(executeJudgmentCallMock).toHaveBeenCalledTimes(1);
    expect(onFailureMock).toHaveBeenCalledTimes(1);
  });

  it('U3: a timeout ProviderError (hard-cap abort, attempt 1, kind retryable) is NOT retried in-process — one call, one breaker failure, the same error propagates', async () => {
    // Fake timers so that if the implementation DOES retry, the failure is a
    // clean "called 3 times" rather than a 5 s test timeout spent in
    // withRetry's real backoff sleeps.
    vi.useFakeTimers();
    // Exactly what registry.ts's execute() throws when the 900 s hard cap
    // fires on a first delivery (registry.ts:845-856): kind is
    // hardCapAbortKind(1) === 'retryable', timeout: true, attempt: 1.
    const hardCap = new ProviderError(
      'Provider call to "llamacpp" (Qwen3.6-35B-A3B) hit the 900000ms hard cap on attempt 1 (initial budget 300000ms)',
      { kind: 'retryable', provider: 'llamacpp', timeout: true, attempt: 1 }
    );
    executeJudgmentCallMock.mockRejectedValue(hardCap);

    const promise = executeJudgment(baseJudgmentInput);
    promise.catch(() => {}); // swallow the eventual rejection before we assert on it below

    await vi.runAllTimersAsync();

    await expect(promise).rejects.toBe(hardCap);
    expect(executeJudgmentCallMock).toHaveBeenCalledTimes(1); // NOT withRetry's default 3
    expect(onFailureMock).toHaveBeenCalledTimes(1);
    expect(onSuccessMock).not.toHaveBeenCalled();
  });

  it('U3: a rate_limited ProviderError WITHOUT timeout keeps the full in-process retry budget', async () => {
    vi.useFakeTimers();
    const limited = new ProviderError('429 slow down', {
      kind: 'rate_limited',
      provider: 'llamacpp',
      status: 429,
    });
    executeJudgmentCallMock.mockRejectedValue(limited);

    const promise = executeJudgment(baseJudgmentInput);
    promise.catch(() => {});

    await vi.runAllTimersAsync();

    await expect(promise).rejects.toBe(limited);
    expect(executeJudgmentCallMock).toHaveBeenCalledTimes(3); // default maxAttempts, unchanged
    expect(onFailureMock).toHaveBeenCalledTimes(1);
  });

  it('U3: a raw AbortError — which classify() stamps timeout: true with no attempt (errors.ts isAbortOrTimeout) — also escapes after one call', async () => {
    vi.useFakeTimers();
    // NOT a ProviderError: this one goes through classify()'s isAbortOrTimeout
    // branch (errors.ts:176-184, :229), which yields kind 'retryable',
    // timeout: true and no `attempt`. It pins the "Consequence" paragraph
    // above — the predicate keys on the timeout flag alone, not on the
    // hard-cap shape — and is the only test that exercises the
    // classify()->timeout wiring rather than classify()'s identity short-circuit.
    const aborted = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    executeJudgmentCallMock.mockRejectedValue(aborted);

    const promise = executeJudgment(baseJudgmentInput);
    promise.catch(() => {});

    await vi.runAllTimersAsync();

    await expect(promise).rejects.toMatchObject({ name: 'ProviderError', kind: 'retryable', timeout: true, provider: 'anthropic' });
    expect(executeJudgmentCallMock).toHaveBeenCalledTimes(1);
    expect(onFailureMock).toHaveBeenCalledTimes(1);
  });

  it('a half-open probe gets exactly one attempt, even for an otherwise-retryable error', async () => {
    allowMock.mockResolvedValue('half_open_probe');
    const err500 = Object.assign(new Error('still down'), { status: 500 });
    executeJudgmentCallMock.mockRejectedValue(err500);

    await expect(executeJudgment(baseJudgmentInput)).rejects.toMatchObject({
      kind: 'retryable',
    });
    expect(executeJudgmentCallMock).toHaveBeenCalledTimes(1);
    expect(onFailureMock).toHaveBeenCalledTimes(1);
  });

  it('a successful half-open probe closes the breaker', async () => {
    allowMock.mockResolvedValue('half_open_probe');
    const response = {
      overallScore: 5,
      reasoning: '',
      criteriaScores: [],
      rawResponse: '',
      latencyMs: 1,
      parseMode: 'fallback' as const,
      samplingParamsUsed: { temperature: 0.3, max_tokens: 4096 },
    };
    executeJudgmentCallMock.mockResolvedValue(response);

    await expect(executeJudgment(baseJudgmentInput)).resolves.toEqual(response);
    expect(executeJudgmentCallMock).toHaveBeenCalledTimes(1);
    expect(onSuccessMock).toHaveBeenCalledTimes(1);
  });

  it('executeRespond goes through the same breaker + classification wiring', async () => {
    const response = {
      responseText: 'hi',
      rawResponse: 'hi',
      latencyMs: 1,
      samplingParamsUsed: { temperature: 0.4, max_tokens: 4096 },
    };
    executeRespondCallMock.mockResolvedValue(response);

    await expect(executeRespond(baseRespondInput)).resolves.toEqual(response);
    expect(onSuccessMock).toHaveBeenCalledTimes(1);
  });

  it('CRITICAL (Task 10 review fix): executeRespond also throws prepare-phase config errors before touching the breaker', async () => {
    await expect(
      executeRespond({ ...baseRespondInput, endpoint: { endpoint: null, apiKeyEnc: null } })
    ).rejects.toMatchObject({ name: 'ProviderError', kind: 'non_retryable' });

    expect(getBreakerMock).not.toHaveBeenCalled();
    expect(executeRespondCallMock).not.toHaveBeenCalled();
  });
});
