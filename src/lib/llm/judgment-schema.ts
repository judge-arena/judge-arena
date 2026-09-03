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

/**
 * ─── The Pairwise Verdict Schema (A0) ───────────────────────────────────────
 *
 * A pairwise judge does not score — it PREFERS. Its whole output is a
 * choice between two candidate responses plus the rationale for that
 * choice, so this schema requires `verdict` and `reasoning` and requires
 * NEITHER `overallScore` nor `criteriaScores`: handing a pairwise call the
 * pointwise `JUDGMENT_JSON_SCHEMA` above through a guided-decoding backend
 * (vLLM, llama.cpp) would constrain the model's sampling to emit a score
 * shape nobody asked it for, and no verdict at all.
 *
 * `verdict` is stored RAW on `ModelJudgment.verdict`, against the
 * `ModelJudgment.pairOrder` the model was actually shown ('AB' for every
 * judgment A0 emits). Which SAMPLE was preferred is derived from the pair
 * (verdict, pairOrder) at read time — never encoded into the stored string
 * (A0 design doc, decision #4). That is what makes A2's `BA` sweep additive
 * with no backfill.
 */
export const PAIRWISE_JUDGMENT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    verdict: {
      type: 'string',
      enum: ['A', 'B', 'tie'],
      description:
        'Which response is better: "A" for Response A, "B" for Response B, or "tie" if neither is clearly better.',
    },
    reasoning: {
      type: 'string',
      description: 'Brief rationale explaining the verdict.',
    },
  },
  required: ['verdict', 'reasoning'],
} as const;

/** A parsed pairwise verdict — the output of `tryParsePairwiseJudgment`,
 * before call metadata is merged in by `registry.ts`'s
 * `executePairwiseCall`. */
export interface ParsedPairwiseJudgment {
  verdict: 'A' | 'B' | 'tie';
  reasoning: string;
  /** TRUE when the parser had to REPAIR the text to read it: a markdown fence
   * was stripped, or the verdict string needed case/whitespace normalisation
   * (`"a"`, `" TIE "`). FALSE when the trimmed text parsed as-is with a
   * canonical verdict. Extra keys the model volunteers are ignored and do NOT
   * count as repair. `registry.ts`'s `executePairwiseCall` combines this with
   * whether a schema was attached to the request to record
   * `ModelJudgment.parseMode` — the pairwise mirror of the pointwise
   * strict-then-lenient demotion. */
  lenient: boolean;
}

/** Case- and whitespace-tolerant normalization of the raw `verdict` string
 * onto the three legal values. Tolerant on the way IN (a model that emits
 * `"a"` or `" TIE "` meant the same thing) and strict on the way OUT —
 * anything else is not a verdict, and returns `null` rather than being
 * coerced into one. */
function normalizeVerdict(raw: unknown): 'A' | 'B' | 'tie' | null {
  if (typeof raw !== 'string') return null;
  const upper = raw.trim().toUpperCase();
  if (upper === 'A') return 'A';
  if (upper === 'B') return 'B';
  if (upper === 'TIE') return 'tie';
  return null;
}

/**
 * Parse a pairwise judge response into `{verdict, reasoning, lenient}`, or
 * `null`.
 *
 * ONE parse path, unlike the pointwise pair (`tryParseStructuredJudgment`
 * strict, `parseJudgmentResponse` lenient — see provider.ts). This function
 * is deliberately fence-tolerant on its own (a model that wraps its JSON in
 * ```json despite guided decoding is still conforming enough). Until
 * 2026-09-01 that meant "no strict-then-lenient demotion to record and no
 * `parseMode` to persist" — CORRECTED: the demotion IS observable from
 * inside this one path (did a fence have to go? did the verdict need
 * normalising?), and `lenient` reports it so `executePairwiseCall` can
 * record `parseMode` with the same meaning pointwise gives it. The parse
 * RESULT is unchanged by this: a fenced or lower-cased verdict is still
 * accepted, it is merely no longer indistinguishable afterwards from one
 * that needed nothing.
 *
 * NEVER throws. A `null` return is the caller's signal that the response
 * carried no usable verdict — `registry.ts`'s `executePairwiseCall` turns
 * that into a `non_retryable` ProviderError, because re-asking the same
 * model the same question is not a provider-health problem and must not
 * burn the retry budget or count against the circuit breaker.
 */
export function tryParsePairwiseJudgment(raw: string): ParsedPairwiseJudgment | null {
  let jsonStr = raw.trim();
  const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  const fenced = codeBlockMatch !== null;
  if (codeBlockMatch) {
    jsonStr = codeBlockMatch[1].trim();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

  const record = parsed as Record<string, unknown>;
  const verdict = normalizeVerdict(record.verdict);
  if (!verdict) return null;
  if (typeof record.reasoning !== 'string') return null;

  // `record.verdict` is a string here (normalizeVerdict returned non-null);
  // any difference from the canonical value is case/whitespace repair.
  const lenient = fenced || record.verdict !== verdict;
  return { verdict, reasoning: record.reasoning, lenient };
}
