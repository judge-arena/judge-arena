import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InitialBudgetAlert } from '@/lib/llm/timeout-policy';

/**
 * MANDATORY carry from Task 8's review: `EVALUATION_MODEL_TIMEOUT_MS` used
 * to be read into `LEASE_MS`/deadline math (`src/worker/claim.ts`,
 * `run-launch.ts`, `run-create-consumer.ts`) but never actually bounded a
 * live provider HTTP call — a hung request could occupy a worker slot
 * indefinitely. `registry.ts`'s `execute()` now wires it into a real
 * `AbortController`, threaded as `{ signal }` into the underlying SDK
 * `.create()` call by `anthropic.ts`/`openai-compatible.ts`.
 *
 * That budget is now the INITIAL budget of a two-stage escalation
 * (`src/lib/llm/timeout-policy.ts`): reaching it ALERTS, and the separate
 * `EVALUATION_MODEL_HARD_CAP_MS` is what aborts. Every test below therefore
 * sets BOTH — a test that set only the old variable would silently wait for
 * the 15-minute default hard cap, which is itself the strongest statement of
 * what changed.
 *
 * These tests mock the `@anthropic-ai/sdk`/`openai` packages' CLIENT
 * classes (not `anthropic.ts`/`openai-compatible.ts` themselves, and not a
 * transitive `node-fetch` — Vitest externalizes third-party node_modules
 * packages by default, so `vi.mock`ing a package two levels down a real
 * SDK's own dependency graph is unreliable; mocking the SDK's own public
 * client surface is the stable interception point). `callAnthropic`/
 * `callOpenAICompatible` run for REAL — this proves THEIR code correctly
 * threads `opts.signal` into `.create()`'s request options, and that
 * `execute()` correctly builds+aborts the `AbortController` at the
 * `EVALUATION_MODEL_TIMEOUT_MS` budget. The mocked `.create()` never
 * resolves/rejects on its own — the ONLY way it settles is via the
 * request's own AbortSignal firing, simulating a genuinely hung call.
 */
const { openaiCreateMock, anthropicCreateMock } = vi.hoisted(() => ({
  openaiCreateMock: vi.fn(),
  anthropicCreateMock: vi.fn(),
}));

vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(() => ({
    chat: { completions: { create: openaiCreateMock } },
  })),
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: anthropicCreateMock },
  })),
}));

const { execute, getDescriptor } = await import('@/lib/llm/registry');

/** Never resolves/rejects on its own — only settles once `opts.signal`
 * fires, simulating a truly hung upstream call. */
function hungCreate(_params: unknown, opts: { signal?: AbortSignal }): Promise<never> {
  return new Promise((_resolve, reject) => {
    opts?.signal?.addEventListener('abort', () => {
      const err = new Error('The operation was aborted.');
      err.name = 'AbortError';
      reject(err);
    });
  });
}

