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
 *
 * Task 11 additions: `DescriptorCallHints`/`ProviderHeaderConfig` (the
 * structural descriptor-hook shapes `callOpenAICompatible` consults for
 * OpenRouter's attribution headers / vLLM's guided-decoding request
 * fields — declared here, not imported from `registry.ts`, to keep this
 * neutral module import-cycle-free; see `DescriptorCallHints`'s own doc)
 * and `tryParseStructuredJudgment` (the strict structured-decoding parse
 * counterpart to `parseJudgmentResponse`'s lenient one, sharing
 * normalization via the private `normalizeParsedJudgment` helper).
 */

import type { CriteriaScore, RubricCriterionView } from '@/types';
import { computeWeightedScore } from '@/lib/utils';
import { ProviderError } from './errors';

export interface RespondRequest {
  promptText: string;
}

/** Context handed to a descriptor's optional `headers()` hook — enough to
 * build attribution/auth headers without the hook needing the full
 * request. Moved here (from `registry.ts`, where it originated in Task 10)
 * so `DescriptorCallHints` below can reference it without `registry.ts`
 * needing to be imported into this neutral module. */
export interface ProviderHeaderConfig {
  apiKey?: string;
  endpoint?: string;
}

/**
 * Structural subset of `registry.ts`'s real `ProviderDescriptor` that
 * `callOpenAICompatible` needs to consult for descriptor-level
 * specialization (Task 11): OpenRouter's attribution headers
 * (`backends/openrouter.ts`) and vLLM's guided-decoding request fields
 * (`backends/vllm.ts`). Declared HERE, not imported from `registry.ts`, to
 * keep this neutral, dependency-free module import-cycle-free —
 * `registry.ts` imports the call FUNCTIONS (`callAnthropic`/
 * `callOpenAICompatible`) from this module's sibling files, so a type
 * import back from `registry.ts` into one of those siblings would be
 * circular. TypeScript's structural typing means `registry.ts`'s actual
 * `ProviderDescriptor` (which has strictly MORE fields, e.g. `id`/`kind`/
 * `auth`/`scoredRunsAllowed`, and a narrower `caps` type) is assignable
 * here without either module importing the other — `registry.ts`'s
 * `execute()` passes its full descriptor straight through.
 */
export interface DescriptorCallHints {
  headers?(cfg: ProviderHeaderConfig): Record<string, string>;
  structuredRequestFields?(schema: Record<string, unknown>): Record<string, unknown>;
  caps: {
    structuredOutput: 'json_schema' | 'tool_use' | 'guided' | 'none';
  };
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
  /** Task 11: the resolved descriptor for this call, so
   * `callOpenAICompatible` can consult its `headers()`/
   * `structuredRequestFields()` hooks and `caps.structuredOutput` without a
   * forked per-backend call path. Optional — `callAnthropic` never reads
   * it (Anthropic's own structured-output path, `caps.structuredOutput:
   * 'tool_use'`, is untouched by this task). */
  descriptor?: DescriptorCallHints;
  /** Task 11: `'judgment'` vs `'respond'` — the structured-output seam
   * only ever attaches the judgment JSON schema for `'judgment'` calls;
   * respond mode is free-form text generation with no schema to guide.
   * Optional (defaults to "not a judgment call, don't attach anything") so
   * pre-Task-11 call sites/tests that never set it keep their exact prior
   * behavior. */
  mode?: 'judgment' | 'respond';
  /** A0: the JSON schema the structured-output seam should attach for a
   * `'judgment'`-mode call. Defaults (in `callOpenAICompatible`) to the
   * pointwise `JUDGMENT_JSON_SCHEMA`; a PAIRWISE call passes
   * `PAIRWISE_JUDGMENT_JSON_SCHEMA` instead, so a guided-decoding backend
   * constrains sampling to `{verdict, reasoning}` rather than to a
   * pointwise score shape the judge was never asked for — which would make
   * every pairwise run against vLLM/llama.cpp unparseable by construction. */
  jsonSchema?: Record<string, unknown>;
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
  /** Task 11: true when `callOpenAICompatible` attached a structured/
   * guided-decoding schema to the OUTGOING request for this call (never
   * set by `callAnthropic`, so an anthropic-backed judgment always parses
   * via the ordinary lenient path, unchanged from before this task). This
   * is a REQUEST-side signal only — it does not mean the provider actually
   * honored the guidance. `registry.ts`'s `executeJudgmentCall` uses it to
   * decide whether to attempt the strict structured parse first, falling
   * back to the lenient `parseJudgmentResponse` (+ `parseMode: 'fallback'`
   * + a logged warning) when the response didn't conform despite the
   * request-side guidance. */
  structuredOutputRequested?: boolean;
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
  /** How the raw text was turned into scores. `'fallback'` — lenient
   * JSON-in-markdown parsing, `parseJudgmentResponse` — is the ordinary
   * path every backend used exclusively before Task 11. `'structured'` is
   * recorded when a backend's native structured/guided-decoding mode
   * (`caps.structuredOutput`: `json_schema`/`guided` — `tool_use`
   * (Anthropic) is untouched by this task) actually drove the response,
   * via `tryParseStructuredJudgment` below — see `registry.ts`'s
   * `executeJudgmentCall` for the strict-then-lenient decision. */
  parseMode: 'structured' | 'fallback';
}

/** `Number.isFinite` narrowed to also reject `null`/`undefined`/non-numbers
 * — used to keep NaN/Infinity (and anything else non-numeric) out of a
 * persisted score instead of silently propagating through
 * `Math.min(Math.max(...))`, which passes NaN through unchanged. */
function finiteNumberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Optional call context for the error raised when a judgment can't be
 * scored — the pointwise counterpart of the `(model "...")` suffix and the
 * `provider:` label `registry.ts`'s `executePairwiseCall` puts on its own
 * `ProviderError`. Optional because `parseJudgmentResponse` is a pure
 * text-in/scores-out function that has never needed to know which backend
 * produced the text; `registry.ts`'s `parseJudgmentText` is the only real
 * caller and already holds both values, so it can pass them through
 * without any other call site (or test) changing.
 *
 * NOT WIRED YET, and don't read the paragraph above as saying it is:
 * `parseJudgmentText` still calls `parseJudgmentResponse(raw.text,
 * criteria)`, so TODAY every real production failure here is labelled
 * `provider: 'unknown'` and its persisted message carries no `(model
 * "...")` suffix — strictly less diagnosable than the pairwise message it
 * is modelled on. Only tests exercise this argument. Closing that is a
 * one-line change in registry.ts (`{ provider: descriptorId, modelId }`),
 * which is outside this change's file ownership.
 */
export interface JudgmentParseContext {
  provider?: string;
  modelId?: string;
}

/**
 * Refuse to invent a score the judge never gave.
 *
 * THE BUG THIS PREVENTS: `finiteNumberOrUndefined(found?.score) ?? 0` used
 * to turn "this criterion was never scored" (absent from the response,
 * name/id unmatched, dropped as a non-record element, or emitted as
 * `null`/`"8"`/`NaN`) into a REAL, persisted 0. `overallScore` was then
 * recomputed from those zeros and the row was written with status
 * 'completed', so a fabricated 0/10 was indistinguishable downstream — on
 * the leaderboard, and in A2's calibration input — from a judge that
 * genuinely scored the submission at rock bottom. Failing loudly is the
 * only option that keeps a persisted score meaning what it says.
 *
 * PARTIAL PARSES ARE FAILURES, deliberately: 4 of 5 criteria is not a
 * partial success. `overallScore` is a weighted composite over the WHOLE
 * rubric, so dropping the 5th criterion silently redistributes its weight
 * across the other four and scoring it 0 silently deflates the composite —
 * either way the persisted number stops meaning "this submission scored X
 * against this rubric" while still claiming status 'completed'. All-or-
 * nothing matches the pairwise path's stance on an unusable verdict.
 *
 * `non_retryable`, and for the same reason `executePairwiseCall` gives
 * (registry.ts): re-asking the same model the same question is not a
 * provider-health signal. Classifying it retryable would burn the
 * 3-attempt budget, DLQ the judgment, and count three failures against a
 * breaker shared with every other correctly-behaving call on the same
 * endpoint+model. A `ProviderError` (rather than the plain `Error` the
 * JSON.parse guard below throws) is also what gets this to the right
 * disposition at all: `classify()` passes a `ProviderError` through
 * untouched, while an unrecognized plain `Error` defaults to `retryable`.
 */
function assertEveryCriterionScored(
  criteria: RubricCriterionView[],
  unscored: string[],
  context: JudgmentParseContext | undefined
): void {
  if (unscored.length === 0) return;

  const named = unscored.map((name) => `"${name}"`).join(', ');
  const model = context?.modelId ? ` (model "${context.modelId}")` : '';
  throw new ProviderError(
    `Pointwise judge response did not contain a usable score for ${unscored.length} of ` +
      `${criteria.length} rubric criteria: ${named}${model}`,
    // `'unknown'` is what every production call currently gets — see
    // `JudgmentParseContext`: `parseJudgmentText` doesn't pass a context
    // yet. Inert rather than wrong: nothing reads `.provider` off a
    // judgment failure (the consumer persists `.message`, and `classify()`
    // returns an existing `ProviderError` untouched, label and all).
    { kind: 'non_retryable', provider: context?.provider ?? 'unknown' }
  );
}

/**
 * Shared normalization: given an already-parsed judgment-shaped object —
 * `parseJudgmentResponse`'s lenient, markdown-stripped `JSON.parse` output,
 * or `tryParseStructuredJudgment`'s strict, direct `JSON.parse` output —
 * plus the rubric criteria, build the score/reasoning fields common to
 * both (score clamping, criteria matching, weighted-score recompute for a
 * missing/non-finite `overallScore`). Extracted (Task 11) so both parse
 * paths apply IDENTICAL normalization, differing only in `parseMode` and
 * in how permissively they accept the raw text before reaching this point.
 *
 * NaN-normalization fix (1b correctness carry, preserved verbatim by this
 * extraction): a non-finite (`NaN`, `Infinity`) or otherwise non-numeric
 * `score`/`overallScore` in the raw JSON is treated as ABSENT rather than
 * passed through — the old `found.score ?? 0` only caught `null`/
 * `undefined` (`??` doesn't match `NaN`), so a model emitting `"score":
 * NaN`-shaped JSON (or any junk that survives `JSON.parse` as a non-finite
 * number) corrupted the stored score with `NaN` (which then poisons every
 * downstream average). A missing/non-finite `overallScore` is recomputed
 * from `criteriaScores` weights via `computeWeightedScore`
 * (src/lib/utils.ts) rather than defaulting to 0 — the same fix Task 11
 * (1a plan) applied to the human-judgment route, ported here for the LLM
 * judge path.
 *
 * "Treated as ABSENT" is where that fix stopped and this one starts: an
 * absent per-criterion score used to become a fabricated 0 anyway, and the
 * `overallScore` recompute then averaged those fabrications. It is now a
 * hard failure — see `assertEveryCriterionScored` for the full rationale,
 * including why a partial (4-of-5) parse is a failure too. The recompute
 * below is only reached once every criterion is known to carry a real
 * score, which is what makes it trustworthy.
 */
function normalizeParsedJudgment(
  parsed: Record<string, unknown>,
  criteria: RubricCriterionView[],
  context?: JudgmentParseContext
): Omit<ParsedJudgment, 'parseMode'> {
  // Validate and normalize criteria scores. Non-record elements (e.g. a
  // stray `null`/string in the array — 1b Task 11 review MINOR fix) are
  // dropped rather than matched against: `cs.criterionId` on a non-object
  // element throws, and this function is shared by BOTH
  // `parseJudgmentResponse` (the lenient fallback) and
  // `tryParseStructuredJudgment` (the strict path) — a malformed element
  // used to crash whichever path reached it first. A dropped element is
  // treated exactly like an absent/unmatched score for that criterion —
  // which, since this fix, means the whole judgment fails rather than that
  // criterion silently scoring 0.
  const parsedScores = (Array.isArray(parsed.criteriaScores) ? parsed.criteriaScores : []).filter(
    isRecord
  ) as unknown as CriteriaScore[];

  // Collected across the whole rubric rather than thrown on the first
  // miss: a judge that scored none of the criteria should say so once,
  // naming all of them, instead of sending an operator round the loop one
  // criterion at a time.
  const unscored: string[] = [];

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

    const rawScore = finiteNumberOrUndefined(found?.score);
    if (rawScore === undefined) unscored.push(criterion.name);

    return {
      criterionId: criterion.id,
      criterionName: criterion.name,
      // `?? 0` only so the array stays well-typed while `unscored` is being
      // collected — `assertEveryCriterionScored` throws below before any of
      // these placeholder rows can be returned, recomputed from, or
      // persisted.
      score: Math.min(Math.max(0, rawScore ?? 0), criterion.maxScore),
      maxScore: criterion.maxScore,
      weight: criterion.weight,
      comment: found?.comment || '',
    };
  });

  assertEveryCriterionScored(criteria, unscored, context);

  const rawOverall = finiteNumberOrUndefined(parsed.overallScore);
  const overallScore =
    rawOverall !== undefined
      ? Math.min(Math.max(0, rawOverall), 10)
      : criteriaScores.length > 0
        ? computeWeightedScore(criteriaScores)
        : // Only reachable for a rubric with NO criteria at all, which
          // `config.ts` forbids (`criteria: z.array(criterionSchema).min(1)`).
          // Left as 0 rather than folded into the failure above on purpose:
          // the completeness check is about criteria the rubric HAS, and
          // "every one of zero criteria was scored" is vacuously true.
          0;

  return {
    overallScore,
    reasoning: (parsed.reasoning as string) || '',
    criteriaScores,
  };
}

