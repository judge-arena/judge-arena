import { afterEach, describe, expect, it, vi } from 'vitest';
// Value import, not `import type`: the registry-defaults guard below
// enumerates the enum at runtime rather than hand-copying the backend list.
// Same precedent as tests/lib/utils.test.ts / append-retry.test.ts — reading
// the generated client's enum object needs no database.
import { ServingBackend } from '@prisma/client';

/**
 * Endpoint base-URL normalization for every `openai_compatible` backend.
 *
 * The failure this exists to prevent: the OpenAI SDK appends
 * `/chat/completions` to whatever `baseURL` it is handed, so a user who
 * pastes `http://192.168.1.164:8001` (the address the llama.cpp/vLLM server
 * prints on startup — no `/v1`) or `http://192.168.1.164:8001/v1/chat/completions`
 * (copied out of curl docs) gets a bare `404 Not Found` from the far end,
 * with nothing anywhere in the stack naming the URL as the cause. Both are
 * the most common way a first local-model setup fails.
 *
 * The countervailing risk — and why the table below spends as many cases on
 * URLs that must NOT change as on ones that must — is that plenty of
 * legitimate deployments are mounted under a path prefix
 * (`https://openrouter.ai/api/v1`, a reverse proxy at `/llm/v1`, a gateway
 * at `/openai/v1`). A normalizer that "helpfully" rewrites those breaks
 * working configurations, which is strictly worse than the 404 it set out
 * to fix. See `normalizeOpenAIBaseUrl`'s own doc for the rule.
 *
 * `openai` is mocked at the SDK-client level — the same stable interception
 * point `tests/lib/backends.test.ts`/`llm-timeout.test.ts` use, and for the
 * reason documented there.
 */
const { openaiCreateMock, OpenAIConstructorMock } = vi.hoisted(() => ({
  openaiCreateMock: vi.fn(),
  OpenAIConstructorMock: vi.fn(),
}));

vi.mock('openai', () => ({
  default: OpenAIConstructorMock.mockImplementation(() => ({
    chat: { completions: { create: openaiCreateMock } },
  })),
}));

const { callOpenAICompatible, normalizeOpenAIBaseUrl } = await import('@/lib/llm/openai-compatible');
const { getDescriptor } = await import('@/lib/llm/registry');

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  vi.clearAllMocks();
  // The registry-defaults guard sets VLLM_BASE_URL/LLAMACPP_BASE_URL. Restore
  // the way tests/lib/backends.test.ts does, so nothing downstream inherits a
  // base URL this file invented — vitest reuses worker processes, and an
  // env-injected descriptor default is exactly the kind of leak that turns
  // into a test that only passes when run after this one.
  process.env = { ...ORIGINAL_ENV };
});

// [input, expected, why]
const CASES: Array<[string | undefined, string | undefined, string]> = [
  // ── Unset stays unset ──────────────────────────────────────────────────
  // MUST return undefined rather than a normalized string: `execute()`
  // resolves `request.baseUrl ?? descriptor.defaultBaseUrl` BEFORE calling
  // in, and the SDK falls back to api.openai.com when baseURL is undefined.
  // Anything else here silently redirects every real-OpenAI call.
  [undefined, undefined, 'unset — the descriptor default / SDK default applies'],
  ['', undefined, 'empty string — same as unset (the API route stores "" as null)'],
  ['   ', undefined, 'whitespace-only — a paste accident, not a host'],

  // ── The two onboarding failures this fix exists for ────────────────────
  ['http://192.168.1.164:8001', 'http://192.168.1.164:8001/v1', 'bare host — the address llama.cpp prints on boot'],
  ['http://192.168.1.164:8001/', 'http://192.168.1.164:8001/v1', 'bare host with a trailing slash'],
  [
    'http://192.168.1.164:8001/v1/chat/completions',
    'http://192.168.1.164:8001/v1',
    'the full completions URL, copied out of curl docs',
  ],
  [
    'http://192.168.1.164:8001/chat/completions',
    'http://192.168.1.164:8001/v1',
    'completions path with no /v1 — strip the suffix, then the root rule applies',
  ],
  [
    'http://192.168.1.164:8001/v1/chat/completions/',
    'http://192.168.1.164:8001/v1',
    'completions URL with a trailing slash',
  ],

  // ── Already correct: byte-identical out ────────────────────────────────
  ['http://192.168.1.164:8001/v1', 'http://192.168.1.164:8001/v1', 'already correct — untouched'],
  ['http://192.168.1.164:8001/v1/', 'http://192.168.1.164:8001/v1', 'correct but for a trailing slash'],
  [' http://192.168.1.164:8001/v1 ', 'http://192.168.1.164:8001/v1', 'surrounding whitespace from a paste'],

  // ── Path-prefixed deployments that MUST survive intact ─────────────────
  ['https://openrouter.ai/api/v1', 'https://openrouter.ai/api/v1', "registry's openrouter defaultBaseUrl"],
  ['http://localhost:11434/v1', 'http://localhost:11434/v1', "registry's ollama defaultBaseUrl"],
  ['https://gateway.example.com/openai/v1', 'https://gateway.example.com/openai/v1', 'gateway mounted at /openai'],
  ['https://gateway.example.com/llm/v1', 'https://gateway.example.com/llm/v1', 'reverse proxy mounted at /llm'],
  [
    'https://gateway.example.com/llm/v1/chat/completions',
    'https://gateway.example.com/llm/v1',
    'suffix stripping keeps the proxy prefix',
  ],
  // The conservative half of the rule: /v1 is only ever APPENDED to a root,
  // never INJECTED into an existing path. A proxy at /llm that serves
  // /llm/chat/completions directly is a real shape, and guessing /llm/v1
  // for it would break a working config to fix a hypothetical one.
  ['https://gateway.example.com/llm', 'https://gateway.example.com/llm', 'non-empty path is assumed deliberate'],
  [
    'https://gateway.example.com/llm/chat/completions',
    'https://gateway.example.com/llm',
    'suffix stripped, but no /v1 injected into the prefix',
  ],

  // ── Shapes we deliberately refuse to reason about ──────────────────────
  // Some gateways key auth off a query param; rewriting around one risks
  // dropping it. Hands off entirely rather than half-understanding it.
  ['https://gateway.example.com/v1?api-key=abc', 'https://gateway.example.com/v1?api-key=abc', 'query string — hands off'],
  // The case that makes the carve-out load-bearing rather than belt-and-
  // braces: delete the `[?#]` early return and the suffix strip eats the
  // TAIL OF A QUERY PARAM here, leaving `...?upstream=https://vllm.internal:8000/v1`
  // pointed at the proxy's own root. Every other query-carrying URL survives
  // deletion untouched (the strip is `$`-anchored, and the append is already
  // blocked by SCHEME_AND_AUTHORITY_ONLY's own `[^/?#]`), so without this row
  // the carve-out has no test that fails when it is removed.
  [
    'https://gateway.example.com/proxy?upstream=https://vllm.internal:8000/v1/chat/completions',
    'https://gateway.example.com/proxy?upstream=https://vllm.internal:8000/v1/chat/completions',
    'a query param whose own value ends in /chat/completions',
  ],
  ['not a url', 'not a url', 'unparseable — pass through and let the SDK raise its own error'],
];