describe('registry.execute: the hard cap aborts a hung provider call (Task 8 review carry, escalated)', () => {
  const ORIGINAL_TIMEOUT_ENV = process.env.EVALUATION_MODEL_TIMEOUT_MS;
  const ORIGINAL_HARD_CAP_ENV = process.env.EVALUATION_MODEL_HARD_CAP_MS;

  beforeEach(() => {
    openaiCreateMock.mockReset();
    anthropicCreateMock.mockReset();
    // Initial budget == hard cap: this suite is about the ABORT, and keeping
    // them equal preserves these tests' original single-budget meaning.
    process.env.EVALUATION_MODEL_TIMEOUT_MS = '50';
    process.env.EVALUATION_MODEL_HARD_CAP_MS = '50';
  });

  afterEach(() => {
    if (ORIGINAL_TIMEOUT_ENV === undefined) delete process.env.EVALUATION_MODEL_TIMEOUT_MS;
    else process.env.EVALUATION_MODEL_TIMEOUT_MS = ORIGINAL_TIMEOUT_ENV;
    if (ORIGINAL_HARD_CAP_ENV === undefined) delete process.env.EVALUATION_MODEL_HARD_CAP_MS;
    else process.env.EVALUATION_MODEL_HARD_CAP_MS = ORIGINAL_HARD_CAP_ENV;
  });

  it('CRITICAL: a hung openai-compatible call aborts at the configured budget, classified as a retryable, timeout:true ProviderError', async () => {
    openaiCreateMock.mockImplementation(hungCreate);

    const start = Date.now();
    await expect(
      execute(getDescriptor('openai'), {
        apiKey: 'sk-test',
        modelId: 'gpt-4o',
        systemPrompt: 'system',
        userPrompt: 'user',
        samplingParams: { temperature: 0.3, max_tokens: 100 },
      })
    ).rejects.toMatchObject({ name: 'ProviderError', kind: 'retryable', timeout: true });
    const elapsed = Date.now() - start;

    // Bounded well above the 50ms budget to absorb CI jitter, but nowhere
    // near the 120000ms production default this would hang against if the
    // timeout were never actually wired to a real abort.
    expect(elapsed).toBeLessThan(2000);
    expect(openaiCreateMock).toHaveBeenCalledTimes(1);

    // Proves the signal genuinely reached the SDK call (not just a
    // same-tick rejection) — the second argument is real RequestOptions
    // carrying an AbortSignal.
    const [, options] = openaiCreateMock.mock.calls[0];
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.signal.aborted).toBe(true);
  }, 10000);

  it('a hung anthropic call aborts at the configured budget the same way', async () => {
    anthropicCreateMock.mockImplementation(hungCreate);

    await expect(
      execute(getDescriptor('anthropic'), {
        apiKey: 'sk-ant-test',
        modelId: 'claude-3-5-haiku',
        systemPrompt: 'system',
        userPrompt: 'user',
        samplingParams: { temperature: 0.3, max_tokens: 100 },
      })
    ).rejects.toMatchObject({ name: 'ProviderError', kind: 'retryable', timeout: true });

    expect(anthropicCreateMock).toHaveBeenCalledTimes(1);
    const [, options] = anthropicCreateMock.mock.calls[0];
    expect(options.signal.aborted).toBe(true);
  }, 10000);

  it('a call that completes well within the budget is NOT aborted, and the AbortSignal it received is still unfired', async () => {
    openaiCreateMock.mockImplementation(async (_params: unknown, opts: { signal?: AbortSignal }) => {
      expect(opts.signal?.aborted).toBe(false);
      return {
        model: 'gpt-4o',
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      };
    });

    const result = await execute(getDescriptor('openai'), {
      apiKey: 'sk-test',
      modelId: 'gpt-4o',
      systemPrompt: 'system',
      userPrompt: 'user',
      samplingParams: { temperature: 0.3, max_tokens: 100 },
    });

    expect(result.text).toBe('ok');
  });

  it('a non-timeout failure (e.g. a real 500) is NOT reclassified as a timeout — controller.signal.aborted stays false', async () => {
    openaiCreateMock.mockRejectedValue(Object.assign(new Error('server error'), { status: 500 }));

    await expect(
      execute(getDescriptor('openai'), {
        apiKey: 'sk-test',
        modelId: 'gpt-4o',
        systemPrompt: 'system',
        userPrompt: 'user',
        samplingParams: { temperature: 0.3, max_tokens: 100 },
      })
    ).rejects.toMatchObject({ status: 500 });
  });
});

/**
 * ─── The escalation, wired through registry.execute() ──────────────────────
 *
 * The owner's spec is that 5 minutes is a WARNING and 15 minutes is the
 * cutoff. Scaled down here (150ms / 700ms) so the boundaries are observable in
 * real time against the real `AbortController`; `tests/lib/timeout-policy.test.ts`
 * covers the same boundaries at the production numbers with fake timers.
 */
