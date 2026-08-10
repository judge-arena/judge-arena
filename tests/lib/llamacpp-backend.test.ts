import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDescriptor } from '@/lib/llm/registry';
import { llamacppStructuredRequestFields } from '@/lib/llm/backends/llamacpp';
import { vllmStructuredRequestFields } from '@/lib/llm/backends/vllm';

// The `llamacpp` descriptor exists because neither existing OpenAI-compatible
// descriptor is correct for a llama.cpp server, and both failure modes are
// SILENT:
//
//   as `openai`   -> caps.structuredOutput is 'none', so every judgment drops
//                    to free-text parsing. Verdicts still come back; they are
//                    just unconstrained.
//   as `vllm`     -> emits `guided_json`, which llama.cpp does not implement.
//                    The key is ignored, generation is unconstrained, and the
//                    response still looks plausible.
//
// Neither mistake throws, so these assertions are the only thing that would
// catch a well-meaning "these are both OpenAI-compatible, share the helper"
// refactor. Verified against a live server (192.168.1.164:8001, Qwen3.6-35B):
// response_format json_schema IS honoured and returns conformant JSON.

const SCHEMA = { type: 'object', properties: { score: { type: 'integer' } } } as const;

describe('llamacpp backend descriptor', () => {
  const original = process.env.LLAMACPP_BASE_URL;

  beforeEach(() => {
    delete process.env.LLAMACPP_BASE_URL;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.LLAMACPP_BASE_URL;
    else process.env.LLAMACPP_BASE_URL = original;
  });

  it('declares json_schema structured output — not none, and not vLLM guided', () => {
    const d = getDescriptor('llamacpp');
    expect(d.caps.structuredOutput).toBe('json_schema');
    expect(d.kind).toBe('openai_compatible');
  });

  it('is allowed for scored runs, unlike ollama', () => {
    // This is the whole point of the descriptor: first-party dogfooding has to
    // produce real evaluation data, not dev-only scratch runs. Ollama is
    // refused because it cannot constrain output; llama.cpp can.
    expect(getDescriptor('llamacpp').scoredRunsAllowed).toBe(true);
    expect(getDescriptor('ollama').scoredRunsAllowed).toBe(false);
  });

  it('reads its base URL from LLAMACPP_BASE_URL fresh on every call', () => {
    expect(getDescriptor('llamacpp').defaultBaseUrl).toBeUndefined();

    process.env.LLAMACPP_BASE_URL = 'http://192.168.1.164:8001/v1';
    expect(getDescriptor('llamacpp').defaultBaseUrl).toBe('http://192.168.1.164:8001/v1');

    // Fresh per call, not captured at module load — otherwise a deployment
    // that sets the var after import would silently get `undefined`.
    process.env.LLAMACPP_BASE_URL = 'http://elsewhere:9001/v1';
    expect(getDescriptor('llamacpp').defaultBaseUrl).toBe('http://elsewhere:9001/v1');
  });

  it('emits response_format json_schema and NEVER guided_json', () => {
    const fields = llamacppStructuredRequestFields(SCHEMA as unknown as Record<string, unknown>);

    expect(fields).toHaveProperty('response_format');
    expect(fields.response_format).toMatchObject({
      type: 'json_schema',
      json_schema: { name: 'judgment', schema: SCHEMA, strict: true },
    });

    // The regression this file exists to prevent.
    expect(fields).not.toHaveProperty('guided_json');
  });

  it('differs from the vllm fields in exactly the guided_json key', () => {
    const llama = llamacppStructuredRequestFields(SCHEMA as unknown as Record<string, unknown>);
    const vllm = vllmStructuredRequestFields(SCHEMA as unknown as Record<string, unknown>);

    expect(Object.keys(vllm).sort()).toEqual(['guided_json', 'response_format']);
    expect(Object.keys(llama)).toEqual(['response_format']);
  });

  it('wires the descriptor to its own fields builder, not vllm’s', () => {
    const d = getDescriptor('llamacpp');
    expect(d.structuredRequestFields).toBe(llamacppStructuredRequestFields);
    expect(d.structuredRequestFields).not.toBe(vllmStructuredRequestFields);
  });
});