/**
 * Parse the LLM response into a structured judgment.
 * Handles cases where the model wraps JSON in markdown code blocks.
 *
 * The ordinary, lenient path — always `parseMode: 'fallback'`. See
 * `tryParseStructuredJudgment` below for the strict, guided-decoding
 * counterpart (Task 11).
 *
 * Lenient about SHAPE (markdown fences, missing ids, positional matching),
 * strict about SUBSTANCE: a criterion the response never usably scored
 * raises a `non_retryable` `ProviderError` rather than resolving to 0 —
 * see `assertEveryCriterionScored`. `context` is optional and only
 * enriches that error's `provider` label and `(model "...")` suffix.
 */
export function parseJudgmentResponse(
  raw: string,
  criteria: RubricCriterionView[],
  context?: JudgmentParseContext
): ParsedJudgment {
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

  return { ...normalizeParsedJudgment(parsed, criteria, context), parseMode: 'fallback' };
}

/**
 * Task 11: attempt a STRICT structured-decoding parse. Guided/structured
 * decoding constrains a model's token sampling to the schema by
 * construction, so a genuinely-conforming response should always be pure
 * JSON (no markdown-fence wrapping needed — unlike `parseJudgmentResponse`,
 * this does NOT strip ```json fences) with `overallScore`/`reasoning`/
 * `criteriaScores` all present and correctly typed, matching
 * `JUDGMENT_JSON_SCHEMA` (`./judgment-schema.ts`).
 *
 * Returns `undefined` (never throws) when the response doesn't conform —
 * signaling the caller (`registry.ts`'s `executeJudgmentCall`) to fall
 * back to the lenient `parseJudgmentResponse` path instead, per Task 11's
 * requirement that a provider "returning non-conforming despite guidance"
 * degrades to `parseMode: 'fallback'` (+ a logged warning) rather than a
 * hard failure — some deployments silently ignore an unsupported
 * `response_format`/`guided_json` request field and just return ordinary
 * (possibly markdown-wrapped) free text.
 *
 * 1b Task 11 review MINOR fix: this docstring's "never throws" promise
 * used to be false — a `criteriaScores` array containing a non-object
 * element (e.g. `[null]`, or `[{...}, "notanobject"]`) reached
 * `normalizeParsedJudgment`'s `cs.criterionId` property access on that
 * element and threw a raw `TypeError`, uncaught, out of this function
 * (`registry.ts`'s `executeJudgmentCall` has no try/catch around its call
 * to this — the whole judgment call would fail instead of degrading to the
 * fallback parse it was designed to). Two changes close this: (1) every
 * `criteriaScores` element is now required to be a record — an array
 * containing anything else is treated as NON-CONFORMING (same as a wrong
 * top-level type), returned as `undefined` before `normalizeParsedJudgment`
 * is ever called; (2) the `normalizeParsedJudgment` call itself is wrapped
 * in try/catch as a backstop for any OTHER shape this function's explicit
 * checks don't anticipate, keeping the "never throws" promise true in
 * fact, not just for the one shape covered by (1). (`normalizeParsedJudgment`
 * was separately hardened to drop non-record elements rather than crash on
 * them at all — see its own doc — which is what lets the lenient
 * `parseJudgmentResponse` fallback actually succeed on the identical raw
 * text this function rejected, instead of hitting the same crash one level
 * up.)
 *
 * The shared `normalizeParsedJudgment` now also THROWS for a response that
 * left a rubric criterion unscored. That is another shape this function's
 * explicit checks can't anticipate (a schema-conforming array can still
 * omit a criterion, or carry `"score": null`), so it lands in the same
 * backstop catch and is reported as non-conforming — the caller logs the
 * demotion warning and re-parses the identical text leniently, where the
 * failure surfaces properly as a `ProviderError` instead of a fabricated
 * 0. No `context` is threaded here on purpose: every error raised inside
 * this function is swallowed, so labelling it would be dead detail.
 */
export function tryParseStructuredJudgment(raw: string, criteria: RubricCriterionView[]): ParsedJudgment | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    return undefined;
  }

  if (!isRecord(parsed)) return undefined;
  if (typeof parsed.overallScore !== 'number' || !Number.isFinite(parsed.overallScore)) return undefined;
  if (typeof parsed.reasoning !== 'string') return undefined;
  if (!Array.isArray(parsed.criteriaScores)) return undefined;
  if (!parsed.criteriaScores.every(isRecord)) return undefined;

  try {
    return { ...normalizeParsedJudgment(parsed, criteria), parseMode: 'structured' };
  } catch {
    return undefined;
  }
}