describe('registry.execute: the escalating timeout (initial budget alerts, hard cap aborts)', () => {
  const ORIGINAL_TIMEOUT_ENV = process.env.EVALUATION_MODEL_TIMEOUT_MS;
  const ORIGINAL_HARD_CAP_ENV = process.env.EVALUATION_MODEL_HARD_CAP_MS;

  const INITIAL_MS = 150;
  const HARD_CAP_MS = 700;

  beforeEach(() => {
    openaiCreateMock.mockReset();
    anthropicCreateMock.mockReset();
    process.env.EVALUATION_MODEL_TIMEOUT_MS = String(INITIAL_MS);
    process.env.EVALUATION_MODEL_HARD_CAP_MS = String(HARD_CAP_MS);
  });

  afterEach(() => {
    if (ORIGINAL_TIMEOUT_ENV === undefined) delete process.env.EVALUATION_MODEL_TIMEOUT_MS;
    else process.env.EVALUATION_MODEL_TIMEOUT_MS = ORIGINAL_TIMEOUT_ENV;
    if (ORIGINAL_HARD_CAP_ENV === undefined) delete process.env.EVALUATION_MODEL_HARD_CAP_MS;
    else process.env.EVALUATION_MODEL_HARD_CAP_MS = ORIGINAL_HARD_CAP_ENV;
  });

  function baseRequest() {
    return {
      apiKey: 'sk-test',
      modelId: 'qwen3-8b',
      systemPrompt: 'system',
      userPrompt: 'user',
      samplingParams: { temperature: 0.3, max_tokens: 100 },
    };
  }

  it('CRITICAL: reaching the initial budget ALERTS and lets the call keep running; the abort waits for the HARD CAP', async () => {
    openaiCreateMock.mockImplementation(hungCreate);

    const alerts: InitialBudgetAlert[] = [];
    let alertedAtMs = -1;
    const start = Date.now();

    await expect(
      execute(getDescriptor('openai'), {
        ...baseRequest(),
        onInitialBudgetElapsed: (alert) => {
          alertedAtMs = Date.now() - start;
          alerts.push(alert);
          // The signal must still be UNFIRED at the moment the alert fires:
          // that is the entire difference between this policy and the single
          // 5-minute timeout it replaces.
          expect(openaiCreateMock.mock.calls[0][1].signal.aborted).toBe(false);
        },
      })
    ).rejects.toMatchObject({ name: 'ProviderError', timeout: true });

    const elapsed = Date.now() - start;

    expect(alerts).toHaveLength(1);
    expect(alertedAtMs).toBeGreaterThanOrEqual(INITIAL_MS - 20);
    // THE INJECTION GUARD: if the abort were armed at the initial budget
    // instead of the hard cap, this call would have failed at ~150ms.
    expect(elapsed).toBeGreaterThan(INITIAL_MS * 2);
    expect(elapsed).toBeLessThan(5000);
  }, 15000);

  it('with NO baseline the alert carries the owner\'s CONFIRM MODEL ACCESS wording', async () => {
    openaiCreateMock.mockImplementation(hungCreate);
    const alerts: InitialBudgetAlert[] = [];

    await expect(
      execute(getDescriptor('openai'), {
        ...baseRequest(),
        judgeModelVersionId: 'jmv_1',
        onInitialBudgetElapsed: (alert) => alerts.push(alert),
      })
    ).rejects.toThrow();

    expect(alerts[0].kind).toBe('no_baseline');
    expect(alerts[0].message).toContain('CONFIRM MODEL ACCESS');
    expect(alerts[0].judgeModelVersionId).toBe('jmv_1');
    expect(alerts[0].hardCapMs).toBe(HARD_CAP_MS);
  }, 15000);

  it('with a baseline the alert says how far past the observed average the call is', async () => {
    openaiCreateMock.mockImplementation(hungCreate);
    const alerts: InitialBudgetAlert[] = [];

    await expect(
      execute(getDescriptor('openai'), {
        ...baseRequest(),
        latencyBaseline: { count: 12, meanMs: 50, p50Ms: 45, p90Ms: 70, maxMs: 90 },
        onInitialBudgetElapsed: (alert) => alerts.push(alert),
      })
    ).rejects.toThrow();

    expect(alerts[0].kind).toBe('over_baseline');
    expect(alerts[0].multipleOfMean).toBeCloseTo(3, 5);
    expect(alerts[0].message).toContain('3.0x');
  }, 15000);

  it('a call that finishes before the initial budget raises no alert at all', async () => {
    openaiCreateMock.mockImplementation(async () => ({
      model: 'qwen3-8b',
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }));

    const alerts: InitialBudgetAlert[] = [];
    const result = await execute(getDescriptor('openai'), {
      ...baseRequest(),
      onInitialBudgetElapsed: (alert) => alerts.push(alert),
    });

    expect(result.text).toBe('ok');
    expect(alerts).toHaveLength(0);
  });

  it('an alert sink that throws does not kill the still-healthy call', async () => {
    // The alert is advisory; the call is the work.
    openaiCreateMock.mockImplementation(hungCreate);

    await expect(
      execute(getDescriptor('openai'), {
        ...baseRequest(),
        onInitialBudgetElapsed: () => {
          throw new Error('sink exploded');
        },
      })
    ).rejects.toMatchObject({ name: 'ProviderError', timeout: true });
  }, 15000);
});

