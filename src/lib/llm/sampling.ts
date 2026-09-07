/**
 * ─── Sampling params (LEAF MODULE) ─────────────────────────────────────────
 *
 * Extracted verbatim from `registry.ts`'s "Sampling params" section so that a
 * module which only needs to RESOLVE a version's effective params can do so
 * without value-importing registry.ts. registry.ts value-imports
 * `@anthropic-ai/sdk` (through `./anthropic`) and every backend module, and
 * the `@/lib/llm` barrel adds `./breaker-redis` (→ the redis client) on top;
 * `src/lib/calibration/launch.ts` is bundled into the image's
 * `calibration-run.js` by esbuild with only `@prisma/client` external
 * (Dockerfile, the `scripts/calibration/run.ts` block), so reaching this
 * resolver through registry.ts or the `@/lib/llm` barrel would ship the SDKs
 * and the redis client into a CLI that never calls a provider.
 *
 * THIS FILE MUST STAY A LEAF: no value `import` of anything, and no
 * `export … from` in ANY form — single-line, multi-line or dynamic
 * `import()` — because esbuild bundles a re-export exactly like an import.
 * tests/lib/sampling.test.ts reads this source and fails on any of them.
 *
 * registry.ts re-exports `SamplingParams` and `effectiveSamplingParams` from
 * here, and the `@/lib/llm` barrel re-exports them from registry.ts, so every
 * pre-existing importer is unchanged.
 */

export interface SamplingParams {
  temperature: number;
  max_tokens: number;
  /** Ollama/llama.cpp repetition penalty. OPTIONAL and OMITTED when unset —
   * never defaulted to 1.0. A provider that receives an explicit 1.0 and one
   * that receives nothing are the same call, but the STORED
   * `ModelJudgment.samplingParams` would differ, and that field is the
   * provenance record for a run. Absent means "not configured". */
  repeat_penalty?: number;
  /** OpenAI-dialect equivalent, for backends that speak it instead. Both are
   * carried because the fleet is mixed; a version sets whichever its backend
   * honours. */
  frequency_penalty?: number;
}

/**
 * Registry-level fallback sampling params — the hardcoded literals every
 * backend module used to declare independently (`anthropic.ts`/
 * `openai-compatible.ts` both used `{ temperature: 0.3, max_tokens: 4096 }`
 * for judge calls and `{ temperature: 0.4, max_tokens: 4096 }` for respond
 * calls — a deliberately HIGHER temperature for free-form generation than
 * for scoring). Now defined exactly ONCE per mode, here, and only ever used
 * as the LAST-RESORT fallback beneath a `JudgeModelVersion`'s own
 * `samplingDefaults` (which, being a single JSON field shared by both
 * modes — see `prisma/schema.prisma` — applies identically to judge and
 * respond calls once set; this mode split only matters when a version has
 * no `samplingDefaults` of its own at all).
 */
export const JUDGE_DEFAULT_SAMPLING_PARAMS: SamplingParams = { temperature: 0.3, max_tokens: 4096 };
export const RESPOND_DEFAULT_SAMPLING_PARAMS: SamplingParams = { temperature: 0.4, max_tokens: 4096 };

function isPartialSamplingParams(value: unknown): value is Partial<SamplingParams> {
  return typeof value === 'object' && value !== null;
}

/**
 * Effective sampling params = per-call override ?? the `JudgeModelVersion`'s
 * own `samplingDefaults` ?? `registryDefault` (mode-specific — see
 * `JUDGE_DEFAULT_SAMPLING_PARAMS`/`RESPOND_DEFAULT_SAMPLING_PARAMS` above) —
 * per-field, so a version that only pins `temperature` still inherits the
 * registry's `max_tokens`. This is the value recorded as
 * `samplingParamsUsed` on every `JudgmentResult`/`RespondResult` (persisted
 * as `ModelJudgment.samplingParams` — the ACTUAL params a call used, not a
 * re-derivation at persist time).
 */
export function effectiveSamplingParams(
  versionDefaults: unknown,
  overrides?: Partial<SamplingParams>,
  registryDefault: SamplingParams = JUDGE_DEFAULT_SAMPLING_PARAMS
): SamplingParams {
  const versionShape = isPartialSamplingParams(versionDefaults) ? versionDefaults : undefined;
  const resolved: SamplingParams = {
    temperature: overrides?.temperature ?? versionShape?.temperature ?? registryDefault.temperature,
    max_tokens: overrides?.max_tokens ?? versionShape?.max_tokens ?? registryDefault.max_tokens,
  };
  // Assigned conditionally, not spread with `?? undefined`: an explicit
  // `repeat_penalty: undefined` key would serialise into
  // `ModelJudgment.samplingParams` as a null and read as "configured to
  // nothing" rather than "not configured".
  const repeatPenalty = overrides?.repeat_penalty ?? versionShape?.repeat_penalty;
  if (repeatPenalty !== undefined) resolved.repeat_penalty = repeatPenalty;
  const frequencyPenalty = overrides?.frequency_penalty ?? versionShape?.frequency_penalty;
  if (frequencyPenalty !== undefined) resolved.frequency_penalty = frequencyPenalty;
  return resolved;
}
