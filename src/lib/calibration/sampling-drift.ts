/**
 * ─── Sampling drift: launch-time snapshot vs execution-time truth (v2k) ────
 *
 * `CalibrationRun.samplingParams` is what a calibration was LAUNCHED under —
 * `effectiveSamplingParams(version.samplingDefaults)` resolved inside the
 * launch transaction (src/lib/calibration/launch.ts). Each
 * `ModelJudgment.samplingParams` is what that judgment was EXECUTED under —
 * the same resolver, run by the worker per call against the version row AS
 * OF THAT CALL (src/worker/judgment-consumer.ts loads the version per
 * judgment). The two agree by construction, unless the version row was edited
 * while the run was draining — runbook §8.8's "mixture of two experiments",
 * which the scoreboard spec §4.1 detects by `SELECT DISTINCT` returning two
 * rows. This module makes that tell mechanical for scripts/calibration/run.ts.
 *
 * WHY IT IS NOT TEN LINES IN THE SCRIPT: JSONB stores object keys
 * shortest-first, so `{ temperature, max_tokens }` written by Prisma comes
 * back as `{ max_tokens, temperature }`. A naive `JSON.stringify` comparison
 * between the in-process header and a DB-loaded judgment reports drift on
 * EVERY run — a rule that is silently wrong, which CONTRIBUTING.md:247 says
 * belongs under src/lib/** where tests/lib/calibration-sampling-drift.test.ts
 * can pin it.
 */

export type SamplingDrift =
  /** Every completed judgment ran under one config, and it matches the
   * header when there is one. `executedUnder` is null when nothing has
   * completed yet. */
  | { kind: 'consistent'; executedUnder: string | null }
  /** Completed judgments ran under more than one config: the version row was
   * edited mid-run. The run is not internally comparable. */
  | { kind: 'moved_mid_run'; executedUnder: string[] }
  /** Judgments agree with each other but not with the header: the row was
   * edited between launch and the first execution. */
  | { kind: 'differs_from_header'; header: string; executedUnder: string };

/**
 * JSON with object keys sorted — flat objects only, which is all a
 * `SamplingParams` is. Total over `Json?` column values (`null`), and over
 * `undefined` for callers holding an unset field.
 */
export function canonicalJson(value: unknown): string {
  if (typeof value !== 'object' || value === null) return JSON.stringify(value) ?? 'undefined';
  const record = value as Record<string, unknown>;
  return JSON.stringify(record, Object.keys(record).sort());
}

/**
 * How a `CalibrationRun.samplingParams` value is shown to an operator. A NULL
 * (or unset) snapshot is a run launched before v2k and is rendered as exactly
 * that — never as a config, and never falling through to a registry default,
 * because either would reintroduce the lie the column was added to end.
 */
export function describeSamplingSnapshot(snapshot: unknown): string {
  return snapshot == null
    ? '(no snapshot — launched before v2k; derive from ModelJudgment.samplingParams)'
    : canonicalJson(snapshot);
}

export function detectSamplingDrift(
  header: unknown,
  judgments: ReadonlyArray<{ status: string; samplingParams: unknown }>
): SamplingDrift {
  // Only COMPLETED judgments carry a config that ran; pending/error rows have
  // NULL samplingParams and must not collapse the comparison (spec §4.1).
  const executedUnder = [
    ...new Set(judgments.filter((j) => j.status === 'completed').map((j) => canonicalJson(j.samplingParams))),
  ];
  if (executedUnder.length > 1) return { kind: 'moved_mid_run', executedUnder };
  const only = executedUnder[0] ?? null;
  // A null header is a run launched before v2k — nothing to compare against,
  // and never something to warn about.
  if (header != null && only !== null && only !== canonicalJson(header)) {
    return { kind: 'differs_from_header', header: canonicalJson(header), executedUnder: only };
  }
  return { kind: 'consistent', executedUnder: only };
}