describe('registry.execute: two 15-minute attempts, then exit', () => {
  const ORIGINAL_TIMEOUT_ENV = process.env.EVALUATION_MODEL_TIMEOUT_MS;
  const ORIGINAL_HARD_CAP_ENV = process.env.EVALUATION_MODEL_HARD_CAP_MS;

  beforeEach(() => {
    openaiCreateMock.mockReset();
    openaiCreateMock.mockImplementation(hungCreate);
    process.env.EVALUATION_MODEL_TIMEOUT_MS = '30';
    process.env.EVALUATION_MODEL_HARD_CAP_MS = '30';
  });

  afterEach(() => {
    if (ORIGINAL_TIMEOUT_ENV === undefined) delete process.env.EVALUATION_MODEL_TIMEOUT_MS;
    else process.env.EVALUATION_MODEL_TIMEOUT_MS = ORIGINAL_TIMEOUT_ENV;
    if (ORIGINAL_HARD_CAP_ENV === undefined) delete process.env.EVALUATION_MODEL_HARD_CAP_MS;
    else process.env.EVALUATION_MODEL_HARD_CAP_MS = ORIGINAL_HARD_CAP_ENV;
  });

  const request = {
    apiKey: 'sk-test',
    modelId: 'qwen3-8b',
    systemPrompt: 'system',
    userPrompt: 'user',
    samplingParams: { temperature: 0.3, max_tokens: 100 },
  };

  it('CRITICAL: attempt 1 is retryable — judgment-consumer.ts sends it round for its second 15-minute attempt', async () => {
    await expect(execute(getDescriptor('openai'), { ...request, attempt: 1 })).rejects.toMatchObject({
      kind: 'retryable',
      timeout: true,
      attempt: 1,
    });
  }, 10000);

  it('CRITICAL: attempt 2 is non_retryable — no third attempt, and non_retryable returns before the DLQ branch', async () => {
    await expect(execute(getDescriptor('openai'), { ...request, attempt: 2 })).rejects.toMatchObject({
      kind: 'non_retryable',
      timeout: true,
      attempt: 2,
    });
  }, 10000);

  it('an omitted attempt is treated as the first, never as a give-up', async () => {
    await expect(execute(getDescriptor('openai'), request)).rejects.toMatchObject({ kind: 'retryable' });
  }, 10000);

  it('the message names the cap and the attempt, so a judgment row explains itself', async () => {
    await expect(execute(getDescriptor('openai'), { ...request, attempt: 2 })).rejects.toThrow(
      /hit the 30ms hard cap on attempt 2/
    );
  }, 10000);
});
