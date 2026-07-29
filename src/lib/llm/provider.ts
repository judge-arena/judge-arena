/**
 * LLM Provider Abstraction Layer — shared, provider-agnostic building blocks.
 *
 * Task 10 (registry rewrite): the class-based `JudgmentProvider`/
 * `ProviderConfig` abstraction and the inline `buildJudgmentSystemPrompt`/
 * `buildJudgmentUserPrompt` builders that used to live here have moved:
 * - The system prompt is now rendered from a DB `PromptTemplate` row (see
 *   `./render.ts`'s `renderJudgmentSystemPrompt` — byte-identical to the old
 *   `buildJudgmentSystemPrompt` for the seeded `v1-legacy` v0 template, see
 *   `tests/lib/render.test.ts`'s golden test).
 * - The `<submission>` user-prompt wrapper (with the 1a MINOR delimiter-
 *   escaping fix) is now `./render.ts`'s `buildJudgmentUserPrompt`.
 * - Provider dispatch is now `./registry.ts`'s `getDescriptor`/`execute`/
 *   `runProviderJudgment`/`runProviderResponse`, replacing `getProvider()`/
 *   the `AnthropicProvider`/`OpenAICompatibleProvider` classes.
 *
 * What's left here: the respond-mode prompt builders (unaffected — respond
 * mode has no DB template, see judgment-consumer.ts's module doc) and
 * `parseJudgmentResponse`, the judge-mode response parser — kept here
 * because it is pure text-in/scores-out logic independent of which backend
 * produced the raw text, and because that's exactly the function this
 * task's NaN-rejection fix (1b correctness carry) needed to land in.
 */

import type { CriteriaScore, RubricCriterionView } from '@/types';
import { computeWeightedScore } from '@/lib/utils';

export interface RespondRequest {
  promptText: string;
}

/**
 * Shared low-level call shape between `anthropic.ts` and
 * `openai-compatible.ts` — deliberately provider-agnostic (a rendered
 * system/user prompt pair in, raw text + call metadata out). Defined here
 * (not in `registry.ts`) so both backend modules and `registry.ts` can
 * import it without a circular module dependency (`registry.ts` imports the
 * call FUNCTIONS from `anthropic.ts`/`openai-compatible.ts`; those modules
 * only need the shared TYPES, which live in this neutral, dependency-free
 * module).
 *
 * `samplingParams` is REQUIRED (not optional, no inline default) — the
 * `{ temperature: 0.3, max_tokens: 4096 }` literals that used to be
 * hardcoded inside `anthropic.ts`/`openai-compatible.ts` are gone; the
 * EFFECTIVE value (`JudgeModelVersion.samplingDefaults ?? registry-level
 * defaults ?? per-call override`) is always resolved by `registry.ts`
 * before either backend module is called.
 */
export interface ProviderCallOptions {
  apiKey: string;
  /** Custom base URL — unset for the official Anthropic/OpenAI hosts. */
  baseUrl?: string;
  modelId: string;
  systemPrompt: string;
  userPrompt: string;
  samplingParams: { temperature: number; max_tokens: number };
  /** Aborts the in-flight HTTP call once `EVALUATION_MODEL_TIMEOUT_MS`
   * elapses — see registry.ts's `execute()` (MANDATORY carry from Task 8's
   * review: the timeout budget was never wired into an actual request
   * before this task). */
  signal: AbortSignal;
}

/** Raw call metadata, captured before any judge-mode score parsing. */
export interface ProviderCallResult {
  text: string;
  /** `response.model` — the model id the serving backend actually reports,
   * which can differ from the requested `modelId` (e.g. an alias resolving
   * to a dated snapshot). */
  servedModelId?: string;
  /** `stop_reason` (Anthropic) / `finish_reason` (OpenAI-compatible). */
  finishReason?: string;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs: number;
}

export function buildRespondSystemPrompt(): string {
  return `You are a helpful, precise assistant. Respond directly to the user prompt.

Instructions:
- Directly answer the prompt as the primary objective whenever possible.
- If the prompt is ambiguous or missing key details, state assumptions briefly and still provide the best possible answer.
- Be accurate and concise.
- Follow the prompt exactly.
- Do not include meta-commentary about being an AI.
- Return plain text only.`;
}

