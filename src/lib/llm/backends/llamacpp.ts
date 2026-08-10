import { JUDGMENT_JSON_SCHEMA_NAME } from '../judgment-schema';

/**
 * Structured-output request fields for a `llama.cpp` server's
 * OpenAI-compatible `/v1/chat/completions` endpoint.
 *
 * ── Why this is NOT `vllmStructuredRequestFields` ───────────────────────────
 * The two look interchangeable and are not. vLLM constrains generation via
 * `guided_json` (its own extension) and additionally accepts `response_format`;
 * `backends/vllm.ts` therefore sends BOTH. llama.cpp implements constrained
 * output through the standard `response_format: {type: 'json_schema'}` path
 * (internally converting the schema to a GBNF grammar) and has no
 * `guided_json` concept at all. Sending vLLM's shape at a llama.cpp server
 * would put an unrecognised key on the wire and leave generation
 * unconstrained — a request that is *wrong* rather than merely unsupported,
 * and one that fails silently: you get plausible free text back and only the
 * strict-parse fallback in `executeJudgmentCall` hints that anything went
 * wrong.
 *
 * So the two backends are deliberately separate modules rather than a shared
 * helper with a flag.
 *
 * ── `strict: true` ─────────────────────────────────────────────────────────
 * Included because it is what was actually verified against a live server
 * (llama.cpp at 192.168.1.164:8001 serving Qwen3.6-35B-A3B-UD-Q3_K_XL, which
 * returned schema-conformant JSON with it set). `vllm.ts` omits it; that is
 * not an inconsistency to reconcile, it is each backend carrying the shape
 * confirmed for it.
 */
export function llamacppStructuredRequestFields(
  schema: Record<string, unknown>
): Record<string, unknown> {
  return {
    response_format: {
      type: 'json_schema',
      json_schema: { name: JUDGMENT_JSON_SCHEMA_NAME, schema, strict: true },
    },
  };
}
