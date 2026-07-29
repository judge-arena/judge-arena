/**
 * ─── Run mode derivation ────────────────────────────────────────────────────
 *
 * judge-arena evaluations run in one of two modes, determined ENTIRELY by
 * whether `Evaluation.responseText` is a non-blank string — v1's exact rule
 * (`evaluation-run-manager.ts`'s `isJudgeMode`), restored verbatim by 1b
 * Task 9b:
 *
 *   - 'judge'   — responseText is set: an existing response is being scored
 *     against a rubric (`executeJudgment` / `runProviderJudgment`).
 *   - 'respond' — responseText is null/undefined/blank: no response exists
 *     yet, so each selected model GENERATES one from promptText (falling
 *     back to inputText) — `executeRespond` / `runProviderResponse` — and a
 *     human later picks the best one (the run finishes `needs_human`;
 *     `resolveHumanJudgmentScore`'s 'respond' branch and the human-judgment
 *     route's `selectedBestModelId` handling complete it).
 *
 * Single source of truth so the web tier (human-judgment route, run-launch
 * producer) and the worker (judgment-consumer, run-create-consumer) never
 * disagree about which mode a given run/evaluation is in. Before this
 * module existed, `responseText?.trim() ? 'judge' : 'respond'` was
 * duplicated inline in several places — this consolidates the two call
 * sites Task 9b's queue path depends on (the worker's judgment-consumer and
 * the human-judgment route); other pre-existing inline duplicates (several
 * `src/app/**\/page.tsx` UI files, `dataset-evaluation-summary.ts`) are
 * outside this task's file list and are left as-is.
 */
export type RunMode = 'judge' | 'respond';

/** `responseText?.trim() ? 'judge' : 'respond'` — see module doc. */
export function deriveRunMode(responseText: string | null | undefined): RunMode {
  return responseText?.trim() ? 'judge' : 'respond';
}
