/**
 * ─── The Judgment JSON Schema (Task 11) ──────────────────────────────────────
 *
 * The ONE schema object handed to a provider's native structured/guided
 * decoding mode (OpenAI-standard `response_format: {type: 'json_schema',
 * ...}` and vLLM's `guided_json` extension both consume this SAME object —
 * see `backends/vllm.ts` and `openai-compatible.ts`'s
 * `defaultStructuredRequestFields`). Defined exactly ONCE, here, so both
 * request-shaping paths and any future structured-output consumer stay in
 * sync with a single source of truth.
 *
 * Mirrors exactly what `provider.ts`'s `parseJudgmentResponse` /
 * `tryParseStructuredJudgment` expect to find: `overallScore`/`reasoning`/
 * `criteriaScores` at the top level (all three REQUIRED — a guided-decoding
 * response omitting any of them is, by definition, non-conforming and
 * demoted to the lenient fallback parse, see `provider.ts`'s doc), each
 * `criteriaScores[]` entry carrying `criterionName`/`score`/`maxScore`
 * (required) plus an OPTIONAL `criterionId` (the model is free to omit it —
 * `parseJudgmentResponse`'s normalization matches criteria by id, exact
 * name, case-insensitive name, or array position, specifically so a model
 * that only ever emits `criterionName` still resolves correctly).
 *
 * Deliberately NOT `strict: true` / `additionalProperties: false` OpenAI
 * "strict schema" mode: strict mode requires every property (including
 * `criterionId`) to be listed in `required` (using a nullable-type trick
 * for genuinely optional fields) — a stronger constraint than this schema
 * needs, and one that would make the schema itself a lot noisier for what
 * is, in practice, a best-effort scoring contract most guided-decoding
 * backends (vLLM's `outlines`/`lm-format-enforcer`, OpenRouter's upstream
 * routing) already enforce plenty strictly via ordinary (non-"strict")
 * JSON Schema validation.
 */

export const JUDGMENT_JSON_SCHEMA_NAME = 'judgment' as const;

export const JUDGMENT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    overallScore: {
      type: 'number',
      description: 'Overall score for the submission, 0-10.',
    },
    reasoning: {
      type: 'string',
      description: 'Brief rationale explaining the scores given.',
    },
    criteriaScores: {
      type: 'array',
      description: 'Per-criterion scores, one entry per rubric criterion.',
      items: {
        type: 'object',
        properties: {
          criterionId: {
            type: 'string',
            description: 'Optional — the rubric criterion id, if known.',
          },
          criterionName: {
            type: 'string',
            description: 'The rubric criterion name being scored.',
          },
          score: {
            type: 'number',
            description: 'The score awarded for this criterion.',
          },
          maxScore: {
            type: 'number',
            description: "This criterion's maximum possible score.",
          },
        },
        required: ['criterionName', 'score', 'maxScore'],
      },
    },
  },
  required: ['overallScore', 'reasoning', 'criteriaScores'],
} as const;
