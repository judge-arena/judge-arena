import { JUDGMENT_JSON_SCHEMA_NAME } from '../judgment-schema';

/**
 * Structured-output request fields for an Ollama server's OpenAI-compatible
 * `/v1/chat/completions` endpoint.
 *
 * ── THIS MODULE EXISTS BECAUSE A CLAIM IN THE REGISTRY WAS WRONG ────────────
 *
 * Until 2026-08-31 `ollama` carried `structuredOutput: 'none'` and
 * `scoredRunsAllowed: false`, justified by: "Ollama is refused for scored runs
 * because it cannot constrain output, so its verdicts are
 * unparseable-by-construction."
 *
 * That was measured against a live server and found false. Ollama 0.32.15 at
 * 192.168.1.9:11434 honours the standard `response_format: {type:
 * 'json_schema'}` path: `granite4.1:3b` returned schema-conformant JSON on
 * three consecutive calls with `finish_reason: 'stop'`, and `gemma4:26b` did
 * the same. The descriptor's own inline comment had already conceded the point
 * ("a SCORED-RUN restriction, NOT a technical one") while the module doc above
 * it still asserted the technical claim — so the file contradicted itself, and
 * the half that was wrong was the half doing the gating.
 *
 * ── WHY A SEPARATE MODULE, when the body matches llamacpp's exactly ─────────
 *
 * Because `backends/llamacpp.ts` argues, correctly, that these belong apart:
 * vLLM constrains via its own `guided_json` extension and llama.cpp via
 * standard `response_format`, and sending one shape to the other server is a
 * request that is WRONG rather than unsupported — it fails silently, returning
 * plausible free text that only the strict-parse fallback flags. Collapsing
 * two verified-separately shapes into one helper because they currently agree
 * is how that silent failure gets reintroduced the next time one server's API
 * moves. Each backend carries the shape confirmed against it.
 *
 * ── `strict: true` ─────────────────────────────────────────────────────────
 * Included because that is what was actually verified on the wire, the same
 * standard `llamacpp.ts` sets for itself.
 *
 * ── WHAT THIS DOES NOT CLAIM ───────────────────────────────────────────────
 * Nothing here says an Ollama-served model is a GOOD judge. Constraining
 * output guarantees a parseable verdict, not a correct one. Whether a 3B
 * quantised model should be trusted as a judge is a question a CalibrationRun
 * answers with a number — which is precisely the machinery that was
 * unreachable while this backend was refused outright.
 */
export function ollamaStructuredRequestFields(
  schema: Record<string, unknown>
): Record<string, unknown> {
  return {
    response_format: {
      type: 'json_schema',
      json_schema: { name: JUDGMENT_JSON_SCHEMA_NAME, schema, strict: true },
    },
  };
}
