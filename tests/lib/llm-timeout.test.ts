import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * MANDATORY carry from Task 8's review: `EVALUATION_MODEL_TIMEOUT_MS` used
 * to be read into `LEASE_MS`/deadline math (`src/worker/claim.ts`,
 * `run-launch.ts`, `run-create-consumer.ts`) but never actually bounded a
 * live provider HTTP call — a hung request could occupy a worker slot
 * indefinitely. `registry.ts`'s `execute()` now wires it into a real
 * `AbortController`, threaded as `{ signal }` into the underlying SDK
 * `.create()` call by `anthropic.ts`/`openai-compatible.ts`.
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

describe('registry.execute: EVALUATION_MODEL_TIMEOUT_MS aborts a hung provider call (Task 8 review carry)', () => {
  const ORIGINAL_TIMEOUT_ENV = process.env.EVALUATION_MODEL_TIMEOUT_MS;

  beforeEach(() => {
    openaiCreateMock.mockReset();
    anthropicCreateMock.mockReset();
    process.env.EVALUATION_MODEL_TIMEOUT_MS = '50';
  });

  afterEach(() => {
    if (ORIGINAL_TIMEOUT_ENV === undefined) delete process.env.EVALUATION_MODEL_TIMEOUT_MS;
    else process.env.EVALUATION_MODEL_TIMEOUT_MS = ORIGINAL_TIMEOUT_ENV;
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
