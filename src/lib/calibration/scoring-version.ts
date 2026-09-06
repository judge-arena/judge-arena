/**
 * ─── WHICH GENERATION OF THE SCORING RULES PRODUCED A STORED NUMBER ─────────
 *
 * SCORING IS EX POST, AND THAT IS THE WHOLE REASON THIS FILE EXISTS.
 *
 * A judge's complete output is on disk — `systemPrompt`, `userPrompt`,
 * `userPromptSha256`, `promptTemplateId`, `rawResponse`, `reasoningContent`,
 * `reasoningSource`, `verdict`, `samplingParams`, `parseMode`, `servedModelId`,
 * all non-null on all 619 judgments of calibration run
 * cmtozu76f00012l5w4llb4pae (measured 2026-09-06). A score is therefore a PURE
 * FUNCTION over stored rows, `--score-only` re-derives it at any time, and the
 * evaluation framework can improve WITHOUT re-executing a single model. Every
 * metric added in this phase — coverage, selective accuracy, the forced-choice
 * projections — was backfilled onto runs that finished days earlier.
 *
 * The cost of that property is this: IF THE RULES CAN CHANGE WITHOUT THE DATA
 * CHANGING, A STORED NUMBER IS MEANINGLESS UNLESS YOU KNOW WHICH RULES MADE IT.
 * Two runs scored under different generations, side by side on one scoreboard,
 * is not a noisy comparison — it is a comparison of two different questions.
 * Nothing else in the header can tell them apart: `finishedAt` moves on every
 * re-score, and "which columns are non-NULL" cannot work because
 * `selectiveAccuracy` is LEGITIMATELY NULL at zero coverage, so "not scored
 * under v2" and "the judge committed to nothing" would be one observation.
 *
 * WHAT NULL MEANS ON THE COLUMN, AND IT MEANS EXACTLY ONE THING: "scored before
 * v2m; the rule generation was not recorded." All 20 production CalibrationRun
 * rows read NULL the moment the migration applies. NULL IS NOT 0 AND IS NOT
 * VERSION 1 — the pre-v2m rules happen to be what this file calls generation 1,
 * but a row that was never stamped cannot prove it was scored under them, and
 * treating NULL as 1 would certify 20 rows nobody checked. A scoreboard query
 * filters on an explicit version and NEVER coalesces this column.
 *
 * PURE AND IMPORT-FREE BY DESIGN. Not one import: this module is pulled into
 * both `src/lib/calibration/score.ts` and the esbuild bundle behind
 * `scripts/calibration/run.ts` (.dockerignore:72 promises that bundle reaches
 * `src/lib/calibration/**` and `@/lib/db` only), so an edge added here is an
 * edge added in two graphs. `tests/lib/calibration-scoring-version.test.ts`
 * asserts the whole file against `/^\s*import\s/m`, not line by line.
 */

/**
 * The generation of scoring rules THIS BUILD implements. Stamped onto
 * `CalibrationRun.scoringVersion` by `scoreCalibrationRun` in the same full
 * overwrite as `rawAgreement`, so re-scoring moves the numbers and the stamp
 * together and cannot move one without the other.
 *
 * BUMP THIS WHENEVER A STORED FIELD'S DEFINITION CHANGES — not when a bug is
 * fixed in something that was already right, and not when a field is added that
 * no previous generation could have written (an all-NULL column is already
 * self-describing) — UNLESS that added column's NULL is AMBIGUOUS, meaning
 * "never scored under these rules" and a real zero-denominator MEASUREMENT read
 * identically on it (`selectiveAccuracy`, per the header above), in which case
 * the column is precisely NOT self-describing and the bump IS required: that
 * carve-out, not a changed definition, is what makes generation 2 below a bump.
 * Add the changelog entry in the SAME commit; the test pins the two together
 * precisely because bumping one and forgetting the other leaves this build
 * calling its own output UNKNOWN.
 */
export const SCORING_RULES_VERSION = 2;

export type ScoringRulesGeneration = {
  /** Monotone, contiguous from 1. Ordered, so "newer than" is decidable. */
  version: number;
  /** The migration whose landing defines the generation, e.g. 'v2l'. */
  migration: string;
  /** What the stored fields MEAN under this generation, in enough detail that
   *  a reader a year from now can tell whether a number is comparable to one
   *  produced today. A label is not a record. */
  rules: string;
};

export const SCORING_RULES_CHANGELOG: readonly ScoringRulesGeneration[] = [
  {
    version: 1,
    migration: 'v2l',
    rules:
      "rawAgreement = correctCount/verdictCount with a 'tie' counted as a miss; " +
      'Cohen kappa over the three preference categories; constantBaselineAccuracy = ' +
      'max(key class)/verdictCount over the SCORED subset',
  },
  {
    version: 2,
    migration: 'v2n',
    rules:
      'generation 1 UNCHANGED (rawAgreement and kappa keep their exact meaning), plus ' +
      "committedCount = items whose raw verdict is not 'tie'; coverage = " +
      'committedCount/verdictCount, so its DENOMINATOR IS ITEMS THAT PRODUCED A ' +
      'VERDICT, not items dispatched, and it is returned but not stored; ' +
      'selectiveAccuracy = correct-among-committed / committedCount, NULL at ' +
      'zero coverage; and ' +
      'selectiveBaselineAccuracy = max(committed key class)/committedCount, which is ' +
      'a DIFFERENT floor from constantBaselineAccuracy and can name a different class; ' +
      'and noVerdictRate = missingVerdicts/dispatchedItemCount, a FLEET property ' +
      '(truncation or dead request) that is NOT abstention and is not stored',
  },
];

/**
 * One line describing a stored version, for the CLI report and for anything
 * that has to explain a row to a human.
 *
 * Three branches, and each one is a different kind of honesty:
 *   null      → the row predates the column. Say so, and say it is not
 *               comparable, rather than substituting a plausible generation.
 *   known     → render the migration and the rules, not just the integer.
 *   unknown   → a NEWER image scored this row. Say that this build cannot
 *               account for the numbers, rather than rendering an integer as
 *               though it had been understood.
 */
export function describeScoringVersion(version: number | null): string {
  if (version === null) {
    return (
      'NULL — scored before v2m, so the rule generation was not recorded; ' +
      'this row is NOT comparable to a stamped one until it is re-scored'
    );
  }
  const known = SCORING_RULES_CHANGELOG.find((generation) => generation.version === version);
  if (known === undefined) {
    return (
      `${version} — UNKNOWN to this build (newest known is ${SCORING_RULES_VERSION}); ` +
      'a NEWER image scored this run and this build cannot say what its numbers mean'
    );
  }
  return `${known.version} (${known.migration}) — ${known.rules}`;
}
