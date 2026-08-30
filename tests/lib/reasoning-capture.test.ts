import { describe, expect, it, vi } from 'vitest';

/**
 * A2.1 v2i — REASONING CHANNEL CAPTURE.
 *
 * The failure this suite exists to prevent: a reasoning-model judge does its
 * actual deliberation in a channel that is NOT `message.content`, and every
 * byte of it used to be dropped on the floor between the wire and the
 * `ModelJudgment` row. Proven live against the target judge: at
 * `max_tokens: 300` the response carried `content: ''` and 1164 characters of
 * `reasoning_content` with `finish_reason: 'length'`; at `max_tokens: 2000`
 * it carried 762 characters of `reasoning_content` and `{"verdict": "A"}` in
 * `content`. A calibration corpus that stores only the second field records
 * the verdict and none of the reasoning that produced it.
 *
 * Mocks the two SDK packages at the client-constructor level (the same
 * stable interception point tests/lib/backends.test.ts and
 * tests/lib/pairwise-execution.test.ts use) so the REAL `callOpenAICompatible`
 * / `callAnthropic` run — this proves the actual extraction, not a
 * re-implementation of it.
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

const { callOpenAICompatible, extractReasoningChannel } = await import('@/lib/llm/openai-compatible');
const { callAnthropic } = await import('@/lib/llm/anthropic');

const baseCall = {
  apiKey: 'sk-test',
  modelId: 'qwen3-32b',
  systemPrompt: 'system',
  userPrompt: 'user',
  samplingParams: { temperature: 0.3, max_tokens: 2000 },
  signal: new AbortController().signal,
};

// ─── extractReasoningChannel: the fixed key order ───────────────────────────

describe('extractReasoningChannel: fixed key order, and it records which key hit', () => {
  it('prefers reasoning_content over BOTH `reasoning` and a <think> tag', () => {
    expect(
      extractReasoningChannel({
        role: 'assistant',
        content: '<think>tag thinking</think>{"verdict":"A"}',
        reasoning_content: 'primary thinking',
        reasoning: 'secondary thinking',
      })
    ).toEqual({ text: 'primary thinking', source: 'reasoning_content' });
  });

  it('falls through to `reasoning` when reasoning_content is absent', () => {
    expect(
      extractReasoningChannel({ role: 'assistant', content: 'answer', reasoning: 'openrouter-style thinking' })
    ).toEqual({ text: 'openrouter-style thinking', source: 'reasoning' });
  });

  it('falls through to a <think> tag in content when neither key is present', () => {
    expect(
      extractReasoningChannel({ role: 'assistant', content: '<think>inline thinking</think>\n{"verdict":"B"}' })
    ).toEqual({ text: 'inline thinking', source: 'think_tag' });
  });

  it('captures an UNTERMINATED <think> — a model cut off mid-thought still deliberated', () => {
    expect(
      extractReasoningChannel({ role: 'assistant', content: '<think>cut off half way' })
    ).toEqual({ text: 'cut off half way', source: 'think_tag' });
  });

  it('returns undefined when there is no reasoning channel at all', () => {
    expect(extractReasoningChannel({ role: 'assistant', content: '{"verdict":"A"}' })).toBeUndefined();
  });

  it('treats a blank or non-string channel as absent rather than recording an empty source', () => {
    // A recorded `reasoningSource` that points at an empty string is worse
    // than none: it asserts the model reasoned there when it did not.
    expect(
      extractReasoningChannel({ role: 'assistant', content: 'x', reasoning_content: '   ', reasoning: 'real' })
    ).toEqual({ text: 'real', source: 'reasoning' });
    expect(
      extractReasoningChannel({ role: 'assistant', content: 'x', reasoning_content: 42, reasoning: 'real' })
    ).toEqual({ text: 'real', source: 'reasoning' });
  });

  it('is undefined-safe for a missing/non-object message', () => {
    expect(extractReasoningChannel(undefined)).toBeUndefined();
    expect(extractReasoningChannel(null)).toBeUndefined();
    expect(extractReasoningChannel('not a message')).toBeUndefined();
  });
});

// ─── callOpenAICompatible ───────────────────────────────────────────────────

describe('callOpenAICompatible: the reasoning channel reaches ProviderCallResult', () => {
  it('LIVE-PROVEN SHAPE: content empty + 1164 chars of reasoning_content at finish_reason "length"', async () => {
    const reasoning = 'x'.repeat(1164);
    openaiCreateMock.mockResolvedValue({
      model: 'qwen3-32b',
      choices: [{ message: { role: 'assistant', content: '', reasoning_content: reasoning }, finish_reason: 'length' }],
      usage: { prompt_tokens: 900, completion_tokens: 300, completion_tokens_details: { reasoning_tokens: 300 } },
    });

    const result = await callOpenAICompatible({ ...baseCall, samplingParams: { temperature: 0.3, max_tokens: 300 } });

    expect(result.text).toBe('');
    expect(result.reasoningText).toBe(reasoning);
    expect(result.reasoningSource).toBe('reasoning_content');
    expect(result.reasoningTokens).toBe(300);
    expect(result.finishReason).toBe('length');
  });

  it('reads usage.completion_tokens_details.reasoning_tokens (the completion/reasoning split)', async () => {
    openaiCreateMock.mockResolvedValue({
      model: 'qwen3-32b',
      choices: [{ message: { role: 'assistant', content: '{"verdict":"A"}', reasoning_content: 'r' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 900, completion_tokens: 780, completion_tokens_details: { reasoning_tokens: 762 } },
    });

    const result = await callOpenAICompatible(baseCall);

    expect(result.outputTokens).toBe(780);
    expect(result.reasoningTokens).toBe(762);
  });

  it('NEVER merges the reasoning channel into `text` — the two carry different content', async () => {
    openaiCreateMock.mockResolvedValue({
      model: 'qwen3-32b',
      choices: [
        { message: { role: 'assistant', content: '{"verdict":"A"}', reasoning_content: 'long deliberation' }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 2 },
    });

    const result = await callOpenAICompatible(baseCall);

    expect(result.text).toBe('{"verdict":"A"}');
    expect(result.text).not.toContain('long deliberation');
  });

  it('a <think>-tag model records source "think_tag" and leaves `text` verbatim', async () => {
    openaiCreateMock.mockResolvedValue({
      model: 'deepseek-r1',
      choices: [{ message: { role: 'assistant', content: '<think>weighing A vs B</think>{"verdict":"B"}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 2 },
    });

    const result = await callOpenAICompatible(baseCall);

    expect(result.reasoningText).toBe('weighing A vs B');
    expect(result.reasoningSource).toBe('think_tag');
    // rawResponse is persisted from `text` and is documented "never
    // truncated" — the tag stays exactly as the model emitted it.
    expect(result.text).toBe('<think>weighing A vs B</think>{"verdict":"B"}');
  });

  it('leaves every reasoning field undefined for a plain, non-reasoning model', async () => {
    openaiCreateMock.mockResolvedValue({
      model: 'gpt-4o',
      choices: [{ message: { role: 'assistant', content: '{"verdict":"A"}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 2 },
    });

    const result = await callOpenAICompatible(baseCall);

    expect(result.reasoningText).toBeUndefined();
    expect(result.reasoningSource).toBeUndefined();
    expect(result.reasoningTokens).toBeUndefined();
  });
});

// ─── callAnthropic: the content[0] bug ──────────────────────────────────────

describe('callAnthropic: finds the first TEXT block, not content[0]', () => {
  it('THE BUG: with a thinking block first, content[0] is not the answer', async () => {
    anthropicCreateMock.mockResolvedValue({
      model: 'claude-sonnet-4-5',
      content: [
        { type: 'thinking', thinking: 'Let me weigh the rubric criteria.', signature: 'sig' },
        { type: 'text', text: '{"overallScore": 8}', citations: null },
      ],
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 50 },
    });

    const result = await callAnthropic(baseCall);

    // Before the fix this was '' with a healthy stop_reason 'end_turn' —
    // every judgment silently empty, with nothing in the row saying why.
    expect(result.text).toBe('{"overallScore": 8}');
    expect(result.reasoningText).toBe('Let me weigh the rubric criteria.');
    expect(result.reasoningSource).toBe('anthropic_thinking');
  });

  it('REGRESSION: a plain single text block is unchanged', async () => {
    anthropicCreateMock.mockResolvedValue({
      model: 'claude-sonnet-4-5',
      content: [{ type: 'text', text: 'plain answer', citations: null }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 2 },
    });

    const result = await callAnthropic(baseCall);

    expect(result.text).toBe('plain answer');
    expect(result.reasoningText).toBeUndefined();
    expect(result.reasoningSource).toBeUndefined();
  });

  it('a thinking-only response yields empty text but still captures the thinking', async () => {
    anthropicCreateMock.mockResolvedValue({
      model: 'claude-sonnet-4-5',
      content: [{ type: 'thinking', thinking: 'ran out of budget mid-thought', signature: 'sig' }],
      stop_reason: 'max_tokens',
      usage: { input_tokens: 1, output_tokens: 2 },
    });

    const result = await callAnthropic(baseCall);

    expect(result.text).toBe('');
    expect(result.reasoningText).toBe('ran out of budget mid-thought');
    expect(result.finishReason).toBe('max_tokens');
  });

  it('never surfaces a redacted_thinking blob as either the answer or the reasoning', async () => {
    anthropicCreateMock.mockResolvedValue({
      model: 'claude-sonnet-4-5',
      content: [
        { type: 'redacted_thinking', data: 'EncryptedBlobNotHumanReadable==' },
        { type: 'text', text: 'the answer', citations: null },
      ],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 2 },
    });

    const result = await callAnthropic(baseCall);

    expect(result.text).toBe('the answer');
    expect(result.reasoningText).toBeUndefined();
  });
});