export function buildRespondUserPrompt(request: RespondRequest): string {
  return request.promptText.trim();
}

/** A single parsed judgment — the output of `parseJudgmentResponse`, before
 * call metadata (latency/tokens/servedModelId/...) is merged in by
 * `registry.ts`'s `runProviderJudgment`. */
export interface ParsedJudgment {
  overallScore: number;
  reasoning: string;
  criteriaScores: CriteriaScore[];
  /** How the raw text was turned into scores. Always `'fallback'` today
   * (lenient JSON-in-markdown parsing) — `'structured'` is recorded once a
   * backend's native structured-output mode (tool_use/json_schema/guided)
   * actually drove the response, landing in Task 11. */
  parseMode: 'structured' | 'fallback';
}

/** `Number.isFinite` narrowed to also reject `null`/`undefined`/non-numbers
 * — used to keep NaN/Infinity (and anything else non-numeric) out of a
 * persisted score instead of silently propagating through
 * `Math.min(Math.max(...))`, which passes NaN through unchanged. */
function finiteNumberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Parse the LLM response into a structured judgment.
 * Handles cases where the model wraps JSON in markdown code blocks.
 *
 * NaN-normalization fix (1b correctness carry): a non-finite (`NaN`,
 * `Infinity`) or otherwise non-numeric `score`/`overallScore` in the raw
 * JSON is treated as ABSENT rather than passed through — the old
 * `found.score ?? 0` only caught `null`/`undefined` (`??` doesn't match
 * `NaN`), so a model emitting `"score": NaN`-shaped JSON (or any junk that
 * survives `JSON.parse` as a non-finite number) corrupted the stored score
 * with `NaN` (which then poisons every downstream average). A missing/
 * non-finite `overallScore` is recomputed from `criteriaScores` weights via
 * `computeWeightedScore` (src/lib/utils.ts) rather than defaulting to 0 —
 * the same fix Task 11 (1a plan) applied to the human-judgment route,
 * ported here for the LLM judge path.
 */
export function parseJudgmentResponse(raw: string, criteria: RubricCriterionView[]): ParsedJudgment {
  // Extract JSON from markdown code blocks if present
  let jsonStr = raw.trim();
  const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    jsonStr = codeBlockMatch[1].trim();
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (parseError) {
    const preview = jsonStr.length > 200 ? jsonStr.slice(0, 200) + '...' : jsonStr;
    throw new Error(
      `Failed to parse LLM judgment response as JSON: ${parseError instanceof Error ? parseError.message : parseError}. ` +
      `Response preview: ${preview}`
    );
  }

  // Validate and normalize criteria scores
  const parsedScores = Array.isArray(parsed.criteriaScores) ? parsed.criteriaScores : [];
  const criteriaScores: CriteriaScore[] = criteria.map((criterion, index) => {
    // Match by ID, exact name, case-insensitive name, or array position
    const found = parsedScores.find(
      (cs: CriteriaScore) =>
        cs.criterionId === criterion.id ||
        cs.criterionName === criterion.name ||
        cs.criterionName?.toLowerCase() === criterion.name.toLowerCase()
    ) ?? (parsedScores[index] && !criteria.some(
      (c, i) => i !== index && (
        parsedScores[index].criterionId === c.id ||
        parsedScores[index].criterionName === c.name ||
        parsedScores[index].criterionName?.toLowerCase() === c.name.toLowerCase()
      )
    ) ? parsedScores[index] : undefined);

    const rawScore = finiteNumberOrUndefined(found?.score) ?? 0;

    return {
      criterionId: criterion.id,
      criterionName: criterion.name,
      score: Math.min(Math.max(0, rawScore), criterion.maxScore),
      maxScore: criterion.maxScore,
      weight: criterion.weight,
      comment: found?.comment || '',
    };
  });

  const rawOverall = finiteNumberOrUndefined(parsed.overallScore);
  const overallScore =
    rawOverall !== undefined
      ? Math.min(Math.max(0, rawOverall), 10)
      : criteriaScores.length > 0
        ? computeWeightedScore(criteriaScores)
        : 0;

  return {
    overallScore,
    reasoning: (parsed.reasoning as string) || '',
    criteriaScores,
    parseMode: 'fallback',
  };
}