describe('normalizeOpenAIBaseUrl', () => {
  it.each(CASES)('%s -> %s (%s)', (input, expected) => {
    expect(normalizeOpenAIBaseUrl(input)).toBe(expected);
  });

  it('is idempotent — re-normalizing an already-normalized URL is a no-op', () => {
    for (const [input] of CASES) {
      const once = normalizeOpenAIBaseUrl(input);
      expect(normalizeOpenAIBaseUrl(once)).toBe(once);
    }
  });

  it('leaves every defaultBaseUrl the registry actually ships byte-identical', () => {
    // Guards the rule against the registry rather than against a literal:
    // if someone adds a descriptor whose default URL this normalizer would
    // rewrite, that is a bug in one of the two and this fails.
    //
    // The backend list is DERIVED from prisma's enum, never hand-copied —
    // a copied list reproduces, inside the guard, the drift the guard exists
    // to catch. That is not hypothetical here: at 2b882ea the hand-copied
    // `SERVING_BACKENDS` tuple in `src/app/api/models/route.ts` was still
    // missing `llamacpp` while the enum and its descriptor already had it,
    // and nothing went red. A literal here fails the same way — silently,
    // by checking one backend fewer than exists.
    process.env.VLLM_BASE_URL = 'http://vllm.internal:8000/v1';
    process.env.LLAMACPP_BASE_URL = 'http://192.168.1.164:8001/v1';

    const checked: string[] = [];
    for (const backend of Object.values(ServingBackend)) {
      // execute() dispatches anthropic to callAnthropic, whose SDK appends
      // `/v1/messages` to its own baseURL — this normalizer never sees it.
      if (backend === 'anthropic') continue;
      const url = getDescriptor(backend).defaultBaseUrl;
      // Real OpenAI ships no default (the SDK supplies its own host); a
      // descriptor with nothing to normalize has nothing to guard.
      if (!url) continue;
      expect(normalizeOpenAIBaseUrl(url), `${backend}'s defaultBaseUrl is rewritten by the normalizer`).toBe(url);
      checked.push(backend);
    }

    // Without this the loop is silently satisfiable by checking nothing —
    // the two env-injected descriptors resolve to `undefined` and skip the
    // moment getDescriptor stops reading VLLM_BASE_URL/LLAMACPP_BASE_URL.
    expect(checked).toEqual(expect.arrayContaining(['openrouter', 'ollama', 'vllm', 'llamacpp']));
  });
});

describe('callOpenAICompatible wiring', () => {
  const baseOpts = {
    apiKey: 'sk-test',
    modelId: 'test-model',
    systemPrompt: 'sys',
    userPrompt: 'usr',
    samplingParams: { temperature: 0.3, max_tokens: 128 },
    signal: new AbortController().signal,
  };

  function okResponse() {
    return {
      model: 'served-model',
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    };
  }

  it('hands the SDK the NORMALIZED base URL, not the raw one', async () => {
    openaiCreateMock.mockResolvedValueOnce(okResponse());

    await callOpenAICompatible({ ...baseOpts, baseUrl: 'http://192.168.1.164:8001' });

    expect(OpenAIConstructorMock).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: 'http://192.168.1.164:8001/v1' })
    );
  });

  it('still passes undefined through when no base URL is set', async () => {
    openaiCreateMock.mockResolvedValueOnce(okResponse());

    await callOpenAICompatible({ ...baseOpts });

    expect(OpenAIConstructorMock).toHaveBeenCalledWith(expect.objectContaining({ baseURL: undefined }));
  });
});
